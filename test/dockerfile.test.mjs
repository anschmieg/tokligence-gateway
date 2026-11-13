import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Docker image includes every local module imported by the proxy", async () => {
  const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
  const proxy = await readFile(path.join(projectRoot, "tgw-proxy.mjs"), "utf8");
  const imported = [...proxy.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g)].map(([, file]) => file);

  for (const file of imported) {
    assert.match(dockerfile, new RegExp(`COPY[^\\n]*\\b${file.replace(".", "\\.")}\\b`), `${file} must be copied into the image`);
  }
});

test("Docker image includes transitive local runtime dependencies", async () => {
  const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
  const copied = new Set([...dockerfile.matchAll(/^COPY (?!.*--from=)([^\n]+) \.\/$/gm)].flatMap((match) => match[1].split(/\s+/)));
  const pending = ["tgw-proxy.mjs", "compile-config.mjs"];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assert(copied.has(file), `${file} must be copied into the image`);
    const source = await readFile(path.join(projectRoot, file), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\/[^"']+\.mjs)["']/g)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
});
