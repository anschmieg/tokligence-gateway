import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenCodeAccountPool } from "../opencode-account-pool.mjs";
import { setOpenCodeFreeModels } from "../opencode-free-models.mjs";
import { configuredModels, parseRoutingConfig } from "../route-config.mjs";
import { parse, stringify } from "yaml";

function fixture(now) {
  return createOpenCodeAccountPool({
    provider: { credential_file: "/missing", opencode_pool: { accounts: [], api_keys: [
      { id: "primary", env: "A", systemone_models: ["jev-1.13-free"] },
      { id: "backup", env: "B", systemone_models: ["jev-1.13-free"] },
      { id: "paid", env: "P", systemone_models: ["jev-1.13"] },
    ] } }, env: { A: "a", B: "b", P: "p" }, now,
  });
}

test("ordered backup selection remains sticky after primary recovers and excludes paid/chat", () => {
  let at = 1000;
  const pool = fixture(() => at);
  const primary = pool.select("systemone", "jev-1.13-free", "session");
  assert.equal(primary.id, "primary");
  pool.markFailure(primary, null, { retryAfterMs: 10000 });
  const backup = pool.select("systemone", "jev-1.13-free", "session");
  assert.equal(backup.id, "backup");
  pool.markSuccess(backup, "session", 0);
  at += 11000;
  assert.equal(pool.select("systemone", "jev-1.13-free", "session").id, "backup");
  assert.equal(pool.select("systemone", "jev-1.13-free", "new-session").id, "primary");
  assert.equal(pool.select("chat", "jev-1.13-free", "session"), null);
  assert.deepEqual(pool.eligibleAccounts("systemone", "jev-1.13"), ["paid"]);
});

test("concurrent failure ordering cannot shorten an existing Retry-After quarantine", () => {
  for (const longFirst of [true, false]) {
    let at = 1000;
    const pool = fixture(() => at);
    const account = pool.select("systemone", "jev-1.13-free", "s");
    const long = () => pool.markFailure(account, null, { retryAfterMs: 3600000 });
    const short = () => pool.markFailure(account, null);
    if (longFirst) { long(); short(); } else { short(); long(); }
    assert.equal(pool.state.get(account.id).until, 3601000);
    at += 120000;
    assert.equal(pool.select("systemone", "jev-1.13-free", "new").id, "backup");
  }
});

test("stale successes cannot clear quarantine or overwrite backup affinity", () => {
  const pool = fixture(() => 1000);
  const primary = pool.select("systemone", "jev-1.13-free", "s");
  pool.markFailure(primary, null);
  const backup = pool.select("systemone", "jev-1.13-free", "s");
  pool.markSuccess(backup, "s", 0);
  pool.markSuccess(primary, "s", 0);
  assert.equal(pool.affinity.get("s").accountId, "backup");
  assert.ok(pool.state.get(primary.id).until > 1000);
});

test("native OAuth authorization is lazy about account-owned chat sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pool-"));
  const file = path.join(dir, "credential.json");
  fs.writeFileSync(file, JSON.stringify({ access: "test", expires: Date.now() + 3600000 }));
  let sessions = 0;
  try {
    const pool = createOpenCodeAccountPool({ provider: { opencode_pool: { accounts: [{ id: "oauth", credential_file: file, systemone_models: ["jev-1.13-free"], chat_models: ["beam-free"] }] } },
      getTokenProvider: () => ({ authorization: async () => "Bearer test" }), createSessions: () => { sessions++; return {}; } });
    const account = pool.select("systemone", "jev-1.13-free", "s");
    assert.equal(await pool.authorizationFor(account), "test");
    assert.equal(sessions, 0);
    const first = pool.servicesFor(account).sessions;
    assert.equal(pool.servicesFor(account).sessions, first);
    assert.equal(sessions, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("native-only keys do not advertise configured chat models", () => {
  const config = parseRoutingConfig(fs.readFileSync(new URL("../gateway.routes.yaml", import.meta.url), "utf8"));
  assert.equal(configuredModels(config, { OPENCODE_API_KEY: "synthetic", OPENCODE_ZEN_CREDENTIAL_FILE: "/missing-native-only-fixture" }).some((model) => model.provider === "opencode-zen"), false);
});

test("pool configuration rejects duplicate identities, inline secrets and obsolete policy", () => {
  const raw = parse(fs.readFileSync(new URL("../gateway.routes.yaml", import.meta.url), "utf8"));
  const invalid = (change) => {
    const next = structuredClone(raw);
    change(next.providers.find((p) => p.id === "opencode-zen"));
    assert.throws(() => parseRoutingConfig(stringify(next)));
  };
  invalid((p) => p.opencode_pool.api_keys.push({ ...p.opencode_pool.api_keys[0] }));
  invalid((p) => p.opencode_pool.accounts[0].access = "secret");
  invalid((p) => p.opencode_pool.api_keys[0].env = "not a variable");
  invalid((p) => p.opencode_pool.accounts[0].systemone_models = ["unsupported"]);
  invalid((p) => p.systemone = {});
});

test("shipped secondary Zen OAuth account is optional and shares free-only eligibility", () => {
  const config = parseRoutingConfig(fs.readFileSync(new URL("../gateway.routes.yaml", import.meta.url), "utf8"));
  const provider = config.providers.find((entry) => entry.id === "opencode-zen");
  const [primary, secondary] = provider.opencode_pool.accounts;
  assert.equal(primary.id, "primary-oauth");
  assert.equal(secondary.id, "secondary-oauth");
  assert.equal(secondary.credential_file, "/data/zen/secondary-oauth.json");
  assert.equal(secondary.discover_free_models, true);
  assert.notEqual(primary.credential_file_env, secondary.credential_file);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-secondary-"));
  const primaryFile = path.join(dir, "primary.json");
  const secondaryFile = path.join(dir, "secondary.json");
  try {
    fs.writeFileSync(primaryFile, JSON.stringify({ access: "synthetic-primary" }));
    const runtimeProvider = { ...provider, credential_file: primaryFile, credential_file_env: null, opencode_pool: {
      ...provider.opencode_pool,
      accounts: [
        { ...primary, credential_file: primaryFile, credential_file_env: null },
        { ...secondary, credential_file: secondaryFile },
      ],
    } };
    const env = {};
    const pool = createOpenCodeAccountPool({ provider: runtimeProvider, env });
    setOpenCodeFreeModels(runtimeProvider, [{ id: "beam-free" }]);
    assert.deepEqual(pool.eligibleAccounts("chat", "beam-free"), ["primary-oauth"]);
    fs.writeFileSync(secondaryFile, JSON.stringify({ access: "synthetic-secondary" }));
    assert.deepEqual(pool.eligibleAccounts("chat", "beam-free"), ["primary-oauth", "secondary-oauth"]);
    assert.deepEqual(pool.eligibleAccounts("chat", "jev-1.13-free"), []);
    assert.deepEqual(pool.eligibleAccounts("chat", "paid-model"), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("explicit backup files do not inherit the primary credential environment override", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-distinct-"));
  const primary = path.join(dir, "primary.json");
  const backup = path.join(dir, "backup.json");
  for (const file of [primary, backup]) fs.writeFileSync(file, JSON.stringify({ access: "synthetic" }));
  const observed = [];
  const provider = { credential_file: "/missing", credential_file_env: "PRIMARY_FILE", opencode_pool: { accounts: [
    { id: "primary", credential_file_env: "PRIMARY_FILE", systemone_models: ["jev-1.13-free"] },
    { id: "backup", credential_file: backup, systemone_models: ["jev-1.13-free"] },
  ] } };
  try {
    const pool = createOpenCodeAccountPool({ provider, env: { PRIMARY_FILE: primary }, getTokenProvider: (entry) => {
      observed.push(entry.credential_file);
      return { authorization: async () => "Bearer synthetic" };
    } });
    await pool.authorizationFor(pool.select("systemone", "jev-1.13-free", "s", { exclude: ["primary"] }));
    assert.deepEqual(observed, [backup]);
    const alias = path.join(dir, "alias.json");
    fs.symlinkSync(primary, alias);
    assert.throws(() => createOpenCodeAccountPool({ provider: { opencode_pool: { accounts: [{ id: "one", credential_file: primary }, { id: "two", credential_file: alias }] } } }), /distinct/);
    assert.throws(() => createOpenCodeAccountPool({ provider: { ...provider, opencode_pool: { accounts: [
      { id: "one", credential_file: primary }, { id: "two", credential_file: primary },
    ] } }, env: {} }), /distinct/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
