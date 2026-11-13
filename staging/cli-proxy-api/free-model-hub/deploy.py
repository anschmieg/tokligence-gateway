#!/usr/bin/env python3
"""One-shot owned Coolify backend/plugin upgrade; token arrives only on stdin.

Preserves native settings/accounts. No login, inference, token export or DB copy.
Native writes touch only this new plugin's subtree with optimistic concurrency.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/agent/cliproxy-staging')
APP = 'iog8gk8g8o0s44840g4o4sso'
OLD = 'f539d27388d539309ff390ab9052f02bf157036542ce69d692ce8f05f2fcfc7d'
CONFIG = dict(enabled=False, allowed_vendors='', blocked_vendors='opencodezen,opencodego,openrouter',
    keyless_accounts=True, keepalive_enabled=False, console_keyless=True,
    console_management_base='/admin', state_dir=str(ROOT/'state/free-model-hub'),
    log_level='info', log_to_file=False, model_name_tag='prefix',
    openrouter_paid_models=False, cline_pass_models=False)
LEAF = '/v8/management/config/plugins/configs/free-model-hub'

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend-sha256', required=True)
    parser.add_argument('--plugin-sha256', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--plugin-only', action='store_true', help='Reviewed 0.1.0 to 0.1.1 file-identity correction')
    parser.add_argument('--stream-status', action='store_true', help='Reviewed 0.1.1 to 0.1.2 structured stream errors')
    parser.add_argument('--provider-acceptance', action='store_true', help='Native OAuth request budget plus structured FreeHub errors')
    parser.add_argument('--zai-free', action='store_true', help='Reviewed documented-free Z.ai catalog correction')
    parser.add_argument('--cline-attribution', action='store_true', help='Reviewed explicit filename provider ownership correction')
    args = parser.parse_args()
    if args.stream_status or args.zai_free or args.cline_attribution: args.plugin_only = True
    token = json.load(sys.stdin)['token']
    key = (ROOT/'secrets/management.key').read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    lock = (ROOT/'state/freehub-deployment.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    journal = ROOT/('freehub-cline-attribution-deployment-v1.json' if args.cline_attribution else 'freehub-zai-free-deployment-v1.json' if args.zai_free else 'provider-acceptance-safety-deployment-v1.json' if args.provider_acceptance else 'freehub-stream-status-deployment-v1.json' if args.stream_status else 'freehub-identity-deployment-v1.json' if args.plugin_only else 'freehub-deployment-v1.json')
    binary = ROOT/'bin/cli-proxy-api'
    pending = ROOT/'freehub-backend.pending'
    library = ROOT/'plugins/free-model-hub.so'
    pending_library = ROOT/'freehub-plugin.pending.so'
    backup = ROOT/('freehub-before-cline-attribution.so' if args.cline_attribution else 'freehub-before-zai-free.so' if args.zai_free else 'bin/cli-proxy-api-before-provider-acceptance' if args.provider_acceptance else 'freehub-before-stream-status.so' if args.stream_status else 'freehub-before-identity.so' if args.plugin_only else 'bin/cli-proxy-api-before-freehub')
    library_backup = ROOT/'freehub-before-provider-acceptance.so'
    if journal.exists() or backup.exists() or (args.provider_acceptance and library_backup.exists()) or (library.exists() and not (args.plugin_only or args.provider_acceptance)):
        raise RuntimeError('existing operation evidence; inspect instead of replay')
    expected_backend = OLD
    if args.plugin_only or args.provider_acceptance:
        prior = json.loads((ROOT/('freehub-zai-free-deployment-v1.json' if args.cline_attribution else 'provider-acceptance-safety-deployment-v1.json' if args.zai_free else 'freehub-identity-deployment-v1.json' if args.stream_status or args.provider_acceptance else 'freehub-deployment-v1.json')).read_text())
        if prior['phase'] != 'deployed' or digest(library) != prior['plugin_sha256']:
            raise RuntimeError('previous plugin identity differs')
        expected_backend = prior['backend_sha256']
    if digest(binary) != expected_backend or (not args.plugin_only and digest(pending) != args.backend_sha256) or digest(pending_library) != args.plugin_sha256:
        raise RuntimeError('artifact identity mismatch')
    runtime = (ROOT/'state/coolify-runtime.lock').open('r')
    def held():
        try: fcntl.flock(runtime, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return True
        fcntl.flock(runtime, fcntl.LOCK_UN)
        return False
    if not held(): raise RuntimeError('expected existing Coolify owner')
    def request(url, secret, method='GET', body=None, etag=None, raw=False):
        headers = {'Authorization': 'Bearer '+secret, 'Content-Type':'application/json'}
        if etag: headers['If-Match'] = etag
        if url.startswith('http://127.0.0.1:8000'): headers['Host'] = 'panel.nothing.pink'
        req = urllib.request.Request(url, headers=headers, method=method,
            data=None if body is None else json.dumps(body).encode())
        with opener.open(req, timeout=20) as response:
            data = response.read()
            return (data if raw else json.loads(data)), response.headers.get('ETag')
    def cool(path, method='GET', body=None):
        return request('http://127.0.0.1:8000/api/v1/'+path, token, method, body)[0]
    def origin():
        addresses = (ROOT/'state/coolify-container-address').read_text().split()
        address = next(ipaddress.ip_address(a) for a in addresses if ipaddress.ip_address(a).version == 4)
        if not address.is_private: raise RuntimeError('unexpected container address')
        return 'http://'+str(address)+':8080'
    def api(path, method='GET', body=None, etag=None, raw=False):
        return request(origin()+path, key, method, body, etag, raw)
    def write_config(value):
        _, etag = api('/v8/management/config')
        if not etag: raise RuntimeError('missing config ETag')
        api(LEAF, 'PUT', value, etag)
    def stop():
        cool('applications/'+APP+'/stop?docker_cleanup=false', 'POST')
        deadline = time.monotonic()+90
        while held():
            if time.monotonic() > deadline: raise RuntimeError('Coolify owner did not stop')
            time.sleep(1)
        # Keep the lock across both atomic swaps. Release only before start.
        fcntl.flock(runtime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def start():
        fcntl.flock(runtime, fcntl.LOCK_UN)
        response = cool('applications/'+APP+'/start', 'POST')
        deployment = response.get('deployment_uuid')
        if not deployment: raise RuntimeError('Coolify did not queue start')
        result['deployment_uuid'] = deployment
        save()
        deadline = time.monotonic()+360
        last = None
        while time.monotonic() < deadline:
            status = cool('deployments/'+deployment).get('status')
            if status != last:
                print(json.dumps({'coolify_status':status}), flush=True); last=status
            if status == 'finished': break
            if status in ('failed','cancelled'): raise RuntimeError('Coolify start failed')
            time.sleep(3)
        else: raise RuntimeError('Coolify deployment still pending; inspect journal')
        deadline = time.monotonic()+40
        while time.monotonic() < deadline:
            try:
                if api('/healthz')[0] and held(): return
            except (OSError, ValueError): pass
            time.sleep(1)
        raise RuntimeError('new owner not healthy')
    protected_files = [p for p in (ROOT/'auth').glob('*.json')
        if json.loads(p.read_text()).get('type') == 'opencode']
    preserved = protected_files + [ROOT/'cliproxy-opencode-live-20261102-v1.json',
        ROOT/'cliproxy-openrouter-live-20261102-v1.json', ROOT/'secrets/client-api-key',
        ROOT/'config/static/management.html', ROOT/'plugins/opencode.so']
    hashes = {str(p):digest(p) for p in preserved}
    native_config = api('/v8/management/config/plugins/configs/opencode')[0]
    configs = api('/v8/management/config/plugins/configs')[0]
    if args.plugin_only or args.provider_acceptance:
        if configs.get('free-model-hub') != dict(CONFIG, enabled=True):
            raise RuntimeError('previous scoped configuration differs')
    elif 'free-model-hub' in configs: raise RuntimeError('Free Hub already configured')
    result = dict(phase='prepared', source_commit=args.source,
        backend_sha256=args.backend_sha256, plugin_sha256=args.plugin_sha256,
        login_requests=0, inference_requests=0, preserved_file_hashes=hashes)
    def save(): journal.write_text(json.dumps(result, indent=2)+'\n')
    with journal.open('x') as output: json.dump(result, output)
    swapped = False
    try:
        if args.provider_acceptance:
            policy_root = api('/v8/management/config')[0].get('oauth', {}).get('request-scoped-errors', {})
            result['previous_request_error_policy'] = {p:policy_root.get(p) for p in ('antigravity','codex','freehub')}
            rule = {'status':401,'match-regexr':['(?s).*'],'action':'stop-and-cooldown'}
            for provider in ('antigravity','codex','freehub'):
                old = policy_root.get(provider, [])
                if old and not isinstance(old,list): raise RuntimeError('unexpected existing policy')
                rules = [rule]+[entry for entry in old if entry != rule]
                _, etag = api('/v8/management/config')
                api('/v8/management/config/oauth/request-scoped-errors/'+provider,'PUT',rules,etag)
        write_config(CONFIG)
        result['phase']='configured_disabled'; save()
        stop()
        shutil.copyfile(library if args.plugin_only else binary, backup); backup.chmod(0o700)
        if args.provider_acceptance:
            shutil.copyfile(library,library_backup); library_backup.chmod(0o700)
        if not args.plugin_only:
            os.replace(pending, binary); binary.chmod(0o700)
        os.replace(pending_library, library); library.chmod(0o700)
        swapped = True
        result['phase']='swapped_stopped'; save()
        start()
        enabled = dict(CONFIG, enabled=True)
        write_config(enabled)
        deadline = time.monotonic()+40
        while time.monotonic() < deadline:
            plugins = api('/v8/management/plugins')[0]['plugins']
            item = next((x for x in plugins if x['id']=='free-model-hub'),{})
            if item.get('registered') and item.get('effective_enabled'): break
            time.sleep(.5)
        else: raise RuntimeError('plugin did not register')
        if api(LEAF)[0] != enabled: raise RuntimeError('scoped configuration differs')
        if api('/v8/management/config/plugins/configs/opencode')[0] != native_config:
            raise RuntimeError('OpenCode configuration changed')
        if any(digest(Path(path)) != sha for path,sha in hashes.items()):
            raise RuntimeError('protected state changed')
        page = api('/admin/v0/management/plugins/free-model-hub/console', raw=True)[0]
        if b'var KEYLESS_SAME_ORIGIN = true;' not in page: raise RuntimeError('keyless console missing')
        vendors = api('/admin/v0/management/plugins/free-model-hub/vendors')[0]['vendors']
        ids = {v['id'] for v in vendors}
        if ids.intersection({'opencodezen','opencodego','openrouter'}) or not {'kilo','cline','github'} <= ids:
            raise RuntimeError('vendor admission differs')
        if args.plugin_only or args.provider_acceptance:
            entries = api('/v8/management/credentials')[0]['files']
            if sum(f.get('name') == 'kilo-free.json' for f in entries) != 1:
                raise RuntimeError('Kilo credential identity duplicated')
        client = (ROOT/'secrets/client-api-key').read_text().strip()
        models = request(origin()+'/v1/models', client)[0]['data']
        result.update(phase='deployed', registered_vendor_ids=sorted(ids),
            freehub_model_count=sum('kilo' in m['id'] for m in models),
            protected_state_unchanged=True, native_opencode_config_unchanged=True,
            console_keyless=True, cooldown_untouched=True)
        save()
        print(json.dumps({k:v for k,v in result.items() if k not in ('preserved_file_hashes',)}))
    except Exception as error:
        result.update(phase='failed', error_type=type(error).__name__); save()
        # Do not race a pending Coolify deployment. Preserve failure evidence and
        # artifacts; an explicit inspected recovery must resolve its state first.
        print(json.dumps({'phase':'failed','error_type':type(error).__name__,
            'backend_swapped':swapped,'journal':str(journal)}), flush=True)
        raise

if __name__ == '__main__': main()
