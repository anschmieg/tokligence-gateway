# Free Model Hub adoption

Pinned upstream: `Yousha-dev/free-model-hub` at
`4d025efe8046af70327d80f75c5bd5ac6b4505af`. The preparation script exports that
commit into a fresh directory and records exact anchored edits and file hashes.
It never changes the reference checkout or deploys anything.

The complete plugin is retained. All vendors except `opencodezen`, `opencodego`
and `openrouter` are admitted, including its login providers. Our native OpenCode
OAuth plugin and native OpenRouter route remain their respective owners. Existing
foreign credential files are refused before vendor parsers run.

Deployment configuration enables the admitted Kilo public pool only. OpenCode
public provisioning is excluded by vendor admission. Scheduled keepalives are off;
loading performs catalog discovery, never inference. Provider availability and free
entitlement remain subject to each provider; compiled support is not live acceptance.
Models use upstream prefix aliases to avoid native-route collisions.

The console is served through native management authentication at:
`https://code.nothing.pink/admin/v0/management/plugins/free-model-hub/console`.
Its requests use the existing same-origin Cloudflare Access session and never
read or send a browser Management Key. Native key API access remains supported.
The unauthenticated static resource redirects to the protected console in this mode.
No new proxy or resource-path authentication exception is introduced.

## Build and focused verification

```sh
python3 staging/cli-proxy-api/free-model-hub/prepare_free_model_hub.py --output /tmp/freehub-build-NEW
cd /tmp/freehub-build-NEW
GOTOOLCHAIN=go1.26.10 go test ./internal/core ./internal/app ./internal/tasks ./internal/admin ./internal/vendors/opencodezen ./internal/hostbridge -run 'Test(ApplyAdmission|Free[Hh]ub|Foreign|IsForeign|LooksLikeCredential|Scheduler|Page|ValidateManagementBase|Disabled|BridgeClients)' -race -count=1
GOTOOLCHAIN=go1.26.10 go build -buildmode=c-shared -ldflags '-X main.pluginVersion=0.1.0-tokligence.1' -o /tmp/free-model-hub.so .
```

The native host can serialize plugin configuration as flow YAML. The adoption
normalizes it with the host's pinned `gopkg.in/yaml.v3 v3.0.1` before the upstream
scalar/list decoder. Both plugin HTTP clients and the native ABI callback clients
must refuse redirects; a single caller request must not create hidden dispatches.

Parent verification: custom focused race tests and console JavaScript behavior
checks pass. Final actual-host coexistence smoke and deployment pass. It caught
and prompted fixes for flow YAML, ABI redirect policy and native filename IDs.
Current plugin version is `0.1.1-tokligence`; Kilo subsequently passed one live
streaming acceptance after a permitted response-cap diagnostic. Other vendors
remain untested.
See `testing/README.md` for the mandatory network-isolated mock run. Its results
prove custom integration only, not real provider acceptance.

## Multiple credentials

The native host already selects eligible credentials per model using round-robin
by default. The plugin preserves each file's identity and forwards the selected
Kilo API key or Cline OAuth access token. No additional pool or refresh owner is
needed. Current dispatch policy remains one credential per caller request,
`request-retry: 0` and `max-retry-credentials: 1`; a rejected request is not replayed
against another account. A later independent request can select a healthy account.

Verified on November 2 with the exact deployed native `.6`, FreeHub `0.1.4`, and
OpenCode `0.3.1` artifacts using two fake Kilo keys and two fake Cline accounts:

```sh
python3 staging/cli-proxy-api/free-model-hub/testing/isolated_host_smoke.py \
  --binary /tmp/cli-proxy-api-native-oauth-budget \
  --plugin /tmp/free-model-hub-cline-attribution.so \
  --opencode-plugin /tmp/opencode-native-parity-031.so \
  --multiple-credentials --output /tmp/freehub-multiple-credentials-NEW
```

Passing evidence: `/tmp/freehub-multiple-credentials-b/verdict.json`. The native
host selected Kilo A/B, returned A's simulated 429 without another dispatch, used
B on the next caller request, and selected Cline A/B on their routes. Six mock
POSTs, zero external provider requests; disabled OpenCode remained untouched.
The first fixture run had the wrong Cline mock URL prefix and failed; the corrected
fixture uses the provider's `/api/v1` prefix. This proves account isolation and
routing, not additional real quota or live acceptance of extra credentials.

**Kilo does not offer independent free request limits per account on one IP.** Its
[billing documentation](https://kilo.ai/docs/gateway/usage-and-billing#rate-limiting)
explicitly applies 200 free requests/hour/IP to both anonymous and authenticated
traffic. Multiple keys do not multiply that allowance. Provider account balances,
organization entitlements, and API-key limits must be distinguished from shared
network limits; do not infer extra free capacity from a larger credential count.

Live inventory at this check has one anonymous Kilo entry and one Cline OAuth
account, so real two-account acceptance is not yet possible for either. Users can
add independent Cline accounts through the existing FreeHub login and Kilo API keys
through Add API key, but additional Kilo keys are not needed for free capacity.
Groq and NVIDIA each have two keys already; their earlier access/availability
failures are separate from multi-credential routing and were not re-tested here.

## Deployment and rollback

Install only the verified `.so` as `plugins/free-model-hub.so`, together with the
reviewed scoped plugin configuration and native callback redirect fix. Preserve all
native settings, credentials, quarantine, cooldowns and live reports. Use a stopped,
lock-verified single-owner backend replacement and a one-shot deployment journal.
Rollback restores the previous backend and removes/disables only this plugin;
never restore an old OAuth owner or enable keepalives as part of rollback.

See `SOURCE-PINS.md` for upstream attribution and `integration/SEAMS.md` for routes.
