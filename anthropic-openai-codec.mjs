// Anthropic Messages <-> OpenAI chat-completions translation.
//
// OpenCode Zen only serves free-tier traffic on the OpenAI chat-completions
// route, so an Anthropic caller has to be translated in both directions:
// system instructions, content blocks, tool_use/tool_result and tool_choice go
// out as OpenAI messages and function tools, and the reply comes back as
// Anthropic content blocks or Anthropic server-sent events.

const STOP_REASONS = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block.type === "text" || typeof block.text === "string"))
    .map((block) => block.text ?? "")
    .join("");
}

function imageDataUrl(block) {
  const source = block?.source;
  if (!source) return null;
  if (source.type === "url" || source.url) return source.url;
  if (source.media_type && source.data) return `data:${source.media_type};base64,${source.data}`;
  return null;
}

function toolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

export function anthropicToOpenAI(request, { gateTools = [], forceStream = true } = {}) {
  const out = {};
  for (const key of ["model", "max_tokens", "temperature", "top_p", "user"]) {
    if (request?.[key] !== undefined) out[key] = request[key];
  }
  if (typeof request?.max_tokens !== "number") out.max_tokens = 4096;
  if (Array.isArray(request?.stop_sequences) && request.stop_sequences.length) out.stop = request.stop_sequences;
  // Zen refuses to answer a free-tier request that is not streaming, so its
  // caller forces it. A generic upstream follows the client instead.
  out.stream = forceStream === true || request?.stream === true;
  if (out.stream) out.stream_options = { include_usage: true };

  const messages = [];
  const system = textOf(request?.system).trim();
  if (system) messages.push({ role: "system", content: system });

  for (const message of request?.messages || []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    const plain = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of parts) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" || typeof block.text === "string") {
        plain.push({ type: "text", text: block.text ?? "" });
        continue;
      }
      if (block.type === "image") {
        const url = imageDataUrl(block);
        if (url) plain.push({ type: "image_url", image_url: { url } });
        continue;
      }
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || `call_${block.name}`,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        continue;
      }
      if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: textOf(block.content) || (typeof block.content === "string" ? block.content : ""),
        });
      }
    }

    if (toolResults.length) messages.push(...toolResults);
    if (plain.length || toolCalls.length) {
      const reply = { role: message.role || "assistant", content: plain.length ? plain : null };
      if (toolCalls.length) reply.tool_calls = toolCalls;
      messages.push(reply);
    }
  }

  const tools = [];
  for (const tool of gateTools) tools.push(tool);
  for (const tool of request?.tools || []) {
    if (!tool?.name) continue;
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
      },
    });
  }
  if (tools.length) out.tools = tools;
  const toolChoice = toolChoiceToOpenAI(request?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (request?.parallel_tool_calls !== undefined) out.parallel_tool_calls = request.parallel_tool_calls === true;

  out.messages = messages;
  return out;
}

function usageOf(usage) {
  return {
    input_tokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
    output_tokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
  };
}

export function openaiToAnthropicMessage(completion, { model } = {}) {
  const choice = completion?.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  const text = typeof message.content === "string" ? message.content : textOf(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = { _raw: call.function?.arguments ?? "" };
    }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  return {
    id: completion?.id || `msg_${content.length}`,
    type: "message",
    role: "assistant",
    model: model || completion?.model,
    content,
    stop_reason: STOP_REASONS[choice?.finish_reason] || (choice?.finish_reason ? "end_turn" : null),
    stop_sequence: null,
    usage: usageOf(completion?.usage),
  };
}

// Turns OpenAI server-sent chunks into Anthropic server-sent events. Zen always
// streams, so this is also how a non-streaming Anthropic caller is served: the
// events are folded into one message by collectAnthropicStream.
export function createAnthropicStreamCodec({ model, messageId } = {}) {
  const id = messageId || `msg_${Math.random().toString(36).slice(2, 18)}`;
  let started = false;
  let finished = false;
  let nextBlock = 0;
  let openBlock = null;
  let openKind = null;
  const toolBlocks = new Map();
  const events = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finishReason = null;

  const emit = (type, payload) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };
  const drain = () => events.splice(0, events.length);

  const closeOpen = () => {
    if (openKind === null) return;
    emit("content_block_stop", { index: openBlock });
    openKind = null;
    openBlock = null;
  };

  const openText = () => {
    if (openKind === "text") return;
    closeOpen();
    openBlock = nextBlock++;
    openKind = "text";
    emit("content_block_start", { index: openBlock, content_block: { type: "text", text: "" } });
  };

  const openTool = (index, name, id) => {
    if (toolBlocks.has(index)) return toolBlocks.get(index);
    closeOpen();
    const block = nextBlock++;
    toolBlocks.set(index, block);
    openBlock = block;
    openKind = "tool";
    emit("content_block_start", { index: block, content_block: { type: "tool_use", id, name, input: {} } });
    return block;
  };

  return {
    push(chunk) {
      let data;
      try {
        data = JSON.parse(chunk);
      } catch {
        return;
      }
      if (!started) {
        started = true;
        emit("message_start", {
          message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        });
      }
      if (data.usage) {
        usage.input_tokens = Number(data.usage.prompt_tokens || usage.input_tokens || 0);
        usage.output_tokens = Number(data.usage.completion_tokens || usage.output_tokens || 0);
      }
      const choice = data.choices?.[0];
      if (!choice) return drain();
      const delta = choice.delta || {};

      if (typeof delta.content === "string" && delta.content.length) {
        openText();
        emit("content_block_delta", { index: openBlock, delta: { type: "text_delta", text: delta.content } });
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0;
        const fn = call.function || {};
        const block = openTool(index, fn.name || "tool", call.id || `call_${index}`);
        if (fn.arguments) {
          emit("content_block_delta", { index: block, delta: { type: "input_json_delta", partial_json: fn.arguments } });
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      return drain();
    },

    end() {
      if (!started) {
        started = true;
        emit("message_start", {
          message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        });
      }
      closeOpen();
      emit("message_delta", {
        delta: { stop_reason: STOP_REASONS[finishReason] || "end_turn", stop_sequence: null },
        usage: { ...usage },
      });
      emit("message_stop", {});
      finished = true;
      return drain();
    },

    get finished() {
      return finished;
    },
    get id() {
      return id;
    },
  };
}

// Folds Anthropic stream events back into a single message for non-streaming
// Anthropic callers.
export function collectAnthropicStream(events) {
  const message = { id: null, type: "message", role: "assistant", model: null, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  const blocks = new Map();
  for (const raw of events) {
    for (const frame of raw.split("\n\n")) {
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (event.type === "message_start") {
        message.id = event.message.id;
        message.model = event.message.model;
      }
      if (event.type === "content_block_start") {
        blocks.set(event.index, { ...event.content_block, json: "" });
      }
      if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (!block) continue;
        if (event.delta.type === "text_delta") block.text = (block.text || "") + event.delta.text;
        if (event.delta.type === "input_json_delta") block.json += event.delta.partial_json || "";
      }
      if (event.type === "message_delta") {
        message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
        message.usage = { ...message.usage, ...(event.usage || {}) };
      }
    }
  }
  message.content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => {
      if (block.type === "compaction") {
        const { json: _json, ...preserved } = block;
        return preserved;
      }
      if (block.type === "tool_use") {
        let input = {};
        try {
          input = block.json ? JSON.parse(block.json) : {};
        } catch {
          input = { _raw: block.json };
        }
        return { type: "tool_use", id: block.id, name: block.name, input };
      }
      return { type: "text", text: block.text || "" };
    })
    .filter((block) => block.type === "tool_use" || block.type === "compaction" || block.text);
  return message;
}

// Parses an OpenAI SSE byte stream into decoded chunks, tolerating partial lines.
export function createSseChunkReader() {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      const chunks = [];
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          chunks.push(payload);
        } catch {
          continue;
        }
      }
      return chunks;
    },
  };
}