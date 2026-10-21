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
async function respondWithCodec({ response, codec, res, status, requestId, model, provider, publicModel, signal, pingMs }) {
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
    if (completion?.error) {
      res.writeHead(status, { ...base, "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(completion.error.message || "Upstream error") } }));
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
  const encoder = createAnthropicStreamCodec({ model });
  response.setEncoding("utf8");

  if (codec.stream) {
    const writer = createSseWriter(res, signal, pingMs);
    const onAbort = () => response.destroy?.(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      res.writeHead(status, sseHeaders(base));
      res.flushHeaders?.();
      const write = async (events) => events.length ? writer.write(events.join("")) : true;
      const feed = async (chunk) => {
        for (const payload of reader.push(String(chunk))) if (!await write(encoder.push(payload))) return false;
        return true;
      };
      for await (const chunk of response) if (!await feed(chunk)) return;
      if (!await write(encoder.end())) return;
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch (error) {
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
  for await (const chunk of response) feed(chunk);
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

export async function executeRoutePlan({ plan, req, res, path, body, env = process.env, runtimeState = {}, adapters = {}, affinityKey = null, historyKey = undefined, onUpstreamResponse }) {
  const requestId = randomUUID();
  const pingMs = Math.max(1, Number(env.GATEWAY_SSE_PING_MS) || 15000);
  const aborter = new AbortController();
  let activeResponse;
  const abortResponse = () => activeResponse?.destroy(aborter.signal.reason);
  aborter.signal.addEventListener("abort", abortResponse, { once: true });
  const timeout = setTimeout(() => aborter.abort(Object.assign(new Error("upstream deadline exceeded"), { code: "TOTAL_DEADLINE" })), Math.max(plan.deadline - Date.now(), 1));
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

  try {
    for (const candidate of plan.candidates) {
      if (aborter.signal.aborted) break;
      const candidateBody = Buffer.from(JSON.stringify({ ...body, model: candidate.upstreamModel }));
      try {
        const { response, codec, specialist, specialistProtocol } = await startAttempt({ candidate, req, path, body: candidateBody, env, signal: aborter.signal, adapters });
        activeResponse = response;
        if (aborter.signal.aborted) {
          response.destroy();
          break;
        }
        const status = response.statusCode || 502;
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
          const detail = await readSnippet(response);
          console.error(
            `upstream ${status} from ${candidate.provider.id}/${candidate.upstreamModel}: ${detail || "<empty body>"}`,
          );
          const cooldown = status === 429
            ? await status429CooldownMs(response, aborter.signal)
            : cooldownMs(response);
          discard(response);
          // A failing status describes THIS candidate (rotated model, dead
          // credential, upstream outage) — never the remaining candidates.
          // Move on so the chain survives catalog rotations and partial
          // upstream outages.
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + cooldown);
          continue;
        }
        observeUpstreamResponse(response, candidate, onUpstreamResponse);
        if (codec) {
          await respondWithCodec({ response, codec, res, status, requestId, model: candidate.upstreamModel, provider: candidate.provider.id, publicModel: plan.publicModel, signal: aborter.signal, pingMs });
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
          // Consume the service's terminal document before exposing any protocol response.
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
        const headers = { ...response.headers, "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
        // An Anthropic-protocol pass-through is repaired here rather than relayed
        // verbatim: some Anthropic-compatible upstreams answer with an array where
        // the schema wants a string, or buffer a response the caller asked to
        // stream. Healthy responses come back byte-identical.
        const thinking = body?.thinking;
        const keepReasoning = Boolean(thinking && thinking.type !== "disabled") || Boolean(body?.reasoning);
        const repaired = candidate.protocol === "messages"
          && await respondWithAnthropicPassthrough({
            response,
            res,
            status,
            headers,
            wantStream: plan.required.streaming === true,
            keepReasoning,
            signal: aborter.signal,
            pingMs,
          });
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
          // Nothing left to try: surface the verbatim cline error, but still
          // cool the candidate down so follow-up requests fail fast.
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + errorCooldownMs(error));
          res.writeHead(error.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: error.code, message: error.message, type: "cline_oauth_error" } }));
          return { committed: false, requestId };
        }
        lastStatus = 502;
        console.error(
          `attempt failed for ${candidate.provider.id}/${candidate.upstreamModel}: ${error?.message ?? error}`,
        );
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
