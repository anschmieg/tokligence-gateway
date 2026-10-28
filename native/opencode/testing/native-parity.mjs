import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, readlink, readFile } from 'node:fs/promises';
import { diffRequestJSON } from '/request-diff.mjs';
assert.equal(process.env.OPENCODE_PARITY_FIXTURE, '1', 'launch only through the isolated parity supervisor');
assert.notEqual(await readlink('/proc/self/ns/net'), process.env.OPENCODE_PARITY_PARENT_NS, 'network namespace must differ from parent');
const blocked = await new Promise(resolve => {
  const socket = net.connect({ host: '1.1.1.1', port: 443 });
  socket.setTimeout(200); socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true)); socket.once('timeout', () => { socket.destroy(); resolve(true); });
});
assert.equal(blocked, true, 'external networking must be blocked');
const captures = [];
const captureHeaders = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  captures.push(JSON.parse(raw));
  captureHeaders.push(Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["authorization", "cookie"].includes(name))));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const models = ['beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free'];
const config = { providers: { fixture: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'public' },
  models: Object.fromEntries(models.map(model => [model, { compatibility: { reasoningField: 'reasoning_content' }, cost: { input: 0, output: 0 }, limit: { context: 200000, output: 1024 } }])) } } };
await writeFile('/work/fixture.json', JSON.stringify(config));
const env = { PATH: '/usr/bin:/bin', HOME: '/work', OPENCODE_NATIVE_STATE: '/work/state', OPENCODE_NATIVE_FIXTURE_CONFIG: '/work/fixture.json', OPENCODE_NATIVE_MODELS: models.join(','), OPENCODE_NATIVE_KEY: 'synthetic-parity-key-000000000000000000', OPENCODE_NATIVE_PORT: '0' };
for (const key of ['DATA', 'CONFIG', 'CACHE', 'STATE']) env[`XDG_${key}_HOME`] = `/work/state/${key}`;
const worker = spawn('/native-bun', ['run', '/native/packages/sdk/src/tokligence-bridge.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const workerExit = once(worker, 'exit');
let stderr = ''; worker.stderr.on('data', value => { stderr += value; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker startup timed out: ' + stderr)), 25000);
    worker.once('exit', code => { clearTimeout(timer); reject(new Error('Worker exited ' + code + ': ' + stderr)); });
    let out = ''; worker.stdout.on('data', value => {
      out += value; for (const line of out.split('\n')) {
        try { const e = JSON.parse(line); if (e.event === 'native_worker_ready') { clearTimeout(timer); resolve(e.port); } } catch {}
      }
    });
  });
  const differences = [];
  const tools = [{ type: 'function', function: { name: 'Read', description: 'Synthetic read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const call = { id: 'call_parity', type: 'function', function: { name: 'Read', arguments: '{"path":"fixture"}' } };
  const vectors = [
    { name: 'text-options', messages: [{ role: 'system', content: 'Exact synthetic system' }, { role: 'user', content: 'hello 🌍\n'.repeat(1000) }], temperature: 0.4, top_p: 0.8, stop: ['END'] },
    { name: 'reasoning-replay', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer', reasoning_content: 'original synthetic reasoning' }, { role: 'user', content: 'continue' }] },
    { name: 'empty-reasoning', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer', reasoning_content: '' }, { role: 'user', content: 'continue' }] },
    { name: 'absent-reasoning', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' }] },
    { name: 'reasoning-effort', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hello' }] },
    { name: 'tool-error', tools, messages: [{ role: 'user', content: 'read' }, { role: 'assistant', content: null, reasoning_content: 'use tool', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'Not found', is_error: true }] },
    { name: 'parallel-history', tools, messages: [{ role: 'user', content: 'read both' }, { role: 'assistant', content: null, reasoning_content: '', tool_calls: [call, { ...call, id: 'call_other' }] }, { role: 'tool', tool_call_id: 'call_other', content: 'second' }, { role: 'tool', tool_call_id: call.id, content: 'first' }] },
    { name: 'named-tool', tools, tool_choice: { type: 'function', function: { name: 'Read' } }, messages: [{ role: 'user', content: 'read' }] },
    { name: 'system-sequence', messages: [{ role: 'system', content: 'first ' }, { role: 'system', content: ' second' }, { role: 'user', content: 'hello' }] },
    { name: 'inline-system', messages: [{ role: 'user', content: 'hello' }, { role: 'system', content: 'inline instructions' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' }] },
    { name: 'multipart-user', messages: [{ role: 'user', content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] }] },
    { name: 'multipart-assistant', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] }, { role: 'user', content: 'continue' }] },
    { name: 'blank-assistant', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '' }, { role: 'user', content: 'continue' }] },
    { name: 'null-assistant', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: null }, { role: 'user', content: 'continue' }] },
    { name: 'whitespace-assistant', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: ' \n ' }, { role: 'user', content: 'continue' }] },
    { name: 'unnamed-description', tools: tools.map(t => ({ type: t.type, function: { name: t.function.name, parameters: t.function.parameters } })), messages: [{ role: 'user', content: 'read' }] },
    { name: 'tools-disabled-history', messages: [{ role: 'user', content: 'read' }, { role: 'assistant', content: null, reasoning_content: 'use tool', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'result' }] },
    { name: 'required-tool', tools, tool_choice: 'required', messages: [{ role: 'user', content: 'read' }] },
    { name: 'no-tool-choice', tools, tool_choice: 'none', messages: [{ role: 'user', content: 'hello' }] },
    { name: 'unicode-surrogates', messages: [{ role: 'system', content: 'system\ud800' }, { role: 'user', content: 'hello\udfff 🌍' }, { role: 'assistant', content: 'answer\ud800', reasoning_content: 'thought\udfff' }, { role: 'user', content: 'continue' }] },
  ];
  for (const model of models) for (const { name, ...vector } of vectors) {
    const body = { model, max_tokens: 1024, ...vector };
    const reference = JSON.parse(execFileSync('/reference-bun', ['run', '/reference-runner.ts'], { input: JSON.stringify(body), env: { PATH: '/usr/bin:/bin', HOME: '/work' }, encoding: 'utf8', timeout: 10000 }));
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${env.OPENCODE_NATIVE_KEY}`, 'x-opencode-bridge-session': 'parity-' + model + '-' + name, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); await response.text();
    const native = captures.at(-1);
    const diff = diffRequestJSON(reference, native);
    differences.push({ model, vector: name, differences: diff });
  }
  const officialCases = [];
  let officialSessionStable = false;
  let officialRequests;
  try { officialRequests = JSON.parse(await readFile('/official-requests.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (officialRequests) {
    const sessionIDs = [];
    for (const [index, official] of officialRequests.entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${env.OPENCODE_NATIVE_KEY}`, 'x-opencode-bridge-session': 'official-persisted-conversation', 'content-type': 'application/json' }, body: JSON.stringify(official.body) });
      assert.equal(response.status, 200, await response.clone().text()); await response.text();
      sessionIDs.push(response.headers.get('x-opencode-native-session'));
      const nativeHeaders = captureHeaders.at(-1);
      assert.equal(nativeHeaders['x-opencode-client'], official.headers['x-opencode-client']);
      assert.equal(nativeHeaders['content-type'], official.headers['content-type']);
      assert.deepEqual(Object.keys(official.headers).filter(name => !(name in nativeHeaders)).sort(), ['x-opencode-request']);
      assert.deepEqual(Object.keys(nativeHeaders).filter(name => !(name in official.headers)).sort(), ['b3', 'traceparent', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']);

      officialCases.push({ turn: index, differences: diffRequestJSON(official.body, captures.at(-1)), official_header_names: Object.keys(official.headers).sort(), native_header_names: Object.keys(captureHeaders.at(-1)).sort() });
    }
    officialSessionStable = Boolean(sessionIDs[0]) && new Set(sessionIDs).size === 1;
  }
  await writeFile('/work/parity.json', JSON.stringify({ external_network_blocked: blocked, scope: 'reference1.18 provider transform and SDK compiler versus native2.1 bridge compiler; not full CLI/TLS/auth parity', cases: differences, official_cases: officialCases, official_session_stable: officialSessionStable }, null, 2));
  console.log(JSON.stringify({ cases: differences.length, differences: differences.filter(item => item.differences.length).map(item => ({ model: item.model, vector: item.vector, paths: item.differences.map(diff => diff.path) })) }));
} finally {
  worker.kill('SIGTERM'); await workerExit;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
