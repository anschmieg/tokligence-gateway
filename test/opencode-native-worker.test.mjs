import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse, stringify } from 'yaml';

const source = process.env.OPENCODE_NATIVE_SOURCE;
const bun = process.env.OPENCODE_NATIVE_BUN;
test('pinned OpenCode runtime: exact prompts, native sessions, external tools and safe failures', { skip: !source || !bun, timeout: 90000 }, async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), 'native-worker-test-'));
  const captures = [];
  let mode = 'text';
  let cliFixturePath = '', cliForbiddenPath = '';
  const canaryRoot = await mkdtemp(path.join(tmpdir(), 'native-private-canary-'));
  cliForbiddenPath = path.join(canaryRoot, 'outside.txt');
  await writeFile(cliForbiddenPath, 'SYNTHETIC_SECRET_DO_NOT_FORWARD');
  let cliTurns = 0;
  const closureObservers = new Map();
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    captures.push({ headers: req.headers, body: JSON.parse(raw) });
    if (mode === 'claude') {
      cliTurns++;
      const body = captures.at(-1).body;
      const results = body.messages.filter(message => message.role === 'tool');
      const text = 'CLAUDE_NATIVE_RECOVERY_OK ' + 'Validated native tool continuation. '.repeat(200);
      const delta = results.length < 2 ? { reasoning_content: 'fixture native thought', tool_calls: [{ index: 0, id: `cli_call_${results.length}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: results.length ? cliFixturePath : cliForbiddenPath }) } }] } : { content: text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const deltas = results.length < 2 ? [delta] : text.match(/.{1,48}/g).map(content => ({ content }));
      res.end(deltas.map(delta => `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join('') + `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: results.length < 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (mode === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'PRIVATE_UPSTREAM_BODY' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'wait' || mode === 'wait-after-text') { const onClosed = captures.at(-1).body.messages.map(message => closureObservers.get(message.content)).find(Boolean) || (() => {}); res.on('close', onClosed); res.write(mode === 'wait' ? ': waiting\n\n' : 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); return; }
    const delta = mode.startsWith('tools') ? { reasoning_content: 'native reasoning to replay', tool_calls: [
      { index: 0, id: 'call_one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one"}' } },
      { index: 1, id: 'call_two', type: 'function', function: { name: 'read_file', arguments: '{"path":"two"}' } },
    ] } : { content: 'native response '.repeat(1000) };
    res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (mode !== 'truncated') res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: mode === 'tools-length' ? 'length' : mode === 'tools-filter' ? 'content_filter' : mode === 'tools' ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const fixture = path.join(state, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ providers: { fixture: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic' }, models: { 'test-model': { limit: { context: 64000, output: 16000 } } } } } }));
  const key = 'synthetic-private-worker-key-0000000000';
  const worker = spawn(bun, ['run', path.join(source, 'packages/sdk/src/tokligence-bridge.ts')], { env: { ...process.env, OPENCODE_NATIVE_STATE: state, OPENCODE_NATIVE_PORT: '0', OPENCODE_NATIVE_KEY: key, OPENCODE_NATIVE_MODELS: 'test-model', OPENCODE_NATIVE_BODY_TIMEOUT_MS: '2000', OPENCODE_NATIVE_REQUEST_TIMEOUT_MS: '5000', OPENCODE_NATIVE_FIXTURE_CONFIG: fixture, ...Object.fromEntries(['DATA', 'CONFIG', 'CACHE', 'STATE'].map(name => [`XDG_${name}_HOME`, path.join(state, name.toLowerCase())])) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const call = (extra = {}, auth = key, signal) => fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'x-opencode-bridge-session': 'same-caller-session' }, body: JSON.stringify({ model: 'test-model', messages, tools, ...extra }), signal });
    assert.equal((await call({}, 'wrong')).status, 401);
    const oversized = await new Promise((resolve, reject) => {
      const req = http.request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-length': String(16 * 1024 * 1024 + 1) } }, response => {
        let body = ''; response.on('data', value => { body += value; }); response.on('end', () => { req.destroy(); resolve({ status: response.statusCode, body }); });
      });
      req.on('error', reject); req.write('{');
    });
    assert.equal(oversized.status, 413, oversized.body);
    assert.equal(captures.length, 0);
    const slow = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const req = http.request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-opencode-bridge-session': `slow-${index}` } }, response => {
        let body = ''; response.on('data', value => { body += value; }); response.on('end', () => { req.end(); resolve({ status: response.statusCode, body }); });
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Slow-body fixture timed out')));
      req.write('{"model":');
    }));
    await new Promise(resolve => setTimeout(resolve, 150));
    const refused = await call();
    assert.equal(refused.status, 503, await refused.clone().text());
    assert.equal(captures.length, 0, 'slow body admission does not start model calls');
    for (const result of await Promise.all(slow)) {
      assert.equal(result.status, 408, result.body);
      assert.equal(JSON.parse(result.body).error.code, 'native_request_body_timeout');
    }

    let response = await call({ max_tokens: 1000 });
    assert.equal(response.status, 200, await response.clone().text());
    const session = response.headers.get('x-opencode-native-session');
    assert.match(session, /^ses_/);
    assert.equal((await response.json()).choices[0].message.content, 'native response '.repeat(1000));
    assert.equal(captures[0].headers['user-agent'], 'opencode/latest/2.1.4/cli');
    assert.equal(captures[0].body.max_tokens, 1000, 'native compatibility preserves the output limit field used by official CLI');
    assert.equal(captures[0].body.max_completion_tokens, undefined);
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
    for (const [failureMode, finish] of [['tools-length', 'length'], ['tools-filter', 'content_filter']]) {
      mode = failureMode;
      response = await call();
      assert.equal(response.status, 200, await response.clone().text());
      const rejected = (await response.json()).choices[0];
      assert.equal(rejected.finish_reason, finish);
      assert.equal(rejected.message.tool_calls, undefined);
      response = await call({ stream: true });
      const rejectedStream = await response.text();
      assert.doesNotMatch(rejectedStream, /"tool_calls"/);
      assert.match(rejectedStream, new RegExp(`"finish_reason":"${finish}"`));
    }
    await t.test('real Claude Code recovers tool errors and replays reasoning through the native runtime', { skip: !process.env.OPENCODE_NATIVE_CLAUDE_BINARY }, async () => {
      mode = 'claude';
      cliFixturePath = path.join(state, 'claude-fixture.txt');
      await writeFile(cliFixturePath, 'fixture marker: NATIVE_READ_OK');
      const config = parse(await (await import('node:fs/promises')).readFile('gateway.routes.yaml', 'utf8'));
      config.providers.find(provider => provider.id === 'opencode-native').models = ['opencode-native/test-model'];
      const configPath = path.join(state, 'gateway.yaml');
      await writeFile(configPath, stringify(config));
      let wireTap, relay; const cliRoles = [], cliSystems = [], cliErrors = [], cliTransport = [];
      const gateway = spawn(process.execPath, ['tgw-proxy.mjs'], { env: { PATH: process.env.PATH, HOME: state, ROUTING_CONFIG_PATH: configPath, PROXY_HOST: '127.0.0.1', PROXY_PORT: '0', TOKLIGENCE_AUTH_SECRET: 'synthetic-cli-client', TOKLIGENCE_ADMIN_SECRET: 'synthetic-admin', OPENCODE_NATIVE_ENABLED: 'true', OPENCODE_NATIVE_URL: `http://127.0.0.1:${port}/v1`, OPENCODE_NATIVE_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
      let gatewayDiagnostics = ''; gateway.stderr.on('data', value => { gatewayDiagnostics += value; });
      try {
        const gatewayPort = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CLI fixture gateway startup timed out')), 8000);
          gateway.once('exit', () => { clearTimeout(timer); reject(new Error('CLI fixture gateway failed')); });
          gateway.stdout.on('data', value => { const match = String(value).match(/tgw-proxy :(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        });
        wireTap = http.createServer(async (req, res) => {
          let raw = ''; for await (const part of req) raw += part;
          cliTransport.push({ path: req.url, declared: req.headers['content-length'], bytes: Buffer.byteLength(raw) });
          try { const messages = JSON.parse(raw).messages || []; cliRoles.push(messages.map(message => ({ role: message.role, keys: Object.keys(message) }))); cliSystems.push(...messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text || '').join(''))); } catch {}
          const upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort, path: req.url, method: req.method, headers: req.headers, agent: false }, response => { Object.assign(cliTransport.at(-1), { status: response.statusCode, contentType: response.headers['content-type'], length: response.headers['content-length'] }); if (response.statusCode >= 400) response.on('data', value => { cliErrors.push(String(value)); }); res.writeHead(response.statusCode, response.headers); response.pipe(res); });
          upstream.on('error', error => { res.destroy(error); }); upstream.end(raw);
        });
        await new Promise(resolve => wireTap.listen(0, '127.0.0.1', resolve));
        const relayProgram = `import sys,json
sys.path.insert(0,sys.argv[1])
from live_safety import LiveGuard,claude_relay
with LiveGuard(sys.argv[2],'native-cli-fixture',5,40960) as guard:
 with claude_relay(guard,sys.argv[3],'test-model','Bearer sk-ant-synthetic-cli-client',5) as url:
  print(json.dumps({'url':url}),flush=True)
  sys.stdin.read()
`;
        relay = spawn('python3', ['-u', '-c', relayProgram, path.resolve('native/opencode'), state, `http://127.0.0.1:${wireTap.address().port}`], { env: { PATH: process.env.PATH, HOME: state }, stdio: ['pipe', 'pipe', 'pipe'] });
        relay.stdin.on('error', () => {});
        let relayErrors = ''; relay.stderr.on('data', value => { relayErrors += value; });
        const relayURL = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Guarded CLI relay startup timed out')), 5000);
          relay.once('exit', code => { clearTimeout(timer); reject(new Error(`Guarded CLI relay exited ${code}: ${relayErrors}`)); });
          relay.stdout.once('data', value => { clearTimeout(timer); resolve(JSON.parse(String(value)).url); });
        });
        const cli = spawn(process.env.OPENCODE_NATIVE_CLAUDE_BINARY, ['-p', `Use Read to read ${cliFixturePath}, recover from any error, and explain the fixture.`, '--model', 'opencode-native/test-model', '--tools', 'Read', '--allowedTools', `Read(/${cliFixturePath})`, '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '5', '--output-format', 'json', '--setting-sources', '', '--no-session-persistence'], { cwd: state, env: { PATH: process.env.PATH, HOME: state, CLAUDE_CONFIG_DIR: path.join(state, 'claude-config'), ANTHROPIC_BASE_URL: relayURL, ANTHROPIC_AUTH_TOKEN: 'sk-ant-synthetic-cli-client', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', MAX_THINKING_TOKENS: '2048' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        cli.stdout.on('data', value => { stdout += value; }); cli.stderr.on('data', value => { stderr += value; });
        const exit = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cli.kill('SIGKILL'); reject(new Error(`Claude fixture timed out: ${stderr}`)); }, 35000);
          cli.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        const guardDiagnostic = await (await import('node:fs/promises')).readFile(path.join(state, 'live-probe-ledger.json'), 'utf8');
        assert.equal(exit, 0, stdout + stderr + JSON.stringify(cliRoles) + JSON.stringify(cliErrors) + guardDiagnostic + JSON.stringify(cliTransport) + gatewayDiagnostics);
        const result = JSON.parse(stdout);
        assert.match(result.result, /CLAUDE_NATIVE_RECOVERY_OK/);
        assert.ok(result.result.length > 6000, "real CLI consumed the long multi-frame answer");
        const reminder = cliSystems.find(text => text.trim());
        assert.ok(reminder, 'real CLI fixture included an inline system reminder');
        assert.ok(captures.some(capture => JSON.stringify(capture.body.messages).includes(JSON.stringify(reminder).slice(1, -1))), 'native protocol preserves the inline reminder text');
        assert.doesNotMatch(JSON.stringify(captures), /SYNTHETIC_SECRET_DO_NOT_FORWARD/, 'out-of-workspace reads must be denied before reaching the model');
        assert.ok(cliTurns >= 3, 'real Claude Code must complete failed and successful Read calls');
        assert.ok(captures.at(-1).body.messages.some(message => message.role === 'tool' && /NATIVE_READ_OK/.test(message.content)));
        assert.ok(captures.at(-1).body.messages.some(message => message.role === 'assistant' && message.reasoning_content === 'fixture native thought'));
        const relayDone = new Promise(resolve => relay.once('exit', resolve));
        relay.stdin.end();
        assert.equal(await relayDone, 0, relayErrors);
        const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(state, 'live-probe-ledger.json')));
        assert.equal(ledger.runs['native-cli-fixture'].requests, cliTurns, 'every actual CLI inference is reserved');
        assert.ok(captures.filter(capture => capture.body.messages.some(message => JSON.stringify(message.content).includes('fixture'))).some(capture => capture.body.max_tokens === 8192));
      } finally { if (relay && relay.exitCode === null && relay.signalCode === null) { relay.stdin.end(); relay.kill('SIGKILL'); } if (wireTap) { wireTap.closeAllConnections(); await new Promise(resolve => wireTap.close(resolve)); } gateway.kill('SIGKILL'); await new Promise(resolve => { if (gateway.exitCode !== null || gateway.signalCode !== null) resolve(); else gateway.once('exit', resolve); }); }
    });
    mode = 'quota'; response = await call();
    assert.equal(response.status, 429, await response.clone().text());
    assert.doesNotMatch(await response.text(), /PRIVATE_UPSTREAM_BODY/);
    mode = 'truncated'; response = await call({ stream: true });
    const truncated = await response.text();
    assert.match(truncated, /native_stream_incomplete|native_stream_invalid|native_/);
    assert.doesNotMatch(truncated, /data: \[DONE\]/);
    mode = 'wait';
    response = await call();
    assert.equal(response.status, 504, await response.clone().text());
    assert.equal((await response.json()).error.code, 'native_request_deadline');
    for (let cancellation = 0; cancellation < 5; cancellation++) {
      mode = 'wait';
      const marker = `cancellation-probe-${cancellation}`;
      const closed = new Promise(resolve => { closureObservers.set(marker, resolve); });
      const abort = new AbortController();
      const reached = () => captures.some(capture => capture.body.messages.some(message => message.content === marker));
      const pending = call({ stream: true, messages: [{ role: "user", content: marker }] }, key, abort.signal);
      pending.catch(() => {});
      for (let i = 0; i < 100 && !reached(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(reached(), 'the exact cancellation probe reached upstream');
      abort.abort();
      await assert.rejects(pending);
      await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native cancellation did not close the provider connection: ' + marker + ' ' + logs)), 3000); timer.unref(); })]);
      mode = 'text';
      // Peer socket close can precede native fiber finalization. A brief conflict
      // is valid; a leaked active lease must not survive the bounded retry window.
      for (let attempt = 0; attempt < 50; attempt++) {
        response = await call();
        if (response.status !== 409) break;
        assert.equal(response.headers.get('retry-after'), '1');
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(response.status, 200, await response.clone().text());
    }
    mode = 'wait-after-text';
    const streamMarker = "mid-stream-cancellation-probe";
    const streamingClosed = new Promise(resolve => { closureObservers.set(streamMarker, resolve); });
    response = await call({ stream: true, messages: [{ role: "user", content: streamMarker }] });
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /partial/);
    await reader.cancel();
    await Promise.race([streamingClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Mid-stream cancellation leaked the provider connection')), 3000); timer.unref(); })]);
    await new Promise(resolve => setTimeout(resolve, 30));
    mode = 'text'; response = await call();
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    worker.kill('SIGTERM');
    await new Promise(resolve => { if (worker.exitCode !== null) resolve(); else { worker.once('exit', resolve); setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(state, { recursive: true, force: true });
    await rm(canaryRoot, { recursive: true, force: true });
  }
});
