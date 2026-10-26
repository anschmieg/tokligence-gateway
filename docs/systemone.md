# OpenCode SystemOne / Jev

## Endpoint and contract

The gateway exposes `POST /v1/systemone` and forwards to the fixed upstream
`https://opencode.ai/inference/systemone/v1/systemone`. Clients authenticate to
the gateway with the existing `Authorization: Bearer <gateway-token>` header.
The gateway authenticates upstream with an eligible OpenCode Console OAuth token
or explicitly configured Console API key. Upstream headers are limited to
`Authorization` and `Content-Type`; client session/gate headers are not forwarded.

Request JSON preserves native structure:

```json
{
  "model": "jev-1.13-free",
  "state": "Command text to evaluate only: pwd",
  "questions": {
    "privileged": {"type":"noul","instructions":"Does this require administrator privileges?"},
    "risk": {"type":"score","instructions":"Rate command risk.","criteria":["Harmless read-only user operation","Modifies privileged system state"]},
    "kind": {"type":"choice","instructions":"Classify command.","criteria":{"read_only":"Read-only user command","privileged":"Privileged system modification"}}
  }
}
```

Model allowlist: `jev-1.13-free`; `jev-1.13` can be explicitly configured for
an account but is not enabled by default and is never a fallback. The request
body is bounded at 64 KiB; question count, text, criteria, response body (256
KiB), and wall clock (30 seconds upstream) are bounded. JSON/schema errors fail
before upstream calls. Successful responses must match the model and exact
question ID/type set; `noul` and probabilities/confidences are range-checked,
choices must be among submitted keys, and scores must be within submitted
criteria indices. Unknown native fields are preserved. Errors from upstream are
not relayed verbatim; gateway logs do not include request contents, upstream
body, client bearer, or upstream credential.

## Credential pool configuration

In `gateway.routes.yaml`, the `opencode-zen` provider's `opencode_pool`
contains ordered preferred credentials and backups. OAuth accounts are eligible
only for their configured `chat_models` and `systemone_models`; API keys are
System One-only. Never place credentials inline:

```yaml
opencode_pool:
  max_attempts: 3
  accounts:
    - id: primary-oauth
      credential_file: /data/zen/oauth.json
      chat_models: [beam-free]
      systemone_models: [jev-1.13-free]
    - id: secondary-oauth
      credential_file: /data/zen/secondary-oauth.json
      chat_models: [beam-free]
      systemone_models: [jev-1.13-free]
  api_keys:
    - id: primary-console-key
      env: OPENCODE_API_KEY
      systemone_models: [jev-1.13-free]
    - id: backup-console-key
      env: OPENCODE_BACKUP_API_KEY
      systemone_models: [jev-1.13-free]
```

Keep each account's credential file distinct. Add environment references to the
deployment's environment/secret mapping as well as the routing policy; the
provided Compose file already forwards `OPENCODE_API_KEY`, but does not
implicitly forward arbitrarily named backup keys. List the actual chat models
that each account may use, not an unverified wildcard.

The legacy `credential_file` and token-refresh settings on `opencode-zen` remain
the default single-account configuration. OAuth tokens reuse the Zen token
provider keyed by canonical credential file plus token URL/client ID, so
refresh/persistence has one owner per credential. SystemOne makes no session,
gate, or chat-shaping calls. OAuth eligibility was verified on October 21, 2026
with the Console OAuth credential. API-key support remains implemented but
requires operator verification because `OPENCODE_API_KEY` was unavailable during
this implementation.

Selection is sticky by hash of gateway principal plus request session (or a
stable default session). It is not round-robin. A failed account receives a
cooldown; requests use the preferred healthy account, then eligible backups up
to `max_attempts`. `Retry-After` is honored for 429 responses (bounded to 30
days); other failures get bounded cooldowns. The original model is retained for
every attempt; no cross-model or paid fallback occurs. Per-endpoint model
eligibility is explicit per pool member. Native calls use a 30-second total
budget and a 10-second per-attempt budget so a hung primary can be quarantined
and a backup attempted. Caller cancellation is not an account failure.

For chat traffic, each OAuth entry can set `egress: direct` or `egress: proxy`.
Direct bypasses `OPENCODE_ZEN_PROXY`; proxy requires it and never silently falls
back to direct. Omitted egress inherits the existing proxy environment setting.
The shipped primary uses the residential proxy and the secondary uses direct
VPS egress. Native SystemOne requests retain their existing direct transport.
Chat errors report safe per-account slot, egress, upstream HTTP status, known
error code/category, schema parameter where available, and cooldown reset time.
Quota-only exhaustion returns HTTP 429 with `Retry-After`, including requests
rejected locally during cooldown; provider response bodies and secrets are not
copied into diagnostics. A model rejection still cools the whole account, so
these diagnostics do not establish exhaustion of every other model.

Chat streams can retry an account after upstream streaming starts but before
meaningful output is exposed. Once text, reasoning, or a tool call is visible,
the gateway does not splice a fresh completion into that response: it emits a
terminal stream error, quarantines the failing account, and selects a backup
on a following request. This is not transparent resumption of already-visible
content. Direct chat retains incremental output. OAuth accounts have separate
minted-session/affinity stores while sharing the local OpenCode server's
lifecycle and authentication; token refresh ownership is shared by the actual
credential file, including filesystem symlink resolution.

## Live verification evidence

Direct native upstream probes were performed on October 21, 2026 using the
existing, unexpired Console OAuth access token. No refresh, session creation,
chat gate headers, alternate model, or authentication bypass was used.

- `2026-10-21T20:58:03.476Z`: harmless synthetic command evaluation; HTTP 200,
  `application/json`, valid typed `noul`, `score`, and `choice` answers.
- `2026-10-21T20:58:04.085Z`: privileged synthetic command evaluation; HTTP 200,
  `application/json`, valid typed answers.
- Repeat at `2026-10-21T20:58:46.232Z`: `pwd` evaluation returned `noul: 0.02`,
  `score: 0`, and `choice: "read_only"`; usage 388 input / 66 output tokens.
- Repeat at `2026-10-21T20:58:46.870Z`: synthetic
  `sudo usermod -aG sudo example-user` evaluation returned `noul: 0.97`,
  `score: 1`, and `choice: "privileged"`; usage 396 input / 67 output tokens.

All probes requested exactly `jev-1.13-free`. Native results contained `model`,
object-valued `answers`, and `usage`; choice/score probabilities and confidences
were present. The command strings were classification input only and were never
executed. These verify upstream OAuth compatibility, not a production gateway
deployment. Console API-key live verification remains blocked because
`OPENCODE_API_KEY` was not available in the test environment; no conclusion
about that key's access rights is claimed.

The implemented local gateway was then exercised with real upstream OAuth:

- `2026-10-21T22:38:39.713Z`: bearer-authenticated `POST /v1/systemone`, harmless
  case, HTTP 200, valid native response; `noul: 0.02`, `score: 0`,
  `choice: "read_only"`, usage 388 / 66.
- `2026-10-21T22:38:40.465Z`: privileged case, HTTP 200, valid native response;
  `noul: 0.98`, `score: 1`, `choice: "privileged"`, usage 396 / 67.

Both used `jev-1.13-free`, the existing unexpired OAuth access token, a transient
local gateway bearer, and a synthetic session ID. No credentials were printed,
no refresh was needed, and no command was executed.

Jev output is probabilistic, untrusted model data, not an authorization decision
by the gateway. Enforce independent application policy and human approval where
needed before executing any command; do not allow a model score to grant
privileges or suppress mandatory checks.

## Adversarial review and regression verification

Independent read-only reviews covered authentication boundaries, outages,
streaming integrity, native response validation, OAuth ownership, and privilege
escalation risk. They identified and then re-verified fixes for:

- Shared session-server password/startup ownership with account-local sessions.
- Hung native requests starving backups; timeout quarantine now permits failover.
- Native-only keys advertising unusable chat models.
- Symlink aliases creating competing rotating-token owners.
- An overly short first-token timeout, UTF-8 handoff corruption, exhausted-account
  retries skipping route-plan backups, and error finish reasons counted as success.

No outstanding findings remained in those bounded follow-ups. Reviewers ran
20 native/auth tests and 44 broader streaming-related tests independently.
A subsequent fresh review found six additional cases: private session-start
errors leaking into executor logs, setup waits ignoring cancellation/deadlines,
unsuccessful finish reasons accepted after stream handoff, non-SSE pooled
responses bypassing validation, concurrent failures shortening cooldowns, and
concurrent first requests splitting sticky sessions. Fixes now sanitize both
error boundaries, race setup waits against cancellation, bound version probes,
apply strict terminal validation after handoff, reject unexpected pooled
response protocols before output, preserve the longest cooldown, and coalesce
per-session selection. Dedicated regressions reproduce these cases.

The latest coordinator full regression run passed **227/227 tests**; lint and
whitespace checks passed. Independent follow-up confirmed all six fixes, passing
15/15 network-free session/codec tests plus synthetic cancellation, late-rejection,
terminal-error, and cooldown checks. No remaining material regression was found
in the reviewed active request paths.

One nonblocking lifecycle race remains: calling a session pool's `close()` while
a mint is pending can allow that old mint to restore pre-close affinity. No
production callers of `close()` were found. Before using it for runtime reset or
disposal, add a generation fence and regression tests for both completion orders.
These checks are not guarantees against all provider behavior; real multi-account
chat failover and Console-key access still require deployment credentials and
operator verification.

## Operations, verification, rollback

1. Configure OAuth account file references and/or a Console API-key env
   reference in the deployment secret manager; keep credential files on the
   persistent volume with private permissions. Do not duplicate an OAuth refresh
   token in another client or manually refresh it.
2. Run `npm run lint` and `npm test`, then build an image tagged with the
   release revision, for example `docker build -t tokligence-gateway:systemone .`.
   Keep the previous image/tag and matching route configuration before updating
   the deployment. The Docker build downloads external tools and can fail
   independently of gateway tests.
3. Deploy to a canary and test only harmless synthetic classification inputs.
   Record timestamp, model, HTTP status, content type, answer type validity and
   usage counts. Never execute submitted command text. Do not log the body or
   credential.
4. Confirm `GET /v1/models` does not advertise Jev and that chat, Messages,
   and Responses requests for Jev return the native-endpoint guidance error.
5. Roll back by redeploying the previous image and its matching route config.
   Keep the previous image available until canary and application checks pass.
   Rollback does not alter credentials or refresh-token files.

No production deployment or live API-key call was performed as part of this
implementation. The local Docker build was attempted but blocked before any
application build step: the environment's OCI runtime could not open
`net.ipv4.ip_unprivileged_port_start` (permission denied). Runtime COPY coverage
is tested separately; a successful container build remains an operator check.
