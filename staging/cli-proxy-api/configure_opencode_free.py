#!/usr/bin/env python3
"""Admit the requested GLM free model without enabling quarantined credentials.
Scoped native If-Match config write only; no provider requests or inference.
"""
import argparse,fcntl,hashlib,ipaddress,json,os,urllib.request
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging')
OLD=Path('/home/agent/tokligence-staging')
MODEL='glm-5.3-flash-free'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw):return None

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-auth-replay',action='store_true',help='Apply native401 stop policy instead of changing model selection')
    args=parser.parse_args()
    os.umask(0o077)
    locks=[]
    for p in [ROOT/'state/freehub-deployment.lock',OLD/'live-probe.lock']:
        f=p.open('r');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(f)
    journal=ROOT/('opencode-no-auth-replay-config-20261102-v1.json' if args.no_auth_replay else 'opencode-free-model-config-20261102-v1.json')
    if journal.exists():raise RuntimeError('operation exists; inspect rather than replay')
    address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    key=(ROOT/'secrets/management.key').read_text().strip()
    def request(path,body=None,etag=None):
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}
        if etag:headers['If-Match']=etag
        q=urllib.request.Request('http://'+address+':8080'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method='GET' if body is None else 'PUT')
        with opener.open(q,timeout=20) as response:return json.load(response),response.headers.get('ETag')
    config,etag=request('/v8/management/config')
    if not etag:raise RuntimeError('native concurrency token missing')
    original=config['plugins']['configs']['opencode']
    if not args.no_auth_replay and original.get('models')!=['beam-free']:raise RuntimeError('existing model selection changed')
    if MODEL in original.get('console_disabled_models',[]):raise RuntimeError('Console policy denies model')
    entries=request('/v8/management/credentials')[0]['files']
    accounts=[e for e in entries if e.get('provider')=='opencode']
    if len(accounts)!=2 or any(not e.get('disabled') for e in accounts):raise RuntimeError('quarantine differs; no config change')
    files=[ROOT/'auth'/e['name'] for e in accounts]
    if any(p.parent.resolve()!=(ROOT/'auth').resolve() for p in files):raise RuntimeError('unexpected auth path')
    files += [OLD/'live-probe-ledger.json',ROOT/'secrets/client-api-key',ROOT/'plugins/opencode.so']
    files += list(ROOT.glob('cliproxy-*-live-20261102-v1*.json'))
    hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    expected=json.loads(json.dumps(config))
    if args.no_auth_replay:
        rule={'status':401,'match-regexr':['(?s).*'],'action':'stop-and-cooldown'}
        previous=config.get('oauth',{}).get('request-scoped-errors',{}).get('opencode',[])
        if not isinstance(previous,list):raise RuntimeError('unexpected existing OpenCode request policy')
        if previous and previous[0]==rule:raise RuntimeError('policy already present; inspect rather than repeat')
        value=[rule]+[r for r in previous if r!=rule]
        leaf='/v8/management/config/oauth/request-scoped-errors/opencode'
        expected.setdefault('oauth',{}).setdefault('request-scoped-errors',{})['opencode']=value
        result=dict(phase='prepared',policy='opencode401-stop-and-cooldown',inference_requests=0,provider_requests=0,credential_writes=0)
    else:
        value=['beam-free',MODEL]
        leaf='/v8/management/config/plugins/configs/opencode/models'
        expected['plugins']['configs']['opencode']['models']=value
        result=dict(phase='prepared',previous_models=original['models'],models=value,inference_requests=0,provider_requests=0,credential_writes=0)
    with journal.open('x') as f:json.dump(result,f)
    request(leaf,value,etag)
    updated=request('/v8/management/config')[0]
    if updated!=expected:raise RuntimeError('unexpected native configuration change; inspect journal')
    after=request('/v8/management/credentials')[0]['files']
    if any(not e.get('disabled') for e in after if e.get('provider')=='opencode'):raise RuntimeError('quarantine changed')
    if not all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in hashes.items()):raise RuntimeError('protected state changed')
    result.update(phase='configured',other_settings_unchanged=True,credentials_unchanged=True,ledger_unchanged=True)
    journal.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
