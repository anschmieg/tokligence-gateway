import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
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

  // Simulate the provider dropping a model; the next request must reflect it.
  orModels.data = orModels.data.filter((m) => m.id !== "free-vision");
  const second = await (await fetch(`${baseUrl}/v1/models`, { headers })).json();
  const secondIds = second.data.map((m) => m.id);
  assert.ok(secondIds.includes("openrouter/free-fast"), "remaining free model present");
  assert.ok(!secondIds.includes("openrouter/free-vision"), "dropped model pruned on next request");
});
