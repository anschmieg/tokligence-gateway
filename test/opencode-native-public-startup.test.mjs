import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;

test('public startup rejects credential-bearing state before host activation in a blocked network namespace', { skip: !source || !bun, timeout: 25000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-public-startup-'));
  try {
    for (const table of ['credential', 'account', 'control_account', 'clean', 'clean']) {
      const state = path.join(root, table);
      await (await import('node:fs/promises')).mkdir(state, { recursive: true });
      await writeFile(path.join(state, 'native-auth-mode'), 'public\n');
      const setup = `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); db.run('CREATE TABLE credential (value TEXT)'); if(process.argv[2] !== 'credential') db.run('CREATE TABLE "'+process.argv[2]+'" (value TEXT)'); db.query('INSERT INTO "'+process.argv[2]+'" (value) VALUES (?)').run('SYNTHETIC_REFRESH_CANARY'); db.close();`;
      if (table !== 'clean') await promisify(execFile)(bun, ['-e', setup, path.join(state, 'opencode.db'), table], { timeout: 5000 });
      const args = ['--unshare-net', '--die-with-parent'];
      for (const item of ['/usr', '/lib', '/lib64', '/bin', '/nix']) if (existsSync(item)) args.push('--ro-bind', item, item);
      args.push('--dir', '/etc');
      for (const item of ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']) if (existsSync(item)) args.push('--ro-bind', item, item);
      args.push('--ro-bind', path.resolve(source), '/source', '--ro-bind', path.resolve(bun), '/bun', '--bind', state, '/state',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/state', '--setenv', 'OPENCODE_NATIVE_STATE', '/state', '--setenv', 'OPENCODE_NATIVE_AUTH_MODE', 'public',
        '--setenv', 'OPENCODE_NATIVE_MODELS', 'glm-5.3-flash-free', '--setenv', 'OPENCODE_NATIVE_KEY', 'synthetic-private-worker-startup-key');
      for (const name of ['DATA', 'CONFIG', 'CACHE', 'STATE']) args.push('--setenv', 'XDG_' + name + '_HOME', '/state/' + name);
      args.push('--', '/bun', 'run', '/source/packages/sdk/src/tokligence-bridge.ts');
      const child = spawn('bwrap', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      let ready = false;
      child.stdout.on('data', value => { stdout += value; if (table === 'clean' && !ready && stdout.includes('native_worker_ready')) { ready = true; child.kill('SIGTERM'); } }); child.stderr.on('data', value => { stderr += value; });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 6000);
      try {
        const [code, exitSignal] = await once(child, 'exit');
        if (table === 'clean') {
          assert.equal(ready, true, 'clean public database boots on creation and restart: ' + stderr);
          // We signal the bwrap supervisor after readiness. Its exit may be
          // SIGTERM even when the contained worker handles shutdown normally.
          assert.ok(code === 0 || exitSignal === 'SIGTERM', stderr);
        } else {
          assert.notEqual(code, 0);
          assert.match(stderr, /Public native state contains credentials; use separate state/);
          assert.doesNotMatch(stdout + stderr, /native_worker_ready/);
        }
        assert.doesNotMatch(stdout + stderr, /SYNTHETIC_REFRESH_CANARY/);
      } finally { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
