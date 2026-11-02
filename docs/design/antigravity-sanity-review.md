# Antigravity sanity review — November 2, 2026

Scope: quick source review of pinned CLIProxyAPI v8.0.49, plus read-only deployed
configuration/account metadata. No login, refresh, inference, quota fetch or
configuration mutation was requested by this review.

Runtime: one active enabled Antigravity account, inference_verified=false.
request-retry=0, max-retry-credentials=1, cooling enabled, credits fallback=false.

No obvious missing OAuth implementation or unconditional paid fallback was found.
Refresh uses a refresh-token singleflight, a bounded 30-second acquisition window,
retains a non-rotated refresh token, and uses the existing host credential owner.
Native transport pools are credential-scoped; the executor itself makes one
inference call and delegates ordinary retry rounds to the conductor. Stream read
errors propagate, response bodies close, and reasoning replay has terminal checks.
These are source findings, not live functionality or native-client-parity proof.

## Findings relevant to this gateway's stricter policy

1. **401 refresh/replay is separate from request-retry.**
   sdk/cliproxy/auth/conductor_execution.go:639 and conductor_stream.go:454 invoke
   tryRefreshAfterUnauthorized and can execute inference again after refresh.
   conductor_refresh.go:1100 has no request-retry=0 check. Local streaming callers
   pass allowRetry=true independently of that numeric retry budget. This is normal
   recovery behavior upstream, but violates a strict one-physical-inference budget.
   Before a strictly bounded live test, select a supported request-scoped error
   policy or a narrow, verified dispatch-budget seam; do not assume retry=0 covers it.
2. **Redirects retain the Go client default.**
   internal/runtime/executor/antigravity_executor.go:440 and
   helps/proxy_helpers.go:32 construct clients without a rejecting CheckRedirect.
   The SDK transport decorator preserves client policy rather than fixing this.
   Our provider_dispatch_budget plugin-host patch does not cover native executors.
   Thus redirects could create extra physical requests. No redirect or credential
   leak was observed; this is a policy gap established by source.
3. **429 reset extraction is body-centric.**
   antigravity_executor_credits.go:352 newAntigravityStatusErr takes only status/body
   and parses structured retry information there. A response containing retry delay
   only in its HTTP Retry-After header does not pass that header through this seam.
   Common structured Google errors are handled, so this is an edge case, not proof
   that the provider's normal quota behavior is broken.

Credits fallback is explicitly off in our runtime; leave it off. Unknown balance
is optimistic in the optional credits implementation, so enabling it later needs
an explicit spending decision rather than being treated as free quota.

Conclusion: no reason for a broad reimplementation or full upstream test matrix.
The single-dispatch policy gaps should be resolved/admitted explicitly before
claiming that a one-call live smoke has a one-physical-request bound. Antigravity
remains connected but live acceptance untested. No changes were deployed.
