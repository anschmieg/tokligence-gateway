"""Offline admission only: inspect pinned plan/evidence; never sends inference."""
import hashlib
import json
import pathlib
from live_safety import ProbeStopped, parse_time, utc_now, recorded_cooldowns

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
    if not earliest or utc_now() < max(value for value in [earliest, threshold] if value):
        blockers.append('comparison_time_not_reached')
    if plan.get('run_id') != run_id or plan.get('model') != model:
        blockers.append('unselected_run_or_model')
    window = plan.get('window', {})
    if type(window.get('request_budget')) is not int or window.get('request_budget') != 1 or type(window.get('output_budget')) is not int or window.get('output_budget') != 1024 or window.get('allowed_runs') != [run_id]:
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
        if (not isinstance(evidence, str) or evidence not in hashes
                or not (code_root / evidence).resolve().is_relative_to(code_root)):
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


def inspect_ledger(root, run_id, window=None):
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
        if recorded_cooldowns(root, ledger): blockers.append('provider_cooldown_active')
        if run_id in ledger.get('runs', {}): blockers.append('run_id_already_reserved')
        if window:
            previous = ledger.get('windows', {}).get(window['id'])
            if previous is not None and previous != window:
                blockers.append('live_window_limits_changed')
            entries = [entry for entry in ledger.get('runs', {}).values() if entry.get('window_id') == window['id']]
            if (sum(entry.get('requests', 0) for entry in entries) >= window['request_budget']
                    or sum(entry.get('reserved_output_tokens', 0) for entry in entries) + 1024 > window['output_budget']):
                blockers.append('live_window_budget_exhausted')
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


def file_sha256(path):
    result = hashlib.sha256()
    with pathlib.Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def inspect_runtime(plan, root, code_root, binary, bun_binary, pause_staging):
    """Bind live admission to the reviewed state and exact executables."""
    blockers = []
    root = pathlib.Path(root).resolve()
    if str(root) != plan.get('staging_root') or pathlib.Path(code_root).resolve() != root / 'gateway':
        blockers.append('staging_root_or_code_binding_mismatch')
    if not pause_staging:
        blockers.append('owned_staging_pause_required')
    runtime = plan.get('runtime', {})
    expected = {'cli': root / 'runtime/opencode-public-cli-1.18.32', 'bun': root / 'runtime/bun'}
    for name, supplied in [('cli', binary or expected['cli']), ('bun', bun_binary)]:
        record = runtime.get(name, {})
        try:
            actual = pathlib.Path(supplied).resolve(strict=True) if supplied else None
            if (actual != expected[name].resolve(strict=True) or record.get('path') != str(expected[name])
                    or not isinstance(record.get('sha256'), str) or file_sha256(actual) != record['sha256']):
                blockers.append('runtime_binding_mismatch:' + name)
        except (OSError, TypeError, ValueError):
            blockers.append('runtime_binding_mismatch:' + name)
    return blockers
