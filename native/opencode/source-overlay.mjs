import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const overlayFiles = Object.freeze([
  'packages/core/src/session/model-request.ts',
  'packages/ai/src/schema/options.ts',
  'packages/ai/src/protocols/openai-chat.ts',
  'packages/sdk/src/tokligence-bridge.ts',
  'packages/sdk/src/tokligence-bridge-wire.mjs',
  'packages/sdk/src/tokligence-state-store.mjs',
  'packages/sdk/src/tokligence-scoped-http.ts',
  'packages/sdk/src/tokligence-source-overlay.mjs',
  'packages/sdk/src/tokligence-source.json',
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const fileHashes = async root => Object.fromEntries(await Promise.all(overlayFiles.map(async file => [file, sha(await readFile(path.join(root, file)))])));

export async function createSourceOverlay(root) {
  const files = await fileHashes(root);
  return { version: 1, files, digest: sha(JSON.stringify(files)) };
}

export async function verifySourceOverlay(root, manifest) {
  if (!manifest || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' ||
      Object.keys(manifest.files).length !== overlayFiles.length ||
      overlayFiles.some(file => !Object.hasOwn(manifest.files, file) || !/^[a-f0-9]{64}$/.test(manifest.files[file]))) {
    throw new Error('Invalid native source overlay manifest');
  }
  // Hash only the fixed build-file list; manifest data cannot select files.
  const actual = await createSourceOverlay(root);
  if (manifest.digest !== actual.digest || overlayFiles.some(file => manifest.files[file] !== actual.files[file])) {
    throw new Error('Native source overlay mismatch; deploy the complete tested worker and compiler snapshot');
  }
  return actual.digest;
}
