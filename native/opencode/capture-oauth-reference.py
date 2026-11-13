#!/usr/bin/env python3
"""Pinned native OAuth CLI/gateway comparison. SYNTHETIC ONLY; no live mode."""
import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tarfile
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from oauth_profile import GATEWAY_FILES


def descendants():
    rows = {}
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(path.name)] = (int(fields[1]), fields[19])
        except (OSError, ValueError, IndexError): pass
    owned = {os.getpid()}
    while True:
        more = {pid for pid, (parent, _) in rows.items() if parent in owned}
        if more.issubset(owned): break
        owned.update(more)
    return {pid: rows[pid][1] for pid in owned if pid != os.getpid()}


def cleanup_descendants():
    # Subreaping also retains ownership of detached descendants if the namespace
    # supervisor dies. pidfds/start times prevent signalling a reused PID.
    for _ in range(20):
        rows = descendants()
        for pid, started in rows.items():
            try:
                fd = os.pidfd_open(pid)
                try:
                    current = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
                    if current == started: signal.pidfd_send_signal(fd, signal.SIGKILL)
                finally: os.close(fd)
            except (OSError, ProcessLookupError): pass
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0: break
            except ChildProcessError: break
        if not descendants(): return
        import time
        time.sleep(.05)
    raise RuntimeError('Owned fixture descendants did not terminate')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--bun', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', required=True, help='New private synthetic evidence directory')
    parser.add_argument('--archive', help='Pinned upstream archive; defaults beside prepared source')
    args = parser.parse_args()
    source = pathlib.Path(args.source).resolve(strict=True)
    bun = pathlib.Path(args.bun).resolve(strict=True)
    node = pathlib.Path(args.node).resolve(strict=True)
    pin = json.loads((HERE / 'source.json').read_text())
    installed = json.loads((source / '.tokligence-source.json').read_text())
    if any(pin[key] != installed[key] for key in ['version', 'commit']):
        parser.error('Pinned native source required')
    if subprocess.check_output([str(bun), '--version'], text=True).strip() != pin['bun']:
        parser.error('Pinned Bun required')
    archive = pathlib.Path(args.archive or source.parent / ('opencode-' + pin['version'] + '.tar.gz')).resolve(strict=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin['sha256']:
        parser.error('Pinned upstream archive hash mismatch')
    if json.loads((source / 'packages/cli/package.json').read_text())['version'] != pin['version']:
        parser.error('Pinned CLI package required')
    # Verify the actual CLI source against the pinned archive, rather than
    # trusting only a version stamp or comparing our own SDK helper to itself.
    verified = 0
    expected_cli = set()
    with tarfile.open(archive, 'r:gz') as upstream:
        for member in upstream:
            if not member.isfile(): continue
            relative = '/'.join(member.name.split('/')[1:])
            if relative.startswith('packages/cli/src/'): expected_cli.add(relative)
            if relative.startswith('packages/cli/src/') or relative in ('packages/cli/package.json', 'packages/cli/bunfig.toml', 'bun.lock'):
                if hashlib.sha256(upstream.extractfile(member).read()).digest() != hashlib.sha256((source / relative).read_bytes()).digest():
                    parser.error('Native CLI source differs from pinned archive')
                verified += 1
    actual_cli = {str(path.relative_to(source)) for path in (source / 'packages/cli/src').rglob('*') if path.is_file()}
    if expected_cli != actual_cli: parser.error('Native CLI source has unexpected/missing files')
    if verified < 10: parser.error('Pinned archive did not contain the native CLI')
    manifest = json.loads((source / 'packages/sdk/src/tokligence-overlay.json').read_text())
    # A manifest cannot choose files outside the fixed reviewed source list.
    files = ['packages/core/src/session/model-request.ts', 'packages/ai/src/schema/options.ts',
             'packages/ai/src/protocols/openai-chat.ts', 'packages/sdk/src/tokligence-bridge.ts',
             'packages/sdk/src/tokligence-bridge-wire.mjs', 'packages/sdk/src/tokligence-state-store.mjs',
             'packages/sdk/src/tokligence-scoped-http.ts', 'packages/sdk/src/tokligence-source-overlay.mjs',
             'packages/sdk/src/tokligence-source.json']
    hashes = {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in files}
    digest = hashlib.sha256(json.dumps(hashes, separators=(',', ':')).encode()).hexdigest()
    if manifest.get('files') != hashes or manifest.get('digest') != digest:
        parser.error('Complete prepared source overlay required')
    if not shutil.which('bwrap'):
        parser.error('bubblewrap required; no unsandboxed fallback')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal') or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        parser.error('Linux child-subreaper/pidfd supervision required')
    output = pathlib.Path(args.output).resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('Evidence directory cannot be reused')
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.chmod(0o700)
    seed = source / ('packages/sdk/src/tokligence-oauth-seed-' + str(uuid.uuid4()) + '.ts')
    child = None
    gateway = HERE.parents[1]
    canary = gateway / ('.oauth-mount-canary-' + str(uuid.uuid4()))
    with os.fdopen(os.open(canary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file: file.write('synthetic-private-checkout-canary')
    try:
        seed.write_text((HERE / 'testing/oauth-seed.ts').read_text())
        command = ['bwrap', '--unshare-net', '--die-with-parent']
        for name in ['/usr', '/lib', '/lib64', '/bin', '/nix']:
            if pathlib.Path(name).exists(): command += ['--ro-bind', name, name]
        command += ['--dir', '/etc']
        for name in ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']:
            if pathlib.Path(name).exists(): command += ['--ro-bind', name, name]
        gateway = HERE.parents[1]
        dependency_roots = {(gateway / 'node_modules').resolve(strict=True)}
        for item in (gateway / 'node_modules').rglob('*'):
            if not item.is_symlink(): continue
            target = item.resolve(strict=True)
            parts = target.parts
            if 'node_modules' not in parts: parser.error('Gateway dependency is outside a node_modules tree')
            dependency_roots.add(pathlib.Path(*parts[:parts.index('node_modules') + 1]))
        for deps in sorted(dependency_roots): command += ['--ro-bind', str(deps), str(deps)]
        # Mount the static gateway graph, not the checkout's .env, .git,
        # untracked captures or other account-bearing files.
        command += ['--dir', '/gateway', '--dir', '/gateway/native', '--dir', '/gateway/native/opencode', '--dir', '/gateway/native/opencode/testing']
        for name in GATEWAY_FILES:
            command += ['--ro-bind', str(gateway / name), '/gateway/' + name]
        command += ['--ro-bind', str(gateway / 'node_modules'), '/gateway/node_modules']
        for name in ['oauth_profile.py', 'oauth_meter.py', 'live_safety.py', 'official_control.py', 'official-models.json',
                     'metered-native-fetch.mjs', 'testing/oauth-reference.py']:
            command += ['--ro-bind', str(HERE / name), '/gateway/native/opencode/' + name]
        command += ['--ro-bind', str(source), '/source', '--ro-bind', str(bun), '/bun',
                    '--ro-bind', str(node), '/node', '--bind', str(output), '/work',
                    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/work',
                    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/work',
                    '--', '/usr/bin/python3', '/gateway/native/opencode/testing/oauth-reference.py',
                    os.readlink('/proc/self/ns/net'), '/source/' + str(seed.relative_to(source)), canary.name]
        child = subprocess.Popen(command, start_new_session=True)
        code = child.wait(timeout=180)
        if code: return code
        summary = json.loads((output / 'summary.json').read_text())
        if not summary.get('passed') or not summary.get('external_network_blocked'):
            return 1
        summary.update(source_commit=pin['commit'], overlay_sha256=digest, cli_archive_files_verified=verified)
        with (output / 'provenance.json').open('x') as file: json.dump(summary, file, indent=2)
        (output / 'provenance.json').chmod(0o600)
        print(json.dumps(summary))
        return 0
    finally:
        if child:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
        try: cleanup_descendants()
        finally:
            seed.unlink(missing_ok=True)
            canary.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main())
