#!/usr/bin/env python3
"""Admitted two-request native OAuth comparison. Default is read-only admission."""
import argparse
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
import pathlib
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error

from live_safety import LiveGuard, ProbeStopped, parse_time, utc_now, open_gateway
from oauth_meter import native_meter
from official_control import public_failure
from oauth_profile import cli_command, control_config, GATEWAY_FILES, verify_free_model
from run_admission import inspect_ledger, inspect_worker
from urllib.request import Request

HERE = pathlib.Path(__file__).resolve().parent
SOURCE_FILES = ['packages/cli/src/index.ts', 'packages/cli/src/server-process.ts',
                'packages/cli/src/run/run.ts', 'packages/cli/src/run/noninteractive.ts',
                'packages/cli/src/util/process.ts', 'packages/cli/package.json', 'bun.lock']

MATCHED_FIELDS = {'model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'temperature', 'top_p', 'stop', 'reasoning_effort', 'parallel_tool_calls'}
CODE_FILES = ['oauth-comparison.py', 'oauth_meter.py', 'oauth_profile.py', 'metered-native-fetch.mjs',
              'live_safety.py', 'official_control.py', 'official-public-probe.py', 'run_admission.py',
              'capture-oauth-reference.py', 'testing/oauth-reference.py', 'testing/oauth-seed.ts', 'source.json', 'owned-cli-exec.py']


def read_json(path): return json.loads(pathlib.Path(path).read_text())
def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def cli_tree_sha(source):
    root = pathlib.Path(source) / 'packages/cli'
    entries = {str(path.relative_to(root)): sha(path) for path in sorted((root / 'src').rglob('*')) if path.is_file()}
    return hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()


def inspect(plan, root, run_id):
    """Read-only admission. No host creation, refresh, service stop or reservation."""
    if not isinstance(plan, dict): return ['invalid_oauth_plan']
    blockers = []
    source = root / 'runtime/opencode'
    if (plan.get('kind') != 'native-oauth-comparison-v1' or plan.get('status') != 'prepared'
            or plan.get('authentication') != 'oauth' or plan.get('version') != '2.1.4'
            or plan.get('model') != 'glm-5.3-flash-free' or plan.get('run_id') != run_id
            or plan.get('staging_root') != str(root.resolve())):
        blockers.append('oauth_plan_contract_mismatch')
    window = plan.get('window', {})
    if not isinstance(window, dict): return ['invalid_two_request_window']
    if (set(window) != {'id', 'request_budget', 'output_budget', 'allowed_runs'}
            or type(window.get('request_budget')) is not int or window.get('request_budget') != 2
            or type(window.get('output_budget')) is not int or window.get('output_budget') != 2048
            or not isinstance(window.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', window['id'])
            or window.get('allowed_runs') != [run_id]): blockers.append('invalid_two_request_window')
    threshold = parse_time(plan.get('not_before'))
    if not threshold or utc_now() < threshold: blockers.append('comparison_time_not_reached')
    if type(plan.get('minimum_gap_seconds')) is not int or not 120 <= plan.get('minimum_gap_seconds', 0) <= 600:
        blockers.append('comparison_pacing_missing')
    if (plan.get('console') != 'https://opencode.ai/console'
            or plan.get('inference') != 'https://opencode.ai/inference/openai/v1/chat/completions'):
        blockers.append('unreviewed_native_destination')
    if not isinstance(plan.get('code_sha256'), dict) or not isinstance(plan.get('source_sha256'), dict):
        return blockers + ['missing_runtime_hashes']
    for name in CODE_FILES:
        if plan.get('code_sha256', {}).get(name) != sha(HERE / name): blockers.append('code_mismatch:' + name)
    gateway_root = root / 'gateway'
    gateway_hashes = plan.get('gateway_sha256', {})
    if not isinstance(gateway_hashes, dict) or set(gateway_hashes) != set(GATEWAY_FILES):
        blockers.append('missing_gateway_snapshot_hashes')
    else:
        for name in GATEWAY_FILES:
            try:
                if gateway_hashes[name] != sha(gateway_root / name): blockers.append('gateway_snapshot_mismatch:' + name)
            except OSError: blockers.append('gateway_snapshot_unavailable:' + name)
    try:
        if any(plan.get('source_sha256', {}).get(name) != sha(source / name) for name in SOURCE_FILES):
            blockers.append('reference_source_mismatch')
        if plan.get('cli_tree_sha256') != cli_tree_sha(source): blockers.append('reference_cli_tree_mismatch')
        pin = read_json(source / '.tokligence-source.json')
        if pin.get('version') != '2.1.4' or read_json(source / 'packages/cli/package.json').get('version') != '2.1.4' or pin.get('commit') != read_json(HERE / 'source.json')['commit']: blockers.append('reference_revision_mismatch')
        preload = source / 'packages/cli/node_modules/@opentui/solid/scripts/preload.js'
        if not preload.is_file(): blockers.append('reference_cli_dependencies_missing')
        if subprocess.check_output([str(root / 'runtime/bun'), '--version'], text=True, timeout=5).strip() != '1.4.4':
            blockers.append('reference_bun_version_mismatch')
        if plan.get('node_sha256') != sha(root / 'runtime/node'): blockers.append('gateway_node_binary_mismatch')
        if plan.get('bun_sha256') != sha(root / 'runtime/bun'): blockers.append('reference_bun_binary_mismatch')
        evidence = root / 'gateway/native/opencode/oauth-reference-evidence.json'
        if plan.get('evidence_sha256') != sha(evidence): blockers.append('oauth_evidence_mismatch')
        summary = read_json(evidence)
        required = ['passed', 'external_network_blocked', 'oauth_on_both', 'org_on_both',
                    'reasoning_replay_verified', 'parallel_tool_success_and_error', 'persisted_cli_resume',
                    'reference_cancel_closed', 'gateway_cancel_closed', 'native_fetch_meter_verified',
                    'control_profile_tool_deny_and_budget_verified', 'quota_cooldown_persisted', 'native_free_catalog_checked',
                    'catalog_alias_verified', 'private_checkout_excluded', 'credential_values_excluded']
        if any(summary.get(key) is not True for key in required) or summary.get('live_tested') is not False:
            blockers.append('oauth_reference_not_qualified')
        if (summary.get('overlay_sha256') != plan.get('overlay_sha256') or summary.get('source_commit') != pin['commit']
                or type(summary.get('cli_archive_files_verified')) is not int or summary.get('cli_archive_files_verified', 0) < 100):
            blockers.append('oauth_evidence_source_mismatch')
        if summary.get('classified_body_differences') != plan.get('classified_body_differences'):
            blockers.append('unreviewed_wire_difference')
        environments = {}
        for env_path in ['worker-env.json', 'gateway-env.json']:
            settings = read_json(root / env_path)
            environments[env_path] = settings
            if any(settings.get(key) for key in ['OPENCODE_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONSOLE_TOKEN']):
                blockers.append('oauth_environment_override_present')
            if any(value for key, value in settings.items() if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy')):
                blockers.append('proxy_environment_requires_review')
        worker_env, gateway_env = environments['worker-env.json'], environments['gateway-env.json']
        if (gateway_env.get('OPENCODE_NATIVE_ENABLED') != 'true'
                or gateway_env.get('OPENCODE_NATIVE_URL') != 'http://127.0.0.1:4187/v1'
                or not worker_env.get('OPENCODE_NATIVE_KEY')
                or worker_env.get('OPENCODE_NATIVE_KEY') != gateway_env.get('OPENCODE_NATIVE_KEY')
                or worker_env.get('OPENCODE_NATIVE_AUTH_MODE', 'oauth') != 'oauth'):
            blockers.append('native_gateway_configuration_mismatch')
        database = root / 'state/opencode.db'
        try: assert_no_recoverable_work(database)
        except (ValueError, sqlite3.Error): blockers.append('native_reference_recovery_not_idle')
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as conn:
            rows = conn.execute("SELECT id, value, active FROM credential WHERE integration_id = 'opencode'").fetchall()
        if len(rows) != 1 or read_credential_type(rows[0][1]) != 'oauth' or rows[0][2] != 1: blockers.append('exclusive_oauth_credential_missing')
        elif hashlib.sha256(rows[0][0].encode()).hexdigest() != plan.get('credential_id_sha256'):
            blockers.append('staging_credential_identity_changed')
    except (OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError):
        blockers.append('oauth_runtime_or_evidence_unavailable')
    blockers.extend(inspect_ledger(root, run_id, window))
    blockers.extend(inspect_worker(root, plan.get('overlay_sha256')))
    return list(dict.fromkeys(blockers))


def assert_no_recoverable_work(database):
    """Never boot the ordinary native CLI with stored agent recovery work.

    Check read-only at admission and again under the worker descriptor lease.
    Fail closed on schema drift. Do not clear claims or background jobs.
    """
    with sqlite3.connect(pathlib.Path(database).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        if conn.execute('SELECT 1 FROM session_v2 WHERE time_suspended IS NOT NULL LIMIT 1').fetchone():
            raise ValueError('Native reference has suspended session work')
        if conn.execute("SELECT 1 FROM kv WHERE key GLOB 'job.background/*' LIMIT 1").fetchone():
            raise ValueError('Native reference has background recovery work')


def read_credential_type(value):
    parsed = json.loads(value)
    return parsed.get('type') if isinstance(parsed, dict) else None


def stop(child):
    if not child: return
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL); child.wait()
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass


def load_staging_control():
    spec = importlib.util.spec_from_file_location('staging_control', HERE / 'official-public-probe.py')
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/home/agent/tokligence-staging')
    parser.add_argument('--plan', required=True)
    parser.add_argument('--run-id', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--execute', action='store_true', help='Explicitly execute only after all admission gates pass')
    mode.add_argument('--check-only', action='store_true', help='Read-only admission (also the default)')
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    try: plan = read_json(args.plan)
    except (OSError, ValueError):
        print(json.dumps({'status': 'not_ready', 'inference_performed': False, 'blockers': ['oauth_plan_unavailable']}))
        return 2
    blockers = inspect(plan, root, args.run_id)
    if any(value for key,value in os.environ.items() if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy')):
        blockers.append('proxy_environment_requires_review')
    staging = load_staging_control()
    try: staging.verify_staging(root)
    except staging.StagingRestoreError: blockers.append('staging_health_or_ownership_failed')
    try:
        os.lstat('/data/tokligence/zen/secondary-oauth.json')
        blockers.append('production_secondary_path_present')
    except FileNotFoundError: pass
    except OSError: blockers.append('production_secondary_absence_unverified')
    if blockers or not args.execute:
        print(json.dumps({'status': 'not_ready' if blockers else 'ready', 'inference_performed': False, 'blockers': blockers}))
        return 2 if blockers else 0
    report = {'scope': 'bounded same-version OAuth basic comparison; not full live acceptance', 'run_id': args.run_id,
              'reference_passed': False, 'gateway_passed': False, 'coverage_incomplete': True}
    guard = LiveGuard(root, args.run_id, 2, 2048, window=plan['window'])
    server = client = None
    logs = []
    def launch(argv, env, name, lease_fd=None):
        paths = [root / 'live-reports' / (args.run_id + '.' + name + '.' + suffix) for suffix in ['stdout', 'stderr']]
        handles = [os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') for path in paths]
        logs.extend(handles)
        command = [sys.executable, str(HERE / 'owned-cli-exec.py'), '--parent', str(os.getpid()), '--', *argv]
        return subprocess.Popen(command, cwd=root / 'state/workspace', env=env, stdin=subprocess.DEVNULL,
                                stdout=handles[0], stderr=handles[1], start_new_session=True,
                                pass_fds=() if lease_fd is None else (lease_fd,)), paths[0]
    try:
        with guard:
            (root / 'live-reports').mkdir(mode=0o700, exist_ok=True)
            try:
                with staging.pause_staging(root, True):
                    # Keep the same inode and OS-held descriptor through the entire
                    # reference process. Never unlink, reseed or copy this state.
                    with (root / 'state/worker.lock').open('a+') as lease:
                        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        assert_no_recoverable_work(root / 'state/opencode.db')
                        values = read_json(root / 'worker-env.json')
                        state = root / 'state'
                        env = {'PATH': str(root / 'runtime') + ':/usr/bin:/bin', 'HOME': str(state),
                               'OPENCODE_DB': str(state / 'opencode.db'), 'PWD': str(state / 'workspace'),
                               'OPENCODE_CONFIG_DIR': str(state / 'config'), 'OPENCODE_CONFIG_PROJECT_DISABLE': '1',
                               'OPENCODE_DISABLE_CLAUDE_CODE': '1', 'OPENCODE_DISABLE_FFF': '1',
                               'OPENCODE_FILEWATCHER_DISABLE': '1', 'OPENCODE_DISABLE_AUTOUPDATE': '1',
                               'OPENCODE_CONFIG_CONTENT': json.dumps(control_config(1024)),
                               'OPENCODE_PASSWORD': os.urandom(32).hex(), 'DO_NOT_TRACK': '1'}
                        for key in ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']:
                            target = pathlib.Path(values[key]).resolve()
                            if not target.is_relative_to(state): raise ValueError('Native state root mismatch')
                            env[key] = str(target)
                        api_identity = {'model': None}
                        with native_meter(guard, lambda: api_identity['model'], max_calls=1, capture_requests=True, allowed_request_fields=MATCHED_FIELDS) as meter:
                            config_path = root / 'live-reports' / (args.run_id + '.meter.json')
                            with os.fdopen(os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
                                json.dump({**meter, 'console': plan['console'], 'inference': plan['inference'], 'controlMarker': 'NATIVE_OAUTH_CONTROL_OK'}, out)
                            cli = cli_command(root / 'runtime/opencode', root / 'runtime/bun')
                            metered = cli[:1] + ['--preload', str(HERE / 'metered-native-fetch.mjs')] + cli[1:]
                            try:
                                server, stdout = launch(metered + ['serve', '--hostname', '127.0.0.1', '--port', '0'],
                                                         {**env, 'OPENCODE_PROBE_METER_FILE': str(config_path)}, 'server', lease.fileno())
                                deadline = time.monotonic() + 40
                                endpoint = None
                                while time.monotonic() < deadline:
                                    if guard.blocked and not getattr(guard, 'pending_error_body', False): raise ProbeStopped(guard.blocked)
                                    if server.poll() is not None: raise RuntimeError('Native server exited')
                                    match = re.search(r'server listening on (http://127.0.0.1:\d+)', stdout.read_text())
                                    if match: endpoint = match.group(1); break
                                    time.sleep(.05)
                                if not endpoint: raise TimeoutError('Native server readiness deadline')
                                api_identity['model'] = verify_free_model(endpoint, env['OPENCODE_PASSWORD'], state / 'workspace', plan['model'])
                                if guard.blocked: raise ProbeStopped(guard.blocked)
                                print(json.dumps({'phase': 'native_oauth_reference_started', 'run_id': args.run_id}), flush=True)
                                client, stdout = launch(cli + ['run', '--server', endpoint, '--model', 'opencode/' + plan['model'],
                                    '--format', 'json', '--title', 'Bounded OAuth control', 'Reply exactly NATIVE_OAUTH_CONTROL_OK.'], env, 'client')
                                deadline = time.monotonic() + 120
                                while client.poll() is None and time.monotonic() < deadline:
                                    if guard.blocked and not getattr(guard, 'pending_error_body', False): raise ProbeStopped(guard.blocked)
                                    time.sleep(.05)
                                if client.poll() is None: raise TimeoutError('Native control deadline')
                                events = [json.loads(line) for line in stdout.read_text().splitlines() if line.startswith('{')]
                                text = ''.join(event.get('part', {}).get('text', '') for event in events if event.get('type') == 'text')
                                if client.returncode or 'NATIVE_OAUTH_CONTROL_OK' not in text or guard.count != 1 or guard.blocked:
                                    guard.stop('Native OAuth reference incomplete; no gateway dispatch')
                                reference_request = guard.native_requests[0]
                                if set(reference_request) - MATCHED_FIELDS: guard.stop('Native reference contains unreviewed body fields')
                                report['reference_passed'] = True
                            finally:
                                stop(client); stop(server); client = server = None
                                config_path.unlink(missing_ok=True)
                staging.verify_staging(root)
                print(json.dumps({'phase': 'reference_passed_pacing_before_gateway', 'run_id': args.run_id}), flush=True)
                time.sleep(plan['minimum_gap_seconds'])
                # One explicit gateway call, no redirects/retries or legacy fallback.
                gateway_env = read_json(root / 'gateway-env.json')
                guard.reserve(1024)
                paired = {key:reference_request[key] for key in ['messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'reasoning_effort', 'parallel_tool_calls'] if key in reference_request}
                paired.update(model='opencode-native/' + plan['model'], stream=False, max_tokens=1024)
                request = Request('http://127.0.0.1:4190/v1/chat/completions', data=json.dumps(paired).encode(),
                    headers={'Authorization': 'Bearer ' + gateway_env['TOKLIGENCE_AUTH_SECRET'], 'Content-Type': 'application/json',
                             'x-session-id': args.run_id})
                report['matched_reference_history'] = True
                try: response = open_gateway(request, timeout=690)
                except urllib.error.HTTPError as error: response = error
                with response:
                    try: raw = response.read(16384 if response.status >= 300 else 1024 * 1024 + 1)
                    except (OSError, http.client.HTTPException):
                        if response.status < 300: raise
                        raw = b''
                    if response.status >= 300:
                        failure = read_json_error(raw)
                        headers = public_failure(raw, response.headers)
                        failure.update({key:value for key,value in headers.items() if key != 'code' or value != 'upstream_http_error'})
                        guard.stop('Native gateway rejected comparison', response.status, failure)
                if len(raw) > 1024 * 1024: guard.stop('Native gateway response limit exceeded')
                result = json.loads(raw)
                choice = result.get('choices', [{}])[0]
                if (choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('tool_calls')
                        or choice.get('message', {}).get('content', '').strip() != 'NATIVE_OAUTH_CONTROL_OK'):
                    guard.stop('Native gateway comparison incomplete')
                report['gateway_passed'] = True
            except Exception as error:
                report['error_type'] = type(error).__name__
                if not guard.blocked:
                    try: guard.stop('Native OAuth comparison failed or delivery uncertain')
                    except ProbeStopped: pass
            finally:
                stop(client); stop(server)
                for file in logs: file.close()
                report.update(requests=guard.count, reserved_output_tokens=guard.output_count, upstream_status=guard.status,
                              upstream_code=guard.entry.get('upstream_code'), upstream_request_id=guard.entry.get('upstream_request_id'),
                              cooldown_until=guard.ledger.get('cooldown_until'), upstream_retry_at=guard.entry.get('upstream_retry_at'),
                              retry_at_source=guard.entry.get('retry_at_source'), reason=guard.blocked)
                with os.fdopen(os.open(root / 'live-reports' / (args.run_id + '.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
                    json.dump(report, out, indent=2)
                print(json.dumps(report))
    except (ProbeStopped, BlockingIOError):
        print(json.dumps({'status': 'not_started', 'inference_performed': False, 'reason': 'Live lease, cooldown or replay refused'}))
        return 2
    return 0 if report['reference_passed'] and report['gateway_passed'] else 1


def read_json_error(raw):
    try:
        value = json.loads(raw).get('error', {})
        return value if isinstance(value, dict) else {}
    except (ValueError, AttributeError): return {}


if __name__ == '__main__': raise SystemExit(main())
