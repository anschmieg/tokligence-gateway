import { Effect, Scope } from "effect"
import { HttpClient, FetchHttpClient } from "effect/http"
import type { LLMClientShape } from "@opencode/ai"

type Middleware = NonNullable<NonNullable<Parameters<LLMClientShape["stream"]>[1]>["http"]>

// Bind the final native HTTP request to the entire model-stream scope. Without
// this, an interrupted response obtained before its body reader starts can
// remain open until GC. Preserve all native request/response hooks and transport.
export function scopedHttp(scope: Scope.Scope, middleware?: Middleware, validate?: (headers: Headers) => void): Middleware {
  // Keep Bun's native fetch/TLS and every original request field. Constrain
  // only redirect policy and the number of physical sends for this model call.
  // FetchHttpClient reads this supported service at execution time, beneath
  // request/response hooks and the platform RequestInit timeout override.
  let dispatched = false
  const fetchOnce = new Proxy(globalThis.fetch, {
    apply(target, receiver, args) {
      if (dispatched) throw new Error("Native model call attempted more than one HTTP dispatch")
      dispatched = true
      validate?.(new Headers(args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined)))
      return Reflect.apply(target, receiver, [args[0], { ...args[1], redirect: "manual" }])
    },
  })
  return (request, next) => {
    const client = HttpClient.withScope(HttpClient.makeWith<never, never, Error, never>(
      effect => Effect.flatMap(effect, next),
      Effect.succeed,
    ))
    const scopedNext: typeof next = sent => client.execute(sent).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(FetchHttpClient.Fetch, fetchOnce))
    return middleware ? middleware(request, scopedNext) : scopedNext(request)
  }
}
