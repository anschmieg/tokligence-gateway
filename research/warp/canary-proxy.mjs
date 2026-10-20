#!/usr/bin/env node
// Standalone, short-lived Warp experiment reverse proxy for the Tokligence host.
// This runs as a separate container; it DOES NOT alter the live tgw-proxy process.
// Requires exact trial bearer, an explicit model, a private trace dir and a 1-hour
// maximum expiry. The *real* gateway bearer remains only inside this container.
// See Linear D-15 and research/warp/README.md.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createWarpTraceRecorder } from "../../warp-context-trace.mjs";
import { createWarpExperimentGuard } from "../../warp-experiment-guard.mjs";

const env = process.env;
const guard = createWarpExperimentGuard(env);
const recorder = createWarpTraceRecorder(env);
const testSecret = env.WARP_TRACE_TEST_SECRET || "";
const upstreamSecret = env.WARP_CANARY_UPSTREAM_SECRET || "";
const model = env.WARP_TRACE_MODEL || "";
const upstream = env.WARP_CANARY_UPSTREAM_URL || "http://127.0.0.1:8080";
const port = Number(env.WARP_CANARY_PORT || 18293);
const endpoint = new URL(upstream);
if (!guard.configured || !recorder.isReady() || !testSecret || !upstreamSecret ||
    testSecret === upstreamSecret || endpoint.protocol !== "http:" ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("Warp canary refused startup: invalid expiry, credentials, trace directory or local upstream");
  process.exit(2);
}
function equal(a, b) {
  const aa=Buffer.from(String(a||"")), bb=Buffer.from(String(b||""));
  return aa.length===bb.length && timingSafeEqual(aa,bb);
}
function respond(res,status,message) {
  res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});
  res.end(JSON.stringify({error:message}));
}
function upstreamRequest(path, method, body, res, request, release = () => {}) {
  let closed=false;
  const onClose=()=>{ if (!closed) client.destroy(); release(); };
  const client = http.request({
    hostname:endpoint.hostname,port:endpoint.port || 80,method,
    path, headers:{
      "authorization":"Bearer "+upstreamSecret,
      "accept":request.headers.accept||"application/json",
      "content-type":"application/json",
      ...(body ? {"content-length":body.length} : {}),
    },
    timeout:90000,
  }, response => {
    if(res.headersSent) return;
    const headers={"content-type":response.headers["content-type"]||"application/json",
      "cache-control":"no-store"};
    res.writeHead(response.statusCode||502,headers);
    response.on("data",chunk => res.write(chunk));
    response.on("end",()=>{closed=true;res.end();release();});
    response.on("error",()=>{closed=true;res.end();release();});
  });
  res.once("close",onClose);
  client.on("timeout",()=>client.destroy(new Error("Warp experiment upstream timeout")));
  client.on("error",()=>{closed=true;if(!res.headersSent)respond(res,502,"Experiment upstream unavailable");else res.end();release();});
  if(body) client.end(body); else client.end();
}
const server=http.createServer((req,res)=>{
  if(req.method==="GET" && req.url==="/health") {
    // Deliberately no information beyond the canary's liveness
    res.writeHead(200,{"content-type":"application/json"});res.end('{"status":"ok"}');return;
  }
  if(!guard.configured || !recorder.isReady() || !equal((req.headers.authorization||"").replace(/^Bearer /,""),testSecret)) {
    respond(res,401,"Unauthorized");return;
  }
  const pathname=new URL(req.url||"/","http://localhost").pathname;
  if(req.method==="GET" && pathname==="/v1/models") {
    if(!guard.catalogAllowed()){respond(res,429,"Experiment model discovery expired");return;}
    // Narrow public surface to a single model, never disclose the complete gateway catalog
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
    res.end(JSON.stringify({object:"list",data:[{id:model,object:"model",owned_by:"warp-canary"}]}));return;
  }
  if(req.method!=="POST" || pathname!=="/v1/chat/completions"){respond(res,404,"Not found");return;}
  const parts=[];let count=0;let overflow=false;
  req.on("data",part=>{count+=part.length;if(count>65536){overflow=true;}else parts.push(part);});
  req.on("end",()=>{
    if(overflow){respond(res,413,"Experiment input too large");return;}
    let body;
    try {body=JSON.parse(Buffer.concat(parts).toString("utf8"));} catch {respond(res,400,"Invalid JSON");return;}
    const access=guard.reserve(body,count);
    if(!access.allowed){respond(res,access.status,access.reason);return;}
    recorder.begin({testPrincipal:true,request:req,response:res,body,protocol:"chat_completions"});
    const outbound=Buffer.from(JSON.stringify(body));
    upstreamRequest("/v1/chat/completions","POST",outbound,res,req,access.release);
  });
  req.on("error",()=>{if(!res.headersSent)respond(res,400,"Invalid request");});
});
server.listen(port,"0.0.0.0",()=>console.log("warp-canary ready, model-scoped, trace enabled"));
