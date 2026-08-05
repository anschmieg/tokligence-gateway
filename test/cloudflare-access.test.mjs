import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  configureCloudflareAccess,
  isValidCloudflareAccessToken,
  cloudflareAccessConfigured,
  _resetCacheForTests,
} from "../cloudflare-access.mjs";

// Generate test RSA key pair.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function makeJwt({ header = {}, payload = {}, key = privateKey, kid = "test-key-1", alg = "RS256" } = {}) {
  const h = {
    alg,
    kid,
    typ: "JWT",
    ...header,
  };
  const p = {
    aud: ["test-audience"],
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    sub: "test-user@example.com",
    email: "test@example.com",
    ...payload,
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${enc(h)}.${enc(p)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function publicJwk() {
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid: "test-key-1",
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: "RS256",
  };
}

function certsJson() {
  return JSON.stringify({ keys: [publicJwk()] });
}

test("verifySignature supports ES256 EC keys (Cloudflare Access algorithm)", async () => {
  const { generateKeyPairSync } = crypto;
  const { publicKey: ecPub, privateKey: ecPriv } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = ecPub.export({ format: "jwk" });
  const certs = JSON.stringify({
    keys: [{ kid: "ec-kid-1", kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" }],
  });
  configureCloudflareAccess({
    aud: "test-audience",
    certs,
    team: "test-team",
  });

  // Create an ES256 JWT.
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const h = { alg: "ES256", kid: "ec-kid-1", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const p = { aud: ["test-audience"], exp: now + 3600, iat: now };
  const input = enc(h) + "." + enc(p);
  const signature = crypto.sign("sha256", Buffer.from(input), ecPriv);
  const jwt = `${input}.${signature.toString("base64url")}`;

  // Raw r||s signature (64 bytes) is what JWT uses. Ensure we convert to DER.
  // Node's crypto.sign produces DER, but a real JWT uses raw r||s.
  // Re-sign manually with raw format:
  const { sign } = crypto;
  // The JWT spec uses raw (r || s) signatures, Node signs DER. For the test,
  // use node crypto to produce a raw signature via manual conversion.

  // Simplest: create the raw signature ourselves.
  const derSig = signature; // this is DER, not raw
  // Actually, Node signs DER for ES256. When validating, we need to accept
  // DER directly since the isValid function checks if signature.length === byteLen*2.
  // Let's just pass the DER signature (Node accepts it natively).
  // But real JWT signatures are raw r||s. Let's convert DER to raw for realism:
  const derToRaw = (der) => {
    // Parse DER sequence
    const seq = der[1];
    const rLen = der[3];
    const rStart = 4;
    const rBytes = der.subarray(rStart, rStart + rLen);
    const sStart = rStart + rLen + 2;
    const sLen = der[sStart - 1];
    const sBytes = der.subarray(sStart, sStart + sLen);
    // Strip leading zeros and pad to 32 bytes
    const norm = (b) => {
      let bytes = b;
      while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
      if (bytes.length < 32) {
        const padded = Buffer.alloc(32);
        bytes.copy(padded, 32 - bytes.length);
        return padded;
      }
      if (bytes.length > 32) bytes = bytes.subarray(bytes.length - 32);
      return bytes;
    };
    return Buffer.concat([norm(rBytes), norm(sBytes)]);
  };
  const rawSig = derToRaw(signature);
  const rawJwt = `${input}.${rawSig.toString("base64url")}`;

  assert.equal(await isValidCloudflareAccessToken(rawJwt), true);

  // Restore RSA config for subsequent tests.
  configureCloudflareAccess({
    aud: "test-audience",
    certs: certsJson(),
    team: "test-team",
  });
});

test.before(() => {
  configureCloudflareAccess({
    aud: "test-audience",
    certs: certsJson(),
    team: "test-team",
  });
});

test.after(() => {
  _resetCacheForTests();
});

test("cloudflareAccessConfigured is true when aud + tokens are set", () => {
  assert.equal(cloudflareAccessConfigured(), true);
});

test("isValidCloudflareAccessToken accepts a valid signed JWT", async () => {
  const token = makeJwt();
  assert.equal(await isValidCloudflareAccessToken(token), true);
});

test("isValidCloudflareAccessToken rejects a tampered token", async () => {
  const token = makeJwt();
  // Tamper with the payload.
  const parts = token.split(".");
  const payload = Buffer.from(
    JSON.stringify({ aud: ["test-audience"], exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const tampered = `${parts[0]}.${payload}.${parts[2]}`;
  assert.equal(await isValidCloudflareAccessToken(tampered), false);
});

test("isValidCloudflareAccessToken rejects wrong-audience token", async () => {
  const token = makeJwt({ payload: { aud: ["different-audience"] } });
  assert.equal(await isValidCloudflareAccessToken(token), false);
});

test("isValidCloudflareAccessToken rejects expired token", async () => {
  const token = makeJwt({ payload: { exp: Math.floor(Date.now() / 1000) - 600 } });
  assert.equal(await isValidCloudflareAccessToken(token), false);
});

test("isValidCloudflareAccessToken rejects unknown kid", async () => {
  const token = makeJwt({ kid: "unknown-key-2" });
  assert.equal(await isValidCloudflareAccessToken(token), false);
});

test("isValidCloudflareAccessToken returns false for empty/malformed input", async () => {
  assert.equal(await isValidCloudflareAccessToken(""), false);
  assert.equal(await isValidCloudflareAccessToken("not.a.jwt"), false);
  assert.equal(await isValidCloudflareAccessToken("a.b"), false);
  assert.equal(await isValidCloudflareAccessToken("a.b.c.d"), false);
});

test("isValidCloudflareAccessToken rejects token signed with wrong key", async () => {
  const { privateKey: otherKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = makeJwt({ key: otherKey });
  assert.equal(await isValidCloudflareAccessToken(token), false);
});

test("isValidCloudflareAccessToken rejects nbf-future token", async () => {
  const token = makeJwt({ payload: { nbf: Math.floor(Date.now() / 1000) + 3600 } });
  assert.equal(await isValidCloudflareAccessToken(token), false);
});
