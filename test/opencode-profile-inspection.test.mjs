import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('installed profile inspection redacts credentials, never executes wrappers and reads modern sessions', async () => {
  await run('python3', ['test/opencode_installed_profile.py'], { timeout: 5000 });
});
