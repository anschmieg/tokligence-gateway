#!/usr/bin/env python3
"""One-shot plugin-only OAuth update. Run on the owned Coolify host.

No login/inference requests, no auth-file edits, no broad configuration writes.
Native If-Match writes affect only this plugin's enabled leaf. The shared
session lock proves the old instance drained before replacing its library.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path('/home/agent/cliproxy-staging')
RELEASES = {
    'device-login': ('736569b12097cfcc4c361954fb9c4aa9abc574001ef53a9f7c7fde9bf2ac5291', '0.3.0'),
    'native-parity-031': ('65eb953a979c6cfd66e83b68445236e77982db12f9d650055ee5d189eb98be66', '0.3.1'),
}


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sha256', required=True); p.add_argument('--source', required=True)
    p.add_argument('--release', choices=RELEASES, default='device-login')
    args = p.parse_args()
    r = ROOT
    lock = (r/'state/opencode-device-login-deployment.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    old_sha, version = RELEASES[args.release]
    stem = 'opencode-'+args.release
    journal = r/(stem+'-deployment.json')
    target, pending, backup = r/'plugins/opencode.so', r/(stem+'.pending.so'), r/('opencode-pre-'+args.release+'.so')
    if journal.exists() or backup.exists(): raise RuntimeError('existing deployment evidence; inspect instead of replay')
    if digest(target) != old_sha or digest(pending) != args.sha256: raise RuntimeError('artifact identity differs')
    runtime = (r/'state/coolify-runtime.lock').open('r')
    try:
        fcntl.flock(runtime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: pass
    else: raise RuntimeError('Coolify runtime lock is not held')
    addresses = (r/'state/coolify-container-address').read_text().split()
    ipv4 = next(ipaddress.ip_address(a) for a in addresses if ipaddress.ip_address(a).version == 4)
    if not ipv4.is_private: raise RuntimeError('unexpected container address')
    base = 'http://'+str(ipv4)+':8080'
    key = (r/'secrets/management.key').read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(path, method='GET', body=None, etag=None):
        headers = {'Authorization':'Bearer '+key}
        if body is not None: headers['Content-Type'] = 'application/json'
        if etag: headers['If-Match'] = etag
        request = urllib.request.Request(base+path, method=method, headers=headers,
            data=None if body is None else json.dumps(body).encode())
        with opener.open(request, timeout=10) as response:
            return json.load(response), response.headers.get('ETag')
    leaf = '/v8/management/config/plugins/configs/opencode/enabled'
    def enabled(value):
        _, etag = api(leaf)
        if not etag: raise RuntimeError('native config ETag missing')
        api(leaf, 'PUT', value, etag)
    def entries(): return api('/v8/management/credentials')[0]['files']
    before = [x for x in entries() if x.get('provider') == 'opencode']
    protected = [x['name'] for x in before if x.get('disabled')]
    if not protected: raise RuntimeError('existing quarantine must be present')
    plugin_config = api('/v8/management/config/plugins/configs/opencode')[0]
    if plugin_config.get('enabled') is not True: raise RuntimeError('plugin was not enabled')
    reports = [r/'cliproxy-opencode-live-20261102-v1.json', r/'cliproxy-openrouter-live-20261102-v1.json']
    hashes = {str(path):digest(path) for path in reports}
    result = {'phase':'prepared','source_commit':args.source,'plugin_sha256':args.sha256,'provider_inference_requests':0,'login_requests':0}
    with journal.open('x') as f: json.dump(result, f, indent=2)
    changed = False
    disabled = False
    try:
        enabled(False); disabled = True
        deadline = time.monotonic()+12
        while True:
            with (r/'state/opencode-sessions.json.lock').open('r') as session:
                try:
                    fcntl.flock(session, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline: raise RuntimeError('old plugin did not drain')
                    time.sleep(.1)
        if api(leaf)[0] is not False: raise RuntimeError('concurrent plugin enable; stop update')
        os.replace(target, backup)
        os.replace(pending, target); target.chmod(0o700); changed = True
        enabled(True); disabled = False
        deadline = time.monotonic()+15
        while True:
            plugins = api('/v8/management/plugins')[0]['plugins']
            item = next((x for x in plugins if x['id'] == 'opencode'), {})
            if item.get('registered') and (item.get('metadata') or {}).get('version') == version: break
            if time.monotonic() >= deadline: raise RuntimeError('new plugin did not register')
            time.sleep(.2)
        current = {x['name']:x for x in entries()}
        if any(name not in current or not current[name].get('disabled') for name in protected): raise RuntimeError('quarantine changed')
        if api('/v8/management/config/plugins/configs/opencode')[0] != plugin_config: raise RuntimeError('plugin configuration changed concurrently')
        if any(digest(Path(path)) != sha for path,sha in hashes.items()): raise RuntimeError('live evidence changed')
        api('/healthz')
        result.update(phase='deployed',version=version,credential_quarantine_preserved=True,live_reports_unchanged=True,plugin_config_unchanged=True)
    except Exception as error:
        result.update(phase='failed',error_type=type(error).__name__)
        if changed:
            enabled(False)
            # New instance must release its persistent session registry first.
            deadline = time.monotonic()+12
            while True:
                with (r/'state/opencode-sessions.json.lock').open('r') as session:
                    try:
                        fcntl.flock(session, fcntl.LOCK_EX | fcntl.LOCK_NB); break
                    except BlockingIOError:
                        if time.monotonic() >= deadline: raise RuntimeError('rollback drain blocked; plugin stays disabled')
                        time.sleep(.1)
            os.replace(target, r/(stem+'.failed.so'))
            os.replace(backup,target)
            enabled(True)
        elif disabled: enabled(True)
        raise
    finally:
        journal.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__': main()
