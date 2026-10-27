import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('live safety guard persists budgets/cooldowns and accounts for actual CLI calls', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  await promisify(execFile)('python3', ['test/opencode_native_live_safety.py'], { timeout: 18000 });
});
