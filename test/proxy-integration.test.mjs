import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
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
  let codexResponseUsageCount = 0;
  const codex = http.createServer(async (req, res) => {
    const body = await jsonRequest(req);
    codexRequests.push({ path: req.url, headers: req.headers, body });

    if (req.url === "/v1/responses") {
      const cachedTokens = codexResponseUsageCount++ === 0 ? 0 : 900;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_cache_sample",
        object: "response",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1100,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cachedTokens ? 0 : 1100 },
        },
      }));
      return;
    }
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
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
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
  assert.equal(routesBody.version, 1);
  assert.equal(routesBody.providers.find((provider) => provider.default).id, "tokligence");
  assert.equal(
    routesBody.providers.find((provider) => provider.id === "codex-oauth").credential_pool.strategy,
    "round-robin",
  );

  const models = await fetch(`${baseUrl}/v1/models`, { headers });
  assert.equal(models.status, 200);
  const modelBody = await models.json();
  const sol = modelBody.data.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(sol.provider, "codex-oauth");
  assert.deepEqual(sol.supported_reasoning_levels, [
    "none", "low", "medium", "high", "xhigh", "max",
  ]);

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "reasoning",
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
  assert.equal(existing.status, 200);
  assert.equal(tokligenceRequests.length, 1);

  // Codex remote compaction is a distinct route on the Codex lane. It must reach
  // CLIProxyAPI as /v1/responses/compact, body intact, with the session headers
  // the lane keys its credential affinity on.
  const compact = await fetch(`${baseUrl}/v1/responses/compact`, {
    method: "POST",
    headers: {
      ...headers,
      "session-id": "019f-compact-session",
      "x-claude-code-session-id": "cc-compact-session",
    },
    body: JSON.stringify({
      model: "gpt-6-luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact please" }] }],
    }),
  });
  assert.equal(compact.status, 200);
  const compactUpstream = codexRequests.at(-1);
  assert.equal(compactUpstream.path, "/v1/responses/compact");
  assert.equal(compactUpstream.body.model, "gpt-6-luna");
  assert.equal(compactUpstream.body.input[0].content[0].text, "compact please");
  assert.equal(compactUpstream.headers["session-id"], "019f-compact-session");
  assert.equal(compactUpstream.headers["x-claude-code-session-id"], "cc-compact-session");
  assert.equal(compactUpstream.headers.authorization, "Bearer internal-secret");

  for (let index = 0; index < 2; index += 1) {
    const cacheResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { ...headers, "session-id": "cache-sample-session" },
      body: JSON.stringify({
        model: "gpt-6-sol",
        prompt_cache_key: "cache-sample-key",
        input: [{ role: "user", content: "private cache evidence payload" }],
      }),
    });
    assert.equal(cacheResponse.status, 200);
  }
  const cacheObservations = await fetch(`${baseUrl}/admin/cache-observations`, {
    headers: { Authorization: "Bearer admin-secret" },
  });
  assert.equal(cacheObservations.status, 200);
  const cacheObservationBody = await cacheObservations.json();
  assert.deepEqual(cacheObservationBody.data, [{
    provider: "codex-oauth", model: "gpt-6-sol", idle_bucket: "0-1m",
    samples: 1, input_tokens: 1100, cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0, output_tokens: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(cacheObservationBody), /cache-sample-session|cache-sample-key|private cache evidence payload/);
  assert.equal(tokligenceRequests.length, 1);

  // Body-identity synthesis: when a client sends only the
  // x-claude-code-session-id header (no body identity), the session id is
  // mirrored into metadata.user_id so body-reading lanes can pin the session.
  const synthesized = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { ...headers, "x-claude-code-session-id": "cc-synth-session" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(synthesized.status, 200);
  const synthUpstream = codexRequests.at(-1);
  assert.equal(synthUpstream.path, "/v1/messages");
  assert.equal(synthUpstream.body.metadata.user_id.session_id, "cc-synth-session");
  assert.equal(tokligenceRequests.length, 1);
});


test("Anthropic beta allow-list gates headers and paired compaction fields at the upstream boundary", async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push({ headers: req.headers, body: await jsonRequest(req) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }));
  });
  const upstreamPort = await listen(upstream);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tgw-beta-route-"));
  const configPath = path.join(dir, "routes.yaml");
  const config = [
    "version: 1", "access:", "  public_secret_env: PUBLIC_SECRET", "  admin_secret_env: ADMIN_SECRET",
    "providers:", "  - id: test", "    adapter: middleware", "    default: true",
    "    base_url_env: TEST_UPSTREAM_BASE_URL", "    default_base_url: https://invalid.example",
    "    protocols: [messages]", "    anthropic_beta_allowlist: [compact-2026-09-04]",
    "    models:", "      - id: claude-test", "        context_window: 200000",
    "    metadata:", "      capabilities: [text]", "profiles:", "  beta-profile:",
    "    context_window: 128000", "    candidates:", "      - provider: test", "        model: claude-test",
    "aliases: []",
  ].join("\n");
  await fs.writeFile(configPath, config, { mode: 0o600 });
  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env, ROUTING_CONFIG_PATH: configPath, PROXY_PORT: "0", TGW_HOST: "127.0.0.1",
      PUBLIC_SECRET: "public-secret", ADMIN_SECRET: "admin-secret",
      TEST_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "", MODAL_GLM5_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await close(upstream);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const port = await waitForProxy(child);
  const url = `http://127.0.0.1:${port}/v1/messages`;
  const headers = {
    Authorization: "Bearer sk-ant-public-secret", "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "compact-2026-09-04,not-allowed-2026-01-01",
  };
  const allowed = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    model: "beta-profile", messages: [{ role: "user", content: "compact" }], compaction: { type: "summarize" },
  }) });
  assert.equal(allowed.status, 200);
  assert.equal(seen[0].headers["anthropic-beta"], "compact-2026-09-04");
  assert.deepEqual(seen[0].body.compaction, { type: "summarize" });

  const denied = await fetch(url, { method: "POST", headers: { ...headers, "anthropic-beta": "not-allowed-2026-01-01" }, body: JSON.stringify({
    model: "beta-profile", messages: [{ role: "user", content: "ordinary" }], compaction: { type: "summarize" },
  }) });
  assert.equal(denied.status, 200);
  assert.equal(seen[1].headers["anthropic-beta"], undefined);
  assert.equal(seen[1].body.compaction, undefined);
});
