// Focused tests for the Cloudflare Access management seal. Everything is
// hermetic: RSA keys and JWKS documents are generated in-test, JWKS fetching
// runs against an injected RoundTripper inside this unit only, and there is
// zero external network contact. The package's TestMain (test_main_test.go)
// already sets gin.TestMode, so no extra TestMain is defined here.
package management

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	cfTestAssertion = "Cf-Access-Jwt-Assertion"
	cfTestAddrCF    = "9.9.9.9:1234"
	cfTestEmail     = "admin@corp.example"
)

// cfTestJWKSResponder is an in-process http.RoundTripper standing in for the
// Cloudflare JWKS endpoint.
type cfTestJWKSResponder struct {
	mu       sync.Mutex
	body     []byte
	status   int    // 0 means 200
	location string // Location header (for redirect fail-closed tests)
	hits     int
	lastURL  string
}

func (r *cfTestJWKSResponder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hits++
	r.lastURL = req.URL.String()
	status := r.status
	if status == 0 {
		status = http.StatusOK
	}
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	if r.location != "" {
		header.Set("Location", r.location)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(string(r.body))),
		Request:    req,
	}, nil
}

func (r *cfTestJWKSResponder) fetchCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hits
}

func (r *cfTestJWKSResponder) lastFetchURL() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastURL
}

// cfTestConfigure swaps in the given environment config and JWKS responder
// for the duration of the test (production variables are restored after).
func cfTestConfigure(t *testing.T, env cfAccessEnv, responder *cfTestJWKSResponder) {
	t.Helper()
	prevEnv := cfEnvOverride
	prevClient := cfHTTPClient
	cfEnvOverride = &env
	cfHTTPClient = &http.Client{
		Timeout: cfJWKSFetchTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: responder,
	}
	t.Cleanup(func() {
		cfEnvOverride = prevEnv
		cfHTTPClient = prevClient
	})
	cfTestClearCache(t)
}

// cfTestClearCache empties the JWKS cache and restores its old contents at
// test end (field-wise restore; the struct is never copied because of its
// embedded mutex).
func cfTestClearCache(t *testing.T) {
	t.Helper()
	cfCache.mu.Lock()
	prevKeys := cfCache.keys
	prevFetchedAt := cfCache.fetchedAt
	prevLastAttempt := cfCache.lastAttempt
	cfCache.keys = nil
	cfCache.fetchedAt = time.Time{}
	cfCache.lastAttempt = time.Time{}
	cfCache.mu.Unlock()
	t.Cleanup(func() {
		cfCache.mu.Lock()
		cfCache.keys = prevKeys
		cfCache.fetchedAt = prevFetchedAt
		cfCache.lastAttempt = prevLastAttempt
		cfCache.mu.Unlock()
	})
}

func cfTestEnv() cfAccessEnv {
	return cfTouchEnv("acme-sso", "aud-xyz", nil)
}

func cfTouchEnv(team, aud string, allowlist map[string]bool) cfAccessEnv {
	return cfAccessEnv{team: team, aud: aud, allowlist: allowlist}
}

func cfTestRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate test RSA key: %v", err)
	}
	return key
}

func cfTestJWK(key *rsa.PrivateKey, kid string) map[string]any {
	return map[string]any{
		"kty": "RSA",
		"kid": kid,
		"alg": "RS256",
		"use": "sig",
		"n":   base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
	}
}

func cfTestJWKSBody(jwks ...map[string]any) []byte {
	body, _ := json.Marshal(map[string]any{"keys": jwks})
	return body
}

// cfTestToken signs a compact JWS with the given header alg/kid and claims.
// A kid of "" omits the kid from the header (for the missing-kid test).
func cfTestToken(t *testing.T, key *rsa.PrivateKey, kid, alg string, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": alg}
	if kid != "" {
		header["kid"] = kid
	}
	headerBytes, _ := json.Marshal(header)
	payloadBytes, _ := json.Marshal(claims)
	h64 := base64.RawURLEncoding.EncodeToString(headerBytes)
	p64 := base64.RawURLEncoding.EncodeToString(payloadBytes)
	digest := sha256.Sum256([]byte(h64 + "." + p64))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign test assertion: %v", err)
	}
	return h64 + "." + p64 + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func cfTestClaims(iss, aud, email string) map[string]any {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": iss,
		"aud": aud,
		"exp": now + 600,
		"nbf": now - 60,
		"iat": now - 60,
	}
	if email != "" {
		claims["email"] = email
	}
	return claims
}

func cfTestInt(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}

func cfTestStr(v any) string {
	s, _ := v.(string)
	return s
}

func cfTestRaw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// cfTestHandler builds a management Handler mirroring the production wiring:
// the test router applies cfAccessGate ahead of the native Middleware exactly
// like the one-anchor integration in handler.go.
func cfTestHandler(envSecret string) *Handler {
	return &Handler{
		failedAttempts:      make(map[string]*attemptInfo),
		envSecret:           envSecret,
		allowRemoteOverride: true,
	}
}

func cfTestRouter(handler *Handler) *gin.Engine {
	router := gin.New()
	native := handler.Middleware()
	router.Use(func(c *gin.Context) {
		if cfAccessGate(c) {
			return
		}
		native(c)
	})
	router.GET("/", func(c *gin.Context) { c.String(http.StatusOK, "next") })
	return router
}

func cfTestRequest(router *gin.Engine, remoteAddr string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remoteAddr
	for h, v := range headers {
		req.Header.Set(h, v)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func cfTestDenialBodyMust(rec *httptest.ResponseRecorder, t *testing.T) {
	t.Helper()
	body := rec.Body.String()
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 denial, got %d with body %q", rec.Code, body)
	}
	if !strings.Contains(body, "cloudflare access authentication failed") {
		t.Fatalf("expected the fixed denial body, got %q", body)
	}
}

func TestCFEnvFromEnv(t *testing.T) {
	t.Run("team and audience required", func(t *testing.T) {
		t.Setenv("CLOUDFLARE_ACCESS_TEAM", "")
		t.Setenv("CLOUDFLARE_ACCESS_AUD", "")
		if env := cfEnvFromEnv(); env.enabled() {
			t.Fatal("nothing configured must not activate")
		}
		t.Setenv("CLOUDFLARE_ACCESS_TEAM", "acme-sso")
		if env := cfEnvFromEnv(); env.enabled() {
			t.Fatal("empty audience must not activate")
		}
		t.Setenv("CLOUDFLARE_ACCESS_AUD", "aud-xyz")
		env := cfEnvFromEnv()
		if !env.enabled() {
			t.Fatal("valid team+aud must activate")
		}
		if want := "https://acme-sso.cloudflareaccess.com"; env.issuer() != want {
			t.Fatalf("issuer %q, want %q", env.issuer(), want)
		}
		if want := env.issuer() + "/cdn-cgi/access/certs"; env.jwksURL() != want {
			t.Fatalf("jwks URL %q, want %q", env.jwksURL(), want)
		}
	})

	t.Run("team is a DNS label only", func(t *testing.T) {
		t.Setenv("CLOUDFLARE_ACCESS_AUD", "aud-xyz")
		for _, team := range []string{"", "-acme", "acme-", "Acme", "a b", "acme.com", "acme_sso", strings.Repeat("a", 64)} {
			t.Setenv("CLOUDFLARE_ACCESS_TEAM", team)
			if env := cfEnvFromEnv(); env.enabled() {
				t.Errorf("team %q must not activate", team)
			}
			if env := cfEnvFromEnv(); env.team != "" {
				t.Errorf("team %q must not be accepted", team)
			}
		}
		for _, team := range []string{"acme", "acme-sso", "acme123", strings.Repeat("a", 63)} {
			t.Setenv("CLOUDFLARE_ACCESS_TEAM", team)
			if env := cfEnvFromEnv(); env.team != team {
				t.Errorf("team %q must be accepted", team)
			}
		}
	})

	t.Run("optional exact email allowlist", func(t *testing.T) {
		t.Setenv("CLOUDFLARE_ACCESS_TEAM", "acme-sso")
		t.Setenv("CLOUDFLARE_ACCESS_AUD", "aud-xyz")
		t.Setenv("CLOUDFLARE_ACCESS_ALLOWED_EMAILS", "")
		if env := cfEnvFromEnv(); env.allowlist != nil {
			t.Fatalf("empty allowlist env must stay nil, got %v", env.allowlist)
		}
		t.Setenv("CLOUDFLARE_ACCESS_ALLOWED_EMAILS", "Admin@Corp.Example, guest@corp.example ,")
		env := cfEnvFromEnv()
		if len(env.allowlist) != 2 || !env.allowlist["admin@corp.example"] || !env.allowlist["guest@corp.example"] {
			t.Fatalf("allowlist parse mismatch: %v", env.allowlist)
		}
	})
}

func TestCFVerifyClaims(t *testing.T) {
	env := cfTestEnv()
	cases := []struct {
		name      string
		allowlist map[string]bool
		mut       func(claims map[string]any)
		wantOK    bool
	}{
		{"valid", nil, nil, true},
		{"audience as list", nil, func(c map[string]any) { c["aud"] = []string{"aud-xyz", "other-aud"} }, true},
		{"wrong issuer", nil, func(c map[string]any) { c["iss"] = "https://evil.cloudflareaccess.com" }, false},
		{"missing issuer", nil, func(c map[string]any) { delete(c, "iss") }, false},
		{"wrong audience", nil, func(c map[string]any) { c["aud"] = "aud-other" }, false},
		{"expired exp", nil, func(c map[string]any) { c["exp"] = time.Now().Unix() - 600 }, false},
		{"nbf in the future", nil, func(c map[string]any) { c["nbf"] = time.Now().Unix() + 600 }, false},
		{"iat in the future", nil, func(c map[string]any) { c["iat"] = time.Now().Unix() + 600 }, false},
		{"missing exp", nil, func(c map[string]any) { delete(c, "exp") }, false},
		{"missing nbf", nil, func(c map[string]any) { delete(c, "nbf") }, false},
		{"missing iat", nil, func(c map[string]any) { delete(c, "iat") }, false},
		{"missing email claim", nil, func(c map[string]any) { delete(c, "email") }, false},
		{"blank email claim", nil, func(c map[string]any) { c["email"] = "   " }, false},
		{"allowlist match", map[string]bool{"admin@corp.example": true}, nil, true},
		{"allowlist mismatch", map[string]bool{"other@corp.example": true}, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := cfTestClaims(env.issuer(), env.aud, cfTestEmail)
			if tc.mut != nil {
				tc.mut(claims)
			}
			caseEnv := cfTouchEnv(env.team, env.aud, tc.allowlist)
			err := cfVerifyClaims(caseEnv, cfTestStr(claims["iss"]), cfTestRaw(claims["aud"]), cfTestInt(claims["exp"]), cfTestInt(claims["nbf"]), cfTestInt(claims["iat"]), cfTestStr(claims["email"]))
			if tc.wantOK && err != nil {
				t.Fatalf("expected acceptance, got error: %v", err)
			}
			if !tc.wantOK && err == nil {
				t.Fatal("expected denial, got none")
			}
		})
	}
}

func TestCFAccessValidAssertionGrantsNext(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	token := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	router := cfTestRouter(cfTestHandler("")) // no management key configured at all
	rec := cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: token})
	if rec.Code != http.StatusOK || rec.Body.String() != "next" {
		t.Fatalf("valid assertion must reach the handler without a management key, got %d %q", rec.Code, rec.Body.String())
	}
	if n := responder.fetchCount(); n != 1 {
		t.Fatalf("expected exactly one JWKS fetch, got %d", n)
	}
	if url := responder.lastFetchURL(); url != env.jwksURL() {
		t.Fatalf("JWKS fetch URL %q, want the fixed %q", url, env.jwksURL())
	}
}

func TestCFAccessInvalidSignatureNoKeyFallback(t *testing.T) {
	env := cfTestEnv()
	correctKey := cfTestRSAKey(t)
	attackerKey := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(correctKey, "kid-a"))}
	cfTestConfigure(t, env, responder)

	// kid matches the deployed JWKS key, but the assertion is signed by an
	// attacker key; even a perfectly valid management key must not be used.
	token := cfTestToken(t, attackerKey, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	router := cfTestRouter(cfTestHandler("k1"))
	rec := cfTestRequest(router, cfTestAddrCF, map[string]string{
		"X-Management-Key": "k1", // the REAL management key
		cfTestAssertion:    token,
	})
	cfTestDenialBodyMust(rec, t)
	if strings.Contains(rec.Body.String(), "management key") {
		t.Fatalf("invalid assertion must not leak into the native key path: %q", rec.Body.String())
	}
}

func TestCFAccessAssertionFailures(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	cases := []struct {
		name    string
		headers map[string]string
		mut     func(claims map[string]any)
	}{
		{"wrong issuer", nil, func(c map[string]any) { c["iss"] = "https://evil.cloudflareaccess.com" }},
		{"wrong audience", nil, func(c map[string]any) { c["aud"] = "aud-other" }},
		{"expired exp", nil, func(c map[string]any) { c["exp"] = time.Now().Unix() - 600 }},
		{"nbf in the future", nil, func(c map[string]any) { c["nbf"] = time.Now().Unix() + 600 }},
		{"missing email claim with spoofed headers", map[string]string{
			// Untrusted Cloudflare headers are NEVER consulted; a signed
			// assertion without the email claim is denied regardless.
			"Cf-Access-Email": cfTestEmail,
			"Cf-Access-Id":    "acme-sso/spoofed-id",
		}, func(c map[string]any) { delete(c, "email") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := cfTestClaims(env.issuer(), env.aud, cfTestEmail)
			if tc.mut != nil {
				tc.mut(claims)
			}
			token := cfTestToken(t, key, "kid-a", "RS256", claims)
			headers := map[string]string{cfTestAssertion: token}
			for h, v := range tc.headers {
				headers[h] = v
			}
			rec := cfTestRequest(cfTestRouter(cfTestHandler("")), "10.1.1.1:1111", headers)
			cfTestDenialBodyMust(rec, t)
			if strings.Contains(rec.Body.String(), "management key") {
				t.Fatalf("denied assertion must not fall back to the native key path: %q", rec.Body.String())
			}
		})
	}
	// Claim failures resolve from the fresh cache; no extra fetches happen.
	if n := responder.fetchCount(); n != 1 {
		t.Fatalf("claim-level denials must not trigger JWKS refetches, got %d", n)
	}
}

func TestCFAccessUnknownKidPaced(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	router := cfTestRouter(cfTestHandler(""))
	unknownToken := cfTestToken(t, key, "kid-b", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	knownToken := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))

	rec := cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: unknownToken})
	cfTestDenialBodyMust(rec, t) // first unknown kid triggers the single fetch
	if n := responder.fetchCount(); n != 1 {
		t.Fatalf("expected one fetch, got %d", n)
	}
	rec = cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: knownToken})
	if rec.Code != http.StatusOK || rec.Body.String() != "next" {
		t.Fatalf("known kid token must pass after the fetch, got %d %q", rec.Code, rec.Body.String())
	}
	rec = cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: unknownToken})
	cfTestDenialBodyMust(rec, t) // fresh cache: unknown kid refresh is a no-op, no pacing hammer
	if n := responder.fetchCount(); n != 1 {
		t.Fatalf("unknown kid against a fresh cache must not refetch, got %d fetches", n)
	}
}

func TestCFAccessRedirectFailClosed(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{
		body:     cfTestJWKSBody(cfTestJWK(key, "kid-a")),
		status:   http.StatusFound,
		location: "https://attacker.invalid/certs",
	}
	cfTestConfigure(t, env, responder)

	token := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	rec := cfTestRequest(cfTestRouter(cfTestHandler("")), cfTestAddrCF, map[string]string{cfTestAssertion: token})
	cfTestDenialBodyMust(rec, t)
	if n := responder.fetchCount(); n != 1 {
		t.Fatalf("redirect response must be a single roundtrip, got %d", n)
	}
}

func TestCFAccessLowCostDenials(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	cases := []struct {
		name    string
		tokenIn func() string
	}{
		{"HS256 alg", func() string {
			return cfTestToken(t, key, "kid-a", "HS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
		}},
		{"none alg", func() string {
			return cfTestToken(t, key, "kid-a", "none", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
		}},
		{"missing kid", func() string {
			return cfTestToken(t, key, "", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
		}},
		{"not a compact JWS", func() string { return "segment-one.segment-two" }},
		{"oversized assertion", func() string { return strings.Repeat("x", cfMaxAssertionBytes+1) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := cfTestRequest(cfTestRouter(cfTestHandler("")), "10.2.2.2:2222", map[string]string{cfTestAssertion: tc.tokenIn()})
			cfTestDenialBodyMust(rec, t)
			if n := responder.fetchCount(); n != 0 {
				t.Fatalf("header/size denials must fetch nothing, got %d fetches", n)
			}
		})
	}
}

func TestCFAccessAbsencePreservesNativeKeyPath(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	t.Run("valid management key, no jwks contact", func(t *testing.T) {
		rec := cfTestRequest(cfTestRouter(cfTestHandler("k1")), "10.3.3.3:3333", map[string]string{"X-Management-Key": "k1"})
		if rec.Code != http.StatusOK || rec.Body.String() != "next" {
			t.Fatalf("native key path must stay intact without the assertion, got %d %q", rec.Code, rec.Body.String())
		}
		if n := responder.fetchCount(); n != 0 {
			t.Fatalf("absent assertion must never fetch JWKS, got %d", n)
		}
	})
	t.Run("invalid management key stays native deny", func(t *testing.T) {
		rec := cfTestRequest(cfTestRouter(cfTestHandler("k1")), "10.4.4.4:4444", map[string]string{"X-Management-Key": "nope"})
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "management key") {
			t.Fatalf("native denial expected, got %d %q", rec.Code, rec.Body.String())
		}
		if n := responder.fetchCount(); n != 0 {
			t.Fatalf("absent assertion must never fetch JWKS, got %d", n)
		}
	})
	t.Run("no key provided stays native deny", func(t *testing.T) {
		rec := cfTestRequest(cfTestRouter(cfTestHandler("k1")), "10.5.5.5:5555", nil)
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "management key") {
			t.Fatalf("native denial expected, got %d %q", rec.Code, rec.Body.String())
		}
	})
}

func TestCFAccessEmailAllowlistMiddleware(t *testing.T) {
	env := cfTouchEnv("acme-sso", "aud-xyz", map[string]bool{"admin@corp.example": true})
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)

	router := cfTestRouter(cfTestHandler(""))
	allowed := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	rec := cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: allowed})
	if rec.Code != http.StatusOK || rec.Body.String() != "next" {
		t.Fatalf("allowlisted email must pass, got %d %q", rec.Code, rec.Body.String())
	}
	foreign := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, "guest@corp.example"))
	rec = cfTestRequest(router, "10.6.6.6:6666", map[string]string{cfTestAssertion: foreign})
	cfTestDenialBodyMust(rec, t)
}

func TestCFExpiredCachedKeyCannotAuthenticateWhenRefreshFails(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "kid-a"))}
	cfTestConfigure(t, env, responder)
	token := cfTestToken(t, key, "kid-a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	router := cfTestRouter(cfTestHandler(""))
	if got := cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: token}); got.Code != 200 {
		t.Fatal(got.Code)
	}
	cfCache.mu.Lock()
	cfCache.fetchedAt = time.Now().Add(-2 * cfJWKSTTL)
	cfCache.lastAttempt = time.Now().Add(-2 * cfJWKSMinRefreshInterval)
	cfCache.mu.Unlock()
	responder.mu.Lock()
	responder.status = 503
	responder.mu.Unlock()
	cfTestDenialBodyMust(cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: token}), t)
	if responder.fetchCount() != 2 {
		t.Fatal("expired cache did not attempt bounded refresh")
	}
}

func TestCFRotatedKidRefreshesAfterPacingEvenWithFreshOldKeys(t *testing.T) {
	env := cfTestEnv()
	a := cfTestRSAKey(t)
	b := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(a, "a"))}
	cfTestConfigure(t, env, responder)
	router := cfTestRouter(cfTestHandler(""))
	token := cfTestToken(t, a, "a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	if cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: token}).Code != 200 {
		t.Fatal("initial key denied")
	}
	responder.mu.Lock()
	responder.body = cfTestJWKSBody(cfTestJWK(b, "b"))
	responder.mu.Unlock()
	cfCache.mu.Lock()
	cfCache.lastAttempt = time.Now().Add(-2 * cfJWKSMinRefreshInterval)
	cfCache.mu.Unlock()
	token = cfTestToken(t, b, "b", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	if cfTestRequest(router, cfTestAddrCF, map[string]string{cfTestAssertion: token}).Code != 200 {
		t.Fatal("legitimate rotation not discovered")
	}
	if responder.fetchCount() != 2 {
		t.Fatal("rotation dispatch accounting differs")
	}
}

func TestCFActualMiddlewareRequiresSameOriginAndNonemptySingleAssertion(t *testing.T) {
	env := cfTestEnv()
	key := cfTestRSAKey(t)
	responder := &cfTestJWKSResponder{body: cfTestJWKSBody(cfTestJWK(key, "a"))}
	cfTestConfigure(t, env, responder)
	token := cfTestToken(t, key, "a", "RS256", cfTestClaims(env.issuer(), env.aud, cfTestEmail))
	router := gin.New()
	router.Use(cfTestHandler("fixture-key").Middleware())
	router.POST("/", func(c *gin.Context) { c.String(200, "next") })
	for _, tc := range []struct {
		origin, site string
		values       []string
		want         int
	}{
		{"https://code.nothing.pink", "same-origin", []string{token}, 200},
		{"https://evil.example", "cross-site", []string{token}, 401},
		{"", "cross-site", []string{token}, 401},
		{"", "", []string{""}, 401},
		{"", "", []string{token, token}, 401},
	} {
		req := httptest.NewRequest("POST", "https://code.nothing.pink/", nil)
		req.RemoteAddr = cfTestAddrCF
		req.Header[http.CanonicalHeaderKey(cfTestAssertion)] = tc.values
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Sec-Fetch-Site", tc.site)
		req.Header.Set("X-Management-Key", "fixture-key")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("origin %q site %q: status %d want %d", tc.origin, tc.site, rec.Code, tc.want)
		}
	}
}
