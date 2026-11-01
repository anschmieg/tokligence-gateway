# Gateway product scope refactor: current inventory

Status: milestone 1 source and deployment inventory; read-only inspection only.
Date: 2026-11-01. Branch: `t3/gateway-milestone-one-inventory-runbook`.

## Evidence boundaries

This inventory describes the checked-out repository, not a live deployment. It does not inspect secret files, environment values, mounted credential files, a remote host, or provider accounts. Values in `gateway.routes.yaml` are routing metadata and environment-variable *names*; credential contents remain out of scope. Source references below point into this checkout. No T3 Code hub implementation or authoritative hub contract was found in the repository. Hub paths, methods, payloads, authentication, streaming, timeout, reconnection, and write semantics are therefore an external read-only discovery item, not assumptions.

The selected backend requirement is mainline `router-for-me/CLIProxyAPI` only. The checked-in Docker build pins release `v7.3.20`, downloads the upstream release archive, and verifies architecture-specific SHA-256 values (`Dockerfile:1-18`). The selected UI requirement is the upstream CLI Proxy API Management Center at `/management.html`; it is not bundled in this checkout. The local `dashboard.html` and `/dashboard` are Tokligence's current UI and are not the target UI (`README.md:27`, `tgw-proxy.mjs:1534-1552`). The plan's statement about upstream dashboard compatibility and storage migration is a plan-level precondition; this inventory does not independently validate a dashboard/backend pair.

## Deployment and process topology

| Component | Observed source/configuration | Current role and boundary |
| --- | --- | --- |
| Tokligence Node public process | `Dockerfile:47-62`, `entrypoint.sh:96-115`, `tgw-proxy.mjs:1342+` | The only public HTTP service in the documented topology; listens on configured `TGW` host/port (README says `tgw-proxy.mjs` is public, `README.md:1-9`). Owns client auth, unified catalogs, routing, adapters and local admin API. |
| `@tokligence/gateway` `gatewayd` | `Dockerfile:24`, `entrypoint.sh:96-115` | Package binary started by entrypoint; readiness checked on loopback `8081`. Its relationship to public Node handling is deployment-specific; source package internals are not vendored. |
| Mainline CLIProxyAPI | `Dockerfile:1-18`, `entrypoint.sh:67-90` | Optional, embedded Codex OAuth proxy. Starts only when `CODEX_PROXY_ENABLED=true` and no external `CODEX_PROXY_BASE_URL` is supplied; bound to `127.0.0.1:8317`. Not the current public gateway or current admin UI. |
| OpenCode Zen adapter | `opencode-zen-*.mjs`, `opencode-account-pool.mjs`, `entrypoint.sh:5-38`, YAML provider `gateway.routes.yaml:326-373` | Custom in-process route with credential/session ownership and provider-specific logic. OAuth file lives under `/data/zen`; current source has primary and secondary account references. Do not copy or inspect either credential. |
| Specialist route handler | `specialist-routes.mjs:7-9,96+`, `tgw-proxy.mjs:1581-1584` | Direct fixed Mistral specialist HTTP routes and a realtime WebSocket rejection/upgrade path; see endpoint inventory below. |
| Local admin dashboard | `dashboard.html`, `dashboard.mjs`, `tgw-proxy.mjs:1534-1552` | Tokligence UI at `/dashboard`, admin auth required. Must not be confused with upstream CLIProxyAPI dashboard. |

The checked-in deployment mechanism is a single-service `docker-compose.yml` that builds `.`; publishes port 8080; mounts named volume `gateway-data:/data`; and injects provider/auth/access environment variables (`docker-compose.yml:1-33`). `entrypoint.sh` creates persistent directories, conditionally seeds the Zen credential from environment values, compiles config, optionally starts CLIProxyAPI, and starts the Node gateway (`entrypoint.sh:1-115`). `compile-config.mjs` writes generated Tokligence and CLIProxyAPI config, mode 0600, with output root default `/` (`compile-config.mjs:11-34`). The CLIProxyAPI config is generated from the flat route schema by `compileOAuthProxyYaml` (`compile-config.mjs:5-9,33-34`; `route-config.mjs`, search for `compileOAuthProxyYaml`).

Repository evidence says secrets are maintained in Coolify and referenced from config by environment-variable name (`gateway.routes.yaml:3-8`). README deployment references describe an attempted Coolify deployment blocked at Cloudflare Access (`README.md:141`), but no Coolify manifest, API automation, CI deployment workflow, or staging deployment definition is present in tracked files (`rg --files` for deployment/Coolify/`.github` returned only `docker-compose.yml`). Therefore the usable checked-in mechanism is Docker Compose/build; the actual existing Coolify project, staging host, routing, volume ownership, and promotion mechanism are unknown and must be discovered read-only before any deployment proposal is executed.

## Public routes, endpoints, and capabilities

All public APIs below are implemented by `tgw-proxy.mjs` except specialist routes delegated to `specialist-routes.mjs`. `/health` is the only documented unauthenticated route; ordinary APIs require the gateway bearer token, while `/admin/*` uses the separate admin secret and/or Cloudflare Access JWT (`README.md:40-72`; route branches `tgw-proxy.mjs:1348-1363,1555-1584`). This is the current Tokligence contract, not the future native CLIProxyAPI or T3 hub contract.

| Method/path | Purpose and current behavior | Evidence / limitations |
| --- | --- | --- |
| GET `/health` | Generic gateway liveness, unauthenticated. | `tgw-proxy.mjs:1348-1355`; no provider readiness promise. |
| GET or POST `/v1/models`, `/models` | Authenticated unified catalog; refreshes configured upstream catalogs per request. | `tgw-proxy.mjs:1555-1573`; README `14-18`. POST compatibility behavior needs contract fixture review. |
| GET `/v1/providers` | Sanitized provider registry. | `tgw-proxy.mjs:1618-1622`; README `19`. |
| POST `/v1/chat/completions` | OpenAI Chat Completions routed by exact model/provider branches; supports provider-dependent stream/tool semantics. | `tgw-proxy.mjs:1624-1645` onward; capability is not uniform across providers. |
| POST `/v1/messages` | Anthropic Messages; custom or shared conversion paths, streaming and tools depend on provider. | `tgw-proxy.mjs:2073+`; README `28`. `/v1/messages/count_tokens` is documented, but exact handler ownership/semantics need separate trace. |
| POST `/v1/responses`, `/responses` | OpenAI Responses compatibility path; several branches translate to Chat or Messages. | Request trace registration `tgw-proxy.mjs:1344-1346`; `isResponses` at `1624-1626`; README `30`. Streaming may be synthesized/limited per branch. |
| POST `/v1/systemone` | Native typed OpenCode Jev request to fixed SystemOne pool; session affinity and cancellation. | `tgw-proxy.mjs:1585-1615`; upstream URL `systemone.mjs:4`; `docs/systemone.md`. Not a general chat route. |
| GET `/admin/routes` | Sanitized effective local routing policy. | `tgw-proxy.mjs:1364-1368`; README `160`. |
| GET `/admin/status` | Local service, provider, catalog count, preferences metadata. | `tgw-proxy.mjs:1429-1442`; README `161`. |
| GET `/admin/quota` | Calls provider quota/balance observers. This is not guaranteed to be metadata-only/non-inference without provider-by-provider audit. | `tgw-proxy.mjs:1444-1457`; README `162`. No quota probes were performed for this inventory. |
| GET `/admin/preferences`; POST same | Read/update routing-preference overrides. | `tgw-proxy.mjs:1459-1487`; README `163-165`. |
| POST `/admin/preferences/clear`, `/reset`, `/bake` | Clear one/all overrides; bake writes policy into `gateway.routes.yaml`. | `tgw-proxy.mjs:1489-1525`; README `166-173`. This is a write to tracked deployment policy in current design. |
| GET `/dashboard` (GET `/` redirects) | Local Tokligence dashboard; admin authentication. | `tgw-proxy.mjs:1534-1552`; README `27`. Not native CLIProxyAPI UI. |
| POST `/admin/cline/oauth/start`; GET `/admin/cline/oauth/status`; POST `/admin/cline/oauth/logout` | Cline OAuth lifecycle/status/logout managed by custom Cline adapter. | `tgw-proxy.mjs:1370-1419`; adapter `cliproxyapi.mjs` (Cline methods around lines 400-700). Credential ownership is local file + custom adapter, not mainline CLIProxyAPI. |
| GET `/admin/cache-observations` | Sanitized local session/cache observation snapshot. | `tgw-proxy.mjs:1423-1427`. |
| POST `/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/embeddings`, `/v1/fim/completions`, `/v1/ocr`, `/v1/moderations` | Specialist Mistral forwarding, fixed configured base URL and model, bounded request body; multipart/audio body behavior is endpoint-specific. | `specialist-routes.mjs:7-9,23-36,38-63,96+`; README `31-36`. |
| WebSocket `/v1/audio/transcriptions/realtime` | Specialist route recognizes WebSocket upgrade and proxies to the fixed Mistral target; HTTP request without upgrade returns 426. | `specialist-routes.mjs:7-9,96-102,155-190`; gateway upgrade dispatch `tgw-proxy.mjs:2330+`; README `31-36`. End-to-end compatibility still requires fixture verification. |

Other documented client-facing features include exact model IDs, profile aliases, route preferences, `count_tokens`, and tool/message conversion. Detailed request/response fields and provider capability parity are not inferred here. Audio, speech, embeddings, OCR, moderation, FIM, realtime, Responses, SystemOne, and count_tokens must each retain separate acceptance rows rather than being inferred from chat support. See `README.md:11-39` and `gateway.routes.yaml:395+` for routing policy entry points.

## Route and credential ownership map

Credential owner means the component that stores, selects, refreshes, or sends the credential according to source/config; it does not mean this inventory inspected a credential. Environment names and storage paths only are listed.

| Route/lane | Credential reference / store | Owner and evidence | Open ownership questions |
| --- | --- | --- | --- |
| Tokligence / MiniMax / OpenAI default adapter | `TOKLIGENCE_AUTH_SECRET`, `TOKLIGENCE_ADMIN_SECRET`; `MINIMAX_API_KEY`, `OPENAI_API_KEY`; optional base URL envs. | Gateway auth and adapter in `tgw-proxy.mjs`, `provider-adapters.mjs`; route refs `gateway.routes.yaml:6-8,22-38`; injection `docker-compose.yml:10-21`. | Which routes are enabled in a real Coolify deployment is unknown. |
| Codex OAuth | `CODEX_PROXY_API_KEY`; auth directory `/data/cliproxy/auth`; generated `/data/cliproxy/config.yaml`; optional external `CODEX_PROXY_BASE_URL`. | CLIProxyAPI owns OAuth login/refresh, selection, affinity, retry/cooldown per `README.md:175-178`; starts loopback-only through `entrypoint.sh:67-90`; upstream binary is mainline v7.3.20 (`Dockerfile:1-18`). | Live credential count, external adapter selection, and effective runtime version are unknown. Do not inspect files or connect. |
| ChatGPT specialist | `CHATGPT_SERVICE_TOKEN`, `CHATGPT_SERVICE_URL`, gated by `CHATGPT_RESPONSES_ENABLED`. | Custom `chatgpt-responses` provider adapter; `gateway.routes.yaml:69-81`; adapters in `provider-adapters.mjs`. | Actual external service deployment/operator is unknown. |
| Copilot Auto | `COPILOT_GITHUB_TOKEN` or SDK interactive device login; state home `/data/copilot-auto`. | Copilot SDK/custom adapter and persistent home; `gateway.routes.yaml:83-93`; `Dockerfile:63-65`; `copilot-auto.mjs`. | Whether device login was used in any runtime is unknown. |
| Cline OAuth | `CLINE_OAUTH_CREDENTIALS_PATH` or default `/data/cline-oauth/credentials.json`; Cline/WorkOS API base envs. | Custom adapter handles OAuth, refresh, storage and API requests (`cliproxyapi.mjs:1-20,400-700`); config `gateway.routes.yaml:95-111`. | Current authenticated status and file presence unknown. |
| Mistral chat + specialist APIs | `MISTRAL_API_KEY`, optional `MISTRAL_API_BASE`. | Custom middleware and specialist handler; `gateway.routes.yaml:114-154`; `specialist-routes.mjs:23-36`; Compose `18-19`. | Whether quota/status reads dispatch upstream and exact credential boundaries need audit. |
| Google AI Studio | `GOOGLE_AI_STUDIO_API_KEY`, optional base URL. | Middleware adapter; `gateway.routes.yaml:157-175`. | Enabled/runtime state unknown. |
| NVIDIA NIM | `NVIDIA_API_KEY`, optional base URL. | Middleware adapter; `gateway.routes.yaml:177-196`. | Enabled/runtime state unknown. |
| Cerebras | `CEREBRAS_API_KEY`, optional base URL. | Middleware adapter; `gateway.routes.yaml:198-217`. | Enabled/runtime state unknown. |
| Together | `TOGETHER_API_KEY`, optional base URL. | Middleware adapter; `gateway.routes.yaml:219-235`. | Enabled/runtime state unknown. |
| Groq | `GROQ_API_KEY`, optional base URL. | Middleware adapter; `gateway.routes.yaml:237-256`. | Enabled/runtime state unknown. |
| Nous | `NOUS_API_KEY` (base URL reference in route). | Middleware adapter; `gateway.routes.yaml:258-276`. | Enabled/runtime state unknown. |
| OpenRouter | `OPENROUTER_API_KEY`, optional base URL; catalog allowlist policy. | Middleware adapter; `gateway.routes.yaml:278-308`; Compose `docker-compose.yml:16`. | Actual route eligibility and payment policy need effective config. |
| Modal GLM | `MODAL_GLM5_API_KEY`, `MODAL_GLM5_API_BASE`. | Custom middleware route; `gateway.routes.yaml:310-322`; Compose `14-15`. This is not Modal compute credits. | Runtime/entitlement unknown. |
| OpenCode Zen OAuth | `/data/zen/oauth.json` or `OPENCODE_ZEN_CREDENTIAL_FILE`; optional secondary file `/data/zen/secondary-oauth.json`; primary/secondary account IDs; refresh and session state in custom adapter. | Custom `opencode-zen` credential/session/account pool (`gateway.routes.yaml:326-373`, `entrypoint.sh:5-38`, `opencode-zen-credential.mjs`, `opencode-account-pool.mjs`). | 429 cause remains unresolved; no inference, quota probes, account/IP changes or credential inspection authorized. |
| OpenCode Zen API key (SystemOne-configured lane) | `OPENCODE_API_KEY`. | Custom pool references it for SystemOne model `jev-1.13-free` (`gateway.routes.yaml:357-360`); do not infer general Zen chat access. | Actual runtime use unknown. |
| OpenCode native experimental worker | `OPENCODE_NATIVE_KEY`, URL env, enable flag; worker state under separate staging/runtime configuration. | Custom `opencode-native` adapter (`gateway.routes.yaml:375-393`). | This checked-in provider entry does not prove a running worker or credential. |
| Cloudflare Access admin | Team/audience/JWKS/certs configuration envs, no token value inventoried. | Gateway verifies admin JWT (`README.md:48-72`, `cloudflare-access.mjs`); Compose `27-30`. | Whether it fronts an actual deployment and exact Access application are unknown. |

## Mainline CLIProxyAPI and native management integration

The current native upstream integration is narrowly the Codex OAuth lane: binary from mainline upstream v7.3.20 (SHA-256 pinned by architecture), generated native config, loopback listener, separate generated management key, and a health check against authenticated `/v1/models` (`Dockerfile:1-18`; `entrypoint.sh:40-90`; `compile-config.mjs:33-34`). `quota.mjs:323-345` calls CLIProxyAPI management at `/v0/management/auth-files`; this is an observed existing dependency on its v0 management API. The custom public model catalog uses the native route's model list. No native management dashboard artifact is referenced in build/deployment files; the browser UI is `dashboard.html`.

Important version gate: the current generated config is explicitly flat 7.x (`Dockerfile:4-6`, `route-config.mjs` `compileOAuthProxyYaml`). The plan/review identifies the upstream dashboard's v8 requirement and `/v8/management` behavior, while current backend remains v7.3.20. This repository evidence means a new pinned backend/dashboard pair needs an explicit config-schema migration and management API inventory before execution. Do not substitute Plus, auto-update artifacts independently, or assume direct T3 hub compatibility. The actual hub integration source is unavailable here; obtain its endpoint/auth/payload/version/stream/reconnect/write contract as a read-only external discovery task.

## Unknowns and unresolved evidence

1. No T3 Code hub client source or contract fixture is present. Discover it from the actual hub implementation/docs, read-only, before claiming native CLIProxyAPI direct compatibility.
2. No deployed state was inspected: effective Coolify envs, enabled routes, image digest, persistent volume contents, admin access path, external Codex base URL, and actual staging/prod topology are unknown.
3. No native upstream source checkout is vendored. Provider/executor/plugin extension points, lifecycle ordering, refresh/retry defaults, management write semantics, browser-originated tests, and complete native endpoint surface require pinned upstream source review in the next evaluation milestone.
4. No downstream inference/quota behavior was exercised. The OpenCode 429 cause remains explicitly unresolved by the plan; it is not evidence of request conversion, account, IP, or entitlement fault.
5. Capability flags in YAML are declarations, not verified protocol-feature evidence. Per-provider input support, tool semantics, reasoning, cache behavior, streaming/cancellation, usage, context, and specialist operations remain unknown/untested until mapped to source fixtures.
6. Native dashboard version/artifact digest and exact compatibility pair are unpinned in this checkout. Upstream release/tag and source must be pinned before dashboard use.

## Suggested isolated staging layout (proposal only)

No deployment or configuration was changed. For the next authorized platform milestone, create a separate staging project/root and isolated data volume, for example `staging/cli-proxy-api/` containing a pinned mainline backend image/build record, pinned native dashboard artifact record, sanitized example configuration, ingress policy, and a staging-only Compose overlay. Use an isolated project/network, distinct empty named volume, distinct staging host/credentials supplied only through the existing secret manager, and protected management ingress; keep the native inference/API endpoints available directly to approved T3 hubs behind the same protected ingress. Keep native CLIProxyAPI APIs as the direct hub integration target; do not route hubs through a custom façade. Keep all helper/provider processes private. Do not import, copy, mount, or seed production credentials or databases. Pin backend/dashboard versions and hashes together; snapshots must not overwrite UI/T3 native config edits after first bootstrap. Promotion is explicitly outside this milestone.
