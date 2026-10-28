// Copied into the pinned core test package by verify-opencode-api.mjs.
// Uses upstream fixture services and the SAME 2.1 preparation code as CLI/TUI.
import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { App } from "@opencode/core/app"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const session = Session.Info.make({
  id: Session.ID.make("ses_same_version_api"), projectID: Project.ID.global,
  cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic-project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "synthetic-free", provider: "opencode" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [],
  limit: { context: 200000, output: 32000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
  close: () => Effect.void, closeAll: Effect.void,
})
const input = { session, agent: Agent.ID.make("build"), model,
  system: [Message.text("Caller-owned synthetic system")], messages: [Message.user("Caller-owned input")],
}

describe("same-version native API boundary", () => {
  it.effect("shares prepared model/session headers and model/HTTP hooks with official primary requests", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const events: string[] = []
      yield* hooks.register("session", "model.request", event => Effect.sync(() => {
        events.push("model:" + event.kind)
        event.headers["x-synthetic-hook"] = "unchanged"
      }))
      yield* hooks.register("session", "http.request", event => Effect.sync(() => {
        events.push("request:" + event.kind)
        event.request.headers.set("x-synthetic-request", "unchanged")
      }))
      yield* hooks.register("session", "http.response", event => Effect.sync(() => {
        events.push("response:" + event.kind)
        event.response.headers.set("x-synthetic-response", "unchanged")
      }))
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const primary = yield* requests.primary(input)
      const external = yield* requests.external({ ...input, options: {} })
      expect(external.request).toEqual(primary.request)
      expect(JSON.stringify(external.request.http)).toContain("opencode/latest/2.1.4/cli")
      for (const prepared of [primary, external]) {
        expect(prepared.options.http).toBeDefined()
        const result = yield* prepared.options.http!(HttpClientRequest.post("https://synthetic.invalid/v1/chat/completions"), req => {
          expect(req.headers["x-synthetic-request"]).toBe("unchanged")
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 })))
        })
        expect(result.headers["x-synthetic-response"]).toBe("unchanged")
      }
      expect(events).toEqual(["model:primary", "model:primary", "request:primary", "response:primary", "request:primary", "response:primary"])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport), Effect.provideService(App.Metadata, { name: "cli", version: "2.1.4", channel: "latest" })),
  )
  it.effect("skips only caller-owned context shaping while retaining the common model request hook", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", event => Effect.sync(() => {
        event.system = [Message.text("Official context hook output")]
      }))
      yield* hooks.register("session", "model.request", event => Effect.sync(() => {
        event.headers["x-synthetic-shared"] = "yes"
      }))
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const primary = yield* requests.primary(input)
      const external = yield* requests.external({ ...input, options: {} })
      expect(primary.request.system).not.toEqual(external.request.system)
      expect(external.request.http).toEqual(primary.request.http)
      expect(external.request.messages).toEqual(primary.request.messages)
      expect(external.request.generation).toEqual(primary.request.generation)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport), Effect.provideService(App.Metadata, { name: "cli", version: "2.1.4", channel: "latest" })),
  )
})
