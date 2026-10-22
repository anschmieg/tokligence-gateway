import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequestTrace, safeTraceId } from "../request-trace.mjs";

function harness(headers = {}) {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/v1/messages?secret=query", headers });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
  const lines = [];
  const trace = createRequestTrace(req, res, { logger: (line) => lines.push(JSON.parse(line)) });
  return { req, res, trace, lines };
}

test("request trace logs only sanitized metadata and shares generated ID", () => {
  const { req, res, trace, lines } = harness({ "cf-ray": "abc123-SEA", "content-length": "5", authorization: "secret" });
  assert.match(trace.id, /^[0-9a-f-]{36}$/);
  trace.model("claude-test");
  trace.emit("attempt_start", { provider: "provider-1", upstream_model: "model-x", prompt: "do not log" });
  req.emit("data", Buffer.from("hello"));
  req.emit("end");
  res.writableEnded = true;
  res.emit("finish");
  const serialized = JSON.stringify(lines);
  assert.match(serialized, new RegExp(trace.id));
  assert.match(serialized, /abc123-SEA/);
  assert.equal(lines.find((line) => line.event === "body_done").body_bytes, 5);
  assert.doesNotMatch(serialized, /secret|prompt|do not log/);
  assert.equal(lines[0].path, "/v1/messages");
});

test("request trace drops unsafe identifiers and bounds CF-Ray", () => {
  assert.equal(safeTraceId("x".repeat(129)), null);
  assert.equal(safeTraceId("ray/with newline\n"), null);
  const { lines } = harness({ "cf-ray": "ray/with newline\n" });
  assert.equal("cf_ray" in lines[0], false);
});
