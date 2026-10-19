import assert from "node:assert/strict";
import test from "node:test";

import { createSessionCacheObserver } from "../cache-observer.mjs";

test("cache observations aggregate by provider/model and request idle bucket without exposing sessions", () => {
  let now = 1_000_000;
  const observer = createSessionCacheObserver({ now: () => now, maxSessions: 10, retentionMs: 60 * 60 * 1000 });
  observer.record("hash-a", "codex-oauth", "gpt-6-sol", { usage: {
    input_tokens: 1100, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1100 },
  } });
  now += 3 * 60 * 1000;
  observer.record("hash-a", "codex-oauth", "gpt-6-sol", { usage: {
    input_tokens: 1100, output_tokens: 8, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
  } });

  const snapshot = observer.snapshot();
  assert.deepEqual(snapshot, [{
    provider: "codex-oauth", model: "gpt-6-sol", idle_bucket: "1-5m",
    samples: 1, input_tokens: 1100, cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0, output_tokens: 8,
  }]);
  assert.equal(JSON.stringify(snapshot).includes("hash-a"), false);
});

test("cache observations expire session correlation and evict oldest sessions at the bound", () => {
  let now = 10_000;
  const observer = createSessionCacheObserver({ now: () => now, maxSessions: 2, retentionMs: 100 });
  const usage = { usage: { input_tokens: 10, output_tokens: 1 } };
  observer.record("session-1", "codex-oauth", "gpt", usage);
  now += 20;
  observer.record("session-2", "codex-oauth", "gpt", usage);
  now += 20;
  observer.record("session-3", "codex-oauth", "gpt", usage);
  now += 101;
  observer.record("session-1", "codex-oauth", "gpt", usage);
  assert.equal(observer.snapshot().length, 0);
  assert.equal(observer.sessionCount, 1);
});


test("OpenAI cache-write tokens are included in cache-creation observations", () => {
  const observer = createSessionCacheObserver({ now: () => 50_000 });
  observer.record("one", "codex-oauth", "gpt", { usage: {
    input_tokens: 1200, output_tokens: 1, input_tokens_details: { cache_write_tokens: 1200 },
  } });
  observer.record("one", "codex-oauth", "gpt", { usage: {
    input_tokens: 1200, output_tokens: 1, input_tokens_details: { cache_write_tokens: 1200 },
  } });
  assert.equal(observer.snapshot()[0].cache_creation_input_tokens, 1200);
});
