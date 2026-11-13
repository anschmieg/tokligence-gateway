#!/usr/bin/env python3
"""One normal Chat inference per explicitly admitted native OAuth provider."""
import fcntl,hashlib,ipaddress,json,os,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None

def main():
 os.umask(0o077);state=ROOT/'state/provider-acceptance-20261102'
 lock=(state/'run.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 deployed=json.loads((ROOT/'provider-acceptance-safety-deployment-v1.json').read_text())
 if deployed.get('phase')!='deployed':raise RuntimeError('bounded runtime not deployed')
 if hashlib.sha256((ROOT/'bin/cli-proxy-api').read_bytes()).hexdigest()!=deployed['backend_sha256']:raise RuntimeError('runtime identity differs')
 address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4);base='http://'+address+':8080'
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 management=(ROOT/'secrets/management.key').read_text().strip();client=(ROOT/'secrets/client-api-key').read_text().strip()
 def get(path,key=management):
  q=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+key})
  with opener.open(q,timeout=15) as response:return json.load(response)
 config=get('/v8/management/config');retry=config.get('routing',{}).get('retry',{})
 if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1:raise RuntimeError('retry policy differs')
 if config.get('oauth',{}).get('providers',{}).get('antigravity',{}).get('antigravity-credits',False):raise RuntimeError('credits fallback enabled')
 models={m['id'] for m in get('/v1/models',client)['data']};entries=get('/v8/management/credentials')['files']
 protected=[ROOT/'cliproxy-opencode-live-20261102-v1.json',ROOT/'cliproxy-openrouter-live-20261102-v1.json',Path('/home/agent/tokligence-staging/live-probe-ledger.json')]
 hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
 for provider,model in [('antigravity','gemini-3.1-flash-lite'),('codex','gpt-6-luna')]:
  journal=state/(provider+'-live-v1.json')
  if journal.exists():print(json.dumps({'provider':provider,'phase':'skipped_existing_journal'}),flush=True);continue
  rules=config.get('oauth',{}).get('request-scoped-errors',{}).get(provider,[])
  if not rules or rules[0]!={'status':401,'match-regexr':['(?s).*'],'action':'stop-and-cooldown'}:raise RuntimeError('401 stop policy missing')
  accounts=[x for x in entries if x.get('provider')==provider and not x.get('disabled')]
  if len(accounts)!=1 or model not in models:print(json.dumps({'provider':provider,'phase':'not_ready'}),flush=True);continue
  account=accounts[0]
  if account.get('unavailable') or account.get('quota_blocked') or account.get('requires_sign_in'):
   print(json.dumps({'provider':provider,'phase':'held_by_native_state'}),flush=True);continue
  for path in (ROOT/'auth').glob('*.json'):
   raw=json.loads(path.read_text())
   if raw.get('type')==provider and any(raw.get(k) for k in ('request_scoped_errors','request-scoped-errors')):raise RuntimeError('credential overrides 401 policy')
  result=dict(provider=provider,model=model,phase='reserved',caller_posts=0,automatic_retries=0,redirects=False,fallback=False,started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
  with journal.open('x') as output:json.dump(result,output)
  body=dict(model=model,stream=False,max_tokens=1024,messages=[dict(role='user',content='Reply with exactly: OK')])
  if provider=='codex':body['reasoning_effort']='low'
  q=urllib.request.Request(base+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+client,'Content-Type':'application/json','X-Request-ID':'gateway-'+provider+'-acceptance-20261102-v1'})
  result.update(phase='dispatched',caller_posts=1);journal.write_text(json.dumps(result,indent=2)+'\n');begin=time.monotonic()
  try:
   try:response=opener.open(q,timeout=60)
   except urllib.error.HTTPError as error:response=error
   with response:result['http_status']=response.code;raw=response.read(1024*1024+1)
   if len(raw)>1024*1024:raise RuntimeError('response exceeds bound')
   payload=json.loads(raw);choices=payload.get('choices',[])
   result.update(nonempty_text=any(c.get('message',{}).get('content') for c in choices),finish_reasons=sorted({c['finish_reason'] for c in choices if c.get('finish_reason')}),embedded_error='error' in payload,response_bytes=len(raw))
   if 'error' in payload:
    error=payload['error'];result['error_code']=str(error.get('code',error.get('type','')))[:80] if isinstance(error,dict) else 'unstructured'
    (state/(provider+'-error.private')).write_bytes(raw)
   result['phase']='pass' if result['http_status']==200 and result['nonempty_text'] and 'stop' in result['finish_reasons'] and not result['embedded_error'] else 'failed'
  except Exception as error:result.update(phase='failed',error_type=type(error).__name__)
  result['elapsed_seconds']=round(time.monotonic()-begin,2);result['prior_evidence_unchanged']=all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==sha for p,sha in hashes.items())
  journal.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
if __name__=='__main__':main()
