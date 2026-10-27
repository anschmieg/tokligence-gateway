import { Effect, Scope } from "effect"
import { HttpClient } from "effect/http"
import type { LLMClientShape } from "@opencode/ai"

type Middleware = NonNullable<NonNullable<Parameters<LLMClientShape["stream"]>[1]>["http"]>

// Bind the final native HTTP request to the entire model-stream scope. Without
// this, an interrupted response obtained before its body reader starts can
// remain open until GC. Preserve all native request/response hooks and transport.
export function scopedHttp(scope: Scope.Scope, middleware?: Middleware): Middleware {
  return (request, next) => {
    const client = HttpClient.withScope(HttpClient.makeWith<never, never, Error, never>(
      effect => Effect.flatMap(effect, next),
      Effect.succeed,
    ))
    const scopedNext: typeof next = sent => client.execute(sent).pipe(Effect.provideService(Scope.Scope, scope))
    return middleware ? middleware(request, scopedNext) : scopedNext(request)
  }
}
