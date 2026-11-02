# Cloudflare Access management seal — integration into pinned CLIProxyAPI v8.0.49

Base: pinned backend `/tmp/m2-eval/backend` (package `management`,
`internal/api/handlers/management/handler.go`, commit source of record) and the
parent-prepared source `/tmp/cliproxy-cloudflare-alpha-source` (earlier patches
plus `management_quarantine` already present, frontend already built as
code.nothing.pink same-origin empty-key login — no dummy key, no browser
secret). Both new Go files go into package `management` (same directory as
`handler.go`), not a subpackage.

## Upstream state (do not weaken)

`Handler.Middleware()` in `handler.go:324` is managementkey-only: it reads
`Authorization: Bearer` / `X-Management-Key` (lines 334–346) and delegates to
`AuthenticateManagementKey` (line 348). Remote callers additionally need
`allow-remote-management=true` or `MANAGEMENT_PASSWORD`. There is no
Cloudflare, JWT or generic OIDC awareness upstream. Inference is not affected:
this seam only sits ahead of management-endpoint access.

## Exactly one insertion point

In `internal/api/handlers/management/handler.go`, inside
`func (h *Handler) Middleware() gin.HandlerFunc`, immediately **before**:

```go
		clientIP := c.ClientIP()
```

(handler.go:331, i.e. after the four `c.Header("X-CPA-*", ...)` buildinfo lines
at 326–329 and before the key extraction at 334). Insert exactly three lines:

```go
		if cfAccessGate(c) {
			return
		}
```

Resulting shape:

```go
	return func(c *gin.Context) {
		c.Header("X-CPA-VERSION", buildinfo.Version)
		c.Header("X-CPA-COMMIT", buildinfo.Commit)
		c.Header("X-CPA-BUILD-DATE", buildinfo.BuildDate)
		c.Header("X-CPA-SUPPORT-PLUGIN", pluginhost.SupportPluginHeaderValue())

		if cfAccessGate(c) {
			return
		}

		clientIP := c.ClientIP()
		...
```

The anchor `clientIP := c.ClientIP()` is unique in `handler.go` (verified:
exactly one occurrence at line 331 in both `/tmp/m2-eval/backend` and
`/tmp/cliproxy-cloudflare-alpha-source`). This places the Cloudflare gate
before any native key logic — the helper is checked BEFORE the native
management key. No other line of `handler.go` changes; the inserted lines need
no new imports in `handler.go` (`cfAccessGate` is self-contained in
`cloudflare_access.go`, which already imports gin, logrus, net/http and os).

## Helper semantics (cloudflare_access.go, package management)

- `cfAccessGate(c *gin.Context) bool` — the single integration function.
  - Header `Cf-Access-Jwt-Assertion` **absent → false**: the native
    management-key path proceeds byte-for-byte unchanged (absence preserves
    the native key path).
  - Assertion present but `CLOUDFLARE_ACCESS_TEAM` / `CLOUDFLARE_ACCESS_AUD`
    not set (or invalid team) → **deny 401**, fail-closed, no key fallback.
  - Assertion present and valid → `c.Next()` and true (caller must stop):
    management is reachable with no management key at all — the
    code.nothing.pink same-origin empty-key login.
  - Assertion present and invalid → **deny 401** with the fixed body
    `{"error":"cloudflare access authentication failed"}`; the response never
    echoes the assertion or any claim value, and the native key path is never
    consulted (no key fallback).
- `cfVerifyAssertion(ctx, token)` — bounded size (32 KiB), compact JWS shape,
  RS256-only header with kid, JWKS key lookup by kid, RS256 PKCS1v15/SHA-256
  signature, then claims. No algorithm is ever taken from the token except
  literal `RS256`.
- `cfVerifyClaims` — exact issuer (`https://<team>.cloudflareaccess.com`),
  audience matches `CLOUDFLARE_ACCESS_AUD` (string or list), `exp` / `nbf` /
  `iat` all required with a 2-minute skew, nonempty `email` claim. The email
  comes only from the signature-verified claim: service tokens without a
  personal email claim are denied, and the untrusted `Cf-Access-Email` /
  `Cf-Access-Id` request headers are never read, so header spoofing is
  impossible. When `CLOUDFLARE_ACCESS_ALLOWED_EMAILS` is set, the email must
  match an entry exactly (comma-separated, case-insensitive; required entries
  lowercased in the response-claim comparison).
- Environment contract (required to activate; never hardcoded):
  - `CLOUDFLARE_ACCESS_TEAM` — DNS label only (lowercase letters, digits,
    hyphens, ≤63 chars); anything else disables the Cloudflare path with a
    warning log and leaves the native key path intact.
  - `CLOUDFLARE_ACCESS_AUD` — audience tag, required.
  - `CLOUDFLARE_ACCESS_ALLOWED_EMAILS` — optional exact email allowlist.
- JWKS: fixed issuer-derived URL `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`;
  10 s timeout, 1 MiB body cap, redirect-rejecting client
  (`http.ErrUseLastResponse` → non-2xx → fail-closed; redirects are never
  followed); simple mutex cache (1 h TTL) with refreshes paced ≥60 s apart;
  unknown kid against a fresh cache does NO fetch (paced no-op → deny);
  unknown kid against a stale/empty cache shares the regular pacing window;
  a failed fetch never poisons the cache. Modulus is hand-checked ≥2048 and
  ≤8192 bits with exponent in [3, 2^31-1] and odd — `rsa.PublicKey.Validate`
  is deliberately not used. Stdlib RSA/SHA256/json/http only, no framework.

## What is NOT changed

- `AuthenticateManagementKey`, `Middleware()`'s native body after the insert,
  routing, `Handler` fields and all other handlers. Management quarantine is
  post-auth and unaffected; inference paths are untouched.
- No other file of the backend is edited by this patch; the parent owns the
  single 3-line insert above.
- No secret values are echoed anywhere: denial bodies are fixed strings, log
  lines carry rejection reasons only (never the token, keys or signatures).

## Tests (cloudflare_access_test.go, package management)

Hermetic, injectable HTTP transport in unit only, zero external network
contact; 2048-bit RSA keys and JWKS documents are generated in-test
(`TestMain` already exists in `test_main_test.go` — no second one is added).
The harness mirrors the anchor exactly: `cfAccessGate` runs ahead of
`h.Middleware()` on a `gin.New()` router.

- `TestCFEnvFromEnv` — team+aud required, fixed issuer/JWKS derivation,
  DNS-label-only team validation, optional allowlist parsing.
- `TestCFVerifyClaims` — table: valid; aud-as-list; wrong/missing issuer;
  wrong audience; expired; nbf/iat future; missing exp/nbf/iat; missing/blank
  email; allowlist match/mismatch.
- `TestCFAccessValidAssertionGrantsNext` — valid signed assertion grants
  `c.Next()` with NO management key configured; exactly one JWKS fetch to the
  fixed team URL.
- `TestCFAccessInvalidSignatureNoKeyFallback` — signature by an attacker key
  (kid matching the deployed JWKS) plus the REAL management key header → 401,
  fixed body, no native usage ("management key" never appears).
- `TestCFAccessAssertionFailures` — wrong issuer/audience, expired,
  nbf-future, and missing-email claim with spoofed `Cf-Access-Email` /
  `Cf-Access-Id` headers still denied; all served from cache, no refetch.
- `TestCFAccessUnknownKidPaced` — unknown kid fetches once, then unknown kid
  against a fresh cache sources no further fetches; known kid passes.
- `TestCFAccessRedirectFailClosed` — JWKS replies 302 → exactly one
  roundtrip, 401, redirect never followed.
- `TestCFAccessLowCostDenials` — HS256/none alg, missing kid, non-compact
  body and oversized (>32 KiB) assertions all deny 401 with ZERO JWKS
  fetches.
- `TestCFAccessAbsencePreservesNativeKeyPath` — no assertion: valid
  management key → 200; invalid/no key → native 401 with "management key"
  text; zero JWKS contact in every variant.
- `TestCFAccessEmailAllowlistMiddleware` — allowlisted email passes; email
  outside the allowlist is denied.

## Verification commands for the parent

Prepare into the NEW separate source directory (never edits input or deploys),
copy both Go files and apply the anchor insert, then run:

```sh
# copy staging/cli-proxy-api/patches/cloudflare_management/cloudflare_access.go and
# staging/cli-proxy-api/patches/cloudflare_management/cloudflare_access_test.go into
# /tmp/cliproxy-cloudflare-alpha-source/internal/api/handlers/management/
# apply the single 3-line insert in .../management/handler.go (anchor above)
cd /tmp/cliproxy-cloudflare-alpha-source
gofmt -l internal/api/handlers/management/ | grep -i cloudflare   # expect empty
go test ./internal/api/handlers/management/ -run 'TestCF' -race -count=1
go test ./internal/api/handlers/management/ -race -count=1   # full package: no regression
go build ./...                                               # whole tree compiles
```

Rollback: remove the three inserted lines and the two new files; behavior
returns to stock (managementkey-only). Retire the patch when mainline ships an
equivalent Cloudflare Access guard for the management surface.

## Out of scope (explicit)

- Any change to `AuthenticateManagementKey`, ban/retry accounting, endpoints,
  or the management_quarantine guard (already in the prepared source).
- Inference/auth-file verification paths — unaffected by design.
- Production env provisioning (TEAM/AUD/ALLOWED_EMAILS) and Cloudflare Zone
  setup — parent/operator concerns; the patch only reads environment values.

Parent corrections after review: cached keys now expire and a missing kid can
trigger one paced refresh even when previous keys remain fresh. Refreshes are
coalesced under the mutex; failed refresh never authenticates an expired cached
key. Present-empty/duplicate assertions deny without native-key fallback.
Access-authenticated browser requests require their own HTTPS Origin and reject
cross-site Fetch Metadata. No raw claim/email/algorithm values are logged.
Focused parent race suite passed including TTL/rotation and actual Middleware
CSRF/duplicate-header regressions. Native API-key clients remain unchanged.
Management auth cannot be implemented at provider/executor hooks, which run
after this protected API surface; this narrowly scoped native middleware seam
is the justified exception, without a separate authentication proxy.
