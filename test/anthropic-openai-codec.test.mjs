import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicToOpenAI,
  collectAnthropicStream,
  createAnthropicStreamCodec,
  createSseChunkReader,
  openaiToAnthropicMessage,
} from "../anthropic-openai-codec.mjs";
import { GATE_TOOLS } from "../opencode-zen-gate.mjs";

test("system instructions and text survive the translation to OpenAI", () => {
  const openai = anthropicToOpenAI({
    model: "zen/space-bunny-free",
    max_tokens: 256,
    system: [{ type: "text", text: "You are terse." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  assert.equal(openai.messages[0].role, "system");
  assert.equal(openai.messages[0].content, "You are terse.");
  assert.equal(openai.messages[1].role, "user");
  assert.equal(openai.messages[1].content[0].text, "hello");
  assert.equal(openai.max_tokens, 256);
  // Zen refuses non-streaming free-tier requests, so streaming is forced.
  assert.equal(openai.stream, true);
  assert.deepEqual(openai.stream_options, { include_usage: true });
});

test("Anthropic tools become OpenAI function tools alongside the gate tools", () => {
  const openai = anthropicToOpenAI(
    {
      messages: [{ role: "user", content: "weather?" }],
      tools: [{
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      }],
      tool_choice: { type: "tool", name: "get_weather" },
    },
    { gateTools: GATE_TOOLS },
  );
  assert.equal(openai.tools.length, GATE_TOOLS.length + 1);
  const weather = openai.tools.find((tool) => tool.function.name === "get_weather");
  assert.deepEqual(weather.function.parameters.required, ["city"]);
  assert.deepEqual(openai.tool_choice, { type: "function", function: { name: "get_weather" } });
});

test("tool_use and tool_result blocks map onto tool_calls and tool messages", () => {
  const openai = anthropicToOpenAI({
    messages: [
      { role: "user", content: "weather in Paris?" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12C and raining" }] },
    ],
  });
  const assistant = openai.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.equal(assistant.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: "Paris" });
  const tool = openai.messages.find((message) => message.role === "tool");
  assert.equal(tool.tool_call_id, "toolu_1");
  assert.equal(tool.content, "12C and raining");
});

test("an OpenAI completion becomes an Anthropic message with tool_use blocks", () => {
  const message = openaiToAnthropicMessage({
    id: "chatcmpl-1",
    model: "space-bunny-free",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "checking",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
    }],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  }, { model: "space-bunny-free" });
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "text", text: "checking" });
  assert.deepEqual(message.content[1], { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } });
  assert.deepEqual(message.usage, { input_tokens: 11, output_tokens: 5 });
});

test("OpenAI chunks become Anthropic server-sent events", () => {
  const codec = createAnthropicStreamCodec({ model: "space-bunny-free", messageId: "msg_1" });
  const first = codec.push(JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }));
  assert.match(first.join(""), /event: message_start/);
  assert.match(first.join(""), /event: content_block_start[\s\S]*"text"/);
  assert.match(first.join(""), /text_delta.*Hel/);
  codec.push(JSON.stringify({ choices: [{ delta: { content: "lo" } }] }));
  const tool = codec.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_weather", arguments: '{"city":' } }] } }] }));
  assert.match(tool.join(""), /"tool_use"/);
  codec.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }));
  codec.push(JSON.stringify({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  const tail = codec.end().join("");
  assert.match(tail, /event: content_block_stop/);
  assert.match(tail, /event: message_delta[\s\S]*"stop_reason":"tool_use"/);
  assert.match(tail, /"output_tokens":3/);
  assert.match(tail, /event: message_stop/);
});

test("the Anthropic event stream folds back into one message", () => {
  const codec = createAnthropicStreamCodec({ model: "space-bunny-free", messageId: "msg_2" });
  const events = [
    ...codec.push(JSON.stringify({ choices: [{ delta: { content: "Sure" } }] })),
    ...codec.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_3", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] } }] })),
    ...codec.push(JSON.stringify({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })),
    ...codec.end(),
  ];
  const message = collectAnthropicStream(events);
  assert.equal(message.id, "msg_2");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "text", text: "Sure" });
  assert.deepEqual(message.content[1], { type: "tool_use", id: "call_3", name: "get_weather", input: { city: "Rome" } });
  assert.deepEqual(message.usage, { input_tokens: 4, output_tokens: 2 });
});

test("the SSE reader tolerates split frames and drops the done marker", () => {
  const reader = createSseChunkReader();
  assert.deepEqual(reader.push('data: {"a":1}\n\ndata: {"b"'), ['{"a":1}']);
  assert.deepEqual(reader.push(':2}\n\ndata: [DONE]\n\n'), ['{"b":2}']);
});

test("compaction blocks and compaction accounting survive stream collection", () => {
  const summary = { type: "compaction", content: "summary text", signature: "signed-opaque-value" };
  const message = collectAnthropicStream([[
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_compact", model: "claude-test", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: summary })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "compaction", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, iterations: 2 } })}\n\n`,
  ].join("")]);
  assert.deepEqual(message.content, [summary]);
  assert.equal(message.stop_reason, "compaction");
  assert.deepEqual(message.usage, { input_tokens: 0, output_tokens: 0, iterations: 2 });
});
