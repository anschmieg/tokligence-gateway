# Cost and Compaction Implementation Plan

> **For agentic workers:** Execute inline with TDD; preserve the design's fallback and safety rules.

**Goal:** Implement the approved cost/compaction design across gateway routing while preserving sessions and never breaking a turn.

**Architecture:** Keep provider-specific wire protocols in their existing adapters. Add opt-in policy above the adapters for class/role decisions, with candidate context-window and capability checks before substitution. Keep session observations in bounded memory only; never store transcripts or enable automatic access.

**Tech Stack:** Node.js ESM, node:test, YAML routing configuration, existing provider adapters and model catalog.

**Spec:** docs/design/cost-and-compaction-architecture.md

## Global Constraints
- Codex stays on CLIProxyAPI 7.3.20; preserve the Responses compact endpoint, session affinity, and negotiated fallback.
- Class routing is opt-in; a downgrade target must meet the session model's context-window floor or the original route wins.
- Any candidate failure falls back to the session model; no turn is rejected to force compaction.
- Anthropic beta headers and paired body fields are route-allow-listed; never send them to Codex translation.
- Store only bounded session identity/timing/usage metadata in memory; never transcripts or persistent session state.
- No push, deployment, live GUI tests, or real quota-consuming probes as part of this plan.

## Review Focus
- Unknown model window: substitution must be refused unless authoritative metadata or an explicit profile floor exists.
- Provider beta on Codex/translated lanes: header and paired body fields must both be absent.
- Malformed/untrusted request-class headers: treat as ordinary main traffic.
- Cheap-route failure: retry the original session route without losing the turn.
- Restart/eviction: missing in-memory observations must degrade to ordinary routing, never an error.

---

### Execution slices and current status

1. **Provider compaction safety — implemented locally:** preserve signed Anthropic compaction blocks through normalizing and stream-folding paths; per-provider beta allow-list filters headers and paired fields; prohibit Codex/translated allow-lists. No provider is allow-listed without verified support.
2. **Class routing — implemented and enabled:** pass validated Claude hints into routing; prepend `mistral/mistral-medium-3-5` (documented 256k window) for `subagent`, `workflow` and `auxiliary` when it clears the profile floor, and keep the ordinary profile chain as fallback.
3. **Usage baseline — implemented:** aggregate input/output, Anthropic cache-read/cache-creation and compaction-iteration token counts by provider/model through existing admin usage reporting.
4. **Role aliases — implemented and configured:** `role/review-strong` and `role/review-fast` declare explicit family, verified window and profile fallback; bounded in-memory family history filters toward unused families, then uses the role's full list and profile fallback.
5. **Cold-resume routing — blocked on evidence:** no reliable cache-cold signal or per-provider threshold is available. Do not guess a timer or build a gateway summary cache before resolving the documented spikes.
6. **Completion — current:** update design/status language, run full tests/lint and diff checks. Do not push/deploy or claim measured quota savings; optional shunt swap and live Codex compaction remain separate/unverified.

Execution method: inline in this session, as previously agreed.


### Final review

- Fresh read-only review found two correctness issues; both were fixed test-first.
- Mutual-exclusion regression test: RED when both fields were forwarded, GREEN after the gateway retained compaction and stripped context editing.
- Iteration-total regression test: RED when `total_tokens` ignored billed iterations, GREEN after totals reconcile to at least summed input/output.
- Final validation: `npm run lint`, changed-file `node --check`, `npm test` (114/114), and `git diff --check` passed.
- Remaining evidence gate: cold-resume routing and provider beta activation are not enabled without verified compatibility/cache signals.


### Cache-evidence instrumentation

- Codex Responses completions now feed the existing token observer.
- Added bounded, memory-only session cache observation buckets (provider/model and elapsed time between same-session requests); no prompt, raw session key, or credential is included in the aggregate admin endpoint.
- No live samples or routing threshold are claimed. Upstream docs establish that MiniMax ignores context management and do not document compaction; the current MiniMax route is now config-ineligible for beta allow-lists.
