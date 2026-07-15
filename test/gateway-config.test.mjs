import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_REASONING_LEVELS,
  codexUpstreamUrl,
  isCodexModel,
  isReservedCodexModel,
} from "../gateway-config.mjs";

const config = {
  enabled: true,
  baseUrl: new URL("http://codex:8317/internal"),
  modelSet: new Set(["gpt-5.6-sol"]),
};

test("Codex routing remains exact and fail-closed", () => {
  assert.equal(isCodexModel(config, "GPT-5.6-SOL"), true);
  assert.equal(isCodexModel(config, "gpt-5.6-unknown"), false);
  assert.equal(isReservedCodexModel("gpt-5.6-unknown"), true);
  assert.equal(isReservedCodexModel("gpt-5.5"), false);
  assert.deepEqual(CODEX_REASONING_LEVELS, [
    "none", "low", "medium", "high", "xhigh", "max",
  ]);
});

test("upstream URLs retain query strings and normalize Anthropic prefixes", () => {
  assert.equal(
    codexUpstreamUrl(config, "/anthropic/v1/messages?beta=true").href,
    "http://codex:8317/internal/v1/messages?beta=true",
  );
});
