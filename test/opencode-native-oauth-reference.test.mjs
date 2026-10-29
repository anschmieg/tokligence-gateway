import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;
test('same-version actual native CLI OAuth lifecycle matches gateway with blocked external networking', { skip: !source || !bun, timeout: 180000 }, async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'native-oauth-reference-'));
  await promisify(execFile)('python3', ['native/opencode/capture-oauth-reference.py', '--source', source, '--bun', bun,
    '--node', process.execPath, '--output', output], { timeout: 170000 });
  const report = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.native_fetch_meter_verified, true);
  assert.equal(report.live_tested, false);
  assert.equal(report.refresh_calls, 1);
  assert.equal(report.total_inference_calls, 13);
  t.diagnostic('Private synthetic evidence: ' + output);
});
