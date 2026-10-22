import { isDiscoveredOpenCodeFree } from "./opencode-free-models.mjs";
import { normalizeUpstreamModel } from "./upstream-model.mjs";

function asModelObject(model) {
  return typeof model === "string" ? { id: model } : (model || {});
}

function isZero(value) {
  if (value == null || value === "" || typeof value === "boolean") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

export function modelSurface(model) {
  const id = normalizeUpstreamModel(model.provider, model.id).toLowerCase();
  if (model.provider === "mistral") {
    if (/-embed/.test(id)) return { type: "embeddings", endpoints: ["/v1/embeddings"] };
    if (/-fim/.test(id)) return { type: "completion", endpoints: ["/v1/fim/completions"] };
    if (/-ocr/.test(id)) return { type: "ocr", endpoints: ["/v1/ocr"] };
    if (/-tts/.test(id)) return { type: "speech", endpoints: ["/v1/audio/speech"] };
    if (/-realtime/.test(id)) return { type: "transcription", endpoints: ["/v1/audio/transcriptions/realtime"] };
    if (/-transcribe|^voxtral-mini-(?:latest|2602)$/.test(id)) return { type: "transcription", endpoints: ["/v1/audio/transcriptions"] };
    if (/-moderation/.test(id)) return { type: "moderation", endpoints: ["/v1/moderations"] };
    if (/^codestral-(?:latest|\d{4})$/.test(id)) return { type: "chat", endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/fim/completions"] };
    if (/^voxtral/.test(id)) return { type: "chat", endpoints: ["/v1/chat/completions"] };
  }
  if (model.supported_endpoints) return { type: model.model_type || "chat", endpoints: model.supported_endpoints };
  const protocols = model.protocols || ["chat_completions", "messages", "responses"];
  return { type: "chat", endpoints: protocols.map((p) => ({ chat_completions: "/v1/chat/completions", messages: "/v1/messages", responses: "/v1/responses" })[p]).filter(Boolean) };
}

export function retiredModelReason(config, id) {
  return (config.model_catalog?.retired || []).find((rule) => new RegExp(rule.pattern, "i").test(id || ""))?.reason || null;
}

export function catalogExcluded(config, model) {
  return (config.model_catalog?.exclude || []).some((rule) =>
    (!rule.provider || rule.provider === model.provider) && new RegExp(rule.pattern, "i").test(model.id));
}

function routeCost(model, provider) {
  if (hasZeroPrice(model) || provider.metadata?.cost_class === "free") return 0;
  return provider.metadata?.cost_class === "subscription" ? 1 : 2;
}

/** Build discovery rows without removing aliases or fallback routes from the registry.
 * Cross-provider equivalence is explicit; matching names never establishes identity.
 */
export function buildModelCatalog(models, config) {
  const policy = config.model_catalog || {};
  const mappings = policy.models || {};
  const groups = new Map();
  for (const model of models) {
    const provider = config.providers.find((p) => p.id === model.provider);
    if (provider?.catalog?.discover_free_only === true && !isDiscoveredOpenCodeFree(provider, model.id)) continue;
    if (!provider || provider.catalog?.visible === false || retiredModelReason(config, model.id)) continue;
    const upstream = normalizeUpstreamModel(model.provider, model.id);
    if (model.provider === "openrouter" && !modelAllowedByCatalog(provider, { ...model, id: upstream })) continue;
    const mapping = Object.entries(mappings).find(([, value]) => value.routes.some((route) =>
      route.provider === model.provider && normalizeUpstreamModel(route.provider, route.model) === upstream));
    const latest = policy.prefer_latest && model.provider === "mistral"
      ? (model.upstream_aliases || []).filter((alias) => alias.endsWith("-latest")).sort()[0] : null;
    const identity = latest || upstream;
    const id = mapping?.[0] || (model.provider === "mistral" || model.provider === "openrouter"
      ? `${model.provider}/${identity}` : model.provider === "opencode-zen" ? upstream : model.id);
    const key = mapping ? `canonical:${id}` : `${model.provider}:${identity}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...model, id, aliases: [], routes: [], supported_endpoints: [], model_type: modelSurface(model).type };
      groups.set(key, group);
    }
    if (!group.aliases.includes(model.id)) group.aliases.push(model.id);
    if (model.upstream_capabilities) group.upstream_capabilities = model.upstream_capabilities;
    // Catalog exclusions do not participate in routing deletion. Explicitly
    // selected equivalent backends can remain usable behind a visible row.
    const preference = mapping?.[1].routes.findIndex((route) => route.provider === model.provider && normalizeUpstreamModel(route.provider, route.model) === upstream) ?? 0;
    const reference = { provider: model.provider, model: latest ? `${model.provider}/${latest}` : model.id, context_window: model.context_window, pricing: model.pricing, upstream_capabilities: model.upstream_capabilities, parallel_tools: model.supports_parallel_tool_calls, cost: routeCost(model, provider), preference, supported_endpoints: modelSurface(model).endpoints };
    const existing = group.routes.find((route) => route.provider === reference.provider && normalizeUpstreamModel(route.provider, route.model) === normalizeUpstreamModel(reference.provider, reference.model));
    if (!existing) group.routes.push(reference);
    else {
      if (Number(reference.context_window) > 0) existing.context_window = Math.min(Number(existing.context_window) || Infinity, Number(reference.context_window));
      if (reference.upstream_capabilities) existing.upstream_capabilities = reference.upstream_capabilities;
      if (typeof reference.parallel_tools === "boolean") existing.parallel_tools = reference.parallel_tools;
    }
    const visible = !catalogExcluded(config, model) && !catalogExcluded(config, { ...model, id });
    group.catalog_visible ||= visible;
    if (visible) group.supported_endpoints = [...new Set([...group.supported_endpoints, ...reference.supported_endpoints])];
  }
  return [...groups.values()].filter((model) => model.catalog_visible).map((model) => {
    model.routes.sort((a, b) => a.cost - b.cost || a.preference - b.preference);
    const primary = model.routes[0];
    const windows = model.routes.map((route) => Number(route.context_window)).filter((n) => Number.isFinite(n) && n > 0);
    return { ...model, provider: primary.provider, owned_by: primary.provider, upstream_capabilities: primary.upstream_capabilities, ...(windows.length ? { context_window: Math.min(...windows) } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function hasZeroPrice(model) {
  const pricing = model.pricing || {};
  return isZero(pricing.prompt) && isZero(pricing.completion);
}

/**
 * Catalog visibility is intentionally independent from routing. It limits what
 * clients discover while preserving explicitly configured routes and aliases.
 */
export function modelAllowedByCatalog(provider, candidate) {
  const catalog = provider?.catalog || {};
  if (catalog.visible === false) return false;

  const model = asModelObject(candidate);
  const id = String(model.id || "");
  if (!id || (/^(?:(?:opencode-zen|zen)\/)?jev-1\.13(?:-free)?$/i.test(id) && provider?.id === "opencode-zen")) return false;

  if (provider?.id === "openrouter" && catalog.zero_price_only === true) {
    return hasZeroPrice(model) || (catalog.paid_allowlist || []).includes(id);
  }

  if (provider?.id === "opencode-zen" && Array.isArray(catalog.id_suffixes)) {
    const lower = id.toLowerCase();
    return catalog.id_suffixes.some((suffix) => lower.endsWith(String(suffix).toLowerCase()));
  }

  return true;
}
