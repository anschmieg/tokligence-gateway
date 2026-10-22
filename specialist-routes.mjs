import http from "node:http";
import https from "node:https";
import { modelSurface, retiredModelReason } from "./model-catalog.mjs";
import { resolveMistralModel } from "./upstream-model.mjs";
import { providerEnabled } from "./route-config.mjs";

const HTTP_PATHS = new Set(["/v1/audio/transcriptions", "/v1/audio/speech", "/v1/embeddings", "/v1/fim/completions", "/v1/ocr", "/v1/moderations"]);
const REALTIME_PATH = "/v1/audio/transcriptions/realtime";
const MAX_BODY = 32 * 1024 * 1024;

function failure(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

function errorResponse(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  const status = error.statusCode || 502;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: status < 500 ? error.message : "Specialist backend unavailable", type: "specialist_api_error" } }));
}

function targetFor(config, env, model, endpoint) {
  if (typeof model !== "string" || !model || model.length > 256) throw failure(400, "A model ID is required");
  const retired = retiredModelReason(config, model);
  if (retired) throw failure(410, retired);
  const provider = config.providers.find((p) => p.id === "mistral");
  // Only the fixed Mistral specialist surface is exposed, never a user URL.
  if (!provider || /\//.test(model) && !model.startsWith("mistral/")) throw failure(400, "Unsupported specialist provider");
  if (!modelSurface({ id: model, provider: "mistral" }).endpoints.includes(endpoint)) throw failure(400, "Model does not support this endpoint");
  if (!providerEnabled(provider, env)) throw failure(503, "Mistral is not configured");
  const target = new URL((provider.base_url_env && env[provider.base_url_env]) || provider.base_url || provider.default_base_url);
  if (!["http:", "https:"].includes(target.protocol)) throw failure(503, "Unsupported backend transport");
  target.pathname = `${target.pathname.replace(/\/$/, "")}/${endpoint.slice(4)}`;
  return { target, model: resolveMistralModel(model), token: env[provider.api_key_env] };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
    };
    const error = (cause) => { cleanup(); reject(cause); };
    const aborted = () => error(failure(400, "Request aborted"));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        error(failure(413, "Specialist request exceeds 32 MiB"));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", aborted);
  });
}

// Parse only form framing; binary audio bytes are never decoded or rewritten.
export function rewriteMultipartModel(body, contentType, normalize = (id) => id) {
  const match = /boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 200) throw failure(400, "Invalid multipart boundary");
  const marker = Buffer.from(`--${boundary}`);
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  let position = 0;
  let found = null;
  while (body.subarray(position, position + marker.length).equals(marker)) {
    position += marker.length;
    if (body.subarray(position, position + 2).toString() === "--") break;
    if (body.subarray(position, position + 2).toString() !== "\r\n") throw failure(400, "Malformed multipart request");
    const headerEnd = body.indexOf("\r\n\r\n", position + 2);
    if (headerEnd < 0 || headerEnd - position > 16384) throw failure(400, "Malformed multipart headers");
    const start = headerEnd + 4;
    const end = body.indexOf(nextMarker, start);
    if (end < 0) throw failure(400, "Malformed multipart body");
    const headers = body.subarray(position + 2, headerEnd).toString("latin1");
    const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line)) || "";
    if (/;\s*name="model"(?:;|$)/i.test(disposition)) {
      if (found || /;\s*filename=/i.test(disposition) || end - start > 256) throw failure(400, "Exactly one model field is required");
      found = { start, end, model: body.subarray(start, end).toString("utf8") };
    }
    position = end + 2;
  }
  if (!found) throw failure(400, "A multipart model field is required");
  const model = normalize(found.model);
  return { model: found.model, body: Buffer.concat([body.subarray(0, found.start), Buffer.from(model), body.subarray(found.end)]) };
}

export function handleSpecialistHttp(req, res, { config, env = process.env }) {
  const incoming = new URL(req.url, "http://gateway.local");
  if (incoming.pathname === REALTIME_PATH) {
    res.writeHead(426, { "content-type": "application/json", upgrade: "websocket" });
    res.end(JSON.stringify({ error: "Use a WebSocket upgrade for realtime transcription" }));
    return true;
  }
  if (!HTTP_PATHS.has(incoming.pathname)) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return true;
  }
  (async () => {
    let upstream;
    const abort = () => upstream?.destroy();
    res.once("close", abort);
    const bodyTimer = setTimeout(() => { errorResponse(res, failure(408, "Request body timed out")); req.destroy(); }, 30000);
    bodyTimer.unref();
    try {
      let body = await readBody(req);
      clearTimeout(bodyTimer);
      if (res.destroyed) return;
      const contentType = String(req.headers["content-type"] || "application/json");
      let selected;
      if (/^multipart\/form-data\b/i.test(contentType)) {
        const rewritten = rewriteMultipartModel(body, contentType, (model) => {
          selected = targetFor(config, env, model, incoming.pathname);
          return selected.model;
        });
        body = rewritten.body;
      } else {
        if (!/^application\/json\b/i.test(contentType)) throw failure(415, "Use JSON or multipart/form-data");
        let parsed;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { throw failure(400, "Invalid JSON"); }
        selected = targetFor(config, env, parsed?.model, incoming.pathname);
        body = Buffer.from(JSON.stringify({ ...parsed, model: selected.model }));
      }
      selected.target.search = incoming.search;
      const client = selected.target.protocol === "https:" ? https : http;
      upstream = client.request(selected.target, { method: "POST", headers: {
        authorization: `Bearer ${selected.token}`, "content-type": contentType, "content-length": body.length,
        ...(req.headers.accept ? { accept: req.headers.accept } : {}),
      } }, (response) => {
        const headers = {};
        for (const key of ["content-type", "content-length", "retry-after", "cache-control"]) if (response.headers[key] != null) headers[key] = response.headers[key];
        res.writeHead(response.statusCode, headers);
        response.once("error", () => res.destroy());
        response.pipe(res);
      });
      upstream.setTimeout(120000, () => upstream.destroy(new Error("Specialist backend timed out")));
      upstream.once("error", (error) => errorResponse(res, error));
      upstream.end(body);
    } catch (error) {
      errorResponse(res, error);
    } finally {
      clearTimeout(bodyTimer);
    }
  })();
  return true;
}

export function handleSpecialistUpgrade(req, socket, head, { config, env = process.env }) {
  const reject = (status) => socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  let selected;
  try {
    const incoming = new URL(req.url, "http://gateway.local");
    if (incoming.pathname !== REALTIME_PATH) return reject(404);
    if (req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket") return reject(400);
    selected = targetFor(config, env, incoming.searchParams.get("model"), REALTIME_PATH);
    selected.target.search = incoming.search;
    selected.target.searchParams.set("model", selected.model);
  } catch (error) { return reject(error.statusCode || 502); }
  const headers = { authorization: `Bearer ${selected.token}`, connection: "Upgrade", upgrade: "websocket" };
  for (const key of ["sec-websocket-key", "sec-websocket-version"]) if (req.headers[key]) headers[key] = req.headers[key];
  const client = selected.target.protocol === "https:" ? https : http;
  const upstream = client.request(selected.target, { headers });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
  upstream.setTimeout(15000, () => upstream.destroy());
  upstream.once("error", () => { if (!socket.destroyed) reject(502); });
  upstream.once("response", (response) => { response.resume(); reject(response.statusCode); });
  upstream.once("upgrade", (response, peer, peerHead) => {
    upstream.setTimeout(0);
    const handshake = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
    if (response.headers["sec-websocket-accept"]) handshake.push(`Sec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}`);
    socket.write(`${handshake.join("\r\n")}\r\n\r\n`);
    peer.once("error", () => socket.destroy());
    peer.once("close", () => socket.destroy());
    socket.once("close", () => peer.destroy());
    if (head.length) peer.write(head);
    if (peerHead.length) socket.write(peerHead);
    socket.pipe(peer).pipe(socket);
  });
  upstream.end();
}
