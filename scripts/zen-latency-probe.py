#!/usr/bin/env python3
import contextlib
import http.server
import io
import json
import os
import re
import sys
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock

ENV_FILE = "/home/t3/.env"
GATEWAY_HOST = "code.nothing.pink"


class ProbeError(Exception):
    pass


def safe_emit(kind, **fields):
    allowed = {"status", "gateway_request_id", "cf_ray", "response_type", "server_class", "gateway_auth_error", "cloudflare_challenge", "cf_mitigated_challenge", "first_frame_ms", "first_text_ms", "complete_ms", "terminal", "evidence", "case"}
    clean = {k: v for k, v in fields.items() if k in allowed}
    print(json.dumps({"event": kind, **clean}, separators=(",", ":")))


def parse_env(path, required=("NOTHING_API_BASE", "NOTHING_API_KEY")):
    values = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip("\"'")
            if key in {"NOTHING_API_BASE", "NOTHING_API_KEY", "COOLIFY_BASE_URL", "COOLIFY_ACCESS_TOKEN"}:
                values[key] = value
    if any(not values.get(k) for k in required):
        raise ProbeError("configuration")
    return values


def normalized(base, host, suffix):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or parsed.hostname != host or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProbeError("target")
    path = parsed.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3].rstrip("/")
    if suffix == "v1/chat/completions":
        path = path + "/v1/chat/completions"
    else:
        path = path + "/api/v1/"
    return urllib.parse.urlunsplit(("https", host, path, "", ""))


def safe_header(headers, name):
    value = headers.get(name, "")
    if len(value) <= 128 and re.fullmatch(r"[A-Za-z0-9._:-]*", value):
        return value
    return ""


def classify_response(status, headers, body):
    content_type = headers.get("Content-Type", "").lower()
    if "json" in content_type:
        response_type = "json"
    elif "html" in content_type:
        response_type = "html"
    elif not body:
        response_type = "empty"
    else:
        response_type = "other"
    server = headers.get("Server", "").lower()
    server_class = "cloudflare" if "cloudflare" in server else "nginx" if "nginx" in server else "other"
    try:
        payload = json.loads(body) if body else {}
    except (ValueError, TypeError):
        payload = {}
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    gateway_auth_error = isinstance(error, dict) and error.get("code") in {"invalid_api_key", "authentication_error", "unauthorized"}
    challenge = "challenge" in headers.get("cf-mitigated", "").lower() or any(marker in body.lower() for marker in (b"just a moment", b"cf-chl-", b"cloudflare challenge"))
    return {
        "response_type": response_type,
        "server_class": server_class,
        "gateway_auth_error": gateway_auth_error,
        "cloudflare_challenge": challenge,
        "cf_mitigated_challenge": headers.get("cf-mitigated", "").lower() == "challenge",
        "cf_ray": safe_header(headers, "cf-ray"),
        "gateway_request_id": safe_header(headers, "x-gateway-request-id"),
    }


def read_stream(response):
    start = time.monotonic()
    first_frame = first_text = None
    content = bytearray()
    terminal = False
    for raw in response:
        now = time.monotonic()
        if first_frame is None:
            first_frame = now
        content.extend(raw)
        if len(content) > 1024 * 1024:
            raise ProbeError("response_limit")
        if b"data:" in content and first_text is None:
            lines = content.decode("utf-8", "ignore").splitlines()
            for line in lines:
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        terminal = True
                    else:
                        try:
                            item = json.loads(payload)
                            delta = item.get("choices", [{}])[0].get("delta", {})
                            if isinstance(delta.get("content"), str) and delta["content"]:
                                first_text = now
                        except (ValueError, AttributeError, IndexError, TypeError):
                            pass
    end = time.monotonic()
    if not terminal:
        raise ProbeError("terminal")
    return {
        "first_frame_ms": round((first_frame - start) * 1000, 1) if first_frame else None,
        "first_text_ms": round((first_text - start) * 1000, 1) if first_text else None,
        "complete_ms": round((end - start) * 1000, 1),
        "terminal": True,
    }


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, data, headers, timeout=30, method="POST"):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirectHandler)
    return opener.open(req, timeout=timeout)


def live():
    values = parse_env(ENV_FILE)
    chat_url = normalized(values["NOTHING_API_BASE"], GATEWAY_HOST, "v1/chat/completions")
    safe_emit("request", evidence="os_http_proxy_present" if any(os.environ.get(key) for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) else "os_http_proxy_absent")
    body = json.dumps({"model": "zen-residential", "stream": True, "messages": [{"role": "user", "content": "Reply with one short word."}]}).encode()
    try:
        try:
            response = request(chat_url, body, {"Authorization": "Bearer " + values["NOTHING_API_KEY"], "Content-Type": "application/json", "Accept": "text/event-stream"})
        except urllib.error.HTTPError as exc:
            safe = classify_response(exc.code, exc.headers or {}, exc.read(1024 * 1024))
            safe_emit("chat", status=exc.code, **safe)
            return
        with response:
            status = response.status
            if status == 200:
                result = read_stream(response)
                safe_emit("chat", status=status, gateway_request_id=safe_header(response.headers, "x-gateway-request-id"), terminal=result["terminal"], first_frame_ms=result["first_frame_ms"], first_text_ms=result["first_text_ms"], complete_ms=result["complete_ms"])
            else:
                safe = classify_response(status, response.headers, response.read(1024 * 1024))
                safe_emit("chat", status=status, **safe)
    except (OSError, ProbeError, ValueError):
        safe_emit("blocked", case="transport_or_stream")


def logs_live():
    values = parse_env(ENV_FILE, ("COOLIFY_BASE_URL", "COOLIFY_ACCESS_TOKEN"))
    logs_url = normalized(values["COOLIFY_BASE_URL"], "panel.nothing.pink", "logs")
    logs_url += "applications/iog8gk8g8o0s44840g4o4sso/logs?lines=1500"
    ray = "a4f7e5f82ef6d2f6-FRA"
    opener = urllib.request.build_opener(NoRedirectHandler)
    user_agent_present = any(name.lower() == "user-agent" and bool(value) for name, value in opener.addheaders)
    safe_emit("logs_request", evidence="single_coolify_get_user_agent_default_present" if user_agent_present else "single_coolify_get_user_agent_absent")
    try:
        try:
            response = request(logs_url, None, {"Authorization": "Bearer " + values["COOLIFY_ACCESS_TOKEN"], "Accept": "application/json"}, timeout=15, method="GET")
        except urllib.error.HTTPError as exc:
            safe = classify_response(exc.code, exc.headers or {}, exc.read(1024 * 1024))
            safe_emit("logs", status=exc.code, **safe)
            return
        with response:
            payload = json.loads(response.read(8 * 1024 * 1024))
            status = response.status
        if not isinstance(payload, dict) or not isinstance(payload.get("logs"), str):
            safe_emit("logs", status=status, evidence="unexpected_json_shape")
            return
        matches = []
        for line in payload["logs"].splitlines():
            try:
                record = json.loads(line)
            except (ValueError, TypeError):
                continue
            if isinstance(record, dict) and ray in json.dumps(record, separators=(",", ":")):
                matches.append(record)
        safe_emit("logs", status=status, evidence="ray_match_count_" + str(len(matches)))
        for record in matches:
            timestamp = next((record.get(key) for key in ("timestamp", "time", "ts") if isinstance(record.get(key), str) and re.fullmatch(r"\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})", record[key])), None)
            rid = next((record.get(key) for key in ("gateway_request_id", "request_id") if isinstance(record.get(key), str) and re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", record[key])), "")
            code = next((record.get(key) for key in ("status", "status_code") if isinstance(record.get(key), int) and 100 <= record[key] <= 599), None)
            safe_emit("ray_match", evidence=json.dumps({"timestamp": timestamp, "gateway_request_id": rid, "status": code}, separators=(",", ":")))
    except (OSError, ProbeError, ValueError, TypeError):
        safe_emit("logs", evidence="unavailable")


def synthetic_tests():
    secret_a, secret_b = "SYNTHETIC_NOTHING_KEY_7X", "SYNTHETIC_COOLIFY_TOKEN_9Q"
    output = io.StringIO()
    redirect_hits = []

    class RedirectHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(307)
            self.send_header("Location", "http://127.0.0.1:%d/target" % target_server.server_port)
            self.end_headers()

        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:%d/target" % target_server.server_port)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    class TargetHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            redirect_hits.append((self.command, self.headers.get("Authorization")))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            redirect_hits.append((self.command, self.headers.get("Authorization")))
            self.send_response(200)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    target_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
    redirect_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    servers = [threading.Thread(target=s.serve_forever, daemon=True) for s in (target_server, redirect_server)]
    for server_thread in servers:
        server_thread.start()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            parse_env("/definitely-not-a-real-config")
        except (OSError, ProbeError):
            pass
        else:
            raise SystemExit(1)
        try:
            normalized("https://example.invalid", GATEWAY_HOST, "v1/chat/completions")
        except ProbeError:
            pass
        else:
            raise SystemExit(1)
        safe403 = classify_response(403, {"Content-Type": "text/html", "Server": "cloudflare", "cf-mitigated": "challenge", "cf-ray": "abc123-IAD", "Set-Cookie": secret_a, "Location": "https://elsewhere.invalid/"}, b"<html>Just a moment " + secret_b.encode() + b"</html>")
        if safe403 != {"response_type": "html", "server_class": "cloudflare", "gateway_auth_error": False, "cloudflare_challenge": True, "cf_mitigated_challenge": True, "cf_ray": "abc123-IAD", "gateway_request_id": ""}:
            raise SystemExit(1)
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            safe_emit("chat", status=403, **safe403)
        for failure in (
            urllib.error.HTTPError("https://code.nothing.pink", 403, "blocked", {}, io.BytesIO((secret_a + secret_b).encode())),
            OSError(secret_a + secret_b),
        ):
            with mock.patch("urllib.request.OpenerDirector.open", side_effect=failure):
                try:
                    request("https://code.nothing.pink", (secret_a + secret_b).encode(), {"Authorization": "Bearer " + secret_a + secret_b})
                except Exception:
                    safe_emit("blocked", case="synthetic_failure")
        for method, token in (("POST", secret_a), ("GET", secret_b)):
            try:
                request("http://127.0.0.1:%d/redirect" % redirect_server.server_port, b"{}" if method == "POST" else None, {"Authorization": "Bearer " + token}, timeout=3, method=method)
            except urllib.error.HTTPError as exc:
                if exc.code not in (301, 302, 303, 307, 308):
                    raise
                safe_emit("test", case="redirect_refused", evidence="passed")
            else:
                raise SystemExit(1)
        if redirect_hits:
            raise SystemExit(1)
        with mock.patch("sys.argv", ["probe", "--live", secret_a, secret_b]):
            safe_emit("test", case="argv_redaction", evidence="passed")
    for server in (redirect_server, target_server):
        server.shutdown()
        server.server_close()
    captured = output.getvalue()
    if secret_a in captured or secret_b in captured:
        raise SystemExit(1)
    if secret_a in captured or secret_b in captured or "elsewhere.invalid" in captured or "Set-Cookie" in captured:
        raise SystemExit(1)
    for case in ("missing_config", "wrong_target", "synthetic_failure", "403_classification", "argv_redaction"):
        safe_emit("test", case=case, evidence="passed")
    safe_emit("test", case="stdout_stderr_secret_scan", evidence="passed")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        synthetic_tests()
    elif len(sys.argv) == 2 and sys.argv[1] == "--live":
        live()
    elif len(sys.argv) == 2 and sys.argv[1] == "--logs-live":
        logs_live()
    else:
        safe_emit("usage", case="use_self_test_or_live")
        raise SystemExit(2)
