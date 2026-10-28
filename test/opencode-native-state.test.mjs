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
  const options = { file, limit: 2, ttlMs: 50, now: () => clock, allocateID: () => `ses_${++sequence}`, create: async () => {}, remove: async id => { removed.push(id); } };
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
    const registry = await createSessionRegistry({ file, limit: 2, ttlMs: 1000, allocateID: () => `ses_${++sequence}`, create: async () => {}, remove: async id => { removed.push(id); } });
    await Promise.all(Array.from({ length: 8 }, (_, i) => registry.get(String(i), 'model', new Set())));
    assert.equal(Object.keys(JSON.parse(await readFile(file))).length, 2);
    assert.equal(removed.length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native registry resumes interrupted removal from a durable marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-recovery-'));
  const file = path.join(root, 'sessions.json');
  let sequence = 0, interrupt = true;
  const options = { file, limit: 1, ttlMs: 1000, allocateID: () => `ses_${++sequence}`, create: async () => {}, remove: async () => { if (interrupt) throw new Error('Interrupted native deletion'); } };
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

test('native registry journals creation identity and persists end-of-request timestamps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-create-'));
  const file = path.join(root, 'sessions.json');
  let clock = 100, count = 0, interrupt = true;
  const native = new Set();
  const options = { file, limit: 2, ttlMs: 100, now: () => clock, allocateID: () => `ses_${++count}`, create: async (model, id) => { native.add(id); if (interrupt) throw new Error('Crash after native creation'); }, remove: async id => { native.delete(id); } };
  try {
    const first = await createSessionRegistry(options);
    await assert.rejects(first.get('a', 'model', new Set()), /Crash/);
    const pending = JSON.parse(await readFile(file));
    assert.equal(pending.a.creating, true); assert.equal(pending.a.id, 'ses_1');
    interrupt = false;
    const recovered = await createSessionRegistry(options);
    assert.equal((await recovered.get('a', 'model', new Set())).id, 'ses_1');
    assert.equal(count, 1); assert.equal(native.size, 1);
    clock = 150; await recovered.touch('a');
    const restarted = await createSessionRegistry(options);
    clock = 220;
    assert.equal((await restarted.get('a', 'model', new Set())).id, 'ses_1');
    assert.equal(JSON.parse(await readFile(file)).a.creating, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fault-injected registry operations retain a bounded, recoverable native identity set', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registry-faults-'));
  const file = path.join(root, 'sessions.json');
  let sequence = 0, clock = 100, random = 17, failCreate = false, failRemove = false;
  const native = new Set();
  const options = { file, limit: 3, ttlMs: 80, now: () => clock, allocateID: () => `ses_${++sequence}`, create: async (model, id) => { native.add(id); if (failCreate) { failCreate = false; throw new Error('Interrupted creation'); } }, remove: async id => { native.delete(id); if (failRemove) { failRemove = false; throw new Error('Interrupted removal'); } } };
  try {
    let registry = await createSessionRegistry(options);
    for (let step = 0; step < 80; step++) {
      random = (random * 1664525 + 1013904223) >>> 0;
      clock += random % 25;
      failCreate = step % 9 === 0; failRemove = step % 11 === 0;
      try {
        const entry = await registry.get(`scope-${random % 7}`, 'model', new Set());
        assert.ok(native.has(entry.id), 'a successful lease must reference a native session');
        await registry.touch(`scope-${random % 7}`);
      } catch (error) { assert.match(error.message, /Interrupted/); }
      const persisted = Object.values(JSON.parse(await readFile(file)));
      assert.ok(native.size <= 3, 'native identities remain bounded even across interrupted operations');
      assert.ok([...native].every(id => persisted.some(entry => entry.id === id)), 'no native session is orphaned outside the creation journal');
      registry = await createSessionRegistry(options); // Process restart loses all in-memory state.
    }
    failCreate = false; failRemove = false;
    clock += 100;
    await registry.get('final', 'model', new Set());
    assert.equal(native.size, 1);
    assert.equal(Object.keys(JSON.parse(await readFile(file))).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native registry migrates model-scoped identities and switches models without new sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-model-switch-'));
  const file = path.join(root, 'sessions.json');
  const switches = [];
  let fail = true;
  await writeFile(file, JSON.stringify({ legacyA: { id: 'ses_existing', model: 'model-a', lastUsed: Date.now() } }));
  const options = { file, limit: 4, ttlMs: 60000, allocateID: () => { throw new Error('Unexpected allocation'); }, create: async () => { throw new Error('Unexpected creation'); }, remove: async () => {}, switchModel: async (id, model) => { switches.push([id, model]); if (fail) { fail = false; throw new Error('Interrupted model selection'); } } };
  try {
    const first = await createSessionRegistry(options);
    await assert.rejects(first.get('conversation', 'model-b', new Set(), ['legacyA']), /Interrupted/);
    const recovered = await createSessionRegistry(options);
    assert.equal((await recovered.get('conversation', 'model-b', new Set(), ['legacyA'])).id, 'ses_existing');
    const saved = JSON.parse(await readFile(file));
    assert.equal(saved.legacyA, undefined);
    assert.equal(saved.conversation.model, 'model-b');
    assert.equal((await recovered.get('conversation', 'model-a', new Set(), ['legacyA'])).id, 'ses_existing');
    assert.deepEqual(switches, [['ses_existing', 'model-b'], ['ses_existing', 'model-b'], ['ses_existing', 'model-a']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
