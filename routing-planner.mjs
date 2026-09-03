import { matchConfiguredProvider, profileByModel, providerById, providerEnabled } from "./route-config.mjs";
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

export function buildRoutePlan(config, { model, protocol, body, affinityKey = null }, env = process.env, runtimeState = {}) {
  if (!model) return { error: { status: 400, code: "missing_model", message: "model is required" } };
  const profile = profileByModel(config, model);
  if (!profile) {
    const providerId = matchConfiguredProvider(config, model);
    const provider = providerById(config, providerId);
    if (!provider || provider.adapter !== "cline-oauth") return null;
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
    });
  }

  const quotaOrdered = reorderByQuota(candidates, runtimeState);
  const limited = reorderByAffinity(quotaOrdered, runtimeState, affinityKey, profile.id).slice(0, profile.max_attempts);
  if (!limited.length) {
    return { error: { status: 503, code: "no_compatible_route", message: "No eligible provider can serve this profile" } };
  }
  return {
    requestedModel: model,
    publicModel: profile.id,
    profile: profile.id,
    required,
    deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
    maxAttempts: limited.length,
    candidates: limited,
  };
}
