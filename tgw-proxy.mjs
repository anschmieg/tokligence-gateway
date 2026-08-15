#!/usr/bin/env node
// tgw-proxy — model-rewriting proxy in front of Tokligence Gateway
//
// For OpenCode MiniMax models: calls the OpenCode Messages endpoint
// For bare MiniMax models: forwards to gateway (which routes to MiniMax API)
// For GLM-5/Modal models: calls Modal directly (non-streaming only)

import http from "http";
import https from "https";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  CODEX_REASONING_LEVELS,
  codexUpstreamUrl,
  isCodexModel,
  isReservedCodexModel,
} from "./gateway-config.mjs";
import {
  configuredModels,
  loadRoutingConfig,
  matchConfiguredProvider,
  providerById,
  providerEnabled,
  publicRoutingConfig,
  resolveConfiguredAlias,
} from "./route-config.mjs";
import { probeAllProviderQuota } from "./quota.mjs";
import { RoutingPreferences, sanitizedPreferences } from "./preferences.mjs";
import { DASHBOARD_HTML } from "./dashboard.mjs";
import { cloudflareAccessConfigured, isValidCloudflareAccessToken } from "./cloudflare-access.mjs";
import { modelAllowedByCatalog } from "./model-catalog.mjs";
import { COPILOT_AUTO_MODEL, createCopilotAutoAdapter } from "./copilot-auto.mjs";

const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
const TGW_HOST   = process.env.TGW_HOST || "127.0.0.1";
const TGW_PORT   = Number(process.env.TGW_PORT || 8081);
const DEBUG = process.env.TGW_DEBUG === "1";
const ROUTING_CONFIG_PATH = path.resolve(process.env.ROUTING_CONFIG_PATH || "gateway.routes.yaml");
const ROUTING = loadRoutingConfig(ROUTING_CONFIG_PATH);

function providerApiKey(id) {
  const provider = providerById(ROUTING, id);
  return provider?.api_key_env ? process.env[provider.api_key_env] : null;
}

function providerBaseUrl(id) {
  const provider = providerById(ROUTING, id);
  const value = (provider?.base_url_env && process.env[provider.base_url_env]) || provider?.default_base_url;
  return value ? new URL(value) : null;
}

const MODAL_KEY = providerApiKey("modal");
const MODAL_URL = providerBaseUrl("modal");
const OPENROUTER_KEY = providerApiKey("openrouter");
const OPENROUTER_URL = providerBaseUrl("openrouter");
const OPENCODE_KEY = providerApiKey("opencode-go");
const OPENCODE_URL = providerBaseUrl("opencode-go");

const MISTRAL_KEY = providerApiKey("mistral");
const MISTRAL_URL = providerBaseUrl("mistral");

function loadOAuthAdapterConfig() {
  const provider = providerById(ROUTING, "codex-oauth");
  const enabled = Boolean(provider && providerEnabled(provider));
  const models = enabled ? provider.models.map(({ id }) => id) : [];
  const baseUrl = enabled
    ? new URL(process.env[provider.external_base_url_env] || "http://127.0.0.1:8317")
    : null;
  return {
    enabled,
    baseUrl,
    apiKey: enabled ? process.env[provider.internal_api_key_env] : null,
    models,
    modelSet: new Set(models.map((model) => model.toLowerCase())),
  };
}

const CODEX = loadOAuthAdapterConfig();

const COPILOT_AUTO_PROVIDER = providerById(ROUTING, "copilot-auto");
const COPILOT_AUTO_ENABLED = Boolean(COPILOT_AUTO_PROVIDER && providerEnabled(COPILOT_AUTO_PROVIDER));
const COPILOT_AUTO = COPILOT_AUTO_ENABLED
  ? createCopilotAutoAdapter({ logger: DEBUG ? console : { info() {} } })
  : null;

// Auth token prefix stripping: clients send sk-proj-<SECRET> or sk-ant-<SECRET>
// We validate against TOKLIGENCE_AUTH_SECRET and forward the bare secret to gateway
const AUTH_SECRET = process.env[ROUTING.access.public_secret_env];
const ADMIN_AUTH_SECRET = process.env[ROUTING.access.admin_secret_env];
const AUTH_PREFIXES = ["sk-proj-", "sk-ant-"];

const MINIMAX_BARE_MODELS = /^minimax-m2/i;
const MINIMAX_MODEL_FRAGMENT = /(^|\/)minimax-m2/i;

const MODEL_REGISTRY = new Map();
let modelRegistryRefresh = null;

const OPENROUTER_ALIASES = {
  // Manual mapping for specific model families
  "free": "openrouter/free",
};

function registerModel(id, provider, extra = {}) {
  if (!id) return;
  const key = id.toLowerCase();
  const existing = MODEL_REGISTRY.get(key);
  if (existing?.provider === "codex-oauth" && provider !== "codex-oauth") return;
  MODEL_REGISTRY.set(key, {
    id,
    provider,
    object: "model",
    created: extra.created || Math.floor(Date.now() / 1000),
    owned_by: extra.owned_by || provider,
    ...extra
  });
}

function modelProvider(model) {
  if (!model) return null;
  return MODEL_REGISTRY.get(model.toLowerCase())?.provider || null;
}

function getAvailableModels() {
  return Array.from(MODEL_REGISTRY.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => ({
      id: model.id,
      slug: model.id,
      display_name: model.display_name || model.id,
      description: model.description || `${model.provider} model`,
      supported_reasoning_levels: model.supported_reasoning_levels || [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: "",
      supports_reasoning_summaries: model.supports_reasoning_summaries || false,
      default_reasoning_summary: model.supports_reasoning_summaries ? "auto" : "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: model.supports_parallel_tool_calls || false,
      supports_image_detail_original: false,
      context_window: model.context_window || 272000,
      experimental_supported_tools: [],
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      provider: model.provider,
    }));
}

function seedConfiguredModels() {
  MODEL_REGISTRY.clear();

  for (const model of configuredModels(ROUTING)) {
    const provider = providerById(ROUTING, model.provider);
    if (!modelAllowedByCatalog(provider, model)) continue;
    const codexMetadata = model.provider === "codex-oauth" ? {
      supported_reasoning_levels: CODEX_REASONING_LEVELS,
      supports_reasoning_summaries: true,
      supports_parallel_tool_calls: true,
    } : {};
    registerModel(model.id, model.provider, { ...model, ...codexMetadata, source: "config", discoveredBy: undefined });
  }
}

function fetchJson(options) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === "https:" || Number(options.port) === 443 ? https : http;
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("Invalid JSON from model provider"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function prefixedModelId(id, prefix) {
  if (!prefix || id.toLowerCase().startsWith(prefix.toLowerCase())) return id;
  return `${prefix}${id}`;
}

async function registerModelsFromEndpoint({ provider, hostname, port, path, headers = {}, prefix = "", filter: modelFilter = null }) {
  const data = await fetchJson({ hostname, port, path, method: "GET", headers });
  const providerConfig = providerById(ROUTING, provider);
  const registered = new Set();
  for (const model of data?.data || []) {
    const candidate = typeof model === "string" ? { id: model } : model;
    if (modelFilter && !modelFilter(candidate)) continue;
    const id = candidate?.id;
    if (!id || !modelAllowedByCatalog(providerConfig, candidate)) continue;
    const fullId = prefixedModelId(id, prefix);
    registerModel(fullId, provider, {
      created: candidate.created,
      owned_by: candidate.owned_by || provider,
      discovered: true,
      discoveredBy: provider,
      context_length: typeof candidate.context_length === "number" ? candidate.context_length : undefined,
      context_window: typeof candidate.context_window === "number" ? candidate.context_window : (typeof candidate.context_length === "number" ? candidate.context_length : undefined),
      pricing: candidate.pricing || undefined,
    });
    registered.add(fullId.toLowerCase());
  }
  return registered;
}

function pruneStaleDiscovered(provider, keepIds) {
  // Keep the provider's endpoint-derived model list current: drop discovered
  // entries that no longer appear upstream. Explicitly configured models
  // (gateway.routes.yaml) are intentionally kept as a stable base/fallback so
  // routing aliases keep resolving even when an upstream endpoint omits them.
  for (const [key, model] of MODEL_REGISTRY) {
    if (model.provider !== provider) continue;
    if (model.source === "config") continue;
    if (!keepIds.has(key)) {
      MODEL_REGISTRY.delete(key);
    }
  }
}

async function refreshModelRegistry() {
  if (modelRegistryRefresh) return modelRegistryRefresh;

  modelRegistryRefresh = (async () => {
    seedConfiguredModels();
    const refreshes = [];

    if (OPENCODE_KEY) {
      const headers = { Authorization: `Bearer ${OPENCODE_KEY}` };
      refreshes.push({
        provider: "opencode-go",
        promise: registerModelsFromEndpoint({
          provider: "opencode-go",
          hostname: OPENCODE_URL.hostname,
          port: OPENCODE_URL.port || 443,
          path: "/zen/go/v1/models",
          headers,
          prefix: "opencode-go/"
        }),
      });
      refreshes.push({
        provider: "opencode-zen",
        promise: registerModelsFromEndpoint({
          provider: "opencode-zen",
          hostname: OPENCODE_URL.hostname,
          port: OPENCODE_URL.port || 443,
          path: "/zen/v1/models",
          headers,
          prefix: "opencode-zen/"
        }),
      });
    }

    if (OPENROUTER_KEY) {
      refreshes.push({
        provider: "openrouter",
        promise: registerModelsFromEndpoint({
          provider: "openrouter",
          hostname: OPENROUTER_URL.hostname,
          port: OPENROUTER_URL.port || 443,
          path: `${OPENROUTER_URL.pathname.replace(/\/$/, "")}/models`,
          headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
          prefix: "openrouter/",
        }),
      });
    }

    if (MISTRAL_KEY) {
      refreshes.push({
        provider: "mistral",
        promise: registerModelsFromEndpoint({
          provider: "mistral",
          hostname: MISTRAL_URL.hostname,
          port: MISTRAL_URL.port || 443,
          path: `${MISTRAL_URL.pathname.replace(/\/$/, "")}/models`,
          headers: { Authorization: `Bearer ${MISTRAL_KEY}` },
          prefix: "mistral/"
        }),
      });
    }

    refreshes.push({
      provider: "tokligence",
      promise: registerModelsFromEndpoint({
        provider: "tokligence",
        hostname: TGW_HOST,
        port: TGW_PORT,
        path: "/v1/models"
      }),
    });

    const results = await Promise.allSettled(refreshes.map((r) => r.promise));
    // Prune entries a provider dropped, so /models always stays current. A
    // successfully fetched provider endpoint is the source of truth for that
    // provider's model list, covering both discovered and config-seeded
    // entries. OpenRouter's keep-set only ever contains free models (paid ones
    // are filtered out at registration), so paid models are excluded here too.
    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      if (settled.status === "rejected") continue;
      const provider = refreshes[i]?.provider;
      if (provider) pruneStaleDiscovered(provider, settled.value);
    }

    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(`model registry refresh warning: ${result.reason.message}`);
      }
    }
  })().finally(() => {
    modelRegistryRefresh = null;
  });

  return modelRegistryRefresh;
}

seedConfiguredModels();

// ---------------------------------------------------------------------------
// Dashboard backend: runtime routing-preference overrides + quota probes.
// Preferences apply immediately in this process and persist to a sidecar file
// so they survive a restart. Quota probes never echo credentials.
// ---------------------------------------------------------------------------
const PREFERENCES = new RoutingPreferences(ROUTING, {
  file: process.env.ROUTING_PREFERENCES_PATH || "gateway.preferences.yaml",
  routesPath: ROUTING_CONFIG_PATH,
  readonly: process.env.ROUTING_PREFERENCES_READONLY === "1",
});

function quotaContext() {
  return {
    openrouterKey: providerApiKey("openrouter"),
    openrouterBaseUrl: providerBaseUrl("openrouter")?.toString() || "https://openrouter.ai/api/v1",
    mistralKey: providerApiKey("mistral"),
    mistralBaseUrl: providerBaseUrl("mistral")?.toString() || "https://api.mistral.ai/v1",
    opencodeKey: providerApiKey("opencode-go"),
    opencodeBaseUrl: providerBaseUrl("opencode-go")?.toString() || "https://opencode.ai",
    minimaxKey: providerApiKey("tokligence"),
    minimaxBaseUrl: providerBaseUrl("tokligence")?.toString() || "https://api.minimax.io/v1",
    modalKey: providerApiKey("modal"),
    modalBaseUrl: providerBaseUrl("modal")?.toString() || "https://api.us-west-2.modal.direct",
  };
}

function resolveModel(model) {
  return PREFERENCES.resolve(model, resolveConfiguredAlias);
}

function isOpenRouterModel(model) {
  return modelProvider(model) === "openrouter" || matchConfiguredProvider(ROUTING, model) === "openrouter";
}

function isOpenCodeModel(model) {
  const provider = modelProvider(model);
  const configured = matchConfiguredProvider(ROUTING, model);
  return provider === "opencode-go" || provider === "opencode-zen" || configured === "opencode-go" || configured === "opencode-zen";
}

function isOpenCodeMiniMaxModel(model) {
  return isOpenCodeModel(model) && MINIMAX_MODEL_FRAGMENT.test(model);
}

function resolveOpenRouterModel(model) {
  if (!model) return model;
  if (model.toLowerCase().startsWith("openrouter/")) {
    return model.slice(11);
  }
  if (model.toLowerCase().startsWith("or/")) {
    return model.slice(3);
  }
  for (const [prefix, target] of Object.entries(OPENROUTER_ALIASES)) {
    if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
      return target;
    }
  }
  return model;
}

function resolveOpenCodeModel(model) {
  if (!model) return model;
  if (model.toLowerCase().startsWith("opencode-go/")) {
    return model.slice(12);
  }
  if (model.toLowerCase().startsWith("opencode-zen/")) {
    return model.slice(13);
  }
  if (model.toLowerCase().startsWith("oc/")) {
    return model.slice(3);
  }
  if (model.toLowerCase().startsWith("zen/")) {
    return model.slice(4);
  }
  return model;
}

function getOpenCodeMessagesPath(model) {
  if (!model) return "/zen/go/v1/messages";
  const provider = modelProvider(model);
  const lower = model.toLowerCase();
  if (provider === "opencode-zen" || lower.startsWith("opencode-zen/") || lower.startsWith("zen/")) {
    return "/zen/v1/messages";
  }
  return "/zen/go/v1/messages";
}

function getOpenCodeChatCompletionsPath(model) {
  if (!model) return "/zen/go/v1/chat/completions";
  const provider = modelProvider(model);
  const lower = model.toLowerCase();
  if (provider === "opencode-zen" || lower.startsWith("opencode-zen/") || lower.startsWith("zen/")) {
    return "/zen/v1/chat/completions";
  }
  return "/zen/go/v1/chat/completions";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content?.text || "";
  return content.map((part) => part.text || part.content || "").join("");
}

function toOpenAIChatMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === "developer" ? "system" : m.role,
    content: textFromContent(m.content)
  }));
}

function toAnthropicMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string"
      ? m.content
      : [{ type: "text", text: textFromContent(m.content) }]
  }));
}

function responseTextFromAnthropic(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.completion === "string") return data.completion;
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.message?.content === "string") return data.message.content;
  if (Array.isArray(data?.choices)) {
    return data.choices
      .map((choice) => choice.message?.content || choice.message?.reasoning_content || choice.text || "")
      .join("");
  }
  const content = data?.content || [];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (
    part.text ||
    part.thinking ||
    part.content ||
    part.input ||
    (Array.isArray(part.content) ? textFromContent(part.content) : "") ||
    ""
  )).join("");
}

function anthropicToChatCompletion(data, requestedModel) {
  const text = responseTextFromAnthropic(data);
  return {
    id: data.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: data.stop_reason || "stop"
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    }
  };
}

function anthropicToMessage(data, requestedModel) {
  return {
    type: "message",
    id: data.id || `msg_${Date.now()}`,
    model: requestedModel,
    role: "assistant",
    content: [{ type: "text", text: responseTextFromAnthropic(data) }],
    stop_reason: data.stop_reason || "end_turn",
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0
    }
  };
}

function responsesPayloadToMessages(parsed) {
  if (parsed.messages) return parsed.messages;
  const input = parsed.input || "";
  if (Array.isArray(input)) {
    return input.map((item) => ({
      role: item.role || "user",
      content: textFromContent(item.content || item)
    }));
  }
  return [{ role: "user", content: input }];
}

function buildResponsePayload(model, text) {
  const id = `resp_${Date.now()}`;
  const outputItem = {
    type: "message",
    role: "assistant",
    end_turn: true,
    content: [{ type: "output_text", text }]
  };
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [outputItem],
    output_text: text
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendResponsesResult(res, model, text, stream = false) {
  if (DEBUG) console.error(`responses result model=${model} stream=${stream} text_len=${text.length}`);
  const response = buildResponsePayload(model, text);
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  const outputItem = response.output[0];
  const contentPart = outputItem.content[0];
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  writeSse(res, "response.created", { type: "response.created", response: { ...response, output: [] } });
  writeSse(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...outputItem, content: [] } });
  writeSse(res, "response.content_part.added", { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
  if (text) {
    writeSse(res, "response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
  }
  writeSse(res, "response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0, text });
  writeSse(res, "response.content_part.done", { type: "response.content_part.done", output_index: 0, content_index: 0, part: contentPart });
  writeSse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: outputItem });
  writeSse(res, "response.completed", { type: "response.completed", response });
  res.write("data: [DONE]\n\n");
  res.end();
}

function isGlmModel(model) {
  return matchConfiguredProvider(ROUTING, model) === "modal";
}

function extractBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function secretsEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function publicSecretFromToken(token) {
  if (!token) return null;
  if (secretsEqual(token, AUTH_SECRET)) return AUTH_SECRET;
  for (const prefix of AUTH_PREFIXES) {
    if (token.startsWith(prefix)) {
      const secret = token.slice(prefix.length);
      if (secretsEqual(secret, AUTH_SECRET)) return secret;
    }
  }
  return null;
}

function validateAndStripAuth(req) {
  const strippedToken = publicSecretFromToken(extractBearerToken(req.headers["authorization"]));
  if (!strippedToken) return false;
  req.headers["authorization"] = `Bearer ${strippedToken}`;
  return true;
}

async function validateAdminAuth(req) {
  // 1) Admin bearer secret (TOKLIGENCE_ADMIN_SECRET) — legacy / direct-origin path.
  if (secretsEqual(extractBearerToken(req.headers["authorization"]), ADMIN_AUTH_SECRET)) {
    return true;
  }
  // 2) Cloudflare Access JWT (Cf-Access-Jwt header): if present, validate strictly.
  //    A browser request that passed the Cloudflare Access policy at the edge may
  //    not carry this header by the time it reaches us, but when it does we make
  //    sure it is genuine so a direct-origin caller can't spoof it.
  if (cloudflareAccessConfigured()) {
    const cfToken = req.headers["cf-access-jwt"];
    if (typeof cfToken === "string" && cfToken) {
      try {
        return await isValidCloudflareAccessToken(cfToken);
      } catch {
        return false;
      }
    }
    // 3) No JWT header present: trust Cloudflare Access at the edge. The dashboard
    //    /admin routes are only publicly reachable through the Cloudflare-fronted
    //    proxy, which enforces the Access policy before traffic reaches us, so a
    //    request already allowed in is authentic. When Access is enabled we do not
    //    force the origin to re-validate the token the browser flow doesn't send.
    return true;
  }
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const CODEX_FORWARD_HEADERS = [
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "user-agent",
  "x-request-id",
];

function proxyToCodex(req, res, body) {
  const target = codexUpstreamUrl(CODEX, req.url);
  const client = target.protocol === "https:" ? https : http;
  const headers = {
    Authorization: `Bearer ${CODEX.apiKey}`,
    "Content-Length": String(body.length),
  };
  for (const name of CODEX_FORWARD_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }

  const upstream = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Codex backend unavailable" }));
  });
  req.once("aborted", () => upstream.destroy());
  res.once("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.end(body);
}

function handleCodexRoute(req, res, parsed, model) {
  if (isCodexModel(CODEX, model)) {
    proxyToCodex(req, res, Buffer.from(JSON.stringify({ ...parsed, model })));
    return true;
  }
  if (isReservedCodexModel(model)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Codex model is not configured: ${model}` }));
    return true;
  }
  return false;
}

function providerSummary() {
  const config = publicRoutingConfig(ROUTING);
  return { object: "list", data: config.providers };
}

function callModal(model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "zai-org/GLM-5-FP8",
      messages,
      stream: false,
      max_tokens: maxTokens
    });

    const options = {
      hostname: MODAL_URL.hostname,
      port: MODAL_URL.port || 443,
      path: MODAL_URL.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MODAL_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch {
          reject(new Error("Invalid JSON from Modal"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callOpenCodeGoOpenAI(model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: resolveOpenCodeModel(model),
      messages,
      stream: false,
      max_tokens: maxTokens
    });

    const options = {
      hostname: OPENCODE_URL.hostname,
      port: OPENCODE_URL.port || 443,
      path: getOpenCodeChatCompletionsPath(model),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENCODE_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch {
          reject(new Error("Invalid JSON from OpenCode Go"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callOpenCodeMessages(model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: resolveOpenCodeModel(model),
      messages: toAnthropicMessages(messages),
      stream: false,
      max_tokens: maxTokens
    });

    const options = {
      hostname: OPENCODE_URL.hostname,
      port: OPENCODE_URL.port || 443,
      path: getOpenCodeMessagesPath(model),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENCODE_KEY}`,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch {
          reject(new Error("Invalid JSON from OpenCode Messages"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callOpenRouterOpenAI(model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: resolveOpenRouterModel(model),
      messages,
      stream: false,
      max_tokens: maxTokens
    });

    const options = {
      hostname: OPENROUTER_URL.hostname,
      port: OPENROUTER_URL.port || 443,
      path: `${OPENROUTER_URL.pathname.replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Length": Buffer.byteLength(body),
        "HTTP-Referer": "https://github.com/tokligence/gateway",
        "X-Title": "Tokligence Gateway"
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch {
          reject(new Error("Invalid JSON from OpenRouter"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function resolveMistralModel(model) {
  if (!model) return model;
  if (model.toLowerCase().startsWith("mistral/")) {
    return model.slice(8);
  }
  return model;
}

function isMistralModel(model) {
  return modelProvider(model) === "mistral" || matchConfiguredProvider(ROUTING, model) === "mistral";
}

function callMistralOpenAI(model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: resolveMistralModel(model),
      messages,
      stream: false,
      max_tokens: maxTokens
    });

    const options = {
      hostname: MISTRAL_URL.hostname,
      port: MISTRAL_URL.port || 443,
      path: `${MISTRAL_URL.pathname.replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MISTRAL_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch {
          reject(new Error("Invalid JSON from Mistral"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function openAIToAnthropicMessage(data, requestedModel) {
  const msg = data?.choices?.[0]?.message;
  const text = msg?.content || "";
  return {
    type: "message",
    id: data.id || `msg_${Date.now()}`,
    model: requestedModel,
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stop_reason: "end_turn",
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0
    }
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "tgw-proxy",
    }));
    return;
  }

  if (url.pathname.startsWith("/admin/")) {
    validateAdminAuth(req).then((isAdmin) => {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/routes") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(publicRoutingConfig(ROUTING)));
      return;
    }

    // Admin status used by the dashboard.
    if (req.method === "GET" && url.pathname === "/admin/status") {
      const enabled = ROUTING.providers.filter((provider) => providerEnabled(provider));
      const configured = enabled.map((provider) => ({ id: provider.id, adapter: provider.adapter }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "tgw-proxy",
        preferences_file: process.env.ROUTING_PREFERENCES_PATH || "gateway.preferences.yaml",
        preferences_readonly: process.env.ROUTING_PREFERENCES_READONLY === "1",
        providers: configured,
        model_count: MODEL_REGISTRY.size,
        upstreams: { tokligence: `${TGW_HOST}:${TGW_PORT}` },
      }));
      return;
    }

    // Live quota/balance for every enabled provider.
    if (req.method === "GET" && url.pathname === "/admin/quota") {
      const enabled = ROUTING.providers.filter((provider) => providerEnabled(provider));
      probeAllProviderQuota(enabled, quotaContext())
        .then((data) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data }));
        })
        .catch((error) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        });
      return;
    }

    // Routing-preference overrides (the "customize routing" part of the UI).
    if (req.method === "GET" && url.pathname === "/admin/preferences") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sanitizedPreferences(PREFERENCES)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/preferences") {
      readJsonBody(req).then((body) => {
        const { id, override } = body || {};
        if (!id || !override) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expected { id, override }" }));
          return;
        }
        const errors = PREFERENCES.set(id, override);
        if (errors.length) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid override", details: errors }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sanitizedPreferences(PREFERENCES)));
      }).catch(() => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/preferences/clear") {
      readJsonBody(req).then((body) => {
        const id = body?.id;
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expected { id }" }));
          return;
        }
        PREFERENCES.clear(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sanitizedPreferences(PREFERENCES)));
      }).catch(() => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/preferences/reset") {
      PREFERENCES.reset();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sanitizedPreferences(PREFERENCES)));
      return;
    }

    // Permanently write overrides into gateway.routes.yaml (source of truth).
    if (req.method === "POST" && url.pathname === "/admin/preferences/bake") {
      try {
        const summary = PREFERENCES.bakeToRoutes();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ baked: true, ...summary }));
      } catch (error) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
    });
    return;
  }

  // Dashboard UI (HTML). Admin auth only. The canonical, Cloudflare-Access-protected
  // path is /dashboard; send visitors from / to it so the browser flow always lands
  // on an Access-protected URL.
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(302, { "Location": "/dashboard" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/dashboard") {
    validateAdminAuth(req).then((isAdmin) => {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
    });
    return;
  }

  // Handle /models endpoint - return aggregated model list
  if ((req.method === "GET" || req.method === "POST") && ["/models", "/v1/models"].includes(url.pathname)) {
    if (!validateAndStripAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    refreshModelRegistry()
      .catch((err) => console.warn(`model registry refresh failed: ${err.message}`))
      .finally(() => {
        const models = getAvailableModels();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: models,
          models,
        }));
      });
    return;
  }

  if (!validateAndStripAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(providerSummary()));
    return;
  }

  const isAnthropic = req.url.includes("/v1/messages") && !req.url.includes("/responses");
  const isResponses = req.url.includes("/responses");
  const isChatCompletions = req.url.includes("/v1/chat/completions");
  // Handle Chat Completions API (OpenAI) - for Codex
  if (req.method === "POST" && isChatCompletions) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed;
      
      try {
        parsed = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const model = resolveModel(parsed.model);

      if (model === COPILOT_AUTO_MODEL) {
        if (!COPILOT_AUTO) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Copilot Auto is not configured" }));
          return;
        }
        // Do not silently discard OpenAI tool declarations. This adapter runs
        // the official Copilot runtime with an empty tool allowlist; tool-call
        // translation is a separate, explicit follow-up.
        if (parsed.tools || parsed.tool_choice) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "copilot-auto does not support OpenAI tool calls yet" }));
          return;
        }

        const id = `chatcmpl_${Date.now()}`;
        let streamed = false;
        const onDelta = (content) => {
          if (!streamed) return;
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: COPILOT_AUTO_MODEL,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`);
        };

        (async () => {
          try {
            if (parsed.stream === true) {
              streamed = true;
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(`data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: COPILOT_AUTO_MODEL,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })}\n\n`);
            }

            const result = await COPILOT_AUTO.complete({ messages: parsed.messages || [], onDelta });
            const selected = result.route?.chosenModel;
            if (parsed.stream === true) {
              res.write(`data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: COPILOT_AUTO_MODEL,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`);
              res.end("data: [DONE]\n\n");
              return;
            }

            const headers = { "Content-Type": "application/json" };
            if (selected) headers["X-Tokligence-Copilot-Selected-Model"] = selected;
            res.writeHead(200, headers);
            res.end(JSON.stringify({
              id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: COPILOT_AUTO_MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
            }));
          } catch (error) {
            console.warn(`copilot-auto request failed: ${error?.name || "Error"}`);
            if (res.headersSent) {
              res.end();
              return;
            }
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Copilot Auto unavailable" }));
          }
        })();
        return;
      }

      if (handleCodexRoute(req, res, parsed, model)) return;
      
      if (isOpenCodeMiniMaxModel(model)) {
        callOpenCodeMessages(model, parsed.messages || [], parsed.max_tokens || 4096)
          .then((data) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicToChatCompletion(data, model)));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeModel(model)) {
        const messages = toOpenAIChatMessages(parsed.messages || []);
        callOpenCodeGoOpenAI(model, messages, parsed.max_tokens || 4096)
          .then((data) => {
            // Convert OpenAI chat completions to OpenAI format
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenRouterModel(model)) {
        const rewritten = resolveOpenRouterModel(model);
        const proxyBody = Buffer.from(JSON.stringify({ ...parsed, model: rewritten }));
        
        const forwardHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Length": String(proxyBody.length),
          "HTTP-Referer": "https://github.com/tokligence/gateway",
          "X-Title": "Tokligence Gateway"
        };

        const options = {
          hostname: OPENROUTER_URL.hostname,
          port: OPENROUTER_URL.port || 443,
          path: `${OPENROUTER_URL.pathname.replace(/\/$/, "")}/chat/completions`,
          method: "POST",
          headers: forwardHeaders
        };

        const upstream = https.request(options, (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        });

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(proxyBody);
      } else if (isMistralModel(model)) {
        const rewritten = resolveMistralModel(model);
        const proxyBody = Buffer.from(JSON.stringify({ ...parsed, model: rewritten }));

        const forwardHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MISTRAL_KEY}`,
          "Content-Length": String(proxyBody.length)
        };

        const options = {
          hostname: MISTRAL_URL.hostname,
          port: MISTRAL_URL.port || 443,
          path: `${MISTRAL_URL.pathname.replace(/\/$/, "")}/chat/completions`,
          method: "POST",
          headers: forwardHeaders
        };

        const upstream = https.request(options, (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        });

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(proxyBody);
      } else if (MINIMAX_BARE_MODELS.test(model)) {
        // MiniMax models: forward to gateway (port 8081)
        const mappedModel = resolveConfiguredAlias(ROUTING, model);
        const proxyBody = Buffer.from(JSON.stringify({ ...parsed, model: mappedModel }));
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        headers["content-type"] = "application/json";
        headers["content-length"] = String(proxyBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: "/v1/chat/completions", method: "POST", headers },
          (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          }
        );

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(proxyBody);
      } else {
        // Forward to gateway
        const proxyBody = Buffer.from(JSON.stringify({ ...parsed, model }));
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        headers["content-type"] = "application/json";
        headers["content-length"] = String(proxyBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: "/v1/chat/completions", method: "POST", headers },
          (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          }
        );
        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
        upstream.end(proxyBody);
      }
    });
    return;
  }

  // Handle Responses API - translate to Messages API
  if (req.method === "POST" && isResponses) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed;
      
      try {
        parsed = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const model = resolveModel(parsed.model);
      const messages = responsesPayloadToMessages(parsed);

      if (handleCodexRoute(req, res, parsed, model)) return;
      if (DEBUG) {
        console.error(`responses request model=${model} stream=${parsed.stream === true} messages=${JSON.stringify(messages).slice(0, 1000)}`);
      }
      
      // Check if GLM model
      if (isGlmModel(model)) {
        callModal("zai-org/GLM-5-FP8", messages.map((m) => ({
          role: m.role,
          content: textFromContent(m.content)
        })), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || msg?.reasoning_content || "";
            
            sendResponsesResult(res, model, text, parsed.stream === true);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeMiniMaxModel(model)) {
        callOpenCodeMessages(model, messages, parsed.max_tokens || 4096)
          .then((data) => {
            sendResponsesResult(res, model, responseTextFromAnthropic(data), parsed.stream === true);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeModel(model)) {
        callOpenCodeGoOpenAI(model, toOpenAIChatMessages(messages), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            sendResponsesResult(res, model, text, parsed.stream === true);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenRouterModel(model)) {
        callOpenRouterOpenAI(model, toOpenAIChatMessages(messages), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            sendResponsesResult(res, model, text, parsed.stream === true);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isMistralModel(model)) {
        callMistralOpenAI(model, toOpenAIChatMessages(messages), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            sendResponsesResult(res, model, text, parsed.stream === true);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (MINIMAX_BARE_MODELS.test(model)) {
        // MiniMax: forward to gateway as Messages API
        const mappedModel = MINIMAX_MAP[model.toLowerCase()] || model;
        const messagesPayload = {
          model: mappedModel,
          max_tokens: parsed.max_tokens || 4096,
          messages: messages
        };
        
        const proxyBody = Buffer.from(JSON.stringify(messagesPayload));
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        headers["content-type"] = "application/json";
        headers["anthropic-version"] = "2023-06-01";
        headers["content-length"] = String(proxyBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: "/v1/messages", method: "POST", headers },
          (upRes) => {
            let data = '';
            upRes.on('data', c => data += c);
            upRes.on('end', () => {
              try {
                const resp = JSON.parse(data);
                const output = resp.content?.[0]?.text || resp.content?.[0]?.thinking || "";
                sendResponsesResult(res, model, output, parsed.stream === true);
              } catch {
                res.writeHead(upRes.statusCode, upRes.headers);
                res.end(data);
              }
            });
          }
        );
        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
        upstream.end(proxyBody);
      } else {
        // Forward to gateway as Messages API
        const messagesPayload = {
          model: model,
          max_tokens: parsed.max_tokens || 4096,
          messages: messages
        };
        
        const proxyBody = Buffer.from(JSON.stringify(messagesPayload));
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        headers["content-type"] = "application/json";
        headers["anthropic-version"] = "2023-06-01";
        headers["content-length"] = String(proxyBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: "/v1/messages", method: "POST", headers },
          (upRes) => {
            let data = '';
            upRes.on('data', c => data += c);
            upRes.on('end', () => {
              try {
                const resp = JSON.parse(data);
                // Translate back to Responses API format
                const output = resp.content?.[0]?.text || resp.content?.[0]?.thinking || "";
                sendResponsesResult(res, model, output, parsed.stream === true);
              } catch {
                res.writeHead(upRes.statusCode, upRes.headers);
                res.end(data);
              }
            });
          }
        );
        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
        upstream.end(proxyBody);
      }
    });
    return;
  }

  if (req.method === "POST" && isAnthropic) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let parsed;
      
      try {
        parsed = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const model = resolveModel(parsed.model);

      if (handleCodexRoute(req, res, parsed, model)) return;

      if (isGlmModel(model)) {
        // Modal's GLM-5 has broken streaming: all text (including actual responses)
        // comes through reasoning_content instead of content, making streaming unusable.
        // We ALWAYS use non-streaming and extract the actual response from content
        // (falling back to reasoning_content if needed).
        
        const streamRequested = parsed.stream === true;
        let warning = null;
        
        if (streamRequested) {
          warning = "Note: Streaming is not supported for GLM-5 on Modal. Response is non-streaming.";
        }
        
        const messages = parsed.messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content) 
            ? m.content.map(c => c.text || c.content || "").join("")
            : m.content
        }));

        callModal("zai-org/GLM-5-FP8", messages, parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content;
            
            if (!text && msg?.reasoning_content) {
              text = msg.reasoning_content;
            }

            const response = {
              type: "message",
              id: data.id || `msg_${Date.now()}`,
              model: model,
              role: "assistant",
              content: warning ? [
                { type: "text", text: warning },
                { type: "text", text: text || "" }
              ] : (text ? [{ type: "text", text }] : []),
              stop_reason: "end_turn",
              usage: {
                input_tokens: data.usage?.prompt_tokens || 0,
                output_tokens: data.usage?.completion_tokens || 0
              }
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeMiniMaxModel(model)) {
        callOpenCodeMessages(model, parsed.messages || [], parsed.max_tokens || 4096)
          .then((data) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicToMessage(data, model)));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeModel(model)) {
        const messages = toOpenAIChatMessages(parsed.messages || []);

        callOpenCodeGoOpenAI(model, messages, parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            const response = {
              type: "message",
              id: data.id || `msg_${Date.now()}`,
              model: model,
              role: "assistant",
              content: [{ type: "text", text }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: data.usage?.prompt_tokens || 0,
                output_tokens: data.usage?.completion_tokens || 0
              }
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenRouterModel(model)) {
        const rewritten = resolveOpenRouterModel(model);
        parsed.model = rewritten;
        const proxyBody = Buffer.from(JSON.stringify(parsed));

        const forwardHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": "https://github.com/tokligence/gateway",
          "X-Title": "Tokligence Gateway"
        };
        
        if (req.headers["anthropic-version"]) {
          forwardHeaders["anthropic-version"] = req.headers["anthropic-version"];
        }

        const options = {
          hostname: OPENROUTER_URL.hostname,
          port: OPENROUTER_URL.port || 443,
          path: `${OPENROUTER_URL.pathname.replace(/\/$/, "")}/messages`,
          method: "POST",
          headers: forwardHeaders
        };

        const upstream = https.request(options, (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        });

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(proxyBody);
      } else if (isMistralModel(model)) {
        const messages = toOpenAIChatMessages(parsed.messages || []);

        callMistralOpenAI(model, messages, parsed.max_tokens || 4096)
          .then((data) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(openAIToAnthropicMessage(data, model)));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (MINIMAX_BARE_MODELS.test(model)) {
        // MiniMax: forward to gateway
        const mappedModel = MINIMAX_MAP[model.toLowerCase()] || model;
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        const updatedBody = Buffer.from(JSON.stringify({ ...parsed, model: mappedModel }));
        headers["content-length"] = String(updatedBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: req.url, method: req.method, headers },
          (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          }
        );

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(updatedBody);
      } else {
        const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
        const updatedBody = Buffer.from(JSON.stringify({ ...parsed, model }));
        headers["content-type"] = "application/json";
        headers["content-length"] = String(updatedBody.length);

        const upstream = http.request(
          { host: TGW_HOST, port: TGW_PORT, path: req.url, method: req.method, headers },
          (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          }
        );

        upstream.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        upstream.end(updatedBody);
      }
    });
  } else {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
      headers["content-length"] = String(body.length);

      const upstream = http.request(
        { host: TGW_HOST, port: TGW_PORT, path: req.url, method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        }
      );

      upstream.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });

      upstream.end(body);
    });
  }
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PROXY_PORT;
  console.log(`tgw-proxy :${listeningPort} -> tgw ${TGW_HOST}:${TGW_PORT}`);
  console.log("  glm-5 / zai-org/* -> Modal (always non-streaming)");
  console.log("  OpenCode MiniMax -> OpenCode Messages (non-streaming)");
  console.log("  other opencode-go/* / oc/* -> OpenCode chat completions (non-streaming)");
  console.log("  openrouter/* / or/* / free -> OpenRouter (streaming OK)");
  console.log("  mistral/* / mistral-* -> Mistral (streaming OK)");
  console.log(CODEX.enabled
    ? "  claude-* -> Codex OAuth (GPT-5.6 tier mapping)"
    : "  claude-* -> OpenCode Go (Tier mapping, non-streaming)");
  console.log("  bare minimax-* -> Gateway (MiniMax, streaming OK)");
  console.log(`  codex-oauth -> ${CODEX.enabled ? "private Codex backend" : "disabled"}`);
});
