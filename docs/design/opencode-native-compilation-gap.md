# OpenCode token-field finding — November 2, 2026

Recovered from the failed GLM Flash task's saved work and checked directly
against the pinned 2.0.32 source. No new inference or compiler fixture was run.

## Established

- `packages/ai/src/providers/openai-compatible.ts` selects
  `OpenAICompatibleChat.route`. `protocols/openai-compatible-chat.ts` reuses
  `OpenAIChat.protocol` without changing lowering semantics.
- `protocols/openai-chat.ts:683-715,821-846` selects the output field from
  `model.compatibility.maxTokensField`, otherwise provider/URL detection.
  For provider `opencode` and `opencode.ai/inference/openai/v1`, the generic
  default is `max_completion_tokens`.
- `protocols/zai-chat.ts:65-71` overrides that field with `max_tokens` and
  declares `reasoning_content`. A GLM-shaped ID alone does not prove that
  the selected model uses this package.
- `core/src/model-resolver.ts:227-239` constructs the selected provider package
  then overlays resolved compatibility. Console model `package`, `modelID`,
  compatibility, headers and body can affect the result
  (`core/src/plugin/provider/opencode.ts:266-335`).
- Existing released compiled-CLI evidence in
  `native/opencode/compiled-cli-evidence.json` already records
  `max_completion_tokens` for an explicitly configured synthetic public
  OpenAI-compatible provider. It does not prove the working OAuth profile's
  effective per-model configuration.
- The deployed gateway plugin currently preserves whichever single token field
  its caller sends. That can differ from native model-aware lowering, but the
  correct resolved field for the working OAuth Beam/GLM profile remains unproven.

## Corrections to the delegate's recommendation

Do not add a token *value* when the caller supplies no limit: native lowering
uses optional `generation.maxTokens`; absent values disappear during encoding.
Do not infer the selected package from a model-name prefix. Also do not use
`compiler-probe.ts` as an untouched default baseline: that saved probe explicitly
injects `maxTokensField: max_tokens` and `reasoningField: reasoning_content`.
Its output proves lowering under those supplied overrides only.

## Implementation decision

No speculative token rewrite or new model-policy framework. Use the existing
single-field validation until actual resolved package/compatibility evidence
supports a small correction. The saved staging Console response contains only
provider name/headers and per-model disabled flags, not a package or compatibility
override. It alone cannot reconstruct the catalog defaults of the working
reference profile. This uncertainty is not evidence that either token field
caused429. Quarantine and all recorded live evidence remain binding.
