"""Internal synthetic fixture. Must run in the launcher's separate network namespace."""
import http.server
import http.client
import copy
import contextlib
import json
import os
import pathlib
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, '/gateway/native/opencode')
from live_safety import LiveGuard
from oauth_meter import native_meter
from oauth_profile import cli_command, control_config, verify_free_model

ROOT = pathlib.Path('/work')
STATE = ROOT / 'state'
MODEL = 'glm-5.3-flash-free'
API_MODEL = 'synthetic-glm-api-alias'
KEY = 'synthetic-native-oauth-fixture-key-000000000'
captures = []
phase = 'seed'
children = []
started = threading.Event()
closed = threading.Event()


def private_json(name, value):
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(value, file, indent=2)


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_GET(self):
        assert self.path == '/console/api/v2/config', self.path
        assert not self.headers.get('cookie')
        assert self.headers.get('authorization') == 'Bearer synthetic-access-canary'
        assert self.headers.get('x-org-id') == 'synthetic-org'
        captures.append({'phase': phase, 'action': 'config', 'oauth': True, 'organization': True,
                         'user_agent': self.headers.get('user-agent')})
        body = {'providers': {'opencode': {
            'package': '@opencode/ai/providers/openai-compatible',
            'settings': {'baseURL': origin + '/v1'},
            'headers': {'x-org-id': 'synthetic-org'},
            'models': {MODEL: {'modelID': API_MODEL, 'name': 'Synthetic free model',
                'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']},
                'cost': {'input': 0, 'output': 0, 'cache': {'read': 0, 'write': 0}},
                'limit': {'context': 100000, 'output': 1024},
                'compatibility': {'maxTokensField': 'max_tokens', 'reasoningField': 'reasoning_content'},
            }},
        }}}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path == '/console/auth/device/token':
            assert body['grant_type'] == 'refresh_token'
            assert body['refresh_token'] == 'synthetic-refresh-canary'
            captures.append({'phase': phase, 'action': 'refresh'})
            value = {'access_token': 'synthetic-access-canary', 'refresh_token': 'synthetic-rotated-canary',
                     'expires_in': 86400, 'org_id': 'synthetic-org'}
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(value).encode()); return
        assert self.path == '/v1/chat/completions', self.path
        assert not self.headers.get('cookie')
        assert self.headers.get('authorization') == 'Bearer synthetic-access-canary'
        assert self.headers.get('x-org-id') == 'synthetic-org'
        assert body['model'] == API_MODEL
        captures.append({'phase': phase, 'action': 'inference', 'oauth': True, 'organization': True,
                         'headers': {key.lower(): value for key, value in self.headers.items()
                                     if key.lower() not in ('authorization', 'cookie')}, 'body': body})
        if phase == 'reference-profile':
            assert not body.get('tools'), 'Native control tool-deny policy did not remove tools'
            assert body.get('max_tokens') == 768, 'Native control output budget not preserved'
        if phase == 'reference-quota':
            self.send_response(429); self.send_header('Content-Type', 'application/json'); self.send_header('Retry-After', '60'); self.end_headers()
            self.wfile.write(b'{"error":{"type":"FreeUsageLimitError"}}'); return
        if phase.endswith('cancel'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
            self.wfile.flush(); started.set()
            self.connection.settimeout(8)
            try:
                if self.connection.recv(1) == b'': closed.set()
            except ConnectionResetError: closed.set()
            return
        needs_tools = phase.endswith('tools') and body['messages'][-1]['role'] != 'tool'
        if needs_tools:
            assert any(tool['function']['name'] == 'execute' for tool in body.get('tools', [])), 'Native execute tool unavailable'
            delta = {'reasoning_content': 'synthetic reasoning preserved across tool continuation', 'tool_calls': [
                {'index': 0, 'id': 'synthetic_ok', 'type': 'function', 'function': {'name': 'execute', 'arguments': json.dumps({'code': 'console.log("SYNTHETIC_EXECUTE_OK")'})}},
                {'index': 1, 'id': 'synthetic_error', 'type': 'function', 'function': {'name': 'execute', 'arguments': json.dumps({'code': 'throw new Error("SYNTHETIC_EXECUTE_ERROR")'})}},
            ]}
        else:
            delta = {'content': 'OAUTH_REFERENCE_OK'}
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        self.wfile.write(('data: ' + json.dumps({'id': 'synthetic', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}) + '\n\n'
            + 'data: ' + json.dumps({'id': 'synthetic', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if needs_tools else 'stop'}]}) + '\n\n'
            + 'data: [DONE]\n\n').encode())


def spawn(argv, env, name):
    out = open(ROOT / (name + '.stdout'), 'w'); err = open(ROOT / (name + '.stderr'), 'w')
    os.chmod(out.name, 0o600); os.chmod(err.name, 0o600)
    child = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
    children.append((child, out, err))
    return child


def stop(child):
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL); child.wait()
    # A standalone CLI can have descendants even after its immediate parent exits.
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass


def wait_ready(child, name, predicate):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if child.poll() is not None: raise RuntimeError(name + ' exited; inspect private synthetic logs')
        text = (ROOT / (name + '.stdout')).read_text()
        result = predicate(text)
        if result: return result
        time.sleep(.05)
    raise RuntimeError(name + ' readiness deadline exceeded')


def wait_success(child, guard, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if guard.blocked and not getattr(guard, 'pending_error_body', False): raise RuntimeError(guard.blocked)
        if child.poll() is not None:
            assert child.returncode == 0, 'Actual CLI failed; inspect private synthetic logs'
            return
        time.sleep(.025)
    raise RuntimeError('Actual CLI deadline exceeded')


def post(url, body, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', **headers})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=25) as reply:
        return json.loads(reply.read())


def compare(reference, candidate):
    left, right = copy.deepcopy(reference['body']), copy.deepcopy(candidate['body'])
    differences = []
    if left.get('tool_choice') is None and 'tool_choice' not in left and right.get('tool_choice') == 'auto':
        differences.append('intentional bridge tool_choice:auto versus native omission')
        del right['tool_choice']
    if left.get('tools') == [] and 'tools' in left and 'tools' not in right:
        differences.append('intentional tool-free control override tools:[] versus native bridge omission')
        left.pop('tools')
    assert len(left.get('tools', [])) == len(right.get('tools', []))
    for a, b in zip(left.get('tools', []), right.get('tools', [])):
        if a['function'].get('strict') is False and 'strict' not in b['function']:
            a['function'].pop('strict')
            if 'intentional bridge omission of native strict:false' not in differences:
                differences.append('intentional bridge omission of native strict:false')
    for a, b in zip(left['messages'], right['messages']):
        if a.get('role') == b.get('role') == 'assistant' and a.get('tool_calls') and 'content' in a and a.get('content') is None and b.get('content') == '':
            a['content'] = ''
            differences.append('intentional legacy bridge empty text versus native null on tool-call assistant')
    assert left == right, 'Unclassified provider body difference: ' + str([key for key in set(left) | set(right) if left.get(key) != right.get(key)])
    volatile = {'b3', 'traceparent', 'x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id', 'content-length'}
    a, b = reference['headers'], candidate['headers']
    assert {k:v for k,v in a.items() if k not in volatile} == {k:v for k,v in b.items() if k not in volatile}, 'Unclassified stable header difference'
    for headers in [a, b]:
        assert headers['user-agent'] == 'opencode/latest/2.1.4/cli'
        assert len({headers[key] for key in ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']}) == 1
    return differences


def main():
    global origin, phase
    assert not pathlib.Path('/gateway', sys.argv[3]).exists(), 'Private checkout canary was mounted'
    assert os.readlink('/proc/self/ns/net') != sys.argv[1], 'Network namespace was not isolated'
    sock = socket.socket(); sock.settimeout(.2)
    try:
        sock.connect(('1.1.1.1', 443))
        raise RuntimeError('External network unexpectedly available')
    except OSError: pass
    finally: sock.close()
    STATE.mkdir(mode=0o700)
    for directory in ['data', 'config', 'cache', 'state', 'workspace']:
        (STATE / directory).mkdir(mode=0o700)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(STATE), 'PWD': str(STATE / 'workspace'),
           **{'XDG_' + key + '_HOME': str(STATE / key.lower()) for key in ['DATA', 'CONFIG', 'CACHE', 'STATE']},
           'OPENCODE_DB': str(STATE / 'opencode.db'), 'OPENCODE_DISABLE_MODELS_FETCH': '1',
           'OPENCODE_CONFIG_PROJECT_DISABLE': '1', 'OPENCODE_DISABLE_CLAUDE_CODE': '1',
           'OPENCODE_DISABLE_FFF': '1', 'OPENCODE_FILEWATCHER_DISABLE': '1',
           'OPENCODE_DISABLE_AUTOUPDATE': '1', 'DO_NOT_TRACK': '1', 'OPENCODE_PASSWORD': 'synthetic-server-password'}
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    origin = 'http://127.0.0.1:' + str(server.server_port)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    cli = cli_command('/source', '/bun')
    stack = contextlib.ExitStack()
    try:
        seed = spawn(['/bun', sys.argv[2], origin + '/console'], env, 'seed')
        assert seed.wait(timeout=25) == 0, 'Synthetic OAuth seed failed; inspect private logs'
        phase = 'reference'
        import re
        (ROOT / 'meter-state').mkdir(mode=0o700)
        guard = stack.enter_context(LiveGuard(ROOT / 'meter-state', 'synthetic-oauth-reference', 7, 7168))
        meter_config = stack.enter_context(native_meter(guard, API_MODEL, allow_tools=True, max_calls=7, capture_requests=True))
        private_json('meter-config.json', {**meter_config, 'inference': origin + '/v1/chat/completions', 'console': origin + '/console'})
        server_env = {**env, 'OPENCODE_PROBE_METER_FILE': '/work/meter-config.json'}
        metered_cli = cli[:1] + ['--preload', '/gateway/native/opencode/metered-native-fetch.mjs'] + cli[1:]
        reference_server = spawn(metered_cli + ['serve', '--port', '0', '--hostname', '127.0.0.1'], server_env, 'reference-server')
        server_url = wait_ready(reference_server, 'reference-server', lambda text: (m.group(1) if (m := re.search(r'server listening on (http://127.0.0.1:\d+)', text)) else None))
        assert verify_free_model(server_url, env['OPENCODE_PASSWORD'], STATE / 'workspace', MODEL) == API_MODEL
        reference = spawn(cli + ['run', '--server', server_url, '--model', 'opencode/' + MODEL, '--format', 'json',
                                 '--title', 'Synthetic OAuth comparison', 'Reply OAUTH_REFERENCE_OK. Do not use tools.'], env, 'reference')
        wait_success(reference, guard, 35)
        stop(reference)
        assert 'OAUTH_REFERENCE_OK' in (ROOT / 'reference.stdout').read_text()
        first_event = json.loads((ROOT / 'reference.stdout').read_text().splitlines()[0])
        session_id = first_event['sessionID']
        phase = 'reference-resume'
        resume = spawn(cli + ['run', '--server', server_url, '--session', session_id, '--format', 'json',
                              'Continue with OAUTH_REFERENCE_OK.'], env, 'reference-resume')
        wait_success(resume, guard, 25)
        stop(resume)
        phase = 'reference-tools'
        tools = spawn(cli + ['run', '--server', server_url, '--session', session_id, '--format', 'json',
                             'Run the two synthetic execute examples; report OAUTH_REFERENCE_OK after success/error.'], env, 'reference-tools')
        wait_success(tools, guard, 30)
        stop(tools)
        reference_calls = [item for item in captures if item['action'] == 'inference' and item['phase'].startswith('reference')]
        assert len(reference_calls) == 4, 'Expected basic/resume/tool call/tool result request sequence'
        assert all(item['headers']['x-opencode-session'] == session_id for item in reference_calls)
        continuation = reference_calls[-1]['body']['messages']
        assert any(item.get('reasoning_content') == 'synthetic reasoning preserved across tool continuation' for item in continuation), 'Actual native reasoning replay missing'
        assert len([item for item in continuation if item['role'] == 'tool']) == 2
        tool_results = {item['tool_call_id']: item['content'] for item in continuation if item['role'] == 'tool'}
        assert 'Logs:\nSYNTHETIC_EXECUTE_OK' in tool_results['synthetic_ok'] and not tool_results['synthetic_ok'].startswith('Error:')
        assert tool_results['synthetic_error'].startswith('Error: SYNTHETIC_EXECUTE_ERROR')
        phase = 'reference-cancel'; started.clear(); closed.clear()
        cancelling = spawn(cli + ['run', '--server', server_url, '--session', session_id, '--format', 'json',
                                  'Wait for a response until interrupted.'], env, 'reference-cancel')
        assert started.wait(10), 'Native cancellation fixture never reached inference'
        deadline = time.monotonic() + 5
        while 'step_start' not in (ROOT / 'reference-cancel.stdout').read_text() and time.monotonic() < deadline: time.sleep(.025)
        assert 'step_start' in (ROOT / 'reference-cancel.stdout').read_text(), 'Native CLI did not observe promoted model step'
        os.killpg(cancelling.pid, signal.SIGINT)
        cancelling.wait(timeout=8)
        assert closed.wait(5), 'Actual native CLI cancellation left provider socket open'
        stop(cancelling)
        stop(reference_server)
        phase = 'reference-profile'
        meter_profile = {**meter_config, 'inference': origin + '/v1/chat/completions', 'console': origin + '/console', 'controlMarker': 'OAUTH_REFERENCE_OK'}
        private_json('meter-profile.json', meter_profile)
        profile_env = {**env, 'OPENCODE_CONFIG_CONTENT': json.dumps(control_config(768))}
        reference_server = spawn(metered_cli + ['serve', '--port', '0', '--hostname', '127.0.0.1'],
                                 {**server_env, **profile_env, 'OPENCODE_PROBE_METER_FILE': '/work/meter-profile.json'}, 'reference-control-server')
        server_url = wait_ready(reference_server, 'reference-control-server', lambda text: (m.group(1) if (m := re.search(r'server listening on (http://127.0.0.1:\d+)', text)) else None))
        profile = spawn(cli + ['run', '--server', server_url, '--model', 'opencode/' + MODEL, '--format', 'json',
                               '--title', 'Synthetic control profile', 'Reply OAUTH_REFERENCE_OK.'], profile_env, 'reference-profile')
        wait_success(profile, guard, 20); stop(profile)
        assert 'OAUTH_REFERENCE_OK' in (ROOT / 'reference-profile.stdout').read_text()
        phase = 'reference-quota'
        quota = spawn(cli + ['run', '--server', server_url, '--session', session_id, '--format', 'json', 'Synthetic quota fault.'], profile_env, 'reference-quota')
        deadline = time.monotonic() + 10
        while (guard.status != 429 or getattr(guard, 'pending_error_body', False)) and time.monotonic() < deadline: time.sleep(.025)
        assert guard.status == 429, 'Native provider rejection did not reach durable meter'
        stop(quota); stop(reference_server)
        assert guard.native_requests == [item['body'] for item in captures if item['action'] == 'inference' and item['phase'].startswith('reference')], 'Native fetch meter changed or missed a request'
        reference_calls.append(next(item for item in captures if item['action'] == 'inference' and item['phase'] == 'reference-profile'))
        assert guard.count == 7, 'Actual native fetch requests did not traverse the meter'
        reference_cancel = [item for item in captures if item['action'] == 'inference' and item['phase'] == 'reference-cancel'][0]
        phase = 'gateway'
        worker_env = {**env, 'OPENCODE_NATIVE_STATE': str(STATE), 'OPENCODE_NATIVE_KEY': KEY,
                      'OPENCODE_NATIVE_MODELS': MODEL, 'OPENCODE_NATIVE_PORT': '0',
                      'OPENCODE_NATIVE_REQUEST_TIMEOUT_MS': '15000'}
        worker = spawn(['/bun', '/source/packages/sdk/src/tokligence-bridge.ts'], worker_env, 'worker')
        def worker_ready(text):
            for line in text.splitlines():
                try:
                    value = json.loads(line)
                    if value.get('event') == 'native_worker_ready': return value['port']
                except ValueError: pass
        worker_port = wait_ready(worker, 'worker', worker_ready)
        gateway_env = {**env, 'PROXY_PORT': '0', 'PROXY_HOST': '127.0.0.1', 'ROUTING_CONFIG_PATH': '/gateway/gateway.routes.yaml', 'UPSTREAM_BASE_URL': 'http://127.0.0.1:1/v1',
                       'OPENCODE_NATIVE_ENABLED': 'true', 'OPENCODE_NATIVE_URL': f'http://127.0.0.1:{worker_port}/v1',
                       'OPENCODE_NATIVE_KEY': KEY, 'TOKLIGENCE_AUTH_SECRET': 'synthetic-gateway-key', 'TOKLIGENCE_ADMIN_SECRET': 'synthetic-admin-key'}
        gateway = spawn(['/node', '/gateway/tgw-proxy.mjs'], gateway_env, 'gateway')
        import re
        gateway_port = wait_ready(gateway, 'gateway', lambda text: (match.group(1) if (match := re.search(r'tgw-proxy :(\d+)', text)) else None))
        classified = set()
        gateway_calls = []
        gateway_headers = {'Authorization': 'Bearer synthetic-gateway-key', 'x-session-id': 'synthetic-oauth-conversation'}
        for index, captured in enumerate(reference_calls):
            phase = 'gateway-tools' if captured['phase'] == 'reference-tools' else 'gateway'
            reference_body = captured['body']
            request = {key: reference_body[key] for key in ['messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop'] if key in reference_body}
            request.update(model='opencode-native/' + MODEL, stream=False, max_tokens=reference_body['max_tokens'])
            selected_headers = {**gateway_headers, 'x-session-id': 'synthetic-control-conversation'} if index == 4 else gateway_headers
            reply = post(f'http://127.0.0.1:{gateway_port}/v1/chat/completions', request, selected_headers)
            if index == 2: assert len(reply['choices'][0]['message']['tool_calls']) == 2
            else: assert reply['choices'][0]['message']['content'] == 'OAUTH_REFERENCE_OK'
            current = [item for item in captures if item['action'] == 'inference' and item['phase'].startswith('gateway')]
            assert len(current) == index + 1, 'Unexpected gateway physical dispatch count'
            candidate = current[-1]; gateway_calls.append(candidate)
            classified.update(compare(captured, candidate))
        assert len({item['headers']['x-opencode-session'] for item in gateway_calls[:4]}) == 1
        assert gateway_calls[4]['headers']['x-opencode-session'] != gateway_calls[0]['headers']['x-opencode-session']
        phase = 'gateway-cancel'; started.clear(); closed.clear()
        request = {key: reference_cancel['body'][key] for key in ['messages', 'tools'] if key in reference_cancel['body']}
        request.update(model='opencode-native/' + MODEL, stream=True, max_tokens=1024)
        connection = http.client.HTTPConnection('127.0.0.1', int(gateway_port), timeout=10)
        connection.request('POST', '/v1/chat/completions', body=json.dumps(request), headers={'Content-Type': 'application/json', **gateway_headers})
        assert started.wait(10)
        native_socket = connection.sock
        response = connection.getresponse(); response.read(1)
        native_socket.shutdown(socket.SHUT_RDWR); response.close(); connection.close()
        assert closed.wait(5), 'Actual gateway cancellation left provider socket open'
        assert not any(token in json.dumps(captures) for token in ['synthetic-access-canary', 'synthetic-refresh-canary', 'synthetic-rotated-canary', 'synthetic-expired-access'])
        private_json('captures.json', captures)
        summary = {'passed': True, 'scope': 'synthetic same-version actual CLI OAuth and actual gateway/worker',
                   'external_network_blocked': True, 'cli_version': '2.1.4', 'bun_version': '1.4.4',
                   'credential_owners': 'sequential seed -> official CLI -> native worker; one synthetic database',
                   'refresh_calls': sum(item['action'] == 'refresh' for item in captures),
                   'reference_inference_calls': len(reference_calls), 'gateway_inference_calls': len(gateway_calls),
                   'oauth_on_both': all(item['oauth'] for item in reference_calls + gateway_calls),
                   'org_on_both': all(item['organization'] for item in reference_calls + gateway_calls),
                   'reasoning_replay_verified': True, 'parallel_tool_success_and_error': True,
                   'persisted_cli_resume': True, 'reference_cancel_closed': True, 'gateway_cancel_closed': True,
                   'classified_body_differences': sorted(classified), 'native_fetch_meter_verified': True, 'private_checkout_excluded': True, 'credential_values_excluded': True,
                   'reference_cancellation_calls': 1, 'gateway_cancellation_calls': 1, 'reference_quota_calls': 1, 'control_profile_calls': 1, 'control_profile_tool_deny_and_budget_verified': True, 'native_free_catalog_checked': True, 'catalog_alias_verified': True, 'total_inference_calls': 13, 'quota_cooldown_persisted': 'cooldown_until' in guard.ledger, 'live_tested': False}
        private_json('summary.json', summary)
    finally:
        if not (ROOT / 'captures.json').exists(): private_json('captures.json', captures)
        for child, out, err in reversed(children): stop(child); out.close(); err.close()
        stack.close()
        server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    main()
