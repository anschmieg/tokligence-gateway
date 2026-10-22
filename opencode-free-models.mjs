// Runtime-only, provider-owned authorization shared by discovery and execution.
// Never infer free access from a model ID or from missing prices.
const snapshots = new WeakMap();
const MAX_AGE_MS = 15 * 60 * 1000;
const bareId = (id) => String(id || "").replace(/^(?:opencode-zen|zen)\//, "");
const zero = (value) => (typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) === 0;

export function freeOpenCodeModels(endpoint, metadata) {
  if (!Array.isArray(endpoint?.data) || !metadata?.opencode?.models || typeof metadata.opencode.models !== "object") throw new Error("Invalid OpenCode discovery catalog");
  return endpoint.data.flatMap((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    const model = metadata.opencode.models[id];
    const cost = model?.cost;
    if (!id || /^jev-/.test(id) || model?.status === "deprecated" || !zero(cost?.input) || !zero(cost?.output)) return [];
    // Include cache charges and context-dependent pricing tiers in the check.
    const allZero = (value) => value && typeof value === "object" ? Object.values(value).every(allZero) : zero(value);
    if (!allZero(cost)) return [];
    if (entry?.pricing && !allZero(entry.pricing)) return [];
    return [{ ...(typeof entry === "object" ? entry : {}), id, name: model.name, context_window: model.limit?.context, pricing: { prompt: 0, completion: 0 } }];
  });
}

export function setOpenCodeFreeModels(provider, models, now = Date.now()) {
  snapshots.set(provider, { ids: new Set(models.map((model) => bareId(model.id))), at: now });
}

export function isDiscoveredOpenCodeFree(provider, model, now = Date.now()) {
  const snapshot = snapshots.get(provider);
  return Boolean(snapshot && now - snapshot.at < MAX_AGE_MS && snapshot.ids.has(bareId(model)));
}

export function openCodeChatAllowed(provider, account, model) {
  if (provider?.catalog?.discover_free_only === true) {
    return account.discover_free_models === true && isDiscoveredOpenCodeFree(provider, model);
  }
  return (account.chat_models || []).includes(model);
}

export async function discoverOpenCodeFreeModels(provider, fetcher = fetch) {
  try {
    const urls = [new URL("/inference/v1/models", provider.base_url || provider.default_base_url).href, "https://models.dev/api.json"];
    const data = await Promise.all(urls.map(async (url) => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`OpenCode discovery HTTP ${response.status}`);
      return response.json();
    }));
    const models = freeOpenCodeModels(...data);
    setOpenCodeFreeModels(provider, models);
    return { data: models };
  } catch (error) {
    setOpenCodeFreeModels(provider, []);
    throw error;
  }
}
