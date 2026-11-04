#!/usr/bin/env node
// Materialize the exact upstream source and the small, reviewed bridge overlay.
// Credentials and production data are never inputs to this build operation.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

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
for (const [source, target] of [["worker.ts", "tokligence-bridge.ts"], ["bridge-wire.mjs", "tokligence-bridge-wire.mjs"]]) {
  await fs.copyFile(path.join(root, "native/opencode", source), path.join(destination, "packages/sdk/src", target));
}
await fs.copyFile(path.join(root, "native/opencode/source.json"), path.join(destination, "packages/sdk/src/tokligence-source.json"));
console.log(JSON.stringify({ source: destination, version: pin.version, commit: pin.commit, bun: pin.bun }));
