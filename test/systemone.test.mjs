import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSystemOnePool, systemOneStickyKey, validateSystemOneRequest, validateSystemOneResponse } from "../systemone.mjs";
import { createOpenCodeAccountPool } from "../opencode-account-pool.mjs";

const request = {
  model: "jev-1.13-free",
  state: "Command text for evaluation only: pwd",
  questions: {
    privileged: { type: "noul", instructions: "Does this require admin privileges?", criteria: { true: "Requires admin privileges", false: "Does not require admin privileges" } },
    risk: { type: "score", instructions: "Rate risk", criteria: ["Harmless", "Privileged change"] },
    kind: { type: "choice", instructions: "Classify command", criteria: { read_only: "Read-only", privileged: "Privileged" } },
  },
};
const answer = {
  model: request.model,
  answers: {
    privileged: { type: "noul", noul: 0.02, legend: { true: "Requires admin privileges", false: "Does not require admin privileges" } },
    risk: { type: "score", score: 0, confidence: 1, legend: { 0: "Harmless", 1: "Privileged change" }, probabilities: { 0: 1, 1: 0 } },
    kind: { type: "choice", choice: "read_only", confidence: 1, probabilities: { read_only: 1, privileged: 0 } },
  },
  usage: { input_tokens: 388, output_tokens: 66 },
};

test("validates native noul, choice, and score request and preserves typed response", () => {
  validateSystemOneRequest(request);
  assert.equal(validateSystemOneResponse(answer, request), true);
  assert.equal(validateSystemOneResponse({ ...answer, answers: { ...answer.answers, kind: { ...answer.answers.kind, choice: "not-a-choice" } } }, request), false);
  assert.equal(validateSystemOneResponse({ ...answer, answers: { privileged: answer.answers.privileged } }, request), false);
  assert.equal(validateSystemOneResponse({ ...answer, answers: { ...answer.answers, privileged: { type: "noul", noul: 1.1 } } }, request), false);
});

test("rejects malformed request schemas, unsupported model, and invalid typed questions", () => {
  assert.doesNotThrow(() => validateSystemOneRequest({ ...request, model: "jev-1.13" }));
  assert.throws(() => validateSystemOneRequest({ ...request, questions: { q: { type: "text", instructions: "x" } } }));
  assert.throws(() => validateSystemOneRequest({ ...request, questions: {} }));
  assert.throws(() => validateSystemOneRequest({ ...request, questions: { q: { type: "noul", instructions: "x", unexpected: true } } }));
  assert.throws(() => validateSystemOneRequest({ ...request, questions: { q: { type: "choice", instructions: "x", criteria: { only: "one" } } } }));
  assert.throws(() => validateSystemOneRequest({ ...request, questions: { q: { type: "score", instructions: "x", criteria: ["only"] } } }));
  assert.throws(() => validateSystemOneRequest({ ...request, state: null }));
});

test("sticky selection, cooldown failover, and model eligibility do not round-robin", async () => {
  let now = 10_000;
  const calls = [];
  let firstFails = true;
  const fetchImpl = async (_url, options) => {
    const account = options.headers.authorization;
    calls.push(account);
    if (account === "Bearer A" && firstFails) return new Response(JSON.stringify({ error: { message: "private" } }), { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = { id: "opencode-zen", credential_file: "/unused", credential_file_env: null, opencode_pool: { max_attempts: 3, accounts: [], api_keys: [
    { id: "a", env: "A", systemone_models: ["jev-1.13-free"] },
    { id: "b", env: "B", systemone_models: ["jev-1.13-free"] },
    { id: "paid", env: "P", systemone_models: ["jev-1.13"] },
  ] } };
  const accountPool = createOpenCodeAccountPool({ provider, env: { A: "A", B: "B", P: "P" }, getTokenProvider: () => { throw new Error("API-key path must not create OAuth token providers"); } });
  const pool = createSystemOnePool({ accountPool, fetchImpl, now: () => now });
  const stickyKey = systemOneStickyKey("Bearer client", "session-1");
  const one = await pool.request(request, { stickyKey });
  assert.deepEqual(one.document, answer);
  assert.deepEqual(calls, ["Bearer A", "Bearer B"]);
  firstFails = false;
  calls.length = 0;
  await pool.request(request, { stickyKey });
  assert.deepEqual(calls, ["Bearer B"]);
  assert.deepEqual(pool.eligibleAccounts("jev-1.13"), ["paid"]);
  now += 60_001;
  const differentKey = systemOneStickyKey("Bearer client", "session-2");
  calls.length = 0;
  await pool.request(request, { stickyKey: differentKey });
  assert.deepEqual(calls, ["Bearer B"]);
  const newAccountPool = createOpenCodeAccountPool({ provider, env: { A: "A", B: "B", P: "P" } });
  const freshPool = createSystemOnePool({ accountPool: newAccountPool, fetchImpl, now: () => now });
  calls.length = 0;
  await freshPool.request(request, { stickyKey: differentKey });
  assert.deepEqual(calls, ["Bearer A"]);
});

test("sessions and principals have stable isolated sticky keys", () => {
  const first = systemOneStickyKey("Bearer principal", "session-one");
  assert.equal(first, systemOneStickyKey("Bearer principal", "session-one"));
  assert.notEqual(first, systemOneStickyKey("Bearer principal", "session-two"));
  assert.notEqual(first, systemOneStickyKey("Bearer other", "session-one"));
});

test("OAuth account forwards only upstream auth/content headers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-"));
  const credentialFile = path.join(dir, "oauth.json");
  fs.writeFileSync(credentialFile, JSON.stringify({ access: "test-access", expires: Date.now() + 60 * 60 * 1000 }), { mode: 0o600 });
  try {
  let observed;
  const accountPool = createOpenCodeAccountPool({
    provider: { id: "opencode-zen", credential_file: null, credential_file_env: null, opencode_pool: { accounts: [{ id: "oauth", credential_file: credentialFile, credential_file_env: null, chat_models: [], systemone_models: ["jev-1.13-free"] }], api_keys: [] } },
    env: {},
    getTokenProvider: () => ({ authorization: async () => "oauth-token" }),
    createSessions: () => { throw new Error("SystemOne OAuth must not start the chat session adapter"); },
  });
  const pool = createSystemOnePool({ accountPool, fetchImpl: async (url, options) => {
    observed = { url, ...options };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await pool.request(request, { stickyKey: "p:s" });
  assert.equal(observed.url, "https://opencode.ai/inference/systemone/v1/systemone");
  assert.equal(observed.headers.authorization, "Bearer oauth-token");
  assert.deepEqual(Object.keys(observed.headers).sort(), ["authorization", "content-type"]);
  assert.equal(observed.redirect, "error");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("non-JSON upstream responses fail closed and quarantine account", async () => {
  const accountPool = createOpenCodeAccountPool({ provider: { id: "opencode-zen", credential_file: null, credential_file_env: null, opencode_pool: { accounts: [], api_keys: [{ id: "a", env: "A", systemone_models: ["jev-1.13-free"] }] } }, env: { A: "key" } });
  const pool = createSystemOnePool({ accountPool, fetchImpl: async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }) });
  await assert.rejects(pool.request(request));
  assert.ok(pool.cooldowns.get("a").until > Date.now());
});

test("upstream errors preserve HTTP status without exposing their body", async () => {
  for (const status of [400, 401, 403, 429, 500, 503, 504]) {
    const accountPool = createOpenCodeAccountPool({ provider: { opencode_pool: { accounts: [], api_keys: [{ id: "a", env: "A", systemone_models: [request.model] }] } }, env: { A: "key" } });
    const pool = createSystemOnePool({ accountPool, fetchImpl: async () => new Response("private bearer and command contents", { status }) });
    await assert.rejects(pool.request(request), (error) => error.statusCode === status && !error.message.includes("private"));
  }
});

test("request cancellation does not quarantine an account or start an upstream attempt", async () => {
  let calls = 0;
  const accountPool = createOpenCodeAccountPool({ provider: { opencode_pool: { accounts: [], api_keys: [{ id: "a", env: "A", systemone_models: [request.model] }] } }, env: { A: "key" } });
  const pool = createSystemOnePool({ accountPool, fetchImpl: async () => { calls++; throw new Error("not expected"); } });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(pool.request(request, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
  assert.equal(accountPool.state.get("a").generation, 0);
});

test("native content and strict response probabilities are validated without chat conversion", () => {
  validateSystemOneRequest({ ...request, state: { command: "pwd", context: [null, "synthetic"] }, questions: { q: { type: "noul" } } });
  validateSystemOneRequest({ ...request, state: "" });
  assert.throws(() => validateSystemOneRequest({ ...request, questions: { q: { type: "noul", criteria: { wrong: "x" } } } }));
  const broken = structuredClone(answer);
  delete broken.answers.kind.probabilities;
  assert.equal(validateSystemOneResponse(broken, request), false);
  const zeros = structuredClone(answer);
  zeros.answers.risk.probabilities = { 0: 0, 1: 0 };
  assert.equal(validateSystemOneResponse(zeros, request), false);
});
