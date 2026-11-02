// Pure public-fallback helpers for the OpenCode Console provider. This file
// adds the native "public" mode next to the deployed OAuth 0.3.0 flow. It is
// intentionally narrow: explicit envelope encode/parse, one read-only host
// admission query over the existing host callback bridge, and an explicit
// free-model allowlist. No auto-provisioning, no background job, no config
// writes, no retries and no credential rotation live here; the parent owns
// all wiring (auth parse, model publication, refresh, executor dispatch and
// the private-console-header removal for public execution).
//
// Native source pins (see SOURCE-PINS.md):
//   - packages/core/src/plugin/provider/opencode.ts:349-357 (2.0.32 parity):
//     const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection ||
//     item.provider.settings?.apiKey)
//     if (!hasKey) { provider.activation = "enabled"
//     provider.settings = { ...provider.settings, apiKey: "public" } }
//     Public mode applies ONLY when none of those key sources is present:
//     an env key, config/api key, or an active Console connection (our OAuth
//     credential) means native never falls back to public.
//   - packages/core/src/plugin/provider/opencode.ts:358-372: with no key the
//     model transform disables every model with cost.input > 0, so public
//     mode serves free models only.
//   - packages/schema/src/credential.ts via credential.go: this package's
//     host envelope overlay (root type = provider id, storage_version 1,
//     nested native credential value).
//   - /tmp/m2-eval/backend sdk/pluginabi/types.go:141
//     (MethodHostAuthList = "host.auth.list"), sdk/pluginapi/types.go:833-895
//     (HostAuthFileEntry) and internal/pluginhost/auth_callbacks.go
//     (callHostAuthList -> rpcHostAuthListResponse{Files}) for the wire shape.
package opencode

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const (
	// PublicCredentialType is the underlying credential discriminator for the
	// public fallback. Native has no persisted file for it; this plugin's
	// envelope spends a "public" type so host storage can round-trip the mode
	// without ever naming it an OAuth credential (no refresh token exists for
	// public mode and none may be invented).
	PublicCredentialType = "public"

	// PublicCredentialAccess is the fixed access sentinel written into the
	// envelope. It mirrors the native public admission value
	// (opencode.ts:353: settings.apiKey = "public"); it is a mode marker, not
	// credential material and not a bearer token for Console calls.
	PublicCredentialAccess = "public"

	// PublicCredentialFileName is the canonical auth-dir file name the public
	// fallback admits. Any other spelling (case, prefix, suffix) is refused.
	PublicCredentialFileName = "opencode-public.json"
)

// PublicCredentialID is the exact host credential record ID for the public
// fallback (handler.go convention: "<provider>:<file name>"). The record must
// carry this ID and the canonical file name together and consistently.
const PublicCredentialID = ProviderKey + ":" + PublicCredentialFileName

// hostPublicCredentialValue is the nested native-shape credential value of
// the public envelope.
type hostPublicCredentialValue struct {
	Type   string `json:"type"`
	Access string `json:"access"`
}

// publicCredentialEnvelope shares credential.go's host storage shape: the
// CLIProxyAPI mergedStorageJSON root (type = provider id) with
// storage_version 1 holding the credential value.
type publicCredentialEnvelope struct {
	Type           string                    `json:"type"`
	StorageVersion int                       `json:"storage_version"`
	Credential     hostPublicCredentialValue `json:"credential"`
}

// EncodePublicCredentialStorage produces the exact public-fallback envelope:
// root type "opencode", storage_version 1 and a fixed credential value
// {type: "public", access: "public"}. It fabricates nothing: no OAuth type,
// no refresh token, no API key, no metadata. The output depends on no input,
// so parent wiring can persist it for the canonical file and feed the result
// to the host auth-dir parse path unchanged.
func EncodePublicCredentialStorage() ([]byte, error) {
	return json.Marshal(publicCredentialEnvelope{
		Type:           ProviderKey,
		StorageVersion: 1,
		Credential: hostPublicCredentialValue{
			Type:   PublicCredentialType,
			Access: PublicCredentialAccess,
		},
	})
}

// IsPublicCredentialStorage reports whether raw is exactly the public
// credential envelope produced by EncodePublicCredentialStorage. The shape is
// strict so host files cannot smuggle a real key into the public path:
//   - the root object carries exactly the keys type / storage_version /
//     credential, with type "opencode" and storage_version the integer
//     literal 1,
//   - the nested credential object carries exactly the keys type / access,
//     with type "public" and access "public",
//   - anything else — an oauth type, a refresh token, an api key field,
//     arbitrary extra keys, a wrong version, a wrong access sentinel,
//     whitespace-only or unparseable bytes — is rejected (false).
//
// This is the public helper's own judgment, NOT ParseCredential: the OAuth
// parser in credential.go must keep declining this shape (its type is not
// "oauth" and it has no refresh token), which is what keeps public mode out
// of the refresh path.
func IsPublicCredentialStorage(raw []byte) bool {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return false
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return false
	}
	if len(root) != 3 {
		return false
	}
	for _, key := range []string{"type", "storage_version", "credential"} {
		if _, ok := root[key]; !ok {
			return false
		}
	}
	var rootType string
	if err := json.Unmarshal(root["type"], &rootType); err != nil || rootType != ProviderKey {
		return false
	}
	// Exactly the integer literal the encoder writes; "1.0", "\"1\"" and the
	// like are refused.
	if strings.TrimSpace(string(root["storage_version"])) != "1" {
		return false
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(root["credential"], &value); err != nil {
		return false
	}
	if len(value) != 2 {
		return false
	}
	var credentialType, credentialAccess string
	if err := json.Unmarshal(value["type"], &credentialType); err != nil || credentialType != PublicCredentialType {
		return false
	}
	if err := json.Unmarshal(value["access"], &credentialAccess); err != nil || credentialAccess != PublicCredentialAccess {
		return false
	}
	return true
}

// PublicAuthInventoryEntry is the non-secret projection of the host auth
// inventory the admission decision may read (sdk/pluginapi.HostAuthFileEntry
// fields id/name/provider/type/status/disabled/unavailable as shaped by
// internal/pluginhost/auth_callbacks.go buildHostAuthFileEntry). No credential
// material, token, email or metadata field is carried.
type PublicAuthInventoryEntry struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Status      string `json:"status,omitempty"`
	Disabled    bool   `json:"disabled,omitempty"`
	Unavailable bool   `json:"unavailable,omitempty"`
}

// Admission reasons. Absence is the normal, healthy "no public fallback"
// outcome; every other non-admitted reason is a deliberate fail-closed block.
const (
	PublicCredentialAdmissionAdmitted  = "public_credential_admitted"
	PublicCredentialAdmissionAbsent    = "public_credential_absent"
	PublicCredentialAdmissionEnvKey    = "env_key_present"
	PublicCredentialAdmissionConfigKey = "config_key_present"
	// An inventory record without any identity (no name and no id) or with
	// neither a provider nor a type cannot be classified; admission fails
	// closed on the whole inventory.
	PublicCredentialAdmissionMalformed = "malformed_inventory"
	// Any opencode-provider/opencode-type record other than exactly the
	// canonical self public record blocks the fallback (including the
	// deployed OAuth credential, and including such a record that is
	// disabled, expired/unavailable or in an unknown state).
	PublicCredentialAdmissionConflict = "opencode_record_conflict"
	// The canonical self record exists but is disabled, unavailable or not in
	// the host's active status ("active"; sdk/cliproxy/auth status values are
	// unknown/active/pending/refreshing/error/disabled).
	PublicCredentialAdmissionUnhealthy = "public_credential_unhealthy"
	// (HostBridge only) the host.auth.list callback failed; fail closed.
	PublicCredentialAdmissionHostError = "host_auth_list_unavailable"
)

// PublicCredentialAdmission is the admission decision handed to the parent
// wiring. It is a value, not a side effect: nothing here registers,
// provisions or writes anything.
type PublicCredentialAdmission struct {
	// Admitted reports whether the public fallback may apply. When true the
	// single matching record is verified canonical, active and healthy.
	Admitted bool
	// Reason carries one of the PublicCredentialAdmission* constants (or, on
	// the host callback path, the HostError constant with the error itself
	// returned separately) for diagnostics.
	Reason string
}

// SelectPublicCredential is the pure selection function. envKeyPresent and
// configKeyPresent are the parent-fed equivalents of the OPENCODE_API_KEY
// environment variable and the provider apiKey setting (opencode.ts:349);
// either blocks the public fallback before the inventory is even examined.
//
// Rules, in order:
//  1. env/config key present -> not admitted (native hasKey is true).
//  2. a record with no name AND no id, or one carrying neither a provider
//     nor a type (unclassifiable), fails the whole inventory closed.
//  3. any record belonging to the "opencode" provider/type that is not
//     exactly the canonical public record (file name opencode-public.json
//     AND id "opencode:opencode-public.json") blocks admission. This covers
//     the deployed OAuth credential in every state, including disabled,
//     expired/unavailable or unknown: a credential key source exists
//     natively, so public mode must not apply.
//  4. the canonical self record must be present, not disabled, not
//     unavailable and in host status "active"; otherwise blocked.
//  5. otherwise admitted.
//
// A foreign provider's record never blocks, and a record's "disabled: false"
// (explicit or omitted by the wire) is never treated as absence: the
// decision is positive-only (exact canonical match plus active/healthy
// state), so an opencode OAuth record with a false disabled flag still
// blocks the fallback.
func SelectPublicCredential(entries []PublicAuthInventoryEntry, envKeyPresent, configKeyPresent bool) PublicCredentialAdmission {
	if envKeyPresent {
		return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionEnvKey}
	}
	if configKeyPresent {
		return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionConfigKey}
	}
	self := -1
	for index, entry := range entries {
		id := strings.TrimSpace(entry.ID)
		name := strings.TrimSpace(entry.Name)
		provider := strings.TrimSpace(entry.Provider)
		entryType := strings.TrimSpace(entry.Type)
		if name == "" && id == "" {
			return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionMalformed}
		}
		if provider == ProviderKey || entryType == ProviderKey {
			if name != PublicCredentialFileName || id != PublicCredentialID || self >= 0 {
				return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionConflict}
			}
			self = index
			continue
		}
		if provider == "" && entryType == "" {
			return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionMalformed}
		}
	}
	if self < 0 {
		return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionAbsent}
	}
	entry := entries[self]
	if entry.Disabled || entry.Unavailable || strings.TrimSpace(entry.Status) != "active" {
		return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionUnhealthy}
	}
	return PublicCredentialAdmission{Admitted: true, Reason: PublicCredentialAdmissionAdmitted}
}

// hostAuthListMethod is the pinned host callback (sdk/pluginabi/types.go:141
// MethodHostAuthList = "host.auth.list"; internal/pluginhost/
// auth_callbacks.go callHostAuthList). The host answers with
// rpcHostAuthListResponse{Files []HostAuthFileEntry}; the cgo entry already
// unwrapped the {ok,result,error} envelope, so the raw result decodes here.
// Only this method is used: the credential-get callbacks (host.auth.get /
// host.auth.get_runtime) return raw credential JSON and are deliberately NOT
// part of public admission.
const hostAuthListMethod = "host.auth.list"

// hostPublicAuthListResponse mirrors internal/pluginhost/auth_callbacks.go
// rpcHostAuthListResponse; only the non-secret projected fields decode.
type hostPublicAuthListResponse struct {
	Files []PublicAuthInventoryEntry `json:"files"`
}

// PublicCredentialAdmission queries the host auth inventory through the
// existing HostBridge hostCallJSON seam and returns the pure admission
// decision. envKeyPresent/configKeyPresent are fed by the parent (the plugin
// itself never reads the environment or config keys; see config.go).
//
// Fail-closed modes: a callback error returns (blocked, err); any malformed
// inventory record is blocked by the selection function. There are no
// retries and no rotation here — the parent decides what admission carries
// forward.
func (b *HostBridge) PublicCredentialAdmission(envKeyPresent, configKeyPresent bool) (PublicCredentialAdmission, error) {
	var list hostPublicAuthListResponse
	// callHostAuthList tolerates an empty request body; host.auth.list takes
	// no parameters and no host callback id (auth_callbacks.go ignores ctx).
	if err := b.hostCallJSON(hostAuthListMethod, struct{}{}, &list); err != nil {
		return PublicCredentialAdmission{Admitted: false, Reason: PublicCredentialAdmissionHostError},
			fmt.Errorf("opencode public admission inventory failed: %w", err)
	}
	return SelectPublicCredential(list.Files, envKeyPresent, configKeyPresent), nil
}

// publicCredentialFreeModels is the current staged Console free catalog the
// public fallback may serve. Native picks free models structurally, by
// disabling every model with cost.input > 0 when no key is present
// (opencode.ts:360-372); this plugin sees no pricing feed, so the boundary is
// the explicit four-model free snapshot (parent-reviewed: beam-free,
// glm-5.3-flash-free, big-pickle and trinity-large-preview-free; beam-free,
// big-pickle and glm-5.3-flash-free appear as Infinity-allowance free models
// in the pinned Console source go-models.ts / models.mdx catalog). Paid and
// unknown models are rejected here; nothing else is treated as "maybe free".
var publicCredentialFreeModels = map[string]struct{}{
	"beam-free":                  {},
	"glm-5.3-flash-free":         {},
	"big-pickle":                 {},
	"trinity-large-preview-free": {},
}

// IsPublicCredentialFreeModel reports whether the bare model id is on the
// explicit public-fallback free allowlist. Matching is on the exact id
// (whitespace-trimmed only), never on prefixes, suffixes like "-free" or a
// price lookup, so a paid or unknown model can never inherit free eligibility.
func IsPublicCredentialFreeModel(model string) bool {
	_, ok := publicCredentialFreeModels[strings.TrimSpace(model)]
	return ok
}

// PublicCredentialFreeModels returns the free allowlist in sorted order for
// parent diagnostics and tests.
func PublicCredentialFreeModels() []string {
	out := make([]string, 0, len(publicCredentialFreeModels))
	for model := range publicCredentialFreeModels {
		out = append(out, model)
	}
	sort.Strings(out)
	return out
}
