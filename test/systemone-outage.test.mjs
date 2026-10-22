import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeAccountPool } from "../opencode-account-pool.mjs";
import { createSystemOnePool } from "../systemone.mjs";
const input = { model: "jev-1.13-free", state: "synthetic", questions: { q: { type: "noul" } } };
const output = { model: input.model, answers: { q: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } };

for (const stalled of ["headers", "body"]) test(`stalled ${stalled} quarantine primary and reach backup within total deadline`, async () => {
  const accountPool = createOpenCodeAccountPool({ provider: { opencode_pool: { accounts: [], api_keys: [
    { id: "a", env: "A", systemone_models: [input.model] }, { id: "b", env: "B", systemone_models: [input.model] },
  ] } }, env: { A: "a", B: "b" } });
  const calls = [];
  const pool = createSystemOnePool({ accountPool, timeoutMs: 500, attemptTimeoutMs: 30, fetchImpl: async (_url, init) => {
    calls.push(init.headers.authorization);
    if (init.headers.authorization === "Bearer b") return new Response(JSON.stringify(output), { headers: { "content-type": "application/json" } });
    if (stalled === "headers") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    return new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); } }), { headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual((await pool.request(input, { stickyKey: "s" })).document, output);
  assert.deepEqual(calls, ["Bearer a", "Bearer b"]);
  assert.ok(accountPool.state.get("a").until > Date.now());
  calls.length = 0;
  await pool.request(input, { stickyKey: "s" });
  assert.deepEqual(calls, ["Bearer b"]);
});
