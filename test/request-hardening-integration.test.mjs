import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";

test("malformed requests and oversized bodies are rejected without killing the gateway", async (t) => {
  const child = spawn(process.execPath, ["tgw-proxy.mjs"], { env: {
    PATH: process.env.PATH, PROXY_HOST: "127.0.0.1", PROXY_PORT: "0", TOKLIGENCE_AUTH_SECRET: "test-public", TOKLIGENCE_ADMIN_SECRET: "test-admin", CODEX_PROXY_ENABLED: "false", OPENCODE_ZEN_CREDENTIAL_FILE: "/tmp/no-review-credential",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let errors = ""; child.stderr.on("data", c => errors += c);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout: " + errors)), 5000);
    child.stdout.on("data", c => { const m = String(c).match(/tgw-proxy :(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${errors}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const healthy = async () => assert.equal((await fetch(base + "/health")).status, 200);
  for (const endpoint of ["/v1/messages", "/v1/chat/completions", "/v1/responses"]) {
    for (const body of ["null", "[]", '"text"', '{"model":{}}', '{"model":"x","messages":{}}', '{"model":"x","metadata":false}']) {
      const response = await fetch(base + endpoint, { method: "POST", headers: { authorization: "Bearer test-public", "content-type": "application/json" }, body });
      assert.equal(response.status, 400, endpoint + " " + body);
      await response.text();
      await healthy();
    }
  }
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end("GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n"));
    let response = ""; socket.on("data", c => response += c); socket.on("end", () => resolve(response)); socket.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/); await healthy();
  for (const endpoint of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/admin/preferences", "/unknown"]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, { method: "POST", headers: { authorization: endpoint.startsWith("/admin") ? "Bearer test-admin" : "Bearer test-public", "content-length": 9 * 1024 * 1024 } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.flushHeaders();
    });
    assert.equal(status, 413, endpoint); await healthy();
  }
  assert.equal(child.exitCode, null);
});
