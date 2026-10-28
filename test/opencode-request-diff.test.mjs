import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRequestJSON } from '../native/opencode/request-diff.mjs';

test('request comparison detects container types, nulls, missing fields and array lengths', () => {
  for (const [a, b] of [[[], {}], [{ content: [] }, { content: {} }], [{ content: '' }, { content: null }], [{ optional: false }, {}], [[1], [1, 2]], [{ x: null }, {}]]) assert.ok(diffRequestJSON(a, b).length);
  assert.deepEqual(diffRequestJSON({ a: [{ b: ' 🌍 ', c: false }], z: null }, { z: null, a: [{ c: false, b: ' 🌍 ' }] }), []);
  assert.equal(diffRequestJSON({ 'a/b': 1 }, { 'a/b': 2 })[0].path, '/a~1b');
});
