import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWarpTraceRecorder } from "../warp-context-trace.mjs";

class Response {
  constructor() { this.chunks = []; this.statusCode = 200; }
  write(value) { this.chunks.push(String(value)); return true; }
  end(value) { if (value !== undefined) this.chunks.push(String(value)); return this; }
}
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "warp-trace-"));
  chmodSync(dir, 0o700);
  const env = {
    WARP_TRACE_ENABLED: "1",
    WARP_TRACE_MODEL: "warp-exp-model",
    WARP_TRACE_DIR: dir,
  };
  const body = {
    model: "warp-exp-model",
    stream: true,
    messages: [{role: "system", content: "WARPCTX_STDOUT_88AABB no unrelated contents"}, {role: "user", content: "diagnose"}],
    tools: [{type: "function", function: {name: "shell_exec", parameters: {type: "object"}}}],
    reasoning_effort: "high",
  };
  return {dir, env, body, close: () => rmSync(dir, {recursive:true,force:true})};
}
function events(dir) {
  return readdirSync(dir).map(f => JSON.parse(readFileSync(path.join(dir,f), "utf8")));
}
test("marker-only trace contains roles, tools and markers but no arbitrary prompt", t => {
  const x=fixture(); t.after(x.close);
  const res=new Response();
  assert.equal(createWarpTraceRecorder(x.env).begin({testPrincipal:true,response:res,body:x.body}),true);
  res.write('data: {"delta":"WARPCTX_GIT_123DEF"}');
  res.end('data: [DONE]');
  assert.deepEqual(res.chunks, ['data: {"delta":"WARPCTX_GIT_123DEF"}','data: [DONE]']);
  const ev=events(x.dir)[0];
  assert.equal(ev.schema,"warp-context-trace/v1");
  assert.deepEqual(ev.request_markers,["WARPCTX_STDOUT_88AABB"]);
  assert.deepEqual(ev.response_markers,["WARPCTX_GIT_123DEF"]);
  assert.deepEqual(ev.message_roles,["system","user"]);
  assert.deepEqual(ev.tool_names,["shell_exec"]);
  assert.equal(ev.reasoning_effort,"high");
  assert.ok(!JSON.stringify(ev).includes("unrelated contents"));
});
test("disabled recorder or wrong identity or model never writes",t=>{
  const x=fixture();t.after(x.close);
  assert.equal(createWarpTraceRecorder({...x.env,WARP_TRACE_ENABLED:"0"}).begin({testPrincipal:true,response:new Response(),body:x.body}),false);
  assert.equal(createWarpTraceRecorder(x.env).begin({testPrincipal:false,response:new Response(),body:x.body}),false);
  assert.equal(createWarpTraceRecorder(x.env).begin({testPrincipal:true,response:new Response(),body:{...x.body,model:"normal"}}),false);
  assert.deepEqual(events(x.dir),[]);
});
test("world-readable directory is rejected and transport remains untouched",t=>{
  const x=fixture();t.after(x.close);chmodSync(x.dir,0o755);
  const res=new Response();
  assert.equal(createWarpTraceRecorder(x.env).begin({testPrincipal:true,response:res,body:x.body}),false);
  res.write("ok");res.end();assert.deepEqual(res.chunks,["ok"]);assert.deepEqual(events(x.dir),[]);
});
test("recorder errors never block original streaming or end",t=>{
  const x=fixture();t.after(x.close);
  const res=new Response();
  createWarpTraceRecorder(x.env).begin({testPrincipal:true,response:res,body:x.body});
  chmodSync(x.dir,0o500);
  res.write("WARPCTX_STDERR_A1B2C3");
  res.end("still-complete");
  assert.deepEqual(res.chunks,["WARPCTX_STDERR_A1B2C3","still-complete"]);
});
test("request without secret values in trace despite payload secret",t=>{
  const x=fixture();t.after(x.close);
  x.body.messages[0].content += " Bearer supersecret0123456789";
  const res=new Response();
  createWarpTraceRecorder(x.env).begin({testPrincipal:true,response:res,body:x.body});
  res.end("done");
  const s=readFileSync(path.join(x.dir,readdirSync(x.dir)[0]),"utf8");
  assert.ok(!s.includes("supersecret0123456789"));
  assert.ok(!s.includes("Bearer"));
});
