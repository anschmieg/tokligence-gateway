import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuotaCache } from '../quota-cache.mjs';

test('quota cache coalesces concurrent loads and serves fresh values until TTL', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time });
  const loader = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { available: true, detail: { quota_signals: [{ percentUsed: 23, status: 'fresh' }] } }; };
  const [a, b] = await Promise.all([cache.get('mistral', loader), cache.get('mistral', loader)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  await cache.get('mistral', loader); assert.equal(calls, 1);
  time = 300001; await cache.get('mistral', loader); assert.equal(calls, 2);
});

test('quota cache backs off failures, labels stale data and removes metrics past stale TTL', async () => {
  let time = 0, fail = false, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100, staleMs: 300 });
  const loader = async () => { calls++; if (fail) throw new Error('private failure'); return { available: true, percentUsed: 30, detail: { quota_signals: [{ percentUsed: 30, remaining: 70, status: 'fresh' }] } }; };
  await cache.get('codex-oauth', loader); time = 101; fail = true;
  const stale = await cache.get('codex-oauth', loader);
  assert.equal(stale.status, 'stale'); assert.equal(stale.detail.quota_signals[0].status, 'stale');
  assert.equal(JSON.stringify(stale).includes('private failure'), false);
  await cache.get('codex-oauth', loader); assert.equal(calls, 2);
  time = 301;
  const expired = await cache.get('codex-oauth', loader);
  assert.equal(expired.status, 'unavailable'); assert.equal(expired.percentUsed, null);
  assert.equal(expired.detail.quota_signals[0].percentUsed, null);
});

test('quota cache limits entries to supported provider IDs and invalidates explicitly', async () => {
  const cache = createQuotaCache({ now: () => 0 });
  await assert.rejects(cache.get('../x', async () => ({})));
  let calls = 0; const loader = async () => ({ call: ++calls });
  await cache.get('mistral', loader); cache.invalidate('mistral'); await cache.get('mistral', loader);
  assert.equal(calls, 2);
});

test('quota windows are refreshed instead of carried across their reset boundary', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time });
  const loader = async () => ({ provider: 'mistral', detail: { quota_signals: [{ percentUsed: ++calls, remaining: 100 - calls, status: 'fresh', resetAt: new Date(1000).toISOString() }] } });
  await cache.get('mistral', loader);
  time = 1000;
  const refreshed = await cache.get('mistral', loader);
  assert.equal(calls, 2);
  assert.equal(refreshed.detail.quota_signals[0].status, 'unavailable');
  assert.equal(refreshed.detail.quota_signals[0].percentUsed, null);
  await cache.get('mistral', loader);
  assert.equal(calls, 2);
});

test('rejected-session invalidation clears quota immediately but preserves retry backoff', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time, failureBackoffMs: 300000 });
  const loader = async () => ({ available: true, percentUsed: ++calls });
  await cache.get('mistral', loader);
  cache.invalidate('mistral', { backoff: true });
  const rejected = await cache.get('mistral', loader);
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.percentUsed, null);
  assert.equal(calls, 1);
  time = 300001;
  await cache.get('mistral', loader);
  assert.equal(calls, 2);
});

test('resolved unavailable probes preserve stale successful metrics during backoff', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100, staleMs: 300, failureBackoffMs: 100 });
  const success = async () => ({ provider: 'mistral', available: true, detail: { quota_signals: [{ status: 'fresh', percentUsed: 35, remaining: 65, observedAt: 'original' }] } });
  await cache.get('mistral', success);
  time = 101;
  const transient = async () => {
    calls++;
    return { provider: 'mistral', available: false, detail: { quota_signals: [{ status: 'unavailable', percentUsed: null, note: 'Mistral quota endpoint unavailable' }] } };
  };
  const stale = await cache.get('mistral', transient);
  assert.equal(stale.detail.quota_signals[0].status, 'stale');
  assert.equal(stale.detail.quota_signals[0].percentUsed, 35);
  assert.equal(stale.detail.quota_signals[0].observedAt, 'original');
  const backedOff = await cache.get('mistral', transient);
  assert.equal(calls, 1);
  assert.equal(backedOff.detail.quota_signals[0].status, 'stale');
});

test('probe success with an already elapsed reset never returns old metrics as fresh', async () => {
  let time = 10000;
  const cache = createQuotaCache({ now: () => time });
  const value = await cache.get('mistral', async () => ({ provider: 'mistral', detail: { quota_signals: [{ status: 'fresh', percentUsed: 80, remaining: 20, resetAt: new Date(9000).toISOString() }] } }));
  assert.equal(value.detail.quota_signals[0].status, 'unavailable');
  assert.equal(value.detail.quota_signals[0].percentUsed, null);
  assert.equal(value.detail.quota_signals[0].resetAt, null);
  time += 1;
  await cache.get('mistral', async () => { throw new Error('should use TTL for no-reset observation'); });
});

test('an unconfigured subscription observer does not invalidate independent Mistral Admin metrics', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100 });
  const adminOnly = async () => {
    calls++;
    return { provider: 'mistral', available: true, used: 12, limit: 50, detail: { quota_signals: [{ status: 'unconfigured', percentUsed: null, note: 'No private Mistral session file configured' }] } };
  };
  await cache.get('mistral', adminOnly);
  await cache.get('mistral', adminOnly);
  assert.equal(calls, 1);
  time = 101;
  await cache.get('mistral', adminOnly);
  assert.equal(calls, 2);
});

test('rejected subscription session clears only that signal and keeps fresh Admin billing', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100 });
  const value = (note, percentUsed) => ({ provider: 'mistral', available: true, used: 12, limit: 50, detail: { quota_signals: [{ status: percentUsed == null ? 'unavailable' : 'fresh', percentUsed, note }] } });
  await cache.get('mistral', async () => value('Mistral console endpoint is unofficial and may change', 30));
  time = 101;
  const result = await cache.get('mistral', async () => { calls++; return value('Mistral session expired or rejected', null); });
  assert.equal(result.available, true);
  assert.equal(result.used, 12);
  assert.equal(result.detail.quota_signals[0].percentUsed, null);
  assert.equal(result.detail.quota_signals[0].note, 'Mistral session expired or rejected');
  await cache.get('mistral', async () => { calls++; return value('unexpected', 90); });
  assert.equal(calls, 1);
});

test('successful Admin reads remain available during subscription outages with and without an earlier cache', async () => {
  let time = 0, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100, failureBackoffMs: 100 });
  const adminWithSubscriptionOutage = async (used, observedAt) => {
    calls++;
    return { provider: 'mistral', available: true, used, limit: 50, detail: { quota_signals: [{ status: 'unavailable', percentUsed: null, note: 'Mistral quota endpoint unavailable' }] } };
  };
  const first = await cache.get('mistral', () => adminWithSubscriptionOutage(12));
  assert.equal(first.used, 12);
  assert.equal((await cache.get('mistral', () => adminWithSubscriptionOutage(99))).used, 12);
  assert.equal(calls, 1);

  time = 101;
  const refreshed = await cache.get('mistral', () => adminWithSubscriptionOutage(15));
  assert.equal(refreshed.used, 15);
  time = 102;
  const backedOff = await cache.get('mistral', () => adminWithSubscriptionOutage(99));
  assert.equal(backedOff.used, 15);
  assert.equal(calls, 2);
});

test('Admin refresh during a subscription outage never carries a quota sample past its reset', async () => {
  let time = 900;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100 });
  await cache.get('mistral', async () => ({ provider: 'mistral', available: true, used: 10, limit: 50, detail: { quota_signals: [{ status: 'fresh', percentUsed: 80, remaining: 20, observedAt: new Date(900).toISOString(), resetAt: new Date(1000).toISOString() }] } }));
  time = 1001;
  const refreshed = await cache.get('mistral', async () => ({ provider: 'mistral', available: true, used: 11, limit: 50, detail: { quota_signals: [{ status: 'unavailable', percentUsed: null, note: 'Mistral quota endpoint unavailable' }] } }));
  assert.equal(refreshed.used, 11);
  assert.equal(refreshed.detail.quota_signals[0].percentUsed, null);
  assert.equal(refreshed.detail.quota_signals[0].status, 'unavailable');
});

test('Mistral cached reads during backoff clear subscription samples at reset', async () => {
  let time = 800, calls = 0;
  const cache = createQuotaCache({ now: () => time, ttlMs: 100, failureBackoffMs: 300000 });
  await cache.get('mistral', async () => ({ provider: 'mistral', available: true, used: 10, limit: 50, detail: { quota_signals: [{ status: 'fresh', percentUsed: 80, remaining: 20, observedAt: new Date(800).toISOString(), resetAt: new Date(1000).toISOString() }] } }));
  time = 901;
  await cache.get('mistral', async () => {
    calls++;
    return { provider: 'mistral', available: true, used: 11, limit: 50, detail: { quota_signals: [{ status: 'unavailable', percentUsed: null, note: 'Mistral quota endpoint unavailable' }] } };
  });
  time = 1000;
  const atReset = await cache.get('mistral', async () => { calls++; throw new Error('backoff should prevent a probe'); });
  assert.equal(calls, 1);
  assert.equal(atReset.available, true);
  assert.equal(atReset.used, 11);
  assert.equal(atReset.detail.quota_signals[0].status, 'unavailable');
  assert.equal(atReset.detail.quota_signals[0].percentUsed, null);
});
