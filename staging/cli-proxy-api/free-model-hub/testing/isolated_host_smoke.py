#!/usr/bin/env python3
"""Exact native host + both plugins, fake HTTPS Kilo, mandatory net namespace.

Python dependencies are stdlib only; Linux bwrap and openssl are required.
No production endpoint override, real credentials, or unsandboxed fallback.
The parent builds/runs this fixture; a newly written fixture is not a pass.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

WORK = Path('/work')
MGMT = '/admin/v0/management/plugins/free-model-hub'
MANAGEMENT_KEY = 'fixture-management-0001'
CLIENT_KEY = 'fixture-caller-0001'
MODEL = 'kilo-auto/free'
LIMIT = 2 * 1024 * 1024


class GateFailure(Exception):
    """Carries only a fixed gate name, never a response or credential."""


def require(condition, gate):
    if not condition:
        raise GateFailure(gate)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for part in iter(lambda: source.read(65536), b''):
            h.update(part)
    return h.hexdigest()


def write_verdict(path, report):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    temporary.replace(path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inner(outer_ns):
    os.umask(0o077)
    report = {'verdict': 'fail', 'failures': [], 'gates': {}, 'counts': {
        'catalog_get': 0, 'stream_origin': 0, 'redirect_origin': 0,
        'inference_posts': 0, 'redirect_target': 0, 'unexpected_http': 0,
        'denied_connect': 0, 'blocked_native_metadata': 0}, 'namespace': {'outer': outer_ns}}
    counts, gates = report['counts'], report['gates']
    backend = None
    servers = []
    stage = 'namespace'
    mode = {'redirect': False}
    lock = threading.Lock()

    def count(name):
        with lock:
            counts[name] += 1

    def gate(name, condition):
        gates[name] = bool(condition)
        require(condition, name)

    class Mock(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body=b'', kind='application/json', **headers):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.server.server_port == 18444:
                count('redirect_target')
                self.reply(500)
            elif self.path == '/api/gateway/models':
                count('catalog_get')
                self.reply(200, json.dumps({'data': [{'id': MODEL, 'isFree': True,
                    'context_length': 8192, 'pricing': {'prompt': '0', 'completion': '0'}}]}).encode())
            else:
                count('unexpected_http')
                self.reply(500)

        def do_POST(self):
            if self.server.server_port == 18444:
                count('redirect_target')
                self.reply(500)
                return
            count('inference_posts')
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/api/gateway/chat/completions' or not 0 < length <= 65536:
                count('unexpected_http')
                self.reply(500)
                return
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, OSError):
                count('unexpected_http')
                self.reply(500)
                return
            if (body.get('model') != MODEL or body.get('stream') is not True
                    or self.headers.get('Authorization')):
                count('unexpected_http')
                self.reply(500)
                return
            if mode['redirect']:
                count('redirect_origin')
                self.reply(307, **{'Location': 'https://redirect.fixture.invalid/captured'})
                return
            count('stream_origin')
            frames = [
                {'id': 'fixture-chat', 'object': 'chat.completion.chunk', 'created': 1700000000,
                 'model': MODEL, 'choices': [{'index': 0, 'delta': {'role': 'assistant',
                    'content': 'fixture-inert-text'}}]},
                {'id': 'fixture-chat', 'object': 'chat.completion.chunk', 'created': 1700000000,
                 'model': MODEL, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}]
            raw = b''.join(b'data: ' + json.dumps(frame).encode() + b'\n\n' for frame in frames)
            self.reply(200, raw + b'data: [DONE]\n\n', 'text/event-stream')

    class Connect(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_CONNECT(self):
            # Native host's npm version updater is not plugin inference. Deny
            # its metadata fetch locally, recording it separately; no tunnel.
            if self.path == 'registry.npmjs.org:443':
                count('blocked_native_metadata')
                self.send_error(403)
                return
            ports = {'api.kilo.ai:443': 18443, 'redirect.fixture.invalid:443': 18444}
            port = ports.get(self.path)
            if port is None:
                count('denied_connect')
                self.send_error(403)
                return
            # Never resolve or connect to the requested authority: only these
            # two literal loopback destinations exist in the private netns.
            with socket.create_connection(('127.0.0.1', port), timeout=3) as upstream:
                self.send_response(200)
                self.end_headers()
                peers = [self.connection, upstream]
                until = time.monotonic() + 12
                while time.monotonic() < until:
                    ready, _, _ = select.select(peers, [], [], .5)
                    for peer in ready:
                        data = peer.recv(65536)
                        if not data:
                            return
                        (upstream if peer is self.connection else self.connection).sendall(data)

    def serve(port, handler, tls=False):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        server.daemon_threads = True
        if tls:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(WORK/'ca.pem'), str(WORK/'key.pem'))
            server.socket = context.wrap_socket(server.socket, server_side=True)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def api(path, key=MANAGEMENT_KEY, body=None):
        headers = {'Content-Type': 'application/json'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        req = urllib.request.Request('http://127.0.0.1:18080' + path,
            data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = opener.open(req, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(LIMIT + 1)
            require(len(raw) <= LIMIT, 'bounded_response')
            return response.code, raw

    def get_json(path, key=MANAGEMENT_KEY):
        status, raw = api(path, key)
        require(status == 200, 'api_status')
        return json.loads(raw)

    def auth_gate(check_runtime=True):
        # Native request logging creates auth/logs after a rejected request;
        # it is not a credential. Check every regular credential file.
        files = sorted(p.name for p in (WORK/'auth').iterdir() if p.is_file())
        return (files == ['kilo-free.json', 'opencode-fixture.json']
            and digest(WORK/'auth/opencode-fixture.json') == seeded_hash
            and json.loads((WORK/'auth/kilo-free.json').read_text()).get('vendor') == 'kilo'
            and (not check_runtime or sum(f.get('name') == 'kilo-free.json' for f in get_json('/v8/management/credentials')['files']) == 1))

    try:
        inner_ns = os.readlink('/proc/self/ns/net')
        report['namespace']['inner'] = inner_ns
        gate('network_namespace_isolated', inner_ns != outer_ns)
        stage = 'test_ca'
        # Generated INSIDE bwrap, so certificate generation and every child
        # share the outer process-group deadline. No Python package installs.
        subprocess.run(['/usr/bin/openssl', 'req', '-config', '/dev/null', '-x509', '-newkey', 'rsa:2048',
            '-nodes', '-days', '1', '-subj', '/CN=api.kilo.ai', '-addext',
            'subjectAltName=DNS:api.kilo.ai,DNS:redirect.fixture.invalid',
            '-addext', 'basicConstraints=critical,CA:TRUE',
            '-keyout', '/work/key.pem', '-out', '/work/ca.pem'],
            check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name in ('auth', 'state', 'home', 'empty-certs', 'static'):
            (WORK/name).mkdir(mode=0o700)
        seed = {'type': 'opencode', 'storage_version': 1, 'disabled': True,
            'credential': {'type': 'oauth', 'methodID': 'device',
                'access': 'fixture-fake-access', 'refresh': 'fixture-fake-refresh',
                'expires': 2524608000000, 'metadata': {'server': 'https://opencode.ai',
                    'accountID': 'fixture-account', 'email': 'fixture@example.invalid'}}}
        (WORK/'auth/opencode-fixture.json').write_text(json.dumps(seed) + '\n')
        seeded_hash = digest(WORK/'auth/opencode-fixture.json')
        (WORK/'static/models.json').write_text(json.dumps({k: [] for k in
            ('claude', 'gemini', 'vertex', 'aistudio', 'codex-free', 'codex-team',
             'codex-plus', 'codex-pro', 'kimi', 'antigravity', 'xai', 'meta')}))
        config = {'config-version': 8, 'server': {'host': '127.0.0.1', 'port': 18080},
            'oauth': {'auth-dir': '/work/auth'}, 'access': {'api-keys': [CLIENT_KEY]},
            'management': {'allow-remote': False, 'secret-key': MANAGEMENT_KEY,
                'disable-control-panel': True, 'disable-auto-update-panel': True},
            'models': {'catalog': '', 'codex-catalog': '', 'devin-catalog': ''},
            'requests': {'proxy-url': 'http://127.0.0.1:18081'},
            'routing': {'retry': {'request-retry': 0, 'max-retry-credentials': 1}},
            'plugins': {'enabled': True, 'dir': '/plugins', 'configs': {
                'opencode': {'enabled': True, 'models': ['fixture-disabled-only'],
                    'session_state_path': '/work/opencode-sessions.json'},
                'free-model-hub': {'enabled': True, 'allowed_vendors': [],
                    'blocked_vendors': ['opencodezen', 'opencodego', 'openrouter'],
                    'keyless_accounts': True, 'keepalive_enabled': False,
                    'console_keyless': True, 'console_management_base': '/admin',
                    'state_dir': '/work/state', 'model_name_tag': 'prefix', 'log_to_file': False}}}}
        (WORK/'config.yaml').write_text(json.dumps(config))
        serve(18443, Mock, True)
        serve(18444, Mock, True)
        serve(18081, Connect)
        stage = 'host_registration'
        backend = subprocess.Popen(['/backend', '--config', '/work/config.yaml', '--local-model'],
            cwd='/work', env={'PATH': '/usr/bin:/bin', 'HOME': '/work/home',
                'SSL_CERT_FILE': '/work/ca.pem', 'SSL_CERT_DIR': '/work/empty-certs'},
            stdout=(WORK/'backend.log').open('wb'), stderr=subprocess.STDOUT)
        until = time.monotonic() + 15
        registered = {}
        model_ids = []
        while time.monotonic() < until:
            require(backend.poll() is None, 'host_alive')
            try:
                registered = {p['id']: p for p in get_json('/v8/management/plugins')['plugins']}
                model_ids = [m['id'] for m in get_json('/v1/models', CLIENT_KEY)['data']]
                if (all(registered.get(p, {}).get('registered') for p in ('opencode', 'free-model-hub'))
                        and any(MODEL in m and 'kilo' in m for m in model_ids)
                        and (WORK/'auth/kilo-free.json').exists()):
                    break
            except (OSError, ValueError, KeyError, GateFailure):
                pass
            time.sleep(.15)
        gate('both_plugins_registered', all(registered.get(p, {}).get('registered')
            and registered[p].get('effective_enabled') for p in ('opencode', 'free-model-hub')))
        stage = 'management_console'
        gate('management_without_key_401', api(MGMT+'/vendors', key=None)[0] == 401)
        gate('console_without_key_401', api(MGMT+'/console', key=None)[0] == 401)
        status, page = api(MGMT+'/console')
        (WORK/'console.html').write_bytes(page)
        gate('protected_keyless_console', status == 200
            and b'var KEYLESS_SAME_ORIGIN = true;' in page
            and b'var MGMT_BASE = "/admin";' in page
            and b'MGMT = MGMT_BASE + "/v0/management" + BASE' in page
            and all(secret.encode() not in page for secret in
                (MANAGEMENT_KEY, CLIENT_KEY, 'fixture-fake-access', 'fixture-fake-refresh')))
        vendors = get_json(MGMT+'/vendors')['vendors']
        vendor_ids = {v['id'] for v in vendors}
        gate('vendor_admission', {'kilo', 'cline', 'github', 'groq'} <= vendor_ids
            and not vendor_ids.intersection({'opencodezen', 'opencodego', 'openrouter'}))
        gate('login_providers_visible', any(v['id'] == 'cline' and v['supports_login'] for v in vendors))
        gate('only_kilo_auth_and_preserved_opencode', auth_gate())
        gate('disabled_opencode_unpublished', not any('fixture-disabled-only' in m for m in model_ids))
        gate('no_startup_inference', counts['inference_posts'] == 0)
        candidates = [m for m in model_ids if MODEL in m and 'kilo' in m]
        gate('published_kilo_selection', len(candidates) == 1 and counts['catalog_get'] > 0)
        model_id = candidates[0]  # Route using the actual host publication.
        request = {'model': model_id, 'stream': True, 'max_tokens': 8,
            'messages': [{'role': 'user', 'content': 'fixture inert input'}]}
        stage = 'stream'
        status, raw = api('/v1/chat/completions', CLIENT_KEY, request)
        frames = []
        done = False
        for line in raw.splitlines():
            if line.startswith(b'data:'):
                payload = line[5:].strip()
                if payload == b'[DONE]':
                    done = True
                elif payload:
                    frames.append(json.loads(payload))
        choices = [c for frame in frames for c in frame.get('choices', [])]
        gate('stream_text_finish_done', status == 200 and done
            and ''.join(c.get('delta', {}).get('content', '') or '' for c in choices) == 'fixture-inert-text'
            and any(c.get('finish_reason') == 'stop' for c in choices))
        gate('stream_single_dispatch', counts['stream_origin'] == 1 and counts['inference_posts'] == 1)
        stage = 'redirect'
        mode['redirect'] = True
        status, raw = api('/v1/chat/completions', CLIENT_KEY, request)
        # Host may surface the upstream 307 as a non-2xx error or SSE error.
        # Physical counts below are the redirect and retry evidence.
        gate('redirect_rejected', status >= 300 or (status == 200 and b'error' in raw
            and b'fixture-inert-text' not in raw))
        time.sleep(.3)
        gate('redirect_origin_once_target_zero', counts['redirect_origin'] == 1
            and counts['redirect_target'] == 0)
        gate('exactly_two_inference_posts', counts['inference_posts'] == 2)
        gate('no_unexpected_provider_requests', counts['unexpected_http'] == 0 and counts['denied_connect'] == 0)
        gate('final_auth_ownership', auth_gate())
    except Exception as error:
        report['failures'].append(str(error) if isinstance(error, GateFailure)
            else stage + ':' + type(error).__name__)
    finally:
        if backend is not None:
            backend.terminate()
            try:
                backend.wait(timeout=2)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=1)
        # Recheck after the host has stopped: late background work must not
        # turn a previously passing snapshot into unnoticed extra dispatches.
        if not report['failures']:
            try:
                gate('stopped_host_exact_counts', counts['inference_posts'] == 2
                    and counts['stream_origin'] == 1 and counts['redirect_origin'] == 1
                    and counts['redirect_target'] == 0 and counts['unexpected_http'] == 0
                    and counts['denied_connect'] == 0)
                gate('stopped_host_auth_ownership', auth_gate(check_runtime=False))
            except Exception as error:
                report['failures'].append(str(error) if isinstance(error, GateFailure)
                    else 'final_evidence:' + type(error).__name__)
        # Close listeners without waiting for arbitrary connection threads.
        for server in servers:
            server.server_close()
        if not report['failures']:
            report['verdict'] = 'pass'
        write_verdict(WORK/'verdict.json', report)
    return 0 if report['verdict'] == 'pass' else 1


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inner':
        return inner(sys.argv[2])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--plugin', required=True, help='Exact Free Model Hub .so')
    parser.add_argument('--opencode-plugin', required=True, help='Exact native OpenCode .so')
    parser.add_argument('--output', required=True, help='NEW private evidence directory')
    args = parser.parse_args()
    os.umask(0o077)
    bwrap = shutil.which('bwrap')
    if not bwrap or not Path('/usr/bin/openssl').is_file():
        parser.error('bwrap and /usr/bin/openssl required; no fallback')
    binary, plugin, opencode = [Path(p).resolve(strict=True) for p in
        (args.binary, args.plugin, args.opencode_plugin)]
    if not all(p.is_file() for p in (binary, plugin, opencode)) or not os.access(binary, os.X_OK):
        parser.error('binary must be executable; both plugins must be regular files')
    out = Path(args.output).absolute()
    if out.exists() or out.is_symlink():
        parser.error('output must be NEW; prior evidence is never overwritten')
    out.mkdir(mode=0o700)
    out = out.resolve(strict=True)
    verdict = out/'verdict.json'
    write_verdict(verdict, {'verdict': 'fail', 'failures': ['fixture_not_completed']})
    inputs = {name: digest(path) for name, path in
        (('binary', binary), ('free_model_hub', plugin), ('opencode', opencode))}
    command = [bwrap, '--unshare-net', '--die-with-parent']
    for path in ('/usr', '/lib', '/lib64', '/bin'):
        if Path(path).exists():
            command += ['--ro-bind', path, path]
    command += ['--dir', '/etc']
    for path in ('/etc/passwd', '/etc/group', '/etc/nsswitch.conf'):
        if Path(path).exists():
            command += ['--ro-bind', path, path]
    command += ['--dir', '/plugins', '--ro-bind', str(binary), '/backend',
        '--ro-bind', str(plugin), '/plugins/free-model-hub.so',
        '--ro-bind', str(opencode), '/plugins/opencode.so',
        '--ro-bind', str(Path(__file__).resolve()), '/fixture.py',
        '--bind', str(out), '/work', '--tmpfs', '/tmp', '--dev', '/dev',
        '--proc', '/proc', '--chdir', '/work', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin', '--', '/usr/bin/python3', '/fixture.py',
        '--inner', os.readlink('/proc/self/ns/net')]
    child = None
    failure = None
    try:
        child = subprocess.Popen(command, start_new_session=True,
            env={'PATH': '/usr/bin:/bin'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        code = child.wait(timeout=52)  # Hard kill before the requested 55s ceiling.
        if code != 0:
            failure = 'sandbox_exit_nonzero'
    except subprocess.TimeoutExpired:
        failure = 'supervisor_deadline'
    except OSError:
        failure = 'sandbox_launch_failed'
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=2)
    report = json.loads(verdict.read_text())
    if failure:
        report['verdict'] = 'fail'
        report.setdefault('failures', []).append(failure)
    report['input_sha256'] = inputs
    report['supervision'] = {'unshare_net_required': True, 'process_group_killed': child is not None,
        'deadline_seconds': 52, 'environment_cleared': True, 'exact_plugins_read_only': True}
    write_verdict(verdict, report)
    print(json.dumps({'verdict': report['verdict'], 'failures': report.get('failures', []),
        'verdict_path': str(verdict)}))
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
