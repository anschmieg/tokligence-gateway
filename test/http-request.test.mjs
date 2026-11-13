import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readRequestBody, parseRequestObject } from "../http-request.mjs";

test("bounded readers reject chunked excess and partial-body deadlines", async () => {
  const req = new PassThrough(); req.headers = {};
  const result = readRequestBody(req, { limit: 4 });
  req.write("123"); req.write("45");
  await assert.rejects(result, { statusCode: 413 });
  req.end();
  const slow = new PassThrough(); slow.headers = {};
  const deadline = readRequestBody(slow, { timeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(deadline, { statusCode: 408 }); }
  finally { clearTimeout(keepAlive); slow.end(); }
});

test("JSON request roots must be objects", () => {
  for (const value of ["null", "[]", '"text"', "42", "false"]) assert.throws(() => parseRequestObject(Buffer.from(value)));
  assert.deepEqual(parseRequestObject(Buffer.from('{"model":"test"}')), { model: "test" });
});
