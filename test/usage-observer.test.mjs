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
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.01 } }), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cost: 0.01,
  });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 3, output_tokens: 2 } }), {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    cost: null,
  });
});

test("observed usage store aggregates by provider and model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-usage-"));
  const file = path.join(dir, "usage.json");
  const store = createObservedUsageStore({ file, now: () => new Date("2026-09-02T12:00:00Z") });

  store.recordUsage("cline-oauth", "cline/free", { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.02 } });
  store.recordUsage("cline-oauth", "cline/free", { usage: { input_tokens: 1, output_tokens: 2 } });
  store.recordEvent("cline-oauth", "cline/free", "cline_daily_free_quota_exhausted");

  assert.deepEqual(store.snapshotByProvider()["cline-oauth"], {
    requests: 2,
    input_tokens: 11,
    output_tokens: 7,
    total_tokens: 18,
    cost: 0.02,
    errors: { cline_daily_free_quota_exhausted: 1 },
    models: {
      "cline/free": {
        requests: 2,
        input_tokens: 11,
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
