// Private subprocess transport. stdin/stdout stay in the supervised Python
// parent; never invoke this helper as an unguarded live probe.
const input = JSON.parse(await Bun.stdin.text());
const url = new URL(input.url);
const live = url.href === 'https://opencode.ai/inference/openai/v1/chat/completions';
const fixture = input.fixture === true && url.protocol === 'http:' &&
  ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/v1/chat/completions' &&
  !url.username && !url.password && !url.search && !url.hash;
if (!live && !fixture) throw new Error('Transport target rejected');
if (Object.keys(process.env).some(key => /^(https?|all)_proxy$/i.test(key) && process.env[key])) throw new Error('Proxy environment rejected');
const headers = new Headers(input.headers);
const permitted = new Set(['authorization', 'content-type', 'user-agent', 'x-opencode-client', 'x-opencode-project', 'x-opencode-request', 'x-opencode-session']);
if ([...headers.keys()].some(key => !permitted.has(key)) || headers.get('authorization') !== 'Bearer public') throw new Error('Public headers required');
const body = Buffer.from(input.body, 'base64');
if (body.length > 1024 * 1024) throw new Error('Body limit exceeded');
const request = JSON.parse(body.toString());
if (!['beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free'].includes(request.model) ||
  !Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > 1024 ||
  'max_completion_tokens' in request || request.stream !== true || request.tools?.length) throw new Error('Bounded free control required');
const timeout = input.timeout;
if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60) throw new Error('Invalid deadline');
const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeout * 1000) });
const selected = {};
for (const name of ['retry-after', 'x-opencode-log-id', 'x-request-id']) {
  const value = response.headers.get(name); if (value) selected[name] = value;
}
const reader = response.body?.getReader();
const chunks = []; let size = 0;
const failed = response.status >= 300;
const limit = failed ? 16 * 1024 : 2 * 1024 * 1024;
if (reader) {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        if (!failed) throw new Error('Response limit exceeded');
        chunks.push(Buffer.from(value.subarray(0, limit - size)));
        await reader.cancel().catch(() => {});
        break;
      }
      size += value.length;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    // Once rejection headers arrive, retain the actual status/reset even if
    // its body is truncated, malformed, too large or times out.
    if (!failed) throw error;
  }
  finally { reader.releaseLock(); }
}
// Only the diagnostic response headers needed by the guard cross the pipe.
process.stdout.write(JSON.stringify({ status: response.status, headers: selected, body: Buffer.concat(chunks).toString('base64') }));
