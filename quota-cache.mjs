const PROVIDERS = new Set(['codex-oauth', 'mistral']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function resetExpired(resetAt, time) {
  const reset = typeof resetAt === 'number' ? resetAt * 1000 : Date.parse(resetAt || '');
  return Number.isFinite(reset) && reset > 0 && reset <= time;
}

function hasExpiredWindow(result, time) {
  return (result.detail?.quota_signals || []).some(signal => resetExpired(signal.resetAt, time))
    || (result.detail?.accounts || []).some(account => (account.windows || []).some(window => resetExpired(window.reset_at, time)));
}

function clearExpiredWindows(result, time) {
  const value = clone(result);
  for (const signal of value.detail?.quota_signals || []) {
    if (resetExpired(signal.resetAt, time)) {
      signal.status = 'unavailable';
      signal.percentUsed = null;
      signal.remaining = null;
      signal.resetAt = null;
      signal.note = 'Quota window has reset; awaiting a fresh observation';
    }
  }
  for (const account of value.detail?.accounts || []) {
    account.windows = (account.windows || []).map(window => resetExpired(window.reset_at, time)
      ? { ...window, used_percent: null, reset_at: null, status: 'unavailable' }
      : window);
  }
  return value;
}

function isTransientFailure(providerId, value) {
  if (providerId === 'mistral') {
    const signals = value.detail?.quota_signals || [];
    return signals.some(signal => signal.status === 'unavailable'
      && !['No private Mistral session file configured', 'Mistral session credentials are missing, unsafe or invalid', 'Mistral session expired or rejected'].includes(signal.note));
  }
  return value.available === false;
}

function isCredentialFailure(value) {
  return (value.detail?.quota_signals || []).some(signal => [
    'Mistral session credentials are missing, unsafe or invalid',
    'Mistral session expired or rejected',
  ].includes(signal.note));
}

function retainRecentSignals(previous, current, observedAt, staleMs, fallbackAt) {
  const currentSignals = clone(current.detail?.quota_signals || []);
  const recent = (previous.detail?.quota_signals || []).filter(signal => {
    if (signal.percentUsed == null) return false;
    if (resetExpired(signal.resetAt, observedAt)) return false;
    const observed = Date.parse(signal.observedAt || '') || fallbackAt;
    return observedAt - observed <= staleMs;
  }).map(signal => ({ ...signal, status: 'stale' }));
  current.detail ||= {};
  current.detail.quota_signals = recent.length ? recent : currentSignals;
  return current;
}

function ageAsStale(result, age, staleMs, time) {
  const stale = clone(result);
  stale.status = age <= staleMs ? 'stale' : 'unavailable';
  stale.cachedAgeMs = age;
  if (age > staleMs) {
    stale.available = false;
    stale.source = 'unavailable';
    stale.used = null; stale.limit = null; stale.percentUsed = null;
  }
  for (const signal of stale.detail?.quota_signals || []) {
    const reset = resetExpired(signal.resetAt, time);
    signal.status = age <= staleMs && !reset ? 'stale' : 'unavailable';
    if (age > staleMs || reset) { signal.percentUsed = null; signal.remaining = null; signal.windows = []; if (reset) signal.resetAt = null; }
  }
  for (const account of stale.detail?.accounts || []) {
    account.windows = (account.windows || []).map(window => age <= staleMs && !resetExpired(window.reset_at, time) ? window : ({ ...window, used_percent: null, reset_at: null }));
  }
  if (stale.detail?.observed_rate_limits) {
    stale.detail.observed_rate_limits.status = age <= staleMs ? 'stale' : 'unavailable';
    if (age > staleMs) stale.detail.observed_rate_limits.remaining = null;
  }
  return stale;
}

export function createQuotaCache({ now = Date.now, ttlMs = 300000, staleMs = 900000, failureBackoffMs = 300000 } = {}) {
  const entries = new Map();
  return {
    async get(providerId, loader) {
      if (!PROVIDERS.has(providerId) || typeof loader !== 'function') throw new Error('unsupported quota cache provider');
      const time = now();
      let entry = entries.get(providerId);
      if (entry?.value && time - entry.at < ttlMs && !hasExpiredWindow(entry.value, time)) return clone(entry.value);
      if (entry?.flight) return clone(await entry.flight);
      if (entry?.failedAt != null && time - entry.failedAt < failureBackoffMs) {
        if (entry.value) {
          if (entry.primaryFresh) {
            entry.value = clearExpiredWindows(entry.value, time);
            return clone(entry.value);
          }
          return ageAsStale(entry.value, time - entry.at, staleMs, time);
        }
        return { provider: providerId, available: false, source: 'unavailable', status: 'unavailable', used: null, limit: null, percentUsed: null, error: 'quota probe unavailable' };
      }
      entry ||= {};
      entry.flight = Promise.resolve().then(loader).then(value => {
        const observedAt = now();
        if (isCredentialFailure(value)) {
          entry.failedAt = observedAt;
          if (value.available) {
            entry.value = clearExpiredWindows(value, observedAt);
            entry.at = observedAt;
            return entry.value;
          }
          if (entry.value) {
            const stale = ageAsStale(entry.value, observedAt - entry.at, staleMs, observedAt);
            stale.detail ||= {};
            stale.detail.quota_signals = clone(value.detail?.quota_signals || []);
            entry.value.detail ||= {};
            entry.value.detail.quota_signals = clone(value.detail?.quota_signals || []);
            return stale;
          }
          entry.value = null;
          entry.at = null;
          return value;
        }
        if (isTransientFailure(providerId, value)) {
          entry.failedAt = observedAt;
          if (providerId === 'mistral') {
            const latest = clearExpiredWindows(value, observedAt);
            if (value.available) {
              if (entry.value) retainRecentSignals(entry.value, latest, observedAt, staleMs, entry.at);
              entry.value = latest;
              entry.at = observedAt;
              entry.primaryFresh = true;
              return entry.value;
            }
            if (entry.value) {
              const stale = ageAsStale(entry.value, observedAt - entry.at, staleMs, observedAt);
              entry.value.detail ||= {};
              entry.value.detail.quota_signals = clone(stale.detail?.quota_signals || []);
              entry.primaryFresh = false;
              return stale;
            }
            entry.value = latest;
            entry.at = observedAt;
            entry.primaryFresh = true;
            return entry.value;
          }
          entry.primaryFresh = false;
          return entry.value ? ageAsStale(entry.value, observedAt - entry.at, staleMs, observedAt) : value;
        }
        entry.value = clearExpiredWindows(value, observedAt);
        entry.at = observedAt;
        entry.failedAt = null;
        entry.primaryFresh = false;
        return entry.value;
      }).catch(() => {
        entry.failedAt = now();
        if (entry.value) return ageAsStale(entry.value, now() - entry.at, staleMs, now());
        return { provider: providerId, available: false, source: 'unavailable', status: 'unavailable', used: null, limit: null, percentUsed: null, error: 'quota probe unavailable' };
      }).finally(() => { entry.flight = null; });
      entries.set(providerId, entry);
      return clone(await entry.flight);
    },
    invalidate(providerId, { backoff = false } = {}) {
      if (!PROVIDERS.has(providerId)) return;
      if (!backoff) { entries.delete(providerId); return; }
      const entry = entries.get(providerId) || {};
      entry.value = null;
      entry.at = null;
      entry.failedAt = now();
      entries.set(providerId, entry);
    },
  };
}
