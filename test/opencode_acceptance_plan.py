import concurrent.futures
import hashlib
import http.server
import json
import pathlib
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'native/opencode'))
import acceptance_plan as admission
from live_safety import ProbeStopped, claude_relay


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-admitted-case-')
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'live-reports').mkdir()
        (self.root / 'live-probe.lock').write_text('')
        (self.root / 'live-probe-ledger.json').write_text(json.dumps({'runs': {'foundation': {'status': 'finished', 'requests': 2, 'reserved_output_tokens': 2048, 'window_id': 'foundation-window'}}}))
        self.foundation_dir = self.root / 'helpers'; self.foundation_dir.mkdir()
        self.xdg = {key: str(self.root / 'state' / key) for key in ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']}
        foundation = {'kind': 'native-oauth-comparison-v1', 'phase': 'comparison', 'authentication': 'oauth', 'run_id': 'foundation',
                      'credential_id_sha256': 'same-owner', 'overlay_sha256': 'same-source', 'effective_xdg': self.xdg, 'staging_root': str(self.root), 'window': {'id': 'foundation-window'}}
        file = self.foundation_dir / 'foundation-plan.json'; file.write_text(json.dumps(foundation))
        report = {'run_id': 'foundation', 'staging_root': str(self.root), 'startup_only': False, 'startup_passed': True,
                  'reference_passed': True, 'gateway_passed': True, 'requests': 2, 'plan_sha256': admission.native.sha(file)}
        result = self.root / 'live-reports/foundation.json'; result.write_text(json.dumps(report))
        self.args = types.SimpleNamespace(run_id='tools-case', url='http://127.0.0.1:4190', models='glm-5.3-flash-free', phases='tools',
                                         request_budget=2, output_budget=2048, not_before='1970-01-01T00:00:00+00:00')
        self.plan = {'kind': 'native-acceptance-case-v1', 'status': 'prepared', 'version': '2.1.4', 'authentication': 'oauth',
                     'run_id': self.args.run_id, 'staging_root': str(self.root), 'model': self.args.models, 'phase': 'tools',
                     'not_before': self.args.not_before, 'minimum_gap_seconds': 120, 'credential_id_sha256': 'same-owner', 'overlay_sha256': 'same-source', 'effective_xdg': self.xdg,
                     'window': {'id': 'tools-window', 'request_budget': 2, 'output_budget': 2048, 'allowed_runs': ['tools-case']},
                     'foundation': {'run_id': 'foundation', 'plan_file': 'foundation-plan.json', 'report_sha256': admission.native.sha(result), 'plan_sha256': admission.native.sha(file)}}

    def tearDown(self): self.temp.cleanup()

    def inspect(self, plan=None, args=None):
        control = types.SimpleNamespace(verify_staging=lambda _: None, StagingRestoreError=RuntimeError)
        with mock.patch.object(admission, 'HERE', self.foundation_dir), mock.patch.object(admission, 'STAGING_ROOT', self.root), \
             mock.patch.object(admission.native, 'inspect_runtime_binding', return_value=[]), \
             mock.patch.object(admission.native, 'load_staging_control', return_value=control), \
             mock.patch.object(admission.os, 'lstat', side_effect=FileNotFoundError):
            return admission.inspect_case(plan or self.plan, self.root, args or self.args)

    def test_rejects_unqualified_foundations_and_burst_or_changed_case_controls(self):
        self.assertEqual(self.inspect(), [])
        for key, value in [('models', 'beam-free,glm-5.3-flash-free'), ('phases', 'tools,long'), ('output_budget', 32768), ('url', 'http://127.0.0.1:9999')]:
            args = types.SimpleNamespace(**{**vars(self.args), key: value})
            self.assertTrue(self.inspect(args=args), key)
        for key, value in [('credential_id_sha256', 'other-owner'), ('overlay_sha256', 'other-source'), ('minimum_gap_seconds', 0), ('foundation', {}), ('phase', {}), ('model', []), ('effective_xdg', {}), ('window', {}), ('window', {'request_budget': 2})]:
            self.assertTrue(self.inspect({**self.plan, key: value}), key)
        report_file = self.root / 'live-reports/foundation.json'
        report = json.loads(report_file.read_text())
        for key, value in [('gateway_passed', False), ('reference_passed', False), ('startup_only', True), ('requests', 1), ('upstream_status', 429), ('staging_root', '/synthetic-other-root')]:
            report_file.write_text(json.dumps({**report, key: value}))
            plan = {**self.plan, 'foundation': {**self.plan['foundation'], 'report_sha256': admission.native.sha(report_file)}}
            self.assertIn('successful_same_owner_foundation_missing', self.inspect(plan), key)
        report_file.write_text(json.dumps(report))
        with admission.PacedGuard(self.root, 'prior-quota', 1, 1024, minimum_gap_seconds=0) as guard:
            try: guard.stop('Synthetic quota', 429)
            except ProbeStopped: pass
        self.assertIn('provider_cooldown_active', self.inspect())

    def test_recheck_under_owned_lease_rejects_plan_and_runtime_changes(self):
        file = self.root / 'case.json'; file.write_text(json.dumps(self.plan)); self.args.plan = str(file)
        case = {'plan': self.plan, 'plan_sha256': admission.native.sha(file)}
        control = types.SimpleNamespace(verify_staging=lambda _: None, StagingRestoreError=RuntimeError)
        with admission.PacedGuard(self.root, self.args.run_id, 2, 2048, window=self.plan['window'], minimum_gap_seconds=0) as guard, \
             mock.patch.object(admission, 'HERE', self.foundation_dir), mock.patch.object(admission, 'STAGING_ROOT', self.root), \
             mock.patch.object(admission.native, 'inspect_runtime_binding', return_value=[]) as runtime, \
             mock.patch.object(admission.native, 'load_staging_control', return_value=control), \
             mock.patch.object(admission.os, 'lstat', side_effect=FileNotFoundError):
            admission.recheck_case(case, self.args, self.root)
            self.assertIn('another_live_owner_active', admission.inspect_case(self.plan, self.root, self.args))
            file.write_text('{}')
            with self.assertRaises(admission.CaseNotAdmitted): admission.recheck_case(case, self.args, self.root)
            file.write_text(json.dumps(self.plan)); runtime.return_value = ['worker_overlay_or_mode_mismatch']
            with self.assertRaises(admission.CaseNotAdmitted): admission.recheck_case(case, self.args, self.root)
            self.assertEqual(guard.count, 0)

    def test_pacing_serializes_requests_and_inherits_prior_reservation_without_sleeping_on_mutex(self):
        with admission.PacedGuard(self.root, 'first-case', 2, 2048, minimum_gap_seconds=.06) as guard:
            guard.reserve(1024)
            deadline = guard.next_at; guard.reserve(1024)
            self.assertGreaterEqual(time.monotonic(), deadline)
        with admission.PacedGuard(self.root, 'second-case', 1, 1024, minimum_gap_seconds=.06) as guard:
            deadline = guard.next_at; guard.reserve(1024)
            self.assertGreaterEqual(time.monotonic(), deadline)
        with admission.PacedGuard(self.root, 'cancel-case', 2, 2048, minimum_gap_seconds=5) as guard:
            # Avoid inherited wait from the prior case in this cancellation fixture.
            guard.next_at = 0; guard.reserve(1024)
            with concurrent.futures.ThreadPoolExecutor() as pool:
                pending = pool.submit(guard.reserve, 1024)
                time.sleep(.02); start = time.monotonic()
                try: guard.stop('Synthetic cancellation')
                except ProbeStopped: pass
                with self.assertRaises(ProbeStopped): pending.result(timeout=.25)
                self.assertLess(time.monotonic() - start, .25)
                self.assertEqual(guard.count, 1)

    def test_native_worker_rejection_blocks_diagnostics_and_late_followups_without_modifying_native_state(self):
        state = self.root / 'state'; state.mkdir()
        file = state / 'native-quota.json'
        reset = (admission.utc_now() + admission.datetime.timedelta(hours=1)).isoformat()
        record = json.dumps({'version': 1, 'status': 429, 'retry_at': reset})
        with admission.PacedGuard(self.root, 'late-native-quota', 2, 2048, minimum_gap_seconds=0) as guard:
            guard.reserve(1024); file.write_text(record)
            with self.assertRaises(ProbeStopped): guard.reserve(1024)
            self.assertEqual(guard.count, 1)
            self.assertEqual(file.read_text(), record)
        with self.assertRaises(ProbeStopped):
            with admission.PacedGuard(self.root, 'new-native-quota', 1, 1024, minimum_gap_seconds=0): self.fail('Native quota ignored')
        ledger = json.loads((self.root / 'live-probe-ledger.json').read_text()); ledger.pop('cooldown_until', None)
        (self.root / 'live-probe-ledger.json').write_text(json.dumps(ledger)); file.unlink()
        pending = state / 'native-quota.json.pending'; pending.write_text(record)
        with self.assertRaises(ProbeStopped):
            with admission.PacedGuard(self.root, 'pending-native-quota', 1, 1024, minimum_gap_seconds=0): self.fail('Pending quota ignored')
        pending.write_text('partial-json')
        self.assertIn('live_ledger_unavailable', self.inspect())

    def test_claude_disconnect_during_pacing_reserves_and_forwards_nothing(self):
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self): calls.append(True); self.send_response(500); self.end_headers()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            with admission.PacedGuard(self.root, 'paced-cli', 2, 2048, minimum_gap_seconds=5) as guard:
                guard.reserve(1024)
                reached = threading.Event(); reserve = guard.reserve
                def observed(*args, **kwargs): reached.set(); return reserve(*args, **kwargs)
                guard.reserve = observed
                with claude_relay(guard, 'http://127.0.0.1:' + str(server.server_port), 'beam-free', 'Bearer synthetic', 2) as endpoint:
                    from urllib.parse import urlsplit
                    address = urlsplit(endpoint)
                    peer = socket.create_connection((address.hostname, address.port))
                    body = json.dumps({'model': 'opencode-native/beam-free', 'max_tokens': 1024, 'messages': [{'role': 'user', 'content': 'synthetic'}]}).encode()
                    peer.sendall(b'POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
                    self.assertTrue(reached.wait(1)); peer.close()
                    deadline = time.monotonic() + .5
                    while not guard.blocked and time.monotonic() < deadline: time.sleep(.01)
                    self.assertTrue(guard.blocked); self.assertEqual(guard.count, 1); self.assertEqual(calls, [])
        finally: server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
