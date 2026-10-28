#!/usr/bin/env node
// Materialize the exact upstream source and the small, reviewed bridge overlay.
// Credentials and production data are never inputs to this build operation.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createSourceOverlay } from "../native/opencode/source-overlay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(await fs.readFile(path.join(root, "native/opencode/source.json"), "utf8"));
const destination = path.resolve(process.argv[2] || path.join(root, ".cache/opencode-native"));
const archivePath = `${destination}.tar.gz`;
await fs.mkdir(path.dirname(destination), { recursive: true });
let archive;
try { archive = await fs.readFile(archivePath); } catch { /* Fetch the pinned archive below. */ }
if (!archive || createHash("sha256").update(archive).digest("hex") !== pin.sha256) {
  const response = await fetch(pin.archive, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`OpenCode source download failed: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== pin.sha256) throw new Error("OpenCode source checksum mismatch");
  await fs.writeFile(archivePath, archive);
}
try {
  const prepared = JSON.parse(await fs.readFile(path.join(destination, ".tokligence-source.json"), "utf8"));
  if (prepared.commit !== pin.commit || prepared.sha256 !== pin.sha256) throw new Error("Destination contains a different source pin");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await fs.mkdir(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", destination]);
  await fs.writeFile(path.join(destination, ".tokligence-source.json"), `${JSON.stringify(pin, null, 2)}\n`);
}

const requestPath = path.join(destination, "packages/core/src/session/model-request.ts");
let requestSource = await fs.readFile(requestPath, "utf8");
if (!requestSource.includes("readonly external:")) {
  const signature = '  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>';
  const implementation = '      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),';
  if (requestSource.split(signature).length !== 2 || requestSource.split(implementation).length !== 2) throw new Error("Pinned OpenCode request seam changed");
  requestSource = requestSource.replace(signature,
    '  /** External caller owns prompts, history, tool execution, and the agent loop. */\n  readonly external: (input: Input & { readonly options?: Readonly<Record<string, unknown>> }) => Effect.Effect<Prepared<SessionContext>>\n' + signature);
  requestSource = requestSource.replace(implementation,
    '      external: (input) => prepare("primary", input, (draft, tools) => Effect.succeed({ ...draft, agent: input.agent, tools, options: { ...draft.options, ...input.options } })),\n' + implementation);
  await fs.writeFile(requestPath, requestSource);
}

// Bridge-only legacy Chat message structure. The opt-in compatibility flag
// preserves caller roles/parts rather than changing the compiler's defaults.
const optionsPath = path.join(destination, "packages/ai/src/schema/options.ts");
let optionsSource = await fs.readFile(optionsPath, "utf8");
if (!optionsSource.includes("legacyMessageStructure:")) {
  const anchor = '  sanitizer: Schema.optional(LanguageModelSanitizerCompatibility),';
  if (optionsSource.split(anchor).length !== 2) throw new Error("Pinned model compatibility schema changed");
  optionsSource = optionsSource.replace(anchor, '  /** External bridge: preserve the 1.18 OpenAI-compatible message structure. */\n  legacyMessageStructure: Schema.optional(Schema.Boolean),\n' + anchor);
  await fs.writeFile(optionsPath, optionsSource);
}
const chatPath = path.join(destination, "packages/ai/src/protocols/openai-chat.ts");
let chatSource = await fs.readFile(chatPath, "utf8");
const chatReplacements = [
    ['    name: Schema.String,\n    description: Schema.String,\n    parameters: JsonObject,', '    name: Schema.String,\n    description: Schema.optional(Schema.String),\n    parameters: JsonObject,'],
    ['interface LoweringOptions {', 'interface LoweringOptions {\n  readonly legacyMessageStructure?: boolean'],
    ['    description: tool.description,', '    description: options.legacyMessageStructure && tool.metadata?.tokligenceOmitDescription === true ? undefined : tool.description,'],
    ['  if (content.every((part) => part.type === "text" && part.cache_control === undefined))', '  if ((!options.legacyMessageStructure || content.length === 1) && content.every((part) => part.type === "text" && part.cache_control === undefined))'],
    ['      if (content.length === 0 && toolCalls.length > 0) return null', '      if (!options.legacyMessageStructure && content.length === 0 && toolCalls.length > 0) return null'],
    ['  const lowering = {\n    ...options,\n    providerMetadataKey: request.model.route.providerMetadataKey ?? request.model.provider,', '  const lowering = {\n    ...options,\n    legacyMessageStructure: request.model.compatibility?.legacyMessageStructure,\n    providerMetadataKey: request.model.route.providerMetadataKey ?? request.model.provider,'],
    ['    if (message.role === "system") {\n      const part = yield* ProviderShared.wrappedSystemUpdate', '    if (message.role === "system" && request.model.compatibility?.legacyMessageStructure) {\n      const parts = yield* ProviderShared.systemUpdateText("OpenAI Chat", message)\n      messages.push({ role: "system", content: parts.map((part) => part.text).join("") })\n      continue\n    }\n    if (message.role === "system") {\n      const part = yield* ProviderShared.wrappedSystemUpdate'],
    ['      message.role === "assistant" &&\n      message.content.every', '      !request.model.compatibility?.legacyMessageStructure &&\n      message.role === "assistant" &&\n      message.content.every'],
    ['  const lowering = { ...options, cacheControl: options.cacheControl ?? declaredCacheControl(request) }', '  const lowering = { ...options, legacyMessageStructure: request.model.compatibility?.legacyMessageStructure, cacheControl: options.cacheControl ?? declaredCacheControl(request) }'],
    ['        ? hasHistory\n          ? []', '        ? hasHistory && !request.model.compatibility?.legacyMessageStructure\n          ? []'],
];
for (const [before, after] of chatReplacements) {
  if (chatSource.split(after).length === 2) continue;
  if (chatSource.split(before).length !== 2) throw new Error("Pinned Chat structure seam changed: " + before.slice(0, 50));
  chatSource = chatSource.replace(before, after);
}
for (const [, expected] of chatReplacements) if (chatSource.split(expected).length !== 2) throw new Error("Incomplete pinned Chat compatibility overlay");
await fs.writeFile(chatPath, chatSource);
for (const [source, target] of [["worker.ts", "tokligence-bridge.ts"], ["bridge-wire.mjs", "tokligence-bridge-wire.mjs"], ["state-store.mjs", "tokligence-state-store.mjs"], ["scoped-http.ts", "tokligence-scoped-http.ts"], ["source-overlay.mjs", "tokligence-source-overlay.mjs"]]) {
  await fs.copyFile(path.join(root, "native/opencode", source), path.join(destination, "packages/sdk/src", target));
}
await fs.copyFile(path.join(root, "native/opencode/source.json"), path.join(destination, "packages/sdk/src/tokligence-source.json"));
await fs.writeFile(path.join(destination, "packages/sdk/src/tokligence-overlay.json"), JSON.stringify(await createSourceOverlay(destination)) + "\n");
console.log(JSON.stringify({ source: destination, version: pin.version, commit: pin.commit, bun: pin.bun }));
