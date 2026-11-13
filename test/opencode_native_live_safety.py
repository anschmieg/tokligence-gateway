import concurrent.futures
import datetime
import http.server
import http.client
import socket
import time
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import stat
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'native/opencode'))
from live_safety import LiveGuard, ProbeStopped, claude_relay, gateway_url, utc_now


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-live-guard-')
        self.root = pathlib.Path(self.temp.name)
        self.calls = []
        self.status = 200
        self.redirect = None
        self.auth = 'synthetic'
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                owner.calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(owner.status)
                self.send_header('Content-Type', 'application/json')
                if owner.redirect:
                    self.send_header('Location', owner.redirect)
                self.end_headers()
                value = {'content': [{'type': 'text', 'text': 'fixture'}], 'type': 'message'} if owner.status == 200 else {'error': {'code': 'FreeUsageLimitError', 'retry_at': (utc_now() + datetime.timedelta(hours=1)).isoformat()}}
                self.wfile.write(json.dumps(value).encode())

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def send(self, relay, model='opencode-native/beam-free', suffix='', auth=None):
        body = {'model': model, 'messages': [{'role': 'user', 'content': 'synthetic'}], 'max_tokens': 32000}
        req = urllib.request.Request(relay + '/v1/messages' + suffix, data=json.dumps(body).encode(), headers={'Authorization': self.auth if auth is None else auth})
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            response.read()
            return response.status

    def test_window_budget_survives_new_run_ids_and_cannot_be_increased(self):
        window = {'id': 'synthetic-window', 'request_budget': 1, 'output_budget': 1024, 'allowed_runs': ['first', 'second']}
        with LiveGuard(self.root, 'first', 1, 1024, window=window) as guard:
            guard.reserve(1024)
        with LiveGuard(self.root, 'second', 1, 1024, window=window) as guard:
            with self.assertRaisesRegex(ProbeStopped, 'Aggregate'):
                guard.reserve(1)
        with self.assertRaisesRegex(ProbeStopped, 'cannot be changed'):
            with LiveGuard(self.root, 'third', 2, 2048, window={**window, 'request_budget': 2, 'allowed_runs': ['first', 'second', 'third']}):
                pass
        with self.assertRaisesRegex(ProbeStopped, 'unselected'):
            with LiveGuard(self.root, 'unlisted', 1, 1, window=window):
                pass

    def test_reservation_syncs_file_then_rename_then_directory_and_fails_before_io(self):
        events = []
        original_sync = os.fsync
        original_replace = os.replace
        def sync(fd):
            events.append('directory_sync' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file_sync')
            return original_sync(fd)
        def replace(*args):
            events.append('rename')
            return original_replace(*args)
        with mock.patch('live_safety.os.fsync', side_effect=sync), mock.patch('live_safety.os.replace', side_effect=replace):
            with LiveGuard(self.root, 'synced', 2, 2048) as guard:
                events.clear()
                guard.reserve(1024)
                self.assertEqual(events, ['file_sync', 'rename', 'directory_sync'])
                with mock.patch('live_safety.os.fsync', side_effect=OSError('synthetic disk failure')):
                    with self.assertRaises(OSError):
                        guard.reserve(1024)
                self.assertEqual(json.loads((self.root / 'live-probe-ledger.json').read_text())['runs']['synced']['requests'], 1)
                self.assertEqual(self.calls, [])

    def test_loopback_gateway_ignores_proxy_environment(self):
        hits = []

        class Proxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                hits.append(self.path)
                self.send_response(429)
                self.end_headers()

        proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            address = 'http://127.0.0.1:' + str(proxy.server_port)
            env = {**os.environ, 'HTTP_PROXY': address, 'http_proxy': address, 'NO_PROXY': '', 'no_proxy': '',
                   'PYTHONPATH': str(pathlib.Path(__file__).resolve().parents[1] / 'native/opencode')}
            code = "from live_safety import open_gateway; import urllib.request,sys; r=open_gateway(urllib.request.Request(sys.argv[1], data=b'{}'),timeout=2); print(r.status);r.close()"
            result = subprocess.run([sys.executable, '-c', code, self.url + '/v1/chat/completions'],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), '200')
            self.assertEqual(hits, [])
            self.assertEqual(len(self.calls), 1)
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join()

    def test_single_owner_budget_and_no_replay(self):
        with LiveGuard(self.root, 'one', 2, 1024) as guard:
            guard.reserve(512)
            with self.assertRaises(BlockingIOError):
                with LiveGuard(self.root, 'competing', 2, 1024):
                    self.fail('second owner acquired lock')
            guard.reserve(512)
            with self.assertRaises(ProbeStopped):
                guard.reserve(1)
            self.assertEqual(guard.count, 2)
            self.assertEqual(guard.output_count, 1024)
        with self.assertRaises(ProbeStopped):
            with LiveGuard(self.root, 'one', 2, 1024):
                self.fail('replayed run')
        ledger = json.loads((self.root / 'live-probe-ledger.json').read_text())
        self.assertEqual(ledger['runs']['one']['requests'], 2)
        self.assertEqual((self.root / 'live-probe-ledger.json').stat().st_mode & 0o777, 0o600)

    def test_crash_reservation_survives_and_kernel_releases_lock(self):
        program = "import os,sys;sys.path.insert(0,sys.argv[1]);from live_safety import LiveGuard;g=LiveGuard(sys.argv[2],'crashed',1,1024);g.__enter__();g.reserve(1024);os._exit(9)"
        child = subprocess.run([sys.executable, '-c', program, str(pathlib.Path(__file__).resolve().parents[1] / 'native/opencode'), str(self.root)], capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 9)
        with self.assertRaises(ProbeStopped):
            with LiveGuard(self.root, 'crashed', 1, 1024):
                self.fail('crashed run replayed')
        with LiveGuard(self.root, 'new-hypothesis', 1, 1024):
            pass

    def test_historical_cooldown_prevents_any_attempt(self):
        (self.root / 'public-native-probe.json').write_text(json.dumps({
            'retry_at': (utc_now() + datetime.timedelta(hours=1)).isoformat()}))
        with self.assertRaises(ProbeStopped):
            with LiveGuard(self.root, 'cooldown', 1, 1024):
                self.fail('cooldown ignored')
        self.assertEqual(json.loads((self.root / 'live-probe-ledger.json').read_text())['runs'], {})

    def test_late_provider_quota_is_not_hidden_by_local_stop(self):
        with LiveGuard(self.root, 'late-quota', 1, 1024) as guard:
            guard.reserve(1024)
            with self.assertRaises(ProbeStopped):
                guard.stop('Local client stopped')
            with self.assertRaises(ProbeStopped):
                guard.stop('Provider quota arrived during cleanup', 429,
                    {'retry_at': (utc_now() + datetime.timedelta(hours=1)).isoformat()})
            self.assertEqual(guard.status, 429)
        with self.assertRaises(ProbeStopped):
            with LiveGuard(self.root, 'after-late-quota', 1, 1024):
                self.fail('late quota cooldown was lost')

    def test_relay_clamps_cli_output_and_stops_at_budget(self):
        self.auth = 'synthetic-authorization-canary'
        with LiveGuard(self.root, 'cli-budget', 2, 16384) as guard:
            with claude_relay(guard, self.url, 'beam-free', 'synthetic-authorization-canary', 5) as relay:
                self.assertEqual(self.send(relay, suffix='?beta=true'), 200)
                self.assertEqual(self.send(relay), 200)
                self.assertEqual(self.send(relay), 429)
            self.assertEqual([call['max_tokens'] for call in self.calls], [8192, 8192])
            self.assertEqual(guard.count, 2)
        self.assertNotIn('synthetic-authorization-canary', (self.root / 'live-probe-ledger.json').read_text())

    def test_unauthorized_relay_calls_do_not_forward_or_consume_budget(self):
        with LiveGuard(self.root, 'unauthorized', 1, 8192) as guard:
            with claude_relay(guard, self.url, 'beam-free', self.auth, 5) as relay:
                self.assertEqual(self.send(relay, auth='wrong'), 401)
                self.assertEqual(guard.count, 0)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.send(relay), 200)

    def test_paid_or_unselected_model_never_reaches_gateway(self):
        with LiveGuard(self.root, 'wrong-model', 2, 16384) as guard:
            with claude_relay(guard, self.url, 'beam-free', 'synthetic', 5) as relay:
                self.assertEqual(self.send(relay, 'opencode-native/paid-model'), 400)
            self.assertEqual(self.calls, [])
            self.assertEqual(guard.count, 0)

    def test_quota_stops_concurrent_retries_and_persists_cooldown(self):
        self.status = 429
        with LiveGuard(self.root, 'cli-quota', 5, 40960) as guard:
            with claude_relay(guard, self.url, 'beam-free', 'synthetic', 5) as relay:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    codes = list(pool.map(lambda _: self.send(relay), range(2)))
            self.assertEqual(codes, [429, 429])
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(guard.count, 1)
        with self.assertRaises(ProbeStopped):
            with LiveGuard(self.root, 'after-quota', 1, 1024):
                self.fail('quota retried')

    def test_relay_validates_stream_completion_and_embedded_errors(self):
        variants = [
            (b'data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n', 200),
            (b'data: {"type":"error","error":{"message":"synthetic"}}\n\n', 502),
            (b'data: {"type":"message_start"}\n\n', 502),
            (b'data: not-json\n\n', 502),
            (b'data: {"type":"message_stop"}\n\ndata: {"type":"content_block_delta"}\n\n', 502),
            (b'data: {"type":"error","error":{"type":"rate_limit_error","upstream_status":429,"code":"FreeUsageLimitError"}}\n\n', 429),
        ]
        for index, (payload, expected) in enumerate(variants):
            calls = []
            class Upstream(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_): pass
                def do_POST(self):
                    self.rfile.read(int(self.headers['Content-Length']))
                    calls.append(1)
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(payload)
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with LiveGuard(self.root, 'stream-' + str(index), 2, 16384) as guard:
                    with claude_relay(guard, 'http://127.0.0.1:' + str(server.server_port), 'beam-free', self.auth, 5) as relay:
                        body = {'model': 'opencode-native/beam-free', 'stream': True,
                                'messages': [{'role': 'user', 'content': 'synthetic'}], 'max_tokens': 10}
                        req = urllib.request.Request(relay + '/v1/messages', data=json.dumps(body).encode(), headers={'Authorization': self.auth})
                        try: response = urllib.request.urlopen(req, timeout=5)
                        except urllib.error.HTTPError as error: response = error
                        with response:
                            self.assertEqual(response.status, expected)
                            if expected == 200: self.assertEqual(response.headers['Content-Type'], 'text/event-stream')
                            response.read()
                        self.assertEqual(guard.count, 1)
                        if expected != 200:
                            self.assertTrue(guard.blocked)
                            self.assertEqual(self.send(relay), expected)
                    self.assertEqual(calls, [1])
                    if expected == 429:
                        self.assertEqual(guard.status, 429)
                        self.assertIn('cooldown_until', json.loads((self.root / 'live-probe-ledger.json').read_text()))
            finally:
                server.shutdown(); server.server_close(); thread.join()

    def test_client_disconnect_cancels_upstream_and_prevents_next_request(self):
        started = threading.Event()
        closed = threading.Event()
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'data: {"type":"message_start"}\n\n')
                self.wfile.flush()
                started.set()
                self.connection.settimeout(3)
                try:
                    if self.connection.recv(1) == b'': closed.set()
                except ConnectionResetError: closed.set()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with LiveGuard(self.root, 'cancel-cli', 2, 16384) as guard:
                with claude_relay(guard, 'http://127.0.0.1:' + str(server.server_port), 'beam-free', self.auth, 5) as relay:
                    client = http.client.HTTPConnection('127.0.0.1', int(relay.rsplit(':', 1)[1]), timeout=5)
                    body = {'model': 'opencode-native/beam-free', 'stream': True, 'messages': [], 'max_tokens': 10}
                    client.request('POST', '/v1/messages', body=json.dumps(body), headers={'Authorization': self.auth})
                    self.assertTrue(started.wait(2))
                    client.sock.shutdown(socket.SHUT_RDWR)
                    client.close()
                    self.assertTrue(closed.wait(2), 'upstream inference socket was left running')
                    deadline = time.monotonic() + 2
                    while not guard.blocked and time.monotonic() < deadline: time.sleep(.01)
                    self.assertTrue(guard.blocked)
                    self.assertEqual(self.send(relay), 429)
                    self.assertEqual(guard.count, 1)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_redirects_and_external_gateway_urls_are_rejected(self):
        for value in ['https://example.com', 'http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/path']:
            with self.assertRaises(ValueError):
                gateway_url(value)
        self.status = 307
        self.redirect = self.url + '/would-be-second-request'
        with LiveGuard(self.root, 'redirect', 5, 40960) as guard:
            with claude_relay(guard, self.url, 'beam-free', 'synthetic', 5) as relay:
                self.assertEqual(self.send(relay), 307)
            self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
