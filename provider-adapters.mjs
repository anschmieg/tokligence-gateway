import http from "node:http";
import https from "node:https";
const FORWARD_HEADERS = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent", "x-request-id"];

function baseUrl(provider, env) {
  if (provider.adapter === "tokligence") return new URL(`http://${env.TGW_HOST || "127.0.0.1"}:${env.TGW_PORT || 8081}`);
  const value = (provider.base_url_env && env[provider.base_url_env]) || provider.base_url || provider.default_base_url;
  return value ? new URL(value) : null;
}

function endpointSuffix(pathname) {
  if (pathname.includes("/chat/completions")) return "chat/completions";
  if (pathname.includes("/responses")) return "responses";
  if (pathname.includes("/messages")) return "messages";
  return null;
}

function requestUrl(candidate, path, env) {
  const incoming = new URL(path, "http://gateway.local");
  if (candidate.provider.adapter === "oauth-proxy") {
    const target = new URL(env[candidate.provider.external_base_url_env] || "http://127.0.0.1:8317");
    target.pathname = `${target.pathname.replace(/\/$/, "")}${incoming.pathname.replace(/^\/anthropic/, "")}`;
    target.search = incoming.search;
    return target;
  }
  const base = baseUrl(candidate.provider, env);
  if (!base) throw new Error("Provider is not configured");
  const target = new URL(base.toString());
  const suffix = endpointSuffix(incoming.pathname);
  target.pathname = suffix
    ? `${target.pathname.replace(/\/$/, "")}/${suffix}`
    : `${target.pathname.replace(/\/$/, "")}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
}

export function startAttempt({ candidate, req, path, body, env = process.env, signal }) {
  const target = requestUrl(candidate, path, env);
  const client = target.protocol === "https:" ? https : http;
  const headers = { "content-type": "application/json", "content-length": String(body.length), ...candidate.provider.headers };
  for (const name of FORWARD_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  if (candidate.provider.adapter === "oauth-proxy") {
    headers.authorization = `Bearer ${env[candidate.provider.internal_api_key_env]}`;
  } else if (candidate.provider.api_key_env && env[candidate.provider.api_key_env]) {
    headers.authorization = `Bearer ${env[candidate.provider.api_key_env]}`;
  } else if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }

  return new Promise((resolve, reject) => {
    const upstream = client.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: "POST", headers }, (response) => resolve({ response, upstream, target }));
    upstream.once("error", reject);
    signal?.addEventListener("abort", () => upstream.destroy(signal.reason), { once: true });
    upstream.end(body);
  });
}
