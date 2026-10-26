import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;

test('native worker excludes concurrent owners, survives SIGKILL and removes evicted native sessions', { skip: !source || !bun, timeout: 60000 }, async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'native-lifecycle-'));
  const provider = http.createServer(async (req, res) => {
    for await (const part of req) { /* Drain fixture input. */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(state, 'fixture.json'), JSON.stringify({ providers: { fixture: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic' }, models: { 'test-model': { limit: { context: 10000, output: 1000 } } } } } }));
  const key = 'private-synthetic-key-for-native-lifecycle';
  const env = { ...process.env, OPENCODE_NATIVE_STATE: state, OPENCODE_NATIVE_PORT: '0', OPENCODE_NATIVE_MODELS: 'test-model', OPENCODE_NATIVE_KEY: key, OPENCODE_NATIVE_SESSION_LIMIT: '2', OPENCODE_NATIVE_FIXTURE_CONFIG: path.join(state, 'fixture.json'), ...Object.fromEntries(['DATA', 'CONFIG', 'CACHE', 'STATE'].map(name => [`XDG_${name}_HOME`, path.join(state, name)])) };
  const children = [];
  const launch = () => {
    const child = spawn(bun, ['run', path.join(source, 'packages/sdk/src/tokligence-bridge.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child;
  };
  const ready = child => new Promise((resolve, reject) => {
    let logs = '', stdout = '';
    const timer = setTimeout(() => reject(new Error('Native lifecycle startup timed out')), 20000);
    child.stderr.on('data', value => { logs += value; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native worker exited ${code}: ${logs}`)); });
    child.stdout.on('data', value => { stdout += value; for (const line of stdout.split('\n')) { try { const event = JSON.parse(line); if (event.event === 'native_worker_ready') { clearTimeout(timer); resolve(event.port); } } catch {} } });
  });
  try {
    await writeFile(path.join(state, 'worker.lock'), '1');
    const starters = Array.from({ length: 4 }, launch);
    const outcomes = await Promise.allSettled(starters.map(ready));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.ok(outcomes.filter(item => item.status === 'rejected').every(item => /live worker owner/.test(item.reason.message)));
    const winner = outcomes.findIndex(item => item.status === 'fulfilled');
    let owner = starters[winner]; let port = outcomes[winner].value;
    await Promise.all(Array.from({ length: 4 }, async () => {
      const duplicate = launch(); let stderr = ''; duplicate.stderr.on('data', value => { stderr += value; });
      const [code] = await once(duplicate, 'exit');
      assert.equal(code, 1); assert.match(stderr, /live worker owner/);
    }));
    const call = async scope => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-opencode-bridge-session': scope }, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers.get('x-opencode-native-session');
    };
    const a = await call('a'), b = await call('b');
    assert.equal(await call('a'), a);
    await call('c');
    assert.notEqual(await call('b'), b, 'LRU eviction creates a new real native session');
    const savedPath = path.join(state, 'bridge-sessions.json');
    const saved = JSON.parse(await readFile(savedPath));
    assert.equal(Object.keys(saved).length, 2);
    assert.ok(!Object.values(saved).some(entry => entry.id === a || entry.id === b));
    owner.kill('SIGKILL'); await once(owner, 'exit');
    // Exercise expiry of real persisted sessions, not just a mocked callback.
    for (const entry of Object.values(saved)) entry.lastUsed = 0;
    await writeFile(savedPath, JSON.stringify(saved));
    owner = launch(); port = await ready(owner);
    await call('after-crash');
    assert.equal(Object.keys(JSON.parse(await readFile(savedPath))).length, 1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(state, { recursive: true, force: true });
  }
});
