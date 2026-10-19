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
    { provider: "cline-oauth", model: "cline/cline-free/deepseek-v4.1-flash" },
    { provider: "cline-oauth", model: "cline/cline-free/mimo-v2.6-flash" },
    { provider: "opencode-zen", model: "opencode-zen/kimi-k2.6-free" },
    { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b" },
    { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
    { provider: "cerebras", model: "cerebras/gpt-oss-120b" },
    { provider: "cerebras", model: "cerebras/gemma-4-31b" },
    { provider: "together", model: "together/Prism-ML/Ternary-Bonsai-27B" },
    { provider: "groq", model: "groq/llama-3.3-70b-versatile" },
    { provider: "groq", model: "groq/openai/gpt-oss-120b" },
    { provider: "nous", model: "nousresearch/laguna-xs-2.1" },
    { provider: "nous", model: "nousresearch/laguna-s-2.1" },
    { provider: "nous", model: "stepfun/step-3.7-flash" },
    { provider: "mistral", model: "mistral-medium-3-5" },
    { provider: "google-ai-studio", model: "gemini-3-flash-latest" },
    { provider: "copilot-auto", model: "copilot-auto" },
    { provider: "codex-oauth", model: "gpt-5.6-terra" },
    { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
    { provider: "openrouter", model: "openrouter/free" },
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
    ["cline-oauth", "cline/cline-free/deepseek-v4.1-flash"],
    ["cline-oauth", "cline/cline-free/mimo-v2.6-flash"],
    ["mistral", "mistral-medium-3-5"],
    ["codex-oauth", "gpt-5.6-terra"],
    ["openrouter", "deepseek/deepseek-v4-flash-0731"],
    ["openrouter", "openrouter/free"],
  ]);
});

test("route planner skips a candidate while its circuit is open", () => {
  const cooldowns = new Map([[
    "cline-oauth:cline/cline-free/deepseek-v4.1-flash:chat_completions",
    Date.now() + 60_000,
  ]]);
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "chat_completions",
    body: { messages: [] },
  }, env, { cooldowns });
  assert.equal(plan.candidates[0].provider.id, "cline-oauth");
  assert.equal(plan.candidates[0].upstreamModel, "cline/cline-free/mimo-v2.6-flash");
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

test("enabled class routing prepends a window-safe cheap target and retains session fallbacks", () => {
  const routed = structuredClone(config);
  routed.classRouting = { enabled: true, cheapPolicyModel: { provider: "mistral", model: "mistral-medium-3-5" } };
  const mistral = routed.providers.find(({ id }) => id === "mistral");
  routed.profiles.find(({ id }) => id === "agent-default").candidates.splice(13, 0, { provider: "mistral", model: "mistral-small-latest" });
  mistral.models.find(({ id }) => id === "mistral-medium-3-5").context_window = 128000;
  const plan = buildRoutePlan(routed, {
    model: "agent-default",
    protocol: "messages",
    requestClass: "subagent",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, env, { cooldowns: new Map() });
  // The cheap target leads, then the session chain in profile order. An
  // Anthropic request can now reach the OpenAI-protocol providers through
  // translation, so Cline (the profile's first candidate) comes next.
  assert.deepEqual(plan.candidates.slice(0, 2).map(({ provider, upstreamModel }) => [provider.id, upstreamModel]), [
    ["mistral", "mistral-medium-3-5"],
    ["cline-oauth", "cline/cline-free/deepseek-v4.1-flash"],
  ]);
});

test("class routing keeps the session route when cheap target window is unknown or below floor", () => {
  for (const window of [undefined, 127999]) {
    const routed = structuredClone(config);
    routed.classRouting = { enabled: true, cheapPolicyModel: { provider: "mistral", model: "mistral-medium-3-5" } };
    const mistral = routed.providers.find(({ id }) => id === "mistral");
    const model = mistral.models.find(({ id }) => id === "mistral-medium-3-5");
    if (window === undefined) delete model.context_window;
    else model.context_window = window;
    const plan = buildRoutePlan(routed, {
      model: "agent-default", protocol: "chat_completions", requestClass: "workflow",
      body: { messages: [{ role: "user", content: "hello" }] },
    }, env, { cooldowns: new Map() });
    assert.equal(plan.candidates[0].provider.id, "cline-oauth");
  }
});


test("unrecognized agent-type hints cannot activate class routing", () => {
  const routed = structuredClone(config);
  routed.classRouting = { enabled: true, cheapPolicyModel: { provider: "mistral", model: "mistral-medium-3-5" } };
  const mistral = routed.providers.find(({ id }) => id === "mistral");
  mistral.models.find(({ id }) => id === "mistral-medium-3-5").context_window = 128000;
  const plan = buildRoutePlan(routed, {
    model: "agent-default", protocol: "chat_completions", requestClass: "subagent",
    agentType: "invented", body: { messages: [{ role: "user", content: "hello" }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.candidates[0].provider.id, "cline-oauth");
});


test("role aliases select a family unused by recent session models and retain profile fallback", () => {
  const routed = structuredClone(config);
  routed.roles = [{
    id: "role/review-strong", max_attempts: 2, context_window: 128000, avoid_recent_families: true, fallback: "agent-default",
    candidates: [
      { provider: "mistral", model: "mistral-medium-3-5", family: "family-a", context_window: 128000 },
      { provider: "openrouter", model: "deepseek/deepseek-v4-flash", family: "family-b", context_window: 128000 },
    ],
  }];
  const modelHistory = new Map([["session-1", { families: ["family-a"], updatedAt: Date.now() }]]);
  const plan = buildRoutePlan(routed, {
    model: "role/review-strong", protocol: "chat_completions", affinityKey: "session-1",
    body: { messages: [{ role: "user", content: "review" }] },
  }, env, { cooldowns: new Map(), modelHistory });
  assert.equal(plan.error, undefined);
  assert.equal(plan.candidates[0].family, "family-b");
  assert.ok(plan.candidates.some(({ provider }) => provider.id === "cline-oauth"));
  assert.equal(plan.publicModel, "role/review-strong");
});

test("role aliases fall back to their full candidate list if no unused family remains", () => {
  const routed = structuredClone(config);
  routed.roles = [{
    id: "role/review-strong", max_attempts: 2, context_window: 128000, avoid_recent_families: true, fallback: "agent-default",
    candidates: [
      { provider: "mistral", model: "mistral-medium-3-5", family: "family-a", context_window: 128000 },
      { provider: "openrouter", model: "deepseek/deepseek-v4-flash", family: "family-b", context_window: 128000 },
    ],
  }];
  const modelHistory = new Map([["session-1", { families: ["family-a", "family-b"], updatedAt: Date.now() }]]);
  const plan = buildRoutePlan(routed, {
    model: "role/review-strong", protocol: "chat_completions", affinityKey: "session-1",
    body: { messages: [{ role: "user", content: "review" }] },
  }, env, { cooldowns: new Map(), modelHistory });
  assert.ok(plan.candidates.length > 2);
  assert.deepEqual(plan.candidates.slice(0, 2).map(({ family }) => family), ["family-a", "family-b"]);
});

test("an Anthropic request reaches an OpenAI-protocol provider through translation", () => {
  const plan = buildRoutePlan(config, {
    model: "groq/llama-3.3-70b-versatile",
    protocol: "messages",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, { ...env, GROQ_API_KEY: "groq-key" }, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  const [candidate] = plan.candidates;
  assert.equal(candidate.provider.id, "groq");
  assert.equal(candidate.upstreamModel, "llama-3.3-70b-versatile");
  assert.equal(candidate.translate, "anthropic-from-openai");
  assert.equal(candidate.native, false);
});

test("a profile exposes its OpenAI-protocol candidates to Anthropic callers", () => {
  const plan = buildRoutePlan(config, {
    model: "agent-default",
    protocol: "messages",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, { ...env, GROQ_API_KEY: "groq-key" }, { cooldowns: new Map() });
  const groq = plan.candidates.find(({ provider }) => provider.id === "groq");
  assert.equal(groq.translate, "anthropic-from-openai");
  assert.equal(groq.upstreamModel, "llama-3.3-70b-versatile");
});

test("a provider that opts out of translation keeps its own lane", () => {
  const plan = buildRoutePlan(config, {
    model: "glm-5",
    protocol: "messages",
    body: { messages: [{ role: "user", content: "hello" }] },
  }, { ...env, MODAL_GLM5_API_KEY: "modal-key" }, { cooldowns: new Map() });
  assert.equal(plan, null);
});

test("Mistral serves Anthropic callers through translation, not a lossy shim", () => {
  const plan = buildRoutePlan(config, {
    model: "mistral-medium-3-5",
    protocol: "messages",
    body: {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    },
  }, { ...env, MISTRAL_API_KEY: "mistral-key" }, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  const [candidate] = plan.candidates;
  assert.equal(candidate.provider.id, "mistral");
  assert.equal(candidate.upstreamModel, "mistral-medium-3-5");
  assert.equal(candidate.translate, "anthropic-from-openai");
  assert.equal(candidate.native, false);
});

test("translated Messages resolves a discovered OpenRouter id to its upstream id", () => {
  const model = "openrouter/z-ai/glm-5.3-flash";
  const plan = buildRoutePlan(config, {
    model,
    protocol: "messages",
    body: { model, max_tokens: 32, messages: [{ role: "user", content: "ping" }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  const [candidate] = plan.candidates;
  assert.equal(candidate.provider.id, "openrouter");
  assert.equal(candidate.upstreamModel, "z-ai/glm-5.3-flash");
  assert.equal(candidate.translate, "anthropic-from-openai");
});

test("translated Messages strips the namespace of a discovered Mistral id", () => {
  const model = "mistral/mistral-large-2411";
  const plan = buildRoutePlan(config, {
    model,
    protocol: "messages",
    body: { model, max_tokens: 32, messages: [{ role: "user", content: "ping" }] },
  }, env, { cooldowns: new Map() });
  assert.equal(plan.error, undefined);
  const [candidate] = plan.candidates;
  assert.equal(candidate.provider.id, "mistral");
  assert.equal(candidate.upstreamModel, "mistral-large-2411");
});
