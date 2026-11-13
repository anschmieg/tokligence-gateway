import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('same-version API/auth/request boundaries use actual upstream components with external networking blocked', { skip: !process.env.OPENCODE_NATIVE_SOURCE || !process.env.OPENCODE_NATIVE_BUN, timeout: 115000 }, async () => {
  const child = spawn(process.execPath, ['scripts/verify-opencode-api.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 110000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /114 pass/);
    assert.match(stdout, /0 fail/);
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
