import http from "node:http";
import https from "node:https";
import { anthropicToOpenAI } from "./anthropic-openai-codec.mjs";
import { GATE_TOOLS, shapeZenRequest, zenHeaders } from "./opencode-zen-gate.mjs";
import { createTokenProvider } from "./opencode-zen-credential.mjs";
import { createSessionPool } from "./opencode-zen-session.mjs";

const FORWARD_HEADERS = ["accept", "anthropic-version", "content-type", "user-agent", "x-request-id"];

export function applyAnthropicBetaPolicy(body, header, allowlist = []) {
  const selectedHeader = allowedAnthropicBeta(header, allowlist);
  const selected = new Set((selectedHeader || "").split(",").map((value) => value.trim()).filter(Boolean));
  const payload = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : structuredClone(body);
  if (![...selected].some((value) => value.startsWith("context-management-")) || payload.compaction != null) {
    delete payload.context_management;
  }
  if (![...selected].some((value) => value.startsWith("compact-"))) delete payload.compaction;
  return { body: Buffer.from(JSON.stringify(payload)), header: selectedHeader };
}

export function allowedAnthropicBeta(header, allowlist = []) {
  if (typeof header !== "string" || !Array.isArray(allowlist)) return undefined;
  const allowed = new Set(allowlist.filter((value) => typeof value === "string"));
  const selected = header.split(",").map((value) => value.trim()).filter((value) => value && allowed.has(value));
  return selected.length ? selected.join(", ") : undefined;
}

// Forwarded to the self-hosted Codex lane only: CLIProxyAPI keys credential
// affinity on these session headers, and a missed affinity costs a prompt-cache
// miss on every turn. A session identifier is not sent to third-party providers,
// where nothing consumes it.
const OAUTH_PROXY_FORWARD_HEADERS = [
  "openai-beta",
  "session-id",
  "session_id",
  "thread-id",
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-session-affinity",
  "x-session-id",
];

function baseUrl(provider, env) {
  if (provider.adapter === "tokligence") return new URL(`http://${env.TGW_HOST || "127.0.0.1"}:${env.TGW_PORT || 8081}`);
  const value = (provider.base_url_env && env[provider.base_url_env]) || provider.base_url || provider.default_base_url;
  return value ? new URL(value) : null;
}

export function endpointSuffix(pathname) {
  if (pathname.includes("/chat/completions")) return "chat/completions";
  // Codex remote compaction is its own route. Collapsing it to /responses would
  // silently turn a compaction call into an ordinary one.
  if (pathname.includes("/responses/compact")) return "responses/compact";
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
  const [minted, authorization, credential] = await Promise.all([
    sessions.sessionId(),
    tokens.authorization(),
    tokens.credential(),
  ]);
  // The service attributes the request with the organisation id; without it the
  // request is refused as not coming from a client.
  const orgId = credential?.metadata?.orgID || env.OPENCODE_ZEN_ORG_ID || "";
  // Zen serves the free tier on chat completions only, so an Anthropic caller is
  // translated rather than forwarded.
  const upstream = candidate.protocol === "messages"
    ? anthropicToOpenAI(request, { gateTools: GATE_TOOLS, forceStream: true })
    : request;
  const shaped = shapeZenRequest(upstream, { gateTools: GATE_TOOLS });
  return {
    body: Buffer.from(JSON.stringify(shaped)),
    headers: zenHeaders({
      session: minted.id,
      authorization,
      clientVersion: (await sessions.clientVersion()) || provider.client_version || "1.18.32",
      project: minted.project || provider.client_project || "global",
      orgId,
    }),
    codec: candidate.protocol === "messages"
      ? { kind: "anthropic-from-openai", stream: request.stream === true, model: candidate.upstreamModel }
      : null,
  };
}

// Serves an Anthropic Messages caller from an OpenAI chat-completions
// upstream. Every provider that speaks chat completions is reachable from
// /v1/messages this way; only genuinely Anthropic-protocol upstreams use the
// native pass-through instead.
function translatedRequest(body) {
  const request = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : body;
  const upstreamBody = anthropicToOpenAI(request, { forceStream: false });
  return {
    upstreamBody,
    codec: { kind: "anthropic-from-openai", stream: upstreamBody.stream === true },
  };
}

async function translatedAttempt(candidate, { upstreamBody, path, req, env, signal, codec }) {
  const target = requestUrl(candidate, path, env, { suffix: "chat/completions" });
  const payload = Buffer.from(JSON.stringify(upstreamBody));
  const headers = {
    "content-type": "application/json",
    "content-length": String(payload.length),
    ...candidate.provider.headers,
  };
  for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  delete headers["anthropic-beta"];
  delete headers["anthropic-version"];
  if (candidate.provider.api_key_env && env[candidate.provider.api_key_env]) {
    headers.authorization = `Bearer ${env[candidate.provider.api_key_env]}`;
  } else if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }
  const { response, upstream } = await send({ target, headers, body: payload, signal });
  return { response, upstream, target, codec };
}

function requestUrl(candidate, path, env, { suffix: forcedSuffix } = {}) {
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
  const suffix = forcedSuffix || endpointSuffix(incoming.pathname);
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
  // An optional proxy (OPENCODE_ZEN_PROXY) lets the Zen adapter exit through a
  // network Zen accepts, without touching any other provider's traffic. The
  // tunnel is a plain HTTP CONNECT to the target, with TLS then layered on top.
  const proxy = process.env.OPENCODE_ZEN_PROXY;
  if (proxy) {
    return sendThroughProxy({ target, headers, body, signal, proxy });
  }
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

function sendThroughProxy({ target, headers, body, signal, proxy }) {
  const proxyUrl = new URL(proxy);
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: { host: `${target.hostname}:${targetPort}` },
    });
    connectReq.on("connect", (res, socket) => {
      console.error(`opencode-zen: proxy CONNECT ${proxyUrl.hostname}:${proxyUrl.port || 80} -> ${target.hostname}:${targetPort} = ${res.statusCode}`);
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const secure = target.protocol === "https:";
      const upstream = (secure ? https : http).request(
        {
          hostname: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers,
          socket,
          servername: secure ? target.hostname : undefined,
        },
        (response) => resolve({ response, upstream }),
      );
      upstream.once("error", reject);
      signal?.addEventListener("abort", () => upstream.destroy(signal.reason), { once: true });
      upstream.end(body);
    });
    connectReq.on("error", (error) => {
      console.error(`opencode-zen: proxy CONNECT error: ${error.message}`);
      reject(error);
    });
    signal?.addEventListener("abort", () => connectReq.destroy(signal.reason), { once: true });
    connectReq.end();
  });
}

export async function startAttempt({ candidate, req, path, body, env = process.env, signal, adapters = {} }) {
  // Translation happens on the body before any adapter sees it: an Anthropic
  // caller is served by an OpenAI upstream, so the adapter must receive the
  // OpenAI request, and the caller receives the Anthropic reply.
  const translation = candidate.translate === "anthropic-from-openai" ? translatedRequest(body) : null;
  const attemptBody = translation ? Buffer.from(JSON.stringify(translation.upstreamBody)) : body;

  if (candidate.provider.adapter === "cline-oauth") {
    const adapter = adapters[candidate.provider.id];
    if (!adapter) throw new Error("Cline OAuth adapter is not configured");
    const response = await adapter.createChatCompletion(JSON.parse(attemptBody.toString()), { signal });
    return { response, upstream: response, target: null, codec: translation?.codec ?? null };
  }

  if (translation) {
    return translatedAttempt(candidate, { upstreamBody: translation.upstreamBody, path, req, env, signal, codec: translation.codec });
  }

  if (candidate.provider.adapter === "opencode-zen") {
    const prepared = await zenAttempt(candidate, { body, env });
    const target = requestUrl(candidate, path, env);
    const { response, upstream } = await send({ target, headers: prepared.headers, body: prepared.body, signal });
    return { response, upstream, target, codec: prepared.codec };
  }

  const target = requestUrl(candidate, path, env);
  const betaPolicy = candidate.protocol === "messages" ? applyAnthropicBetaPolicy(body, req.headers["anthropic-beta"], candidate.provider.anthropic_beta_allowlist) : { body, header: undefined };
  body = betaPolicy.body;
  const headers = { "content-type": "application/json", "content-length": String(body.length), ...candidate.provider.headers };
  for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  delete headers["anthropic-beta"];
  if (betaPolicy.header) headers["anthropic-beta"] = betaPolicy.header;
  if (candidate.provider.adapter === "oauth-proxy") {
    for (const name of OAUTH_PROXY_FORWARD_HEADERS) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    headers.authorization = `Bearer ${env[candidate.provider.internal_api_key_env]}`;
  } else if (candidate.provider.api_key_env && env[candidate.provider.api_key_env]) {
    headers.authorization = `Bearer ${env[candidate.provider.api_key_env]}`;
  } else if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }

  const { response, upstream } = await send({ target, headers, body, signal });
  return { response, upstream, target, codec: null };
}
