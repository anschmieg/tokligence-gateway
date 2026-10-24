import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTokenProvider, credentialExpiry, needsRefresh, readCredential } from "../opencode-zen-credential.mjs";
import { requestId, shapeZenRequest, zenHeaders } from "../opencode-zen-gate.mjs";

function credentialFile(credential) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zen-cred-")), "oauth.json");
  fs.writeFileSync(file, JSON.stringify(credential));
  return file;
}

test("a Console API key is never enough, so the provider needs an OAuth credential", () => {
  const file = credentialFile({ access: "st_abc", refresh: "rt_abc", expires: Date.now() + 3_600_000 });
  assert.equal(readCredential(file).access, "st_abc");
  assert.equal(readCredential(`${file}.missing`), null);
});

test("expiry is honoured in both seconds and milliseconds", () => {
  assert.equal(credentialExpiry({ expires: 2_000_000_000_000 }), 2_000_000_000_000);
  assert.equal(credentialExpiry({ expires: 2_000_000_000 }), 2_000_000_000_000);
  assert.equal(credentialExpiry({}), Number.POSITIVE_INFINITY);
});

test("a token is refreshed before it expires, not after it fails", async () => {
  const file = credentialFile({ access: "st_old", refresh: "rt_one", expires: Date.now() + 60_000 });
  const calls = [];
  const provider = createTokenProvider({
    file,
    tokenUrl: "https://opencode.ai/console/oauth/token",
    clientId: "client",
    skewMs: 10 * 60 * 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: new URLSearchParams(options.body).get("grant_type") });
      return new Response(JSON.stringify({ access_token: "st_new", refresh_token: "rt_two", expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(await provider.authorization(), "Bearer st_new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "refresh_token");
  // The rotated token and refresh token are persisted for the next process.
  const stored = readCredential(file);
  assert.equal(stored.access, "st_new");
  assert.equal(stored.refresh, "rt_two");
  assert.ok(stored.expires > Date.now() + 3_500_000);
});

test("a still-valid token is returned untouched", async () => {
  const file = credentialFile({ access: "st_fresh", refresh: "rt_one", expires: Date.now() + 3_600_000 });
  let called = 0;
  const provider = createTokenProvider({
    file,
    tokenUrl: "https://opencode.ai/console/oauth/token",
    fetchImpl: async () => {
      called += 1;
      return new Response("{}", { status: 500 });
    },
  });
  assert.equal(await provider.authorization(), "Bearer st_fresh");
  assert.equal(called, 0);
});

test("concurrent requests share a single refresh", async () => {
  const file = credentialFile({ access: "st_old", refresh: "rt_one", expires: Date.now() - 1 });
  let calls = 0;
  const provider = createTokenProvider({
    file,
    tokenUrl: "https://opencode.ai/console/oauth/token",
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: "st_new", expires_in: 3600 }), { status: 200 });
    },
  });
  const results = await Promise.all([provider.authorization(), provider.authorization(), provider.authorization()]);
  assert.equal(calls, 1);
  assert.deepEqual(results, ["Bearer st_new", "Bearer st_new", "Bearer st_new"]);
});

test("a failed refresh keeps serving the old token until it expires", async () => {
  const file = credentialFile({ access: "st_old", refresh: "rt_one", expires: Date.now() + 30_000 });
  const provider = createTokenProvider({
    file,
    tokenUrl: "https://opencode.ai/console/oauth/token",
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });
  assert.equal(await provider.authorization(), "Bearer st_old");
});

test("an expired token with a failed refresh reports why", async () => {
  const file = credentialFile({ access: "st_old", refresh: "rt_one", expires: Date.now() - 1000 });
  const provider = createTokenProvider({
    file,
    tokenUrl: "https://opencode.ai/console/oauth/token",
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });
  await assert.rejects(provider.authorization(), /token has expired/);
});

test("every request carries the OpenCode identity the gate checks", () => {
  // Captured from a current client talking to the inference endpoint: the
  // organisation id, x-session-id and x-session-affinity are all required, and
  // v2 reports a channel in the user-agent.
  const headers = zenHeaders({
    session: "ses_abc",
    authorization: "Bearer st_abc",
    clientVersion: "2.0.32",
    orgId: "wrk_test",
  });
  assert.equal(headers["user-agent"], "opencode/latest/2.0.32/cli");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-session"], "ses_abc");
  assert.equal(headers["x-session-id"], "ses_abc");
  assert.equal(headers["x-session-affinity"], "ses_abc");
  assert.equal(headers["x-opencode-org-id"], "wrk_test");

  // A v1 client reports no channel, and the request id it used to send is gone.
  const v1 = zenHeaders({ session: "ses_abc", authorization: "Bearer st_abc", clientVersion: "1.18.32" });
  assert.equal(v1["user-agent"], "opencode/1.18.32/cli");
  assert.equal(v1["x-opencode-request"], undefined);
  assert.notEqual(requestId(), requestId());
});

test("Zen preserves caller tools and forces streaming without injecting built-ins", () => {
  const tools = [{ type: "function", function: { name: "lookup_weather", description: "Forecast", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  const shaped = shapeZenRequest({ model: "space-bunny-free", stream: false, messages: [{ role: "user", content: "hi" }], tools });
  assert.equal(shaped.stream, true);
  assert.deepEqual(shaped.stream_options, { include_usage: true });
  assert.deepEqual(shaped.tools, tools);
  assert.deepEqual(shapeZenRequest({ messages: [] }).tools, undefined);
});