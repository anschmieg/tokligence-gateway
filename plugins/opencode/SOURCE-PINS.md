# Source pins for the OpenCode plugin ports

The pinned actual OpenCode source trees (read-only references) are:

| Version | Path | Archive SHA-256 |
| --- | --- | --- |
| 2.0.32 (the working inference server's version) | `/tmp/opencode-2032-parity` | `d9e080eae0965104dfe3857aabbc8ce976e9aeaa62110ce101bc1a107d243d97` |
| 2.1.4 (the staged native runtime) | `/tmp/opencode-214-parity` | `eb16e1b9c504fff1e7d8679d7a88421967a403a7bb233e8993879a46735ff61f` |
| 2.2.5 (the upgraded client) | `/tmp/opencode-225-parity` | `04621edf6c47c2c7a36982ef39914d482c16977708fbd7b779f49f928bdc4fba` |

Archive URLs and Bun/Effect pins: `native/opencode/reference-2x-source.json`
(2.0.32/2.2.5) and `native/opencode/source.json` (2.1.4,
commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`). The host ABI is verified
against the pinned CLIProxyAPI v8.0.49 tree at `/tmp/m2-eval/backend`
(`internal/pluginhost`, `sdk/pluginabi`, `sdk/pluginapi`). The earlier legacy
1.18 adapter is NOT a parity reference.

## Port map

| Our file | Native source (inside the pinned archives) | What is ported |
| --- | --- | --- |
| `credential.go` | `packages/schema/src/credential.ts` (`Credential.OAuth`), `packages/core/src/console-access.ts`, `packages/core/src/integration.ts` (`expiring()`), `packages/core/src/plugin/provider/opencode.ts` (`refresh`, `credential`) | The native OAuth credential value shape (type/methodID/access/refresh/expires/metadata with server/accountID/email/orgID/orgName), the Console server normalization, the Console API header set (`x-org-id` only for Console calls), the 5-minute refresh lead, the token rotation with org metadata handling. |
| `handler.go` (`auth.refresh`) | `packages/core/src/plugin/provider/opencode.ts` (`oauth().refresh`) | The refresh grant: `POST {server}/auth/device/token` with `grant_type=refresh_token`, `refresh_token`, `client_id=opencode-cli`; HTTP 400 `invalid_grant` is the terminal native `SignedOut` (only a new device login recovers; never retried). |
| `request.go` | `packages/core/src/session/model-request.ts` (http.headers block), `packages/core/src/app.ts` (`App.useragent`), `packages/ai/src/protocols/openai-chat.ts` (`fromRequest` body compilation) | The exact native inference header set (`x-opencode-session-id`, `x-session-affinity`/`X-Session-Id`/`x-opencode-session` with the affinity, `x-opencode-project`, `x-opencode-client`, `User-Agent: opencode/<channel>/<version>/<name>`), `stream: true` and `stream_options.include_usage` body rules. |
| `errors.go` | `packages/core/src/session/to-session-error.ts` | The native QuotaExceeded taxonomy: `FreeUsageLimitError` → `provider.free-limit` (native message), `BudgetLimitError` → budget/model-budget by coverage, `GoUsageLimitError` → `provider.go-limit` with the recorded limit name, generic quota/rate-limit/auth otherwise. |
| `session.go` | `packages/core/src/session.ts` (`Session.create`), `packages/schema/src/session-id.ts` + `packages/schema/src/identifier.ts` (`descending()`), `packages/core/src/session/affinity.ts` | The native session id shape (`ses_` + 12 lowercase hex + 14 base62), the affinity variant (`^ses_[0-9a-f]{64}$` from model-request.ts), and the documented gap: `Session.create` needs the native project resolver/event bus/session store. |
| `transport.go` | `/tmp/m2-eval/backend` `internal/pluginhost/host_callbacks.go` (`rpcHostHTTPRequest`, `rpcHostHTTPStreamResponse`, `rpcHostHTTPStreamReadResponse`), `internal/pluginhost/stream_bridge.go` (`rpcStreamEmitRequest`, `rpcStreamCloseRequest`) | The host bridge wire shapes for `host.http.do` / `host.http.do_stream` / `host.http.stream_read` / `host.stream.emit` / `host.stream.close`, including the `pluginabi.Error`-shaped `error_detail`. |

## Version agreement

The files above are byte-identical across 2.0.32 / 2.1.4 / 2.2.5 for every
ported behavior (verified by diff of the listed paths): the credential
schema, the refresh grant and its SignedOut boundary, the inference header
block in `model-request.ts`, the App.useragent format, the session id
generator, and the toSessionError taxonomy. Where a 2.2.5-only addition
exists (`usage-limits.ts` `x-opencode-org-id` for the Go usage endpoint), it
is intentionally NOT ported: it belongs to the Go-plan usage API, not to
inference, and inference header parity is pinned to the 2.0.32 working
server's behavior.

## Differential tests

Each port has focused tests in the matching `*_test.go` file, constructed
from the pinned source behavior (not from the plugin's own output):

- `credential_test.go`: native credential fixture, foreign-shape decline,
  server normalization, Console header set, expiry window, refresh rotation
  (org metadata handling), SignedOut terminality.
- `request_test.go`: the exact native header set (including the absence of
  org headers in the base session block; Console provider overlays apply separately), the useragent format across channels, body
  compilation rules, no-tool-injection, endpoint join.
- `session_test.go`: the native id shape against the known working session
  ids, the no-minting rule, the precise gap error, foreign-namespace
  rejection.
- `errors_test.go`: the toSessionError taxonomy, request-id extraction order
  and charset bound, Retry-After parsing, terminal status set.
- `handler_test.go`: registration contract, login refusal, auth parse,
  refresh grant with a fake transport (no network), expiry admission before
  dispatch, session-identity gating, dispatch headers, rejection preservation,
  stream relay/error-close, bounded Console GET passthrough.

Console overlay correction Nov2: plugin/provider/opencode.ts provider.transform
merges remote providers[providerID].headers; model-resolver.ts carries resolved
headers into the runtime route. The session/model-request.ts header block alone
is not the complete inference header set. Actual staging Console config returned
x-opencode-org-id matching the same credential org. console_headers applies that
reviewed snapshot with account-scope/transport-header refusal. This is a narrow
snapshot implementation, not the entire dynamic Console provider transform.

Console model policy Nov2: `plugin/provider/opencode.ts` provider transform sets
`model.enabled = !config.disabled`. `console_disabled_models` carries the reviewed
snapshot denylist into local model publication and both executors. Unknown models
remain unadmitted by the operator allowlist. Native compiled-host isolated fixture
`/tmp/opencode-console-model-policy-20261102-a` includes an allowlisted but
Console-disabled model, verifies it is absent from publication and preserves the
existing reasoning continuation. Focused tests reject disabled dispatch before
HTTP and malformed/null list entries without mutating prior configuration.
