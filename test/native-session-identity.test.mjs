import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeConversationIdentity as identity, nativeConversationScope } from '../native-session-identity.mjs';

test('native identity uses explicit conversation metadata and rejects fallback/conflicting scopes', () => {
  assert.equal(identity({ 'x-session-id': 'ses_one' }), 'ses_one');
  assert.equal(identity({}, { metadata: { user_id: { session_id: 'ses_two' } } }), 'ses_two');
  assert.equal(identity({}, { metadata: { user_id: '{"session_id":"ses_three","device_id":"ignored"}' } }), 'ses_three');
  assert.equal(identity({ 'x-session-id': 'ses_one', 'session-id': 'ses_one' }), 'ses_one');
  for (const headers of [{}, { 'x-client-request-id': 'request' }, { 'x-task-id': 'task' }, { 'x-session-affinity': 'cache' }]) {
    assert.throws(() => identity(headers, { prompt_cache_key: 'not-a-session' }), { code: 'native_session_identity_required' });
  }
  assert.throws(() => identity({ 'x-session-id': 'one' }, { metadata: { user_id: '{"session_id":"two"}' } }), { code: 'native_session_identity_conflict' });
  for (const value of ['', ' ', ['one', 'two'], 123, 'a'.repeat(257)]) assert.throws(() => identity({ 'x-session-id': value }), { code: 'native_session_identity_invalid' });
});

test('native scope binds identity to principal and does not expose raw identity', () => {
  const body = { metadata: { user_id: '{"session_id":"same"}' } };
  const first = nativeConversationScope({ authorization: 'principal-one' }, body);
  assert.notEqual(first, nativeConversationScope({ authorization: 'principal-two' }, body));
  assert.equal(first, nativeConversationScope({ authorization: 'principal-one', 'x-session-id': 'same' }, {}));
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
});
