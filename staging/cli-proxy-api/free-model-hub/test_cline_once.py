#!/usr/bin/env python3
"""One native-owner Cline refresh when expired, then one free-route inference.
Private credentials remain in the gateway. No retries, fallback or token export.
"""
import fcntl, hashlib, ipaddress, json, os, time, urllib.error, urllib.request
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging')
MODEL='cline-cline-free/solar-mini4'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw): return None

def main():
    os.umask(0o077)
    state=ROOT/'state/provider-acceptance-20261102'
    lock=(state/'run.lock').open('a'); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    deployed=json.loads((ROOT/'freehub-cline-attribution-deployment-v1.json').read_text())
    if deployed.get('phase')!='deployed' or hashlib.sha256((ROOT/'plugins/free-model-hub.so').read_bytes()).hexdigest()!=deployed['plugin_sha256']:
        raise RuntimeError('reviewed ownership correction not deployed')
    address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
    base='http://'+address+':8080'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    management=(ROOT/'secrets/management.key').read_text().strip()
    client=(ROOT/'secrets/client-api-key').read_text().strip()
    def call(path,body=None,key=management,timeout=20):
        q=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        try: response=opener.open(q,timeout=timeout)
        except urllib.error.HTTPError as error: response=error
        with response:return response.code,response.read(1024*1024+1)
    def get(path,key=management):
        status,raw=call(path,key=key)
        if status!=200:raise RuntimeError('management admission failed')
        return json.loads(raw)
    def save(path,result):path.write_text(json.dumps(result,indent=2)+'\n')
    retry=get('/v8/management/config/routing/retry')
    if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1:raise RuntimeError('dispatch budget differs')
    policy=get('/v8/management/config').get('oauth',{}).get('request-scoped-errors',{}).get('freehub',[])
    if not policy or policy[0]!={'status':401,'match-regexr':['(?s).*'],'action':'stop-and-cooldown'}:raise RuntimeError('401 no-replay policy differs')
    entries=[e for e in get('/v8/management/credentials')['files'] if e.get('name','').startswith('cline-') and e.get('provider')=='freehub']
    if len(entries)!=1:raise RuntimeError('Cline account must be unambiguous')
    entry=entries[0]
    if any(entry.get(k) for k in ('disabled','quota_blocked','requires_sign_in')):raise RuntimeError('Cline native admission held')
    authpath=ROOT/'auth'/entry['name']
    if authpath.parent.resolve()!=(ROOT/'auth').resolve():raise RuntimeError('unexpected auth path')
    def valid():
        d=json.loads(authpath.read_text())
        return isinstance(d.get('expiresAt'),(int,float)) and d['expiresAt']>time.time()+120 and bool(d.get('accessToken'))
    protected=[p for p in (ROOT/'auth').glob('*.json') if json.loads(p.read_text()).get('type')=='opencode']
    protected += [Path('/home/agent/tokligence-staging/live-probe-ledger.json')]
    protected += list(ROOT.glob('cliproxy-*-live-20261102-v1*.json'))
    hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    def unchanged():return all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in hashes.items())
    if not valid():
        journal=state/'cline-refresh-v1.json'
        if journal.exists():raise RuntimeError('prior refresh evidence exists; do not repeat')
        result=dict(provider='cline',phase='reserved',native_refresh_posts=0,inference_posts=0)
        with journal.open('x') as f:json.dump(result,f)
        result.update(phase='dispatched',native_refresh_posts=1);save(journal,result)
        try:
            status,raw=call('/v8/management/credentials/refresh',{'name':entry['name'],'auth_index':entry['auth_index']},timeout=70)
            result.update(http_status=status,valid_access_after=valid(),protected_state_unchanged=unchanged())
            result['phase']='pass' if status==200 and result['valid_access_after'] else 'failed'
        except Exception as error:result.update(phase='failed',error_type=type(error).__name__)
        save(journal,result);print(json.dumps(result),flush=True)
        if result['phase']!='pass':return
    entries=get('/v8/management/credentials')['files']
    entry=next(e for e in entries if e.get('name')==entry['name'])
    if any(entry.get(k) for k in ('disabled','unavailable','quota_blocked','requires_sign_in')):raise RuntimeError('native routing still held')
    if MODEL not in {m['id'] for m in get('/v1/models',client)['data']}:raise RuntimeError('explicit free model not published')
    journal=state/'cline-live-v1.json'
    result=dict(provider='cline',model=MODEL,phase='reserved',caller_posts=0,automatic_retries=0,redirects=False,fallback=False,started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
    with journal.open('x') as f:json.dump(result,f)
    body=dict(model=MODEL,stream=True,max_tokens=1024,messages=[dict(role='user',content='Reply with exactly: OK')])
    result.update(phase='dispatched',caller_posts=1);save(journal,result);began=time.monotonic()
    try:
        status,raw=call('/v1/chat/completions',body,key=client,timeout=60)
        frames=[];done=False
        for line in raw.splitlines():
            if line.startswith(b'data:'):
                p=line[5:].strip()
                if p==b'[DONE]':done=True
                elif p:frames.append(json.loads(p))
        choices=[c for f in frames for c in f.get('choices',[])]
        result.update(http_status=status,done=done,nonempty_text=any(c.get('delta',{}).get('content') for c in choices),finish_reasons=sorted({c['finish_reason'] for c in choices if c.get('finish_reason')}),embedded_error=any('error' in f for f in frames),response_bytes=len(raw))
        result['phase']='pass' if status==200 and done and result['nonempty_text'] and 'stop' in result['finish_reasons'] and not result['embedded_error'] else 'failed'
        if status>=300:(state/'cline-error.private').write_bytes(raw)
    except Exception as error:result.update(phase='failed',error_type=type(error).__name__)
    result.update(elapsed_seconds=round(time.monotonic()-began,2),protected_state_unchanged=unchanged());save(journal,result);print(json.dumps(result),flush=True)
if __name__=='__main__':main()
