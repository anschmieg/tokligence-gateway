#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  compileOAuthProxyYaml,
  compileTokligenceIni,
  loadRoutingConfig,
} from "./route-config.mjs";

const policyPath = path.resolve(process.env.ROUTING_CONFIG_PATH || "gateway.routes.yaml");
const outputRoot = path.resolve(process.env.CONFIG_OUTPUT_ROOT || "/");
const config = loadRoutingConfig(policyPath);

for (const [name, envName] of Object.entries(config.access)) {
  if (!process.env[envName]) throw new Error(`${name} requires environment variable ${envName}`);
}

function outputPath(absolutePath) {
  return path.join(outputRoot, absolutePath.replace(/^\/+/, ""));
}

function write(absolutePath, content) {
  const destination = outputPath(absolutePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { mode: 0o600 });
}

write("/app/config/settings.ini", "environment=dev\n");
write("/app/config/dev/gateway.ini", compileTokligenceIni(config));

const oauthProxyConfig = compileOAuthProxyYaml(config);
if (oauthProxyConfig) write("/data/cliproxy/config.yaml", oauthProxyConfig);
