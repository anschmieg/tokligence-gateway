import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLINE_WORKOS_CLIENT_ID,
  ClineOAuthAdapter,
  classifyClineUpstreamError,
} from "../cline-oauth.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function responseText(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function clineCredentials(accessToken, refreshToken, expiresAt) {
  return {
    success: true,
    data: {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresAt,
      userInfo: {
        subject: "user-1",
        email: "person@example.test",
        name: "Test Person",
        clineUserId: "user-1",
        accounts: null,
      },
    },
  };
}

test("WorkOS device auth stays redacted and persists only registered Cline credentials atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cline-oauth-test-"));
  const credentialsPath = path.join(directory, "credentials.json");
  const requests = [];
  let polls = 0;
  const api = http.createServer(async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/user_management/authorize/device") {
      res.end(JSON.stringify({
        device_code: "workos-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://signin.example.test/device",
        verification_uri_complete: "https://signin.example.test/device?code=ABCD-EFGH",
        expires_in: 300,
        interval: 0.001,
      }));
      return;
    }
    if (req.url === "/user_management/authenticate") {
      polls += 1;
      if (polls === 1) {
        res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" }));
      } else if (polls === 2) {
        res.writeHead(400).end(JSON.stringify({ error: "slow_down" }));
      } else {
        res.end(JSON.stringify({
          access_token: "workos-access-secret",
          refresh_token: "workos-refresh-secret",
          token_type: "Bearer",
        }));
      }
      return;
    }
    if (req.url === "/api/v1/auth/register") {
      res.end(JSON.stringify(clineCredentials(
        "cline-access-secret",
        "cline-refresh-secret",
        new Date(Date.now() + 60 * 60_000).toISOString(),
      )));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  const port = await listen(api);
  t.after(() => close(api));

  const sleeps = [];
  const adapter = new ClineOAuthAdapter({
    provider: {
      api_base_url: `http://127.0.0.1:${port}`,
      workos_base_url: `http://127.0.0.1:${port}`,
      credentials_path: credentialsPath,
      request_timeout_ms: 1000,
      models: [],
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  const started = await adapter.startOAuth();
  assert.deepEqual(started, {
    status: "pending",
    verification_url: "https://signin.example.test/device?code=ABCD-EFGH",
    user_code: "ABCD-EFGH",
    expires_at: started.expires_at,
  });
  assert.ok(Date.parse(started.expires_at) > Date.now());
  assert.doesNotMatch(JSON.stringify(started), /workos-device-secret|access-secret|refresh-secret/);

  const completed = await adapter.waitForOAuthCompletion();
  assert.deepEqual(completed, { status: "authenticated", expires_at: completed.expires_at });
  assert.doesNotMatch(JSON.stringify(completed), /access-secret|refresh-secret|device-secret/);
  assert.deepEqual(sleeps, [1, 1001]);

  assert.equal(requests[0].path, "/user_management/authorize/device");
  assert.match(requests[0].headers["content-type"], /^application\/x-www-form-urlencoded/);
  assert.equal(requests[0].body, `client_id=${CLINE_WORKOS_CLIENT_ID}`);
  for (const request of requests.filter(({ path: requestPath }) => requestPath === "/user_management/authenticate")) {
    assert.equal(
      request.body,
      `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=workos-device-secret&client_id=${CLINE_WORKOS_CLIENT_ID}`,
    );
  }
  const registration = requests.find(({ path: requestPath }) => requestPath === "/api/v1/auth/register");
  assert.deepEqual(JSON.parse(registration.body), {
    accessToken: "workos-access-secret",
    refreshToken: "workos-refresh-secret",
  });

  const persisted = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.deepEqual(persisted, {
    accessToken: "cline-access-secret",
    refreshToken: "cline-refresh-secret",
    expiresAt: persisted.expiresAt,
  });
  assert.doesNotMatch(JSON.stringify(persisted), /workos-access-secret|workos-refresh-secret|workos-device-secret/);
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
});

test("refresh rotation is persisted before inference with exact bearer and truthful unique headers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cline-refresh-test-"));
  const credentialsPath = path.join(directory, "credentials.json");
  const initial = {
    accessToken: "old-cline-access",
    refreshToken: "old-cline-refresh",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  await writeFile(credentialsPath, `${JSON.stringify(initial)}\n`, { mode: 0o644 });
  await chmod(credentialsPath, 0o644);

  const requests = [];
  const api = http.createServer(async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === "/api/v1/auth/refresh") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clineCredentials(
        "rotated-cline-access",
        "rotated-cline-refresh",
        new Date(Date.now() + 60 * 60_000).toISOString(),
      )));
      return;
    }
    if (req.url === "/api/v1/ai/cline/recommended-models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ free: [{ id: "z-ai/glm-free" }] }));
      return;
    }
    if (req.url === "/api/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Upstream": "preserved" });
      res.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(api);
  t.after(() => close(api));

  const adapter = new ClineOAuthAdapter({
    provider: {
      api_base_url: `http://127.0.0.1:${port}`,
      workos_base_url: `http://127.0.0.1:${port}`,
      credentials_path: credentialsPath,
      request_timeout_ms: 1000,
      model_cache_ttl_ms: 300000,
      models: [],
    },
  });
  const payload = {
    model: "cline/z-ai/glm-free",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    parallel_tool_calls: true,
  };
  const first = await adapter.createChatCompletion(payload);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-upstream"], "preserved");
  assert.match(await responseText(first), /data: \[DONE\]/);
  const second = await adapter.createChatCompletion({ ...payload, stream: false });
  await responseText(second);

  const refresh = requests.find(({ path: requestPath }) => requestPath === "/api/v1/auth/refresh");
  assert.deepEqual(JSON.parse(refresh.body), {
    refreshToken: "old-cline-refresh",
    grantType: "refresh_token",
  });
  const inferenceRequests = requests.filter(({ path: requestPath }) => requestPath === "/api/v1/chat/completions");
  assert.equal(inferenceRequests.length, 2);
  assert.equal(inferenceRequests[0].headers.authorization, "Bearer workos:rotated-cline-access");
  assert.equal(inferenceRequests[0].headers["http-referer"], "https://cline.bot");
  assert.equal(inferenceRequests[0].headers["x-title"], "Cline");
  assert.equal(inferenceRequests[0].headers["user-agent"], "Cline/unknown");
  assert.equal(inferenceRequests[0].headers["x-is-multiroot"], "false");
  assert.equal(inferenceRequests[0].headers["x-client-type"], "cline-sdk");
  assert.equal(inferenceRequests[0].headers["x-client-version"], "unknown");
  assert.equal(inferenceRequests[0].headers["x-platform"], "sdk");
  assert.equal(inferenceRequests[0].headers["x-platform-version"], "unknown");
  assert.equal(inferenceRequests[0].headers["x-core-version"], "unknown");
  assert.match(inferenceRequests[0].headers["x-task-id"], /^[0-9a-f-]{36}$/);
  assert.notEqual(inferenceRequests[0].headers["x-task-id"], inferenceRequests[1].headers["x-task-id"]);
  assert.deepEqual(JSON.parse(inferenceRequests[0].body), { ...payload, model: "z-ai/glm-free" });

  const persisted = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(persisted.accessToken, "rotated-cline-access");
  assert.equal(persisted.refreshToken, "rotated-cline-refresh");
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
});

test("model discovery exposes only free models, caches transient failures, and removes retired entries after success", async () => {
  let now = 1_000_000;
  let response = {
    ok: true,
    status: 200,
    json: async () => ({
      free: [{ id: "z-ai/first", name: "First" }, { id: "cline-free/second" }],
      recommended: [{ id: "paid/recommended" }],
      clinePass: [{ id: "paid/pass" }],
      clineCloud: [{ id: "paid/cloud" }],
    }),
  };
  let calls = 0;
  const adapter = new ClineOAuthAdapter({
    provider: {
      api_base_url: "https://cline.invalid",
      workos_base_url: "https://workos.invalid",
      credentials_path: "/tmp/not-read-by-this-test.json",
      model_cache_ttl_ms: 300000,
      models: [],
    },
    now: () => now,
    fetch: async () => {
      calls += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  });

  assert.deepEqual((await adapter.discoverFreeModels()).map(({ id }) => id), [
    "cline/z-ai/first",
    "cline/cline-free/second",
  ]);
  assert.equal(calls, 1);
  await adapter.discoverFreeModels();
  assert.equal(calls, 1, "fresh feed is cached");

  now += 300001;
  response = new Error("transient network failure");
  assert.deepEqual((await adapter.discoverFreeModels()).map(({ id }) => id), [
    "cline/z-ai/first",
    "cline/cline-free/second",
  ]);

  response = {
    ok: true,
    status: 200,
    json: async () => ({
      free: [{ id: "z-ai/first" }],
      recommended: [{ id: "cline-free/second" }],
    }),
  };
  assert.deepEqual((await adapter.discoverFreeModels()).map(({ id }) => id), ["cline/z-ai/first"]);
});


test("logout clears stored credentials and prevents a pending device login from persisting", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cline-logout-test-"));
  const credentialsPath = path.join(directory, "credentials.json");
  let authenticate;
  let registerCalled = false;
  const api = http.createServer(async (req, res) => {
    await requestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/user_management/authorize/device") {
      res.end(JSON.stringify({
        device_code: "logout-device-secret",
        user_code: "WXYZ-1234",
        verification_uri_complete: "https://signin.example.test/device?code=WXYZ-1234",
        expires_in: 300,
        interval: 60,
      }));
      return;
    }
    if (req.url === "/user_management/authenticate") {
      await new Promise((resolve) => { authenticate = resolve; });
      res.end(JSON.stringify({ access_token: "workos-after-logout", refresh_token: "workos-refresh-after-logout" }));
      return;
    }
    if (req.url === "/api/v1/auth/register") {
      registerCalled = true;
      res.end(JSON.stringify(clineCredentials(
        "cline-after-logout",
        "cline-refresh-after-logout",
        new Date(Date.now() + 60 * 60_000).toISOString(),
      )));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  const port = await listen(api);
  t.after(() => close(api));

  const sleeps = [];
  const adapter = new ClineOAuthAdapter({
    provider: {
      api_base_url: `http://127.0.0.1:${port}`,
      workos_base_url: `http://127.0.0.1:${port}`,
      credentials_path: credentialsPath,
      request_timeout_ms: 1000,
      models: [],
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
  });

  const started = await adapter.startOAuth();
  assert.equal(started.status, "pending");
  for (let i = 0; i < 20 && typeof authenticate !== "function"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(typeof authenticate, "function");
  assert.deepEqual(await adapter.logout(), { status: "login_required" });
  authenticate();
  for (let i = 0; i < 20 && !registerCalled; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(registerCalled, true);
  await assert.rejects(readFile(credentialsPath, "utf8"), { code: "ENOENT" });
  assert.deepEqual(await adapter.oauthStatus(), { status: "login_required" });
});

test("safe Cline upstream classifications preserve meaningful statuses without raw upstream bodies", () => {
  assert.deepEqual(classifyClineUpstreamError(401, "token invalid access-secret"), {
    status: 401,
    code: "cline_auth_error",
    message: "Cline login is missing or expired",
  });
  assert.deepEqual(classifyClineUpstreamError(429, "Daily free limit reached on model x. Try again tomorrow"), {
    status: 429,
    code: "cline_daily_free_quota_exhausted",
    message: "Cline's daily free quota is exhausted for this model",
  });
  assert.deepEqual(classifyClineUpstreamError(404, "model not found: retired-paid-id"), {
    status: 404,
    code: "cline_model_retired",
    message: "The requested Cline free model is no longer available",
  });
  assert.doesNotMatch(JSON.stringify(classifyClineUpstreamError(500, "access-secret")), /access-secret/);
});
