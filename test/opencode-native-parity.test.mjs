import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;
const reference = process.env.OPENCODE_2X_REFERENCE_SOURCE, referenceBun = process.env.OPENCODE_2X_REFERENCE_BUN;
test('pinned native 2.0.32 compiler matches actual 2.1 bridge with matched explicit controls and no external networking', { skip: !source || !bun || !reference || !referenceBun, timeout: 90000 }, async (t) => {
  const pin = JSON.parse(await readFile('native/opencode/reference-2x-source.json'));
  assert.equal(JSON.parse(await readFile(path.join(reference, 'packages/ai/package.json'))).version, pin.version);
  assert.equal(execFileSync(referenceBun, ['--version'], { encoding: 'utf8' }).trim(), pin.bun);
  assert.equal(createHash('sha256').update(await readFile(path.join(reference, 'packages/ai/src/protocols/openai-chat.ts'))).digest('hex'), pin.compilerSha256);
  assert.equal(JSON.parse(await readFile(path.join(reference, 'packages/ai/node_modules/effect/package.json'))).version, pin.effectVersion);
  // Verify every imported upstream AI/schema source and the lock against the
  // archive, not just a version label. Only synthetic fixture inputs are used.
  execFileSync('python3', ['-c', `import pathlib,tarfile,hashlib,sys
r=pathlib.Path(sys.argv[1]);a=r/'source.tar.gz'
assert hashlib.sha256(a.read_bytes()).hexdigest()==sys.argv[2]
with tarfile.open(a) as archive:
 for m in archive:
  relative='/'.join(m.name.split('/')[1:])
  if m.isfile() and (relative.startswith(('packages/ai/src/','packages/schema/src/')) or relative=='bun.lock'):
   assert archive.extractfile(m).read()==(r/relative).read_bytes(),relative
`, reference, pin.sha256]);
  const output = await mkdtemp(path.join(os.tmpdir(), 'zen-request-parity-2x-'));
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
    assert.deepEqual(report.cases.filter(item => item.differences.length), [], 'unapproved compiler differences; report at ' + output);
    t.diagnostic('Synthetic 2.x compiler evidence: ' + output);
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
