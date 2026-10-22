import { randomUUID } from "node:crypto";
import { startAttempt } from "./provider-adapters.mjs";
import {
  collectAnthropicStream,
  createAnthropicStreamCodec,
  createSseChunkReader,
  openaiToAnthropicMessage,
} from "./anthropic-openai-codec.mjs";
import { anthropicMessageToSse, respondWithAnthropicPassthrough } from "./anthropic-passthrough.mjs";
import { createSseWriter, sseHeaders, endSseError } from "./sse-stream.mjs";

// Errors whose allowance is gone until a periodic reset (e.g. a daily free
// quota) get a long cooldown; transient limits (per-minute rate limits,
// hiccups) keep the short default. Tuned via ROUTING_DAILY_QUOTA_COOLDOWN_MS.
const ERROR_COOLDOWN_MS = 10000;
const DAILY_QUOTA_COOLDOWN_MS = Math.max(
  Number(process.env.ROUTING_DAILY_QUOTA_COOLDOWN_MS) || 60 * 60 * 1000,
  ERROR_COOLDOWN_MS,
);
const DAILY_QUOTA_ERROR_CODES = new Set(["cline_daily_free_quota_exhausted"]);
const DAILY_QUOTA_BODY_PATTERN = /\b(daily|per[-_ ]?day|per[-_ ]?month|monthly|weekly|quota|exhaust(ed|ion)?)\b/i;

function failureStatus(status) {
  if (status === 429 || status === 503) return 503;
  return 502;
}

function cooldownMs(response) {
  const retryAfter = Number(response?.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1000, 1000), 30000) : ERROR_COOLDOWN_MS;
}

function errorCooldownMs(error) {
  if (error?.code && DAILY_QUOTA_ERROR_CODES.has(String(error.code))) return DAILY_QUOTA_COOLDOWN_MS;
  const message = typeof error?.message === "string" ? error.message : "";
  if (DAILY_QUOTA_BODY_PATTERN.test(message)) return DAILY_QUOTA_COOLDOWN_MS;
  return ERROR_COOLDOWN_MS;
}

// Peeks the body of a 429 to distinguish daily/period quota exhaustion from
// per-minute rate limits, which usually arrive without a usable retry-after.
// Capped at ~1s so a stalled upstream never delays failover.
async function status429CooldownMs(response, signal) {
  try {
    const text = await Promise.race([
      readBodyText(response, signal, 4096),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (typeof text === "string" && DAILY_QUOTA_BODY_PATTERN.test(text)) return DAILY_QUOTA_COOLDOWN_MS;
  } catch {
    // fall through to header/default-based cooldown
  }
  return cooldownMs(response);
}

function readBodyText(response, signal, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => { cleanup(); fn(value); };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) {
        response.pause();
        finish(resolve, Buffer.concat(chunks).toString("utf8"));
      }
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, signal?.reason || new Error("aborted"));
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function discard(response) {
  response.resume();
}

function abortError(signal) {
  return signal?.reason || Object.assign(new Error("request aborted"), { code: "ABORT_ERR" });
}

// Shared OAuth/session setup may outlive a caller; its deadline must not wait for it.
function startAttemptUntilAbort(options, attemptStarter) {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError(signal);
      return attemptStarter(options);
    }).then((attempt) => {
      cleanup();
      if (signal.aborted) {
        attempt.response?.destroy?.();
        if (attempt.upstream !== attempt.response) attempt.upstream?.destroy?.();
        reject(abortError(signal));
      } else resolve(attempt);
    }, (error) => { cleanup(); reject(error); });
  });
}

// Holds a bounded stream prefix until the first semantic event. This leaves a
// small pre-output window for account failover without replaying anything once
// visible output has started.
function preflightOpenCodeStream(response, signal, limit = 256 * 1024, deadlineMs = 90000) {
  return new Promise((resolve) => {
    const parser = createSseChunkReader();
    const decoder = new TextDecoder();
    let prefixText = "";
    let bytes = 0;
    let semantic = false;
    let complete = false;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result, ended = false) => {
      if (settled) return;
      settled = true;
      response.pause();
      cleanup();
      resolve({ ...result, prefixText, ended, decoder });
    };
    const inspect = (payload) => {
      if (payload === "[DONE]") { complete = true; return null; }
      let frame;
      try { frame = JSON.parse(payload); } catch { return new Error("OpenCode stream contained malformed JSON"); }
      if (frame?.error) return new Error("OpenCode returned an embedded stream error");
      const choice = frame?.choices?.[0];
      const delta = choice?.delta || {};
      if ((typeof delta.content === "string" && delta.content.length)
        || (typeof delta.reasoning === "string" && delta.reasoning.length)
        || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length)
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => call?.id || call?.function?.name || call?.function?.arguments))) semantic = true;
      if (choice?.finish_reason) {
        if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice.finish_reason)) return new Error("OpenCode stream reported an unsuccessful finish");
        complete = true;
        semantic = true;
      }
      return null;
    };
    const onData = (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) return finish({ retryable: !semantic && !signal?.aborted, semantic, error: new Error("OpenCode stream preamble exceeded its bound") });
      const decoded = decoder.decode(buffer, { stream: true });
      prefixText += decoded;
      for (const payload of parser.push(decoded)) {
        const error = inspect(payload);
        if (error) return finish({ retryable: !semantic && !signal?.aborted, semantic, error });
      }
      if (semantic || complete) finish({ retryable: false, semantic, complete });
    };
    const onEnd = () => {
      const tail = decoder.decode();
      if (tail) {
        if (bytes + Buffer.byteLength(tail) > limit) return finish({ retryable: !semantic, semantic, error: new Error("OpenCode stream preamble exceeded its bound") }, true);
        prefixText += tail;
        for (const payload of parser.push(tail)) {
          const error = inspect(payload);
          if (error) return finish({ retryable: !semantic, semantic, error }, true);
        }
      }
      finish({ retryable: !semantic, semantic, complete, error: complete && semantic ? null : new Error("OpenCode stream ended before completion") }, true);
    };
    const onError = (error) => finish({ retryable: !semantic && !signal?.aborted, semantic, error }, true);
    const onAbort = () => finish({ retryable: false, semantic, error: signal.reason || new Error("request aborted") }, true);
    const preflightMs = Math.max(1, deadlineMs);
    timer = setTimeout(() => finish({ retryable: !semantic && !signal?.aborted, semantic, error: new Error("OpenCode stream preamble timed out") }), preflightMs);
    timer.unref?.();
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    response.resume();
  });
}

function createChatStreamValidator() {
  const reader = createSseChunkReader();
  let terminal = false;
  let error = null;
  let semantic = false;
  const inspect = (payload) => {
    if (payload === "[DONE]") { terminal = true; return; }
    let frame;
    try { frame = JSON.parse(payload); } catch { error = new Error("OpenCode stream contained malformed JSON"); return; }
    if (frame?.error) { error = new Error("OpenCode returned an embedded stream error"); return; }
    const choice = frame?.choices?.[0];
    const delta = choice?.delta || {};
    if ((typeof delta.content === "string" && delta.content.length)
      || (typeof delta.reasoning === "string" && delta.reasoning.length)
      || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length)
      || (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => call?.id || call?.function?.name || call?.function?.arguments))) semantic = true;
    if (choice?.finish_reason) {
      if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice.finish_reason)) error = new Error("OpenCode stream reported an unsuccessful finish");
      else terminal = true;
    }
  };
  return {
    push(text) {
      const frames = reader.push(text);
      for (const frame of frames) inspect(frame);
      return { frames, error, terminal, semantic };
    },
    end() {
      const tail = reader.end?.() || [];
      for (const frame of tail) inspect(frame);
      return { frames: tail, error, terminal, semantic };
    },
    get terminal() { return terminal; },
    get error() { return error; },
    get semantic() { return semantic; },
  };
}

function firstStreamChunk(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk) => { response.pause(); cleanup(); resolve(chunk); };
    const onEnd = () => { cleanup(); reject(new Error("upstream stream ended before its first event")); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal.reason || new Error("request aborted")); };
    response.once("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    response.resume();
  });
}

// Serves an OpenAI stream to a caller that spoke the Anthropic protocol: as
// Anthropic server-sent events, or folded into one message when the caller
// asked for a single response. Used when the upstream only speaks OpenAI.
async function respondWithCodec({ response, codec, res, status, requestId, model, provider, publicModel, signal, pingMs, strictCompletion = false, preflight = null }) {
  const base = {
    "x-gateway-request-id": requestId,
    "x-gateway-model": publicModel || model,
    "x-gateway-provider": provider,
    "x-gateway-upstream-model": model,
  };
  // A translated upstream answers in whichever shape it was asked for: JSON for
  // a non-streaming caller, SSE for a streaming one. Either way the caller gets
  // an Anthropic reply, and a streaming caller never receives a bare JSON body.
  const contentType = String(response.headers?.["content-type"] || "");
  if (!contentType.includes("text/event-stream")) {
    const raw = await readBodyText(response, signal, 32 * 1024 * 1024);
    let completion;
    try {
      completion = JSON.parse(raw);
    } catch {
      res.writeHead(502, { ...base, "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream returned an unreadable body" } }));
      return;
    }
    if (completion?.error || (strictCompletion && (!completion?.choices?.[0] || !completion.choices[0].finish_reason))) {
      if (strictCompletion) response._opencodePoolStreamState = { failure: new Error("OpenCode returned an error or incomplete completion") };
      res.writeHead(completion?.error ? status : 502, { ...base, "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream returned an error or incomplete completion" } }));
      return;
    }
    const message = openaiToAnthropicMessage(completion, { model });
    if (codec.stream) {
      res.writeHead(status, { ...base, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      res.end(anthropicMessageToSse(message));
      return;
    }
    res.writeHead(status, { ...base, "content-type": "application/json" });
    res.end(JSON.stringify(message));
    return;
  }

  const reader = createSseChunkReader();
  const encoder = createAnthropicStreamCodec({ model, strictCompletion });
  const decoder = preflight?.decoder;
  if (!decoder) response.setEncoding("utf8");
  const decode = (chunk) => decoder ? decoder.decode(chunk, { stream: true }) : String(chunk);

  if (codec.stream) {
    const writer = createSseWriter(res, signal, pingMs);
    const onAbort = () => response.destroy?.(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      res.writeHead(status, sseHeaders(base));
      res.flushHeaders?.();
      if (response._opencodePoolStreamState && preflight?.semantic) response._opencodePoolStreamState.semantic = true;
      const write = async (events) => events.length ? writer.write(events.join("")) : true;
      const feed = async (chunk) => {
        for (const payload of reader.push(String(chunk))) {
          const events = encoder.push(payload);
          if (response._opencodePoolStreamState && events.length) response._opencodePoolStreamState.semantic = true;
          if (!await write(events)) return false;
        }
        return true;
      };
      if (preflight?.prefixText && !await feed(preflight.prefixText)) return;
      if (!preflight?.ended) {
        for await (const chunk of response) if (!await feed(decode(chunk))) return;
        if (decoder && !await feed(decoder.decode())) return;
      }
      if (!await write(encoder.end())) return;
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch (error) {
      if (response._opencodePoolStreamState && !signal?.aborted) response._opencodePoolStreamState.failure = error;
      endSseError(res, signal);
      throw error;
    } finally {
      writer.cleanup();
      signal?.removeEventListener("abort", onAbort);
    }
    return;
  }

  const collected = [];
  const feed = (chunk) => { for (const payload of reader.push(String(chunk))) collected.push(...encoder.push(payload)); };
  if (preflight?.prefixText) feed(preflight.prefixText);
  if (!preflight?.ended) {
    for await (const chunk of response) feed(decode(chunk));
    if (decoder) feed(decoder.decode());
  }
  collected.push(...encoder.end());
  res.writeHead(status, { ...base, "content-type": "application/json" });
  res.end(JSON.stringify(collectAnthropicStream(collected)));
}

async function readSnippet(response, limit = 300) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) break;
    }
    return Buffer.concat(chunks).toString("utf8").slice(0, limit).replace(/\s+/g, " ").trim();
  } catch {
    return "<unreadable>";
  }
}

const MAX_MODEL_HISTORY_SESSIONS = 1000;
const MAX_MODEL_HISTORY_FAMILIES = 16;
const MODEL_HISTORY_TTL_MS = Number(process.env.ROUTING_ROLE_HISTORY_TTL_MS || 60 * 60 * 1000);

export function recordModelFamily(runtimeState, affinityKey, candidate) {
  if (!affinityKey || typeof candidate?.family !== "string" || !candidate.family) return;
  if (!(runtimeState.modelHistory instanceof Map)) runtimeState.modelHistory = new Map();
  const now = Date.now();
  const previous = runtimeState.modelHistory.get(affinityKey);
  const families = previous && previous.updatedAt + MODEL_HISTORY_TTL_MS > now ? previous.families : [];
  const next = [...families.filter((family) => family !== candidate.family), candidate.family].slice(-MAX_MODEL_HISTORY_FAMILIES);
  runtimeState.modelHistory.delete(affinityKey);
  runtimeState.modelHistory.set(affinityKey, { families: next, updatedAt: now });
  while (runtimeState.modelHistory.size > MAX_MODEL_HISTORY_SESSIONS) {
    runtimeState.modelHistory.delete(runtimeState.modelHistory.keys().next().value);
  }
}

export function observeUpstreamResponse(response, candidate, callback) {
  if (typeof callback !== "function") return;
  const chunks = [];
  let size = 0;
  response.on("data", chunk => {
    if (size >= 1024 * 1024) return;
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
    if (size > 1024 * 1024) chunks.length = 0;
  });
  response.once("end", () => {
    try { callback({ provider: candidate.provider.id, model: candidate.upstreamModel, headers: response.headers || {}, chunks }); } catch {}
  });
}

function specialistProtocolResponse({ protocol, document, model }) {
  if (protocol === "responses") return document;
  const text = typeof document.output_text === "string" ? document.output_text : "";
  if (protocol === "messages") {
    return { id: document.id, type: "message", role: "assistant", model, content: text ? [{ type: "text", text }] : [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  }
  if (protocol === "chat_completions") {
    return { id: document.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: null };
  }
  return null;
}

function settledSpecialistSse(protocol, document, translated, model) {
  const text = typeof document.output_text === "string" ? document.output_text : "";
  if (protocol === "messages") return anthropicMessageToSse(translated);
  if (protocol === "chat_completions") {
    const id = document.id || `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (choices) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices })}\n\n`;
    return chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])
      + (text ? chunk([{ index: 0, delta: { content: text }, finish_reason: null }]) : "")
      + chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) + "data: [DONE]\n\n";
  }
  const id = document.id || `resp_${randomUUID()}`;
  const emit = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const response = { ...document, id, object: "response", status: "completed", output_text: text };
  const item = { id: `${id}_msg`, type: "message", role: "assistant", status: "completed", content: text ? [{ type: "output_text", text, annotations: [] }] : [] };
  const events = [
    emit("response.created", { response: { ...response, status: "in_progress" } }),
    emit("response.output_item.added", { response_id: id, output_index: 0, item: { ...item, status: "in_progress" } }),
  ];
  if (text) {
    events.push(emit("response.content_part.added", { response_id: id, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    events.push(emit("response.output_text.delta", { response_id: id, item_id: item.id, output_index: 0, content_index: 0, delta: text }));
    events.push(emit("response.output_text.done", { response_id: id, item_id: item.id, output_index: 0, content_index: 0, text }));
    events.push(emit("response.content_part.done", { response_id: id, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } }));
  }
  return events.join("") + emit("response.output_item.done", { response_id: id, output_index: 0, item }) + emit("response.completed", { response });
}

export async function executeRoutePlan({ plan, req, res, path, body, trace = req.requestTrace, env = process.env, runtimeState = {}, adapters = {}, affinityKey = null, historyKey = undefined, onUpstreamResponse, openCodeAccountPool = null, startAttempt: attemptStarter = startAttempt }) {
  const requestId = trace?.id || randomUUID();
  trace?.model(plan.publicModel);
  trace?.stage("executor");
  trace?.emit("route_plan", { candidate_count: plan.candidates.length });
  const pingMs = Math.max(1, Number(env.GATEWAY_SSE_PING_MS) || 15000);
  const aborter = new AbortController();
  let activeResponse;
  const abortResponse = () => activeResponse?.destroy(aborter.signal.reason);
  aborter.signal.addEventListener("abort", abortResponse, { once: true });
  aborter.signal.addEventListener("abort", () => trace?.emit("deadline", { deadline: aborter.signal.reason?.code || "unknown" }), { once: true });
  const deadlineMs = Math.max(plan.deadline - Date.now(), 1);
  const timeout = setTimeout(() => aborter.abort(Object.assign(new Error("upstream deadline exceeded"), { code: "TOTAL_DEADLINE" })), deadlineMs);
  const responseStartMs = Math.max(1, Number(env.GATEWAY_RESPONSE_START_TIMEOUT_MS) || 90000);
  let responseStartExpired = false;
  let responseStartTimer;
  responseStartTimer = setTimeout(() => {
    if (res.headersSent) return;
    responseStartExpired = true;
    aborter.abort(Object.assign(new Error("gateway response-start deadline exceeded"), { code: "RESPONSE_START_DEADLINE" }));
  }, Math.min(responseStartMs, Math.max(plan.deadline - Date.now(), 1)));
  responseStartTimer.unref?.();
  const cancel = () => aborter.abort(Object.assign(new Error("client disconnected"), { code: "CLIENT_DISCONNECTED" }));
  req.once("aborted", cancel);
  const onClose = () => { if (!res.writableEnded) cancel(); };
  res.once("close", onClose);
  let lastStatus = 502;
  if (plan.deadline <= Date.now()) {
    aborter.abort(Object.assign(new Error("upstream deadline exceeded"), { code: "TOTAL_DEADLINE" }));
  }

  try {
    candidateLoop: for (const candidate of plan.candidates) {
      if (aborter.signal.aborted) break;
      trace?.stage("attempt");
      const candidateBody = Buffer.from(JSON.stringify({ ...body, model: candidate.upstreamModel }));
      const excludedAccounts = [];
      let poolAttempt = 0;
      let attemptNumber = 0;
      let attemptResult;
      let status;
      try {
        const maxPoolAttempts = candidate.provider.adapter === "opencode-zen" && openCodeAccountPool ? openCodeAccountPool.maxAttempts : 1;
        while (true) {
          attemptNumber += 1;
          trace?.emit("attempt_start", { provider: candidate.provider.id, upstream_model: candidate.upstreamModel, attempt_number: attemptNumber });
          try {
            attemptResult = await startAttemptUntilAbort({ candidate, req, path, body: candidateBody, env, signal: aborter.signal, adapters, trace, accountPool: candidate.provider.adapter === "opencode-zen" ? openCodeAccountPool : null, stickyKey: affinityKey, excludedAccounts }, attemptStarter);
          } catch (error) {
            const failedAccount = error.poolAccount;
            if (failedAccount && !aborter.signal.aborted) {
              openCodeAccountPool.markFailure(failedAccount, error);
              if (poolAttempt + 1 < maxPoolAttempts) {
                excludedAccounts.push(failedAccount.id);
                poolAttempt += 1;
                continue;
              }
            }
            throw error;
          }
          const { response } = attemptResult;
          activeResponse = response;
          if (aborter.signal.aborted) {
            response.destroy();
            break;
          }
          status = response.statusCode || 502;
          trace?.emit("upstream_headers", { provider: candidate.provider.id, upstream_model: candidate.upstreamModel, status });
          if (status >= 200 && status < 300) {
            if (attemptResult.poolAccount && !String(response.headers?.["content-type"] || "").includes("text/event-stream")) {
              openCodeAccountPool.markFailure(attemptResult.poolAccount, new Error("OpenCode returned an unexpected response protocol"));
              lastStatus = 502;
              response.destroy();
              if (poolAttempt + 1 < maxPoolAttempts) {
                excludedAccounts.push(attemptResult.poolAccount.id);
                poolAttempt += 1;
                continue;
              }
              attemptResult = null;
              continue candidateLoop;
            }
            if (attemptResult.poolAccount
              && (attemptResult.codec || candidate.protocol === "chat_completions")
              && String(response.headers?.["content-type"] || "").includes("text/event-stream")) {
              const preflight = await preflightOpenCodeStream(response, aborter.signal, 256 * 1024, Math.max(1, plan.deadline - Date.now()));
              attemptResult.streamPreflight = preflight;
              if (preflight.retryable) {
                openCodeAccountPool.markFailure(attemptResult.poolAccount, preflight.error);
                if (poolAttempt + 1 < maxPoolAttempts) {
                  response.destroy();
                  excludedAccounts.push(attemptResult.poolAccount.id);
                  poolAttempt += 1;
                  continue;
                }
                response.destroy();
                attemptResult = null;
                continue candidateLoop;
              }
              if (preflight.error && preflight.semantic) {
                attemptResult.streamPreflight = preflight;
                break;
              }
              if (preflight.error) throw preflight.error;
            }
            break;
          }
          if (attemptResult.poolAccount) {
            const retryable = status === 429 || status === 401 || status === 403 || status >= 500;
            if (retryable) {
              const retryAfter = Number(response.headers?.["retry-after"]);
              openCodeAccountPool.markFailure(attemptResult.poolAccount, new Error(`upstream ${status}`), { retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : undefined });
              if (poolAttempt + 1 < maxPoolAttempts) {
                excludedAccounts.push(attemptResult.poolAccount.id);
                poolAttempt += 1;
                discard(response);
                continue;
              }
            }
          }
          break;
        }
        const { response, codec, specialist, specialistProtocol, poolAccount, poolGeneration, poolStickyKey, streamPreflight } = attemptResult;
        if (aborter.signal.aborted) break;
        if (status < 200 || status >= 300) {
          if (specialist) {
            const rawError = await readBodyText(response, aborter.signal, 4096).catch(() => "");
            let upstreamError;
            try { upstreamError = JSON.parse(rawError); } catch {}
            const code = upstreamError?.error?.code || upstreamError?.error?.type || "specialist_upstream_error";
            const message = typeof upstreamError?.error?.message === "string" ? upstreamError.error.message : "ChatGPT specialist service rejected or failed the request; no retry or fallback was attempted";
            res.writeHead(status, { "content-type": "application/json", "x-gateway-request-id": requestId, "x-gateway-provider": candidate.provider.id });
            res.end(JSON.stringify({ error: { type: status < 500 ? "invalid_request_error" : "specialist_upstream_error", code, message } }));
            return { committed: false, requestId, specialist: true };
          }
          lastStatus = status;
          trace?.emit("upstream_rejected", { provider: candidate.provider.id, upstream_model: candidate.upstreamModel, status });
          if (poolAccount) {
            discard(response);
            continue candidateLoop;
          }
          const cooldown = status === 429
            ? await status429CooldownMs(response, aborter.signal)
            : cooldownMs(response);
          discard(response);
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + cooldown);
          continue;
        }
        observeUpstreamResponse(response, candidate, onUpstreamResponse);
        if (poolAccount && !codec && candidate.protocol === "chat_completions" && String(response.headers?.["content-type"] || "").includes("text/event-stream")) {
          const validator = createChatStreamValidator();
          const writer = createSseWriter(res, aborter.signal, pingMs);
          const base = { "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
          let streamFailure = null;
          let finished = false;
          const relay = async (chunk) => {
            const checked = validator.push(String(chunk));
            if (checked.error) { streamFailure = checked.error; return false; }
            for (const frame of checked.frames) if (!await writer.write(`data: ${frame}\n\n`)) return false;
            if (checked.terminal) finished = true;
            return true;
          };
          try {
            res.writeHead(status, sseHeaders(base));
            res.flushHeaders?.();
            if (streamPreflight?.prefixText && !await relay(streamPreflight.prefixText)) throw streamFailure || new Error("downstream disconnected");
            if (!streamPreflight?.ended) {
              const decoder = streamPreflight?.decoder || new TextDecoder();
              for await (const chunk of response) {
                if (!await relay(decoder.decode(chunk, { stream: true }))) {
                  if (streamFailure) break;
                  if (aborter.signal.aborted || res.destroyed) break;
                  throw new Error("downstream disconnected");
                }
              }
              if (!streamFailure) await relay(decoder.decode());
            }
            const tail = validator.end();
            for (const frame of tail.frames) if (!await writer.write(`data: ${frame}\n\n`)) break;
            streamFailure ||= tail.error;
            finished ||= tail.terminal;
            if (!finished) streamFailure ||= new Error("OpenCode stream ended before completion");
          } catch (error) {
            if (!aborter.signal.aborted && !res.destroyed) streamFailure ||= error;
          } finally {
            writer.cleanup();
          }
          if (aborter.signal.aborted || res.destroyed) {
            response.destroy(aborter.signal.reason);
            return { committed: true, requestId, provider: candidate.provider.id };
          }
          if (streamFailure) {
            openCodeAccountPool.markFailure(poolAccount, streamFailure);
            if (validator.semantic || streamPreflight?.semantic) openCodeAccountPool.markSessionFailure?.(poolAccount, poolStickyKey);
            response.destroy();
            if (!res.destroyed && !res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream failed" } })}\n\n`);
          } else {
            openCodeAccountPool.markSuccess(poolAccount, poolStickyKey, poolGeneration);
            if (!res.destroyed && !res.writableEnded) res.end();
          }
          return { committed: true, requestId, provider: candidate.provider.id };
        }
        if (codec) {
          await respondWithCodec({ response, codec, res, status, requestId, model: candidate.upstreamModel, provider: candidate.provider.id, publicModel: plan.publicModel, signal: aborter.signal, pingMs, strictCompletion: Boolean(poolAccount), preflight: streamPreflight });
          if (poolAccount && !aborter.signal.aborted) {
            const streamState = response._opencodePoolStreamState;
            if (streamState?.failure || streamPreflight?.error) {
              openCodeAccountPool.markFailure(poolAccount, streamState?.failure || streamPreflight.error);
              if (streamState?.semantic || streamPreflight?.semantic) openCodeAccountPool.markSessionFailure?.(poolAccount, poolStickyKey);
            } else openCodeAccountPool.markSuccess(poolAccount, poolStickyKey, poolGeneration);
          }
          if (affinityKey && plan.profile && runtimeState.affinity) {
            runtimeState.affinity.set(`${affinityKey}:${plan.profile}`, {
              provider: candidate.provider.id,
              model: candidate.upstreamModel,
              updatedAt: Date.now(),
            });
          }
          recordModelFamily(runtimeState, historyKey === undefined ? affinityKey : historyKey, candidate);
          return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1, translated: codec.kind };
        }
        if (specialist) {
          const raw = await readBodyText(response, aborter.signal, 32 * 1024 * 1024);
          let document;
          try { document = JSON.parse(raw); } catch {
            res.writeHead(502, { "content-type": "application/json", "x-gateway-request-id": requestId });
            res.end(JSON.stringify({ error: { type: "specialist_invalid_response", message: "ChatGPT specialist service returned an unreadable response; reconcile the original idempotency key" } }));
            return { committed: false, requestId, specialist: true };
          }
          if (document?.status !== "completed" || document?.service?.settled !== true) {
            res.writeHead(502, { "content-type": "application/json", "x-gateway-request-id": requestId });
            res.end(JSON.stringify({ error: { type: "specialist_unsettled", message: "ChatGPT specialist response is not durably settled; reconcile the original idempotency key before retrying" } }));
            return { committed: false, requestId, specialist: true };
          }
          const translated = specialistProtocolResponse({ protocol: specialistProtocol, document, model: plan.publicModel });
          if (!translated) {
            res.writeHead(502, { "content-type": "application/json", "x-gateway-request-id": requestId });
            res.end(JSON.stringify({ error: { type: "specialist_protocol_error", message: "Could not translate settled specialist response" } }));
            return { committed: false, requestId, specialist: true };
          }
          const streaming = body?.stream === true;
          if (streaming) {
            res.writeHead(status, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id });
            res.end(settledSpecialistSse(specialistProtocol, document, translated, plan.publicModel));
          } else {
            res.writeHead(status, { "content-type": "application/json", "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id });
            res.end(JSON.stringify(translated));
          }
          return { committed: true, requestId, provider: candidate.provider.id, specialist: true };
        }
        trace?.stage("response");
        const headers = { ...response.headers, "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
        const thinking = body?.thinking;
        const keepReasoning = Boolean(thinking && thinking.type !== "disabled") || Boolean(body?.reasoning);
        const repaired = candidate.protocol === "messages"
          && await respondWithAnthropicPassthrough({ response, res, status, headers, wantStream: plan.required.streaming === true, keepReasoning, signal: aborter.signal, pingMs });
        if (!repaired) {
          if (plan.required.streaming) {
            const first = await firstStreamChunk(response, aborter.signal);
            res.writeHead(status, headers);
            res.write(first);
          } else {
            res.writeHead(status, headers);
          }
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              response.off("end", onEnd);
              response.off("error", onError);
              res.off("finish", onFinish);
              res.off("close", onClose);
              aborter.signal.removeEventListener("abort", onAbort);
            };
            const done = (fn, value) => { cleanup(); fn(value); };
            const onEnd = () => { if (!res.destroyed && !res.writableEnded) res.end(); done(resolve); };
            const onFinish = () => done(resolve);
            const onClose = () => done(resolve);
            const onError = (error) => done(reject, error);
            const onAbort = () => { response.destroy?.(aborter.signal.reason); done(reject, aborter.signal.reason); };
            response.once("end", onEnd);
            response.once("error", onError);
            res.once("finish", onFinish);
            res.once("close", onClose);
            aborter.signal.addEventListener("abort", onAbort, { once: true });
            if (aborter.signal.aborted) onAbort();
            else response.pipe(res);
          });
        }
        if (affinityKey && plan.profile && runtimeState.affinity) {
          runtimeState.affinity.set(`${affinityKey}:${plan.profile}`, {
            provider: candidate.provider.id,
            model: candidate.upstreamModel,
            updatedAt: Date.now(),
          });
        }
        recordModelFamily(runtimeState, historyKey === undefined ? affinityKey : historyKey, candidate);
        return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1 };
      } catch (error) {
        if (attemptResult?.poolAccount && !aborter.signal.aborted) {
          openCodeAccountPool?.markFailure(attemptResult.poolAccount, error);
          if (attemptResult.poolStickyKey) openCodeAccountPool?.markSessionFailure?.(attemptResult.poolAccount, attemptResult.poolStickyKey);
        }
        if (res.headersSent) {
          if (!res.destroyed && !res.writableEnded) res.destroy();
          return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1 };
        }
        if (aborter.signal.aborted) break;
        if (candidate.specialist) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
          res.writeHead(status, { "content-type": "application/json", "x-gateway-request-id": requestId, "x-gateway-provider": candidate.provider.id });
          res.end(JSON.stringify({ error: { type: status < 500 ? "invalid_request_error" : "specialist_upstream_error", message: status < 500 ? error.message : "ChatGPT specialist service is unavailable; no retry or fallback was attempted" } }));
          return { committed: false, requestId, specialist: true };
        }
        const isLastCandidate = candidate === plan.candidates[plan.candidates.length - 1];
        if (isLastCandidate && candidate.provider.adapter === "cline-oauth" && error?.status && error?.code) {
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + errorCooldownMs(error));
          res.writeHead(error.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: error.code, message: error.message, type: "cline_oauth_error" } }));
          return { committed: false, requestId };
        }
        lastStatus = 502;
        const safeCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : "upstream_error";
        trace?.emit("attempt_failed", { provider: candidate.provider.id, upstream_model: candidate.upstreamModel, code: safeCode, attempt_number: attemptNumber });
        runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + errorCooldownMs(error));
      }
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(responseStartTimer);
    req.off("aborted", cancel);
    res.off("close", onClose);
    aborter.signal.removeEventListener("abort", abortResponse);
  }
  if (!res.headersSent && !res.destroyed && aborter.signal.aborted && aborter.signal.reason?.code !== "CLIENT_DISCONNECTED") {
    const timedOut = responseStartExpired || aborter.signal.reason?.code === "TOTAL_DEADLINE";
    res.writeHead(timedOut ? 504 : failureStatus(lastStatus), { "content-type": "application/json", "x-gateway-request-id": requestId });
    const message = timedOut
      ? "Gateway response deadline exceeded; remote execution may still be running. Reconcile with the original idempotency key before retrying."
      : "No eligible upstream completed the request";
    res.end(JSON.stringify({ error: { message, type: timedOut ? "gateway_timeout" : "gateway_upstream_error", request_id: requestId, model: plan.publicModel } }));
  } else if (!res.headersSent && !aborter.signal.aborted) {
    res.writeHead(failureStatus(lastStatus), { "content-type": "application/json", "x-gateway-request-id": requestId });
    res.end(JSON.stringify({ error: { message: "No eligible upstream completed the request", type: "gateway_upstream_error", request_id: requestId, model: plan.publicModel } }));
  }
  return { committed: false, requestId };
}
