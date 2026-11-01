package opencode

import (
	"net/http"
	"strings"
	"testing"
)

// TestClassifyRejectionMatchesNativeToSessionError pins the error taxonomy
// port of packages/core/src/session/to-session-error.ts: a 429 body carrying
// FreeUsageLimitError classifies as provider.free-limit with the exact
// native FREE_USAGE_LIMIT_MESSAGE; BudgetLimitError and GoUsageLimitError map
// to their native types (the Go limit keeps its recorded limit name); a bare
// 429 stays provider.rate-limit and 401/403 are auth.
func TestClassifyRejectionMatchesNativeToSessionError(t *testing.T) {
	freeBody := `{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}`
	rejection := ClassifyRejection(http.StatusTooManyRequests, map[string][]string{"retry-after": {"3600"}}, []byte(freeBody))
	if rejection.Code != "provider.free-limit" {
		t.Errorf("code = %q, want provider.free-limit", rejection.Code)
	}
	if rejection.Message != freeUsageLimitMessage {
		t.Errorf("message = %q, want the native FREE_USAGE_LIMIT_MESSAGE", rejection.Message)
	}
	if rejection.RetryAfterS != 3600 {
		t.Errorf("retry-after = %d, want 3600", rejection.RetryAfterS)
	}
	if rejection.StatusCode != http.StatusTooManyRequests {
		t.Errorf("status = %d, want preserved 429", rejection.StatusCode)
	}

	goBody := `{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"5 hour"}}`
	rejection = ClassifyRejection(429, nil, []byte(goBody))
	if rejection.Code != "provider.go-limit" {
		t.Errorf("code = %q, want provider.go-limit", rejection.Code)
	}
	if !strings.Contains(rejection.Message, "OpenCode Go 5 hour usage limit reached") {
		t.Errorf("go-limit message = %q, want the native format with the limit name", rejection.Message)
	}

	budgetBody := `{"type":"error","error":{"type":"BudgetLimitError","message":"Workspace limit"}}`
	rejection = ClassifyRejection(429, nil, []byte(budgetBody))
	if rejection.Code != "provider.budget-limit" {
		t.Errorf("code = %q, want provider.budget-limit", rejection.Code)
	}
	modelBudgetBody := `{"type":"error","error":{"type":"BudgetLimitError"},"metadata":{"coverage":"models"}}`
	rejection = ClassifyRejection(429, nil, []byte(modelBudgetBody))
	if rejection.Code != "provider.model-budget-limit" {
		t.Errorf("code = %q, want provider.model-budget-limit when coverage is models", rejection.Code)
	}

	// Unidentified 429: generic rate-limit, never a fabricated FreeUsageLimit
	// (the audited rule: preserve the actual allowlisted error type).
	rejection = ClassifyRejection(429, nil, []byte(`{"error":{"message":"slow down"}}`))
	if rejection.Code != "provider.rate-limit" {
		t.Errorf("unidentified 429 code = %q, want provider.rate-limit", rejection.Code)
	}

	rejection = ClassifyRejection(http.StatusUnauthorized, nil, []byte(`{"error":{"message":"bad token"}}`))
	if rejection.Code != "provider.auth" {
		t.Errorf("401 code = %q, want provider.auth", rejection.Code)
	}
	rejection = ClassifyRejection(http.StatusForbidden, nil, []byte(`{"error":{"message":"no"}}`))
	if rejection.Code != "provider.auth" {
		t.Errorf("403 code = %q, want provider.auth", rejection.Code)
	}
	rejection = ClassifyRejection(500, nil, nil)
	if rejection.Code != "provider.internal" {
		t.Errorf("5xx code = %q, want provider.internal", rejection.Code)
	}
}

// TestUpstreamRequestID pins the request-id extraction order and charset
// bound: x-opencode-log-id, then x-request-id, then request-id, then the
// JSON body's error.request_id / request_id fields.
func TestUpstreamRequestID(t *testing.T) {
	headers := map[string][]string{"x-opencode-log-id": {"01a19696-b57a-7399-bbb8-67cd26f7721d"}}
	if got := UpstreamRequestID(headers, nil); got != "01a19696-b57a-7399-bbb8-67cd26f7721d" {
		t.Errorf("UpstreamRequestID = %q, want the x-opencode-log-id value first", got)
	}
	headers = map[string][]string{"x-request-id": {"req_1"}}
	if got := UpstreamRequestID(headers, nil); got != "req_1" {
		t.Errorf("UpstreamRequestID = %q, want x-request-id fallback", got)
	}
	headers = map[string][]string{"request-id": {"req_2"}}
	if got := UpstreamRequestID(headers, nil); got != "req_2" {
		t.Errorf("UpstreamRequestID = %q, want request-id fallback", got)
	}
	body := []byte(`{"error":{"request_id":"01a19413-3d16-7617-aa8f-e86ccacaa072"}}`)
	if got := UpstreamRequestID(nil, body); got != "01a19413-3d16-7617-aa8f-e86ccacaa072" {
		t.Errorf("UpstreamRequestID(body) = %q, want the body request id", got)
	}
	// Charset bound: junk never enters diagnostics.
	headers = map[string][]string{"x-opencode-log-id": {"bad value with spaces!"}}
	if got := UpstreamRequestID(headers, nil); got != "" {
		t.Errorf("UpstreamRequestID(junk) = %q, want rejected by the charset bound", got)
	}
	if got := UpstreamRequestID(nil, []byte(`{"request_id":"`+strings.Repeat("x", 129)+`"}`)); got != "" {
		t.Errorf("UpstreamRequestID(overlong) = %q, want rejected by the length bound", got)
	}
}

// TestParseRetryAfterSeconds pins the integer-seconds-only Retry-After rule.
func TestParseRetryAfterSeconds(t *testing.T) {
	cases := map[string]int{
		"3600": 3600,
		"45":   45,
		"0":    0,
		"-5":   0,
		"":     0,
	}
	for raw, want := range cases {
		headers := map[string][]string{"Retry-After": {raw}}
		if got := ParseRetryAfterSeconds(headers); got != want {
			t.Errorf("ParseRetryAfterSeconds(%q) = %d, want %d", raw, got, want)
		}
	}
	// HTTP-date form is ignored (zero), matching the bounded rule.
	if got := ParseRetryAfterSeconds(map[string][]string{"Retry-After": {"Wed, 21 Oct 2026 07:28:00 GMT"}}); got != 0 {
		t.Errorf("ParseRetryAfterSeconds(HTTP-date) = %d, want 0", got)
	}
}

// TestIsTerminalStatus pins the fail-closed status set: 401/403/429/402/5xx
// stop dispatch for the credential; no retry exists in this plugin.
func TestIsTerminalStatus(t *testing.T) {
	terminal := []int{401, 403, 429, 402, 500, 502, 503}
	for _, status := range terminal {
		if !IsTerminalStatus(status) {
			t.Errorf("IsTerminalStatus(%d) = false, want true", status)
		}
	}
	nonTerminal := []int{200, 201, 204, 302, 400, 404, 409}
	for _, status := range nonTerminal {
		if IsTerminalStatus(status) {
			t.Errorf("IsTerminalStatus(%d) = true, want false", status)
		}
	}
}

// TestRejectionStatusErrorPreservesUpstreamState pins that a rejection
// converts to the structured error with the upstream status, code and
// retry-after so the host surfaces the client status and records cooldown.
func TestRejectionStatusErrorPreservesUpstreamState(t *testing.T) {
	rejection := ClassifyRejection(429, map[string][]string{"retry-after": {"120"}}, []byte(`{"error":{"type":"FreeUsageLimitError"}}`))
	err := rejection.statusError()
	statusErr, ok := AsStatusError(err)
	if !ok {
		t.Fatalf("AsStatusError(rejection) failed")
	}
	if statusErr.Status() != 429 {
		t.Errorf("Status() = %d, want 429", statusErr.Status())
	}
	if statusErr.Code() != "provider.free-limit" {
		t.Errorf("Code() = %q, want provider.free-limit", statusErr.Code())
	}
	if statusErr.RetryAfterSeconds() != 120 {
		t.Errorf("RetryAfterSeconds() = %d, want 120", statusErr.RetryAfterSeconds())
	}
}
