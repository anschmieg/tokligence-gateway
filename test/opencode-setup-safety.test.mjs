import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startAttempt } from "../provider-adapters.mjs";
import { executeRoutePlan } from "../request-executor.mjs";

const candidate = { provider: { id: "zen", adapter: "opencode-zen", base_url: "http://127.0.0.1:1" }, model: { id: "beam-free" }, upstreamModel: "beam-free", protocol: "messages" };
const body = { model: "beam-free", stream: true, messages: [{ role: "user", content: "synthetic" }] };
function pool(blocked, failure = null) {
  const account = { id: "primary" };
  let quarantines = 0;
  return {
    maxAttempts: 1, state: new Map([[account.id, { generation: 0 }]]), select: () => account,
    servicesFor: () => ({ tokens: { authorization: async () => "Bearer synthetic", credential: async () => ({}) }, sessions: {
      sessionId: async () => { if (failure) throw new Error(failure); return blocked === "mint" ? new Promise(() => {}) : { id: "fixture" }; },
      clientVersion: async () => blocked === "version" ? new Promise(() => {}) : "1.18.32",
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
