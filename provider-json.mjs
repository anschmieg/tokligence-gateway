import http from "node:http";
import https from "node:https";

// Catalog responses have a total deadline, including receipt of the body.
export function fetchProviderJson(options, { timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    let chunks = [];
    let bytes = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks = [];
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Provider catalog deadline exceeded")), timeoutMs);
    timer.unref?.();
    try {
      const client = options.protocol === "https:" || Number(options.port) === 443 ? https : http;
      req = client.request(options, (res) => {
        response = res;
        res.on("error", (error) => finish(error));
        res.on("aborted", () => finish(new Error("Provider catalog response aborted")));
        res.on("close", () => { if (!res.complete) finish(new Error("Provider catalog response incomplete")); });
        res.on("data", (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) finish(new Error("Provider catalog exceeds size limit"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.statusCode < 200 || res.statusCode >= 300) return finish(new Error(`Provider catalog HTTP ${res.statusCode}`));
          try { finish(null, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); }
          catch { finish(new Error("Invalid JSON from model provider")); }
        });
      });
      req.on("error", (error) => finish(error));
      req.end();
    } catch (error) { finish(error); }
  });
}
