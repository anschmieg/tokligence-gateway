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
