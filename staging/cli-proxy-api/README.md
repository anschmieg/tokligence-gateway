# CLIProxyAPI staging install/bootstrap tool

Two Python tools, no third-party dependencies (stdlib only):

- `staging/cli-proxy-api/cliproxy_staging.py install` — downloads the two
  pinned public release artifacts, verifies SHA-256 **against the downloaded
  bytes** for the **actual host architecture** (`aarch64`/`arm64` → the
  `linux_aarch64` asset, `x86_64` → `linux_amd64`), and installs the **native
  CLIProxyAPI binary** and the **native `management.html` dashboard** into a
  NEW caller-specified root (default `/home/agent/cliproxy-staging`).
- `staging/cli-proxy-api/cliproxy_staging.py bootstrap` — writes the
  once-only loopback configuration (bind `127.0.0.1:4195`) with an **empty
  auth state**, privately generated management + client keys (mode `0600`,
  values never printed), no providers, asset auto-update disabled, and the
  `--local-model` launch instruction.
- `staging/cli-proxy-api/cliproxy_lifecycle.py start|stop|status|smoke` —
  start, stop, inspect, and smoke-check the installed server (below).

Pins are from `docs/design/upstream-artifact-pins.md`:

| Artifact | Version | SHA-256 |
| --- | --- | --- |
| `CLIProxyAPI_8.0.49_linux_amd64.tar.gz` | v8.0.49 | `f61d5e27…7f22d94` |
| `CLIProxyAPI_8.0.49_linux_aarch64.tar.gz` | v8.0.49 | `685bbc0a…a5711b` |
| `management.html` | v1.27.0 | `2ca7a226…17ea2adf` |

Both linux archive digests and the dashboard digest were re-verified against
the actual downloaded bytes on 2026-11-01 (both are full 64-hex digests). The
installer validates every pin is exactly 64 hex characters before use and
refuses truncated digests.

## Layout

```
<root>/bin/cli-proxy-api                  # native backend binary, 0755
<root>/config/config.yaml                 # written by bootstrap, 0600
<root>/config/static/management.html      # native dashboard, pre-placed
<root>/auth/                              # empty auth state, 0700
<root>/secrets/management.key             # 0600, never printed
<root>/secrets/client-api-key             # 0600, never printed
<root>/manifest.json                      # pin + path record
<root>/.lifecycle.json                    # private pid record, 0600 (start)
<root>/.lifecycle.lock                    # OS held lock, never unlinked
<root>/lifecycle.log                      # server stdout/stderr, 0600
```

The server resolves the control panel as `<config-dir>/static/management.html`
and only downloads it when missing, so pre-placing the pinned asset there
(together with `disable-auto-update-panel: true`) keeps the install offline
after download: no panel fetch on first access, no 3-hourly auto-update.

## Use

```sh
# 1. Install into a NEW root (must be nonexistent or empty)
python3 staging/cli-proxy-api/cliproxy_staging.py install \
  --root /home/agent/cliproxy-staging

# 2. Bootstrap once (idempotent: an existing config is never overwritten)
python3 staging/cli-proxy-api/cliproxy_staging.py bootstrap \
  --root /home/agent/cliproxy-staging

# 3. Lifecycle (start/stop/status/smoke)
python3 staging/cli-proxy-api/cliproxy_lifecycle.py start  \
  --root /home/agent/cliproxy-staging
python3 staging/cli-proxy-api/cliproxy_lifecycle.py smoke  \
  --root /home/agent/cliproxy-staging
python3 staging/cli-proxy-api/cliproxy_lifecycle.py status \
  --root /home/agent/cliproxy-staging
python3 staging/cli-proxy-api/cliproxy_lifecycle.py stop   \
  --root /home/agent/cliproxy-staging
```

Both tools refuse roots that collide with production locations
(`/home/agent/tokligence-staging`, `/data`, `/etc`, …) or the repository
itself. The installer never starts the server; neither tool prints key
values, raw config, or server log content.

## Lifecycle behavior (`cliproxy_lifecycle.py`)

`start` launches the pinned binary directly
(`<root>/bin/cli-proxy-api --config <root>/config/config.yaml --local-model`,
working dir `<root>`) with stdout/stderr to the private `<root>/lifecycle.log`,
then polls `GET /healthz` (bounded 20 s) and records the child's
PID, kernel start time, UID, and full command line in a private
`<root>/.lifecycle.json`. Before launching it refuses when:

- an owned process is already running (duplicate start),
- the loopback port `127.0.0.1:4195` is occupied (checked with
  `SO_REUSEADDR`, so stale TIME_WAIT sockets do not cause false refusals —
  the pinned binary itself exits 0 on a bind conflict, so the tool cannot
  rely on the child's exit status),
- the config does not match the credential-free loopback staging shape
  (bind host/port, `allow-remote: false`, empty catalogs, plugins off,
  auto-update off) or contains provider/upstream credential groups
  (`api-keys:` root, `openai-compatibility:`, `base-url:`, provider
  `api-key:`, or `allow-remote: true`).

`stop` signals **only a process it can re-verify**: the recorded PID must be
alive with the same kernel start time (defeats PID recycling), same UID,
executable, and full command line, and the record's own stored fields must
match. A stale or foreign record is never signalled; it is kept for
inspection. SIGTERM (10 s wait), `--force` escalates to SIGKILL. After a
verified stop the record is removed.

`status` reports running (with PID/UID/start time) or stopped, without
signalling anything.

`smoke` runs against the live owned server, without printing key values:

1. `GET /healthz` → 200.
2. `GET /management.html` → 200 and bytes hash to the pinned v1.27.0 digest.
3. Auth boundary: `/v8/management/config` → 401 without a key, 200 with the
   management key, rejected with the client key; `/v1/models` → 200 with the
   client key, rejected with the management key.
4. Config/key persistence across one restart: stop the owned process, start
   again, and check the config is byte-stable and both keys still
   authenticate. (The backend rewrites `config.yaml` on first launch — keys
   are hashed in place — so stability is only asserted after the first
   start, never against the bootstrap plaintext.)

Concurrent lifecycle commands serialize on an OS-held lock
(`<root>/.lifecycle.lock`, never unlinked). Verified against the pinned
`8.0.49` linux-aarch64 binary and `1.27.0` dashboard on 2026-11-01.

## Bootstrap recovery

Bootstrap holds an OS descriptor lock and publishes configuration after private key files. Interrupted initialization may leave partial private files and fails closed on retry; inspect only this new, unused staging root before manually removing it and reinstalling. Never apply cleanup to a root that has accepted credentials or configuration edits. Protected production/OpenCode trees and repository descendants are rejected.

The pinned panel asset prevents the normal missing-asset fetch while present; it is not a blanket network isolation guarantee. Native background behavior is reviewed separately before adding credentials.

## Deployed foundation checkpoint — 2026-11-01

Parent integrated lifecycle commit d966978 and deployed scripts to `/home/agent/cliproxy-staging` on the VPS. Pinned backend8.0.49/native dashboard1.27.0 are running loopback-only at127.0.0.1:4195. Minimal smoke passed: health, served dashboard digest, management/client authentication separation and one-restart config/key persistence. Auth storage is empty; no providers configured and no inference performed. Existing OpenCode staging and production were not changed. Native T3 hub connection and provider routes remain unverified.
