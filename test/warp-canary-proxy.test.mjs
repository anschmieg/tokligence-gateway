import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import test from "node:test";

async function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),"warp-canary-"));
  chmodSync(dir,0o700);
  const realGatewaySecret="LOCAL-UPSTREAM-ONLY-"+"b".repeat(40);
  const testSecret="LOCAL-TRIAL-ONLY-"+"c".repeat(40);
  let seen=0,authOk=true;
  const upstream=http.createServer((req,res)=>{
    seen++;
    authOk &&= req.headers.authorization==="Bearer "+realGatewaySecret;
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.write('data: {"choices":[{"delta":{"content":"WARPCTX_STDERR_CC11DD"}}]}');
    res.end("\n\ndata: [DONE]\n\n");
  });
  upstream.listen(0,"127.0.0.1");
  await once(upstream,"listening");
  const port=upstream.address().port;
  const portProbe=http.createServer();
  portProbe.listen(0,"127.0.0.1");await once(portProbe,"listening");
  const canaryPort=portProbe.address().port;
  await new Promise(resolve=>portProbe.close(resolve));
  const child=spawn(process.execPath,["research/warp/canary-proxy.mjs"],{
    cwd:process.cwd(),
    stdio:["ignore","pipe","pipe"],
    env:{
      ...process.env,
      WARP_TRACE_ENABLED:"1",WARP_TRACE_MODEL:"warp-exp-model",
      WARP_TRACE_TEST_SECRET:testSecret,
      WARP_CANARY_UPSTREAM_SECRET:realGatewaySecret,
      WARP_CANARY_UPSTREAM_URL:"http://127.0.0.1:"+port,
      WARP_TRACE_DIR:dir,WARP_TRACE_MAX_REQUESTS:"2",
      WARP_TRACE_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),
      WARP_CANARY_PORT:String(canaryPort),
    },
  });
  let ready=false,stderr="";
  child.stderr.on("data",chunk=>stderr+=chunk.toString());
  child.stdout.on("data",chunk=>{if(chunk.toString().includes("warp-canary ready"))ready=true;});
  for(let i=0;i<50 && !ready;i++)await new Promise(resolve=>setTimeout(resolve,50));
  if(!ready)throw Error("Canary failed startup: "+stderr);
  const url="http://127.0.0.1:"+canaryPort;
  const close=async()=>{
    child.kill("SIGTERM");await Promise.race([once(child,"exit"),new Promise(r=>setTimeout(r,400))]);
    await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true});
  };
  return {url,dir,testSecret,close,get seen(){return seen;},get authOk(){return authOk;}};
}
test("trial auth, single-model routing, markers, and 2-request cap",async t=>{
  const x=await fixture();t.after(x.close);
  let r=await fetch(x.url+"/v1/models");
  assert.equal(r.status,401);
  const headers={authorization:"Bearer "+x.testSecret,"content-type":"application/json"};
  r=await fetch(x.url+"/v1/models",{headers});
  assert.equal(r.status,200);assert.deepEqual((await r.json()).data.map(x=>x.id),["warp-exp-model"]);
  const wrong={model:"normal",messages:[]};
  r=await fetch(x.url+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify(wrong)});
  assert.equal(r.status,403);assert.equal(x.seen,0);
  const req={model:"warp-exp-model",messages:[{role:"user",content:"WARPCTX_STDOUT_AABBCC"}],stream:true,max_tokens:1200};
  for(let i=0;i<2;i++){
    r=await fetch(x.url+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify(req)});
    assert.equal(r.status,200);
    assert.match(await r.text(),/WARPCTX_STDERR_CC11DD/);
  }
  r=await fetch(x.url+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify(req)});
  assert.equal(r.status,429);assert.equal(x.seen,2);assert.equal(x.authOk,true);
  const trace=readdirSync(x.dir).map(n=>JSON.parse(readFileSync(path.join(x.dir,n))));
  assert.equal(trace.length,2);
  for(const ev of trace){
    assert.deepEqual(ev.request_markers,["WARPCTX_STDOUT_AABBCC"]);
    assert.deepEqual(ev.response_markers,["WARPCTX_STDERR_CC11DD"]);
    const content=JSON.stringify(ev);
    assert.doesNotMatch(content,/LOCAL-UPSTREAM-ONLY|LOCAL-TRIAL-ONLY/);
  }
});
