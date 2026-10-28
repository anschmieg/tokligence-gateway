#!/usr/bin/env python3
"""Capture the official CLI against a synthetic OpenCode provider, without external networking."""
import argparse
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys

helpers = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True, help='Official Linux OpenCode executable')
parser.add_argument('--bun-transport', help='Exercise guarded Bun onward transport in the blocked network namespace')
parser.add_argument('--output', required=True, help='New or empty directory for private artifacts')
parser.add_argument('--fixture', default=str(pathlib.Path(__file__).with_name('offline-cli-fixture.py')))
parser.add_argument('--model', default='glm-5.3-flash-free', choices=list(json.loads((helpers / 'official-models.json').read_text())['opencode']['models']))
args = parser.parse_args()
binary = pathlib.Path(args.binary).resolve(strict=True)
fixture = pathlib.Path(args.fixture).resolve(strict=True)
output = pathlib.Path(args.output).resolve()
if not binary.is_file() or not os.access(binary, os.X_OK):
    parser.error('binary must be an executable file')
if output.exists() and any(output.iterdir()):
    parser.error('output directory must be empty; previous evidence is never overwritten')
output.mkdir(mode=0o700, parents=True, exist_ok=True)
output.chmod(0o700)
if not shutil.which('bwrap'):
    parser.error('bubblewrap is required; there is no unsandboxed fallback')
command = ['bwrap', '--unshare-net', '--die-with-parent']
for name in ['/usr', '/lib', '/lib64', '/bin']:
    if pathlib.Path(name).exists():
        command += ['--ro-bind', name, name]
command += ['--dir', '/etc']
for name in ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf']:
    if pathlib.Path(name).exists():
        command += ['--ro-bind', name, name]
for name in ['official_control.py', 'live_safety.py', 'official-models.json', 'public-bun-transport.mjs']:
    command += ['--ro-bind', str(helpers / name), '/' + name]
if args.bun_transport:
    command += ['--ro-bind', str(pathlib.Path(args.bun_transport).resolve(strict=True)), '/bun']
command += ['--ro-bind', str(binary), '/cli', '--ro-bind', str(fixture), '/fixture.py',
            '--bind', str(output), '/work', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--chdir', '/work', '--clearenv', '--',
            '/usr/bin/python3', '/fixture.py', os.readlink('/proc/self/ns/net'), args.model]
if args.bun_transport:
    command += ['/bun']
child = subprocess.Popen(command, start_new_session=True)
try:
    code = child.wait(timeout=55)
except subprocess.TimeoutExpired:
    raise SystemExit('Offline capture supervisor timed out; inspect private artifacts')
finally:
    # The fixture and CLI remain in this dedicated process group. Reap any
    # remaining children even if startup or the fixture itself failed.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
if code:
    raise SystemExit(code)
summary = json.loads((output / 'summary.json').read_text())
if not (summary['external_network_blocked'] and summary['marker_received'] and summary['public_auth_only']
        and summary['exit_code'] == 0 and summary['requests'] == 1):
    raise SystemExit(1)
