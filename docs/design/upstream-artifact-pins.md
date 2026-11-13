# Upstream artifact pin manifest (milestone 2)

Status: pin record for the gateway refactor foundation. Source-only verification; artifacts were hashed, never executed. Date: 2026-11-01.
Companion analysis: [cli-proxyapi-upstream-evaluation.md](cli-proxyapi-upstream-evaluation.md).

Pairing rule: the two artifacts below are pinned as a unit. Do not upgrade either independently (`gateway-product-scope-refactor.md:47`).

## Backend: router-for-me/CLIProxyAPI

| Field | Value |
| --- | --- |
| Release tag | `v8.0.49` |
| Release URL | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.49 |
| Tag commit | `250d598175db61a4e99ac38b9164ed04745754e5` |
| Commit date | 2026-10-31 (published 2026-11-01T04:54:47Z) |
| License | MIT (`LICENSE` at tag) |
| Source verification | shallow clone at tag, `git log -1` hash matches tag object |

### Release assets (linux, production targets)

| Asset | SHA-256 (verified) | Verification method |
| --- | --- | --- |
| `CLIProxyAPI_8.0.49_linux_amd64.tar.gz` | `f61d5e27ed46c1eebfdd240eb50cf15d6d6be38b22159e9618a667f671f22d94` | downloaded + `sha256sum` recomputed; matches release API `digest` and `checksums.txt` |
| `CLIProxyAPI_8.0.49_linux_aarch64.tar.gz` | `685bbc0a99a6f8b4ddfaa1666f446a0d7a6ee36ea53216b29e2fb7e0c6a5711b` | release API `digest` + `checksums.txt` (not recomputed locally) |
| `CLIProxyAPI_8.0.49_linux_amd64_no-plugin.tar.gz` | `88efe5cd6de65e9bf6ee7278120554ea07578ccf77b9326356decab832502174` | release API `digest` + `checksums.txt` (not recomputed locally) |
| `CLIProxyAPI_8.0.49_linux_aarch64_no-plugin.tar.gz` | `a0a141285a0ec4b01e7fdb7aa754f31b968cfeebaa87ddbe707712217e14511c` | release API `digest` + `checksums.txt` (not recomputed locally) |
| `checksums.txt` | `sha256:863c42e33a281bf03f507a96118248eae07e3d4a908016ab35a6af4ae8bfcd9b` | release API `digest` (asset itself downloaded and used for cross-checks) |

`checksums.txt` cross-check: the four linux asset hashes above all appear in the downloaded `checksums.txt` for this release. Other-platform assets (darwin/windows/freebsd) are listed in the same file and intentionally not pinned here.

## Dashboard: router-for-me/Cli-Proxy-API-Management-Center

| Field | Value |
| --- | --- |
| Release tag | `v1.27.0` |
| Release URL | https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/tag/v1.27.0 |
| Tag commit | `4e4aeff23f9f82b3ccdbe48b2e774d5dc918234e` |
| Commit date | 2026-10-31 (published 2026-10-30T20:06:40Z) |
| License | MIT (`LICENSE`, "Copyright (c) 2026 Router-For.ME") |
| Compatibility | README requires CLI Proxy API ≥ 8.0.0, uses `/v8/management` with no v0 fallback (`README.md:35` at tag) |

### Release assets

| Asset | SHA-256 (verified) | Verification method |
| --- | --- | --- |
| `management.html` | `2ca7a226f8d2fa078fb52e12fd5b75762ded2dc585205d3da509ebfb17ea2adf` | downloaded (3,702,882 bytes) + `sha256sum` recomputed; matches release API `digest` |

This is the release's only asset.

## Re-verification commands (for later milestones)

```sh
# Backend digest
curl -fsSLo /tmp/cpa.tar.gz https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.49/CLIProxyAPI_8.0.49_linux_amd64.tar.gz
echo "f61d5e27ed46c1eebfdd240eb50cf15d6d6be38b22159e9618a667f671f22d94  /tmp/cpa.tar.gz" | sha256sum -c -

# Dashboard digest
curl -fsSLo /tmp/management.html https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.27.0/management.html
echo "2ca7a226f8d2fa078fb52e12fd5b75762ded2dc585205d3da509ebfb17ea2adf  /tmp/management.html" | sha256sum -c -

# Tag-to-commit re-check
git ls-remote --tags https://github.com/router-for-me/CLIProxyAPI.git v8.0.49
git ls-remote --tags https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git v1.27.0
```

## Deployment-note status (from the evaluation)

- If a patched dashboard variant is later chosen (connectivity-test bypass mitigation, evaluation §"Mitigation options"), its build must be recorded here as a separate derived artifact with its own digest and the source tag it was built from. **No derived artifact exists yet.**
- Backend container images on GHCR were not evaluated in this milestone; the current Tokligence build installs the release archive directly (`Dockerfile:1-18`). Any future image pin belongs in the staging proposal (milestone 4), not here.

## Version-selection note

`v8.0.49` is the newest backend release at evaluation time (released 2026-11-01, one day before this evaluation). It is pinned as newest-stable, not as "latest forever": upstream cadence is roughly daily patches. Future bump criteria: a required security fix, a needed provider feature, or a dashboard compatibility break — each with a fresh round of this manifest's verification steps and a plan-level review, per the pairing rule.
