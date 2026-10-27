// Wire adaptation only. OpenCode owns model resolution, auth, request
// preparation, provider serialization and inference. This module executes no tools.
export class BridgeInputError extends Error {
  constructor(message, code = "unsupported_bridge_request", status = 400) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class BridgeStreamError extends BridgeInputError {
  constructor(message, code) { super(message, code); this.status = 502; }
}

// Public is a separate, explicit lane, never an automatic OAuth fallback.
export function nativeAuthMode(env) {
  const mode = env.OPENCODE_NATIVE_AUTH_MODE || "oauth";
  if (!["oauth", "public"].includes(mode)) throw new Error("Invalid OPENCODE_NATIVE_AUTH_MODE");
  if (mode === "public" && ["OPENCODE_NATIVE_SEED_FILE", "OPENCODE_API_KEY", "OPENCODE_AUTH_CONTENT", "OPENCODE_CONSOLE_TOKEN"].some(key => env[key])) {
    throw new Error("Public native workers forbid credential seeds and authentication overrides");
  }
  return mode;
}

export function assertNativeCredentialCount(mode, count) {
  if (count !== (mode === "public" ? 0 : 1)) throw new Error(mode === "public"
    ? "Public native workers require a separate state with no OpenCode credentials"
    : "The isolated native worker must own exactly one OpenCode credential");
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new BridgeInputError(message); };
const textParts = (content) => {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return fail("Message content must be text or an array of text parts");
  return content.map((part) => {
    if (!object(part) || part.type !== "text" || typeof part.text !== "string") {
      return fail("The experimental native bridge currently supports text and function tools only");
    }
    return { type: "text", text: part.text };
  });
};

// Enforce limits while reading, before buffering or JSON parsing can consume
// an arbitrarily large chunked upload. Cancellation never starts inference.
export async function readChatBody(request, { limit = 16 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void request.body?.cancel().catch(() => {});
    if (!/^\d+$/.test(length)) throw new BridgeInputError("Invalid Content-Length header", "native_request_length_invalid");
    throw new BridgeInputError("Request exceeds the native bridge body limit", "native_request_too_large", 413);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  let failure;
  const stop = (error) => {
    if (failure) return;
    failure = error;
    void reader.cancel().catch(() => {});
  };
  const abort = () => stop(new BridgeInputError("Request body was cancelled", "native_request_cancelled", 408));
  const timer = setTimeout(() => stop(new BridgeInputError("Request body upload deadline exceeded", "native_request_body_timeout", 408)), timeoutMs);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const buffer = Buffer.allocUnsafe(length === null ? limit : Number(length));
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (failure) throw failure;
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new BridgeInputError("Request exceeds the native bridge body limit", "native_request_too_large", 413);
      if (size > buffer.byteLength) throw new BridgeInputError("Body does not match Content-Length", "native_request_length_invalid");
      buffer.set(part.value, size - part.value.byteLength);
    }
    if (length !== null && size !== Number(length)) throw new BridgeInputError("Body does not match Content-Length", "native_request_length_invalid");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)); }
    catch { throw new BridgeInputError("Request body must be valid UTF-8", "native_request_encoding_invalid"); }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

export function decodeChatRequest(body) {
  if (!object(body)) return fail("Request must be a JSON object");
  const supported = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "user"]);
  for (const key of Object.keys(body)) if (!supported.has(key)) return fail(`Unsupported native bridge request field: ${key}`);
  if (typeof body.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.model)) return fail("Select a bare model ID from the native worker catalog");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 4096) return fail("messages must contain between 1 and 4096 messages");
  if (body.stream !== undefined && typeof body.stream !== "boolean") return fail("stream must be boolean");
  if (body.stream_options != null && (!object(body.stream_options) || Object.keys(body.stream_options).some((key) => key !== "include_usage") || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean"))) return fail("Unsupported stream_options");
  if (body.user !== undefined) return fail("The native bridge does not forward user attribution; use the gateway session header");

  const calls = new Map();
  const results = new Set();
  const system = [];
  let conversationStarted = false;
  const messages = body.messages.map((message) => {
    if (!object(message) || !["system", "user", "assistant", "tool"].includes(message.role)) return fail("Unsupported message role");
    const allowed = new Set(["role", "content", "reasoning_content", "reasoning", "tool_calls", "tool_call_id", "is_error", "provider_metadata"]);
    for (const key of Object.keys(message)) if (!allowed.has(key)) return fail(`Unsupported native bridge message field: ${key}`);
    const content = textParts(message.content);
    if (message.is_error !== undefined && (message.role !== "tool" || typeof message.is_error !== "boolean")) return fail("is_error must be a boolean on tool results");
    if (message.provider_metadata !== undefined) return fail("Opaque provider metadata replay is not supported by this experimental bridge");
    if ((message.reasoning_content !== undefined || message.reasoning !== undefined) && message.role !== "assistant") return fail("Reasoning fields must belong to an assistant message");
    if ([message.reasoning_content, message.reasoning].some(value => value != null && typeof value !== "string")) return fail("Reasoning must be textual");
    if (message.reasoning_content != null && message.reasoning != null && message.reasoning_content !== message.reasoning) return fail("Conflicting assistant reasoning fields");
    if (message.tool_calls !== undefined && (message.role !== "assistant" || !Array.isArray(message.tool_calls))) return fail("tool_calls must belong to an assistant message");
    if (message.tool_call_id !== undefined && message.role !== "tool") return fail("tool_call_id must belong to a tool result");
    if (message.role === "system") {
      if (conversationStarted) return { role: "system", content };
      system.push(...content);
      return null;
    }
    conversationStarted = true;
    const reasoning = message.reasoning_content ?? message.reasoning ?? undefined;
    if (reasoning !== undefined) {
      if (message.role !== "assistant" || typeof reasoning !== "string") return fail("reasoning_content is supported only as assistant text");
      content.unshift({ type: "reasoning", text: reasoning });
    }
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return fail("tool_calls must belong to an assistant message");
      for (const call of message.tool_calls) {
        if (!object(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || !object(call.function) || typeof call.function.name !== "string") return fail("Invalid function tool call");
        if (calls.has(call.id)) return fail("Tool call IDs must be unique within the supplied history");
        if (call.function.arguments !== undefined && typeof call.function.arguments !== "string") return fail("Tool call arguments must be a JSON string");
        let input;
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { return fail("Tool call arguments must be valid JSON"); }
        calls.set(call.id, call.function.name);
        content.push({ type: "tool-call", id: call.id, name: call.function.name, input });
      }
    }
    if (message.role === "tool") {
      const name = calls.get(message.tool_call_id);
      if (!name) return fail("Tool results must reference an earlier assistant tool call");
      if (results.has(message.tool_call_id)) return fail("Each tool call must have only one result");
      results.add(message.tool_call_id);
      return { role: "tool", content: [{ type: "tool-result", id: message.tool_call_id, name, result: { type: message.is_error ? "error" : "text", value: content.map((part) => part.text).join("") } }] };
    }
    return { role: message.role, content, ...(message.provider_metadata ? { providerMetadata: message.provider_metadata } : {}) };
  }).filter(Boolean);

  if (body.tools !== undefined && !Array.isArray(body.tools)) return fail("tools must be an array");
  const names = new Set();
  const tools = (body.tools || []).map((tool) => {
    if (!object(tool) || tool.type !== "function" || !object(tool.function)) return fail("Only function tools are supported");
    const fn = tool.function;
    if (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name) || names.has(fn.name)) return fail("Tool names must be valid and unique");
    if (fn.description !== undefined && typeof fn.description !== "string") return fail("Tool descriptions must be text");
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") return fail("Tool strict flags must be boolean");
    if (fn.strict === true) return fail("Strict tool schemas are not supported by the pinned native chat compiler");
    if (!object(fn.parameters)) return fail("Function tools require a JSON schema object");
    names.add(fn.name);
    return { type: "function", name: fn.name, description: fn.description || "", inputSchema: fn.parameters };
  });
  let toolChoice;
  if (body.tool_choice !== undefined) {
    if (["auto", "none", "required"].includes(body.tool_choice)) toolChoice = { type: body.tool_choice };
    else if (body.tool_choice?.type === "function" && names.has(body.tool_choice.function?.name)) toolChoice = { type: "tool", name: body.tool_choice.function.name };
    else return fail("Unsupported tool_choice or unknown selected tool");
  }
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") return fail("parallel_tool_calls must be boolean");
    toolChoice = { ...(toolChoice || { type: "auto" }), disableParallelToolUse: !body.parallel_tool_calls };
  }
  const options = {};
  if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined && body.max_completion_tokens !== body.max_tokens) return fail("Conflicting output token limits");
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) {
    if (!Number.isSafeInteger(max) || max < 1 || max > 262144) return fail("Invalid output token limit");
    options.maxTokens = max;
  }
  for (const [key, target, min, max] of [["temperature", "temperature", 0, 2], ["top_p", "topP", 0, 1]]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < min || body[key] > max) return fail(`Invalid ${key}`);
    options[target] = body[key];
  }
  if (body.stop !== undefined) {
    const stop = typeof body.stop === "string" ? [body.stop] : body.stop;
    if (!Array.isArray(stop) || stop.some((value) => typeof value !== "string")) return fail("Invalid stop sequences");
    options.stop = stop;
  }
  if (body.reasoning_effort !== undefined) {
    if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(body.reasoning_effort)) return fail("Unsupported reasoning_effort");
    options.reasoningEffort = body.reasoning_effort;
  }
  return { model: body.model, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, system, messages, tools, toolChoice, options };
}

export function safeNativeError(error) {
  if (error instanceof BridgeInputError) return { status: error.status, error: { type: error.status >= 400 && error.status < 500 ? "invalid_request_error" : "native_bridge_error", code: error.code, message: error.message } };
  const reason = error?.reason || error?.cause?.reason || {};
  const tag = reason._tag;
  const upstreamStatus = reason.http?.status;
  const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus
    : tag === "QuotaExceeded" || tag === "RateLimit" ? 429 : tag === "Authentication" ? 401 : tag === "InvalidRequest" ? 400 : 502;
  const codes = new Set(["FreeUsageLimitError", "FreeTierError", "rate_limit_error", "invalid_request_error", "authentication_error"]);
  let upstreamCode;
  try {
    const parsed = JSON.parse(reason.body || "{}");
    const candidate = parsed?.error?.type || parsed?.error?.code || parsed?.code;
    if (codes.has(candidate)) upstreamCode = candidate;
  } catch { /* Never return raw provider bodies or credential-bearing messages. */ }
  const retry = reason.retryAfterMs ?? reason.rateLimit?.retryAfterMs;
  const requestId = reason.http?.headers?.["x-opencode-log-id"] || reason.http?.headers?.["x-request-id"];
  const parameter = typeof reason.parameter === "string" && /^(messages|tools|model|max_tokens|stream|temperature|reasoning)[.\[\]a-zA-Z0-9_-]{0,100}$/.test(reason.parameter) ? reason.parameter : undefined;
  return { status, error: {
    type: status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : "native_bridge_error",
    code: upstreamCode || (tag ? `native_${tag.replace(/[^A-Za-z]/g, "").toLowerCase()}` : "native_worker_unavailable"),
    message: `OpenCode native inference failed (${upstreamCode || tag || "worker unavailable"}); no raw provider body is exposed.`,
    upstream_status: upstreamStatus,
    ...(Number.isFinite(retry) && retry > 0 ? { retry_after_seconds: Math.ceil(retry / 1000), retry_at: new Date(Date.now() + retry).toISOString() } : {}),
    ...(typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? { upstream_request_id: requestId } : {}),
    ...(parameter ? { parameter } : {}),
  } };
}

export function createChatEncoder({ model, id, created = Math.floor(Date.now() / 1000), includeUsage = true }) {
  const tools = new Map();
  const blocks = new Map();
  let content = "", reasoning = "", finished = false, finishReason = "stop", usage;
  const chunk = (delta, finish = null, extra = {}) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  return {
    push(event) {
      if (finished) return [];
      if (event.type.startsWith("reasoning-") && event.providerMetadata && /"(?:signature|encrypted[^" ]*|reasoningId)"/i.test(JSON.stringify(event.providerMetadata))) throw new BridgeStreamError("Opaque reasoning replay is unsupported", "native_reasoning_metadata_unsupported");
      if (["text-delta", "reasoning-delta", "text-end", "reasoning-end"].includes(event.type)) {
        const isReasoning = event.type.startsWith("reasoning-");
        const key = `${isReasoning ? "reasoning" : "text"}:${event.id || "default"}`;
        const previous = blocks.get(key) || "";
        let text = event.text || "";
        if (event.type.endsWith("-end")) {
          if (event.text === undefined) return [];
          if (!text.startsWith(previous)) throw new BridgeStreamError("Native provider revised already streamed content", "native_stream_revision_unsupported");
          text = text.slice(previous.length);
        }
        blocks.set(key, previous + text);
        if (!text) return [];
        if (isReasoning) reasoning += text; else content += text;
        return [chunk(isReasoning ? { reasoning_content: text } : { content: text })];
      }
      if (event.type === "tool-call") {
        if (event.providerExecuted) throw new BridgeStreamError("Provider-executed tools are unsupported", "provider_tools_unsupported");
        const call = { id: event.id, type: "function", function: { name: event.name, arguments: JSON.stringify(event.input) } };
        if (tools.has(event.id)) throw new BridgeStreamError("Duplicate native tool call ID", "native_stream_invalid");
        tools.set(event.id, call);
        return []; // Never expose executable calls until the terminal outcome is known.
      }
      if (event.type === "provider-error") throw new BridgeStreamError("Provider emitted an error event", "native_provider_error");
      if (["tool-input-error", "tool-result", "tool-error", "media", "compaction"].includes(event.type)) throw new BridgeStreamError("Native stream contained unsupported or invalid output", "native_stream_invalid");
      if (event.type !== "finish") return [];
      const reason = event.reason?.normalized;
      if (!["stop", "length", "tool-calls", "content-filter"].includes(reason)) throw new BridgeStreamError("Native stream did not finish successfully", "native_stream_incomplete");
      if (reason === "length" || reason === "content-filter") tools.clear();
      if (reason === "tool-calls" && !tools.size) throw new BridgeStreamError("Native tool completion contained no calls", "native_stream_invalid");
      finishReason = reason === "length" ? "length" : reason === "content-filter" ? "content_filter" : tools.size ? "tool_calls" : "stop";
      if (!content && !reasoning && !tools.size && finishReason === "stop") throw new BridgeStreamError("Native stream completed without semantic output", "native_stream_empty");
      finished = true;
      usage = event.usage && { prompt_tokens: event.usage.inputTokens || 0, completion_tokens: event.usage.outputTokens || 0, total_tokens: (event.usage.inputTokens || 0) + (event.usage.outputTokens || 0) };
      return [...tools.values()].map((call, index) => chunk({ tool_calls: [{ index, ...call }] })).concat(chunk({}, finishReason, usage && includeUsage ? { usage } : {}));
    },
    end() { if (!finished) throw new BridgeStreamError("Native stream ended without a terminal event", "native_stream_incomplete"); },
    completion() {
      this.end();
      return { id, object: "chat.completion", created, model, choices: [{ index: 0, finish_reason: finishReason, message: {
        role: "assistant", content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.size ? { tool_calls: [...tools.values()] } : {}),
      } }], ...(usage ? { usage } : {}) };
    },
  };
}
