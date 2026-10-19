import fs from "node:fs";
import { parse, stringify } from "yaml";

const VALID_ADAPTERS = new Set(["tokligence", "oauth-proxy", "middleware", "copilot-sdk", "openai-compatible", "cline-oauth", "opencode-zen"]);

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeModel(model, label) {
  if (typeof model === "string") return { id: requireString(model, label) };
  return {
    ...model,
    id: requireString(model?.id, `${label}.id`),
  };
}

function optionalBoundedInteger(value, label, fallback, minimum, maximum) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeClineOAuthProvider(provider, index) {
  const label = `providers[${index}]`;
  return {
    ...provider,
    default_base_url: provider.default_base_url
      ? requireString(provider.default_base_url, `${label}.default_base_url`)
      : "https://api.cline.bot",
    default_workos_base_url: provider.default_workos_base_url
      ? requireString(provider.default_workos_base_url, `${label}.default_workos_base_url`)
      : "https://api.workos.com",
    credentials_path: provider.credentials_path
      ? requireString(provider.credentials_path, `${label}.credentials_path`)
      : "/data/cline-oauth/credentials.json",
    model_cache_ttl_ms: optionalBoundedInteger(
      provider.model_cache_ttl_ms,
      `${label}.model_cache_ttl_ms`,
      300000,
      0,
      300000,
    ),
    request_timeout_ms: optionalBoundedInteger(
      provider.request_timeout_ms,
      `${label}.request_timeout_ms`,
      30000,
      1,
      120000,
    ),
    refresh_buffer_ms: optionalBoundedInteger(
      provider.refresh_buffer_ms,
      `${label}.refresh_buffer_ms`,
      300000,
      0,
      3600000,
    ),
  };
}

function envEnabled(provider, env) {
  if (!provider.enabled_env) return true;
  return String(env[provider.enabled_env] || "").toLowerCase() === "true";
}

export function parseRoutingConfig(source) {
  const raw = parse(source);
  if (!raw || (raw.version !== 1 && raw.version !== 2)) throw new Error("routing config version must be 1 or 2");
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new Error("routing config must define providers");
  }

  const access = {
    public_secret_env: requireString(raw.access?.public_secret_env, "access.public_secret_env"),
    admin_secret_env: requireString(raw.access?.admin_secret_env, "access.admin_secret_env"),
  };

  const providers = raw.providers.map((provider, index) => {
    const id = requireString(provider?.id, `providers[${index}].id`);
    const adapter = requireString(provider?.adapter, `providers[${index}].adapter`);
    if (!VALID_ADAPTERS.has(adapter)) {
      throw new Error(`providers[${index}].adapter is not supported: ${adapter}`);
    }
    const betaAllowlist = provider.anthropic_beta_allowlist ?? [];
    if (!Array.isArray(betaAllowlist) || betaAllowlist.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`providers[${index}].anthropic_beta_allowlist must contain only non-empty strings`);
    }
    if (betaAllowlist.length && ["oauth-proxy", "opencode-zen", "cline-oauth", "copilot-sdk", "tokligence"].includes(adapter)) {
      throw new Error(`providers[${index}] cannot allow Anthropic betas on the ${adapter} adapter`);
    }
    const normalizedProvider = adapter === "cline-oauth"
      ? normalizeClineOAuthProvider(provider, index)
      : provider;
    return {
      ...normalizedProvider,
      id,
      adapter,
      default: provider.default === true,
      models: (provider.models || []).map((model, modelIndex) =>
        normalizeModel(model, `providers[${index}].models[${modelIndex}]`)),
    };
  });
  const providerIds = new Set(providers.map(({ id }) => id));
  if (providerIds.size !== providers.length) throw new Error("provider IDs must be unique");
  if (providers.filter(({ default: isDefault }) => isDefault).length !== 1) {
    throw new Error("routing config must define exactly one default provider");
  }

  const routes = (raw.routes || []).map((route, index) => {
    const provider = requireString(route?.provider, `routes[${index}].provider`);
    if (!providerIds.has(provider)) {
      throw new Error(`routes[${index}] references unknown provider: ${provider}`);
    }
    if (!Array.isArray(route.prefixes) || route.prefixes.length === 0) {
      throw new Error(`routes[${index}].prefixes must not be empty`);
    }
    return {
      provider,
      upstream: route.upstream ? requireString(route.upstream, `routes[${index}].upstream`) : null,
      prefixes: route.prefixes.map((prefix, prefixIndex) =>
        requireString(prefix, `routes[${index}].prefixes[${prefixIndex}]`)),
    };
  });

  const profiles = Object.entries(raw.profiles || {}).map(([profileId, value], index) => {
    const id = requireString(profileId, `profiles[${index}].id`);
    if (!Array.isArray(value?.candidates) || value.candidates.length === 0) {
      throw new Error(`profile ${id}.candidates must not be empty`);
    }
    const candidates = value.candidates.map((candidate, candidateIndex) => {
      const provider = requireString(candidate?.provider, `profile ${id}.candidates[${candidateIndex}].provider`);
      if (!providerIds.has(provider)) throw new Error(`profile ${id} references unknown provider: ${provider}`);
      return {
        provider,
        model: requireString(candidate?.model, `profile ${id}.candidates[${candidateIndex}].model`),
        ...(candidate?.family ? { family: requireString(candidate.family, `profile ${id}.candidates[${candidateIndex}].family`) } : {}),
      };
    });
    const max_attempts = value?.max_attempts == null ? candidates.length : Number(value.max_attempts);
    if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 || max_attempts > candidates.length) {
      throw new Error(`profile ${id}.max_attempts must be between 1 and ${candidates.length}`);
    }
    return { id, candidates, max_attempts, context_window: value?.context_window || undefined };
  });
  const profileIds = new Set(profiles.map(({ id }) => id.toLowerCase()));
  if (profileIds.size !== profiles.length) throw new Error("profile IDs must be unique case-insensitively");

  const roles = Object.entries(raw.roles || {}).map(([roleName, value], index) => {
    const name = requireString(roleName, `roles[${index}].name`);
    if (name.includes("/")) throw new Error(`role ${name} name must not include a slash`);
    if (!Array.isArray(value?.candidates) || value.candidates.length === 0) {
      throw new Error(`role ${name}.candidates must not be empty`);
    }
    const candidates = value.candidates.map((candidate, candidateIndex) => {
      const providerId = requireString(candidate?.provider, `role ${name}.candidates[${candidateIndex}].provider`);
      const provider = providerById({ providers }, providerId);
      if (!provider) throw new Error(`role ${name} references unknown provider: ${providerId}`);
      const modelId = requireString(candidate?.model, `role ${name}.candidates[${candidateIndex}].model`);
      const model = provider.models.find(({ id }) => id === modelId);
      if (!model) throw new Error(`role ${name} references unknown model ${providerId}/${modelId}`);
      const family = requireString(candidate?.family, `role ${name}.candidates[${candidateIndex}].family`);
      const context_window = Number(candidate.context_window || model.context_window || provider.metadata?.context_window || 0);
      if (!Number.isSafeInteger(context_window) || context_window <= 0) {
        throw new Error(`role ${name} candidate ${providerId}/${modelId} requires a verified context_window`);
      }
      return { provider: providerId, model: modelId, family, context_window };
    });
    const fallback = requireString(value?.fallback, `role ${name}.fallback`);
    if (!profiles.some(({ id }) => id.toLowerCase() === fallback.toLowerCase())) {
      throw new Error(`role ${name}.fallback must reference a configured profile`);
    }
    const max_attempts = value?.max_attempts == null ? candidates.length : Number(value.max_attempts);
    if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 || max_attempts > candidates.length) {
      throw new Error(`role ${name}.max_attempts must be between 1 and ${candidates.length}`);
    }
    return { id: `role/${name}`, candidates, max_attempts, fallback, context_window: Math.min(...candidates.map(({ context_window }) => context_window)), avoid_recent_families: value?.avoid_recent_families !== false };
  });
  const roleIds = new Set(roles.map(({ id }) => id.toLowerCase()));
  if (roleIds.size !== roles.length) throw new Error("role IDs must be unique case-insensitively");

  if (!Array.isArray(raw.aliases)) throw new Error("routing config aliases must be a list");
  const aliases = raw.aliases.map((value, index) => {
    const id = requireString(value?.id, `aliases[${index}].id`);
    if (!Array.isArray(value.patterns) || value.patterns.length === 0) {
      throw new Error(`aliases[${index}].patterns must not be empty`);
    }
    const provider = value.provider ? requireString(value.provider, `alias ${id}.provider`) : null;
    if (provider && !providerIds.has(provider)) throw new Error(`alias ${id} references unknown provider: ${provider}`);
    return {
      id,
      patterns: value.patterns.map((pattern, patternIndex) =>
        requireString(pattern, `aliases[${index}].patterns[${patternIndex}]`)),
      provider,
      target: requireString(value?.target, `alias ${id}.target`),
      fallback: value.fallback ? requireString(value.fallback, `alias ${id}.fallback`) : null,
    };
  });

  const rawClassRouting = raw.classRouting || {};
  if (rawClassRouting.enabled != null && typeof rawClassRouting.enabled !== "boolean") {
    throw new Error("classRouting.enabled must be a boolean");
  }
  let cheapPolicyModel = null;
  if (rawClassRouting.cheapPolicyModel != null) {
    const targetProviderId = requireString(rawClassRouting.cheapPolicyModel.provider, "classRouting.cheapPolicyModel.provider");
    const targetModelId = requireString(rawClassRouting.cheapPolicyModel.model, "classRouting.cheapPolicyModel.model");
    const targetProvider = providerById({ providers }, targetProviderId);
    if (!targetProvider || !targetProvider.models.some(({ id }) => id === targetModelId)) {
      throw new Error("classRouting.cheapPolicyModel must reference a configured provider model");
    }
    if (targetProvider.adapter === "oauth-proxy") {
      throw new Error("classRouting.cheapPolicyModel cannot target an oauth-proxy");
    }
    const targetModel = targetProvider.models.find(({ id }) => id === targetModelId);
    const targetWindow = Number(targetModel.context_window || targetProvider.metadata?.context_window || 0);
    if (rawClassRouting.enabled === true && (!Number.isSafeInteger(targetWindow) || targetWindow <= 0)) {
      throw new Error("classRouting.cheapPolicyModel requires a verified context_window when enabled");
    }
    cheapPolicyModel = { provider: targetProviderId, model: targetModelId };
  }
  if (rawClassRouting.enabled === true && !cheapPolicyModel) {
    throw new Error("classRouting.enabled requires classRouting.cheapPolicyModel");
  }
  const classRouting = { enabled: rawClassRouting.enabled === true, cheapPolicyModel };

  return { version: 1, access, providers, routes, profiles, roles, aliases, model_picker: raw.model_picker || {}, classRouting };
}

export function loadRoutingConfig(path) {
  return parseRoutingConfig(fs.readFileSync(path, "utf8"));
}

export function providerEnabled(provider, env = process.env) {
  if (!envEnabled(provider, env)) return false;
  if (provider.adapter === "opencode-zen") {
    // The free tier is only served to an account that completed the Console
    // sign-in, so the OAuth credential is what makes this provider available.
    const file = (provider.credential_file_env && env[provider.credential_file_env])
      || provider.credential_file
      || env.OPENCODE_ZEN_CREDENTIAL_FILE;
    if (!file) return false;
    try {
      const credential = JSON.parse(fs.readFileSync(file, "utf8"));
      return typeof credential?.access === "string" && credential.access.length > 0;
    } catch {
      return false;
    }
  }
  if (provider.api_key_env) return Boolean(env[provider.api_key_env]);
  if (provider.adapter === "oauth-proxy") return Boolean(env[provider.internal_api_key_env]);
  return true;
}

export function enabledProviders(config, env = process.env) {
  return config.providers.filter((provider) => providerEnabled(provider, env));
}

export function quotaObserverProviders(config, env = process.env) {
  const providers = enabledProviders(config, env);
  const mistral = providerById(config, "mistral");
  if (mistral && (env.MISTRAL_SESSION_FILE || env.MISTRAL_ADMIN_API_KEY)
    && !providers.some((provider) => provider.id === "mistral")) providers.push(mistral);
  return providers;
}

export function providerById(config, id) {
  return config.providers.find((provider) => provider.id === id) || null;
}

export function profileByModel(config, model) {
  if (!model) return null;
  return (config.profiles || []).find(({ id }) => id.toLowerCase() === String(model).toLowerCase()) || null;
}

export function roleByModel(config, model) {
  if (!model) return null;
  return (config.roles || []).find(({ id }) => id.toLowerCase() === String(model).toLowerCase()) || null;
}

export function configuredModels(config, env = process.env) {
  return enabledProviders(config, env).flatMap((provider) => provider.models.map((model) => ({
    ...model,
    provider: provider.id,
  })));
}

export function matchConfiguredProvider(config, model) {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const route of config.routes) {
    if (route.prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return route.provider;
  }
  return config.providers.find(({ default: isDefault }) => isDefault)?.id || null;
}

export function resolveConfiguredAlias(config, model, env = process.env) {
  if (!model) return model;
  const lower = model.toLowerCase();
  const wildcardRegex = (pattern) => new RegExp(`^${pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`);
  const match = config.aliases
    .flatMap((alias) => alias.patterns.map((pattern) => ({ alias, pattern })))
    .filter(({ pattern }) => wildcardRegex(pattern).test(lower))
    .sort((a, b) => b.pattern.replaceAll("*", "").length - a.pattern.replaceAll("*", "").length)[0];
  if (!match) return model;
  const alias = match.alias;
  if (!alias.provider) return alias.target;
  const provider = providerById(config, alias.provider);
  return provider && providerEnabled(provider, env) ? alias.target : (alias.fallback || model);
}

function envValue(env, name, fallback = "") {
  return (name && env[name]) || fallback;
}

export function compileTokligenceIni(config, env = process.env) {
  const provider = config.providers.find(({ adapter }) => adapter === "tokligence");
  if (!provider) throw new Error("routing config requires one Tokligence provider");
  const anthropic = provider.upstreams?.anthropic || {};
  const openai = provider.upstreams?.openai || {};
  const routePairs = config.routes
    .filter((route) => route.provider === provider.id)
    .flatMap((route) => route.prefixes.map((prefix) => `${prefix}*=>${route.upstream || "anthropic"}`));
  const providerRoutePairs = config.routes
    .filter((route) => route.provider === provider.id)
    .flatMap((route) => route.prefixes.map((prefix) => `${prefix}*=${route.upstream || "anthropic"}`));
  return [
    "auth_disabled=true",
    `auth_secret=${env[config.access.public_secret_env] || ""}`,
    "log_level=info",
    "ledger_path=/data/ledger.db",
    "identity_path=/data/identity.db",
    "work_mode=auto",
    "",
    `anthropic_api_key=${envValue(env, anthropic.api_key_env)}`,
    `anthropic_base_url=${envValue(env, anthropic.base_url_env, anthropic.default_base_url)}`,
    "",
    `openai_api_key=${envValue(env, openai.api_key_env)}`,
    `openai_base_url=${envValue(env, openai.base_url_env, openai.default_base_url)}`,
    "",
    `model_provider_routes=${providerRoutePairs.join(",")}`,
    `routes=${[...routePairs, "loopback=>loopback"].join(",")}`,
    "enable_facade=true",
    "multiport_mode=false",
    "facade_port=8081",
    "bridge_session_enabled=false",
    "bridge_session_ttl=5m",
    "bridge_session_max_count=1000",
    "",
  ].join("\n");
}

export function compileOAuthProxyYaml(config, env = process.env) {
  const provider = config.providers.find(({ adapter }) => adapter === "oauth-proxy");
  if (!provider) return null;
  const pool = provider.credential_pool || {};
  return stringify({
    host: "127.0.0.1",
    port: 8317,
    "remote-management": {
      "allow-remote": false,
      "secret-key": env.CODEX_MANAGEMENT_KEY || "",
      "disable-control-panel": true,
    },
    "auth-dir": provider.auth_dir || "/data/cliproxy/auth",
    "api-keys": [envValue(env, provider.internal_api_key_env)],
    debug: false,
    "logging-to-file": false,
    "usage-statistics-enabled": false,
    "request-retry": pool.request_retry ?? 1,
    "max-retry-credentials": pool.max_retry_credentials ?? 2,
    "max-retry-interval": pool.max_retry_interval ?? 30,
    routing: {
      strategy: pool.strategy || "round-robin",
      "session-affinity": pool.session_affinity === true,
      "session-affinity-ttl": pool.session_affinity_ttl || "1h",
    },
  });
}

export function publicRoutingConfig(config, env = process.env) {
  return {
    version: config.version,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      adapter: provider.adapter,
      default: provider.default,
      configured: providerEnabled(provider, env),
      discover_models: provider.discover_models === true,
      models: provider.models.map(({ id }) => id),
      credential_pool: provider.credential_pool || undefined,
    })),
    routes: config.routes,
    profiles: config.profiles,
    aliases: config.aliases,
  };
}
