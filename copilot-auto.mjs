import path from "node:path";
import { CopilotClient } from "@github/copilot-sdk";

export const COPILOT_AUTO_MODEL = "copilot-auto";

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content?.text || "";
  return content
    .filter((part) => part?.type === "text" || typeof part?.text === "string")
    .map((part) => part.text || "")
    .join("");
}

// The Copilot SDK accepts one prompt per turn. Preserve role boundaries inside
// that prompt instead of silently dropping system or assistant context.
export function messagesToPrompt(messages) {
  return (messages || [])
    .map((message) => `[${message.role || "user"}]\n${contentToText(message.content)}`)
    .join("\n\n");
}

export function createCopilotAutoAdapter({
  clientFactory = (options) => new CopilotClient(options),
  baseDirectory = process.env.COPILOT_AUTO_HOME || process.env.COPILOT_HOME || path.resolve(".copilot-auto"),
  workingDirectory = process.env.COPILOT_AUTO_WORKDIR || process.cwd(),
  logger = console,
} = {}) {
  let clientPromise;

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

  async function complete({ messages, onDelta }) {
    const sdk = await client();
    const session = await sdk.createSession({
      model: "auto",
      // Required in SDK empty mode. An empty allowlist means the Copilot runtime
      // cannot execute host tools on behalf of an OpenAI-compatible request.
      availableTools: [],
      enableConfigDiscovery: false,
      enableSessionStore: false,
    });
    let route;
    let receivedDelta = false;

    const unsubscribeRoute = session.on("session.auto_mode_resolved", (event) => {
      const data = event.data || {};
      route = {
        chosenModel: data.chosenModel,
        availableModels: Array.isArray(data.availableModels) ? data.availableModels : [],
        candidateModels: Array.isArray(data.candidateModels) ? data.candidateModels : [],
        predictedLabel: data.predictedLabel,
        reasoningBucket: data.reasoningBucket,
      };
      // Never log tokens, session IDs, Authorization, or prompt contents.
      logger.info?.(`copilot.auto resolved model=${route.chosenModel || "unknown"}`);
    });
    const unsubscribeDelta = session.on("assistant.message_delta", (event) => {
      const delta = event.data?.deltaContent || "";
      if (!delta) return;
      receivedDelta = true;
      onDelta?.(delta);
    });

    try {
      const result = await session.sendAndWait({ prompt: messagesToPrompt(messages) }, 120000);
      const text = result?.data?.content || "";
      if (!receivedDelta && text) onDelta?.(text);
      return { text, route };
    } finally {
      unsubscribeRoute();
      unsubscribeDelta();
      await session.disconnect();
    }
  }

  async function close() {
    if (!clientPromise) return;
    const sdk = await clientPromise;
    clientPromise = undefined;
    await sdk.stop();
  }

  return { complete, close };
}
