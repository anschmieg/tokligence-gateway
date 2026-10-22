import test from "node:test";
import assert from "node:assert/strict";
import { buildModelCatalog, modelAllowedByCatalog, retiredModelReason } from "../model-catalog.mjs";
import { decorateCatalog, decorateModel } from "../model-catalog-metadata.mjs";
import { loadRoutingConfig } from "../route-config.mjs";
import { buildRoutePlan } from "../routing-planner.mjs";

const openrouter = {
  id: "openrouter",
  catalog: {
    zero_price_only: true,
    paid_allowlist: ["qwen/qwen3.7-flash"],
  },
};

test("OpenRouter catalog keeps zero-price models even without a free suffix", () => {
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "google/lyria-3-pro-preview",
    pricing: { prompt: "0", completion: "0" },
  }), true);
});

test("OpenRouter catalog retains only configured paid exceptions", () => {
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "qwen/qwen3.7-flash",
    pricing: { prompt: "0.00000003", completion: "0.00000013" },
  }), true);
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "old/paid-model",
    pricing: { prompt: "0.1", completion: "0.2" },
  }), false);
});

test("OpenCode Zen catalog exposes only models explicitly marked free", () => {
  const zen = { id: "opencode-zen", catalog: { id_suffixes: ["-free"] } };
  assert.equal(modelAllowedByCatalog(zen, { id: "deepseek-v4-flash-free" }), true);
  assert.equal(modelAllowedByCatalog(zen, { id: "gpt-5.6-terra" }), false);
  assert.equal(modelAllowedByCatalog(zen, { id: "jev-1.13-free" }), false);
  assert.equal(modelAllowedByCatalog(zen, { id: "jev-1.13" }), false);
});

test("hidden providers do not enter the catalog", () => {
  assert.equal(modelAllowedByCatalog({ id: "opencode-go", catalog: { visible: false } }, {
    id: "deepseek-v4-pro",
  }), false);
});

test("unknown or missing prices never count as free", () => {
  for (const pricing of [{}, { prompt: null, completion: null }, { prompt: "", completion: false }]) {
    assert.equal(modelAllowedByCatalog(openrouter, { id: "unknown", pricing }), false);
  }
});

const config = loadRoutingConfig("gateway.routes.yaml");

test("catalog merges verified aliases and explicit equivalent backends, not matching names", () => {
  const rows = buildModelCatalog([
    { id: "codestral-latest", provider: "mistral", context_window: 128000 },
    { id: "mistral/codestral-latest", provider: "mistral", context_window: 128000 },
    { id: "mistral/codestral-2508", provider: "mistral", upstream_aliases: ["codestral-latest"], context_window: 128000 },
    { id: "cline/cline-free/minimax-m3.1-flash", provider: "cline-oauth", context_window: 1000000 },
    { id: "minimax-m3.1-flash-free", provider: "opencode-zen", context_window: 200000 },
    { id: "openrouter/minimax/minimax-m3.1-flash:free", provider: "openrouter", context_window: 1000000, pricing: { prompt: "0", completion: "0" } },
    { id: "openrouter/deepseek/deepseek-v4-flash", provider: "openrouter" },
    { id: "deepseek-v4.1-flash-free", provider: "opencode-zen" },
  ], config);
  assert.equal(rows.filter((row) => row.id.includes("codestral")).length, 1);
  assert.equal(rows.find((row) => row.id === "mistral/codestral-latest").aliases.length, 3);
  const mini = rows.find((row) => row.id === "minimax-m3.1-flash-free");
  assert.equal(mini.routes.length, 3);
  assert.equal(mini.routes[0].provider, "cline-oauth", "equal-price backends respect the verified Cline-first preference");
  assert.equal(decorateModel(mini, config.model_picker).model_picker_enabled, true);
  assert.equal(mini.context_window, 200000);
  assert.equal(decorateModel(mini).capabilities.limits.max_context_window_tokens, 200000);
  assert.equal(rows.filter((row) => row.id.includes("deepseek")).length, 2);
});

test("personal exclusions and explicit retirements have different semantics", () => {
  const input = [
    { id: "gpt-5.6-sol", provider: "codex-oauth" },
    { id: "space-bunny-free", provider: "opencode-zen" },
    { id: "mistral/ministral-8b-latest", provider: "mistral" },
    { id: "mistral/ministral-14b-latest", provider: "mistral" },
    { id: "gpt-6.1-sol", provider: "codex-oauth" },
    { id: "gpt-6-astra", provider: "codex-oauth" },
  ];
  assert.deepEqual(buildModelCatalog(input, config).map((row) => row.id), ["gpt-6-astra", "gpt-6.1-sol", "mistral/ministral-14b-latest"]);
  assert.match(retiredModelReason(config, "opencode-zen/space-bunny-free"), /retired/);
  assert.equal(retiredModelReason(config, "minimax-m3.1-flash-free"), null);
  assert.equal(input.length, 6, "policy never mutates the request registry");
});

test("specialist rows publish only their implemented API and never enter a chat picker", () => {
  for (const [id, endpoint] of [
    ["voxtral-mini-latest", "/v1/audio/transcriptions"],
    ["voxtral-mini-transcribe-3", "/v1/audio/transcriptions"],
    ["voxtral-mini-tts-3", "/v1/audio/speech"],
    ["voxtral-mini-transcribe-realtime-3", "/v1/audio/transcriptions/realtime"],
    ["mistral-ocr-latest", "/v1/ocr"],
    ["codestral-embed", "/v1/embeddings"],
  ]) {
    const model = decorateModel({ id: `mistral/${id}`, provider: "mistral" });
    assert.deepEqual(model.supported_endpoints, [endpoint]);
    assert.equal(model.model_picker_enabled, false);
    assert.equal(model.capabilities.supports.tool_calls, false);
  }
  assert.deepEqual(decorateModel({ id: "mistral/voxtral-small-latest", provider: "mistral" }).supported_endpoints, ["/v1/chat/completions"]);
  assert(decorateModel({ id: "mistral/codestral-latest", provider: "mistral" }).supported_endpoints.includes("/v1/fim/completions"));
});

test("picker capacity is explicit and preferred models survive new discoveries", () => {
  const rows = [...Array.from({ length: 40 }, (_, i) => ({ id: `new-free-${i}`, provider: "openrouter" })), { id: "gpt-6-astra", provider: "codex-oauth" }];
  const decorated = decorateCatalog(rows, config.model_picker);
  assert.equal(decorated.filter((row) => row.model_picker_enabled).length, 32);
  assert.equal(decorated.find((row) => row.id === "gpt-6-astra").model_picker_enabled, true);
  assert.match(decorated.find((row) => !row.model_picker_enabled).policy.terms, /capacity/);
});

test("selected picker families survive a crowded catalog while new models use spare slots", () => {
  const preferred = [
    ["gpt-6.1-sol", "codex-oauth"], ["gpt-6-astra", "codex-oauth"], ["gpt-6-luna", "codex-oauth"],
    ["minimax-m3.1-flash-free", "opencode-zen"], ["deepseek-v4.1-flash-free", "opencode-zen"],
    ["mistral/codestral-latest", "mistral"], ["mistral/ministral-14b-latest", "mistral"],
    ["mistral/mistral-vibe-cli-with-tools", "mistral"],
    ["poolside/laguna-s-2.1", "openrouter"], ["openrouter/poolside/laguna-s-2.2:free", "openrouter"],
    ["thinkingmachines/inkling-small", "openrouter"], ["openrouter/thinkingmachines/inkling-next:free", "openrouter"],
    ["openrouter/cohere/north-mini-code:free", "openrouter"], ["openrouter/liquid/lfm-2.5-2.6b:free", "openrouter"],
  ].map(([id, provider]) => ({ id, provider }));
  const newcomers = Array.from({ length: 40 }, (_, i) => ({ id: `aaa-new-${i}`, provider: "openrouter" }));
  const audio = { id: "mistral/voxtral-small-latest", provider: "mistral" };
  const crowded = decorateCatalog([...newcomers, audio, ...preferred], config.model_picker);
  const selected = crowded.filter((row) => row.model_picker_enabled);
  assert.equal(selected.length, 32);
  for (const row of preferred) assert(selected.some((option) => option.id === row.id), row.id);
  assert.equal(crowded.find((row) => row.id === audio.id).model_picker_enabled, false);
  assert.match(crowded.find((row) => row.id === audio.id).policy.terms, /Audio specialists/);
  const spare = decorateCatalog([...preferred, newcomers[0]], config.model_picker);
  assert.equal(spare.find((row) => row.id === newcomers[0].id).model_picker_enabled, true);
  assert.equal(crowded.length, newcomers.length + preferred.length + 1, "picker policy never removes API rows");
});

test("canonical routes prefer free backends and reject incompatible fallback context", () => {
  const routing = structuredClone(config);
  routing.providers.find((p) => p.id === "openrouter").catalog.paid_allowlist.push("poolside/laguna-s-2.1");
  const rows = buildModelCatalog([
    { id: "openrouter/poolside/laguna-s-2.1", provider: "openrouter", pricing: { prompt: ".01", completion: ".02" }, context_window: 500 },
    { id: "openrouter/poolside/laguna-s-2.1:free", provider: "openrouter", pricing: { prompt: "0", completion: "0" }, context_window: 10 },
  ], routing);
  const state = { catalogModels: new Map(rows.map((row) => [row.id, row])) };
  const request = { model: "poolside/laguna-s-2.1", protocol: "chat_completions", body: { messages: [{ role: "user", content: "x".repeat(100) }] } };
  const plan = buildRoutePlan(routing, request, { OPENROUTER_API_KEY: "test" }, state);
  assert.equal(plan.candidates.length, 1, "tiny-context free route cannot serve even this request");
  assert.equal(plan.candidates[0].upstreamModel, "poolside/laguna-s-2.1");
  const small = buildRoutePlan(routing, { ...request, body: {} }, { OPENROUTER_API_KEY: "test" }, state);
  assert.equal(small.candidates[0].upstreamModel, "poolside/laguna-s-2.1:free");
});

test("saved canonical IDs cannot fall through to an unrelated provider before discovery", () => {
  const plan = buildRoutePlan(config, { model: "poolside/laguna-s-2.1", protocol: "chat_completions", body: {} }, { OPENROUTER_API_KEY: "test" }, { catalogModels: new Map() });
  assert.equal(plan.error.status, 503);
  assert.equal(plan.error.code, "canonical_model_unavailable");
});

test("canonical fallback respects per-model tool support and preserves the Cline Messages translator", () => {
  const rows = buildModelCatalog([
    { id: "cline/cline-free/minimax-m3.1-flash", provider: "cline-oauth", context_window: 1000000, supports_parallel_tool_calls: true },
    { id: "openrouter/minimax/minimax-m3.1-flash:free", provider: "openrouter", context_window: 1000000, pricing: { prompt: "0", completion: "0" }, upstream_capabilities: { function_calling: false } },
  ], config);
  assert.equal(decorateModel(rows[0], config.model_picker).model_picker_enabled, true);
  const state = { catalogModels: new Map(rows.map((row) => [row.id, row])) };
  const request = { model: "minimax-m3.1-flash-free", protocol: "messages", body: { messages: [{ role: "user", content: "hello" }], parallel_tool_calls: true, tools: [{ name: "test", input_schema: { type: "object" } }] } };
  const plan = buildRoutePlan(config, request, { OPENROUTER_API_KEY: "test" }, state);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].provider.id, "cline-oauth");
  assert.equal(plan.candidates[0].translate, "anthropic-from-openai");
});
