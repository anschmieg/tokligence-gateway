#!/usr/bin/env python3
"""Isolated custom-provider integration smoke for the OpenCode Console plugin.

Parent-reviewed scope (implementation sub-agent; parent runs, reviews and
commits): a NEW, independent custom-provider integration smoke — not upstream
core conformance. It supervises the pinned CLIProxyAPI backend (with the
provider-scoped no-redirect patch) inside a bubblewrap sandbox with no network
egress, a loopback-only mock inference provider, and drives:
  1. plugin registration + auth.parse / provider publication,
  2. one buffered /v1/chat/completions call,
  3. one streaming /v1/messages (Anthropic) call,
and verifies the raw callback envelope, the normalized JSON / data:-prefix
translation, and the physical mock dispatch count (exactly one physical mock
POST /chat/completions per caller call; the plugin forces stream:true upstream
per the native compiler, so the buffered caller call still appears as one
streamed physical dispatch).

Honesty rules enforced by this script:
  - There is NO unsandboxed fallback: bwrap is required or the smoke fails.
  - Every credential is fake; expiry is epoch 2050 so nothing is refreshed;
    no real network, OAuth, refresh owner, or persistent state is touched.
  - KNOWN GAP stays exposed: the host file synthesizer derives req.Provider
    from the auth file metadata.type, and mergedStorageJSON forces the stored
    root type to the provider key, so a raw native Credential.OAuth file
    (type "oauth") cannot survive host persistence and the plugin's
    req.Provider=="opencode" gate declines it. The ENVELOPED shape
    {type: "opencode", storage_version: 1, credential: {native Credential.OAuth}}
    is the EXPECTED SUPPORTED case. A raw-native variant runs SEPARATELY and
    must stay blocked with zero published models; it is never counted as
    dispatch success and no API-key/public/real credential fallback exists.

Usage:
  isolated_host_smoke.py --binary <cli-proxy-api> --plugin <opencode.so> \
      --output <fresh empty directory>

Exit code 0 requires ALL of: proven network-namespace isolation, the enveloped
profile publishing the model, both calls reaching the mock exactly once each
with the fake bearer, and the raw-native profile staying blocked. Any other
outcome exits nonzero with a sanitized failure list in verdict.json; the
parent decides what the evidence means. This script never claims a pass it
cannot evidence.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys

OUTER_DEADLINE_S = 56.0  # hard outer kill for the whole bwrap process group (<=60s)

FIXTURE_NAME = "smoke_fixture.py"

FIXTURE_SOURCE = r'''
"""In-sandbox fixture. argv: <outer_net_ns_token> <backend> <plugin> <work>

Runs inside bwrap: the network namespace is unshared (loopback only), writable
paths are /work (the private output dir) and /tmp (private tmpfs), and /proc
is a freshly mounted procfs. Everything this fixture writes goes under /work.
The fixture prints nothing on success; all evidence goes to /work/summary.json.
"""
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# sys.argv: <outer_net_ns_token> <backend> <plugin> <work>
OUTER_NS_NET = sys.argv[1]
BACKEND = sys.argv[2]
PLUGIN = sys.argv[3]
WORK = pathlib.Path(sys.argv[4])

BACKEND_PORT = 18080
MOCK_PORT = 18081
CALLER_KEY = "smoke-caller-key-0001"
FAKE_ACCESS = "fake-access-token"
FAKE_REFRESH = "fake-refresh-token"
FAKE_EXPIRES_MS = 2524608000000  # 2050-01-01T00:00:00Z; nothing is refreshed
MODEL_ID = "smoke-model"
# Native session id shape: ses_ + 12 lowercase hex + 14 alphanumeric
# (plugins/opencode/session.go SessionIDPattern).
SESSION_ID = "ses_000000000000" + "SmokeSessionAA"

READY_WAIT_S = 8.0
CALL_TIMEOUT_S = 6.0

summary = {
    "profile": None,
    "ns_net_isolated": False,
    "inner_net_ns": "",
    "backend_started": False,
    "backend_ready": False,
    "models_published": None,  # list of published model ids matching MODEL_ID
    "buffered": {"attempted": False, "status": None, "ok": False, "detail": ""},
    "stream": {"attempted": False, "status": None, "ok": False, "detail": ""},
    "reasoning_replay": {"attempted": False, "ok": False, "observed_upstream": False},
    "mock": {"chat_completions_dispatches": 0, "other_paths": [], "last_authorization": None},
    "blocked": False,
    "blocker": "",
}


def read_net_ns():
    try:
        return os.readlink("/proc/self/ns/net")
    except OSError as exc:
        try:
            st = os.stat("/proc/self/ns/net")
            return "inode:%d" % st.st_ino
        except OSError:
            return "unreadable:%s" % exc


def ns_isolation_proven(inner, outer):
    """Isolation is proven only by two READABLE tokens that differ. An
    unreadable inner token is unprovable, never evidence of isolation."""
    if inner.startswith("unreadable") or outer.startswith("unreadable"):
        return False
    return inner != outer


# ---------------------------------------------------------------------------
# loopback mock inference provider (stands in for the OpenCode inference API)
# ---------------------------------------------------------------------------

class MockHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path != "/chat/completions":
            summary["mock"]["other_paths"].append(self.path)
            payload = json.dumps({"error": {"message": "not found"}}).encode()
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        summary["mock"]["chat_completions_dispatches"] += 1
        summary["mock"]["last_authorization"] = self.headers.get("Authorization")
        try:
            req = json.loads(body or b"{}")
        except Exception:
            req = {}
        upstream_model = str(req.get("model", ""))
        wants_stream = bool(req.get("stream"))
        for message in req.get("messages", []):
            if message.get("role") == "assistant" and message.get("reasoning_content") == "smoke-reasoning":
                summary["reasoning_replay"]["observed_upstream"] = True
        summary.setdefault("mock_models_seen", [])
        summary["mock_models_seen"].append(upstream_model)

        if wants_stream:
            # Realistic OpenAI-chat SSE: role, text, reasoning, finish+usage, DONE.
            frames = [
                {"id": "chatcmpl-smoke", "object": "chat.completion.chunk", "created": 1700000000,
                 "model": upstream_model,
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]},
                {"id": "chatcmpl-smoke", "object": "chat.completion.chunk", "created": 1700000000,
                 "model": upstream_model,
                 "choices": [{"index": 0, "delta": {"content": "smoke-text"}}]},
                {"id": "chatcmpl-smoke", "object": "chat.completion.chunk", "created": 1700000000,
                 "model": upstream_model,
                 "choices": [{"index": 0, "delta": {"reasoning_content": "smoke-reasoning"}}]},
                {"id": "chatcmpl-smoke", "object": "chat.completion.chunk", "created": 1700000000,
                 "model": upstream_model,
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for obj in frames:
                frame = b"data: " + json.dumps(obj).encode() + b"\n\n"
                self.wfile.write(b"%x\r\n" % len(frame) + frame + b"\r\n")
                self.wfile.flush()
            tail = b"data: [DONE]\n\n"
            self.wfile.write(b"%x\r\n" % len(tail) + tail + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        else:
            payload = json.dumps({
                "id": "chatcmpl-smoke", "object": "chat.completion", "created": 1700000000,
                "model": upstream_model,
                "choices": [{"index": 0,
                             "message": {"role": "assistant",
                                         "content": "smoke-text",
                                         "reasoning_content": "smoke-reasoning"},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self):
        summary["mock"]["other_paths"].append("GET " + self.path)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def start_mock():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# backend supervision (per profile)
# ---------------------------------------------------------------------------

BLANK_CATALOG = {
    "claude": [], "gemini": [], "vertex": [], "aistudio": [],
    "codex-free": [], "codex-team": [], "codex-plus": [], "codex-pro": [],
    "kimi": [], "antigravity": [], "xai": [], "meta": [],
}


def write_backend_config(work, profile, session_state_path):
    auth_dir = work / ("auth-" + profile)
    plugins_dir = work / ("plugins-" + profile)
    config_path = work / ("config-" + profile + ".yaml")
    # JSON is YAML-compatible; use the pinned v8 hierarchy rather than a
    # handwritten v7 serializer. Caller authentication must really be enabled.
    config = {
        "config-version": 8,
        "server": {"host": "127.0.0.1", "port": BACKEND_PORT},
        "oauth": {"auth-dir": str(auth_dir)},
        "access": {"api-keys": [CALLER_KEY]},
        "management": {"allow-remote": False, "secret-key": "fake-management-only",
            "disable-control-panel": True, "disable-auto-update-panel": True},
        "models": {"catalog": "", "codex-catalog": "", "devin-catalog": ""},
        "routing": {"retry": {"request-retry": 0, "max-retry-credentials": 1},
            "cooldown": {"save-cooldown-status": True}},
        "plugins": {"enabled": True, "dir": str(plugins_dir), "configs": {
            "opencode": {"enabled": True,
                "inference_base_url": "http://127.0.0.1:%d" % MOCK_PORT,
                "models": [MODEL_ID], "app_name": "cli", "version": "2.0.32",
                "channel": "latest", "project_id": "global",
                "session_state_path": str(session_state_path)}}},
    }
    config_path.write_text(json.dumps(config, indent=2))
    return config_path


def prepare_profile_dirs(work, profile):
    auth_dir = work / ("auth-" + profile)
    auth_dir.mkdir(parents=True, exist_ok=True)
    plugins_dir = work / ("plugins-" + profile)
    plugins_dir.mkdir(parents=True, exist_ok=True)
    # The host discovers plugins by scanning plugins.dir for *.so files; the
    # plugin id is the file name minus the extension and must equal the
    # plugins.configs key ("opencode").
    shutil.copyfile(PLUGIN, plugins_dir / "opencode.so")
    blank = work / "blank-catalog.json"
    if not blank.exists():
        blank.write_text(json.dumps(BLANK_CATALOG) + "\n")
    return auth_dir, plugins_dir


def seed_auth_file(auth_dir, shape):
    """Seed one fake credential file in the requested shape.

    enveloped:  {type: opencode, storage_version: 1, credential: {native}}
    raw_native: native Credential.OAuth at the top level (type: oauth)
    Both use only fake tokens; expires is 2050 so no refresh path can run.
    """
    native = {
        "type": "oauth",
        "methodID": "device",
        "access": FAKE_ACCESS,
        "refresh": FAKE_REFRESH,
        "expires": FAKE_EXPIRES_MS,
        "metadata": {
            "server": "http://127.0.0.1:%d" % MOCK_PORT,
            "accountID": "smoke-account",
            "email": "smoke@example.invalid",
            "orgID": "smoke-org",
            "orgName": "Smoke Org",
        },
    }
    if shape == "enveloped":
        payload = {"type": "opencode", "storage_version": 1, "credential": native}
    elif shape == "raw_native":
        payload = dict(native)
    else:
        raise ValueError("unknown shape %r" % shape)
    path = auth_dir / "opencode-smoke.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path


def start_backend(work, profile, config_path):
    (work / "home").mkdir(exist_ok=True)
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(work / "home"),
    }
    log_path = work / ("backend-" + profile + ".log")
    log_file = open(log_path, "ab")
    # Same process group as bwrap: the outer supervisor's killpg reaps
    # everything on every outcome. No start_new_session here.
    proc = subprocess.Popen(
        [BACKEND, "--config", str(config_path), "--local-model"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
        cwd=str(work),
    )
    return proc, log_file


def wait_backend_ready(proc, deadline_s=READY_WAIT_S):
    deadline = time.time() + deadline_s
    url = "http://127.0.0.1:%d/healthz" % BACKEND_PORT
    while time.time() < deadline:
        if proc.poll() is not None:
            return False  # exited early; do not burn the deadline
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def stop_backend(proc, log_file):
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=4)
    finally:
        log_file.close()


# ---------------------------------------------------------------------------
# calls through the backend
# ---------------------------------------------------------------------------

def post_json(path, body, headers, timeout=CALL_TIMEOUT_S):
    url = "http://127.0.0.1:%d%s" % (BACKEND_PORT, path)
    data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def post_stream(path, body, headers, timeout=CALL_TIMEOUT_S):
    url = "http://127.0.0.1:%d%s" % (BACKEND_PORT, path)
    data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            chunks = []
            while True:
                part = response.read(4096)
                if not part:
                    break
                chunks.append(part)
            return response.status, b"".join(chunks)
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def sanitize_error(body_bytes, limit=300):
    text = body_bytes.decode("utf-8", "replace")
    for secret in (FAKE_ACCESS, FAKE_REFRESH, CALLER_KEY):
        text = text.replace(secret, "[redacted]")
    return text[:limit]


def run_profile(work, profile, shape):
    summary["profile"] = profile
    session_state = work / ("sessions-" + profile + ".json")
    config_path = write_backend_config(work, profile, session_state)
    auth_dir, _plugins_dir = prepare_profile_dirs(work, profile)
    seed_auth_file(auth_dir, shape)
    backend, log_file = start_backend(work, profile, config_path)
    try:
        summary["backend_started"] = True
        summary["backend_ready"] = wait_backend_ready(backend)
        if not summary["backend_ready"]:
            summary["blocked"] = True
            summary["blocker"] = "backend did not become ready on /healthz within %.0fs" % READY_WAIT_S
            return

        # Model publication: the plugin publishes only for a usable credential.
        published = []
        try:
            request = urllib.request.Request(
                "http://127.0.0.1:%d/v1/models" % BACKEND_PORT,
                headers={"Authorization": "Bearer " + CALLER_KEY},
            )
            with urllib.request.urlopen(request, timeout=CALL_TIMEOUT_S) as response:
                catalog = json.loads(response.read())
            ids = [m.get("id") for m in catalog.get("data", []) if isinstance(m, dict)]
            published = [m for m in ids if MODEL_ID in (m or "")]
        except Exception as exc:
            summary["blocked"] = True
            summary["blocker"] = "models listing failed: %s" % exc
        summary["models_published"] = published

        # Health becomes ready before the initial auth-file/model load. This
        # is a bounded local metadata wait, never an inference retry.
        publication_deadline = time.monotonic() + 3
        while not published and time.monotonic() < publication_deadline:
            time.sleep(0.1)
            with urllib.request.urlopen(request, timeout=CALL_TIMEOUT_S) as response:
                catalog = json.loads(response.read())
            ids = [m.get("id") for m in catalog.get("data", []) if isinstance(m, dict)]
            published = [m for m in ids if MODEL_ID == m]
        summary["models_published"] = published

        # Native inference header binding (model-request.ts): the caller
        # supplies the session identity; the plugin forwards it upstream.
        chat_headers = {
            "Authorization": "Bearer " + CALLER_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-opencode-session-id": SESSION_ID,
            "x-session-affinity": SESSION_ID,
            "X-Session-Id": SESSION_ID,
        }
        chat_body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "smoke ping"}],
        }

        if not published:
            summary["buffered"]["detail"] = "skipped: no model published"
            summary["stream"]["detail"] = "skipped: no model published"
            if not summary["blocker"]:
                summary["blocked"] = True
                summary["blocker"] = (
                    "zero models published for %s credential shape %r; "
                    "auth.parse/provider publication gate blocked dispatch" % (profile, shape)
                )
            return

        dispatches_before = summary["mock"]["chat_completions_dispatches"]
        summary["buffered"]["attempted"] = True
        status, body = post_json("/v1/chat/completions", chat_body, chat_headers)
        summary["buffered"]["status"] = status
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {}
        content = ""
        message = {}
        if parsed.get("choices"):
            message = parsed["choices"][0].get("message") or {}
            content = str(message.get("content") or "")
        buffered_ok = (
            status == 200
            and parsed.get("object") == "chat.completion"
            and message.get("role") == "assistant"
            and message.get("reasoning_content") == "smoke-reasoning"
            and "smoke-text" in content
            and summary["mock"]["chat_completions_dispatches"] == dispatches_before + 1
        )
        summary["buffered"]["ok"] = buffered_ok
        if not buffered_ok:
            summary["buffered"]["detail"] = "status=%s body=%s" % (status, sanitize_error(body))

        stream_before = summary["mock"]["chat_completions_dispatches"]
        summary["stream"]["attempted"] = True
        status, body = post_stream("/v1/messages", {
            "model": MODEL_ID,
            "max_tokens": 64,
            "stream": True,
            "messages": [{"role": "user", "content": "smoke stream"}],
        }, {**chat_headers, "Accept": "text/event-stream", "anthropic-version": "2023-06-01"})
        summary["stream"]["status"] = status
        text = body.decode("utf-8", "replace")
        stream_ok = (
            status == 200
            and "smoke-text" in text
            and "data:" in text
            and "event: message_start" in text
            and "event: message_stop" in text
            and summary["mock"]["chat_completions_dispatches"] == stream_before + 1
        )
        summary["stream"]["ok"] = stream_ok
        if not stream_ok:
            summary["stream"]["detail"] = "status=%s body=%s" % (status, sanitize_error(body))
        # Independent custom continuation: require actual reasoning-bearing
        # response data, then verify it reaches the next upstream assistant.
        if stream_ok and "smoke-reasoning" in text and "thinking_delta" in text:
            replay_before = summary["mock"]["chat_completions_dispatches"]
            summary["reasoning_replay"]["attempted"] = True
            replay_status, replay_body = post_json("/v1/messages", {
                "model": MODEL_ID, "max_tokens": 64, "stream": False,
                "messages": [
                    {"role": "user", "content": "smoke stream"},
                    {"role": "assistant", "content": [
                        {"type": "thinking", "thinking": "smoke-reasoning", "signature": ""},
                        {"type": "text", "text": "smoke-text"}]},
                    {"role": "user", "content": "continue"}],
            }, chat_headers)
            replay = json.loads(replay_body) if replay_status == 200 else {}
            summary["reasoning_replay"]["ok"] = (
                replay_status == 200 and replay.get("type") == "message"
                and summary["reasoning_replay"]["observed_upstream"]
                and summary["mock"]["chat_completions_dispatches"] == replay_before + 1)
    finally:
        stop_backend(backend, log_file)


def snapshot_state():
    return {
        key: (dict(value) if isinstance(value, dict) else value)
        for key, value in summary.items()
    }


def reset_profile_state():
    summary["profile"] = None
    summary["backend_started"] = False
    summary["backend_ready"] = False
    summary["models_published"] = None
    summary["buffered"] = {"attempted": False, "status": None, "ok": False, "detail": ""}
    summary["stream"] = {"attempted": False, "status": None, "ok": False, "detail": ""}
    summary["reasoning_replay"] = {"attempted": False, "ok": False, "observed_upstream": False}
    summary["mock"] = {"chat_completions_dispatches": 0, "other_paths": [], "last_authorization": None}
    summary["blocked"] = False
    summary["blocker"] = ""
    summary.pop("mock_models_seen", None)


def write_summary(report):
    (WORK / "summary.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


def main():
    inner_net = read_net_ns()
    summary["inner_net_ns"] = inner_net
    summary["ns_net_isolated"] = ns_isolation_proven(inner_net, OUTER_NS_NET)
    report = {"ns_net_isolated": summary["ns_net_isolated"], "inner_net_ns": inner_net, "profiles": {}}
    if not summary["ns_net_isolated"]:
        write_summary(report)
        return 1
    mock = start_mock()
    try:
        run_profile(WORK, "enveloped", "enveloped")
        report["profiles"]["enveloped"] = {
            "state": snapshot_state(),
            "mock": json.loads(json.dumps(summary["mock"])),
        }
        reset_profile_state()
        run_profile(WORK, "raw_native", "raw_native")
        report["profiles"]["raw_native"] = {
            "state": snapshot_state(),
            "mock": json.loads(json.dumps(summary["mock"])),
        }
    finally:
        write_summary(report)
        mock.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def outer_net_ns_token():
    try:
        return os.readlink("/proc/self/ns/net")
    except OSError as exc:
        try:
            st = os.stat("/proc/self/ns/net")
            return "inode:%d" % st.st_ino
        except OSError:
            return "unreadable:%s" % exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True,
                        help="Pinned cli-proxy-api backend binary (provider-scoped no-redirect build)")
    parser.add_argument("--plugin", required=True,
                        help="Built opencode plugin shared object (opencode.so)")
    parser.add_argument("--output", required=True,
                        help="Fresh empty directory for private artifacts")
    args = parser.parse_args()

    if shutil.which("bwrap") is None:
        parser.error("bubblewrap (bwrap) is required; there is no unsandboxed fallback")

    binary = pathlib.Path(args.binary).resolve(strict=True)
    plugin = pathlib.Path(args.plugin).resolve(strict=True)
    output = pathlib.Path(args.output).resolve()

    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must be an executable file")
    if not plugin.is_file():
        parser.error("--plugin must be an existing shared object file")
    if output.exists() and any(output.iterdir()):
        parser.error("--output must be empty; previous evidence is never overwritten")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.chmod(0o700)

    fixture_path = output / FIXTURE_NAME
    fixture_path.write_text(FIXTURE_SOURCE)
    os.chmod(fixture_path, 0o500)

    ns_token = outer_net_ns_token()

    # PID namespace is NOT available in this environment (proc mount for a new
    # pidns fails); the network namespace IS. The backend is spawned by the
    # fixture WITHOUT start_new_session, so bwrap's single process group owns
    # fixture + backend and the outer killpg reaps everything on every outcome.
    command = ["bwrap", "--unshare-net", "--die-with-parent"]
    for name in ("/usr", "/lib", "/lib64", "/bin"):
        if pathlib.Path(name).exists():
            command += ["--ro-bind", name, name]
    command += ["--dir", "/etc"]
    for name in ("/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts"):
        if pathlib.Path(name).exists():
            command += ["--ro-bind", name, name]
    # resolv.conf is deliberately NOT mounted: loopback needs no DNS.
    command += [
        "--ro-bind", str(binary), "/backend",
        "--ro-bind", str(plugin), "/plugin.so",
        "--ro-bind", str(fixture_path), "/" + FIXTURE_NAME,
        "--bind", str(output), "/work",
        "--tmpfs", "/tmp",
        "--dev", "/dev",
        "--proc", "/proc",
        "--chdir", "/work",
        "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--",
        "/usr/bin/python3", "/" + FIXTURE_NAME,
        ns_token, "/backend", "/plugin.so", "/work",
    ]

    child = subprocess.Popen(command, start_new_session=True)
    code = None
    timed_out = False
    try:
        code = child.wait(timeout=OUTER_DEADLINE_S)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        # Always stop and reap the whole supervised process group (fixture,
        # backend, and any descendants) regardless of outcome.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass

    summary_path = output / "summary.json"
    if timed_out:
        (output / "supervisor_error.txt").write_text(
            "outer supervisor deadline (%ss) exceeded; process group killed\n" % OUTER_DEADLINE_S)
        raise SystemExit(1)
    if code != 0:
        (output / "supervisor_error.txt").write_text(
            "fixture exited with code %r; inspect private artifacts\n" % code)
        raise SystemExit(1)

    # ---- outer verdict, strictly on the recorded evidence ----
    report = json.loads(summary_path.read_text())
    profiles = report["profiles"]
    enveloped = profiles["enveloped"]
    raw = profiles["raw_native"]
    failures = []

    if not report.get("ns_net_isolated"):
        failures.append("network namespace isolation inside bwrap could not be proven "
                        "(inner token %r vs outer %r)" % (report.get("inner_net_ns"), ns_token))
    if not enveloped["state"].get("backend_ready"):
        failures.append("enveloped: backend never became ready (blocker=%r)"
                        % enveloped["state"].get("blocker"))
    published = enveloped["state"].get("models_published") or []
    if not published:
        failures.append("enveloped: zero models published (blocker=%r)"
                        % enveloped["state"].get("blocker"))
    if not enveloped["state"]["buffered"].get("ok"):
        failures.append("enveloped: buffered chat failed (%s)"
                        % enveloped["state"]["buffered"].get("detail"))
    if not enveloped["state"]["stream"].get("ok"):
        failures.append("enveloped: anthropic stream failed (%s)"
                        % enveloped["state"]["stream"].get("detail"))
    mock_env = enveloped["mock"]
    if not enveloped["state"]["reasoning_replay"].get("ok"):
        failures.append("enveloped: reasoning-bearing continuation was not verified")
    if mock_env.get("chat_completions_dispatches") != 3:
        failures.append("enveloped: physical mock dispatches = %r, want exactly 3 "
                        "(one per caller call; the plugin forces stream:true upstream)"
                        % mock_env.get("chat_completions_dispatches"))
    auth_seen = mock_env.get("last_authorization") or ""
    if "fake-access-token" not in auth_seen:
        failures.append("enveloped: mock never saw the fake bearer token (got %r)" % auth_seen[:40])

    # Raw-native variant: honesty gate. Blocked-with-zero-models is the
    # EXPECTED outcome for the known gap; any publication or dispatch attempt
    # here would contradict the gap evidence and fails the smoke.
    if raw["state"].get("models_published"):
        failures.append("raw_native: unexpectedly published models %r; known-gap evidence contradicted"
                        % raw["state"]["models_published"])
    if not raw["state"].get("backend_ready") or raw["mock"].get("chat_completions_dispatches") != 0:
        failures.append("raw_native: blocked-shape control was not ready or dispatched")
    if raw["state"]["buffered"].get("attempted") or raw["state"]["stream"].get("attempted"):
        failures.append("raw_native: dispatch was attempted despite zero publication")

    verdict = {
        "outer_net_ns": ns_token,
        "failures": failures,
        "verdict": "pass" if not failures else "fail",
    }
    (output / "verdict.json").write_text(json.dumps(verdict, indent=2, sort_keys=True) + "\n")
    # Sanitized stdout: verdict summary only; never secrets or artifact bodies.
    print(json.dumps({"verdict": verdict["verdict"],
                      "failures": failures,
                      "artifacts": str(summary_path)}))
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
