package opencode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - error classification: packages/core/src/session/to-session-error.ts
//     (QuotaExceeded distinguishes FreeUsageLimitError / BudgetLimitError /
//     GoUsageLimitError from a generic provider quota error)
//   - retry guidance: Retry-After header, integer-seconds form
//
// This plugin stops dispatch on 401/403/429 and reports the upstream status
// and code to the host. The host owns cooldown state; this plugin never
// retries, rotates credentials or switches accounts/lanes after a rejection.

// Upstream status codes that terminate dispatch for this credential.
func IsTerminalStatus(status int) bool {
	return status == http.StatusUnauthorized ||
		status == http.StatusForbidden ||
		status == http.StatusTooManyRequests ||
		status == http.StatusPaymentRequired ||
		status >= 500
}

var upstreamRequestIDCharset = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// upstreamRequestIDHeaders are the response headers the Console uses to
// report the provider request id. The audited gateway adapter reads the same
// order (request-executor.mjs: upstreamRequestId).
var upstreamRequestIDHeaders = []string{"x-opencode-log-id", "x-request-id", "request-id"}

// UpstreamRequestID extracts the provider request id from rejection response
// headers, then the JSON error body. It is bounded to the documented charset
// so arbitrary header junk never enters diagnostics.
func UpstreamRequestID(headers map[string][]string, body []byte) string {
	for _, name := range upstreamRequestIDHeaders {
		for _, value := range headers[name] {
			trimmed := strings.TrimSpace(value)
			if upstreamRequestIDCharset.MatchString(trimmed) {
				return trimmed
			}
		}
	}
	var payload struct {
		Error struct {
			RequestID string `json:"request_id"`
			RequestId string `json:"requestId"`
		} `json:"error"`
		RequestID string `json:"request_id"`
		RequestId string `json:"requestId"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	for _, candidate := range []string{payload.Error.RequestID, payload.Error.RequestId, payload.RequestID, payload.RequestId} {
		trimmed := strings.TrimSpace(candidate)
		if upstreamRequestIDCharset.MatchString(trimmed) {
			return trimmed
		}
	}
	return ""
}

// ParseRetryAfterSeconds extracts upstream retry guidance from the Retry-After
// header. Only the integer-seconds form is honored; HTTP-date values yield
// zero and the host's own cooldown policy applies.
func ParseRetryAfterSeconds(headers map[string][]string) int {
	raw := ""
	for _, name := range []string{"Retry-After", "retry-after"} {
		if values := headers[name]; len(values) > 0 {
			raw = strings.TrimSpace(values[0])
			if raw != "" {
				break
			}
		}
	}
	if raw == "" {
		return 0
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 0
	}
	return seconds
}

// Rejection is a terminal upstream rejection with the detail the host needs
// to surface the native error type and cooldown.
type Rejection struct {
	StatusCode  int
	Code        string
	Message     string
	RetryAfterS int
	RequestID   string
	Detail      string
}

// Error implements error.
func (r *Rejection) Error() string {
	parts := []string{fmt.Sprintf("opencode upstream returned HTTP %d", r.StatusCode)}
	if r.Code != "" {
		parts = append(parts, r.Code)
	}
	if r.Message != "" {
		parts = append(parts, r.Message)
	}
	if r.RequestID != "" {
		parts = append(parts, "request id "+r.RequestID)
	}
	return strings.Join(parts, ": ")
}

// freeUsageLimitMessage mirrors the native FREE_USAGE_LIMIT_MESSAGE
// (to-session-error.ts): the message the native CLI shows for a
// FreeUsageLimitError 429.
const freeUsageLimitMessage = "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models."

// goUsageLimitMessage mirrors the native goLimit() format.
func goUsageLimitMessage(limitName string) string {
	if limitName == "" {
		return "OpenCode Go usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going."
	}
	return fmt.Sprintf("OpenCode Go %s usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.", limitName)
}

// budgetLimitMessage mirrors the native BUDGET_LIMIT_MESSAGE.
const budgetLimitMessage = "Workspace usage limit reached. Model use is paused until the limit resets."

// modelBudgetLimitMessage mirrors the native MODEL_BUDGET_LIMIT_MESSAGE.
const modelBudgetLimitMessage = "You've reached the spend limit for this model. Switch models to keep going."

var goLimitNamePattern = regexp.MustCompile(`"limitName"\s*:\s*"([^"]+)"`)
var modelBudgetCoveragePattern = regexp.MustCompile(`"coverage"\s*:\s*"models"`)

// ClassifyRejection builds a Rejection from a terminal upstream response,
// porting the native toSessionError QuotaExceeded classification
// (to-session-error.ts):
//   - body containing FreeUsageLimitError  -> provider.free-limit with the
//     native free-limit message,
//   - BudgetLimitError with coverage models -> provider.model-budget-limit,
//   - BudgetLimitError otherwise           -> provider.budget-limit,
//   - GoUsageLimitError                    -> provider.go-limit with the
//     recorded limit name,
//   - any other 4xx/5xx                    -> provider.quota / auth /
//     rate-limit codes.
func ClassifyRejection(status int, headers map[string][]string, body []byte) *Rejection {
	detail := ""
	if len(body) <= 2048 {
		detail = strings.TrimSpace(string(body))
	}
	rejection := &Rejection{
		StatusCode:  status,
		RetryAfterS: ParseRetryAfterSeconds(headers),
		RequestID:   UpstreamRequestID(headers, body),
		Detail:      detail,
	}
	lowerBody := strings.ToLower(detail)
	switch {
	case strings.Contains(lowerBody, "freeusagelimiterror"):
		rejection.Code = "provider.free-limit"
		rejection.Message = freeUsageLimitMessage
	case strings.Contains(lowerBody, "budgetlimiterror"):
		rejection.Code = "provider.budget-limit"
		rejection.Message = budgetLimitMessage
		if modelBudgetCoveragePattern.MatchString(detail) {
			rejection.Code = "provider.model-budget-limit"
			rejection.Message = modelBudgetLimitMessage
		}
	case strings.Contains(lowerBody, "gousagelimiterror"):
		rejection.Code = "provider.go-limit"
		limitName := ""
		if match := goLimitNamePattern.FindStringSubmatch(detail); len(match) > 1 {
			limitName = match[1]
		}
		rejection.Message = goUsageLimitMessage(limitName)
	case strings.Contains(lowerBody, "creditlimitexceeded"):
		rejection.Code = "provider.quota"
		rejection.Message = "Credit limit exceeded."
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		rejection.Code = "provider.auth"
		rejection.Message = "OpenCode Console rejected the credential."
	case status == http.StatusTooManyRequests:
		rejection.Code = "provider.rate-limit"
		rejection.Message = "OpenCode upstream rate limited the request."
	case status == http.StatusPaymentRequired:
		rejection.Code = "provider.quota"
		rejection.Message = "OpenCode upstream reports the account is out of credit."
	default:
		rejection.Code = "provider.internal"
		rejection.Message = fmt.Sprintf("OpenCode upstream returned HTTP %d.", status)
	}
	return rejection
}

// rejectionStatusError converts a Rejection into the statusError form the
// executor returns to the host, preserving the upstream HTTP status,
// machine-readable code, message and retry-after guidance. The native retry
// classification is not retryable for any of these (SessionRunnerRetry.
// isRetryable returns false for free/go limits); the plugin never retries.
func (r *Rejection) statusError() *statusError {
	message := r.Message
	if message == "" {
		message = r.Error()
	}
	return &statusError{
		status:      r.StatusCode,
		code:        r.Code,
		detail:      message,
		retryAfterS: r.RetryAfterS,
	}
}

// toStatusError wraps err into a statusError carrying the given status when it
// is not already one.
func toStatusError(status int, err error) *statusError {
	if se, ok := err.(*statusError); ok {
		return se
	}
	return &statusError{status: status, code: err.Error()}
}
