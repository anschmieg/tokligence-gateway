import assert from "node:assert/strict";
import test from "node:test";
import { createCopilotAutoAdapter, extractVisionAttachments, messagesToPrompt, validateStructuredOutput } from "../copilot-auto.mjs";

test("messagesToPrompt preserves role boundaries and text content", () => {
  assert.equal(messagesToPrompt([
    { role: "system", content: "Be concise." },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ]), "[system]\nBe concise.\n\n[user]\nHello");
});

test("extractVisionAttachments accepts bounded image data URLs and rejects remote URLs", () => {
  const { attachments, messages } = extractVisionAttachments([
    { role: "user", content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ] },
  ]);
  assert.deepEqual(attachments, [{ type: "blob", data: "aGVsbG8=", mimeType: "image/png", displayName: "image-1.png" }]);
  assert.equal(messagesToPrompt(messages), "[user]\nWhat is this?");
  assert.throws(() => extractVisionAttachments([
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] },
  ]), /only accepts data URLs/);
});

test("validateStructuredOutput enforces json_object and JSON Schema contracts", () => {
  assert.deepEqual(validateStructuredOutput('{"ok":true}', { type: "json_object" }), { ok: true });
  assert.throws(() => validateStructuredOutput('not json', { type: "json_object" }), /valid JSON/);
  assert.deepEqual(validateStructuredOutput('{"answer":"yes"}', {
    type: "json_schema",
    json_schema: { name: "answer", schema: {
      type: "object", required: ["answer"], additionalProperties: false,
      properties: { answer: { type: "string" } },
    } },
  }), { answer: "yes" });
  assert.throws(() => validateStructuredOutput('{"answer":7}', {
    type: "json_schema",
    json_schema: { name: "answer", schema: {
      type: "object", required: ["answer"], properties: { answer: { type: "string" } },
    } },
  }), /JSON Schema/);
});

test("copilot-auto rejects vision input when the official Auto capability catalog lacks vision", async () => {
  const adapter = createCopilotAutoAdapter({
    clientFactory: () => ({
      async start() {}, async stop() {},
      async listModels() { return [{ id: "auto", capabilities: { supports: { vision: false } } }]; },
      async createSession() { throw new Error("must not create a vision-incompatible session"); },
    }),
    routingAudit: async () => {}, logger: { info() {} },
  });
  await assert.rejects(adapter.complete({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
  ] }] }), /vision capability/);
  await adapter.close();
});

test("copilot-auto maps OpenAI function declarations to handlerless SDK custom tools", async () => {
  let sessionConfig;
  const session = {
    on() { return () => {}; },
    async sendAndWait() { return { data: { content: "ready" } }; },
    async disconnect() {},
  };
  const adapter = createCopilotAutoAdapter({
    clientFactory: () => ({
      async start() {},
      async createSession(config) { sessionConfig = config; return session; },
      async stop() {},
    }),
    routingAudit: async () => {},
    logger: { info() {} },
  });

  await adapter.complete({
    messages: [{ role: "user", content: "Use the weather tool." }],
    tools: [{ type: "function", function: {
      name: "weather",
      description: "Look up weather.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    } }],
  });

  assert.deepEqual(sessionConfig.availableTools, ["custom:weather"]);
  assert.deepEqual(sessionConfig.tools, [{
    name: "weather",
    description: "Look up weather.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    defer: "never",
  }]);
  await adapter.close();
});

test("copilot-auto returns an external tool call and resumes it from a matching tool result", async () => {
  const handlers = new Map();
  let disconnects = 0;
  let resolveTurn;
  const handled = [];
  const session = {
    on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
    async sendAndWait() {
      queueMicrotask(() => handlers.get("external_tool.requested")?.({ data: {
        requestId: "pending-1", toolCallId: "call-1", toolName: "weather", arguments: { city: "Paris" },
      } }));
      return new Promise((resolve) => {
        resolveTurn = resolve;
        setTimeout(() => resolve({ data: { content: "unexpected completion" } }), 50);
      });
    },
    rpc: { tools: { async handlePendingToolCall(request) {
      handled.push(request);
      if (request.requestId === "pending-1") {
        queueMicrotask(() => handlers.get("external_tool.requested")?.({ data: {
          requestId: "pending-2", toolCallId: "call-2", toolName: "weather", arguments: { city: "Lyon" },
        } }));
      } else {
        resolveTurn({ data: { content: "It is sunny." } });
      }
      return { success: true };
    } } },
    async disconnect() { disconnects += 1; },
  };
  const adapter = createCopilotAutoAdapter({
    clientFactory: () => ({ async start() {}, async createSession() { return session; }, async stop() {} }),
    routingAudit: async () => {}, logger: { info() {} },
  });
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];

  const first = await adapter.complete({ messages: [{ role: "user", content: "Weather?" }], tools, callerKey: "alice" });
  assert.deepEqual(first.toolCalls, [{ id: "call-1", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } }]);
  assert.equal(disconnects, 0);
  await assert.rejects(
    adapter.complete({ messages: [{ role: "tool", tool_call_id: "call-1", content: "sunny" }], callerKey: "bob" }),
    /belongs to another caller/,
  );

  const second = await adapter.complete({
    messages: [{ role: "tool", tool_call_id: "call-1", content: "sunny" }], callerKey: "alice",
  });
  assert.deepEqual(second.toolCalls, [{ id: "call-2", type: "function", function: { name: "weather", arguments: '{"city":"Lyon"}' } }]);
  const third = await adapter.complete({
    messages: [{ role: "tool", tool_call_id: "call-2", content: "sunny" }], callerKey: "alice",
  });
  assert.deepEqual(handled, [
    { requestId: "pending-1", result: "sunny" },
    { requestId: "pending-2", result: "sunny" },
  ]);
  assert.equal(third.text, "It is sunny.");
  assert.equal(disconnects, 1);
  await adapter.close();
});

test("copilot-auto runs the official auto model with no ambient tools and exposes routing metadata", async () => {
  const handlers = new Map();
  let sessionConfig;
  let prompt;
  let disconnected = false;
  let stopped = false;
  const session = {
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    async sendAndWait({ prompt: value }) {
      prompt = value;
      handlers.get("session.auto_mode_resolved")?.({ data: {
        chosenModel: "gpt-5-mini",
        availableModels: ["gpt-5-mini", "claude-haiku-4.5"],
        candidateModels: ["gpt-5-mini"],
        predictedLabel: "no_reasoning",
        reasoningBucket: "low",
      } });
      handlers.get("assistant.message_delta")?.({ data: { deltaContent: "hello" } });
      return { data: { content: "hello" } };
    },
    async disconnect() { disconnected = true; },
  };
  const fakeClient = {
    async start() {},
    async createSession(config) { sessionConfig = config; return session; },
    async stop() { stopped = true; },
  };
  const deltas = [];
  const audits = [];
  const adapter = createCopilotAutoAdapter({
    clientFactory(options) {
      assert.equal(options.mode, "empty");
      assert.equal(options.useLoggedInUser, true);
      return fakeClient;
    },
    routingAudit: async (event) => audits.push(event),
    logger: { info() {} },
  });

  const result = await adapter.complete({
    messages: [{ role: "user", content: "Say hello" }],
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(prompt, "[user]\nSay hello");
  assert.equal(sessionConfig.model, "auto");
  assert.deepEqual(sessionConfig.availableTools, []);
  assert.equal(sessionConfig.enableConfigDiscovery, false);
  assert.deepEqual(deltas, ["hello"]);
  assert.equal(result.text, "hello");
  assert.deepEqual(result.route.availableModels, ["gpt-5-mini", "claude-haiku-4.5"]);
  assert.equal(result.route.chosenModel, "gpt-5-mini");
  assert.deepEqual(audits, [{
    timestamp: audits[0].timestamp,
    requested_model: "copilot-auto",
    selected_model: "gpt-5-mini",
    available_models: ["gpt-5-mini", "claude-haiku-4.5"],
    candidate_models: ["gpt-5-mini"],
    predicted_label: "no_reasoning",
    reasoning_bucket: "low",
    message_count: 1,
    image_count: 0,
    tool_count: 0,
    response_format: null,
  }]);
  assert.equal(JSON.stringify(audits).includes("Say hello"), false);
  assert.equal(disconnected, true);
  await adapter.close();
  assert.equal(stopped, true);
});
