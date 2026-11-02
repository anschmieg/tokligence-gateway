# Source pins and deviations — Free Model Hub adoption

Status: staging artifact. Everything below was verified by reading the pinned
trees; no build, test or network call was made while producing this package.
The parent executes git/go outside this package.

## Upstream pin of record

| Field | Value |
| --- | --- |
| Repository | `https://github.com/Yousha-dev/free-model-hub` (public upstream) |
| Pinned commit | `4d025efe8046af70327d80f75c5bd5ac6b4505af` |
| Local pinned clone | `/tmp/free-model-hub-reference-20261102` (`.git/refs/heads/main` points at the pinned SHA) |
| Go toolchain | go 1.26 (declared in `go.mod`); the module has **zero third-party dependencies** |
| Module name | `free-model-hub` |
| Plugin identity | `pluginID = "free-model-hub"`; provider key `core.ProviderKey = "freehub"` (`free-system-go` account `type` with `vendor:"<vendorID>"`) |
| State directory | `~/.free-model-hub`, override via `FREE_MODEL_HUB_HOME` |

Verification pin format used in `prepare_free_model_hub.py`:

    Source of record. Verify: git clone https://github.com/Yousha-dev/free-model-hub
    PIN_HEAD = "4d025efe8046af70327d80f75c5bd5ac6b4505af"

The prepare script refuses to run against a clone whose HEAD does not equal
`PIN_HEAD` (fail-closed; any local drift means re-pin).

## Host ABI pin

| Field | Value | Verified against |
| --- | --- | --- |
| Host | CLIProxyAPI `8.0.49` | `/tmp/m2-eval/backend`, `/tmp/cliproxy-cloudflare-alpha-source` |
| Plugin ABI | `ABIVersion = 1`; exported init symbol `cliproxy_init`-style handshake via `cliproxy_plugin_init` | `internal/pluginhost/` |
| SDK config schema | plugin declares schema **6**; host schema is **10**; the host rejects only *future* schemas, so 6 loads | `internal/pluginhost/rpc_schema.go` |
| Plugin binary discovery | `<host config dir>/plugins/free-model-hub.so` (or `free-model-hub-v<semver>.so`) | `internal/pluginhost/platform.go` |
| Management routes | plugin-declared routes under `/v0/management/plugins/free-model-hub/...` (key-authenticated); resource pages under `/v0/resource/plugins/free-model-hub/...` (NOT management-authenticated) | `internal/pluginhost/management.go`, `internal/api/server_management.go` |

Do not build with a different upstream commit: `prepare_free_model_hub.py`
applies exact anchored edits whose "find" strings are exact pin text. A different
commit will either fail closed (best case) or fail silently off-context (never
accepted).

## Community sources inside the pinned upstream (`NOTICE.md`, reviewed 2026-10-29)

| Source | Commit | License | Used for |
| --- | --- | --- | --- |
| `jiandanc/CLIProxyAPI-freetier2api-plugin` | `e90609d0138c0cfd7f1e00c0f8c827f8e5c22d11` | MIT | Base: plugin ABI, console, login providers, OpenCode Zen lane |
| `xspeed1989/opencode-go-cliproxyapi` | `ede6a197fd69b24103dc15887ce0f517def8769a` | MIT | OpenCode Go catalog/protocol translators (`internal/ocgo`) |
| `dingguotu/oc2cpa` | `1876f22864e484bccd5c1dd683fef10942b60d52` | MIT | Keyless OpenCode Zen account reference (no code copied) |
| `tsaQB/cpa-freetier-plugin` | `1a51670c77238e7f2cc91d7edb6ea4ed73fdeca0` | README claims MIT; no LICENSE file | Keyless Kilo free pool reference (no code copied) |
| `sy0u1ti/cpa-our-free-model` | `a673eb52f9db94b6776863900a3861e48286b513` | MIT | Provider endpoint list, first-party providers only (no code copied) |

All code sources are MIT-family. `tsaQB` is "README claims MIT, no LICENSE
file": upstream only took the keyless-Kilo *idea*, not code, which is the
sound reading; keep it that way if this pin is ever refreshed.

Upstream deliberately did NOT adopt (recorded in its `NOTICE.md`, and reasons
are carried over into this deployment): reward farming/check-ins, unaudited
binary/Node runtime surfaces, third-party relays and resellers, prompt-rewriting
lanes, TLS-fingerprint sidecars, store/CI packaging. The scheduler in this
adopted build runs token keepalive only; quota reset reports "not supported".

## Adoption changes and verification

The authoritative edit inventory is `EDITS` / `NEW_FILES` in
`prepare_free_model_hub.py` and its generated `build/prepare-manifest.json`.
Do not rely on a hardcoded edit count. Changes implement vendor admission before
catalog/configuration work, foreign credential ownership guards, explicit scheduler
control, authenticated same-origin keyless console routing, redirect refusal in
both HTTP layers, and flow-YAML normalization with yaml.v3 v3.0.1 (same pin as host).
The upstream module itself is dependency-free; this adoption adds that YAML library.

Deployment admits all compiled vendors except OpenCode Zen/Go and OpenRouter.
Keyless provisioning is explicitly enabled for the remaining Kilo pool, while
scheduled keepalives are explicitly disabled. Native OpenCode 0.3.1 retains sole
ownership of Console OAuth and its recorded quarantine. No account/database is
copied or re-seeded. Prefix aliases avoid native model-name collisions.

Focused custom race tests and console JavaScript checks passed in the prepared
source. Actual-host testing proved schema6 loads on schema10, foreign auth remains
unchanged, excluded vendors stay absent, login providers remain visible, console
authentication works and one mock streaming inference succeeds. It also caught a
host callback redirect-policy gap, now being corrected before final acceptance.
No real provider traffic or deployment has occurred from these smoke tests.

The inherited `tsaQB` attribution ambiguity above is retained; no additional code
from that source is adopted. Provider support is not a guarantee of free quota.


## Final acceptance

Source0898748, FreeHub0.1.1-tokligence SHA
`b8ea4e20e1e4f43dbc8678f64e9d87bdff7879d2074a2f13f8557dae9d71013e`.
Native host .5 SHA
`fd20618ee87f376bd45de142aa2ce52d98202e9dedef2e2acc2b69fb8caac1ff`.
Actual-host isolated smoke `/tmp/freehub-native-host-smoke-g` passes, including
unique native credential identity (the upstream ID dropped the `.json` suffix;
this adoption preserves the host filename). Deployment and the subsequent Kilo
live diagnostic pass; other provider variants remain untested. See
`docs/design/free-model-hub-acceptance.json` for sanitized evidence.
