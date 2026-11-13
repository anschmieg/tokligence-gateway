#!/usr/bin/env python3
"""User-authorized live evaluation of new free providers and native rotation.

One deliberate request per new key plus two independent canonical requests and one qualified OpenRouter control.
No forced credentials, retries, redirects, OAuth changes or model-ID mutations.
Tokens never leave the host. Reports retain selection labels, not auth indexes.
Third-party routers' internal dispatches are not observable here.
"""
import collections,copy,fcntl,hashlib,ipaddress,json,os,time,urllib.error,urllib.request
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def main():
 os.umask(0o077)
 state=ROOT/'state/provider-rotation-20261102-v1';state.mkdir(mode=0o700,exist_ok=True)
 lock=(ROOT/'state/provider-acceptance-20261102/run.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 deploy_lock=(ROOT/'state/freehub-deployment.lock').open('a');fcntl.flock(deploy_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 key=(ROOT/'secrets/management.key').read_text().strip();client=(ROOT/'secrets/client-api-key').read_text().strip()
 address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4);base='http://'+address+':8080'
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 def get(path,secret=key):
  with opener.open(urllib.request.Request(base+path,headers={'Authorization':'Bearer '+secret}),timeout=20) as response:return json.load(response),response.headers.get('ETag')
 config,_=get('/v8/management/config');retry=config.get('routing',{}).get('retry',{})
 if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1 or config.get('requests',{}).get('streaming',{}).get('bootstrap-retries',0)!=0:raise RuntimeError('single dispatch admission differs')
 artifacts=json.loads((ROOT/'model-catalog-routing-deployment-v1.json').read_text())
 for rel,field in [('bin/cli-proxy-api','backend_sha256'),('plugins/free-model-hub.so','plugin_sha256')]:
  if hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()!=artifacts[field]:raise RuntimeError('deployed artifact differs')
 providers,etag=get('/v8/management/config/api-keys/openai-compatibility');selected={p['name'].lower():p for p in providers}
 if any(name not in selected for name in ['orcarouter','unorouter','requesty']):raise RuntimeError('new provider absent')
 # Avoid HTTP-level replay through automatic redirects on newly configured lanes.
 flagjournal=state/'redirect-policy.json'
 if not flagjournal.exists():
  updated=copy.deepcopy(providers)
  for p in updated:
   if p['name'].lower() in ['orcarouter','unorouter','requesty']:p['disable-redirects']=True
  if updated!=providers:
   q=urllib.request.Request(base+'/v8/management/config/api-keys/openai-compatibility',method='PUT',data=json.dumps(updated).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','If-Match':etag})
   with opener.open(q,timeout=20) as response:response.read()
  flagjournal.write_text(json.dumps({'configured':True,'scope':'Only disable-redirects=true for three new native providers; all other fields preserved.'})+'\n')
 providers,_=get('/v8/management/config/api-keys/openai-compatibility');index_map={};key_counts={}
 for p in providers:
  name=p['name'].lower();key_counts[name]=len(p.get('keys',[]))
  for i,k in enumerate(p.get('keys',[]),1):
   if k.get('auth_index'):index_map[k['auth_index']]=name+'-key-'+str(i)
 for e in get('/v8/management/credentials')[0]['files']:
  if e.get('name')=='kilo-free.json':index_map[e['auth_index']]='kilo-public'
 plan=[('orca-free','orca/z-ai/glm-5.3-flash-free'),('uno-free','uno/nemotron-3.5-lightning-30b-a3b:free')]
 if key_counts['requesty']!=4:raise RuntimeError('reviewed four-key Requesty scope changed')
 plan += [('requesty-'+str(i),'requesty/nvidia/nemotron-3.5-lightning-30b-a3b') for i in range(1,5)]
 plan += [('canonical-'+str(i),'nemotron-3.5-lightning') for i in range(1,3)]
 plan += [('openrouter-direct','openrouter/nemotron-3.5-lightning-free')]
 if not (ROOT/'state/openrouter-price-priority-v1.json').exists():raise RuntimeError('reviewed equal-priority operation missing')
 plan += [('balanced-canonical-'+str(i),'nemotron-3.5-lightning') for i in range(1,3)]
 models={m['id'] for m in get('/v1/models',client)[0]['data']}
 if any(model not in models for case,model in plan if not (state/(case+'.json')).exists()):raise RuntimeError('new planned published model missing')
 protected=[p for p in (ROOT/'auth').glob('*.json') if json.loads(p.read_text()).get('type')=='opencode']+list(ROOT.glob('cliproxy-*-live-20261102-v1*.json'))
 protected.append(Path('/home/agent/tokligence-staging/live-probe-ledger.json'))
 hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
 results=[]
 for case,model in plan:
  journal=state/(case+'.json')
  if journal.exists():results.append(json.loads(journal.read_text()));continue
  result={'case':case,'model':model,'phase':'reserved','caller_posts':0,'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'automatic_retries':0,'forced_selection':False}
  with journal.open('x') as output:json.dump(result,output)
  def save():journal.write_text(json.dumps(result,indent=2)+'\n')
  request_id='gateway-rotation-20261102-v1-'+case
  body={'model':model,'stream':True,'max_tokens':1024,'messages':[{'role':'user','content':'Reply with exactly OK. Do not explain. Test nonce: '+request_id}]}
  request=urllib.request.Request(base+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+client,'Content-Type':'application/json','X-Request-ID':request_id,'Idempotency-Key':request_id})
  result.update(phase='dispatched',caller_posts=1);save();began=time.monotonic()
  try:
   try:response=opener.open(request,timeout=60)
   except urllib.error.HTTPError as error:response=error
   with response:
    result['http_status']=response.code;trace=response.headers.get('X-CPA-TRACE-ID','');result['selected_credential']=next((label for index,label in index_map.items() if '-'+index+'-' in trace),None)
    result['selection_trace_present']=bool(trace);result['retry_after']=response.headers.get('Retry-After');raw=response.read(1024*1024+1)
   if len(raw)>1024*1024:raise RuntimeError('response exceeds bound')
   frames=[];done=False
   for line in raw.splitlines():
    if line.startswith(b'data:'):
     data=line[5:].strip()
     if data==b'[DONE]':done=True
     elif data:frames.append(json.loads(data))
   choices=[c for f in frames for c in f.get('choices',[])]
   result.update(done=done,nonempty_text=any(c.get('delta',{}).get('content') for c in choices),finish_reasons=sorted({c['finish_reason'] for c in choices if c.get('finish_reason')}),embedded_error=any('error' in f for f in frames),response_bytes=len(raw))
   if result['http_status']>=300 or result['embedded_error']:
    (state/(case+'.error.private')).write_bytes(raw)
    try:error=json.loads(raw).get('error',{})
    except ValueError:error={}
    if isinstance(error,dict):
     result['error_code']=str(error.get('code',error.get('type','')))[:90]
     metadata=error.get('metadata',{})
     if isinstance(metadata,dict):result['error_reason']=str(metadata.get('reason',''))[:80]
   result['phase']='pass' if result['http_status']==200 and done and result['nonempty_text'] and 'stop' in result['finish_reasons'] and not result['embedded_error'] else 'failed'
  except Exception as error:result.update(phase='uncertain' if isinstance(error,(TimeoutError,OSError)) else 'failed',error_type=type(error).__name__)
  result['elapsed_seconds']=round(time.monotonic()-began,2);save();results.append(result);print(json.dumps(result),flush=True)
 summary={'provider_inference_calls':sum(x.get('caller_posts',0) for x in results),'key_counts':key_counts,'openrouter_priority':next(p.get('priority',0) for p in providers if p['name'].lower()=='openrouter'),'cases':results,'requesty_selected_credentials':sorted({x.get('selected_credential') for x in results if x['case'].startswith('requesty-') and x.get('selected_credential')}),'balanced_provider_sequence':[x.get('selected_credential') for x in results if x['case'].startswith('balanced-canonical-')],'canonical_selected_credentials':[x.get('selected_credential') for x in results if x['case'].startswith('canonical-')],'protected_state_unchanged':all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in hashes.items())}
 (state/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({'summary_path':str(state/'summary.json'),'protected_state_unchanged':summary['protected_state_unchanged']}))
if __name__=='__main__':main()
