#!/usr/bin/env node
// tgw-proxy — model-rewriting proxy in front of Tokligence Gateway
//
// claude-opus-*   -> zai-org/GLM-5-FP8  (Modal GLM-5, high-complexity)
// claude-sonnet-* -> MiniMax-M2.7       (general)
// claude-haiku-*  -> MiniMax-M2.1       (high-volume, fast)
// glm-5           -> zai-org/GLM-5-FP8
// m2.7 / m2.5 / m2.1 -> MiniMax-M2.7/2.5/2.1

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
];

function resolveModel(name) {
  if (!name) return name;
  for (const [pattern, target] of ALIASES) {
    if (pattern.test(name)) return target;
  }
  return name;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("application/json") && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        const rewritten = resolveModel(parsed.model);
        if (rewritten !== parsed.model) {
          parsed.model = rewritten;
          body = Buffer.from(JSON.stringify(parsed));
        }
      } catch {
        // not valid JSON, forward as-is
      }
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
});
