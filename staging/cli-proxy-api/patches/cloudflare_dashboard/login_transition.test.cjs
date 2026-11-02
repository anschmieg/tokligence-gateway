// Execute the actual LoginPage render branch, without an authenticated browser.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2];
const ts = require(path.join(root, 'node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'src/pages/LoginPage.tsx'), 'utf8');
const start = source.indexOf('  if (isAuthenticated &&');
const end = source.indexOf('  return (\n    <div className={styles.container}', start);
assert(start > 0 && end > start, 'pinned render seam exists');
const js = ts.transpileModule(`function render(isAuthenticated, autoLoading, autoLoginSuccess, phase, access) {
 const isCloudflareAccessHost = () => access;
 const redirectTarget = '/';
 ${source.slice(start, end)}
 return null;
}`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
const Navigate = function Navigate() {};
const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
const render = new Function('React', 'Navigate', js + ';return render;')(React, Navigate);
for (const state of [[true,true,false,'idle'], [true,false,true,'idle'], [true,false,true,'exiting'], [true,false,false,'idle']]) {
 assert.equal(render(...state, true).type, Navigate, 'Access success redirects immediately, including animation interval');
}
const pending = JSON.stringify(render(false,true,false,'idle',true));
assert(pending.includes('Checking your Cloudflare Access session'));
assert(!pending.includes('validation failed'));
assert(!pending.includes('Retry gateway session'));
const failed = JSON.stringify(render(false,false,false,'idle',true));
assert(failed.includes('validation failed'));
assert(failed.includes('Retry gateway session'));
assert.equal(render(true,false,true,'idle',false), null, 'ordinary native login keeps its transition');
console.log('PASS: successful Access states redirect; pending/failure/native states remain distinct');
