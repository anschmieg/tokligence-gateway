import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatBody } from '../native/opencode/bridge-wire.mjs';

function request(body, signal = new AbortController().signal, headers = {}) { return { body, signal, headers: new Headers(headers) }; }

test('native ingestion bounds unknown-length streams and cancels them before draining', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
  await assert.rejects(readChatBody(request(body), { limit: 100 }), error => error.status === 413);
  assert.ok(cancelled); assert.ok(pulls <= 3, 'reader stops at the limit instead of draining the upload');
  let earlyCancelled = false;
  const oversized = new ReadableStream({ cancel() { earlyCancelled = true; } });
  await assert.rejects(readChatBody(request(oversized, undefined, { 'content-length': '101' }), { limit: 100 }), error => error.status === 413);
  assert.ok(earlyCancelled, 'oversized declarations cancel the upload without reading it');
});

test('native ingestion times out stalled streams and honors aborts', async () => {
  let cancelled = false;
  await assert.rejects(readChatBody(request(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 20 }), error => error.status === 408 && error.code === 'native_request_body_timeout');
  assert.ok(cancelled);
  const abort = new AbortController();
  const pending = readChatBody(request(new ReadableStream(), abort.signal));
  abort.abort();
  await assert.rejects(pending, error => error.code === 'native_request_cancelled');
});

test('native ingestion preserves UTF-8 split between chunks', async () => {
  const data = new TextEncoder().encode('hello 🌍');
  const body = new ReadableStream({ start(controller) { controller.enqueue(data.slice(0, 8)); controller.enqueue(data.slice(8)); controller.close(); } });
  assert.equal(await readChatBody(request(body)), 'hello 🌍');
});

test('native ingestion rejects malformed encoding and framing explicitly', async () => {
  await assert.rejects(readChatBody(request(null, undefined, { 'content-length': '-1' })), error => error.status === 400 && error.code === 'native_request_length_invalid');
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
  await assert.rejects(readChatBody(request(body)), error => error.status === 400 && error.code === 'native_request_encoding_invalid');
});

test('native ingestion handles tiny fragments and a non-resolving source cancellation', async () => {
  let remaining = 1000;
  const fragments = new ReadableStream({ pull(controller) { if (remaining--) controller.enqueue(new Uint8Array([97])); else controller.close(); } });
  assert.equal((await readChatBody(request(fragments), { limit: 1000 })).length, 1000);
  const stuckCancel = new ReadableStream({ cancel() { return new Promise(() => {}); } });
  await assert.rejects(readChatBody(request(stuckCancel), { timeoutMs: 20 }), error => error.code === 'native_request_body_timeout');
  const mismatch = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([97])); controller.close(); } });
  await assert.rejects(readChatBody(request(mismatch, undefined, { 'content-length': '2' })), error => error.code === 'native_request_length_invalid');
});
