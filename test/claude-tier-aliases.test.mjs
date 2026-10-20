import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  matchConfiguredProvider,
  parseRoutingConfig,
  resolveConfiguredAlias,
} from "../route-config.mjs";

const config = parseRoutingConfig(fs.readFileSync("gateway.routes.yaml", "utf8"));

test("Claude Code tier names resolve to gateway models", () => {
  // The gateway has no Anthropic upstream, so an Anthropic model name has to
  // land on a gateway model. The mapping mirrors the tier defaults the
  // clients set for opus/sonnet/haiku/fable.
  assert.equal(resolveConfiguredAlias(config, "claude-opus-5-5"), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-opus-4-6"), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-sonnet-5"), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "claude-sonnet-4-6"), "gpt-5.6-terra");
  assert.equal(resolveConfiguredAlias(config, "claude-haiku-4-5"), "gpt-5.6-luna");
  assert.equal(resolveConfiguredAlias(config, "claude-haiku-5-5"), "gpt-5.6-luna");
  assert.equal(resolveConfiguredAlias(config, "claude-fable-5-1"), "gpt-5.6-sol");
  assert.equal(resolveConfiguredAlias(config, "claude-fable-5"), "gpt-5.6-sol");
});

test("non-tier Anthropic names keep the Anthropic lane", () => {
  // Only the tier families are mapped. Every other Anthropic name still
  // reaches the configured Anthropic route, so funding that lane stays
  // meaningful.
  assert.equal(resolveConfiguredAlias(config, "claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
  assert.equal(matchConfiguredProvider(config, "claude-3-5-sonnet-20241022"), "tokligence");
  assert.equal(matchConfiguredProvider(config, "claude-opus-4-1"), "tokligence");
});

test("gateway model names are not rewritten by the Claude tier aliases", () => {
  for (const model of ["gpt-5.6-sol", "gpt-6-luna", "mistral/mistral-small-latest", "beam-free"]) {
    assert.equal(resolveConfiguredAlias(config, model), model);
  }
});
