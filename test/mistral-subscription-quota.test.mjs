import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseMistralVibeUsage, probeMistralSubscription } from '../mistral-subscription-quota.mjs';

const payload = value => JSON.stringify([{ result: { data: { json: value } } }]);

test('parses the unofficial monthly subscription usage without exposing response fields', () => {
  const result = parseMistralVibeUsage(payload({ usage_percentage: 42.5, reset_at: '2026-11-01T00:00:00Z', email: 'private@example.test' }), new Date('2026-10-19T10:00:00Z'));
  assert.equal(result.percentUsed, 42.5);
  assert.equal(result.resetAt, '2026-11-01T00:00:00.000Z');
  assert.equal(result.source, 'unofficial-console');
  assert.doesNotMatch(JSON.stringify(result), /private@example|usage_percentage/);
});

test('rejects malformed and out-of-range usage, but permits a missing reset timestamp', () => {
  for (const value of [null, {}, { usage_percentage: '42' }, { usage_percentage: -1 }, { usage_percentage: 101 }, { usage_percentage: null }]) {
    assert.throws(() => parseMistralVibeUsage(payload(value), new Date()));
  }
  const result = parseMistralVibeUsage(payload({ usage_percentage: 0, reset_at: 'not-a-date' }), new Date());
  assert.equal(result.percentUsed, 0);
  assert.equal(result.resetAt, null);
});

test('reads only a private regular credential file and sends fixed-origin auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mistral-quota-'));
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({ csrfToken: 'csrf-fixture', sessionCookies: { ory_session_console: 'session-fixture=' } }), { mode: 0o600 });
  try {
    let captured;
    const result = await probeMistralSubscription({ file, now: () => new Date('2026-10-19T10:00:00Z'), transport: async request => {
      captured = request;
      return { statusCode: 200, body: payload({ usage_percentage: 12, reset_at: null }) };
    } });
    assert.equal(result.percentUsed, 12);
    assert.equal(captured.url.hostname, 'console.mistral.ai');
    assert.equal(captured.headers['X-CSRFToken'], 'csrf-fixture');
    assert.equal(captured.headers.Cookie, 'csrftoken=csrf-fixture; ory_session_console=session-fixture=');
    assert.equal(captured.redirect, 'error');
    assert.doesNotMatch(JSON.stringify(result), /csrf-fixture|session-fixture/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing, unsafe, malformed or server-rejected credentials fail closed without secrets', async () => {
  const missing = await probeMistralSubscription({});
  assert.equal(missing.status, 'unconfigured');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mistral-quota-'));
  const file = path.join(dir, 'session.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ csrfToken: 'bad\ncsrf', sessionCookies: { ory_session_x: 'secret' } }), { mode: 0o600 });
    const result = await probeMistralSubscription({ file });
    assert.equal(result.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /secret|bad/);
    fs.writeFileSync(file, JSON.stringify({ csrfToken: 'csrf', sessionCookies: { ory_session_x: 'secret' } }), { mode: 0o600 });
    const rejected = await probeMistralSubscription({ file, transport: async () => ({ statusCode: 302, body: '' }) });
    assert.equal(rejected.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(rejected), /secret|csrf|302/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects symlinked and broadly readable credential files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mistral-quota-'));
  const real = path.join(dir, 'real.json'), link = path.join(dir, 'link.json'), open = path.join(dir, 'open.json');
  try {
    fs.writeFileSync(real, JSON.stringify({ csrfToken: 'csrf', sessionCookies: { ory_session_x: 'cookie' } }), { mode: 0o600 });
    fs.symlinkSync(real, link);
    fs.writeFileSync(open, JSON.stringify({ csrfToken: 'csrf', sessionCookies: { ory_session_x: 'cookie' } }), { mode: 0o644 });
    assert.equal((await probeMistralSubscription({ file: link })).status, 'unavailable');
    assert.equal((await probeMistralSubscription({ file: open })).status, 'unavailable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
