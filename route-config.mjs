import fs from "node:fs";
import { parse, stringify } from "yaml";

const VALID_ADAPTERS = new Set(["tokligence", "oauth-proxy", "middleware", "copilot-sdk", "openai-compatible", "cline-oauth", "opencode-zen", "chatgpt-responses"]);

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

function validateCatalogPolicy(raw, providerIds) {
  const catalog = raw.model_catalog || {};
  for (const name of ["exclude", "retired"]) {
    if (catalog[name] != null && !Array.isArray(catalog[name])) throw new Error(`model_catalog.${name} must be a list`);
    for (const rule of catalog[name] || []) {
      requireString(rule?.pattern, `model_catalog.${name}.pattern`);
      new RegExp(rule.pattern, "i");
      if (rule.provider && !providerIds.has(rule.provider)) throw new Error(`Unknown catalog provider: ${rule.provider}`);
      if (name === "retired") requireString(rule.reason, "model_catalog.retired.reason");
    }
  }
  if (catalog.prefer_latest != null && typeof catalog.prefer_latest !== "boolean") throw new Error("model_catalog.prefer_latest must be a boolean");
  if (catalog.models != null && (typeof catalog.models !== "object" || Array.isArray(catalog.models))) throw new Error("model_catalog.models must be a mapping");
  const identities = new Set();
  const names = new Set();
  for (const [id, mapping] of Object.entries(catalog.models || {})) {
    requireString(id, "canonical model ID");
    if (names.has(id.toLowerCase())) throw new Error("Canonical model IDs must be unique");
    names.add(id.toLowerCase());
    if (!Array.isArray(mapping?.routes) || !mapping.routes.length) throw new Error(`Canonical model ${id} requires routes`);
    for (const reference of mapping.routes) {
      if (!providerIds.has(reference?.provider)) throw new Error(`Canonical model ${id} references an unknown provider`);
      requireString(reference.model, `canonical model ${id}.model`);
      const key = `${reference.provider}:${reference.model}`;
      if (identities.has(key)) throw new Error("A backend model can belong to only one canonical model");
      identities.add(key);
    }
  }
  const picker = raw.model_picker || {};
  optionalBoundedInteger(picker.max_models, "model_picker.max_models", 32, 1, 10000);
  if (picker.priority != null && !Array.isArray(picker.priority)) throw new Error("model_picker.priority must be a list");
  for (const pattern of picker.priority || []) new RegExp(requireString(pattern, "model_picker.priority"), "i");
  for (const rule of picker.hide || []) new RegExp(requireString(rule?.pattern, "model_picker.hide.pattern"), "i");
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
    if (adapter === "chatgpt-responses" && provider.enabled_env !== "CHATGPT_RESPONSES_ENABLED") {
      throw new Error(`providers[${index}] chatgpt-responses must use the explicit enable gate`);
    }
    if (provider.messages_translation != null && typeof provider.messages_translation !== "boolean") {
      throw new Error(`providers[${index}].messages_translation must be a boolean`);
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
    const opencodePool = provider.opencode_pool;
    if (opencodePool != null) {
      if (adapter !== "opencode-zen" || !opencodePool || typeof opencodePool !== "object" || Array.isArray(opencodePool)) throw new Error(`providers[${index}].opencode_pool is only valid for opencode-zen`);
      optionalBoundedInteger(opencodePool.max_attempts, `providers[${index}].opencode_pool.max_attempts`, 3, 1, 16);
      if (opencodePool.accounts != null && (!Array.isArray(opencodePool.accounts) || opencodePool.accounts.length > 32)) throw new Error(`providers[${index}].opencode_pool.accounts must be a list of at most 32 entries`);
      if (opencodePool.api_keys != null && (!Array.isArray(opencodePool.api_keys) || opencodePool.api_keys.length > 32)) throw new Error(`providers[${index}].opencode_pool.api_keys must be a list of at most 32 entries`);
      if ((opencodePool.accounts?.length || 0) + (opencodePool.api_keys?.length || 0) > 32) throw new Error(`providers[${index}].opencode_pool supports at most 32 total accounts`);
      const ids = new Set();
      const credentialRefs = new Set();
      const validatePoolEntry = (entry, entryIndex, type) => {
        const entryLabel = `providers[${index}].opencode_pool.${type}[${entryIndex}]`;
        const allowed = type === "accounts"
          ? ["id", "credential_file", "credential_file_env", "chat_models", "systemone_models"]
          : ["id", "env", "systemone_models"];
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !allowed.includes(key))) throw new Error(`${entryLabel} contains unsupported fields`);
        const accountId = requireString(entry?.id, `${entryLabel}.id`);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(accountId)) throw new Error(`${entryLabel}.id contains unsupported characters`);
        if (ids.has(accountId)) throw new Error(`providers[${index}].opencode_pool account IDs must be unique`);
        ids.add(accountId);
        if (type === "accounts") {
          if (!entry.credential_file && !entry.credential_file_env && !provider.credential_file && !provider.credential_file_env) throw new Error(`${entryLabel} requires credential_file or credential_file_env`);
          if (entry.credential_file_env != null) requireString(entry.credential_file_env, `${entryLabel}.credential_file_env`);
          if (entry.credential_file != null) requireString(entry.credential_file, `${entryLabel}.credential_file`);
          const ref = entry.credential_file_env ? `env:${entry.credential_file_env}` : `file:${entry.credential_file || provider.credential_file}`;
          if (credentialRefs.has(ref)) throw new Error(`${entryLabel} duplicates a credential reference`);
          credentialRefs.add(ref);
        } else requireString(entry.env, `${entryLabel}.env`);
        const envRef = type === "accounts" ? entry.credential_file_env : entry.env;
        if (envRef != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envRef)) throw new Error(`${entryLabel} must reference an environment variable name`);
        for (const field of ["chat_models", "systemone_models"]) {
          if (entry[field] != null && (!Array.isArray(entry[field]) || entry[field].some((model) => typeof model !== "string" || !model.trim()))) throw new Error(`${entryLabel}.${field} must contain non-empty model IDs`);
          if (field === "systemone_models" && (entry[field] || []).some((model) => !["jev-1.13-free", "jev-1.13"].includes(model))) throw new Error(`${entryLabel}.systemone_models contains an unsupported model`);
          if (field === "chat_models" && (entry[field] || []).some((model) => ["jev-1.13-free", "jev-1.13"].includes(model))) throw new Error(`${entryLabel}.chat_models cannot include native SystemOne models`);
        }
      };
      for (const [entryIndex, entry] of (opencodePool.accounts || []).entries()) validatePoolEntry(entry, entryIndex, "accounts");
      for (const [entryIndex, entry] of (opencodePool.api_keys || []).entries()) validatePoolEntry(entry, entryIndex, "api_keys");
    }
    if (provider.systemone != null) throw new Error(`providers[${index}].systemone is unsupported; configure opencode_pool instead`);
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
  validateCatalogPolicy(raw, providerIds);
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
    if (value?.specialist === true && (value.candidates.length !== 1 || (value.max_attempts != null && Number(value.max_attempts) !== 1) || value.fallback != null)) {
      throw new Error(`specialist role ${name} requires one candidate and no fallback`);
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
    const specialist = value?.specialist === true;
    const fallback = specialist ? null : requireString(value?.fallback, `role ${name}.fallback`);
    if (!specialist && !profiles.some(({ id }) => id.toLowerCase() === fallback.toLowerCase())) {
      throw new Error(`role ${name}.fallback must reference a configured profile`);
    }
    const instructions = specialist ? requireString(value.instructions, `role ${name}.instructions`) : null;
    const max_attempts = value?.max_attempts == null ? candidates.length : Number(value.max_attempts);
    if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 || max_attempts > candidates.length) {
      throw new Error(`role ${name}.max_attempts must be between 1 and ${candidates.length}`);
    }
    if (candidates.some(({ provider: providerId }) => providerById({ providers }, providerId).adapter === "chatgpt-responses") && !specialist) {
      throw new Error(`role ${name} using chatgpt-responses must be an explicit specialist without fallback`);
    }
    if (specialist && candidates.some(({ provider: providerId }) => providerById({ providers }, providerId).adapter !== "chatgpt-responses")) {
      throw new Error(`specialist role ${name} may only use chatgpt-responses candidates`);
    }
    return { id: `role/${name}`, candidates, max_attempts, fallback, specialist, instructions, context_window: Math.min(...candidates.map(({ context_window }) => context_window)), avoid_recent_families: value?.avoid_recent_families !== false };
  });
  const roleIds = new Set(roles.map(({ id }) => id.toLowerCase()));
  if (roleIds.size !== roles.length) throw new Error("role IDs must be unique case-insensitively");
  if (roles.some((role) => role.specialist && profiles.some((profile) => profile.id.toLowerCase() === role.id.toLowerCase()))) {
    throw new Error("specialist role IDs must not collide with profile IDs");
  }

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
  for (const provider of providers.filter(({ adapter }) => adapter === "chatgpt-responses")) {
    const usedByRole = roles.some((role) => role.specialist && role.candidates.some((candidate) => candidate.provider === provider.id));
    if (!usedByRole || routes.some((route) => route.provider === provider.id)
      || profiles.some((profile) => profile.candidates.some((candidate) => candidate.provider === provider.id))
      || (classRouting.cheapPolicyModel?.provider === provider.id)) {
      throw new Error(`provider ${provider.id} is restricted to explicit specialist roles`);
    }
  }
  return { version: 1, access, providers, routes, profiles, roles, aliases, model_picker: raw.model_picker || {}, model_catalog: raw.model_catalog || {}, classRouting };
}

export function loadRoutingConfig(path) {
  return parseRoutingConfig(fs.readFileSync(path, "utf8"));
}

export function providerEnabled(provider, env = process.env) {
  if (!envEnabled(provider, env)) return false;
  if (provider.adapter === "chatgpt-responses") {
    return env.CHATGPT_RESPONSES_ENABLED === "true"
      && Boolean(env.CHATGPT_SERVICE_URL && env.CHATGPT_SERVICE_TOKEN);
  }
  if (provider.adapter === "opencode-zen") {
    const pool = provider.opencode_pool || {};
    if ((pool.api_keys || []).some((entry) => env[entry.env])) return true;
    const accounts = pool.accounts || [];
    const credentialFiles = accounts.length
      ? accounts.map((account) => {
          const ref = account.credential_file_env || (account.credential_file ? null : provider.credential_file_env);
          return (ref && env[ref]) || account.credential_file || provider.credential_file;
        }).filter(Boolean)
      : [(provider.credential_file_env && env[provider.credential_file_env]) || provider.credential_file || env.OPENCODE_ZEN_CREDENTIAL_FILE].filter(Boolean);
    if (credentialFiles.some((file) => {
      try {
        const credential = JSON.parse(fs.readFileSync(file, "utf8"));
        return typeof credential?.access === "string" && credential.access.length > 0;
      } catch {
        return false;
      }
    })) return true;
    return false;
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

export function chatModelAvailable(provider, model, env = process.env) {
  if (provider.adapter !== "opencode-zen") return true;
  const pool = provider.opencode_pool;
  const accounts = pool ? (pool.accounts || []) : [{ chat_models: provider.models.map((entry) => entry.id), credential_file: provider.credential_file, credential_file_env: provider.credential_file_env }];
  return accounts.some((account) => {
    if (!(account.chat_models || []).includes(model)) return false;
    const ref = account.credential_file_env || (account.credential_file ? null : provider.credential_file_env);
    const file = (ref && env[ref]) || account.credential_file || provider.credential_file;
    try { return Boolean(JSON.parse(fs.readFileSync(file, "utf8"))?.access); } catch { return false; }
  });
}

export function configuredModels(config, env = process.env) {
  return enabledProviders(config, env).flatMap((provider) => provider.models.filter((model) => chatModelAvailable(provider, model.id, env)).map((model) => ({
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
    model_catalog: config.model_catalog,
    model_picker: config.model_picker,
  };
}
