import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startAttempt } from '../provider-adapters.mjs';

test('native adapter is opt-in, isolates authorization, preserves session and fails closed on version mismatch', async () => {
  const received = [];
  let version = '2.1.4';
  const worker = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    received.push({ headers: req.headers, path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-opencode-native-version': version });
    res.end('{}');
  });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  try {
    const env = { OPENCODE_NATIVE_ENABLED: 'true', OPENCODE_NATIVE_URL: `http://127.0.0.1:${worker.address().port}/v1`, OPENCODE_NATIVE_KEY: 'private-worker-key' };
    const candidate = { protocol: 'chat_completions', provider: { id: 'opencode-native', adapter: 'opencode-native', base_url_env: 'OPENCODE_NATIVE_URL' } };
    const args = { candidate, req: { headers: { authorization: 'Bearer gateway-client-secret', 'x-api-key': 'never-forward' } }, path: '/v1/chat/completions', body: JSON.stringify({ model: 'opencode-native/beam-free', messages: [{ role: 'user', content: 'hello' }] }), stickyKey: 'scoped-session', env };
    await assert.rejects(startAttempt({ ...args, env: {} }), { code: 'native_bridge_disabled' });
    assert.equal(received.length, 0);
    const result = await startAttempt(args);
    result.response.resume();
    assert.equal(result.nativeBridge, true);
    assert.equal(received[0].headers.authorization, 'Bearer private-worker-key');
    assert.equal(received[0].headers['x-api-key'], undefined);
    assert.equal(received[0].headers['x-opencode-bridge-session'], 'scoped-session');
    assert.equal(received[0].body.model, 'beam-free');
    assert.equal(received[0].path, '/v1/chat/completions');
    const dispatched = received.length;
    for (const type of ['image', 'document', 'redacted_thinking']) {
      const request = { model: 'opencode-native/beam-free', messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: [{ type, source: {}, data: 'synthetic' }] }] },
      ] };
      await assert.rejects(startAttempt({ ...args, candidate: { ...candidate, protocol: 'messages' }, body: JSON.stringify(request) }), error => error.statusCode === 400 && /Native tool result supports plain text/.test(error.message));
      assert.equal(received.length, dispatched);
    }
    const messagesCandidate = { ...candidate, protocol: 'messages' };
    const call = { type: 'tool_use', id: 'empty-result', name: 'Read', input: {} };
    const emptyResult = { type: 'tool_result', tool_use_id: 'empty-result' };
    const history = [{ role: 'assistant', content: [call] }, { role: 'user', content: [emptyResult] }];
    const empty = await startAttempt({ ...args, candidate: messagesCandidate, body: JSON.stringify({ model: 'opencode-native/beam-free', messages: history }) });
    empty.response.resume();
    assert.equal(received.at(-1).body.messages[1].content, '');
    assert.equal(received.at(-1).body.messages[1].tool_call_id, 'empty-result');
    const beforeAmbiguous = received.length;
    for (const block of [call, emptyResult, { type: 'thinking', thinking: 'retain reasoning' }]) {
      const role = block.type === 'tool_result' ? 'user' : 'assistant';
      await assert.rejects(startAttempt({ ...args, candidate: messagesCandidate, body: JSON.stringify({ model: 'opencode-native/beam-free', messages: [{ role, content: [{ ...block, text: 'would swallow the block' }] }] }) }), error => error.statusCode === 400 && /non-text blocks/.test(error.message));
      assert.equal(received.length, beforeAmbiguous);
    }
    for (const disabled of [true, false]) {
      const singleTool = await startAttempt({ ...args, candidate: messagesCandidate, body: JSON.stringify({ model: 'opencode-native/beam-free', messages: [{ role: 'user', content: 'use tools' }], tool_choice: { type: 'any', disable_parallel_tool_use: disabled } }) });
      singleTool.response.resume();
      assert.equal(received.at(-1).body.parallel_tool_calls, !disabled);
      assert.equal(received.at(-1).body.tool_choice, 'required');
    }
    const beforeInvalidChoice = received.length;
    for (const options of [
      { tool_choice: { type: 'any', disable_parallel_tool_use: 'true' } },
      { tool_choice: { type: 'any', disable_parallel_tool_use: true }, parallel_tool_calls: true },
      { tool_choice: { type: 'unknown' } },
      { tool_choice: { type: 'tool' } },
    ]) {
      await assert.rejects(startAttempt({ ...args, candidate: messagesCandidate, body: JSON.stringify({ model: 'opencode-native/beam-free', messages: history, ...options }) }), error => error.statusCode === 400);
      assert.equal(received.length, beforeInvalidChoice);
    }
    version = 'unexpected';
    await assert.rejects(startAttempt(args), { code: 'native_worker_version_mismatch' });
  } finally { worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve)); }
});
