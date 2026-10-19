import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  compileOAuthProxyYaml,
  compileTokligenceIni,
  configuredModels,
  enabledProviders,
  matchConfiguredProvider,
  parseRoutingConfig,
  providerEnabled,
  quotaObserverProviders,
  resolveConfiguredAlias,
} from "../route-config.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));

test("config compiler restores private permissions on existing generated OAuth config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-private-config-"));
  const target = path.join(root, "data/cliproxy/config.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "old config", { mode: 0o644 });
  try {
    const run = spawnSync(process.execPath, ["compile-config.mjs"], {
      cwd: process.cwd(), encoding: "utf8", env: {
        ...process.env,
        CONFIG_OUTPUT_ROOT: root,
        TOKLIGENCE_AUTH_SECRET: "fixture-public",
        TOKLIGENCE_ADMIN_SECRET: "fixture-admin",
        CODEX_MANAGEMENT_KEY: "fixture-private-management",
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.statSync(target).mode & 0o077, 0);
    assert.match(fs.readFileSync(target, "utf8"), /fixture-private-management/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Mistral session credentials enable quota observation without enabling inference routing", () => {
  const env = { MISTRAL_SESSION_FILE: "/private/mistral-session.json" };
  const mistral = config.providers.find((provider) => provider.id === "mistral");
  assert.equal(providerEnabled(mistral, env), false);
  assert.equal(quotaObserverProviders(config, env).some((provider) => provider.id === "mistral"), true);
  assert.equal(enabledProviders(config, env).some((provider) => provider.id === "mistral"), false);
});

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

test("Anthropic beta allow-lists are validated and forbidden on protocol-translation lanes", () => {
  const base = [
    "version: 1", "access:", "  public_secret_env: PUBLIC", "  admin_secret_env: ADMIN",
    "providers:", "  - id: test", "    adapter: openai-compatible", "    default: true",
    "    protocols: [messages]", "    anthropic_beta_allowlist: [compact-2026-09-04]", "aliases: []",
  ].join("\n");
  const allowed = parseRoutingConfig(base);
  assert.deepEqual(allowed.providers[0].anthropic_beta_allowlist, ["compact-2026-09-04"]);
  assert.throws(() => parseRoutingConfig(base.replace("openai-compatible", "oauth-proxy")), /cannot allow Anthropic betas/);
  assert.throws(() => parseRoutingConfig(base.replace("openai-compatible", "tokligence")), /cannot allow Anthropic betas/);
  assert.throws(() => parseRoutingConfig(base.replace("compact-2026-09-04", "42")), /anthropic_beta_allowlist must contain only non-empty strings/);
});


test("class routing is opt-in and targets only configured provider models", () => {
  const source = fs.readFileSync("gateway.routes.yaml", "utf8");
  // A disabled block stays a valid, inert configuration.
  const disabled = source.replace(
    "classRouting:\n  enabled: true",
    "classRouting:\n  enabled: false",
  );
  assert.equal(parseRoutingConfig(disabled).classRouting.enabled, false);
  // Enabling without a verified window must fail during startup validation.
  const noWindow = disabled.replace("        context_window: 256000\n", "");
  assert.throws(
    () => parseRoutingConfig(noWindow.replace("  enabled: false", "  enabled: true")),
    /requires a verified context_window/,
  );
  assert.throws(() => parseRoutingConfig(source.replace("provider: mistral\n    model: mistral-medium-3-5", "provider: codex-oauth\n    model: gpt-5.6-terra")), /cannot target an oauth-proxy/);
  assert.throws(() => parseRoutingConfig(source.replace("model: mistral-medium-3-5\n", "model: not-configured\n")), /must reference a configured provider model/);
});


test("the shipped routing policy enables class routing with a documented window target", () => {
  assert.equal(config.classRouting.enabled, true);
  assert.deepEqual(config.classRouting.cheapPolicyModel, { provider: "mistral", model: "mistral-medium-3-5" });
  const mistral = config.providers.find(({ id }) => id === "mistral");
  const target = mistral.models.find(({ id }) => id === "mistral-medium-3-5");
  assert.equal(target.context_window, 256000);
});

test("shipped role aliases publish their minimum candidate window", () => {
  const role = config.roles.find(({ id }) => id === "role/review-strong");
  assert.ok(role);
  assert.equal(role.context_window, 131072);
  assert.equal(role.fallback, "agent-default");
  assert.deepEqual(role.candidates.map(({ family }) => family), ["mistral", "bonsai", "gpt-oss"]);
});

test("role aliases require family and verified windows and publish the minimum window", () => {
  const source = [
    "version: 1", "access:", "  public_secret_env: PUBLIC", "  admin_secret_env: ADMIN",
    "providers:", "  - id: test", "    adapter: middleware", "    default: true",
    "    protocols: [chat_completions]", "    models:", "      - id: light", "        context_window: 128000",
    "      - id: strong", "        context_window: 256000", "aliases: []", "profiles:",
    "  session-default:", "    context_window: 128000", "    candidates:",
    "      - provider: test", "        model: light", "roles:",
    "  review-strong:", "    fallback: session-default", "    candidates:", "      - provider: test", "        model: light", "        family: family-a",
    "      - provider: test", "        model: strong", "        family: family-b",
  ].join("\n");
  const role = parseRoutingConfig(source).roles[0];
  assert.equal(role.id, "role/review-strong");
  assert.equal(role.context_window, 128000);
  assert.equal(role.avoid_recent_families, true);
  assert.throws(() => parseRoutingConfig(source.replace("context_window: 256000", "context_window: 0")), /requires a verified context_window/);
});
