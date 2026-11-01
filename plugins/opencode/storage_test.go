package opencode

import (
	"encoding/json"
	"reflect"
	"testing"
)

func equalCredentialMetadata(left, right json.RawMessage) bool {
	var a, b any
	return json.Unmarshal(left, &a) == nil && json.Unmarshal(right, &b) == nil && reflect.DeepEqual(a, b)
}

// The external host contract is pinned auth_provider.go mergedStorageJSON:
// copy provider RawJSON, overlay host metadata, then force root type=provider.
func emulateHostStorage(t *testing.T, raw []byte) []byte {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	object["type"] = ProviderKey
	object["oauth_provider"] = ProviderKey
	object["label"] = "host-label"
	result, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestNativeCredentialSurvivesHostSaveAndRefresh(t *testing.T) {
	original, err := ParseCredential([]byte(validCredential))
	if err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	_ = json.Unmarshal(original.Metadata, &metadata)
	metadata["extension"] = map[string]any{"fixture": "preserved"}
	original.Metadata, _ = json.Marshal(metadata)
	raw, err := EncodeCredentialStorage(original)
	if err != nil {
		t.Fatal(err)
	}
	saved := emulateHostStorage(t, raw)
	var disk struct {
		Type       string
		Version    int `json:"storage_version"`
		Credential Credential
	}
	if err := json.Unmarshal(saved, &disk); err != nil {
		t.Fatal(err)
	}
	if disk.Type != ProviderKey || disk.Version != 1 || disk.Credential.Type != "oauth" {
		t.Fatal("host/native discriminators collided")
	}
	parsed, err := ParseCredential(saved)
	if err != nil {
		t.Fatal(err)
	}
	want := original
	want.Metadata = parsed.Metadata
	if !reflect.DeepEqual(parsed, want) || !equalCredentialMetadata(parsed.Metadata, original.Metadata) {
		t.Fatal("host save changed native credential")
	}
	transport := &fakeTransport{doResult: HTTPResult{StatusCode: 200, Body: []byte(`{"access_token":"fixture-rotated","refresh_token":"fixture-refresh","expires_in":3600}`)}}
	h := newTestHandler(t, transport)
	req, _ := json.Marshal(map[string]any{"AuthID": "opencode:fixture.json", "AuthProvider": ProviderKey, "StorageJSON": saved, "Metadata": map[string]any{"type": ProviderKey, "oauth_provider": ProviderKey}})
	result, err := h.HandleMethod("auth.refresh", req)
	if err != nil {
		t.Fatal(err)
	}
	var refreshed AuthRefreshResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &refreshed); err != nil {
		t.Fatal(err)
	}
	rotated, err := ParseCredential(emulateHostStorage(t, refreshed.Auth.StorageJSON))
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Access != "fixture-rotated" || rotated.Refresh != "fixture-refresh" || !equalCredentialMetadata(rotated.Metadata, original.Metadata) {
		t.Fatal("refresh lost rotation or native account metadata")
	}
	// A file watcher reparse after save/restart must retain stable host identity.
	parseReq, _ := json.Marshal(map[string]any{"Provider": ProviderKey, "FileName": "fixture.json", "RawJSON": emulateHostStorage(t, refreshed.Auth.StorageJSON)})
	response, err := h.HandleMethod("auth.parse", parseReq)
	if err != nil {
		t.Fatal(err)
	}
	var parsedFile AuthParseResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, response), &parsedFile); err != nil {
		t.Fatal(err)
	}
	if !parsedFile.Handled || parsedFile.Auth.ID != refreshed.Auth.ID {
		t.Fatal("saved host file did not reparse with stable identity")
	}
}

func TestCredentialEnvelopeRefusesForeignOrAmbiguousShapes(t *testing.T) {
	for _, raw := range []string{
		`{"type":"opencode","storage_version":2,"credential":` + validCredential + `}`,
		`{"type":"opencode","storage_version":1,"credential":null}`,
		`{"type":"opencode","storage_version":1,"oauth_provider":"cline","credential":` + validCredential + `}`,
		`{"type":"opencode","storage_version":1,"credential":{"type":"key","key":"fake"}}`,
		`{"type":"opencode","access":"fake","refresh":"fake","expires":2000000000000}`,
	} {
		if _, err := ParseCredential([]byte(raw)); err == nil {
			t.Fatalf("ambiguous/foreign envelope accepted: %s", raw)
		}
	}
}

func TestMissingAccessTokenCannotPassExpiryAdmission(t *testing.T) {
	credential := Credential{Type: "oauth", MethodID: "device", Refresh: "fixture", Expires: 4102444800000}
	if !credential.ExpiredAt(testNow) {
		t.Fatal("future expiry admitted an empty bearer")
	}
}
