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
