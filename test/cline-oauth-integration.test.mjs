import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy startup timed out")), 8000);
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/tgw-proxy :(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited during startup with code ${code}: ${output}`));
    });
  });
}

async function waitForAuthenticated(baseUrl, headers) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/cline/oauth/status`, { headers });
    const body = await response.json();
    if (body.status === "authenticated") return body;
    if (body.status === "error" || body.status === "expired") {
      throw new Error(`OAuth failed: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("OAuth did not complete");
}

test("native Cline OAuth endpoints and free-model inference are redacted, direct, and fail-closed", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "cline-gateway-test-"));
  const credentialsPath = path.join(dataDirectory, "credentials.json");
  const clineRequests = [];
  let tokenPolls = 0;
  const cline = http.createServer(async (req, res) => {
    const body = await readBody(req);
    clineRequests.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/user_management/authorize/device") {
      res.end(JSON.stringify({
        device_code: "device-secret",
        user_code: "CLINE-CODE",
        verification_uri: "https://verify.example.test/device",
        expires_in: 300,
        interval: 0.001,
      }));
      return;
    }
    if (req.url === "/user_management/authenticate") {
      tokenPolls += 1;
      if (tokenPolls === 1) {
        res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" }));
      } else {
        res.end(JSON.stringify({ access_token: "workos-access", refresh_token: "workos-refresh" }));
      }
      return;
    }
    if (req.url === "/api/v1/auth/register") {
      res.end(JSON.stringify({
        success: true,
        data: {
          accessToken: "cline-access",
          refreshToken: "cline-refresh",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          userInfo: { subject: "user-1", email: "x@example.test", name: "X", clineUserId: "user-1", accounts: null },
        },
      }));
      return;
    }
    if (req.url === "/api/v1/ai/cline/recommended-models") {
      res.end(JSON.stringify({
        free: [{ id: "z-ai/glm-free", name: "GLM Free" }, { id: "z-ai/quota-free" }],
        recommended: [{ id: "paid/recommended" }],
        clinePass: [{ id: "paid/pass" }],
        clineCloud: [{ id: "paid/cloud" }],
      }));
      return;
    }
    if (req.url === "/api/v1/chat/completions") {
      const parsed = JSON.parse(body);
      if (parsed.model === "z-ai/quota-free") {
        res.writeHead(429).end(JSON.stringify({ error: "Daily free limit reached on model z-ai/quota-free. Try again tomorrow" }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "X-Cline-Stream": "yes" });
        res.end("data: {\"choices\":[{\"delta\":{\"content\":\"native\"}}]}\n\ndata: [DONE]\n\n");
      } else {
        res.end(JSON.stringify({ id: "chatcmpl-test", choices: [{ message: { role: "assistant", content: "native" } }] }));
      }
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  const clinePort = await listen(cline);

  let fallbackPosts = 0;
  const tokligence = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "minimax-m2.7" }] }));
      return;
    }
    fallbackPosts += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "paid fallback" } }] }));
  });
  const tokligencePort = await listen(tokligence);

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TGW_HOST: "127.0.0.1",
      TGW_PORT: String(tokligencePort),
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      CLINE_API_BASE_URL: `http://127.0.0.1:${clinePort}`,
      CLINE_WORKOS_BASE_URL: `http://127.0.0.1:${clinePort}`,
      CLINE_OAUTH_CREDENTIALS_PATH: credentialsPath,
      CODEX_PROXY_ENABLED: "false",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENCODE_API_KEY: "",
      MISTRAL_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(cline), close(tokligence)]);
  });

  const proxyPort = await waitForProxy(child);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const publicHeaders = { Authorization: "Bearer public-secret", "Content-Type": "application/json" };
  const adminHeaders = { Authorization: "Bearer admin-secret" };

  const missingLogin = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({ model: "cline/z-ai/glm-free", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(missingLogin.status, 401);
  assert.equal((await missingLogin.json()).error.code, "cline_login_required");
  assert.equal(fallbackPosts, 0);

  const deniedStart = await fetch(`${baseUrl}/admin/cline/oauth/start`, { method: "POST", headers: publicHeaders });
  assert.equal(deniedStart.status, 401);
  const startedResponse = await fetch(`${baseUrl}/admin/cline/oauth/start`, { method: "POST", headers: adminHeaders });
  assert.equal(startedResponse.status, 202);
  const startedText = await startedResponse.text();
  const started = JSON.parse(startedText);
  assert.equal(started.status, "pending");
  assert.equal(started.verification_url, "https://verify.example.test/device");
  assert.equal(started.user_code, "CLINE-CODE");
  assert.ok(started.expires_at);
  assert.doesNotMatch(startedText, /device-secret|access|refresh/);

  const authenticated = await waitForAuthenticated(baseUrl, adminHeaders);
  assert.equal(authenticated.status, "authenticated");
  assert.doesNotMatch(JSON.stringify(authenticated), /cline-access|cline-refresh|workos/);

  const modelResponse = await fetch(`${baseUrl}/v1/models`, { headers: publicHeaders });
  assert.equal(modelResponse.status, 200);
  const modelIds = (await modelResponse.json()).data.map(({ id }) => id);
  assert.ok(modelIds.includes("cline/z-ai/glm-free"));
  assert.ok(modelIds.includes("cline/z-ai/quota-free"));
  assert.ok(!modelIds.some((id) => /paid|recommended|pass|cloud/.test(id)));

  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
  const stream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({
      model: "cline/z-ai/glm-free",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      tools,
      parallel_tool_calls: true,
    }),
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("x-cline-stream"), "yes");
  assert.match(await stream.text(), /data: \[DONE\]/);

  const nonstream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({ model: "cline/z-ai/glm-free", messages: [], stream: false }),
  });
  assert.equal(nonstream.status, 200);
  await nonstream.arrayBuffer();

  const inference = clineRequests.filter(({ path: requestPath }) => requestPath === "/api/v1/chat/completions");
  assert.equal(inference[0].headers.authorization, "Bearer workos:cline-access");
  assert.equal(inference[0].headers["x-client-type"], "cline-sdk");
  assert.equal(inference[0].headers["x-platform"], "sdk");
  assert.notEqual(inference[0].headers["x-task-id"], inference[1].headers["x-task-id"]);
  const streamedBody = JSON.parse(inference[0].body);
  assert.equal(streamedBody.model, "z-ai/glm-free");
  assert.equal(streamedBody.stream, true);
  assert.deepEqual(streamedBody.tools, tools);
  assert.equal(streamedBody.parallel_tool_calls, true);

  const quota = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({ model: "cline/z-ai/quota-free", messages: [] }),
  });
  assert.equal(quota.status, 429);
  assert.deepEqual(await quota.json(), {
    error: {
      code: "cline_daily_free_quota_exhausted",
      message: "Cline's daily free quota is exhausted for this model",
      type: "cline_oauth_error",
    },
  });

  const paid = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({ model: "cline/paid/pass", messages: [] }),
  });
  assert.equal(paid.status, 404);
  assert.equal((await paid.json()).error.code, "cline_model_retired");
  assert.equal(fallbackPosts, 0, "cline/ requests must never reach a fallback provider");
});
