#!/usr/bin/env python3
"""Read-only OpenCode acceptance admission. No provider HTTP, refresh or writes.

Uses native management metadata plus the existing host-owned credential and
investigation ledger. Never enables credentials, clears cooldowns or sends a
prompt. A clear local check does not establish upstream free-model eligibility.
"""
import datetime
import fcntl
import hashlib
import ipaddress
import json
from pathlib import Path
import sys
import time
import urllib.request

ROOT=Path('/home/agent/cliproxy-staging')
OLD=Path('/home/agent/tokligence-staging')
MODEL='glm-5.3-flash-free'
REVIEWED_PLUGIN='19ee4302f7f96418ba0c59d443c4682ba1972de67d7cf1d687ea4e9004df354b'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def main():
    locks=[]
    for path in [ROOT/'state/freehub-deployment.lock',OLD/'live-probe.lock']:
        lock=path.open('r')
        fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
        locks.append(lock)
    before=hashlib.sha256((OLD/'live-probe-ledger.json').read_bytes()).hexdigest()
    sys.path.insert(0,str(OLD/'gateway/native/opencode'))
    from live_safety import recorded_cooldowns
    ledger=json.loads((OLD/'live-probe-ledger.json').read_text())
    cooldowns=recorded_cooldowns(OLD,ledger)
    provider_state=ROOT/'state/opencode-provider-cooldown.json'
    if provider_state.exists():
        state=json.loads(provider_state.read_text())
        reset=datetime.datetime.fromisoformat(state['retry_at'])
        if state.get('version')!=1 or state.get('status') not in (401,403,429) or reset.tzinfo is None:
            raise RuntimeError('provider cooldown evidence cannot be verified')
        if reset>datetime.datetime.now(datetime.timezone.utc):cooldowns.append(reset)
    now=time.time()
    address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
    if not ipaddress.ip_address(address).is_private:raise RuntimeError('non-private native origin')
    key=(ROOT/'secrets/management.key').read_text().strip()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def get(path):
        req=urllib.request.Request('http://'+address+':8080'+path,headers={'Authorization':'Bearer '+key})
        with opener.open(req,timeout=15) as response:return json.load(response)
    config=get('/v8/management/config')
    cfg=config.get('plugins',{}).get('configs',{}).get('opencode',{})
    entries=[e for e in get('/v8/management/credentials')['files'] if e.get('provider')=='opencode']
    accounts=[]
    for entry in entries:
        name=entry.get('name','');path=ROOT/'auth'/name
        if path.parent.resolve()!=(ROOT/'auth').resolve():raise RuntimeError('unexpected credential path')
        data=json.loads(path.read_text());value=data.get('credential',{})
        metadata=value.get('metadata',{})
        if isinstance(metadata,str):metadata=json.loads(metadata)
        expiry=value.get('expires')
        org=metadata.get('orgID')
        overlay=cfg.get('console_headers',{}).get('x-opencode-org-id')
        accounts.append(dict(disabled=bool(entry.get('disabled')),unavailable=bool(entry.get('unavailable')),requires_sign_in=bool(entry.get('requires_sign_in')),access_expired=not isinstance(expiry,(int,float)) or expiry/1000<=now,refresh_due=not isinstance(expiry,(int,float)) or expiry/1000<=now+300,refresh_present=bool(value.get('refresh')),console_org_matches=bool(org) and org==overlay))
    reasons=[]
    if cooldowns:reasons.append('durable_investigation_hold')
    if hashlib.sha256((ROOT/'plugins/opencode.so').read_bytes()).hexdigest()!=REVIEWED_PLUGIN:reasons.append('plugin_not_reviewed_identity')
    if not cfg.get('enabled'):reasons.append('plugin_disabled')
    if MODEL not in cfg.get('models',[]):reasons.append('model_not_admitted')
    if MODEL in cfg.get('console_disabled_models',[]):reasons.append('console_disables_model')
    retry=config.get('routing',{}).get('retry',{})
    if retry.get('request-retry')!=0 or retry.get('max-retry-credentials')!=1:reasons.append('dispatch_budget_differs')
    rules=config.get('oauth',{}).get('request-scoped-errors',{}).get('opencode',[])
    if not rules or rules[0]!={'status':401,'match-regexr':['(?s).*'],'action':'stop-and-cooldown'}:reasons.append('automatic401_replay_not_blocked')
    active=[a for a in accounts if not a['disabled']]
    if len(active)!=1:reasons.append('requires_exactly_one_enabled_credential')
    elif active[0]['access_expired'] or active[0]['refresh_due']:reasons.append('native_owner_refresh_needed')
    if any(not a['console_org_matches'] for a in accounts):reasons.append('credential_console_org_mismatch')
    unchanged=before==hashlib.sha256((OLD/'live-probe-ledger.json').read_bytes()).hexdigest()
    if not unchanged:raise RuntimeError('investigation ledger changed during inspection')
    print(json.dumps(dict(checked_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),model=MODEL,local_admission='held' if reasons else 'clear',held_reasons=reasons,cooldown_until=max(cooldowns).isoformat() if cooldowns else None,credential_states=accounts,provider_requests=0,inference_requests=0,refresh_requests=0,credential_writes=0,ledger_unchanged=unchanged,upstream_free_client_eligibility='not_established')))

if __name__=='__main__':main()
