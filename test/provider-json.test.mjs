import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchProviderJson } from "../provider-json.mjs";

test("provider JSON rejects truncated, oversized and stalled responses and allows recovery", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/truncated") { res.writeHead(200, { "content-length": 100, connection: "close" }); res.end("{"); }
    else if (req.url === "/large") res.end("x".repeat(100));
    else if (req.url === "/stalled") { res.writeHead(200); res.flushHeaders(); res.write("{"); }
    else if (req.url === "/headers-stalled") { /* deadline includes headers */ }
    else res.end('{"data":[]}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { hostname: "127.0.0.1", port: server.address().port, method: "GET" };
  for (const [path, pattern] of [["/truncated", /aborted|incomplete/], ["/large", /size limit/], ["/stalled", /deadline/], ["/headers-stalled", /deadline/]]) {
    await assert.rejects(fetchProviderJson({ ...options, path }, { timeoutMs: 100, maxBytes: 64 }), pattern);
    assert.deepEqual(await fetchProviderJson({ ...options, path: "/ok" }), { data: [] });
  }
});
