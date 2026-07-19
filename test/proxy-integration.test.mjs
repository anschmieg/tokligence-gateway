import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
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

function jsonRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy startup timed out")), 5000);
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
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited during startup with code ${code}: ${output}`));
    });
  });
}

test("the façade routes exact Codex models and preserves Claude effort", async (t) => {
  const codexRequests = [];
  const codex = http.createServer(async (req, res) => {
    const body = await jsonRequest(req);
    codexRequests.push({ path: req.url, headers: req.headers, body });

    if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 123 }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "message",
      model: body.model,
      content: [{ type: "text", text: "codex ok" }],
    }));
  });
  const codexPort = await listen(codex);

  const tokligenceRequests = [];
  const tokligence = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.6-sol", owned_by: "tokligence" }],
      }));
      return;
    }
    const body = await jsonRequest(req);
    tokligenceRequests.push({ path: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "tokligence ok" }],
    }));
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
      CODEX_PROXY_ENABLED: "true",
      CODEX_PROXY_BASE_URL: `http://127.0.0.1:${codexPort}`,
      CODEX_PROXY_API_KEY: "internal-secret",
      OLLAMA_API_KEY: "ollama-secret",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(codex), close(tokligence)]);
  });

  const proxyPort = await waitForProxy(child);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const headers = {
    Authorization: "Bearer sk-ant-public-secret",
    "Content-Type": "application/json",
  };

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "tgw-proxy" });

  for (const protectedPath of ["/v1/models", "/v1/providers", "/v1/messages"]) {
    const denied = await fetch(`${baseUrl}${protectedPath}`);
    assert.equal(denied.status, 401, `${protectedPath} must require public authentication`);
  }

  const providers = await fetch(`${baseUrl}/v1/providers`, { headers });
  assert.equal(providers.status, 200);
  const providerBody = await providers.json();
  assert.equal(
    providerBody.data.find((provider) => provider.id === "codex-oauth").configured,
    true,
  );

  const deniedRoutes = await fetch(`${baseUrl}/admin/routes`, { headers });
  assert.equal(deniedRoutes.status, 401);
  const unknownAdmin = await fetch(`${baseUrl}/admin/unknown`, {
    headers: { Authorization: "Bearer admin-secret" },
  });
  assert.equal(unknownAdmin.status, 404);
  const routes = await fetch(`${baseUrl}/admin/routes`, {
    headers: { Authorization: "Bearer admin-secret" },
  });
  assert.equal(routes.status, 200);
  const routesBody = await routes.json();
  assert.equal(routesBody.version, 2);
  assert.equal(routesBody.providers.find((provider) => provider.default).id, "ollama-cloud");
  assert.equal(
    routesBody.providers.find((provider) => provider.id === "codex-oauth").credential_pool.strategy,
    "round-robin",
  );

  const models = await fetch(`${baseUrl}/v1/models`, { headers });
  assert.equal(models.status, 200);
  const modelBody = await models.json();
  const sol = modelBody.data.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(sol.provider, "codex-oauth");
  assert.equal(modelBody.data.some((model) => model.id === "gateway/architecture"), true);
  assert.deepEqual(sol.supported_reasoning_levels, [
    "none", "low", "medium", "high", "xhigh", "max",
  ]);

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gateway/architecture",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      stream: true,
      max_tokens: 100,
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.equal(codexRequests[0].body.model, "gpt-5.6-sol");
  assert.equal(codexRequests[0].body.output_config.effort, "max");
  assert.equal(codexRequests[0].body.thinking.type, "adaptive");
  assert.equal(codexRequests[0].headers.authorization, "Bearer internal-secret");

  const count = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.deepEqual(await count.json(), { input_tokens: 123 });
  assert.equal(codexRequests[1].path, "/v1/messages/count_tokens");

  const unknown = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gpt-5.6-unknown",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(unknown.status, 404);
  assert.equal(codexRequests.length, 2);
  assert.equal(tokligenceRequests.length, 0);

  const existing = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "unrelated-existing-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(existing.status, 404);
  assert.equal(tokligenceRequests.length, 0);
});

test("the façade preserves upstream failures without synthesizing success", async (t) => {
  const gateway = http.createServer(async (req, res) => {
    await jsonRequest(req);
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  const gatewayPort = await listen(gateway);
  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TGW_HOST: "127.0.0.1",
      TGW_PORT: String(gatewayPort),
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      CODEX_PROXY_ENABLED: "false",
      OLLAMA_API_KEY: "ollama-secret",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGTERM"); await close(gateway); });
  const port = await waitForProxy(child);
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-ant-public-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "ollama/deepseek-v4-flash", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.type, "gateway_upstream_error");
  assert.doesNotMatch(JSON.stringify(body), /rate limited/);
});
