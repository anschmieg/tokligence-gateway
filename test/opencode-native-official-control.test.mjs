import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('official public control meters real transport and preserves credentials isolation', { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
  await promisify(execFile)('python3', ['test/opencode_official_control.py'], { timeout: 25000 });
});
