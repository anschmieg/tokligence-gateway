import { matchConfiguredProvider, profileByModel, providerById, providerEnabled, roleByModel } from "./route-config.mjs";
import { inspectRequestFeatures, supportsFeatures } from "./protocol-codecs.mjs";

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

function candidateSupports(provider, reference, required, body) {
  if (!supportsFeatures(providerCapabilities(provider), required)) return false;
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
  if (!model || !floor || !window || window < floor) return null;
  if (circuitOpen(runtimeState, provider.id, model.id, protocol)) return null;
  if (!candidateSupports(provider, model, required, body)) return null;
  return {
    provider,
    model,
    upstreamModel: model.id,
    protocol,
    native: true,
    family: model.family || provider.metadata?.family,
  };
}

export function buildRoutePlan(config, { model, protocol, body, requestClass = null, agentType = null, affinityKey = null, historyKey = undefined }, env = process.env, runtimeState = {}) {
  if (!model) return { error: { status: 400, code: "missing_model", message: "model is required" } };
  const profile = profileByModel(config, model);
  const role = roleByModel(config, model);
  if (!profile && role) {
    const required = inspectRequestFeatures(protocol, body);
    let candidates = [];
    for (const reference of role.candidates) {
      const provider = providerById(config, reference.provider);
      if (!provider || !providerEnabled(provider, env)) continue;
      if (circuitOpen(runtimeState, provider.id, reference.model, protocol)) continue;
      const modelConfig = provider.models.find(({ id }) => id === reference.model);
      if (!modelConfig || !candidateSupports(provider, reference, required, body)) continue;
      candidates.push({
        provider,
        model: modelConfig,
        upstreamModel: modelConfig.id,
        protocol,
        native: true,
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
    const protocols = Array.isArray(provider.protocols) && provider.protocols.length
      ? provider.protocols
      : ["chat_completions"];
    if (!protocols.includes(protocol)) continue;
    if (circuitOpen(runtimeState, provider.id, reference.model, protocol)) continue;
    if (!candidateSupports(provider, reference, required, body)) continue;
    candidates.push({
      provider,
      model: { id: reference.model },
      upstreamModel: reference.model,
      protocol,
      native: true,
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
