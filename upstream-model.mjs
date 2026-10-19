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
