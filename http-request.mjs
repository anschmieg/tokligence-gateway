const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BODY_TIMEOUT_MS = 30_000;

export function readRequestBody(req, { limit = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", aborted);
      // Retain the error handler until close when rejecting a partial body.
      if (!error) req.off("error", failed);
      if (error) { chunks = []; req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes));
    };
    const failure = (statusCode, message) => finish(Object.assign(new Error(message), { statusCode }));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) failure(413, "Request body exceeds the size limit");
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => failure(400, "Request body could not be read");
    const aborted = () => failure(400, "Request body was aborted");
    const timer = setTimeout(() => failure(408, "Request body timed out"), timeoutMs);
    timer.unref?.();
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", aborted);
    if (Number(req.headers["content-length"]) > limit) failure(413, "Request body exceeds the size limit");
  });
}

export function parseRequestObject(body) {
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

export function sendRequestError(req, res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = [400, 408, 413].includes(error?.statusCode) ? error.statusCode : 500;
  res.shouldKeepAlive = false;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: status === 500 ? "Request could not be processed" : error.message }));
  // Release partial requests after the error response has been sent.
  res.once("finish", () => { if (!req.complete) req.destroy(); });
}
