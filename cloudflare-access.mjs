// cloudflare-access.mjs — validate Cloudflare Access JWT tokens.
//
// Cloudflare Access sits in front of the gateway and injects a signed JWT
// into the `Cf-Access-Jwt` request header. This module validates that token
// against Cloudflare's public JWKS so the dashboard can be protected by
// Cloudflare Access instead of (or in addition to) the TOKLIGENCE_ADMIN_SECRET
// shared secret.
//
// Configuration (environment variables; all optional — admin JWT validation is
// disabled until one of the required vars is present):
//   CLOUDFLARE_ACCESS_TEAM     - your Cloudflare Zero Trust team name (e.g. "my-company")
//                                Used to build the default JWKS URL.
//   CLOUDFLARE_ACCESS_AUD      - the application audience tag (required).
//   CLOUDFLARE_ACCESS_JWKS_URL - optional override for the JWKS URL (defaults to
//                                https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/certs).
//   CLOUDFLARE_ACCESS_CERTS    - optional inline JSON JWKS (for air-gapped deployments);
//                                takes precedence over the URL.
//
// The JWKS is fetched once and cached in-memory. Failures are fail-safe: if we
// can't fetch/verify, access is denied (never silently allowed).
//
// For testing: call configureCloudflareAccess({...}) to override the
// environment-derived settings.

import crypto from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const JWKS_REFRESH_MS = 60 * 60 * 1000;

let config = readConfig();
let cachedKeys = null;
let cachedKeysAt = 0;
let fetchInFlight = null;

function readConfig() {
  return {
    team: process.env.CLOUDFLARE_ACCESS_TEAM || "",
    aud: process.env.CLOUDFLARE_ACCESS_AUD || "",
    jwksUrlOverride: process.env.CLOUDFLARE_ACCESS_JWKS_URL || "",
    inlineCerts: process.env.CLOUDFLARE_ACCESS_CERTS || "",
  };
}

export function configureCloudflareAccess(overrides = {}) {
  config = {
    team: overrides.team || process.env.CLOUDFLARE_ACCESS_TEAM || config.team || "",
    aud: overrides.aud || process.env.CLOUDFLARE_ACCESS_AUD || config.aud || "",
    jwksUrlOverride: overrides.jwksUrl || process.env.CLOUDFLARE_ACCESS_JWKS_URL || config.jwksUrlOverride || "",
    inlineCerts: overrides.certs || process.env.CLOUDFLARE_ACCESS_CERTS || config.inlineCerts || "",
  };
  // Invalidate cache when reconfiguring.
  cachedKeys = null;
  cachedKeysAt = 0;
  fetchInFlight = null;
}

export function _resetCacheForTests() {
  cachedKeys = null;
  cachedKeysAt = 0;
  fetchInFlight = null;
}

function getDefaultJwksUrl() {
  return config.team ? `https://${config.team}.cloudflareaccess.com/cdn-cgi/access/certs` : "";
}

function resolveJwksUrl() {
  return config.jwksUrlOverride || getDefaultJwksUrl();
}

function fetchUrlJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const client = isHttps ? httpsRequest : httpRequest;
    const req = client({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { Accept: "application/json" },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} fetching JWKS`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("invalid JWKS JSON"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("JWKS fetch timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function resolveKeys() {
  if (config.inlineCerts) {
    try {
      return JSON.parse(config.inlineCerts);
    } catch {
      return null;
    }
  }
  const url = resolveJwksUrl();
  if (!url) return null;

  const now = Date.now();
  if (cachedKeys && now - cachedKeysAt < JWKS_REFRESH_MS) return cachedKeys;
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = (async () => {
    try {
      const data = await fetchUrlJson(url);
      cachedKeys = data;
      cachedKeysAt = Date.now();
      return cachedKeys;
    } catch (error) {
      if (cachedKeys) return cachedKeys;
      console.warn(`cloudflare-access: JWKS fetch failed: ${error.message}`);
      return null;
    } finally {
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

// ---------------------------------------------------------------------------
// JWT utilities
// ---------------------------------------------------------------------------

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function decodeJwtParts(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return {
    header: JSON.parse(base64UrlDecode(parts[0]).toString("utf8")),
    payload: JSON.parse(base64UrlDecode(parts[1]).toString("utf8")),
    signature: base64UrlDecode(parts[2]),
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

/**
 * Verify the JWT signature for a single JWK.
 */
function verifySignature(parts, jwk) {
  const { header, signature, signingInput } = parts;
  const { alg, kid } = header;
  if (!kid || jwk.kid !== kid) return false;

  try {
    if (alg === "RS256" || alg === "RS384" || alg === "RS512") {
      if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;
      const hashName = { "RS256": "sha256", "RS384": "sha384", "RS512": "sha512" }[alg];
      const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      const verifier = crypto.createVerify(hashName);
      verifier.update(signingInput);
      return verifier.verify(key, signature);
    }
    if (alg === "ES256" || alg === "ES384" || alg === "ES512") {
      if (jwk.kty !== "EC" || !jwk.x || !jwk.y || !jwk.crv) return false;
      const hashName = { "ES256": "sha256", "ES384": "sha384", "ES512": "sha512" }[alg];
      const byteLen = { "ES256": 32, "ES384": 48, "ES512": 66 }[alg];
      const key = crypto.createPublicKey({
        key: { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y },
        format: "jwk",
      });
      // Node crypto.verify expects ASN.1 DER; convert raw r||s if needed.
      const signatureDer = signature.length === byteLen * 2
        ? rawEcdsaToDer(signature, byteLen)
        : signature;
      const verifier = crypto.createVerify(hashName);
      verifier.update(signingInput);
      return verifier.verify(key, signatureDer);
    }
    return false;
  } catch {
    return false;
  }
}

function rawEcdsaToDer(raw, byteLen) {
  const r = raw.subarray(0, byteLen);
  const s = raw.subarray(byteLen);
  const toBn = (bytes) => {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
  };
  const rBn = toBn(r);
  const sBn = toBn(s);
  const toDerInt = (bn) => {
    let hex = bn.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    if (/^[89abcdef]/i.test(hex)) hex = "00" + hex;
    const bytes = Buffer.from(hex, "hex");
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const rDer = toDerInt(rBn);
  const sDer = toDerInt(sBn);
  return Buffer.concat([Buffer.from([0x30, rDer.length + sDer.length]), rDer, sDer]);
}

function checkClaims(payload, expectedAud) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return "token expired";
  if (payload.nbf && now < payload.nbf) return "token not yet valid";
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (expectedAud && !aud.includes(expectedAud)) return "audience mismatch";
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isValidCloudflareAccessToken(token) {
  if (!token) return false;
  if (!cloudflareAccessConfigured()) return false;

  let parts;
  try {
    parts = decodeJwtParts(token);
  } catch {
    return false;
  }
  const { header } = parts;
  if (!header.kid) return false;

  const keys = await resolveKeys();
  if (!keys?.keys?.length) return false;

  const matchedJwk = keys.keys.find((k) => k.kid === header.kid);
  if (!matchedJwk) return false;

  if (!verifySignature(parts, matchedJwk)) return false;

  const claimError = checkClaims(parts.payload, config.aud);
  if (claimError) {
    console.warn(`cloudflare-access: token rejected: ${claimError}`);
    return false;
  }
  return true;
}

export function cloudflareAccessConfigured() {
  return Boolean(config.aud) && Boolean(resolveJwksUrl() || config.inlineCerts);
}
