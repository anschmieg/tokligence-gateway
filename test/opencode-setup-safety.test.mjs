import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { startAttempt } from "../provider-adapters.mjs";
import { executeRoutePlan } from "../request-executor.mjs";

const candidate = { provider: { id: "zen", adapter: "opencode-zen", base_url: "http://127.0.0.1:1" }, model: { id: "beam-free" }, upstreamModel: "beam-free", protocol: "messages" };
const body = { model: "beam-free", stream: true, messages: [{ role: "user", content: "synthetic" }] };
function pool(blocked, failure = null, traceEvents = null, setupOverrides = {}) {
  const account = { id: "primary" };
  let quarantines = 0;
  return {
    maxAttempts: 1, state: new Map([[account.id, { generation: 0 }]]), select: () => account,
    servicesFor: () => ({ tokens: {
      authorization: async () => { traceEvents?.push("authorization"); return "Bearer synthetic"; },
      credential: async () => { traceEvents?.push("credential"); return {}; },
    }, sessions: {
      sessionId: async () => { traceEvents?.push("session_id"); if (failure) throw new Error(failure); return blocked === "mint" ? new Promise(() => {}) : { id: "fixture" }; },
      clientVersion: async () => { traceEvents?.push("client_version"); return blocked === "version" ? new Promise(() => {}) : "1.18.32"; },
      ...setupOverrides,
    } }),
    markFailure: () => { quarantines++; }, get quarantines() { return quarantines; },
  };
}

for (const blocked of ["mint", "version"]) test(`OpenCode ${blocked} wait obeys cancellation without quarantining shared account`, async () => {
  const accountPool = pool(blocked);
  const aborter = new AbortController();
  const attempt = startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from(JSON.stringify(body)), accountPool, signal: aborter.signal });
  aborter.abort(new Error("fixture cancelled"));
  await assert.rejects(Promise.race([attempt, new Promise((_, reject) => setTimeout(() => reject(new Error("setup ignored cancellation")), 100))]), /fixture cancelled/);
  assert.equal(accountPool.quarantines, 0);
});

test("setup tracing exposes concurrent pending phase and late cancelled completion", async () => {
  let releaseSession;
  const phases = [];
  const accountPool = pool(null, null, phases, { sessionId: () => new Promise((resolve) => { releaseSession = resolve; }) });
  const trace = { emit: (event, fields) => phases.push({ event, ...fields }) };
  const aborter = new AbortController();
  const attempt = startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from(JSON.stringify(body)), accountPool, signal: aborter.signal, trace });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(phases.filter((item) => item.event === "setup_phase_start").map((item) => item.phase).sort(), ["authorization", "client_version", "credential", "session_id"]);
  assert.deepEqual(phases.filter((item) => item.event === "setup_phase_end" && item.outcome === "ok").map((item) => item.phase).sort(), ["authorization", "client_version", "credential"]);
  aborter.abort(new Error("fixture cancelled"));
  await assert.rejects(attempt, /fixture cancelled/);
  releaseSession({ id: "late-fixture" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(phases.some((item) => item.event === "setup_phase_end" && item.phase === "session_id" && item.outcome === "completed_after_cancel"));
});

test("setup rejection preserves its original error identity", async () => {
  const original = Object.assign(new Error("synthetic private setup detail"), { code: "ETIMEDOUT", statusCode: 429 });
  const accountPool = pool(null, null, null, { sessionId: async () => { throw original; } });
  await assert.rejects(startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from(JSON.stringify(body)), accountPool }), (error) => error === original);
});

test("blocked session setup respects executor deadline without sending upstream", async (t) => {
  const accountPool = pool("mint");
  let elapsed;
  const server = http.createServer((req, res) => {
    req.resume(); req.once("end", () => {
      const started = Date.now();
      void executeRoutePlan({ plan: { candidates: [candidate], publicModel: "beam-free", required: { streaming: true }, deadline: started + 30 }, req, res, path: "/v1/messages", body, openCodeAccountPool: accountPool }).then(() => { elapsed = Date.now() - started; });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: "{}" });
  assert.equal(response.status, 504);
  await response.text();
  assert.ok(elapsed < 200, `deadline took ${elapsed}ms`);
  assert.equal(accountPool.quarantines, 0);
});

test("direct HTTP transport records body completion before delayed upstream headers", async (t) => {
  let releaseHeaders;
  const upstreamServer = http.createServer((req, res) => { req.resume(); releaseHeaders = () => res.end("ok"); });
  upstreamServer.listen(0, "127.0.0.1"); await once(upstreamServer, "listening");
  t.after(() => { upstreamServer.closeAllConnections(); upstreamServer.close(); });
  const candidate = { provider: { id: "fixture", adapter: "middleware", base_url: `http://127.0.0.1:${upstreamServer.address().port}` }, upstreamModel: "fixture", protocol: "messages" };
  const events = [];
  const received = new Promise((resolve) => upstreamServer.once("request", (req) => req.once("end", resolve)));
  const attempt = startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from("{}"), trace: { emit: (event, fields) => events.push({ event, ...fields }) } });
  await received;
  assert.ok(events.some((item) => item.event === "transport_phase_end" && item.phase === "body_sent"));
  assert.equal(events.some((item) => item.event === "upstream_headers"), false);
  releaseHeaders();
  const result = await attempt;
  result.response.resume();
  assert.ok(events.findIndex((item) => item.event === "transport_phase_end" && item.phase === "body_sent") < events.length);
});

test("proxy CONNECT is traced without endpoint details", async (t) => {
  const upstreamServer = http.createServer((req, res) => { req.resume(); res.end("ok"); });
  upstreamServer.listen(0, "127.0.0.1"); await once(upstreamServer, "listening");
  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    const [host, port] = req.url.split(":");
    const upstreamSocket = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket); upstreamSocket.pipe(clientSocket);
    });
  });
  proxyServer.listen(0, "127.0.0.1"); await once(proxyServer, "listening");
  const previousProxy = process.env.OPENCODE_ZEN_PROXY;
  process.env.OPENCODE_ZEN_PROXY = `http://127.0.0.1:${proxyServer.address().port}`;
  t.after(() => {
    if (previousProxy === undefined) delete process.env.OPENCODE_ZEN_PROXY; else process.env.OPENCODE_ZEN_PROXY = previousProxy;
    proxyServer.closeAllConnections(); proxyServer.close(); upstreamServer.closeAllConnections(); upstreamServer.close();
  });
  const candidate = { provider: { id: "fixture", adapter: "middleware", base_url: `http://127.0.0.1:${upstreamServer.address().port}` }, upstreamModel: "fixture", protocol: "messages" };
  const events = [];
  const attempt = startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from("{}"), trace: { emit: (event, fields) => events.push({ event, ...fields }) } });
  await new Promise((resolve) => upstreamServer.once("request", (req) => req.once("end", resolve)));
  const phases = events.filter((item) => item.event === "transport_phase_end").map((item) => item.phase);
  const result = await attempt;
  result.response.resume();
  assert.ok(phases.indexOf("proxy_connect") >= 0);
  assert.ok(phases.indexOf("proxy_connect") < phases.indexOf("connection"));
  assert.doesNotMatch(JSON.stringify(events), /127\\.0\\.0\\.1|fixture/);
});

test("OpenCode setup errors are never logged with private subprocess details", async (t) => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  t.after(() => { console.error = original; });
  const server = http.createServer((req, res) => {
    req.resume(); req.once("end", () => void executeRoutePlan({ plan: { candidates: [candidate], publicModel: "beam-free", required: { streaming: true }, deadline: Date.now() + 1000 }, req, res, path: "/v1/messages", body, openCodeAccountPool: pool(null, "/private/command server password SYNTHETIC_SECRET") }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: "{}" });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.doesNotMatch(logs.join("\n") + text, /SYNTHETIC_SECRET|\/private\/command/);
});
