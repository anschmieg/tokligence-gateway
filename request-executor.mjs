import { randomUUID } from "node:crypto";
import { startAttempt } from "./provider-adapters.mjs";
import { collectAnthropicStream, createAnthropicStreamCodec, createSseChunkReader } from "./anthropic-openai-codec.mjs";
import { respondWithAnthropicPassthrough } from "./anthropic-passthrough.mjs";

// Errors whose allowance is gone until a periodic reset (e.g. a daily free
// quota) get a long cooldown; transient limits (per-minute rate limits,
// hiccups) keep the short default. Tuned via ROUTING_DAILY_QUOTA_COOLDOWN_MS.
const ERROR_COOLDOWN_MS = 10000;
const DAILY_QUOTA_COOLDOWN_MS = Math.max(
  Number(process.env.ROUTING_DAILY_QUOTA_COOLDOWN_MS) || 60 * 60 * 1000,
  ERROR_COOLDOWN_MS,
);
const DAILY_QUOTA_ERROR_CODES = new Set(["cline_daily_free_quota_exhausted"]);
const DAILY_QUOTA_BODY_PATTERN = /\b(daily|per[-_ ]?day|per[-_ ]?month|monthly|weekly|quota|exhaust(ed|ion)?)\b/i;

function failureStatus(status) {
  if (status === 429 || status === 503) return 503;
  return 502;
}

function cooldownMs(response) {
  const retryAfter = Number(response?.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1000, 1000), 30000) : ERROR_COOLDOWN_MS;
}

function errorCooldownMs(error) {
  if (error?.code && DAILY_QUOTA_ERROR_CODES.has(String(error.code))) return DAILY_QUOTA_COOLDOWN_MS;
  const message = typeof error?.message === "string" ? error.message : "";
  if (DAILY_QUOTA_BODY_PATTERN.test(message)) return DAILY_QUOTA_COOLDOWN_MS;
  return ERROR_COOLDOWN_MS;
}

// Peeks the body of a 429 to distinguish daily/period quota exhaustion from
// per-minute rate limits, which usually arrive without a usable retry-after.
// Capped at ~1s so a stalled upstream never delays failover.
async function status429CooldownMs(response, signal) {
  try {
    const text = await Promise.race([
      readBodyText(response, signal, 4096),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (typeof text === "string" && DAILY_QUOTA_BODY_PATTERN.test(text)) return DAILY_QUOTA_COOLDOWN_MS;
  } catch {
    // fall through to header/default-based cooldown
  }
  return cooldownMs(response);
}

function readBodyText(response, signal, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => { cleanup(); fn(value); };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) {
        response.pause();
        finish(resolve, Buffer.concat(chunks).toString("utf8"));
      }
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, signal?.reason || new Error("aborted"));
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function discard(response) {
  response.resume();
}

function firstStreamChunk(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk) => { response.pause(); cleanup(); resolve(chunk); };
    const onEnd = () => { cleanup(); reject(new Error("upstream stream ended before its first event")); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal.reason || new Error("request aborted")); };
    response.once("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    response.resume();
  });
}

// Serves an OpenAI stream to a caller that spoke the Anthropic protocol: as
// Anthropic server-sent events, or folded into one message when the caller
// asked for a single response. Used when the upstream only speaks OpenAI.
async function respondWithCodec({ response, codec, res, status, requestId, model, provider, publicModel, signal }) {
  const reader = createSseChunkReader();
  const encoder = createAnthropicStreamCodec({ model });
  const first = await firstStreamChunk(response, signal);
  response.setEncoding("utf8");
  const base = {
    "x-gateway-request-id": requestId,
    "x-gateway-model": publicModel || model,
    "x-gateway-provider": provider,
    "x-gateway-upstream-model": model,
  };

  if (codec.stream) {
    res.writeHead(status, { ...base, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (events) => { if (events.length && !res.writableEnded) res.write(events.join("")); };
    const feed = (chunk) => { for (const payload of reader.push(String(chunk))) write(encoder.push(payload)); };
    feed(first);
    for await (const chunk of response) feed(chunk);
    write(encoder.end());
    res.end();
    return;
  }

  const collected = [];
  const feed = (chunk) => { for (const payload of reader.push(String(chunk))) collected.push(...encoder.push(payload)); };
  feed(first);
  for await (const chunk of response) feed(chunk);
  collected.push(...encoder.end());
  res.writeHead(status, { ...base, "content-type": "application/json" });
  res.end(JSON.stringify(collectAnthropicStream(collected)));
}

async function readSnippet(response, limit = 300) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) break;
    }
    return Buffer.concat(chunks).toString("utf8").slice(0, limit).replace(/\s+/g, " ").trim();
  } catch {
    return "<unreadable>";
  }
}

export function observeUpstreamResponse(response, candidate, callback) {
  if (typeof callback !== "function") return;
  const chunks = [];
  let size = 0;
  response.on("data", chunk => {
    if (size >= 1024 * 1024) return;
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
    if (size > 1024 * 1024) chunks.length = 0;
  });
  response.once("end", () => {
    try { callback({ provider: candidate.provider.id, model: candidate.upstreamModel, headers: response.headers || {}, chunks }); } catch {}
  });
}

export async function executeRoutePlan({ plan, req, res, path, body, env = process.env, runtimeState = {}, adapters = {}, affinityKey = null, onUpstreamResponse }) {
  const requestId = randomUUID();
  const aborter = new AbortController();
  const timeout = setTimeout(() => aborter.abort(new Error("upstream deadline exceeded")), Math.max(plan.deadline - Date.now(), 1));
  const cancel = () => aborter.abort(new Error("client disconnected"));
  req.once("aborted", cancel);
  res.once("close", () => { if (!res.writableEnded) cancel(); });
  let lastStatus = 502;

  try {
    for (const candidate of plan.candidates) {
      if (aborter.signal.aborted) break;
      const candidateBody = Buffer.from(JSON.stringify({ ...body, model: candidate.upstreamModel }));
      try {
        const { response, codec } = await startAttempt({ candidate, req, path, body: candidateBody, env, signal: aborter.signal, adapters });
        const status = response.statusCode || 502;
        if (status < 200 || status >= 300) {
          lastStatus = status;
          const detail = await readSnippet(response);
          console.error(
            `upstream ${status} from ${candidate.provider.id}/${candidate.upstreamModel}: ${detail || "<empty body>"}`,
          );
          const cooldown = status === 429
            ? await status429CooldownMs(response, aborter.signal)
            : cooldownMs(response);
          discard(response);
          // A failing status describes THIS candidate (rotated model, dead
          // credential, upstream outage) — never the remaining candidates.
          // Move on so the chain survives catalog rotations and partial
          // upstream outages.
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + cooldown);
          continue;
        }
        observeUpstreamResponse(response, candidate, onUpstreamResponse);
        if (codec) {
          await respondWithCodec({ response, codec, res, status, requestId, model: candidate.upstreamModel, provider: candidate.provider.id, publicModel: plan.publicModel, signal: aborter.signal });
          if (affinityKey && plan.profile && runtimeState.affinity) {
            runtimeState.affinity.set(`${affinityKey}:${plan.profile}`, {
              provider: candidate.provider.id,
              model: candidate.upstreamModel,
              updatedAt: Date.now(),
            });
          }
          return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1, translated: codec.kind };
        }
        const headers = { ...response.headers, "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
        // An Anthropic-protocol pass-through is repaired here rather than relayed
        // verbatim: some Anthropic-compatible upstreams answer with an array where
        // the schema wants a string, or buffer a response the caller asked to
        // stream. Healthy responses come back byte-identical.
        const thinking = body?.thinking;
        const keepReasoning = Boolean(thinking && thinking.type !== "disabled") || Boolean(body?.reasoning);
        const repaired = candidate.protocol === "messages"
          && await respondWithAnthropicPassthrough({
            response,
            res,
            status,
            headers,
            wantStream: plan.required.streaming === true,
            keepReasoning,
            signal: aborter.signal,
          });
        if (!repaired) {
          if (plan.required.streaming) {
            const first = await firstStreamChunk(response, aborter.signal);
            res.writeHead(status, headers);
            res.write(first);
          } else {
            res.writeHead(status, headers);
          }
          response.pipe(res);
        }
        if (affinityKey && plan.profile && runtimeState.affinity) {
          runtimeState.affinity.set(`${affinityKey}:${plan.profile}`, {
            provider: candidate.provider.id,
            model: candidate.upstreamModel,
            updatedAt: Date.now(),
          });
        }
        return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1 };
      } catch (error) {
        if (aborter.signal.aborted) break;
        const isLastCandidate = candidate === plan.candidates[plan.candidates.length - 1];
        if (isLastCandidate && candidate.provider.adapter === "cline-oauth" && error?.status && error?.code) {
          // Nothing left to try: surface the verbatim cline error, but still
          // cool the candidate down so follow-up requests fail fast.
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + errorCooldownMs(error));
          res.writeHead(error.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: error.code, message: error.message, type: "cline_oauth_error" } }));
          return { committed: false, requestId };
        }
        lastStatus = 502;
        console.error(
          `attempt failed for ${candidate.provider.id}/${candidate.upstreamModel}: ${error?.message ?? error}`,
        );
        runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + errorCooldownMs(error));
      }
    }
  } finally {
    clearTimeout(timeout);
    req.off("aborted", cancel);
  }
  if (!res.headersSent && !aborter.signal.aborted) {
    res.writeHead(failureStatus(lastStatus), { "content-type": "application/json", "x-gateway-request-id": requestId });
    res.end(JSON.stringify({ error: { message: "No eligible upstream completed the request", type: "gateway_upstream_error", request_id: requestId, model: plan.publicModel } }));
  }
  return { committed: false, requestId };
}
