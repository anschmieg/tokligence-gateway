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

const GLM_MODELS = /^glm-5$|^zai-org\/GLM-5-FP8$|^claude-opus/i;
const MINIMAX_MAP = {
  "claude-sonnet": "MiniMax-M2.7",
  "claude-haiku": "MiniMax-M2.1",
  "minimax-m2.7": "MiniMax-M2.7",
  "minimax-m2.5": "MiniMax-M2.5",
  "minimax-m2.1": "MiniMax-M2.1",
  "m2.7": "MiniMax-M2.7",
  "m2.5": "MiniMax-M2.5",
  "m2.1": "MiniMax-M2.1",
};

function resolveModel(model) {
  if (!model) return model;
  for (const [prefix, target] of Object.entries(MINIMAX_MAP)) {
    if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
      return target;
    }
  }
  return model;
}

function isGlmModel(model) {
  return model && GLM_MODELS.test(model);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isAnthropic = req.url.includes("/anthropic/v1/messages");

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

      const model = parsed.model;

      if (isGlmModel(model)) {
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
              content: text ? [{ type: "text", text }] : [],
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
      } else {
        const rewritten = resolveModel(model);
        if (rewritten !== model) {
          parsed.model = rewritten;
          body = Buffer.from(JSON.stringify(parsed));
        }

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
  console.log("  glm-5 / claude-opus-* -> Modal (direct, non-streaming)");
  console.log("  claude-sonnet-* / minimax-* -> Gateway (MiniMax)");
});
