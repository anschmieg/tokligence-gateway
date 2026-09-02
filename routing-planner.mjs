import { matchConfiguredProvider, profileByModel, providerById, providerEnabled } from "./route-config.mjs";
import { inspectRequestFeatures } from "./protocol-codecs.mjs";

function circuitOpen(runtimeState, provider, model, protocol) {
  const until = runtimeState?.cooldowns?.get(`${provider}:${model}:${protocol}`) || 0;
  return until > Date.now();
}

export function buildRoutePlan(config, { model, protocol, body }, env = process.env, runtimeState = {}) {
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
    candidates.push({
      provider,
      model: { id: reference.model },
      upstreamModel: reference.model,
      protocol,
      native: true,
    });
  }

  const limited = candidates.slice(0, profile.max_attempts);
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
