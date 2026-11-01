package opencode

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - inference headers: packages/core/src/session/model-request.ts
//     (the http.headers block in SessionModelRequest)
//   - user agent: packages/core/src/app.ts (App.useragent: opencode/<channel>/<version>/<name>)
//   - body compilation: packages/ai/src/protocols/openai-chat.ts (fromRequest)
//   - zai compatibility: packages/ai/src/protocols/zai-chat.ts (the compatibility
//     record the Console's opencode provider configures for GLM-family models)
//
// The header set is the native 2.x set exactly: no x-org-id on inference
// (that header belongs to Console API calls; model-request.ts does not send
// it), and the session headers name identities a real OpenCode session owns.

// AppInfo is the native App.Info triple the user agent reports. The plugin is
// configured with the version/channel of the OpenCode runtime this deployment
// actually represents; it never invents a version. Name is the native
// artifact name ("cli" for the CLI).
type AppInfo struct {
	Name    string
	Version string
	Channel string
}

// UserAgent reproduces the native App.useragent format
// (app.ts: `opencode/${app.channel}/${app.version}/${app.name}`).
func UserAgent(app AppInfo) string {
	name := strings.TrimSpace(app.Name)
	if name == "" {
		name = "cli"
	}
	return "opencode/" + strings.TrimSpace(app.Channel) + "/" + strings.TrimSpace(app.Version) + "/" + name
}

// InferenceHeaders builds the native inference request headers
// (model-request.ts: http.headers). sessionID is the real OpenCode session
// identity; affinity is the native SessionAffinity.get() value. Both must
// belong to an actual OpenCode session — this plugin does not mint
// client-looking identities.
func InferenceHeaders(app AppInfo, sessionID, affinity, projectID string, authorization string) map[string][]string {
	if affinity == "" {
		affinity = sessionID
	}
	if projectID == "" {
		// Native sessions carry a resolved project id; "global" is the native
		// fallback identity for the global project (schema/project-id.ts).
		projectID = "global"
	}
	headers := map[string][]string{
		"authorization":         {authorization},
		"user-agent":            {UserAgent(app)},
		"x-opencode-session-id": {sessionID},
		"x-session-affinity":    {affinity},
		"X-Session-Id":          {affinity},
		"x-opencode-session":    {affinity},
		"x-opencode-project":    {projectID},
		"x-opencode-client":     {strings.TrimSpace(app.Name)},
		"content-type":          {"application/json"},
		"accept":                {"text/event-stream"},
	}
	return headers
}

// UpstreamModelID strips a public "opencode/" model prefix when present; the
// upstream inference API knows bare model ids (the native catalog serves
// unprefixed ids and the host routes public aliases itself).
func UpstreamModelID(model string) string {
	trimmed := strings.TrimSpace(model)
	if len(trimmed) >= len("opencode/") && strings.EqualFold(trimmed[:len("opencode/")], "opencode/") {
		return trimmed[len("opencode/"):]
	}
	return trimmed
}

// shapeInferenceRequest applies the native OpenAI-chat body compilation rules
// to an already-chat-completions payload (openai-chat.ts: fromRequest):
//
//   - stream is forced on (Schema.Literal(true); the native compiler always
//     sends stream: true — the CLI serves streamed inference),
//   - stream_options.include_usage defaults to true when absent
//     (fromRequest: streamUsage ?? true),
//   - unknown top-level fields are preserved as-is: the native schema does
//     allow extra request fields to pass through providerOptions, and the
//     plugin never silently drops caller semantics,
//   - session identity is not carried in the body: it is header-only.
//
// Caller tools, messages, tool_choice and every other semantic field are
// preserved untouched; the plugin never injects or fabricates tools.
func shapeInferenceRequest(payload []byte, upstreamModel string) ([]byte, error) {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return nil, fmt.Errorf("opencode request payload is empty")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, fmt.Errorf("opencode request payload is not a JSON object: %w", err)
	}
	if body == nil {
		return nil, fmt.Errorf("opencode request payload must be a JSON object, not null")
	}
	if err := validateDispatchControls(body); err != nil {
		return nil, err
	}
	modelJSON, err := json.Marshal(upstreamModel)
	if err != nil {
		return nil, err
	}
	body["model"] = modelJSON
	// Native: stream is Schema.Literal(true) — the compiler sends it always.
	body["stream"] = json.RawMessage("true")
	// Native: stream_options: { include_usage: true } unless streamUsage
	// compatibility opts out; the Console opencode provider keeps the default.
	if _, ok := body["stream_options"]; !ok {
		body["stream_options"] = json.RawMessage(`{"include_usage":true}`)
	}
	// Session identity is a header identity in the native request
	// (model-request.ts); it never rides in the body.
	delete(body, "session")
	delete(body, "session_id")
	out, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("opencode request shaping failed: %w", err)
	}
	return out, nil
}

// InferenceEndpoint joins the configured inference base URL with the native
// chat-completions path. The native free-tier catalog serves
// https://opencode.ai/inference/openai/v1 (voice.ts baseURL and the audited
// gateway's working endpoint); the completions path is /chat/completions.
func InferenceEndpoint(baseURL string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "", fmt.Errorf("opencode inference base URL is not configured")
	}
	if _, err := secureEndpoint(trimmed); err != nil {
		return "", err
	}
	return trimmed + "/chat/completions", nil
}

// NormalizeHeaderValueList returns the sorted values of a single header so
// tests can compare header sets deterministically.
func NormalizeHeaderValueList(headers map[string][]string, name string) []string {
	values := append([]string(nil), headers[name]...)
	sort.Strings(values)
	return values
}

// validateDispatchControls rejects controls this single-choice, native-stream
// executor cannot honor. It does not clamp limits, repair history, or guess
// model-specific ceilings. Native openai-chat.ts emits exactly one output
// token field and stream_options.include_usage is a required boolean when
// stream_options is present. Unknown provider options remain untouched.
func validateDispatchControls(body map[string]json.RawMessage) error {
	for _, key := range []string{"max_tokens", "max_completion_tokens", "n"} {
		if raw, ok := body[key]; ok {
			var value int64
			if err := json.Unmarshal(raw, &value); err != nil || value <= 0 {
				return fmt.Errorf("opencode %s must be a positive integer", key)
			}
			if key == "n" && value != 1 {
				return fmt.Errorf("opencode executor supports only n=1")
			}
		}
	}
	if _, first := body["max_tokens"]; first {
		if _, second := body["max_completion_tokens"]; second {
			return fmt.Errorf("opencode request must use only one output token limit field")
		}
	}
	if raw, ok := body["stream_options"]; ok {
		var options map[string]json.RawMessage
		if err := json.Unmarshal(raw, &options); err != nil || options == nil {
			return fmt.Errorf("opencode stream_options must be an object")
		}
		var value bool
		usage, exists := options["include_usage"]
		if !exists || string(usage) == "null" || json.Unmarshal(usage, &value) != nil {
			return fmt.Errorf("opencode stream_options.include_usage must be a boolean")
		}
	}
	return nil
}
