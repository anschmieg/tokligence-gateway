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


## Additional account acceptance — November 2, 14:10 UTC

One live request per ready provider passed for Antigravity
(`gemini-3.1-flash-lite`), Codex (`gpt-6-luna`) and LLM7
(`llm7-llm7/mistral-Nemo-Instruct-2407`). NVIDIA's selected Gemma model returned
404; SambaNova returned high-demand429; Z.ai returned no-balance/resource-package429.
Groq discovery returned403 and Mistral401. Cline account registration remains an
integration gap: its native credential is visible but no FreeHub route is published.
Duplicate keys were not individually tested; no account rotation was used.

Backend .6 and FreeHub0.1.2 now preserve streamed upstream error statuses and
bound native OAuth requests against redirects and automatic401 replay. Existing
accounts/settings, dashboard, OpenCode quarantine and prior evidence were preserved.
See [sanitized acceptance report](configured-provider-acceptance-20261102.json).


## Free-provider follow-up — November 2, 16:21 UTC

FreeHub0.1.3 is deployed. Its Z.ai catalog now admits only the documented free
GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash. The earlier GLM-5.3-Flash was
incorrectly labeled free by upstream and is paid; it is no longer published in
this free lane. Focused catalog tests passed, and existing settings/accounts,
OpenCode quarantine and prior reports were preserved through the plugin update.

The single corrected Z.ai free-model diagnostic still returned429/code1113
(insufficient balance/resource package). This does not establish that buying
balance is required for a zero-priced model. Standard API access/key product
needs clarification; no billing changes or Coding Plan endpoint substitution
were made. NVIDIA's single useful follow-up used its documented free
`z-ai/glm-5.3-flash` endpoint and timed out after45seconds. Its outcome is
inconclusive; the uncertain request was not repeated. Both diagnostics used the
native gateway with automatic retries/redirects/fallback disabled.

Current live-passed providers: OpenRouter, Kilo, LLM7, Antigravity and Codex.
Failed or blocked: NVIDIA (404 then timeout), SambaNova (high-demand429), Z.ai
(1113), Groq (catalog403), Mistral (catalog401), Cline (saved account absent from
FreeHub account pool/routes), OpenCode (existing429 quarantine through at least
November3 07:42:08.980115UTC). A representative-model success is not validation
of every model or every duplicate credential. Groq/Mistral/Cline have no ready
published route, so no inference was sent to them.


## Cline restored — November 2, 16:47 UTC

FreeHub0.1.4 fixes filename attribution: a leading provider prefix now takes
precedence over vendor words embedded in an account label. A Cline account with
an embedded GitHub description had previously been parsed as GitHub. No saved
credential was renamed or manually rewritten. Explicit persisted vendor ownership
still takes precedence. Focused real-parser and ownership regressions passed.

The deployed host now lists the Cline account and four free models. One refresh
through the native credential owner renewed its expired access token; one live
streaming request to `cline-cline-free/solar-mini4` returned200, nonempty text,
`stop` and `[DONE]` in1.58seconds. No inference retry, redirects, fallback, credential
rotation or OpenCode state change. Journals `cline-refresh-v1.json` and
`cline-live-v1.json` are completed; do not replay them. Native backend.6 unchanged;
FreeHub0.1.4 SHAcdab08acb6eac6367c6f646ef94770cf5ac01c882b5e2ca2e3711958fee2bb08,
Coolify deployment `m5v4iyyaaocrdorbbwjo5ejm` finished.

Upstream attribution bug: [free-model-hub issue#1](https://github.com/Yousha-dev/free-model-hub/issues/1).


## OpenCode acceptance preparation — November 2, 16:59 UTC

Corrected two production configuration gaps: the OpenCode allowlist now includes
`glm-5.3-flash-free` alongside `beam-free`, and its native401 request policy stops
and cools the credential instead of permitting automatic refresh/replay. Both
changes used scoped native If-Match writes; all other settings, quarantined
credential files and previous evidence were verified unchanged.

Read-only admission confirms that both saved OAuth access tokens are currently
valid and match the configured Console organization. Both credentials remain
disabled, and the durable investigation hold remains through November3
07:42:08.980115UTC or newer. That timestamp is the local guard's conservative
24-hour fallback after the prior429, not a provider-confirmed reset. No new
inference, refresh or provider HTTP was sent. This preparation does not establish
live free-model acceptance or permission for non-OpenCode clients.


## Official OpenCode CLI control — November 2, 17:29 UTC

At the user's explicit request, released OpenCode2.2.5 made one same-account,
same-organization Beam Free control request. OpenCode returned429 with
`FreeUsageLimitError` and `Retry-After: 23413`. The response receipt plus that
delay places retry eligibility at approximately November3 00:00UTC /01:00CET.
This is now provider-supplied guidance; the previous07:42UTC timestamp remains a
separate, unchanged local investigation hold.

The CLI compiled and decoded the request. A supported one-shot plugin called the
original Bun HTTPS fetch with redirects disabled and returned its response to the
native decoder through a local204 stub. Retries, tool calls and title inference
were disabled. This proves one guarded official-CLI control, not untouched
signed-in profile parity. The existing OAuth access token was supplied read-only;
no refresh token or credential database was copied, and the fresh CLI database
contained zero credentials. Gateway quarantine and prior evidence were unchanged.
See [control evidence](opencode-official-cli-control-20261102.json). No retry was sent.


## Free Model Hub sidebar fix

The Access dashboard previously prepended its management-only `/admin` prefix
to the plugin's public resource URL, resulting in404 and Safari's download prompt.
The deployed panel now uses the native origin-root resource URL, whose static
page redirects to the protected console. Panel SHA:
`e91963c598d64608791d21a00d2983885e814fdc40bc3a1b7e4c6033029874a7`.
Three URL regressions, five authentication regressions and the build pass. Native
origin responses verify HTML and the deployed panel hash. No gateway restart or
account changes were required. Reload the dashboard before retrying the sidebar;
real Safari confirmation remains pending.

## Model discovery and canonical routing audit — November 2, 18:15 UTC

Read-only inspection of the deployed native origin found208 unique OpenAI model
IDs across9 provider lanes. All models registered by credential owners appear;
the additional OpenRouter route comes from native static configuration. Counts:
NVIDIA85, LLM770, Kilo17, Codex14, Antigravity8, SambaNova6, Cline4, Zai3,
OpenRouter1. These are published IDs, not208 live-accepted models. Groq/Mistral
currently register none; disabled OpenCode credentials register none.

`/v1/models` returns200 in OpenAI, Claude and Codex client formats;
`/v1beta/models` returns200 for Gemini. Each has208 records. Codex/Gemini share
the OpenAI IDs; Claude rewrites206 non-Claude IDs into reversible
`claude-fable-5-dd-<reversed-original>` aliases. Decoding them gives the exact same
208 underlying IDs. Bare `/models` returns404: clients must use the `/v1` base.
This verifies the deployed origin, not external Cloudflare ingress acceptance.
No inference, refresh, credential changes or configuration writes occurred.

Discovery is complete relative to the registered routes, but capability metadata
is not reliable enough to use for automatic routing:

- Plain OpenAI discovery strips capabilities and limits;185 plugin models also
  have empty ownership. Richer protocol formats cannot repair missing source facts.
- FreeHub substitutes1M context and16,384 output tokens where upstream values are
  absent, and declares tools unconditionally in the generic adapter. Codex format
  synthesizes reasoning controls:190 records advertise low through ultra without
  corresponding upstream evidence.
- 185 Gemini records contain `tool_calls` as a generation method, rather than the
  `generateContent` operation. Generic FreeHub rows also classify task-specific
  embedding/audio/image/video identifiers as chat without proving those endpoints.
- A public Kilo catalog spotcheck confirms Lyria clip declares no tools and has
  audio output; local conversion advertises tools and loses that output modality.

The sanitized [full208-model audit](gateway-model-catalog-audit-20261102.json)
contains per-model disclosed fields, source locations, flags and26 candidate
identity groups. Merging those candidates would reduce208 IDs to180, but this is
candidate discovery, not a verified identity map or an applied configuration.

Implement consolidation within the existing providers and native registry:

1. Correct the FreeHub metadata conversion and native discovery serialization.
   Preserve real supported parameters/modalities/limits and distinguish unknown
   values from defaults. Keep standard API fields compatible.
2. Approve explicit publisher/model/revision mappings, including known spelling
   variants. Do not erase thinking, fast/high, size, quantization, date or context
   variants. Virtual routers and unknown stealth identities remain distinct.
   Third-party GPT/Claude naming alone does not establish identical service/model.
3. Use FreeHub's existing vendor-scoped aliases/reverse lookup, native OAuth fork
   aliases for built-ins, and native compatible-provider aliases for OpenRouter.
   FreeHub currently replaces original IDs: add a small keep-original publication
   option so existing clients and provider-qualified overrides remain usable.
   Resolve same-vendor duplicates deterministically; a single global reverse alias
   would route some vendor-specific upstream IDs incorrectly.
4. Publish canonical capabilities as the intersection guaranteed by admitted
   routes, with minimum confirmed context/output ceilings. Keep advanced
   provider-specific options available through qualified IDs. Preserve free-only
   admission, privacy distinctions, credential cooldowns and one physical dispatch.
5. Start with `nemotron-3.5-lightning`: the specific OpenRouter and Kilo routes
   already passed live acceptance. Cline's Lightning and similarly named NVIDIA
   variants require their own admission evidence; Cline's Solar pass is insufficient.
   Then expand to Beam and other verified groups. No aliases were changed in this
   audit, and no new routing service/proxy is proposed.

Vercel's free Gateway imposes its own per-model limits; upstream limits are
independent. Published docs do not provide numeric limits sufficient to conclude
which is generally stricter. Purchased Gateway credits remove Vercel's own limit,
not upstream capacity, model eligibility or promotion duration. Multiple keys do
not create team entitlements; independent funded teams do not guarantee independent
upstream capacity. Pooling accounts to circumvent rate limits is explicitly
prohibited by Vercel's AUP. Sources: [rate limits](https://vercel.com/docs/ai-gateway/rate-limits),
[pricing](https://vercel.com/docs/ai-gateway/pricing),
[AUP](https://vercel.com/legal/acceptable-use-policy#2-prohibited-activities).


## Deployed model discovery and canonical routing — November 2, 20:55 UTC

Native `8.0.49-tokligence.7` and FreeHub `0.1.5-tokligence.1` are deployed through
Coolify operation `azsyfaj4mlcanqoukqtq25pe`, source `1d94a85`. The deployment
journal `model-catalog-routing-deployment-v1.json` is complete: never replay it.
No provider inference or login was sent. Existing accounts, plugin settings,
OpenCode quarantine/reports, panel and caller key are preserved.

`/v1/models` now exposes provider ownership, source-backed parameters/modalities,
known token ceilings and explicit capability objects. `null` capabilities and
omitted limits mean unknown. Missing metadata no longer becomes a1M/16K promise;
170 current entries have unknown context omitted. No foreign Codex entry inherits
`ultra` reasoning from the Codex template. All209 model IDs have ownership and
capability objects. No Gemini generation method contains `tool_calls`.
Kilo Lyria correctly declares audio output and tools=false. Generic model family
is unspecified (`model`) unless a vendor-specific adapter declares otherwise;
this does not add embedding/audio/video inference endpoints.

Use `model: "nemotron-3.5-lightning"` for the first canonical route. Native routing
selects FreeHub Kilo or native OpenRouter among eligible credentials. All208 prior
IDs remain published and callable, including both qualified Lightning overrides.
This adds the first reviewed canonical name; it does not claim the other26 audit
candidate groups have been verified or merged. Third-party GPT/Claude branding,
quantization/revisions and virtual routers are deliberately not equated by name.

The exact deployed binary/plugin pair passed the isolated actual-host fixture:
three local mock POSTs selected Kilo/OpenRouter/Kilo, canonical source model names
were restored correctly, qualified override stayed on Kilo, no hidden dispatch
or external network traffic occurred, and disabled OpenCode stayed unpublished.
Focused custom race tests cover missing/explicit source metadata, vendor-isolated
reverse aliases, operator overrides, shared contract intersection and foreign
Codex template removal. Existing upstream console tests assuming mandatory keys
conflict with the previously deployed keyless UI; these are not newly claimed
passing. See [post-deployment catalog/evidence](gateway-model-catalog-fixed-20261102.json).

The native dashboard's AI Providers Codex page reads `config.codexApiKeys`; OAuth
Codex accounts are shown under Auth Files. Its empty API-key resource list does
not imply missing OAuth accounts. No account migration or relogin is needed.
