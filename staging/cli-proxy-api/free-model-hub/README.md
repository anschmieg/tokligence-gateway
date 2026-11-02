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
checks pass. Actual-host coexistence testing found and prompted fixes for flow
YAML and ABI redirect policy; final integrated smoke/deployment remain pending.
See `testing/README.md` for the mandatory network-isolated mock run. Its results
prove custom integration only, not real provider acceptance.

## Deployment and rollback

Install only the verified `.so` as `plugins/free-model-hub.so`, together with the
reviewed scoped plugin configuration and native callback redirect fix. Preserve all
native settings, credentials, quarantine, cooldowns and live reports. Use a stopped,
lock-verified single-owner backend replacement and a one-shot deployment journal.
Rollback restores the previous backend and removes/disables only this plugin;
never restore an old OAuth owner or enable keepalives as part of rollback.

See `SOURCE-PINS.md` for upstream attribution and `integration/SEAMS.md` for routes.
