import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const binary = process.env.OPENCODE_OFFICIAL_CLI_BINARY;
test('official CLI uses the actual OpenCode provider with public auth in an isolated network namespace', { skip: !binary, timeout: 65000 }, async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'zen-official-cli-'));
  const run = async () => {
    const child = spawn('python3', ['native/opencode/capture-official-cli.py', '--binary', binary, '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  };
  try {
    const result = await run();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const summary = JSON.parse(await readFile(path.join(output, 'summary.json')));
    assert.equal(summary.external_network_blocked, true);
    assert.equal(summary.public_auth_only, true);
    assert.equal(summary.marker_received, true);
    const [request] = JSON.parse(await readFile(path.join(output, 'requests.json')));
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.authentication, 'public');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-opencode-client'], 'cli');
    assert.match(request.headers['x-opencode-session'], /^ses_/);
    assert.equal(request.body.model, 'beam-free');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.messages.at(-1).role, 'user');
    assert.equal(request.body.tools?.length || 0, 0);
    const repeated = await run();
    assert.notEqual(repeated.code, 0, 'do not overwrite previous evidence or rerun the CLI');
    assert.match(repeated.stderr, /previous evidence is never overwritten/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
