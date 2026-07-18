import {
  modelById,
  profileByModel,
  providerById,
  providerEnabled,
  resolveConfiguredAlias,
} from "./route-config.mjs";
import { inspectRequestFeatures, supportsFeatures } from "./protocol-codecs.mjs";

function physicalModel(config, value) {
  return modelById(config, value) || config.models.find((model) => model.upstream_model.toLowerCase() === String(value).toLowerCase()) || null;
}

function circuitOpen(runtimeState, provider, model, protocol) {
  const until = runtimeState?.cooldowns?.get(`${provider}:${model}:${protocol}`) || 0;
  return until > Date.now();
}

export function buildRoutePlan(config, { model, protocol, body }, env = process.env, runtimeState = {}) {
  if (!model) return { error: { status: 400, code: "missing_model", message: "model is required" } };
  const requestedModel = model;
  const routeReference = resolveConfiguredAlias(config, model);
  const profile = profileByModel(config, routeReference);
  const required = inspectRequestFeatures(protocol, body);
  const references = profile ? profile.candidates : [routeReference];
  const candidates = [];

  for (const reference of references) {
    const physical = physicalModel(config, reference);
    if (!physical) {
      if (!profile) {
        const provider = providerById(config, "tokligence");
        if (provider && providerEnabled(provider, env)) candidates.push({ provider, model: null, upstreamModel: reference, protocol, native: true });
      }
      continue;
    }
    const provider = providerById(config, physical.provider);
    if (!provider || !providerEnabled(provider, env)) continue;
    if (provider.billing_class === "paygo" && (!profile?.permit_paygo || runtimeState?.paygoExhausted)) continue;
    if (!supportsFeatures(physical.capabilities, required)) continue;
    if (circuitOpen(runtimeState, provider.id, physical.id, protocol)) continue;
    candidates.push({ provider, model: physical, upstreamModel: physical.upstream_model, protocol, native: true });
  }
  const limited = candidates.slice(0, profile?.max_attempts || 1);
  if (!limited.length) return { error: { status: 503, code: "no_compatible_route", message: "No eligible provider can serve this request" } };
  return {
    requestedModel,
    publicModel: profile?.public_model || requestedModel,
    profile: profile?.id || null,
    required,
    deadline: Date.now() + Number(env.GATEWAY_REQUEST_TIMEOUT_MS || 120000),
    maxAttempts: limited.length,
    candidates: limited,
  };
}
