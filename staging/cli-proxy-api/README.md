# CLIProxyAPI staging install/bootstrap tool

One Python tool, no third-party dependencies (stdlib only):

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
```

The tool refuses roots that collide with production locations
(`/home/agent/tokligence-staging`, `/data`, `/etc`, …) or the repository
itself. It never starts the server and never prints key values.

## Launch (manual, by the parent/lifecycle stage)

```sh
/home/agent/cliproxy-staging/bin/cli-proxy-api \
  --config /home/agent/cliproxy-staging/config/config.yaml --local-model
```

`--local-model` uses embedded model catalogs; `models.catalog: ""` in the
config keeps explicit sources empty. The management panel is at
`http://127.0.0.1:4195/management.html`; both keys are under
`<root>/secrets/`.

## Not in scope (by design)

No wrapper proxy, no helper service, no custom/patched dashboard, no Plus
fork, no lifecycle scripts (start/stop are assigned separately). The tool
downloads public releases to verify hashes; it does not execute the backend.
