import http from "node:http";
import https from "node:https";
import { anthropicToOpenAI } from "./anthropic-openai-codec.mjs";
import { GATE_TOOLS, shapeZenRequest, zenHeaders } from "./opencode-zen-gate.mjs";
import { createTokenProvider } from "./opencode-zen-credential.mjs";
import { createSessionPool } from "./opencode-zen-session.mjs";

const FORWARD_HEADERS = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent", "x-request-id"];

function baseUrl(provider, env) {
  if (provider.adapter === "tokligence") return new URL(`http://${env.TGW_HOST || "127.0.0.1"}:${env.TGW_PORT || 8081}`);
  const value = (provider.base_url_env && env[provider.base_url_env]) || provider.base_url || provider.default_base_url;
  return value ? new URL(value) : null;
}

function endpointSuffix(pathname) {
  if (pathname.includes("/chat/completions")) return "chat/completions";
  if (pathname.includes("/responses")) return "responses";
  if (pathname.includes("/messages")) return "messages";
  return null;
}

// The OpenCode Zen free tier is gated: the request must carry the OAuth token of
// a Console sign-in, identify as OpenCode 1.18+, stream, declare tools, and name
// a session a real OpenCode client created. This module owns those conditions so
// every other provider keeps the plain pass-through behaviour.
const zenServices = new Map();

function zenServicesFor(provider, env) {
  if (!zenServices.has(provider.id)) {
    zenServices.set(provider.id, {
      tokens: createTokenProvider({
        file: (provider.credential_file_env && env[provider.credential_file_env]) || provider.credential_file || env.OPENCODE_ZEN_CREDENTIAL_FILE,
        tokenUrl: provider.token_url || env.OPENCODE_ZEN_TOKEN_URL,
        clientId: provider.client_id || env.OPENCODE_ZEN_CLIENT_ID,
        skewMs: Number(provider.refresh_skew_ms || 10 * 60 * 1000),
        log: (message) => console.error(message.startsWith("opencode-zen:") ? message : `opencode-zen: ${message}`),
      }),
      sessions: createSessionPool({
        command: provider.serve_command || env.OPENCODE_ZEN_SERVE_COMMAND || "opencode",
        port: Number(provider.serve_port || env.OPENCODE_ZEN_SERVE_PORT || 4096),
        log: (message) => console.error(message.startsWith("opencode-zen:") ? message : `opencode-zen: ${message}`),
      }),
    });
  }
  return zenServices.get(provider.id);
}

async function zenAttempt(candidate, { body, env }) {
  const provider = candidate.provider;
  const { tokens, sessions } = zenServicesFor(provider, env);
  const request = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : body;
  const [session, authorization, credential] = await Promise.all([
    sessions.sessionId(),
    tokens.authorization(),
    tokens.credential(),
  ]);
  // The service attributes the request with the organisation id; without it the
  // request is refused as not coming from a client.
  const orgId = credential?.metadata?.orgID || env.OPENCODE_ZEN_ORG_ID || "";
  // Zen serves the free tier on chat completions only, so an Anthropic caller is
  // translated rather than forwarded.
  const upstream = candidate.protocol === "messages" ? anthropicToOpenAI(request, { gateTools: GATE_TOOLS }) : request;
  const shaped = shapeZenRequest(upstream, { gateTools: GATE_TOOLS });
  return {
    body: Buffer.from(JSON.stringify(shaped)),
    headers: zenHeaders({
      session,
      authorization,
      clientVersion: (await sessions.clientVersion()) || provider.client_version || "1.18.32",
      project: provider.client_project || "global",
      orgId,
    }),
    codec: candidate.protocol === "messages"
      ? { kind: "anthropic-from-openai", stream: request.stream === true, model: candidate.upstreamModel }
      : null,
  };
}

function requestUrl(candidate, path, env) {
  const incoming = new URL(path, "http://gateway.local");
  if (candidate.provider.adapter === "oauth-proxy") {
    const target = new URL(env[candidate.provider.external_base_url_env] || "http://127.0.0.1:8317");
    target.pathname = `${target.pathname.replace(/\/$/, "")}${incoming.pathname.replace(/^\/anthropic/, "")}`;
    target.search = incoming.search;
    return target;
  }
  const base = baseUrl(candidate.provider, env);
  if (!base) throw new Error("Provider is not configured");
  const target = new URL(base.toString());
  const suffix = endpointSuffix(incoming.pathname);
  if (candidate.provider.adapter === "opencode-zen") {
    // Free-tier traffic never reaches Zen's Anthropic or Responses routes.
    target.pathname = `${target.pathname.replace(/\/$/, "")}/chat/completions`;
  } else {
    target.pathname = suffix
      ? `${target.pathname.replace(/\/$/, "")}/${suffix}`
      : `${target.pathname.replace(/\/$/, "")}${incoming.pathname}`;
  }
  target.search = incoming.search;
  return target;
}

function send({ target, headers, body, signal }) {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const upstream = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: "POST", headers },
      (response) => resolve({ response, upstream }),
    );
    upstream.once("error", reject);
    signal?.addEventListener("abort", () => upstream.destroy(signal.reason), { once: true });
    upstream.end(body);
  });
}

export async function startAttempt({ candidate, req, path, body, env = process.env, signal, adapters = {} }) {
  if (candidate.provider.adapter === "cline-oauth") {
    const adapter = adapters[candidate.provider.id];
    if (!adapter) throw new Error("Cline OAuth adapter is not configured");
    const response = await adapter.createChatCompletion(JSON.parse(body.toString()), { signal });
    return { response, upstream: response, target: null, codec: null };
  }

  if (candidate.provider.adapter === "opencode-zen") {
    const prepared = await zenAttempt(candidate, { body, env });
    const target = requestUrl(candidate, path, env);
    const { response, upstream } = await send({ target, headers: prepared.headers, body: prepared.body, signal });
    return { response, upstream, target, codec: prepared.codec };
  }

  const target = requestUrl(candidate, path, env);
  const headers = { "content-type": "application/json", "content-length": String(body.length), ...candidate.provider.headers };
  for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  if (candidate.provider.adapter === "oauth-proxy") {
    headers.authorization = `Bearer ${env[candidate.provider.internal_api_key_env]}`;
  } else if (candidate.provider.api_key_env && env[candidate.provider.api_key_env]) {
    headers.authorization = `Bearer ${env[candidate.provider.api_key_env]}`;
  } else if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }

  const { response, upstream } = await send({ target, headers, body, signal });
  return { response, upstream, target, codec: null };
}
