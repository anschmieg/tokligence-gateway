import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createObservedUsageStore,
  extractUsage,
} from "../usage-observer.mjs";

test("extractUsage normalizes OpenAI and Anthropic usage fields", () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cache_read_input_tokens: 6, cache_creation_input_tokens: 2, cost: 0.01 } }), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 6,
    cacheCreationInputTokens: 2,
    cost: 0.01,
  });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 1 } }), {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    cacheReadInputTokens: 6,
    cacheCreationInputTokens: 1,
    cost: null,
  });
});

test("extractUsage counts billed tokens from Anthropic compaction iterations", () => {
  assert.deepEqual(extractUsage({ usage: {
    input_tokens: 0,
    output_tokens: 0,
    iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }],
  } }), {
    inputTokens: 144,
    outputTokens: 276,
    totalTokens: 420,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cost: null,
  });
});

test("extractUsage includes separately billed compaction iterations in total tokens", () => {
  assert.deepEqual(extractUsage({ usage: {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    iterations: [{ input_tokens: 2, output_tokens: 3 }],
  } }), {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cost: null,
  });
});

test("observed usage store aggregates by provider and model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-usage-"));
  const file = path.join(dir, "usage.json");
  const store = createObservedUsageStore({ file, now: () => new Date("2026-09-02T12:00:00Z") });

  store.recordUsage("cline-oauth", "cline/free", { usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, cost: 0.02 } });
  store.recordUsage("cline-oauth", "cline/free", { usage: { input_tokens: 1, output_tokens: 2 } });
  store.recordEvent("cline-oauth", "cline/free", "cline_daily_free_quota_exhausted");

  assert.deepEqual(store.snapshotByProvider()["cline-oauth"], {
    requests: 2,
    input_tokens: 11,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    output_tokens: 7,
    total_tokens: 18,
    cost: 0.02,
    errors: { cline_daily_free_quota_exhausted: 1 },
    models: {
      "cline/free": {
        requests: 2,
        input_tokens: 11,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        output_tokens: 7,
        total_tokens: 18,
        cost: 0.02,
        errors: { cline_daily_free_quota_exhausted: 1 },
        last_seen_at: "2026-09-02T12:00:00.000Z",
      },
    },
    last_seen_at: "2026-09-02T12:00:00.000Z",
  });

  const reloaded = createObservedUsageStore({ file, now: () => new Date("2026-09-02T12:01:00Z") });
  assert.equal(reloaded.snapshotByProvider()["cline-oauth"].requests, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
