// One-shot official CLI control only. Supported plugin API; original Bun fetch/TLS.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = process.env.OPENCODE_PROBE_DIR;
const endpoint = process.env.OPENCODE_PROBE_ENDPOINT;
const model = process.env.OPENCODE_PROBE_MODEL;
const expectedAuth = process.env.OPENCODE_PROBE_AUTH_SHA256;
const expectedOrg = process.env.OPENCODE_PROBE_ORG || '';
const save = (name, value, exclusive = false) => writeFileSync(`${dir}/${name}.json`, JSON.stringify(value), {mode:0o600,flag:exclusive?'wx':'w'});
const fail = () => { throw new Error('Official CLI single-request guard refused operation'); };
const validate = async request => {
  if (request.url !== endpoint || request.method !== 'POST') fail();
  if (createHash('sha256').update(request.headers.get('authorization') || '').digest('hex') !== expectedAuth) fail();
  if ((request.headers.get('x-opencode-org-id') || '') !== expectedOrg) fail();
  const body = await request.clone().json();
  const limits = [body.max_tokens,body.max_completion_tokens].filter(x=>x!==undefined);
  if (body.model!==model || body.stream!==true || limits.length!==1 || !Number.isInteger(limits[0]) || limits[0]<1 || limits[0]>1024 || (body.n!==undefined && body.n!==1) || (body.tools?.length)) fail();
  return {model,output_limit:limits[0],output_limit_field:body.max_tokens===undefined?'max_completion_tokens':'max_tokens',header_names:[...request.headers.keys()].sort(),user_agent:request.headers.get('user-agent')};
};
export default {
  id:'official-cli-single-control',
  async setup(ctx) {
    const nativeFetch=globalThis.fetch;
    let pendingResponse;
    const guardedFetch=async(req)=>{
      // Only this configured inference destination may leave the process.
      const metadata=await validate(req);
      save('physical-request',metadata,true);
      const response=await nativeFetch(req,{redirect:'manual',signal:AbortSignal.any([req.signal,AbortSignal.timeout(45000)])});
      const result={status:response.status,retry_after:response.headers.get('retry-after'),request_id:response.headers.get('x-opencode-log-id')||response.headers.get('x-request-id')};
      if(response.status>=300){
        let raw='';const reader=response.clone().body?.getReader();
        if(reader){let size=0;const chunks=[];while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768){void reader.cancel();break;}chunks.push(part.value);}if(size<=32768)raw=Buffer.concat(chunks).toString('utf8');}
        try{const value=JSON.parse(raw);const err=value.error||value;for(const k of ['type','code','_tag'])if(typeof err[k]==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(err[k]))result[k]=err[k];if(typeof err.retry_at==='string'&&err.retry_at.length<80)result.retry_at=err.retry_at;}catch{}
      }
      save('provider-response',result);
      return response;
    };
    await ctx.session.hook('context',event=>{event.tools={};});
    await ctx.session.hook('title',event=>{event.result='Official CLI control';});
    await ctx.session.hook('retry',event=>{event.decision={retry:false};});
    await ctx.session.hook('http.request',async event=>{
      if(event.kind!=='primary')fail();
      save('logical-request',await validate(event.request),true);
      pendingResponse=await guardedFetch(event.request);
      event.request=new Request(process.env.OPENCODE_PROBE_BRIDGE,{method:'GET'});
    });
    await ctx.session.hook('http.response',event=>{
      if(event.request.url!==process.env.OPENCODE_PROBE_BRIDGE || !pendingResponse)fail();
      event.response=pendingResponse;pendingResponse=undefined;
    });
    save('guard-ready',{native_transport:true,retries:false,redirects:false,limit:1});
    return ()=>{void pendingResponse?.body?.cancel();};
  }
};
