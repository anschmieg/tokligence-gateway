import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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

export async function createSessionRegistry({ file, limit, ttlMs, allocateID, create, remove, now = Date.now }) {
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
    await fs.writeFile(`${file}.pending`, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    await fs.rename(`${file}.pending`, file);
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
      return serialize(async () => {
        const entry = sessions.get(key);
        if (entry && !entry.removing) { entry.lastUsed = now(); await save(); }
      });
    },
    get(key, model, active) {
      return serialize(async () => {
        for (const [candidate, entry] of sessions) {
          if ((candidate === key || !active.has(candidate)) && (entry.removing || now() - entry.lastUsed >= ttlMs)) await discard(candidate);
        }
        let entry = sessions.get(key);
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
        entry.lastUsed = now();
        await save();
        return entry;
      });
    },
  };
}
