import { randomUUID } from "node:crypto";
import { startAttempt } from "./provider-adapters.mjs";
import {
  collectAnthropicStream,
  createAnthropicStreamCodec,
  createSseChunkReader,
  openaiToAnthropicMessage,
  openaiReasoningText,
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

function upstreamRequestId(response) {
  for (const key of ["x-opencode-log-id", "x-request-id", "request-id"]) {
    const value = response?.headers?.[key];
    if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  }
  return null;
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
const SAFE_ZEN_ERROR_CODES = new Set(["FreeUsageLimitError", "FreeTierError", "rate_limit_error", "invalid_request_error", "authentication_error", "permission_error", "model_not_found"]);

function classifyZenErrorBody(text) {
  if (typeof text !== "string") return { category: "unknown", providerErrorCode: null };
  let errorCode = "";
  let errorType = "";
  let detail = text;
  let parameter;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    const candidateParam = typeof error?.param === "string" ? error.param : /Missing required parameter: ['"]([^'"]+)['"]/.exec(error?.message || "")?.[1];
    if (typeof candidateParam === "string" && /^(messages|tools|model|max_tokens|stream|temperature|reasoning)([.\[\]a-zA-Z0-9_-]*)$/.test(candidateParam) && candidateParam.length <= 128) parameter = candidateParam;
    errorCode = typeof error?.code === "string" ? error.code : typeof parsed?.code === "string" ? parsed.code : "";
    errorType = typeof error?.type === "string" ? error.type : typeof parsed?.type === "string" ? parsed.type : "";
    if (typeof error === "string") detail = error;
    else if (error && typeof error === "object") detail = [errorCode, errorType, error.message].filter((value) => typeof value === "string").join(" ");
    else detail = [errorCode, errorType, parsed?.message].filter((value) => typeof value === "string").join(" ");
  } catch {}
  const normalized = `${errorCode} ${errorType} ${detail}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let category = "unknown";
  if (["FreeUsageLimitError", "FreeTierError"].includes(errorCode) || ["FreeUsageLimitError", "FreeTierError"].includes(errorType)) {
    category = errorCode === "FreeUsageLimitError" || errorType === "FreeUsageLimitError" ? "free_usage_limit" : "free_tier_rejection";
  } else if (/abusive traffic|suspicious traffic|ip address.*blocked|blocked.*ip address/.test(normalized)) category = "network_rejection";
  else if (["rate_limit_error"].includes(errorCode) || ["rate_limit_error"].includes(errorType)
    || /rate limit error|rate limit|too many requests/.test(normalized)) category = "rate_limit";
  else if (/account quota|daily quota|monthly quota|quota exhausted|quota exceeded|insufficient credits|out of credits/.test(normalized)
    || DAILY_QUOTA_BODY_PATTERN.test(normalized)) category = "accountquota";
  else if (/model capacity|capacity for (this )?model|model overloaded|model unavailable/.test(normalized)) category = "modelcapacity";
  const providerErrorCode = SAFE_ZEN_ERROR_CODES.has(errorCode) ? errorCode : SAFE_ZEN_ERROR_CODES.has(errorType) ? errorType : null;
  return { category, providerErrorCode, ...(parameter ? { parameter } : {}) };
}

async function status429Diagnostics(response, signal) {
  const retryAfter = Number(response?.headers?.["retry-after"]);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
  let classification = { category: "unknown", providerErrorCode: null };
  let legacyCooldown = cooldownMs(response);
  try {
    const text = await readBodyText(response, signal, 4096, 1000);
    classification = classifyZenErrorBody(text);
    if (typeof text === "string" && DAILY_QUOTA_BODY_PATTERN.test(text)) legacyCooldown = DAILY_QUOTA_COOLDOWN_MS;
  } catch {
    // Diagnostics must not interfere with the established retry policy.
  }
  return { legacyCooldown, ...classification, retryAfterMs };
}

function readBodyText(response, signal, limit = 4096, timeoutMs = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timeout = timeoutMs === null ? null : setTimeout(() => finish(resolve, null), timeoutMs);
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => { cleanup(); fn(value); };
    const onData = (chunk) => {
      const remaining = limit - size;
      if (remaining > 0) {
        const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(bounded);
        size += bounded.length;
      }
      if (size >= limit) {
        response.pause();
        finish(resolve, Buffer.concat(chunks, size).toString("utf8"));
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
function preflightOpenCodeStream(response, signal, limit = 256 * 1024, deadlineMs = 90000, { allowRetryAfterSemantic = false, waitForCompletion = false } = {}) {
  return new Promise((resolve) => {
    const parser = createSseChunkReader();
    const decoder = new TextDecoder();
    let prefixText = "";
    let bytes = 0;
    let semantic = false;
    let complete = false;
    let finishSeen = false;
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
      if (payload === "[DONE]") {
        if (waitForCompletion && !semantic) return new Error("OpenCode completed without a message or tool call");
        complete = true;
        return null;
      }
      let frame;
      try { frame = JSON.parse(payload); } catch { return new Error("OpenCode stream contained malformed JSON"); }
      if (frame?.error) return new Error("OpenCode returned an embedded stream error");
      const choice = frame?.choices?.[0];
      const delta = choice?.delta || {};
      if ((typeof delta.content === "string" && delta.content.length)
        || (typeof delta.reasoning === "string" && delta.reasoning.length)
        || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length)
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => call?.id || call?.function?.name || call?.function?.arguments))) semantic = true;
      if (waitForCompletion && choice?.finish_reason === "content_filter") semantic = true;
      if (choice?.finish_reason) {
        if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice.finish_reason)) return new Error("OpenCode stream reported an unsuccessful finish");
        if (waitForCompletion && !semantic && choice.finish_reason !== "content_filter") return new Error("OpenCode completed without a message or tool call");
        if (waitForCompletion && choice.finish_reason === "content_filter") semantic = true;
        finishSeen = true;
        if (!waitForCompletion) complete = true;
        if (!waitForCompletion) semantic = true;
      }
      return null;
    };
    const onData = (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) return finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, error: new Error("OpenCode stream preamble exceeded its bound") });
      const decoded = decoder.decode(buffer, { stream: true });
      prefixText += decoded;
      for (const payload of parser.push(decoded)) {
        const error = inspect(payload);
        if (error) return finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, error });
      }
      if (complete && (!waitForCompletion || finishSeen)) finish({ retryable: false, semantic, complete });
      else if (semantic && !waitForCompletion) finish({ retryable: false, semantic, complete });
    };
    const onEnd = () => {
      const tail = decoder.decode();
      if (tail) {
        if (bytes + Buffer.byteLength(tail) > limit) return finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, error: new Error("OpenCode stream preamble exceeded its bound") }, true);
        prefixText += tail;
        for (const payload of parser.push(tail)) {
          const error = inspect(payload);
          if (error) return finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, error }, true);
        }
      }
      finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, complete, error: complete && semantic && (!waitForCompletion || finishSeen) ? null : new Error("OpenCode stream ended before completion") }, true);
    };
    const onError = (error) => finish({ retryable: (allowRetryAfterSemantic || !semantic) && !signal?.aborted, semantic, error }, true);
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

async function collectOpenAIChatCompletion(response, preflight, model) {
  const reader = createSseChunkReader();
  const decoder = preflight?.decoder || new TextDecoder();
  let size = 0;
  let completion = null;
  let done = false;
  const choices = new Map();
  let sawFinish = false;
  let semantic = false;
  let contentFiltered = false;
  const fail = (message) => { throw Object.assign(new Error(message), { upstreamStreamError: true }); };
  const consume = (text) => {
    for (const payload of reader.push(text)) {
      if (payload === "[DONE]") { done = true; continue; }
      let frame;
      try { frame = JSON.parse(payload); } catch { fail("OpenCode stream contained malformed JSON"); }
      if (!frame || typeof frame !== "object" || frame.error) fail("OpenCode returned an embedded stream error");
      if (!completion) completion = { id: frame.id, object: "chat.completion", created: frame.created, model: frame.model || model, choices: [], usage: null };
      if (frame.usage && typeof frame.usage === "object") completion.usage = frame.usage;
      for (const part of frame.choices || []) {
        if (!Number.isInteger(part.index) || part.index < 0) fail("OpenCode stream contained an invalid choice index");
        let choice = choices.get(part.index);
        if (!choice) { choice = { index: part.index, message: { role: "assistant", content: "" }, finish_reason: null }; choices.set(part.index, choice); }
        const delta = part.delta || {};
        if (delta.role) choice.message.role = delta.role;
        if (typeof delta.content === "string") { choice.message.content += delta.content; if (delta.content.length) semantic = true; }
        if (typeof delta.reasoning_content === "string") {
          choice.message.reasoning_content = (choice.message.reasoning_content || "") + delta.reasoning_content;
          if (delta.reasoning_content.length) semantic = true;
        }
        if (Array.isArray(delta.tool_calls)) {
          choice.message.tool_calls ||= [];
          for (const call of delta.tool_calls) {
            if (!Number.isInteger(call.index) || call.index < 0) fail("OpenCode stream contained an invalid tool index");
            let tool = choice.message.tool_calls[call.index];
            if (!tool) { tool = { id: "", type: call.type || "function", function: { name: "", arguments: "" } }; choice.message.tool_calls[call.index] = tool; }
            if (call.id) { tool.id += call.id; semantic = true; }
            if (call.type) tool.type = call.type;
            if (call.function?.name) tool.function.name += call.function.name;
            if (typeof call.function?.arguments === "string") { tool.function.arguments += call.function.arguments; if (call.function.arguments.length) semantic = true; }
          }
        }
        if (part.finish_reason) { choice.finish_reason = part.finish_reason; sawFinish = true; if (part.finish_reason === "content_filter") contentFiltered = true; }
      }
      size += Buffer.byteLength(payload);
      if (size > 32 * 1024 * 1024) fail("OpenCode completion exceeded its size bound");
    }
  };
  if (preflight?.error) throw preflight.error;
  if (preflight?.prefixText) consume(preflight.prefixText);
  if (!preflight?.ended) {
    for await (const chunk of response) consume(decoder.decode(chunk, { stream: true }));
    consume(decoder.decode());
  }
  if (!completion || !done || !choices.size || !sawFinish || (!semantic && !contentFiltered)) fail("OpenCode stream ended before completion");
  completion.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  for (const choice of completion.choices) {
    if (!choice.finish_reason || !["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice.finish_reason)) fail("OpenCode stream reported an incomplete completion");
    const hasText = choice.message.content.trim().length > 0;
    const hasReasoning = typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content.length > 0;
    const hasTools = choice.message.tool_calls?.length > 0;
    if (!hasText && !hasReasoning && !hasTools && choice.finish_reason !== "content_filter") fail("OpenCode completed without a message or tool call");
  }
  return completion;
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
  // Translated completions must be validated before committing response headers,
  // so an invalid upstream result can flow through the normal candidate fallback.
  const validateCompletion = (completion) => {
    if (completion?.error) throw Object.assign(new Error("Upstream returned an embedded completion error"), { upstreamStreamError: true });
    const choice = completion?.choices?.[0];
    const finish = choice?.finish_reason;
    if (!choice || !finish || !["stop", "length", "tool_calls", "function_call", "content_filter"].includes(finish)) {
      throw Object.assign(new Error("Upstream returned an incomplete completion"), { upstreamStreamError: true });
    }
    const message = choice.message || {};
    const text = typeof message.content === "string" && message.content.trim().length > 0;
    const reasoning = codec.keepReasoning && openaiReasoningText(message).length > 0;
    const tools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!text && !reasoning && !tools && !["content_filter", "length"].includes(finish)) {
      throw Object.assign(new Error("Upstream completed without a message or tool call"), { upstreamStreamError: true });
    }
  };
  if (!contentType.includes("text/event-stream")) {
    const raw = await readBodyText(response, signal, 32 * 1024 * 1024);
    let completion;
    try {
      completion = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("Upstream returned an unreadable completion body"), { upstreamStreamError: true });
    }
    try {
      validateCompletion(completion);
    } catch (error) {
      if (strictCompletion) response._opencodePoolStreamState = { failure: error };
      throw error;
    }
    const message = openaiToAnthropicMessage(completion, { model, keepReasoning: codec.keepReasoning === true });
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
  const encoder = createAnthropicStreamCodec({ model, strictCompletion, keepReasoning: codec.keepReasoning === true });
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
  const upstreamFailures = [];
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
      let status429Info;
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
             if (error?.poolExhausted && !aborter.signal.aborted) {
               for (const slot of error.poolDiagnostics || []) {
                 if (slot.reason === "model_ineligible") continue;
                 const remaining = Math.max(0, Number(slot.remaining_ms) || 0);
                 upstreamFailures.push({ provider: candidate.provider.id, model: candidate.upstreamModel,
                   account_slot: slot.slot, category: slot.failure?.category || slot.reason,
                   ...(slot.failure || {}), ...(remaining ? { retry_after_seconds: Math.ceil(remaining / 1000), retry_at: new Date(Date.now() + remaining).toISOString() } : {}) });
               }
               // OpenCode account pool exhausted for this candidate; try the
               // next configured route instead of aborting the whole request.
               attemptResult = null;
               continue candidateLoop;
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
          status429Info = status === 429 && !candidate.specialist && !attemptResult.nativeBridge ? await status429Diagnostics(response, aborter.signal) : null;
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
              const directChatNonstream = !attemptResult.codec && candidate.protocol === "chat_completions" && body?.stream !== true;
              const preflight = await preflightOpenCodeStream(response, aborter.signal, directChatNonstream ? 32 * 1024 * 1024 : 256 * 1024, Math.max(1, plan.deadline - Date.now()), { allowRetryAfterSemantic: directChatNonstream, waitForCompletion: directChatNonstream });
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
              const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
              let info = status429Info;
              if (!info) {
                const raw = await readBodyText(response, aborter.signal, 4096, 1000).catch(() => "");
                info = classifyZenErrorBody(raw);
              }
              const diagnostic = { provider: candidate.provider.id, model: candidate.upstreamModel,
                account_slot: openCodeAccountPool.slot?.(attemptResult.poolAccount), egress: attemptResult.egress,
                upstream_status: status, ...(upstreamRequestId(response) ? { upstream_request_id: upstreamRequestId(response) } : {}), category: info.category === "unknown" ? (status === 401 ? "authentication" : status === 403 ? "access_denied" : status >= 500 ? "upstream_server_error" : "request_rejected") : info.category,
                ...(info.providerErrorCode ? { upstream_error_code: info.providerErrorCode } : {}),
                ...(info.parameter ? { parameter: info.parameter } : {}) };
              openCodeAccountPool.markFailure(attemptResult.poolAccount, new Error(`upstream ${status}`), { retryAfterMs, diagnostic });
              const until = openCodeAccountPool.state.get(attemptResult.poolAccount.id)?.until || 0;
              if (until > Date.now()) Object.assign(diagnostic, { retry_after_seconds: Math.ceil((until - Date.now()) / 1000), retry_at: new Date(until).toISOString() });
              upstreamFailures.push(diagnostic);
              trace?.emit("upstream_diagnostic", { provider: candidate.provider.id, upstream_model: candidate.upstreamModel, status, slot: diagnostic.account_slot, egress: diagnostic.egress, category: diagnostic.category, upstream_error_code: diagnostic.upstream_error_code });
              if (status429Info) {
                const cooldownUntil = openCodeAccountPool.state.get(attemptResult.poolAccount.id)?.until || 0;
                trace?.emit("upstream_429", {
                  provider: candidate.provider.id,
                  upstream_model: candidate.upstreamModel,
                  status,
                  category: status429Info.category,
                  ...(status429Info.providerErrorCode ? { upstream_error_code: status429Info.providerErrorCode } : {}),
                  ...(status429Info.retryAfterMs !== null ? { retry_after_ms: status429Info.retryAfterMs } : {}),
                  cooldown_ms: Math.max(0, cooldownUntil - Date.now()),
                  slot: openCodeAccountPool.slot?.(attemptResult.poolAccount),
                });
              }
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
          if (attemptResult.nativeBridge) {
            const raw = await readBodyText(response, aborter.signal, 16384);
            let failure;
            try { failure = JSON.parse(raw)?.error; } catch { /* An invalid worker response is never forwarded verbatim. */ }
            const valid = failure && typeof failure.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(failure.code) && typeof failure.message === "string" && failure.message.length <= 2048;
            const retryAfter = response.headers["retry-after"];
            res.writeHead(status, { "content-type": "application/json", "x-gateway-request-id": requestId, "x-gateway-provider": candidate.provider.id,
              ...(typeof retryAfter === "string" && /^\d{1,8}$/.test(retryAfter) ? { "retry-after": retryAfter } : {}) });
            res.end(JSON.stringify({ error: { ...(valid ? failure : { code: "native_worker_invalid_error", message: "The native worker returned an invalid error response", type: "native_bridge_error" }), request_id: requestId } }));
            return { committed: false, requestId, provider: candidate.provider.id };
          }
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
            if (![429, 401, 403].includes(status) && status < 500) {
              const raw = await readBodyText(response, aborter.signal, 4096, 1000).catch(() => "");
              const info = classifyZenErrorBody(raw);
              upstreamFailures.push({ provider: candidate.provider.id, model: candidate.upstreamModel,
                account_slot: openCodeAccountPool.slot?.(poolAccount), egress: attemptResult.egress,
                upstream_status: status, ...(upstreamRequestId(response) ? { upstream_request_id: upstreamRequestId(response) } : {}), category: "request_rejected",
                ...(info.providerErrorCode ? { upstream_error_code: info.providerErrorCode } : {}),
                ...(info.parameter ? { parameter: info.parameter } : {}) });
            }
            discard(response);
            continue candidateLoop;
          }
          const cooldown = status === 429
            ? status429Info?.legacyCooldown ?? cooldownMs(response)
            : cooldownMs(response);
          discard(response);
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + cooldown);
          continue;
        }
        observeUpstreamResponse(response, candidate, onUpstreamResponse);
        if (attemptResult.nativeBridge) {
          for (const name of ["x-opencode-native-version", "x-opencode-native-session"]) {
            const value = response.headers[name];
            if (typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)) res.setHeader(name, value);
          }
        }
        if (poolAccount && !codec && candidate.protocol === "chat_completions" && body?.stream !== true && String(response.headers?.["content-type"] || "").includes("text/event-stream")) {
          const completion = await collectOpenAIChatCompletion(response, streamPreflight, candidate.upstreamModel);
          const base = { "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
          res.writeHead(status, { ...base, "content-type": "application/json" });
          res.end(JSON.stringify(completion));
          openCodeAccountPool.markSuccess(poolAccount, poolStickyKey, poolGeneration);
          if (affinityKey && plan.profile && runtimeState.affinity) runtimeState.affinity.set(`${affinityKey}:${plan.profile}`, { provider: candidate.provider.id, model: candidate.upstreamModel, updatedAt: Date.now() });
          recordModelFamily(runtimeState, historyKey === undefined ? affinityKey : historyKey, candidate);
          return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1 };
        }
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
          await respondWithCodec({ response, codec, res, status, requestId, model: candidate.upstreamModel, provider: candidate.provider.id, publicModel: plan.publicModel, signal: aborter.signal, pingMs, strictCompletion: true, preflight: streamPreflight });
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
        if (candidate.provider.adapter === "opencode-native") {
          res.writeHead(error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502, { "content-type": "application/json", "x-gateway-request-id": requestId, "x-gateway-provider": candidate.provider.id });
          const unsupported = error?.statusCode === 400 && error?.code === "unsupported_bridge_request";
          const detail = unsupported && typeof error.message === "string" && error.message.length <= 512 ? error.message : "The experimental OpenCode native worker is unavailable or incompatible; no legacy fallback was attempted";
          res.end(JSON.stringify({ error: { code: error?.statusCode === 400 ? "unsupported_bridge_request" : error?.code === "native_worker_version_mismatch" ? error.code : "native_worker_unavailable", type: unsupported ? "invalid_request_error" : "native_bridge_error", message: detail, request_id: requestId } }));
          return { committed: false, requestId, provider: candidate.provider.id };
        }
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
    const failures = [...new Map(upstreamFailures.map((item) => [`${item.provider}/${item.model}/${item.account_slot}`, item])).values()].slice(-32);
    const limited = failures.length && failures.every((item) => item.upstream_status === 429);
    const rejected = failures.length && failures.every((item) => item.upstream_status === 400);
    const retry = limited ? Math.min(...failures.map((item) => item.retry_after_seconds).filter((value) => value > 0)) : null;
    const commonStatus = failures.length && failures.every((item) => item.upstream_status === failures[0].upstream_status) ? failures[0].upstream_status : null;
    const freeTierRejected = failures.some((item) => item.upstream_error_code === "FreeTierError");
    const status = commonStatus >= 400 && commonStatus < 500 ? commonStatus : failureStatus(lastStatus);
    const message = limited
      ? "OpenCode Zen free usage or rate limit reached on all eligible accounts; see upstream_errors for account, egress, reason, and reset time."
      : freeTierRejected ? "OpenCode Zen rejected free-tier access (client/session/authentication gate); see upstream_errors. This is distinct from free usage quota exhaustion."
      : commonStatus === 401 ? "OpenCode Zen rejected authentication; see upstream_errors for account and egress."
      : rejected ? "OpenCode Zen rejected the request; see upstream_errors for the error code and parameter."
      : failures.length ? "OpenCode Zen accounts are unavailable; see upstream_errors for individual causes."
      : "No eligible upstream completed the request";
    const diagnosticSummary = failures.slice(0, 8).map((item) =>
      `account ${item.account_slot ?? "unknown"} (${item.egress || "unknown egress"}): ${item.upstream_status ? `HTTP ${item.upstream_status} ` : ""}${item.upstream_error_code || item.category}${item.parameter ? ` parameter=${item.parameter}` : ""}${item.retry_at ? ` retry_at=${item.retry_at}` : ""}`
    ).join("; ");
    res.writeHead(status, { "content-type": "application/json", "x-gateway-request-id": requestId,
      ...(Number.isFinite(retry) ? { "retry-after": String(retry) } : {}) });
    res.end(JSON.stringify({ error: { message: diagnosticSummary ? `${message} ${diagnosticSummary}` : message, type: limited ? "rate_limit_error" : rejected ? "invalid_request_error" : "gateway_upstream_error",
      code: limited ? "opencode_accounts_rate_limited" : freeTierRejected ? "opencode_free_tier_rejected" : rejected ? "opencode_request_rejected" : "upstreams_unavailable",
      request_id: requestId, model: plan.publicModel, ...(failures.length ? { upstream_errors: failures } : {}) } }));
  }
  return { committed: false, requestId };
}
