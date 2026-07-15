export const CODEX_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isCodexModel(config, model) {
  return Boolean(model && config.enabled && config.modelSet.has(model.toLowerCase()));
}

export function isReservedCodexModel(model) {
  return Boolean(model && /^gpt-5\.6-/i.test(model));
}

export function codexUpstreamUrl(config, requestPath) {
  if (!config.enabled) throw new Error("Codex backend is disabled");
  const incoming = new URL(requestPath, "http://gateway.local");
  let pathname = incoming.pathname;
  if (pathname.startsWith("/anthropic/")) pathname = pathname.slice("/anthropic".length);
  const target = new URL(config.baseUrl);
  target.pathname = `${target.pathname.replace(/\/$/, "")}${pathname}`;
  target.search = incoming.search;
  return target;
}
