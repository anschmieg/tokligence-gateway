#!/usr/bin/env node
// Upstream model namespaces.
//
// A client reaches a provider's models through this gateway's own namespace:
// `openrouter/z-ai/glm-5.3-flash`, `mistral/mistral-small-latest`,
// `opencode-zen/kimi-k2.6-free`. The provider's OpenAI-compatible API expects
// the id without that namespace, and the OpenRouter `free` family has one
// alias. The native lanes rewrite the id on the way out, so the translated lane
// (Anthropic Messages onto chat completions) has to rewrite it the same way:
// otherwise an id that /v1/models advertises works on /v1/chat/completions and
// fails on /v1/messages.

// Manual mapping for specific model families.
const OPENROUTER_ALIASES = {
  "free": "openrouter/free",
};

export function resolveOpenRouterModel(model) {
  if (!model) return model;
  if (/^(?:openrouter\/|or\/)?free$/i.test(model)) return "openrouter/free";
  if (model.toLowerCase().startsWith("openrouter/")) {
    return model.slice(11);
  }
  if (model.toLowerCase().startsWith("or/")) {
    return model.slice(3);
  }
  for (const [prefix, target] of Object.entries(OPENROUTER_ALIASES)) {
    if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
      return target;
    }
  }
  return model;
}

export function resolveMistralModel(model) {
  if (!model) return model;
  if (model.toLowerCase().startsWith("mistral/")) {
    return model.slice(8);
  }
  return model;
}

export function resolveOpenCodeModel(model) {
  if (!model) return model;
  if (model.toLowerCase().startsWith("opencode-go/")) {
    return model.slice(12);
  }
  if (model.toLowerCase().startsWith("opencode-zen/")) {
    return model.slice(13);
  }
  if (model.toLowerCase().startsWith("oc/")) {
    return model.slice(3);
  }
  if (model.toLowerCase().startsWith("zen/")) {
    return model.slice(4);
  }
  return model;
}

const NAMESPACES = {
  openrouter: resolveOpenRouterModel,
  mistral: resolveMistralModel,
  "opencode-zen": resolveOpenCodeModel,
  "opencode-go": resolveOpenCodeModel,
};

// Applies the provider's namespace rewrite. A provider with no declared
// namespace (cerebras, groq, together, nvidia, ...) keeps the id it was given,
// exactly like its native lane does.
export function normalizeUpstreamModel(providerId, model) {
  const normalizer = NAMESPACES[providerId];
  return normalizer ? normalizer(model) : model;
}

// Free status belongs to a recent discovery snapshot, not to a model suffix.
export function isVerifiedFreeOpenRouterModel(model, snapshot, now = Date.now()) {
  const id = resolveOpenRouterModel(model)?.toLowerCase();
  return id === "openrouter/free" || Number(snapshot?.get(id)) > now;
}

// Only client-side function tools are permitted on the free OpenRouter lane.
export function openRouterRequestError(body) {
  if (body.plugins != null && (!Array.isArray(body.plugins) || body.plugins.some(plugin => !plugin || typeof plugin.id !== "string" || plugin.enabled !== false))) return "OpenRouter plugins are disabled on the free-only gateway";
  const containsFile = value => Array.isArray(value) ? value.some(containsFile) : value && typeof value === "object"
    ? ["file", "input_file", "document"].includes(value.type) || Object.values(value).some(containsFile) : false;
  if (containsFile(body.messages) || containsFile(body.input)) return "File inputs are disabled on free-only OpenRouter to prevent automatic paid parsing";
  if (["preset", "web_search_options", "search_parameters"].some((key) => body[key] != null)) return "OpenRouter presets and search add-ons are disabled on the free-only gateway";
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some((tool) =>
    !tool || (tool.type != null && tool.type !== "function" && !(tool.type === "custom" && typeof tool.name === "string" && tool.input_schema)) || /^openrouter:/i.test(tool.name || tool.function?.name || "")
  ))) return "OpenRouter server tools are disabled; use client-side function tools";
  return null;
}

export function enforceOpenRouterFreeRequest(body) {
  const disabled = new Set(["web", "file-parser", "response-healing", ...(body.plugins || []).map(plugin => plugin.id)]);
  return {
    ...body,
    provider: { ...(body.provider && typeof body.provider === "object" && !Array.isArray(body.provider) ? body.provider : {}), max_price: { prompt: 0, completion: 0, request: 0, image: 0 } },
    plugins: [...disabled].map(id => ({ id, enabled: false })),
  };
}
