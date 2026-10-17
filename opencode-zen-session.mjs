// OpenCode Zen session pool.
//
// Zen only answers a free-tier request whose x-opencode-session names a session
// that a real OpenCode client created; invented ids are rejected with
// FreeTierError even when the token and user-agent are correct. Creating a
// session is a local, model-free operation, so the provider keeps a small pool
// of ids minted through `opencode serve` and reuses them across requests.

import { spawn } from "node:child_process";

const READY_TIMEOUT_MS = 30000;
const READY_INTERVAL_MS = 250;

export function createSessionPool({
  command = "opencode",
  args = ["serve", "--hostname", "127.0.0.1"],
  host = "127.0.0.1",
  port = Number(process.env.OPENCODE_ZEN_SERVE_PORT || 4096),
  size = 8,
  ttlMs = 15 * 60 * 1000,
  title = "tokligence opencode-zen",
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const origin = `http://${host}:${port}`;
  const ready = [];
  let child = null;
  let starting = null;

  const probe = async () => {
    try {
      const response = await fetchImpl(`${origin}/session`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  };

  const waitForServer = async () => {
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (await probe()) return true;
      await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
    return false;
  };

  const ensureServer = async () => {
    if (await probe()) return;
    if (starting) {
      await starting;
      if (await probe()) return;
    }
    starting = (async () => {
      if (child && child.exitCode === null) return;
      log(`opencode-zen: starting ${command} serve on ${origin}`);
      child = spawnProcess(command, [...args, "--port", String(port)], { stdio: "ignore", detached: true });
      child.unref?.();
      child.on?.("error", (error) => log(`opencode-zen: ${command} serve failed to start: ${error.message}`));
      if (!(await waitForServer())) throw new Error(`OpenCode Zen could not reach ${command} serve on ${origin}`);
    })().finally(() => {
      starting = null;
    });
    await starting;
  };

  const mint = async () => {
    await ensureServer();
    const response = await fetchImpl(`${origin}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error(`OpenCode Zen could not create a session (${response.status})`);
    const payload = await response.json();
    if (!payload?.id) throw new Error("OpenCode Zen session response had no id");
    return { id: payload.id, minted: now() };
  };

  const fill = async () => {
    while (ready.length < size) ready.push(await mint());
  };

  const sessionId = async () => {
    while (ready.length) {
      const entry = ready.shift();
      if (now() - entry.minted <= ttlMs) {
        if (ready.length < size) fill().catch(() => {});
        return entry.id;
      }
    }
    return (await mint()).id;
  };

  return { sessionId, ensureServer, close: () => { ready.length = 0; } };
}