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
    { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    { provider: "mistral", model: "mistral-medium-3-5" },
    { provider: "openrouter", model: "z-ai/glm-5.2" },
    { provider: "codex-oauth", model: "gpt-5.6-terra" },
  ]);
  assert.equal(profileByModel(config, "AGENTIC-WORKER").candidates[0].provider, "mistral");
});

test("route planner builds the ordered fallback chain", () => {
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.candidates.map(({ provider, upstreamModel }) => [provider.id, upstreamModel]), [
    ["openrouter", "deepseek/deepseek-v4-flash"],
    ["mistral", "mistral-medium-3-5"],
    ["openrouter", "z-ai/glm-5.2"],
    ["codex-oauth", "gpt-5.6-terra"],
  ]);
});

test("route planner skips a candidate while its circuit is open", () => {
  const cooldowns = new Map([[
    "openrouter:deepseek/deepseek-v4-flash:chat_completions",
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
