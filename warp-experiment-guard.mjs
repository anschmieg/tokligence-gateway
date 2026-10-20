// Fixed-duration and capped canary access for the Warp experiment only.
// This is an additional authority limited by model, request count, and expiry.
// Counters are in-memory: combine with a separately capped upstream provider key
// for a HARD spend ceiling, not the gateway's unrestricted master credential.
export function createWarpExperimentGuard(env = process.env, now = () => Date.now()) {
  const enabled = env.WARP_TRACE_ENABLED === "1";
  const secret = env.WARP_TRACE_TEST_SECRET || "";
  const model = env.WARP_TRACE_MODEL || "";
  const expires = Date.parse(env.WARP_TRACE_EXPIRES_AT || "");
  const cap = Number(env.WARP_TRACE_MAX_REQUESTS || 8);
  const maxInputBytes = 65536;
  const maxCompletionTokens = 768;
  const started = now();
  const configured = enabled && secret.length >= 32 && !!model &&
    Number.isFinite(expires) && expires > started && expires <= started + 60 * 60 * 1000 &&
    Number.isInteger(cap) && cap > 0 && cap <= 12;
  let consumed = 0;
  let catalogRequests = 0;
  let inflight = 0;
  const deny = (reason, status = 403) => ({ allowed: false, reason, status });
  function catalogAllowed() {
    if (!configured || now() >= expires || catalogRequests >= 12) return false;
    catalogRequests++;
    return true;
  }
  function reserve(body, inputBytes) {
    if (!configured || now() >= expires) return deny("Warp experiment disabled or expired");
    if (body?.model !== model) return deny("Warp experiment model mismatch");
    if (!Number.isInteger(inputBytes) || inputBytes > maxInputBytes) return deny("Warp experiment input too large", 413);
    if (consumed >= cap) return deny("Warp experiment request budget exhausted", 429);
    if (inflight !== 0) return deny("Warp experiment allows one concurrent request", 429);
    // Do not silently increase the token cap. Both fields are normalized to the
    // same conservative limit; the gateway's model adapter may not honor both.
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const value = body[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        return deny("Invalid completion token limit", 400);
      }
      if (value !== undefined && value > maxCompletionTokens) body[key] = maxCompletionTokens;
    }
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
      body.max_tokens = maxCompletionTokens;
    }
    consumed++;
    inflight++;
    let finished = false;
    return {
      allowed: true, status: 200,
      release() {
        if (finished) return;
        finished = true;
        inflight = Math.max(0, inflight - 1);
      },
    };
  }
  return { configured, model, catalogAllowed, reserve,
    get remaining() { return cap - consumed; },
  };
}
