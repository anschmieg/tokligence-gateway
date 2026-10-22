import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const SAFE_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export function safeTraceId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 128 && SAFE_ID.test(normalized) ? normalized : null;
}

export function createRequestTrace(req, res, { logger = console.info } = {}) {
  const started = performance.now();
  const id = randomUUID();
  const cfRay = safeTraceId(req.headers["cf-ray"]);
  let bodyBytes = 0;
  let stage = "ingress";
  let ended = false;
  const fields = { request_id: id, method: req.method, path: safeTracePath(req.url), ...(cfRay ? { cf_ray: cfRay } : {}) };
  const emit = (event, extra = {}) => {
    try {
      const safeExtra = {};
      for (const key of ["status", "body_bytes", "content_length", "candidate_count"]) {
        if (Number.isSafeInteger(extra[key]) && extra[key] >= 0) safeExtra[key] = extra[key];
      }
      for (const key of ["stage", "provider", "upstream_model", "code", "deadline"]) {
        const value = safeTraceId(extra[key]);
        if (value) safeExtra[key] = value;
      }
      logger(JSON.stringify({ trace: "inference", event, ...fields, elapsed_ms: Math.round(performance.now() - started), ...safeExtra }));
    } catch {}
  };
  const onData = (chunk) => { bodyBytes += Buffer.byteLength(chunk); };
  req.on("data", onData);
  req.once("end", () => { emit("body_done", { body_bytes: bodyBytes, content_length: safeContentLength(req.headers["content-length"]) }); });
  req.once("aborted", () => { if (!ended) emit("client_disconnected", { stage }); });
  res.once("finish", () => { ended = true; emit("response_finish", { stage, status: res.statusCode }); });
  res.once("close", () => { if (!res.writableEnded) { ended = true; emit("client_disconnected", { stage, status: res.statusCode }); } });
  const heartbeat = setInterval(() => { if (!ended && !res.writableEnded) emit("pending", { stage }); }, 30000);
  heartbeat.unref?.();
  res.once("finish", () => clearInterval(heartbeat));
  res.once("close", () => clearInterval(heartbeat));
  emit("ingress", { content_length: safeContentLength(req.headers["content-length"]) });
  return {
    id,
    emit,
    stage(value) { stage = value; },
    model(value) { const model = safeTraceId(value); if (model) fields.model = model; },
  };
}

function safeTracePath(value) {
  if (typeof value !== "string") return "unknown";
  const path = value.split("?", 1)[0];
  return /^\/[A-Za-z0-9._/-]{1,200}$/.test(path) ? path : "unknown";
}

function safeContentLength(value) {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}
