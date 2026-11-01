#!/usr/bin/env python3
"""Install and bootstrap the pinned CLIProxyAPI + Management Center staging stack.

Downloads the two pinned public release artifacts, verifies their SHA-256
digests against the downloaded bytes for the actual host architecture,
installs the native binary and native dashboard into a NEW caller-specified
root, and (bootstrap) writes a once-only loopback configuration with
privately generated management and client keys.

The tool never starts the server and never prints key values.
Staging only; no wrapper proxy, helper, custom dashboard, or Plus fork.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import sys
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BACKEND_REPO = "router-for-me/CLIProxyAPI"
BACKEND_VERSION = "8.0.49"
DASHBOARD_REPO = "router-for-me/Cli-Proxy-API-Management-Center"
DASHBOARD_VERSION = "1.27.0"
DASHBOARD_ASSET = "management.html"
BINARY_NAME = "cli-proxy-api"

# Byte-verified against the public release downloads on 2026-11-01
# (docs/design/upstream-artifact-pins.md).
BACKEND_SHA256 = {
    "amd64": "f61d5e27ed46c1eebfdd240eb50cf15d6d6be38b22159e9618a667f671f22d94",
    "aarch64": "685bbc0a99a6f8b4ddfaa1666f446a0d7a6ee36ea53216b29e2fb7e0c6a5711b",
}
DASHBOARD_SHA256 = "2ca7a226f8d2fa078fb52e12fd5b75762ded2dc585205d3da509ebfb17ea2adf"

DEFAULT_ROOT = "/home/agent/cliproxy-staging"
BIND_HOST = "127.0.0.1"
BIND_PORT = 4195
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

FORBIDDEN_ROOTS = {
    "/",
    "/boot",
    "/data",
    "/data/cliproxy",
    "/etc",
    "/home",
    "/home/agent",
    "/home/agent/tokligence",
    "/home/agent/tokligence-staging",
    "/root",
    "/usr",
    "/var",
}


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def checked_digest(value: str, label: str) -> str:
    # Release digests must be complete; a truncated or malformed pin is never trusted.
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        die(f"{label}: pinned SHA-256 must be exactly 64 hex characters, got {value!r}; refusing to use it")
    return value


def detect_arch(override: str | None) -> str:
    machine = (override or platform.machine()).lower()
    if machine in ("x86_64", "amd64"):
        return "amd64"
    if machine in ("aarch64", "arm64"):
        return "aarch64"
    die(f"unsupported platform {machine!r}: this staging installer supports linux amd64 and aarch64 only")


def backend_asset(arch: str) -> tuple[str, str]:
    name = f"CLIProxyAPI_{BACKEND_VERSION}_linux_{arch}.tar.gz"
    url = f"https://github.com/{BACKEND_REPO}/releases/download/v{BACKEND_VERSION}/{name}"
    return name, url


def dashboard_asset_url() -> str:
    return (
        f"https://github.com/{DASHBOARD_REPO}/releases/download/"
        f"v{DASHBOARD_VERSION}/{DASHBOARD_ASSET}"
    )


def download_verified(url: str, digest: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".{dest.name}.part"
    hasher = hashlib.sha256()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cliproxy-staging-installer/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
            total = 0
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    die(f"download of {url} exceeded {MAX_DOWNLOAD_BYTES} bytes; aborting")
                hasher.update(chunk)
                out.write(chunk)
        actual = hasher.hexdigest()
        if actual != digest:
            die(f"SHA-256 mismatch for {url}: expected {digest}, downloaded bytes hash to {actual}")
        os.replace(tmp, dest)
    except Exception as exc:
        die(f"download failed for {url}: {exc}")
    finally:
        if tmp.exists():
            tmp.unlink()


def resolve_root(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        die(f"--root must be an absolute path, got {raw!r}")
    root = path.resolve()
    if str(root) in FORBIDDEN_ROOTS:
        die(f"refusing to use {root}: forbidden or production location")
    repo = Path(__file__).resolve().parent.parent.parent
    if root == repo or root in repo.parents:
        die(f"refusing to use {root}: staging root must not be the repository or one of its ancestors")
    return root


def require_new_root(root: Path) -> None:
    if root.exists():
        if not root.is_dir():
            die(f"{root} exists and is not a directory")
        if any(root.iterdir()):
            die(f"{root} exists and is not empty; install requires a NEW (nonexistent or empty) root")
    else:
        root.mkdir(parents=True)


def write_private(path: Path, content: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(content)


def cmd_install(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    require_new_root(root)
    arch = detect_arch(args.arch)
    backend_digest = checked_digest(BACKEND_SHA256[arch], f"backend {arch} archive pin")
    dashboard_digest = checked_digest(DASHBOARD_SHA256, "dashboard pin")
    asset_name, asset_url = backend_asset(arch)

    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as tmpdir:
        archive = Path(tmpdir) / asset_name
        download_verified(asset_url, backend_digest, archive)
        with tarfile.open(archive, "r:gz") as tf:
            try:
                member = tf.getmember(BINARY_NAME)
            except KeyError:
                die(f"{asset_name} does not contain {BINARY_NAME}")
            if not member.isfile():
                die(f"{asset_name}: {BINARY_NAME} is not a regular file")
            tf.extract(member, path=bin_dir, filter="data")
    binary_path = bin_dir / BINARY_NAME
    os.chmod(binary_path, 0o755)
    if binary_path.stat().st_size < 1024 * 1024:
        die(f"extracted binary {binary_path} is implausibly small; aborting")

    # The server resolves the panel as <config-dir>/static/management.html and
    # only downloads it when missing, so pre-placing the pinned asset here
    # together with disable-auto-update-panel means it never fetches a panel.
    dashboard_path = root / "config" / "static" / DASHBOARD_ASSET
    download_verified(dashboard_asset_url(), dashboard_digest, dashboard_path)

    manifest = {
        "tool": "staging/cli-proxy-api/cliproxy_staging.py",
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "platform": "linux",
        "arch": arch,
        "backend": {
            "repo": BACKEND_REPO,
            "version": BACKEND_VERSION,
            "asset": asset_name,
            "url": asset_url,
            "sha256": backend_digest,
        },
        "dashboard": {
            "repo": DASHBOARD_REPO,
            "version": DASHBOARD_VERSION,
            "asset": DASHBOARD_ASSET,
            "url": dashboard_asset_url(),
            "sha256": dashboard_digest,
        },
        "paths": {
            "binary": str(binary_path),
            "dashboard": str(dashboard_path),
            "config_dir": str(root / "config"),
        },
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    os.chmod(manifest_path, 0o644)

    print(f"installed CLIProxyAPI v{BACKEND_VERSION} (linux {arch})")
    print(f"  binary   {binary_path}")
    print(f"  sha256   {backend_digest}")
    print(f"installed Management Center v{DASHBOARD_VERSION}")
    print(f"  dashboard {dashboard_path}")
    print(f"  sha256    {dashboard_digest}")
    print(f"manifest {manifest_path}")
    print(f"next: {Path(__file__).name} bootstrap --root {root}")
    return 0


def cmd_bootstrap(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    if not root.is_dir():
        die(f"{root} does not exist; run 'install' first")
    binary_path = root / "bin" / BINARY_NAME
    if not binary_path.is_file():
        die(f"{binary_path} is missing; run 'install' first")
    dashboard_path = root / "config" / "static" / DASHBOARD_ASSET
    if not dashboard_path.is_file():
        die(f"{dashboard_path} is missing; run 'install' first (bootstrap never downloads)")

    config_path = root / "config" / "config.yaml"
    launch = f"{binary_path} --config {config_path} --local-model"
    if config_path.exists():
        print(f"config already exists at {config_path}; not overwritten")
        print(f"launch: {launch}")
        return 0

    config_dir = root / "config"
    config_dir.mkdir(exist_ok=True)
    os.chmod(config_dir, 0o700)
    auth_dir = root / "auth"
    auth_dir.mkdir(exist_ok=True)
    os.chmod(auth_dir, 0o700)
    if any(auth_dir.iterdir()):
        die(f"{auth_dir} is not empty; bootstrap requires an empty auth state")
    secrets_dir = root / "secrets"
    secrets_dir.mkdir(exist_ok=True)
    os.chmod(secrets_dir, 0o700)

    management_key = secrets.token_hex(32)
    client_key = secrets.token_hex(32)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    config_text = f"""# CLIProxyAPI staging configuration (loopback only, no providers).
# Generated by staging/cli-proxy-api/cliproxy_staging.py bootstrap on {now}.
# Bootstrap is once-only: re-running bootstrap never overwrites this file.
config-version: 8

models:
  catalog: ""
  codex-catalog: ""
  devin-catalog: ""

server:
  host: "{BIND_HOST}"
  port: {BIND_PORT}

management:
  allow-remote: false
  secret-key: "{management_key}"
  disable-auto-update-panel: true

access:
  api-keys:
    - "{client_key}"

routing:
  retry:
    request-retry: 0
    max-retry-credentials: 1
  cooldown:
    save-cooldown-status: true

oauth:
  auth-dir: "{auth_dir}"

plugins:
  enabled: false
"""
    write_private(config_path, config_text)
    # The backend hashes management.secret-key inside config.yaml on first
    # startup, so the only durable plaintext copies live here, mode 0600.
    write_private(secrets_dir / "management.key", management_key + "\n")
    write_private(secrets_dir / "client-api-key", client_key + "\n")

    print(f"wrote config  {config_path} (0600, keys not printed)")
    print(f"wrote keys    {secrets_dir / 'management.key'} (0600)")
    print(f"              {secrets_dir / 'client-api-key'} (0600)")
    print(f"auth state    {auth_dir} (empty)")
    print(f"launch: {launch}")
    print(f"management panel: http://{BIND_HOST}:{BIND_PORT}/management.html")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="cliproxy_staging.py",
        description=(
            "Install the pinned CLIProxyAPI v8.0.49 binary and Management Center "
            "v1.27.0 dashboard into a NEW staging root, and bootstrap a once-only "
            "loopback configuration. Never starts the server."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_install = sub.add_parser("install", help="download, verify, and install the pinned artifacts")
    p_install.add_argument("--root", default=DEFAULT_ROOT, help=f"staging root (default: {DEFAULT_ROOT})")
    p_install.add_argument(
        "--arch",
        choices=["amd64", "aarch64"],
        default=None,
        help="override host architecture detection (default: detected platform)",
    )
    p_install.set_defaults(func=cmd_install)

    p_boot = sub.add_parser("bootstrap", help="write the once-only staging config and keys")
    p_boot.add_argument("--root", default=DEFAULT_ROOT, help=f"staging root (default: {DEFAULT_ROOT})")
    p_boot.set_defaults(func=cmd_bootstrap)

    args = parser.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
