import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parseRoutingConfig, profileByModel } from "../route-config.mjs";
import { buildRoutePlan } from "../routing-planner.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));
const env = {
  OPENROUTER_API_KEY: "or-key",
  MISTRAL_API_KEY: "mistral-key",
  CODEX_PROXY_ENABLED: "true",
  CODEX_PROXY_API_KEY: "codex-key",
};

test("agent profiles preserve deterministic candidate order", () => {
  assert.deepEqual(profileByModel(config, "agent-default").candidates, [
    { provider: "cline-oauth", model: "cline/z-ai/glm-5.3-flash" },
    { provider: "opencode-zen", model: "opencode-zen/kimi-k2.6-free" },
    { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b" },
    { provider: "cerebras", model: "cerebras/gpt-oss-120b" },
    { provider: "together", model: "together/Prism-ML/Ternary-Bonsai-27B" },
    { provider: "groq", model: "groq/llama-3.3-70b-versatile" },
    { provider: "mistral", model: "mistral-medium-3-5" },
    { provider: "google-ai-studio", model: "gemini-3-flash-latest" },
    { provider: "copilot-auto", model: "copilot-auto" },
    { provider: "codex-oauth", model: "gpt-5.6-terra" },
    { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
  ]);
  assert.equal(profileByModel(config, "AGENTIC-WORKER").candidates[0].provider, "cline-oauth");
});

test("route planner builds the ordered fallback chain", () => {
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.candidates.map(({ provider, upstreamModel }) => [provider.id, upstreamModel]), [
    ["cline-oauth", "cline/z-ai/glm-5.3-flash"],
    ["mistral", "mistral-medium-3-5"],
    ["codex-oauth", "gpt-5.6-terra"],
    ["openrouter", "deepseek/deepseek-v4-flash-0731"],
  ]);
});

test("route planner skips a candidate while its circuit is open", () => {
  const cooldowns = new Map([[
    "cline-oauth:cline/z-ai/glm-5.3-flash:chat_completions",
    Date.now() + 60_000,
  ]]);
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [] },
  }, env, { cooldowns });
  assert.equal(plan.candidates[0].provider.id, "mistral");
  assert.equal(plan.candidates[0].upstreamModel, "mistral-medium-3-5");
});


test("route planner filters candidates by request capabilities", () => {
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }] }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  assert.ok(plan.candidates.every(({ provider }) => provider.metadata.capabilities.includes("vision")));
});

test("route planner keeps a successful model sticky within a profile", () => {
  const affinity = new Map([["principal:agent-default", { provider: "mistral", model: "mistral-medium-3-5", updatedAt: Date.now() }]]);
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [{ role: "user", content: "hello" }] },
    affinityKey: "principal",
  }, env, { cooldowns: new Map(), affinity });
  assert.equal(plan.candidates[0].provider.id, "mistral");
  assert.equal(plan.candidates[0].upstreamModel, "mistral-medium-3-5");
});
