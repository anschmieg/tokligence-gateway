#!/usr/bin/env python3
"""Add only the assistant profile via native If-Match configuration; no inference."""
import copy, fcntl, hashlib, ipaddress, json, os, time, urllib.request, urllib.error
from pathlib import Path
ROOT = Path('/home/agent/cliproxy-staging')
PROFILE = {'task': 'general', 'max-models': 8, 'preferred-model': 'glm-5.3-flash', 'cost-policy': 'session'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def main():
    os.umask(0o077)
    lock = (ROOT/'state/freehub-deployment.lock').open('r+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    journal = ROOT/'assistant-profile-config-v1.json'
    if journal.exists(): raise RuntimeError('Existing operation: inspect, never replay')
    runtime = (ROOT/'state/coolify-runtime.lock').open('r')
    try:
        fcntl.flock(runtime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: pass
    else: raise RuntimeError('Native owner absent')
    address = next(x for x in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(x).version == 4)
    if not ipaddress.ip_address(address).is_private: raise RuntimeError('Unexpected origin')
    origin = 'http://' + address + ':8080'
    key = (ROOT/'secrets/management.key').read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def request(path, secret=key, body=None, etag=None):
        headers = {'Authorization': 'Bearer '+secret, 'Content-Type': 'application/json', 'X-Gateway-Session': 'assistant-profile-discovery-v1'}
        if etag: headers['If-Match'] = etag
        req = urllib.request.Request(origin+path, headers=headers, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'PUT')
        with opener.open(req, timeout=25) as response: return json.load(response), response.headers.get('ETag')
    before, etag = request('/v8/management/config')
    profiles = before['models']['canonical-routing']['profiles']
    if not etag or 'assistant' in profiles: raise RuntimeError('Missing concurrency token or existing profile')
    # Hash without displaying, backing up, or parsing any credential contents.
    paths = list((ROOT/'auth').glob('*.json')) + list((ROOT/'plugins').glob('*.so'))
    paths += [ROOT/'bin/cli-proxy-api', ROOT/'config/static/management.html']
    paths += list(ROOT.glob('*live*.json'))
    ledger = Path('/home/agent/tokligence-staging/live-probe-ledger.json')
    if ledger.exists(): paths.append(ledger)
    hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    accounts = {p.name for p in (ROOT/'auth').glob('*.json')}
    expected = copy.deepcopy(before)
    expected['models']['canonical-routing']['profiles']['assistant'] = PROFILE
    result = {'phase': 'prepared', 'profile': 'assistant', 'configuration': PROFILE, 'provider_inference_requests': 0}
    with journal.open('x') as file: json.dump(result, file)
    request('/v8/management/config/models/canonical-routing/profiles/assistant', body=PROFILE, etag=etag)
    after = request('/v8/management/config')[0]
    if after != expected: raise RuntimeError('Unexpected configuration difference; inspect journal')
    client = before['access']['api-keys'][0]
    deadline = time.monotonic() + 15
    while True:
        try:
            view = request('/assistant/v1/models', client)[0]
            break
        except urllib.error.HTTPError as error:
            if error.code != 404 or time.monotonic() >= deadline: raise
            time.sleep(0.2)  # Native config watch applies asynchronously; discovery only.
    rows = request('/v1/models', client)[0]['data']
    alias = next((r for r in rows if r['id'] == 'assistant'), {})
    if not view.get('data') or view.get('preferred_model') != PROFILE['preferred-model'] or view['data'][0]['id'] != PROFILE['preferred-model']:
        raise RuntimeError('Profile discovery differs; inspect journal')
    if not alias.get('virtual') or alias.get('preferred_model') != PROFILE['preferred-model']: raise RuntimeError('Alias not published')
    control = request('/v1/routing/session?profile=assistant', client)[0]
    if control.get('policy') != 'SUB': raise RuntimeError('Billing default differs')
    if any(hashlib.sha256(p.read_bytes()).hexdigest() != digest for p, digest in hashes.items()): raise RuntimeError('Protected state changed')
    if accounts != {p.name for p in (ROOT/'auth').glob('*.json')}: raise RuntimeError('Account inventory changed')
    result.update(phase='configured', other_settings_preserved=True, protected_state_preserved=True, native_restarted=False, billing_default='SUB', profile_ids=[r['id'] for r in view['data']], full_catalog_count=len(rows), alias_published=True, public_ingress_verified=False)
    journal.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))
if __name__ == '__main__': main()
