import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

import { executeRoutePlan } from "../request-executor.mjs";

const STREAM_BODY = { model: "public/model", stream: true, max_tokens: 32, messages: [{ role: "user", content: "hello" }] };
const NATIVE_FRAME = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"native/model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const OPENAI_FRAME = `data: ${JSON.stringify({ id: "chatcmpl_test", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function makeCandidate({ id, adapter = "middleware", port, protocol = "messages", translate }) {
  return {
    provider: { id, adapter, base_url: `http://127.0.0.1:${port}` },
    model: { id: `${id}-model` },
    upstreamModel: `${id}/model`,
    protocol,
    ...(translate ? { translate } : {}),
  };
}

async function fixture(t, upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const candidate = makeCandidate({ id: options.providerId || "synthetic", adapter: options.adapter || "middleware", port: upstreamPort, translate: options.translate });
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      void executeRoutePlan({
        plan: {
          candidates: options.candidates || [candidate],
          publicModel: "public/model",
          required: { streaming: true },
          deadline: Date.now() + (options.deadlineMs ?? 1500),
        },
        req,
        res,
        path: "/v1/messages",
        body,
        env: { ...process.env, GATEWAY_SSE_PING_MS: "15", GATEWAY_RESPONSE_START_TIMEOUT_MS: "180", ...options.env },
        openCodeAccountPool: options.openCodeAccountPool,
        affinityKey: options.affinityKey || "test-affinity",
      });
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  return { gateway, upstream, gatewayPort, upstreamPort, candidate };
}

function startRequest(port, { abortAfterFirstData = false } = {}) {
  const request = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } });
  const chunks = [];
  let response;
  const firstData = new Promise((resolve, reject) => {
    request.once("response", (res) => {
      response = res;
      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (abortAfterFirstData) request.destroy();
        resolve({ res, text: () => Buffer.concat(chunks).toString() });
      });
      res.once("error", reject);
    });
    request.once("error", (error) => {
      if (abortAfterFirstData && error.code === "ECONNRESET") return;
      reject(error);
    });
  });
  request.end(JSON.stringify(STREAM_BODY));
  return { request, firstData, get response() { return response; }, text: () => Buffer.concat(chunks).toString() };
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("condition did not become true in time"));
      setTimeout(check, 5).unref?.();
    };
    check();
  });
}

function nativeServer(handler) {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    handler(req, res);
  });
}

function translatedServer(handler) {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    handler(req, res);
  });
}

test("native incomplete SSE frames keep a quiet streaming client alive with pings", async (t) => {
  let upstreamClosed = false;
  const upstream = nativeServer((_req, res) => {
    res.write('event: message_start\ndata: {"type":"message_start"');
    res.on("close", () => { upstreamClosed = true; });
  });
  const fixtureResult = await fixture(t, upstream.listeners("request")[0]);
  const client = startRequest(fixtureResult.gatewayPort);
  const first = await client.firstData;
  assert.equal(first.res.statusCode, 200);
  assert.match(first.text(), /event: ping\ndata: \{"type":"ping"\}\n\n/);
  assert.equal(first.text().includes("event: message_start"), false, "incomplete upstream event must not leak as a complete frame");
  client.request.destroy();
  await waitFor(() => upstreamClosed);
});

test("translated non-streaming errors are rejected before headers and use candidate fallback", async (t) => {
  let fallbackCalls = 0;
  const failing = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic upstream failure" } }));
  });
  const fallback = http.createServer((_req, res) => {
    fallbackCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "recovered" } }] }));
  });
  const failingPort = await listen(failing);
  const fallbackPort = await listen(fallback);
  const candidates = [
    makeCandidate({ id: "translated-error", adapter: "openai-compatible", port: failingPort, translate: "anthropic-from-openai" }),
    makeCandidate({ id: "translated-healthy", adapter: "openai-compatible", port: fallbackPort, translate: "anthropic-from-openai" }),
  ];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(failing); await close(fallback); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify({ ...STREAM_BODY, stream: false }) });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /recovered/);
  assert.equal(fallbackCalls, 1);
});

test("translated non-streaming caller rejects embedded SSE error before headers", async (t) => {
  let fallbackCalls = 0;
  const failing = translatedServer((_req, res) => {
    res.end(`data: ${JSON.stringify({ error: { message: "synthetic upstream failure" } })}\n\n`);
  });
  const fallback = http.createServer((_req, res) => {
    fallbackCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "recovered" } }] }));
  });
  const failingPort = await listen(failing);
  const fallbackPort = await listen(fallback);
  const candidates = [
    makeCandidate({ id: "translated-sse-error", adapter: "openai-compatible", port: failingPort, translate: "anthropic-from-openai" }),
    makeCandidate({ id: "translated-recovered", adapter: "openai-compatible", port: fallbackPort, translate: "anthropic-from-openai" }),
  ];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(failing); await close(fallback); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ ...STREAM_BODY, stream: false }),
  });
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.equal(message.content[0].text, "recovered");
  assert.equal(fallbackCalls, 1);
});

test("translated valid tool-only JSON completion succeeds", async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] } }] }));
  });
  const candidate = makeCandidate({ id: "translated-tool-json", adapter: "openai-compatible", port: await listen(upstream), translate: "anthropic-from-openai" });
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates: [candidate] });
  t.after(async () => { await close(gateway); await close(upstream); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ ...STREAM_BODY, stream: false }),
  });
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(message.content, [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }]);
});

test("translated post-commit embedded errors emit an error without fallback", async (t) => {
  let fallbackCalls = 0;
  const failing = translatedServer((_req, res) => {
    res.write(OPENAI_FRAME);
    res.end(`data: ${JSON.stringify({ error: { message: "synthetic upstream failure" } })}\n\n`);
  });
  const fallback = nativeServer((_req, res) => { fallbackCalls += 1; res.end(NATIVE_FRAME); });
  const failingPort = await listen(failing);
  const fallbackPort = await listen(fallback);
  const candidates = [
    makeCandidate({ id: "translated-failure", adapter: "openai-compatible", port: failingPort, translate: "anthropic-from-openai" }),
    makeCandidate({ id: "must-not-fallback", port: fallbackPort }),
  ];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(failing); await close(fallback); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /event: error/);
  assert.match(text, /Upstream stream failed/);
  assert.doesNotMatch(text, /event: message_stop/);
  assert.equal(fallbackCalls, 0);
});

test("translated empty JSON completion is rejected before headers and uses candidate fallback", async (t) => {
  let fallbackCalls = 0;
  const empty = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }));
  });
  const healthy = http.createServer((_req, res) => {
    fallbackCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "recovered" } }] }));
  });
  const emptyPort = await listen(empty);
  const healthyPort = await listen(healthy);
  const candidates = [
    makeCandidate({ id: "translated-empty", adapter: "openai-compatible", port: emptyPort, translate: "anthropic-from-openai" }),
    makeCandidate({ id: "translated-healthy", adapter: "openai-compatible", port: healthyPort, translate: "anthropic-from-openai" }),
  ];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(empty); await close(healthy); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ ...STREAM_BODY, stream: false }),
  });
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.equal(message.content[0].text, "recovered");
  assert.equal(fallbackCalls, 1);
});

test("translated truncated SSE for a non-streaming caller falls back before headers", async (t) => {
  let fallbackCalls = 0;
  const truncated = translatedServer((_req, res) => res.end(OPENAI_FRAME));
  const healthy = http.createServer((_req, res) => {
    fallbackCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "recovered" } }] }));
  });
  const truncatedPort = await listen(truncated);
  const healthyPort = await listen(healthy);
  const candidates = [
    makeCandidate({ id: "translated-truncated-buffered", adapter: "openai-compatible", port: truncatedPort, translate: "anthropic-from-openai" }),
    makeCandidate({ id: "translated-recovered-buffered", adapter: "openai-compatible", port: healthyPort, translate: "anthropic-from-openai" }),
  ];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(truncated); await close(healthy); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ ...STREAM_BODY, stream: false }),
  });
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.equal(message.content[0].text, "recovered");
  assert.equal(fallbackCalls, 1);
});

test("translated EOF without finish reason or DONE emits a protocol error", async (t) => {
  const upstream = translatedServer((_req, res) => res.end(OPENAI_FRAME));
  const candidate = makeCandidate({ id: "translated-truncated", adapter: "openai-compatible", port: await listen(upstream), translate: "anthropic-from-openai" });
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates: [candidate] });
  t.after(async () => { await close(gateway); await close(upstream); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  const text = await response.text();
  assert.match(text, /event: error/);
  assert.match(text, /Upstream stream failed/);
  assert.doesNotMatch(text, /event: message_stop/);
});

test("translated stream emits heartbeat while upstream delays its first bytes", async (t) => {
  let upstreamClosed = false;
  const upstream = translatedServer((_req, res) => {
    const timer = setTimeout(() => {
      res.write(OPENAI_FRAME);
      res.end("data: [DONE]\n\n");
    }, 90);
    res.on("close", () => { clearTimeout(timer); upstreamClosed = true; });
  });
  const upstreamPort = await listen(upstream);
  const candidate = makeCandidate({ id: "synthetic-translated", adapter: "openai-compatible", port: upstreamPort, translate: "anthropic-from-openai" });
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => void executeRoutePlan({ plan: { candidates: [candidate], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1000 }, req, res, path: "/v1/messages", body: STREAM_BODY, env: { GATEWAY_SSE_PING_MS: "15", GATEWAY_RESPONSE_START_TIMEOUT_MS: "250" } }));
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  const client = startRequest(gatewayPort);
  const first = await client.firstData;
  assert.equal(first.res.statusCode, 200);
  assert.match(first.text(), /event: ping\ndata: \{"type":"ping"\}\n\n/);
  assert.equal(first.text().includes("event: message_start"), false);
  client.request.destroy();
  await waitFor(() => upstreamClosed);
});

test("response-start timeout returns 504 before headers and does not try another candidate", async (t) => {
  let secondCalls = 0;
  const slow = http.createServer((_req, res) => { setTimeout(() => res.end("late"), 250); });
  const fallback = http.createServer((_req, res) => { secondCalls += 1; res.end(NATIVE_FRAME); });
  const slowPort = await listen(slow);
  const fallbackPort = await listen(fallback);
  const candidates = [makeCandidate({ id: "slow-native", port: slowPort }), makeCandidate({ id: "fallback-native", port: fallbackPort })];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "40" }, deadlineMs: 500 });
  t.after(async () => { await close(gateway); await close(slow); await close(fallback); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 504);
  assert.equal(secondCalls, 0);
  await response.body?.cancel();
});

test("pre-commit upstream status failure falls back to the next candidate", async (t) => {
  let fallbackCalls = 0;
  const failing = http.createServer((_req, res) => { res.writeHead(503); res.end("synthetic unavailable"); });
  const healthy = nativeServer((_req, res) => { fallbackCalls += 1; res.end(NATIVE_FRAME); });
  const failingPort = await listen(failing);
  const healthyPort = await listen(healthy);
  const candidates = [makeCandidate({ id: "failed", port: failingPort }), makeCandidate({ id: "healthy", port: healthyPort })];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates });
  t.after(async () => { await close(gateway); await close(failing); await close(healthy); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 200);
  assert.equal(fallbackCalls, 1);
  await response.body?.cancel();
});

test("total deadline after stream commitment emits an error and never falls back", async (t) => {
  let fallbackCalls = 0;
  const first = nativeServer((_req, res) => {
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n');
    // Keep the stream open beyond the route deadline.
  });
  const fallback = nativeServer((_req, res) => { fallbackCalls += 1; res.end(NATIVE_FRAME); });
  const firstPort = await listen(first);
  const fallbackPort = await listen(fallback);
  const candidates = [makeCandidate({ id: "committed", port: firstPort }), makeCandidate({ id: "must-not-run", port: fallbackPort })];
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates, deadlineMs: 90, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "500" } });
  t.after(async () => { await close(gateway); await close(first); await close(fallback); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: error/);
  assert.match(text, /deadline exceeded/i);
  assert.equal(fallbackCalls, 0);
});

test("total deadline before stream commitment returns 504", async (t) => {
  const stall = http.createServer((_req, _res) => {});
  const port = await listen(stall);
  const candidate = makeCandidate({ id: "precommit-stall", port });
  const { gateway, gatewayPort } = await fixture(t, () => {}, { candidates: [candidate], deadlineMs: 55, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "500" } });
  t.after(async () => { await close(gateway); await close(stall); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.type, "gateway_timeout");
});

test("response-start budget includes buffered JSON bodies", async (t) => {
  const { gatewayPort } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"type":"message"');
  }, { env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "40" } });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.type, "gateway_timeout");
});

test("response-start budget is shared across failed provider attempts", async (t) => {
  const first = http.createServer((_req, res) => {
    const timer = setTimeout(() => { res.writeHead(503); res.end("unavailable"); }, 70);
    res.once("close", () => clearTimeout(timer));
  });
  const firstPort = await listen(first);
  t.after(() => close(first));
  const stall = http.createServer(() => {});
  const stallPort = await listen(stall);
  t.after(() => close(stall));
  const candidates = [makeCandidate({ id: "delayed-failure", port: firstPort }), makeCandidate({ id: "stall", port: stallPort })];
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => void executeRoutePlan({ plan: { candidates, publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1000 }, req, res, path: "/v1/messages", body: STREAM_BODY, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "100" } }));
  });
  const port = await listen(gateway);
  t.after(() => close(gateway));
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
  assert.equal(response.status, 504);
  assert.ok(Date.now() - started < 160, "fallback must not restart the response-start budget");
  await response.text();
});

test("native and translated streams survive a local idle-timeout edge during silence", async (t) => {
  for (const translated of [false, true]) {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const first = setTimeout(() => res.write(translated ? OPENAI_FRAME : NATIVE_FRAME), 100);
      const last = setTimeout(() => res.end(translated ? 'data: [DONE]\n\n' : 'event: message_stop\ndata: {"type":"message_stop"}\n\n'), 220);
      res.once("close", () => { clearTimeout(first); clearTimeout(last); });
    });
    const upstreamPort = await listen(upstream);
    const candidate = makeCandidate({ id: "idle-test", port: upstreamPort, adapter: translated ? "openai-compatible" : "middleware", translate: translated ? "anthropic-from-openai" : undefined });
    const { gatewayPort } = await fixture(t, () => {}, { candidates: [candidate], env: { GATEWAY_SSE_PING_MS: "10", GATEWAY_RESPONSE_START_TIMEOUT_MS: "50" } });
    const edge = http.createServer((req, res) => {
      const outgoing = http.request({ hostname: "127.0.0.1", port: gatewayPort, path: req.url, method: req.method, headers: req.headers }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(res);
      });
      outgoing.setTimeout(65, () => outgoing.destroy(new Error("synthetic edge idle timeout")));
      outgoing.on("error", () => res.destroy());
      req.pipe(outgoing);
    });
    const edgePort = await listen(edge);
    t.after(async () => { await close(edge); await close(upstream); });
    const response = await fetch(`http://127.0.0.1:${edgePort}/v1/messages`, { method: "POST", body: JSON.stringify(STREAM_BODY) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok((text.match(/event: ping/g) || []).length >= 2);
    assert.match(text, /event: message_stop/);
    if (translated) assert.match(text, /hello/);
  }
});

test("client disconnect aborts and closes the upstream request", async (t) => {
  let upstreamClosed = false;
  const upstream = nativeServer((_req, res) => {
    res.write(NATIVE_FRAME);
    res.on("close", () => { upstreamClosed = true; });
  });
  const { gateway, gatewayPort } = await fixture(t, upstream.listeners("request")[0]);
  const client = startRequest(gatewayPort, { abortAfterFirstData: true });
  await client.firstData;
  await waitFor(() => upstreamClosed);
});
