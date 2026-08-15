import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import Ajv from "ajv";

export const COPILOT_AUTO_MODEL = "copilot-auto";

const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_IMAGE_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content?.text || "";
  return content
    .filter((part) => part?.type === "text" || typeof part?.text === "string")
    .map((part) => part.text || "")
    .join("");
}

// Convert OpenAI-compatible image data URLs into the Copilot SDK's supported
// in-memory blob attachments. Remote URLs are intentionally rejected: fetching
// client-controlled URLs from the gateway would create an SSRF boundary.
export function extractVisionAttachments(messages) {
  const attachments = [];
  const normalizedMessages = (messages || []).map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = [];
    for (const part of message.content) {
      if (part?.type !== "image_url") {
        content.push(part);
        continue;
      }
      const url = part?.image_url?.url;
      const match = typeof url === "string" ? url.match(DATA_IMAGE_URL) : null;
      if (!match) throw new Error("copilot-auto vision only accepts data URLs for image_url inputs");
      const mimeType = match[1].toLowerCase();
      const data = match[2];
      const bytes = Buffer.byteLength(data, "base64");
      if (bytes === 0 || bytes > MAX_VISION_IMAGE_BYTES) {
        throw new Error(`copilot-auto image must be between 1 byte and ${MAX_VISION_IMAGE_BYTES} bytes`);
      }
      if (attachments.length >= MAX_VISION_IMAGES) {
        throw new Error(`copilot-auto accepts at most ${MAX_VISION_IMAGES} images per request`);
      }
      const extension = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1];
      attachments.push({ type: "blob", data, mimeType, displayName: `image-${attachments.length + 1}.${extension}` });
    }
    return { ...message, content };
  });
  return { messages: normalizedMessages, attachments };
}

// The Copilot SDK accepts one prompt per turn. Preserve role boundaries inside
// that prompt instead of silently dropping system or assistant context.
export function messagesToPrompt(messages) {
  return (messages || [])
    .map((message) => `[${message.role || "user"}]\n${contentToText(message.content)}`)
    .join("\n\n");
}

export function structuredOutputInstruction(responseFormat) {
  if (!responseFormat || responseFormat.type === "text") return "";
  if (responseFormat.type === "json_object") return "Return only one valid JSON object. Do not use Markdown fences or explanatory text.";
  if (responseFormat.type === "json_schema") {
    const schema = responseFormat.json_schema?.schema;
    if (!schema || typeof schema !== "object") throw new Error("response_format.json_schema.schema is required");
    return `Return only JSON that validates against this JSON Schema: ${JSON.stringify(schema)}`;
  }
  throw new Error(`Unsupported response_format.type: ${responseFormat.type}`);
}

export function validateStructuredOutput(text, responseFormat) {
  if (!responseFormat || responseFormat.type === "text") return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Copilot Auto did not return valid JSON");
  }
  if (responseFormat.type === "json_object" && (value === null || Array.isArray(value) || typeof value !== "object")) {
    throw new Error("Copilot Auto did not return a JSON object");
  }
  if (responseFormat.type === "json_schema") {
    const schema = responseFormat.json_schema?.schema;
    if (!schema || typeof schema !== "object") throw new Error("response_format.json_schema.schema is required");
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new Error(`Copilot Auto output failed JSON Schema validation: ${ajv.errorsText(validate.errors)}`);
    }
  }
  return value;
}

export function createRoutingAuditLogger(logPath) {
  let initialized = false;
  return async (event) => {
    if (!initialized) {
      await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
      initialized = true;
    }
    // The event deliberately contains no prompts, image data, OAuth data,
    // upstream session IDs, tool arguments, or authorization material.
    await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  };
}

export function routingAuditEvent({ route, messageCount, imageCount, toolCount, responseFormat }) {
  return {
    timestamp: new Date().toISOString(),
    requested_model: COPILOT_AUTO_MODEL,
    selected_model: route?.chosenModel || null,
    available_models: route?.availableModels || [],
    candidate_models: route?.candidateModels || [],
    predicted_label: route?.predictedLabel || null,
    reasoning_bucket: route?.reasoningBucket || null,
    message_count: messageCount,
    image_count: imageCount,
    tool_count: toolCount,
    response_format: responseFormat?.type || null,
  };
}

export function openAiToolsToExternalTools(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new Error("tools must be an array");
  return tools.map((tool) => {
    const definition = tool?.type === "function" ? tool.function : null;
    if (!definition || typeof definition.name !== "string" || !definition.name) {
      throw new Error("Each tool must be an OpenAI function with a name");
    }
    if (definition.parameters != null && (typeof definition.parameters !== "object" || Array.isArray(definition.parameters))) {
      throw new Error(`Tool ${definition.name} parameters must be a JSON Schema object`);
    }
    // Handler omitted: the public SDK emits external_tool.requested and never
    // executes OpenAI client functions in this gateway process.
    return defineTool(definition.name, {
      description: definition.description,
      parameters: definition.parameters,
      defer: "never",
    });
  });
}

export function createCopilotAutoAdapter({
  clientFactory = (options) => new CopilotClient(options),
  baseDirectory = process.env.COPILOT_AUTO_HOME || process.env.COPILOT_HOME || path.resolve(".copilot-auto"),
  workingDirectory = process.env.COPILOT_AUTO_WORKDIR || process.cwd(),
  routingAudit = createRoutingAuditLogger(process.env.COPILOT_AUTO_ROUTING_LOG || path.join(baseDirectory, "routing.jsonl")),
  logger = console,
  sessionTtlMs = 5 * 60 * 1000,
} = {}) {
  let clientPromise;
  const pendingToolCalls = new Map();

  async function client() {
    if (!clientPromise) {
      clientPromise = (async () => {
        // `empty` is mandatory for a server: no ambient host tools, MCP servers,
        // or workspace discovery. The gateway presently exposes chat text only.
        const instance = clientFactory({
          mode: "empty",
          baseDirectory,
          workingDirectory,
          logLevel: "error",
          useLoggedInUser: true,
        });
        await instance.start();
        return instance;
      })().catch((error) => {
        clientPromise = undefined;
        throw error;
      });
    }
    return clientPromise;
  }

  function touch(state) {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => state.cleanup(), sessionTtlMs);
    state.expiry.unref?.();
  }

  async function complete({ messages = [], onDelta, tools, toolCount = 0, responseFormat = null, callerKey }) {
    const toolResults = messages.filter((message) => message?.role === "tool" && message.tool_call_id);
    if (toolResults.length) {
      const call = toolResults[toolResults.length - 1];
      const pending = pendingToolCalls.get(call.tool_call_id);
      if (!pending) throw new Error("Unknown or expired tool_call_id");
      if (pending.callerKey !== callerKey) throw new Error("tool_call_id belongs to another caller");
      touch(pending);
      // Register the waiter before the RPC: resolving a pending tool can cause
      // the runtime to synchronously enqueue the next external-tool event.
      const nextOutcome = pending.waitForOutcome();
      const accepted = await pending.session.rpc.tools.handlePendingToolCall({
        requestId: pending.requestId,
        result: contentToText(call.content),
      });
      if (!accepted?.success) throw new Error("Tool result was not accepted");
      pendingToolCalls.delete(call.tool_call_id);
      pending.pending.delete(call.tool_call_id);
      return nextOutcome;
    }
    const { messages: normalizedMessages, attachments } = extractVisionAttachments(messages);
    const structureInstruction = structuredOutputInstruction(responseFormat);
    if (structureInstruction) normalizedMessages.unshift({ role: "system", content: structureInstruction });
    const sdk = await client();
    if (attachments.length) {
      const models = await sdk.listModels();
      const auto = (models || []).find((model) => model?.id === "auto");
      if (auto?.capabilities?.supports?.vision !== true) {
        const error = new Error("Copilot Auto account has no vision capability");
        error.code = "vision_unsupported";
        throw error;
      }
    }
    const externalTools = openAiToolsToExternalTools(tools);
    const session = await sdk.createSession({
      model: "auto",
      // Only declared handlerless custom tools are exposed; no host/MCP tool can run.
      availableTools: externalTools.length ? externalTools.map((tool) => `custom:${tool.name}`) : [],
      tools: externalTools,
      enableConfigDiscovery: false,
      enableSessionStore: false,
    });
    const state = { session, callerKey, route: undefined, receivedDelta: false, pending: new Map() };
    const settle = (outcome) => {
      const resolve = state.waiting;
      state.waiting = undefined;
      resolve?.(outcome);
    };
    state.cleanup = async () => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.expiry);
      for (const callId of state.pending.keys()) pendingToolCalls.delete(callId);
      state.unsubscribeRoute?.();
      state.unsubscribeDelta?.();
      state.unsubscribeTool?.();
      await session.disconnect();
    };
    state.waitForOutcome = async () => {
      const outcome = await new Promise((resolve) => { state.waiting = resolve; });
      if (outcome.kind === "tool") {
        const calls = [...state.pending.values()].map(({ toolCallId, toolName, arguments: args }) => ({
          id: toolCallId,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(args || {}) },
        }));
        return { text: "", toolCalls: calls, route: state.route };
      }
      if (outcome.kind === "error") {
        await state.cleanup();
        throw outcome.error;
      }
      const text = outcome.result?.data?.content || "";
      const structured = responseFormat ? validateStructuredOutput(text, responseFormat) : text;
      const outputText = responseFormat ? JSON.stringify(structured) : text;
      if ((!state.receivedDelta || responseFormat) && outputText) onDelta?.(outputText);
      await routingAudit(routingAuditEvent({ route: state.route, messageCount: normalizedMessages.length, imageCount: attachments.length, toolCount, responseFormat }))
        .catch((error) => logger.warn?.(`copilot.auto audit failed: ${error?.name || "Error"}`));
      await state.cleanup();
      return { text: outputText, route: state.route };
    };

    state.unsubscribeRoute = session.on("session.auto_mode_resolved", (event) => {
      const data = event.data || {};
      state.route = {
        chosenModel: data.chosenModel,
        availableModels: Array.isArray(data.availableModels) ? data.availableModels : [],
        candidateModels: Array.isArray(data.candidateModels) ? data.candidateModels : [],
        predictedLabel: data.predictedLabel,
        reasoningBucket: data.reasoningBucket,
      };
      // Never log tokens, session IDs, Authorization, or prompt contents.
      logger.info?.(`copilot.auto resolved model=${state.route.chosenModel || "unknown"}`);
    });
    state.unsubscribeDelta = session.on("assistant.message_delta", (event) => {
      const delta = event.data?.deltaContent || "";
      if (!delta) return;
      if (responseFormat) return;
      state.receivedDelta = true;
      onDelta?.(delta);
    });
    state.unsubscribeTool = session.on("external_tool.requested", (event) => {
      const data = event.data || {};
      if (!data.requestId || !data.toolCallId || !data.toolName) return;
      const pending = { ...state, requestId: data.requestId, toolCallId: data.toolCallId, toolName: data.toolName, arguments: data.arguments };
      state.pending.set(data.toolCallId, pending);
      pendingToolCalls.set(data.toolCallId, pending);
      touch(state);
      settle({ kind: "tool" });
    });
    touch(state);
    session.sendAndWait({
        prompt: messagesToPrompt(normalizedMessages),
        attachments,
      }, 120000).then((result) => settle({ kind: "complete", result }), (error) => settle({ kind: "error", error }));
    return state.waitForOutcome();
  }

  async function close() {
    await Promise.all([...new Set(pendingToolCalls.values())].map((state) => state.cleanup()));
    if (!clientPromise) return;
    const sdk = await clientPromise;
    clientPromise = undefined;
    await sdk.stop();
  }

  return { complete, close };
}
