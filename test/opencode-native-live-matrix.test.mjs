import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

test('live matrix distinguishes actual reasoning replay, absent reasoning and failed continuations', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-live-matrix-'));
  let failContinuation = false, truncateContinuation = false, reasoningReplayed = 0;
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    let message, finish = 'stop';
    if (body.tool_choice === 'required') {
      message = { role: 'assistant', content: null, tool_calls: ['alpha', 'beta'].map(key => ({ type: 'function', id: key, function: { name: 'fixture_lookup', arguments: JSON.stringify({ key }) } })) };
      if (body.model.endsWith('/beam-free')) message.reasoning_content = 'fixture reasoning';
      finish = 'tool_calls';
    } else if (body.tool_choice === 'none') {
      if (body.messages.some(message => message.reasoning_content === 'fixture reasoning')) reasoningReplayed++;
      message = { role: 'assistant', content: failContinuation ? 'wrong' : '42' };
      if (truncateContinuation) finish = 'length';
    } else message = { role: 'assistant', content: body.messages[0].content.includes('token_2999') ? '8997 ' + 'long output '.repeat(600) + ' LONG_DONE' : 'STAGING_OK' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(root, 'runtime'));
    await writeFile(path.join(root, 'gateway-env.json'), JSON.stringify({ TOKLIGENCE_AUTH_SECRET: 'synthetic' }));
    await writeFile(path.join(root, 'runtime/claude'), '#!/usr/bin/python3\nimport json\nprint(json.dumps({"result":"CLAUDE_TOOL_OK " + "fixture " * 700 + " CLAUDE_LONG_DONE", "num_turns":2}))\n', { mode: 0o700 });
    const run = async () => {
      const child = spawn('python3', ['native/opencode/live-tests.py', '--root', root, '--url', `http://127.0.0.1:${provider.address().port}`, '--not-before', '1970-01-01T00:00:00+00:00'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', value => { errors += value; });
      const [code] = await once(child, 'exit');
      const report = JSON.parse(await readFile(path.join(root, 'live-matrix-results.json')));
      return { code, report, errors };
    };
    let result = await run();
    assert.equal(result.code, 2, result.errors);
    assert.equal(result.report.coverage_incomplete, true);
    const reasoning = result.report.results.filter(item => item.test === 'reasoning-replay');
    assert.equal(reasoning.find(item => item.model === 'beam-free').passed, true);
    assert.ok(reasoning.filter(item => item.model !== 'beam-free').every(item => item.passed === null && item.status === 'untested'));
    assert.ok(result.report.results.filter(item => item.test === 'parallel-tools').every(item => item.passed === true));
    assert.equal(reasoningReplayed, 1);
    failContinuation = true; result = await run();
    assert.equal(result.code, 1, result.errors);
    assert.ok(result.report.results.filter(item => item.test === 'reasoning-replay').every(item => item.passed === null));
    assert.ok(result.report.results.filter(item => item.test === 'parallel-tools').every(item => item.passed === false));
    failContinuation = false; truncateContinuation = true; result = await run();
    assert.equal(result.code, 1, result.errors);
    assert.ok(result.report.results.filter(item => item.test === 'reasoning-replay').every(item => item.passed === null));
  } finally {
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
