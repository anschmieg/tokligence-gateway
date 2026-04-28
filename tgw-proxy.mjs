#!/usr/bin/env node
// tgw-proxy — model-rewriting proxy in front of Tokligence Gateway
//
// For MiniMax models: forwards to gateway (which routes to MiniMax API)
// For GLM-5/Modal models: calls Modal directly (non-streaming only)

import http from "http";
import https from "https";

const PROXY_PORT = 8080;
const TGW_HOST   = "127.0.0.1";
const TGW_PORT   = 8081;
const MODAL_KEY  = process.env.MODAL_GLM5_API_KEY || "modalresearch_qCoc8v8mnEgVCIyzHNHmBw6E2QjbAE9PFuk6aCWFEno";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;

// Auth token prefix stripping: clients send sk-proj-<SECRET> or sk-ant-<SECRET>
// We validate against TOKLIGENCE_AUTH_SECRET and forward the bare secret to gateway
const AUTH_SECRET = process.env.TOKLIGENCE_AUTH_SECRET;
const AUTH_PREFIXES = ["sk-proj-", "sk-ant-"];

const GLM_MODELS = /^glm-5|^zai-org\/GLM-5/i;
const OPENROUTER_MODELS = /^openrouter\/|^or\/|^free/i;
const OPENCODE_MODELS = /^opencode-go\/|^oc\/|^deepseek-v4|^kimi-k2|^glm-5\.\d|^mimo-v2|^qwen3/i;
const MINIMAX_BARE_MODELS = /^minimax-m2/i;

// Available models served by this gateway (aggregated from all upstream providers)
const AVAILABLE_MODELS = [
  // OpenCode Go models
  { id: "opencode-go/deepseek-v4-pro", provider: "opencode" },
  { id: "opencode-go/deepseek-v4-flash", provider: "opencode" },
  { id: "opencode-go/glm-5", provider: "opencode" },
  { id: "opencode-go/glm-5.1", provider: "opencode" },
  { id: "opencode-go/kimi-k2.5", provider: "opencode" },
  { id: "opencode-go/kimi-k2.6", provider: "opencode" },
  { id: "opencode-go/mimo-v2.5", provider: "opencode" },
  { id: "opencode-go/mimo-v2.5-pro", provider: "opencode" },
  { id: "opencode-go/mimo-v2-pro", provider: "opencode" },
  { id: "opencode-go/mimo-v2-omni", provider: "opencode" },
  { id: "opencode-go/minimax-m2.5", provider: "opencode" },
  { id: "opencode-go/minimax-m2.7", provider: "opencode" },
  { id: "opencode-go/qwen3.5-plus", provider: "opencode" },
  { id: "opencode-go/qwen3.6-plus", provider: "opencode" },
  // Claude tier aliases (resolve to OpenCode Go)
  { id: "claude-opus", provider: "opencode" },
  { id: "claude-sonnet", provider: "opencode" },
  { id: "claude-haiku", provider: "opencode" },
  // MiniMax models (via gateway)
  { id: "minimax-m2.1", provider: "gateway" },
  { id: "minimax-m2.5", provider: "gateway" },
  { id: "minimax-m2.7", provider: "gateway" },
  // GLM-5 models (via Modal)
  { id: "glm-5", provider: "modal" },
  { id: "glm-5.1", provider: "modal" },
  { id: "zai-org/GLM-5", provider: "modal" },
];

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
  return model && OPENROUTER_MODELS.test(model);
}

function isOpenCodeModel(model) {
  return model && OPENCODE_MODELS.test(model);
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
  if (model.toLowerCase().startsWith("oc/")) {
    return model.slice(3);
  }
  return model;
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
      path: "/zen/go/v1/chat/completions",
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

  // Handle /models endpoint - return aggregated model list
  if ((req.method === "GET" || req.method === "POST") && url.pathname.match(/\/models$/)) {
    if (!validateAndStripAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const modelList = {
      object: "list",
      data: AVAILABLE_MODELS.map(m => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider,
      })),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(modelList));
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
  const isModels = req.url.includes("/v1/models");

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
      
      if (isOpenCodeModel(model)) {
        const messages = parsed.messages || [];
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

      // Translate Responses API to Messages API
      const model = resolveModel(parsed.model);
      const messages = parsed.messages || [{ role: "user", content: parsed.input }];
      
      // Check if GLM model
      if (isGlmModel(model)) {
        const msgContents = messages.map(m => 
          typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '')
        );
        
        callModal("zai-org/GLM-5-FP8", messages.map((m, i) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '')
        })), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || msg?.reasoning_content || "";
            
            const response = {
              status: "completed",
              output: text
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenCodeModel(model)) {
        callOpenCodeGoOpenAI(model, messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '')
        })), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            const response = {
              status: "completed",
              output: text
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      } else if (isOpenRouterModel(model)) {
        callOpenRouterOpenAI(model, messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '')
        })), parsed.max_tokens || 4096)
          .then((data) => {
            const msg = data.choices?.[0]?.message;
            let text = msg?.content || "";
            
            const response = {
              status: "completed",
              output: text
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
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
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "completed", output }));
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
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "completed", output }));
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
      } else if (isOpenCodeModel(model)) {
        const messages = parsed.messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content) 
            ? m.content.map(c => c.text || c.content || "").join("")
            : m.content
        }));

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
  console.log("  opencode-go/* / oc/* -> OpenCode Go (non-streaming)");
  console.log("  openrouter/* / or/* / free -> OpenRouter (streaming OK)");
  console.log("  claude-* -> OpenCode Go (Tier mapping, non-streaming)");
  console.log("  minimax-* -> Gateway (MiniMax, streaming OK)");
});
