import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUpstreamModel,
  resolveMistralModel,
  resolveOpenCodeModel,
  resolveOpenRouterModel,
} from "../upstream-model.mjs";

test("OpenRouter ids are rewritten to the id OpenRouter expects", () => {
  assert.equal(resolveOpenRouterModel("openrouter/z-ai/glm-5.3-flash"), "z-ai/glm-5.3-flash");
  assert.equal(resolveOpenRouterModel("OR/google/gemini-3.6-flash"), "google/gemini-3.6-flash");
  // A namespaced upstream id keeps its own slashes.
  assert.equal(resolveOpenRouterModel("deepseek/deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
  assert.equal(resolveOpenRouterModel("free"), "openrouter/free");
});

test("Mistral and OpenCode ids lose only the gateway namespace", () => {
  assert.equal(resolveMistralModel("mistral/mistral-large-2411"), "mistral-large-2411");
  assert.equal(resolveMistralModel("mistral-large-latest"), "mistral-large-latest");
  assert.equal(resolveOpenCodeModel("opencode-zen/kimi-k2.6-free"), "kimi-k2.6-free");
  assert.equal(resolveOpenCodeModel("zen/kimi-k2.6-free"), "kimi-k2.6-free");
  assert.equal(resolveOpenCodeModel("oc/kimi-k2.6-free"), "kimi-k2.6-free");
});

test("normalizeUpstreamModel applies only the provider's own namespace", () => {
  assert.equal(normalizeUpstreamModel("openrouter", "openrouter/z-ai/glm-5.3-flash"), "z-ai/glm-5.3-flash");
  assert.equal(normalizeUpstreamModel("mistral", "mistral/mistral-large-2411"), "mistral-large-2411");
  assert.equal(normalizeUpstreamModel("cerebras", "cerebras/gpt-oss-120b"), "cerebras/gpt-oss-120b");
  assert.equal(normalizeUpstreamModel("nvidia", "nvidia/nemotron-3-super-120b-a12b"), "nvidia/nemotron-3-super-120b-a12b");
});
