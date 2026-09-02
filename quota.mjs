// quota.mjs — per-provider quota / account-balance probes for the dashboard.
//
// The gateway routes requests to many independent providers, each of which has
// its own billing/quota model (subscriptions, credit balances, monthly caps).
// This module knows how to ask each provider for how much of its quota has
// already been consumed and normalises every answer into a single shape:
//
//   {
//     provider: string,        // provider id
//     account: string,         // human label for the account whose quota is shown
//     available: boolean,      // false when the provider can't report quota
//     source: "api"|"unavailable",
//     used?: number,           // consumed amount in `unit`
//     limit?: number | null,   // total quota in `unit` when finite; null when not numeric
//     limitKind?: string,      // "finite" | "unmetered" | "unknown" | "external" | "balance"
//     limitLabel?: string,     // UI-safe display for non-finite limits
//     unit: string,            // "USD" | "credits" | "tokens" | "requests" | "unknown"
//     currency?: "USD",
//     percentUsed?: number,    // 0-100 when limit is finite and > 0
//     detail?: object,         // provider-specific extras, never secrets
//     updatedAt: string,       // ISO timestamp
//     error?: string,          // human-safe reason quota is unavailable
//   }
//
// Probes are fail-safe: no real credentials are ever echoed back. A provider
// that does not expose a balance/usage API, or whose call fails, reports
// `available: false` with a short reason rather than taking the dashboard down.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 64 * 1024;

function fetchJson({ method = "GET", protocol = "https:", hostname, port, path, headers = {}, timeout = 12000 }) {
  return new Promise((resolve, reject) => {
    const request = protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(
      { method, protocol, hostname, port, path, headers, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("provider response too large"));
          }
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
    req.end();
  });
}

function percentUsed(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const pct = (used / limit) * 100;
  // Round away from zero to a sensible precision so 12.3456% -> 12.35
  return Math.round(pct * 100) / 100;
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

function ok(provider, fields, detail = {}) {
  const unit = fields.unit || "unknown";
  const used = fields.used;
  const limit = fields.limit;
  const normalizedLimit = limit == null ? null : limit === Infinity ? null : Number(limit);
  return {
    provider,
    account: fields.account || provider,
    available: true,
    source: "api",
    used: used == null ? null : Number(used),
    limit: normalizedLimit,
    limitKind: limitKindFor(fields, normalizedLimit),
    ...(fields.limitLabel ? { limitLabel: fields.limitLabel } : {}),
    unit,
    ...(fields.currency ? { currency: fields.currency } : {}),
    percentUsed: percentUsed(used, limit),
    detail,
    updatedAt: new Date().toISOString(),
  };
}


function informational(provider, account, note, detail = {}) {
  return ok(provider, {
    account,
    used: null,
    limit: null,
    limitKind: "external",
    limitLabel: "metered upstream",
    unit: "unknown",
  }, { reachable: true, note, ...detail });
}

function baseUrlParts(baseUrl) {
  const url = new URL(baseUrl);
  return { protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined, pathname: url.pathname.replace(/\/+$/, "") };
}

// ---------------------------------------------------------------------------
// OpenRouter — https://openrouter.ai/api/v1
// Gets the API key's current usage and limit (USD). `limit` is the configured
// spend cap; `is_free_tier` keys report ``limit: 0`` (unmetered).
// ---------------------------------------------------------------------------
export async function probeOpenRouter(apiKey, baseUrl = "https://openrouter.ai/api/v1") {
  if (!apiKey) return unavailable("openrouter", "OpenRouter", "no API key configured");
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    const data = await fetchJson({
      protocol, hostname, port,
      path: `${pathname}/key`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const info = data?.body?.data || data?.data || {};
    const usage = Number(info.usage) || 0;
    const limitRaw = Number(info.limit) || 0;
    const limit = limitRaw > 0 ? limitRaw : null; // limit 0 => free-tier / unmetered
    const credits = info.credits ?? info.balance;
    const detail = { is_free_tier: Boolean(info.is_free_tier) };
    if (Number.isFinite(credits)) detail.credits_remaining = Number(credits);
    return ok("openrouter", {
      account: "API key",
      used: usage,
      limit,
      limitKind: limit == null ? "unmetered" : "finite",
      limitLabel: limit == null ? "unmetered" : undefined,
      unit: "USD",
      currency: "USD",
    }, detail);
  } catch (error) {
    return unavailable("openrouter", "OpenRouter", error.message);
  }
}

// ---------------------------------------------------------------------------
// Mistral — https://api.mistral.ai/v1
// `GET /me` returns account identity but NOT remaining Vibe subscription budget,
// so we treat it as a connectivity check and label the limit as managed
// upstream unless a future Mistral usage endpoint is added. `available` is true
// so the dashboard can show the account is reachable even without a numeric cap.
// ---------------------------------------------------------------------------
export async function probeMistral(apiKey, baseUrl = "https://api.mistral.ai/v1") {
  if (!apiKey) return unavailable("mistral", "Mistral", "no API key configured");
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    // Mistral's public API does not expose subscription quota. /models is a
    // stable authenticated connectivity check; /me returns 404 on current API.
    await fetchJson({
      protocol, hostname, port,
      path: `${pathname}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return informational(
      "mistral",
      "Mistral account",
      "Mistral does not expose remaining Vibe/subscription budget via its public API",
    );
  } catch (error) {
    return unavailable("mistral", "Mistral", error.message);
  }
}

// ---------------------------------------------------------------------------
// OpenCode Go / Zen — https://opencode.ai
// Subscription quota lives under /zen/usage and /zen/v1/me (token/credit caps).
// Shapes vary; we cast defensively and degrade gracefully.
// ---------------------------------------------------------------------------
async function probeOpenCodeFamily(providerId, label, apiKey, baseUrl = "https://opencode.ai") {
  if (!apiKey) return unavailable(providerId, label, "no API key configured");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
  // Try usage first (best source), then identity. Combine failures safely.
  let usageData = null;
  try {
    const res = await fetchJson({ protocol, hostname, port, path: `${pathname}/zen/usage`, headers });
    usageData = res?.body ?? res?.data;
  } catch {
    usageData = null;
  }
  if (!usageData) {
    try {
      const res = await fetchJson({ protocol, hostname, port, path: `${pathname}/zen/v1/me`, headers });
      usageData = { me: res?.body };
    } catch {
      return informational(providerId, label, "OpenCode does not expose quota through the configured API endpoint");
    }
  }
  const u = usageData?.data ?? usageData?.usage ?? usageData?.me ?? usageData;
  const used = numberOrNull(u?.used_tokens ?? u?.tokens_used ?? u?.usage);
  const limit = numberOrNull(u?.quota ?? u?.token_limit ?? u?.limit ?? u?.resets?.limit);
  return ok(providerId, {
    account: (u?.email || u?.name || label),
    used,
    limit,
    unit: "unknown",
  }, { reachable: true, resets: u?.resets || u?.reset_at || null });
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function probeOpenCodeGo(apiKey, baseUrl = "https://opencode.ai") {
  return probeOpenCodeFamily("opencode-go", "OpenCode Go", apiKey, baseUrl);
}

export function probeOpenCodeZen(apiKey, baseUrl = "https://opencode.ai") {
  return probeOpenCodeFamily("opencode-zen", "OpenCode Zen", apiKey, baseUrl);
}

// ---------------------------------------------------------------------------
// MiniMax (routed through the Tokligence adapter) — account balance endpoints
// differ by deployment region; we probe the documented account endpoint but
// never fail the dashboard if the shape is unexpected.
// ---------------------------------------------------------------------------
export async function probeMiniMax(apiKey, baseUrl = "https://api.minimax.io/v1") {
  if (!apiKey) {
    return informational(
      "tokligence",
      "Embedded Tokligence gateway",
      "Inner gateway quota is managed by its configured upstream credentials; no MiniMax API key is configured for dashboard balance probing",
    );
  }
  try {
    const { protocol, hostname, port, pathname } = baseUrlParts(baseUrl);
    const data = await fetchJson({
      protocol, hostname, port,
      path: `${pathname}/account/balance`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = data?.body ?? data;
    const balance = payload?.data?.balance ?? payload?.balance;
    const walletCurrency = payload?.data?.currency ?? payload?.wallet_currency ?? "USD";
    const currency = ["USD", "EUR", "CNY", "GBP"].includes(walletCurrency) ? walletCurrency : "unknown";
    if (Number.isFinite(balance)) {
      return ok("tokligence", {
        account: "MiniMax account",
        used: null,
        limit: null,
        limitKind: "balance",
        limitLabel: "balance only",
        unit: currency === "unknown" ? "credits" : currency,
        ...(currency !== "unknown" ? { currency } : {}),
      }, { balance_remaining: balance, reachable: true });
    }
    return ok("tokligence", {
      account: "MiniMax account",
      used: null,
      limit: null,
      limitKind: "unknown",
      limitLabel: "metering unknown",
      unit: "unknown",
    }, { reachable: true });
  } catch (error) {
    return unavailable("tokligence", "MiniMax", error.message);
  }
}

// ---------------------------------------------------------------------------
// Modal adapter — Modal bills by active apps/GPU usage; there is no simple
// per-key balance API. Show that metering is external instead of unmetered.
// ---------------------------------------------------------------------------
export async function probeModal(apiKey, baseUrl = "https://api.us-west-2.modal.direct") {
  if (!apiKey) return unavailable("modal", "Modal", "no API key configured");
  return ok("modal", {
    account: "Modal (by usage)",
    used: null,
    limit: null,
    limitKind: "external",
    limitLabel: "metered by Modal",
    unit: "unknown",
  }, { reachable: true, note: "Modal bills per second of compute; no balance endpoint" });
}

// ---------------------------------------------------------------------------
// codex-oauth — credential pool; no per-account quota probe through the proxy.
// ---------------------------------------------------------------------------
export function probeCodexOauth() {
  return informational(
    "codex-oauth",
    "Codex OAuth credential pool",
    "Quota is managed by the embedded CLIProxy credential pool; no separate gateway quota endpoint",
  );
}

export function probeClineOauth() {
  return informational(
    "cline-oauth",
    "Cline OAuth account",
    "Cline free-model limits are enforced by Cline upstream per model/account; no aggregate quota endpoint",
  );
}

export function probeCopilotAuto() {
  return informational(
    "copilot-auto",
    "Copilot subscription",
    "GitHub Copilot subscription quota is managed upstream; no quota endpoint is exposed to the gateway",
  );
}

export function probeGoogleAiStudio() {
  return informational(
    "google-ai-studio",
    "Google AI Studio",
    "Google AI Studio usage is managed upstream; no quota probe is configured",
  );
}

export function probeNvidia() {
  return informational(
    "nvidia",
    "NVIDIA NIM",
    "NVIDIA NIM free-tier quota is managed upstream; no quota probe is configured",
  );
}

export function probeNous() {
  return informational(
    "nous",
    "Nous Research",
    "Nous free-tier quota is managed upstream; no quota probe is configured",
  );
}

// ---------------------------------------------------------------------------
// Dispatch: probe every enabled provider, in parallel, without aborting others.
// `providerCtx` maps a provider id to the probe arguments it needs.
// ---------------------------------------------------------------------------
export async function probeProviderQuota(provider, context = {}) {
  const id = provider?.id;
  switch (id) {
    case "openrouter":
      return probeOpenRouter(context.openrouterKey, context.openrouterBaseUrl);
    case "mistral":
      return probeMistral(context.mistralKey, context.mistralBaseUrl);
    case "opencode-go":
      return probeOpenCodeGo(context.opencodeKey, context.opencodeBaseUrl);
    case "opencode-zen":
      return probeOpenCodeZen(context.opencodeKey, context.opencodeBaseUrl);
    case "tokligence":
      return probeMiniMax(context.minimaxKey, context.minimaxBaseUrl);
    case "modal":
      return probeModal(context.modalKey, context.modalBaseUrl);
    case "codex-oauth":
      return probeCodexOauth(provider);
    case "cline-oauth":
      return probeClineOauth(provider);
    case "copilot-auto":
      return probeCopilotAuto(provider);
    case "google-ai-studio":
      return probeGoogleAiStudio(provider);
    case "nvidia":
      return probeNvidia(provider);
    case "nous":
      return probeNous(provider);
    default:
      return informational(id, id, "No quota probe is configured for this provider");
  }
}

export async function probeAllProviderQuota(enabledProviders, context) {
  const entries = await Promise.allSettled(
    enabledProviders.map((provider) => probeProviderQuota(provider, context)),
  );
  return entries.map((entry, index) =>
    entry.status === "fulfilled"
      ? entry.value
      : unavailable(enabledProviders[index].id, enabledProviders[index].id, entry.reason?.message || "quota probe failed"),
  );
}
