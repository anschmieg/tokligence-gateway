# Coolify alpha deployment

Target application: `iog8gk8g8o0s44840g4o4sso`, `https://code.nothing.pink`,
control plane `https://panel.nothing.pink`. Its API is reachable locally on
VPS port8000; use the existing private `COOLIFY_ACCESS_TOKEN` from the user's
`~/.env`, never log it. Public control-plane requests currently return403.

Use `Dockerfile.coolify` with the existing root bind-mounted at the SAME path,
`/home/agent/cliproxy-staging`. Runtime UID30033 owns existing private state.
The image contains only system runtime dependencies and the entrypoint; tested
backend/plugin/panel artifacts remain in the versioned deployment root.
No legacy gateway executable, credential import, second database or proxy layer.

Before first native container launch: verify/quiesce the owned host service,
retain rollback configuration, change native server binding to0.0.0.0:8080,
apply tested backend/panel, preserve native keys/cooldowns and write
`state/coolify-owner.ready`. The entrypoint holds `state/coolify-runtime.lock`
for the entire native process lifetime; duplicate containers fail locally.
Keep OpenCode disabled. Do not mount/reseed its old database. Existing production
`/data` storage remains untouched and is not read by this native runtime.

The panel is still the pinned upstream native panel with a small same-origin
Cloudflare login bootstrap for `code.nothing.pink`. It uses no management key,
no dummy key and persists no key there. Backend management authentication must
verify the signed Access assertion's issuer/audience/signature/time/email.
Existing native key authentication remains for trusted API/T3 clients. The
Cloudflare application, not a caller-supplied email header, controls who may log in.
Inference clients retain API-key authentication; Access login is not an
inference credential. No inference requests are part of deployment checks.

The exact before-change Coolify app definition is retained privately at
`coolify-before-alpha/application.json`; private environment values must not
be placed in Git or deployment output. Restore only reviewed app/runtime
settings for rollback, never reactivate an old secondary OAuth owner.
