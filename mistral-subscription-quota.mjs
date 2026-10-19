import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import https from 'node:https';

const ENDPOINT = new URL('https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D');
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function signal(fields) {
  return {
    id: 'mistral-vibe-monthly',
    label: 'Unofficial Vibe subscription quota',
    source: 'unofficial-console',
    status: 'unavailable',
    observedAt: null,
    resetAt: null,
    percentUsed: null,
    remaining: null,
    unit: 'percent',
    note: 'Mistral console endpoint is unofficial and may change',
    ...fields,
  };
}

export function parseMistralVibeUsage(body, observedAt) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('invalid response');
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('invalid response'); }
  const value = Array.isArray(data) ? data[0]?.result?.data?.json : null;
  const percentage = value?.usage_percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error('invalid usage');
  const parsedReset = typeof value.reset_at === 'string' ? new Date(value.reset_at) : null;
  return signal({
    status: 'fresh',
    observedAt: new Date(observedAt).toISOString(),
    resetAt: parsedReset && Number.isFinite(parsedReset.getTime()) ? parsedReset.toISOString() : null,
    percentUsed: percentage,
    remaining: Math.round((100 - percentage) * 100) / 100,
  });
}

export async function readMistralSession(file) {
  if (!file || typeof file !== 'string') throw new Error('unconfigured');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let raw;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > MAX_CREDENTIAL_BYTES) throw new Error('unsafe credentials');
    raw = await handle.readFile('utf8');
  } finally { await handle.close(); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('invalid credentials'); }
  const csrfToken = parsed?.csrfToken;
  const cookies = parsed?.sessionCookies;
  if (typeof csrfToken !== 'string' || !csrfToken || /[\x00-\x20\x7f;,]/.test(csrfToken) || !cookies || typeof cookies !== 'object' || Array.isArray(cookies)) throw new Error('invalid credentials');
  const entries = Object.entries(cookies);
  if (entries.length < 1 || entries.length > 8 || entries.some(([name, value]) => !/^ory_session_[A-Za-z0-9_-]+$/.test(name) || typeof value !== 'string' || !value || /[\x00-\x20\x7f;,]/.test(value))) throw new Error('invalid credentials');
  return { csrfToken, sessionCookies: Object.fromEntries(entries) };
}

function requestJson({ headers, timeoutMs = 4000, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, { method: 'GET', headers, timeout: timeoutMs, signal }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); reject(new Error('redirect refused')); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.once('error', () => reject(new Error('request failed')));
    req.end();
  });
}

export async function probeMistralSubscription({ file, transport = requestJson, now = () => new Date() } = {}) {
  if (!file) return signal({ status: 'unconfigured', note: 'No private Mistral session file configured' });
  let session;
  try { session = await readMistralSession(file); } catch { return signal({ note: 'Mistral session credentials are missing, unsafe or invalid' }); }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 4000);
  deadline.unref?.();
  try {
    const headers = {
      Accept: '*/*',
      Cookie: [`csrftoken=${session.csrfToken}`, ...Object.entries(session.sessionCookies).map(([name, value]) => `${name}=${value}`)].join('; '),
      'X-CSRFToken': session.csrfToken,
    };
    const response = await transport({ url: ENDPOINT, headers, redirect: 'error', timeoutMs: 4000, signal: controller.signal });
    if (response.statusCode !== 200) return signal({ note: response.statusCode === 401 || response.statusCode === 403 ? 'Mistral session expired or rejected' : 'Mistral quota endpoint unavailable' });
    return parseMistralVibeUsage(response.body, now());
  } catch {
    return signal({ note: 'Mistral quota endpoint unavailable or returned an invalid response' });
  } finally { clearTimeout(deadline); controller.abort(); }
}
