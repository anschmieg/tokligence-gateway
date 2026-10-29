import importlib.util
import contextlib
import copy
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import types
import urllib.error
import urllib.request
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parents[1] / 'native/opencode'
sys.path.insert(0, str(HERE))
from live_safety import LiveGuard
from oauth_meter import native_meter
from oauth_profile import cli_command, selected_free_model

spec = importlib.util.spec_from_file_location('oauth_comparison', HERE / 'oauth-comparison.py')
driver = importlib.util.module_from_spec(spec); spec.loader.exec_module(driver)


class OAuthComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-oauth-control-')
        self.root = pathlib.Path(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def test_fixture_supervisor_reaps_detached_orphan_descendants(self):
        program = self.root / 'supervisor.py'
        program.write_text('''
import ctypes, importlib.util, os, subprocess, sys
spec=importlib.util.spec_from_file_location('capture',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
code="import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)"
child=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
try:
 child.wait(timeout=3)
 assert m.descendants(), 'Detached child was not adopted'
finally: m.cleanup_descendants()
assert not m.descendants()
print('owned-descendants-reaped')
''')
        result = subprocess.run([sys.executable, str(program), str(HERE / 'capture-oauth-reference.py')],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'owned-descendants-reaped')

    def test_live_transaction_serializes_ownership_and_stops_before_second_request_on_failure(self):
        for mode in ['success', 'reference-quota', 'missing-marker', 'outside-xdg', 'gateway-quota', 'priced-model', 'pending-recovery']:
            with self.subTest(mode=mode):
                root = self.root / mode; root.mkdir()
                state = root / 'state'; state.mkdir(); (state / 'workspace').mkdir()
                with sqlite3.connect(state / 'opencode.db') as conn:
                    conn.execute('CREATE TABLE session_v2 (time_suspended INTEGER)')
                    conn.execute('CREATE TABLE kv (key TEXT)')
                    if mode == 'pending-recovery': conn.execute('INSERT INTO session_v2 VALUES (123)')
                (root / 'live-reports').mkdir()
                values = {key: str(state / key.lower()) for key in ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']}
                if mode == 'outside-xdg': values['XDG_CONFIG_HOME'] = str(root / 'outside-state')
                (root / 'worker-env.json').write_text(json.dumps(values))
                (root / 'gateway-env.json').write_text('{"TOKLIGENCE_AUTH_SECRET":"synthetic-private-gateway-canary"}')
                plan = {'model': 'glm-5.3-flash-free', 'minimum_gap_seconds': 120,
                        'console': 'https://opencode.ai/console', 'inference': 'https://opencode.ai/inference/openai/v1/chat/completions',
                        'window': {'id': 'synthetic-window', 'request_budget': 2, 'output_budget': 2048, 'allowed_runs': ['synthetic-transaction']}}
                plan_path = root / 'plan.json'; plan_path.write_text(json.dumps(plan))
                ownership = {'paused': False, 'restored': 0, 'gateway_calls': 0}
                memory = {}
                @contextlib.contextmanager
                def pause(*_):
                    ownership['paused'] = True
                    try: yield
                    finally: ownership.update(paused=False, restored=ownership['restored'] + 1)
                @contextlib.contextmanager
                def meter(guard, *_args, **_kwargs):
                    memory['guard'] = guard
                    yield {'meter': 'http://127.0.0.1:1', 'authorization': 'synthetic-private-meter-canary'}
                staging = types.SimpleNamespace(verify_staging=lambda *_: None, pause_staging=pause, StagingRestoreError=RuntimeError)
                class Child:
                    pid = 999999999
                    def __init__(self, server): self.server = server; self.returncode = None if server else 0
                    def poll(self): return self.returncode
                def popen(argv, **kwargs):
                    self.assertTrue(ownership['paused'])
                    for value in kwargs['env'].values(): self.assertNotIn('synthetic-private-gateway-canary', str(value))
                    import fcntl
                    with (state / 'worker.lock').open('a+') as contender:
                        with self.assertRaises(BlockingIOError): fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    if 'serve' in argv:
                        self.assertEqual(len(kwargs['pass_fds']), 1)
                        kwargs['stdout'].write('server listening on http://127.0.0.1:12345\n'); kwargs['stdout'].flush()
                        return Child(True)
                    guard = memory['guard']; guard.reserve(1024)
                    if mode == 'reference-quota': guard.stop('Synthetic reference rejection', 429)
                    guard.native_requests = [{'model': 'glm-5.3-flash-free', 'stream': True, 'max_tokens': 1024, 'tools': [],
                        'messages': [{'role': 'system', 'content': 'Synthetic native context'}, {'role': 'user', 'content': 'Static marker request'}]}]
                    marker = 'WRONG_MARKER' if mode == 'missing-marker' else 'NATIVE_OAUTH_CONTROL_OK'
                    kwargs['stdout'].write(json.dumps({'type': 'text', 'part': {'text': marker}}) + '\n'); kwargs['stdout'].flush()
                    return Child(False)
                def gateway(request, **_):
                    self.assertFalse(ownership['paused'])
                    self.assertEqual(ownership['restored'], 1)
                    self.assertEqual(json.loads(request.data)['messages'], memory['guard'].native_requests[0]['messages'])
                    ownership['gateway_calls'] += 1
                    class Response:
                        status = 429 if mode == 'gateway-quota' else 200
                        headers = {'retry-after': '3600'}
                        def __enter__(self): return self
                        def __exit__(self, *_): pass
                        def read(self, _):
                            return (b'{"error":{"code":"FreeUsageLimitError"}}' if self.status == 429 else
                                b'{"choices":[{"finish_reason":"stop","message":{"content":"NATIVE_OAUTH_CONTROL_OK"}}]}')
                    return Response()
                original_lstat = os.lstat
                def lstat(path, *args, **kwargs):
                    if str(path) == '/data/tokligence/zen/secondary-oauth.json': raise FileNotFoundError()
                    return original_lstat(path, *args, **kwargs)
                output = io.StringIO()
                with mock.patch.object(sys, 'argv', ['oauth-comparison', '--root', str(root), '--plan', str(plan_path), '--run-id', 'synthetic-transaction', '--execute']), \
                     mock.patch.object(driver, 'inspect', return_value=[]), mock.patch.object(driver, 'load_staging_control', return_value=staging), \
                     mock.patch.object(driver, 'native_meter', side_effect=meter), mock.patch.object(driver.subprocess, 'Popen', side_effect=popen), \
                     mock.patch.object(driver, 'verify_free_model', return_value='glm-5.3-flash-free', side_effect=ValueError('Synthetic priced model') if mode == 'priced-model' else None), \
                     mock.patch.object(driver, 'stop'), mock.patch.object(driver, 'open_gateway', side_effect=gateway), \
                     mock.patch.object(driver.time, 'sleep'), mock.patch.object(driver.os, 'lstat', side_effect=lstat), \
                     mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(output):
                    result = driver.main()
                self.assertEqual(result, 0 if mode == 'success' else 1)
                self.assertFalse(ownership['paused'])
                self.assertEqual(ownership['restored'], 1)
                self.assertEqual(ownership['gateway_calls'], int(mode in ['success', 'gateway-quota']))
                report = json.loads((root / 'live-reports/synthetic-transaction.json').read_text())
                self.assertEqual(report['requests'], 0 if mode in ['outside-xdg', 'priced-model', 'pending-recovery'] else 2 if mode in ['success', 'gateway-quota'] else 1)
                self.assertNotIn('synthetic-private', output.getvalue())
                with (state / 'worker.lock').open('a+') as released:
                    import fcntl
                    fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_native_reference_rejects_recovery_read_only_and_fails_closed_on_schema_drift(self):
        database = self.root / 'recovery.db'
        with sqlite3.connect(database) as conn:
            conn.execute('CREATE TABLE session_v2 (time_suspended INTEGER)')
            conn.execute('CREATE TABLE kv (key TEXT)')
        driver.assert_no_recoverable_work(database)
        for sql in ["INSERT INTO session_v2 VALUES (123)", "INSERT INTO kv VALUES ('job.background/synthetic')"]:
            with sqlite3.connect(database) as conn: conn.execute(sql)
            before = database.read_bytes()
            with self.assertRaises(ValueError): driver.assert_no_recoverable_work(database)
            self.assertEqual(database.read_bytes(), before, 'Never clear or rewrite recovery state')
            with sqlite3.connect(database) as conn:
                conn.execute('DELETE FROM session_v2'); conn.execute('DELETE FROM kv')
        with sqlite3.connect(database) as conn: conn.execute('DROP TABLE kv')
        with self.assertRaises(sqlite3.Error): driver.assert_no_recoverable_work(database)

    def test_native_reference_requires_free_available_text_catalog_before_inference(self):
        row = {'id': 'glm-5.3-flash-free', 'modelID': 'glm-5.3-flash-free', 'providerID': 'opencode', 'enabled': True,
               'capabilities': {'input': ['text'], 'output': ['text']},
               'cost': [{'input': 0, 'output': 0, 'cache': {'read': 0, 'write': 0}}]}
        self.assertTrue(selected_free_model([row], row['id']))
        self.assertEqual(selected_free_model([{**row, 'modelID': 'native-api-alias'}], row['id']), 'native-api-alias')
        for field in ['input', 'output', 'read', 'write']:
            priced = copy.deepcopy(row)
            if field in ['input', 'output']: priced['cost'][0][field] = 1
            else: priced['cost'][0]['cache'][field] = 1
            with self.assertRaises(ValueError): selected_free_model([priced], row['id'])
        for key, value in [('enabled', False), ('modelID', None), ('cost', None),
                           ('capabilities', {'input': ['image'], 'output': ['text']})]:
            with self.assertRaises(ValueError): selected_free_model([{**row, key:value}], row['id'])

    def test_native_meter_phase_cap_and_safe_quota_persistence(self):
        for index, status in enumerate([401, 403, 429]):
            root = self.root / str(index); root.mkdir()
            with LiveGuard(root, 'quota', 2, 2048) as guard:
                with native_meter(guard, 'glm-5.3-flash-free') as config:
                    def send(route, data):
                        request = urllib.request.Request(config['meter'] + route, data=json.dumps(data).encode(),
                            headers={'Authorization': config['authorization']})
                        try: response = urllib.request.urlopen(request, timeout=3)
                        except urllib.error.HTTPError as error: response = error
                        with response: response.read(); return response.status
                    value = {'model': 'glm-5.3-flash-free', 'max_tokens': 1024, 'competing_limit': False,
                             'tools': 0, 'cookies': False, 'oauth_bearer': True, 'stream': True}
                    self.assertEqual(send('/reserve', value), 200)
                    self.assertEqual(send('/outcome', {'status': status, 'body': '{"error":{"type":"PRIVATE_CANARY"}}',
                                                      'headers': {'retry-after': '3600'}}), 200)
                    self.assertEqual(send('/reserve', value), 429)
                    self.assertEqual(guard.count, 1)
                    self.assertEqual(guard.status, status)
                    self.assertIn('cooldown_until', guard.ledger)
                self.assertNotIn('PRIVATE_CANARY', (root / 'live-probe-ledger.json').read_text())

    @unittest.skipUnless(os.environ.get('OPENCODE_NATIVE_BUN'), 'Pinned Bun required for inherited lease/crash test')
    def test_native_reference_inherits_lease_and_dies_with_driver(self):
        supervisor = self.root / 'lease-supervisor.py'
        supervisor.write_text(r'''import ctypes,fcntl,os,pathlib,subprocess,sys,time,importlib.util
spec=importlib.util.spec_from_file_location('capture',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
parent_code=r"""import fcntl,os,subprocess,sys
lease=open(sys.argv[1],'a+');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
child=subprocess.Popen([sys.executable,sys.argv[2],'--parent',str(os.getpid()),'--',sys.argv[3],'-e','console.log("owned-ready");await new Promise(r=>setTimeout(r,30000))'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,pass_fds=(lease.fileno(),))
assert child.stdout.readline().strip()=='owned-ready'
lease.close();print('child-owns-lease',flush=True)
sys.stdin.readline();os._exit(0)
"""
lock=str(pathlib.Path(sys.argv[4])/'worker.lock')
parent=subprocess.Popen([sys.executable,'-c',parent_code,lock,sys.argv[2],sys.argv[3]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 assert parent.stdout.readline().strip()=='child-owns-lease'
 with open(lock,'a+') as contender:
  try:fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB);raise AssertionError('Native Bun did not inherit its lease')
  except BlockingIOError:pass
  parent.stdin.write('exit\n');parent.stdin.flush();parent.wait(timeout=3)
  deadline=time.monotonic()+3
  while True:
   try:fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if time.monotonic()>deadline:raise AssertionError('Native reference outlived its owning driver')
    time.sleep(.025)
finally:m.cleanup_descendants()
print('owned-lease-released')
''')
        result = subprocess.run([sys.executable, str(supervisor), str(HERE / 'capture-oauth-reference.py'),
                                str(HERE / 'owned-cli-exec.py'), os.environ['OPENCODE_NATIVE_BUN'], str(self.root)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'owned-lease-released')

    @unittest.skipUnless(os.environ.get('OPENCODE_NATIVE_BUN'), 'Pinned Bun required for native fetch qualification')
    def test_source_cli_recipe_disables_dotenv_and_bunfig_autoload(self):
        source = self.root / 'source'
        entry = source / 'packages/cli/src/index.ts'; entry.parent.mkdir(parents=True)
        preload = source / 'packages/cli/node_modules/@opentui/solid/scripts/preload.js'; preload.parent.mkdir(parents=True)
        preload.write_text('')
        entry.write_text('console.log(JSON.stringify({version:OPENCODE_VERSION,unexpected:process.env.SYNTHETIC_DOTENV_CANARY!==undefined}))')
        (self.root / '.env').write_text('SYNTHETIC_DOTENV_CANARY=must-not-load\n')
        (self.root / 'bunfig.toml').write_text('preload = ["./unwanted.js"]\n')
        (self.root / 'unwanted.js').write_text('throw new Error("Unreviewed Bun config loaded")')
        result = subprocess.run(cli_command(source, os.environ['OPENCODE_NATIVE_BUN']), cwd=self.root,
            env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)}, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'version': '2.1.4', 'unexpected': False})

    @unittest.skipUnless(os.environ.get('OPENCODE_NATIVE_BUN'), 'Pinned Bun required for native fetch qualification')
    def test_native_fetch_preserves_requests_and_withholds_tool_or_invalid_control_responses(self):
        bun = os.environ['OPENCODE_NATIVE_BUN']
        good = 'data: {"choices":[{"delta":{"content":"CONTROL_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        variants = [('good', good, 200, 1, False),
                    ('tools', 'data: {"choices":[{"delta":{"tool_calls":[{"id":"one"}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', 200, 1, True),
                    ('truncated', 'data: {"choices":[{"delta":{"content":"CONTROL_OK"},"finish_reason":null}]}\n\n', 200, 1, True),
                    ('post-finish-content', good.split('data: [DONE]')[0] + 'data: {"choices":[{"delta":{"content":"late"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', 200, 1, True),
                    ('duplicate-finish', good.replace('data: [DONE]', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]'), 200, 1, True),
                    ('wrong-choice', good.replace('"delta":', '"index":1,"delta":'), 200, 1, True),
                    ('malformed', 'data: invalid-json\n\n', 200, 1, True),
                    ('quota', '{"error":{"type":"FreeUsageLimitError"}}', 429, 1, True),
                    ('quota-broken-body', '', 429, 1, True), ('quota-stalled-body', '', 429, 1, True),
                    ('embedded-code-quota', 'data: {"error":{"code":"FreeUsageLimitError"}}\n\n', 200, 1, True),
                    ('embedded-hanging-quota', 'data: {"error":{"code":"FreeUsageLimitError"}}\n\n', 200, 1, True),
                    ('embedded-quota', 'data: {"error":{"type":"FreeUsageLimitError"}}\n\n', 200, 1, True),
                    ('public-auth', good, 200, 0, True), ('over-budget', good, 200, 0, True),
                    ('websocket', good, 200, 0, True), ('wrong-model', good, 200, 0, True), ('cookie', good, 200, 0, True)]
        for name, payload, status, physical, blocked in variants:
            root = self.root / name; root.mkdir()
            with self.subTest(name=name), LiveGuard(root, name, 2, 2048) as guard:
                with native_meter(guard, 'glm-5.3-flash-free') as config:
                    config.update(inference='http://127.0.0.1:9/v1/chat/completions', console='http://127.0.0.1:9/console', controlMarker='CONTROL_OK')
                    meter_file = root / 'meter.json'; meter_file.write_text(json.dumps(config)); meter_file.chmod(0o600)
                    script = root / 'fetch.mjs'
                    script.write_text('''
import assert from 'node:assert/strict';
const real = globalThis.fetch; let physical = 0;
const target = 'http://127.0.0.1:9/v1/chat/completions';
const nativeBody = new TextEncoder().encode(JSON.stringify({model:process.env.CASE === 'wrong-model' ? 'paid' : 'glm-5.3-flash-free',max_tokens:process.env.CASE === 'over-budget' ? 8192 : 1024,stream:true,tools:[]}));
globalThis.fetch = async (url, init) => {
 if(String(url)!==target)return real(url,init);
 physical++;assert.equal(init.body,nativeBody);assert.equal(init.redirect,'manual');
 const body=process.env.CASE==='embedded-hanging-quota'?new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(process.env.PAYLOAD))}}):process.env.CASE==='quota-broken-body'?new ReadableStream({start(c){c.error(new Error('synthetic broken body'))}}):process.env.CASE==='quota-stalled-body'?new ReadableStream({}):process.env.PAYLOAD;
 return new Response(body,{status:Number(process.env.STATUS),headers:{'content-type':Number(process.env.STATUS)===200?'text/event-stream':'application/json','retry-after':'3600'}});
};
let sockets=0;globalThis.WebSocket=class {constructor(){sockets++}};
await import(process.env.PRELOAD);
if(process.env.CASE==='websocket'){assert.throws(()=>new WebSocket('wss://example.invalid'));assert.equal(sockets,0);}
let passed=false;
try {const response=await fetch(target,{method:'POST',body:nativeBody,headers:{authorization:process.env.CASE==='public-auth'?'Bearer public':'Bearer synthetic',...(process.env.CASE==='cookie'?{cookie:'synthetic'}:{})}});if(response.ok)await response.text();passed=response.ok;}catch{}
if(process.env.CASE.includes('quota')) {let refused=false;try{await fetch(target,{method:'POST',body:nativeBody,headers:{authorization:'Bearer synthetic'}})}catch{refused=true}assert.equal(refused,true);}
console.log(JSON.stringify({physical,passed}));
''')
                    result = subprocess.run([bun, str(script)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5,
                        env={'PATH': '/usr/bin:/bin', 'OPENCODE_PROBE_METER_FILE': str(meter_file), 'CASE': name,
                             'PAYLOAD': payload, 'STATUS': str(status), 'PRELOAD': (HERE / 'metered-native-fetch.mjs').as_uri()})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), {'physical': physical, 'passed': not blocked})
                    self.assertEqual(bool(guard.blocked), blocked)
                    if 'quota' in name:
                        self.assertEqual(guard.status, 429)
                        self.assertIn('cooldown_until', guard.ledger)
                        self.assertEqual(guard.entry.get('retry_at_source'), 'conservative_unknown' if name.startswith('embedded-') else 'provider')

    def test_oauth_admission_rejects_public_old_versions_budget_changes_and_stale_evidence(self):
        runtime = self.root / 'runtime'; source = runtime / 'opencode'
        for name in driver.SOURCE_FILES:
            target = source / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('synthetic')
        target = source / 'packages/cli/node_modules/@opentui/solid/scripts/preload.js'; target.parent.mkdir(parents=True); target.write_text('synthetic')
        (source / 'packages/cli/package.json').write_text('{"version":"2.1.4"}')
        (source / '.tokligence-source.json').write_text(json.dumps(driver.read_json(HERE / 'source.json')))
        (runtime / 'bun').write_text('synthetic-runtime')
        (runtime / 'node').write_text('synthetic-node')
        for name in driver.GATEWAY_FILES:
            target = self.root / 'gateway' / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('synthetic-gateway-source')
        for name in ['worker-env.json', 'gateway-env.json']: (self.root / name).write_text(json.dumps({'OPENCODE_NATIVE_KEY':'synthetic-internal','OPENCODE_NATIVE_ENABLED':'true','OPENCODE_NATIVE_URL':'http://127.0.0.1:4187/v1'}))
        evidence = self.root / 'gateway/native/opencode/oauth-reference-evidence.json'; evidence.parent.mkdir(parents=True)
        summary = {key: True for key in ['passed', 'external_network_blocked', 'oauth_on_both', 'org_on_both', 'reasoning_replay_verified',
            'parallel_tool_success_and_error', 'persisted_cli_resume', 'reference_cancel_closed', 'gateway_cancel_closed',
            'native_fetch_meter_verified', 'control_profile_tool_deny_and_budget_verified', 'quota_cooldown_persisted',
            'native_free_catalog_checked', 'catalog_alias_verified', 'private_checkout_excluded', 'credential_values_excluded']}
        summary.update(live_tested=False, classified_body_differences=[], overlay_sha256='synthetic-overlay', source_commit=driver.read_json(HERE / 'source.json')['commit'], cli_archive_files_verified=200); evidence.write_text(json.dumps(summary))
        state = self.root / 'state'; state.mkdir()
        with sqlite3.connect(state / 'opencode.db') as conn:
            conn.execute('CREATE TABLE session_v2 (time_suspended INTEGER)')
            conn.execute('CREATE TABLE kv (key TEXT)')
            conn.execute('CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER)')
            conn.execute('INSERT INTO credential VALUES (?,?,?,?)', ('synthetic-credential', 'opencode', '{"type":"oauth"}', 1))
        plan = {'kind': 'native-oauth-comparison-v1', 'status': 'prepared', 'authentication': 'oauth', 'version': '2.1.4',
                'overlay_sha256': 'synthetic-overlay', 'model': 'glm-5.3-flash-free', 'run_id': 'comparison', 'staging_root': str(self.root),
                'not_before': '1970-01-01T00:00:00+00:00', 'minimum_gap_seconds': 120,
                'console': 'https://opencode.ai/console', 'inference': 'https://opencode.ai/inference/openai/v1/chat/completions',
                'window': {'id': 'synthetic', 'request_budget': 2, 'output_budget': 2048, 'allowed_runs': ['comparison']},
                'code_sha256': {name: driver.sha(HERE / name) for name in driver.CODE_FILES},
                'source_sha256': {name: driver.sha(source / name) for name in driver.SOURCE_FILES},
                'cli_tree_sha256': driver.cli_tree_sha(source), 'node_sha256': driver.sha(runtime / 'node'), 'gateway_sha256': {name: driver.sha(self.root / 'gateway' / name) for name in driver.GATEWAY_FILES}, 'bun_sha256': driver.sha(runtime / 'bun'), 'evidence_sha256': driver.sha(evidence),
                'credential_id_sha256': driver.hashlib.sha256(b'synthetic-credential').hexdigest(), 'classified_body_differences': []}
        with mock.patch.object(driver.subprocess, 'check_output', return_value='1.4.4\n'), mock.patch.object(driver, 'inspect_ledger', return_value=[]), mock.patch.object(driver, 'inspect_worker', return_value=[]):
            self.assertEqual(driver.inspect(plan, self.root, 'comparison'), [])
            for field, value in [('authentication', 'public'), ('version', '1.18.32'), ('status', 'draft'),
                                 ('minimum_gap_seconds', 0), ('credential_id_sha256', 'changed'), ('evidence_sha256', 'changed'), ('node_sha256', 'changed'), ('gateway_sha256', {})]:
                self.assertTrue(driver.inspect({**plan, field: value}, self.root, 'comparison'), field)
            self.assertIn('invalid_two_request_window', driver.inspect({**plan, 'window': {**plan['window'], 'request_budget': 3}}, self.root, 'comparison'))
            self.assertFalse((self.root / 'live-probe-ledger.json').exists())


if __name__ == '__main__': unittest.main()
