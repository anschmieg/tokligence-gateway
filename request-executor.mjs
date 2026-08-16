import { randomUUID } from "node:crypto";
import { startAttempt } from "./provider-adapters.mjs";

const RETRYABLE_STATUSES = new Set([401, 402, 403, 408, 425, 429, 500, 502, 503, 504]);

function failureStatus(status) {
  if (status === 429 || status === 503) return 503;
  return 502;
}

function cooldownMs(response) {
  const retryAfter = Number(response?.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1000, 1000), 30000) : 10000;
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

export async function executeRoutePlan({ plan, req, res, path, body, env = process.env, runtimeState = {} }) {
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
        const { response } = await startAttempt({ candidate, req, path, body: candidateBody, env, signal: aborter.signal });
        const status = response.statusCode || 502;
        if (status < 200 || status >= 300) {
          lastStatus = status;
          discard(response);
          if (!RETRYABLE_STATUSES.has(status)) break;
          runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + cooldownMs(response));
          continue;
        }
        const headers = { ...response.headers, "x-gateway-request-id": requestId, "x-gateway-model": plan.publicModel, "x-gateway-provider": candidate.provider.id, "x-gateway-upstream-model": candidate.upstreamModel };
        if (plan.required.streaming) {
          const first = await firstStreamChunk(response, aborter.signal);
          res.writeHead(status, headers);
          res.write(first);
        } else {
          res.writeHead(status, headers);
        }
        response.pipe(res);
        return { committed: true, requestId, provider: candidate.provider.id, attempts: plan.candidates.indexOf(candidate) + 1 };
      } catch (error) {
        if (aborter.signal.aborted) break;
        lastStatus = 502;
        runtimeState.cooldowns?.set(`${candidate.provider.id}:${candidate.model?.id || candidate.upstreamModel}:${candidate.protocol}`, Date.now() + 10000);
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
