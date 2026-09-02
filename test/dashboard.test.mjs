import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRoutingConfig } from "../route-config.mjs";
import { RoutingPreferences } from "../preferences.mjs";
import { loadRoutingConfig } from "../route-config.mjs";
import {
  probeAllProviderQuota,
  probeClineOauth,
  probeCodexOauth,
  probeMistral,
  probeOpenCodeGo,
  probeOpenRouter,
  probeProviderQuota,
} from "../quota.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));

test("RoutingPreferences rejects unknown aliases and unconfigured providers", () => {
  const prefs = new RoutingPreferences(config, { readonly: true, env: {} });
  const unknown = "no-such-alias";
  assert.deepEqual(prefs.set(unknown, { target: "x" }), ["unknown alias: no-such-alias"]);

  // codex-oauth is disabled when env lacks its key, so it's not an allowed target provider.
  const errors = prefs.set("profile-low", { provider: "openrouter", target: "ministral-8b-latest" });
  // openrouter is not "configured" with env:{} so should be rejected
  assert.equal(errors.length > 0, true);
});

test("RoutingPreferences persists overrides and reloads them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-prefs-"));
  const file = path.join(dir, "gateway.preferences.yaml");
  fs.writeFileSync(file, "version: 1\naliases: {}\n");

  const env = { MISTRAL_API_KEY: "x" };
  const prefs = new RoutingPreferences(config, { file, env });
  const errors = prefs.set("profile-low", { provider: "mistral", target: "mistral-small-latest", fallback: "oc/kimi-k2.6" });
  assert.deepEqual(errors, []);
  assert.equal(prefs.list().length, 1);

  // Reload from a fresh instance and confirm the override survived.
  const reloaded = new RoutingPreferences(config, { file, env });
  assert.equal(reloaded.get("profile-low").target, "mistral-small-latest");
  assert.equal(reloaded.get("profile-low").provider, "mistral");

  prefs.clear("profile-low");
  assert.equal(prefs.get("profile-low"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RoutingPreferences.resolve applies an active override", () => {
  const prefs = new RoutingPreferences(config, { readonly: true, env: {} });
  // profile-low normally resolves via resolveConfiguredAlias to ministral-8b-latest
  assert.match(prefs.resolve("cheap", (cfg, model) => model), /cheap/);
  prefs.set("profile-low", { target: "gpt-5.6-luna" });
  assert.equal(prefs.resolve("cheap", () => "unused"), "gpt-5.6-luna");
});

test("quota probes return normalized shapes and fail safe", async () => {
  // Missing keys return unavailable without any network call.
  const or = await probeOpenRouter("", "https://openrouter.ai/api/v1");
  assert.equal(or.provider, "openrouter");
  assert.equal(or.available, false);
  assert.equal(or.source, "unavailable");

  const minimax = await probeProviderQuota({ id: "tokligence" }, {});
  assert.equal(minimax.provider, "tokligence");
  assert.equal(minimax.available, true);
  assert.match(minimax.detail.note, /dashboard balance probing/);
});

test("probeAllProviderQuota never rejects and covers enabled providers", async () => {
  const res = await probeAllProviderQuota(
    [{ id: "openrouter", adapter: "middleware" }, { id: "mistral", adapter: "middleware" }],
    { openrouterKey: "", mistralKey: "" },
  );
  assert.equal(res.length, 2);
  assert.equal(res[0].provider, "openrouter");
  assert.equal(res[1].provider, "mistral");
  assert.deepEqual(res.filter((q) => q.available), []);
});



test("quota probes show informational cards for providers without quota endpoints", async () => {
  const cline = probeClineOauth();
  assert.equal(cline.provider, "cline-oauth");
  assert.equal(cline.available, true);
  assert.match(cline.detail.note, /no aggregate quota endpoint/);
  assert.equal(cline.error, undefined);

  const codex = probeCodexOauth();
  assert.equal(codex.provider, "codex-oauth");
  assert.equal(codex.available, true);
  assert.match(codex.detail.note, /CLIProxy credential pool/);
  assert.equal(codex.error, undefined);

  const generic = await probeProviderQuota({ id: "nvidia" }, {});
  assert.equal(generic.available, true);
  assert.match(generic.detail.note, /managed upstream/);
  assert.equal(generic.error, undefined);
});

test("OpenCode unavailable usage endpoints render as informational, not errors", async (t) => {
  const server = await import("node:http").then(({ default: http }) => http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await probeOpenCodeGo("key", `http://127.0.0.1:${server.address().port}`);
  assert.equal(result.available, true);
  assert.equal(result.error, undefined);
  assert.match(result.detail.note, /does not expose quota/);
});

test("bakeToRoutes persists overrides into gateway.routes.yaml", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-bake-"));
  const routesFile = path.join(dir, "gateway.routes.yaml");
  fs.copyFileSync("gateway.routes.yaml", routesFile);
  const prefsFile = path.join(dir, "gateway.preferences.yaml");

  const env = { MISTRAL_API_KEY: "x" };
  const prefs = new RoutingPreferences(config, { file: prefsFile, routesPath: routesFile, env });
  const errors = prefs.set("profile-low", {
    provider: "mistral", target: "mistral-small-latest", fallback: "oc/kimi-k2.6",
  });
  assert.deepEqual(errors, []);

  const summary = prefs.bakeToRoutes();
  assert.equal(summary.written, 1);
  // Live overrides are cleared after baking.
  assert.deepEqual(prefs.list(), []);

  // The baked file now encodes the override and still parses + compiles.
  const baked = loadRoutingConfig(routesFile);
  const low = baked.aliases.find((a) => a.id === "profile-low");
  assert.equal(low.provider, "mistral");
  assert.equal(low.target, "mistral-small-latest");
  assert.equal(low.fallback, "oc/kimi-k2.6");
  // Unrelated aliases untouched.
  assert.equal(baked.aliases.find((a) => a.id === "profile-high").target, "gpt-5.6-terra");
  assert.equal(baked.providers.length, config.providers.length);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("bakeToRoutes clears a provider/fallback when override sets them null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-bake2-"));
  const routesFile = path.join(dir, "gateway.routes.yaml");
  fs.copyFileSync("gateway.routes.yaml", routesFile);

  const prefs = new RoutingPreferences(config, {
    file: path.join(dir, "prefs.yaml"), routesPath: routesFile, env: { MISTRAL_API_KEY: "x" },
  });
  // a-vision-fallback-2 has provider+fallback; override with provider null + no fallback should clear them
  const errs = prefs.set("a-vision-fallback-2", { provider: "", target: "gpt-5.6-luna", fallback: "" });
  assert.deepEqual(errs, []);
  prefs.bakeToRoutes();
  const baked = loadRoutingConfig(routesFile);
  const item = baked.aliases.find((a) => a.id === "a-vision-fallback-2");
  // The parser normalizes absent provider/fallback to null.
  assert.equal(item.provider, null);
  assert.equal(item.target, "gpt-5.6-luna");
  assert.equal(item.fallback, null);
  // The raw YAML should not carry the cleared keys.
  const raw = fs.readFileSync(routesFile, "utf8");
  const block = raw.split("a-vision-fallback-2")[1];
  assert.equal(/provider:/.test(block), false);
  assert.equal(/fallback:/.test(block), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("dashboard exposes Cline OAuth controls without token fields", () => {
  const html = fs.readFileSync("dashboard.html", "utf8");
  assert.match(html, /Cline OAuth/);
  assert.match(html, /admin\/cline\/oauth\/start/);
  assert.match(html, /admin\/cline\/oauth\/status/);
  assert.match(html, /admin\/cline\/oauth\/logout/);
  assert.match(html, /Connect Cline/);
  assert.match(html, /Clear credentials/);
  assert.doesNotMatch(html, /accessToken|refreshToken|device_code/);
});

