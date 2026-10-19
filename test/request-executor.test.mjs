import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { observeUpstreamResponse } from "../request-executor.mjs";

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
