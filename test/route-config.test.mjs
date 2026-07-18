import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  compileOAuthProxyYaml,
  compileTokligenceIni,
  configuredModels,
  matchConfiguredProvider,
  parseRoutingConfig,
  resolveConfiguredAlias,
} from "../route-config.mjs";
import { buildRoutePlan } from "../routing-planner.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));
const codexEnv = { CODEX_PROXY_ENABLED: "true", CODEX_PROXY_API_KEY: "internal" };

test("v2 policy exposes profiles and preserves direct model routing", () => {
  assert.equal(config.version, 2);
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4-8"), "gateway/architecture");
  assert.equal(resolveConfiguredAlias(config, "minimax-m2.7"), "minimax-m2.7");
  assert.equal(matchConfiguredProvider(config, "minimax-m2.7", codexEnv), "tokligence");
  assert.equal(matchConfiguredProvider(config, "unknown-model", codexEnv), "tokligence");
});

test("planner filters disabled candidates and keeps configured physical models exact", () => {
  const unavailable = buildRoutePlan(config, { model: "gateway/architecture", protocol: "messages", body: { model: "gateway/architecture", messages: [] } }, {});
  assert.equal(unavailable.error.status, 503);
  const architecture = buildRoutePlan(config, { model: "gateway/architecture", protocol: "messages", body: { model: "gateway/architecture", messages: [] } }, codexEnv);
  assert.equal(architecture.candidates[0].upstreamModel, "gpt-5.6-sol");
  const exact = buildRoutePlan(config, { model: "gpt-5.6-luna", protocol: "messages", body: { model: "gpt-5.6-luna", messages: [] } }, codexEnv);
  assert.equal(exact.profile, null);
  assert.equal(exact.candidates[0].upstreamModel, "gpt-5.6-luna");
});

test("planner refuses feature-degrading candidates", () => {
  const plan = buildRoutePlan(config, { model: "gateway/cheap", protocol: "messages", body: { model: "gateway/cheap", stream: true, tools: [{ name: "x" }], messages: [] } }, codexEnv);
  assert.equal(plan.error.status, 503);
});

test("one policy compiles downstream configurations", () => {
  const env = { TOKLIGENCE_AUTH_SECRET: "public", TOKLIGENCE_ADMIN_SECRET: "admin", MINIMAX_API_KEY: "minimax", ...codexEnv };
  const ini = compileTokligenceIni(config, env);
  assert.match(ini, /anthropic_api_key=minimax/);
  assert.match(ini, /routes=claude\*=>anthropic,minimax-m2\*=>anthropic,gpt\*=>openai,loopback=>loopback/);
  const oauth = compileOAuthProxyYaml(config, env);
  assert.match(oauth, /strategy: round-robin/);
  assert.doesNotMatch(oauth, /public/);
  assert.equal(configuredModels(config, env).some(({ upstream_model }) => upstream_model === "gpt-5.6-sol"), true);
});

test("invalid policies fail during startup validation", () => {
  assert.throws(() => parseRoutingConfig("version: 2\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders: []\n"), /providers must not be empty/);
  assert.throws(() => parseRoutingConfig("version: 2\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders:\n  - id: x\n    adapter: invalid\n    billing_class: subscription\n    protocols: [messages]\n    default: true\nmodels: []\n"), /not supported/);
});
