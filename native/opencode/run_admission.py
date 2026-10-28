"""Offline admission only: inspect pinned plan/evidence; never sends inference."""
import datetime
import hashlib
import json
import pathlib
from live_safety import ProbeStopped, parse_time, utc_now

GATES = {'native_identity', 'official_lifecycle', 'outbound_attempts', 'session_comparison'}
REQUIRED_ARTIFACTS = {
    'tgw-proxy.mjs', 'native-session-identity.mjs', 'provider-adapters.mjs',
    'request-executor.mjs', 'routing-planner.mjs',
    'native/opencode/official-public-probe.py', 'native/opencode/official_control.py',
    'native/opencode/live_safety.py', 'native/opencode/run_admission.py',
    'native/opencode/public-bun-transport.mjs', 'native/opencode/official-models.json',
}



def inspect_plan(path, code_root, run_id, model, not_before):
    plan = json.loads(pathlib.Path(path).read_text())
    blockers = []
    threshold = parse_time(not_before)
    earliest = parse_time(plan.get('not_before'))
    if not earliest or not threshold or threshold < earliest:
        blockers.append('not_before_does_not_match_plan')
    if not earliest or utc_now() < earliest:
        blockers.append('comparison_time_not_reached')
    if plan.get('run_id') != run_id or plan.get('model') != model:
        blockers.append('unselected_run_or_model')
    window = plan.get('window', {})
    if window.get('request_budget') != 1 or window.get('output_budget') != 1024 or window.get('allowed_runs') != [run_id]:
        blockers.append('invalid_single_request_window')
    if set(plan.get('gates', {})) != GATES:
        blockers.append('missing_required_gates')
    for name, gate in plan.get('gates', {}).items():
        if not isinstance(gate, dict) or gate.get('status') != 'passed':
            blockers.append('gate_incomplete:' + name)
    code_root = pathlib.Path(code_root).resolve()
    hashes = plan.get('sha256', {})
    if not REQUIRED_ARTIFACTS.issubset(hashes):
        blockers.append('missing_artifact_hashes')
    for relative, digest in hashes.items():
        source = (code_root / relative).resolve()
        if not source.is_relative_to(code_root) or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            blockers.append('artifact_mismatch:' + relative)
    for name, gate in plan.get('gates', {}).items():
        if not isinstance(gate, dict) or gate.get('status') != 'passed': continue
        evidence = gate.get('evidence')
        if not isinstance(evidence, str) or evidence not in hashes:
            blockers.append('unbound_evidence:' + name)
            continue
        try:
            record = json.loads((code_root / evidence).read_text())
            if record.get('gates', {}).get(name, {}).get('passed') is not True:
                blockers.append('evidence_not_passed:' + name)
        except (OSError, ValueError, AttributeError):
            blockers.append('evidence_unreadable:' + name)

    return plan, blockers


def require_plan(path, code_root, run_id, model, not_before):
    plan, blockers = inspect_plan(path, code_root, run_id, model, not_before)
    if blockers:
        raise ProbeStopped('Live admission refused: ' + ','.join(blockers))
    return plan


def inspect_ledger(root, run_id):
    """Read-only cooldown/replay/owner check. The real guard rechecks under lock."""
    import fcntl
    blockers = []
    root = pathlib.Path(root)
    try:
        with (root / 'live-probe.lock').open('r') as lease:
            try: fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: blockers.append('another_live_owner_active')
    except FileNotFoundError:
        blockers.append('live_ledger_lock_missing')
    try:
        ledger = json.loads((root / 'live-probe-ledger.json').read_text())
        cooldown = parse_time(ledger.get('cooldown_until'))
        if cooldown and cooldown > utc_now(): blockers.append('provider_cooldown_active')
        if run_id in ledger.get('runs', {}): blockers.append('run_id_already_reserved')
    except (OSError, ValueError, TypeError): blockers.append('live_ledger_unavailable')
    return blockers


def inspect_worker(root, expected_overlay):
    import fcntl
    from live_safety import open_gateway
    blockers = []
    root = pathlib.Path(root)
    try:
        with open_gateway('http://127.0.0.1:4187/health', timeout=2) as response:
            health = json.load(response)
        if (health.get('version') != '2.1.4' or health.get('fixture') is not False
                or not expected_overlay or health.get('overlay') != expected_overlay):
            blockers.append('worker_overlay_or_mode_mismatch')
    except (OSError, ValueError): blockers.append('worker_health_unavailable')
    try:
        if (root / 'state/native-auth-mode').read_text().strip() != 'oauth':
            blockers.append('default_oauth_owner_not_restored')
        with (root / 'state/worker.lock').open('r') as lease:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                blockers.append('worker_exclusive_lock_not_held')
            except BlockingIOError: pass
    except OSError: blockers.append('worker_state_ownership_unverified')
    return blockers
