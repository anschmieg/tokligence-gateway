#!/usr/bin/env python3
"""Start, stop, status, and smoke-check the pinned CLIProxyAPI staging server.

Operates only on a root installed and bootstrapped by cliproxy_staging.py.
Never prints key values, raw config, or server log content; errors name the
private file and a short reason only. A PID from the private record is only
signalled after re-verifying process identity (kernel start time, UID, and
full command line), so an unrelated recycled PID can never be killed. Refuses
to start when the port is occupied, when an owned process is already running,
or when the config deviates from the loopback staging shape.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cliproxy_staging as base  # noqa: E402

READY_SECONDS = 20
STOP_SECONDS = 10
POLL_SECONDS = 0.25
RECORD_NAME = ".lifecycle.json"
LOCK_NAME = ".lifecycle.lock"
LOG_NAME = "lifecycle.log"

# The backend rewrites config.yaml on first launch (secret-key and client keys
# are hashed in place, blank lines dropped), so only fields the server never
# removes are checked here. Verified against the pinned 8.0.49 aarch64 binary.
REQUIRED_SHAPES = [
    "config-version: 8",
    f'host: "{base.BIND_HOST}"',
    f"port: {base.BIND_PORT}",
    "disable-auto-update-panel: true",
    'catalog: ""',
]
# Provider configuration is owned/validated by the native backend. Do not
# make documented provider entries prevent an ordinary staging restart.
# These string checks are only a bootstrap-shape sanity check, not a YAML
# parser or security boundary against an administrator editing the config.
FORBIDDEN_SHAPES = []


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def paths(raw: str) -> tuple[Path, Path, Path]:
    root = base.resolve_root(raw)
    return root, root / "bin" / base.BINARY_NAME, root / "config" / "config.yaml"


def config_ok(config: Path) -> None:
    """Check the staging shape without parsing YAML or displaying contents."""
    try:
        data = config.read_text()
    except OSError:
        die("staging config is missing or unreadable; run bootstrap first")
    if any(item not in data for item in REQUIRED_SHAPES):
        die("config does not match the expected loopback staging shape; refusing to operate")
    expected_remote = "true" if base.BIND_HOST != "127.0.0.1" else "false"
    if f"allow-remote: {expected_remote}" not in data:
        die("management access setting does not match the selected private listener")
    for pattern, label in FORBIDDEN_SHAPES:
        if re.search(pattern, data):
            die(f"config contains {label}; this loopback staging tool refuses to operate")
    if 'secret-key: ""' in data or "secret-key:" not in data:
        die("config is missing a management secret key")
    if "api-keys:" not in data:
        die("config is missing the client api-keys list")


def keys_ok(root: Path) -> tuple[str, str]:
    """Load private keys; values are used, never printed."""
    values = []
    for name in ("management.key", "client-api-key"):
        path = root / "secrets" / name
        try:
            value = path.read_text().strip()
        except OSError:
            die(f"private key file {path} is missing; run bootstrap first")
        if not value:
            die(f"private key file {path} is empty; re-bootstrap a fresh root")
        values.append(value)
    return values[0], values[1]


def expected_cmd(binary: Path, config: Path) -> list[str]:
    return [str(binary), "--config", str(config), "--local-model"]


def proc_identity(pid: int) -> dict | None:
    """Read identity fields from /proc; None means not verifiably alive."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        tail = stat[stat.rfind(")") + 2 :].split()
        uid = int(Path(f"/proc/{pid}/status").read_text().split("Uid:")[1].split()[0])
        cmd = [a.decode(errors="replace") for a in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if a]
        exe = os.readlink(f"/proc/{pid}/exe")
        return {"pid": pid, "start": int(tail[19]), "uid": uid, "cmd": cmd, "exe": exe}
    except (OSError, ValueError, IndexError):
        return None


def identity_matches(record: dict, binary: Path, config: Path) -> bool:
    """True only if the record still names our exact live process.

    Compares PID liveness, kernel start time (defeats PID recycling), UID,
    executable, and the full command line. The record's own stored fields must
    match too, so a foreign or tampered record never authorizes a signal.
    """
    if not isinstance(record, dict):
        return False
    try:
        pid = int(record.get("pid", -1))
    except (TypeError, ValueError):
        return False
    if pid <= 1:
        return False
    now = proc_identity(pid)
    expected = expected_cmd(binary, config)
    return bool(
        now
        and now["start"] == record.get("start")
        and now["uid"] == os.geteuid()
        and now["uid"] == record.get("uid")
        and now["exe"] == str(binary)
        and now["cmd"] == expected
        and record.get("cmd") == expected
    )


def load_record(root: Path) -> dict | None:
    try:
        record = json.loads((root / RECORD_NAME).read_text())
        return record if isinstance(record, dict) else None
    except (OSError, ValueError):
        return None


def save_record(root: Path, record: dict) -> None:
    tmp = root / (RECORD_NAME + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(record, fh)
        fh.write("\n")
    os.replace(tmp, root / RECORD_NAME)


def lock_root(root: Path) -> int:
    """Hold an exclusive OS lock for the command's lifetime; never unlink it."""
    fd = os.open(root / LOCK_NAME, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        die("another lifecycle command owns this staging root")
    return fd


def http(path: str, key: str | None = None, timeout: float = 3.0) -> tuple[int, bytes]:
    req = urllib.request.Request(f"http://{base.BIND_HOST}:{base.BIND_PORT}{path}")
    if key is not None:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read()
        except Exception:
            return exc.code, b""
    except (OSError, urllib.error.URLError) as exc:
        return 0, str(exc).encode()


def port_free() -> bool:
    """True when a listener can take the port.

    SO_REUSEADDR mirrors the Go server's own listener: stale TIME_WAIT
    sockets from a just-stopped instance do not count as occupation, but an
    active listener still does.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((base.BIND_HOST, base.BIND_PORT))
            return True
        except OSError:
            return False


def spawn_server(root: Path, binary: Path, config: Path) -> subprocess.Popen:
    log = root / LOG_NAME
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        return subprocess.Popen(
            expected_cmd(binary, config),
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=fd,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(fd)


def wait_ready(child: subprocess.Popen, root: Path, binary: Path, config: Path) -> dict | None:
    """Poll /healthz until it answers 200 with our child still verified alive.

    The pinned binary exits 0 when the port is taken, so liveness plus a 200
    from the loopback port is what proves the child owns the listener.
    """
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        if child.poll() is not None:
            die(f"native process exited before becoming ready; inspect {root / LOG_NAME} manually")
        if http("/healthz", timeout=1.0)[0] == 200:
            now = proc_identity(child.pid)
            if now and now["exe"] == str(binary) and now["cmd"] == expected_cmd(binary, config):
                return now
        time.sleep(POLL_SECONDS)
    return None


def terminate_verified(pid: int, force: bool) -> bool:
    """SIGTERM an identity-verified PID and wait; True when it exited."""
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + STOP_SECONDS
    while time.monotonic() < deadline:
        if proc_identity(pid) is None:
            return True
        time.sleep(POLL_SECONDS)
    if not force:
        return False
    os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + STOP_SECONDS
    while time.monotonic() < deadline:
        if proc_identity(pid) is None:
            return True
        time.sleep(POLL_SECONDS)
    die(f"pid {pid} ignored SIGKILL; inspect manually")


def cmd_start(args: argparse.Namespace) -> int:
    root, binary, config = paths(args.root)
    if (root / "state/coolify-owner.ready").exists():
        die("runtime ownership belongs to Coolify; use its application lifecycle, not a second host process")
    if not binary.is_file() or not os.access(binary, os.X_OK):
        die(f"native executable {binary} is missing or not executable; run install first")
    if not config.is_file():
        die(f"staging config {config} is missing; run bootstrap first")
    config_ok(config)
    keys_ok(root)

    lock = lock_root(root)
    try:
        record = load_record(root)
        if record and identity_matches(record, binary, config):
            die(f"owned staging process is already running (pid {record['pid']})")
        if not port_free():
            die(f"port {base.BIND_HOST}:{base.BIND_PORT} is occupied; refusing to start")

        child = spawn_server(root, binary, config)
        now = wait_ready(child, root, binary, config)
        if now is None:
            if child.poll() is None and not terminate_verified(child.pid, force=False):
                die(f"server did not become ready within {READY_SECONDS}s and ignored SIGTERM; inspect {root / LOG_NAME}")
            die(f"server did not become ready within {READY_SECONDS}s; inspect {root / LOG_NAME} manually")
        save_record(root, {
            "pid": child.pid,
            "start": now["start"],
            "uid": os.geteuid(),
            "cmd": expected_cmd(binary, config),
            "started_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        print(f"started pid {child.pid}; health OK on {base.BIND_HOST}:{base.BIND_PORT}")
        print(f"pid record  {root / RECORD_NAME} (0600)")
        print(f"log file    {root / LOG_NAME} (0600)")
        return 0
    finally:
        os.close(lock)


def cmd_status(args: argparse.Namespace) -> int:
    root, binary, config = paths(args.root)
    record = load_record(root)
    if record and identity_matches(record, binary, config):
        print(f"running pid {record['pid']} (uid {record['uid']}, started {record.get('started_utc', 'unknown')})")
        return 0
    if record:
        print(f"stopped (stale record referencing pid {record.get('pid')}; not acted on)")
    else:
        print("stopped (no lifecycle record)")
    return 1


def cmd_stop(args: argparse.Namespace) -> int:
    root, binary, config = paths(args.root)
    lock = lock_root(root)
    try:
        record = load_record(root)
        if not record:
            print("stopped (no lifecycle record); nothing to stop")
            return 0
        if not identity_matches(record, binary, config):
            print(
                f"stopped (stale record referencing pid {record.get('pid')}); "
                "not signalling a process this tool does not own; record kept for inspection"
            )
            return 1
        pid = int(record["pid"])
        if terminate_verified(pid, force=args.force):
            # The verified process is confirmed gone; remove only this
            # tool's record so status reads clean and a stale PID is never
            # left behind for a later start to trip over.
            (root / RECORD_NAME).unlink(missing_ok=True)
            print(f"stopped pid {pid}" + (" (SIGKILL)" if args.force else ""))
            return 0
        print(f"pid {pid} did not exit within {STOP_SECONDS}s of SIGTERM; re-run with --force", file=sys.stderr)
        return 1
    finally:
        os.close(lock)


def smoke_checks(management_key: str, client_key: str) -> list[str]:
    """Minimum smoke: native health, pinned dashboard bytes, auth boundary."""
    failures = []
    status, _ = http("/healthz")
    if status != 200:
        failures.append(f"GET /healthz: expected 200, got {status or 'connection failed'}")
    status, body = http("/management.html")
    if status != 200:
        failures.append(f"GET /management.html: expected 200, got {status or 'connection failed'}")
    elif hashlib.sha256(body).hexdigest() != base.DASHBOARD_SHA256:
        failures.append("served dashboard bytes do not match the pinned v1.27.0 digest")
    status, _ = http("/v8/management/config")
    if status != 401:
        failures.append(f"GET /v8/management/config without key: expected 401, got {status or 'connection failed'}")
    status, _ = http("/v8/management/config", key=management_key)
    if status != 200:
        failures.append(f"GET /v8/management/config with management key: expected 200, got {status or 'connection failed'}")
    status, _ = http("/v8/management/config", key=client_key)
    if status == 200:
        failures.append("management API accepted the client key; key separation broken")
    status, _ = http("/v1/models", key=client_key)
    if status != 200:
        failures.append(f"GET /v1/models with client key: expected 200, got {status or 'connection failed'}")
    status, _ = http("/v1/models", key=management_key)
    if status == 200:
        failures.append("inference surface accepted the management key; key separation broken")
    return failures


def cmd_smoke(args: argparse.Namespace) -> int:
    root, binary, config = paths(args.root)
    lock = lock_root(root)
    try:
        record = load_record(root)
        if not record or not identity_matches(record, binary, config):
            die("smoke requires the owned staging server to be running (start it first)")
        config_ok(config)
        management_key, client_key = keys_ok(root)
        failures = smoke_checks(management_key, client_key)

        # Config/key persistence across one restart. The first-launch config
        # rewrite already happened during start, so the file must be
        # byte-stable across this restart and both keys must still work.
        before = hashlib.sha256(config.read_bytes()).hexdigest()
        pid = int(record["pid"])
        if not terminate_verified(pid, force=False):
            die(f"could not stop the owned process for the persistence check within {STOP_SECONDS}s")
        child = spawn_server(root, binary, config)
        now = wait_ready(child, root, binary, config)
        if now is None:
            if child.poll() is None:
                terminate_verified(child.pid, force=False)
            die(f"server did not come back after restart; inspect {root / LOG_NAME} manually")
        save_record(root, {
            "pid": child.pid,
            "start": now["start"],
            "uid": os.geteuid(),
            "cmd": expected_cmd(binary, config),
            "started_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        if hashlib.sha256(config.read_bytes()).hexdigest() != before:
            failures.append("config bytes changed across the restart")
        failures.extend(smoke_checks(management_key, client_key))

        if failures:
            for failure in failures:
                print(f"FAIL {failure}", file=sys.stderr)
            die(f"smoke failed with {len(failures)} failure(s)")
        print("smoke OK: health, dashboard digest, auth boundary, config/keys persist across one restart")
        return 0
    finally:
        os.close(lock)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="cliproxy_lifecycle.py",
        description=(
            "Start, stop, inspect, and smoke-check the pinned CLIProxyAPI staging "
            "server. Refuses unexpected configs and occupied ports; never prints "
            "key values or private log/config content."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="start the server after config preflight")
    p_stop = sub.add_parser("stop", help="stop the owned staging server")
    p_status = sub.add_parser("status", help="report whether the owned server is running")
    p_smoke = sub.add_parser("smoke", help="health, dashboard, auth boundary, one-restart persistence")
    for p in (p_start, p_stop, p_status, p_smoke):
        p.add_argument("--root", default=base.DEFAULT_ROOT, help=f"staging root (default: {base.DEFAULT_ROOT})")
        p.add_argument("--listen-host", default=base.BIND_HOST, help="127.0.0.1 or this node's literal Tailscale IPv4 address")
    p_stop.add_argument("--force", action="store_true", help="escalate to SIGKILL if SIGTERM is ignored")
    p_start.set_defaults(func=cmd_start)
    p_stop.set_defaults(func=cmd_stop)
    p_status.set_defaults(func=cmd_status)
    p_smoke.set_defaults(func=cmd_smoke)

    args = parser.parse_args()
    try:
        address = ipaddress.ip_address(args.listen_host)
    except ValueError:
        die("listen host must be a literal loopback or Tailscale IPv4 address")
    if str(address) != "127.0.0.1" and address not in ipaddress.ip_network("100.64.0.0/10"):
        die("listen host must be loopback or Tailscale IPv4")
    base.BIND_HOST = str(address)
    REQUIRED_SHAPES[1] = f'host: "{base.BIND_HOST}"'
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
