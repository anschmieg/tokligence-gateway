// Repairs Anthropic-protocol pass-through responses before they reach a client.
//
// Mistral's Anthropic-compatible /v1/messages endpoint relays two shapes that a
// strict Anthropic client cannot parse:
//
//   1. a `text` field holding an ARRAY of sub-blocks (reasoning first, answer
//      last) instead of a string, e.g.
//        [{"type":"thinking","thinking":[...],"closed":true},{"type":"text","text":"OK"}]
//   2. a buffered `application/json` message even when the caller asked for a
//      stream, so `stream: true` yields zero server-sent events.
//
// Conforming responses are relayed byte-for-byte: this module only rewrites a
// payload it recognises as malformed, or synthesises the stream the caller
// asked for and the upstream did not produce.

import { collectAnthropicStream } from "./anthropic-openai-codec.mjs";

const REASONING_TYPES = new Set(["thinking", "reasoning", "reasoning_content"]);

const LEGAL_BLOCK_TYPES = new Set([
  "text",
  "image",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "mcp_tool_use",
  "mcp_tool_result",
  "documentation",
]);

const MAX_PASSTHROUGH_BYTES = 32 * 1024 * 1024;

/** Flattens any nested textual payload into one string. */
export function joinParts(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(joinParts).join("");
  if (value && typeof value === "object") {
    if ("text" in value) return joinParts(value.text);
    if ("thinking" in value) return joinParts(value.thinking);
    if ("reasoning" in value) return joinParts(value.reasoning);
    if ("content" in value) return joinParts(value.content);
    return "";
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function isReasoning(block) {
  return REASONING_TYPES.has(block?.type)
    || typeof block?.reasoning === "string"
    || typeof block?.reasoning_content === "string";
}

/** Turns one upstream block into legal Anthropic blocks, appending to `out`. */
function pushBlock(block, out) {
  if (block === null || block === undefined) return;
  if (typeof block === "string") {
    if (block) out.push({ type: "text", text: block });
    return;
  }
  if (Array.isArray(block)) {
    for (const item of block) pushBlock(item, out);
    return;
  }
  if (typeof block !== "object") return;

  const type = typeof block.type === "string" ? block.type : undefined;

  if (type === "redacted_thinking" && typeof block.data === "string") {
    out.push({ type: "redacted_thinking", data: block.data });
    return;
  }

  if (isReasoning(block)) {
    const thinking = joinParts(block.thinking ?? block.reasoning ?? block.reasoning_content ?? block.content);
    if (!thinking) return;
    out.push({
      type: "thinking",
      thinking,
      ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
    });
    return;
  }

  if (type === "text" || (type === undefined && "text" in block)) {
    const text = block.text;
    // An array here is another layer of sub-blocks, not literal text.
    if (Array.isArray(text)) {
      for (const item of text) pushBlock(item, out);
      return;
    }
    out.push({ type: "text", text: joinParts(text) });
    return;
  }

  if (LEGAL_BLOCK_TYPES.has(type)) {
    out.push(block);
    return;
  }

  if (Array.isArray(block.content)) {
    for (const item of block.content) pushBlock(item, out);
    return;
  }

  // Unknown shape: surface any text rather than forward an unrecognised block.
  const fallback = joinParts(block);
  if (fallback) out.push({ type: "text", text: fallback });
}

function compact(blocks) {
  return blocks.filter((block) => {
    if (block?.type === "text") return typeof block.text === "string" && block.text.length > 0;
    if (block?.type === "thinking") return typeof block.thinking === "string" && block.thinking.length > 0;
    return Boolean(block);
  });
}

/**
 * Returns `{ message, changed }`. Reasoning is dropped unless the caller asked
 * for extended thinking, matching what this gateway already does for every
 * OpenAI-protocol provider (openaiToAnthropicMessage never forwards
 * `reasoning_content`).
 */
export function normalizeAnthropicMessage(message, { keepReasoning = false } = {}) {
  if (!message || typeof message !== "object" || !("content" in message)) {
    return { message, changed: false };
  }
  const source = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : null;
  if (source === null) return { message, changed: false };

  const expanded = [];
  for (const block of source) pushBlock(block, expanded);

  let blocks = compact(expanded);
  if (!keepReasoning) blocks = blocks.filter((block) => block.type !== "thinking");
  // Never answer with an empty content array: a reasoning-only response still
  // has to reach the client as something parseable.
  if (blocks.length === 0 && expanded.length > 0) {
    const text = expanded
      .map((block) => (block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    blocks = text ? [{ type: "text", text }] : [];
  }

  const changed = JSON.stringify(blocks) !== JSON.stringify(source);
  return { message: { ...message, content: blocks }, changed };
}

/** Normalises one parsed SSE payload; `changed` says whether to re-encode it. */
export function normalizeAnthropicEvent(event) {
  if (!event || typeof event !== "object") return { event, changed: false };

  if (event.type === "message_start" && event.message) {
    const { message, changed } = normalizeAnthropicMessage(event.message);
    return { event: { ...event, message }, changed };
  }

  if (event.type === "content_block_start" && event.content_block) {
    const block = event.content_block;
    if (Array.isArray(block.text)) {
      // Block indices are already committed mid-stream, so sub-blocks fold into
      // the text of this one block.
      return {
        event: { ...event, content_block: { ...block, text: joinParts(block.text) } },
        changed: true,
      };
    }
    if (isReasoning(block) && Array.isArray(block.thinking)) {
      return {
        event: { ...event, content_block: { ...block, thinking: joinParts(block.thinking) } },
        changed: true,
      };
    }
    return { event, changed: false };
  }

  if (event.type === "content_block_delta" && event.delta && Array.isArray(event.delta.text)) {
    return { event: { ...event, delta: { ...event.delta, text: joinParts(event.delta.text) } }, changed: true };
  }

  return { event, changed: false };
}

/** Synthesises the Anthropic SSE frames for an already-complete message. */
export function anthropicMessageToSse(message) {
  const frames = [];
  const emit = (type, payload) => frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;

  emit("message_start", {
    message: {
      id: message.id || `msg_${Math.random().toString(36).slice(2, 18)}`,
      type: "message",
      role: message.role || "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  const blocks = Array.isArray(message.content) ? message.content : [];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
      if (block.text) emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      emit("content_block_stop", { index });
      return;
    }
    if (block.type === "thinking") {
      emit("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
      if (block.thinking) {
        emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      }
      if (typeof block.signature === "string" && block.signature) {
        emit("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
      }
      emit("content_block_stop", { index });
      return;
    }
    if (block.type === "tool_use") {
      emit("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      emit("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
      emit("content_block_stop", { index });
      return;
    }
    emit("content_block_start", { index, content_block: block });
    emit("content_block_stop", { index });
  });

  emit("message_delta", {
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  emit("message_stop", {});
  return frames.join("");
}

function readAll(response, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
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
      if (size > limit) {
        overflow = true;
        response.pause();
        finish(resolve, { raw: Buffer.concat(chunks), overflow });
      }
    };
    const onEnd = () => finish(resolve, { raw: Buffer.concat(chunks), overflow });
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, signal?.reason || new Error("aborted"));
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Strips hop-by-hop framing, then applies the overrides. */
function headerBasis(headers, overrides = {}) {
  const basis = { ...headers };
  delete basis["content-length"];
  delete basis["transfer-encoding"];
  return { ...basis, ...overrides };
}

function wantsJsonMessage(payload) {
  if (typeof payload !== "string") return false;
  if (payload.trimStart().startsWith("{") === false) return false;
  try {
    return Boolean(JSON.parse(payload));
  } catch {
    return false;
  }
}

function relayRawPrefixThenPipe(response, res, status, headers, raw) {
  res.writeHead(status, headerBasis(headers));
  if (raw.length) res.write(raw);
  response.pipe(res);
}

function sendJson(res, status, headers, payload) {
  const body = Buffer.from(payload, "utf8");
  res.writeHead(status, headerBasis(headers, {
    "content-type": "application/json",
    "content-length": String(body.length),
  }));
  res.end(body);
}

function sendSse(res, status, headers, frames) {
  res.writeHead(status, headerBasis(headers, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  }));
  res.end(frames);
}

/** Splits an SSE payload into complete frames, keeping any trailing partial. */
function splitFrames(text) {
  const parts = text.split("\n\n");
  const trailing = parts.pop() ?? "";
  return { frames: parts.map((part) => `${part}\n\n`), trailing };
}

/**
 * Serves one Anthropic-protocol pass-through response, repairing the shapes
 * listed at the top of this file. Returns `false` when the caller should fall
 * back to a plain pipe (not an Anthropic response, compressed body, or a body
 * this module does not recognise) — in that case the response must not have
 * been consumed.
 */
export async function respondWithAnthropicPassthrough({
  response,
  res,
  status,
  headers,
  wantStream,
  keepReasoning = false,
  signal,
}) {
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  const contentEncoding = String(response.headers?.["content-encoding"] || "").toLowerCase();
  if (contentEncoding && !["identity", ""].includes(contentEncoding)) return false;

  const isEventStream = contentType.includes("text/event-stream");
  if (!isEventStream && !contentType.includes("json")) return false;

  if (isEventStream) {
    const { raw, overflow } = await readAll(response, MAX_PASSTHROUGH_BYTES, signal);
    if (overflow) { relayRawPrefixThenPipe(response, res, status, headers, raw); return true; }
    const text = raw.toString("utf8");
    const { frames, trailing } = splitFrames(text);

    if (wantStream) {
      let rewritten = "";
      for (const frame of frames) {
        const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
        if (!line) { rewritten += frame; continue; }
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { rewritten += frame; continue; }
        const result = normalizeAnthropicEvent(event);
        if (result.changed) {
          rewritten += `event: ${result.event.type || "message"}\ndata: ${JSON.stringify(result.event)}\n\n`;
        } else {
          rewritten += frame;
        }
      }
      sendSse(res, status, headers, rewritten + trailing);
      return true;
    }

    // The caller asked for one message but the upstream streamed: fold it.
    const events = frames.filter((frame) => frame.includes("data: "));
    if (!events.length) {
      // Nothing parseable arrived; relay the bytes rather than fail the attempt.
      res.writeHead(status, headerBasis(headers, wantStream
        ? { "content-type": "text/event-stream; charset=utf-8" }
        : {}));
      res.end(text);
      return true;
    }
    const folded = collectAnthropicStream(events);
    const { message } = normalizeAnthropicMessage(folded, { keepReasoning });
    sendJson(res, status, headers, JSON.stringify(message));
    return true;
  }

  const { raw, overflow } = await readAll(response, MAX_PASSTHROUGH_BYTES, signal);
  if (overflow) { relayRawPrefixThenPipe(response, res, status, headers, raw); return true; }
  const text = raw.toString("utf8");

  if (!wantsJsonMessage(text)) {
    // Not something we understand: relay exactly what arrived.
    if (text.length) {
      res.writeHead(status, headerBasis(headers, { "content-length": String(Buffer.byteLength(text)) }));
      res.end(text);
    } else {
      res.writeHead(status, headerBasis(headers));
      res.end();
    }
    return true;
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || parsed.type !== "message" || !Array.isArray(parsed.content)) {
    // Error envelopes and foreign shapes are forwarded verbatim.
    res.writeHead(status, headerBasis(headers, { "content-length": String(Buffer.byteLength(text)) }));
    res.end(text);
    return true;
  }

  const { message, changed } = normalizeAnthropicMessage(parsed, { keepReasoning });

  if (wantStream) {
    sendSse(res, status, headers, anthropicMessageToSse(message));
    return true;
  }
  if (!changed) {
    // Healthy response: keep the upstream bytes and headers.
    res.writeHead(status, headers);
    res.end(raw);
    return true;
  }
  sendJson(res, status, headers, JSON.stringify(message));
  return true;
}
