import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireStateLock, createSessionRegistry } from '../native/opencode/state-store.mjs';

test('native lock ignores stale PID contents and retains one inode across acquisitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-lock-'));
  const file = path.join(root, 'worker.lock');
  await writeFile(file, '1'); // A prior container's PID 1 is irrelevant.
  let lock;
  try {
    lock = await acquireStateLock(file);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireStateLock(file)));
    assert.ok(attempts.every(item => item.status === 'rejected' && /live worker owner/.test(item.reason.message)));
    await lock.close(); lock = await acquireStateLock(file);
  } finally { await lock?.close(); await rm(root, { recursive: true, force: true }); }
});

test('native registry evicts idle LRU and expired sessions, migrates timestamps and protects active sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-'));
  const file = path.join(root, 'sessions.json');
  let clock = 100, sequence = 0;
  const removed = [];
  const options = { file, limit: 2, ttlMs: 50, now: () => clock, create: async () => `ses_${++sequence}`, remove: async id => { removed.push(id); } };
  try {
    const registry = await createSessionRegistry(options);
    const active = new Set();
    const a = await registry.get('a', 'model', active); clock++;
    const b = await registry.get('b', 'model', active); clock++;
    active.add('a');
    await registry.get('c', 'model', active);
    assert.deepEqual(removed, [b.id]);
    active.add('c');
    await assert.rejects(registry.get('d', 'model', active), { code: 'native_session_capacity' });
    active.clear(); clock += 100;
    const replacement = await registry.get('a', 'model', active);
    assert.notEqual(replacement.id, a.id);
    assert.equal(Object.keys(JSON.parse(await readFile(file))).length, 1);
    await writeFile(file, JSON.stringify({ legacy: { id: 'ses_legacy', model: 'model' } }));
    const migrated = await createSessionRegistry(options);
    assert.equal((await migrated.get('legacy', 'model', active)).id, 'ses_legacy');
    clock += 100;
    assert.notEqual((await migrated.get('legacy', 'model', active)).id, 'ses_legacy');
    assert.ok(removed.includes('ses_legacy'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native registry serializes simultaneous allocation under its capacity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-race-'));
  const file = path.join(root, 'sessions.json');
  let sequence = 0;
  const removed = [];
  try {
    const registry = await createSessionRegistry({ file, limit: 2, ttlMs: 1000, create: async () => `ses_${++sequence}`, remove: async id => { removed.push(id); } });
    await Promise.all(Array.from({ length: 8 }, (_, i) => registry.get(String(i), 'model', new Set())));
    assert.equal(Object.keys(JSON.parse(await readFile(file))).length, 2);
    assert.equal(removed.length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native registry resumes interrupted removal from a durable marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-recovery-'));
  const file = path.join(root, 'sessions.json');
  let sequence = 0, interrupt = true;
  const options = { file, limit: 1, ttlMs: 1000, create: async () => `ses_${++sequence}`, remove: async () => { if (interrupt) throw new Error('Interrupted native deletion'); } };
  try {
    const first = await createSessionRegistry(options);
    await first.get('a', 'model', new Set());
    await assert.rejects(first.get('b', 'model', new Set()), /Interrupted/);
    assert.equal(JSON.parse(await readFile(file)).a.removing, true);
    interrupt = false;
    const recovered = await createSessionRegistry(options);
    await recovered.get('b', 'model', new Set());
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file))), ['b']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
