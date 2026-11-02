# Gateway alpha — gateway-alpha-20261102.1

This alpha uses the existing CLIProxyAPI deployment on the private Tailscale
network. It does not move production OAuth or replace the production ingress.

## Use now

- Dashboard: <http://100.74.55.86:4195/management.html>
- OpenAI API base: `http://100.74.55.86:4195/v1`
- Anthropic Messages endpoint: `http://100.74.55.86:4195/v1/messages`
- Model: `openrouter/nemotron-3.5-lightning-free`
- Inference key: existing private VPS file
  `/home/agent/cliproxy-staging/secrets/client-api-key`.
- Dashboard/management key: separate private VPS file
  `/home/agent/cliproxy-staging/secrets/management.key`.

Keys are not included in the release. Use a client on the same authorized
Tailscale network and the inference key in its normal API-key setting. The T3
usage hub uses the management API separately; connecting that hub alone does
not configure model inference.

## Verified and remaining

The deployed mainline-based CLIProxyAPI8.0.49-tokligence.3 serves its pinned
native dashboard. A single live free OpenRouter request passed streaming
Messages translation and an inert tool proposal. The route has one key,
retry0, automatic redirects disabled, provider fallback disabled and zero-price
routing constraints. No tool was executed; live reasoning continuation is
untested. Usage/rate limits of the upstream free service still apply.

OpenCode's secondary OAuth has one owner here. Its first live request returned
429; the credential remains disabled. The subsequent Console org-header and
model-restriction fixes are deployed, but corrected live behavior is untested.
Do not re-enable or retry it through the dashboard. The upstream management
API-call utility can bypass disabled-credential dispatch checks; a narrow fix
is in progress. Do not use management connectivity/verification/test actions
as acceptance tests or quota recovery.

Cline's custom plugin has isolated host evidence, but is not live-configured.
Mistral's existing key is available privately, but no free entitlement or live
acceptance is claimed. Full production migration and general gateway feature
parity are not part of this alpha's completed coverage.

## Operations

Deployment root remains `/home/agent/cliproxy-staging`; retaining this path avoids
unnecessary state/credential migration. The alpha release records the exact
running backend/plugin/dashboard hashes, source revision, native model listing
and health result. No new provider inference is needed for release admission.
Previous backend/plugin rollback artifacts and all live reports/cooldowns stay
in place. The alpha manifest is a release record, not a second configuration
store; the native management API remains the configuration owner.

OpenCode free-model compatibility is the first priority after this release.
Defer additional providers and speculative parity features until that path is
resolved or a precise external blocker is established.
