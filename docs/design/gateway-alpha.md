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
browser. The user subsequently confirmed personal-email Cloudflare login and
keyless native panel access after the production-team correction below.

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

OpenCode free-model compatibility remains a priority. Its same-account durable
cooldown expires no earlier than November 3 at 07:42:08.980115 UTC. Reconnecting
does not clear it; no rejection-driven public/account fallback is allowed.

## Login correction after initial alpha deployment

The first real login revealed production `CLOUDFLARE_ACCESS_TEAM=my-company`;
preview had `nothingpink` and had been incorrectly treated as production evidence.
Production is now corrected and the restarted process's actual environment was
verified. Fix deployment `yjxuec0qlcz6h2gyg2j7iq2t` finished at revision `fe33bfc`.
The panel now clears only local auth on API401, preserving Cloudflare login.
Explicit Logout still ends SSO. Five custom auth-state tests and the panel build
pass; the user subsequently confirmed successful personal browser login.


## Free Model Hub addition — November 2

The full pinned Free Model Hub plugin is installed alongside native OpenCode:
[open its console](https://code.nothing.pink/admin/v0/management/plugins/free-model-hub/console).
It uses the same Cloudflare Access session, without a browser Management Key.
The origin console and API authentication checks pass; real browser opening of
this added console has not yet been confirmed by the user.

There are 27 admitted vendor variants, including Cline and the other upstream
login providers. OpenCode Zen/Go and OpenRouter are excluded here because their
existing native integrations retain ownership. Provider support does not imply
an account, free entitlement or live acceptance for every provider.

The public Kilo pool publishes 17 models. Scheduled keepalives are disabled;
loading performs catalog discovery and no inference. Prefix model aliases keep
new routes separate. Native backend `.5` covers ABI callback redirect policy;
plugin `0.1.1-tokligence` preserves native filename credential IDs so one saved
account appears once. Existing accounts/settings, OpenCode quarantine, dashboard
asset, client key and prior live reports were verified unchanged through both
controlled restarts. Final Coolify deployment: `ctvr56qzepr1enqzb7hxsw98`.

Custom unit checks and an actual-host isolated mock smoke pass, including both
plugins, keyless console authentication, foreign credential preservation, single
stream dispatch and zero redirect-target requests. These are synthetic results,
not claims of live provider parity. Kilo live acceptance is recorded separately.


Kilo live acceptance: `kilo-kilo/nvidia/nemotron-3.5-lightning:free` passed a
streaming Chat request on November 2 at 13:13 UTC. The first 64-token call ended
at `length` before answering; the single permitted diagnostic used 1024 tokens
on the same free model and returned text with `stop` and `[DONE]`. Two total
caller POSTs, no automatic retries, redirects or fallback. No other new vendor's
live functionality is claimed. Both reports and the original OpenCode cooldown
remain preserved.
