import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { observeUpstreamResponse, recordModelFamily } from "../request-executor.mjs";

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
