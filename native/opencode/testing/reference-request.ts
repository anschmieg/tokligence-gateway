// Runs only inside the parity test's network namespace with synthetic input.
import { createOpenAICompatible } from "/reference/packages/opencode/node_modules/@ai-sdk/openai-compatible/dist/index.mjs"
import { streamText, jsonSchema, tool } from "/reference/packages/opencode/node_modules/ai/dist/index.mjs"
import { ProviderTransform } from "/reference/packages/opencode/src/provider/transform.ts"
const input = JSON.parse(await Bun.stdin.text())
const capture: unknown[] = []
const model = createOpenAICompatible({ name: "opencode", apiKey: "public", includeUsage: true, baseURL: "http://127.0.0.1/v1", fetch: async (_url, init) => {
  capture.push(JSON.parse(String(init?.body)))
  return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
} }).chatModel(input.model)
const info: any = { id: input.model, providerID: "opencode", api: { id: input.model, npm: "@ai-sdk/openai-compatible" },
  capabilities: { input: { text: true }, output: { text: true }, interleaved: { field: "reasoning_content" } } }
const messages = input.messages.map((m: any) => {
  if (m.role === "system") return m
  if (m.role === "tool") return { role: "tool", content: [{ type: "tool-result", toolCallId: m.tool_call_id, toolName: "Read", output: { type: m.is_error ? "error-text" : "text", value: m.content } }] }
  const content: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || []
  if (m.reasoning_content !== undefined) content.unshift({ type: "reasoning", text: m.reasoning_content })
  for (const c of m.tool_calls || []) content.push({ type: "tool-call", toolCallId: c.id, toolName: c.function.name, input: JSON.parse(c.function.arguments) })
  return { role: m.role, content }
})
const result = streamText({ model, messages: ProviderTransform.message(messages, info, {}),
  maxOutputTokens: input.max_tokens, temperature: input.temperature, topP: input.top_p, stopSequences: input.stop,
  providerOptions: input.reasoning_effort ? { openaiCompatible: { reasoningEffort: input.reasoning_effort } } : undefined,
  tools: input.tools ? Object.fromEntries(input.tools.map((t: any) => [t.function.name, tool({ description: t.function.description, inputSchema: jsonSchema(t.function.parameters) })])) : undefined,
  toolChoice: input.tool_choice?.type === "function" ? { type: "tool", toolName: input.tool_choice.function.name } : input.tool_choice,
  maxRetries: 0,
})
await result.consumeStream({ onError: error => { throw error } })
if (capture.length !== 1) throw new Error("Reference must generate exactly one synthetic request")
console.log(JSON.stringify(capture[0]))
