import assert from "node:assert/strict";
import test from "node:test";
import { createCopilotAutoAdapter, messagesToPrompt } from "../copilot-auto.mjs";

test("messagesToPrompt preserves role boundaries and text content", () => {
  assert.equal(messagesToPrompt([
    { role: "system", content: "Be concise." },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ]), "[system]\nBe concise.\n\n[user]\nHello");
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
  const adapter = createCopilotAutoAdapter({
    clientFactory(options) {
      assert.equal(options.mode, "empty");
      assert.equal(options.useLoggedInUser, true);
      return fakeClient;
    },
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
  assert.equal(disconnected, true);
  await adapter.close();
  assert.equal(stopped, true);
});
