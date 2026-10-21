import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { EventEmitter, once } from "node:events";

import {
  anthropicMessageToSse,
  joinParts,
  normalizeAnthropicEvent,
  normalizeAnthropicMessage,
  respondWithAnthropicPassthrough,
} from "../anthropic-passthrough.mjs";
import { collectAnthropicStream } from "../anthropic-openai-codec.mjs";

// Captured from https://api.mistral.ai/v1/messages through this gateway. The
// `text` field is an ARRAY of sub-blocks (reasoning first, answer last) where
// the Anthropic schema wants a string, and it arrives as JSON even when the
// caller asked for a stream.
const MISSHAPED = {
  type: "message",
  id: "e223539b557e41c0a855a9f9f096d470",
  model: "mistral/zai-glm-5-3",
  role: "assistant",
  content: [{
    type: "text",
    text: [
      {
        type: "thinking",
        thinking: [{ type: "text", text: "The user asked me to reply with exactly \"OK\"." }],
        closed: true,
      },
      { type: "text", text: "OK" },
    ],
  }],
  stop_reason: "end_turn",
  usage: { input_tokens: 17, output_tokens: 49 },
};

function upstream(headers) {
  const stream = new Readable({ read() {} });
  stream.headers = headers;
  return stream;
}

function clientResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    write(chunk) { this.body += Buffer.from(chunk).toString("utf8"); this.emit("write", this.body); this.onWrite?.(this.body); return true; },
    end(chunk) {
      if (chunk) this.body += Buffer.from(chunk).toString("utf8");
      this.completed = true;
      this.writableEnded = true;
      this.emit("finish");
    },
  });
}

test("a sub-block array in `text` becomes a plain string block", () => {
  const { message, changed } = normalizeAnthropicMessage(MISSHAPED);
  assert.equal(changed, true);
  assert.deepEqual(message.content, [{ type: "text", text: "OK" }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(message.usage, { input_tokens: 17, output_tokens: 49 });
  assert.equal(message.model, "mistral/zai-glm-5-3");
});

test("reasoning survives when the caller asked for extended thinking", () => {
  const { message } = normalizeAnthropicMessage(MISSHAPED, { keepReasoning: true });
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].type, "thinking");
  assert.equal(message.content[0].thinking, "The user asked me to reply with exactly \"OK\".");
  assert.deepEqual(message.content[1], { type: "text", text: "OK" });
});

test("signed compaction blocks and the compaction stop reason survive normalization", () => {
  const summary = { type: "compaction", content: "signed summary", signature: "opaque-signature" };
  const source = { type: "message", content: [summary], stop_reason: "compaction", usage: { input_tokens: 0, output_tokens: 0, iterations: 3 } };
  const { message, changed } = normalizeAnthropicMessage(source);
  assert.equal(changed, false);
  assert.deepEqual(message.content, [summary]);
  assert.equal(message.stop_reason, "compaction");
  assert.deepEqual(message.usage, source.usage);
  const folded = collectAnthropicStream([anthropicMessageToSse(message)]);
  assert.deepEqual(folded.content, [summary]);
  assert.equal(folded.stop_reason, "compaction");
  assert.deepEqual(folded.usage, source.usage);
});

test("a conforming message is reported unchanged", () => {
  const conforming = { ...MISSHAPED, content: [{ type: "text", text: "OK" }] };
  const { message, changed } = normalizeAnthropicMessage(conforming);
  assert.equal(changed, false);
  assert.deepEqual(message, conforming);
});

test("a reasoning-only answer never collapses to an empty content array", () => {
  const source = { ...MISSHAPED, content: [{ type: "text", text: [{ type: "thinking", thinking: [{ type: "text", text: "only reasoning" }] }] }] };
  const { message } = normalizeAnthropicMessage(source);
  assert.deepEqual(message.content, [{ type: "text", text: "only reasoning" }]);
});

test("tool_use blocks and nested text arrays are preserved", () => {
  const source = {
    ...MISSHAPED,
    content: [{ type: "text", text: [{ type: "tool_use", id: "t1", name: "lookup", input: { city: "Paris" } }] }],
  };
  assert.deepEqual(normalizeAnthropicMessage(source).message.content, [
    { type: "tool_use", id: "t1", name: "lookup", input: { city: "Paris" } },
  ]);
  assert.equal(joinParts([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(joinParts(null), "");
});

test("a synthesised stream carries the full Anthropic event sequence", () => {
  const { message } = normalizeAnthropicMessage(MISSHAPED);
  const sse = anthropicMessageToSse(message);
  const types = [...sse.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.ok(sse.endsWith("\n\n"));
  const payloads = [...sse.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(payloads.find((event) => event.type === "message_start").message.content, []);
  assert.equal(payloads.find((event) => event.type === "content_block_delta").delta.text, "OK");
  const folded = collectAnthropicStream([sse]);
  assert.deepEqual(folded.content, message.content);
  assert.deepEqual(folded.usage, message.usage);
});

test("a malformed SSE frame is repaired, a clean one is left alone", () => {
  const repaired = normalizeAnthropicEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: [{ type: "text", text: "part" }] },
  });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.event.content_block.text, "part");
  assert.equal(normalizeAnthropicEvent({ type: "message_stop" }).changed, false);
});

test("a misshapen JSON body is normalised for a non-streaming caller", async () => {
  const res = clientResponse();
  const headers = { "content-type": "application/json", "content-length": "662", "x-gateway-request-id": "r1" };
  const response = upstream(headers);
  response.push(JSON.stringify(MISSHAPED));
  response.push(null);
  assert.equal(await respondWithAnthropicPassthrough({ response, res, status: 200, headers, wantStream: false }), true);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["content-length"], String(Buffer.byteLength(res.body)));
  assert.equal(res.headers["x-gateway-request-id"], "r1");
  assert.deepEqual(JSON.parse(res.body).content, [{ type: "text", text: "OK" }]);
});

test("a misshapen JSON body becomes a real stream for a streaming caller", async () => {
  const res = clientResponse();
  const headers = { "content-type": "application/json", "content-length": "662" };
  const response = upstream(headers);
  response.push(JSON.stringify(MISSHAPED));
  response.push(null);
  assert.equal(await respondWithAnthropicPassthrough({ response, res, status: 200, headers, wantStream: true }), true);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.equal(res.headers["content-length"], undefined);
  assert.match(res.body, /^event: message_start/);
  assert.match(res.body, /event: message_stop/);
  assert.equal(collectAnthropicStream([res.body]).content[0].text, "OK");
});

test("a conforming JSON body keeps its upstream bytes and headers", async () => {
  const conforming = JSON.stringify({ ...MISSHAPED, content: [{ type: "text", text: "OK" }] });
  const res = clientResponse();
  const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(conforming)) };
  const response = upstream(headers);
  response.push(conforming);
  response.push(null);
  assert.equal(await respondWithAnthropicPassthrough({ response, res, status: 200, headers, wantStream: false }), true);
  assert.equal(res.body, conforming);
  assert.equal(res.headers["content-length"], headers["content-length"]);
});

test("a healthy upstream stream is relayed intact and an empty one is not a failure", async () => {
  const frames = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const res = clientResponse();
  const headers = { "content-type": "text/event-stream" };
  const response = upstream(headers);
  response.push(frames);
  response.push(null);
  assert.equal(await respondWithAnthropicPassthrough({ response, res, status: 200, headers, wantStream: true }), true);
  assert.equal(res.body, frames);

  const empty = clientResponse();
  const emptyResponse = upstream(headers);
  emptyResponse.push(null);
  assert.equal(await respondWithAnthropicPassthrough({ response: emptyResponse, res: empty, status: 200, headers, wantStream: true }), true);
  assert.equal(empty.body, "");
});

test("native SSE streams incrementally, normalizes split CRLF frames and decodes split UTF-8", async () => {
  const res = clientResponse();
  const response = upstream({ "content-type": "text/event-stream" });
  const utf8 = Buffer.from('event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"é"}}\r\n\r\n');
  const run = respondWithAnthropicPassthrough({ response, res, status: 200, headers: response.headers, wantStream: true });
  response.push(utf8.subarray(0, utf8.length - 1));
  response.push(utf8.subarray(utf8.length - 1));
  response.push(null);
  await run;
  assert.match(res.body, /é/);
  assert.equal(res.headers["x-accel-buffering"], "no");
});

test("native frames arrive before EOF and preserve fragmented UTF-8 and CRLF bytes", async () => {
  const res = clientResponse();
  const response = upstream({ "content-type": "text/event-stream" });
  const frame = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"é"}}\r\n\r\n';
  const bytes = Buffer.from(frame);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const run = respondWithAnthropicPassthrough({ response, res, status: 200, headers: response.headers, wantStream: true });
  response.push(bytes.subarray(0, split));
  const delivered = once(res, "write");
  response.push(bytes.subarray(split));
  await delivered;
  assert.equal(res.body, frame);
  assert.equal(res.completed, undefined);
  response.push(null);
  await run;
});

test("multiline native data receives the existing malformed-text repair", async () => {
  const res = clientResponse();
  const response = upstream({ "content-type": "text/event-stream" });
  response.push('event: content_block_start\r\ndata: {"type":"content_block_start",\r\ndata: "index":0,"content_block":{"type":"text","text":[{"type":"text","text":"OK"}]}}\r\n\r\n');
  response.push(null);
  await respondWithAnthropicPassthrough({ response, res, status: 200, headers: response.headers, wantStream: true });
  assert.match(res.body, /"text":"OK"/);
});

test("many small native frames may exceed the per-frame limit in one chunk", async () => {
  const res = clientResponse();
  const response = upstream({ "content-type": "text/event-stream" });
  const frames = ': healthy\n\n'.repeat(100000);
  response.push(frames);
  response.push(null);
  await respondWithAnthropicPassthrough({ response, res, status: 200, headers: response.headers, wantStream: true });
  assert.equal(res.body, frames);
});

test("an oversized partial native frame terminates with a stream error", async () => {
  const res = clientResponse();
  const response = upstream({ "content-type": "text/event-stream" });
  response.push('data: ' + 'x'.repeat(1024 * 1024));
  response.push(null);
  await assert.rejects(respondWithAnthropicPassthrough({ response, res, status: 200, headers: response.headers, wantStream: true }), /frame exceeds/);
  assert.match(res.body, /event: error/);
  assert.equal(res.completed, true);
});

test("a non-Anthropic content type is declined before the body is read", async () => {
  const res = clientResponse();
  const headers = { "content-type": "text/plain" };
  const response = upstream(headers);
  assert.equal(await respondWithAnthropicPassthrough({ response, res, status: 200, headers, wantStream: false }), false);
  assert.equal(res.headers, null);
});
