package opencodezen

import "strings"

// foreign_guard.go is a tokligence staging addition for the adopted
// free-model-hub build (source pin: Yousha-dev/free-model-hub
// 4d025efe8046af70327d80f75c5bd5ac6b4505af).
//
// Narrow foreign-auth ownership guard. The deployment hosts native account
// files that this plugin must never claim, disable, rewrite or refresh:
//
//   - the standalone tokligence-opencode OAuth plugin (v0.3.0) writes host
//     auth files shaped `{"type":"opencode","storage_version":N,
//     "credential":{...}}` (e.g. `opencode.json`,
//     `opencode-login-<state>.json`);
//   - other host-native accounts use `"type":"builtin"`.
//
// Upstream's LooksLikeCredential accepted any filename containing a bare
// "opencode" segment, which would swallow exactly those files. This guard
// makes the refusal explicit and applies before any filename or field
// heuristic below; the runtime credentials of signed-in accounts stay owned
// by their native plugin and the host's normal refresh path.

// NativeOpenCodeAuthType is the top-level `type` marker of the standalone
// tokligence-opencode OAuth plugin's host auth files.
const NativeOpenCodeAuthType = "opencode"

// HostBuiltinAuthType is the top-level `type` marker of host-native accounts.
const HostBuiltinAuthType = "builtin"

// StorageVersionField is the credential envelope field written by the
// native OpenCode plugin (host file format covers the native credential).
const StorageVersionField = "storage_version"

// IsForeignCredentialJSON reports whether the credential JSON belongs to a
// foreign host-native account instead of this plugin.
//
// The verdict is deliberately narrow: it recognizes only the deployed native
// markers, never generic heuristics. Everything this plugin writes itself
// (`type:"freehub"` plus `vendor:"opencodezen"`, or anonymous keyless
// credentials without a foreign envelope) never trips this guard.
func IsForeignCredentialJSON(raw map[string]any) bool {
	if raw == nil {
		return false
	}
	if typeValue, ok := raw["type"].(string); ok {
		switch normalizeMarker(typeValue) {
		case NativeOpenCodeAuthType, HostBuiltinAuthType:
			return true
		}
	}
	if _, hasEnvelope := raw[StorageVersionField]; hasEnvelope {
		return true
	}
	return false
}

func normalizeMarker(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}
