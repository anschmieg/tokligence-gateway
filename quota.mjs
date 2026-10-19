// quota.mjs — per-provider quota / account-balance probes for the dashboard.
//
// Probes are fail-safe and never echo credentials. When a provider has no
// authoritative quota API, the dashboard reports that honestly instead of
// inventing limits.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { probeMistralSubscription } from "./mistral-subscription-quota.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;

function fetchJson({ method = "GET", protocol = "https:", hostname, port, path, headers = {}, timeout = 12000, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(
      { method, protocol, hostname, port, path, headers, timeout, signal },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("provider response too large"));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            reject(new Error("invalid JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function percentUsed(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.round((used / limit) * 10000) / 100;
}

function unavailable(provider, account, reason, detail = {}) {
  return {
    provider,
    account,
    available: false,
    source: "unavailable",
    unit: "unknown",
    detail,
    updatedAt: new Date().toISOString(),
    error: reason,
  };
}

function limitKindFor(fields, limit) {
  if (fields.limitKind) return fields.limitKind;
  if (Number.isFinite(limit) && limit > 0) return "finite";
  return "unknown";
}

function attachObserved(detail, observedUsage) {
  if (!observedUsage) return detail;
  return { ...detail, observed_usage: observedUsage };
}

function ok(provider, fields, detail = {}) {
  const unit = fields.unit || "unknown";
  const used = fields.used == null ? null : Number(fields.used);
  const limit = fields.limit;
  const normalizedLimit = limit == null ? null : limit === Infinity ? null : Number(limit);
  return {
    provider,
    account: fields.account || provider,
    available: true,
    source: fields.source || "api",
    used,
    limit: normalizedLimit,
    limitKind: limitKindFor(fields, normalizedLimit),
    ...(fields.limitLabel ? { limitLabel: fields.limitLabel } : {}),
    unit,
    ...(fields.currency ? { currency: fields.currency } : {}),
    percentUsed: percentUsed(used, normalizedLimit),
    detail,
    updatedAt: new Date().toISOString(),
  };
}

function noQuotaSource(provider, account, note, detail = {}) {
  return {
    provider,
    account,
    available: false,
    source: "unreported",
    used: null,
    limit: null,
    limitKind: "unreported",
    limitLabel: "not reported",
    unit: "unknown",
    detail: { note, ...detail },
    updatedAt: new Date().toISOString(),
  };
}

function baseUrlParts(baseUrl) {
  const url = new URL(baseUrl);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    pathname: url.pathname.replace(/\/+$/, ""),
  };
}

function monthYear(now = new Date()) {
  return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
}

// OpenRouter — authoritative key usage and limit.
export async function probeOpenRouter(apiKey, baseUrl = "https://openrouter.ai/api/v1", options = {}) {
  if (!apiKey) return unavailable("openrouter", "OpenRouter", "no API key configured");
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    const data = await fetchJson({
      protocol, hostname, port,
      path: `${pathname}/key`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const info = data?.body?.data || data?.body || {};
    const usage = firstNumber(info.usage, info.used) ?? 0;
    const limitRaw = firstNumber(info.limit, info.usage_limit);
    const limit = limitRaw && limitRaw > 0 ? limitRaw : null;
    const limitRemaining = firstNumber(info.limit_remaining, info.remaining, info.remaining_credits);
    const credits = firstNumber(info.credits, info.balance);
    const detail = { is_free_tier: Boolean(info.is_free_tier) };
    if (limitRemaining != null) detail.limit_remaining = limitRemaining;
    if (credits != null) detail.credits_remaining = credits;
    return ok("openrouter", {
      account: "API key",
      used: usage,
      limit,
      limitKind: limit == null ? "unmetered" : "finite",
      limitLabel: limit == null ? "unmetered" : undefined,
      unit: "USD",
      currency: "USD",
    }, attachObserved(detail, options.observedUsage));
  } catch (error) {
    return unavailable("openrouter", "OpenRouter", error.message, attachObserved({}, options.observedUsage));
  }
}

// Mistral — authoritative usage requires a separate Admin API key.
export async function probeMistral(apiKey, baseUrl = "https://api.mistral.ai/v1", options = {}) {
  const observed = options.observedUsage;
  const subscriptionProbe = options.mistralSubscriptionProbe || probeMistralSubscription;
  const subscription = await subscriptionProbe({ file: options.mistralSessionFile });
  const attachSubscription = (result) => {
    result.detail ||= {};
    result.detail.quota_signals = [...(result.detail.quota_signals || []), subscription];
    return result;
  };
  const adminApiKey = options.adminApiKey;
  if (adminApiKey) {
    try {
      const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
      const adminBase = pathname.endsWith("/admin") ? pathname : `${pathname}/admin`;
      const { month, year } = monthYear(options.now || new Date());
      const headers = { "x-api-key": adminApiKey };
      const [usageRes, spendRes, rateRes] = await Promise.all([
        fetchJson({ protocol, hostname, port, path: adminBase + "/usage?month=" + month + "&year=" + year, headers }),
        fetchJson({ protocol, hostname, port, path: adminBase + "/spend-limit", headers }),
        fetchJson({ protocol, hostname, port, path: adminBase + "/rate-limit", headers }).catch(() => null),
      ]);
      const usage = usageRes.body?.data ?? usageRes.body;
      const spend = spendRes.body?.data ?? spendRes.body;
      const limits = spend?.limits ?? spend;
      const used = firstNumber(usage?.total, usage?.amount, usage?.used, usage?.usage, usage?.total_cost);
      const limit = firstNumber(limits?.limit, limits?.amount, limits?.monthly_limit, limits?.value);
      const rateLimits = rateRes?.body?.data ?? rateRes?.body ?? null;
      const currency = usage?.currency || spend?.currency || limits?.currency || "USD";
      return attachSubscription(ok("mistral", {
        account: "Mistral account",
        used,
        limit,
        limitKind: limit == null ? "unknown" : "finite",
        limitLabel: limit == null ? "spend limit unknown" : undefined,
        unit: currency,
        ...(currency === "USD" ? { currency: "USD" } : {}),
      }, attachObserved({ month, year, rate_limits: rateLimits, observed_rate_limits: options.mistralObservedRateLimits || null }, observed)));
    } catch (error) {
      return attachSubscription(unavailable("mistral", "Mistral Admin API", error.message, attachObserved({ admin_api: true }, observed)));
    }
  }

  if (!apiKey) return attachSubscription(unavailable("mistral", "Mistral", "no API key configured", attachObserved({}, observed)));
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    await fetchJson({
      protocol, hostname, port,
      path: `${pathname}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return attachSubscription(noQuotaSource(
      "mistral",
      "Mistral account",
      "Mistral monthly usage is Admin API/console data; X-RateLimit-Remaining is observed only after an inference response",
      attachObserved({ reachable: true, admin_api_required: true, observed_rate_limits: options.mistralObservedRateLimits || null }, observed),
    ));
  } catch (error) {
    return attachSubscription(unavailable("mistral", "Mistral", error.message, attachObserved({}, observed)));
  }
}

// OpenCode Go / Zen — no documented usage API. Go has documented hard caps.
async function probeOpenCodeFamily(providerId, label, apiKey, baseUrl = "https://opencode.ai", options = {}) {
  if (!apiKey) return unavailable(providerId, label, "no API key configured", attachObserved({}, options.observedUsage));
  const limits = providerId === "opencode-go"
    ? { five_hour_usd: 12, weekly_usd: 30, monthly_usd: 60 }
    : undefined;
  return noQuotaSource(
    providerId,
    label,
    providerId === "opencode-go"
      ? "OpenCode Go usage is console-only; documented caps are static and gateway-observed spend is tracked separately"
      : "OpenCode Zen balance/usage is console-only; gateway-observed spend is tracked separately",
    attachObserved({ ...(limits ? { documented_limits: limits } : {}) }, options.observedUsage),
  );
}

export function probeOpenCodeGo(apiKey, baseUrl = "https://opencode.ai", options = {}) {
  return probeOpenCodeFamily("opencode-go", "OpenCode Go", apiKey, baseUrl, options);
}

export function probeOpenCodeZen(apiKey, baseUrl = "https://opencode.ai", options = {}) {
  return probeOpenCodeFamily("opencode-zen", "OpenCode Zen", apiKey, baseUrl, options);
}

// MiniMax — Token Plan remains is the authoritative subscription signal.
export async function probeMiniMax(apiKey, baseUrl = "https://www.minimax.io", options = {}) {
  const observed = options.observedUsage;
  if (!apiKey) {
    return noQuotaSource(
      "tokligence",
      "Embedded Tokligence gateway",
      "Inner gateway quota is managed by its configured upstream credentials; no MiniMax key is configured for dashboard token-plan probing",
      attachObserved({}, observed),
    );
  }
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    const base = pathname === "/v1" ? pathname : `${pathname}/v1`;
    const data = await fetchJson({
      protocol, hostname, port,
      path: `${base}/token_plan/remains`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = data?.body?.data ?? data?.body ?? {};
    const remaining = firstNumber(
      payload.remaining_tokens,
      payload.remaining,
      payload.remains,
      payload.current_interval_usage_count,
    );
    const total = firstNumber(payload.total, payload.limit, payload.token_limit, payload.current_interval_total_count);
    if (remaining != null || total != null) {
      return ok("tokligence", {
        account: "MiniMax Token Plan",
        used: null,
        limit: total,
        limitKind: "balance",
        limitLabel: "remaining tokens",
        unit: "tokens",
      }, attachObserved({
        remaining_tokens: remaining,
        interval: payload.interval || payload.current_interval || null,
      }, observed));
    }
    return ok("tokligence", {
      account: "MiniMax Token Plan",
      used: null,
      limit: null,
      limitKind: "unknown",
      limitLabel: "metering unknown",
      unit: "tokens",
    }, attachObserved({ reachable: true }, observed));
  } catch (error) {
    return unavailable("tokligence", "MiniMax", error.message, attachObserved({}, observed));
  }
}

export async function probeModal(apiKey, baseUrl = "https://api.us-west-2.modal.direct", options = {}) {
  if (!apiKey) return unavailable("modal", "Modal", "no API key configured", attachObserved({}, options.observedUsage));
  return noQuotaSource(
    "modal",
    "Modal (external billing)",
    "Modal bills at the account/app level; gateway-observed usage is tracked separately",
    attachObserved({}, options.observedUsage),
  );
}

export async function probeCodexOauth(provider, context = {}) {
  const key = context.codexManagementKey;
  if (key) {
    try {
      const url = new URL(context.codexManagementBaseUrl || "http://127.0.0.1:8317");
      if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("management requires literal loopback HTTP");
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 15000);
      deadline.unref?.();
      const call = (path, body) => fetchJson({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port,
        path: `/v0/management/${path}`, method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        timeout: 10000,
        signal: controller.signal,
      });
      try {
        const listing = await call("auth-files");
        const files = listing.body?.files;
        if (!Array.isArray(files)) throw new Error("invalid credential listing");
        const selected = files.filter(f => (f.provider || f.type) === "codex" && !f.disabled && f.auth_index);
        const accounts = new Array(Math.min(selected.length, 32));
        let cursor = 0;
        const worker = async () => {
          while (!controller.signal.aborted) {
            const index = cursor++;
            if (index >= accounts.length) return;
            const file = selected[index];
            try {
              const header = { Authorization: "Bearer $TOKEN$", Accept: "application/json" };
              const accountId = file.id_token?.chatgpt_account_id;
              if (typeof accountId === "string") header["Chatgpt-Account-Id"] = accountId;
              const reply = await call("api-call", { auth_index: file.auth_index, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage", header });
              if (reply.body?.status_code !== 200) throw new Error("quota request failed");
              const data = JSON.parse(reply.body.body);
              const windows = [];
              for (const name of ["primary_window", "secondary_window"]) {
                const w = data.rate_limit?.[name];
                if (typeof w?.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100) continue;
                const reset = numberOrNull(w.reset_at);
                const resetAt = reset != null && reset > 0 && reset <= 8.64e12 ? reset : null;
                const duration = numberOrNull(w.limit_window_seconds);
                const limitWindowSeconds = duration != null && duration > 0 && duration <= 31_536_000 ? duration : null;
                windows.push({ name, used_percent: w.used_percent, reset_at: resetAt, limit_window_seconds: limitWindowSeconds });
              }
              accounts[index] = { label: `Codex account ${index + 1}`, windows, available: windows.length > 0 };
            } catch { accounts[index] = { label: `Codex account ${index + 1}`, available: false, windows: [] }; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
        for (let index = 0; index < accounts.length; index++) accounts[index] ||= { label: `Codex account ${index + 1}`, available: false, windows: [] };
        const values = accounts.flatMap(a => a.windows.map(w => w.used_percent));
        const details = { accounts, totalAccounts: selected.length, truncated: selected.length > accounts.length, incomplete: accounts.some(a => !a.available) || selected.length > accounts.length };
        if (!values.length) return unavailable("codex-oauth", "Codex OAuth credential pool", "No Codex quota windows are currently available", attachObserved(details, context.observedUsage));
      // No pooled percentage: windows belong to separate credentials with different limits.
        return ok("codex-oauth", { account: "Codex OAuth credential pool", used: null, limit: null, unit: "percent", limitLabel: "per-account windows" }, attachObserved({ accounts, totalAccounts: selected.length, truncated: selected.length > accounts.length, incomplete: accounts.some(a => !a.available) || selected.length > accounts.length }, context.observedUsage));
      } finally { clearTimeout(deadline); controller.abort(); }
    } catch {
      return unavailable("codex-oauth", "Codex OAuth credential pool", "Codex quota unavailable; check local management configuration or credential status", attachObserved({}, context.observedUsage));
    }
  }
  return noQuotaSource(
    "codex-oauth",
    "Codex OAuth credential pool",
    "Quota is managed by the embedded CLIProxy credential pool; gateway-observed usage is tracked separately",
    attachObserved({}, context.observedUsage),
  );
}

export async function probeClineOauth(provider, context = {}) {
  const observed = context.observedUsage;
  const adapter = context.clineOAuth;
  if (!adapter?.accountUsage) {
    return noQuotaSource(
      "cline-oauth",
      "Cline OAuth account",
      "Cline account balance needs an authenticated OAuth adapter; free-model daily limits are still enforced per model upstream",
      attachObserved({}, observed),
    );
  }
  try {
    const data = await adapter.accountUsage();
    const user = data.user || {};
    const balance = data.balance || {};
    const transactions = Array.isArray(data.usageTransactions) ? data.usageTransactions : [];
    const balanceCents = firstNumber(balance.balance, balance.currentBalance, balance.current_balance_cents);
    return ok("cline-oauth", {
      account: user.email || user.name || user.id || "Cline OAuth account",
      used: null,
      limit: null,
      limitKind: "balance",
      limitLabel: "balance only",
      unit: "credits",
    }, attachObserved({
      user_id: user.id || user.uid || null,
      balance_remaining_cents: balanceCents,
      transaction_count: transactions.length,
    }, observed));
  } catch (error) {
    return unavailable("cline-oauth", "Cline OAuth account", error.message, attachObserved({}, observed));
  }
}

export function probeCopilotAuto(provider, context = {}) {
  return noQuotaSource(
    "copilot-auto",
    "Copilot subscription",
    "Copilot Individual has no supported real-time quota API; gateway-observed usage and exhaustion errors are tracked separately",
    attachObserved({}, context.observedUsage),
  );
}

export function probeGoogleAiStudio(provider, context = {}) {
  return noQuotaSource(
    "google-ai-studio",
    "Google AI Studio",
    "Google AI Studio API-key quota is managed upstream; authoritative project metrics need Google Cloud auth, gateway-observed usage is tracked separately",
    attachObserved({}, context.observedUsage),
  );
}

export function probeNvidia(provider, context = {}) {
  return noQuotaSource(
    "nvidia",
    "NVIDIA NIM",
    "NVIDIA NIM trial/free-tier quota is managed upstream; gateway-observed usage and 429s are tracked separately",
    attachObserved({}, context.observedUsage),
  );
}

export function probeNous(provider, context = {}) {
  return noQuotaSource(
    "nous",
    "Nous Research",
    "Nous portal usage has no public balance API; gateway-observed usage is tracked separately",
    attachObserved({}, context.observedUsage),
  );
}

function observedFor(context, id) {
  return context.observedUsageByProvider?.[id] || context.observedUsage?.[id] || null;
}

export async function probeProviderQuota(provider, context = {}) {
  const id = provider?.id;
  const withObserved = { ...context, observedUsage: observedFor(context, id) };
  switch (id) {
    case "openrouter":
      return probeOpenRouter(context.openrouterKey, context.openrouterBaseUrl, withObserved);
    case "mistral":
      return probeMistral(context.mistralKey, context.mistralBaseUrl, {
        ...withObserved,
        adminApiKey: context.mistralAdminApiKey,
        mistralSessionFile: context.mistralSessionFile,
        mistralObservedRateLimits: context.mistralObservedRateLimits,
      });
    case "opencode-go":
      return probeOpenCodeGo(context.opencodeKey, context.opencodeBaseUrl, withObserved);
    case "opencode-zen":
      return probeOpenCodeZen(context.opencodeKey, context.opencodeBaseUrl, withObserved);
    case "tokligence":
      return probeMiniMax(context.minimaxKey, context.minimaxBaseUrl, withObserved);
    case "modal":
      return probeModal(context.modalKey, context.modalBaseUrl, withObserved);
    case "codex-oauth":
      return probeCodexOauth(provider, withObserved);
    case "cline-oauth":
      return probeClineOauth(provider, { ...withObserved, clineOAuth: context.clineOAuth });
    case "copilot-auto":
      return probeCopilotAuto(provider, withObserved);
    case "google-ai-studio":
      return probeGoogleAiStudio(provider, withObserved);
    case "nvidia":
      return probeNvidia(provider, withObserved);
    case "nous":
      return probeNous(provider, withObserved);
    default:
      return noQuotaSource(id, id, "No quota probe is configured for this provider", attachObserved({}, withObserved.observedUsage));
  }
}

export async function probeAllProviderQuota(enabledProviders, context) {
  const entries = await Promise.allSettled(
    enabledProviders.map(async (provider) => {
      const load = () => probeProviderQuota(provider, context);
      const result = context?.quotaCache && ["mistral", "codex-oauth"].includes(provider.id)
        ? await context.quotaCache.get(provider.id, load)
        : await load();
      if (result.detail && context?.observedUsageByProvider?.[provider.id]) {
        result.detail.observed_usage = context.observedUsageByProvider[provider.id];
      }
      if (result.provider === "mistral" && result.detail && context?.mistralObservedRateLimits) {
        result.detail.observed_rate_limits = { ...context.mistralObservedRateLimits };
      }
      return result;
    }),
  );
  return entries.map((entry, index) =>
    entry.status === "fulfilled"
      ? entry.value
      : unavailable(enabledProviders[index].id, enabledProviders[index].id, entry.reason?.message || "quota probe failed"),
  );
}
