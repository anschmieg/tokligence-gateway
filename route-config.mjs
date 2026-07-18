import fs from "node:fs";
import { parse, stringify } from "yaml";

const VALID_ADAPTERS = new Set(["tokligence", "oauth-proxy", "openai-compatible"]);
const VALID_PROTOCOLS = new Set(["chat_completions", "responses", "messages"]);
const VALID_BILLING = new Set(["subscription", "paygo"]);

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requireList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function normalizedUrl(value, label, { allowHttp = false } = {}) {
  const url = new URL(requireString(value, label));
  if (url.protocol !== "https:" && (!allowHttp || url.protocol !== "http:")) {
    throw new Error(`${label} must use ${allowHttp ? "HTTP or HTTPS" : "HTTPS"}`);
  }
  return url.toString().replace(/\/$/, "");
}

function envEnabled(provider, env) {
  return !provider.enabled_env || String(env[provider.enabled_env] || "").toLowerCase() === "true";
}

function wildcardRegex(pattern) {
  return new RegExp(`^${pattern.toLowerCase().split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

function normalizeCapabilities(value, label) {
  const capabilities = value || {};
  const protocols = requireList(capabilities.protocols, `${label}.protocols`).map((protocol) => {
    const valid = requireString(protocol, `${label}.protocol`);
    if (!VALID_PROTOCOLS.has(valid)) throw new Error(`${label} has unsupported protocol: ${valid}`);
    return valid;
  });
  return {
    protocols,
    streaming: capabilities.streaming === true,
    tools: capabilities.tools === true,
    parallel_tools: capabilities.parallel_tools === true,
    structured_output: capabilities.structured_output === true,
    reasoning: capabilities.reasoning === true,
    vision: capabilities.vision === true,
  };
}

function normalizeV1(raw) {
  console.warn("routing config version 1 is deprecated; normalize it to version 2");
  const providers = (raw.providers || []).map((provider) => ({
    ...provider,
    adapter: provider.adapter === "middleware" ? "openai-compatible" : provider.adapter,
    billing_class: provider.id === "openrouter" ? "paygo" : "subscription",
    protocols: ["chat_completions", "responses", "messages"],
    retry_owner: provider.adapter === "oauth-proxy" ? "adapter" : "gateway",
  }));
  const models = providers.flatMap((provider) => (provider.models || []).map((model) => {
    const id = typeof model === "string" ? model : model.id;
    return {
      id,
      provider: provider.id,
      upstream_model: id,
      quality_tier: provider.id === "codex-oauth" ? "premium" : "standard",
      context_window: typeof model === "object" ? model.context_window : undefined,
      capabilities: { protocols: ["chat_completions", "responses", "messages"], streaming: true },
    };
  }));
  return {
    version: 2,
    access: raw.access,
    providers,
    models,
    profiles: [],
    aliases: (raw.aliases || []).map(({ provider, fallback, ...alias }) => alias),
    routes: raw.routes || [],
    budget: { monthly_limit_eur: 50, local_paygo_limit_eur: 0 },
  };
}

export function parseRoutingConfig(source) {
  let raw = parse(source);
  if (!raw || typeof raw !== "object") throw new Error("routing config must be an object");
  if (raw.version === 1) raw = normalizeV1(raw);
  if (raw.version !== 2) throw new Error("routing config version must be 2");

  const access = {
    public_secret_env: requireString(raw.access?.public_secret_env, "access.public_secret_env"),
    admin_secret_env: requireString(raw.access?.admin_secret_env, "access.admin_secret_env"),
  };
  const providers = requireList(raw.providers, "routing config providers").map((provider, index) => {
    const label = `providers[${index}]`;
    const id = requireString(provider?.id, `${label}.id`);
    const adapter = requireString(provider?.adapter, `${label}.adapter`);
    if (!VALID_ADAPTERS.has(adapter)) throw new Error(`${label}.adapter is not supported: ${adapter}`);
    const billing_class = requireString(provider?.billing_class, `${label}.billing_class`);
    if (!VALID_BILLING.has(billing_class)) throw new Error(`${label}.billing_class is not supported: ${billing_class}`);
    const protocols = requireList(provider?.protocols, `${label}.protocols`).map((protocol) => {
      const value = requireString(protocol, `${label}.protocol`);
      if (!VALID_PROTOCOLS.has(value)) throw new Error(`${label}.protocols has unsupported value: ${value}`);
      return value;
    });
    if (adapter === "openai-compatible" && !provider.base_url_env && !provider.default_base_url) {
      throw new Error(`${label} requires base_url_env or default_base_url`);
    }
    if (provider.default_base_url) normalizedUrl(provider.default_base_url, `${label}.default_base_url`);
    if (provider.base_url) normalizedUrl(provider.base_url, `${label}.base_url`, { allowHttp: adapter === "tokligence" });
    return { ...provider, id, adapter, billing_class, protocols, default: provider.default === true,
      retry_owner: provider.retry_owner || "gateway" };
  });
  const providerIds = new Set(providers.map(({ id }) => id.toLowerCase()));
  if (providerIds.size !== providers.length) throw new Error("provider IDs must be unique case-insensitively");
  if (providers.filter(({ default: isDefault }) => isDefault).length !== 1) throw new Error("routing config must define exactly one default provider");
  const knownProvider = (id) => providers.some((provider) => provider.id === id);

  const models = requireList(raw.models, "routing config models").map((model, index) => {
    const label = `models[${index}]`;
    const id = requireString(model?.id, `${label}.id`);
    const provider = requireString(model?.provider, `${label}.provider`);
    if (!knownProvider(provider)) throw new Error(`${label} references unknown provider: ${provider}`);
    const quality_tier = requireString(model?.quality_tier, `${label}.quality_tier`);
    if (!new Set(["premium", "standard", "economy"]).has(quality_tier)) throw new Error(`${label}.quality_tier is invalid`);
    const context_window = Number(model?.context_window || 0);
    if (!Number.isSafeInteger(context_window) || context_window <= 0) throw new Error(`${label}.context_window must be a positive integer`);
    return { ...model, id, provider, upstream_model: requireString(model?.upstream_model, `${label}.upstream_model`), quality_tier, context_window,
      capabilities: normalizeCapabilities(model?.capabilities, `${label}.capabilities`) };
  });
  const modelIds = new Set(models.map(({ id }) => id.toLowerCase()));
  if (modelIds.size !== models.length) throw new Error("model IDs must be unique case-insensitively");

  const profiles = (raw.profiles || []).map((profile, index) => {
    const label = `profiles[${index}]`;
    const id = requireString(profile?.id, `${label}.id`);
    const public_model = requireString(profile?.public_model, `${label}.public_model`);
    const candidates = requireList(profile?.candidates, `${label}.candidates`).map((candidate) => requireString(candidate, `${label}.candidate`));
    if (new Set(candidates.map((candidate) => candidate.toLowerCase())).size !== candidates.length) throw new Error(`${label}.candidates must be unique`);
    for (const candidate of candidates) if (!modelIds.has(candidate.toLowerCase())) throw new Error(`${label} references unknown model: ${candidate}`);
    const max_attempts = Number(profile?.max_attempts || 0);
    if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 || max_attempts > candidates.length) throw new Error(`${label}.max_attempts must select configured candidates`);
    return { ...profile, id, public_model, candidates, max_attempts, permit_paygo: profile.permit_paygo === true };
  });
  const publicModels = new Set(profiles.map(({ public_model }) => public_model.toLowerCase()));
  if (publicModels.size !== profiles.length) throw new Error("profile public models must be unique case-insensitively");

  const aliases = (raw.aliases || []).map((alias, index) => {
    const label = `aliases[${index}]`;
    const id = requireString(alias?.id, `${label}.id`);
    const patterns = requireList(alias?.patterns, `${label}.patterns`).map((pattern) => requireString(pattern, `${label}.pattern`));
    const target = requireString(alias?.target, `${label}.target`);
    if (!modelIds.has(target.toLowerCase()) && !publicModels.has(target.toLowerCase())) throw new Error(`${label} references unknown model or profile: ${target}`);
    return { id, patterns, target };
  });
  const aliasIds = new Set(aliases.map(({ id }) => id.toLowerCase()));
  if (aliasIds.size !== aliases.length) throw new Error("alias IDs must be unique case-insensitively");

  const routes = (raw.routes || []).map((route, index) => {
    const provider = requireString(route?.provider, `routes[${index}].provider`);
    if (!knownProvider(provider)) throw new Error(`routes[${index}] references unknown provider: ${provider}`);
    return { provider, upstream: route.upstream ? requireString(route.upstream, `routes[${index}].upstream`) : null,
      prefixes: requireList(route?.prefixes, `routes[${index}].prefixes`).map((prefix) => requireString(prefix, `routes[${index}].prefix`)) };
  });
  const budget = { monthly_limit_eur: Number(raw.budget?.monthly_limit_eur), local_paygo_limit_eur: Number(raw.budget?.local_paygo_limit_eur) };
  if (!Number.isFinite(budget.monthly_limit_eur) || budget.monthly_limit_eur < 0 || !Number.isFinite(budget.local_paygo_limit_eur) || budget.local_paygo_limit_eur < 0) throw new Error("budget limits must be non-negative numbers");
  return { version: 2, access, providers, models, profiles, aliases, routes, budget };
}

export function loadRoutingConfig(path) { return parseRoutingConfig(fs.readFileSync(path, "utf8")); }
export function providerEnabled(provider, env = process.env) {
  if (!envEnabled(provider, env)) return false;
  if (provider.adapter === "tokligence") return true;
  if (provider.api_key_env) return Boolean(env[provider.api_key_env]);
  if (provider.adapter === "oauth-proxy") return Boolean(env[provider.internal_api_key_env]);
  return true;
}
export function enabledProviders(config, env = process.env) { return config.providers.filter((provider) => providerEnabled(provider, env)); }
export function providerById(config, id) { return config.providers.find((provider) => provider.id === id) || null; }
export function modelById(config, id) { return config.models.find((model) => model.id.toLowerCase() === String(id).toLowerCase()) || null; }
export function profileByModel(config, model) { return config.profiles.find((profile) => profile.public_model.toLowerCase() === String(model).toLowerCase()) || null; }
export function configuredModels(config, env = process.env) { return config.models.filter((model) => providerEnabled(providerById(config, model.provider), env)); }
export function matchConfiguredProvider(config, model, env = process.env) {
  if (!model) return null;
  const lower = model.toLowerCase();
  const route = config.routes.filter((candidate) => providerEnabled(providerById(config, candidate.provider), env))
    .flatMap((candidate) => candidate.prefixes.map((prefix) => ({ candidate, prefix })))
    .filter(({ prefix }) => lower.startsWith(prefix.toLowerCase()))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.candidate;
  return route?.provider || enabledProviders(config, env).find(({ default: isDefault }) => isDefault)?.id || null;
}
export function resolveConfiguredAlias(config, model) {
  if (!model) return model;
  const matched = config.aliases.flatMap((alias) => alias.patterns.map((pattern) => ({ alias, pattern })))
    .filter(({ pattern }) => wildcardRegex(pattern).test(model.toLowerCase()))
    .sort((a, b) => b.pattern.replaceAll("*", "").length - a.pattern.replaceAll("*", "").length)[0];
  return matched ? matched.alias.target : model;
}
function envValue(env, name, fallback = "") { return (name && env[name]) || fallback; }
export function compileTokligenceIni(config, env = process.env) {
  const provider = config.providers.find(({ adapter }) => adapter === "tokligence");
  if (!provider) throw new Error("routing config requires one Tokligence provider");
  const anthropic = provider.upstreams?.anthropic || {}; const openai = provider.upstreams?.openai || {};
  const routePairs = config.routes.filter((route) => route.provider === provider.id).flatMap((route) => route.prefixes.map((prefix) => `${prefix}*=>${route.upstream || "anthropic"}`));
  const providerRoutePairs = config.routes.filter((route) => route.provider === provider.id).flatMap((route) => route.prefixes.map((prefix) => `${prefix}*=${route.upstream || "anthropic"}`));
  return ["auth_disabled=true", `auth_secret=${env[config.access.public_secret_env] || ""}`, "log_level=info", "ledger_path=/data/ledger.db", "identity_path=/data/identity.db", "work_mode=auto", "", `anthropic_api_key=${envValue(env, anthropic.api_key_env)}`, `anthropic_base_url=${envValue(env, anthropic.base_url_env, anthropic.default_base_url)}`, "", `openai_api_key=${envValue(env, openai.api_key_env)}`, `openai_base_url=${envValue(env, openai.base_url_env, openai.default_base_url)}`, "", `model_provider_routes=${providerRoutePairs.join(",")}`, `routes=${[...routePairs, "loopback=>loopback"].join(",")}`, "enable_facade=true", "multiport_mode=false", "facade_port=8081", ""].join("\n");
}
export function compileOAuthProxyYaml(config, env = process.env) {
  const provider = config.providers.find(({ adapter }) => adapter === "oauth-proxy"); if (!provider) return null;
  const pool = provider.credential_pool || {};
  return stringify({ host: "127.0.0.1", port: 8317, "remote-management": { "allow-remote": false, "secret-key": "", "disable-control-panel": true }, "auth-dir": provider.auth_dir || "/data/cliproxy/auth", "api-keys": [envValue(env, provider.internal_api_key_env)], debug: false, "logging-to-file": false, "usage-statistics-enabled": false, "request-retry": pool.request_retry ?? 1, "max-retry-credentials": pool.max_retry_credentials ?? 2, "max-retry-interval": pool.max_retry_interval ?? 30, routing: { strategy: pool.strategy || "round-robin", "session-affinity": pool.session_affinity === true, "session-affinity-ttl": pool.session_affinity_ttl || "1h" } });
}
export function publicRoutingConfig(config, env = process.env) {
  return { version: config.version, providers: config.providers.map((provider) => ({ id: provider.id, adapter: provider.adapter, default: provider.default, configured: providerEnabled(provider, env), billing_class: provider.billing_class, protocols: provider.protocols, models: config.models.filter((model) => model.provider === provider.id).map(({ id }) => id), credential_pool: provider.credential_pool || undefined })), models: config.models.map(({ id, provider, upstream_model, ...model }) => ({ id, provider, ...model })), profiles: config.profiles, routes: config.routes, aliases: config.aliases, budget: config.budget };
}
