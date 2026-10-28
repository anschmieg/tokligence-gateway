import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;
test('request scope closes an unread native response before GC and preserves HTTP hooks', { skip: !source || !bun, timeout: 20000 }, async () => {
  const script = path.join(source, 'packages/sdk/src', 'tokligence-scope-test-' + randomUUID() + '.ts');
  const closed = new Map(), captures = [];
  const server = http.createServer((req, res) => {
    captures.push({ path: req.url, hook: req.headers['x-fixture-hook'] });
    res.on('close', () => closed.set(req.url, true));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': deliberately unread body\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const code = `import { Effect } from "effect"
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http"
import { scopedHttp } from "./tokligence-scoped-http"
const controller = new AbortController()
const retained: unknown[] = []
const scoped = process.argv[2] !== "baseline"
let doubleDenied = false
await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
 const client = yield* HttpClient.HttpClient
 const scope = yield* Effect.scope
 const request = HttpClientRequest.get(process.argv[3])
 const middleware = scopedHttp(scope, (req, next) => next(HttpClientRequest.setHeader(req, "x-fixture-hook", "preserved")))
 const response = yield* (scoped ? middleware(request, req => client.execute(req)) : client.execute(request))
 retained.push(response)
 if (process.argv[2] === "double") {
   const second = yield* Effect.exit(middleware(request, req => client.execute(req)))
   doubleDenied = second._tag === "Failure"
 }
 setTimeout(() => controller.abort(), 10)
 yield* Effect.never
})).pipe(Effect.provide(FetchHttpClient.layer)), { signal: controller.signal })
if (process.argv[2] === "double" && !doubleDenied) throw new Error("Second physical dispatch was not refused")
console.log("scope-finalized")
await new Promise(resolve => process.stdin.once("data", resolve))
retained.length = 0
process.exit(0)
`;
  await writeFile(script, code);
  const children = [];
  try {
    for (const mode of ['baseline', 'scoped', 'double']) {
      const child = spawn(bun, ['run', script, mode, `http://127.0.0.1:${server.address().port}/${mode}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); let errors = ''; child.stderr.on('data', value => { errors += value; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Scoped HTTP fixture timed out: ' + errors)), 5000);
        child.once('exit', code => { clearTimeout(timer); reject(new Error('Scoped HTTP fixture exited ' + code + ': ' + errors)); });
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      });
      // Keep the response strongly referenced and the process alive. Any close
      // must come from scope finalization, not GC or process teardown.
      for (let i = 0; i < 25 && !closed.get('/' + mode); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(Boolean(closed.get('/' + mode)), mode !== 'baseline');
      child.stdin.write('finish\n'); await once(child, 'exit');
    }
    assert.equal(captures.length, 3, "second middleware call never reaches the provider");
    assert.equal(captures[1].hook, 'preserved');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await unlink(script);
  }
});
