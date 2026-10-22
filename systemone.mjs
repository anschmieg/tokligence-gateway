import { createHash } from "node:crypto";
import Ajv from "ajv";

export const SYSTEMONE_URL = "https://opencode.ai/inference/systemone/v1/systemone";
export const SYSTEMONE_MODELS = new Set(["jev-1.13-free", "jev-1.13"]);
export const SYSTEMONE_MAX_REQUEST_BYTES = 64 * 1024;
export const SYSTEMONE_MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_QUESTIONS = 32;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

const entryType = { type: ["string", "object", "array", "null"] };
const questionSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "noul" }, instructions: entryType, criteria: { type: ["object", "null"], maxProperties: 2, properties: { true: entryType, false: entryType }, additionalProperties: false } } },
    { type: "object", additionalProperties: false, required: ["type", "criteria"], properties: { type: { const: "choice" }, instructions: entryType, criteria: { type: "object", minProperties: 2, maxProperties: 255, propertyNames: { minLength: 1, maxLength: 128 }, additionalProperties: entryType } } },
    { type: "object", additionalProperties: false, required: ["type", "criteria"], properties: { type: { const: "score" }, instructions: entryType, criteria: { type: "array", minItems: 2, maxItems: 10, items: entryType } } },
  ],
};
const requestSchema = {
  type: "object", additionalProperties: false, required: ["model", "state", "questions"],
  properties: {
    model: { type: "string", enum: [...SYSTEMONE_MODELS] },
    state: { type: ["string", "array", "object"] },
    questions: { type: "object", minProperties: 1, maxProperties: MAX_QUESTIONS, propertyNames: { minLength: 1, maxLength: 128 }, additionalProperties: questionSchema },
  },
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRequest = ajv.compile(requestSchema);

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

export function validateSystemOneRequest(input) {
  const stack = [[input, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > 32) throw invalid("SystemOne request nesting exceeds its limit");
    if (value && typeof value === "object") for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  if (!validateRequest(input)) throw invalid("Invalid SystemOne request schema");
}

function boundedText(value, max = SYSTEMONE_MAX_RESPONSE_BYTES) {
  return typeof value === "string" && value.length <= max;
}

export function validateSystemOneResponse(response, request) {
  if (!isObject(response) || response.model !== request.model || !isObject(response.answers)) return false;
  const expected = Object.entries(request.questions);
  if (Object.keys(response.answers).length !== expected.length) return false;
  for (const [id, question] of expected) {
    const answer = response.answers[id];
    if (!Object.hasOwn(response.answers, id) || !isObject(answer) || answer.type !== question.type) return false;
    if (question.type !== "noul" && (!Number.isFinite(answer.confidence) || !isObject(answer.probabilities))) return false;
    if (question.type === "score" && !isObject(answer.legend)) return false;
    if (question.type !== "noul" && Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01) return false;
    if (question.type === "noul" && (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) return false;
    if (question.type === "noul" && answer.legend !== undefined && (!isObject(answer.legend) || Object.keys(answer.legend).some((key) => !["true", "false"].includes(key) || !boundedText(answer.legend[key], 4096)))) return false;
    if (question.type === "noul" && answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) return false;
    if (question.type === "choice" && (!boundedText(answer.choice, 128) || !Object.hasOwn(question.criteria, answer.choice))) return false;
    if (question.type === "choice" && answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) return false;
    if (question.type === "choice" && answer.probabilities !== undefined) {
      if (!isObject(answer.probabilities) || Object.keys(answer.probabilities).length !== Object.keys(question.criteria).length) return false;
      if (Object.keys(question.criteria).some((key) => !Object.hasOwn(answer.probabilities, key) || !Number.isFinite(answer.probabilities[key]) || answer.probabilities[key] < 0 || answer.probabilities[key] > 1)) return false;
    }
    if (question.type === "choice" && answer.legend !== undefined && (!isObject(answer.legend) || Object.keys(answer.legend).length !== Object.keys(question.criteria).length || Object.keys(question.criteria).some((key) => !Object.hasOwn(answer.legend, key) || !boundedText(answer.legend[key], 4096)))) return false;
    if (question.type === "score") {
      const max = question.criteria.length - 1;
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > max) return false;
      if (answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) return false;
      if (answer.probabilities !== undefined) {
        if (!isObject(answer.probabilities) || Object.keys(answer.probabilities).length !== question.criteria.length) return false;
        if (question.criteria.some((_, index) => !Object.hasOwn(answer.probabilities, index) || !Number.isFinite(answer.probabilities[index]) || answer.probabilities[index] < 0 || answer.probabilities[index] > 1)) return false;
      }
      if (answer.legend !== undefined && (!isObject(answer.legend) || Object.keys(answer.legend).length !== question.criteria.length || question.criteria.some((_, index) => !Object.hasOwn(answer.legend, index) || !boundedText(answer.legend[index], 4096)))) return false;
    }
  }
  if (!isObject(response.usage) || !Number.isFinite(response.usage.input_tokens) || !Number.isFinite(response.usage.output_tokens)
    || response.usage.input_tokens < 0 || response.usage.output_tokens < 0) return false;
  return true;
}

function retryDelay(headers, now) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_COOLDOWN_MS);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const delay = reset > 1e12 ? reset - now : reset * 1000 - now;
    if (delay > 0) return Math.min(delay, MAX_COOLDOWN_MS);
  }
  return null;
}

export function createSystemOnePool({ accountPool, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = REQUEST_TIMEOUT_MS, attemptTimeoutMs = 10000 } = {}) {
  if (!accountPool) throw new TypeError("SystemOne requires the shared OpenCode account pool");
  const affinity = accountPool.affinity;
  const cooldowns = accountPool.state;
  const identity = (account) => account.id;
  const eligible = (model) => accountPool.eligibleAccounts("systemone", model);

  async function request(input, { stickyKey, signal } = {}) {
    validateSystemOneRequest(input);
    const key = String(stickyKey || "anonymous");
    const excluded = new Set();
    let attempts = 0;
    let lastStatus = 503;
    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    const maxAttempts = accountPool.maxAttempts;

    while (attempts < maxAttempts) {
      if (signal?.aborted) throw signal.reason || invalid("SystemOne request cancelled", 499);
      if (now() >= deadline) throw invalid("SystemOne request timed out", 504);
      const account = accountPool.select("systemone", input.model, key, { exclude: [...excluded] });
      if (!account) break;
      excluded.add(identity(account));
      attempts += 1;
      const generation = accountPool.state.get(identity(account))?.generation ?? 0;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason || invalid("SystemOne request cancelled", 499));
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      let timer;
      try {
        const remaining = Math.max(1, Math.min(attemptTimeoutMs, deadline - now()));
        const timedOut = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = invalid("SystemOne request timed out", 504);
            controller.abort(error);
            reject(error);
          }, remaining);
        });
        const tokenRequest = accountPool.authorizationFor(account);
        const token = await Promise.race([tokenRequest, timedOut]);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!token) throw Object.assign(new Error("credential unavailable"), { statusCode: 503 });
        const response = await Promise.race([fetchImpl(SYSTEMONE_URL, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        }), timedOut]);
        if (!response.ok) {
          lastStatus = response.status;
          const delay = retryDelay(response.headers, now()) ?? (response.status === 429 ? 60_000 : 30_000);
          try { await response.body?.cancel(); } catch {}
          if ([400, 404, 422].includes(response.status)) throw Object.assign(new Error("SystemOne rejected the request"), { statusCode: response.status, retryable: false });
          accountPool.markFailure(account, null, { retryAfterMs: delay });
          continue;
        }
        const readBody = async () => {
          const reader = response.body?.getReader();
          if (!reader) throw Object.assign(new Error("empty response body"), { statusCode: 502 });
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > SYSTEMONE_MAX_RESPONSE_BYTES) {
              try { await reader.cancel(); } catch {}
              throw Object.assign(new Error("response too large"), { statusCode: 502 });
            }
            chunks.push(Buffer.from(value));
          }
          if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) throw Object.assign(new Error("invalid content type"), { statusCode: 502 });
          let document;
          try { document = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 502 }); }
          if (!validateSystemOneResponse(document, input)) throw Object.assign(new Error("invalid response schema"), { statusCode: 502 });
          return document;
        };
        const document = await Promise.race([readBody(), timedOut]);
        accountPool.markSuccess(account, key, generation);
        return { status: response.status, document };
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        if (controller.signal.aborted && controller.signal.reason?.statusCode === 504) {
          lastStatus = 504;
          accountPool.markFailure(account, controller.signal.reason, { retryAfterMs: 30000 });
          continue;
        }
        if (error.retryable === false) throw error;
        lastStatus = Number.isInteger(error.statusCode) ? error.statusCode : 502;
        accountPool.markFailure(account, error, { retryAfterMs: 30_000 });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    }
    throw invalid("SystemOne request failed or no eligible credential is available", lastStatus);
  }
  return { request, eligibleAccounts: eligible, cooldowns, affinity };
}

export function systemOneStickyKey(principalAuthorization, session) {
  return createHash("sha256").update(`${principalAuthorization || ""}\0${session || "default"}`).digest("base64url");
}

export function readBoundedBody(req, limit = SYSTEMONE_MAX_REQUEST_BYTES, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) finish(invalid("SystemOne request exceeds 64 KiB", 413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(invalid("Invalid JSON request")); }
    };
    const onError = (error) => finish(error);
    const onAborted = () => finish(invalid("SystemOne request cancelled", 499));
    const timer = setTimeout(() => finish(invalid("SystemOne request timed out", 504)), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}
