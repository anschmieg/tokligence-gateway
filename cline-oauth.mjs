import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

const DEFAULT_API_BASE_URL = "https://api.cline.bot";
const DEFAULT_WORKOS_BASE_URL = "https://api.workos.com";
const DEFAULT_CREDENTIALS_PATH = "/data/cline-oauth/credentials.json";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60_000;
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_DEVICE_EXPIRES_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function resolveProviderSetting(provider, env, field, envField, fallback) {
  return nonEmptyString(env[provider?.[envField]]) || nonEmptyString(provider?.[field]) || fallback;
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function publicModelId(upstreamId) {
  const id = nonEmptyString(upstreamId);
  if (!id) return null;
  return /^cline\//i.test(id) ? `cline/${id.slice("cline/".length)}` : `cline/${id}`;
}

function upstreamModelId(publicId) {
  return String(publicId).replace(/^cline\//i, "");
}

function normalizedModel(entry) {
  const candidate = typeof entry === "string" ? { id: entry } : entry;
  const id = publicModelId(candidate?.id);
  if (!id || id === "cline/") return null;
  return {
    id,
    ...(nonEmptyString(candidate?.name) ? { display_name: candidate.name.trim() } : {}),
    ...(nonEmptyString(candidate?.description) ? { description: candidate.description.trim() } : {}),
  };
}

function uniqueModels(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    const model = normalizedModel(entry);
    const key = model?.id.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function parseExpiresAt(value) {
  const expires = Date.parse(value);
  if (!Number.isFinite(expires)) throw new Error("Cline credentials contain an invalid expiresAt value");
  return new Date(expires).toISOString();
}

function parseCredentialPayload(payload, fallbackRefreshToken = null) {
  const data = payload?.success === true ? payload.data : null;
  const accessToken = nonEmptyString(data?.accessToken);
  const refreshToken = nonEmptyString(data?.refreshToken) || fallbackRefreshToken;
  if (!accessToken || !refreshToken) throw new Error("Cline credential response is invalid");
  return {
    accessToken,
    refreshToken,
    expiresAt: parseExpiresAt(data.expiresAt),
  };
}

function parseStoredCredentials(payload) {
  const accessToken = nonEmptyString(payload?.accessToken);
  const refreshToken = nonEmptyString(payload?.refreshToken);
  if (!accessToken || !refreshToken) throw new Error("Stored Cline credentials are invalid");
  return {
    accessToken,
    refreshToken,
    expiresAt: parseExpiresAt(payload.expiresAt),
  };
}

function workosTokenPrefix(accessToken) {
  return `workos:${String(accessToken).replace(/^workos:/i, "")}`;
}

async function defaultSleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestHeaders(taskId = randomUUID()) {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": "Cline/unknown",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "unknown",
    "X-PLATFORM": "sdk",
    "X-PLATFORM-VERSION": "unknown",
    "X-CORE-VERSION": "unknown",
    "X-Task-ID": taskId,
  };
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function responseErrorText(response) {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    return "";
  }
}

function requestError(status, code, message) {
  return new ClineAdapterError(message, { status, code });
}

export class ClineAdapterError extends Error {
  constructor(message, { status = 502, code = "cline_upstream_error" } = {}) {
    super(message);
    this.name = "ClineAdapterError";
    this.status = status;
    this.code = code;
  }
}

export function classifyClineUpstreamError(statusCode, upstreamText = "") {
  const status = Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 502;
  const normalized = String(upstreamText).toLowerCase();
  if (status === 401 || status === 403) {
    return { status, code: "cline_auth_error", message: "Cline login is missing or expired" };
  }
  if (status === 429 && normalized.includes("free limit reached on model")) {
    return {
      status,
      code: "cline_daily_free_quota_exhausted",
      message: "Cline's daily free quota is exhausted for this model",
    };
  }
  if (status === 404 && normalized.includes("model not found")) {
    return {
      status,
      code: "cline_model_retired",
      message: "The requested Cline free model is no longer available",
    };
  }
  if (status === 402) {
    return {
      status,
      code: "cline_request_rejected",
      message: "Cline rejected this free-model request",
    };
  }
  return { status, code: "cline_upstream_error", message: "Cline upstream request failed" };
}

async function atomicWriteCredentials(destination, credentials) {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(credentials)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    try {
      const directoryHandle = await open(directory, fsConstants.O_RDONLY);
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch {
      // The credential file is already atomically renamed. Some filesystems do
      // not allow directory fsync, so this durability hardening is best effort.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function nodePostJson(url, body, headers, signal) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      },
      signal,
    }, resolve);
    request.once("error", reject);
    request.end(payload);
  });
}

export class ClineOAuthAdapter {
  #apiBaseUrl;
  #workosBaseUrl;
  #credentialsPath;
  #requestTimeoutMs;
  #refreshBufferMs;
  #modelCacheTtlMs;
  #fetch;
  #now;
  #sleep;
  #credentials = undefined;
  #refreshInFlight = null;
  #oauthState = { status: "idle" };
  #oauthCompletion = null;
  #oauthGeneration = 0;
  #configuredModels;
  #modelCache;
  #modelCacheExpiresAt = 0;
  #modelRefreshInFlight = null;

  constructor({ provider = {}, env = process.env, fetch: fetchImpl = fetch, now = Date.now, sleep = defaultSleep } = {}) {
    this.#apiBaseUrl = resolveProviderSetting(provider, env, "api_base_url", "api_base_url_env", provider.default_base_url || DEFAULT_API_BASE_URL);
    this.#workosBaseUrl = resolveProviderSetting(provider, env, "workos_base_url", "workos_base_url_env", provider.default_workos_base_url || DEFAULT_WORKOS_BASE_URL);
    this.#credentialsPath = resolveProviderSetting(provider, env, "credentials_path", "credentials_path_env", DEFAULT_CREDENTIALS_PATH);
    this.#requestTimeoutMs = boundedNumber(provider.request_timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS, 1, 120_000);
    this.#refreshBufferMs = boundedNumber(provider.refresh_buffer_ms, DEFAULT_REFRESH_BUFFER_MS, 0, 60 * 60_000);
    this.#modelCacheTtlMs = boundedNumber(provider.model_cache_ttl_ms, DEFAULT_MODEL_CACHE_TTL_MS, 0, DEFAULT_MODEL_CACHE_TTL_MS);
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep;
    this.#configuredModels = uniqueModels(provider.models || []);
    this.#modelCache = this.#configuredModels;
  }

  async #fetchWithTimeout(url, options = {}) {
    return this.#fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(this.#requestTimeoutMs),
    });
  }

  async #loadCredentials() {
    if (this.#credentials !== undefined) return this.#credentials;
    try {
      const parsed = JSON.parse(await readFile(this.#credentialsPath, "utf8"));
      this.#credentials = parseStoredCredentials(parsed);
      await chmod(this.#credentialsPath, 0o600);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#credentials = null;
      } else {
        throw requestError(500, "cline_credentials_invalid", "Stored Cline credentials are invalid");
      }
    }
    return this.#credentials;
  }

  async #persistCredentials(credentials) {
    await atomicWriteCredentials(this.#credentialsPath, credentials);
    this.#credentials = credentials;
  }

  async #clineJsonRequest(pathname, body) {
    const response = await this.#fetchWithTimeout(endpoint(this.#apiBaseUrl, pathname), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requestHeaders() },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const classified = classifyClineUpstreamError(response.status, await responseErrorText(response));
      throw new ClineAdapterError(classified.message, classified);
    }
    return responseJson(response, "Cline API");
  }

  async #refreshCredentials(current) {
    const payload = await this.#clineJsonRequest("/api/v1/auth/refresh", {
      refreshToken: current.refreshToken,
      grantType: "refresh_token",
    });
    const rotated = parseCredentialPayload(payload, current.refreshToken);
    await this.#persistCredentials(rotated);
    return rotated;
  }

  async #validCredentials() {
    const current = await this.#loadCredentials();
    if (!current) {
      throw requestError(401, "cline_login_required", "Cline login is required");
    }
    if (Date.parse(current.expiresAt) - this.#now() > this.#refreshBufferMs) return current;
    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refreshCredentials(current).finally(() => {
        this.#refreshInFlight = null;
      });
    }
    return this.#refreshInFlight;
  }

  #publicOAuthState() {
    const state = this.#oauthState;
    return {
      status: state.status,
      ...(state.verificationUrl ? { verification_url: state.verificationUrl } : {}),
      ...(state.userCode ? { user_code: state.userCode } : {}),
      ...(state.expiresAt ? { expires_at: state.expiresAt } : {}),
      ...(state.errorCode ? { error: state.errorCode } : {}),
    };
  }

  async startOAuth() {
    if (this.#oauthState.status === "pending" && Date.parse(this.#oauthState.expiresAt) > this.#now()) {
      return this.#publicOAuthState();
    }
    let response;
    try {
      response = await this.#fetchWithTimeout(endpoint(this.#workosBaseUrl, "/user_management/authorize/device"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
      });
    } catch {
      throw requestError(502, "cline_device_authorization_unavailable", "Cline device authorization is unavailable");
    }
    const payload = await responseJson(response, "WorkOS device authorization");
    if (!response.ok) {
      throw requestError(response.status, "cline_device_authorization_failed", "Cline device authorization failed");
    }
    const deviceCode = nonEmptyString(payload.device_code);
    const userCode = nonEmptyString(payload.user_code);
    const verificationUrl = nonEmptyString(payload.verification_uri_complete) || nonEmptyString(payload.verification_uri);
    if (!deviceCode || !userCode || !verificationUrl) {
      throw requestError(502, "cline_device_authorization_invalid", "Cline device authorization returned an invalid response");
    }
    const expiresInSeconds = boundedNumber(payload.expires_in, DEFAULT_DEVICE_EXPIRES_SECONDS, 0.001, 3600);
    const pollIntervalSeconds = boundedNumber(payload.interval, DEFAULT_POLL_INTERVAL_SECONDS, 0.001, 300);
    const generation = ++this.#oauthGeneration;
    this.#oauthState = {
      status: "pending",
      verificationUrl,
      userCode,
      expiresAt: new Date(this.#now() + expiresInSeconds * 1000).toISOString(),
    };
    this.#oauthCompletion = this.#completeOAuth({
      deviceCode,
      expiresAtMs: this.#now() + expiresInSeconds * 1000,
      pollIntervalSeconds,
      generation,
    });
    return this.#publicOAuthState();
  }

  async #completeOAuth({ deviceCode, expiresAtMs, pollIntervalSeconds, generation }) {
    let intervalSeconds = pollIntervalSeconds;
    try {
      while (this.#now() <= expiresAtMs) {
        let response;
        try {
          response = await this.#fetchWithTimeout(endpoint(this.#workosBaseUrl, "/user_management/authenticate"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: deviceCode,
              client_id: CLINE_WORKOS_CLIENT_ID,
            }),
          });
        } catch {
          throw requestError(502, "cline_device_poll_unavailable", "Cline device authorization polling is unavailable");
        }
        const payload = await responseJson(response, "WorkOS device authorization polling");
        if (response.ok) {
          const accessToken = nonEmptyString(payload.access_token);
          const refreshToken = nonEmptyString(payload.refresh_token);
          if (!accessToken || !refreshToken) {
            throw requestError(502, "cline_device_tokens_invalid", "WorkOS returned invalid device credentials");
          }
          const registered = await this.#clineJsonRequest("/api/v1/auth/register", { accessToken, refreshToken });
          if (generation !== this.#oauthGeneration) {
            return this.#publicOAuthState();
          }
          await this.#persistCredentials(parseCredentialPayload(registered));
          this.#oauthState = { status: "authenticated", expiresAt: this.#credentials.expiresAt };
          return this.#publicOAuthState();
        }
        const errorCode = nonEmptyString(payload.error);
        if (errorCode === "authorization_pending") {
          await this.#sleep(Math.max(1, Math.round(intervalSeconds * 1000)));
          continue;
        }
        if (errorCode === "slow_down") {
          intervalSeconds += 1;
          await this.#sleep(Math.max(1, Math.round(intervalSeconds * 1000)));
          continue;
        }
        if (errorCode === "access_denied") {
          throw requestError(403, "cline_access_denied", "Cline device authorization was denied");
        }
        if (errorCode === "expired_token" || errorCode === "invalid_grant") {
          throw requestError(401, "cline_device_code_expired", "Cline device authorization expired");
        }
        throw requestError(response.status, "cline_device_poll_failed", "Cline device authorization polling failed");
      }
      throw requestError(408, "cline_device_code_expired", "Cline device authorization expired");
    } catch (error) {
      const known = error instanceof ClineAdapterError
        ? error
        : requestError(502, "cline_oauth_failed", "Cline OAuth failed");
      this.#oauthState = {
        status: known.code === "cline_device_code_expired" ? "expired" : "error",
        errorCode: known.code,
      };
      return this.#publicOAuthState();
    }
  }

  async waitForOAuthCompletion() {
    if (this.#oauthCompletion) return this.#oauthCompletion;
    return this.oauthStatus();
  }

  async oauthStatus() {
    if (this.#oauthState.status !== "idle") return this.#publicOAuthState();
    const credentials = await this.#loadCredentials();
    return credentials
      ? { status: "authenticated", expires_at: credentials.expiresAt }
      : { status: "login_required" };
  }


  async logout() {
    this.#oauthGeneration += 1;
    this.#oauthCompletion = null;
    this.#oauthState = { status: "login_required" };
    this.#credentials = null;
    this.#refreshInFlight = null;
    try {
      await unlink(this.#credentialsPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw requestError(500, "cline_logout_failed", "Cline credentials could not be cleared");
      }
    }
    return this.#publicOAuthState();
  }

  async discoverFreeModels() {
    if (this.#modelCacheExpiresAt > this.#now()) return this.#modelCache.map((model) => ({ ...model }));
    if (this.#modelRefreshInFlight) return this.#modelRefreshInFlight;
    this.#modelRefreshInFlight = (async () => {
      try {
        const response = await this.#fetchWithTimeout(endpoint(this.#apiBaseUrl, "/api/v1/ai/cline/recommended-models"));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await responseJson(response, "Cline model feed");
        if (!Array.isArray(payload?.free)) throw new Error("Cline model feed does not contain a free array");
        this.#modelCache = uniqueModels(payload.free);
        this.#modelCacheExpiresAt = this.#now() + this.#modelCacheTtlMs;
      } catch {
        // Keep only the last successfully fetched or explicitly configured free
        // set. A transient feed failure must not introduce any other tier.
      }
      return this.#modelCache.map((model) => ({ ...model }));
    })().finally(() => {
      this.#modelRefreshInFlight = null;
    });
    return this.#modelRefreshInFlight;
  }

  async createChatCompletion(body, { signal } = {}) {
    const credentials = await this.#validCredentials();
    const models = await this.discoverFreeModels();
    const requested = nonEmptyString(body?.model);
    const allowed = requested && models.some(({ id }) => id.toLowerCase() === requested.toLowerCase());
    if (!allowed) {
      throw requestError(404, "cline_model_retired", "The requested Cline free model is no longer available");
    }
    const payload = { ...body, model: upstreamModelId(requested) };
    const headers = {
      ...requestHeaders(),
      Authorization: `Bearer ${workosTokenPrefix(credentials.accessToken)}`,
    };
    try {
      return await nodePostJson(
        endpoint(this.#apiBaseUrl, "/api/v1/chat/completions"),
        payload,
        headers,
        signal,
      );
    } catch (error) {
      if (error instanceof ClineAdapterError) throw error;
      throw requestError(502, "cline_upstream_unavailable", "Cline upstream is unavailable");
    }
  }
}
