import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function closed(response) {
  if (response.destroyed) return;
  await Promise.race([once(response, "close"), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream remained connected")), 2000); timer.unref(); })]);
}

test("legacy requests clean framing and cancel on deadlines and disconnects", async (t) => {
  const seen = [];
  let stalled;
  let notifyStall;
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes.toString() || "{}");
    seen.push({ headers: req.headers, body, bytes: bytes.length });
    const mode = String(body.messages?.[0]?.content || body.input || "");
    if (mode === "stream-stall") { stalled = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"choices":[]}\n\n'); return; }
    if (mode.startsWith("stall")) { stalled = res; notifyStall?.(res); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], content: [{ type: "text", text: "ok" }] }));
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const mockPort = mock.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-legacy-"));
  const preload = path.join(dir, "local-transport.mjs");
  await fs.writeFile(preload, `import https from 'node:https';import http from 'node:http';const original=https.request;https.request=function(options,...args){if(options.hostname==='127.0.0.1')return http.request({...options,protocol:'http:'},...args);return original(options,...args);};`);
  const child = spawn(process.execPath, ["--import", preload, "tgw-proxy.mjs"], { env: {
    PATH: process.env.PATH, PROXY_HOST: "127.0.0.1", PROXY_PORT: "0", TOKLIGENCE_AUTH_SECRET: "public", TOKLIGENCE_ADMIN_SECRET: "admin", CODEX_PROXY_ENABLED: "false", OPENCODE_ZEN_CREDENTIAL_FILE: path.join(dir, "missing"), TGW_PORT: String(mockPort), MISTRAL_API_KEY: "mock", MISTRAL_API_BASE: `http://127.0.0.1:${mockPort}/v1`, GATEWAY_REQUEST_TIMEOUT_MS: "500", GATEWAY_RESPONSE_START_TIMEOUT_MS: "300",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill(); mock.closeAllConnections(); mock.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let stderr = ""; child.stderr.on("data", c => stderr += c);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || "startup timeout")), 5000);
    child.stdout.on("data", c => { const m = String(c).match(/tgw-proxy :(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer public", "content-type": "application/json" };
  for (const endpoint of ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/custom"]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, { method: "POST", headers: { ...headers, "transfer-encoding": "chunked", connection: "keep-alive, x-review-hop", "x-review-hop": "remove-me" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.write(JSON.stringify({ model: "claude-sonnet-4-5", input: "hello", messages: [{ role: "user", content: "hello" }] })); req.end();
    });
    assert.equal(status, 200, endpoint);
    const record = seen.at(-1);
    assert.equal(record.headers["transfer-encoding"], undefined);
    assert.equal(record.headers["x-review-hop"], undefined);
    assert.equal(Number(record.headers["content-length"]), record.bytes);
  }
  for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
    const response = await fetch(base + endpoint, { method: "POST", headers, body: JSON.stringify({ model: "mistral-large-latest", input: "stall", messages: [{ role: "user", content: "stall" }] }), signal: AbortSignal.timeout(2500) });
    assert.equal(response.status, 504);
    await response.text();
    await closed(stalled);
  }
  const streaming = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "mistral-large-latest", messages: [{ role: "user", content: "stream-stall" }], stream: true }), signal: AbortSignal.timeout(2500) });
  assert.equal(streaming.status, 200);
  await assert.rejects(streaming.text(), "the total deadline also terminates a stalled response body");
  await closed(stalled);
  const controller = new AbortController();
  const arriving = new Promise(resolve => { notifyStall = resolve; });
  const pending = fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "mistral-large-latest", messages: [{ role: "user", content: "stall-cancel" }] }), signal: controller.signal });
  const disconnected = await arriving;
  const pendingRejection = assert.rejects(pending);
  controller.abort(); await pendingRejection;
  await closed(disconnected);
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal(child.exitCode, null);
});
