#!/usr/bin/env python3
"""One accounted public official-CLI control; staging only, no OAuth or live discovery."""
import argparse
import contextlib
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time
import urllib.request

from live_safety import LiveGuard, ProbeStopped, parse_time, utc_now
from official_control import CATALOG, official_relay, profile_environment


class ControlSetupError(RuntimeError):
    pass


class StagingRestoreError(RuntimeError):
    pass


def memory_snapshot():
    root = pathlib.Path('/sys/fs/cgroup/user.slice') / ('user-' + str(os.getuid()) + '.slice')
    return {name: (root / name).read_text().strip() for name in ['memory.current', 'memory.max', 'memory.events'] if (root / name).exists()}


def process_alive(pid):
    try:
        status = pathlib.Path('/proc', str(pid), 'stat').read_text()
    except FileNotFoundError:
        return False
    return not status.split(') ', 1)[1].startswith('Z ')


def owns_command(pid, expected):
    try:
        command = pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
        if str(expected).encode() in command:
            return True
        relative = expected.name.encode() in command or ('./' + expected.name).encode() in command
        return relative and pathlib.Path('/proc', str(pid), 'cwd').resolve() == expected.parent.resolve()
    except (FileNotFoundError, PermissionError):
        return False


def verify_staging(root):
    failures = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for name, port, expected in [('worker', 4187, root / 'runtime/opencode/packages/sdk/src/tokligence-bridge.ts'),
                                 ('gateway', 4190, root / 'gateway/tgw-proxy.mjs')]:
        healthy = False
        for _ in range(100):
            try:
                pid = int((root / (name + '.pid')).read_text())
                if not owns_command(pid, expected):
                    break
                with opener.open('http://127.0.0.1:' + str(port) + '/health', timeout=1) as response:
                    healthy = response.status == 200
                if healthy: break
            except (OSError, ValueError):
                pass
            time.sleep(.2)
        if not healthy: failures.append(name)
    if failures: raise StagingRestoreError(','.join(failures))


@contextlib.contextmanager
def pause_staging(root, enabled):
    stopped = []
    try:
        if enabled:
            for name, expected in [('worker', root / 'runtime/opencode/packages/sdk/src/tokligence-bridge.ts'),
                                   ('gateway', root / 'gateway/tgw-proxy.mjs')]:
                pid_file = root / (name + '.pid')
                if not pid_file.exists():
                    raise ControlSetupError('staging_pid_missing')
                pid = int(pid_file.read_text())
                if not process_alive(pid):
                    raise ControlSetupError('staging_owner_not_running')
                if not owns_command(pid, expected):
                    raise ControlSetupError('staging_owner_mismatch')
                os.kill(pid, signal.SIGTERM)
                stopped.append((name, pid))
                for _ in range(100):
                    if not process_alive(pid):
                        break
                    time.sleep(.1)
                else:
                    raise ControlSetupError('staging_stop_timeout')
        yield
    finally:
        failures = []
        for name, pid in stopped:
            if process_alive(pid):
                failures.append(name)
                continue  # Never create another owner while the recorded process remains alive.
            try:
                subprocess.run(['python3', str(root / ('start-' + name + '.py'))], check=True, timeout=20)
            except (OSError, subprocess.SubprocessError):
                failures.append(name)
        if failures:
            raise StagingRestoreError(','.join(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/home/agent/tokligence-staging')
    parser.add_argument('--binary')
    parser.add_argument('--bun-transport', help='Use this Bun executable for guarded onward HTTPS; no Python TLS')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--model', default='glm-5.3-flash-free', choices=list(json.loads(CATALOG.read_text())['opencode']['models']))
    parser.add_argument('--not-before', default='2026-10-28T00:01:00+00:00')
    parser.add_argument('--pause-staging', action='store_true')
    parser.add_argument('--fixture-upstream', help='Synthetic loopback /v1 only; report is explicitly not live evidence')
    args = parser.parse_args()
    if not args.fixture_upstream and any(value for key, value in os.environ.items() if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy')):
        parser.exit(2, 'Official control not started: inherited proxy configuration requires review\n')
    threshold = parse_time(args.not_before)
    if not threshold or utc_now() < threshold:
        parser.exit(2, 'Official control not started before the configured comparison time\n')
    root = pathlib.Path(args.root).resolve()
    binary = pathlib.Path(args.binary or root / 'runtime/opencode-public-cli-1.18.32').resolve(strict=True)
    guard = LiveGuard(root, args.run_id, 1, 1024)
    report = {'at': utc_now().isoformat(), 'run_id': args.run_id, 'model': args.model,
              'authentication': 'public', 'scope': 'synthetic' if args.fixture_upstream else 'live',
              'transport': 'official_cli_http_via_guarded_bun' if args.bun_transport else 'official_cli_http_via_guarded_urllib',
              'passed': False, 'coverage_incomplete': True, 'memory_before': memory_snapshot()}
    try:
        with guard:
            artifacts = root / 'live-reports'
            artifacts.mkdir(mode=0o700, exist_ok=True)
            try:
                with pause_staging(root, args.pause_staging):
                    print(json.dumps({'run_id': args.run_id, 'phase': 'official-control-started'}), flush=True)
                    with tempfile.TemporaryDirectory(prefix='official-control-', dir=root) as folder:
                        with official_relay(guard, args.model, args.fixture_upstream, bun_binary=args.bun_transport) as relay:
                            env = profile_environment(folder, relay, args.model)
                            version = subprocess.run([str(binary), '--version'], env=env, cwd=folder,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
                            if version.returncode or version.stdout.strip() != '1.18.32':
                                raise ControlSetupError('verified_cli_version_required')
                            argv = [str(binary), 'run', '--pure', '--model', 'opencode/' + args.model,
                                    '--title', 'Official public diagnostic control', '--format', 'json', '--print-logs',
                                    'Reply exactly OFFICIAL_CONTROL_OK. Do not use tools.']
                            child = subprocess.Popen(argv, env=env, cwd=folder, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, text=True, start_new_session=True)
                            try:
                                try:
                                    stdout, stderr = child.communicate(timeout=90)
                                except subprocess.TimeoutExpired:
                                    os.killpg(child.pid, signal.SIGKILL)
                                    stdout, stderr = child.communicate()
                                    report['timeout'] = True
                            finally:
                                try: os.killpg(child.pid, signal.SIGKILL)
                                except ProcessLookupError: pass
                                child.wait()
                            for suffix, content in [('stdout', stdout), ('stderr', stderr)]:
                                fd = os.open(artifacts / (args.run_id + '.' + suffix), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                                with os.fdopen(fd, 'w') as output: output.write(content)
                            events = []
                            for line in stdout.splitlines():
                                try:
                                    event = json.loads(line)
                                    if isinstance(event, dict): events.append(event)
                                except ValueError: pass
                            text = ''.join(event.get('part', {}).get('text', '') for event in events if event.get('type') == 'text')
                            terminal = any(event.get('type') == 'step_finish' and event.get('part', {}).get('reason') == 'stop' for event in events)
                            report.update(cli_version='1.18.32', exit_code=child.returncode,
                                marker_received='OFFICIAL_CONTROL_OK' in text, terminal_stop=terminal)
                            report['passed'] = child.returncode == 0 and terminal and report['marker_received'] and guard.count == 1 and not guard.blocked
                if args.pause_staging:
                    verify_staging(root)
            except Exception as error:
                report['passed'] = False
                report['error_type'] = type(error).__name__
                if isinstance(error, ControlSetupError):
                    report['setup_error'] = str(error)
                if isinstance(error, StagingRestoreError):
                    report['staging_restore_failures'] = str(error).split(',')
            finally:
                report.update(requests=guard.count, reserved_output_tokens=guard.output_count,
                    reason=guard.blocked, upstream_status=guard.status,
                    upstream_code=guard.entry.get('upstream_code'),
                    upstream_request_id=guard.entry.get('upstream_request_id'),
                    request_metadata=guard.entry.get('request_metadata'),
                    memory_after=memory_snapshot(), cooldown_until=guard.ledger.get('cooldown_until'))
                fd = os.open(artifacts / (args.run_id + '.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as output: json.dump(report, output, indent=2)
                print(json.dumps(report), flush=True)
    except (ProbeStopped, BlockingIOError):
        print(json.dumps({'status': 'not_started', 'coverage_incomplete': True, 'reason': 'Active owner, recorded cooldown or reserved run ID'}))
        return 2
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
