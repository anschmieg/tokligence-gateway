import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { overlayFiles, createSourceOverlay, verifySourceOverlay } from '../native/opencode/source-overlay.mjs';

test('prepared source verification rejects partial deployments and arbitrary manifest paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-overlay-'));
  try {
    for (const file of overlayFiles) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'synthetic ' + file); }
    const manifest = await createSourceOverlay(root);
    assert.equal(await verifySourceOverlay(root, manifest), manifest.digest);
    await assert.rejects(verifySourceOverlay(root, { ...manifest, files: { ...manifest.files, '../private': 'a'.repeat(64) } }), /Invalid native source overlay/);
    await writeFile(path.join(root, 'packages/ai/src/protocols/openai-chat.ts'), 'stale compiler');
    await assert.rejects(verifySourceOverlay(root, manifest), /overlay mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
