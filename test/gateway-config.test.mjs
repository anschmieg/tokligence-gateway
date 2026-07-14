import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_REASONING_LEVELS,
  codexUpstreamUrl,
  isCodexModel,
  isReservedCodexModel,
  loadCodexConfig,
  resolveClaudeTier,
} from "../gateway-config.mjs";

test("Codex stays disabled when no backend is configured", () => {
  const config = loadCodexConfig({});
  assert.equal(config.enabled, false);
  assert.deepEqual(config.models, []);
});

test("partial Codex configuration fails closed", () => {
  assert.throws(
    () => loadCodexConfig({ CODEX_PROXY_BASE_URL: "http://codex:8317" }),
    /must be configured together/,
  );
  assert.throws(
    () => loadCodexConfig({ CODEX_PROXY_API_KEY: "internal" }),
    /must be configured together/,
  );
});

test("default model tiers map Claude classes to the GPT-5.6 family", () => {
  const config = loadCodexConfig({
    CODEX_PROXY_BASE_URL: "http://codex:8317/",
    CODEX_PROXY_API_KEY: "internal",
  });

  assert.equal(config.enabled, true);
  assert.equal(resolveClaudeTier("claude-haiku", config.tiers, {}), "gpt-5.6-luna");
  assert.equal(resolveClaudeTier("claude-sonnet", config.tiers, {}), "gpt-5.6-terra");
  assert.equal(resolveClaudeTier("claude-opus", config.tiers, {}), "gpt-5.6-sol");
  assert.equal(resolveClaudeTier("claude-fable", config.tiers, {}), "gpt-5.6-sol");
  assert.equal(isCodexModel(config, "GPT-5.6-SOL"), true);
  assert.equal(isReservedCodexModel("gpt-5.6-unknown"), true);
  assert.equal(isReservedCodexModel("gpt-5.5"), false);
  assert.deepEqual(CODEX_REASONING_LEVELS, [
    "none", "low", "medium", "high", "xhigh", "max",
  ]);
});

test("tier targets must be included in the exact model allowlist", () => {
  assert.throws(
    () => loadCodexConfig({
      CODEX_PROXY_BASE_URL: "http://codex:8317",
      CODEX_PROXY_API_KEY: "internal",
      CODEX_MODELS: "gpt-5.6-sol",
    }),
    /claude-haiku maps to gpt-5.6-luna/,
  );
});

test("upstream URLs retain query strings and normalize Anthropic prefixes", () => {
  const config = loadCodexConfig({
    CODEX_PROXY_BASE_URL: "http://codex:8317/internal",
    CODEX_PROXY_API_KEY: "internal",
  });
  assert.equal(
    codexUpstreamUrl(config, "/anthropic/v1/messages?beta=true").href,
    "http://codex:8317/internal/v1/messages?beta=true",
  );
});
