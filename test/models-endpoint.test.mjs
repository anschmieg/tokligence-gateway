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

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function writeSchedulerFixture(dir) {
  const preload = path.join(dir, "preload.mjs");
  const credentialFile = path.join(dir, "zen-oauth.json");
  await fs.writeFile(credentialFile, JSON.stringify({ access: "synthetic-access-token" }));
  await fs.writeFile(preload, `
    const realTimeout = globalThis.setTimeout;
    const realNow = Date.now;
    let clockOffset = 0;
    Date.now = () => realNow() + clockOffset;
    const timers = [];
    let initialFailure = true;
    globalThis.setTimeout = (fn, ms = 0, ...args) => {
      if (fn.name === "refresh" && (Number(ms) === 10000 || Number(ms) === 60000)) {
        const timer = { delay: Number(ms), callbackName: fn.name, fired: false, fire() { if (!this.fired) { this.fired = true; realTimeout(() => fn(...args), 0); } } };
        timers.push(timer);
        process.send?.({ type: "scheduled", delay: timer.delay, callbackName: timer.callbackName });
        return { unref() { return this; }, ref() { return this; } };
      }
      return realTimeout(fn, ms, ...args);
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.includes("opencode.ai/inference/v1/models") && !url.includes("models.dev/api.json")) throw new Error("unexpected network request " + url);
      const catalog = url.includes("models.dev");
      if (!catalog && initialFailure) {
        initialFailure = false;
        process.send?.({ type: "discovery", result: "failed" });
        return new Response("offline", { status: 503 });
      }
      process.send?.({ type: "discovery", result: "ok", catalog });
      return catalog
        ? Response.json({ opencode: { models: { "fixture-free": { cost: { input: 0, output: 0 } } } } })
        : Response.json({ data: [{ id: "fixture-free" }] });
    };
    process.on("message", ({ type, delay }) => {
      if (type !== "fire") return;
      clockOffset += delay;
      const timer = timers.find((item) => item.delay === delay && !item.fired);
      if (!timer) { process.send?.({ type: "missing", delay }); return; }
      process.send?.({ type: "fired", delay });
      timer.fire();
    });
  `);
  return { preload, credentialFile };
}

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy startup timed out")), 8000);
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

// OpenRouter /models payload with a mix of free (pricing 0) and paid models.
const orModels = {
  object: "list",
  data: [
    { id: "free-fast", pricing: { prompt: "0", completion: "0" } },
    { id: "free-vision", pricing: { prompt: "0", completion: "0" } },
    { id: "paid-flagship", pricing: { prompt: "5.0", completion: "15.0" } },
  ],
};

test("startup discovery scheduler retries after failure and returns to its normal interval", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "tgw-scheduler-"));
  const { preload, credentialFile } = await writeSchedulerFixture(fixtureDir);
  const upstream = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: [] })));
  const upstreamPort = await listen(upstream);
  const child = spawn(process.execPath, ["--import", preload, "tgw-proxy.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, PROXY_PORT: "0", TGW_HOST: "127.0.0.1", TGW_PORT: String(upstreamPort), TOKLIGENCE_AUTH_SECRET: "public-secret", TOKLIGENCE_ADMIN_SECRET: "admin-secret", OPENCODE_ZEN_CREDENTIAL_FILE: credentialFile, OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "", MISTRAL_API_KEY: "", MODAL_GLM5_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  const childExited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([childExited, close(upstream)]);
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });
  const proxyPort = await waitForProxy(child);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const headers = { Authorization: "Bearer sk-ant-public-secret", "Content-Type": "application/json" };
  const waitMessage = async (predicate) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for fixture event; seen: ${JSON.stringify(messages)}`);
  };
  await waitMessage((message) => message.type === "discovery" && message.result === "failed");
  assert.deepEqual(await waitMessage((message) => message.type === "scheduled" && message.delay === 10000), { type: "scheduled", delay: 10000, callbackName: "refresh" });
  await waitMessage((message) => message.type === "discovery" && message.catalog === true);
  let models = await (await fetch(`${baseUrl}/v1/models`, { headers })).json();
  assert.ok(!models.data.some((model) => model.id === "fixture-free" || model.id === "opencode-zen/fixture-free"), "failed discovery is not exposed under bare or provider-prefixed IDs");
  assert.equal(messages.filter((message) => message.type === "discovery").length, 2, "models request does not retry discovery outside the scheduler");
  child.send({ type: "fire", delay: 10000 });
  await waitMessage((message) => message.type === "fired" && message.delay === 10000);
  await waitMessage((message) => message.type === "scheduled" && message.delay === 60000);
  await waitMessage((message) => message.type === "discovery" && message.result === "ok" && message.catalog === true);
  models = await (await fetch(`${baseUrl}/v1/models`, { headers })).json();
  assert.ok(models.data.some((model) => model.id === "fixture-free" || model.id === "opencode-zen/fixture-free"), `recovered catalog makes the verified model discoverable: ${JSON.stringify(models.data.filter((model) => model.id.includes("fixture")))}`);
  assert.equal(messages.filter((message) => message.type === "discovery").length, 4, "models request uses recovered registry without another fetch pair");
  child.send({ type: "fire", delay: 60000 });
  await waitMessage((message) => message.type === "fired" && message.delay === 60000);
  await waitMessage((message) => message.type === "scheduled" && message.delay === 60000 && messages.filter((entry) => entry.type === "scheduled" && entry.delay === 60000).length >= 2);
  assert.equal(messages.filter((message) => message.type === "discovery").length, 6, "normal interval callback performs the next actual discovery");
});

test("GET /v1/models reflects live provider endpoints and only exposes free OpenRouter models", async (t) => {
  // Mock OpenRouter /models endpoint.
  const openrouter = http.createServer(async (req, res) => {
    if (req.url === "/api/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(orModels));
      return;
    }
    res.writeHead(404).end();
  });
  const orPort = await listen(openrouter);

  // Mock Tokligence backend /models endpoint.
  const tokligence = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "minimax-m2.7", owned_by: "tokligence" }],
      }));
      return;
    }
    res.writeHead(404).end();
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
      CHATGPT_RESPONSES_ENABLED: "true",
      CHATGPT_SERVICE_URL: "http://127.0.0.1:38752/v1",
      CHATGPT_SERVICE_TOKEN: "synthetic-token",
      CODEX_PROXY_ENABLED: "false",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_API_BASE: `http://127.0.0.1:${orPort}/api/v1`,
      OPENCODE_API_KEY: "",
      MISTRAL_API_KEY: "",
      MODAL_GLM5_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([close(openrouter), close(tokligence)]);
  });

  const proxyPort = await waitForProxy(child);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const headers = {
    Authorization: "Bearer sk-ant-public-secret",
    "Content-Type": "application/json",
  };

  const first = await (await fetch(`${baseUrl}/v1/models`, { headers })).json();
  const firstIds = first.data.map((m) => m.id);
  // Free OpenRouter models are surfaced with the openrouter/ prefix.
  assert.ok(firstIds.includes("openrouter/free-fast"), "free OpenRouter model present");
  assert.ok(firstIds.includes("openrouter/free-vision"), "free OpenRouter model present");
  // Paid OpenRouter model must be excluded.
  assert.ok(!firstIds.some((id) => id.includes("paid-flagship")), "paid OpenRouter model excluded");
  // Tokligence/gateway model is surfaced.
  assert.ok(firstIds.includes("minimax-m2.7"), "tokligence backend model present");
  for (const name of ["research", "explore", "plan", "review", "architecture", "synthesis", "explain", "reasoning"]) {
    assert.ok(firstIds.includes(`role/${name}`), `specialist role/${name} is discoverable`);
  }

  // Simulate the provider dropping a model; the next request must reflect it.
  orModels.data = orModels.data.filter((m) => m.id !== "free-vision");
  const second = await (await fetch(`${baseUrl}/v1/models`, { headers })).json();
  const secondIds = second.data.map((m) => m.id);
  assert.ok(secondIds.includes("openrouter/free-fast"), "remaining free model present");
  assert.ok(!secondIds.includes("openrouter/free-vision"), "dropped model pruned on next request");
});
