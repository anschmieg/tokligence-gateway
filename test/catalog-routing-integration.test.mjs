import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

test("catalog aliases route free-first, exclude unauthorized paid fallback, and guard specialist APIs", async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      const models = req.url === "/router/models" ? [
        { id: "minimax/minimax-m3.1-flash:free", pricing: { prompt: "0", completion: "0" }, context_length: 1000000 },
        { id: "poolside/laguna-s-2.1:free", pricing: { prompt: "0", completion: "0" }, context_length: 262144 },
        { id: "poolside/laguna-s-2.1", pricing: { prompt: ".00000009", completion: ".00000018" }, context_length: 1000000 },
      ] : req.url === "/mistral/models" ? [
        { id: "codestral-2508", aliases: ["codestral-latest"], max_context_length: 128000 },
        { id: "codestral-latest", max_context_length: 128000 },
        { id: "voxtral-mini-transcribe-3", max_context_length: 32000 },
      ] : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ path: req.url, headers: req.headers, body });
    if (req.url.startsWith("/zen/") || body.model === "poolside/laguna-s-2.1:free") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "quota exhausted" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], text: "transcribed" }));
    }
  });
  const port = await listen(upstream, t);
  const shipped = parse(await fs.readFile("gateway.routes.yaml", "utf8"));
  const raw = {
    version: 1,
    access: { public_secret_env: "PUBLIC_SECRET", admin_secret_env: "ADMIN_SECRET" },
    providers: [
      { id: "tokligence", adapter: "middleware", default: true, base_url: `http://127.0.0.1:${port}`, models: [] },
      { id: "opencode-zen", adapter: "middleware", api_key_env: "ZEN_TEST_KEY", base_url: `http://127.0.0.1:${port}/zen`, protocols: ["chat_completions"], models: [{ id: "minimax-m3.1-flash-free", context_window: 200000 }], metadata: { cost_class: "free", capabilities: ["tool_calling"] } },
      { ...shipped.providers.find((p) => p.id === "openrouter"), models: [], default_base_url: `http://127.0.0.1:${port}/router`, base_url_env: "TEST_ROUTER_BASE", catalog: { zero_price_only: true, paid_allowlist: [] } },
      { ...shipped.providers.find((p) => p.id === "mistral"), models: [], default_base_url: `http://127.0.0.1:${port}/mistral`, base_url_env: "TEST_MISTRAL_BASE" },
    ],
    routes: [{ provider: "mistral", prefixes: ["mistral/"] }, { provider: "opencode-zen", prefixes: ["minimax-m3.1-flash-free"] }, { provider: "openrouter", prefixes: ["openrouter/"] }],
    aliases: [],
    model_catalog: { ...shipped.model_catalog, models: {
      "minimax-m3.1-flash-free": { routes: [{ provider: "opencode-zen", model: "minimax-m3.1-flash-free" }, { provider: "openrouter", model: "minimax/minimax-m3.1-flash:free" }] },
      "poolside/laguna-s-2.1": shipped.model_catalog.models["poolside/laguna-s-2.1"],
    } },
    model_picker: shipped.model_picker,
  };
  raw.model_catalog.models["poolside/laguna-s-2.1"].routes = raw.model_catalog.models["poolside/laguna-s-2.1"].routes.filter((route) => route.provider === "openrouter");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-routes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "routes.yaml");
  await fs.writeFile(configPath, stringify(raw));
  const child = spawn(process.execPath, ["tgw-proxy.mjs"], { env: {
    ...process.env, PROXY_PORT: "0", ROUTING_CONFIG_PATH: configPath, PUBLIC_SECRET: "public", ADMIN_SECRET: "admin", ZEN_TEST_KEY: "zen-key", TEST_ROUTER_BASE: `http://127.0.0.1:${port}/router`, TEST_MISTRAL_BASE: `http://127.0.0.1:${port}/mistral`, OPENROUTER_API_KEY: "router-key", MISTRAL_API_KEY: "mistral-key", TGW_HOST: "127.0.0.1", TGW_PORT: String(port), CODEX_PROXY_ENABLED: "false", CHATGPT_RESPONSES_ENABLED: "false",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const proxyPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timed out")), 5000);
    let output = "";
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/tgw-proxy :(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  const headers = { authorization: "Bearer public", "content-type": "application/json" };
  const catalog = await (await fetch(base + "/v1/models", { headers })).json();
  assert.equal(catalog.data.filter((m) => m.id.includes("codestral")).length, 1);
  assert.equal(catalog.data.find((m) => m.id === "mistral/codestral-latest").routes.length, 1);
  assert.equal(catalog.data.find((m) => m.id === "poolside/laguna-s-2.1").routes.length, 1);
  const transcript = catalog.data.find((m) => m.id === "mistral/voxtral-mini-transcribe-3");
  assert.deepEqual(transcript.supported_endpoints, ["/v1/audio/transcriptions"]);
  assert.equal(transcript.model_picker_enabled, false);
  const complete = (model, endpoint = "/v1/chat/completions", auth = headers) => fetch(base + endpoint, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }) });
  const success = await complete("minimax-m3.1-flash-free");
  assert.equal(success.status, 200);
  await success.text();
  assert.equal(success.headers.get("x-gateway-provider"), "openrouter");
  assert.deepEqual(seen.slice(0, 2).map((r) => r.body.model), ["minimax-m3.1-flash-free", "minimax/minimax-m3.1-flash:free"]);
  const exhausted = await complete("poolside/laguna-s-2.1");
  assert.equal(exhausted.status, 503);
  await exhausted.text();
  assert(!seen.some((r) => r.body.model === "poolside/laguna-s-2.1"), "no implicit paid fallback");
  const coolingDown = await complete("poolside/laguna-s-2.1");
  assert.equal(coolingDown.status, 503);
  assert.match(coolingDown.headers.get("retry-after"), /^[1-9]\d*$/);
  await coolingDown.text();
  const retired = await complete("opencode-zen/space-bunny-free");
  assert.equal(retired.status, 410);
  await retired.text();
  for (const endpoint of ["/v1/messages", "/v1/chat/completions", "/v1/responses"]) {
    const wrong = await complete("mistral/voxtral-mini-transcribe-3", endpoint);
    assert.equal(wrong.status, 400);
    await wrong.text();
  }
  const unauthorized = await complete("mistral/voxtral-mini-transcribe-3", "/v1/audio/transcriptions", { "content-type": "application/json" });
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const specialist = await complete("mistral/voxtral-mini-transcribe-3", "/v1/audio/transcriptions");
  assert.equal(specialist.status, 200);
  await specialist.text();
  assert.equal(seen.at(-1).headers.authorization, "Bearer mistral-key");
  assert.equal(seen.at(-1).body.model, "voxtral-mini-transcribe-3");
});
