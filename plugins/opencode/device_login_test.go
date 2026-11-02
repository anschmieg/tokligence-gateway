package opencode

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Focused tests for the native device login manager. The transport is a
// fake: scripted URL-suffix responses, recorded calls and context callback
// IDs. No network, no real clocks (each test drives a scriptable clock).

type loginTransport struct {
	mu          sync.Mutex
	calls       []recordedCall
	callbackIDs []string
	scripts     map[string]func(recordedCall) (HTTPResult, error)
}

func (t *loginTransport) Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error) {
	t.mu.Lock()
	call := recordedCall{Method: method, URL: url, Headers: headers, Body: body}
	t.calls = append(t.calls, call)
	t.callbackIDs = append(t.callbackIDs, HostCallbackIDFromContext(ctx))
	fn := t.scripts[urlSuffix(url)]
	t.mu.Unlock()
	if fn == nil {
		return HTTPResult{}, fmt.Errorf("unexpected transport call %s %s", method, url)
	}
	return fn(call)
}

func (t *loginTransport) DoStream(context.Context, string, string, map[string][]string, []byte) (StreamResult, error) {
	return StreamResult{}, fmt.Errorf("device login never streams")
}

func (t *loginTransport) CloseStream(StreamResult) {}

func urlSuffix(raw string) string {
	parsed, _ := url.Parse(raw)
	return parsed.Path
}

func (t *loginTransport) callsTo(suffix string) []recordedCall {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []recordedCall
	for _, call := range t.calls {
		if strings.HasSuffix(call.URL, suffix) {
			out = append(out, call)
		}
	}
	return out
}

func (t *loginTransport) tokenPOSTCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	count := 0
	for _, call := range t.calls {
		if call.Method == "POST" && strings.HasSuffix(call.URL, "/auth/device/token") {
			count++
		}
	}
	return count
}

func (t *loginTransport) setScript(suffix string, fn func(recordedCall) (HTTPResult, error)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.scripts[suffix] = fn
}

func jsonResponse(status int, body string) func(recordedCall) (HTTPResult, error) {
	return func(recordedCall) (HTTPResult, error) {
		return HTTPResult{StatusCode: status, Body: []byte(body)}, nil
	}
}

// loginFixture is one scripted manager driven by a stepped fake clock.
type loginFixture struct {
	manager   *DeviceLoginManager
	transport *loginTransport
	clock     *int64
}

func newLoginFixture(t *testing.T, scripts map[string]func(recordedCall) (HTTPResult, error)) loginFixture {
	t.Helper()
	transport := &loginTransport{scripts: scripts}
	fixture := loginFixture{transport: transport, clock: new(int64)}
	fixture.manager = newDeviceLoginManager(transport, "https://console.test", func() int64 { return *fixture.clock })
	return fixture
}

func (f *loginFixture) setClock(ms int64) { *f.clock = ms }
func (f *loginFixture) advance(ms int64)  { *f.clock += ms }
func ctxWithCallback() context.Context    { return WithHostCallbackID(context.Background(), "cb-login-1") }

// deviceCodeScript is the standard scripted start response.
func deviceCodeScript(deviceCode, userCode string) func(recordedCall) (HTTPResult, error) {
	body := fmt.Sprintf(`{"device_code":%q,"user_code":%q,"verification_uri_complete":"https://console.test/device?code=%s","expires_in":600,"interval":5}`, deviceCode, userCode, userCode)
	return jsonResponse(200, body)
}

// TestDeviceLoginHappyPathExactRequest covers Start's exact native start
// body, the opaque state and native metadata, then one token POST per
// eligible poll, bearer/accept follow-ups, native org selection, and state
// consumption against replay.
func TestDeviceLoginHappyPathExactRequest(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-secret-1", "ABCD-1234"),
		"/auth/device/token": jsonResponse(200, `{"access_token":"at1","refresh_token":"rt1","expires_in":3600,"org_id":null}`),
		"/api/user":          jsonResponse(200, `{"id":"u1","email":"user@example.com"}`),
		"/api/orgs":          jsonResponse(200, `[{"id":"o2","name":"Zeta"},{"id":"o1","name":"Alpha"}]`),
	})
	fixture.setClock(1_000_000)

	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if start.Provider != ProviderKey {
		t.Errorf("Provider = %q, want %q", start.Provider, ProviderKey)
	}
	if start.URL != "https://console.test/device?code=ABCD-1234" {
		t.Errorf("URL = %q, want the complete verification URL", start.URL)
	}
	if !strings.HasPrefix(start.State, "odl_") || len(start.State) != len("odl_")+32 {
		t.Errorf("State = %q, want a bounded opaque token", start.State)
	}
	if strings.Contains(start.State, "dc-secret-1") {
		t.Errorf("State must not carry the raw device code")
	}
	if start.ExpiresAt.UnixMilli() != *fixture.clock+600_000 {
		t.Errorf("ExpiresAt = %v, want now+600s", start.ExpiresAt)
	}
	if got, _ := start.Metadata["instructions"].(string); got != "Enter code: ABCD-1234" {
		t.Errorf("Metadata instructions = %v", got)
	}
	if got, _ := start.Metadata["poll_interval"].(int); got != 5 {
		t.Errorf("Metadata poll_interval = %v, want 5", start.Metadata["poll_interval"])
	}
	if got, _ := start.Metadata["user_code"].(string); got != "ABCD-1234" {
		t.Errorf("Metadata user_code = %v", got)
	}
	startCalls := fixture.transport.callsTo("/auth/device/code")
	if len(startCalls) != 1 {
		t.Fatalf("device code request count = %d, want 1", len(startCalls))
	}
	wantBody := `{"client_id":"opencode-cli","supports_org_scope":true}`
	if string(startCalls[0].Body) != wantBody {
		t.Errorf("device code body = %s, want %s", startCalls[0].Body, wantBody)
	}
	if got := startCalls[0].Headers["content-type"]; len(got) != 1 || got[0] != "application/json" {
		t.Errorf("device code content-type = %v", got)
	}
	if got := startCalls[0].Headers["accept"]; len(got) != 1 || got[0] != "application/json" {
		t.Errorf("device code accept = %v", got)
	}

	// Gating: not yet eligible, zero token POSTs.
	poll, err := fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil {
		t.Fatalf("gated Poll() error = %v", err)
	}
	if poll.Status != DeviceLoginStatusPending {
		t.Errorf("gating Status = %q, want pending", poll.Status)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 0 {
		t.Fatalf("gated poll made %d token POSTs, want 0", n)
	}

	// Eligible: exactly one token POST, then the account and org fetches.
	fixture.advance(5_000)
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if poll.Status != DeviceLoginStatusSuccess {
		t.Fatalf("Poll() Status = %q message %q, want success", poll.Status, poll.Message)
	}
	if poll.Auth.FileName != "opencode-login-"+strings.TrimPrefix(start.State, "odl_")+".json" || poll.Auth.ID != ProviderKey+":"+poll.Auth.FileName {
		t.Fatal("login must supply its own non-colliding host credential identity")
	}
	tokenCalls := fixture.transport.callsTo("/auth/device/token")
	if len(tokenCalls) != 1 {
		t.Fatalf("token POST count = %d, want 1", len(tokenCalls))
	}
	wantTokenBody := `{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"dc-secret-1","client_id":"opencode-cli"}`
	if string(tokenCalls[0].Body) != wantTokenBody {
		t.Errorf("token body = %s, want %s", tokenCalls[0].Body, wantTokenBody)
	}
	userCalls := fixture.transport.callsTo("/api/user")
	orgCalls := fixture.transport.callsTo("/api/orgs")
	if len(userCalls) != 1 || len(orgCalls) != 1 {
		t.Fatalf("user/orgs call counts = %d/%d, want 1/1", len(userCalls), len(orgCalls))
	}
	followUps := map[string]recordedCall{"user": userCalls[0], "orgs": orgCalls[0]}
	for name, call := range followUps {
		if call.Method != "GET" {
			t.Errorf("%s method = %s, want GET", name, call.Method)
		}
		auth := call.Headers["authorization"]
		if len(auth) != 1 || auth[0] != "Bearer at1" {
			t.Errorf("%s authorization = %v, want Bearer at1", name, auth)
		}
		accept := call.Headers["accept"]
		if len(accept) != 1 || accept[0] != "application/json" {
			t.Errorf("%s accept = %v, want application/json", name, accept)
		}
	}

	// Native host-compatible auth record: parse the storage envelope.
	if len(poll.Auths) != 1 || poll.Auths[0].Provider != ProviderKey || poll.Auths[0].Label != "OpenCode Console" {
		t.Fatalf("Auths = %+v, want one OpenCode Console auth", poll.Auths)
	}
	credential, err := ParseCredential(poll.Auth.StorageJSON)
	if err != nil {
		t.Fatalf("ParseCredential(storage) error = %v", err)
	}
	if credential.Type != CredentialTypeOAuth || credential.MethodID != MethodDevice {
		t.Errorf("credential type/method = %q/%q", credential.Type, credential.MethodID)
	}
	if credential.Access != "at1" || credential.Refresh != "rt1" {
		t.Errorf("credential tokens = %q/%q", credential.Access, credential.Refresh)
	}
	if credential.Expires != *fixture.clock+3_600_000 {
		t.Errorf("credential expires = %d, want %d", credential.Expires, *fixture.clock+3_600_000)
	}
	metadata, err := credential.CredentialMetadata()
	if err != nil {
		t.Fatalf("CredentialMetadata() error = %v", err)
	}
	if metadata.Server != "https://console.test" || metadata.AccountID != "u1" || metadata.Email != "user@example.com" {
		t.Errorf("credential metadata = %+v", metadata)
	}
	if metadata.OrgID != "o1" || metadata.OrgName != "Alpha" {
		t.Errorf("org selection = %q/%q, want the first org sorted by name", metadata.OrgID, metadata.OrgName)
	}
	if poll.Auth.NextRefreshAfter.UnixMilli() != credential.Expires-DefaultRefreshBufferMs {
		t.Errorf("NextRefreshAfter = %v, want expiry minus the native buffer", poll.Auth.NextRefreshAfter)
	}

	// Replay: the successful state is consumed; the unknown-state outcome.
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil {
		t.Fatalf("replayed Poll() error = %v", err)
	}
	if poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginUnknownMessage {
		t.Errorf("replayed poll = %q/%q, want the fixed unknown-state message", poll.Status, poll.Message)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 1 {
		t.Errorf("replay made extra token POSTs: %d", n)
	}

	// Every transport call carried the per-call callback ID.
	fixture.transport.mu.Lock()
	defer fixture.transport.mu.Unlock()
	for _, id := range fixture.transport.callbackIDs {
		if id != "cb-login-1" {
			t.Errorf("callback ID = %q, want cb-login-1", id)
		}
	}
}

// TestDeviceLoginWaitedPollIsPendingUntilEligible covers interval gating
// and the native slow_down pacing: authorization_pending keeps the current
// wait, slow_down adds a sticky 5s, and every gate skips the POST.
func TestDeviceLoginPendingAndSlowDown(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-2", "XY-77"),
		"/auth/device/token": jsonResponse(200, `{"error":"slow_down"}`),
	})
	fixture.setClock(2_000_000)
	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	// Not eligible yet: pending, no POST.
	poll, err := fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusPending || poll.Message != deviceLoginPendingMessage {
		t.Fatalf("gated poll = %+v/%v, want the pending message", poll, err)
	}
	fixture.advance(5_000)
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusPending {
		t.Fatalf("slow_down poll = %+v/%v, want pending", poll, err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 1 {
		t.Fatalf("token POSTs = %d, want 1", n)
	}

	// The native +5s sticks: the wait is now 10s, so +4s polls stay gated.
	fixture.advance(4_000)
	poll, _ = fixture.manager.Poll(ctxWithCallback(), start.State)
	if poll.Status != DeviceLoginStatusPending || poll.Message != deviceLoginPendingMessage {
		t.Fatalf("+4s poll = %+v, want pending without a POST", poll)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 1 {
		t.Fatalf("too-early poll POSTed again: %d", n)
	}

	// Past the new window the next eligible call POSTs once more, and an
	// authorization_pending keeps the same 10s wait instead of shrinking.
	fixture.transport.setScript("/auth/device/token", jsonResponse(200, `{"error":"authorization_pending"}`))
	fixture.advance(6_000)
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusPending || poll.Message != deviceLoginPendingMessage {
		t.Fatalf("pending poll = %+v/%v", poll, err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 2 {
		t.Fatalf("token POSTs = %d, want 2", n)
	}
	fixture.advance(5_000) // still inside the 10s wait
	if _, err := fixture.manager.Poll(ctxWithCallback(), start.State); err != nil {
		t.Fatalf("waited poll error = %v", err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 2 {
		t.Errorf("poll inside the slow_down wait POSTed: %d", n)
	}
	fixture.advance(5_000)
	if _, err := fixture.manager.Poll(ctxWithCallback(), start.State); err != nil {
		t.Fatalf("poll error = %v", err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 3 {
		t.Errorf("eligible poll count = %d, want 3", n)
	}
}

// TestDeviceLoginDeniedAndUnknown covers the denied terminal outcome, state
// consumption, and unknown/bogus/replayed states, all without a second POST.
func TestDeviceLoginDeniedAndUnknown(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-3", "UD-88"),
		"/auth/device/token": jsonResponse(200, `{"error":"access_denied"}`),
	})
	fixture.setClock(3_000_000)
	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	// Unknown and bogus states never reach the network.
	poll, err := fixture.manager.Poll(ctxWithCallback(), "odl_unknown")
	if err != nil || poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginUnknownMessage {
		t.Fatalf("unknown-state poll = %+v/%v", poll, err)
	}
	poll, err = fixture.manager.Poll(ctxWithCallback(), "\x00bad")
	if err != nil || poll.Message != deviceLoginUnknownMessage {
		t.Fatalf("bogus-state poll = %+v/%v", poll, err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 0 {
		t.Fatalf("stateless polls POSTed %d times, want 0", n)
	}

	fixture.advance(5_000)
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginDeniedMessage {
		t.Fatalf("denied poll = %+v/%v, want the fixed denial message", poll, err)
	}
	// The denied flow is consumed: replay yields the unknown-state outcome.
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginUnknownMessage {
		t.Fatalf("replayed denied poll = %+v/%v", poll, err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 1 {
		t.Fatalf("token POSTs = %d, want 1", n)
	}
}

// TestDeviceLoginExpiry covers local expiry gating: an expired flow fails
// without a token POST and is consumed before the next real attempt.
func TestDeviceLoginExpiry(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code": deviceCodeScript("dc-4", "EX-99"),
	})
	fixture.setClock(4_000_000)
	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if got := start.ExpiresAt.UnixMilli(); got != *fixture.clock+600_000 {
		t.Fatalf("ExpiresAt = %v, want now+600s", start.ExpiresAt)
	}
	fixture.advance(600_000) // now == expiresAt
	poll, err := fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginExpiredMessage {
		t.Fatalf("expired poll = %+v/%v, want the fixed expiry message", poll, err)
	}
	if n := fixture.transport.tokenPOSTCount(); n != 0 {
		t.Fatalf("expired flow POSTed %d times, want 0", n)
	}
	poll, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || poll.Message != deviceLoginUnknownMessage {
		t.Fatalf("replayed expired poll = %+v/%v", poll, err)
	}
}

// TestDeviceLoginOrgSelection covers the requested org_id match and the
// name/id tiebreak of the native sorted default.
func TestDeviceLoginOrgSelection(t *testing.T) {
	run := func(t *testing.T, orgID, orgsJSON string, check func(credentialMetadata)) {
		t.Helper()
		fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
			"/auth/device/code":  deviceCodeScript("dc-5", "OR-11"),
			"/auth/device/token": jsonResponse(200, `{"access_token":"at5","refresh_token":"rt5","expires_in":60,"org_id":`+orgID+`}`),
			"/api/user":          jsonResponse(200, `{"id":"u5","email":"org@example.com"}`),
			"/api/orgs":          jsonResponse(200, orgsJSON),
		})
		fixture.setClock(5_000_000)
		start, err := fixture.manager.Start(ctxWithCallback())
		if err != nil {
			t.Fatalf("Start() error = %v", err)
		}
		fixture.advance(5_000)
		poll, err := fixture.manager.Poll(ctxWithCallback(), start.State)
		if err != nil {
			t.Fatalf("Poll() error = %v", err)
		}
		if poll.Status != DeviceLoginStatusSuccess {
			t.Fatalf("Poll() = %q/%q, want success", poll.Status, poll.Message)
		}
		credential, err := ParseCredential(poll.Auth.StorageJSON)
		if err != nil {
			t.Fatalf("ParseCredential() error = %v", err)
		}
		metadata, err := credential.CredentialMetadata()
		if err != nil {
			t.Fatalf("CredentialMetadata() error = %v", err)
		}
		check(metadata)
	}

	// Requested org_id wins over the sorted default.
	run(t, `"o2"`, `[{"id":"o1","name":"Alpha"},{"id":"o2","name":"Beta"}]`, func(metadata credentialMetadata) {
		if metadata.OrgID != "o2" || metadata.OrgName != "Beta" {
			t.Errorf("requested org = %q/%q, want o2/Beta", metadata.OrgID, metadata.OrgName)
		}
	})
	// Sorted tiebreak by id when names collide.
	run(t, `null`, `[{"id":"b-1","name":"Same"},{"id":"a-1","name":"Same"}]`, func(metadata credentialMetadata) {
		if metadata.OrgID != "a-1" || metadata.OrgName != "Same" {
			t.Errorf("tied org = %q/%q, want a-1/Same", metadata.OrgID, metadata.OrgName)
		}
	})
}

// TestDeviceLoginUnknownRequestedOrg covers the native failure when the
// token names an org the account does not have: fixed sanitized error and
// a consumed state.
func TestDeviceLoginUnknownRequestedOrg(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-7", "UN-22"),
		"/auth/device/token": jsonResponse(200, `{"access_token":"at7","refresh_token":"rt7","expires_in":60,"org_id":"nope"}`),
		"/api/user":          jsonResponse(200, `{"id":"u7","email":"u7@example.com"}`),
		"/api/orgs":          jsonResponse(200, `[{"id":"o1","name":"Alpha"}]`),
	})
	fixture.setClock(6_000_000)
	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	fixture.advance(5_000)
	resp, err := fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil {
		t.Fatalf("unknown-org poll error = %v (want fixed sanitized response)", err)
	}
	if resp.Status != DeviceLoginStatusError || resp.Message != "the OpenCode Console returned an unknown organization" {
		t.Errorf("unknown-org poll = %q/%q", resp.Status, resp.Message)
	}
	// The state was consumed: no duplicate credential attempt is possible.
	resp, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || resp.Message != deviceLoginUnknownMessage {
		t.Errorf("replayed unknown-org poll = %+v/%v", resp, err)
	}
}

// TestDeviceLoginForeignErrorClosesTheFlow covers a foreign error code: one
// fixed sanitized terminal response, state consumed, no echo of the code.
func TestDeviceLoginForeignErrorClosesTheFlow(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-8", "FG-33"),
		"/auth/device/token": jsonResponse(400, `{"error":"weird_internal_code & <html>"}`),
	})
	fixture.setClock(7_000_000)
	start, err := fixture.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	fixture.advance(5_000)
	resp, err := fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil {
		t.Fatalf("foreign-error poll error = %v (want fixed sanitized response)", err)
	}
	if resp.Status != DeviceLoginStatusError || resp.Message != deviceLoginForeignMessage {
		t.Errorf("foreign-error poll = %q/%q", resp.Status, resp.Message)
	}
	resp, err = fixture.manager.Poll(ctxWithCallback(), start.State)
	if err != nil || resp.Message != deviceLoginUnknownMessage {
		t.Errorf("replayed foreign-error poll = %+v/%v", resp, err)
	}
}

// TestDeviceLoginMalformedAndStatusFailures covers malformed bodies and
// upstream status failures: fixed errors, no body leakage, and consumed
// states where a token was minted.
func TestDeviceLoginMalformedAndStatusFailures(t *testing.T) {
	clockBase := int64(8_000_000)

	// Start: upstream 500.
	failing := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code": jsonResponse(500, `<body>please retry</body>`),
	})
	failing.setClock(clockBase)
	_, err := failing.manager.Start(ctxWithCallback())
	if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Errorf("Start() 500 error = %v, want a status-numbered fixed error", err)
	}

	// Start: malformed body.
	broken := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code": jsonResponse(200, `{device`),
	})
	broken.setClock(clockBase)
	_, err = broken.manager.Start(ctxWithCallback())
	if err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf("Start() malformed error = %v", err)
	}

	// Poll: malformed token body.
	mangled := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-9", "MD-44"),
		"/auth/device/token": jsonResponse(400, `not-json`),
	})
	mangled.setClock(clockBase)
	start, err := mangled.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	mangled.advance(5_000)
	_, err = mangled.manager.Poll(ctxWithCallback(), start.State)
	if err == nil || !strings.Contains(err.Error(), "device token response is invalid") {
		t.Errorf("malformed token Poll error = %v", err)
	}

	// The native token union consumes any status: a 400 with error=pending
	// still polls as pending (no fabricated failure).
	pending400 := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-10", "P4-55"),
		"/auth/device/token": jsonResponse(400, `{"error":"authorization_pending"}`),
	})
	pending400.setClock(clockBase)
	startPending, err := pending400.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	pending400.advance(5_000)
	resp, err := pending400.manager.Poll(ctxWithCallback(), startPending.State)
	if err != nil || resp.Status != DeviceLoginStatusPending {
		t.Errorf("400 pending poll = %+v/%v, want pending", resp, err)
	}

	// Follow-up status failure after a minted token: fixed error, consumed.
	trailing := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code":  deviceCodeScript("dc-11", "TF-66"),
		"/auth/device/token": jsonResponse(200, `{"access_token":"at11","refresh_token":"rt11","expires_in":60,"org_id":null}`),
		"/api/user":          jsonResponse(401, `{"_tag":"Unauthorized"}`),
	})
	trailing.setClock(clockBase)
	startAfter, err := trailing.manager.Start(ctxWithCallback())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	trailing.advance(5_000)
	resp, err = trailing.manager.Poll(ctxWithCallback(), startAfter.State)
	if err != nil {
		t.Fatalf("401 follow-up Poll error = %v (want fixed sanitized response)", err)
	}
	if resp.Status != DeviceLoginStatusError || strings.Contains(resp.Message, "Unauthorized") || strings.Contains(resp.Message, "at11") {
		t.Errorf("401 follow-up response = %+v, want a fixed sanitized message", resp)
	}
	resp, err = trailing.manager.Poll(ctxWithCallback(), startAfter.State)
	if err != nil || resp.Message != deviceLoginUnknownMessage {
		t.Errorf("replayed follow-up poll = %+v/%v", resp, err)
	}
	if n := trailing.transport.tokenPOSTCount(); n != 1 {
		t.Errorf("token POSTs after follow-up failure = %d, want 1", n)
	}
}

// TestDeviceLoginBoundedStatesAndClose covers the bounded concurrent state
// cap, distinct opaque states on every Start, and Close.
func TestDeviceLoginBoundedStatesAndClose(t *testing.T) {
	fixture := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
		"/auth/device/code": deviceCodeScript("dc-b", "BS-00"),
	})
	fixture.setClock(9_000_000)

	var states []string
	for i := 0; i < maxDeviceLoginStates+1; i++ {
		start, err := fixture.manager.Start(ctxWithCallback())
		if i == maxDeviceLoginStates {
			if err == nil {
				t.Fatalf("Start() #%d succeeded, want the bounded-state error", i)
			}
			continue
		}
		if err != nil {
			t.Fatalf("Start() #%d error = %v", i, err)
		}
		states = append(states, start.State)
	}
	seen := map[string]bool{}
	for _, state := range states {
		if seen[state] {
			t.Errorf("duplicate opaque state %q", state)
		}
		seen[state] = true
	}

	// Close clears everything.
	fixture.manager.Close()
	for _, state := range states {
		poll, err := fixture.manager.Poll(ctxWithCallback(), state)
		if err != nil || poll.Status != DeviceLoginStatusError || poll.Message != deviceLoginUnknownMessage {
			t.Errorf("post-Close poll = %+v/%v, want the unknown-state outcome", poll, err)
		}
	}
}

func TestDeviceLoginRejectionNeverRepollsOrLeaks(t *testing.T) {
	for _, status := range []int{401, 403, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newLoginFixture(t, map[string]func(recordedCall) (HTTPResult, error){
				"/auth/device/code":  deviceCodeScript("fixture-private", "TEST"),
				"/auth/device/token": jsonResponse(status, `{"error":"authorization_pending"}`),
			})
			start, err := f.manager.Start(ctxWithCallback())
			if err != nil {
				t.Fatal(err)
			}
			f.advance(5000)
			if _, err := f.manager.Poll(ctxWithCallback(), start.State); err == nil {
				t.Fatal("HTTP rejection must be terminal")
			}
			poll, err := f.manager.Poll(ctxWithCallback(), start.State)
			if err != nil || poll.Status != DeviceLoginStatusError || f.transport.tokenPOSTCount() != 1 {
				t.Fatal("rejection retried")
			}
		})
	}
}
