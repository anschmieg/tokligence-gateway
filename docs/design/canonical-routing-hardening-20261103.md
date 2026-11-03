# Canonical routing adversarial fixes

The six findings in `canonical-routing-adversarial-review-20261103.md` have
permanent regressions and matching native/FreeHub fixes.

1. **Final source binding:** canonical execution bypasses native alias/pool
   interpretation. Each attempt freezes its eligible credential/source/cost
   bindings. Immediately before every executor invocation, native code verifies
   the binding against current registration and claims a shared one-use permit.
   Changed source/cost or a reused permit fails locally before dispatch.
2. **Suffix admission:** an unavailable canonical `:free` name fails closed,
   including unknown publisher namespaces. Only positively identified registered
   provider overrides bypass policy; a slash is not override provenance. Turning
   canonical mode off preserves stock native source-name behavior.
3. **Per-model and per-credential costs:** additive JSON `CostTier` and
   `SourceModelID` model fields carry producer evidence through the plugin ABI,
   registry and non-secret model cache. FreeHub's final source/cost ledger is
   scoped to the selected credential, not the shared vendor cache. Free/paid
   visibility settings do not change economic classification. Explicit positive
   prices override free suffixes/flags; unknown cost does not grant free routing.
   Empty/failed auth-model refreshes revoke grants; Cline's bundled metadata
   fallback retains model names without asserting fresh free-price evidence.
4. **Streaming bound:** the one-use permit covers the streaming pool and retry
   branches as well as non-streaming execution. A direct pool regression bypasses
   candidate selection deliberately and still proves only one executor dispatch.
5. **Compatibility:** Gemini file/inline-data input and requested output
   modalities are recognized. Text-only alternatives cannot accept PDF or audio
   output requests. Explicit tool choice requires declared support.
6. **Identity:** only an identified transport wrapper is stripped. Raw model
   family names such as `mistral-small-3.2`, `deepseek-v4` and `qwen-3.7` survive;
   FreeHub supplies its unwrapped source explicitly instead of relying on name
   guesses. Original explicit provider routes remain registered and hidden.

Response provider disclosure and attempt deduplication use the frozen admission
snapshot, so a later catalog update cannot relabel the completed execution.
No source/cost/account/IP fallback is added after authentication refusals; no
stream is spliced to another model after output starts.

Verification: focused native and FreeHub race tests passed, including all
reported adversarial counterexamples, repricing, namespace/suffix ambiguity,
per-credential isolation, grant revocation, final-boundary pool escape and stock
mode behavior. Exact compiled native `.12` plus FreeHub `.1.7` passed the proven
network-isolated real-host fixture: original override, unknown free request
rejected before dispatch, intentional source/alias collision without target
escape, plain free-to-paid routing and compatible free-only fallback. Six mock
POSTs, no external provider inference. Evidence:
`canonical-hardening-isolated-20261103.json`.

This enforces admission against the gateway's cost evidence; it is not a
provider-side billing cap or a claim that every upstream/model/key was live
retested. No real paid calls, OpenCode probes, credential copies, quota resets,
management-panel changes or second refresh owner are required for this rollout.
Native and FreeHub artifacts must be swapped together under the existing
single-owner deployment lock. Existing account/settings/config bytes, dashboard,
OpenCode plugin and protected account state must remain unchanged.
