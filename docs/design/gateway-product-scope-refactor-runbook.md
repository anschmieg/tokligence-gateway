# Gateway product scope refactor: bounded execution runbook

Status: milestone 1 planning artifact for a lower-cost implementation agent.
Date: 2026-11-01. This runbook authorizes no deployment, credentials, live inference, external account action, timer, or production change. The parent reviews each milestone before authorizing the next.

## Guardrails that apply to every milestone

- Backend is only mainline `https://github.com/router-for-me/CLIProxyAPI`; management UI is only its native upstream CLI Proxy API Management Center. Do not use the Plus fork or build a competing management UI.
- Preserve native CLIProxyAPI inference and management APIs as directly usable integration surfaces for T3 Code hubs. Hub contract discovery is external and read-only; do not invent methods or payloads.
- Prefer provider, executor, or plugin customization. A runtime helper is allowed only after a concrete requirement fails through an evaluated extension point and the exception records the limitation, tested alternatives, state owner, maintenance cost, and retirement condition.
- Never read, print, copy, seed, rotate, refresh, or migrate production credentials or databases. No OAuth login/refresh, provider inference/quota probes, account/IP changes, SSH writes, runtime deployment, production changes, timers, subagents, or PRs under this runbook.
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

## Milestone 3 — Discover and freeze the real T3 hub contract (read-only)

**Files/artifacts:** add `docs/design/t3-code-hub-contract-inventory.md` and sanitized fixtures under `docs/design/fixtures/t3-hub/`. Include the actual hub implementation/docs version, path+method, auth, request/response fields, API version, streaming/cancel, timeouts, reconnect behavior, native discovery, config writes, credential operations if actually used, errors, and unused operations explicitly. Remove bearer values, provider prompts, and user data from fixtures.

**Commands:**

```sh
rg -n 'CLIProxyAPI|hub|/v1/models|/v1/providers|management' <read-only-hub-source-root>
```

`<read-only-hub-source-root>` must be supplied by the parent or found via approved repository/source discovery. Do not guess a hub implementation path or access another system using credentials. Read only tracked source and public documentation.

**Acceptance:** each contract row has a source permalink and sanitized fixture or an explicit “not used/not found”; API version and native management operations are evidenced. Tests are only planned here; this milestone does not assert compatibility or write to a hub.

**Rollback:** revert the docs/fixture commit. No hub state is touched.

**Stop conditions:** no authoritative source/docs, unclear permission boundary, requirement to call the hub or access private data, or an operation that would mutate remote state. Record discovery as blocked/unknown for parent review; do not infer a contract from a sample chat request.

## Milestone 4 — Select the isolated staging shape (proposal, no deployment)

**Files/artifacts:** add a sanitized proposed layout under `docs/design/staging-layout-proposal.md` (or update the inventory); list existing Compose/Coolify/build mechanisms, isolated project/network/volume names, ingress boundary, secret-manager reference names only, image digests, initial-config bootstrap rule, persistence/redeployment behavior, and rollback snapshots. Do not add executable deployment manifests in this milestone.

**Commands:**

```sh
rg --files -g 'docker-compose*.yml' -g 'compose*.yml' -g 'Dockerfile*' -g '.github/workflows/**' -g '*coolify*'
git status --short
```

Ask the parent to arrange read-only confirmation of current staging ownership/topology if it is not in source. No SSH, host API, secret manager, deployment UI, or mounted volume access.

**Acceptance:** staging is distinct from production at source, persistent volume, network, hostname, and credentials; backend/dashboard artifacts are immutably pinned; native APIs remain reachable to approved hubs without mandatory custom façade; dashboard management stays authenticated and network protected; no live configuration is initialized from production. Staging topology is a proposal until a later explicit authorization.

**Rollback:** revert the proposal. No infrastructure has been created.

**Stop conditions:** cannot establish isolated storage/network/credentials, existing provider cooldown or owner conflict would be touched, management must become public/anonymous, or source state implies a production mutation. Stop and report; do not “test” by deploying.

## Milestone 5 — Offline contract fixtures and source-level extension decision

**Files/artifacts:** only after parent approval, add sanitized request/response fixtures and an architecture decision record naming the first ordinary provider slice, exact extension hook and owner. Implementation may touch only the selected provider/executor/plugin package and required fixture/test files. Any helper exception must include the required evidence. Do not edit existing Tokligence routes until an explicit migration slice is authorized.

**Commands:** select exact repository scripts after inspecting `package.json`; expected checks are `npm run lint`, focused `node --test <selected-fixture-test>`, and `git diff --check`. Never run live-provider tests. Do not run broad `npm test` without explicit parent approval because test coverage includes live/integration-oriented scripts.

**Acceptance:** offline contract and fault tests prove direct native API availability, exact model selection, no hidden fallback/retry, credential ownership labels only, safe config revision/write behavior, streaming cancellation if in-scope, and the inventoried T3 contract. Physical dispatch count is asserted only against a synthetic upstream. Full test command/output and commit are reviewable.

**Rollback:** revert only this milestone commit. Keep staging empty and old runtime unchanged. Re-run only offline focused checks after revert if requested.

**Stop conditions:** any fixture needs real credentials/prompts; extension hook cannot enforce invariants; unexplained dispatch amplification; synthetic run reaches external network; no rollback from a config/schema migration; or any provider rejection/uncertain outcome. Stop for parent review.

## Milestone 6 — First isolated platform slice (future authorization required)

This milestone is deliberately not executable from the current authorization. It requires a reviewed source pin, T3 contract, staging proposal, synthetic acceptance plan, and a separate explicit parent authorization. The future artifacts should include a versioned staging deployment packet, sanitized effective config, native dashboard workflow evidence, hub integration fixture results, restart/redeploy persistence and rollback evidence. No production promotion is included. Any later production promotion requires its own approval after a concrete packet exists.

**Stop conditions:** any production credential/data, provider inference/quota call, OAuth lifecycle action, account/IP change, timer, public admin exposure, native API incompatibility, unbounded retry/fallback, or uncertainty about credential ownership. Do not proceed to OpenCode adapter work or resolve the existing 429 as part of this slice.
