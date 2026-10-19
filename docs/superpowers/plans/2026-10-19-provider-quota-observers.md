# Provider Quota Observers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish trustworthy Codex and Mistral quota reporting without inference probes, credential disclosure, or new runtime dependencies.

**Architecture:** Keep provider observations separate from gateway token accounting. Codex reads usage through authenticated loopback CLIProxyAPI management; Mistral optionally reads the fixed unofficial console endpoint with explicitly supplied session credentials. A memory-only, single-flight cache serves both the dashboard and scheduled refresh; observations do not alter routing policy.

**Tech Stack:** Existing Node.js ESM, node:http/node:https, node:test, YAML configuration, current HTML dashboard.

**Spec:** `docs/design/quota-observation.md`, plus the agreed contract below. Existing cost/compaction work remains governed by `docs/design/cost-and-compaction-architecture.md` and `docs/superpowers/plans/2026-10-18-cost-compaction.md`.

## Agreed contract and scope

- Use the Mistral internal endpoint directly; CodexBar is a reference, not a dependency.
- Optional explicit credentials from a private file; no browser extraction or cookies pasted into chat.
- Mistral target: `https://console.mistral.ai/api-ui/trpc/billing.vibeUsage`, GET with `batch=1` and `input={"0":{"json":null,"meta":{"values":["undefined"],"v":1}}}`.
- Send only `csrftoken` and `ory_session_*` cookies, plus `X-CSRFToken`; parse `.[0].result.data.json.usage_percentage` and `reset_at`.
- Label the result **Unofficial Vibe subscription quota**. It is not generic API monthly consumption or Enterprise billing spend.
- Codex uses the existing fixed `wham/usage` request through management, preserving per-account windows and resets.
- Retain Enterprise Admin API support and ordinary Mistral rate-limit observations as separate signals.
- Keep gateway-observed tokens/cache counters explicitly gateway-only.

## Global Constraints

- CLIProxyAPI remains pinned to 7.3.20. Preserve Responses compaction, session affinity and signed Anthropic compaction handling.
- Management stays loopback-only, remote management false, control panel disabled, with a separate private key.
- Never expose a generic management proxy, browser-session import, auth-file download, token refresh implementation, or reset-credit action.
- Never log raw cookies, OAuth identifiers, management keys, request headers or upstream bodies.
- All new observations and caches are bounded and memory-only; do not put session credentials in the usage store or routing YAML.
- No inference, live-account access, deployment, restart, push or commit is authorized by this draft. Real credential installation and any live validation require a separate checkpoint.
- Existing class/role routing remains opt-in; no percentage-based automatic routing or cache-cold inference is added.
- Previously authorized inference budget remains 1–2% total and 0.1–0.2% per stage; this plan spends none. Rounded subscription percentages are not a precise token/cost denominator.

## Current implementation baseline

Implemented and landed as `e703c36` ("observe Codex and Mistral quota without inference probes") and deployed to production: Codex management config/key wiring, fixed per-account quota calls, numeric window filtering, Mistral timestamped response-header capture, usage/cache counters and synthetic tests. Validation is 156/156 with lint clean.

Remaining: independent read-only review of the security boundaries, and live-account validation (a separate checkpoint that needs a real credential installed). The observer modules are implemented and deployed; treat live behavior as unverified until reviewed.

## Review Focus

1. Malformed/expired session files must produce sanitized unavailable results and never echo secrets (Task 1).
2. Redirects or configurable origins must never receive Mistral cookies or management authority (Tasks 1–2).
3. Concurrent dashboard and timer refreshes must not multiply calls or display old data as fresh (Task 3).
4. Partial credential pools, truncation, missing windows and reset rollover must not produce false pooled availability (Tasks 2–3).
5. Routed/streaming traffic and deceptive provider strings must not misattribute usage or inject dashboard HTML (Tasks 4–5).

## File structure and interfaces

- Create `mistral-subscription-quota.mjs`: private-file validation, fixed request and strict parser.
- Create `quota-cache.mjs`: bounded, memory-only single-flight refresh coordinator.
- Modify `quota.mjs`: provider-specific signal composition and Codex hardening; preserve existing callers.
- Modify `tgw-proxy.mjs`: shared coordinator, private config propagation, consistent inference observations.
- Modify `entrypoint.sh`, `route-config.mjs`, `compile-config.mjs`: management authority and private generated-config handling.
- Modify `request-executor.mjs` only if routed responses currently bypass observation; reuse existing callbacks/codecs instead of duplicating stream parsers.
- Modify `dashboard.html`, `Dockerfile`, `.gitignore`, documentation and focused tests as assigned below.

Shared signal shape: `{id, label, source, status, observedAt, resetAt, percentUsed, remaining, unit, windows, accounts, note}`. `source` is `provider-api`, `unofficial-console`, `response-header` or `gateway-observed`; `status` is `fresh`, `stale`, `unavailable` or `unconfigured`. Missing metrics are null, never zero by default. Provider cards retain their existing outer shape; add `detail.quota_signals` rather than replacing observed usage/billing details.

### Task 1: Optional Mistral subscription observer

**Files:** Create `mistral-subscription-quota.mjs`, `test/mistral-subscription-quota.test.mjs`; modify `quota.mjs`, `tgw-proxy.mjs`, `Dockerfile`, `.gitignore`.

**Interfaces:** `readMistralSession(file) -> {csrfToken, sessionCookies}`; `parseMistralVibeUsage(body, observedAt) -> Signal`; `probeMistralSubscription({file, transport, now}) -> Promise<Signal>`. The transport is injectable for tests, but production origin/path are constants, never supplied by callers.

- [ ] Write failing tests asserting `42.5` consumption gives `percentUsed:42.5`, valid reset ISO text is normalized, and no token/string identifier appears in output. Reject missing/null/string/negative/>100/nonfinite percentages, empty arrays, tRPC errors, oversized JSON and invalid reset dates (retain valid usage with null reset).
- [ ] Test credential contract: `MISTRAL_SESSION_FILE` points to a JSON file `{csrfToken:string, sessionCookies:{ory_session_<suffix>:string}}`; require a regular non-symlink file owned by the process UID, no group/world permission bits and maximum 16 KiB. Validate cookie names and reject empty values, CR/LF, control characters, commas and semicolons. No arbitrary header map or other cookie names is allowed.
- [ ] Run the new tests and record the expected RED failures before implementation.
- [ ] Implement with built-in HTTP modules, fixed HTTPS hostname/path/query, no redirects, 4-second absolute timeout, 64 KiB body cap and sanitized error categories. Do not include cookie values or response bodies in exceptions. Missing file configuration is unconfigured, not an outage.
- [ ] Test 401/403 as credential-expired/unavailable, redirects as refused, timeout/HTML/malformed JSON as unavailable, and fixed cookie/header construction using fake transport only.
- [ ] Wire `MISTRAL_SESSION_FILE` into the probe context. Do not require a standard inference API key to show subscription quota. Keep Admin API results and rate-limit headers independent if one probe fails.
- [ ] Add the module to the image and secret-file ignore guidance. Run focused tests to GREEN, then review the scoped diff. Do not install a real credential.

### Task 2: Harden existing Codex management wiring

**Files:** Modify `quota.mjs`, `route-config.mjs`, `entrypoint.sh`, `compile-config.mjs`, `test/codex-quota.test.mjs`, `test/route-config.test.mjs`.

**Interfaces:** Preserve `probeCodexOauth(provider, context) -> Promise<ProviderQuota>`; expose sanitized per-account windows through `detail.quota_signals`. Use ephemeral ordinal account labels, not emails or auth indices.

- [ ] Add failing tests for literal-loopback URL validation, credentials in URL, IPv6, malformed auth listing, disabled/non-Codex entries, upstream non-200, absent/invalid windows, multiple accounts and partial failures. Assert no credential material appears in output or logs, and no arbitrary upstream URL/method can enter the request.
- [ ] Test key separation and private configuration: no public inference/admin key reuse, listener remains private, generated config mode 0600 even when overwriting an existing permissive file, and secret never enters public config responses.
- [ ] Run tests to RED; implement corrections without changing the pinned version. Keep absent custom management config fail-closed. Generated key must remain process-local and independent of inference credentials; document external loopback instances requiring a separately matched key.
- [ ] Bound each refresh to 32 active accounts, concurrency 4 and an absolute 15-second overall deadline. Abort outstanding requests at deadline. Explicitly report truncation, total/discovered counts and per-account failures. Do not average window percentages or use an observed reset as a reset-credit action.
- [ ] Verify exact account metadata/header handling against pinned upstream source with fixtures. Discard account IDs after constructing the fixed request; never download OAuth files.
- [ ] Run focused tests to GREEN and inspect the scoped diff for changes to inference/compaction routes (none expected).

### Task 3: Shared refresh cache and freshness semantics

**Files:** Create `quota-cache.mjs`, `test/quota-cache.test.mjs`; modify `tgw-proxy.mjs`, `quota.mjs`, `Dockerfile`.

**Interfaces:** `createQuotaCache({now, ttlMs:300000, staleMs:900000})` returns `get(providerId, loader) -> Promise<ProviderQuota>` and `invalidate(providerId)`. Only configured provider IDs can allocate entries. Both `/admin/quota` and the routing quota refresh consume this instance.

- [ ] Add failing fake-clock tests: simultaneous requests share one call; fresh hits make none; refresh occurs at five minutes; errors cannot hot-loop; previous successful samples retain their original timestamp and become stale; samples older than fifteen minutes lose usable metrics.
- [ ] Add tests that a known reset crossing immediately invalidates that window's usable percentage; it does not synthesize zero consumption. Invalid resets do not invent a lifetime. No expired/stale metric becomes a routing permission.
- [ ] Implement single-flight caching with a five-minute failed-attempt backoff. 401/403 invalidates current Mistral metrics immediately, without stale fallback. Re-read the private credential file on the next allowed refresh so rotation works without restart; do not store its contents in cache entries.
- [ ] Verify observations survive no process restart: cache starts empty; no new disk state is written. Add module to image and run tests to GREEN.

### Task 4: Observation attribution across inference paths

**Files:** Modify `tgw-proxy.mjs`, `request-executor.mjs` only as needed, `test/proxy-integration.test.mjs`, `test/request-executor.test.mjs`, `test/usage-observer.test.mjs`.

**Interfaces:** Reuse `recordObservedUsage(provider, model, data)` and add a single header-observation callback `(provider, model, headers, observedAt) -> void` for routed and passthrough responses.

- [ ] Add failing synthetic upstream tests for Mistral direct and profile-routed responses, streaming and JSON, plus Codex Responses usage. Assert each usage event is counted once under the actual selected provider; Mistral never increments OpenCode totals.
- [ ] Assert header observation accepts only a bounded `X-RateLimit-Remaining` value and records provider/model/time. Do not interpret the undocumented header value format as monthly quota or compute a percentage from it.
- [ ] Implement the minimal callback wiring; avoid new body buffering, duplicate SSE parsers or changing inference payloads merely to obtain usage. Missing streaming usage is unknown, not a fabricated count.
- [ ] Test absent headers, failed upstream calls, fallback to another provider and cancelled streams. Run focused tests to GREEN and retain all compaction/session-affinity regressions.

### Task 5: Clear authenticated dashboard reporting

**Files:** Modify `dashboard.html`, `test/dashboard.test.mjs`, `test/dashboard-integration.test.mjs`.

**Interfaces:** `quotaCard(q)` consumes `detail.quota_signals` and existing `detail.observed_usage`; no credentials or session-setup actions are exposed by HTTP.

- [ ] Add failing assertions for separate subscription percentage, per-account Codex windows, Admin billing spend, response-header remaining and gateway-only counters. Include fresh/stale/unconfigured/unavailable labels and observed/reset timestamps.
- [ ] Render Mistral copy exactly as **Unofficial Vibe subscription quota**; never imply it describes all Mistral API allowance. Codex displays each account/window, not a combined progress bar. Show partial/truncated pool warnings.
- [ ] Test hostile labels/notes and HTML strings are escaped, absent metrics display an em dash rather than zero, and stale metrics cannot display a fresh/healthy badge. Preserve admin authentication and Cloudflare Access tests.
- [ ] Implement compact native-to-existing-dashboard sections using current escaping helpers. Run focused tests to GREEN; no live browser/session inspection is needed.

### Task 6: Documentation, verification, review and handoff

**Files:** Modify `docs/design/quota-observation.md`, `docs/design/cost-and-compaction-architecture.md`, this plan and relevant README configuration instructions.

- [ ] Correct the earlier research statement: the Mistral internal URL/auth/schema are now source-verified through CodexBar, but not live-account verified. Cite its exact source revision at implementation time; document that it can change without notice.
- [ ] Document private file JSON, ownership/mode, read-only secret mount, rotation/expiry, disabling by removing configuration, key separation, cache intervals and freshness rules. Use placeholders only, never real values. Explain API/Vibe subscription/billing/rate limits are distinct.
- [ ] Preserve the existing cost/compaction plan's evidence gates: class routing stays disabled, unsupported betas stay disabled, CLIProxyAPI stays pinned, and cache-retention inference probes remain separate. The quota observer does not establish cache warmth or measured savings.
- [ ] Use repository verification wrappers if available. If absent, explicitly resolve the inherited wrapper-only policy before executing fallback commands; do not quietly claim compliance. Required checks to wrap are focused node:test suites, full `npm test`, `npm run lint`, `sh -n entrypoint.sh`, link/consistency review and `git diff --check`.
- [ ] Create the required review artifact and obtain read-only independent review of touched code/security boundaries before calling implementation complete. If review tooling is unavailable, report that gate as pending rather than silently skipping it.
- [ ] Record actual results and remaining gaps. Do not stage unrelated existing changes or create commits without a separate instruction. No deploy/restart/push.

## Acceptance and activation checkpoint

Implementation is ready for activation review only when fixture tests prove strict credentials/egress, bounded calls/cache, correct units/freshness, protected dashboard and unchanged compaction behavior, with independent review resolved.

Activation is a separate user decision: install credentials through a local private secret mechanism, authorize deployment/restart, then optionally perform one read-only quota refresh per configured provider. Never copy browser cookies automatically. No inference requests belong to activation validation, and no live result should be claimed before it occurs.

## Self-review

- Scope covers both agreed quota observers and preserves earlier compaction work rather than reimplementing it.
- Five review-focus conditions each have explicit owning tests.
- New timing, file-schema and concurrency constants are proposed implementation defaults, not previously user-specified facts.
- No additional service, package, browser-cookie importer, routing feature or deployment is introduced.
- Execution remains inline as previously agreed, after review/approval of this draft.
