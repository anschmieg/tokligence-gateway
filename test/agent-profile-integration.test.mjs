import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
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

test("agent-default falls back from OpenRouter 429 to Mistral", async (t) => {
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

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gateway-model"), "agent-default");
  assert.equal(response.headers.get("x-gateway-provider"), "mistral");
  const data = await response.json();
  assert.equal(data.choices[0].message.content, "mistral ok");
  assert.equal(openrouterRequests.length, 1);
  assert.equal(openrouterRequests[0].path, "/api/v1/chat/completions");
  assert.equal(openrouterRequests[0].headers.authorization, "Bearer or-key");
  assert.equal(openrouterRequests[0].body.model, "deepseek/deepseek-v4-flash");
  assert.equal(mistralRequests.length, 1);
  assert.equal(mistralRequests[0].path, "/v1/chat/completions");
  assert.equal(mistralRequests[0].headers.authorization, "Bearer mistral-key");
  assert.equal(mistralRequests[0].body.model, "mistral-medium-3-5");
});
