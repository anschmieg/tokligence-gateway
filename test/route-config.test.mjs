import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  compileOAuthProxyYaml,
  compileTokligenceIni,
  configuredModels,
  matchConfiguredProvider,
  parseRoutingConfig,
  providerEnabled,
  resolveConfiguredAlias,
} from "../route-config.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));

test("routing policy preserves current provider prefixes", () => {
  assert.equal(matchConfiguredProvider(config, "openrouter/free"), "openrouter");
  assert.equal(matchConfiguredProvider(config, "zen/model"), "opencode-zen");
  assert.equal(matchConfiguredProvider(config, "oc/kimi-k2.6"), "opencode-go");
  assert.equal(matchConfiguredProvider(config, "minimax-m2.7"), "tokligence");
  assert.equal(matchConfiguredProvider(config, "unknown-model"), "tokligence");
});

test("Mistral provider is configured and routed", () => {
  const mistral = config.providers.find((provider) => provider.id === "mistral");
  assert.equal(mistral.adapter, "middleware");
  assert.equal(mistral.api_key_env, "MISTRAL_API_KEY");
  assert.equal(mistral.default_base_url, "https://api.mistral.ai/v1");
  assert.equal(matchConfiguredProvider(config, "mistral/mistral-large-latest"), "mistral");
  assert.equal(matchConfiguredProvider(config, "mistral-large-latest"), "mistral");
  assert.equal(resolveConfiguredAlias(config, "mistral-large-latest"), "mistral-large-latest");
  assert.equal(providerEnabled(mistral, {}), false);
  assert.equal(providerEnabled(mistral, { MISTRAL_API_KEY: "x" }), true);
});

test("routing aliases use the most specific matching prefix", () => {
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4", {}), "oc/deepseek-v4-pro");
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4", {
    CODEX_PROXY_ENABLED: "true",
    CODEX_PROXY_API_KEY: "internal",
  }), "gpt-5.6-sol");
  const enabled = { CODEX_PROXY_ENABLED: "true", CODEX_PROXY_API_KEY: "internal" };
  assert.equal(resolveConfiguredAlias(config, "claude-haiku-4-5-20251001", enabled), "gpt-5.6-luna");
  assert.equal(resolveConfiguredAlias(config, "claude-sonnet-4-7", enabled), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4-8", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-fable-5", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-sonnet-4.5", enabled), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "claude-3.5-sonnet", enabled), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "claude-3-5-haiku-20241022", enabled), "gpt-5.6-luna");
  assert.equal(resolveConfiguredAlias(config, "claude-4-opus-20250514", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-5-fable", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-opus", enabled), "claude-opus");
  assert.equal(resolveConfiguredAlias(config, "claude-opusfoo", enabled), "claude-opusfoo");
  assert.equal(resolveConfiguredAlias(config, "minimax-m2.7"), "MiniMax-M2.7");
  assert.equal(resolveConfiguredAlias(config, "unknown-model"), "unknown-model");
});

test("one policy compiles both downstream configurations", () => {
  const env = {
    TOKLIGENCE_AUTH_SECRET: "public",
    TOKLIGENCE_ADMIN_SECRET: "admin",
    MINIMAX_API_KEY: "minimax",
    CODEX_PROXY_ENABLED: "true",
    CODEX_PROXY_API_KEY: "internal",
  };
  const ini = compileTokligenceIni(config, env);
  assert.match(ini, /anthropic_api_key=minimax/);
  assert.match(ini, /routes=claude\*=>anthropic,minimax-m2\*=>anthropic,gpt\*=>openai,loopback=>loopback/);

  const oauth = compileOAuthProxyYaml(config, env);
  assert.match(oauth, /strategy: round-robin/);
  assert.match(oauth, /session-affinity: true/);
  assert.doesNotMatch(oauth, /public/);

  const models = configuredModels(config, env);
  assert.equal(models.some(({ id }) => id === "gpt-5.6-sol"), true);
});

test("invalid policies fail during startup validation", () => {
  assert.throws(
    () => parseRoutingConfig("version: 1\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders: []\n"),
    /must define providers/,
  );
  assert.throws(
    () => parseRoutingConfig("version: 1\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders:\n  - id: x\n    adapter: invalid\n    default: true\n"),
    /not supported/,
  );
});
