# Management quarantine guard — integration into pinned CLIProxyAPI v8.0.49

Base: mainline CLIProxyAPI v8.0.49, commit `250d598175db61a4e99ac38b9164ed04745754e5`.
Source read from `/tmp/m2-eval/backend` (package `management`,
`internal/api/handlers/management/api_tools.go`). Both new Go files go into
package `management` (same directory as `api_tools.go`), not a subpackage.

## Upstream behavior already verified (do not weaken)

`Manager.VerifyInference` in `sdk/cliproxy/auth/conductor_execution.go:2235`
already refuses disabled credentials **before any executor lookup, token
resolution or HTTP**:

```go
// conductor_execution.go:2247-2249
if auth.Disabled || auth.Status == StatusDisabled {
    return auth, &Error{Code: "auth_disabled", Message: "credential is disabled", HTTPStatus: http.StatusConflict}
}
```

This runs after `GetByID` (line 2243) and before `RequiresSignIn` (2250) and
the provider executor lookup (2253-2259). Conclusion: **no insert is needed at
VerifyAuthFileV8 / VerifyInference**. `auth_files_v8.go:524` calls
`VerifyInference` directly and maps the SDK error via
`clienterror.HTTPStatusFromErrorOr` (409) and
`coreauth.SanitizeRenewalMessage` — that path is already safe. Do not add a
second check there.

## The one real gap: Handler.APICall

`api_tools.go:104` (`POST /v0/management/api-call`) resolves
`auth := h.authByIndex(authIndex)` at line 137, then proceeds to `$TOKEN$`
substitution (lines 149-189: `resolveTokenForAuth`, which can trigger a real
OAuth refresh via `refreshAntigravityOAuthAccessToken`, `resolveMetaToken`,
`resolveXAIToken`) and an upstream `httpClient.Do` (line 218) with no check of
`auth.Disabled` or `auth.Status == StatusDisabled` anywhere in the function.
A quarantined credential is therefore still usable through the management
api-call proxy.

## Exactly one insertion point

In `internal/api/handlers/management/api_tools.go`, inside
`func (h *Handler) APICall(c *gin.Context)` — immediately **after**:

```go
	authIndex := firstNonEmptyString(body.AuthIndexSnake, body.AuthIndexCamel, body.AuthIndexPascal)
	auth := h.authByIndex(authIndex)
```

(line 137) and **before**:

```go
	reqHeaders := body.Header
	if reqHeaders == nil {
```

(line 139). This places the guard after the auth lookup but before all header
processing, `$TOKEN$` resolution and transport construction. Insert:

```go
	if managementQuarantineGuard(c, auth) {
		return
	}
```

The anchor `auth := h.authByIndex(authIndex)` is unique in the file (grep
verifies exactly one occurrence outside its definition at line 819). No other
line of `api_tools.go` changes; no new imports are needed in `api_tools.go`
itself (`gin` is already imported).

## Helper semantics (management_quarantine.go, package management)

- `managementQuarantineRefused(auth *coreauth.Auth) bool` — nil and enabled
  auth return `false` (upstream behavior preserved verbatim); refusal matches
  the SDK's own dual condition `auth.Disabled || auth.Status == StatusDisabled`
  (conductor_execution.go:2247), so the two layers can never disagree. It is
  read-only: no flag is cleared and no status rewritten, so a quarantine never
  doubles as a quarantine-clear.
- `managementQuarantineGuard(c *gin.Context, auth *coreauth.Auth) bool` — on
  refusal writes a **local** `403` with fixed `error: "auth_disabled"` and
  `message: "credential is disabled"` (the SDK's message text, no provider
  names, no credential material) and returns `true` (caller must `return`).
  403 (not 409) marks it as an operator-policy refusal at the management
  surface, distinct from the SDK inference-verify conflict. This is a fixed
  local error code before any token resolution, refresh or HTTP.
- `ManagementQuarantineErrorCode = "auth_disabled"` matches the SDK's
  identifier so clients see one code across both paths.

Provider-agnostic by construction: both fields live on the shared
`coreauth.Auth` type; no provider string is referenced anywhere.

## What is NOT changed

- No source API / client contract elsewhere: `VerifyAuthFileV8`,
  `VerifyInference`, executors, middleware, routing and error mapping keep
  upstream behavior. `firstNonEmptyString`, `authByIndex`,
  `resolveTokenForAuth` and `apiCallTransport` are untouched.
- Disabled-auth operations that skip the guard (all other management/usage
  endpoints) still fail clearly through their existing paths — the guard adds
  a check, it never allows anything new.
- No redirects change (that remains the separate `native_openai_redirect` /
  `provider_dispatch_budget` scope).
- Existing OpenCode `.so` fixes/delegates and legacy dirty files are out of
  scope; nothing here touches `pluginhost`/`pluginstore`.

## Tests (management_quarantine_test.go, package management)

Uses the package's existing fixture conventions (`api_tools_test.go`):
`coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)`,
`manager.Register(context.Background(), ...)`, `auth.EnsureIndex()`, a
`&Handler{authManager: manager}` wired through `gin.New()` +
`router.POST("/", h.APICall)`, and loopback-only `httptest` upstreams with
fake credentials (no real tokens, zero external network).

- `TestManagementQuarantineRefusedNilAuth` — nil is never refused (upstream
  behavior retained).
- `TestManagementQuarantineRefusedEnabledAuth` — enabled auth passes and is
  not mutated.
- `TestManagementQuarantineRefusedDisabledFlag` — `Disabled: true` refused,
  `Status` untouched (no quarantine-clear).
- `TestManagementQuarantineRefusedDisabledStatus` — `StatusDisabled` refused,
  `Disabled` untouched.
- `TestManagementQuarantineGuardWritesLocal403` — 403 + fixed code + message.
- `TestManagementQuarantineGuardEnabledAuthPassesThrough` — no response
  written for enabled auth.
- `TestAPICallDisabledAuthQuarantinedBeforeUpstream` — end-to-end through the
  real `APICall` handler: disabled credential returns the local 403 with the
  fixed code and the loopback upstream records **zero** hits (guard provably
  runs before `$TOKEN$` resolution and dispatch).
- `TestAPICallEnabledAuthStillReachesUpstream` — same request shape with an
  enabled credential: upstream is reached, `$TOKEN$` substitution works, HTTP
  200 — proving the guard does not over-block the enabled path.
- `TestVerifyInferenceRefusesDisabledCredential` — pins the SDK's existing
  refusal (`auth_disabled`, 409) so a future SDK change that drops it is
  caught instead of silently relied on.

## Verification commands for the parent

Prepare into a NEW separate source directory (never edits input/deploys), copy
both Go files into package `management`, apply the three-line insert above,
then:

```sh
python3 staging/cli-proxy-api/prepare_provider_patch.py --source /tmp/m2-eval/backend --output /tmp/cliproxy-quarantine-source
# copy staging/cli-proxy-api/patches/management_quarantine/*.go into
# /tmp/cliproxy-quarantine-source/internal/api/handlers/management/
# apply the anchor insert in .../management/api_tools.go
go test ./internal/api/handlers/management/ -run 'TestManagementQuarantine|TestAPICallDisabledAuthQuarantinedBeforeUpstream|TestAPICallEnabledAuthStillReachesUpstream|TestVerifyInferenceRefusesDisabledCredential' -race -count=1
go test ./internal/api/handlers/management/ -race -count=1   # full package: no regression
go build ./...                                               # whole tree compiles
```

Rollback: remove the three inserted lines and the two new files; behavior
returns to stock v8.0.49. Retire this patch when mainline refuses disabled
credentials in the management api-call path itself.

## Out of scope (explicit)

- Redirect policy for plugins / compatible providers (`provider_dispatch_budget.go`,
  `openai_compat_redirect_policy.go`).
- Any change to OAuth token refresh implementations (antigravity/meta/xai) —
  the guard simply runs before them.
- Management middleware authentication (unchanged; the guard is post-auth).
- `git status` dirty legacy files in this repo.
