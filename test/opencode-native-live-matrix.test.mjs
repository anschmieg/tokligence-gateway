import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

test('live matrix distinguishes actual reasoning replay, absent reasoning and failed continuations', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-live-matrix-'));
  let failContinuation = false, truncateContinuation = false, quota = false, reasoningReplayed = 0;
  const order = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    order.push({ model: body.model, tool: body.tool_choice, long: body.messages[0].content.includes("token_2999") });
    if (quota) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'FreeUsageLimitError', retry_at: '2026-10-28T00:00:00Z', upstream_request_id: 'synthetic-quota' } }));
      return;
    }
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
    await writeFile(path.join(root, 'runtime/claude'), `#!/usr/bin/python3
import json, os, sys, urllib.request
model = sys.argv[sys.argv.index('--model') + 1]
for turn in range(2):
 req = urllib.request.Request(os.environ['ANTHROPIC_BASE_URL'] + '/v1/messages', data=json.dumps({'model':model,'max_tokens':32000,'messages':[{'role':'user','content':'synthetic CLI continuation'}]}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['ANTHROPIC_AUTH_TOKEN']})
 with urllib.request.urlopen(req) as response: response.read()
print(json.dumps({"result":"CLAUDE_TOOL_OK " + "fixture " * 700 + " CLAUDE_LONG_DONE", "num_turns":2}))
`, { mode: 0o700 });
    let runNumber = 0;
    const run = async () => {
      const runID = 'synthetic-' + ++runNumber;
      const child = spawn('python3', ['native/opencode/live-tests.py', '--root', root, '--url', `http://127.0.0.1:${provider.address().port}`, '--not-before', '1970-01-01T00:00:00+00:00', '--run-id', runID, '--models', 'beam-free,glm-5.3-flash-free,deepseek-v4.1-flash-free,mimo-v2.6-flash-free', '--phases', 'basic,tools,long,claude', '--request-budget', '40', '--output-budget', '220000'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', value => { errors += value; });
      const [code] = await once(child, 'exit');
      const report = JSON.parse(await readFile(path.join(root, 'live-reports', runID + '.json')));
      return { code, report, errors };
    };
    let result = await run();
    assert.equal(result.code, 2, result.errors);
    assert.equal(new Set(order.slice(0, 4).map(item => item.model)).size, 4);
    assert.ok(order.slice(0, 4).every(item => !item.tool && !item.long));
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
    quota = true;
    const beforeQuota = order.length;
    result = await run();
    assert.equal(result.code, 1, result.errors);
    assert.equal(order.length, beforeQuota + 1, 'no more traffic after first quota response');
    assert.equal(result.report.coverage_incomplete, true);
    const checks = result.report.results.filter(item => item.test);
    assert.equal(checks.length, 20);
    assert.equal(checks.filter(item => item.status === 'blocked').length, 1);
    assert.equal(checks.filter(item => item.status === 'untested').length, 19);
    assert.ok(checks.every(item => item.passed === null));
  } finally {
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
