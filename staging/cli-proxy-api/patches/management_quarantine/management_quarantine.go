package management

import (
	"net/http"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// ManagementQuarantineErrorCode is the fixed provider-agnostic denial code; it
// matches the SDK's existing auth_disabled identifier so callers see one code.
const ManagementQuarantineErrorCode = "auth_disabled"

// managementQuarantineRefused reports an operator-disabled credential. Nil and
// enabled credentials are never refused and never mutated (no flag or status
// is cleared); both fields live on the shared Auth type, so the semantics are
// provider-agnostic.
func managementQuarantineRefused(auth *coreauth.Auth) bool {
	if auth == nil {
		return false
	}
	return auth.Disabled || auth.Status == coreauth.StatusDisabled
}

// managementQuarantineGuard writes a local 403 with the fixed error code for
// disabled credentials before any token resolution, refresh or upstream HTTP;
// a true return means the caller must stop immediately.
func managementQuarantineGuard(c *gin.Context, auth *coreauth.Auth) bool {
	if !managementQuarantineRefused(auth) {
		return false
	}
	c.JSON(http.StatusForbidden, gin.H{
		"error":   ManagementQuarantineErrorCode,
		"message": "credential is disabled",
	})
	return true
}
