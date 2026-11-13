const requests = new WeakMap();

export function stripHopByHopHeaders(headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const nominated = String(normalized.connection || "").split(",").map(value => value.trim().toLowerCase());
  for (const key of [...nominated, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]) delete normalized[key];
  return normalized;
}

function duration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function lifecycle(req, res) {
  if (requests.has(req)) return requests.get(req);
  const controller = new AbortController();
  const totalMs = duration(process.env.GATEWAY_REQUEST_TIMEOUT_MS, 120000);
  const startMs = Math.min(totalMs, duration(process.env.GATEWAY_RESPONSE_START_TIMEOUT_MS, 90000));
  const cancel = () => controller.abort(new Error("Client disconnected"));
  const close = () => { if (!res.writableEnded) cancel(); cleanup(); };
  const expire = () => {
    if (!res.destroyed && !res.writableEnded) {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Gateway upstream deadline exceeded" }));
      }
    }
    controller.abort(new Error("Gateway upstream deadline exceeded"));
    cleanup();
  };
  const totalTimer = setTimeout(expire, totalMs);
  const startTimer = setTimeout(expire, startMs);
  totalTimer.unref?.(); startTimer.unref?.();
  const cleanup = () => {
    clearTimeout(totalTimer); clearTimeout(startTimer);
    req.off("aborted", cancel);
    res.off("close", close);
    res.off("finish", cleanup);
  };
  req.once("aborted", cancel);
  res.once("close", close);
  res.once("finish", cleanup);
  if (req.aborted || res.destroyed) { cancel(); cleanup(); }
  const state = { signal: controller.signal, receivedHeaders: () => clearTimeout(startTimer) };
  requests.set(req, state);
  return state;
}

// Every legacy exchange shares the caller's deadline and cancellation signal.
export function requestWithLifecycle(client, options, req, res, callback) {
  const state = lifecycle(req, res);
  const upstream = client.request({ ...options, headers: stripHopByHopHeaders(options.headers), signal: state.signal }, response => {
    if (state.signal.aborted || res.destroyed || res.writableEnded) { response.destroy(); return; }
    state.receivedHeaders();
    response.headers = stripHopByHopHeaders(response.headers);
    response.on("error", () => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Upstream response interrupted" })); }
    });
    callback(response);
  });
  upstream.on("error", () => {});
  return upstream;
}

export function sendUpstreamError(res, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
