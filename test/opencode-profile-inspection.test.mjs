import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('installed profile inspection redacts credentials, never executes wrappers and reads modern sessions', async () => {
  await run('python3', ['test/opencode_installed_profile.py'], { timeout: 5000 });
});
test('saved profile scope comparison reports only metadata equality and preserves state', async () => {
  await run('python3', ['test/opencode_profile_scope.py'], { timeout: 5000 });
});
