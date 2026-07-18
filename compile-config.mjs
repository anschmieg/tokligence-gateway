#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  compileOAuthProxyYaml,
  compileTokligenceIni,
  loadRoutingConfig,
  providerEnabled,
} from "./route-config.mjs";

const policyPath = path.resolve(process.env.ROUTING_CONFIG_PATH || "gateway.routes.yaml");
const outputRoot = path.resolve(process.env.CONFIG_OUTPUT_ROOT || "/");
const config = loadRoutingConfig(policyPath);

for (const [name, envName] of Object.entries(config.access)) {
  if (!process.env[envName]) throw new Error(`${name} requires environment variable ${envName}`);
}
for (const provider of config.providers) {
  if (!provider.enabled_env || String(process.env[provider.enabled_env]).toLowerCase() === "true") {
    if (provider.adapter === "openai-compatible" && !process.env[provider.api_key_env]) {
      throw new Error(`enabled provider ${provider.id} requires environment variable ${provider.api_key_env}`);
    }
    if (provider.adapter === "oauth-proxy" && !process.env[provider.internal_api_key_env]) {
      throw new Error(`enabled provider ${provider.id} requires environment variable ${provider.internal_api_key_env}`);
    }
  }
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
