import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
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
function close(server) { return new Promise((resolve) => server.close(resolve)); }
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
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
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`proxy exited with ${code}: ${output}`)); });
  });
}

test("agent-default fails over past a failed Cline route", async (t) => {
  const openrouterRequests = [];
  const mistralRequests = [];
  const openrouter = http.createServer(async (req, res) => {
    openrouterRequests.push({ path: req.url, headers: req.headers, body: await readJson(req) });
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  const mistral = http.createServer(async (req, res) => {
    const body = await readJson(req);
    mistralRequests.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "mistral ok" }, finish_reason: "stop" }],
    }));
  });
  const openrouterPort = await listen(openrouter);
  const mistralPort = await listen(mistral);

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_API_BASE: `http://127.0.0.1:${openrouterPort}/api/v1`,
      MISTRAL_API_KEY: "mistral-key",
      MISTRAL_API_BASE: `http://127.0.0.1:${mistralPort}/v1`,
      CODEX_PROXY_ENABLED: "false",
      CODEX_PROXY_API_KEY: "",
      OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(openrouter), close(mistral)]);
  });

  const proxyPort = await waitForProxy(child);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer public-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "agent-default",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });

  // Cline is first in the profile but has no credentials in the test env; its
  // 401 must not abort the chain — the planner fails over to the next healthy
  // upstream (mistral) instead of surfacing the cline error.
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices?.[0]?.message?.content, "mistral ok");
  assert.equal(openrouterRequests.length, 0);
  assert.equal(mistralRequests.length, 1);
});

test("daily-quota 429 cools cline down for follow-up requests, rate-limit 429s stay short", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tokligence-cline-test-"));
  const credentialsPath = path.join(directory, "credentials.json");
  await fs.writeFile(credentialsPath, JSON.stringify({
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }));

  const clineChatRequests = [];
  const mistralRequests = [];
  // Cline mock: free-model feed lists both profile candidates; every chat
  // completion fails — one with Cline's daily-quota message (long cooldown),
  // one with a generic 429 (short cooldown).
  const cline = http.createServer(async (req, res) => {
    if (req.url.startsWith("/api/v1/ai/cline/recommended-models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ free: [{ id: "cline-free/deepseek-v4.1-flash" }, { id: "cline-free/mimo-v2.6-flash" }] }));
      return;
    }
    if (req.url.startsWith("/api/v1/chat/completions")) {
      const body = await readJson(req);
      clineChatRequests.push(body.model);
      const daily = String(body.model).includes("deepseek");
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify(daily ? { error: "free limit reached on model" } : { error: "rate limited" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  const mistral = http.createServer(async (req, res) => {
    const body = await readJson(req);
    mistralRequests.push({ path: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "mistral ok" }, finish_reason: "stop" }],
    }));
  });
  const clinePort = await listen(cline);
  const mistralPort = await listen(mistral);

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      CLINE_API_BASE_URL: `http://127.0.0.1:${clinePort}`,
      CLINE_OAUTH_CREDENTIALS_PATH: credentialsPath,
      MISTRAL_API_KEY: "mistral-key",
      MISTRAL_API_BASE: `http://127.0.0.1:${mistralPort}/v1`,
      CODEX_PROXY_ENABLED: "false",
      CODEX_PROXY_API_KEY: "",
      OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
      MINIMAX_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(cline), close(mistral), fs.rm(directory, { recursive: true, force: true })]);
  });

  const proxyPort = await waitForProxy(child);
  const call = () => fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer public-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "agent-default",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });

  // First request: both cline candidates fail (daily quota + generic 429) and
  // the chain fails over to mistral instead of surfacing the cline error.
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices?.[0]?.message?.content, "mistral ok");
  assert.equal(clineChatRequests.length, 2);

  // Second request: both cline candidates are cooling down and are skipped —
  // the exhausted models are not retried, mistral serves again.
  const second = await call();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices?.[0]?.message?.content, "mistral ok");

  assert.equal(clineChatRequests.length, 2);
  assert.equal(mistralRequests.length, 2);
});

test("a middle candidate's 404 must not abort the failover chain", async (t) => {
  const mistralRequests = [];
  const openrouterRequests = [];
  // mistral serves 404 for its profile candidate (model rotated upstream),
  // openrouter serves 200 — the chain must reach openrouter instead of dying
  // on the mistral 404.
  const mistral = http.createServer(async (req, res) => {
    await readJson(req);
    mistralRequests.push(req.url);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "model not found" }));
  });
  const openrouter = http.createServer(async (req, res) => {
    const body = await readJson(req);
    openrouterRequests.push(body.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "openrouter ok" }, finish_reason: "stop" }],
    }));
  });
  const mistralPort = await listen(mistral);
  const openrouterPort = await listen(openrouter);

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      MISTRAL_API_KEY: "mistral-key",
      MISTRAL_API_BASE: `http://127.0.0.1:${mistralPort}/v1`,
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_API_BASE: `http://127.0.0.1:${openrouterPort}/api/v1`,
      CODEX_PROXY_ENABLED: "false",
      CODEX_PROXY_API_KEY: "",
      OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(mistral), close(openrouter)]);
  });

  const proxyPort = await waitForProxy(child);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer public-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "agent-default",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices?.[0]?.message?.content, "openrouter ok");
  assert.equal(mistralRequests.length, 1);
  assert.equal(openrouterRequests.length, 1);
});

test("an Anthropic Messages request to Mistral is translated with tools and streaming", async (t) => {
  const mistralRequests = [];
  const mistral = http.createServer(async (req, res) => {
    const body = await readJson(req);
    mistralRequests.push({ path: req.url, headers: req.headers, body });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"mis\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"tral\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
      ].join(""));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "mistral ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });
  const mistralPort = await listen(mistral);

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      MISTRAL_API_KEY: "mistral-key",
      MISTRAL_API_BASE: `http://127.0.0.1:${mistralPort}/v1`,
      CODEX_PROXY_ENABLED: "false",
      CODEX_PROXY_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await close(mistral);
  });

  const proxyPort = await waitForProxy(child);
  const url = `http://127.0.0.1:${proxyPort}/v1/messages`;
  const headers = {
    Authorization: "Bearer public-secret", "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  const single = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "mistral-large-latest",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", description: "look up", input_schema: { type: "object", properties: {} } }],
    }),
  });
  assert.equal(single.status, 200);
  const message = await single.json();
  assert.equal(message.type, "message");
  assert.equal(message.content[0].text, "mistral ok");
  assert.equal(mistralRequests[0].path, "/v1/chat/completions");
  assert.equal(mistralRequests[0].body.stream, false);
  assert.equal(mistralRequests[0].body.tools?.length, 1);
  assert.equal(mistralRequests[0].body.tools[0].function.name, "lookup");

  const streamed = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "mistral-large-latest",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
  const sse = await streamed.text();
  assert.match(sse, /event: message_start/);
  assert.match(sse, /mis/);
  assert.match(sse, /event: message_stop/);
  assert.equal(mistralRequests[1].path, "/v1/chat/completions");
  assert.equal(mistralRequests[1].body.stream, true);
});
