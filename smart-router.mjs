// smart-router.mjs
// Quota-basiertes Smart-Routing für Tokligence Gateway
// Priorisiert Provider basierend auf:
// 1. Quota-Verfügbarkeit (dynamisch)
// 2. Kosten (Free > PAYG > Subscription)
// 3. Fähigkeiten (Tool-Calling, Vision, etc.)

import { getProviderQuota, calculateDynamicCost } from "./quota-tracker.mjs";
import { ROUTING_PROFILES } from "./routing-profiles.mjs";

// Provider-Klassifizierung
const PROVIDER_CLASSES = {
  free: { priority: 100, cost_multiplier: 0 },
  subscription: { priority: 50, cost_multiplier: 1 },
  payg: { priority: 25, cost_multiplier: 2 },
};

/**
 * Berechne den Routing-Score für einen Provider
 * Score = (Quota-Priority * 100) + (Klassen-Priority) - (Dynamische Kosten * 10)
 * Höherer Score = besser
 */
function calculateRoutingScore(providerInfo, quotaInfo) {
  const { cost, quota_remaining } = quotaInfo || { cost: 0, quota_remaining: 1.0 };
  const classInfo = PROVIDER_CLASSES[providerInfo.billing_class] || PROVIDER_CLASSES.free;
  
  // Quota-Priority: 100% = 100, 0% = 0
  const quotaPriority = quota_remaining * 100;
  
  // Klassen-Priority
  const classPriority = classInfo.priority;
  
  // Dynamische Kosten (0-100)
  const dynamicCost = cost;
  
  // Endscore: Je höher, desto besser
  const score = (quotaPriority * 1.5) + classPriority - (dynamicCost * 0.5);
  
  return {
    score,
    quotaPriority,
    classPriority,
    dynamicCost,
    quota_remaining,
  };
}

/**
 * Wähle den besten Provider für eine Anfrage
 */
export async function selectBestProvider(modelRequest, taskType = "primary", capabilities = []) {
  const profile = getProfileForTask(taskType);
  
  // 1. Filter Provider nach Fähigkeiten
  const capableProviders = profile.providers.filter(p =>
    p.models.some(m => modelSupportsCapabilities(m, capabilities))
  );
  
  if (capableProviders.length === 0) {
    // Fallback: Alle Provider
    capableProviders.push(...profile.providers);
  }
  
  // 2. Hole Quota-Infos für alle Provider
  const providersWithQuota = await Promise.all(
    capableProviders.map(async (provider) => {
      const apiKey = process.env[provider.api_key_env];
      const quotaInfo = apiKey 
        ? await getProviderQuota(provider.id, apiKey)
        : { cost: 0, quota_remaining: 1.0 };
      
      const score = calculateRoutingScore(provider, quotaInfo);
      
      return {
        ...provider,
        ...score,
        apiKey: apiKey ? "***" : null, // Maskiert
      };
    })
  );
  
  // 3. Sortiere nach Score (absteigend)
  providersWithQuota.sort((a, b) => b.score - a.score);
  
  // 4. Wähle den besten verfügbaren Provider
  for (const provider of providersWithQuota) {
    const availableModel = await findAvailableModel(provider, modelRequest);
    if (availableModel) {
      return {
        provider: provider.id,
        model: availableModel,
        score: provider.score,
        quota_remaining: provider.quota_remaining,
        cost_class: provider.billing_class,
      };
    }
  }
  
  // 5. Fallback: Erster Provider
  return {
    provider: profile.providers[0]?.id,
    model: modelRequest,
    score: -Infinity,
    quota_remaining: 0,
    cost_class: "fallback",
  };
}

/**
 * Finde ein verfügbares Modell für einen Provider
 */
async function findAvailableModel(provider, modelRequest) {
  // TODO: Hier könnte man die Modellverfügbarkeit prüfen
  // Für jetzt: Nimm das erste Modell des Providers oder das angefragte Modell
  if (provider.models.includes(modelRequest)) {
    return modelRequest;
  }
  return provider.models[0];
}

/**
 * Prüfe, ob ein Modell die benötigten Fähigkeiten hat
 */
function modelSupportsCapabilities(modelId, requiredCapabilities) {
  // TODO: Hier könnte man eine Fähigkeiten-Datenbank abfragen
  // Für jetzt: Annahme, dass alle Modelle alle Fähigkeiten unterstützen
  return true;
}

/**
 * Hole das passende Profil für eine Aufgabe
 */
function getProfileForTask(taskType) {
  if (taskType.startsWith("auxiliary:")) {
    const subType = taskType.split(":")[1];
    return ROUTING_PROFILES.auxiliary?.[subType] || ROUTING_PROFILES.auxiliary.default;
  }
  return ROUTING_PROFILES[taskType] || ROUTING_PROFILES.primary;
}

/**
 * Erzwinge einen Provider-Wechsel bei Quota-Erschöpfung
 */
export async function getFallbackProvider(excludedProviders = [], taskType = "primary") {
  const profile = getProfileForTask(taskType);
  
  const availableProviders = profile.providers.filter(
    p => !excludedProviders.includes(p.id)
  );
  
  if (availableProviders.length === 0) {
    return null;
  }
  
  // Wähle den besten verfügbaren Provider (ohne Quota-Prüfung)
  return availableProviders[0];
}

export { calculateRoutingScore, ROUTING_PROFILES };
