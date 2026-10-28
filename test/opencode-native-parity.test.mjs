import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;
const reference = process.env.OPENCODE_REFERENCE_SOURCE, referenceBun = process.env.OPENCODE_REFERENCE_BUN;
test('independent pinned reference and native compilers compare multi-turn requests without external networking', { skip: !source || !bun || !reference || !referenceBun, timeout: 90000 }, async () => {
  const pin = JSON.parse(await readFile('native/opencode/reference-source.json'));
  assert.equal(JSON.parse(await readFile(path.join(reference, 'packages/opencode/package.json'))).version, pin.version);
  assert.equal(execFileSync(referenceBun, ['--version'], { encoding: 'utf8' }).trim(), pin.bun);
  for (const [filename, expected] of [
    ['packages/opencode/src/provider/transform.ts', pin.transformSha256],
    ['packages/opencode/node_modules/@ai-sdk/openai-compatible/dist/index.mjs', pin.openaiCompatibleDistSha256],
  ]) assert.equal(createHash('sha256').update(await readFile(path.join(reference, filename))).digest('hex'), expected, 'reference source must remain pinned');
  assert.equal(JSON.parse(await readFile(path.join(reference, 'packages/opencode/node_modules/@ai-sdk/openai-compatible/package.json'))).version, pin.openaiCompatibleVersion);
  const output = await mkdtemp(path.join(os.tmpdir(), 'zen-request-parity-'));
  const args = ['--unshare-net', '--die-with-parent'];
  for (const item of ['/usr', '/lib', '/lib64', '/bin', '/nix']) if (existsSync(item)) args.push('--ro-bind', item, item);
  args.push('--dir', '/etc');
  for (const item of ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']) if (existsSync(item)) args.push('--ro-bind', item, item);
  args.push('--ro-bind', path.resolve(source), '/native', '--ro-bind', path.resolve(reference), '/reference',
    '--ro-bind', path.resolve(bun), '/native-bun', '--ro-bind', path.resolve(referenceBun), '/reference-bun',
    '--ro-bind', process.execPath, '/node',
    '--ro-bind', path.resolve('native/opencode/testing/native-parity.mjs'), '/fixture.mjs',
    '--ro-bind', path.resolve('native/opencode/testing/reference-request.ts'), '/reference-runner.ts',
    '--ro-bind', path.resolve('native/opencode/request-diff.mjs'), '/request-diff.mjs',
    '--bind', output, '/work', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/work', '--clearenv',
    '--setenv', 'OPENCODE_PARITY_FIXTURE', '1', '--setenv', 'OPENCODE_PARITY_PARENT_NS', await readlink('/proc/self/ns/net'), '--', '/node', '/fixture.mjs');
  const child = spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 85000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr + stdout);
    const report = JSON.parse(await readFile(path.join(output, 'parity.json')));
    assert.equal(report.external_network_blocked, true);
    assert.equal(report.cases.length, 80);
    // Keep evidence for review rather than treating serialization differences as success.
    const unexpected = report.cases.filter(item => item.differences.length);
    assert.deepEqual(unexpected, [], 'unapproved reference/native request differences; report at ' + output);
    await rm(output, { recursive: true, force: true });
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
