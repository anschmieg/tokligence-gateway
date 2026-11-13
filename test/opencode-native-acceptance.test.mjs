import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const run = promisify(execFile);
test('acceptance admission requires a same-owner foundation, single case and immutable paced window', { timeout: 12000 }, async () => {
  await run('python3', ['test/opencode_acceptance_plan.py'], { timeout: 10000 });
});
test('unplanned matrix commands fail before credential/state access or reservation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'matrix-cold-admission-'));
  const root = path.join(base, 'must-not-be-created');
  const args = ['native/opencode/live-tests.py', '--root', root, '--not-before', '1970-01-01T00:00:00+00:00', '--run-id', 'unplanned', '--models', 'beam-free', '--phases', 'basic'];
  try {
    await assert.rejects(run('python3', args), error => error.code === 2 && /--plan/.test(error.stderr));
    await assert.rejects(run('python3', [...args, '--plan', path.join(base, 'missing.json')]), error => error.code === 2 && /case_plan_unavailable/.test(error.stdout));
    await assert.rejects(access(root), { code: 'ENOENT' });
  } finally { await rm(base, { recursive: true, force: true }); }
});
