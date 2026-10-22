# Personal model catalog and routing

`gateway.routes.yaml` owns model discovery, picker visibility, and explicit model
equivalence. Consumers should sync picker-enabled rows from `/v1/models` instead
of maintaining their own copies of the exclusion rules.

## Discovery versus picker visibility

- `model_catalog.exclude` removes a row from discovery. Rules have a `pattern`,
  optional `provider`, and explanatory `reason`. Existing request aliases and
  explicitly configured role routes are retained.
- `model_catalog.retired` additionally refuses requests with HTTP 410. Space
  Bunny is retired, with no replacement mapping. Choosing MiniMax is explicit.
- `model_picker.hide` retains the row but sets `model_picker_enabled: false`.
  Specialist models are automatically picker-disabled regardless of their names.
- `model_picker.max_models: 32` prevents T3's renderer from silently dropping
  custom models. `priority` regexes select preferred models first. Overflow rows
  stay in the API catalog with a capacity reason in `policy.terms`.

Picker preference order is GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna, the selected
OpenCode free models, selected current Mistral models, then Laguna, North Code,
Liquid LFM, and Inkling families. Family matching covers both canonical IDs and
new OpenRouter-prefixed variants. New OpenCode free models follow these groups;
other eligible discoveries fill remaining slots. Ties within a priority group
are alphabetical, so overflow selection is deterministic rather than dependent
on the order provider endpoints happen to return. All Voxtral models, including
the chat-capable audio-understanding variant, remain API-only for this personal
coding picker. Their actual supported endpoints are preserved.

The configured policy excludes GPT-5.6, old GPT-6 Sol, Magistral, Pixtral,
Leanstral, Ministral 3B/8B, older GLM models served by Mistral, and selected dated
Mistral aliases. It retains Ministral 14B, Codestral, and Mistral Code/Vibe aliases.
GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna use Codex OAuth. This is configuration,
not a guarantee that every model is available to every upstream account.

## Canonical IDs and fallback

Bare/prefixed duplicates from one backend produce one discovery row. Mistral
uses `mistral/<id>` and verified `-latest` aliases reported by its model endpoint;
an arbitrary date suffix is never used to infer model identity. Cross-backend
equivalence is declared under `model_catalog.models.<public-id>.routes`.
Similar names do not establish equivalence, and DeepSeek V4 and V4.1 stay distinct.

Each canonical row exposes its aliases, backend routes, and a conservative
context window. Routes are ordered free, subscription, then paid, respecting the
explicit route order within a cost class. Fallback skips unavailable providers,
incompatible endpoints/features, context windows that are too small, and cooling
routes. Paid-route affinity never displaces a recovered free route.

OpenRouter discovery uses `catalog.zero_price_only: true`. Only explicit
`catalog.paid_allowlist` exceptions are discovered or eligible for canonical
fallback; listing a paid route in an equivalence mapping does not authorize it.
Missing/null prices are not treated as zero. Existing paid exceptions are
preserved; new paid models are not opted in automatically. Explicit legacy
provider-addressed requests retain their existing behavior.

Discovery refreshes when `/v1/models` is requested. OpenCode also refreshes at
startup and every 12 hours. Requests reuse that cache and do not trigger extra
OpenCode discovery within the 12-hour interval. OpenRouter free models and
OpenCode free models appear automatically, subject to personal catalog exclusions
and the picker limit. OpenCode discovery intersects the public
`https://opencode.ai/inference/v1/models` list with the `opencode` provider in
`https://models.dev/api.json`. Input, output, cache, and any tier prices must all
be explicitly zero. Unknown prices, deprecated models, and native Jev models
are rejected; a `-free` suffix alone grants no access.

OAuth accounts opt in with `discover_free_models: true`. With provider
`catalog.discover_free_only: true`, the live verified free set replaces static
chat allowlists for both advertisement and execution, including prefixed/direct
requests and fallback. Snapshots expire after 12 hours plus a one-minute
refresh grace period; refresh failures clear them, blocking chat until the next successful scheduled refresh. Failed attempts
are also cached for 12 hours to prevent request-driven retries. API keys remain
SystemOne-only.
No OpenCode credits or paid fallback are needed. Other providers' paid exceptions
and native SystemOne eligibility are configured separately.

## Specialist APIs

These Mistral models remain discoverable but are hidden from chat pickers:

| Model type | Gateway endpoint |
| --- | --- |
| Voxtral transcription | `POST /v1/audio/transcriptions` |
| Voxtral speech generation | `POST /v1/audio/speech` |
| Voxtral realtime transcription | WebSocket `/v1/audio/transcriptions/realtime?model=...` |
| Embeddings | `POST /v1/embeddings` |
| OCR | `POST /v1/ocr` |
| Moderation | `POST /v1/moderations` |
| Fill-in-the-middle | `POST /v1/fim/completions` |

HTTP accepts JSON or multipart forms, preserves binary file bytes and streaming
responses, and replaces only the model namespace and backend authentication.
Requests are limited to 32 MiB, with a 30-second body timeout and a 120-second
upstream inactivity timeout. Realtime uses a raw WebSocket tunnel authenticated
with the gateway Bearer header; it does not provision browser ephemeral tokens.
Wrong-endpoint requests are rejected before contacting the backend. Audio-only
models do not advertise Messages, Chat Completions, or Responses.

Voxtral Small's audio-understanding/instruction model is an exception: it supports
Chat Completions. This does not make audio input compatible with the gateway's
Anthropic or Responses translation. Chat-only backends advertise only the
implemented Chat Completions and, where supported, Messages translation surfaces.

## Chezmoi synchronization

The external dotfiles repository was inspected read-only. Its
`.chezmoiscripts/run_onchange_after_97-claude-model-picker.sh.tmpl` generates
Claude's picker from gateway-enabled models, then replaces T3's `customModels`
and `modelOrder` using `scripts/t3-code/merge-claude-gateway-models.py`. With this
gateway policy deployed, regenerating those lists no longer restores excluded
families or duplicate rows.

However, a runtime catalog change does **not** change the rendered `run_onchange`
hook. To refresh after deployment, rerun that specific rendered hook, or change
the external hook to `run_after` if synchronization on every apply is desired.
No external dotfiles were edited by this change. New gateway rows alone cannot
update already-running CLI or T3 processes.

Sources used to select the policy and protocol boundaries:

- <https://developers.openai.com/api/docs/models>
- <https://docs.mistral.ai/models>
- <https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-in-realtime>
- <https://docs.mistral.ai/models/voxtral-small-25-07>
- <https://opencode.ai/v2/docs/console/models/>
- <https://openrouter.ai/api/v1/models>
