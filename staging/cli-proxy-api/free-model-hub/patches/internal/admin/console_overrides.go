package admin

// console_overrides.go is a tokligence staging addition for the adopted
// free-model-hub build (source pin: Yousha-dev/free-model-hub
// 4d025efe8046af70327d80f75c5bd5ac6b4505af).
//
// Console same-origin keyless mode for the Cloudflare deployment:
//
//   - `console_keyless: true` lets the console page call the management API
//     WITHOUT a browser-side management key. Authentication happens host-side:
//     the deployment's cfAccessGate cloudflare_access.go patch admits valid
//     Cloudflare Access JWT requests on /v0/management before any key lookup,
//     behind the same-origin /admin alias (parent-managed alias code).
//   - `console_management_base` (e.g. "/admin") prepends a same-origin prefix
//     to both the plugin management calls and the host-level management calls
//     made by the page, so everything travels through the same Access-gated
//     alias namespace.
//
// No browser secret, no dummy key, no proxy page rewrite is added: the page
// keeps its native key panel and reuses it whenever a key IS available; in
// keyless mode it simply does not refuse to send an unauthenticated request
// (the panel key path remains fully preserved upstream).

import (
	"fmt"
	"strings"

	"free-model-hub/internal/logger"
)

// Page keeps the upstream signature (used by tests and replacers).
func Page(basePath string) string {
	return PageWithOverrides(basePath, "", false)
}

// PageWithOverrides renders the console page with the two deployment
// overrides. mgmtBase is a validated same-origin prefix ("" keeps upstream
// paths); keyless flips the page into unauthenticated same-origin mode.
func PageWithOverrides(basePath, mgmtBase string, keyless bool) string {
	keylessFlag := "false"
	if keyless {
		keylessFlag = "true"
	}
	return strings.NewReplacer(
		"__BASE__", basePath,
		"__MGMT_BASE__", mgmtBase,
		"__CONSOLE_KEYLESS__", keylessFlag,
	).Replace(page)
}

// consolePage renders the page for the management dispatcher using the active
// plugin configuration (called by admin.go's GET .../console case).
func (s *Service) consolePage() string {
	raw := s.deps.Config().Raw
	mgmtBase, errBase := ValidateManagementBase(raw["console_management_base"])
	if errBase != nil {
		// Validation already rejects invalid values at config decode; stay
		// conservative here and fall back to upstream paths.
		logger.Error("console page: %v (falling back to upstream management paths)", errBase)
		mgmtBase = ""
	}
	stageKeyless := ParseBool(raw["console_keyless"], s.deps.Config().ConsoleKeyless)
	return PageWithOverrides("/plugins/"+s.deps.Identity().ID, mgmtBase, stageKeyless)
}

// ValidateManagementBase validates the same-origin management URL prefix.
//
// The value is embedded into the console page and used with fetch() from the
// page origin, so it must never widen the page into another origin: only
// single, absolute, root-anchored paths are accepted ("/admin" style). Empty
// keeps the upstream paths exactly.
func ValidateManagementBase(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	if !strings.HasPrefix(trimmed, "/") {
		return "", fmt.Errorf("console_management_base %q must be a same-origin absolute path (start with \"/\", e.g. /admin)", raw)
	}
	if strings.HasPrefix(trimmed, "//") {
		return "", fmt.Errorf("console_management_base %q must not be a protocol-relative URL", raw)
	}
	if strings.Contains(trimmed, "://") {
		return "", fmt.Errorf("console_management_base %q must not carry a scheme; use a same-origin path like /admin", raw)
	}
	if strings.ContainsAny(trimmed, "?#\\") {
		return "", fmt.Errorf("console_management_base %q must not contain query, fragment or escape characters", raw)
	}
	for _, ch := range trimmed {
		if !(ch == '/' || ch == '-' || ch == '_' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
			return "", fmt.Errorf("console_management_base contains invalid path characters")
		}
	}
	return trimmed, nil
}
