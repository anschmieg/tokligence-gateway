import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("failed preference writes return errors and preserve running state", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-persistence-"));
  const prefs = path.join(dir, "preferences.yaml");
  const preload = path.join(dir, "disk-full.mjs");
  const original = 'version: 1\naliases:\n  profile-low:\n    target: preserved-model\n';
  await fs.writeFile(prefs, original);
  await fs.writeFile(preload, `import fs from 'node:fs';const original = fs.writeFileSync;fs.writeFileSync = function(file,...args){if(String(file).startsWith(${JSON.stringify(prefs)}+'.')) { original(file,'partial write'); throw Object.assign(new Error('simulated disk full'),{code:'ENOSPC'}); }return original(file,...args);};`);
  const child = spawn(process.execPath, ["--import", preload, "tgw-proxy.mjs"], { env: {
    PATH: process.env.PATH, PROXY_HOST: "127.0.0.1", PROXY_PORT: "0", TOKLIGENCE_AUTH_SECRET: "public", TOKLIGENCE_ADMIN_SECRET: "admin", ROUTING_PREFERENCES_PATH: prefs, OPENCODE_ZEN_CREDENTIAL_FILE: path.join(dir, "missing-token"), CODEX_PROXY_ENABLED: "false",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill(); await fs.rm(dir, { recursive: true, force: true }); });
  let errors = ""; child.stderr.on("data", c => errors += c);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || "startup timeout")), 5000);
    child.stdout.on("data", c => { const m = String(c).match(/tgw-proxy :(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${errors}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer admin", "content-type": "application/json" };
  const snapshot = async () => (await (await fetch(base + "/admin/preferences", { headers })).json()).aliases;
  const before = await snapshot();
  assert(before.some(entry => entry.target === "preserved-model"));
  for (const [endpoint, body] of [["/admin/preferences/reset", {}], ["/admin/preferences/clear", { id: "profile-low" }], ["/admin/preferences", { id: "profile-low", override: { target: "changed-model" } }]]) {
    const response = await fetch(base + endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 500, endpoint);
    assert.doesNotMatch(await response.text(), /ENOSPC|simulated disk|preferences\.yaml/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal(await fs.readFile(prefs, "utf8"), original);
    assert(!(await fs.readdir(dir)).some(name => name.endsWith(".tmp")), "failed temporary writes are cleaned up");
  }
  assert.equal(child.exitCode, null);
});
