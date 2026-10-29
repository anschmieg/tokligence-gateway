// Native-source CLI preload. Counts calls; forwards the original request through
// the original Bun fetch/TLS implementation. No HTTP relay or token copying.
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.OPENCODE_PROBE_METER_FILE, 'utf8'));
const meter = new URL(config.meter);
if (meter.protocol !== 'http:' || meter.hostname !== '127.0.0.1') throw new Error('Loopback probe meter required');
const original = globalThis.fetch;
async function notify(route, value) {
  const reply = await original(new URL(route, meter), { method: 'POST', redirect: 'manual',
    headers: { authorization: config.authorization, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (reply.status !== 200) throw new Error('Native probe stopped by persistent meter');
  await reply.arrayBuffer();
}
// The bounded control supports HTTP only. Native Bun also exposes WebSocket;
// reject its constructor before network I/O and prevent an HTTP fallback race.
let unsupportedTransport;
if (globalThis.WebSocket) globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct() {
    unsupportedTransport ||= notify('/invalid', { reason: 'unsupported_native_websocket' }).catch(() => {});
    throw new Error('WebSocket transport is outside the bounded native control');
  },
});
globalThis.fetch = async (input, init) => {
  if (unsupportedTransport) {
    await unsupportedTransport;
    throw new Error('Native control stopped after unsupported transport');
  }
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = (init?.method || input.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers || input.headers);
  // CLI-to-local-native-server calls do not leave the machine. They carry no
  // provider credential and remain separate from provider inference accounting.
  if (url.hostname === '127.0.0.1' && url.origin === config.localServer) return original(input, init);
  const inference = url.href === config.inference && method === 'POST';
  const consoleCall = (url.href === config.console + '/api/v2/config' && method === 'GET') ||
    (url.href === config.console + '/auth/device/token' && method === 'POST');
  const discovery = method === 'GET' && ['http://127.0.0.1:1234/api/v1/models', 'http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:8000/health'].includes(url.href);
  const catalog = url.href === 'https://models.dev/api.json' && method === 'GET';
  if (!inference && !consoleCall && !catalog && !discovery) {
    await notify('/invalid', { reason: 'unexpected_native_destination' });
    throw new Error('Unexpected native probe destination');
  }
  if (inference) {
    let body = init?.body;
    if (body === undefined && input instanceof Request) body = await input.clone().text();
    if (ArrayBuffer.isView(body) && body.byteLength <= 1024 * 1024) body = new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (body instanceof ArrayBuffer && body.byteLength <= 1024 * 1024) body = new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (typeof body !== 'string' || body.length > 1024 * 1024) {
      await notify('/invalid', { reason: 'invalid_native_request_body' });
      throw new Error('Invalid native probe body');
    }
    const value = JSON.parse(body);
    const auth = headers.get('authorization') || '';
    await notify('/reserve', { model: value.model, max_tokens: value.max_tokens,
      request: value, competing_limit: value.max_completion_tokens !== undefined, tools: (value.tools || []).length,
      cookies: headers.has('cookie'), oauth_bearer: /^Bearer \S+$/.test(auth) && auth !== 'Bearer public', stream: value.stream });
  } else await notify('/background', {});
  let response;
  try { response = await original(input, { ...init, redirect: 'manual' }); }
  catch (error) { if (inference || consoleCall) await notify('/invalid', { reason: 'native_transport_failed' }); throw error; }
  if ((inference || consoleCall) && response.status >= 300) {
    const metadata = { status: response.status, body: '',
      headers: Object.fromEntries(['retry-after', 'x-opencode-log-id', 'x-request-id'].map(key => [key, response.headers.get(key)])) };
    await notify('/observed-rejection', metadata);
    let body = '';
    const reader = response.clone().body?.getReader();
    const deadline = Date.now() + 1000;
    try {
      while (reader && body.length <= 16384 && Date.now() < deadline) {
        let timer;
        let item;
        try { item = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bounded rejection body deadline')), Math.max(1, deadline - Date.now())); })]); }
        finally { clearTimeout(timer); }
        if (item.done) break;
        body += new TextDecoder().decode(item.value);
      }
    } catch { /* The observed status and headers are already durable. */ }
    finally { if (reader) void reader.cancel().catch(() => {}); }
    await notify('/outcome', { status: response.status, body: body.slice(0, 16384),
      headers: Object.fromEntries(['retry-after', 'x-opencode-log-id', 'x-request-id'].map(key => [key, response.headers.get(key)])) });
  }
  // The first live control is explicitly tool-free. Hold its bounded response
  // before the native agent can execute a hallucinated tool call. Provider
  // request bytes and native TLS remain untouched; response delivery is buffered.
  if (inference && response.ok && config.controlMarker) {
    const reader = response.body?.getReader();
    const chunks = []; let size = 0, pending = '', text = '', finish = false, done = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const deadline = Date.now() + 110000;
    async function frame(value) {
      const data = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (done) throw new Error('Output after completion');
      if (data === '[DONE]') {
        if (!finish) throw new Error('Completion before finish');
        done = true; return;
      }
      const event = JSON.parse(data);
      if (event.error) {
        const error = event.error;
        const quota = ['FreeUsageLimitError', 'FreeTierError', 'rate_limit_error'].some(code => error.type === code || error.code === code);
        const auth = ['authentication_error', 'permission_error'].some(code => error.type === code || error.code === code);
        const status = [401, 403, 429].includes(error.upstream_status) ? error.upstream_status
          : quota ? 429 : auth ? 401 : 502;
        // Persist a complete error frame immediately, even if the peer never
        // closes the stream. The remaining body must not delay the cooldown.
        await notify('/outcome', { status, body: JSON.stringify(event), headers: {} });
        throw new Error('Embedded control error');
      }
      if (!Array.isArray(event.choices) || event.choices.length > 1) throw new Error('Invalid control choices');
      for (const choice of event.choices) {
        if (finish) throw new Error('Choice after terminal finish');
        if (choice.index !== undefined && choice.index !== 0) throw new Error('Unexpected control choice');
        const delta = choice.delta;
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('Invalid control delta');
        if (delta.tool_calls?.length || delta.function_call) throw new Error('Control returned tools');
        if (delta.role !== undefined && delta.role !== 'assistant') throw new Error('Invalid control role');
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') throw new Error('Invalid control text');
          text += delta.content;
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (choice.finish_reason !== 'stop') throw new Error('Control did not stop');
          finish = true;
        }
      }
    }
    try {
      if (!reader) throw new Error('Missing control stream');
      while (true) {
        let timer, item;
        try {
          item = await Promise.race([reader.read(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Control stream deadline')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
        if (item.done) { pending += decoder.decode(); break; }
        size += item.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('Control response exceeded limit');
        chunks.push(item.value);
        pending += decoder.decode(item.value, { stream: true });
        // Normalize only complete CRLF pairs; a CR split across chunks stays
        // in pending until the next chunk supplies its LF.
        pending = pending.replaceAll('\r\n', '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const value = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          await frame(value);
        }
      }
      if (pending.trim() || !done || !finish || text.trim() !== config.controlMarker) throw new Error('Control incomplete');
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {});
      await notify('/invalid', { reason: 'invalid_native_control_response' });
      throw error;
    }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
};
