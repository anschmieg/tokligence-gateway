import { createHash } from "node:crypto";
import { canonicalCredentialFile, readCredential } from "./opencode-zen-credential.mjs";
import { getZenTokenProvider } from "./provider-adapters.mjs";
import { createSessionPool } from "./opencode-zen-session.mjs";

const MAX_STICKY = 4096;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_ACCOUNTS = 32;

export function makeOpenCodeAffinityKey(principal, session) {
  return createHash("sha256").update(`${principal || ""}\0${session || "default"}`).digest("base64url");
}

export function createOpenCodeAccountPool({ provider, env = process.env, getTokenProvider = getZenTokenProvider, createSessions = (options) => createSessionPool(options), now = () => Date.now(), maxAttempts = 3 } = {}) {
  const config = provider?.opencode_pool || {};
  const configured = Array.isArray(config.accounts) ? config.accounts : [];
  const legacy = configured.length || (Array.isArray(config.api_keys) && config.api_keys.length) ? [] : [{
    id: "legacy-oauth",
    credential_file: provider.credential_file,
    credential_file_env: provider.credential_file_env,
    chat_models: (provider.models || []).map((model) => typeof model === "string" ? model : model.id),
    systemone_models: ["jev-1.13-free"],
  }];
  const accounts = [...configured, ...legacy].map((account, index) => ({
    ...account,
    id: account.id || `oauth-${index + 1}`,
    credential_file: account.credential_file ?? provider.credential_file,
    credential_file_env: account.credential_file_env ?? (account.credential_file ? null : provider.credential_file_env),
    token_url: account.token_url || provider.token_url,
    client_id: account.client_id || provider.client_id,
    refresh_skew_ms: account.refresh_skew_ms ?? provider.refresh_skew_ms,
    api_key: false,
  }));
  for (const entry of config.api_keys || []) accounts.push({ id: entry.id, api_key: true, api_key_env: entry.env, systemone_models: entry.systemone_models || [], chat_models: [] });
  if (accounts.length > MAX_ACCOUNTS) throw new Error(`opencode_pool supports at most ${MAX_ACCOUNTS} total accounts`);
  const oauthFiles = new Set();
  for (const account of accounts.filter((entry) => !entry.api_key)) {
    const file = (account.credential_file_env && env[account.credential_file_env]) || account.credential_file;
    if (!file) continue;
    const canonical = canonicalCredentialFile(file);
    if (oauthFiles.has(canonical)) throw new Error("OpenCode pool OAuth accounts must reference distinct credential files");
    oauthFiles.add(canonical);
  }
  const state = new Map(accounts.map((account) => [account.id, { until: 0, failures: 0, generation: 0 }]));
  const affinity = new Map();
  const services = new Map();

  const fileFor = (account) => (account.credential_file_env && env[account.credential_file_env]) || account.credential_file || (account.credential_file_env === "OPENCODE_ZEN_CREDENTIAL_FILE" ? env.OPENCODE_ZEN_CREDENTIAL_FILE : null);
  const eligible = (account, endpoint, model) => {
    if (account.api_key) return endpoint === "systemone" && account.systemone_models.includes(model) && Boolean(env[account.api_key_env]);
    const allowed = endpoint === "chat" ? account.chat_models : account.systemone_models;
    if (!allowed?.includes(model)) return false;
    const credential = readCredential(fileFor(account));
    return Boolean(credential?.access);
  };
  const servicesFor = (account) => {
    if (!services.has(account.id)) {
      const credentialFile = fileFor(account);
      const options = { ...provider, ...account, credential_file: credentialFile, credential_file_env: null };
      services.set(account.id, {
        tokens: getTokenProvider({
          ...provider,
          ...account,
          credential_file: credentialFile,
          credential_file_env: null,
        }, env),
        get sessions() {
          if (account.api_key) return null;
          if (!this.sessionPool) this.sessionPool = createSessions({
            ...options,
            command: account.serve_command || provider.serve_command || env.OPENCODE_ZEN_SERVE_COMMAND || "opencode",
            port: Number(account.serve_port || provider.serve_port || env.OPENCODE_ZEN_SERVE_PORT || 4096),
            log: () => {},
          });
          return this.sessionPool;
        },
      });
    }
    return services.get(account.id);
  };
  function pruneAffinity() {
    const at = now();
    for (const [key, value] of affinity) if (!value || value.until <= at) affinity.delete(key);
    while (affinity.size > MAX_STICKY) affinity.delete(affinity.keys().next().value);
  }
  function select(endpoint, model, stickyKey, { exclude = [], includeCooling = false } = {}) {
    const at = now();
    pruneAffinity();
    const candidates = accounts.filter((account) => !exclude.includes(account.id) && eligible(account, endpoint, model) && (includeCooling || state.get(account.id).until <= at));
    if (!candidates.length) return null;
    const sticky = affinity.get(stickyKey);
    const preferred = sticky && sticky.until > at ? candidates.find((account) => account.id === sticky.accountId) : null;
    return preferred || candidates[0];
  }
  function markSuccess(account, stickyKey, generation = state.get(account?.id)?.generation) {
    if (!account) return;
    const current = state.get(account.id);
    if (current.generation !== generation) return;
    current.until = 0;
    current.failures = 0;
    pruneAffinity();
    affinity.delete(stickyKey);
    affinity.set(stickyKey, { accountId: account.id, until: now() + 60 * 60 * 1000 });
    while (affinity.size > MAX_STICKY) affinity.delete(affinity.keys().next().value);
  }
  function markFailure(account, error, { retryAfterMs } = {}) {
    if (!account) return;
    const entry = state.get(account.id);
    entry.failures += 1;
    entry.generation += 1;
    const retry = Number(retryAfterMs);
    const delay = Number.isFinite(retry) ? Math.max(1000, Math.min(retry, MAX_COOLDOWN_MS)) : Math.min(30000 * 2 ** Math.min(entry.failures - 1, 6), MAX_COOLDOWN_MS);
    entry.until = Math.max(entry.until, now() + delay);
  }
  function markSessionFailure(account, stickyKey) {
    if (account && stickyKey) affinity.delete(stickyKey);
  }
  async function authorizationFor(account) {
    if (account?.api_key) return env[account.api_key_env] || null;
    const authorization = await servicesFor(account).tokens.authorization();
    return String(authorization || "").replace(/^Bearer\s+/i, "") || null;
  }
  return {
    accounts,
    maxAttempts: Math.max(1, Math.min(Number(config.max_attempts || maxAttempts), 16)),
    select,
    markSuccess,
    markFailure,
    markSessionFailure,
    servicesFor,
    authorizationFor,
    eligibleAccounts(endpoint, model) { return accounts.filter((a) => eligible(a, endpoint, model)).map((a) => a.id); },
    state,
    affinity,
  };
}
