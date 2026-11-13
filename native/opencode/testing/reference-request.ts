// Independent pinned 2.x compiler. Runs only in the parity network namespace.
import { Effect } from '/reference/packages/ai/node_modules/effect/dist/index.js'
import * as LLM from '/reference/packages/ai/src/llm.ts'
import { Message, LanguageModel, ToolDefinition } from '/reference/packages/ai/src/schema/index.ts'
import { OpenAIChat } from '/reference/packages/ai/src/protocols/openai-chat.ts'
import { compileRequest } from '/reference/packages/ai/src/route/client.ts'
const input = JSON.parse(await Bun.stdin.text())
const model = LanguageModel.update(OpenAIChat.route.with({ provider: 'opencode', endpoint: { baseURL: 'https://opencode.ai/inference/openai/v1' } }).model({ id: input.model }), {
  compatibility: { maxTokensField: 'max_tokens', reasoningField: 'reasoning_content', supportsStore: false },
})
const system = [], messages = [], names = new Map()
let started = false
for (const message of input.messages) {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...(message.content || [])]
  if (message.role === 'system' && !started) { system.push(...content); continue }
  started = true
  if (message.role === 'tool') {
    messages.push(Message.make({ role: 'tool', content: [{ type: 'tool-result', id: message.tool_call_id, name: names.get(message.tool_call_id), result: { type: message.is_error ? 'error' : 'text', value: content.map(p => p.text).join('') } }] }))
    continue
  }
  if (message.reasoning_content !== undefined) content.unshift({ type: 'reasoning', text: message.reasoning_content })
  for (const call of message.tool_calls || []) {
    names.set(call.id, call.function.name)
    content.push({ type: 'tool-call', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })
  }
  messages.push(Message.make({ role: message.role, content }))
}
const tools = (input.tools || []).map(t => ToolDefinition.make({ name: t.function.name, description: t.function.description || '', inputSchema: t.function.parameters }))
const choice = input.tool_choice?.type === 'function' ? { type: 'tool', name: input.tool_choice.function.name } : input.tool_choice ? { type: input.tool_choice } : tools.length ? { type: 'auto' } : undefined
const request = LLM.request({ model, system: system.map(p => Message.text(p.text)), messages, tools, toolChoice: choice,
  generation: { maxTokens: input.max_tokens, temperature: input.temperature, topP: input.top_p, stop: input.stop },
  providerOptions: input.reasoning_effort ? { reasoningEffort: input.reasoning_effort } : undefined,
})
console.log(JSON.stringify((await Effect.runPromise(compileRequest(request))).body))
