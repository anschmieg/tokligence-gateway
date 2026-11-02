#!/usr/bin/env python3
"""Explicit one-call checks of already-published, user-configured API-key lanes.
No credential rotation, OAuth, model fallback, redirects, or automatic retries.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT=Path('/home/agent/cliproxy-staging')
PLAN=[('nvidia','nvidia-nvidia/z-ai/glm-5.3-flash',1024),
      ('zai','zai-zai/glm-4.7-flash',1024)]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider",required=True,choices=["nvidia","zai"])
    args=parser.parse_args()
    os.umask(0o077)
    state=ROOT/'state/provider-acceptance-20261102';state.mkdir(mode=0o700,exist_ok=True)
    lock=(state/'run.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    management=(ROOT/'secrets/management.key').read_text().strip()
    client=(ROOT/'secrets/client-api-key').read_text().strip()
    address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
    base='http://'+address+':8080'
    def get(path,key=management):
        req=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+key})
        with opener.open(req,timeout=15) as response:return json.load(response)
    retry=get('/v8/management/config/routing/retry')
    if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1:
        raise RuntimeError('dispatch budget differs')
    deployment=json.loads((ROOT/('freehub-zai-free-deployment-v1.json' if args.provider=='zai' else 'provider-acceptance-safety-deployment-v1.json')).read_text())
    if deployment.get('phase')!='deployed':raise RuntimeError('reviewed plugin not deployed')
    if hashlib.sha256((ROOT/'plugins/free-model-hub.so').read_bytes()).hexdigest()!=deployment['plugin_sha256']:
        raise RuntimeError('plugin identity differs')
    models={m['id'] for m in get('/v1/models',client)['data']}
    protected=[ROOT/'cliproxy-opencode-live-20261102-v1.json',ROOT/'cliproxy-openrouter-live-20261102-v1.json',ROOT/'cliproxy-kilo-live-20261102-v1.json',ROOT/'cliproxy-kilo-live-20261102-v1-diagnostic.json',Path('/home/agent/tokligence-staging/live-probe-ledger.json')]
    hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    for provider,model,limit in PLAN:
        if provider != args.provider: continue
        first=json.loads((state/(provider+'-live-v1.json')).read_text())
        if first.get('phase')!='failed' or first.get('caller_posts')!=1: raise RuntimeError('diagnostic not admitted')
        journal=state/(provider+'-live-v2.json')
        if journal.exists():
            print(json.dumps({'provider':provider,'phase':'skipped_existing_journal'}),flush=True);continue
        candidates=[]
        for path in (ROOT/'auth').glob('*.json'):
            data=json.loads(path.read_text())
            if data.get('vendor')==provider and not data.get('disabled'):candidates.append(data)
        if model not in models or not candidates:
            print(json.dumps({'provider':provider,'phase':'not_ready'}),flush=True);continue
        if any(any(data.get(k) for k in ('refreshToken','refresh_token','refresh')) for data in candidates):
            raise RuntimeError('OAuth credential entered API-key-only plan')
        result=dict(provider=provider,model=model,phase='reserved',caller_posts=0,
            credential_count=len(candidates),automatic_retries=0,redirects=False,
            fallback=False,started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
        with journal.open('x') as output:json.dump(result,output)
        body=json.dumps(dict(model=model,stream=True,max_tokens=limit,
            messages=[dict(role='user',content='Reply with exactly: OK')])).encode()
        req=urllib.request.Request(base+'/v1/chat/completions',data=body,headers={
            'Authorization':'Bearer '+client,'Content-Type':'application/json',
            'X-Request-ID':'gateway-'+provider+'-acceptance-20261102-v2'})
        result.update(phase='dispatched',caller_posts=1);journal.write_text(json.dumps(result,indent=2)+'\n')
        began=time.monotonic()
        try:
            try:response=opener.open(req,timeout=45)
            except urllib.error.HTTPError as error:response=error
            with response:
                result['http_status']=response.code
                raw=response.read(1024*1024+1)
                result['retry_after_present']=bool(response.headers.get('Retry-After'))
            if len(raw)>1024*1024:raise RuntimeError('response exceeds bound')
            frames=[];done=False
            for line in raw.splitlines():
                if not line.startswith(b'data:'):continue
                payload=line[5:].strip()
                if payload==b'[DONE]':done=True
                elif payload:frames.append(json.loads(payload))
            choices=[c for frame in frames for c in frame.get('choices',[])]
            result.update(done=done,nonempty_text=any(c.get('delta',{}).get('content') for c in choices),
                finish_reasons=sorted({c['finish_reason'] for c in choices if c.get('finish_reason')}),
                embedded_error=any('error' in frame for frame in frames),response_bytes=len(raw))
            if result['http_status']>=300:
                try:error=json.loads(raw).get('error',{})
                except ValueError:error={}
                if isinstance(error,dict):result['error_code']=str(error.get('code',error.get('type','')))[:80]
                # Raw failure kept private, never printed or committed.
                (state/(provider+'-v2-error.private')).write_bytes(raw)
            result['phase']='pass' if result['http_status']==200 and done and result['nonempty_text'] and 'stop' in result['finish_reasons'] and not result['embedded_error'] else 'failed'
        except Exception as error:
            result.update(phase='failed',error_type=type(error).__name__)
        result['elapsed_seconds']=round(time.monotonic()-began,2)
        result['prior_evidence_unchanged']=all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==sha for p,sha in hashes.items())
        journal.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)

if __name__=='__main__':main()
