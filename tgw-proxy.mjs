#!/usr/bin/env node
// tgw-proxy — model-rewriting proxy in front of Tokligence Gateway
//
// For OpenCode MiniMax models: calls the OpenCode Messages endpoint
// For bare MiniMax models: forwards to gateway (which routes to MiniMax API)
// For GLM-5/Modal models: calls Modal directly (non-streaming only)

import http from "http";
import https from "https";

const PROXY_PORT = 8080;
const TGW_HOST   = "127.0.0.1";
const TGW_PORT   = 8081;
const MODAL_KEY  = process.env.MODAL_GLM5_API_KEY || "modalresearch_qCoc8v8mnEgVCIyzHNHmBw6E2QjbAE9PFuk6aCWFEno";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEBUG = process.env.TGW_DEBUG === "1";

// Auth token prefix stripping: clients send sk-proj-<SECRET> or sk-ant-<SECRET>
// We validate against TOKLIGENCE_AUTH_SECRET and forward the bare secret to gateway
const AUTH_SECRET = process.env.TOKLIGENCE_AUTH_SECRET;
const AUTH_PREFIXES = ["sk-proj-", "sk-ant-"];

const GLM_MODELS = /^glm-5|^zai-org\/GLM-5/i;
const OPENROUTER_MODELS = /^openrouter\/|^or\/|^free/i;
const OPENCODE_MODELS = /^opencode-go\/|^opencode-zen\/|^oc\/|^zen\/|^deepseek-v4|^kimi-k2|^glm-5\.\d|^mimo-v2|^qwen3/i;
const MINIMAX_BARE_MODELS = /^minimax-m2/i;
const MINIMAX_MODEL_FRAGMENT = /(^|\/)minimax-m2/i;

const FALLBACK_MODELS = [
  { id: "opencode-go/deepseek-v4-pro", provider: "opencode-go" },
  { id: "opencode-go/deepseek-v4-flash", provider: "opencode-go" },
  { id: "opencode-go/glm-5", provider: "opencode-go" },
  { id: "opencode-go/glm-5.1", provider: "opencode-go" },
  { id: "opencode-go/kimi-k2.5", provider: "opencode-go" },
  { id: "opencode-go/kimi-k2.6", provider: "opencode-go" },
  { id: "opencode-go/mimo-v2.5", provider: "opencode-go" },
  { id: "opencode-go/mimo-v2.5-pro", provider: "opencode-go" },
  { id: "opencode-go/mimo-v2-pro", provider: "opencode-go" },
  { id: "opencode-go/mimo-v2-omni", provider: "opencode-go" },
  { id: "opencode-go/minimax-m2.5", provider: "opencode-go" },
  { id: "opencode-go/minimax-m2.7", provider: "opencode-go" },
  { id: "opencode-go/qwen3.5-plus", provider: "opencode-go" },
  { id: "opencode-go/qwen3.6-plus", provider: "opencode-go" },
  { id: "claude-opus", provider: "opencode-go" },
  { id: "claude-sonnet", provider: "opencode-go" },
  { id: "claude-haiku", provider: "opencode-go" },
  { id: "minimax-m2.1", provider: "gateway" },
  { id: "minimax-m2.5", provider: "gateway" },
  { id: "minimax-m2.7", provider: "gateway" },
  { id: "glm-5", provider: "modal" },
  { id: "glm-5.1", provider: "modal" },
  { id: "zai-org/GLM-5", provider: "modal" },
];

const MODEL_REGISTRY = new Map();
let modelRegistryRefresh = null;

const CLAUDE_TIER_MAP = {
  "claude-opus": "oc/deepseek-v4-pro",
  "claude-sonnet": "oc/kimi-k2.6",
  "claude-haiku": "oc/minimax-m2.7",
};

const OPENROUTER_ALIASES = {
  // Manual mapping for specific model families
  "free": "openrouter/free",
};

const MINIMAX_MAP = {
  "minimax-m2.7": "MiniMax-M2.7",
  "minimax-m2.5": "MiniMax-M2.5",
  "minimax-m2.1": "MiniMax-M2.1",
  "m2.7": "MiniMax-M2.7",
  "m2.5": "MiniMax-M2.5",
  "m2.1": "MiniMax-M2.1",
};

function registerModel(id, provider, extra = {}) {
  if (!id) return;
  MODEL_REGISTRY.set(id.toLowerCase(), {
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
    .map(({ id, object, created, owned_by, provider }) => ({
      id,
      slug: id,
      display_name: id,
      description: `${provider} model`,
      supported_reasoning_levels: [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: "",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: 272000,
      experimental_supported_tools: [],
      object,
      created,
      owned_by,
      provider
    }));
}

function seedConfiguredModels() {
  MODEL_REGISTRY.clear();

  for (const model of FALLBACK_MODELS) {
    if (model.provider.startsWith("opencode") && !OPENCODE_KEY) continue;
    if (model.provider === "openrouter" && !OPENROUTER_KEY) continue;
    if (model.provider === "openai" && !OPENAI_KEY) continue;
    registerModel(model.id, model.provider);
  }
}

function fetchJson(options) {
  return new Promise((resolve, reject) => {
    const client = options.port === 443 ? https : http;
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

async function registerModelsFromEndpoint({ provider, hostname, port, path, headers = {}, prefix = "" }) {
  const data = await fetchJson({ hostname, port, path, method: "GET", headers });
  for (const model of data?.data || []) {
    const id = typeof model === "string" ? model : model.id;
    if (!id) continue;
    registerModel(prefixedModelId(id, prefix), provider, {
      created: model.created,
      owned_by: model.owned_by || provider
    });
  }
}

async function refreshModelRegistry() {
  if (modelRegistryRefresh) return modelRegistryRefresh;

  modelRegistryRefresh = (async () => {
    seedConfiguredModels();
    const refreshes = [];

    if (OPENCODE_KEY) {
      const headers = { Authorization: `Bearer ${OPENCODE_KEY}` };
      refreshes.push(registerModelsFromEndpoint({
        provider: "opencode-go",
        hostname: "opencode.ai",
        port: 443,
        path: "/zen/go/v1/models",
        headers,
        prefix: "opencode-go/"
      }));
      refreshes.push(registerModelsFromEndpoint({
        provider: "opencode-zen",
        hostname: "opencode.ai",
        port: 443,
        path: "/zen/v1/models",
        headers,
        prefix: "opencode-zen/"
      }));
    }

    if (OPENROUTER_KEY) {
      refreshes.push(registerModelsFromEndpoint({
        provider: "openrouter",
        hostname: "openrouter.ai",
        port: 443,
        path: "/api/v1/models",
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
        prefix: "openrouter/"
      }));
    }

    refreshes.push(registerModelsFromEndpoint({
      provider: "gateway",
      hostname: TGW_HOST,
      port: TGW_PORT,
      path: "/v1/models"
    }));

    const results = await Promise.allSettled(refreshes);
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

function resolveModel(model) {
  if (!model) return model;
  const lower = model.toLowerCase();
  for (const [prefix, target] of Object.entries(CLAUDE_TIER_MAP)) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return target;
    }
  }
  for (const [prefix, target] of Object.entries(MINIMAX_MAP)) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return target;
    }
  }
  return model;
}

function isOpenRouterModel(model) {
  return modelProvider(model) === "openrouter" || (model && OPENROUTER_MODELS.test(model));
}

function isOpenCodeModel(model) {
  const provider = modelProvider(model);
  return provider === "opencode-go" || provider === "opencode-zen" || (model && OPENCODE_MODELS.test(model));
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
  const content = data?.content || [];
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text || part.thinking || "").join("");
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
  return model && GLM_MODELS.test(model);
}

function extractAuthToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  for (const prefix of AUTH_PREFIXES) {
    if (token.startsWith(prefix)) {
      const secret = token.slice(prefix.length);
      if (AUTH_SECRET && secret === AUTH_SECRET) return secret;
    }
  }
  return null;
}

function validateAndStripAuth(req) {
  const strippedToken = extractAuthToken(req.headers["authorization"]);
  if (!strippedToken) return false;
  req.headers["authorization"] = `Bearer ${strippedToken}`;
  return true;
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
      hostname: "api.us-west-2.modal.direct",
      port: 443,
      path: "/v1/chat/completions",
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
      hostname: "opencode.ai",
      port: 443,
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
      hostname: "opencode.ai",
      port: 443,
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
      hostname: "openrouter.ai",
      port: 443,
      path: "/api/v1/chat/completions",
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Handle /models endpoint - return aggregated model list
  if ((req.method === "GET" || req.method === "POST") && url.pathname.match(/\/models$/)) {
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
          hostname: "openrouter.ai",
          port: 443,
          path: "/api/v1/chat/completions",
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
        const mappedModel = MINIMAX_MAP[model.toLowerCase()] || model;
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
          hostname: "openrouter.ai",
          port: 443,
          path: "/api/v1/messages",
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
  console.log(`tgw-proxy :${PROXY_PORT} -> tgw :${TGW_PORT}`);
  console.log("  glm-5 / zai-org/* -> Modal (always non-streaming)");
  console.log("  OpenCode MiniMax -> OpenCode Messages (non-streaming)");
  console.log("  other opencode-go/* / oc/* -> OpenCode chat completions (non-streaming)");
  console.log("  openrouter/* / or/* / free -> OpenRouter (streaming OK)");
  console.log("  claude-* -> OpenCode Go (Tier mapping, non-streaming)");
  console.log("  bare minimax-* -> Gateway (MiniMax, streaming OK)");
});
