import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { executeRoutePlan } from "../request-executor.mjs";

const requestBody = { model: "public/model", stream: true, messages: [{ role: "user", content: "hello" }] };
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function close(server) { if (server.listening) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } }
function candidate(port, protocol = "messages") { return { provider: { id: "zen", adapter: "opencode-zen", base_url: `http://127.0.0.1:${port}` }, model: { id: "zen/model" }, upstreamModel: "zen/model", protocol }; }
function makePool(firstStatusFailure = false) {
  const accounts = [{ id: "a" }, { id: "b" }];
  const state = new Map(accounts.map((account) => [account.id, { generation: 0 }]));
  const failures = new Set();
  return {
    state, failures, accounts, maxAttempts: 2,
    slot(account) { return accounts.indexOf(account) + 1; },
    diagnostic(_endpoint, _model, { exclude = [] } = {}) { return accounts.map((account, index) => ({ slot: index + 1, reason: exclude.includes(account.id) ? "excluded_after_failure" : failures.has(account.id) ? "cooldown" : "eligible", ...(failures.has(account.id) ? { remaining_ms: 5000 } : {}) })); },
    select(_endpoint, _model, _sticky, { exclude = [] } = {}) { return accounts.find((a) => !exclude.includes(a.id) && !failures.has(a.id)) || (firstStatusFailure && !exclude.includes("b") ? accounts[1] : null); },
    servicesFor(account) { return { tokens: { authorization: async () => `Bearer ${account.id}`, credential: async () => ({ metadata: { orgID: "org" } }) }, sessions: { sessionId: async () => ({ id: `session-${account.id}`, project: "global" }), clientVersion: async () => "1.18.32" } }; },
    markFailure(account, _error, options = {}) { failures.add(account.id); state.get(account.id).generation += 1; account.retryAfterMs = options.retryAfterMs; state.get(account.id).until = Date.now() + (options.retryAfterMs || 10000); },
    markSuccess() {},
  };
}
async function runFixture(t, handler, protocol = "messages") {
  const upstream = http.createServer(handler);
  const port = await listen(upstream);
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => void executeRoutePlan({
      plan: { candidates: [candidate(port, protocol)], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 3000 },
      req, res, path: protocol === "chat_completions" ? "/v1/chat/completions" : "/v1/messages", body: requestBody,
      env: { GATEWAY_SSE_PING_MS: "20", GATEWAY_RESPONSE_START_TIMEOUT_MS: "2500" }, openCodeAccountPool: pool, affinityKey: "sticky",
    }));
  });
  const gatewayPort = await listen(gateway);
  const pool = makePool();
  t.after(async () => { await close(gateway); await close(upstream); });
  return { gatewayPort, pool };
}
async function post(port, protocol = "messages") {
  return fetch(`http://127.0.0.1:${port}${protocol === "chat_completions" ? "/v1/chat/completions" : "/v1/messages"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
}

const good = `data: ${JSON.stringify({ choices: [{ delta: { content: "backup" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

test("pooled Retry-After beyond one hour is preserved while selecting the backup", async (t) => {
  const pool = makePool(true);
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) { res.writeHead(429, { "retry-after": "12489", "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "SECRET provider detail" } })); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(good); }
  });
  const port = await listen(upstream);
  const logs = [];
  const trace = { id: "test-trace-id", stage() {}, model() {}, emit(event, fields) { logs.push({ event, ...fields }); } };
  const gateway = http.createServer((req, res) => { req.resume(); req.once("end", () => void executeRoutePlan({ plan: { candidates: [candidate(port)], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1800 }, req, res, path: "/v1/messages", body: requestBody, trace, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "700" }, openCodeAccountPool: pool, affinityKey: "sticky" })); });
  const gatewayPort = await listen(gateway); t.after(async () => { await close(gateway); await close(upstream); });
  const response = await post(gatewayPort);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /backup/);
  assert.deepEqual([...pool.failures], ["a"]);
  assert.equal(pool.accounts[0].retryAfterMs, 12489000);
  assert.ok(pool.state.get("a").until - Date.now() > 3 * 60 * 60 * 1000);
  assert.equal(calls, 2);
  assert.deepEqual(logs.filter((entry) => entry.event === "pool_account_selected").map((entry) => entry.slot), [1, 2]);
  const rejected = logs.find((entry) => entry.event === "upstream_429");
  assert.equal(rejected.category, "rate_limit");
  assert.equal(rejected.upstream_error_code, "rate_limit_error");
  assert.equal(rejected.retry_after_ms, 12489000);
  assert.ok(rejected.cooldown_ms <= 12489000 && rejected.cooldown_ms > 12488000);
  assert.equal(rejected.slot, 1);
  assert.equal(Object.hasOwn(rejected, "upstream_path"), false);
  assert.equal(Object.hasOwn(rejected, "upstream_host"), false);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET provider detail|Bearer|session-a/);
});

test("OpenCode free quota error codes are classified without changing pool cooldown policy", async (t) => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "FreeUsageLimitError", message: "PRIVATE account text" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(good);
    }
  });
  const port = await listen(upstream);
  const pool = makePool(true);
  const logs = [];
  const trace = { id: "test-trace-id", stage() {}, model() {}, emit(event, fields) { logs.push({ event, ...fields }); } };
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => void executeRoutePlan({
      plan: { candidates: [candidate(port)], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1800 },
      req, res, path: "/v1/messages", body: requestBody, trace, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "700" }, openCodeAccountPool: pool, affinityKey: "sticky",
    }));
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });

  const response = await post(gatewayPort);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls, 2);
  assert.equal(pool.accounts[0].retryAfterMs, undefined);
  const rejected = logs.find((entry) => entry.event === "upstream_429");
  assert.equal(rejected.category, "free_usage_limit");
  assert.equal(rejected.upstream_error_code, "FreeUsageLimitError");
  assert.equal(rejected.retry_after_ms, undefined);
  assert.ok(rejected.cooldown_ms <= 10000 && rejected.cooldown_ms > 9000);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE account text/);
});

test("429 classification ignores provider details beyond the bounded body prefix", async (t) => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(`${"x".repeat(4096)} FreeUsageLimitError daily quota exhausted`);
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(good);
    }
  });
  const port = await listen(upstream);
  const pool = makePool(true);
  const logs = [];
  const trace = { id: "test-trace-id", stage() {}, model() {}, emit(event, fields) { logs.push({ event, ...fields }); } };
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => void executeRoutePlan({
      plan: { candidates: [candidate(port)], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1800 },
      req, res, path: "/v1/messages", body: requestBody, trace, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "700" }, openCodeAccountPool: pool, affinityKey: "sticky",
    }));
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });

  const response = await post(gatewayPort);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls, 2);
  assert.equal(pool.accounts[0].retryAfterMs, undefined);
  const rejected = logs.find((entry) => entry.event === "upstream_429");
  assert.equal(rejected.category, "unknown");
  assert.equal(rejected.upstream_error_code, undefined);
  assert.ok(rejected.cooldown_ms <= 10000 && rejected.cooldown_ms > 9000);
});

test("top-level FreeTierError classification is allowlisted without quota policy changes", async (t) => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "FreeTierError", message: "PRIVATE account text" }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(good);
    }
  });
  const port = await listen(upstream);
  const pool = makePool(true);
  const logs = [];
  const trace = { id: "test-trace-id", stage() {}, model() {}, emit(event, fields) { logs.push({ event, ...fields }); } };
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => void executeRoutePlan({
      plan: { candidates: [candidate(port)], publicModel: "public/model", required: { streaming: true }, deadline: Date.now() + 1800 },
      req, res, path: "/v1/messages", body: requestBody, trace, env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "700" }, openCodeAccountPool: pool, affinityKey: "sticky",
    }));
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  const response = await post(gatewayPort);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls, 2);
  assert.equal(pool.accounts[0].retryAfterMs, undefined);
  const rejected = logs.find((entry) => entry.event === "upstream_429");
  assert.equal(rejected.category, "free_tier_rejection");
  assert.equal(rejected.upstream_error_code, "FreeTierError");
  assert.ok(rejected.cooldown_ms <= 10000 && rejected.cooldown_ms > 9000);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE account text/);
});

test("stream failure before semantic output retries; after output it terminates without splicing and quarantines", async (t) => {
  let call = 0;
  const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
    call += 1;
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    if (call === 1) res.end('data: {"error":{"message":"provider detail"}}\n\n');
    else res.end(good);
  });
  const response = await post(gatewayPort);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /backup/);
  assert.deepEqual([...pool.failures], ["a"]);

  let secondCall = 0;
  const second = await runFixture(t, (_req, res) => {
    secondCall += 1;
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    if (secondCall === 1) res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\ndata: {"error":{"message":"provider detail"}}\n\n`);
    else res.end(good);
  });
  const firstResponse = await post(second.gatewayPort);
  const firstText = await firstResponse.text();
  assert.match(firstText, /partial/);
  assert.match(firstText, /event: error/);
  assert.doesNotMatch(firstText, /backup/);
  assert.deepEqual([...second.pool.failures], ["a"]);
  const next = await post(second.gatewayPort);
  assert.match(await next.text(), /backup/);
  assert.equal(secondCall, 2);
});

test("pooled direct chat stream surfaces embedded errors and truncation", async (t) => {
  for (const bad of ['data: {"error":{"message":"secret detail"}}\n\n', `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`]) {
    const { gatewayPort, pool } = await runFixture(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(bad); }, "chat_completions");
    const response = await post(gatewayPort, "chat_completions");
    const text = await response.text();
    assert.match(text, /event: error|"error"/);
    assert.doesNotMatch(text, /secret detail/);
    assert.deepEqual([...pool.failures], bad.includes('"error"') ? ["a", "b"] : ["a"]);
  }
});

test("pooled direct chat client cancellation does not quarantine the account", async (t) => {
  let upstreamClosed = false;
  const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "early" }, finish_reason: null }] })}\n\n`);
    res.on("close", () => { upstreamClosed = true; });
  }, "chat_completions");
  const response = await post(gatewayPort, "chat_completions");
  await response.body.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pool.failures.size, 0);
  assert.ok(upstreamClosed);
});

test("healthy first-token latency over one second does not rotate accounts", async (t) => {
  const { gatewayPort, pool } = await runFixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res.end(good);
  });
  const response = await post(gatewayPort);
  assert.match(await response.text(), /backup/);
  assert.equal(pool.failures.size, 0);
});

test("split UTF-8 at preflight handoff survives both chat and Messages", async (t) => {
  for (const protocol of ["messages", "chat_completions"]) {
    const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const first = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "start" }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{"content":"`);
      const emoji = Buffer.from("😀");
      res.write(Buffer.concat([first, emoji.subarray(0, 2)]));
      setImmediate(() => res.end(Buffer.concat([emoji.subarray(2), Buffer.from('"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')])));
    }, protocol);
    const response = await post(gatewayPort, protocol);
    const text = await response.text();
    assert.match(text, /😀/);
    assert.doesNotMatch(text, /�/);
    assert.equal(pool.failures.size, 0);
  }
});

test("unsuccessful finish reason is never a successful completion", async (t) => {
  const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n');
  }, "chat_completions");
  const response = await post(gatewayPort, "chat_completions");
  assert.notEqual(response.status, 200);
  assert.deepEqual([...pool.failures], ["a", "b"]);
});

test("unsuccessful finish after visible Messages output cannot synthesize success", async (t) => {
  for (const reason of ["error", "failed", "unknown"]) {
    const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`), 10);
    });
    const response = await post(gatewayPort);
    const text = await response.text();
    assert.match(text, /partial/);
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /event: message_stop/);
    assert.deepEqual([...pool.failures], ["a"]);
  }
});

test("unexpected non-SSE pooled responses are redacted and fail over before output", async (t) => {
  for (const protocol of ["messages", "chat_completions"]) {
    let calls = 0;
    const { gatewayPort, pool } = await runFixture(t, (_req, res) => {
      if (++calls === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "SYNTHETIC_PRIVATE_PROVIDER_DETAIL" } }));
      } else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(good); }
    }, protocol);
    const response = await post(gatewayPort, protocol);
    const text = await response.text();
    assert.match(text, /backup/);
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PROVIDER_DETAIL/);
    assert.deepEqual([...pool.failures], ["a"]);
  }
});

test("pooled direct chat forwards semantic frames before upstream completion", async (t) => {
  let release;
  let signalFinished;
  const upstreamFinished = new Promise((resolve) => { signalFinished = resolve; });
  const { gatewayPort, pool } = await runFixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "early" }, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => { release = resolve; });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    signalFinished();
  }, "chat_completions");
  const response = await post(gatewayPort, "chat_completions");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(response.status, 200);
  assert.match(new TextDecoder().decode(first.value), /early/);
  assert.equal(pool.failures.size, 0, "a stream still in progress is not quarantined");
  release();
  await upstreamFinished;
  let tail = "";
  while (true) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  assert.match(tail, /finish_reason.*stop/);
  assert.match(tail, /\[DONE\]/);
  assert.equal(pool.failures.size, 0);
});
