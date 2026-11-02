# Gateway alpha — Coolify deployment

The alpha is now deployed in the existing **Tokligence Gateway** Coolify app at
`code.nothing.pink`, replacing its old gateway process.

- Admin panel: <https://code.nothing.pink/dashboard>
- OpenAI API base: `https://code.nothing.pink/v1`
- Model: `openrouter/nemotron-3.5-lightning-free`

The admin panel uses your existing Cloudflare Access personal-email policy.
Its same-origin browser requests go through the existing protected `/admin/*`
paths. The native backend validates the signed Access assertion; the browser
sends and stores no management key. Direct native management clients retain
key authentication. Ordinary inference clients still need their API key;
Cloudflare admin login is not an inference credential.

## Actual coverage

Coolify deployment `xbw4myxjpqnlobplmkfnrlss` finished successfully. Its native
backend8.0.49-tokligence.4 and patched upstream1.27.0 panel passed origin health,
model discovery, management/client auth separation, invalid-assertion denial
and runtime single-owner checks. Both `/dashboard` and `/management.html` serve
the exact tested panel. Public unauthenticated `/dashboard` redirects to Access;
public unauthenticated `/v1/models` returns native401 Missing API key in the
browser. A personal-email login and keyless panel opening await user confirmation:
Google rejected the automated preview browser as insecure. This is not claimed
as an observed successful real-user login.

The existing staging client key and old production client key remain admitted.
Public Python urllib discovery from the VPS hit Cloudflare1010 Browser Integrity
Check, even without auth; origin discovery with the native key succeeded.
This is a distinct edge-client limitation, not a provider inference result.

The free OpenRouter route previously passed one live streaming Messages request
with a correct inert tool proposal. No tool was executed, and live reasoning
continuation remains untested. No new inference was sent during this deployment.
Retries, redirects, provider fallback and paid routing remain disabled for it.

OpenCode remains disabled after its recorded429. Console org-header and model
restriction fixes are present, but corrected live acceptance is still untested.
The management API-call utility now refuses disabled credentials before token
resolution or HTTP. Cline is not live-configured; no Mistral free entitlement or
live acceptance is claimed. Full migration/parity remains unfinished.

## Operations

Coolify app UUID: `iog8gk8g8o0s44840g4o4sso`.
Deployment Git revision: `af2bd33` (Dockerfile/runtime ownership setup).
Backend patch revision: `2a0bf688e085d9e62bac104a48dda149344bea72`.
Native state remains `/home/agent/cliproxy-staging`, bind-mounted at that exact
path. The former standalone4195 process is stopped; Coolify is the runtime
owner. A lifetime descriptor lock prevents duplicate native containers.
No OAuth database/token was copied or reseeded. Old production `/data` storage
is unchanged and is not consumed by the new native process.

Private rollback/app configuration, tested artifact identities and deployment
reports remain in that root. The native management API is the configuration
owner; the release manifest is evidence rather than a second route store.
Do not start another host runtime or re-enable quarantined OpenCode to test login.

After the personal Cloudflare login check, OpenCode free-model compatibility
returns to top priority. Additional providers and speculative parity work remain
deferred.

## Login correction after initial alpha deployment

The first real login revealed production `CLOUDFLARE_ACCESS_TEAM=my-company`;
preview had `nothingpink` and had been incorrectly treated as production evidence.
Production is now corrected and the restarted process's actual environment was
verified. Fix deployment `yjxuec0qlcz6h2gyg2j7iq2t` finished at revision `fe33bfc`.
The panel now clears only local auth on API401, preserving Cloudflare login.
Explicit Logout still ends SSO. Five custom auth-state tests and the panel build
pass; a successful personal browser login still awaits the user's retry.
