import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { startAttempt, openCodeAccountTransport } from "../provider-adapters.mjs";
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

test("pool exhaustion is distinguishable with a safe trace code", async () => {
  const events = [];
  const unavailable = { select: () => null };
  await assert.rejects(startAttempt({ candidate, req: { headers: {} }, path: "/v1/messages", body: Buffer.from(JSON.stringify(body)), accountPool: unavailable, trace: { emit: (event, fields) => events.push({ event, ...fields }) } }), (error) => error.code === "OPENCODE_POOL_EXHAUSTED" && error.poolExhausted === true);
  assert.ok(events.some((item) => item.phase === "pool_selection" && item.outcome === "exhausted"));
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
  assert.ok(events.some((item) => item.event === "transport_phase_start" && item.phase === "upstream_headers_wait"));
  assert.equal(events.some((item) => item.event === "transport_phase_end" && item.phase === "upstream_headers_wait"), false);
  assert.equal(events.some((item) => item.event === "upstream_headers"), false);
  releaseHeaders();
  const result = await attempt;
  result.response.resume();
  assert.ok(events.some((item) => item.event === "transport_phase_end" && item.phase === "upstream_headers_wait" && item.outcome === "ok"));
  assert.ok(events.findIndex((item) => item.event === "transport_phase_end" && item.phase === "body_sent") < events.length);
});

test("Zen alone uses its explicitly configured proxy across native and translated lanes", async (t) => {
  const upstreamRequests = [];
  const upstreamSockets = new Set();
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { upstreamRequests.push({ url: req.url, body: Buffer.concat(chunks).toString() }); res.setHeader("connection", "close"); res.end("ok"); });
  });
  upstreamServer.on("connection", (socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  upstreamServer.listen(0, "127.0.0.1"); await once(upstreamServer, "listening");
  const connectRequests = [];
  const gatewayRequestIds = [];
  const tunnelSockets = new Set();
  const proxyServer = http.createServer();
  proxyServer.on("connection", (socket) => { tunnelSockets.add(socket); socket.once("close", () => tunnelSockets.delete(socket)); });
  proxyServer.on("connect", (req, clientSocket, head) => {
    tunnelSockets.add(clientSocket);
    clientSocket.once("close", () => tunnelSockets.delete(clientSocket));
    connectRequests.push(req.url);
    gatewayRequestIds.push(req.headers["x-gateway-request-id"]);
    const [host, port] = req.url.split(":");
    const upstreamSocket = net.connect(Number(port), host, () => {
      tunnelSockets.add(upstreamSocket);
      upstreamSocket.once("close", () => tunnelSockets.delete(upstreamSocket));
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket); upstreamSocket.pipe(clientSocket);
    });
  });
  proxyServer.listen(0, "127.0.0.1"); await once(proxyServer, "listening");
  const proxy = `http://127.0.0.1:${proxyServer.address().port}`;
  const baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  t.after(() => {
    for (const socket of tunnelSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    proxyServer.closeAllConnections(); upstreamServer.closeAllConnections();
    proxyServer.close(); upstreamServer.close();
  });

  async function dispatch(candidate, path, requestBody, env, accountEgress) {
    const accountPool = pool();
    const selected = accountPool.select();
    if (accountEgress) selected.egress = accountEgress;
    const events = [];
    const result = await startAttempt({ candidate, req: { headers: candidate.provider.adapter === "chatgpt-responses" ? { "idempotency-key": "fixture-key" } : {} }, path, body: Buffer.from(JSON.stringify(requestBody)), env, accountPool: candidate.provider.adapter === "opencode-zen" ? accountPool : null, trace: { id: "00000000-0000-4000-8000-000000000001", emit: (event, fields) => events.push({ event, ...fields }) } });
    const statusCode = result.response.statusCode;
    result.response.resume();
    return { events, statusCode };
  }
  const baseEnv = { OPENCODE_ZEN_PROXY: proxy };
  const request = { model: "fixture", stream: false, messages: [{ role: "user", content: "synthetic" }] };
  const native = await dispatch({ provider: { id: "mistral", adapter: "middleware", base_url: baseUrl }, upstreamModel: "fixture", protocol: "chat_completions" }, "/v1/chat/completions", request, baseEnv);
  const translated = await dispatch({ provider: { id: "mistral", adapter: "middleware", base_url: baseUrl }, upstreamModel: "fixture", protocol: "messages", translate: "anthropic-from-openai" }, "/v1/messages", { model: "fixture", stream: false, max_tokens: 20, messages: [{ role: "user", content: "synthetic" }] }, baseEnv);
  const specialist = await dispatch({ provider: { id: "specialist", adapter: "chatgpt-responses" }, upstreamModel: "fixture", protocol: "responses", specialistInstructions: "Review carefully." }, "/v1/responses", { model: "specialist", input: "synthetic" }, { ...baseEnv, CHATGPT_RESPONSES_ENABLED: "true", CHATGPT_SERVICE_URL: baseUrl, CHATGPT_SERVICE_TOKEN: "synthetic-token" });
  const zen = await dispatch({ provider: { id: "zen", adapter: "opencode-zen", base_url: baseUrl }, model: { id: "fixture" }, upstreamModel: "fixture", protocol: "chat_completions" }, "/v1/chat/completions", request, baseEnv);

  const directZen = await dispatch({ provider: { id: "zen", adapter: "opencode-zen", base_url: baseUrl }, model: { id: "fixture" }, upstreamModel: "fixture", protocol: "chat_completions" }, "/v1/chat/completions", request, baseEnv, "direct");
  assert.equal(directZen.statusCode, 200);
  assert.ok(directZen.events.some((item) => item.event === "account_egress" && item.egress === "direct"));
  assert.equal(directZen.events.some((item) => item.phase === "proxy_connect"), false);

  assert.equal(native.statusCode, 200);
  assert.equal(translated.statusCode, 200);
  assert.equal(specialist.statusCode, 200);
  assert.equal(zen.statusCode, 200);
  assert.deepEqual(connectRequests, [`127.0.0.1:${upstreamServer.address().port}`]);
  assert.match(gatewayRequestIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const result of [native, translated, specialist]) assert.equal(result.events.some((item) => item.phase === "proxy_connect"), false);
  assert.ok(zen.events.some((item) => item.phase === "proxy_connect"));
  assert.equal(upstreamRequests.length, 5);
  assert.equal(upstreamRequests[1].url, "/chat/completions");
  assert.match(upstreamRequests[1].body, /\"messages\"/);
  assert.equal(upstreamRequests[2].url, "/v1/responses");
  assert.doesNotMatch(JSON.stringify([native.events, translated.events, specialist.events, zen.events]), /127\\.0\\.0\\.1|synthetic/);
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


test("an explicitly proxied account cannot silently fall back to direct egress", () => {
  assert.throws(() => openCodeAccountTransport({ egress: "proxy" }, {}), (error) => error.code === "OPENCODE_PROXY_NOT_CONFIGURED");
  assert.deepEqual(openCodeAccountTransport({ egress: "direct" }, { OPENCODE_ZEN_PROXY: "http://unavailable.invalid:8888" }), { egress: "direct", proxy: undefined });
});
