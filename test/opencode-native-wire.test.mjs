import test from "node:test";
import assert from "node:assert/strict";
import { decodeChatRequest, createChatEncoder, safeNativeError } from "../native/opencode/bridge-wire.mjs";

const tool = { type: "function", function: { name: "lookup", description: "Caller tool", parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false } } };

test("native input preserves caller prompts, schemas, reasoning, call IDs and results", () => {
  const body = {
    model: "beam-free", stream: true, max_tokens: 256, temperature: 0, top_p: 0.8, stop: ["END"],
    tools: [tool], tool_choice: { type: "function", function: { name: "lookup" } }, parallel_tool_calls: false,
    messages: [
      { role: "system", content: [{ type: "text", text: "First prompt" }, { type: "text", text: "Second prompt" }] },
      { role: "system", content: "Third prompt" },
      { role: "user", content: "Question" },
      { role: "assistant", content: null, reasoning_content: "Returned reasoning", tool_calls: [{ id: "caller_1", type: "function", function: { name: "lookup", arguments: '{"id":7}' } }] },
      { role: "tool", tool_call_id: "caller_1", content: "Result" },
    ],
  };
  const result = decodeChatRequest(body);
  assert.deepEqual(result.system.map((part) => part.text), ["First prompt", "Second prompt", "Third prompt"]);
  assert.deepEqual(result.tools[0].inputSchema, tool.function.parameters);
  assert.deepEqual(result.messages[1].content, [
    { type: "reasoning", text: "Returned reasoning" },
    { type: "tool-call", id: "caller_1", name: "lookup", input: { id: 7 } },
  ]);
  assert.deepEqual(result.messages[2].content, [{ type: "tool-result", id: "caller_1", name: "lookup", result: { type: "text", value: "Result" } }]);
  assert.deepEqual(result.options, { maxTokens: 256, temperature: 0, topP: 0.8, stop: ["END"] });
  assert.deepEqual(result.toolChoice, { type: "tool", name: "lookup", disableParallelToolUse: true });
});

for (const [label, change] of [
  ["unsupported request options", (body) => { body.response_format = { type: "json_object" }; }],
  ["media", (body) => { body.messages[0].content = [{ type: "image_url", image_url: { url: "https://example.invalid/private" } }]; }],
  ["unmatched tool results", (body) => { body.messages = [{ role: "tool", tool_call_id: "missing", content: "result" }]; }],
  ["strict schemas", (body) => { body.tools = [{ ...tool, function: { ...tool.function, strict: true } }]; }],
  ["late system prompts", (body) => { body.messages.push({ role: "system", content: "late" }); }],
]) test(`native input rejects ${label} explicitly`, () => {
  const body = { model: "beam-free", messages: [{ role: "user", content: "hello" }] };
  change(body);
  assert.throws(() => decodeChatRequest(body), (error) => error.status === 400 && error.code === "unsupported_bridge_request");
});

test("native events preserve parallel calls and normalize reasoning for caller replay", () => {
  const encoder = createChatEncoder({ model: "beam-free", id: "fixture", created: 1 });
  assert.deepEqual(encoder.push({ type: "step-start", index: 0 }), []);
  assert.equal(encoder.push({ type: "reasoning-delta", text: "Thought" })[0].choices[0].delta.reasoning_content, "Thought");
  assert.deepEqual(encoder.push({ type: "tool-call", id: "one", name: "lookup", input: { id: 1 } }), []);
  assert.deepEqual(encoder.push({ type: "tool-call", id: "two", name: "lookup", input: { id: 2 } }), []);
  const terminal = encoder.push({ type: "finish", reason: { normalized: "tool-calls" }, usage: { inputTokens: 3, outputTokens: 2 } });
  assert.equal(terminal[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(terminal[1].choices[0].delta.tool_calls[0].index, 1);
  const result = encoder.completion();
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(result.choices[0].message.tool_calls.map((call) => call.id), ["one", "two"]);
  assert.equal(result.choices[0].message.reasoning_content, "Thought");
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test("native truncated, empty, invalid and provider-executed output never becomes success", () => {
  for (const event of [
    { type: "finish", reason: { normalized: "stop" } },
    { type: "provider-error", message: "private provider detail" },
    { type: "tool-call", id: "one", name: "lookup", input: {}, providerExecuted: true },
    { type: "tool-input-error", raw: "{broken" },
  ]) {
    const encoder = createChatEncoder({ model: "fixture", id: "one" });
    assert.throws(() => encoder.push(event), (error) => error.status === 502);
  }
  const encoder = createChatEncoder({ model: "fixture", id: "one" });
  encoder.push({ type: "text-delta", text: "partial" });
  assert.throws(() => encoder.end(), /without a terminal/);
});

test("native diagnostics retain quota timing and provider IDs without leaking upstream bodies", () => {
  const result = safeNativeError({ reason: { _tag: "QuotaExceeded", message: "PRIVATE_TOKEN", body: JSON.stringify({ error: { type: "FreeUsageLimitError", message: "PRIVATE_PROMPT" } }), retryAfterMs: 60000, http: { status: 429, headers: { "x-opencode-log-id": "provider-fixture-123" } } } });
  assert.equal(result.status, 429);
  assert.equal(result.error.code, "FreeUsageLimitError");
  assert.equal(result.error.retry_after_seconds, 60);
  assert.equal(result.error.upstream_request_id, "provider-fixture-123");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|PRIVATE_PROMPT/);
});

test('native authoritative end text is preserved and revisions cannot silently corrupt output', () => {
  const encoder = createChatEncoder({ model: 'fixture', id: 'one' });
  encoder.push({ type: 'text-delta', id: 'part', text: 'first' });
  assert.equal(encoder.push({ type: 'text-end', id: 'part', text: 'first last' })[0].choices[0].delta.content, ' last');
  assert.throws(() => encoder.push({ type: 'text-end', id: 'part', text: 'rewritten' }), /revised/);
});

for (const [reason, expected] of [["length", "length"], ["content-filter", "content_filter"]]) test(`native ${reason} withholds pending tool calls`, () => {
  const encoder = createChatEncoder({ model: "fixture", id: "one" });
  assert.deepEqual(encoder.push({ type: "tool-call", id: "one", name: "run", input: {} }), []);
  const chunks = encoder.push({ type: "finish", reason: { normalized: reason } });
  assert.equal(chunks.at(-1).choices[0].finish_reason, expected);
  assert.ok(chunks.every(chunk => !chunk.choices[0].delta.tool_calls));
  const result = encoder.completion().choices[0];
  assert.equal(result.finish_reason, expected);
  assert.equal(result.message.tool_calls, undefined);
});
