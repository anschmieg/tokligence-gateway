export function createSseWriter(res, signal, pingMs = 15000) {
  let lastWriteAt = Date.now();
  let stopped = false;
  const pending = new Set();
  const write = async (chunk) => {
    if (stopped || res.destroyed || res.writableEnded || signal?.aborted) return false;
    if (res.writableNeedDrain && !await drained()) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
    lastWriteAt = Date.now();
    const ready = res.write(chunk) ? true : await drained();
    if (!ready && signal?.aborted) throw signal.reason;
    return ready;
  };
  const drained = () => new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onClose);
      pending.delete(onClose);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = (error) => { cleanup(); reject(error); };
    pending.add(onClose);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onClose, { once: true });
    if (stopped || res.destroyed || signal?.aborted) onClose();
    else if (!res.writableNeedDrain) onDrain();
  });
  const cleanup = () => {
    stopped = true;
    clearInterval(timer);
    res.off("close", cleanup);
    res.off("finish", cleanup);
    for (const cancel of [...pending]) cancel();
  };
  const timer = setInterval(() => {
    if (stopped || signal?.aborted || res.destroyed || res.writableEnded || res.writableNeedDrain || Date.now() - lastWriteAt < pingMs) return;
    lastWriteAt = Date.now();
    try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch { cleanup(); }
  }, Math.max(1, pingMs));
  timer.unref?.();
  res.once("close", cleanup);
  res.once("finish", cleanup);
  return { write, cleanup };
}

export function sseHeaders(headers = {}) {
  const result = { ...headers };
  delete result["content-length"];
  delete result["transfer-encoding"];
  return {
    ...result,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

export function endSseError(res, signal) {
  if (res.destroyed || res.writableEnded || signal?.reason?.code === "CLIENT_DISCONNECTED") return;
  const message = signal?.aborted ? "Gateway deadline exceeded" : "Upstream stream failed";
  res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
}
