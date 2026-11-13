# Gateway product scope refactor: bounded execution runbook

Status: milestone 1 planning artifact for a lower-cost implementation agent.
Date: 2026-11-01. The user has authorized autonomous branch/staging implementation. Each delegated milestone receives a bounded parent brief and ends for parent validation; this document is not a request for repeated user permission. Milestones2–4 below are read-only. Later implementation, synthetic execution and staging deployment are authorized through their scoped briefs; production promotion and new provider inference are excluded unless explicitly admitted.

## User correction: verification scope

Do not implement the previously delegated broad synthetic CLIProxyAPI core fixture. Rely on upstream documentation/tests for unchanged standard functionality. Subsequent milestones prioritize actual provider/plugin implementation; add targeted tests only for our changes and concrete integration/configuration risks. A minimal startup/API smoke check is sufficient for an unchanged upstream binary. Earlier broad test lists below are narrowed by this rule.

## Guardrails that apply to every milestone

- Backend is only mainline `https://github.com/router-for-me/CLIProxyAPI`; management UI is only its native upstream CLI Proxy API Management Center. Do not use the Plus fork or build a competing management UI.
- Preserve native CLIProxyAPI inference and management APIs as directly usable integration surfaces for T3 Code hubs. Hub contract discovery is external and read-only; do not invent methods or payloads.
- Prefer provider, executor, or plugin customization. A runtime helper is allowed only after a concrete requirement fails through an evaluated extension point and the exception records the limitation, tested alternatives, state owner, maintenance cost, and retirement condition.
- Never read, print, copy, seed, rotate, refresh, or migrate production credentials or databases. No OAuth login/refresh, provider inference/quota probes, account/IP changes, production changes, timers, subagents or PRs by default. SSH writes and staging deployment require a later scoped implementation brief after the preceding gates pass.
- Provider 429 evidence remains unresolved. Stop inference work at any 401/403/429, malformed stream, timeout, or uncertain outcome. Do not retry, rotate, or infer cause.
- Keep all unrelated existing changes. Do not edit application code during the evidence and architecture milestones. Every implementation milestone uses a separate reviewable commit and ends for parent review.

## Milestone 2 — Pin and inspect upstream foundation (source only)

**Files/artifacts:** add `docs/design/cli-proxyapi-upstream-evaluation.md`; record exact mainline CLIProxyAPI release/tag/commit and checksum; record exact compatible native dashboard release/tag/commit/checksum; save source permalinks for relevant handlers, extension interfaces, config schema, management APIs, and dashboard-originated requests. Do not download/execute binaries.

**Commands:**

```sh
git status --short --branch
git diff --check
git ls-remote --tags https://github.com/router-for-me/CLIProxyAPI.git
git ls-remote --tags https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git
```

Use public source browsing or read-only archives at the selected tag/commit. Do not clone into this repository or run upstream code. Avoid dumping local environment/config values. The `ls-remote` commands only enumerate public tags; use another read-only public-source method if network policy blocks them.

**Acceptance:** source and artifacts identify mainline ownership, version pairing, licenses, maintenance signals, native route/API inventory, provider/executor/plugin lifecycle and ordering, management read/write behavior, auth boundaries, browser test request origin, retry/refresh/fallback defaults, and any feature unknowns. No extension capability is claimed without a code reference. The backend/dashboard pair meets the v8/config migration and dashboard `/v8/management` compatibility precondition from the plan; the old 7.x schema cannot be assumed compatible.

**Rollback:** documentation-only commit can be reverted without affecting runtime. Preserve source references and hashes in the reverted commit record for audit.

**Stop conditions:** no pinned compatible pair; unclear license/provenance; Plus code/fork required; extension ordering cannot enforce a required invariant; dashboard can send upstream credentials or inference outside guarded server dispatch; unknown management semantics; or evidence would require reading a secret/live state. Record the exact blocker and stop for parent review.

## Remaining implementation sequence (supersedes the former milestones3–6)

The inventory and public source evaluation are complete. Do not repeat them or build a broad synthetic platform fixture. Existing source evidence is in `cli-proxyapi-upstream-evaluation.md`; parent validation qualifies its management bypass and dispatch-limit claims.

### Next child: staging foundation implementation

Scope: add an isolated deployment/config example and operational instructions under `staging/cli-proxy-api/`. Use mainline8.0.49 and native dashboard1.27.0, reverify the actual target-architecture artifact before execution. No Plus, custom UI, wrapper proxy or general test framework. Existing OpenCode staging at `/home/agent/tokligence-staging` and its state/ports are reserved; use separate project/root/ports/storage. Never import production or OpenCode credentials.

Deliver: reproducible pinned staging deployment, bootstrap-only native config, documented management/network protection, disabled unwanted updates and documented retry defaults. Run credential-free startup/dashboard/API-auth/persistence smoke checks; no provider inference. Parent may authorize the concrete staging deployment within the existing user scope after inspecting its manifests. Use public source/documentation for ordinary upstream behavior. Do not modify production artifacts or make live credentials a prerequisite to the empty staging setup.

Review: exact diff, artifact provenance, isolated paths/ports/volumes, credential ownership, smoke record and stop/restart/rollback commands. If a required host/deployment detail cannot be discovered safely, finish the local deployable artifact and name only that blocker.

### Following child: provider configuration and first useful route

Map all existing routes to built-in, generic compatible, custom-required or retained legacy. Implement documented native provider configuration first. Select one useful supported route with an available isolated credential; parent handles credential delivery/ownership without dumping values. Live checks need a bounded admitted case and must honor existing cooldowns. T3 native-hub connection is tested through its actual setup/discovery, not an invented conformance suite. Missing access blocks that connection, not all provider work.

### Following children: one custom provider at a time

Implement only the selected provider/plugin and its focused tests, using the platform's documented extension points. No helpers unless a demonstrated limitation justifies one. OpenCode retains explicit OAuth/session/reasoning/tool/quota requirements and existing evidence; fake-upstream tests target our custom changes only. Parent validates every major commit before staging integration. No production promotion without a concrete reviewed packet. Preserve all existing reports, cooldowns and single-refresh ownership.

Each child brief must name exact files/artifacts, acceptance commands, allowed environment actions and rollback. Broaden tests only for changed behavior, failures or an unresolved integration risk. Do not seek routine user approval between reversible authorized steps.
