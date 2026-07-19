#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { CODEX_REASONING_LEVELS } from "./gateway-config.mjs";
import { configuredModels, loadRoutingConfig, publicRoutingConfig } from "./route-config.mjs";
import { protocolForPath } from "./protocol-codecs.mjs";
import { buildRoutePlan } from "./routing-planner.mjs";
import { executeRoutePlan } from "./request-executor.mjs";

const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
const ROUTING = loadRoutingConfig(path.resolve(process.env.ROUTING_CONFIG_PATH || "gateway.routes.yaml"));
const AUTH_SECRET = process.env[ROUTING.access.public_secret_env];
const ADMIN_SECRET = process.env[ROUTING.access.admin_secret_env];
const runtimeState = { cooldowns: new Map(), paygoExhausted: false };

function equal(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function token(req) { return req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null; }
function publicAuth(req) {
  const value = token(req);
  const secret = value?.replace(/^(sk-proj-|sk-ant-)/, "");
  if (!equal(secret, AUTH_SECRET)) return false;
  req.headers.authorization = `Bearer ${secret}`;
  return true;
}
function adminAuth(req) { return equal(token(req), ADMIN_SECRET); }
function send(res, status, data) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
function readJson(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(new Error("Request body exceeds gateway limit")); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
function modelList() {
  const physical = configuredModels(ROUTING).filter((model) => model.direct_access).map((model) => ({ id: model.public_model, slug: model.public_model, object: "model", provider: model.provider, kind: "physical", quality_tier: model.quality_tier, billing_class: ROUTING.providers.find((provider) => provider.id === model.provider)?.billing_class, context_window: model.context_window, supported_reasoning_levels: model.provider === "codex-oauth" ? CODEX_REASONING_LEVELS : [] }));
  const profiles = ROUTING.profiles.map((profile) => ({ id: profile.public_model, slug: profile.public_model, object: "model", kind: "profile", intent: profile.intent, provider: null }));
  return [...profiles, ...physical];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://gateway.local");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", service: "tgw-proxy" });
  if (url.pathname.startsWith("/admin/")) {
    if (!adminAuth(req)) return send(res, 401, { error: "Unauthorized" });
    if (req.method === "GET" && url.pathname === "/admin/routes") return send(res, 200, publicRoutingConfig(ROUTING));
    if (req.method === "GET" && url.pathname === "/admin/providers") return send(res, 200, { object: "list", data: publicRoutingConfig(ROUTING).providers, cooldowns: runtimeState.cooldowns.size });
    return send(res, 404, { error: "Not found" });
  }
  if (!publicAuth(req)) return send(res, 401, { error: "Unauthorized" });
  if ((req.method === "GET" || req.method === "POST") && ["/models", "/v1/models"].includes(url.pathname)) return send(res, 200, { object: "list", data: modelList(), models: modelList() });
  if (req.method === "GET" && url.pathname === "/v1/providers") return send(res, 200, { object: "list", data: publicRoutingConfig(ROUTING).providers });

  const protocol = protocolForPath(url.pathname);
  if (!protocol || req.method !== "POST") return send(res, 404, { error: "Not found" });
  let body;
  try { body = await readJson(req); } catch (error) { return send(res, error.message === "Invalid JSON" ? 400 : 413, { error: error.message }); }
  const plan = buildRoutePlan(ROUTING, { model: body.model, protocol, body }, process.env, runtimeState);
  if (plan.error) return send(res, plan.error.status, { error: plan.error.message });
  await executeRoutePlan({ plan, req, res, path: req.url, body, env: process.env, runtimeState });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  const address = server.address();
  console.log(`tgw-proxy :${typeof address === "object" ? address.port : PROXY_PORT}`);
});
