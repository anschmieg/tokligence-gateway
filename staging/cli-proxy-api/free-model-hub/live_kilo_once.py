#!/usr/bin/env python3
"""One explicit free Kilo live acceptance. No retries, redirects or fallback."""
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
ID='cliproxy-kilo-live-20261102-v1'
MODEL='kilo-kilo/nvidia/nemotron-3.5-lightning:free'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def main():
    os.umask(0o077)
    lock=(ROOT/'state/kilo-live.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    journal=ROOT/(ID+'.json')
    if journal.exists(): raise RuntimeError('existing reservation; never replay')
    deployed=json.loads((ROOT/'freehub-deployment-v1.json').read_text())
    if deployed['phase']!='deployed': raise RuntimeError('deployment not admitted')
    address=next(ipaddress.ip_address(a) for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
    base='http://'+str(address)+':8080'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    management=(ROOT/'secrets/management.key').read_text().strip()
    client=(ROOT/'secrets/client-api-key').read_text().strip()
    def get(path,key=management):
        request=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+key})
        with opener.open(request,timeout=15) as response:return json.load(response)
    retry=get('/v8/management/config/routing/retry')
    if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1:
        raise RuntimeError('dispatch policy differs')
    plugin=get('/v8/management/config/plugins/configs/free-model-hub')
    if plugin.get('keepalive_enabled') is not False or plugin.get('blocked_vendors')!='opencodezen,opencodego,openrouter':
        raise RuntimeError('provider policy differs')
    models=get('/v1/models',client)['data']
    if sum(m['id']==MODEL for m in models)!=1: raise RuntimeError('explicit free model not published')
    files=get('/v8/management/credentials')['files']
    if sum(f['name']=='kilo-free.json' and not f.get('disabled') for f in files)!=1:
        raise RuntimeError('single public Kilo credential missing')
    opencode=[f for f in files if f.get('provider')=='opencode']
    if not opencode or any(not f.get('disabled') for f in opencode):
        raise RuntimeError('OpenCode quarantine differs')
    evidence=[ROOT/'cliproxy-opencode-live-20261102-v1.json',ROOT/'cliproxy-openrouter-live-20261102-v1.json',Path('/home/agent/tokligence-staging/live-probe-ledger.json')]
    hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence}
    result=dict(id=ID,model=MODEL,provider='kilo',phase='reserved',
        caller_post_budget=1,caller_posts=0,automatic_retries=0,redirects=False,
        fallback=False,started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
    with journal.open('x') as output:json.dump(result,output)
    body=json.dumps(dict(model=MODEL,stream=True,max_tokens=64,
        messages=[dict(role='user',content='Say hi in one short sentence.')])).encode()
    request=urllib.request.Request(base+'/v1/chat/completions',data=body,
        headers={'Authorization':'Bearer '+client,'Content-Type':'application/json','X-Request-ID':ID})
    result.update(phase='dispatched',caller_posts=1)
    journal.write_text(json.dumps(result,indent=2)+'\n')
    try:
        try: response=opener.open(request,timeout=60)
        except urllib.error.HTTPError as error: response=error
        with response:
            raw=response.read(1024*1024+1)
            result['http_status']=response.code
        if len(raw)>1024*1024: raise RuntimeError('response exceeds bound')
        frames=[];done=False
        for line in raw.splitlines():
            if not line.startswith(b'data:'):continue
            payload=line[5:].strip()
            if payload==b'[DONE]':done=True
            elif payload:frames.append(json.loads(payload))
        choices=[choice for frame in frames for choice in frame.get('choices',[])]
        result.update(done=done,nonempty_text=any(c.get('delta',{}).get('content') for c in choices),
            finish_reasons=sorted({c['finish_reason'] for c in choices if c.get('finish_reason')}),
            response_bytes=len(raw),embedded_error=any('error' in f for f in frames))
        result['phase']='pass' if (result['http_status']==200 and done and result['nonempty_text'] and not result['embedded_error'] and 'stop' in result['finish_reasons']) else 'failed'
    except Exception as error:
        result.update(phase='failed',error_type=type(error).__name__)
    result['prior_evidence_unchanged']=all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==sha for p,sha in hashes.items())
    journal.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))

if __name__=='__main__':main()
