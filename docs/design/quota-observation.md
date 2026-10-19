# Provider quota observation

## Codex

The embedded CLIProxyAPI 7.3.20 management listener remains on literal loopback,
with remote access and the control panel disabled. Startup generates a separate
random `CODEX_MANAGEMENT_KEY` unless one is supplied. Never reuse a public API key.
The key is shared only by the local proxy processes and the private generated config.
External CLIProxyAPI instances require the same key configured separately; non-loopback
management URLs are rejected and therefore are not currently supported by this observer.

The gateway lists active Codex credentials using `/v0/management/auth-files`, then
uses `/v0/management/api-call` with a fixed GET target:
`https://chatgpt.com/backend-api/wham/usage`. Token substitution happens inside
CLIProxyAPI. No OAuth files are downloaded. Only numeric usage windows and reset
metadata are returned to the authenticated dashboard, not emails, tokens, auth
indices, raw bodies or account IDs. Partial failures are explicit. Window percentages
are not averaged or treated as token-denominated balances. These requests report
usage, not inference, and do not change cooldowns or consume reset credits. Queries
are capped at 32 credentials, concurrency four, and a 15-second overall deadline.

Reference: https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.20/internal/api/handlers/management/api_tools.go

## Mistral research (2026-10-19)

Mistral's help center documents monthly API and Vibe quota consumption percentages
in Code → CLI → View organization usage:
https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them

Enterprise Admin API billing consumption uses a dedicated Admin key; the response
is category-based and is not necessarily equivalent to remaining Vibe allowance:
https://docs.mistral.ai/admin/admin-api/usage-metrics

Ordinary inference may expose `X-RateLimit-Remaining`; this is rate-limit telemetry,
not proof of monthly subscription consumption:
https://docs.mistral.ai/resources/known-limitations

## Unofficial Vibe subscription observer

CodexBar source implements `GET https://console.mistral.ai/api-ui/trpc/billing.vibeUsage`
with the tRPC `batch=1` and encoded `input` value, sending `csrftoken` plus
`ory_session_*` cookies and `X-CSRFToken`. It parses
`.[0].result.data.json.usage_percentage` and `reset_at`.

Source inspected:
https://github.com/steipete/CodexBar/blob/7508e656cd679c52e238cba13ef06a6044d9e075/Sources/CodexBarCore/Providers/Mistral/MistralUsageFetcher.swift

The gateway implementation is opt-in through `MISTRAL_SESSION_FILE`, a read-only
mounted JSON file shaped as `{ "csrfToken": "…", "sessionCookies": { "ory_session_console": "…" } }`.
The file must be a regular, current-user-owned file with mode 0600 or stricter,
under 16 KiB. Only `csrftoken` and validated `ory_session_*` cookies are sent;
the request host and path are fixed. The observer rejects redirects, has a 4-second
deadline and a 64 KiB response cap. It never imports browser state, returns cookies,
or logs response bodies. Remove `MISTRAL_SESSION_FILE` to disable it; rotate the
file contents out-of-band when the web session expires.

The signal is displayed as **Unofficial Vibe subscription quota**. It reports the
console's monthly Vibe percentage, not general Mistral API spend or a standard API
key's remaining allowance. It is unofficial, can break at any time, and has not been
tested with a live account. Do not treat it as a permission or routing signal.

The Admin API, this unofficial Vibe signal, response `X-RateLimit-Remaining`, and
gateway-observed usage are separate dashboard signals. Gateway token totals reflect
only traffic through this gateway, not account-wide consumption.
