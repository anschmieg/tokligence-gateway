import fs from "node:fs";
import path from "node:path";

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function emptyBucket() {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost: 0,
    errors: {},
    models: {},
    last_seen_at: null,
  };
}

function emptyModelBucket() {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost: 0,
    errors: {},
    last_seen_at: null,
  };
}

export function extractUsage(data) {
  const usage = data?.usage ?? data;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = numberOrNull(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens) ?? 0;
  const outputTokens = numberOrNull(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens) ?? 0;
  const totalTokens = numberOrNull(usage.total_tokens ?? usage.totalTokens) ?? inputTokens + outputTokens;
  const cost = numberOrNull(usage.cost ?? usage.total_cost ?? usage.credits_used);
  if (!inputTokens && !outputTokens && !totalTokens && cost == null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
  };
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch {
    // Best-effort persistence; callers run in request path and must not fail.
  }
}

function modelBucket(state, provider, model) {
  state.providers ||= {};
  state.providers[provider] ||= emptyBucket();
  const bucket = state.providers[provider];
  bucket.errors ||= {};
  bucket.models ||= {};
  bucket.models[model] ||= emptyModelBucket();
  bucket.models[model].errors ||= {};
  return { bucket, modelBucket: bucket.models[model] };
}

export function createObservedUsageStore({
  file = process.env.TGW_OBSERVED_USAGE_PATH || "/data/tgw-observed-usage.json",
  now = () => new Date(),
} = {}) {
  let state = readState(file);
  const persist = () => {
    try { writeState(file, state); } catch {}
  };
  return {
    recordUsage(provider, model, data) {
      const usage = extractUsage(data);
      if (!provider || !model || !usage) return false;
      const at = now().toISOString();
      const pair = modelBucket(state, provider, model);
      for (const target of [pair.bucket, pair.modelBucket]) {
        target.requests += 1;
        target.input_tokens += usage.inputTokens;
        target.output_tokens += usage.outputTokens;
        target.total_tokens += usage.totalTokens;
        if (usage.cost != null) target.cost = roundMoney(target.cost + usage.cost);
        target.last_seen_at = at;
      }
      persist();
      return true;
    },
    recordEvent(provider, model, code) {
      if (!provider || !model || !code) return false;
      const at = now().toISOString();
      const pair = modelBucket(state, provider, model);
      for (const target of [pair.bucket, pair.modelBucket]) {
        target.errors[code] = (target.errors[code] || 0) + 1;
        target.last_seen_at = at;
      }
      persist();
      return true;
    },
    snapshotByProvider() {
      state = readState(file);
      const result = {};
      for (const [provider, bucket] of Object.entries(state.providers || {})) {
        result[provider] = JSON.parse(JSON.stringify(bucket));
      }
      return result;
    },
  };
}
