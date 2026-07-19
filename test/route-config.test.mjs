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
const enabledEnv = {
  CODEX_PROXY_ENABLED: "true",
  CODEX_PROXY_API_KEY: "internal",
  OLLAMA_API_KEY: "ollama",
};

test("v2 policy exposes cataloged Ollama routes and profiles", () => {
  assert.equal(config.version, 2);
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4-8"), "gateway/architecture");
  assert.equal(resolveConfiguredAlias(config, "minimax-m2.7"), "minimax-m2.7");
  assert.equal(matchConfiguredProvider(config, "ollama/kimi-k2.7-code", enabledEnv), "ollama-cloud");
  assert.equal(matchConfiguredProvider(config, "unknown-model", enabledEnv), null);
  assert.equal(config.models.some((model) => model.id.startsWith("minimax-")), false);
});

test("planner selects exact cataloged direct models and rejects unknown models", () => {
  const unavailable = buildRoutePlan(config, { model: "gateway/architecture", protocol: "messages", body: { model: "gateway/architecture", messages: [] } }, {});
  assert.equal(unavailable.error.status, 503);

  const architecture = buildRoutePlan(config, { model: "gateway/architecture", protocol: "messages", body: { model: "gateway/architecture", messages: [] } }, enabledEnv);
  assert.equal(architecture.candidates[0].upstreamModel, "gpt-5.6-sol");

  const exact = buildRoutePlan(config, { model: "ollama/gpt-oss-20b", protocol: "messages", body: { model: "ollama/gpt-oss-20b", messages: [] } }, enabledEnv);
  assert.equal(exact.profile, null);
  assert.equal(exact.candidates[0].upstreamModel, "gpt-oss:20b");

  const unknown = buildRoutePlan(config, { model: "gpt-5.6-unknown", protocol: "messages", body: { model: "gpt-5.6-unknown", messages: [] } }, enabledEnv);
  assert.equal(unknown.error.status, 404);
  assert.equal(unknown.error.code, "unknown_model");

  const internal = buildRoutePlan(config, { model: "ollama-gpt-oss-20b", protocol: "messages", body: { model: "ollama-gpt-oss-20b", messages: [] } }, enabledEnv);
  assert.equal(internal.error.status, 404);
});

test("planner refuses feature-degrading candidates", () => {
  const plan = buildRoutePlan(config, { model: "gateway/cheap", protocol: "messages", body: { model: "gateway/cheap", stream: true, tools: [{ name: "x" }], messages: [] } }, enabledEnv);
  assert.equal(plan.error.status, 503);
});

test("one policy compiles downstream configurations", () => {
  const env = { TOKLIGENCE_AUTH_SECRET: "public", TOKLIGENCE_ADMIN_SECRET: "admin", ...enabledEnv };
  const ini = compileTokligenceIni(config, env);
  assert.match(ini, /openai_api_key=ollama/);
  assert.match(ini, /openai_base_url=https:\/\/ollama\.com\/v1/);
  assert.match(ini, /model_provider_routes=.*kimi-k2\.7-code\*=>openai/);
  assert.doesNotMatch(ini, /model_provider_routes=.*kimi-k2\.7-code\*=openai/);
  assert.doesNotMatch(ini, /minimax/i);
  const oauth = compileOAuthProxyYaml(config, env);
  assert.match(oauth, /strategy: round-robin/);
  assert.doesNotMatch(oauth, /public/);
  assert.equal(configuredModels(config, env).some(({ public_model }) => public_model === "ollama/kimi-k2.7-code"), true);
});

test("invalid policies fail during startup validation", () => {
  assert.throws(() => parseRoutingConfig("version: 2\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders: []\n"), /providers must not be empty/);
  assert.throws(() => parseRoutingConfig("version: 2\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders:\n  - id: x\n    adapter: invalid\n    billing_class: subscription\n    protocols: [messages]\n    default: true\nmodels: []\n"), /not supported/);
});
