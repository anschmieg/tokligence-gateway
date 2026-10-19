import { extractUsage } from "./usage-observer.mjs";

const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_GROUPS = 1000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

function idleBucket(milliseconds) {
  if (milliseconds < 60_000) return "0-1m";
  if (milliseconds < 5 * 60_000) return "1-5m";
  if (milliseconds < 15 * 60_000) return "5-15m";
  if (milliseconds < 30 * 60_000) return "15-30m";
  if (milliseconds < 60 * 60_000) return "30-60m";
  return "60m+";
}

export function createSessionCacheObserver({
  now = () => Date.now(),
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxGroups = DEFAULT_MAX_GROUPS,
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  const sessions = new Map();
  const groups = new Map();

  function prune(currentTime) {
    for (const [key, entry] of sessions) {
      if (entry.lastSeenAt + retentionMs <= currentTime) sessions.delete(key);
    }
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    while (groups.size > maxGroups) groups.delete(groups.keys().next().value);
  }

  return {
    record(sessionKeyHash, provider, model, data) {
      const usage = extractUsage(data);
      if (!sessionKeyHash || !provider || !model || !usage) return false;
      const currentTime = now();
      prune(currentTime);
      const previous = sessions.get(sessionKeyHash);
      const hasRecentPrevious = previous && previous.lastSeenAt + retentionMs > currentTime;
      if (hasRecentPrevious) {
        const bucket = idleBucket(currentTime - previous.lastSeenAt);
        const groupKey = `${provider}\0${model}\0${bucket}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = {
            provider, model, idle_bucket: bucket, samples: 0, input_tokens: 0,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
          };
          groups.set(groupKey, group);
        } else {
          groups.delete(groupKey);
          groups.set(groupKey, group);
        }
        group.samples += 1;
        group.input_tokens += usage.inputTokens;
        group.cache_read_input_tokens += usage.cacheReadInputTokens;
        group.cache_creation_input_tokens += usage.cacheCreationInputTokens;
        group.output_tokens += usage.outputTokens;
      }
      sessions.delete(sessionKeyHash);
      sessions.set(sessionKeyHash, { provider, model, lastSeenAt: currentTime });
      prune(currentTime);
      return true;
    },
    snapshot() {
      return [...groups.values()].map((group) => ({ ...group }));
    },
    get sessionCount() {
      return sessions.size;
    },
  };
}
