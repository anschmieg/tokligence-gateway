// OpenCode Zen credential store.
//
// Zen's free tier is only served to an account that completed the Console
// sign-in, so the provider cannot use a Console API key: it needs the OAuth
// access token, and it has to renew that token before it expires or every
// request starts failing with FreeTierError. The credential file is the same
// shape OpenCode itself keeps, so it can be seeded from a working client.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_SKEW_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_TIMEOUT_MS = 10_000;
const TOKEN_RESPONSE_LIMIT = 64 * 1024;

export function canonicalCredentialFile(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

export function readCredential(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed.access === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCredential(file, credential) {
  file = canonicalCredentialFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(credential, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function credentialExpiry(credential) {
  const expires = Number(credential?.expires);
  if (Number.isFinite(expires) && expires > 0) return expires > 1e12 ? expires : expires * 1000;
  return Number.POSITIVE_INFINITY;
}

export function needsRefresh(credential, skewMs = DEFAULT_SKEW_MS, now = Date.now()) {
  if (!credential) return true;
  return credentialExpiry(credential) - now <= skewMs;
}

async function requestToken({ tokenUrl, clientId, refreshToken, fetchImpl }) {
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(clientId ? { client_id: clientId } : {}),
    }).toString(),
  });
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TOKEN_RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error("OpenCode Zen token refresh returned an oversized response");
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks, bytes).toString("utf8");
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`OpenCode Zen token refresh failed (${response.status})`);
  }
  const access = payload?.access_token || payload?.access;
  if (!access) throw new Error("OpenCode Zen token refresh returned no access token");
  const expiresIn = Number(payload?.expires_in);
  return {
    access,
    refresh: payload?.refresh_token || refreshToken,
    expires: Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : credentialExpiryFallback(payload),
  };
}

function credentialExpiryFallback(payload) {
  const expires = Number(payload?.expires);
  if (Number.isFinite(expires) && expires > 0) return expires > 1e12 ? expires : expires * 1000;
  return Date.now() + 24 * 60 * 60 * 1000;
}

// Single-flight token provider: concurrent requests share one refresh, and a
// still-valid token is preferred over a failed refresh so a transient outage
// does not take the provider down. Production ownership is canonicalized by the
// provider/account service registry; this factory remains isolated for tests.
export function createTokenProvider({
  file,
  tokenUrl,
  clientId,
  skewMs = DEFAULT_SKEW_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let inFlight = null;

  const refresh = async (credential) => {
    if (!tokenUrl) throw new Error("OpenCode Zen needs a token_url to refresh the access token");
    if (!credential?.refresh) throw new Error("OpenCode Zen credential has no refresh token; sign in again");
    const rotated = await requestToken({ tokenUrl, clientId, refreshToken: credential.refresh, fetchImpl });
    const next = {
      ...credential,
      type: credential.type || "oauth",
      methodID: credential.methodID || "device",
      access: rotated.access,
      refresh: rotated.refresh,
      expires: rotated.expires,
    };
    if (file) writeCredential(file, next);
    log(`opencode-zen: refreshed access token, valid until ${new Date(next.expires).toISOString()}`);
    return next;
  };

  const resolve = async () => {
    const credential = file ? readCredential(file) : null;
    if (!credential) throw new Error("OpenCode Zen credential is missing");
    if (!needsRefresh(credential, skewMs, now())) return credential;

    if (!inFlight) {
      inFlight = refresh(credential).finally(() => {
        inFlight = null;
      });
    }
    try {
      return await inFlight;
    } catch (error) {
      if (credentialExpiry(credential) > now()) {
        log("opencode-zen: refresh failed, using the current token until it expires");
        return credential;
      }
      throw new Error(`${error.message}; the stored OpenCode Zen token has expired`);
    }
  };

  const provider = {
    authorization: async () => `Bearer ${(await resolve()).access}`,
    credential: resolve,
    refreshNow: async () => {
      const credential = file ? readCredential(file) : null;
      if (!credential) throw new Error("OpenCode Zen credential is missing");
      return refresh(credential);
    },
  };
  return provider;
}