import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSessionPool } from "../opencode-zen-session.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const offlineFetch = async () => { throw new Error("offline"); };

function fakeChild({ exitCode = null, kill } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = exitCode;
  child.unref = () => {};
  if (kill) child.kill = kill;
  return child;
}

test("startup failures do not expose announced passwords, child output, or executable paths", async () => {
  const password = "synthetic-private-password-42";
  const privatePath = "/private/test/opencode-command";
  const logs = [];
  const port = 49172;
  const spawnProcess = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", `server password ${password}\\n`);
      child.stderr.emit("data", `failed to start at ${privatePath}`);
      child.emit("exit", 1, null);
    });
    return child;
  };
  const pool = createSessionPool({
    command: privatePath,
    port,
    size: 0,
    readyTimeoutMs: 20,
    readyIntervalMs: 1,
    spawnProcess,
    fetchImpl: offlineFetch,
    log: (line) => logs.push(line),
  });
  let error;
  try { await pool.ensureServer(); } catch (caught) { error = caught; }
  assert.ok(error);
  const outward = `${error.message}\\n${logs.join("\\n")}`;
  assert.doesNotMatch(outward, new RegExp(password));
  assert.doesNotMatch(outward, new RegExp(privatePath.replaceAll("/", "\\\\/")));
  assert.doesNotMatch(outward, /failed to start at/);
  assert.match(error.message, /NOT_READY/);
});

test("version lookup bounds time, kills only the probe, and coalesces concurrent calls", async () => {
  let spawns = 0;
  let kills = 0;
  let probe;
  const pool = createSessionPool({
    command: "synthetic-opencode",
    size: 0,
    versionProbeTimeoutMs: 20,
    spawnProcess: () => {
      spawns++;
      probe = fakeChild({ kill: () => { kills++; } });
      return probe;
    },
    fetchImpl: offlineFetch,
  });
  const [a, b, c] = await Promise.all([pool.clientVersion(), pool.clientVersion(), pool.clientVersion()]);
  assert.deepEqual([a, b, c], [null, null, null]);
  assert.equal(spawns, 1);
  assert.equal(kills, 1);
});

test("concurrent first requests for one sticky key share the selected session", async () => {
  let minted = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === "POST") {
      const id = `concurrent-${++minted}`;
      await gate;
      return new Response(JSON.stringify({ data: { id, projectID: "fixture" } }));
    }
    return new Response("[]");
  };
  const pool = createSessionPool({ size: 0, port: 49173, fetchImpl });
  const one = pool.sessionId("same-key");
  const two = pool.sessionId("same-key");
  await sleep(10);
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a, b);
  assert.equal(minted, 1);
});

test("expired sticky sessions renew once for concurrent callers; mint failures can retry", async () => {
  let now = 0;
  let minted = 0;
  let fail = true;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === "POST") {
      minted++;
      if (fail) { fail = false; return new Response("", { status: 503 }); }
      return new Response(JSON.stringify({ data: { id: `session-${minted}`, projectID: "fixture" } }));
    }
    return new Response("[]");
  };
  const pool = createSessionPool({ size: 0, port: 49174, ttlMs: 10, affinityTtlMs: 100, now: () => now, fetchImpl });
  await assert.rejects(pool.sessionId("retry-key"), /HTTP_503/);
  const first = await pool.sessionId("retry-key");
  assert.equal(first.id, "session-2");
  now = 11;
  const [renewedA, renewedB] = await Promise.all([pool.sessionId("retry-key"), pool.sessionId("retry-key")]);
  assert.deepEqual(renewedA, renewedB);
  assert.equal(minted, 3);
  now = 22;
  const renewedAgain = await pool.sessionId("retry-key");
  assert.equal(renewedAgain.id, "session-4");
});

test("close clears sticky affinity so the same key mints a new session", async () => {
  let minted = 0;
  const fetchImpl = async (_url, init = {}) => init.method === "POST"
    ? new Response(JSON.stringify({ data: { id: `close-${++minted}` } }))
    : new Response("[]");
  const pool = createSessionPool({ size: 0, port: 49175, fetchImpl });
  const first = await pool.sessionId("close-key");
  pool.close();
  const second = await pool.sessionId("close-key");
  assert.notEqual(first.id, second.id);
  assert.equal(minted, 2);
});

test("account-local session pools share the session server password and lifecycle", async () => {
  let running = false;
  let spawns = 0;
  let minted = 0;
  const port = 49171;
  const fetchImpl = async (_url, init = {}) => {
    if (!running) throw new Error("offline");
    const expected = `Basic ${Buffer.from("opencode:synthetic-server-password").toString("base64")}`;
    if (init.headers?.authorization !== expected) return new Response("", { status: 401 });
    if (init.method === "POST") return new Response(JSON.stringify({ data: { id: `session-${++minted}`, projectID: "fixture" } }));
    return new Response("[]");
  };
  const spawnProcess = () => {
    spawns++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.unref = () => {};
    queueMicrotask(() => { running = true; child.stdout.emit("data", "server password synthetic-server-password"); });
    return child;
  };
  const first = createSessionPool({ port, size: 0, spawnProcess, fetchImpl });
  const second = createSessionPool({ port, size: 0, spawnProcess, fetchImpl });
  const a = await first.sessionId("caller-session");
  const b = await second.sessionId("caller-session");
  assert.notEqual(a.id, b.id);
  assert.equal(spawns, 1);
});
