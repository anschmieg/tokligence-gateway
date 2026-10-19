// Synthetic-only, opt-in Warp context provenance recorder for Tokligence.
// No patch to routing, no new public endpoints, no recording unless explicitly enabled.
// D-15: https://linear.app/as-claw/issue/D-15/warp-agent-context-provenance-experiment-via-nothing-gateway
import { randomBytes } from "node:crypto";
import { openSync, writeSync, closeSync, fstatSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const MARKER = /\bWARPCTX_[A-Z0-9_]{5,80}\b/g;
const MAX_CAPTURE = 256 * 1024;

function tags(value) {
  const found = new Set();
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const match of text.matchAll(MARKER)) found.add(match[0]);
  return [...found].sort();
}
function privateDirectory(name) {
  if (!name || !isAbsolute(name)) return false;
  try {
    const info = lstatSync(name);
    return info.isDirectory() && !info.isSymbolicLink() &&
      info.uid === process.getuid() && (info.mode & 0o077) === 0;
  } catch { return false; }
}
function safeMessageRoles(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.map(x => x && typeof x === "object" ? String(x.role || "") : "");
}
function toolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : [])
    .map(x => x?.function?.name || x?.name)
    .filter(x => typeof x === "string").slice(0, 128);
}
export function createWarpTraceRecorder(env = process.env) {
  const enabled = env.WARP_TRACE_ENABLED === "1";
  const model = env.WARP_TRACE_MODEL || "";
  const directory = env.WARP_TRACE_DIR || "";
  // Raw contents intentionally NOT persisted; marker-only until independently
  // audited synthetic-full-mode with hard source controls.
  function begin({ testPrincipal, request, response, body, protocol = "chat_completions" }) {
    if (!enabled || !testPrincipal || !model || body?.model !== model ||
        !privateDirectory(directory) || !response) return false;
    const traceId = randomBytes(12).toString("hex");
    const started = process.hrtime.bigint();
    const modelMarkers = tags(body);
    const outputMarkers = new Set();
    let outputBytes = 0, truncated = false, completed = false;
    const writeOriginal = response.write;
    const endOriginal = response.end;

    function capture(chunk) {
      try {
        if (chunk === null || chunk === undefined) return;
        const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") :
          (typeof chunk === "string" ? chunk : "");
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > MAX_CAPTURE) { truncated = true; return; }
        for (const marker of tags(data)) outputMarkers.add(marker);
      } catch { /* Logging is never allowed to break inference. */ }
    }
    function finish() {
      if (completed) return;
      completed = true;
      try {
        const event = {
          schema: "warp-context-trace/v1",
          stage: "tokligence_auth_passed_parsed_http_ingress",
          trace_id: traceId,
          started_at: new Date().toISOString(),
          duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          protocol,
          requested_model: body.model,
          message_roles: safeMessageRoles(body),
          tool_names: toolNames(body),
          stream: body.stream === true,
          reasoning_effort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : null,
          request_markers: modelMarkers,
          response_markers: [...outputMarkers].sort(),
          response_bytes: outputBytes,
          response_scan_truncated: truncated,
          response_http_status: response.statusCode,
        };
        const filename = join(directory, traceId + ".json");
        // Event contains structural metadata and disposable marker strings only.
        const fd = openSync(filename, "wx", 0o600);
        try {
          const bytes = Buffer.from(JSON.stringify(event) + "\n");
          if (bytes.length <= MAX_CAPTURE) writeSync(fd, bytes);
        } finally { closeSync(fd); }
      } catch { /* Do not change response or routing on capture errors. */ }
    }
    response.write = function(chunk, ...args) {
      capture(chunk);
      return writeOriginal.call(this, chunk, ...args);
    };
    response.end = function(chunk, ...args) {
      capture(chunk);
      try { return endOriginal.call(this, chunk, ...args); }
      finally { finish(); }
    };
    return true;
  }
  return { begin };
}
