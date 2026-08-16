// quota-tracker.mjs
// Dynamische Quota-Abrage für Provider mit Subscription-Modellen
// Kosten = f(verbleibende Quota) → Je weniger Quota, desto höher der Kostenwert

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = process.env.CACHE_DIR || "/tmp/tokligence-cache";
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten Cache

// Provider-spezifische Quota-Abrage-Funktionen
const QUOTA_FETCHERS = {
  mistral: fetchMistralQuota,
  codex: fetchCodexQuota,
  copilot: fetchCopilotQuota,
  supergrok: fetchSuperGrokQuota,
};

/**
 * Lade Quota-Informationen aus dem Cache oder hole sie frisch
 */
async function getQuotaWithCache(providerId, apiKey) {
  const cachePath = path.join(CACHE_DIR, `${providerId}-quota.json`);
  
  try {
    // Cache prüfen
    const cached = await readCache(cachePath, CACHE_TTL);
    if (cached) return cached;
    
    // Frisch holen
    const fetcher = QUOTA_FETCHERS[providerId];
    if (!fetcher) {
      // Standard für Free-Tier Provider
      return { remaining: 1.0, total: Infinity, used: 0, reset_at: null };
    }
    
    const quota = await fetcher(apiKey);
    await writeFile(cachePath, JSON.stringify(quota));
    return quota;
  } catch (error) {
    console.warn(`[quota-tracker] Failed to fetch quota for ${providerId}:`, error.message);
    // Fallback: Annahme 100% Quota
    return { remaining: 1.0, total: Infinity, used: 0, reset_at: null };
  }
}

/**
 * Berechne dynamischen Kostenwert basierend auf verbleibender Quota
 * Formel: cost = (1 - quota_remaining) * 100
 * → 100% Quota = cost 0 (bevorzugt)
 * → 0% Quota = cost 100 (vermeiden)
 */
function calculateDynamicCost(quotaInfo) {
  if (!quotaInfo) {
    return { cost: 0, quota_remaining: 1, used: 0, total: Infinity, reset_at: null };
  }
  
  const remainingRatio = quotaInfo.remaining !== undefined 
    ? quotaInfo.remaining 
    : (quotaInfo.total - quotaInfo.used) / quotaInfo.total;
  
  // Kostenwert: 0 (voll) bis 100 (leer)
  const cost = (1 - remainingRatio) * 100;
  
  return {
    cost,
    quota_remaining: remainingRatio,
    used: quotaInfo.used,
    total: quotaInfo.total,
    reset_at: quotaInfo.reset_at,
  };
}

/**
 * Hole Quota-Info für einen Provider
 */
export async function getProviderQuota(providerId, apiKey) {
  const quotaInfo = await getQuotaWithCache(providerId, apiKey);
  return calculateDynamicCost(quotaInfo);
}

// --- Provider-spezifische Implementierungen ---

/**
 * Mistral API Quota abfragen
 * Dokumentation: https://docs.mistral.ai/api/#operation/get_api_usage
 */
async function fetchMistralQuota(apiKey) {
  const url = "https://api.mistral.ai/v1/usage";
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`Mistral API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Mistral gibt Usage pro Modell zurück
  // Wir nehmen das erste Modell als Referenz
  const firstModelUsage = data.data?.[0];
  if (!firstModelUsage) {
    return { remaining: 1.0, total: Infinity, used: 0, reset_at: null };
  }
  
  const used = firstModelUsage.usage || 0;
  const total = firstModelUsage.quota || Infinity;
  const resetAt = firstModelUsage.reset_at || null;
  
  return {
    remaining: Math.max(0, 1 - (used / total)),
    total,
    used,
    reset_at: resetAt,
  };
}

/**
 * Codex (OpenAI) Quota abfragen
 * Dokumentation: https://platform.openai.com/docs/api-reference/usage
 */
async function fetchCodexQuota(apiKey) {
  const url = "https://api.openai.com/v1/usage";
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // OpenAI gibt Usage pro Modell zurück
  // Wir aggregieren alle Modelle
  const totalUsage = data.data?.reduce((sum, entry) => {
    return sum + (entry.usage?.total_tokens || 0);
  }, 0) || 0;
  
  // OpenAI hat keine feste Quota pro Monat, aber wir können die Credits schätzen
  // Annahme: 1 Credit = 1 Token (vereinfacht)
  // Für Hermes: Wir nehmen an, dass die Quota durch die Subscription definiert ist
  // Da wir keine direkte Quota-Abfrage haben, nutzen wir einen Schätzwert
  // oder setzen auf 100% (da wir keine genaue Info haben)
  
  // TODO: Hier könnte man die Credits aus der Subscription abfragen
  // Für jetzt: Annahme 100% Quota
  return {
    remaining: 1.0,
    total: Infinity,
    used: totalUsage,
    reset_at: null,
  };
}

/**
 * GitHub Copilot Quota abfragen
 * Dokumentation: https://docs.github.com/en/rest/copilot/copilot-usage?apiVersion=2022-11-28
 */
async function fetchCopilotQuota(apiKey) {
  // Copilot nutzt GitHub API mit Token
  const url = "https://api.github.com/user/copilot_usage";
  const response = await fetch(url, {
    headers: { 
      "Authorization": `Bearer ${apiKey}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // GitHub gibt Usage in "credits_used" und "credits_total" zurück
  const used = data.credits_used || 0;
  const total = data.credits_total || 0;
  const resetAt = data.reset_at || null;
  
  return {
    remaining: Math.max(0, 1 - (used / total)),
    total,
    used,
    reset_at: resetAt,
  };
}

/**
 * SuperGrok (xAI) Quota abfragen
 * Dokumentation: https://docs.x.ai/grok/usage
 */
async function fetchSuperGrokQuota(apiKey) {
  const url = "https://api.x.ai/v1/usage";
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`xAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // xAI gibt Usage in "total_tokens" und "limit" zurück
  const used = data.total_tokens || 0;
  const total = data.limit || Infinity;
  const resetAt = data.reset_at || null;
  
  return {
    remaining: Math.max(0, 1 - (used / total)),
    total,
    used,
    reset_at: resetAt,
  };
}

// --- Cache-Helper ---

async function readCache(filePath, ttl) {
  try {
    const stats = await statFile(filePath);
    if (!stats) return null;
    
    const now = Date.now();
    if (now - stats.mtimeMs < ttl) {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content);
    }
  } catch {
    return null;
  }
  return null;
}

async function statFile(filePath) {
  try {
    const { stat } = await import("node:fs/promises");
    return await stat(filePath);
  } catch {
    return null;
  }
}

// Cache-Verzeichnis sicherstellen
try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(CACHE_DIR, { recursive: true }));
} catch {
  // Ignorieren
}

export { getQuotaWithCache, calculateDynamicCost, QUOTA_FETCHERS };
