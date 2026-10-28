import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Called while holding worker.lock, before EmbeddedHost can open credentials.
export async function claimAuthState(directory, mode) {
  const marker = `${directory}/native-auth-mode`;
  let existing;
  try { existing = (await fs.readFile(marker, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing !== mode) throw new Error('Native authentication modes require separate state directories');
    return;
  }
  if (mode === 'public') {
    try {
      await fs.access(`${directory}/opencode.db`);
      throw new Error('Public native workers require a fresh state directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.writeFile(marker, `${mode}\n`, { flag: 'wx', mode: 0o600 });
}

// Public mode must reject imported credentials BEFORE EmbeddedHost activates
// provider plugins, credential refresh, or Console discovery.
export async function assertPublicDatabaseEmpty(directory, openDatabase) {
  const file = `${directory}/opencode.db`;
  try { await fs.access(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let database;
  try {
    database = openDatabase(file);
    let recognized = false;
    for (const table of ['credential', 'account', 'control_account']) {
      if (!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      if (table === 'credential') recognized = true;
      // Only fixed table names and counts; never load credential/token values.
      if (database.query(`SELECT count(*) AS count FROM "${table}"`).get().count > 0) {
        throw new Error('Public native state contains credentials; use separate state');
      }
    }
    if (!recognized) throw new Error('Public native state has an unrecognized credential schema');
  } catch (error) {
    if (error.message === 'Public native state contains credentials; use separate state' || error.message === 'Public native state has an unrecognized credential schema') throw error;
    throw new Error('Public native credential state could not be verified before startup');
  } finally { database?.close(); }
}

// flock locks the inherited open-file description. The parent retains that
// descriptor after the utility exits; the kernel releases it even on SIGKILL.
// Never unlink this inode: doing so would allow a second independent lock.
export async function acquireStateLock(file) {
  const handle = await fs.open(file, 'a+', 0o600);
  const result = spawnSync('flock', ['-n', '-E', '73', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', handle.fd],
  });
  if (result.error || result.status !== 0) {
    await handle.close();
    throw new Error(result.status === 73 ? 'This native state already has a live worker owner' : 'Native state locking requires the flock utility');
  }
  return handle;
}

export async function createSessionRegistry({ file, limit, ttlMs, allocateID, create, remove, switchModel = async (_id, _model) => {}, now = Date.now }) {
  const sessions = new Map();
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const [key, entry] of Object.entries(saved)) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.model !== 'string') throw new Error('Invalid native session registry');
      // Older deployments did not persist timestamps. Give these entries one TTL.
      sessions.set(key, { ...entry, lastUsed: Number.isFinite(entry.lastUsed) ? entry.lastUsed : now() });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  const serialize = (action) => {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const save = async () => {
    const pending = await fs.open(`${file}.pending`, 'w', 0o600);
    try {
      await pending.writeFile(JSON.stringify(Object.fromEntries(sessions)));
      await pending.sync();
    } finally { await pending.close(); }
    await fs.rename(`${file}.pending`, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const discard = async (key) => {
    const entry = sessions.get(key);
    entry.removing = true;
    await save(); // Durable tombstone: retry interrupted native cleanup after restart.
    await remove(entry.id);
    sessions.delete(key);
    // Persist deletions before creating a replacement so restarts don't retain
    // references to native sessions that have already been removed.
    await save();
  };
  return {
    touch(key) {
      // Update the idle timestamp before releasing the request's active lease.
      // The write remains ordered before any subsequently queued allocation.
      const entry = sessions.get(key);
      if (!entry || entry.removing) return Promise.resolve();
      entry.lastUsed = now();
      return serialize(save);
    },
    get(key, model, active, aliases = []) {
      return serialize(async () => {
        for (const [candidate, entry] of sessions) {
          if ((candidate === key || !active.has(candidate)) && (entry.removing || now() - entry.lastUsed >= ttlMs)) await discard(candidate);
        }
        let entry = sessions.get(key);
        if (!entry) {
          // Adopt one pre-upgrade model-specific identity without creating a
          // second native session. Other old entries remain eligible for TTL/LRU.
          const legacy = aliases.find(candidate => sessions.has(candidate) && !active.has(candidate));
          if (legacy) {
            entry = sessions.get(legacy);
            sessions.delete(legacy);
            sessions.set(key, entry);
          }
        }
        if (!entry) {
          while (sessions.size >= limit) {
            const oldest = [...sessions].filter(([candidate]) => !active.has(candidate))
              .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            if (!oldest) throw Object.assign(new Error('All native sessions are active'), { code: 'native_session_capacity' });
            await discard(oldest[0]);
          }
          entry = { id: allocateID(), model, lastUsed: now(), creating: true };
          sessions.set(key, entry);
        }
        if (entry.creating) {
          // Persist identity BEFORE invoking native creation. OpenCode accepts
          // this native ID and returns the same session on retries after a crash.
          await save();
          await create(model, entry.id);
          delete entry.creating;
        }
        if (entry.model !== model) {
          // Native selection is idempotent. If persistence fails after this,
          // the same selection is safe to apply again after restart.
          await switchModel(entry.id, model);
          entry.model = model;
        }
        entry.lastUsed = now();
        await save();
        return entry;
      });
    },
  };
}
