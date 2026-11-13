import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAuthMode, assertNativeCredentialCount } from '../native/opencode/bridge-wire.mjs';
import { claimAuthState } from '../native/opencode/state-store.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('public native auth is explicit and cannot consume OAuth state or overrides', () => {
  assert.equal(nativeAuthMode({}), 'oauth');
  assert.equal(nativeAuthMode({ OPENCODE_NATIVE_AUTH_MODE: 'public' }), 'public');
  assert.throws(() => nativeAuthMode({ OPENCODE_NATIVE_AUTH_MODE: 'automatic' }));
  for (const key of ['OPENCODE_NATIVE_SEED_FILE', 'OPENCODE_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONSOLE_TOKEN']) {
    assert.throws(() => nativeAuthMode({ OPENCODE_NATIVE_AUTH_MODE: 'public', [key]: 'private-canary' }), error => !error.message.includes('private-canary') && /forbid/.test(error.message));
  }
  for (const key of ['OPENCODE_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONSOLE_TOKEN']) {
    assert.throws(() => nativeAuthMode({ [key]: 'private-canary' }), /alternate authentication overrides/);
  }
  assert.doesNotThrow(() => assertNativeCredentialCount('public', 0));
  assert.doesNotThrow(() => assertNativeCredentialCount('oauth', 1));
  assert.throws(() => assertNativeCredentialCount('public', 1), /separate state/);
  assert.throws(() => assertNativeCredentialCount('oauth', 0), /exactly one/);
  assert.throws(() => assertNativeCredentialCount('oauth', 2), /exactly one/);
});

test('public state cannot open an existing unmarked or OAuth database', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'native-auth-state-'));
  try {
    await writeFile(path.join(state, 'opencode.db'), 'synthetic existing OAuth database');
    await assert.rejects(claimAuthState(state, 'public'), /fresh state/);
    await claimAuthState(state, 'oauth'); // Existing OAuth deployments migrate safely.
    await assert.rejects(claimAuthState(state, 'public'), /separate state/);
    await claimAuthState(state, 'oauth');
  } finally { await rm(state, { recursive: true, force: true }); }
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'native-public-state-'));
  try {
    await claimAuthState(fresh, 'public');
    await writeFile(path.join(fresh, 'opencode.db'), 'synthetic public database');
    await claimAuthState(fresh, 'public'); // Public restarts preserve their own sessions.
    await assert.rejects(claimAuthState(fresh, 'oauth'), /separate state/);
  } finally { await rm(fresh, { recursive: true, force: true }); }
});
