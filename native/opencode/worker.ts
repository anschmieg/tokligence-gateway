// Copied into the pinned OpenCode SDK source tree by prepare-opencode-native.mjs.
// There is no agent runner or tool executor on the completion request path.
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, timingSafeEqual, randomUUID } from "node:crypto"
import { Effect, Stream, Layer, Schema, Cause, Exit } from "effect"
import { LLMClient, Message, SystemPart, ToolDefinition, type ToolChoice } from "@opencode/ai"
import { EmbeddedHost } from "./internal/host"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/schema/integration"
import { Session } from "@opencode/core/session"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { WebSocketConstructor } from "@opencode/core/effect/websocket-constructor"
import { App } from "@opencode/core/app"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { BridgeInputError, readChatBody, decodeChatRequest, createChatEncoder, safeNativeError } from "./tokligence-bridge-wire.mjs"
import source from "./tokligence-source.json"
import { acquireStateLock, createSessionRegistry } from "./tokligence-state-store.mjs"

function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? error.code : undefined }
type BridgeInput = {
  model: string; stream: boolean; includeUsage: boolean; system: Array<{ text: string }>
  messages: Array<ConstructorParameters<typeof Message>[0]>
  tools: Array<ToolDefinition.Input>; toolChoice?: ToolChoice.Input; options: Readonly<Record<string, unknown>>
}
const state = path.resolve(process.env.OPENCODE_NATIVE_STATE || "/state/opencode-native")
for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
  const value = process.env[name]
  if (!value || path.relative(state, path.resolve(value)).startsWith("..")) throw new Error(`${name} must point inside the isolated native worker state directory`)
}
const key = process.env.OPENCODE_NATIVE_KEY
if (!key || key.length < 32) throw new Error("OPENCODE_NATIVE_KEY must contain at least 32 characters")
const keyHash = createHash("sha256").update(key).digest()
const fixture = process.env.OPENCODE_NATIVE_FIXTURE_CONFIG
const providerID = fixture ? "fixture" : "opencode"
const allow = new Set((process.env.OPENCODE_NATIVE_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean))
if (!allow.size) throw new Error("OPENCODE_NATIVE_MODELS must explicitly allow model IDs")
await fs.mkdir(state, { recursive: true, mode: 0o700 })
const lock = await acquireStateLock(path.join(state, "worker.lock"))
const metadata = { name: "cli", version: source.version, channel: "latest" }
const workspace = path.join(state, "workspace")
await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
const config = fixture ? JSON.parse(await fs.readFile(fixture, "utf8")) : {}
if (fixture) {
  const endpoint = new URL(config.providers?.fixture?.settings?.baseURL)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Fixture providers must use a loopback endpoint")
}
const host = await Effect.runPromise(EmbeddedHost.create({
  app: metadata,
  database: { path: path.join(state, "opencode.db") },
  config: { directory: path.join(state, "config"), project: false, claude: false, content: JSON.stringify(config) },
  models: { fetch: !fixture }, fs: { filewatcher: false, fff: false },
  log: { level: "error", emit: () => {} },
}))
const seed = process.env.OPENCODE_NATIVE_SEED_FILE
if (seed) {
  if (fixture) throw new Error("Credential seeds are forbidden in fixture mode")
  if (path.relative(state, path.resolve(seed)).startsWith("..")) throw new Error("The staging credential seed must be owned by the isolated worker state directory")
  const values = await host.runtime.runPromise(Effect.gen(function* () {
    const credentials = yield* Credential.Service
    return yield* credentials.list(Integration.ID.make("opencode"))
  }))
  let pending
  try { pending = await fs.readFile(seed, "utf8") } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
  if (pending && !values.length) {
    let value
    try { value = Schema.decodeUnknownSync(Credential.OAuth)(JSON.parse(pending)) } catch { throw new Error("Invalid staging credential seed; contents withheld") }
    await host.runtime.runPromise(Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID: Integration.ID.make("opencode"), value, label: "staging-exclusive", activate: true })
    }))
  }
  if (pending) await fs.rename(seed, `${seed}.imported`)
}

if (!fixture) {
  const count = await host.runtime.runPromise(Effect.gen(function* () {
    const credentials = yield* Credential.Service
    return (yield* credentials.list(Integration.ID.make("opencode"))).length
  }))
  if (count !== 1) throw new Error("The isolated native worker must own exactly one OpenCode credential")
}

const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
const active = new Set<string>()
function positiveSetting(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`)
  return value
}
const registry = await createSessionRegistry({
  file: path.join(state, "bridge-sessions.json"),
  limit: positiveSetting("OPENCODE_NATIVE_SESSION_LIMIT", 4096, 4096),
  ttlMs: positiveSetting("OPENCODE_NATIVE_SESSION_TTL_MS", 86400000, 2592000000),
  allocateID: () => Session.ID.create(),
  create: async (model: string, id: string) => {
    const ref = Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(model) })
    return (await host.runtime.runPromise(host.sessions.create({ id: Session.ID.make(id), location, model: ref, agent: Agent.ID.make("build") }))).id
  },
  remove: async (id: string) => { await host.runtime.runPromise(host.sessions.remove(Session.ID.make(id)).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))) },
})
const nativeLayers = SessionModelRequest.layer.pipe(
  Layer.provide(SessionModelTransport.layer.pipe(Layer.provide(WebSocketConstructor.layer))),
  Layer.provide(App.layer(metadata)),
)

function authorized(request: Request) {
  const header = request.headers.get("authorization") || ""
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : ""
  return timingSafeEqual(keyHash, createHash("sha256").update(supplied).digest())
}
const headers = (extra: Record<string, string> = {}) => ({
  "x-opencode-native-version": source.version, "x-opencode-native-commit": source.commit, ...extra,
})
function errorResponse(error: unknown) {
  const result = safeNativeError(error)
  return Response.json({ error: result.error }, { status: result.status, headers: headers({
    ...("retry_after_seconds" in result.error && result.error.retry_after_seconds ? { "retry-after": String(result.error.retry_after_seconds) } : {}),
  }) })
}

let ingesting = 0
const requestTimeoutMs = positiveSetting("OPENCODE_NATIVE_REQUEST_TIMEOUT_MS", 120000, 600000)
const bodyTimeoutMs = positiveSetting("OPENCODE_NATIVE_BODY_TIMEOUT_MS", 30000, 30000)
async function inference(request: Request) {
  if (ingesting + active.size >= 4) return Response.json({ error: { type: "native_bridge_error", code: "native_worker_busy", message: "Native worker concurrency limit reached" } }, { status: 503, headers: headers({ "retry-after": "1" }) })
  ingesting++
  let raw
  try { raw = await readChatBody(request, { timeoutMs: bodyTimeoutMs }) }
  finally { ingesting-- }
  let value
  try { value = JSON.parse(raw) } catch { throw new BridgeInputError("Request body must be valid JSON") }
  const input = decodeChatRequest(value) as BridgeInput
  if (!allow.has(input.model)) throw new BridgeInputError("Model is not enabled on this native worker", "native_model_not_allowed")
  const scope = request.headers.get("x-opencode-bridge-session")
  if (!scope || !/^[A-Za-z0-9._:-]{1,128}$/.test(scope)) throw new BridgeInputError("A gateway-scoped x-opencode-bridge-session is required")
  const sessionKey = createHash("sha256").update(`${scope}\0${input.model}`).digest("hex")
  if (active.has(sessionKey)) return Response.json({ error: { type: "native_bridge_error", code: "native_session_busy", message: "This native session already has an active request" } }, { status: 409, headers: headers() })
  if (active.size >= 4) return Response.json({ error: { type: "native_bridge_error", code: "native_worker_busy", message: "Native worker concurrency limit reached" } }, { status: 503, headers: headers({ "retry-after": "1" }) })
  active.add(sessionKey)
  const cancel = new AbortController()
  const deadline = setTimeout(() => cancel.abort(new BridgeInputError("Native model request deadline exceeded", "native_request_deadline", 504)), requestTimeoutMs)
  const onAbort = () => cancel.abort(request.signal.reason)
  request.signal.addEventListener("abort", onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  let cleanupTask: Promise<void> | undefined
  const cleanup = () => cleanupTask ??= (async () => {
    clearTimeout(deadline)
    request.signal.removeEventListener("abort", onAbort)
    try { await registry.touch(sessionKey) }
    catch { console.warn(JSON.stringify({ event: "native_session_touch_failed" })) }
    finally { active.delete(sessionKey) }
  })()
  try {
    const ref = Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(input.model) })
    let entry
    try { entry = await registry.get(sessionKey, input.model, active) }
    catch (error) {
      if (errorCode(error) === "native_session_capacity") { await cleanup(); return Response.json({ error: { code: "native_session_capacity", message: "All native sessions are active; retry shortly" } }, { status: 503, headers: headers({ "retry-after": "1" }) }) }
      throw error
    }
    const session = await host.runtime.runPromise(host.sessions.get(Session.ID.make(entry.id)))
    const events = Stream.unwrap(Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Stream.unwrap(Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const resolver = yield* ModelResolver.Service
        const model = yield* resolver.resolve(ref)
        if (!model) return yield* Effect.fail(new BridgeInputError("Model is unavailable in OpenCode's catalog", "native_model_unavailable"))
        if (!fixture && model.cost.some((price) => price.input > 0 || price.output > 0)) return yield* Effect.fail(new BridgeInputError("The native worker only serves verified free models", "native_paid_model_rejected"))
        const prepare = yield* SessionModelRequest.Service
        const prepared = yield* prepare.external({
          session, agent: Agent.ID.make("build"), model,
          system: input.system.map((part) => SystemPart.make(part.text)),
          messages: input.messages.map((message) => Message.make(message)),
          tools: { definitions: input.tools.map((tool) => ToolDefinition.make(tool)), execute: () => Effect.die("External tools must never execute in the native worker") },
          toolChoice: input.toolChoice, options: input.options,
        })
        const client = yield* LLMClient.Service
        return client.stream(prepared.request, prepared.options)
      })).pipe(Stream.provide(nativeLayers), Stream.provide(AppNodeBuilder.build(llmClient)), Stream.provide(locations.get(location)))
    }))
    const encoder = createChatEncoder({ model: input.model, includeUsage: input.includeUsage, id: `chatcmpl_${randomUUID()}` })
    const chunks: Array<Record<string, unknown>> = []
    let notify = () => {}
    let drain = () => {}
    let done = false
    let failure: unknown
    const running = host.runtime.runPromiseExit(Stream.runForEach(events, (event) => Effect.gen(function* () {
      yield* Effect.sync(() => { chunks.push(...encoder.push(event)); notify() })
      if (chunks.length >= 64) yield* Effect.promise((signal) => new Promise<void>((resolve) => {
        const ready = () => { signal.removeEventListener("abort", ready); resolve() }
        drain = ready
        signal.addEventListener("abort", ready, { once: true })
        if (signal.aborted || chunks.length < 64) ready()
      }))
    })), { signal: cancel.signal }).then((exit) => {
      if (Exit.isFailure(exit)) {
        const reasons = exit.cause.reasons
        failure = cancel.signal.reason instanceof BridgeInputError ? cancel.signal.reason : reasons.map((reason) => Cause.isFailReason(reason) ? ("error" in reason.error ? reason.error.error : reason.error) : Cause.isDieReason(reason) ? reason.defect : undefined).find(Boolean) || new Error("Native request interrupted")
      }
      done = true
      notify()
    })
    const next = async () => {
      while (!chunks.length && !done) await new Promise<void>((resolve) => { notify = resolve })
      if (chunks.length) { const chunk = chunks.shift(); if (chunks.length < 32) drain(); return chunk }
      if (failure) throw failure
      encoder.end()
      return null
    }
    if (!input.stream) {
      while (await next()) { /* The encoder folds the same native stream. */ }
      await running
      await cleanup()
      return Response.json(encoder.completion(), { headers: headers({ "x-opencode-native-session": session.id }) })
    }
    // Do not commit HTTP 200 for lifecycle events or a failed model call.
    const first = await next()
    let pending = first
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          const value = pending || await next()
          pending = null
          if (!value) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
            await cleanup()
            return
          }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
        } catch (error) {
          const result = safeNativeError(error)
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: result.error })}\n\n`))
          controller.close()
          await cleanup()
        }
      },
      async cancel() { cancel.abort(); await running; await cleanup() },
    }), { headers: headers({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-opencode-native-session": session.id }) })
  } catch (error) {
    cancel.abort()
    await cleanup()
    throw error
  }
}

const server = Bun.serve({
  hostname: process.env.OPENCODE_NATIVE_BIND || "127.0.0.1",
  port: Number(process.env.OPENCODE_NATIVE_PORT || 4187),
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ status: "ok", worker: "opencode-native", version: source.version, commit: source.commit, fixture: Boolean(fixture) })
    if (!authorized(request)) return Response.json({ error: { code: "unauthorized", message: "Invalid native worker authorization" } }, { status: 401 })
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") return Response.json({ error: { code: "not_found", message: "Unknown native worker endpoint" } }, { status: 404 })
    try { return await inference(request) } catch (error) { return errorResponse(error) }
  },
})
console.info(JSON.stringify({ event: "native_worker_ready", port: server.port, version: source.version, commit: source.commit, fixture: Boolean(fixture) }))
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  server.stop(true)
  await host.close()
  await lock.close()
  process.exit(0)
})
