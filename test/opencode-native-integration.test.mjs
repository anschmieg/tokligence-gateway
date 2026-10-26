import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('gateway exposes the native lane explicitly and translates caller-owned tool turns', { timeout: 15000 }, async () => {
  let status = 200, emptyLength = false;
  const requests = [];
  const worker = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    if (emptyLength) {
      const stream = requests.at(-1).body.stream;
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'x-opencode-native-version': '2.1.4' });
      const choice = { index: 0, finish_reason: 'length', ...(stream ? { delta: {} } : { message: { role: 'assistant', content: null } }) };
      const completion = { id: 'fixture', choices: [choice] };
      res.end(stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'x-opencode-native-version': '2.1.4', 'x-opencode-native-session': 'ses_fixture', ...(status === 429 ? { 'retry-after': '60' } : {}) });
    res.end(JSON.stringify(status === 429 ? { error: { code: 'FreeUsageLimitError', type: 'rate_limit_error', message: 'Native quota exhausted', retry_after_seconds: 60, upstream_request_id: 'fixture-request' } } : { id: 'chatcmpl_fixture', object: 'chat.completion', model: 'beam-free', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'preserve this reasoning', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  const gateway = spawn(process.execPath, ['tgw-proxy.mjs'], { env: { ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: '0', TOKLIGENCE_AUTH_SECRET: 'fixture-public', TOKLIGENCE_ADMIN_SECRET: 'fixture-admin', OPENCODE_NATIVE_ENABLED: 'true', OPENCODE_NATIVE_URL: `http://127.0.0.1:${worker.address().port}/v1`, OPENCODE_NATIVE_KEY: 'fixture-worker-key', CODEX_PROXY_ENABLED: '', CHATGPT_RESPONSES_ENABLED: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', OPENCODE_API_KEY: '', MODAL_GLM5_API_KEY: '', CLINE_ENABLED: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; gateway.stderr.on('data', value => { logs += value; if(process.env.NATIVE_TEST_DEBUG) process.stderr.write(value); });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Gateway startup timeout: ${logs}`)), 6000);
      gateway.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${logs}`)); });
      gateway.stdout.on('data', value => { const match = String(value).match(/tgw-proxy :(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const send = (body) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer sk-ant-fixture-public', 'content-type': 'application/json', 'x-session-id': 'caller-session' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const body = { model: 'opencode-native/beam-free', max_tokens: 1000, system: '  Exact caller system\n', messages: [{ role: 'user', content: 'read the file' }], tools: [{ name: 'read_file', description: 'Owned by caller', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };
    let response = await send(body);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-opencode-native-session'), 'ses_fixture');
    const result = await response.json();
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.content.find(block => block.type === 'tool_use').id, 'call_fixture');
    assert.equal(result.content.find(block => block.type === 'thinking').thinking, 'preserve this reasoning');
    assert.equal(requests[0].body.messages[0].content, body.system);
    assert.equal(requests[0].headers.authorization, 'Bearer fixture-worker-key');
    response = await send({ ...body, messages: [...body.messages, { role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'file contents' }] }] });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(requests.at(-1).body.messages.at(-2).reasoning_content, 'preserve this reasoning');
    assert.equal(requests.at(-1).body.messages.at(-1).tool_call_id, 'call_fixture');
    assert.equal(requests[0].headers['x-opencode-bridge-session'], requests[1].headers['x-opencode-bridge-session']);
    const errorResult = await send({ ...body, messages: [...body.messages, { role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'File not found', is_error: true }] }] });
    assert.equal(errorResult.status, 200, await errorResult.clone().text());
    assert.equal(requests.at(-1).body.messages.at(-1).is_error, true);
    const beforeRejected = requests.length;
    for (const block of [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic' } },
      { type: 'document', source: { type: 'text', data: 'document' } },
      { type: 'redacted_thinking', data: 'opaque' },
    ]) {
      const rejected = await send({ ...body, messages: [...body.messages, { role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: [block] }] }] });
      assert.equal(rejected.status, 400);
      assert.equal(requests.length, beforeRejected, 'unsupported nested data never reaches the worker');
    }
    const invalidSystem = await send({ ...body, system: [{ type: 'document', source: {} }] });
    assert.equal(invalidSystem.status, 400);
    assert.equal(requests.length, beforeRejected);
    status = 429; response = await send(body);
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await response.json()).error.upstream_request_id, 'fixture-request');
    status = 200; emptyLength = true;
    response = await send(body);
    assert.equal(response.status, 200, await response.clone().text());
    const lengthResult = await response.json();
    assert.equal(lengthResult.stop_reason, 'max_tokens');
    assert.deepEqual(lengthResult.content, []);
    response = await send({ ...body, stream: true });
    assert.equal(response.status, 200);
    const lengthStream = await response.text();
    assert.match(lengthStream, /"stop_reason":"max_tokens"/);
    assert.match(lengthStream, /event: message_stop/);
    assert.doesNotMatch(lengthStream, /"type":"tool_use"/);
    const count = requests.length;
    response = await send({ ...body, model: 'opencode-native/unknown' });
    assert.equal(response.status, 400); assert.equal(requests.length, count);
  } finally {
    gateway.kill('SIGTERM');
    await new Promise(resolve => { if (gateway.exitCode !== null) resolve(); else { gateway.once('exit', resolve); setTimeout(() => { gateway.kill('SIGKILL'); resolve(); }, 1500).unref(); } });
    worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve));
  }
});
