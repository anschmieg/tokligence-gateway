#!/usr/bin/env node
// tgw-proxy — model-rewriting proxy in front of Tokligence Gateway
//
// Model routing (request rewriting):
//   claude-opus-*   -> zai-org/GLM-5-FP8  (Modal GLM-5, high-complexity)
//   claude-sonnet-* -> MiniMax-M2.7          (general)
//   claude-haiku-*  -> MiniMax-M2.1          (high-volume, fast)
//   glm-5           -> zai-org/GLM-5-FP8
//   minimax-m2.7    -> MiniMax-M2.7
//   minimax-m2.1    -> MiniMax-M2.1
//
// Response transformation:
//   reasoning_content -> content (for GLM-style reasoning models)

import http from "http";

const PROXY_PORT = 8080;
const TGW_PORT   = 8081;
const TGW_HOST   = "127.0.0.1";

const ALIASES = [
  [/^claude-opus/i,   "zai-org/GLM-5-FP8"],
  [/^claude-sonnet/i, "MiniMax-M2.7"],
  [/^claude-haiku/i,  "MiniMax-M2.1"],
  [/^glm-5$/i,        "zai-org/GLM-5-FP8"],
  [/^m2\.7$/i,        "MiniMax-M2.7"],
  [/^m2\.5$/i,        "MiniMax-M2.5"],
  [/^m2\.1$/i,        "MiniMax-M2.1"],
  [/^minimax-m2\.7$/i, "MiniMax-M2.7"],
  [/^minimax-m2\.5$/i, "MiniMax-M2.5"],
  [/^minimax-m2\.1$/i, "MiniMax-M2.1"],
  [/^minimax-m2$/i,    "MiniMax-M2"],
];

function resolveModel(name) {
  if (!name) return name;
  for (const [pattern, target] of ALIASES) {
    if (pattern.test(name)) return target;
  }
  return name;
}

function transformResponse(body, isStreaming) {
  if (isStreaming) {
    return transformStreamingResponse(body);
  }
  return transformNonStreamingResponse(body);
}

function transformNonStreamingResponse(body) {
  try {
    const data = JSON.parse(body.toString());
    let modified = false;

    if (data.choices && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice.message && choice.message.reasoning_content !== undefined) {
          if (choice.message.reasoning_content && !choice.message.content) {
            choice.message.content = choice.message.reasoning_content;
            modified = true;
          }
          delete choice.message.reasoning_content;
        }
        if (choice.delta && choice.delta.reasoning_content !== undefined) {
          if (choice.delta.reasoning_content && !choice.delta.content) {
            choice.delta.content = choice.delta.reasoning_content;
            modified = true;
          }
          delete choice.delta.reasoning_content;
        }
      }
    }

    if (data.message && data.message.reasoning_content !== undefined) {
      if (data.message.reasoning_content && !data.message.content) {
        data.message.content = data.message.reasoning_content;
        modified = true;
      }
      delete data.message.reasoning_content;
    }

    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === "text" && block.reasoning_content) {
          block.text = block.reasoning_content;
          delete block.reasoning_content;
          modified = true;
        }
      }
    }

    return modified ? JSON.stringify(data) : body;
  } catch {
    return body;
  }
}

function transformStreamingResponse(body) {
  const lines = body.toString().split('\n');
  const transformed = [];

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6);
      if (dataStr === '[DONE]') {
        transformed.push(line);
        continue;
      }
      try {
        const data = JSON.parse(dataStr);
        let modified = false;

        if (data.choices) {
          for (const choice of data.choices) {
            if (choice.delta) {
              if (choice.delta.reasoning_content !== undefined) {
                if (choice.delta.reasoning_content && !choice.delta.content) {
                  choice.delta.content = choice.delta.reasoning_content;
                  modified = true;
                }
                delete choice.delta.reasoning_content;
              }
            }
          }
        }

        transformed.push(modified ? 'data: ' + JSON.stringify(data) : line);
      } catch {
        transformed.push(line);
      }
    } else {
      transformed.push(line);
    }
  }

  return Buffer.from(transformed.join('\n'));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";
    const isStreaming = req.url.includes("stream=true") || 
                       req.url.includes("stream%3Dtrue") ||
                       (body.length > 0 && body.toString().includes('"stream":true'));

    if (contentType.includes("application/json") && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        const rewritten = resolveModel(parsed.model);
        if (rewritten !== parsed.model) {
          parsed.model = rewritten;
          body = Buffer.from(JSON.stringify(parsed));
        }
        if (parsed.stream) isStreaming = true;
      } catch {
        // not valid JSON, forward as-is
      }
    }

    const headers = { ...req.headers, host: `${TGW_HOST}:${TGW_PORT}` };
    headers["content-length"] = String(body.length);

    const upstream = http.request(
      { host: TGW_HOST, port: TGW_PORT, path: req.url, method: req.method, headers },
      (upRes) => {
        const contentType = upRes.headers["content-type"] || "";
        const isSSE = contentType.includes("text/event-stream") || 
                      contentType.includes("application/x-ndjson");

        if (isSSE) {
          res.writeHead(upRes.statusCode, upRes.headers);
          let buffer = Buffer.alloc(0);

          upRes.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            const lines = buffer.toString().split('\n');
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i];
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') {
                  res.write(line + '\n');
                } else {
                  try {
                    const data = JSON.parse(dataStr);
                    let modified = false;

                    if (data.choices) {
                      for (const choice of data.choices) {
                        if (choice.delta && choice.delta.reasoning_content !== undefined) {
                          if (choice.delta.reasoning_content && !choice.delta.content) {
                            choice.delta.content = choice.delta.reasoning_content;
                            modified = true;
                          }
                          delete choice.delta.reasoning_content;
                        }
                      }
                    }

                    res.write('data: ' + JSON.stringify(data) + '\n');
                  } catch {
                    res.write(line + '\n');
                  }
                }
              } else {
                res.write(line + '\n');
              }
            }

            const lastLine = lines[lines.length - 1];
            if (lastLine && !lines[lines.length - 1].includes('\n')) {
              buffer = Buffer.from(lastLine);
            } else {
              buffer = Buffer.alloc(0);
            }
          });

          upRes.on("end", () => {
            res.end();
          });
        } else {
          const chunks = [];
          upRes.on("data", (chunk) => chunks.push(chunk));
          upRes.on("end", () => {
            const responseBody = Buffer.concat(chunks);
            const transformed = transformResponse(responseBody, false);
            res.writeHead(upRes.statusCode, upRes.headers);
            res.end(transformed);
          });
        }
      }
    );

    upstream.on("error", (err) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });

    upstream.end(body);
  });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`tgw-proxy :${PROXY_PORT} -> tgw :${TGW_PORT}`);
  console.log("  claude-opus-*   -> zai-org/GLM-5-FP8 (Modal)");
  console.log("  claude-sonnet-* -> MiniMax-M2.7");
  console.log("  claude-haiku-*  -> MiniMax-M2.1");
  console.log("  reasoning_content -> content (GLM transformation enabled)");
});
