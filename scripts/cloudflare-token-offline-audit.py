#!/usr/bin/env python3
import contextlib
import http.server
import io
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

ENV_FILE = "/home/t3/.env"
TOKEN_KEY = "CLOUDFLARE_LOGS_TOKEN"
ZONE_URL = "https://api.cloudflare.com/client/v4/zones?" + urllib.parse.urlencode({"name": "nothing.pink", "per_page": 50})
VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify"


def parse_zone_env(text):
    token = None
    for line in text.splitlines():
        match = re.match(r"\s*(?:export\s+)?CLOUDFLARE_LOGS_TOKEN\s*=\s*(.*)", line)
        if match:
            token = match.group(1).strip().strip("\"'")
    return token


def parse_verify_env(text):
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?CLOUDFLARE_LOGS_TOKEN\s*=\s*(.*?)\s*$", line)
        if match:
            value = match.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            return value
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def do_request(url, token, timeout):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"}, method="GET")
    return urllib.request.build_opener(NoRedirect).open(request, timeout=timeout)


def classify_actual_env():
    try:
        with open(ENV_FILE, "r", encoding="utf-8", newline="") as handle:
            text = handle.read()
    except OSError:
        return {"source_read": False}
    lines = text.splitlines()
    matching = [line for line in lines if re.match(r"\s*(?:export\s+)?CLOUDFLARE_LOGS_TOKEN\s*=", line)]
    raw_values = []
    vals = []
    for line in matching:
        match = re.match(r"\s*(?:export\s+)?CLOUDFLARE_LOGS_TOKEN\s*=\s*(.*)", line)
        raw_values.append(match.group(1))
        vals.append(match.group(1).strip().strip("\"'"))
    selected = vals[-1] if vals else ""
    raw_selected = raw_values[-1].strip() if raw_values else ""
    quote_starts = bool(raw_selected) and raw_selected[0] in "\"'"
    quote_ends = bool(raw_selected) and raw_selected[-1] in "\"'"
    matching_quote_pair = quote_starts and raw_selected[0] == raw_selected[-1]
    def valid_repr(value):
        return bool(value) and not any(ord(c) < 32 or ord(c) == 127 or ord(c) > 126 for c in value)
    return {
        "source_read": True,
        "matching_definition_count_multiple": len(matching) > 1,
        "first_last_equivalent": len(vals) < 2 or vals[0] == vals[-1],
        "selected_empty": not bool(selected),
        "selected_whitespace_only": bool(selected) and not selected.strip(),
        "matching_quote_pair": matching_quote_pair,
        "malformed_outer_quote_pair": quote_starts != quote_ends or (quote_starts and not matching_quote_pair),
        "whitespace_inside_selected": any(c.isspace() for c in selected),
        "literal_placeholder_present": bool(re.search(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", selected)),
        "inline_comment_marker_present": "#" in selected,
        "control_character_present": any(ord(c) < 32 or ord(c) == 127 for c in selected),
        "non_ascii_present": any(ord(c) > 126 for c in selected),
        "scheme_like_prefix_present": selected.lower().startswith(("bearer ", "basic ", "token ")),
        "urlencoded_or_jsonescaped_marker_present": bool(re.search(r"%[0-9A-Fa-f]{2}|\\\\[\\\\/\"bfnrtu]", selected)),
        "parser_values_agree": bool(vals) and parse_zone_env(text) == parse_verify_env(text),
        "selected_representation_safe_printable": valid_repr(selected),
    }


def run_loopback_checks():
    seen = []
    response_status = 200
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append({"path": self.path, "authorization": self.headers.get_all("Authorization", []), "accept": self.headers.get_all("Accept", [])})
            self.send_response(response_status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success":true}')
        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_port
    cases = {
        "export_crlf_unquoted": "# ignored\r\nexport CLOUDFLARE_LOGS_TOKEN = fake-value-1\r\n",
        "single_quoted": "CLOUDFLARE_LOGS_TOKEN='fake-value-2'\n",
        "double_quoted": 'CLOUDFLARE_LOGS_TOKEN="fake-value-3"\n',
        "inline_comment_preserved": "CLOUDFLARE_LOGS_TOKEN=fake-value-4 # literal\n",
        "duplicate_last_wins": "CLOUDFLARE_LOGS_TOKEN=fake-first\nexport CLOUDFLARE_LOGS_TOKEN=fake-last\n",
        "duplicate_first_wins_verifier": "CLOUDFLARE_LOGS_TOKEN=fake-first\nexport CLOUDFLARE_LOGS_TOKEN=fake-last\n",
    }
    reports = []
    try:
        for name, text in cases.items():
            zone = parse_zone_env(text)
            verify = parse_verify_env(text)
            expected = {
                "export_crlf_unquoted": "fake-value-1",
                "single_quoted": "fake-value-2",
                "double_quoted": "fake-value-3",
                "inline_comment_preserved": "fake-value-4 # literal",
                "duplicate_last_wins": "fake-last",
                "duplicate_first_wins_verifier": "fake-first",
            }[name]
            chosen = verify if name == "duplicate_first_wins_verifier" else zone
            response_status = 200
            with do_request(base + "/zones?name=nothing.pink&per_page=50", chosen, 3) as response:
                success_status = response.status
            response_status = 401
            try:
                with do_request(base + "/user/tokens/verify", chosen, 3) as response:
                    error_status = response.status
            except urllib.error.HTTPError as exc:
                error_status = exc.code
                exc.close()
            received_success, received_error = seen[-2:]
            reports.append({
                "case": name,
                "selected_equals_fixture": chosen == expected,
                "zone_parser_wire_header_exact": received_success["authorization"] == ["Bearer " + zone],
                "verify_parser_wire_header_exact": received_error["authorization"] == ["Bearer " + verify],
                "success_request_path_exact": received_success["path"] == "/zones?name=nothing.pink&per_page=50",
                "verify_request_path_exact": received_error["path"] == "/user/tokens/verify",
                "one_authorization_header_each": len(received_success["authorization"]) == 1 and len(received_error["authorization"]) == 1,
                "accept_json_each": received_success["accept"] == ["application/json"] and received_error["accept"] == ["application/json"],
                "success_status": success_status,
                "error_status": error_status,
                "credential_free": True,
            })
        return reports
    finally:
        server.shutdown()
        server.server_close()


def parser_edge_checks():
    fixtures = {
        "empty": "CLOUDFLARE_LOGS_TOKEN=\n",
        "spaces_quoted": 'CLOUDFLARE_LOGS_TOKEN="  fake  "\n',
        "scheme_prefix": "CLOUDFLARE_LOGS_TOKEN=Bearer fake\n",
        "leading_comment": "# CLOUDFLARE_LOGS_TOKEN=comment-value\n",
        "json_escape_preserved": 'CLOUDFLARE_LOGS_TOKEN="fake\\nvalue"\n',
    }
    return {name: {"zone_empty": parse_zone_env(text) == "", "verify_empty": parse_verify_env(text) == "", "parsers_equal": parse_zone_env(text) == parse_verify_env(text)} for name, text in fixtures.items()}


def main():
    out = {"audit": "offline_cloudflare_token_audit", "verification_source": "reconstructed_from_user_supplied_executed_logic", "external_requests": False}
    out["actual_env_classification"] = classify_actual_env()
    out["loopback_request_checks"] = run_loopback_checks()
    out["parser_edge_checks"] = parser_edge_checks()
    print(json.dumps(out, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
