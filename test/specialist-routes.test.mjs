import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { loadRoutingConfig } from "../route-config.mjs";
import { handleSpecialistHttp, handleSpecialistUpgrade, rewriteMultipartModel } from "../specialist-routes.mjs";

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}

test("multipart model rewrite preserves binary audio and rejects duplicate model fields", () => {
  const binary = Buffer.from([0, 255, 1, 13, 10, 128]);
  const body = Buffer.concat([
    Buffer.from('--test\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
    binary,
    Buffer.from('\r\n--test\r\nContent-Disposition: form-data; name="model"\r\n\r\nmistral/voxtral-mini-latest\r\n--test--\r\n'),
  ]);
  const rewritten = rewriteMultipartModel(body, 'multipart/form-data; boundary="test"', (id) => id.slice(8));
  assert.equal(rewritten.model, "mistral/voxtral-mini-latest");
  assert(rewritten.body.includes(binary));
  assert(!rewritten.body.includes(Buffer.from("mistral/")));
  const duplicate = Buffer.from('--test\r\nContent-Disposition: form-data; name="model"\r\n\r\na\r\n--test\r\nContent-Disposition: form-data; name="model"\r\n\r\nb\r\n--test--\r\n');
  assert.throws(() => rewriteMultipartModel(duplicate, "multipart/form-data; boundary=test"), /Exactly one/);
});

test("specialist HTTP forwards JSON, multipart and binary replies only to compatible endpoints", async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(Buffer.from([0, 255, 13, 10]));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "transcribed" }));
    }
  });
  const upstreamPort = await listen(upstream, t);
  const config = loadRoutingConfig("gateway.routes.yaml");
  const env = { MISTRAL_API_KEY: "private-key", MISTRAL_API_BASE: `http://127.0.0.1:${upstreamPort}/v1` };
  const gateway = http.createServer((req, res) => { if (!handleSpecialistHttp(req, res, { config, env })) res.writeHead(404).end(); });
  const gatewayPort = await listen(gateway, t);
  const base = `http://127.0.0.1:${gatewayPort}`;
  const speech = await fetch(`${base}/v1/audio/speech`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer caller-key", "x-api-key": "caller-key" }, body: JSON.stringify({ model: "mistral/voxtral-mini-tts-3", input: "hello" }) });
  assert.equal(speech.status, 200);
  assert.deepEqual(Buffer.from(await speech.arrayBuffer()), Buffer.from([0, 255, 13, 10]));
  assert.equal(JSON.parse(seen[0].body).model, "voxtral-mini-tts-3");
  assert.equal(seen[0].headers.authorization, "Bearer private-key");
  assert.equal(seen[0].headers["x-api-key"], undefined);
  const form = new FormData();
  form.set("model", "mistral/voxtral-mini-transcribe-3");
  form.set("file", new Blob([Buffer.from([0, 255, 1])], { type: "audio/wav" }), "speech.wav");
  const transcript = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
  assert.equal(transcript.status, 200);
  await transcript.text();
  assert(seen[1].body.includes(Buffer.from([0, 255, 1])));
  assert(!seen[1].body.includes(Buffer.from("mistral/")));
  for (const [path, body] of [
    ["/v1/audio/speech", { model: "mistral/mistral-large-latest" }],
    ["/v1/audio/speech", { model: "openrouter/voxtral-mini-tts-3" }],
    ["/v1/audio/transcriptions", { model: "mistral/voxtral-mini-tts-3" }],
    ["/v1/audio/speech", null],
  ]) {
    const invalid = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(invalid.status, 400);
    await invalid.text();
  }
  assert.equal(seen.length, 2, "mismatches never reach upstream");
  const realtimeHttp = await fetch(`${base}/v1/audio/transcriptions/realtime`);
  assert.equal(realtimeHttp.status, 426);
  await realtimeHttp.text();
});

test("realtime transcription upgrades and tunnels bytes with backend credentials", async (t) => {
  const config = loadRoutingConfig("gateway.routes.yaml");
  const upstream = http.createServer();
  let observed;
  let peer;
  upstream.on("upgrade", (req, socket) => {
    observed = req;
    peer = socket;
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream, t);
  const env = { MISTRAL_API_KEY: "private-key", MISTRAL_API_BASE: `http://127.0.0.1:${upstreamPort}/v1` };
  const gateway = http.createServer();
  gateway.on("upgrade", (req, socket, head) => handleSpecialistUpgrade(req, socket, head, { config, env }));
  const gatewayPort = await listen(gateway, t);
  const socket = net.connect(gatewayPort, "127.0.0.1");
  t.after(() => { socket.destroy(); peer?.destroy(); });
  socket.write('GET /v1/audio/transcriptions/realtime?model=mistral%2Fvoxtral-mini-transcribe-realtime-3 HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer caller-key\r\n\r\n');
  const [handshake] = await once(socket, "data");
  assert.match(handshake.toString(), /^HTTP\/1.1 101/);
  assert.match(observed.url, /model=voxtral-mini-transcribe-realtime-3/);
  assert.equal(observed.headers.authorization, "Bearer private-key");
  const payload = Buffer.from([0x81, 0x80, 1, 2, 3, 4]);
  socket.write(payload);
  const [echo] = await once(socket, "data");
  assert.deepEqual(echo, payload);
});
