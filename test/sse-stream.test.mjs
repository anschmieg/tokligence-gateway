import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseWriter, endSseError, sseHeaders } from "../sse-stream.mjs";

function response() {
  return Object.assign(new EventEmitter(), {
    chunks: [], writableNeedDrain: false,
    write(chunk) { this.chunks.push(chunk); return !this.writableNeedDrain; },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; this.emit("finish"); },
  });
}

test("backpressured SSE writes resume without losing frames and clean listeners", async () => {
  const res = response();
  const aborter = new AbortController();
  const writer = createSseWriter(res, aborter.signal);
  res.writableNeedDrain = true;
  const write = writer.write("frame\n\n");
  assert.equal(res.chunks.length, 0);
  res.writableNeedDrain = false;
  res.emit("drain");
  assert.equal(await write, true);
  assert.deepEqual(res.chunks, ["frame\n\n"]);
  writer.cleanup();
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("abort releases pending backpressure and prevents later writes", async () => {
  const res = response();
  const aborter = new AbortController();
  const writer = createSseWriter(res, aborter.signal);
  res.writableNeedDrain = true;
  const write = writer.write("not sent");
  aborter.abort(new Error("timeout"));
  await assert.rejects(write, /timeout/);
  assert.equal(await writer.write("not sent either"), false);
  endSseError(res, aborter.signal);
  assert.match(res.chunks.join(""), /Gateway deadline exceeded/);
  writer.cleanup();
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("heartbeats stop after completion and do not accumulate under backpressure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const res = response();
  const writer = createSseWriter(res, undefined, 10);
  t.mock.timers.tick(10);
  assert.equal(res.chunks.length, 1);
  res.writableNeedDrain = true;
  t.mock.timers.tick(100);
  assert.equal(res.chunks.length, 1);
  res.end();
  t.mock.timers.tick(100);
  assert.equal(res.chunks.length, 1);
  assert.equal(res.listenerCount("close"), 0);
  writer.cleanup();
});

test("SSE headers remove obsolete body framing and disconnect emits no error", () => {
  const headers = sseHeaders({ "content-length": "123", "transfer-encoding": "chunked", "x-custom": "ok" });
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["transfer-encoding"], undefined);
  assert.equal(headers["x-custom"], "ok");
  const res = response();
  const aborter = new AbortController();
  aborter.abort(Object.assign(new Error("disconnect"), { code: "CLIENT_DISCONNECTED" }));
  endSseError(res, aborter.signal);
  assert.deepEqual(res.chunks, []);
});
