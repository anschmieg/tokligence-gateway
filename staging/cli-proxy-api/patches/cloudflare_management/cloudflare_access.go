// Signed Cloudflare Access JWT authentication for the management endpoints.
// This file owns the new cloudflare_management patch only: the native
// management-key middleware in handler.go is not modified here, the parent
// inserts a single `cfAccessGate` call ahead of the native key extraction
// (see INTEGRATION.md for the exact anchor).
//
// Semantics, fail-closed:
//   - No `Cf-Access-Jwt-Assertion` header -> return false; the native
//     management-key path proceeds byte-for-byte unchanged.
//   - Assertion present but Cloudflare Access env not configured -> deny 401.
//   - Assertion present -> bounded size, RS256-only signature against the
//     team-derived JWKS, then fixed issuer / configured audience /
//     exp / nbf / iat / email claims. Valid -> c.Next() (the caller must
//     stop). Invalid -> fixed 401 with no assertion/claim echo and NO
//     fallback to the native management key.
//
// The untrusted `Cf-Access-Email` / `Cf-Access-Id` request headers are never
// read; the email comes only from the signature-verified `email` claim, so
// service tokens (no personal email claim) are always denied and header
// spoofing is impossible.
package management

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

const (
	// cfAssertionHeader is Cloudflare's officially signed JWT header.
	cfAssertionHeader = "Cf-Access-Jwt-Assertion"

	// cfMaxAssertionBytes bounds the accepted assertion (32 KiB) so oversized
	// tokens are rejected before any parsing or JWKS work.
	cfMaxAssertionBytes = 32 * 1024

	// cfMaxJWKSBytes bounds the JWKS response body read.
	cfMaxJWKSBytes = 1 << 20 // 1 MiB

	// cfJWKSFetchTimeout bounds each JWKS HTTP fetch.
	cfJWKSFetchTimeout = 10 * time.Second

	// cfJWKSTTL bounds how long cached keys stay fresh.
	cfJWKSTTL = time.Hour

	// cfJWKSMinRefreshInterval paces refreshes (including unknown-kid
	// retries) so a stream of bad kid values cannot turn into a fetch hammer.
	cfJWKSMinRefreshInterval = time.Minute

	// cfClockSkew is the tolerance applied to exp/nbf/iat validation.
	cfClockSkew = 2 * time.Minute

	// cfMinModulusBits / cfMaxModulusBits bound accepted RSA key sizes.
	// Keys are hand-checked; rsa.PublicKey.Validate is deliberately not used.
	cfMinModulusBits = 2048
	cfMaxModulusBits = 8192

	// cfIssuerFormat is the fixed team-derived HTTPS issuer and JWKS base.
	// No attacker-supplied URLs or issuers are ever followed or trusted.
	cfIssuerFormat = "https://%s.cloudflareaccess.com"
)

// cfAccessEnv holds the environment-derived configuration. Both team and aud
// must be valid for Cloudflare Access authentication to activate; the email
// allowlist is optional.
type cfAccessEnv struct {
	team      string
	aud       string
	allowlist map[string]bool // exact emails (lowercased); nil when unset
}

// issuer returns the fixed team-derived HTTPS issuer, or "" when unset.
// The team is a validated DNS label, so the host shape is always
// https://<team>.cloudflareaccess.com and nothing else.
func (e cfAccessEnv) issuer() string {
	if e.team == "" {
		return ""
	}
	return fmt.Sprintf(cfIssuerFormat, e.team)
}

// jwksURL returns the fixed team-derived HTTPS JWKS URL, built only from the
// validated team label.
func (e cfAccessEnv) jwksURL() string {
	if e.team == "" {
		return ""
	}
	return e.issuer() + "/cdn-cgi/access/certs"
}

// enabled reports whether the required environment variables are present.
func (e cfAccessEnv) enabled() bool { return e.team != "" && e.aud != "" }

// cfValidTeamLabel restricts the team to a DNS label: lowercase letters,
// digits and hyphens only, 1-63 chars, no leading/trailing hyphen. This makes
// issuer and JWKS URL derivation injection-proof.
func cfValidTeamLabel(team string) bool {
	if len(team) == 0 || len(team) > 63 {
		return false
	}
	if team[0] == '-' || team[len(team)-1] == '-' {
		return false
	}
	for _, r := range team {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-':
		default:
			return false
		}
	}
	return true
}

// cfEnvFromEnv builds the configuration from environment variables only:
// CLOUDFLARE_ACCESS_TEAM (DNS label), CLOUDFLARE_ACCESS_AUD (required) and
// CLOUDFLARE_ACCESS_ALLOWED_EMAILS (optional comma-separated exact emails).
func cfEnvFromEnv() cfAccessEnv {
	team := strings.TrimSpace(os.Getenv("CLOUDFLARE_ACCESS_TEAM"))
	aud := strings.TrimSpace(os.Getenv("CLOUDFLARE_ACCESS_AUD"))
	if team == "" && aud == "" {
		return cfAccessEnv{}
	}
	if !cfValidTeamLabel(team) {
		log.Warn("management: cloudflare access disabled: CLOUDFLARE_ACCESS_TEAM must be a lowercase DNS label (letters, digits, hyphens)")
		return cfAccessEnv{}
	}
	if aud == "" {
		log.Warn("management: cloudflare access disabled: CLOUDFLARE_ACCESS_AUD not set")
		return cfAccessEnv{}
	}
	env := cfAccessEnv{team: team, aud: aud}
	if raw := strings.TrimSpace(os.Getenv("CLOUDFLARE_ACCESS_ALLOWED_EMAILS")); raw != "" {
		allowlist := make(map[string]bool)
		for _, addr := range strings.Split(raw, ",") {
			addr = strings.ToLower(strings.TrimSpace(addr))
			if addr != "" {
				allowlist[addr] = true
			}
		}
		env.allowlist = allowlist
	}
	return env
}

var (
	// cfEnvOverride is a test seam (nil in production); tests replace the
	// environment-derived config without touching process env or sync.Once.
	cfEnvOverride *cfAccessEnv
	cfEnvOnce     sync.Once
	cfEnv         cfAccessEnv
)

// cfLoadEnv resolves the Cloudflare Access configuration once per process.
func cfLoadEnv() cfAccessEnv {
	if cfEnvOverride != nil {
		return *cfEnvOverride
	}
	cfEnvOnce.Do(func() {
		cfEnv = cfEnvFromEnv()
		if cfEnv.enabled() {
			log.WithField("issuer", cfEnv.issuer()).Info("management: cloudflare access authentication active")
		}
	})
	return cfEnv
}

// cfJWKSCache is a simple mutex-guarded JWKS cache. A failed fetch never
// overwrites or poisons cached keys: stale keys stay usable within the TTL
// and an empty cache simply denies authentication (fail-closed).
type cfJWKSCache struct {
	mu          sync.Mutex
	keys        map[string]*rsa.PublicKey // keyed by kid
	fetchedAt   time.Time
	lastAttempt time.Time
}

var cfCache cfJWKSCache

// cfHTTPClient is a bounded, redirect-rejecting client: with
// ErrUseLastResponse a redirect response surfaces as-is and is then rejected
// on the non-2xx status, so no JWKS URL can ever redirect the fetch elsewhere.
var cfHTTPClient = &http.Client{
	Timeout: cfJWKSFetchTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// cfRSAPublicKeyFromJWK converts a single RSA JWK into a public key after
// hand-checked bounds (no rsa.PublicKey.Validate usage): modulus >= 2048 and
// <= 8192 bits, exponent in [3, 2^31-1] and odd, so the key is safe to
// exponentiate and cannot explode signature timing or memory.
func cfRSAPublicKeyFromJWK(jwk map[string]any) (*rsa.PublicKey, error) {
	if jwk["kty"] != "RSA" {
		return nil, errors.New("jwk kty is not RSA")
	}
	nStr, _ := jwk["n"].(string)
	eStr, _ := jwk["e"].(string)
	if nStr == "" || eStr == "" {
		return nil, errors.New("jwk missing n or e")
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(nStr)
	if err != nil {
		return nil, fmt.Errorf("jwk n is not base64url: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eStr)
	if err != nil {
		return nil, fmt.Errorf("jwk e is not base64url: %w", err)
	}
	if len(nBytes) == 0 || len(eBytes) == 0 {
		return nil, errors.New("jwk n or e is empty")
	}
	n := new(big.Int).SetBytes(nBytes)
	e := new(big.Int).SetBytes(eBytes)
	bits := n.BitLen()
	if bits < cfMinModulusBits || bits > cfMaxModulusBits {
		return nil, fmt.Errorf("jwk modulus size %d outside [%d, %d] bits", bits, cfMinModulusBits, cfMaxModulusBits)
	}
	if !e.IsInt64() || e.Int64() < 3 || e.Int64() > math.MaxInt32 || e.Int64()%2 == 0 {
		return nil, errors.New("jwk exponent out of acceptable range")
	}
	return &rsa.PublicKey{N: n, E: int(e.Int64())}, nil
}

// cfFetchJWKS performs a single bounded HTTPS GET against the fixed team URL
// through the redirect-rejecting client.
func cfFetchJWKS(ctx context.Context, url string) (map[string]*rsa.PublicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, cfJWKSFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("jwks request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := cfHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jwks fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("jwks fetch: http %d (redirects are never followed)", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, cfMaxJWKSBytes+1))
	if err != nil {
		return nil, fmt.Errorf("jwks read: %w", err)
	}
	if len(body) > cfMaxJWKSBytes {
		return nil, fmt.Errorf("jwks body exceeds %d bytes", cfMaxJWKSBytes)
	}

	var parsed struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("jwks parse: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(parsed.Keys))
	for _, jwk := range parsed.Keys {
		kid, _ := jwk["kid"].(string)
		if kid == "" {
			continue
		}
		pub, err := cfRSAPublicKeyFromJWK(jwk)
		if err != nil {
			// Skip malformed or non-RSA entries; Cloudflare publishes several.
			continue
		}
		keys[kid] = pub
	}
	if len(keys) == 0 {
		return nil, errors.New("jwks contained no usable RSA keys")
	}
	return keys, nil
}

// cfLookupKey coalesces refreshes under the mutex. Cached keys expire;
// unknown kids can trigger one paced refresh for legitimate key rotation.
func cfLookupKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	cfCache.mu.Lock()
	defer cfCache.mu.Unlock()
	now := time.Now()
	if !cfCache.fetchedAt.IsZero() && now.Sub(cfCache.fetchedAt) < cfJWKSTTL {
		if key := cfCache.keys[kid]; key != nil {
			return key, nil
		}
	}
	if !cfCache.lastAttempt.IsZero() && now.Sub(cfCache.lastAttempt) < cfJWKSMinRefreshInterval {
		return nil, errors.New("jwks refresh paced")
	}
	cfCache.lastAttempt = now
	keys, err := cfFetchJWKS(ctx, cfLoadEnv().jwksURL())
	if err != nil {
		return nil, errors.New("jwks unavailable")
	}
	cfCache.keys = keys
	cfCache.fetchedAt = time.Now()
	if key := keys[kid]; key != nil {
		return key, nil
	}
	return nil, errors.New("jwks key unavailable")
}

// cfVerifyAssertion validates a Cloudflare Access JWT end to end and returns
// the verified email claim. Order: bounded size -> compact JWS shape ->
// RS256-only header with kid -> JWKS key by kid (paced refresh) -> RS256
// signature -> iss / aud / exp / nbf / iat / email claims.
func cfVerifyAssertion(ctx context.Context, token string) (string, error) {
	env := cfLoadEnv()
	if !env.enabled() {
		return "", errors.New("cloudflare access not configured")
	}
	if len(token) > cfMaxAssertionBytes {
		return "", fmt.Errorf("assertion exceeds %d bytes", cfMaxAssertionBytes)
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("assertion is not a JWS compact serialisation")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("assertion header is not base64url: %w", err)
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return "", fmt.Errorf("assertion header is not valid JSON: %w", err)
	}
	if header.Alg != "RS256" {
		return "", fmt.Errorf("assertion alg %q is not RS256", header.Alg)
	}
	if header.Kid == "" {
		return "", errors.New("assertion header missing kid")
	}

	pub, err := cfLookupKey(ctx, header.Kid)
	if err != nil {
		return "", err
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("assertion signature is not base64url: %w", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig) != nil {
		return "", errors.New("assertion signature verification failed")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("assertion payload is not base64url: %w", err)
	}
	var claims struct {
		Issuer    string          `json:"iss"`
		Audience  json.RawMessage `json:"aud"`
		ExpiresAt int64           `json:"exp"`
		NotBefore int64           `json:"nbf"`
		IssuedAt  int64           `json:"iat"`
		Email     string          `json:"email"`
	}
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return "", fmt.Errorf("assertion payload is not valid JSON: %w", err)
	}
	if err := cfVerifyClaims(env, claims.Issuer, claims.Audience, claims.ExpiresAt, claims.NotBefore, claims.IssuedAt, claims.Email); err != nil {
		return "", err
	}
	return claims.Email, nil
}

// cfVerifyClaims enforces the fixed issuer, the configured audience (string
// or list), bounded-skew time claims and a nonempty email claim. The email is
// always the signature-verified claim; request headers are never consulted.
func cfVerifyClaims(env cfAccessEnv, iss string, aud json.RawMessage, exp, nbf, iat int64, email string) error {
	now := time.Now()
	expectedIssuer := env.issuer()
	if iss == "" || expectedIssuer == "" || iss != expectedIssuer {
		return errors.New("assertion issuer mismatch")
	}

	var audList []string
	if len(aud) > 0 {
		var single string
		if err := json.Unmarshal(aud, &single); err == nil {
			audList = []string{single}
		} else if err := json.Unmarshal(aud, &audList); err != nil {
			return errors.New("assertion audience is neither string nor list")
		}
	}
	audOK := false
	for _, a := range audList {
		if a == env.aud {
			audOK = true
			break
		}
	}
	if !audOK {
		return errors.New("assertion audience mismatch")
	}

	if exp == 0 {
		return errors.New("assertion missing exp")
	}
	if now.After(time.Unix(exp, 0).Add(cfClockSkew)) {
		return errors.New("assertion expired")
	}
	if nbf == 0 {
		return errors.New("assertion missing nbf")
	}
	if now.Add(cfClockSkew).Before(time.Unix(nbf, 0)) {
		return errors.New("assertion not yet valid")
	}
	if iat == 0 {
		return errors.New("assertion missing iat")
	}
	if now.Add(cfClockSkew).Before(time.Unix(iat, 0)) {
		return errors.New("assertion iat in the future")
	}
	if strings.TrimSpace(email) == "" {
		return errors.New("assertion missing email")
	}
	if env.allowlist != nil && !env.allowlist[strings.ToLower(strings.TrimSpace(email))] {
		return errors.New("assertion email is not on the allowlist")
	}
	return nil
}

// cfDeny writes the fixed 401 denial. The response body never echoes the
// assertion or any claim value, and the caller must not fall through to the
// native management-key path.
func cfDeny(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "cloudflare access authentication failed"})
}

// cfAccessGate enforces Cloudflare Access ahead of the native management-key
// check. It returns true when the caller must stop immediately (the request
// has either been advanced with c.Next() or denied) and false when the
// assertion header is absent, in which case the native key path must proceed
// unchanged. This is the single function the integration inserts.
func cfAccessGate(c *gin.Context) bool {
	values, present := c.Request.Header[http.CanonicalHeaderKey(cfAssertionHeader)]
	if !present {
		return false
	}
	if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
		cfDeny(c)
		return true
	}
	assertion := strings.TrimSpace(values[0])
	// Cookie-authenticated browser requests must originate from this HTTPS
	// origin. Native key clients take the unchanged no-assertion path.
	if origin := c.GetHeader("Origin"); origin != "" && origin != "https://"+c.Request.Host {
		cfDeny(c)
		return true
	}
	if c.GetHeader("Sec-Fetch-Site") == "cross-site" {
		cfDeny(c)
		return true
	}
	env := cfLoadEnv()
	if !env.enabled() {
		log.Warn("management: cloudflare access assertion present but CLOUDFLARE_ACCESS_TEAM/CLOUDFLARE_ACCESS_AUD not configured; denying")
		cfDeny(c)
		return true
	}
	_, err := cfVerifyAssertion(c.Request.Context(), assertion)
	if err != nil {
		log.Warn("management: cloudflare access assertion denied")
		cfDeny(c)
		return true
	}
	log.Debug("management: cloudflare access assertion accepted")
	c.Next()
	return true
}
