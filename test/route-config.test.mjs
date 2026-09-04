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
  assert.equal(matchConfiguredProvider(config, "oc/kimi-k2.6"), "tokligence");
  assert.equal(matchConfiguredProvider(config, "opencode-go/deepseek-v4-flash-free"), "tokligence");
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

test("Cline OAuth provider is native, free-only, and fail-closed by prefix", () => {
  const cline = config.providers.find((provider) => provider.id === "cline-oauth");
  assert.equal(cline.adapter, "cline-oauth");
  assert.equal(cline.credentials_path, "/data/cline-oauth/credentials.json");
  assert.equal(cline.default_base_url, "https://api.cline.bot");
  assert.equal(cline.default_workos_base_url, "https://api.workos.com");
  assert.equal(cline.model_cache_ttl_ms, 300000);
  assert.equal(cline.metadata.cost_class, "free");
  assert.equal(matchConfiguredProvider(config, "cline/z-ai/glm-5.3-flash"), "cline-oauth");
  assert.equal(providerEnabled(cline, {}), true);
});

test("capability profiles route to correct models and fallbacks", () => {
  const enabled = { CODEX_PROXY_ENABLED: "true", CODEX_PROXY_API_KEY: "internal" };
  assert.equal(resolveConfiguredAlias(config, "xhigh", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "reasoning", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "smartest", enabled), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "high", enabled), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "engineer", enabled), "gpt-5.6-terra");
  // Routing is fail-closed: a profile's provider must be enabled, otherwise its
  // fallback is used. Mistral-backed profiles fall back when Mistral is off.
  const mistralOff = {};
  const mistralOn = { MISTRAL_API_KEY: "x" };
  assert.equal(resolveConfiguredAlias(config, "low", mistralOff), "oc/kimi-k2.6");
  assert.equal(resolveConfiguredAlias(config, "cheap", mistralOff), "oc/kimi-k2.6");
  assert.equal(resolveConfiguredAlias(config, "low", mistralOn), "ministral-8b-latest");
  assert.equal(resolveConfiguredAlias(config, "cheap", mistralOn), "ministral-8b-latest");

  assert.equal(resolveConfiguredAlias(config, "vision", mistralOff), "a-vision-fallback");
  assert.equal(resolveConfiguredAlias(config, "reviewer", mistralOff), "a-vision-fallback");
  assert.equal(resolveConfiguredAlias(config, "vision", mistralOn), "pixtral-large-latest");
  assert.equal(resolveConfiguredAlias(config, "reviewer", mistralOn), "pixtral-large-latest");
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
  assert.throws(
    () => parseRoutingConfig("version: 1\naccess:\n  public_secret_env: PUBLIC\n  admin_secret_env: ADMIN\nproviders:\n  - id: x\n    adapter: cline-oauth\n    default: true\n    model_cache_ttl_ms: 300001\naliases: []\n"),
    /model_cache_ttl_ms must be between 0 and 300000/,
  );
});
