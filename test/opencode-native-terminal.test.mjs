import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const source = process.env.OPENCODE_NATIVE_SOURCE, bun = process.env.OPENCODE_NATIVE_BUN;

test('late native scope failure cannot commit executable terminal output', { skip: !source || !bun, timeout: 15000 }, async () => {
  const script = path.join(source, 'packages/sdk/src', 'tokligence-terminal-' + randomUUID() + '.ts');
  await writeFile(script, `import { Effect, Stream, Exit } from "effect"
import { createChatEncoder, createTerminalGate } from "./tokligence-bridge-wire.mjs"
async function run(fail: boolean) {
 const encoder = createChatEncoder({model:"fixture",id:"terminal"})
 const gate = createTerminalGate()
 const visible: unknown[] = []
 const events = Stream.unwrap(Effect.gen(function* () {
  if(fail) yield* Effect.addFinalizer(() => Effect.die(new Error("Synthetic late finalizer failure")))
  return Stream.make({type:"tool-call",id:"one",name:"Read",input:{}}, {type:"finish",reason:{normalized:"tool-calls"}})
 }))
 const exit = await Effect.runPromiseExit(Effect.scoped(Stream.runForEach(events, event => Effect.sync(() => {visible.push(...gate.push(event.type,encoder.push(event)))}))))
 const beforeSettlement = visible.length
 visible.push(...gate.settle(Exit.isSuccess(exit)))
 return {successful:Exit.isSuccess(exit),beforeSettlement,visibleTools:visible.filter((chunk:any)=>chunk.choices?.[0]?.delta?.tool_calls).length}
}
console.log(JSON.stringify([await run(false),await run(true)]))
`);
  let child;
  try {
    child = spawn(bun, ['run', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    let code;
    try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), [
      { successful: true, beforeSettlement: 0, visibleTools: 1 },
      { successful: false, beforeSettlement: 0, visibleTools: 0 },
    ]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await unlink(script);
  }
});
