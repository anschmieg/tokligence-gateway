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

function invalidSpecialist(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validText(value, max, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > max || value.includes("\0")) {
    throw invalidSpecialist(`${label} must be bounded text`);
  }
}

function canonicalTextInput(input) {
  if (typeof input === "string") {
    validText(input, 15000, "input");
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input) || !input.length || input.length > 100) throw invalidSpecialist("Input must be text or a bounded text message list");
  let total = 0;
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidSpecialist("Only text messages are supported");
    if (Object.keys(item).some((key) => !["type", "role", "content"].includes(key)) || (item.type && item.type !== "message") || !["user", "assistant", "system", "developer"].includes(item.role)) throw invalidSpecialist("Only labelled text messages are supported");
    let content = item.content;
    if (Array.isArray(content) && content.length && content.every((part) => part && typeof part === "object" && Object.keys(part).every((key) => ["type", "text"].includes(key)) && part.type === "input_text")) {
      content = content.map((part) => { validText(part.text, 15000, "input message"); return part.text; }).join("\n");
    }
    validText(content, 15000, "input message");
    total += content.length;
    if (total > 15000) throw invalidSpecialist("Input message list exceeds the total text bound");
    return { role: item.role, content };
  });
}

function prepareMessagesRequest(input, candidate, idempotencyKey) {
  if (input.instructions !== undefined && input.system !== undefined) throw invalidSpecialist("Specify system or instructions, not both");
  const allowed = new Set(["model", "messages", "system", "instructions", "max_tokens", "stream", "metadata"]);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpecialist("Messages request must be an object");
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw invalidSpecialist(`Unsupported Messages field: ${unsupported}`);
  if (!Array.isArray(input.messages) || !input.messages.length) throw invalidSpecialist("messages must be a non-empty text message list");
  if (input.max_tokens !== undefined && (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 4096)) throw invalidSpecialist("max_tokens must be between 1 and 4096");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw invalidSpecialist("stream must be boolean");
  if (input.metadata !== undefined) throw invalidSpecialist("Messages metadata is unsupported by the text service");
  let totalText = 0;
  const messages = input.messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).some((key) => key !== "role" && key !== "content") || !["user", "assistant"].includes(message.role)) throw invalidSpecialist("Only user and assistant text Messages are supported");
    validText(message.content, 15000, "message content");
    totalText += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalText > 12000) throw invalidSpecialist("Messages history exceeds supported text bounds");
  let parentInstructions = "";
  const systemValue = input.system ?? input.instructions;
  if (systemValue !== undefined && systemValue !== null) {
    if (typeof systemValue === "string") parentInstructions = systemValue;
    else if (Array.isArray(systemValue) && systemValue.every((part) => part && part.type === "text" && typeof part.text === "string" && Object.keys(part).every((key) => ["type", "text", "cache_control"].includes(key)))) parentInstructions = systemValue.map((part) => part.text).join("\n");
    else throw invalidSpecialist("system must contain text only");
    validText(parentInstructions, 4000, "system", { empty: true });
  }
  const maxTokensNote = input.max_tokens === undefined ? "" : `\n[Requested output token limit is advisory; the text service cannot enforce it: ${input.max_tokens}]`;
  const visible = `[Visible specialist role guidance; user accepts visible instruction emulation, not true system priority]\n${candidate.specialistInstructions}\n[Parent-provided task guidance]\n${parentInstructions}${maxTokensNote}`;
  const prompt = [{ role: "system", content: visible }, ...messages].map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
  validText(prompt, 15000, "prepared prompt");
  return { body: { input: prompt }, idempotencyKey };
}

function prepareChatRequest(input, candidate, idempotencyKey) {
  const allowed = new Set(["model", "messages", "stream", "user"]);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpecialist("Chat Completions request must be an object");
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw invalidSpecialist(`Unsupported Chat Completions field: ${unsupported}`);
  if (!Array.isArray(input.messages) || !input.messages.length) throw invalidSpecialist("messages must be a non-empty text message list");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw invalidSpecialist("stream must be boolean");
  if (input.user !== undefined) validText(input.user, 200, "user");
  let totalText = 0;
  const messages = input.messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).some((key) => key !== "role" && key !== "content") || !["user", "assistant", "system", "developer"].includes(message.role)) throw invalidSpecialist("Only text Chat Completions messages are supported");
    validText(message.content, 15000, "message content");
    totalText += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalText > 12000) throw invalidSpecialist("Chat history exceeds supported text bounds");
  const prompt = [
    "[Visible specialist role guidance; user accepts visible instruction emulation, not true system priority]",
    candidate.specialistInstructions,
    "[Parent-provided task context follows in the submitted messages]",
    ...messages.map(({ role, content }) => `[${role}]\n${content}`),
  ].join("\n\n");
  validText(prompt, 15000, "prepared prompt");
  return { body: { model: input.model, input: prompt }, idempotencyKey };
}

export function prepareSpecialistRequest(input, candidate, idempotencyKey, protocol = "responses") {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200) throw invalidSpecialist("Idempotency-Key is required for ChatGPT specialist requests");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpecialist("Request must be an object");
  const allowed = protocol === "responses"
    ? new Set(["model", "input", "instructions", "stream"])
    : protocol === "messages"
      ? new Set(["model", "messages", "system", "instructions", "max_tokens", "stream", "metadata"])
      : protocol === "chat_completions"
        ? new Set(["model", "messages", "stream", "user"])
        : new Set();
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw invalidSpecialist(`Unsupported ${protocol} field: ${unsupported}`);
  let prepared;
  if (protocol === "responses") {
    if (input.stream !== undefined && typeof input.stream !== "boolean") throw invalidSpecialist("stream must be boolean");
    if (typeof input.input !== "string" && !Array.isArray(input.input)) throw invalidSpecialist("input must be text or a text message list");
    const request = structuredClone(input);
    const messages = canonicalTextInput(request.input);
    let parentInstructions = request.instructions ?? "";
    if (typeof parentInstructions !== "string") throw invalidSpecialist("instructions must be text or null");
    validText(parentInstructions, 4000, "instructions", { empty: true });
    const prompt = [
      "[Visible specialist role guidance; user accepts visible instruction emulation, not true system priority]",
      candidate.specialistInstructions,
      "[Parent-provided task guidance]",
      parentInstructions,
      ...messages.map(({ role, content }) => `[${role}]\n${content}`),
    ].join("\n\n");
    validText(prompt, 15000, "prepared prompt");
    prepared = { body: { model: request.model, input: prompt }, idempotencyKey };
  } else if (protocol === "messages") prepared = prepareMessagesRequest(input, candidate, idempotencyKey);
  else if (protocol === "chat_completions") prepared = prepareChatRequest(input, candidate, idempotencyKey);
  else throw invalidSpecialist("Unsupported specialist protocol");
  if (Buffer.byteLength(JSON.stringify(prepared.body), "utf8") > 65536) throw invalidSpecialist("Prepared specialist request exceeds the service request bound");
  return prepared;
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
  if (candidate.provider.adapter === "chatgpt-responses") {
    const endpoint = env.CHATGPT_SERVICE_URL;
    const token = env.CHATGPT_SERVICE_TOKEN;
    if (env.CHATGPT_RESPONSES_ENABLED !== "true" || !endpoint || !token) {
      throw new Error("ChatGPT specialist service is not configured");
    }
    const suffix = candidate.protocol === "messages" ? "messages" : candidate.protocol === "chat_completions" ? "chat/completions" : candidate.protocol === "responses" ? "responses" : null;
    if (!suffix) throw Object.assign(new Error("Unsupported ChatGPT specialist protocol"), { statusCode: 400 });
    const target = new URL(`/v1/${suffix}`, endpoint);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw new Error("ChatGPT specialist service URL is invalid");
    }
    const request = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body);
    const prepared = prepareSpecialistRequest(request, candidate, req.headers["idempotency-key"], candidate.protocol);
    const payload = Buffer.from(JSON.stringify(prepared.body));
    const headers = { "content-type": "application/json", "content-length": String(payload.length), authorization: `Bearer ${token}`, "idempotency-key": prepared.idempotencyKey };
    const { response, upstream } = await send({ target, headers, body: payload, signal });
    return { response, upstream, target, codec: null, specialist: true, specialistProtocol: candidate.protocol };
  }
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
