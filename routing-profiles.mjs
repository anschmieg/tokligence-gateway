// routing-profiles.mjs
// Routing-Profile für verschiedene Aufgabentypen
// Jedes Profil definiert Provider + Modelle + Strategien

export const ROUTING_PROFILES = {
  // === PRIMARY (Hauptaufgaben: Coding, Reasoning, komplexe Tools)
  primary: {
    name: "Primary (High-Quality)",
    providers: [
      { id: "mistral", models: ["mistral-medium-3.5"], weight: 100, billing_class: "subscription" },
      { id: "nvidia", models: ["nemotron-3-ultra-550b-a55b", "nemotron-3-super-120b-a12b"], weight: 90, billing_class: "free" },
      { id: "google-ai-studio", models: ["gemini-3.1-pro-latest", "gemini-3-flash-latest"], weight: 80, billing_class: "subscription" },
      { id: "openrouter", models: ["deepseek/deepseek-v4-flash-0731"], weight: 70, billing_class: "payg" },
    ],
    fallback_strategy: "weighted_random",
    max_retries: 3,
    capabilities: ["coding", "reasoning", "tool_calling", "vision"],
  },

  // === AUXILIARY (Unterteilt nach Aufgabentyp)
  auxiliary: {
    // Compression (z.B. Session-Titel, Memory-Flush)
    compression: {
      name: "Auxiliary: Compression",
      providers: [
        { id: "nvidia", models: ["glm-5.2"], weight: 100, billing_class: "free" },
        { id: "nous", models: ["laguna-xs-2.1"], weight: 90, billing_class: "free" },
      ],
      fallback_strategy: "round_robin",
      max_retries: 2,
      capabilities: ["text"],
    },

    // Web-Extraction (z.B. Summaries, Screenshot-Analyse)
    web_extraction: {
      name: "Auxiliary: Web Extraction",
      providers: [
        { id: "nvidia", models: ["nemotron-3-super-120b-a12b"], weight: 100, billing_class: "free" },
        { id: "google-ai-studio", models: ["gemini-3-flash-latest"], weight: 90, billing_class: "subscription" },
      ],
      fallback_strategy: "round_robin",
      max_retries: 2,
      capabilities: ["text", "vision"],
    },

    // Vision (z.B. Bildanalyse)
    vision: {
      name: "Auxiliary: Vision",
      providers: [
        { id: "google-ai-studio", models: ["gemini-3.1-pro-latest"], weight: 100, billing_class: "subscription" },
        { id: "openrouter", models: ["google/gemini-3-pro-preview"], weight: 90, billing_class: "payg" },
      ],
      fallback_strategy: "round_robin",
      max_retries: 2,
      capabilities: ["vision"],
    },

    // Default (Fallback für alle Auxiliary)
    default: {
      name: "Auxiliary: Default",
      providers: [
        { id: "nvidia", models: ["*"], weight: 100, billing_class: "free" },
        { id: "nous", models: ["*"], weight: 90, billing_class: "free" },
      ],
      fallback_strategy: "random",
      max_retries: 1,
      capabilities: ["text"],
    },
  },

  // === CRON (Für Cron-Jobs: Quota-schonend, schnell, zuverlässig)
  cron: {
    name: "Cron (Quota-Safe)",
    providers: [
      { id: "nvidia", models: ["nemotron-3-super-120b-a12b", "glm-5.2"], weight: 100, billing_class: "free" },
      { id: "nous", models: ["laguna-xs-2.1"], weight: 90, billing_class: "free" },
      { id: "openrouter", models: ["deepseek/deepseek-v4-flash-0731"], weight: 80, billing_class: "payg" },
      { id: "google-ai-studio", models: ["gemini-3-flash-latest"], weight: 70, billing_class: "subscription" },
    ],
    fallback_strategy: "weighted_random",
    max_retries: 3,
    capabilities: ["text", "tool_calling"],
  },

  // === FALLBACK (Notfall: Wenn alles andere rate-limited)
  fallback: {
    name: "Fallback (Any)",
    providers: [
      { id: "nvidia", models: ["*"], weight: 100, billing_class: "free" },
      { id: "nous", models: ["*"], weight: 90, billing_class: "free" },
      { id: "openrouter", models: ["*"], weight: 80, billing_class: "payg" },
    ],
    fallback_strategy: "random",
    max_retries: 1,
    capabilities: ["text"],
  },
};

/**
 * Hole das passende Profil für eine Aufgabe
 */
export function getProfileForTask(taskType) {
  if (taskType?.startsWith("auxiliary:")) {
    const subType = taskType.split(":")[1];
    return ROUTING_PROFILES.auxiliary?.[subType] || ROUTING_PROFILES.auxiliary.default;
  }
  return ROUTING_PROFILES[taskType] || ROUTING_PROFILES.primary;
}
