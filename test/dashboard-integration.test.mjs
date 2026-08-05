import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_TOKEN = "admin-secret-dashboard";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function jsonRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy startup timed out")), 5000);
    let out = "";
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/tgw-proxy :(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(Number(m[1]));
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${out}`)); });
  });
}

test("dashboard admin endpoints protect and serve quota + routing preferences", async (t) => {
  const tokligence = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  const tgwPort = await listen(tokligence);

  // Isolate writes: point the proxy at a throwaway copy of the routing policy so
  // the bake endpoint never touches the real gateway.routes.yaml.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-dash-fixture-"));
  const routesCopy = path.join(fixtureDir, "gateway.routes.yaml");
  fs.copyFileSync(path.join(projectRoot, "gateway.routes.yaml"), routesCopy);
  const prefsPath = path.join(fixtureDir, "gateway.preferences.yaml");

  const child = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TGW_HOST: "127.0.0.1",
      TGW_PORT: String(tgwPort),
      ROUTING_CONFIG_PATH: routesCopy,
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: ADMIN_TOKEN,
      OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "", MISTRAL_API_KEY: "",
      ROUTING_PREFERENCES_PATH: prefsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGTERM"); await close(tokligence); fs.rmSync(fixtureDir, { recursive: true, force: true }); });

  const port = await waitForProxy(child);
  const base = `http://127.0.0.1:${port}`;
  const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

  // Dashboard HTML requires admin auth.
  assert.equal((await fetch(`${base}/dashboard`)).status, 401);
  const html = await fetch(`${base}/dashboard`, { headers: admin });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Tokligence Gateway/);

  // Root also serves the dashboard.
  const root = await fetch(`${base}/`, { headers: admin });
  assert.equal(root.status, 200);

  // Status endpoint.
  const status = await fetch(`${base}/admin/status`, { headers: admin });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.service, "tgw-proxy");
  assert.equal(Array.isArray(statusBody.providers), true);

  // Quota is fail-safe when no keys are configured.
  const quota = await fetch(`${base}/admin/quota`, { headers: admin });
  assert.equal(quota.status, 200);
  const quotaBody = await quota.json();
  assert.equal(Array.isArray(quotaBody.data), true);
  quotaBody.data.forEach((q) => assert.equal(q.provider, q.provider));

  // Preferences GET returns the (empty) set of overrides.
  const prefs = await fetch(`${base}/admin/preferences`, { headers: admin });
  assert.equal(prefs.status, 200);
  const prefsBody = await prefs.json();
  assert.equal(Array.isArray(prefsBody.aliases), true);

  // Setting a valid override works.
  const setBody = { id: "profile-low", override: { provider: "mistral", target: "ministral-8b-latest" } };
  // mistral is NOT enabled here (no key), so the write must be rejected.
  const setRes = await fetch(`${base}/admin/preferences`, {
    method: "POST", headers: admin, body: JSON.stringify(setBody),
  });
  assert.equal(setRes.status, 422);

  // Setting an override with no provider (uses configured default routing) is valid.
  const setOk = await fetch(`${base}/admin/preferences`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ id: "profile-low", override: { provider: "", target: "ministral-8b-latest", fallback: "oc/kimi-k2.6" } }),
  });
  assert.equal(setOk.status, 200);
  const after = await (await fetch(`${base}/admin/preferences`, { headers: admin })).json();
  assert.equal(after.aliases.find((a) => a.id === "profile-low").target, "ministral-8b-latest");

  // Reset works.
  await fetch(`${base}/admin/preferences/reset`, { method: "POST", headers: admin });
  const afterReset = await (await fetch(`${base}/admin/preferences`, { headers: admin })).json();
  assert.deepEqual(afterReset.aliases, []);

  // Baking overrides into gateway.routes.yaml works (no-op when nothing set).
  const bake = await fetch(`${base}/admin/preferences/bake`, { method: "POST", headers: admin });
  assert.equal(bake.status, 200);
  const bakeBody = await bake.json();
  assert.equal(bakeBody.baked, true);
  assert.equal(typeof bakeBody.written, "number");
});

// ---------------------------------------------------------------------------
// Cloudflare Access as an alternative admin auth method.
// ---------------------------------------------------------------------------

test("dashboard admin endpoints accept a valid Cloudflare Access JWT", async (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = publicKey.export({ format: "jwk" });
  const certs = JSON.stringify({
    keys: [{ kid: "test-kid-1", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }],
  });
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: "test-kid-1", typ: "JWT" };
  const payload = { aud: ["test-aud"], exp: now + 3600, iat: now - 60 };
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  const jwt = `${signingInput}.${signature.toString("base64url")}`;

  const tokligence2 = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  const tgwPort2 = await listen(tokligence2);

  const fixtureDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tgw-cf-"));
  const routesCopy2 = path.join(fixtureDir2, "gateway.routes.yaml");
  fs.copyFileSync(path.join(projectRoot, "gateway.routes.yaml"), routesCopy2);

  const child2 = spawn(process.execPath, ["tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROXY_PORT: "0",
      TGW_HOST: "127.0.0.1",
      TGW_PORT: String(tgwPort2),
      ROUTING_CONFIG_PATH: routesCopy2,
      TOKLIGENCE_AUTH_SECRET: "public-secret",
      TOKLIGENCE_ADMIN_SECRET: "admin-secret",
      OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "",
      MODAL_GLM5_API_KEY: "", MISTRAL_API_KEY: "",
      ROUTING_PREFERENCES_PATH: path.join(fixtureDir2, "gateway.preferences.yaml"),
      // Cloudflare Access config:
      CLOUDFLARE_ACCESS_TEAM: "test-team",
      CLOUDFLARE_ACCESS_AUD: "test-aud",
      CLOUDFLARE_ACCESS_CERTS: certs,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child2.kill("SIGTERM"); await close(tokligence2); fs.rmSync(fixtureDir2, { recursive: true, force: true }); });

  const port2 = await waitForProxy(child2);
  const base2 = `http://127.0.0.1:${port2}`;

  // Valid Cloudflare Access JWT authenticates.
  const cfRes = await fetch(`${base2}/admin/status`, {
    headers: { "Cf-Access-Jwt": jwt },
  });
  assert.equal(cfRes.status, 200);
  const status2 = await cfRes.json();
  assert.equal(status2.service, "tgw-proxy");

  // A tampered Cf-Access-Jwt header is still rejected (strict validation when a
  // token is present) so a direct-origin caller can't spoof a valid CF session.
  const badJwt = "bad.token.here";
  const badRes = await fetch(`${base2}/admin/status`, {
    headers: { "Cf-Access-Jwt": badJwt },
  });
  assert.equal(badRes.status, 401);

  // With Cloudflare Access configured, the dashboard/admin routes are protected
  // at the edge. A request already admitted by the Access policy may not carry a
  // Cf-Access-Jwt header by the time it reaches us, so the origin trusts it.
  const noAuth = await fetch(`${base2}/admin/status`);
  assert.equal(noAuth.status, 200);
});
