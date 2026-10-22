import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const request = { model: "jev-1.13-free", state: "synthetic command text; evaluation only", questions: { a: { type: "noul", instructions: "is it privileged?" } } };
const answer = { model: request.model, answers: { a: { type: "noul", noul: 0.01 } }, usage: { input_tokens: 2, output_tokens: 3 } };
const preload = `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === "https://opencode.ai/inference/systemone/v1/systemone") {
    const payload = JSON.parse(init.body);
    if (JSON.stringify(payload) !== JSON.stringify(${JSON.stringify(request)})) throw new Error("native body changed");
    if (init.headers.authorization !== "Bearer synthetic-console-key") throw new Error("incorrect upstream authentication");
    if (Object.keys(init.headers).sort().join(",") !== "authorization,content-type") throw new Error("caller headers leaked");
    return new Response(JSON.stringify(${JSON.stringify(answer)}), { status: 201, headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};
`;

function listen(server) { server.listen(0, "127.0.0.1"); return once(server, "listening").then(() => server.address().port); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function startup(child) { return new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error(`startup timeout ${out}`)), 8000);
  child.stdout.on("data", (buf) => { out += buf.toString(); const match = out.match(/tgw-proxy :(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`proxy exit ${code}: ${out}`)); });
}); }

test("authenticated exact SystemOne route fails closed without available credentials and rejects chat Jev", async (t) => {
  const upstream = http.createServer();
  const upPort = await listen(upstream);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "systemone-gateway-"));
  const routePath = path.join(tmp, "routes.yaml");
  const routes = (await fs.readFile(path.join(root, "gateway.routes.yaml"), "utf8"))
    .replace("credential_file: /data/zen/oauth.json", `credential_file: ${path.join(tmp, "oauth.json")}`)
    .replace("token_url: https://opencode.ai/console/auth/device/token", `token_url: http://127.0.0.1:${upPort}/token`)
    .replace("base_url: https://opencode.ai/inference/v1", `base_url: http://127.0.0.1:${upPort}/inference/v1`)
    .replace("api_key_env: OPENCODE_API_KEY", "api_key_env: TEST_OPENCODE_API_KEY");
  await fs.writeFile(routePath, routes);
  const oauthPath = path.join(tmp, "oauth.json");
  // Keep this test's intended no-credential case: the configured file path is
  // absent, so the pool must fail closed before attempting an upstream request.
  const child = spawn(process.execPath, ["tgw-proxy.mjs"], { cwd: root, env: {
    ...process.env, ROUTING_CONFIG_PATH: routePath, PROXY_PORT: "0", TGW_HOST: "127.0.0.1", TGW_PORT: "1",
    TOKLIGENCE_AUTH_SECRET: "public-secret", TOKLIGENCE_ADMIN_SECRET: "admin-secret", TEST_OAUTH_FILE: oauthPath,
    TEST_OPENCODE_API_KEY: "", OPENCODE_ZEN_CREDENTIAL_FILE: oauthPath,
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGTERM"); await close(upstream); await fs.rm(tmp, { recursive: true, force: true }); });
  const port = await startup(child);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: "Bearer sk-ant-public-secret", "content-type": "application/json" };
  const response = await fetch(`${base}/v1/systemone`, { method: "POST", headers: auth, body: JSON.stringify(request) });
  assert.equal(response.status, 503);
  assert.match((await response.text()).toLowerCase(), /credential|systemone/);

  const unauthorized = await fetch(`${base}/v1/systemone`, { method: "POST", headers: { ...auth, authorization: "Bearer wrong" }, body: JSON.stringify(request) });
  assert.equal(unauthorized.status, 401);
  const wrongMethod = await fetch(`${base}/v1/systemone`, { method: "GET", headers: auth });
  assert.equal(wrongMethod.status, 405);
  const chat = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "jev-1.13-free", messages: [{ role: "user", content: "x" }] }) });
  assert.equal(chat.status, 400);
  const messages = await fetch(`${base}/v1/messages`, { method: "POST", headers: auth, body: JSON.stringify({ model: "jev-1.13-free", messages: [{ role: "user", content: "x" }] }) });
  assert.equal(messages.status, 400);
  const responses = await fetch(`${base}/v1/responses`, { method: "POST", headers: auth, body: JSON.stringify({ model: "jev-1.13-free", input: "x" }) });
  assert.equal(responses.status, 400);
  for (const model of ["jev-1.13", "zen/jev-1.13-free", "opencode-zen/jev-1.13"]) {
    const rejected = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [] }) });
    assert.equal(rejected.status, 400);
  }
  const models = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  assert.equal(models.data.some(({ id }) => /^jev-1\.13(?:-free)?$/i.test(id)), false);
});

test("gateway preserves authenticated native request and structured upstream response", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "systemone-native-"));
  const preloadPath = path.join(tmp, "fetch.mjs");
  await fs.writeFile(preloadPath, preload);
  const child = spawn(process.execPath, ["--import", preloadPath, "tgw-proxy.mjs"], { cwd: root, env: {
    ...process.env, PROXY_PORT: "0", TGW_PORT: "1", ROUTING_CONFIG_PATH: path.join(root, "gateway.routes.yaml"),
    TOKLIGENCE_AUTH_SECRET: "public-secret", TOKLIGENCE_ADMIN_SECRET: "admin-secret",
    OPENCODE_ZEN_CREDENTIAL_FILE: path.join(tmp, "missing.json"), OPENCODE_API_KEY: "synthetic-console-key",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGTERM"); await fs.rm(tmp, { recursive: true, force: true }); });
  const port = await startup(child);
  const headers = { authorization: "Bearer sk-ant-public-secret", "content-type": "application/json", "x-session-id": "native-test", "x-private-client-header": "must-not-forward" };
  const response = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), answer);
  const malformed = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers, body: JSON.stringify({ ...request, questions: { a: { type: "choice", criteria: {} } } }) });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers, body: JSON.stringify({ ...request, state: "x".repeat(65536) }) });
  assert.equal(oversized.status, 413);
});
