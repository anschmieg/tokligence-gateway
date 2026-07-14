export const CODEX_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_CODEX_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];

function csv(value, fallback = []) {
  if (!value?.trim()) return [...fallback];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function normalizedBaseUrl(value) {
  if (!value?.trim()) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CODEX_PROXY_BASE_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function loadCodexConfig(env = process.env) {
  const baseUrl = normalizedBaseUrl(env.CODEX_PROXY_BASE_URL);
  const apiKey = env.CODEX_PROXY_API_KEY?.trim() || null;

  if (Boolean(baseUrl) !== Boolean(apiKey)) {
    throw new Error(
      "CODEX_PROXY_BASE_URL and CODEX_PROXY_API_KEY must be configured together",
    );
  }

  const enabled = Boolean(baseUrl && apiKey);
  const models = enabled ? csv(env.CODEX_MODELS, DEFAULT_CODEX_MODELS) : [];
  const modelSet = new Set(models.map((model) => model.toLowerCase()));

  const tiers = enabled ? {
    "claude-haiku": env.CODEX_HAIKU_MODEL?.trim() || "gpt-5.6-luna",
    "claude-sonnet": env.CODEX_SONNET_MODEL?.trim() || "gpt-5.6-terra",
    "claude-opus": env.CODEX_OPUS_MODEL?.trim() || "gpt-5.6-sol",
    "claude-fable": env.CODEX_FABLE_MODEL?.trim() || "gpt-5.6-sol",
  } : {};

  for (const [tier, model] of Object.entries(tiers)) {
    if (!modelSet.has(model.toLowerCase())) {
      throw new Error(`${tier} maps to ${model}, which is not listed in CODEX_MODELS`);
    }
  }

  return {
    enabled,
    baseUrl,
    apiKey,
    models,
    modelSet,
    tiers,
  };
}

export function isCodexModel(config, model) {
  return Boolean(model && config.enabled && config.modelSet.has(model.toLowerCase()));
}

export function isReservedCodexModel(model) {
  return Boolean(model && /^gpt-5\.6-/i.test(model));
}

export function resolveClaudeTier(model, tiers, fallbackTiers) {
  if (!model) return model;
  const lower = model.toLowerCase();
  const mappings = Object.keys(tiers).length > 0 ? tiers : fallbackTiers;
  for (const [prefix, target] of Object.entries(mappings)) {
    if (lower.startsWith(prefix.toLowerCase())) return target;
  }
  return model;
}

export function codexUpstreamUrl(config, requestPath) {
  if (!config.enabled) throw new Error("Codex backend is disabled");
  const incoming = new URL(requestPath, "http://gateway.local");
  let pathname = incoming.pathname;
  if (pathname.startsWith("/anthropic/")) {
    pathname = pathname.slice("/anthropic".length);
  }
  const target = new URL(config.baseUrl);
  target.pathname = `${target.pathname.replace(/\/$/, "")}${pathname}`;
  target.search = incoming.search;
  return target;
}
