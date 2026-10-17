// OpenCode Zen session pool.
//
// Zen only answers a free-tier request whose x-opencode-session names a session
// that a real OpenCode client created; invented ids are rejected with
// FreeTierError even when the token and user-agent are correct. Creating a
// session is a local, model-free operation, so the provider keeps a small pool
// of ids minted through `opencode serve` and reuses them across requests.
//
// The server is started on demand, and its output is captured rather than
// discarded: when `opencode serve` cannot come up, that output is the only
// evidence of why, so it is kept in a ring buffer and attached to the error.

import { spawn } from "node:child_process";

const READY_TIMEOUT_MS = Number(process.env.OPENCODE_ZEN_READY_TIMEOUT_MS || 30000);
const READY_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2000;
const CHILD_LOG_LIMIT = 4000;

export function createSessionPool({
  command = process.env.OPENCODE_ZEN_SERVE_COMMAND || "opencode",
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
  let detectedVersion = null;

  // Zen checks that the request looks like it came from OpenCode. Hardcoding a
  // version means the user-agent can drift from the binary that actually minted
  // the session, and the pair has to agree, so ask the binary instead.
  const clientVersion = async () => {
    if (detectedVersion) return detectedVersion;
    detectedVersion = await new Promise((resolve) => {
      let out = "";
      try {
        const probe = spawnProcess(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        probe.stdout?.on("data", (chunk) => { out += String(chunk); });
        probe.on?.("error", () => resolve(null));
        probe.on?.("exit", () => {
          const match = out.match(/(\d+\.\d+\.\d+)/);
          resolve(match ? match[1] : null);
        });
      } catch {
        resolve(null);
      }
    });
    log(`opencode-zen: ${command} reports version ${detectedVersion ?? "unknown"}`);
    return detectedVersion;
  };
  let child = null;
  let starting = null;
  let childLog = "";

  let serverPassword = process.env.OPENCODE_ZEN_SERVE_PASSWORD || null;

  const record = (text) => {
    // OpenCode v2 protects `serve` with a password it prints at startup.
    const announced = String(text).match(/server password (\S+)/);
    if (announced) {
      serverPassword = announced[1];
      log("opencode-zen: serve announced a password; using it for local calls");
    }
    childLog = (childLog + text).slice(-CHILD_LOG_LIMIT);
  };

  const authHeaders = () => (serverPassword ? { authorization: `Bearer ${serverPassword}` } : {});

  const probe = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${origin}/session`, { method: "GET", headers: authHeaders(), signal: controller.signal });
      if (response.ok) return { ready: true };
      return { ready: false, why: `GET ${origin}/session returned ${response.status}` };
    } catch (error) {
      return { ready: false, why: `${error.name}: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  };

  const waitForServer = async () => {
    const deadline = now() + READY_TIMEOUT_MS;
    let lastWhy = "never probed";
    while (now() < deadline) {
      const attempt = await probe();
      if (attempt.ready) return true;
      lastWhy = attempt.why;
      await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
    log(`opencode-zen: ${command} serve did not become ready within ${READY_TIMEOUT_MS}ms (${lastWhy})`);
    return false;
  };

  const describe = () => childLog.trim() || "no output captured from the server";

  const ensureServer = async () => {
    const first = await probe();
    if (first.ready) return;
    if (starting) {
      await starting;
      if ((await probe()).ready) return;
    }
    starting = (async () => {
      if (child && child.exitCode === null) return;
      childLog = "";
      log(`opencode-zen: starting ${command} serve on ${origin} (${first.why})`);
      try {
        child = spawnProcess(command, [...args, "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        throw new Error(`OpenCode Zen could not spawn ${command}: ${error.message}`);
      }
      child.stdout?.on("data", (chunk) => record(String(chunk)));
      child.stderr?.on("data", (chunk) => record(String(chunk)));
      child.on?.("error", (error) => log(`opencode-zen: ${command} serve failed to start: ${error.message}`));
      child.on?.("exit", (code, signal) => {
        log(`opencode-zen: ${command} serve exited (code=${code} signal=${signal}): ${describe()}`);
        child = null;
      });
      child.unref?.();
      if (!(await waitForServer())) {
        throw new Error(
          `OpenCode Zen could not reach ${command} serve on ${origin}: ${describe()}`,
        );
      }
      log(`opencode-zen: ${command} serve ready on ${origin}`);
    })().finally(() => {
      starting = null;
    });
    await starting;
  };

  const mint = async () => {
    await ensureServer();
    const response = await fetchImpl(`${origin}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error(`OpenCode Zen could not create a session (${response.status}): ${describe()}`);
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

  return { sessionId, ensureServer, clientVersion, close: () => { ready.length = 0; } };
}