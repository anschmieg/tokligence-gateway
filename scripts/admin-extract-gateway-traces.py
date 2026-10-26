#!/usr/bin/env python3
"""Read-only, allowlisted extraction of production gateway inference traces."""
import json
import re
import subprocess
import sys
import unittest
from datetime import datetime, timezone

APPLICATION = "iog8gk8g8o0s44840g4o4sso"
SINCE = "2026-10-24T12:00:00Z"
SUCCESS_IDS = {
    "4a19d23c-7ab6-4aff-8150-fb817e5361ad",
    "3e0b53e4-d067-4810-96d6-65b637f1133d",
}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
DOCKER_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(.*)$")
SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:/-]{1,128}$")
EVENTS = {
    "ingress", "body_done", "route_plan", "attempt_start", "upstream_headers",
    "upstream_429", "upstream_rejected", "attempt_failed", "response_finish",
    "client_disconnected", "pending", "deadline", "cline_request_features",
    "cline_upstream_failure", "transport_phase_start", "transport_phase_end",
    "setup_phase_start", "setup_phase_end", "pool_slot", "pool_account_selected",
}
NUMERIC_FIELDS = {
    "elapsed_ms", "status", "body_bytes", "content_length", "candidate_count",
    "attempt_number", "slot", "retry_after_ms", "cooldown_ms", "remaining_ms",
    "request_body_bytes", "request_tool_count", "request_message_count",
    "request_max_tokens", "request_max_completion_tokens", "duration_ms",
}
BOOL_FIELDS = {
    "request_has_tools", "request_stream", "request_has_system", "request_has_temperature",
    "request_has_top_p", "request_has_stop", "request_has_tool_choice",
    "request_has_parallel_tool_calls", "request_has_response_format",
    "request_has_stream_options", "request_has_n", "request_has_seed", "request_has_user",
}
TEXT_FIELDS = {"stage", "provider", "upstream_model", "deadline", "model"}
SAFE_CODES = {
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
    "EAI_AGAIN", "ENOTFOUND", "TOTAL_DEADLINE", "RESPONSE_START_DEADLINE",
    "CLIENT_DISCONNECTED", "OPENCODE_POOL_EXHAUSTED", "cline_auth_error",
    "cline_daily_free_quota_exhausted", "cline_model_retired", "cline_request_rejected",
    "cline_upstream_error", "cline_upstream_unavailable", "upstream_error",
}
ENUMS = {
    "cline_classification": {"cline_auth_error", "cline_daily_free_quota_exhausted", "cline_model_retired", "cline_request_rejected", "cline_upstream_error"},
    "cline_error_code": {"invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "not_found_error", "api_error", "overloaded_error", "server_error", "insufficient_quota", "context_length_exceeded", "model_not_found", "unknown"},
    "cline_content_type": {"application_json", "event_stream", "other", "unknown"},
    "phase": {"session_id", "authorization", "credential", "client_version", "proxy_connect", "connection", "tls", "body_sent", "upstream_headers_wait", "pool_selection"},
    "outcome": {"ok", "error", "cancelled", "completed_after_cancel", "failed_after_cancel", "reused", "rejected", "exhausted", "timeout"},
    "reason": {"eligible", "excluded_after_failure", "model_ineligible", "missing_credential", "cooldown"},
    "category": {"accountquota", "modelcapacity", "rate_limit", "free_usage_limit", "free_tier_rejection", "unknown"},
    "provider_error_code": {"FreeUsageLimitError", "FreeTierError", "rate_limit_error"},
    "upstream_error_code": {"FreeUsageLimitError", "FreeTierError", "rate_limit_error"},
}


def parse_line(line):
    """Return (timestamp, decoded trace record) for a JSON app log line."""
    timestamp = None
    match = DOCKER_TS.match(line)
    if match:
        timestamp, line = match.groups()
    try:
        obj = json.loads(line)
    except (ValueError, TypeError):
        return timestamp, None
    if not isinstance(obj, dict) or obj.get("trace") != "inference":
        return timestamp, None
    return timestamp, obj


def sanitize(timestamp, obj):
    event = obj.get("event")
    request_id = obj.get("request_id")
    if event not in EVENTS or not isinstance(request_id, str) or not UUID.fullmatch(request_id):
        return None
    out = {"timestamp": timestamp, "event": event, "request_id": request_id}
    for key in NUMERIC_FIELDS:
        value = obj.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1:
            out[key] = value
    for key in BOOL_FIELDS:
        if isinstance(obj.get(key), bool):
            out[key] = obj[key]
    for key in TEXT_FIELDS:
        value = obj.get(key)
        if isinstance(value, str) and SAFE_VALUE.fullmatch(value):
            out[key] = value
    if obj.get("code") in SAFE_CODES:
        out["code"] = obj["code"]
    for key, allowed in ENUMS.items():
        if obj.get(key) in allowed:
            out[key] = obj[key]
    return out


def group_records(lines):
    groups = {}
    discovery_times = []
    malformed = 0
    for line in lines:
        timestamp, obj = parse_line(line)
        if obj is None:
            if 'OpenCode free discovery failed:' in line:
                discovery_times.append(timestamp)
            malformed += 1
            continue
        record = sanitize(timestamp, obj)
        if record is None:
            malformed += 1
            continue
        groups.setdefault(record["request_id"], []).append(record)
    for records in groups.values():
        records.sort(key=lambda record: record.get("timestamp") or "")
    return groups, discovery_times, malformed


def group_is_cline_failure(records):
    cline = any(r.get("provider") == "cline-oauth" or r["event"] == "cline_upstream_failure"
                or str(r.get("model", "")).lower().startswith("cline/")
                or str(r.get("upstream_model", "")).lower().startswith("cline/")
                for r in records)
    failed = any(r["event"] in {"cline_upstream_failure", "attempt_failed", "upstream_rejected", "response_finish", "deadline", "client_disconnected"}
                 and (r.get("event") != "response_finish" or r.get("status", 0) >= 500)
                 for r in records)
    # A Cline adapter transport exception can appear only as a 502 response with no provider field.
    cline = cline or any(r.get("code") in {"cline_upstream_unavailable", "cline_upstream_error", "cline_model_retired", "cline_auth_error"}
                         for r in records)
    return cline and failed


def docker_log_lines(stdout, stderr):
    """Docker returns container stdout and stderr separately; both carry logs."""
    if len(stdout.encode()) + len(stderr.encode()) > 16 * 1024 * 1024:
        raise RuntimeError("Docker log output exceeded 16 MiB; refusing truncated evidence")
    return stdout.splitlines() + stderr.splitlines()


def extract(lines):
    groups, discovery_times, malformed = group_records(lines)
    successes = {rid: groups.get(rid, []) for rid in sorted(SUCCESS_IDS)}
    candidates = {rid: recs for rid, recs in groups.items()
                  if rid not in SUCCESS_IDS and group_is_cline_failure(recs)}
    return {
        "source": "production_gateway_docker_logs",
        "since_utc": SINCE,
        "docker_tail_limit_lines": 10000,
        "docker_log_output_limit_bytes": 16777216,
        "successes_correlated_by_exact_request_id": successes,
        "cline_failure_candidates_not_user_correlated": candidates,
        "opencode_free_discovery_failure_count": len(discovery_times),
        "opencode_free_discovery_failure_timestamps_utc": discovery_times,
        "ignored_or_malformed_line_count": malformed,
    }


def docker_command(args, timeout=25):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)


def production_container():
    # Discover by the independently verified Coolify app UUID embedded in the
    # deployed image/name, then inspect each candidate before selecting one.
    ps = docker_command(["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"], timeout=15)
    if ps.returncode:
        raise RuntimeError("docker ps failed (exit %d); no output shown" % ps.returncode)
    candidates = []
    for row in ps.stdout.splitlines():
        parts = row.split("\t")
        if len(parts) != 3:
            continue
        cid, name, image = parts
        if re.fullmatch(re.escape(APPLICATION) + r"-[0-9]+", name) and image.startswith(APPLICATION + ":") and not image.startswith(APPLICATION + ":pr-"):
            candidates.append((cid, name, image))
    verified = []
    for cid, name, image in candidates:
        inspect = docker_command(["inspect", "--format", "{{.Name}}\t{{.Config.Image}}\t{{.State.Running}}\t{{index .Config.Labels \"coolify.applicationId\"}}", cid], timeout=15)
        if inspect.returncode:
            raise RuntimeError("docker inspect failed (exit %d); refusing ambiguous selection" % inspect.returncode)
        values = inspect.stdout.strip().split("\t")
        if len(values) == 4 and values == ["/" + name, image, "true", "26"]:
            verified.append(cid)
    if len(verified) != 1:
        raise RuntimeError("expected exactly one verified production gateway container; found %d; refusing extraction" % len(verified))
    return verified[0]


def live():
    container = production_container()
    # Separate stdout/stderr streams are both application log streams in Docker;
    # retain both and never suppress stderr. Bound total output and age.
    result = docker_command(["logs", "--timestamps", "--since", SINCE, "--tail", "10000", container], timeout=45)
    if result.returncode:
        raise RuntimeError("docker logs failed (exit %d); refusing partial extraction" % result.returncode)
    combined = docker_log_lines(result.stdout, result.stderr)
    print(json.dumps(extract(combined), indent=2, sort_keys=True))


class ExtractorTests(unittest.TestCase):
    def test_fixture_pipeline(self):
        one, two = sorted(SUCCESS_IDS)
        fake_secret = "fixture-secret-canary"
        fixture = [
            json.dumps({"trace":"inference","event":"ingress","request_id":one,"method":"POST","path":"/v1/chat/completions","model":"beam-free"}),
            json.dumps({"trace":"inference","event":"attempt_start","request_id":one,"provider":"cline-oauth","upstream_model":"beam-free","attempt_number":1}),
            json.dumps({"trace":"inference","event":"response_finish","request_id":one,"status":200,"stage":"response"}),
            json.dumps({"trace":"inference","event":"ingress","request_id":two,"model":"beam-free"}),
            json.dumps({"trace":"inference","event":"route_plan","request_id":two,"candidate_count":1}),
            json.dumps({"trace":"inference","event":"attempt_start","request_id":two,"provider":"cline-oauth","upstream_model":"beam-free","attempt_number":1}),
            "2026-10-24T13:05:00.000000000Z " + json.dumps({"trace":"inference","event":"cline_upstream_failure","request_id":two,"provider":"cline","status":500,"cline_classification":"cline_upstream_error","cline_error_code":"api_error","cline_content_type":"application_json","request_has_tools":True,"body":fake_secret,"raw_error":fake_secret}),
            json.dumps({"trace":"inference","event":"response_finish","request_id":two,"status":502,"stage":"attempt"}),
            json.dumps({"trace":"inference","event":"attempt_start","request_id":"7f2d9ce1-04c0-4cd4-9db4-b2f84761d1a0","provider":"cline","upstream_model":"cline/free-model","attempt_number":1}),
            json.dumps({"trace":"inference","event":"attempt_failed","request_id":"7f2d9ce1-04c0-4cd4-9db4-b2f84761d1a0","provider":"cline","code":"cline_upstream_unavailable","attempt_number":1}),
            json.dumps({"trace":"inference","event":"attempt_failed","request_id":"not-a-uuid-secret","provider":"cline","code":"cline_upstream_unavailable"}),
            "malformed application line with " + fake_secret,
            "OpenCode free discovery failed: " + fake_secret,
        ]
        # Ensure a valid trace arriving on container stderr is retained too.
        stdout = "\n".join(fixture[:6] + fixture[8:10]) + "\n"
        stderr = "\n".join(fixture[6:8] + fixture[10:]) + "\n"
        out = extract(docker_log_lines(stdout, stderr))
        self.assertEqual(set(out["successes_correlated_by_exact_request_id"]), SUCCESS_IDS)
        self.assertEqual(out["successes_correlated_by_exact_request_id"][one][0]["model"], "beam-free")
        self.assertEqual(out["successes_correlated_by_exact_request_id"][one][1]["provider"], "cline-oauth")
        self.assertEqual(out["successes_correlated_by_exact_request_id"][two][1]["candidate_count"], 1)
        cline_failure = next(record for record in out["successes_correlated_by_exact_request_id"][two]
                             if record["event"] == "cline_upstream_failure")
        self.assertEqual(cline_failure["cline_error_code"], "api_error")
        candidate = out["cline_failure_candidates_not_user_correlated"]["7f2d9ce1-04c0-4cd4-9db4-b2f84761d1a0"]
        self.assertEqual([record["event"] for record in candidate], ["attempt_start", "attempt_failed"])
        self.assertNotIn("not-a-uuid-secret", json.dumps(out))
        self.assertNotIn(fake_secret, json.dumps(out))
        self.assertEqual(out["opencode_free_discovery_failure_count"], 1)


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ExtractorTests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(not result.wasSuccessful())
    if len(sys.argv) != 1:
        raise SystemExit("Usage: python3 -I scripts/admin-extract-gateway-traces.py [--self-test]")
    try:
        live()
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        # Do not reveal raw Docker errors: they may include private host details.
        print("gateway trace extraction refused: " + str(error), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
