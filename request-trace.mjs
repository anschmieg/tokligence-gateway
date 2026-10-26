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
      for (const key of ["status", "body_bytes", "content_length", "candidate_count", "attempt_number", "slot", "retry_after_ms", "cooldown_ms", "remaining_ms", "request_body_bytes", "request_tool_count", "request_message_count", "request_max_tokens", "request_max_completion_tokens"]) {
        if (Number.isSafeInteger(extra[key]) && extra[key] >= 0) safeExtra[key] = extra[key];
      }
      for (const key of ["request_has_tools", "request_stream", "request_has_system", "request_has_temperature", "request_has_top_p", "request_has_stop", "request_has_tool_choice", "request_has_parallel_tool_calls", "request_has_response_format", "request_has_stream_options", "request_has_n", "request_has_seed", "request_has_user"]) {
        if (typeof extra[key] === "boolean") safeExtra[key] = extra[key];
      }
      for (const key of ["stage", "provider", "upstream_model", "code", "deadline"]) {
        const value = safeTraceId(extra[key]);
        if (value) safeExtra[key] = value;
      }
      if (["direct", "proxy"].includes(extra.egress)) safeExtra.egress = extra.egress;
      if (["FreeUsageLimitError", "FreeTierError", "rate_limit_error"].includes(extra.provider_error_code)) safeExtra.provider_error_code = extra.provider_error_code;
      if (["FreeUsageLimitError", "FreeTierError", "rate_limit_error"].includes(extra.upstream_error_code)) safeExtra.upstream_error_code = extra.upstream_error_code;
      if (["cline_auth_error", "cline_daily_free_quota_exhausted", "cline_model_retired", "cline_request_rejected", "cline_upstream_error"].includes(extra.cline_classification)) safeExtra.cline_classification = extra.cline_classification;
      if (["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "not_found_error", "api_error", "overloaded_error", "server_error", "insufficient_quota", "context_length_exceeded", "model_not_found", "unknown"].includes(extra.cline_error_code)) safeExtra.cline_error_code = extra.cline_error_code;
      if (["application_json", "event_stream", "other", "unknown"].includes(extra.cline_content_type)) safeExtra.cline_content_type = extra.cline_content_type;
      if (["session_id", "authorization", "credential", "client_version", "proxy_connect", "connection", "tls", "body_sent", "upstream_headers_wait", "pool_selection"].includes(extra.phase)) safeExtra.phase = extra.phase;
      if (["ok", "error", "cancelled", "completed_after_cancel", "failed_after_cancel", "reused", "rejected", "exhausted", "timeout"].includes(extra.outcome)) safeExtra.outcome = extra.outcome;
      if (["eligible", "excluded_after_failure", "model_ineligible", "missing_credential", "cooldown"].includes(extra.reason)) safeExtra.reason = extra.reason;
      if (["accountquota", "modelcapacity", "rate_limit", "free_usage_limit", "free_tier_rejection", "network_rejection", "authentication", "access_denied", "request_rejected", "upstream_server_error", "unknown"].includes(extra.category)) safeExtra.category = extra.category;
      if (Number.isSafeInteger(extra.duration_ms) && extra.duration_ms >= 0) safeExtra.duration_ms = extra.duration_ms;
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
