import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { verifySourceOverlay } from '../native/opencode/source-overlay.mjs';
import { once } from 'node:events';

const source = path.resolve(process.env.OPENCODE_NATIVE_SOURCE || '.cache/opencode-native');
const bun = path.resolve(process.env.OPENCODE_NATIVE_BUN || '/nonexistent');
const pin = JSON.parse(await fs.readFile('native/opencode/source.json', 'utf8'));
const installed = JSON.parse(await fs.readFile(path.join(source, '.tokligence-source.json'), 'utf8'));
if (pin.version !== installed.version || pin.commit !== installed.commit) throw new Error('API comparison requires the pinned source revision');
const version = spawnSync(bun, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== pin.bun) throw new Error('API comparison requires pinned Bun');
await verifySourceOverlay(source, JSON.parse(await fs.readFile(path.join(source, 'packages/sdk/src/tokligence-overlay.json'), 'utf8')));
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-api-boundary-'));
const name = 'tokligence-api-boundary-' + randomUUID() + '.test.ts';
const fixture = path.join(source, 'packages/core/test', name);
await fs.copyFile('native/opencode/testing/api-boundary.ts', fixture);
const args = ['--unshare-net', '--die-with-parent'];
for (const item of ['/usr', '/lib', '/lib64', '/bin', '/nix']) if (existsSync(item)) args.push('--ro-bind', item, item);
args.push('--dir', '/etc');
for (const item of ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']) if (existsSync(item)) args.push('--ro-bind', item, item);
args.push('--ro-bind', source, '/source', '--ro-bind', bun, '/bun', '--bind', output, '/work',
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/source/packages/core', '--clearenv',
  '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/work', '--', '/bun', 'test',
  'test/plugin/provider-opencode.test.ts', 'test/session-model-request.test.ts', 'test/session-model-request-hooks.test.ts',
  'test/credential.test.ts', 'test/model-resolver.test.ts', 'test/' + name, '--timeout', '30000');
let child;
try {
  child = spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 100000);
  let code;
  try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
  await fs.writeFile(path.join(output, 'results.log'), stdout + stderr);
  process.stdout.write(stdout + stderr);
  console.log(JSON.stringify({ scope: 'same-version 2.1 native components; synthetic OAuth and HTTP only', external_network: 'OS namespace isolated', evidence: output }));
  process.exitCode = code ?? 1;
} finally {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await fs.unlink(fixture);
}
