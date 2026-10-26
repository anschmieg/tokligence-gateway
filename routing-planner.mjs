import { isDiscoveredOpenCodeFree } from "./opencode-free-models.mjs";
import { matchConfiguredProvider, profileByModel, providerById, providerEnabled, roleByModel } from "./route-config.mjs";
import { inspectRequestFeatures, supportsFeatures } from "./protocol-codecs.mjs";
import { normalizeUpstreamModel } from "./upstream-model.mjs";

function circuitOpen(runtimeState, provider, model, protocol) {
  const until = runtimeState?.cooldowns?.get(`${provider}:${model}:${protocol}`) || 0;
  return until > Date.now();
}

function providerCapabilities(provider) {
  const declared = provider.metadata?.capabilities || [];
  return {
    protocols: provider.protocols?.length ? provider.protocols : ["chat_completions"],
    streaming: provider.metadata?.streaming !== false,
    tools: declared.includes("tool_calling"),
    parallel_tools: provider.metadata?.parallel_tools === true,
    structured_output: provider.metadata?.structured_output === true,
    reasoning: declared.includes("reasoning"),
    vision: declared.includes("vision"),
  };
}

function requestTokenEstimate(body) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(body || {}), "utf8") / 4);
}

// Adapters that can execute a plain OpenAI chat-completions request. A
// provider on one of these is reachable from /v1/messages even when it never
// declared the messages protocol, because the gateway translates the request
// and the reply. Adapters with their own request pipeline (Codex, Copilot,
// Zen) are excluded: they already own their protocol handling and must not be
// handed a translated body.
const TRANSLATING_ADAPTERS = new Set(["middleware", "openai-compatible", "cline-oauth"]);

// A profile or route may address a model as `<provider>/<id>` while the
// provider's catalog stores the bare id. Strip the prefix only when the
// remainder is a declared model, so ids that genuinely contain a slash
// (nvidia/nemotron-*, cline/cline-free/*) are left untouched.
function resolveUpstreamModel(provider, requested) {
  const prefix = `${provider.id}/`;
  if (typeof requested !== "string" || !requested.toLowerCase().startsWith(prefix.toLowerCase())) {
    return requested;
  }
  const bare = requested.slice(prefix.length);
  return provider.models?.some(({ id }) => id === bare) ? bare : requested;
}

function candidateSupports(provider, reference, required, body, translated = false) {
  const capabilities = providerCapabilities(provider);
  if (typeof reference.parallel_tools === "boolean") capabilities.parallel_tools = reference.parallel_tools;
  for (const [field, feature] of [["function_calling", "tools"], ["vision", "vision"], ["reasoning", "reasoning"], ["structured_output", "structured_output"]]) {
    if (typeof reference.upstream_capabilities?.[field] === "boolean") capabilities[feature] = reference.upstream_capabilities[field];
  }
  // A translated lane serves the Anthropic surface on top of chat completions;
  // the protocol is therefore supported, and thinking cannot be carried across,
  // so a thinking request is served without it rather than refused.
  const effective = translated
    ? { ...required, protocol: capabilities.protocols.includes(required.protocol) ? required.protocol : "messages", reasoning: false }
    : required;
  if (translated) capabilities.protocols = [...capabilities.protocols, effective.protocol];
  if (provider.adapter === "chatgpt-responses") return false;
  if (!supportsFeatures(capabilities, effective)) return false;
  const limit = reference.context_window || provider.metadata?.context_window;
  return !limit || requestTokenEstimate(body) <= Number(limit);
}

function reorderByAffinity(candidates, runtimeState, affinityKey, profileId) {
  if (!affinityKey || !runtimeState?.affinity) return candidates;
  const sticky = runtimeState.affinity.get(`${affinityKey}:${profileId}`);
  if (!sticky) return candidates;
  const ttl = Number(process.env.ROUTING_AFFINITY_TTL_MS || 3600000);
  if (sticky.updatedAt && sticky.updatedAt + ttl <= Date.now()) {
    runtimeState.affinity.delete(`${affinityKey}:${profileId}`);
    return candidates;
  }
  const index = candidates.findIndex(({ provider, upstreamModel }) => provider.id === sticky.provider && upstreamModel === sticky.model);
  if (index <= 0) return index === -1 ? candidates : candidates;
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

function quotaScore(candidate, runtimeState) {
  const quota = runtimeState?.quotas?.get(candidate.provider.id);
  const costClass = candidate.provider.metadata?.cost_class || "payg";
  const classScore = { free: 300, subscription: 200, payg: 100 }[costClass] || 0;
  if (!quota || quota.available !== true || quota.percentUsed == null) return classScore;
  return classScore + Math.max(0, 100 - Number(quota.percentUsed));
}

function reorderByQuota(candidates, runtimeState) {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => quotaScore(b.candidate, runtimeState) - quotaScore(a.candidate, runtimeState) || a.index - b.index)
    .map(({ candidate }) => candidate);
}

// Returns undefined when the provider serves the protocol natively, a
// translation marker when it can be served through chat completions, and null
// when it cannot serve the request at all.
function translationFor(provider, protocol) {
  const protocols = Array.isArray(provider.protocols) && provider.protocols.length
    ? provider.protocols
    : ["chat_completions"];
  if (protocols.includes(protocol)) return undefined;
  if (provider.messages_translation === false) return null;
  if (protocol === "messages" && protocols.includes("chat_completions")) return "anthropic-from-openai";
  return null;
}

const CLASS_ROUTING_CLASSES = new Set(["subagent", "workflow", "auxiliary"]);
const CLAUDE_AGENT_TYPES = new Set(["Explore", "fork", "teammate", "custom"]);

function cheapClassCandidate(config, profile, requestClass, agentType, protocol, required, body, env, runtimeState) {
  const policy = config.classRouting;
  if (!policy?.enabled || !policy.cheapPolicyModel || !CLASS_ROUTING_CLASSES.has(requestClass)) return null;
  if (agentType != null && !CLAUDE_AGENT_TYPES.has(agentType)) return null;
  const { provider: providerId, model: modelId } = policy.cheapPolicyModel;
  const provider = providerById(config, providerId);
  if (!provider || !providerEnabled(provider, env)) return null;
  const model = provider.models.find(({ id }) => id === modelId);
  const window = Number(model?.context_window || provider.metadata?.context_window || 0);
  const floor = Number(profile.context_window || 0);
  const translate = translationFor(provider, protocol);
  if (!model || !floor || !window || window < floor || translate === null) return null;
  if (translate && !TRANSLATING_ADAPTERS.has(provider.adapter)) return null;
  if (circuitOpen(runtimeState, provider.id, model.id, protocol)) return null;
  if (!candidateSupports(provider, model, required, body, Boolean(translate))) return null;
  return {
    provider,
    model,
    upstreamModel: model.id,
    protocol,
    native: translate !== "anthropic-from-openai",
    ...(translate ? { translate } : {}),
    family: model.family || provider.metadata?.family,
  };
}

export function buildRoutePlan(config, { model, protocol, body, requestClass = null, agentType = null, affinityKey = null, historyKey = undefined }, env = process.env, runtimeState = {}) {
  if (!model) return { error: { status: 400, code: "missing_model", message: "model is required" } };
  const profile = profileByModel(config, model);
  const role = roleByModel(config, model);
  let catalogModel = runtimeState.catalogModels?.get(model.toLowerCase());
  // Direct provider IDs must use the same verified-free pool as catalog IDs;
  // returning null here would hand them to the legacy API-key proxy.
  const direct = providerById(config, matchConfiguredProvider(config, model));
  const freeOnly = providerById(config, "opencode-zen")?.catalog?.discover_free_only === true;
  if (freeOnly && (direct?.id === "opencode-go" || /^(?:opencode-go|go)\//i.test(model))) {
    return { error: { status: 403, code: "opencode_paid_route_disabled", message: "Only verified free OpenCode models are available" } };
  }
  if (!profile && !role && !catalogModel && direct?.adapter === "opencode-zen" && direct.catalog?.discover_free_only === true) {
    if (!isDiscoveredOpenCodeFree(direct, model)) return { error: { status: 403, code: "opencode_model_not_verified_free", message: "OpenCode model is unavailable or not verified free; refresh /v1/models" } };
    catalogModel = { routes: [{ provider: direct.id, model, supported_endpoints: ["/v1/messages", "/v1/chat/completions"] }], supported_endpoints: ["/v1/messages", "/v1/chat/completions"] };
  }

  if (!profile && !role && runtimeState.catalogModels && !catalogModel && Object.keys(config.model_catalog?.models || {}).some((id) => id.toLowerCase() === model.toLowerCase())) {
    return { error: { status: 503, code: "canonical_model_unavailable", message: "No discovered backend is available for this canonical model; refresh /v1/models" } };
  }
  // The native OAuth lane also owns remote compaction and session-cache
  // observations. Catalog publication must not bypass those behaviors.
  if (!profile && !role && catalogModel?.routes.length === 1 && catalogModel.routes[0].model.toLowerCase() === model.toLowerCase()
    && ["oauth-proxy", "cline-oauth"].includes(providerById(config, catalogModel.routes[0].provider)?.adapter)) catalogModel = null;
  if (!profile && !role && catalogModel) {
    const required = inspectRequestFeatures(protocol, body);
    const endpoint = { messages: "/v1/messages", responses: "/v1/responses", chat_completions: "/v1/chat/completions" }[protocol];
    const candidates = [];
    const cooledCompatibleUntil = [];
    // Catalog routes are already ordered free -> subscription -> paid. Do not
    // let sticky affinity promote a paid route above a recovered free backend.
     for (const reference of catalogModel.routes) {
       const provider = providerById(config, reference.provider);
       const translate = translationFor(provider, protocol);
       if (!provider || !providerEnabled(provider, env)) continue;
       if (!reference.supported_endpoints.includes(endpoint) && translate === null) continue;
       if (translate === null || (translate && !TRANSLATING_ADAPTERS.has(provider.adapter))) continue;
      if (!candidateSupports(provider, reference, required, body, Boolean(translate))) continue;
      const cooldownUntil = runtimeState?.cooldowns?.get(`${provider.id}:${reference.model}:${protocol}`) || 0;
      if (cooldownUntil > Date.now()) {
        cooledCompatibleUntil.push(cooldownUntil);
        continue;
      }
      candidates.push({ provider, model: { id: reference.model }, upstreamModel: normalizeUpstreamModel(provider.id, reference.model), protocol, native: !translate, ...(translate ? { translate } : {}) });
    }
    if (!candidates.length && cooledCompatibleUntil.length) {
      const retryAfter = Math.max(1, Math.ceil((Math.min(...cooledCompatibleUntil) - Date.now()) / 1000));
      return { error: { status: 503, code: "model_routes_cooling_down", message: "Compatible backends are temporarily unavailable", retry_after: retryAfter, supported_endpoints: catalogModel.supported_endpoints } };
    }
    if (!candidates.length) return { error: { status: 400, code: "no_compatible_model_route", message: "No configured backend supports this model and request", supported_endpoints: catalogModel.supported_endpoints } };
    return { requestedModel: model, publicModel: model, profile: null, required, deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000), maxAttempts: candidates.length, candidates };
  }
  if (!profile && role) {
    const required = inspectRequestFeatures(protocol, body);
    if (role.specialist) {
      const provider = providerById(config, role.candidates[0].provider);
      if (!["responses", "messages", "chat_completions"].includes(protocol)) return { error: { status: 400, code: "specialist_protocol_unsupported", message: "Unsupported specialist protocol" } };
      if (!provider || !providerEnabled(provider, env)) return { error: { status: 503, code: "specialist_service_unavailable", message: "ChatGPT specialist service is not configured; no fallback was attempted" } };
      if (!(provider.protocols || []).includes("responses")) return { error: { status: 503, code: "specialist_protocol_misconfigured", message: "ChatGPT specialist provider must declare its Responses backend protocol" } };
      const model = provider.models.find(({ id }) => id === role.candidates[0].model);
      return { requestedModel: model.id, publicModel: role.id, profile: role.id, required, deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000), maxAttempts: 1, specialistInstructions: role.instructions, specialistRole: role.id.slice(5), candidates: [{ provider, model, upstreamModel: model.id, protocol, native: true, family: role.candidates[0].family, specialist: true, specialistInstructions: role.instructions, specialistRole: role.id.slice(5) }] };
    }
    let candidates = [];
    for (const reference of role.candidates) {
      const provider = providerById(config, reference.provider);
      if (!provider || !providerEnabled(provider, env)) continue;
      const translate = translationFor(provider, protocol);
      if (translate === null || (translate && !TRANSLATING_ADAPTERS.has(provider.adapter))) continue;
      if (circuitOpen(runtimeState, provider.id, reference.model, protocol)) continue;
      const modelConfig = provider.models.find(({ id }) => id === reference.model);
      if (!modelConfig || !candidateSupports(provider, reference, required, body, Boolean(translate))) continue;
      candidates.push({
        provider,
        model: modelConfig,
        upstreamModel: resolveUpstreamModel(provider, modelConfig.id),
        protocol,
        native: translate !== "anthropic-from-openai",
        ...(translate ? { translate } : {}),
        family: reference.family,
      });
    }
    if (role.avoid_recent_families) {
      const historyIdentity = historyKey === undefined ? affinityKey : historyKey;
      const historyEntry = historyIdentity ? runtimeState?.modelHistory?.get(historyIdentity) : null;
      const historyTtl = Number(env.ROUTING_ROLE_HISTORY_TTL_MS || 60 * 60 * 1000);
      const history = historyEntry && historyEntry.updatedAt + historyTtl > Date.now() ? historyEntry.families : [];
      if (history.length) {
        const diverse = candidates.filter(({ family }) => family && !history.includes(family));
        if (diverse.length) candidates = diverse;
      }
    }
    const ordered = reorderByAffinity(reorderByQuota(candidates, runtimeState), runtimeState, affinityKey, role.id)
      .slice(0, role.max_attempts);
    const fallbackPlan = buildRoutePlan(config, {
      model: role.fallback, protocol, body, affinityKey, historyKey,
    }, env, runtimeState);
    const fallbackCandidates = fallbackPlan && !fallbackPlan.error ? fallbackPlan.candidates : [];
    const seenCandidates = new Set(ordered.map(({ provider, upstreamModel }) => `${provider.id}:${upstreamModel}`));
    for (const candidate of fallbackCandidates) {
      const key = `${candidate.provider.id}:${candidate.upstreamModel}`;
      if (!seenCandidates.has(key)) ordered.push(candidate);
      seenCandidates.add(key);
    }
    if (!ordered.length) return fallbackPlan?.error || { error: { status: 503, code: "no_compatible_role_route", message: "No eligible provider can serve this role or its fallback" } };
    return {
      requestedModel: model,
      publicModel: role.id,
      profile: role.id,
      required,
      deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
      maxAttempts: ordered.length,
      candidates: ordered,
    };
  }
  if (!profile) {
    const providerId = matchConfiguredProvider(config, model);
    const provider = providerById(config, providerId);
    if (!provider) return null;
    // An Anthropic caller can be served by a chat-completions provider through
    // translation. This is what makes /v1/messages work for every configured
    // model instead of only the two that declare the messages protocol.
    const directTranslate = translationFor(provider, protocol);
    if (directTranslate === "anthropic-from-openai" && TRANSLATING_ADAPTERS.has(provider.adapter)) {
      if (!providerEnabled(provider, env)) return null;
      // The native lane for this provider rewrites the model on the way out;
      // the translated lane has to land on the same upstream id, or an id from
      // /v1/models works on /v1/chat/completions and fails here.
      const resolvedModel = normalizeUpstreamModel(provider.id, resolveUpstreamModel(provider, model));
      const modelConfig = provider.models.find(({ id }) => id === resolvedModel) || { id: resolvedModel };
      const required = inspectRequestFeatures(protocol, body);
      if (!candidateSupports(provider, modelConfig, required, body, true)) {
        return {
          error: {
            status: 400,
            code: "model_cannot_serve_messages",
            message: `${provider.id}/${model} cannot serve this Anthropic request (missing capability or context window)`,
          },
        };
      }
      return {
        requestedModel: model,
        publicModel: model,
        profile: null,
        required,
        deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
        maxAttempts: 1,
        candidates: [{
          provider,
          model: modelConfig,
          upstreamModel: modelConfig.id,
          protocol,
          native: false,
          translate: directTranslate,
          family: modelConfig.family || provider.metadata?.family,
        }],
      };
    }
    if (provider.adapter === "opencode-zen") {
      // Direct model requests for Zen are routed through the adapter so the
      // free-tier gate (OAuth token, OpenCode identity, real session, streaming,
      // declared tools) is applied, and the Anthropic protocol is translated
      // because Zen only serves free traffic on chat completions.
      const protocols = Array.isArray(provider.protocols) && provider.protocols.length
        ? provider.protocols
        : ["chat_completions"];
      if (!protocols.includes(protocol)) {
        return { error: { status: 400, code: "opencode_zen_unsupported_protocol", message: `OpenCode Zen does not serve the ${protocol} protocol` } };
      }
      if (!providerEnabled(provider, env)) {
        return { error: { status: 503, code: "opencode_zen_unavailable", message: "OpenCode Zen credential is missing or unreadable" } };
      }
      const upstreamModel = model
        .replace(/^(opencode-zen|zen|oc)\//i, "");
      return {
        requestedModel: model,
        publicModel: model,
        profile: null,
        required: inspectRequestFeatures(protocol, body),
        deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
        maxAttempts: 1,
        candidates: [{ provider, model: { id: model }, upstreamModel, protocol, native: true }],
      };
    }
    if (provider.adapter !== "cline-oauth") return null;
    if (!(provider.protocols || ["chat_completions"]).includes(protocol)) {
      return { error: { status: 400, code: "cline_chat_completions_only", message: "Cline free models support only OpenAI Chat Completions" } };
    }
    return {
      requestedModel: model,
      publicModel: model,
      profile: null,
      required: inspectRequestFeatures(protocol, body),
      deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
      maxAttempts: 1,
      candidates: [{ provider, model: { id: model }, upstreamModel: model, protocol, native: true }],
    };
  }

  const required = inspectRequestFeatures(protocol, body);
  const candidates = [];
  for (const reference of profile.candidates) {
    const provider = providerById(config, reference.provider);
    if (!provider || !providerEnabled(provider, env)) continue;
    const translate = translationFor(provider, protocol);
    if (translate === null || (translate && !TRANSLATING_ADAPTERS.has(provider.adapter))) continue;
    if (circuitOpen(runtimeState, provider.id, reference.model, protocol)) continue;
    if (!candidateSupports(provider, reference, required, body, Boolean(translate))) continue;
    candidates.push({
      provider,
      model: { id: reference.model },
      upstreamModel: resolveUpstreamModel(provider, reference.model),
      protocol,
      native: translate !== "anthropic-from-openai",
      ...(translate ? { translate } : {}),
      family: reference.family || provider.models.find(({ id }) => id === reference.model)?.family || provider.metadata?.family,
    });
  }

  const quotaOrdered = reorderByQuota(candidates, runtimeState);
  const limited = reorderByAffinity(quotaOrdered, runtimeState, affinityKey, profile.id).slice(0, profile.max_attempts);
  const classCandidate = cheapClassCandidate(config, profile, requestClass, agentType, protocol, required, body, env, runtimeState);
  if (config.classRouting?.enabled && CLASS_ROUTING_CLASSES.has(requestClass) && !classCandidate) {
    runtimeState.classRoutingMisses ||= new Set();
    const missKey = `${profile.id}:${requestClass}`;
    if (!runtimeState.classRoutingMisses.has(missKey)) {
      runtimeState.classRoutingMisses.add(missKey);
      console.warn(`class-routing: no verified window-safe target for ${profile.id}/${requestClass}; keeping the session route`);
    }
  }
  const planned = classCandidate
    ? [classCandidate, ...limited.filter(({ provider, upstreamModel }) => provider.id !== classCandidate.provider.id || upstreamModel !== classCandidate.upstreamModel)]
    : limited;
  if (!planned.length) {
    return { error: { status: 503, code: "no_compatible_route", message: "No eligible provider can serve this profile" } };
  }
  return {
    requestedModel: model,
    publicModel: profile.id,
    profile: profile.id,
    required,
    deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
    maxAttempts: planned.length,
    candidates: planned,
  };
}
