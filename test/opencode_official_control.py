import datetime
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import select
import unittest
import urllib.error
import urllib.request

HARNESS = pathlib.Path(__file__).resolve().parents[1] / 'native/opencode'
sys.path.insert(0, str(HARNESS))
from live_safety import LiveGuard, ProbeStopped, parse_time, utc_now
from official_control import ENDPOINT, control_endpoint, official_relay, profile_environment, public_failure


class OfficialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-official-control-')
        self.root = pathlib.Path(self.temp.name)
        self.calls = []
        self.status = 200
        self.error_body = None
        self.truncated = False
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers['Content-Length']))
                owner.calls.append({'raw': raw, 'headers': dict(self.headers)})
                self.send_response(owner.status)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Retry-After', '60')
                self.send_header('x-opencode-log-id', '01a17f70-7a91-7e31-ac46-5859c5becdd6')
                if owner.status == 307:
                    self.send_header('Location', owner.url + '/v1/should-not-follow')
                if owner.truncated:
                    self.send_header('Content-Length', '99999')
                self.end_headers()
                if owner.status != 200:
                    try:
                        self.wfile.write(owner.error_body if owner.error_body is not None else json.dumps({'error': {'type': 'FreeUsageLimitError', 'message': 'PRIVATE_PROVIDER_MESSAGE'}}).encode())
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                else:
                    self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"OFFICIAL_CONTROL_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def send(self, relay, **changes):
        body = {'model': 'glm-5.3-flash-free', 'max_tokens': 1024, 'stream': True,
                'messages': [{'role': 'user', 'content': 'synthetic control'}], **changes}
        raw = json.dumps(body).encode()
        headers = {'Authorization': 'Bearer public', 'User-Agent': 'opencode/1.18.32',
                   'x-opencode-client': 'cli', 'x-opencode-session': 'ses_synthetic',
                   'x-opencode-request': 'msg_synthetic', 'Cookie': 'PRIVATE_COOKIE_CANARY'}
        req = urllib.request.Request(relay + '/chat/completions', data=raw, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            response.read()
            return response.status, raw

    def test_profile_is_empty_and_preserves_real_metadata_and_bounded_output(self):
        env = profile_environment(self.root / 'profile', self.url + '/v1', 'glm-5.3-flash-free')
        config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
        self.assertEqual(config['provider']['opencode']['models']['glm-5.3-flash-free']['limit'], {'context': 200000, 'output': 1024})
        self.assertEqual(env['OPENCODE_AUTH_CONTENT'], '{}')
        self.assertNotIn('apiKey', config['provider']['opencode']['options'])
        self.assertNotIn('OPENCODE_API_KEY', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        catalog = json.loads(pathlib.Path(env['OPENCODE_MODELS_PATH']).read_text())
        self.assertTrue(catalog['opencode']['models']['glm-5.3-flash-free']['reasoning'])
        with self.assertRaises(ValueError):
            profile_environment(self.root / 'paid', self.url, 'paid-model')

    def test_target_is_fixed_or_explicit_synthetic_loopback_only(self):
        self.assertEqual(control_endpoint(), ENDPOINT)
        for value in ['https://example.com/v1', 'http://user:secret@127.0.0.1/v1', self.url + '/v1?key=secret']:
            with self.assertRaises(ValueError):
                control_endpoint(value)

    def test_control_preserves_body_and_cli_headers_but_never_cookies(self):
        with LiveGuard(self.root, 'control', 1, 1024) as guard:
            with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 5) as relay:
                status, raw = self.send(relay)
                self.assertEqual(status, 200)
                self.assertEqual(self.calls[0]['raw'], raw)
                headers = {key.lower(): value for key, value in self.calls[0]['headers'].items()}
                self.assertEqual(headers['authorization'], 'Bearer public')
                self.assertEqual(headers['user-agent'], 'opencode/1.18.32')
                self.assertEqual(headers['x-opencode-request'], 'msg_synthetic')
                self.assertNotIn('cookie', headers)
                self.assertEqual(self.send(relay)[0], 400)
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(guard.count, 1)
        self.assertNotIn('PRIVATE_COOKIE_CANARY', (self.root / 'live-probe-ledger.json').read_text())

    def test_unselected_model_is_never_forwarded(self):
        with LiveGuard(self.root, 'wrong-model', 1, 1024) as guard:
            with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 5) as relay:
                self.assertEqual(self.send(relay, model='paid-model')[0], 400)
            self.assertEqual(guard.count, 0)
            self.assertEqual(self.calls, [])

    @unittest.skipUnless(os.environ.get('OPENCODE_NATIVE_BUN'), 'Bun runtime not configured')
    def test_bun_transport_preserves_public_wire_and_stops_quota_retry_and_redirect(self):
        for status in [200, 429, 307]:
            with self.subTest(status=status):
                self.status = status
                self.calls.clear()
                root = self.root / str(status)
                root.mkdir()
                with LiveGuard(root, 'bun-control', 1, 1024) as guard:
                    with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 5,
                                        bun_binary=os.environ['OPENCODE_NATIVE_BUN']) as relay:
                        result, raw = self.send(relay)
                        self.assertEqual(result, status if status in [200, 429] else 400)
                        self.assertEqual(self.calls[0]['raw'], raw)
                        headers = {key.lower(): value for key, value in self.calls[0]['headers'].items()}
                        self.assertEqual(headers['authorization'], 'Bearer public')
                        self.assertEqual(headers['user-agent'], 'opencode/1.18.32')
                        self.assertNotIn('cookie', headers)
                        self.send(relay)
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(guard.count, 1)
                    if status == 429:
                        self.assertEqual(guard.entry['upstream_code'], 'FreeUsageLimitError')
                        self.assertIn('cooldown_until', guard.ledger)

    def test_quota_retains_safe_reset_and_stops_sdk_retry(self):
        self.status = 429
        with LiveGuard(self.root, 'quota', 1, 1024) as guard:
            with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 5) as relay:
                self.assertEqual(self.send(relay)[0], 429)
                self.assertEqual(self.send(relay)[0], 429)
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(guard.entry['upstream_code'], 'FreeUsageLimitError')
            self.assertEqual(guard.entry['upstream_request_id'], '01a17f70-7a91-7e31-ac46-5859c5becdd6')
            reset = parse_time(guard.ledger['cooldown_until'])
            self.assertTrue(0 < (reset - utc_now()).total_seconds() <= 60)
        self.assertNotIn('PRIVATE_PROVIDER_MESSAGE', (self.root / 'live-probe-ledger.json').read_text())

    def test_quota_headers_survive_large_or_truncated_error_bodies(self):
        transports = [None] + ([os.environ['OPENCODE_NATIVE_BUN']] if os.environ.get('OPENCODE_NATIVE_BUN') else [])
        for transport in transports:
            for truncated in [False, True]:
                with self.subTest(bun=bool(transport), truncated=truncated):
                    self.status = 429
                    self.truncated = truncated
                    self.error_body = b'broken-json' if truncated else b'x' * (3 * 1024 * 1024)
                    self.calls.clear()
                    root = self.root / ('body-' + str(bool(transport)) + '-' + str(truncated))
                    root.mkdir()
                    with LiveGuard(root, 'error-body', 1, 1024) as guard:
                        with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 2, bun_binary=transport) as relay:
                            self.assertEqual(self.send(relay)[0], 429)
                            self.assertEqual(self.send(relay)[0], 429)
                        self.assertEqual(guard.status, 429)
                        self.assertIn('cooldown_until', guard.ledger)
                        self.assertEqual(guard.entry['upstream_request_id'], '01a17f70-7a91-7e31-ac46-5859c5becdd6')
                        self.assertEqual(len(self.calls), 1)

    def test_redirect_never_forwards_to_another_path(self):
        self.status = 307
        with LiveGuard(self.root, 'redirect', 1, 1024) as guard:
            with official_relay(guard, 'glm-5.3-flash-free', self.url + '/v1', 5) as relay:
                self.assertEqual(self.send(relay)[0], 400)
            self.assertEqual(len(self.calls), 1)

    def test_failure_parser_handles_malformed_types_and_headers_without_raw_messages(self):
        failure = public_failure(b'{"error":{"type":{"unexpected":true},"message":"PRIVATE"}}', {'retry-after': '60'})
        self.assertEqual(failure['code'], 'upstream_http_error')
        self.assertIn('retry_at', failure)
        self.assertNotIn('PRIVATE', json.dumps(failure))

    def test_runner_reserves_once_and_preserves_report_on_replay(self):
        binary = self.root / 'fake-official-cli'
        binary.write_text('''#!/usr/bin/python3
import os,sys,json,urllib.request
assert sys.stdin.read() == ''
if '--version' in sys.argv:
 print('1.18.32');raise SystemExit(0)
model=sys.argv[sys.argv.index('--model')+1].split('/',1)[1]
config=json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])['provider']['opencode']
req=urllib.request.Request(config['options']['baseURL']+'/chat/completions',data=json.dumps({'model':model,'max_tokens':1024,'stream':True,'messages':[{'role':'user','content':'synthetic'}]}).encode(),headers={'Authorization':'Bearer public','User-Agent':'opencode/1.18.32'})
with urllib.request.urlopen(req) as response:response.read()
print(json.dumps({'type':'text','part':{'text':'OFFICIAL_CONTROL_OK'}}))
print(json.dumps({'type':'step_finish','part':{'reason':'stop'}}))
''')
        binary.chmod(0o700)
        argv = [sys.executable, str(HARNESS / 'official-public-probe.py'), '--root', str(self.root),
                '--binary', str(binary), '--run-id', 'synthetic-runner', '--not-before', '1970-01-01T00:00:00+00:00',
                '--fixture-upstream', self.url + '/v1']
        first = subprocess.run(argv, capture_output=True, text=True, timeout=15)
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        evidence = self.root / 'live-reports/synthetic-runner.json'
        original = evidence.read_text()
        report = json.loads(original)
        self.assertEqual(report['scope'], 'synthetic')
        self.assertTrue(report['passed'])
        self.assertEqual(report['requests'], 1)
        second = subprocess.run(argv, capture_output=True, text=True, timeout=5)
        self.assertEqual(second.returncode, 2)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(evidence.read_text(), original)

    def probe_module(self):
        spec = importlib.util.spec_from_file_location('official_probe_test', HARNESS / 'official-public-probe.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_only_owned_staging_processes_stop_and_starters_run_after_failure(self):
        module = self.probe_module()
        children = []
        restore = self.root / 'restored.txt'
        try:
            for name, relative in [('worker', 'runtime/opencode/packages/sdk/src/tokligence-bridge.ts'),
                                   ('gateway', 'gateway/tgw-proxy.mjs')]:
                script = self.root / relative
                script.parent.mkdir(parents=True, exist_ok=True)
                script.write_text('import time\nprint("ready",flush=True)\ntime.sleep(30)\n')
                child = subprocess.Popen([sys.executable, script.name if name == 'gateway' else str(script)], cwd=script.parent, stdout=subprocess.PIPE, text=True)
                children.append(child)
                self.assertTrue(select.select([child.stdout], [], [], 3)[0], 'owned fixture did not start')
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                (self.root / (name + '.pid')).write_text(str(child.pid))
                (self.root / ('start-' + name + '.py')).write_text(
                    'import pathlib\nwith pathlib.Path(' + repr(str(restore)) + ").open('a') as f:f.write(" + repr(name + '\n') + ')\n')
            with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                with module.pause_staging(self.root, True):
                    self.assertTrue(all(child.poll() is not None for child in children))
                    raise RuntimeError('synthetic failure')
            self.assertEqual(restore.read_text().splitlines(), ['worker', 'gateway'])
        finally:
            for child in children:
                if child.poll() is None: child.kill()
                child.wait()
                child.stdout.close()

    def test_wrong_pid_owner_is_never_stopped(self):
        module = self.probe_module()
        foreign = self.root / 'foreign'
        foreign.mkdir()
        (foreign / 'tokligence-bridge.ts').write_text('import time;time.sleep(30)\n')
        child = subprocess.Popen([sys.executable, 'tokligence-bridge.ts'], cwd=foreign)
        try:
            (self.root / 'worker.pid').write_text(str(child.pid))
            with self.assertRaises(module.ControlSetupError):
                with module.pause_staging(self.root, True):
                    self.fail('incorrect owner accepted')
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait()


class SocketProbeTests(unittest.TestCase):
    def test_reset_is_closed_but_timeout_and_data_are_not(self):
        from socket_probe import observe_peer_close
        class Peer:
            def __init__(self, result): self.result = result
            def recv(self, _):
                if isinstance(self.result, BaseException): raise self.result
                return self.result
        self.assertEqual(observe_peer_close(Peer(b'')), 'eof')
        for error in [ConnectionResetError(), ConnectionAbortedError(), BrokenPipeError()]:
            self.assertEqual(observe_peer_close(Peer(error)), 'reset')
        self.assertEqual(observe_peer_close(Peer(TimeoutError())), 'timeout')
        self.assertEqual(observe_peer_close(Peer(b'x')), 'unexpected_data')
        with self.assertRaises(PermissionError): observe_peer_close(Peer(PermissionError()))


class AdmissionTests(unittest.TestCase):
    def test_admission_checks_time_run_gates_and_artifact_integrity_without_traffic(self):
        from run_admission import inspect_plan, REQUIRED_ARTIFACTS
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = root / 'evidence.json'
            artifact.write_text(json.dumps({'gates': {name: {'passed': True} for name in ['native_identity', 'official_lifecycle', 'outbound_attempts', 'session_comparison']}}))
            plan = {'run_id': 'single', 'model': 'glm-5.3-flash-free', 'not_before': '1970-01-01T00:00:00+00:00',
                    'window': {'id': 'window', 'request_budget': 1, 'output_budget': 1024, 'allowed_runs': ['single']},
                    'gates': {name: {'status': 'passed', 'evidence': 'evidence.json'} for name in ['native_identity', 'official_lifecycle', 'outbound_attempts', 'session_comparison']},
                    'sha256': {'evidence.json': hashlib.sha256(artifact.read_bytes()).hexdigest()}}
            for relative in REQUIRED_ARTIFACTS:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('synthetic artifact')
                plan['sha256'][relative] = hashlib.sha256(target.read_bytes()).hexdigest()
            path = root / 'plan.json'
            path.write_text(json.dumps(plan))
            self.assertEqual(inspect_plan(path, root, 'single', plan['model'], plan['not_before'])[1], [])
            self.assertIn('unselected_run_or_model', inspect_plan(path, root, 'new-id', plan['model'], plan['not_before'])[1])
            self.assertIn('comparison_time_not_reached', inspect_plan(path, root, 'single', plan['model'], '2999-01-01T00:00:00+00:00')[1])
            plan['window']['request_budget'] = True
            path.write_text(json.dumps(plan))
            self.assertIn('invalid_single_request_window', inspect_plan(path, root, 'single', plan['model'], plan['not_before'])[1])
            plan['window']['request_budget'] = 1
            plan['gates']['session_comparison']['status'] = 'pending'
            path.write_text(json.dumps(plan))
            self.assertIn('gate_incomplete:session_comparison', inspect_plan(path, root, 'single', plan['model'], plan['not_before'])[1])
            artifact.write_text('tampered')
            self.assertIn('artifact_mismatch:evidence.json', inspect_plan(path, root, 'single', plan['model'], plan['not_before'])[1])
            plan['not_before'] = '2999-01-01T00:00:00+00:00'
            path.write_text(json.dumps(plan))
            self.assertIn('comparison_time_not_reached', inspect_plan(path, root, 'single', plan['model'], plan['not_before'])[1])

    def test_runtime_binding_rejects_wrong_root_binaries_or_missing_pause(self):
        from run_admission import inspect_runtime, file_sha256
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'gateway').mkdir()
            (root / 'runtime').mkdir()
            cli = root / 'runtime/opencode-public-cli-1.18.32'
            bun = root / 'runtime/bun'
            cli.write_text('synthetic cli'); bun.write_text('synthetic bun')
            plan = {'staging_root': str(root), 'runtime': {name: {'path': str(path), 'sha256': file_sha256(path)} for name, path in [('cli', cli), ('bun', bun)]}}
            self.assertEqual(inspect_runtime(plan, root, root / 'gateway', None, bun, True), [])
            self.assertIn('owned_staging_pause_required', inspect_runtime(plan, root, root / 'gateway', None, bun, False))
            self.assertIn('staging_root_or_code_binding_mismatch', inspect_runtime(plan, root, root / 'other-code', None, bun, True))
            alternate = root / 'other-cli'; alternate.write_bytes(cli.read_bytes())
            self.assertIn('runtime_binding_mismatch:cli', inspect_runtime(plan, root, root / 'gateway', alternate, bun, True))
            bun.write_text('changed runtime')
            self.assertIn('runtime_binding_mismatch:bun', inspect_runtime(plan, root, root / 'gateway', None, bun, True))

    def test_readiness_imports_history_and_checks_aggregate_window_without_writes(self):
        from run_admission import inspect_ledger
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'live-probe.lock').touch()
            ledger = root / 'live-probe-ledger.json'
            window = {'id': 'window', 'allowed_runs': ['first', 'second'], 'request_budget': 1, 'output_budget': 1024}
            ledger.write_text(json.dumps({'runs': {'first': {'window_id': 'window', 'requests': 1, 'reserved_output_tokens': 1024}}, 'windows': {'window': window}}))
            history = root / 'public-native-probe.json'
            history.write_text(json.dumps({'retry_at': (utc_now() + datetime.timedelta(hours=1)).isoformat()}))
            before = ledger.read_bytes()
            blocked = inspect_ledger(root, 'second', window)
            self.assertIn('provider_cooldown_active', blocked)
            self.assertIn('live_window_budget_exhausted', blocked)
            self.assertEqual(ledger.read_bytes(), before)
            self.assertIn('live_window_limits_changed', inspect_ledger(root, 'second', {**window, 'request_budget': 2}))

    def test_retired_public_live_entrypoint_cannot_be_reactivated_by_new_plan_or_run(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder) / 'must-not-be-created'
            for flags in [[], ['--check-only'], ['--plan', '/nonexistent/plan', '--pause-staging']]:
                result = subprocess.run([sys.executable, str(HARNESS / 'official-public-probe.py'),
                    '--root', str(root), '--binary', '/nonexistent/binary',
                    '--run-id', 'new-id-is-not-a-bypass', '--not-before', '1970-01-01T00:00:00+00:00',
                    *flags], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout), {
                    'status': 'retired', 'inference_performed': False,
                    'blockers': ['public_reference_not_oauth_comparison']})
                self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
