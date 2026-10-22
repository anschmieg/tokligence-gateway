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
const VERSION_PROBE_TIMEOUT_MS = 1500;
const VERSION_OUTPUT_LIMIT = 1024;
const CHILD_LOG_LIMIT = 4000;
const serverPasswords = new Map();
const serverStarts = new Map();

export function createSessionPool({
  command = process.env.OPENCODE_ZEN_SERVE_COMMAND || "opencode",
  args = ["serve", "--hostname", "127.0.0.1"],
  host = "127.0.0.1",
  port = Number(process.env.OPENCODE_ZEN_SERVE_PORT || 4096),
  size = 8,
  ttlMs = 15 * 60 * 1000,
  affinityTtlMs = 60 * 60 * 1000,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyIntervalMs = READY_INTERVAL_MS,
  versionProbeTimeoutMs = VERSION_PROBE_TIMEOUT_MS,
  title = "tokligence opencode-zen",
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const origin = `http://${host}:${port}`;
  const ready = [];
  const sticky = new Map();
  const stickyPending = new Map();
  const STICKY_LIMIT = 2048;
  let detectedVersion = null;
  let versionProbe = null;

  // Version lookup is best-effort and bounded: never let a stuck executable
  // delay a request indefinitely or retain unbounded subprocess output.
  const clientVersion = async () => {
    if (detectedVersion !== null) return detectedVersion;
    if (versionProbe) return versionProbe;
    versionProbe = new Promise((resolve) => {
      let out = "";
      let settled = false;
      let probe;
      const finish = (version) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detectedVersion = version;
        resolve(version);
      };
      const timer = setTimeout(() => {
        try { probe?.kill?.(); } catch {}
        finish(null);
      }, versionProbeTimeoutMs);
      try {
        probe = spawnProcess(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        probe.stdout?.on("data", (chunk) => {
          if (settled) return;
          out = (out + String(chunk)).slice(0, VERSION_OUTPUT_LIMIT);
        });
        probe.on?.("error", () => finish(null));
        probe.on?.("exit", () => {
          const match = out.match(/(\d+\.\d+\.\d+)/);
          finish(match ? match[1] : null);
        });
      } catch {
        finish(null);
      }
    }).finally(() => { versionProbe = null; });
    return versionProbe;
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
      serverPasswords.set(origin, serverPassword);
      log("opencode-zen: serve announced a password; using it for local calls");
    }
    childLog = (childLog + text).slice(-CHILD_LOG_LIMIT);
  };

  // v2 protects the server with HTTP Basic (username "opencode"); v1 had no
  // local auth at all, so an absent password simply sends no credentials.
  const authHeaders = () => {
    const password = serverPasswords.get(origin) || serverPassword;
    return password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
  };

  // Resolved once from the running server: v2 serves /api/session, v1 /session.
  let sessionPath = null;
  const candidatePaths = ["/api/session", "/session"];
  const resolveSessionPath = async () => {
    if (sessionPath) return sessionPath;
    for (const candidate of candidatePaths) {
      try {
        const response = await fetchImpl(`${origin}${candidate}`, {
          method: "GET",
          headers: authHeaders(),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.ok || response.status === 401) {
          sessionPath = candidate;
          return candidate;
        }
      } catch {
        // Try the next shape.
      }
    }
    return null;
  };

  const probe = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const path = (await resolveSessionPath()) || "/api/session";
      const response = await fetchImpl(`${origin}${path}`, { method: "GET", headers: authHeaders(), signal: controller.signal });
      if (response.ok) return { ready: true };
      return { ready: false, why: `GET ${origin}${path} returned ${response.status}` };
    } catch (error) {
      return { ready: false, why: `${error.name}: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  };

  const waitForServer = async () => {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      const attempt = await probe();
      if (attempt.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, readyIntervalMs));
    }
    log("opencode-zen: serve did not become ready within configured timeout");
    return false;
  };

  const describe = () => "server startup failed";

  const ensureServer = async () => {
    const first = await probe();
    if (first.ready) return;
    if (serverStarts.has(origin)) {
      await serverStarts.get(origin);
      if ((await probe()).ready) return;
    }
    if (starting) {
      await starting;
      if ((await probe()).ready) return;
    }
    starting = (async () => {
      if (child && child.exitCode === null) return;
      childLog = "";
      log("opencode-zen: starting local serve");
      try {
        child = spawnProcess(command, [...args, "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch {
        throw new Error("OpenCode Zen server startup failed (SPAWN_FAILED)");
      }
      child.stdout?.on("data", (chunk) => record(String(chunk)));
      child.stderr?.on("data", (chunk) => record(String(chunk)));
      child.on?.("error", () => log("opencode-zen: local serve process error"));
      child.on?.("exit", () => {
        log("opencode-zen: local serve process exited");
        child = null;
      });
      child.unref?.();
      if (!(await waitForServer())) {
        throw new Error("OpenCode Zen server startup failed (NOT_READY)");
      }
      log("opencode-zen: local serve ready");
    })().finally(() => {
      starting = null;
      serverStarts.delete(origin);
    });
    serverStarts.set(origin, starting);
    await starting;
  };

  const mint = async () => {
    await ensureServer();
    const path = (await resolveSessionPath()) || "/api/session";
    const response = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 5),
    });
    if (!response.ok) throw new Error(`OpenCode Zen could not create a session (HTTP_${response.status})`);
    const payload = await response.json();
    // v2 nests the session under `data` and reports the project it belongs to;
    // v1 returned it at the top level with no project.
    const id = payload?.data?.id || payload?.id;
    if (!id) throw new Error("OpenCode Zen session response had no id (MISSING_ID)");
    return { id, project: payload?.data?.projectID || payload?.projectID || null, minted: now() };
  };

  const fill = async () => {
    while (ready.length < size) ready.push(await mint());
  };

  const setAffinity = (stickyKey, entry) => {
    sticky.delete(stickyKey);
    sticky.set(stickyKey, { entry, until: now() + affinityTtlMs });
    while (sticky.size > STICKY_LIMIT) sticky.delete(sticky.keys().next().value);
  };

  // Returns the session together with the project that owns it, so the caller
  // can describe the session it presents instead of guessing.
  const sessionId = async (stickyKey = null) => {
    const select = async () => {
      const affinity = stickyKey ? sticky.get(stickyKey) : null;
      if (affinity?.entry && affinity.until > now() && now() - affinity.entry.minted <= ttlMs) {
        return { id: affinity.entry.id, project: affinity.entry.project };
      }
      while (ready.length) {
        const entry = ready.shift();
        if (now() - entry.minted <= ttlMs) {
          if (ready.length < size) fill().catch(() => {});
          if (stickyKey) setAffinity(stickyKey, entry);
          return { id: entry.id, project: entry.project };
        }
      }
      const entry = await mint();
      if (stickyKey) setAffinity(stickyKey, entry);
      return { id: entry.id, project: entry.project };
    };
    if (!stickyKey) return select();
    if (stickyPending.has(stickyKey)) return stickyPending.get(stickyKey);
    const pending = select().finally(() => {
      if (stickyPending.get(stickyKey) === pending) stickyPending.delete(stickyKey);
    });
    stickyPending.set(stickyKey, pending);
    return pending;
  };

  return { sessionId, ensureServer, clientVersion, close: () => { ready.length = 0; sticky.clear(); stickyPending.clear(); } };
}