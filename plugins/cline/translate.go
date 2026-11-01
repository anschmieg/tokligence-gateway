package cline

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// PublicModelID converts an upstream model id to the host-visible id with the
// "cline/" prefix (idempotent).
func PublicModelID(upstreamID string) string {
	id := strings.TrimSpace(upstreamID)
	if id == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(id), "cline/") {
		return "cline/" + id[len("cline/"):]
	}
	return "cline/" + id
}

// UpstreamModelID strips the public prefix (case-insensitive) so the upstream
// API sees its own id, preserving the model casing after the prefix.
func UpstreamModelID(publicID string) string {
	trimmed := strings.TrimSpace(publicID)
	if len(trimmed) >= len("cline/") && strings.EqualFold(trimmed[:len("cline/")], "cline/") {
		return trimmed[len("cline/"):]
	}
	return trimmed
}

var modelIDPattern = regexp.MustCompile(`^cline/[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidPublicModelID reports whether id is a well-formed public model id.
func ValidPublicModelID(id string) bool {
	return modelIDPattern.MatchString(strings.TrimSpace(id))
}

// TranslateChatRequest converts a chat-completions request payload destined for
// a public cline/ model into the upstream Cline API payload:
//   - the model id loses its cline/ prefix,
//   - max_tokens and max_completion_tokens are floored at MinTokenFloor,
//   - unknown top-level fields are preserved as-is (exact-model requests stay
//     exact; no semantic rewriting).
//
// It returns the translated body and the concrete upstream model id.
func TranslateChatRequest(publicModel string, payload []byte) ([]byte, string, error) {
	publicModel = strings.TrimSpace(publicModel)
	if publicModel == "" {
		return nil, "", fmt.Errorf("cline request has no model")
	}
	if !ValidPublicModelID(publicModel) {
		return nil, "", fmt.Errorf("cline model %q is not a cline/ model", publicModel)
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, "", fmt.Errorf("cline request body is not JSON: %w", err)
	}
	if body == nil {
		body = map[string]any{}
	}
	upstream := UpstreamModelID(publicModel)
	body["model"] = upstream
	for _, field := range []string{"max_tokens", "max_completion_tokens"} {
		if value, ok := body[field].(float64); ok && value < MinTokenFloor {
			body[field] = MinTokenFloor
		}
	}
	translated, err := json.Marshal(body)
	if err != nil {
		return nil, "", fmt.Errorf("cline request translation failed: %w", err)
	}
	return translated, upstream, nil
}

// ChatErrorClassification mirrors the gateway's classifyClineUpstreamError
// contract so quota and cooldown semantics stay identical to the validated
// adapter behavior.
type ChatErrorClassification struct {
	StatusCode int    `json:"status_code"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

// ClassifyUpstreamError maps an upstream status/error body to the gateway's
// cline error taxonomy. It never turns a terminal rejection into a retryable
// condition.
func ClassifyUpstreamError(statusCode int, upstreamBody []byte) ChatErrorClassification {
	status := statusCode
	if status < 400 || status > 599 {
		status = 502
	}
	normalized := strings.ToLower(string(upstreamBody))
	switch {
	case status == 401 || status == 403:
		return ChatErrorClassification{StatusCode: status, Code: "cline_auth_error", Message: "Cline login is missing or expired"}
	case status == 429 && strings.Contains(normalized, "free limit reached on model"):
		return ChatErrorClassification{StatusCode: status, Code: "cline_daily_free_quota_exhausted", Message: "Cline's daily free quota is exhausted for this model"}
	case status == 404 && strings.Contains(normalized, "model not found"):
		return ChatErrorClassification{StatusCode: status, Code: "cline_model_retired", Message: "The requested Cline free model is no longer available"}
	case status == 402:
		return ChatErrorClassification{StatusCode: status, Code: "cline_request_rejected", Message: "Cline rejected this free-model request"}
	default:
		return ChatErrorClassification{StatusCode: status, Code: "cline_upstream_error", Message: "Cline upstream request failed"}
	}
}

// RequestHeaders builds the Cline client headers attached to upstream calls.
// taskID may be empty; a random UUID is substituted by the caller.
func RequestHeaders(taskID string) map[string][]string {
	if strings.TrimSpace(taskID) == "" {
		taskID = "00000000-0000-0000-0000-000000000000"
	}
	return map[string][]string{
		"HTTP-Referer":       {"https://cline.bot"},
		"X-Title":            {"Cline"},
		"User-Agent":         {"Cline/unknown"},
		"X-IS-MULTIROOT":     {"false"},
		"X-CLIENT-TYPE":      {"cline-sdk"},
		"X-CLIENT-VERSION":   {"unknown"},
		"X-PLATFORM":         {"sdk"},
		"X-PLATFORM-VERSION": {"unknown"},
		"X-CORE-VERSION":     {"unknown"},
		"X-Task-ID":          {taskID},
	}
}

// AuthorizationHeader formats the bearer token for upstream calls.
func AuthorizationHeader(accessToken string) string {
	return "Bearer workos:" + strings.TrimPrefix(strings.TrimSpace(accessToken), "workos:")
}
