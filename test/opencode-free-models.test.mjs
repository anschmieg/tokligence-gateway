import { buildRoutePlan } from "../routing-planner.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freeOpenCodeModels, setOpenCodeFreeModels, isDiscoveredOpenCodeFree, discoverOpenCodeFreeModels } from "../opencode-free-models.mjs";
import { createOpenCodeAccountPool } from "../opencode-account-pool.mjs";
import { chatModelAvailable } from "../route-config.mjs";

const cost = { input: 0, output: 0, cache_read: 0 };
test("discovery intersects availability with explicit zero prices, never ID suffixes", () => {
  const models = {
    "new-free": { cost }, "stealth": { cost }, "paid-free": { cost: { ...cost, output: 1 } },
    "unknown-free": {}, "null-free": { cost: { input: null, output: 0 } },
    "cached-free": { cost: { ...cost, cache_write: 1 } },
    "tier-free": { cost: { ...cost, tiers: { large: { input: 1 } } } },
    "old-free": { cost, status: "deprecated" }, "absent-free": { cost }, "jev-1.13-free": { cost },
  };
  const endpoint = { data: Object.keys(models).filter((id) => id !== "absent-free").map((id) => ({ id })) };
  assert.deepEqual(freeOpenCodeModels(endpoint, { opencode: { models } }).map((m) => m.id), ["new-free", "stealth"]);
  endpoint.data[0].pricing = { prompt: 0, completion: 1 };
  assert.deepEqual(freeOpenCodeModels(endpoint, { opencode: { models } }).map((m) => m.id), ["stealth"]);
});

test("new free models route immediately while paid direct requests and static overrides fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-discovery-"));
  try {
    const file = path.join(dir, "oauth.json");
    fs.writeFileSync(file, JSON.stringify({ access: "synthetic" }));
    const provider = { adapter: "opencode-zen", catalog: { discover_free_only: true }, opencode_pool: {
      accounts: [{ id: "oauth", credential_file: file, discover_free_models: true, chat_models: ["paid"] }],
      api_keys: [{ id: "key", env: "KEY", systemone_models: ["jev-1.13-free"] }],
    } };
    const pool = createOpenCodeAccountPool({ provider, env: { KEY: "synthetic" } });
    assert.equal(pool.select("chat", "new-free", "s"), null);
    setOpenCodeFreeModels(provider, [{ id: "new-free" }]);
    assert.equal(chatModelAvailable(provider, "new-free", {}), true);
    assert.equal(pool.select("chat", "new-free", "s").id, "oauth");
    for (const id of ["paid", "paid-free", "opencode-zen/paid", "zen/paid", "jev-1.13-free"]) {
      assert.equal(chatModelAvailable(provider, id, {}), false);
      assert.equal(pool.select("chat", id, "s"), null);
    }
    assert.equal(pool.select("systemone", "jev-1.13-free", "s").id, "key");
    setOpenCodeFreeModels(provider, []);
    assert.equal(pool.select("chat", "new-free", "s"), null);
    setOpenCodeFreeModels(provider, [{ id: "new-free" }], 1000);
    assert.equal(isDiscoveredOpenCodeFree(provider, "new-free", 901000), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("refresh failures revoke a formerly free route and work without an API key", async () => {
  const provider = { base_url: "https://opencode.ai/inference/v1" };
  const responses = [{ data: [{ id: "fresh-free" }] }, { opencode: { models: { "fresh-free": { cost } } } }];
  const result = await discoverOpenCodeFreeModels(provider, async (url, options) => {
    assert.equal(options.headers, undefined);
    return { ok: true, json: async () => responses.shift() };
  });
  assert.equal(result.data[0].id, "fresh-free");
  assert.equal(isDiscoveredOpenCodeFree(provider, "fresh-free"), true);
  const paid = [{ data: [{ id: "fresh-free" }] }, { opencode: { models: { "fresh-free": { cost: { input: 1, output: 1 } } } } }];
  await discoverOpenCodeFreeModels(provider, async () => ({ ok: true, json: async () => paid.shift() }));
  assert.equal(isDiscoveredOpenCodeFree(provider, "fresh-free"), false);
  setOpenCodeFreeModels(provider, [{ id: "fresh-free" }]);
  await assert.rejects(discoverOpenCodeFreeModels(provider, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(isDiscoveredOpenCodeFree(provider, "fresh-free"), false);
});

test("direct provider requests never fall through to the legacy paid proxy", () => {
  const provider = { id: "opencode-zen", adapter: "opencode-zen", catalog: { discover_free_only: true }, protocols: ["chat_completions", "messages"], opencode_pool: { api_keys: [{ env: "TEST_KEY" }] }, models: [], metadata: {} };
  const config = { providers: [provider], routes: [{ provider: provider.id, prefixes: ["opencode-zen/", "zen/"] }], profiles: [], roles: [] };
  const plan = (model, protocol = "chat_completions") => buildRoutePlan(config, { model, protocol, body: { messages: [{ role: "user", content: "test" }] } }, { TEST_KEY: "synthetic" }, { catalogModels: new Map() });
  for (const id of ["opencode-zen/paid", "zen/paid-free", "opencode-go/paid"]) assert.equal(plan(id).error.status, 403);
  setOpenCodeFreeModels(provider, [{ id: "new-free" }]);
  for (const id of ["opencode-zen/new-free", "zen/new-free"]) {
    const result = plan(id);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].upstreamModel, "new-free");
    assert.equal(result.candidates[0].provider.adapter, "opencode-zen");
  }
  assert.equal(plan("zen/new-free", "responses").error.status, 400);
});
