import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const source = process.env.OPENCODE_NATIVE_SOURCE;
const bun = process.env.OPENCODE_NATIVE_BUN;
test('pinned OpenCode runtime: exact prompts, native sessions, external tools and safe failures', { skip: !source || !bun, timeout: 60000 }, async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'native-worker-test-'));
  const captures = [];
  let mode = 'text';
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    captures.push({ headers: req.headers, body: JSON.parse(raw) });
    if (mode === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'PRIVATE_UPSTREAM_BODY' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = mode === 'tools' ? { reasoning_content: 'native reasoning to replay', tool_calls: [
      { index: 0, id: 'call_one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one"}' } },
      { index: 1, id: 'call_two', type: 'function', function: { name: 'read_file', arguments: '{"path":"two"}' } },
    ] } : { content: 'native response '.repeat(1000) };
    res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (mode !== 'truncated') res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: mode === 'tools' ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const fixture = path.join(state, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ providers: { fixture: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic' }, models: { 'test-model': { limit: { context: 64000, output: 16000 } } } } } }));
  const key = 'synthetic-private-worker-key-0000000000';
  const worker = spawn(bun, ['run', path.join(source, 'packages/sdk/src/tokligence-bridge.ts')], { env: { ...process.env, OPENCODE_NATIVE_STATE: state, OPENCODE_NATIVE_PORT: '0', OPENCODE_NATIVE_KEY: key, OPENCODE_NATIVE_MODELS: 'test-model', OPENCODE_NATIVE_FIXTURE_CONFIG: fixture, ...Object.fromEntries(['DATA', 'CONFIG', 'CACHE', 'STATE'].map(name => [`XDG_${name}_HOME`, path.join(state, name.toLowerCase())])) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  worker.stderr.on('data', value => { logs += value; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${logs}`)), 25000);
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${logs}`)); });
      let output = '';
      worker.stdout.on('data', value => { output += value; for (const line of output.split('\n')) { try { const event = JSON.parse(line); if (event.event === 'native_worker_ready') { clearTimeout(timer); resolve(event.port); } } catch {} } });
    });
    const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
    const messages = [{ role: 'system', content: 'EXACT_CALLER_SYSTEM' }, { role: 'user', content: 'Long input '.repeat(5000) }];
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Caller-owned tool', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
    const call = (extra = {}, auth = key) => fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'x-opencode-bridge-session': 'same-caller-session' }, body: JSON.stringify({ model: 'test-model', messages, tools, ...extra }) });
    assert.equal((await call({}, 'wrong')).status, 401);
    let response = await call();
    assert.equal(response.status, 200, await response.clone().text());
    const session = response.headers.get('x-opencode-native-session');
    assert.match(session, /^ses_/);
    assert.equal((await response.json()).choices[0].message.content, 'native response '.repeat(1000));
    assert.equal(captures[0].headers['user-agent'], 'opencode/latest/2.1.4/cli');
    assert.deepEqual(captures[0].body.messages, messages);
    assert.equal(captures[0].body.tools[0].function.name, 'read_file');
    mode = 'tools'; response = await call();
    const assistant = (await response.json()).choices[0].message;
    assert.equal(assistant.reasoning_content, 'native reasoning to replay');
    assert.deepEqual(assistant.tool_calls.map(call => call.id), ['call_one', 'call_two']);
    assert.equal(response.headers.get('x-opencode-native-session'), session);
    mode = 'text';
    response = await call({ stream: true, messages: [...messages, assistant, { role: 'tool', tool_call_id: 'call_one', content: 'first result' }, { role: 'tool', tool_call_id: 'call_two', content: 'second result' }] });
    const stream = await response.text();
    assert.match(stream, /native response/); assert.match(stream, /data: \[DONE\]/);
    assert.equal(captures.at(-1).body.messages.at(-1).content, 'second result');
    assert.equal(captures.at(-1).body.messages.find(message => message.role === 'assistant').reasoning_content, 'native reasoning to replay');
    mode = 'quota'; response = await call();
    assert.equal(response.status, 429, await response.clone().text());
    assert.doesNotMatch(await response.text(), /PRIVATE_UPSTREAM_BODY/);
    mode = 'truncated'; response = await call({ stream: true });
    const truncated = await response.text();
    assert.match(truncated, /native_stream_incomplete|native_stream_invalid|native_/);
    assert.doesNotMatch(truncated, /data: \[DONE\]/);
  } finally {
    worker.kill('SIGTERM');
    await new Promise(resolve => { if (worker.exitCode !== null) resolve(); else { worker.once('exit', resolve); setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(state, { recursive: true, force: true });
  }
});
