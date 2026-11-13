package opencode

import (
	"encoding/json"
	"strings"
	"testing"
)

// This file tests the pure public-fallback helpers against non-secret
// fixtures: envelope strictness, the host.auth.list inventory admission
// (through a fake HostCall, no network, no subprocess) and the explicit
// free-model allowlist. No test here provisions, writes or rotates anything.

func mustPublicStorage(t *testing.T) []byte {
	t.Helper()
	raw, err := EncodePublicCredentialStorage()
	if err != nil {
		t.Fatalf("EncodePublicCredentialStorage() error = %v", err)
	}
	if len(raw) == 0 {
		t.Fatalf("EncodePublicCredentialStorage() returned no bytes")
	}
	return raw
}

func testPublicSelfEntry() PublicAuthInventoryEntry {
	return PublicAuthInventoryEntry{
		ID:       PublicCredentialID,
		Name:     PublicCredentialFileName,
		Provider: ProviderKey,
		Type:     ProviderKey,
		Status:   "active",
	}
}

// Envelope: exact shape, no OAuth pretense, no refresh token.

func TestEncodePublicCredentialStorageExactShape(t *testing.T) {
	raw := mustPublicStorage(t)
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if len(root) != 3 {
		t.Fatalf("envelope root keys = %d, want exactly 3 (type/storage_version/credential)", len(root))
	}
	var rootType string
	_ = json.Unmarshal(root["type"], &rootType)
	if rootType != ProviderKey {
		t.Fatalf("root type = %q, want %q", rootType, ProviderKey)
	}
	var version json.Number
	_ = json.Unmarshal(root["storage_version"], &version)
	if version.String() != "1" {
		t.Fatalf("storage_version = %q, want literal 1", version.String())
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(root["credential"], &value); err != nil {
		t.Fatalf("unmarshal credential: %v", err)
	}
	if len(value) != 2 {
		t.Fatalf("credential keys = %d, want exactly 2 (type/access)", len(value))
	}
	var credentialType, credentialAccess string
	_ = json.Unmarshal(value["type"], &credentialType)
	_ = json.Unmarshal(value["access"], &credentialAccess)
	if credentialType != PublicCredentialType || credentialAccess != PublicCredentialAccess {
		t.Fatalf("credential = %q/%q, want %q/%q", credentialType, credentialAccess, PublicCredentialType, PublicCredentialAccess)
	}
	encoded := string(raw)
	if strings.Contains(encoded, CredentialTypeOAuth) {
		t.Fatalf("public envelope must never name the OAuth type: %s", encoded)
	}
	if strings.Contains(encoded, "refresh") {
		t.Fatalf("public envelope must never carry a refresh token field: %s", encoded)
	}
	if strings.Contains(encoded, "api_key") || strings.Contains(encoded, "apiKey") {
		t.Fatalf("public envelope must never carry an api key field: %s", encoded)
	}
}

// IsPublicCredentialStorage: strict shape, no arbitrary keys or API keys.

func TestIsPublicCredentialStorageRoundTripsCanonicalOnly(t *testing.T) {
	raw := mustPublicStorage(t)
	if !IsPublicCredentialStorage(raw) {
		t.Fatalf("canonical public envelope rejected")
	}
	// The OAuth parser declines this shape: public mode must stay out of the
	// refresh path.
	if _, err := ParseCredential(raw); err == nil {
		t.Fatalf("ParseCredential accepted a public envelope as OAuth storage")
	}
}

func TestIsPublicCredentialStorageStrictness(t *testing.T) {
	cases := map[string][]byte{
		"empty":                 {},
		"whitespace":            {' '},
		"garbage":               []byte("{not json"),
		"oauth_credential":      []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"oauth","access":"tok","refresh":"r"}`),
		"array":                 []byte(`[]`),
		"null":                  []byte(`null`),
		"wrong_root_type":       []byte(`{"type":"other","storage_version":1,"credential":{"type":"public","access":"public"}}`),
		"wrong_version":         []byte(`{"type":"opencode","storage_version":2,"credential":{"type":"public","access":"public"}}`),
		"version_string":        []byte(`{"type":"opencode","storage_version":"1","credential":{"type":"public","access":"public"}}`),
		"version_float":         []byte(`{"type":"opencode","storage_version":1.0,"credential":{"type":"public","access":"public"}}`),
		"missing_version":       []byte(`{"type":"opencode","credential":{"type":"public","access":"public"}}`),
		"extra_root_key":        []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":"public"},"note":"x"}`),
		"extra_oauth_provider":  []byte(`{"type":"opencode","storage_version":1,"oauth_provider":"opencode","credential":{"type":"public","access":"public"}}`),
		"extra_credential_key":  []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":"public","api_key":"sk-real"}}`),
		"api_key_access":        []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":"sk-real"}}`),
		"access_number":         []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":1}}`),
		"access_null":           []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":null}}`),
		"refresh_in_credential": []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"public","access":"public","refresh":"r"}}`),
		"type_case_mismatch":    []byte(`{"type":"opencode","storage_version":1,"credential":{"type":"Public","access":"public"}}`),
	}
	for name, raw := range cases {
		if IsPublicCredentialStorage(raw) {
			t.Fatalf("case %q: accepted a non-canonical storage", name)
		}
	}
}

// SelectPublicCredential: inventory cases.

func TestSelectPublicCredentialSelfOnlyAdmitted(t *testing.T) {
	entries := []PublicAuthInventoryEntry{
		testPublicSelfEntry(),
		{ID: "claude:claude.json", Name: "claude.json", Provider: "claude", Type: "claude", Status: "active"},
		{ID: "antigravity:a.json", Name: "a.json", Provider: "antigravity", Type: "antigravity", Status: "error", Unavailable: true},
	}
	got := SelectPublicCredential(entries, false, false)
	if !got.Admitted || got.Reason != PublicCredentialAdmissionAdmitted {
		t.Fatalf("self-only admission = %+v, want admitted", got)
	}
}

func TestSelectPublicCredentialForeignOnlyAbsent(t *testing.T) {
	entries := []PublicAuthInventoryEntry{
		{ID: "openai:o.json", Name: "o.json", Provider: "openai", Type: "openai", Status: "active"},
		{ID: "claude:c.json", Name: "c.json", Provider: "claude", Type: "claude", Status: "active"},
	}
	got := SelectPublicCredential(entries, false, false)
	if got.Admitted {
		t.Fatalf("foreign-only inventory admitted the public fallback")
	}
	if got.Reason != PublicCredentialAdmissionAbsent {
		t.Fatalf("reason = %q, want %q (absence is normal)", got.Reason, PublicCredentialAdmissionAbsent)
	}
}

func TestSelectPublicCredentialEmptyInventoryAbsent(t *testing.T) {
	got := SelectPublicCredential(nil, false, false)
	if got.Admitted || got.Reason != PublicCredentialAdmissionAbsent {
		t.Fatalf("empty inventory = %+v, want absent", got)
	}
}

func TestSelectPublicCredentialHealthyOAuthBlocks(t *testing.T) {
	// The deployed working OAuth 0.3.0 credential: the canonical self record
	// can never appear next to it.
	entries := []PublicAuthInventoryEntry{
		testPublicSelfEntry(),
		{ID: ProviderKey + ":" + ProviderKey + ".json", Name: ProviderKey + ".json", Provider: ProviderKey, Type: ProviderKey, Status: "active"},
	}
	got := SelectPublicCredential(entries, false, false)
	if got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("healthy OAuth record did not block: %+v", got)
	}
}

func TestSelectPublicCredentialOAuthAloneBlocks(t *testing.T) {
	entries := []PublicAuthInventoryEntry{
		{ID: ProviderKey + ":" + ProviderKey + ".json", Name: ProviderKey + ".json", Provider: ProviderKey, Type: ProviderKey, Status: "active"},
	}
	got := SelectPublicCredential(entries, false, false)
	if got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("OAuth record alone did not block: %+v", got)
	}
}

func TestSelectPublicCredentialOAuthEveryStateBlocks(t *testing.T) {
	// A disabled, expired/unavailable, erroring or unknown-state opencode
	// record still proves a credential key source exists; public mode never
	// applies in any of them.
	for _, entry := range []PublicAuthInventoryEntry{
		{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey, Status: "disabled", Disabled: true},
		{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey, Status: "error", Unavailable: true},
		{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey, Status: "unknown"},
		{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey},
	} {
		got := SelectPublicCredential([]PublicAuthInventoryEntry{entry}, false, false)
		if got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
			t.Fatalf("opencode record %+v did not block: %+v", entry, got)
		}
	}
}

func TestSelectPublicCredentialOtherOpencodeSpellingBlocks(t *testing.T) {
	// Same canonical file name with a different (inconsistent) id, or a
	// different file name with the canonical id, is not the self record.
	entries := []PublicAuthInventoryEntry{
		{ID: ProviderKey + ":weird-id", Name: PublicCredentialFileName, Provider: ProviderKey, Type: ProviderKey, Status: "active"},
	}
	if got := SelectPublicCredential(entries, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("canonical name with foreign id did not block: %+v", got)
	}
	entries = []PublicAuthInventoryEntry{
		{ID: PublicCredentialID, Name: "renamed.json", Provider: ProviderKey, Type: ProviderKey, Status: "active"},
	}
	if got := SelectPublicCredential(entries, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("canonical id with foreign name did not block: %+v", got)
	}
}

func TestSelectPublicCredentialDuplicateSelfBlocks(t *testing.T) {
	entries := []PublicAuthInventoryEntry{testPublicSelfEntry(), testPublicSelfEntry()}
	got := SelectPublicCredential(entries, false, false)
	if got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("duplicate self record did not block: %+v", got)
	}
}

func TestSelectPublicCredentialSelfUnhealthyBlocks(t *testing.T) {
	for _, disabled := range []bool{true} {
		entry := testPublicSelfEntry()
		entry.Disabled = disabled
		if got := SelectPublicCredential([]PublicAuthInventoryEntry{entry}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionUnhealthy {
			t.Fatalf("disabled self record did not block: %+v", got)
		}
	}
	entry := testPublicSelfEntry()
	entry.Unavailable = true
	if got := SelectPublicCredential([]PublicAuthInventoryEntry{entry}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionUnhealthy {
		t.Fatalf("unavailable self record did not block: %+v", got)
	}
	for _, status := range []string{"error", "disabled", "unknown", "expired", "", "pending"} {
		entry := testPublicSelfEntry()
		entry.Status = status
		if got := SelectPublicCredential([]PublicAuthInventoryEntry{entry}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionUnhealthy {
			t.Fatalf("self record with status %q did not block: %+v", status, got)
		}
	}
}

func TestSelectPublicCredentialDisabledFalseStillBlocks(t *testing.T) {
	// "disabled: false" (explicit or wire-omitted) is an opencode record that
	// exists — it is not absence and must not let the fallback through.
	// The wire shape (omitempty) omits the false flag entirely; the decision
	// is positive-only.
	disabledFalse := PublicAuthInventoryEntry{
		ID: PublicCredentialID, Name: PublicCredentialFileName,
		Provider: ProviderKey, Type: ProviderKey, Status: "active",
	}
	raw, err := json.Marshal(disabledFalse)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "disabled") {
		t.Fatalf("fixture should mirror the host wire (omitempty drops disabled=false): %s", raw)
	}
	var decoded PublicAuthInventoryEntry
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := SelectPublicCredential([]PublicAuthInventoryEntry{decoded}, false, false)
	if !got.Admitted {
		t.Fatalf("disabled=false self record must be handled by the active/healthy check, not treated as absence: %+v", got)
	}
	// The same false flag on a foreign-opencode OAuth record still blocks.
	oauth := disabledFalse
	oauth.ID = ProviderKey + ":" + ProviderKey + ".json"
	oauth.Name = ProviderKey + ".json"
	rawOauth, err := json.Marshal(oauth)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decodedOauth PublicAuthInventoryEntry
	_ = json.Unmarshal(rawOauth, &decodedOauth)
	if got := SelectPublicCredential([]PublicAuthInventoryEntry{decodedOauth, testPublicSelfEntry()}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionConflict {
		t.Fatalf("OAuth record with disabled=false did not block: %+v", got)
	}
}

func TestSelectPublicCredentialMalformedInventoryFailsClosed(t *testing.T) {
	// No identity at all: cannot be classified.
	noIdentity := PublicAuthInventoryEntry{Provider: "claude", Type: "claude"}
	if got := SelectPublicCredential([]PublicAuthInventoryEntry{noIdentity, testPublicSelfEntry()}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionMalformed {
		t.Fatalf("identity-less record did not fail closed: %+v", got)
	}
	// Known identity but no provider/type value: unknown record.
	unknownType := PublicAuthInventoryEntry{ID: "x", Name: "x.json"}
	if got := SelectPublicCredential([]PublicAuthInventoryEntry{unknownType}, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionMalformed {
		t.Fatalf("provider/type-less record did not fail closed: %+v", got)
	}
	// Round-tripped wire JSON reconstructs the same failure.
	raw := []byte(`{"files":[{"id":"","name":"","provider":"claude","type":"claude"},{"id":"opencode:opencode-public.json","name":"opencode-public.json","provider":"opencode","type":"opencode","status":"active"}]}`)
	var list hostPublicAuthListResponse
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatalf("unmarshal wire inventory: %v", err)
	}
	if got := SelectPublicCredential(list.Files, false, false); got.Admitted || got.Reason != PublicCredentialAdmissionMalformed {
		t.Fatalf("wire malformed inventory did not fail closed: %+v", got)
	}
}

// Optional key-presence booleans fed by the parent.

func TestSelectPublicCredentialEnvKeyBlocks(t *testing.T) {
	got := SelectPublicCredential([]PublicAuthInventoryEntry{testPublicSelfEntry()}, true, false)
	if got.Admitted || got.Reason != PublicCredentialAdmissionEnvKey {
		t.Fatalf("env key did not block: %+v", got)
	}
	if got := SelectPublicCredential(nil, true, false); got.Admitted || got.Reason != PublicCredentialAdmissionEnvKey {
		t.Fatalf("env key with empty inventory did not block: %+v", got)
	}
}

func TestSelectPublicCredentialConfigKeyBlocks(t *testing.T) {
	got := SelectPublicCredential([]PublicAuthInventoryEntry{testPublicSelfEntry()}, false, true)
	if got.Admitted || got.Reason != PublicCredentialAdmissionConfigKey {
		t.Fatalf("config key did not block: %+v", got)
	}
	if got := SelectPublicCredential(nil, false, true); got.Admitted || got.Reason != PublicCredentialAdmissionConfigKey {
		t.Fatalf("config key with empty inventory did not block: %+v", got)
	}
}

// HostBridge.PublicCredentialAdmission over a fake HostCall.

// fakeHostRecord captures each callback and replays the scripted result.
type fakeHostRecord struct {
	method  string
	payload []byte
}

func newFakeHostCall(t *testing.T, result []byte, err error, records *[]fakeHostRecord) HostCall {
	t.Helper()
	return func(method string, payload []byte) ([]byte, error) {
		if records != nil {
			*records = append(*records, fakeHostRecord{method: method, payload: payload})
		}
		return result, err
	}
}

func TestHostBridgePublicCredentialAdmissionWireAndAdmission(t *testing.T) {
	var records []fakeHostRecord
	raw, _ := json.Marshal(hostPublicAuthListResponse{Files: []PublicAuthInventoryEntry{
		{ID: "claude:c.json", Name: "c.json", Provider: "claude", Type: "claude", Status: "active"},
		testPublicSelfEntry(),
	}})
	bridge := NewHostBridge(newFakeHostCall(t, raw, nil, &records))
	got, err := bridge.PublicCredentialAdmission(false, false)
	if err != nil {
		t.Fatalf("PublicCredentialAdmission() error = %v", err)
	}
	if !got.Admitted || got.Reason != PublicCredentialAdmissionAdmitted {
		t.Fatalf("admission = %+v, want admitted", got)
	}
	if len(records) != 1 {
		t.Fatalf("callbacks = %d, want exactly one host.auth.list (no credential-get)", len(records))
	}
	if records[0].method != hostAuthListMethod {
		t.Fatalf("callback method = %q, want %q", records[0].method, hostAuthListMethod)
	}
	// The list callback takes no parameters and needs no credential material.
	var payload map[string]any
	if err := json.Unmarshal(records[0].payload, &payload); err != nil || len(payload) != 0 {
		t.Fatalf("list callback payload = %s, want an empty parameter object", records[0].payload)
	}
}

func TestHostBridgePublicCredentialAdmissionBlocksOnInventory(t *testing.T) {
	cases := []struct {
		name   string
		files  []PublicAuthInventoryEntry
		envKey bool
		cfgKey bool
		reason string
	}{
		{"none", nil, false, false, PublicCredentialAdmissionAbsent},
		{"oauth_present", []PublicAuthInventoryEntry{{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey, Status: "active"}}, false, false, PublicCredentialAdmissionConflict},
		{"disabled_but_present_opencode_record", []PublicAuthInventoryEntry{{ID: ProviderKey + ":o.json", Name: "o.json", Provider: ProviderKey, Type: ProviderKey, Disabled: true, Unavailable: true, Status: "disabled"}}, false, false, PublicCredentialAdmissionConflict},
		{"self_unhealthy", []PublicAuthInventoryEntry{func() PublicAuthInventoryEntry {
			e := testPublicSelfEntry()
			e.Disabled = true
			e.Status = "disabled"
			return e
		}()}, false, false, PublicCredentialAdmissionUnhealthy},
		{"malformed", []PublicAuthInventoryEntry{{}}, false, false, PublicCredentialAdmissionMalformed},
		{"env_key", nil, true, false, PublicCredentialAdmissionEnvKey},
		{"cfg_key", nil, false, true, PublicCredentialAdmissionConfigKey},
	}
	for _, tc := range cases {
		raw, _ := json.Marshal(hostPublicAuthListResponse{Files: tc.files})
		bridge := NewHostBridge(newFakeHostCall(t, raw, nil, nil))
		got, err := bridge.PublicCredentialAdmission(tc.envKey, tc.cfgKey)
		if err != nil {
			t.Fatalf("case %q: unexpected error %v", tc.name, err)
		}
		if got.Admitted || got.Reason != tc.reason {
			t.Fatalf("case %q: admission = %+v, want blocked with %q", tc.name, got, tc.reason)
		}
	}
}

func TestHostBridgePublicCredentialAdmissionCallbackErrorFailsClosed(t *testing.T) {
	bridge := NewHostBridge(newFakeHostCall(t, nil, errHostUnavailable{}, nil))
	got, err := bridge.PublicCredentialAdmission(false, false)
	if err == nil {
		t.Fatalf("callback error must surface")
	}
	if got.Admitted || got.Reason != PublicCredentialAdmissionHostError {
		t.Fatalf("callback error admission = %+v, want blocked with %q", got, PublicCredentialAdmissionHostError)
	}
	// Malformed inventory JSON from the host also fails closed.
	bridge = NewHostBridge(newFakeHostCall(t, []byte("{nope"), nil, nil))
	got, err = bridge.PublicCredentialAdmission(false, false)
	if err == nil {
		t.Fatalf("malformed host result must surface")
	}
	if got.Admitted {
		t.Fatalf("malformed host result must not admit")
	}
}

type errHostUnavailable struct{}

func (errHostUnavailable) Error() string { return "host unavailable" }

// Free-model allowlist.

func TestPublicCredentialFreeModelsExactlyStagedFour(t *testing.T) {
	got := PublicCredentialFreeModels()
	want := []string{"beam-free", "big-pickle", "glm-5.3-flash-free", "trinity-large-preview-free"}
	if len(got) != len(want) {
		t.Fatalf("free allowlist = %v, want exactly the staged four", got)
	}
	for i, id := range want {
		if got[i] != id {
			t.Fatalf("free allowlist[%d] = %q, want %q", i, got[i], id)
		}
		if !IsPublicCredentialFreeModel(id) {
			t.Fatalf("staged free model %q rejected", id)
		}
	}
	if IsPublicCredentialFreeModel("  beam-free  ") != true {
		t.Fatalf("trimmed id must match")
	}
}

func TestPublicCredentialFreeModelRejectsPaidAndUnknown(t *testing.T) {
	for _, model := range []string{
		"", "beam", "beam-free-x", "xbeam-free", "BEAM-FREE", "Beam-Free",
		"glm-5.3-flash", "glm-5.3", "glm-5.3-flash-fre", "free", "-free",
		"bigpickle", "big-pickle-pro", "trinity-large-preview", "trinity-large-preview-freeX",
		"claude-haiku-5-5", "qwen3.8-max", "kimi-k3", "unknown-model",
	} {
		if IsPublicCredentialFreeModel(model) {
			t.Fatalf("paid/unknown model %q admitted by the free allowlist", model)
		}
	}
}
