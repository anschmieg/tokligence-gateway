# OpenCode request compatibility review — October 28, 2026

Status: fixes verified offline; provider 429 cause and live bridge acceptance remain unresolved. No statistically defensible 99.99% reliability claim follows from these tests.

| Finding | Resolution / evidence |
| --- | --- |
| Earlier capture forced provider package/baseURL and did not prove the deployed route. | Authenticated zero-inference diagnostics inspected the actual worker catalog: four models resolve to the expected OpenAI-compatible public endpoint. Diagnostics now also expose the configured reasoning field. |
| Reference and native bodies differed for tools: empty content versus null, absent strict versus false, and default auto tool choice versus omission. | Native message/model APIs now align those encodings with the working 1.18 reference; no outgoing JSON or identity-header spoofing. |
| No independent multi-turn request comparison guarded against regressions. | New OS-network-isolated differential test compares upstream 1.18 provider transform + SDK compiler with the 2.1 native worker, across 32 cases / four models. Reference source, SDK distribution and Bun version are pinned and checked. |
| Histories could leave tool calls unanswered, or insert another conversation turn before results. | Reject locally before session allocation or provider I/O; allow parallel results in either order and inline system reminders. |
| A rejected HTTP response could lose its status when its body was oversized, truncated or failed to read. | Both transports retain rejection status/reset/request ID from headers; bounded error bodies and truncated-body regressions prove cooldown persists. |
| Control labeled every 429 FreeUsageLimitError, even when the provider did not identify that error. | Preserve the actual allowlisted error type; use generic rate_limit_error for an unidentified 429. |
| Invalid retry duration could throw while formatting an otherwise known native quota error; unknown tags could expose arbitrary values. | Validate date range; preserve status and omit unusable retry data. Only source-known reason tags are exposed. |
| Loopback gateway probes inherited proxy configuration. | Explicitly disable proxies for the loopback client; regression proves a configured proxy receives no traffic. This does not establish that a proxy caused any historical rejection. |
| Live scripts retained obsolete midnight-adjacent defaults. | --not-before is mandatory; existing scheduled continuation remains October29 01:03UTC with one request and durable no-replay/cooldown controls. |

## Exact scope of the new comparison

Reference: OpenCode1.18.32 commit545f51d26cc39a907d2867492d498d9607ea5fa4; its unmodified ProviderTransform.message and @ai-sdk/openai-compatible2.0.41; Bun1.3.14. Hashes are in reference-source.json. Native: pinned OpenCode2.1.4 + reviewed bridge, Bun1.4.4.

Eight vectors per model: long Unicode text plus generation controls; nonempty reasoning replay; empty reasoning replay; absent reasoning field; reasoning effort; tool error; parallel tool history with reversed results; named tool selection. All32 generated JSON bodies match structurally, ignoring JSON object-key order. No arbitrary field omissions or permissive difference allowlist is used.

The test exercises upstream provider compilers with identical synthetic caller inputs. It does **not** run the entire reference CLI agent loop for those32 cases. Separate compiled-CLI captures and actual Claude Code tests cover their named flows. The source reference and native fixture use controlled public auth and catalog compatibility; this is not evidence that production OAuth/public routing or dynamic server configuration are identical.

Known differences remain: native2.1 versus manualCLI1.18 generated User-Agent and session/header lifecycle, native tracing/affinity headers, source/native Bun versions and TLS, OAuth versus public auth, modified control profile, historical timing and destination/egress family. Do not spoof version headers or claim full CLI parity. Multipart/system normalization outside the listed vectors is not proven byte-for-byte equivalent.

The same-VPS GLM success at09:28 invalidates a blanket daylong account/VPS-block explanation, but occurred about9hours after the rejected control. Neither request mismatch nor punitive quota treatment is proven as the429 cause. A provider can reject a perfectly formed request for reasons outside the gateway's control.

## Reproduction

Set OPENCODE_NATIVE_SOURCE and OPENCODE_NATIVE_BUN to the prepared2.1.4 source/Bun1.4.4. Set OPENCODE_REFERENCE_SOURCE to the frozen installed1.18.32 source workspace and OPENCODE_REFERENCE_BUN to Bun1.3.14. Set OPENCODE_OFFICIAL_CLI_BINARY and OPENCODE_NATIVE_CLAUDE_BINARY for the compiled OpenCode and Claude fixtures. Run npm run test:native; the comparison is included. Missing optional runtimes are explicitly skipped, not passed. Also run npm test, npm run lint and the native SDK typecheck. Control quota/body/proxy tests run via test/opencode-native-official-control.test.mjs and test/opencode-native-live-safety.test.mjs; set OPENCODE_NATIVE_BUN to exercise the Bun transport branches.

No inference was sent during this review. The next live comparison remains the already-authorized01:03UTC single GLM control, followed only on success by the matched native-public request and bounded acceptance phases. Stop on renewed rejection; never change credentials/IPs or manufacture request identities to evade limits.

## Final verification and staging

Full suite347 passed/5explicit runtime skips. Native6 passed/0skipped, including the32-case comparison and actualClaudeCode/compiledOpenCode fixtures. SDK typecheck1292 files clean; lint, Python compilation and helper syntax clean. Staging28 targeted synthetic/auth/wire/control checks passed after exact3a291f8 code+preparedworker/wire deployment. Both health endpoints200, exclusive state flock held, defaultOAuth preserved, production secondary path absent. Actualcatalog reasoning_field is reasoning_content for allfour models, matching the tested metadata. Durable live ledger still contains only the prior official-glm-control-20261028; no inference during review.

## Second pass — message structure and deployment integrity

Expanded the same pinned differential suite from32 to80 exact structural cases. New coverage: consecutive initial system messages, inline system roles, multipart user/assistant text, blank/null/whitespace assistant turns, omitted tool descriptions, completed tool history with no active tools, required/none tool selection, and invalid Unicode surrogates.

New findings fixed:

- The 2.1 compiler merged initial system messages and wrapped chronological system instructions into user content. The bridge now retains leading system-message boundaries and opts into a small prepared-source compatibility extension that emits the original system roles without wrappers.
- Multipart user content was flattened, and blank assistant turns were dropped. The same bridge-only extension preserves these structures. Default compiler behavior is unchanged when the option is absent;101 upstream OpenAI/OpenAI-compatible tests pass in an OS network namespace.
- Omitted tool descriptions became empty strings, and inactive tools became an extra empty array on history replay. Preserve omission through a boolean tool metadata marker and the opt-in compiler option. Explicit descriptions remain intact.
- The original structural comparator could consider an empty array and empty object equivalent. A separately tested JSON comparator now checks container type, field presence, array length and escaped JSON paths.
- Bun1.3.14's JSON/input path normalized invalid surrogate escapes differently from the newer worker. Text normalization now matches the observed replacement-character behavior; valid Unicode is unchanged.
- Copying a new worker without its prepared compiler could silently lose these fixes. A fixed nine-file SHA256 manifest is generated at preparation and verified before host creation. A stale/partial bundle fails startup; health and response headers expose its nonsecret digest. Tests reject both stale compiler files and arbitrary manifest paths. Preparation is idempotent and verifies every patch seam.

Verification: full349pass/5explicitruntime skips, native6pass/0skip including80 differential cases and actualClaude/compiledCLI fixtures, SDK1293files clean, and101 upstream protocol tests pass. No provider inference during this pass. Runtime deployment must include the complete generated manifest bundle, particularly packages/ai/src/schema/options.ts and packages/ai/src/protocols/openai-chat.ts, not just SDK worker files.

User additionally reported a manual-TUI free-message limit resetting1:31AM October29. The inspected 1.18 profiles have no new persisted failure. The exact text is present in the newer2.x TUI, which formats reset using local machine time. Machine/profile/timezone are pending clarification; do not assume1:31UTC or a shared quota bucket. The01:03 live command is gated until the later reset is confirmed, then must retain at least an hour of margin. This banner is quota evidence on the manual path, separate from the original missing-reasoning400, not a proven explanation of earlier gateway429s.

Second-pass deployment:649df97 staged with all nine hashed sources and generatedmanifest, startupdigest d7965c9a38fb544691d1f1b6728ff2bd6aefc25625fa3cd8adbc2ccb8cbd6052 verified. VPS28 targeted checks passed, both services healthy, OSlockheld, productionsecondarypathabsent, and live ledger stillone historicalrun.

## Plan-level follow-up

See LIVE-ACCEPTANCE-PLAN.md for the later adversarial review of rate-limit exposure, full-harness parity and session/tool lifecycle. It supersedes automatic live expansion and stale reset/timezone instructions above. Apollo reset is confirmed00:31UTC; earliest next window01:34UTC, conditional on documented gates. No new runtime fixes or test passes are claimed by this plan review.

## Prepared-run adversarial review — October 28

Four findings fixed, with no live inference:

1. **High: the native identity check was only at direct-route selection.** An alias/profile selecting the adapter could supply a legacy default sticky key. The native adapter now independently validates conversation identity and derives the principal-bound scope, ignoring caller-supplied sticky keys. A direct adapter regression reproduces the bypass; principal isolation is tested.
2. **Medium: live admission did not pin executables or bind the state root.** A changed Bun/CLI binary, alternate ledger root or missing staging pause could invalidate the prepared comparison or collide with the1GiB limit. The plan now pins exact runtime paths/SHA256, staging root and code location, and requires managed service pause for actual live execution. The zero-inference check remains non-mutating. Tests reject alternate roots/code, same-content alternate executables, changed binary bytes and missing pause.
3. **Medium: dry-run readiness could disagree with the actual guard.** It omitted imported historical cooldowns, spent aggregate windows, changed window policies, and a caller-supplied later not-before. Readiness now uses the same historical cooldown reader as locked dispatch and reports those conditions without writing the ledger. Tests cover each case, including boolean budgets rejected as malformed.
4. **Medium: rename alone did not establish crash durability.** Reservations/cooldowns now flush+fsync the pending ledger, rename, then fsync the directory before forwarding. A regression checks that ordering and injects a failed sync before any provider I/O. This uses Linux filesystem durability primitives, not a claim that power-loss behavior was physically tested.

Extra fault coverage confirms invoking the native HTTP middleware twice still sends only once. A fixture startup race also surfaced: process-ownership tests could inspect /proc before the synthetic child had executed its script. The fixture now signals readiness explicitly before ownership is checked; production ownership checks remain strict.

Verification: full351pass/5explicitruntime skips, lint clean; targeted real-runtime3pass (scoped HTTP including double dispatch and actual Claude/native tool/reasoning recovery), plus actual compiled OpenCode network-blocked capture1pass. Python safety12cases; official-control/admission16cases including Bun transport pass with the runtime supplied. Prior80+5 exact-body comparison and SDK1293-file results remain applicable: no compiler/worker/scoped-http source changed in this review. The four gates remain bounded synthetic evidence, not live quota availability or total CLI/TLS parity. Runtime/evidence hashes were refreshed; the existing stable run/window IDs and schedule are unchanged.

## Startup and recovery adversarial review

Three findings fixed:

- **High — public-mode validation ran too late.** EmbeddedHost creation could activate native credential/config logic before the later credential-count check rejected an unexpectedly populated public database. The worker now checks fixed credential/account tables read-only before host creation, loading counts only and withholding database-error details. Credential-bearing/unrecognized public state fails before activation. Network-isolated real-worker regressions cover native credential and legacy account tables, plus clean initial boot and clean restart.
- **High — SDK automatic recovery could bypass the caller's loop.** EmbeddedHost automatically sweeps suspended native executions. This bridge's caller owns continuation and tool execution, so a mixed/imported pending native run could start model/tool work at boot without a gateway request. The worker now uses the supported SessionRestart service replacement with an inert automatic sweep. A real native database regression seeds a suspended claim, verifies no boot inference and verifies the claim is preserved. This is a deliberate safety difference from full CLI recovery; it neither silently executes nor discards pending work.
- **Medium — session-reference persistence lacked disk sync.** Session create/remove intents now sync the pending file, rename, then sync its directory before native side effects. An injected sync failure proves native creation is not invoked until reference persistence succeeds. Existing crash/journal/model-switch fault tests remain applicable; this does not claim physical power-loss testing.

Readiness is emitted after signal-handler installation. The positive public fixture explicitly accounts for the bwrap supervisor being terminated after readiness; it does not label that supervisor's exit a verified graceful worker shutdown.

The combined verification also exposed a reference-fixture gap: TCP reset during CLI abort was discarded as an unclassified OSError, so a closed provider socket could be reported as not closed. The fixture now recognizes EOF and connection reset explicitly; timeout, unexpected data and unrelated exceptions still do not count as closure. A pure socket-outcome regression guards the distinction. This changes fixture accuracy, not provider retry/cancellation policy.
