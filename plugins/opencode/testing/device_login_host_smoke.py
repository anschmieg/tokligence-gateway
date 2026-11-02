#!/usr/bin/env python3
"""Exact shared library + native OAuth API, fake Console, no network egress.

The HTTPS Console fixture uses a test-only CA and CONNECT proxy inside an
unshared network namespace. The plugin's production endpoint stays unchanged.
No real credentials or inference are involved. Requires bwrap and openssl.
"""
import argparse
import http.server
import json
import os
import pathlib
import select
import shutil
import signal
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.request


def inner(outer_ns):
    assert os.readlink('/proc/self/ns/net') != outer_ns
    work = pathlib.Path('/work')
    calls = []
    class Console(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            calls.append(self.path)
            if self.path == '/console/auth/device/code':
                assert body == {'client_id': 'opencode-cli', 'supports_org_scope': True}
                self.reply(200, {'device_code': 'fixture-device', 'user_code': 'TEST-CODE',
                    'verification_uri_complete': 'https://opencode.ai/console/device?code=TEST-CODE',
                    'expires_in': 600, 'interval': 1})
            elif self.path == '/console/auth/device/token':
                assert body == {'client_id': 'opencode-cli', 'device_code': 'fixture-device',
                    'grant_type': 'urn:ietf:params:oauth:grant-type:device_code'}
                if calls.count(self.path) == 1:
                    self.reply(400, {'error': 'authorization_pending'})
                else:
                    self.reply(200, {'access_token': 'fixture-access', 'refresh_token': 'fixture-refresh',
                        'expires_in': 3600, 'org_id': 'fixture-org'})
            else:
                self.reply(500, {'error': 'unexpected fixture POST'})
        def do_GET(self):
            calls.append(self.path)
            assert self.headers.get('Authorization') == 'Bearer fixture-access'
            if self.path == '/console/api/user':
                self.reply(200, {'id': 'fixture-account', 'email': 'fixture@example.invalid'})
            elif self.path == '/console/api/orgs':
                self.reply(200, [{'id': 'fixture-org', 'name': 'Fixture'}])
            else: self.reply(500, {'error': 'unexpected fixture GET'})
    tls = http.server.ThreadingHTTPServer(('127.0.0.1', 18443), Console)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('/work/ca.pem', '/work/key.pem')
    tls.socket = ctx.wrap_socket(tls.socket, server_side=True)
    threading.Thread(target=tls.serve_forever, daemon=True).start()

    class Connect(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_CONNECT(self):
            if self.path != 'opencode.ai:443':
                self.send_error(403); return
            with socket.create_connection(('127.0.0.1', 18443), timeout=5) as upstream:
                self.send_response(200); self.end_headers()
                peers = [self.connection, upstream]
                while True:
                    ready, _, _ = select.select(peers, [], [], 8)
                    if not ready: return
                    for peer in ready:
                        data = peer.recv(65536)
                        if not data: return
                        (upstream if peer is self.connection else self.connection).sendall(data)
    proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 18081), Connect)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    for directory in ['auth', 'plugins', 'static']:
        (work/directory).mkdir(mode=0o700)
    shutil.copyfile('/plugin.so', work/'plugins/opencode.so')
    (work/'static/models.json').write_text(json.dumps({k: [] for k in
        ['claude','gemini','vertex','aistudio','codex-free','codex-team','codex-plus','codex-pro','kimi','antigravity','xai','meta']}))
    config = {'config-version': 8, 'server': {'host':'127.0.0.1','port':18080},
        'oauth': {'auth-dir':'/work/auth'}, 'access': {'api-keys':['fixture-client-0001']},
        'management': {'allow-remote':False,'secret-key':'fixture-management-0001',
            'disable-control-panel':True,'disable-auto-update-panel':True},
        'models': {'catalog':'','codex-catalog':'','devin-catalog':''},
        'routing': {'retry': {'request-retry':0,'max-retry-credentials':1}},
        'plugins': {'enabled':True,'dir':'/work/plugins','configs': {'opencode': {
            'enabled':True,'models':['fixture-only'],'session_state_path':'/work/sessions.json'}}}}
    (work/'config.yaml').write_text(json.dumps(config))
    env = dict(os.environ, SSL_CERT_FILE='/work/ca.pem', SSL_CERT_DIR='/tmp/no-system-certs', HOME='/work')
    log = (work/'backend.log').open('wb')
    backend = subprocess.Popen(['/backend','--config','/work/config.yaml','--local-model'], env=env, stdout=log, stderr=log)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(path, body=None):
        raw = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request('http://127.0.0.1:18080'+path, data=raw,
            headers={'Authorization':'Bearer fixture-management-0001','Content-Type':'application/json'})
        with opener.open(req, timeout=8) as resp: return json.load(resp)
    try:
        for _ in range(80):
            try:
                api('/v8/management/plugins'); break
            except Exception:
                if backend.poll() is not None: raise RuntimeError('fixture backend exited')
                time.sleep(.1)
        start = api('/v8/management/oauth/auth-url', {'provider':'opencode','proxy_url':'http://127.0.0.1:18081'})
        assert start['status'] == 'ok' and 'TEST-CODE' in start['url']
        state = start['state']
        assert state != 'fixture-device'
        status_path = '/v8/management/oauth/status?state='+state
        assert api(status_path)['status'] == 'wait'
        assert len(calls) == 1, 'early poll dispatched'
        time.sleep(1.1)
        assert api(status_path)['status'] == 'wait'
        time.sleep(1.1)
        assert api(status_path)['status'] == 'ok'
        assert api(status_path)['status'] == 'ok', 'completed host session should be idempotent'
        files = list((work/'auth').glob('opencode-login-*.json'))
        assert len(files) == 1, 'host did not persist one distinct credential'
        saved = json.loads(files[0].read_text())
        assert saved['credential']['refresh'] == 'fixture-refresh'
        assert saved['credential']['metadata']['orgID'] == 'fixture-org'
        assert calls == ['/console/auth/device/code','/console/auth/device/token',
            '/console/auth/device/token','/console/api/user','/console/api/orgs'], calls
        (work/'verdict.json').write_text(json.dumps({'verdict':'pass','isolated':True,
            'native_start_poll_persistence':True,'console_requests':len(calls),'inference_requests':0}))
    finally:
        backend.terminate()
        try: backend.wait(timeout=5)
        except subprocess.TimeoutExpired: backend.kill(); backend.wait()
        log.close(); proxy.shutdown(); tls.shutdown()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--inner':
        return inner(sys.argv[2])
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', required=True); p.add_argument('--plugin', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    out = pathlib.Path(args.output).resolve()
    if out.exists(): p.error('output must not exist; preserve earlier evidence')
    if not shutil.which('bwrap'): p.error('bwrap required; no unsandboxed fallback')
    out.mkdir(mode=0o700)
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
        '-subj','/CN=opencode.ai','-addext','subjectAltName=DNS:opencode.ai',
        '-keyout',str(out/'key.pem'),'-out',str(out/'ca.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cmd = ['bwrap','--unshare-net','--die-with-parent']
    for path in ['/usr','/lib','/lib64','/bin']:
        if pathlib.Path(path).exists(): cmd += ['--ro-bind',path,path]
    cmd += ['--dir','/etc']
    for path in ['/etc/passwd','/etc/group','/etc/nsswitch.conf','/etc/hosts']:
        if pathlib.Path(path).exists(): cmd += ['--ro-bind',path,path]
    cmd += ['--ro-bind',str(pathlib.Path(args.binary).resolve()),'/backend',
        '--ro-bind',str(pathlib.Path(args.plugin).resolve()),'/plugin.so',
        '--ro-bind',str(pathlib.Path(__file__).resolve()),'/fixture.py',
        '--bind',str(out),'/work','--tmpfs','/tmp','--dev','/dev','--proc','/proc',
        '--clearenv','--setenv','PATH','/usr/bin:/bin','--','/usr/bin/python3','/fixture.py',
        '--inner',os.readlink('/proc/self/ns/net')]
    child = subprocess.Popen(cmd, start_new_session=True)
    try:
        assert child.wait(timeout=45) == 0, 'fixture failed; inspect private output'
    finally:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
    print((out/'verdict.json').read_text())


if __name__ == '__main__': main()
