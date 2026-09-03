# Tokligence Gateway Architecture Audit Report

**Codebase:** `/home/hermes/workspace/projects/tokligence-gateway-cline-oauth/`
**Date:** 2026-09-03
**Files analyzed:** routing-planner.mjs, request-executor.mjs, provider-adapters.mjs, route-config.mjs, smart-router.mjs, quota-tracker.mjs, routing-profiles.mjs, tgw-proxy.mjs, gateway.routes.yaml, model-catalog.mjs, protocol-codecs.mjs, quota.mjs, preferences.mjs, usage-observer.mjs, cline-oauth.mjs, compile-config.mjs, gateway-config.mjs, and 18 test files.

---

## Executive Summary

The Tokligence Gateway is an OpenAI/Anthropic-compatible proxy that routes requests across 12 configured providers with varying cost models (free, subscription, PAYG). The codebase has **two completely parallel routing systems** — one active, one dead. The active system uses YAML-based profiles with a deterministic fallback chain. The dead system (`smart-router.mjs` + `routing-profiles.mjs` + `quota-tracker.mjs`) was an ambitious quota-aware routing layer that was never wired into the request pipeline. Several quality issues exist: hardcoded provider IDs in usage tracking, unused capability detection, and stub functions with TODOs.

**Tests:** 79 tests, all passing.

---

## 1. Two Parallel Routing Systems

### Active System: `gateway.routes.yaml` + `routing-planner.mjs` + `request-executor.mjs`

This is the system **actually used for every request**. The flow is:

1. `tgw-proxy.mjs` loads `gateway.routes.yaml` at startup via `loadRoutingConfig()` from `route-config.mjs`
2. For each incoming request, `handleProfileRequest()` in `tgw-proxy.mjs` (line 454) is called
3. It calls `profileByModel()` to check if the requested model name matches a profile ID (e.g., `agent-default`, `agentic-worker`)
4. If a profile matches, `buildRoutePlan()` in `routing-planner.mjs` constructs an ordered candidate list from the profile's `candidates` array
5. `executeRoutePlan()` in `request-executor.mjs` iterates candidates, attempting each in order with circuit-breaker cooldowns
6. If no profile matches, the request falls through to `tgw-proxy.mjs`'s legacy per-provider routing (hardcoded if/else chains for OpenRouter, Mistral, OpenCode, Modal, MiniMax, etc.)

The active system provides:
- **Deterministic candidate ordering** (profile candidates are tried in YAML order)
- **Circuit breaker** (`circuitOpen()` checks a cooldown map keyed by `provider:model:protocol`)
- **Protocol filtering** (candidates are skipped if their provider doesn't support the requested protocol)
- **Max attempts limiting** (`max_attempts` from profile config)

### Dead System: `routing-profiles.mjs` (ROUTING_PROFILES) + `smart-router.mjs` + `quota-tracker.mjs`

**`smart-router.mjs` is entirely dead code.** It is:
- **Never imported by `tgw-proxy.mjs`** (the main entry point)
- **Never imported by `routing-planner.mjs`** (the active routing planner)
- **Never imported by `request-executor.mjs`** (the active executor)
- Only imported by `test/smart-router.test.mjs`

`routing-profiles.mjs` defines a completely separate set of profiles (`primary`, `auxiliary.compression`, `auxiliary.web_extraction`, `auxiliary.vision`, `cron`, `fallback`) with hardcoded provider+model lists that **diverge from the YAML config**. These profiles reference models like `glm-5.3-flash` (cline-oauth), `nemotron-3-ultra-550b-a55b` (nvidia), `laguna-xs-2.1` (nous) — some of which don't match the models actually configured in `gateway.routes.yaml`.

`quota-tracker.mjs` provides dynamic quota fetching for 4 providers (mistral, codex, copilot, supergrok) with 5-minute caching. It's imported only by `smart-router.mjs` and `test/smart-router.test.mjs`. The quota fetching functions use hardcoded API endpoints, some of which are speculative (e.g., `https://api.github.com/user/copilot_usage` and `https://api.x.ai/v1/usage` — these endpoints may not actually exist or return the expected shape).

### Verdict

| Aspect | Active System (YAML) | Dead System (smart-router) |
|--------|---------------------|---------------------------|
| Used in request pipeline | ✅ Yes | ❌ No |
| Profile source | `gateway.routes.yaml` | `routing-profiles.mjs` hardcoded |
| Routing strategy | Ordered fallback chain | Score-based (quota + cost + class) |
| Quota awareness | ❌ No (circuit breaker only) | Designed for yes, but never wired |
| Capability matching | ❌ No | Designed for yes, but stubbed |
| Tests | ✅ Integration + unit tests | ✅ Unit tests only (self-referential) |

**Recommendation:** Remove `smart-router.mjs`, `routing-profiles.mjs`, and `quota-tracker.mjs` entirely, OR integrate their quota-awareness into the active routing pipeline. Keeping dead code that references different model lists than the YAML config is a maintenance hazard.

---

## 2. Model Discovery (`discover_models: true`)

### How it works

The `discover_models: true` flag in `gateway.routes.yaml` is **metadata only** — it appears in the public routing config (`publicRoutingConfig()` in `route-config.mjs` line 303) but is **never checked by the discovery logic itself**.

Actual model discovery happens in `tgw-proxy.mjs`'s `refreshModelRegistry()` function (line 291), which is called on every `/v1/models` request. The function:

1. Calls `seedConfiguredModels()` — seeds the registry with models from `gateway.routes.yaml`
2. Then makes live HTTP calls to provider endpoints, **gated by API key availability, not by `discover_models` flag**:
   - **OpenCode** (if `OPENCODE_KEY` exists): calls `/zen/go/v1/models` and `/zen/v1/models`
   - **OpenRouter** (if `OPENROUTER_KEY` exists): calls `/api/v1/models`
   - **Mistral** (if `MISTRAL_KEY` exists): calls `/v1/models`
   - **Cline OAuth** (if `CLINE_OAUTH` adapter exists): calls `discoverFreeModels()`
   - **Tokligence backend** (always): calls `/v1/models` on the gateway

### Where discovered models are stored

Discovered models are stored in an in-memory `MODEL_REGISTRY` Map (not persisted to disk). They are tagged with `discovered: true` and `discoveredBy: <provider>`.

### Are they added to routing candidates?

**No.** Discovered models are only listed in the `/v1/models` endpoint response. They are **not** automatically added to any routing profile's candidate list. Routing profiles are static, defined in `gateway.routes.yaml`, and only include explicitly configured provider+model pairs.

However, discovered models **can be used** via direct model requests — if a client requests `cline/z-ai/glm-5.3-flash` (a discovered Cline model), the routing system will:
1. Check if `cline/z-ai/glm-5.3-flash` matches a profile ID → no
2. Call `matchConfiguredProvider()` → matches `cline/` prefix → routes to cline-oauth provider
3. `buildRoutePlan()` handles this as a non-profile route, creating a single-candidate plan

### Catalog filtering

The `model-catalog.mjs` module filters which discovered models are exposed:
- **OpenRouter**: `zero_price_only: true` — only free (pricing=0) models or `paid_allowlist` entries are registered
- **OpenCode Zen**: `id_suffixes: ["-free"]` — only models ending in `-free` are registered
- **Cline OAuth**: the adapter's `discoverFreeModels()` method only returns the `free` array from the API response, ignoring `recommended`, `clinePass`, and `clineCloud` arrays

### Stale model pruning

`pruneStaleDiscovered()` removes discovered models that no longer appear in a provider's endpoint response. Explicitly configured models (from YAML) are preserved as a stable fallback — except for Cline OAuth, where all models (including config-seeded) are pruned to match the live endpoint.

---

## 3. Quota Integration

### `quota-tracker.mjs` — NOT integrated

`quota-tracker.mjs` exports `getProviderQuota()` and `calculateDynamicCost()`. These are:
- Imported only by `smart-router.mjs` (dead code)
- Imported only by `test/smart-router.test.mjs`
- **Never called by `routing-planner.mjs`**, `request-executor.mjs`, or `tgw-proxy.mjs`

The routing planner (`routing-planner.mjs`) does **not** check quota before selecting candidates. It only checks:
1. Provider enabled (API key present)
2. Protocol supported
3. Circuit breaker (cooldown from previous failures)

### `quota.mjs` — Dashboard only, separate from routing

There is a **second, independent quota system** in `quota.mjs` that IS used — but only for the dashboard's `/admin/quota` endpoint. It provides real quota probes for:
- OpenRouter (`/api/v1/key` endpoint)
- Mistral (Admin API `/usage` + `/spend-limit`)
- MiniMax (`/v1/token_plan/remains`)
- Cline OAuth (account balance via adapter)
- OpenCode, Modal (reported as unavailable/no source)

This quota data is displayed in the dashboard but **never feeds back into routing decisions**. The routing system has no awareness of remaining quota — it only reacts to failures via the circuit breaker.

### `usage-observer.mjs` — Observational, not routing

The usage observer tracks actual token usage from responses (input/output tokens, cost, errors) and persists to `/data/tgw-observed-usage.json`. This data feeds into the dashboard's quota view as `observed_usage` but, again, **does not influence routing**.

---

## 4. Capability Matching

### Current state: No real capability-based routing

The active routing system has **no capability-based filtering**. Here's what exists but is unused:

1. **`protocol-codecs.mjs`** exports `inspectRequestFeatures()` which detects: streaming, tools, parallel_tools, structured_output, reasoning, vision (via regex on message content). This IS called by `routing-planner.mjs` (line 23, 30) and stored in the plan's `required` field.

2. **However, `required` is never used for filtering.** In `buildRoutePlan()`, candidates are filtered only by:
   - Provider enabled
   - Protocol support
   - Circuit breaker status
   
   The `required` features object is attached to the plan but never consulted when building the candidate list.

3. **`protocol-codecs.mjs`** also exports `supportsFeatures()` which compares required features against provider capabilities. This function is **never imported or called by any other file**.

4. **`gateway.routes.yaml`** has `metadata.capabilities` on each provider (e.g., `["coding", "reasoning", "tool_calling"]`, `["text", "vision", "tool_calling"]`). This metadata is **never used for routing** — it's purely informational, surfaced in the public routing config.

5. **`routing-profiles.mjs`** (dead code) has `capabilities` arrays on profiles and a `modelSupportsCapabilities()` function — but this is a stub that always returns `true` (line 127: `return true;`).

### What this means in practice

- A request requiring vision will be routed to a provider that doesn't support vision (e.g., nvidia, which has `capabilities: ["coding", "reasoning", "tool_calling"]` — no vision)
- A request with tools will be routed to a provider that doesn't support tool calling
- The only protection is the circuit breaker — if a provider returns an error, the next candidate is tried

### Alias-based "capability" routing

The alias system provides a crude capability routing mechanism:
- `profile-vision` alias → routes to `pixtral-large-latest` (Mistral)
- `profile-xhigh` → `gpt-5.6-sol` (Codex)
- `profile-low` → `ministral-8b-latest` (Mistral)

But this requires the client to explicitly request a capability keyword (e.g., "vision", "coding") as the model name. There's no automatic capability detection from the request body.

---

## 5. Missing Providers

### Currently configured providers (12)

| Provider | Adapter | Cost Class | Key Models |
|----------|---------|------------|------------|
| tokligence (MiniMax) | tokligence | subscription | minimax-m2.1/2.5/2.7 |
| codex-oauth (OpenAI GPT) | oauth-proxy | subscription | gpt-5.6-luna/terra/sol |
| copilot-auto (GitHub) | copilot-sdk | subscription | copilot-auto |
| cline-oauth | cline-oauth | free | discovered (GLM, DeepSeek, etc.) |
| mistral | middleware | subscription | 8 models incl. pixtral |
| google-ai-studio | middleware | subscription | gemini-3.1-pro, gemini-3-flash |
| nvidia | middleware | free | nemotron-3-ultra/super, glm-5.2 |
| nous | middleware | free | laguna-xs/s, step-3.7-flash |
| openrouter | middleware | payg | deepseek-v4-flash/pro + free catalog |
| modal | middleware | payg | glm-5, glm-5.1 |
| opencode-go | middleware | free | deepseek-v4-flash-free |
| opencode-zen | middleware | free | discovered (kimi, etc.) |

### Missing providers with free tiers or subscriptions

| Provider | Free Tier? | API | Notes |
|----------|-----------|-----|-------|
| **Groq** | ✅ Free | OpenAI-compatible | Ultra-fast inference (Llama, Mixtral). Has `/v1/models` endpoint. Significant free tier. |
| **Cerebras** | ✅ Free | OpenAI-compatible | Fastest inference. Free tier with Llama models. |
| **Together AI** | ✅ Free credits | OpenAI-compatible | $5 free credits. Wide model catalog. |
| **Fireworks** | ✅ Free tier | OpenAI-compatible | Fast inference, free tier available. |
| **DeepInfra** | ✅ Free credits | OpenAI-compatible | $5 free credits, cheap PAYG. |
| **Replicate** | ❌ PAYG only | Custom API | Predictions API, not OpenAI-compatible. |
| **HuggingFace Inference API** | ✅ Free | Custom/OpenAI | Serverless inference, free tier for small models. |
| **Cloudflare Workers AI** | ✅ Free | REST/OpenAI | Free tier (10k Neurons/day). Could use existing Cloudflare infra. |
| **AWS Bedrock** | ❌ PAYG | AWS SDK | Not OpenAI-compatible natively, requires AWS auth. |
| **Azure AI** | ❌ PAYG | OpenAI-compatible | Azure OpenAI Service, requires Azure subscription. |
| **Cohere** | ✅ Trial | Custom API | Command R/R+, trial keys available. |
| **AI21** | ✅ Free | OpenAI-compatible | Jamba models, free tier. |
| **Perplexity** | ❌ PAYG | OpenAI-compatible | Sonar models, PAYG only. |
| **Galaxy.ai** | ❓ Unknown | Unknown | Unclear API availability. |
| **Z.ai API** | ✅ Free | OpenAI-compatible | GLM models directly from Zhipu AI. |
| **Kimi API (Moonshot)** | ✅ Free | OpenAI-compatible | kimi-k2.6, free tier available. Currently only accessed via OpenCode/Cline. |
| **Qwen API (Alibaba)** | ✅ Free | OpenAI-compatible | Qwen3 models, free tier via DashScope. Currently only via OpenRouter. |
| **DeepSeek API** | ✅ Free | OpenAI-compatible | DeepSeek V4, free tier. Currently only via OpenRouter/OpenCode/Cline. |

### High-value additions recommended

1. **Groq** — Free, OpenAI-compatible, ultra-fast. Trivial to add as a `middleware` adapter.
2. **Cerebras** — Free, OpenAI-compatible, fastest inference. Trivial to add.
3. **Z.ai API** — Free, direct GLM access without intermediaries. Reduces dependency on Cline/OpenCode for GLM models.
4. **DeepSeek API** — Free direct access. Currently routed through 3 intermediaries (Cline, OpenCode, OpenRouter).
5. **Kimi API (Moonshot)** — Free direct access. Currently only through OpenCode/Cline.
6. **Cloudflare Workers AI** — Free, leverages existing Cloudflare infrastructure.

---

## 6. Code Quality Issues

### Bugs

#### BUG-1: Hardcoded `"opencode-go"` provider in `pipeAndRecordUsage()` calls
**File:** `tgw-proxy.mjs`, lines 1529, 1558, 1579, 1600, 1925, 1958, 1978
**Severity:** Medium — incorrect usage statistics

Every `pipeAndRecordUsage()` call passes `"opencode-go"` as the provider, regardless of which provider actually served the request. This means:
- OpenRouter requests are recorded as `opencode-go` usage
- Mistral requests are recorded as `opencode-go` usage
- MiniMax/Tokligence requests are recorded as `opencode-go` usage
- Even the generic fallback (line 1978) records as `opencode-go`

The `OBSERVED_USAGE` store aggregates by provider, so all proxy-piped usage is misattributed. The dashboard's per-provider usage view is incorrect for all providers except those served via `callModal()`, `callOpenCodeGoOpenAI()`, `callOpenRouterOpenAI()` (non-streaming), `callMistralOpenAI()` (non-streaming), and `callOpenCodeMessages()` — these correctly use `recordModelObservedUsage()` which resolves the provider from the model name.

#### BUG-2: `routing-profiles.mjs` references models not in `gateway.routes.yaml`
**File:** `routing-profiles.mjs`
**Severity:** Low (dead code, but misleading)

The dead routing profiles reference models like:
- `cline-oauth: ["glm-5.3-flash"]` — not in YAML (cline-oauth has `models: []`, relies on discovery)
- `nvidia: ["nemotron-3-ultra-550b-a55b"]` — YAML has `nvidia/nemotron-3-ultra-550b-a55b` (with prefix)
- `opencode-zen: ["deepseek-v4-flash-free", "kimi-k2.6-free"]` — YAML has `models: []` for opencode-zen
- `nous: ["laguna-xs-2.1"]` — YAML has `nousresearch/laguna-xs-2.1` (with prefix)

If someone accidentally wires `smart-router.mjs` into the request pipeline, it would route to non-existent model IDs.

#### BUG-3: `quota-tracker.mjs` fetches from speculative API endpoints
**File:** `quota-tracker.mjs`
**Severity:** Low (dead code)

- `fetchCopilotQuota()` calls `https://api.github.com/user/copilot_usage` — this endpoint does not exist in the GitHub REST API. The Copilot usage API is at `/orgs/{org}/copilot/usage` (enterprise only).
- `fetchSuperGrokQuota()` calls `https://api.x.ai/v1/usage` — xAI does not publish a usage API endpoint.
- `fetchCodexQuota()` calls `https://api.openai.com/v1/usage` — OpenAI's usage API is at `/v1/usage?date=...` with a different response shape. The function's own TODO acknowledges this: `"TODO: Hier könnte man die Credits aus der Subscription abfragen"`.

These would all fail silently (returning `{ remaining: 1.0 }` fallback) if the code were ever activated.

### Stubs and TODOs

#### TODO-1: `smart-router.mjs:113` — Model availability check stub
```javascript
async function findAvailableModel(provider, modelRequest) {
  // TODO: Hier könnte man die Modellverfügbarkeit prüfen
  // Für jetzt: Nimm das erste Modell des Providers oder das angefragte Modell
  if (provider.models.includes(modelRequest)) {
    return modelRequest;
  }
  return provider.models[0];
}
```

#### TODO-2: `smart-router.mjs:125` — Capability matching stub
```javascript
function modelSupportsCapabilities(modelId, requiredCapabilities) {
  // TODO: Hier könnte man eine Fähigkeiten-Datenbank abfragen
  // Für jetzt: Annahme, dass alle Modelle alle Fähigkeiten unterstützen
  return true;
}
```

#### TODO-3: `quota-tracker.mjs:147` — Codex/OpenAI quota estimation stub
```javascript
// TODO: Hier könnte man die Credits aus der Subscription abfragen
// Für jetzt: Annahme 100% Quota
return {
  remaining: 1.0,
  total: Infinity,
  used: totalUsage,
  reset_at: null,
};
```

### Dead Code

| File | Status | Notes |
|------|--------|-------|
| `smart-router.mjs` | **Fully dead** | Never imported by any non-test file except its own dependencies |
| `routing-profiles.mjs` | **Fully dead** | Only imported by `smart-router.mjs` and tests |
| `quota-tracker.mjs` | **Fully dead** | Only imported by `smart-router.mjs` and tests |
| `protocol-codecs.mjs:supportsFeatures()` | **Dead export** | Exported but never imported by any file |
| `routing-planner.mjs:required` field | **Unused** | `inspectRequestFeatures()` result is computed and stored in the plan but never used for candidate filtering |

### Other Quality Issues

#### ISSUE-1: Massive `tgw-proxy.mjs` (2035 lines)
The main proxy file is a monolith containing:
- Model registry management
- Model discovery / refresh
- Auth/validation
- Protocol translation (Anthropic ↔ OpenAI ↔ Responses)
- Per-provider hardcoded routing (6+ if/else chains)
- Dashboard backend
- Admin endpoints
- Usage tracking
- Quota context

The per-provider routing in `tgw-proxy.mjs` (lines 1490-1980) duplicates the functionality that `provider-adapters.mjs` and `request-executor.mjs` were designed to provide. Two code paths exist for the same purpose: the profile-based path (via `handleProfileRequest`) and the legacy hardcoded path (the long if/else chains). This means any new provider must be added in two places.

#### ISSUE-2: Non-streaming for Responses API and some Anthropic paths
Several code paths force `stream: false` upstream and then synthesize streaming responses client-side:
- `callOpenRouterOpenAI()` — always `stream: false`
- `callMistralOpenAI()` — always `stream: false`
- `callOpenCodeGoOpenAI()` — always `stream: false`
- `callOpenCodeMessages()` — always `stream: false`
- `callModal()` — always `stream: false`

The Responses API path always buffers the full response and then emits a synthetic SSE stream. This adds latency and breaks true streaming for these providers.

#### ISSUE-3: `package.json` lint script doesn't cover all files
The `lint` script checks 12 source files + 10 test files, but misses:
- `smart-router.mjs`, `quota-tracker.mjs`, `routing-profiles.mjs` (dead code, but still shipped in Docker image)
- `cline-oauth.mjs`, `model-catalog.mjs`, `usage-observer.mjs`, `protocol-codecs.mjs`, `sanitize-headers.mjs`, `openai-stream.mjs`, `cloudflare-access.mjs`
- Several test files (`cline-oauth.test.mjs`, `cline-oauth-integration.test.mjs`, `smart-router.test.mjs`, `model-catalog.test.mjs`, `usage-observer.test.mjs`, `quota-sources.test.mjs`, `dockerfile.test.mjs`)

#### ISSUE-4: Docker image ships dead code
The Dockerfile `COPY` command includes `smart-router.mjs`, `quota-tracker.mjs`, and `routing-profiles.mjs` in the production image despite them being unused.

---

## Test Coverage Analysis

### Well-tested areas
- **`route-config.mjs`**: Config parsing, validation, alias resolution, provider matching — comprehensive
- **`cline-oauth.mjs`**: OAuth flow, token refresh, model discovery, error classification — excellent
- **`copilot-auto.mjs`**: Tool mapping, vision rejection, structured output — good
- **`cloudflare-access.mjs`**: JWT validation, RS256/ES256 — thorough
- **`models-endpoint.test.mjs`**: Live model discovery with mocked providers — good integration test
- **`agent-profile.test.mjs`**: Profile candidate ordering, circuit breaker — good
- **`proxy-integration.test.mjs`**: Auth, Codex routing, health checks — good

### Poorly tested areas
- **`routing-planner.mjs`**: Only 3 tests (candidate order, fallback chain, circuit breaker). No tests for: protocol mismatch handling, error responses, cline-oauth non-profile path, max_attempts limiting.
- **`request-executor.mjs`**: **Zero direct tests**. Only exercised indirectly through `agent-profile-integration.test.mjs` which tests 2 scenarios.
- **`provider-adapters.mjs`**: **Zero direct tests**. The adapter logic for `oauth-proxy`, `tokligence`, `middleware` adapters is untested in isolation.
- **`smart-router.mjs` / `quota-tracker.mjs`**: Tests exist but only verify the dead code's internal consistency, not integration.
- **`tgw-proxy.mjs` legacy routing**: The massive if/else chains (lines 1490-1980) are only partially tested. Mistral, OpenCode, OpenRouter, and Modal direct routing paths lack dedicated tests.
- **Usage tracking attribution**: No test verifies that `pipeAndRecordUsage` records the correct provider (BUG-1 is untested).

---

## Recommendations

### Immediate (P0)

1. **Fix BUG-1**: Replace hardcoded `"opencode-go"` in all `pipeAndRecordUsage()` calls with the actual provider ID. Use `matchConfiguredProvider(ROUTING, model) || modelProvider(model)` like `recordModelObservedUsage()` does.

2. **Remove dead code**: Delete `smart-router.mjs`, `routing-profiles.mjs`, `quota-tracker.mjs`, and `test/smart-router.test.mjs`. Remove them from the Dockerfile `COPY` command. If quota-aware routing is desired, build it into the active `routing-planner.mjs` instead.

3. **Remove `supportsFeatures()` from `protocol-codecs.mjs`** or implement capability-based candidate filtering in `routing-planner.mjs` using it.

### Short-term (P1)

4. **Implement capability-based routing**: In `buildRoutePlan()`, after building the candidate list, filter candidates by whether their provider's `metadata.capabilities` match the request's `required` features (already computed by `inspectRequestFeatures()`). This would prevent routing vision requests to non-vision providers.

5. **Add missing providers**: Groq, Cerebras, and Z.ai API are all OpenAI-compatible with free tiers. Adding them requires only a YAML entry and an API key — no code changes needed (the `middleware` adapter already handles OpenAI-compatible APIs).

6. **Add direct tests for `request-executor.mjs` and `provider-adapters.mjs`**: Test retry behavior, cooldown setting, streaming vs non-streaming, error classification.

7. **Integrate `quota.mjs` data into routing**: Feed the dashboard's quota probes into `buildRoutePlan()` as a scoring factor. Skip or deprioritize providers with exhausted quota.

### Long-term (P2)

8. **Refactor `tgw-proxy.mjs`**: Split the 2035-line monolith into focused modules: `auth.mjs`, `model-registry.mjs`, `protocol-translation.mjs`, `dashboard-backend.mjs`, `admin-endpoints.mjs`. Migrate all per-provider routing to use `provider-adapters.mjs` + `request-executor.mjs` uniformly, eliminating the legacy if/else chains.

9. **Enable true streaming for all providers**: The current `stream: false` + synthetic SSE pattern for OpenRouter, Mistral, OpenCode, and Modal adds latency. Pipe the upstream stream directly to the client.

10. **Persist discovered models**: Write the model registry to disk so it's available immediately on startup without waiting for provider endpoints to respond.

11. **Add DeepSeek, Kimi, and Qwen as direct providers**: These are currently accessed through 2-3 intermediaries (Cline, OpenCode, OpenRouter). Direct API access would reduce latency, eliminate intermediary-specific quirks, and provide better quota control.

---

## Architecture Diagram

```
                    Client Request
                          │
                          ▼
                   ┌─────────────┐
                   │  tgw-proxy  │  (port 8080)
                   │  .mjs       │
                   └──────┬──────┘
                          │
                    ┌─────┴─────┐
                    │           │
                    ▼           ▼
              Profile?      No Profile
                    │           │
                    ▼           ▼
          routing-planner   Legacy if/else
          .mjs               (hardcoded per-
                    │        provider routing)
                    ▼
          request-executor
          .mjs
                    │
                    ▼
          provider-adapters
          .mjs
                    │
          ┌────────┼────────┐
          ▼        ▼        ▼
       HTTP      OAuth    Cline
       proxy     proxy    adapter
          │        │        │
          ▼        ▼        ▼
    ┌─────────────────────────────┐
    │  Upstream Providers         │
    │  (MiniMax, OpenAI, Mistral, │
    │   OpenRouter, NVIDIA, etc.) │
    └─────────────────────────────┘

    DEAD CODE (not connected):
    ┌─────────────────────────────┐
    │  smart-router.mjs           │
    │  routing-profiles.mjs       │
    │  quota-tracker.mjs          │
    └─────────────────────────────┘

    Dashboard-only (not routing):
    ┌─────────────────────────────┐
    │  quota.mjs                  │
    │  usage-observer.mjs         │
    │  preferences.mjs            │
    └─────────────────────────────┘
```
