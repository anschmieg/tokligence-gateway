import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { probeCodexOauth } from '../quota.mjs';
import { compileOAuthProxyYaml, loadRoutingConfig } from '../route-config.mjs';

test('management config uses separate key and keeps listener private', () => {
  const config = loadRoutingConfig('gateway.routes.yaml');
  const yaml = compileOAuthProxyYaml(config, { CODEX_MANAGEMENT_KEY: 'fixture-management', CODEX_PROXY_API_KEY: 'fixture-inference' });
  assert.match(yaml, /host: 127\.0\.0\.1/);
  assert.match(yaml, /allow-remote: false/);
  assert.match(yaml, /disable-control-panel: true/);
  assert.match(yaml, /secret-key: fixture-management/);
});

test('Codex management reads fixed usage endpoint and returns only quota windows', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-management-key');
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('auth-files')) {
      res.end(JSON.stringify({ files: [{ type: 'codex', auth_index: 'secret-index', email: 'private@example.test' }, { type: 'codex', auth_index: 'disabled', disabled: true }] }));
    } else {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      assert.equal(body.url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(body.header.Authorization, 'Bearer $TOKEN$');
      assert.equal(body.method, 'GET');
      res.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ email: 'private@example.test', rate_limit: { primary_window: { used_percent: 25, reset_at: 1800000000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 9 } } }) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCodexOauth({}, { codexManagementKey: 'private-management-key', codexManagementBaseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.available, true);
    assert.equal(result.detail.accounts[0].windows[0].used_percent, 25);
    assert.equal(result.detail.accounts[0].label, 'Codex account 1');
    assert.equal(result.percentUsed, null);
    assert.equal(seen.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /secret-index|private@example|private-management-key/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Codex quota caps probes at 32 and exposes counts but never credential identities', async () => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('auth-files')) {
      res.end(JSON.stringify({ files: Array.from({ length: 35 }, (_, i) => ({ type: 'codex', auth_index: `secret-${i}`, disabled: i === 0 })) }));
    } else {
      calls++;
      for await (const _ of req) {}
      res.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCodexOauth({}, { codexManagementKey: 'fixture', codexManagementBaseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(calls, 32);
    assert.equal(result.detail.totalAccounts, 34);
    assert.equal(result.detail.truncated, true);
    assert.equal(result.detail.accounts[0].label, 'Codex account 1');
    assert.doesNotMatch(JSON.stringify(result), /secret-/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Codex refuses sending management authority to a non-loopback host', async () => {
  const result = await probeCodexOauth({}, { codexManagementKey: 'private', codexManagementBaseUrl: 'https://example.com' });
  assert.equal(result.available, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|example.com/);
});

test('Codex quota marks partial account failures without exposing auth indices', async () => {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('auth-files')) {
      res.end(JSON.stringify({ files: [{ type: 'codex', auth_index: 'private-good' }, { type: 'codex', auth_index: 'private-bad' }] }));
      return;
    }
    let text = ''; for await (const chunk of req) text += chunk;
    if (JSON.parse(text).auth_index === 'private-bad') res.end(JSON.stringify({ status_code: 403, body: 'private upstream response' }));
    else res.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 15 } } }) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCodexOauth({}, { codexManagementKey: 'fixture', codexManagementBaseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.detail.incomplete, true);
    assert.equal(result.detail.accounts[0].available, true);
    assert.equal(result.detail.accounts[1].available, false);
    assert.doesNotMatch(JSON.stringify(result), /private-good|private-bad|private upstream response/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
