function asModelObject(model) {
  return typeof model === "string" ? { id: model } : (model || {});
}

function isZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function hasZeroPrice(model) {
  const pricing = model.pricing || {};
  return isZero(pricing.prompt) && isZero(pricing.completion);
}

/**
 * Catalog visibility is intentionally independent from routing. It limits what
 * clients discover while preserving explicitly configured routes and aliases.
 */
export function modelAllowedByCatalog(provider, candidate) {
  const catalog = provider?.catalog || {};
  if (catalog.visible === false) return false;

  const model = asModelObject(candidate);
  const id = String(model.id || "");
  if (!id) return false;

  if (provider?.id === "openrouter" && catalog.zero_price_only === true) {
    return hasZeroPrice(model) || (catalog.paid_allowlist || []).includes(id);
  }

  if (provider?.id === "opencode-zen" && Array.isArray(catalog.id_suffixes)) {
    const lower = id.toLowerCase();
    return catalog.id_suffixes.some((suffix) => lower.endsWith(String(suffix).toLowerCase()));
  }

  return true;
}
