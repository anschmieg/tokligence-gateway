import { createHash } from "node:crypto";
// Native sessions need a conversation identity, never a request ID/cache key or
// the legacy principal-wide default. Only the digest crosses the worker boundary.
export function nativeConversationIdentity(headers = {}, body = {}) {
  const candidates = [];
  const add = value => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
      throw Object.assign(new Error('Native conversation identity must be a nonempty session identifier'), { statusCode: 400, code: 'native_session_identity_invalid' });
    }
    candidates.push(value);
  };
  for (const name of ['x-claude-code-session-id', 'session-id', 'session_id', 'x-session-id']) add(headers[name]);
  let user = body?.metadata?.user_id;
  if (typeof user === 'string') {
    try { user = JSON.parse(user); } catch { user = null; }
  }
  if (user && typeof user === 'object' && !Array.isArray(user)) add(user.session_id);
  if (!candidates.length) throw Object.assign(new Error('Native requests require a stable conversation ID in x-session-id or Claude session metadata'), { statusCode: 400, code: 'native_session_identity_required' });
  if (new Set(candidates).size !== 1) throw Object.assign(new Error('Native request contains conflicting conversation identifiers'), { statusCode: 400, code: 'native_session_identity_conflict' });
  return candidates[0];
}

export function nativeConversationScope(headers = {}, body = {}) {
  return createHash('sha256').update(`${String(headers.authorization || '')}\0${nativeConversationIdentity(headers, body)}`).digest('base64url');
}
