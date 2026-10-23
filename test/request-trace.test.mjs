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

test("request trace accepts only bounded phase diagnostics", () => {
  const { trace, lines } = harness();
  trace.emit("setup_phase_start", { phase: "session_id", outcome: "ok", duration_ms: 12, sessionId: "private-session", host: "secret.example" });
  trace.emit("setup_phase_end", { phase: "secret-value", outcome: "secret-value", duration_ms: -1 });
  const serialized = JSON.stringify(lines);
  assert.match(serialized, /session_id/);
  assert.match(serialized, /duration_ms/);
  assert.doesNotMatch(serialized, /private-session|secret\.example|secret-value/);
  assert.equal(lines[2].phase, undefined);
  assert.equal(lines[2].duration_ms, undefined);
});

test("request trace allows only safe diagnostic phase and outcome enums", () => {
  const { trace, lines } = harness();
  trace.emit("transport_phase_end", { phase: "upstream_headers_wait", outcome: "timeout", attempt_number: 2, duration_ms: 90000, host: "private.example" });
  trace.emit("attempt_failed", { phase: "pool_selection", outcome: "exhausted", code: "OPENCODE_POOL_EXHAUSTED", attempt_number: 3 });
  const serialized = JSON.stringify(lines);
  assert.match(serialized, /upstream_headers_wait/);
  assert.match(serialized, /OPENCODE_POOL_EXHAUSTED/);
  assert.match(serialized, /exhausted/);
  assert.match(serialized, /attempt_number/);
  assert.doesNotMatch(serialized, /private\.example/);
});

test("request trace exposes only allowlisted Cline diagnostic fields", () => {
  const { trace, lines } = harness();
  trace.emit("cline_upstream_failure", {
    status: 500,
    cline_classification: "cline_upstream_error",
    cline_error_code: "invalid_request_error",
    cline_content_type: "application_json",
    request_body_bytes: 54000,
    request_tool_count: 3,
    request_message_count: 8,
    request_max_tokens: 8192,
    request_has_tools: true,
    request_stream: true,
    request_has_tool_choice: true,
    prompt: "private prompt",
    tool_name: "private tool name",
    raw_error: "private error",
    cline_error_code_raw: "attacker-controlled",
    request_model: "private model",
  });
  trace.emit("cline_upstream_failure", {
    cline_error_code: "arbitrary-provider-detail",
    cline_content_type: "text/plain; secret=1",
    request_body_bytes: -1,
    request_tool_count: 1.5,
    request_has_tools: "yes",
  });
  const serialized = JSON.stringify(lines);
  assert.match(serialized, /invalid_request_error/);
  assert.match(serialized, /application_json/);
  assert.match(serialized, /54000/);
  assert.match(serialized, /request_has_tool_choice/);
  assert.doesNotMatch(serialized, /private prompt|private tool name|private error|attacker-controlled|private model|arbitrary-provider-detail|text\/plain|secret=1/);
  assert.equal(lines[2].request_body_bytes, undefined);
  assert.equal(lines[2].request_tool_count, undefined);
  assert.equal(lines[2].request_has_tools, undefined);
});

test("request trace allows only explicitly safe provider error codes", () => {
  const { trace, lines } = harness();
  trace.emit("upstream_429", { upstream_error_code: "FreeUsageLimitError", provider_error_code: "secret-provider-code", category: "accountquota" });
  const serialized = JSON.stringify(lines);
  assert.match(serialized, /FreeUsageLimitError/);
  assert.doesNotMatch(serialized, /secret-provider-code/);
});

test("request trace drops unsafe identifiers and bounds CF-Ray", () => {
  assert.equal(safeTraceId("x".repeat(129)), null);
  assert.equal(safeTraceId("ray/with newline\n"), null);
  const { lines } = harness({ "cf-ray": "ray/with newline\n" });
  assert.equal("cf_ray" in lines[0], false);
});
