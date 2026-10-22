import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { EventEmitter } from "node:events";
import { executeRoutePlan, observeUpstreamResponse, recordModelFamily } from "../request-executor.mjs";
import { startAttempt } from "../provider-adapters.mjs";

function mockRequestResponse() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(body = "") { this.body = String(body); this.writableEnded = true; this.emit("finish"); },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  return { req, res };
}

function simplePlan(deadline = Date.now() + 1000) {
  return {
    publicModel: "test-model", deadline, required: { streaming: false },
    candidates: [{ provider: { id: "injected", adapter: "middleware" }, upstreamModel: "upstream-model", protocol: "messages" }],
  };
}

test("aborted setup returns a response-start timeout promptly and destroys a late attempt", async () => {
  const { req, res } = mockRequestResponse();
  let release;
  let lateResponse;
  const setup = new Promise((resolve) => { release = resolve; });
  const startedAt = Date.now();
  const execution = executeRoutePlan({
    plan: simplePlan(), req, res, path: "/v1/messages", body: { model: "test-model" },
    env: { GATEWAY_RESPONSE_START_TIMEOUT_MS: "20" },
    startAttempt: () => setup,
  });
  await execution;
  assert.ok(Date.now() - startedAt < 500, "setup timeout should not wait for adapter resolution");
  assert.equal(res.statusCode, 504);
  assert.match(res.body, /Gateway response deadline exceeded/);

  lateResponse = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  const lateUpstream = { destroyed: false, destroy() { this.destroyed = true; } };
  release({ response: lateResponse, upstream: lateUpstream });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateResponse.destroyed, true);
  assert.equal(lateUpstream.destroyed, true);
});

test("an already-aborted route never starts adapter setup", async () => {
  const { req, res } = mockRequestResponse();
  let calls = 0;
  const result = await executeRoutePlan({
    plan: simplePlan(Date.now() - 1), req, res, path: "/v1/messages", body: { model: "test-model" },
    startAttempt: () => { calls++; throw new Error("adapter setup must not start"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.committed, false);
  assert.equal(res.statusCode, 504);
});

test("already-aborted OpenCode setup rejects before accessing credentials or sessions", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before setup");
  controller.abort(reason);
  await assert.rejects(startAttempt({ candidate: { provider: { id: "zen", adapter: "opencode-zen" } }, signal: controller.signal }), error => error === reason);
});

test("client disconnect interrupts stalled setup without writing a response", async () => {
  const { req, res } = mockRequestResponse();
  const execution = executeRoutePlan({
    plan: simplePlan(), req, res, path: "/v1/messages", body: {},
    startAttempt: () => new Promise(() => {}),
  });
  req.emit("aborted");
  await execution;
  assert.equal(res.headersSent, false);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("upstream observation captures bounded successful response bytes and attribution once", async () => {
  const response = new PassThrough();
  response.headers = { "x-ratelimit-remaining": "tokens=120" };
  const seen = [];
  observeUpstreamResponse(response, { provider: { id: "mistral" }, upstreamModel: "mistral-small" }, event => seen.push(event));
  response.end(Buffer.from('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'));
  await new Promise(resolve => response.once("end", resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, "mistral");
  assert.equal(seen[0].model, "mistral-small");
  assert.equal(Buffer.concat(seen[0].chunks).toString(), '{"usage":{"prompt_tokens":3,"completion_tokens":2}}');
  assert.equal(seen[0].headers["x-ratelimit-remaining"], "tokens=120");
});

test("session family history is bounded and stores no model or transcript data", () => {
  const runtimeState = { modelHistory: new Map() };
  for (let index = 0; index < 20; index += 1) {
    recordModelFamily(runtimeState, "session", { family: `family-${index}`, upstreamModel: `private-model-${index}` });
  }
  const entry = runtimeState.modelHistory.get("session");
  assert.equal(entry.families.length, 16);
  assert.equal(entry.families[0], "family-4");
  assert.equal(JSON.stringify(entry).includes("private-model"), false);
});

test("session family history evicts least-recently-used sessions at its bound", () => {
  const runtimeState = { modelHistory: new Map() };
  for (let index = 0; index < 1001; index += 1) {
    recordModelFamily(runtimeState, `session-${index}`, { family: "family-a" });
  }
  assert.equal(runtimeState.modelHistory.size, 1000);
  assert.equal(runtimeState.modelHistory.has("session-0"), false);
  assert.equal(runtimeState.modelHistory.has("session-1000"), true);
});
