import assert from "node:assert/strict";
import test from "node:test";

import { allowedAnthropicBeta, applyAnthropicBetaPolicy, prepareSpecialistRequest } from "../provider-adapters.mjs";

test("specialist preparation preserves text/task guidance visibly and requires an idempotency key", () => {
  const candidate = { upstreamModel: "ui-text", specialistInstructions: "Review supplied context." };
  const prepared = prepareSpecialistRequest({ model: "ui-text", input: "Review this", instructions: "Parent asks for a focused review" }, candidate, "task-turn-1");
  assert.equal(prepared.idempotencyKey, "task-turn-1");
  assert.match(prepared.body.input, /Review this/);
  assert.match(prepared.body.input, /Review supplied context/);
  assert.match(prepared.body.input, /Parent asks for a focused review/);
  assert.match(prepared.body.input, /not true system priority/);
  assert.match(prepared.body.input, /\n\[user\]\nReview this/);
  assert.throws(() => prepareSpecialistRequest({ model: "ui-text", input: "x" }, candidate, undefined), /Idempotency-Key/);
});

test("specialist preparation rejects unsupported protocol fields and non-text items before dispatch", () => {
  const candidate = { upstreamModel: "ui-text", specialistInstructions: "Role" };
  for (const request of [
    { model: "ui-text", input: "x", tools: [{ type: "function" }] },
    { model: "ui-text", input: "x", reasoning: { effort: "high" } },
    { model: "ui-text", input: [{ type: "function_call_output", call_id: "c", output: "x" }] },
    { model: "ui-text", input: [{ role: "user", content: [{ type: "input_image" }] }] },
    { model: "ui-text", input: { text: "wrong" } },
  ]) assert.throws(() => prepareSpecialistRequest(request, candidate, "key"), /Unsupported|Only|input must|input message|Client tools/i);
});

test("specialist Messages and Chat Completions accept text only and preserve guidance", () => {
  const candidate = { specialistInstructions: "Investigate carefully." };
  const messages = prepareSpecialistRequest({ model: "role/explore", system: "Use parent facts", max_tokens: 200, messages: [{ role: "user", content: "Question" }] }, candidate, "msg-key", "messages");
  assert.match(messages.body.input, /Investigate carefully/);
  assert.match(messages.body.input, /Use parent facts/);
  assert.match(messages.body.input, /Question/);
  assert.match(messages.body.input, /advisory/);
  const chat = prepareSpecialistRequest({ model: "role/review", messages: [{ role: "system", content: "Parent rule" }, { role: "user", content: "Review" }] }, candidate, "chat-key", "chat_completions");
  assert.match(chat.body.input, /Parent rule/);
  assert.match(chat.body.input, /Review/);
  assert.throws(() => prepareSpecialistRequest({ model: "role/review", messages: [{ role: "user", content: [{ type: "image_url" }] }] }, candidate, "key", "chat_completions"), /bounded text/);
  assert.throws(() => prepareSpecialistRequest({ model: "role/review", messages: [{ role: "user", content: "x" }], tools: [] }, candidate, "key", "messages"), /Unsupported/);
});

test("Anthropic beta headers are restricted to exact route allow-list entries", () => {
  assert.equal(allowedAnthropicBeta("context-management-2025-06-27, compact-2026-09-04", ["compact-2026-09-04"]), "compact-2026-09-04");
  assert.equal(allowedAnthropicBeta("compact-2026-09-04-extra", ["compact-2026-09-04"]), undefined);
  assert.equal(allowedAnthropicBeta("context-management-2025-06-27", []), undefined);
  assert.equal(allowedAnthropicBeta(undefined, ["compact-2026-09-04"]), undefined);
});

test("paired beta request fields are stripped unless that route admits their beta", () => {
  const body = { model: "claude-test", context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }, compaction: { trigger: { type: "tokens", value: 50000 } } };
  const result = applyAnthropicBetaPolicy(body, "context-management-2025-06-27, compact-2026-09-04", ["compact-2026-09-04"]);
  assert.equal(result.header, "compact-2026-09-04");
  assert.deepEqual(JSON.parse(result.body), { model: "claude-test", compaction: body.compaction });
  assert.equal(body.context_management.edits[0].type, "clear_tool_uses_20250919");
});


test("mutually exclusive Anthropic context editing is removed when summary compaction is present", () => {
  const body = {
    model: "claude-test",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    compaction: { type: "summarize" },
  };
  const result = applyAnthropicBetaPolicy(
    body,
    "context-management-2025-06-27, compact-2026-09-04",
    ["context-management-2025-06-27", "compact-2026-09-04"],
  );
  assert.deepEqual(JSON.parse(result.body), { model: "claude-test", compaction: { type: "summarize" } });
  assert.equal(result.header, "context-management-2025-06-27, compact-2026-09-04");
});
