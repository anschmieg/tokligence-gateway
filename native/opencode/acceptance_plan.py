"""Single-case live admission and cancellable, ledger-backed inference pacing."""
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import threading
import time
from live_safety import LiveGuard, ProbeStopped, parse_time, utc_now
from run_admission import inspect_ledger

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_oauth_admission', HERE / 'oauth-comparison.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
STAGING_ROOT = pathlib.Path('/home/agent/tokligence-staging')
MODELS = {'beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free'}
BUDGETS = {'basic': (1, 1024), 'tools': (2, 2048), 'long': (1, 8192), 'claude': (4, 32768)}


class CaseNotAdmitted(ProbeStopped):
    def __init__(self, blockers):
        super().__init__('Native acceptance case not admitted')
        self.blockers = blockers


def inspect_case(plan, root, args, lease_held=False):
    blockers = []
    phase = plan.get('phase')
    if (root.resolve() != STAGING_ROOT
            or plan.get('kind') != 'native-acceptance-case-v1' or plan.get('status') != 'prepared'
            or plan.get('authentication') != 'oauth' or plan.get('version') != '2.1.4'
            or plan.get('staging_root') != str(root.resolve()) or plan.get('run_id') != args.run_id
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', args.run_id)
            or args.url != 'http://127.0.0.1:4190' or not isinstance(phase, str) or phase not in BUDGETS
            or not isinstance(plan.get('model'), str) or plan.get('model') not in MODELS or args.models != plan.get('model') or args.phases != phase):
        blockers.append('single_case_contract_mismatch')
    budget = BUDGETS.get(phase) if isinstance(phase, str) else None
    if budget != (args.request_budget, args.output_budget): blockers.append('case_budget_mismatch')
    threshold = parse_time(plan.get('not_before'))
    if not threshold or utc_now() < threshold or args.not_before != plan.get('not_before'):
        blockers.append('case_not_eligible')
    xdg = plan.get('effective_xdg')
    if not isinstance(xdg, dict) or set(xdg) != {'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'}:
        blockers.append('case_runtime_paths_unbound')
    gap = plan.get('minimum_gap_seconds')
    if type(gap) is not int or not 120 <= gap <= 600: blockers.append('case_pacing_missing')
    window = plan.get('window')
    window_valid = not (budget is None or not isinstance(window, dict) or set(window) != {'id', 'request_budget', 'output_budget', 'allowed_runs'}
            or not isinstance(window.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', window['id'])
            or type(window.get('request_budget')) is not int or type(window.get('output_budget')) is not int
            or window.get('allowed_runs') != [args.run_id]
            or (window.get('request_budget'), window.get('output_budget')) != budget)
    if not window_valid: blockers.append('case_window_mismatch')
    # A synthetic fixture, token count, rejected CLI, or startup-only pass cannot
    # authorize live tools/long/Claude work. The successful foundation must bind
    # the same existing staging credential and complete native source overlay.
    try:
        proof = plan['foundation']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', proof['run_id']): raise ValueError()
        report_file = root / 'live-reports' / (proof['run_id'] + '.json')
        report = json.loads(report_file.read_text())
        entry = json.loads((root / 'live-probe-ledger.json').read_text()).get('runs', {}).get(proof['run_id'], {})
        foundation_file = HERE / proof['plan_file']
        if pathlib.Path(proof['plan_file']).name != proof['plan_file']: raise ValueError()
        foundation_plan = json.loads(foundation_file.read_text())
        if (native.sha(report_file) != proof['report_sha256'] or native.sha(foundation_file) != proof['plan_sha256']
                or report.get('plan_sha256') != proof['plan_sha256'] or report.get('run_id') != proof['run_id']
                or foundation_plan.get('run_id') != proof['run_id'] or foundation_plan.get('phase') != 'comparison'
                or foundation_plan.get('kind') != 'native-oauth-comparison-v1'
                or foundation_plan.get('staging_root') != str(root.resolve())
                or report.get('staging_root') != str(root.resolve())
                or report.get('startup_only') is not False or report.get('startup_passed') is not True
                or report.get('reference_passed') is not True or report.get('gateway_passed') is not True
                or report.get('requests') != 2 or report.get('reason') or report.get('error_type')
                or report.get('upstream_status') is not None
                or foundation_plan.get('credential_id_sha256') != plan.get('credential_id_sha256')
                or foundation_plan.get('overlay_sha256') != plan.get('overlay_sha256')
                or foundation_plan.get('authentication') != 'oauth'
                or entry.get('status') != 'finished' or entry.get('requests') != 2
                or entry.get('reserved_output_tokens') != 2048
                or entry.get('window_id') != foundation_plan.get('window', {}).get('id')
                or any(foundation_plan.get(key) != plan.get(key) for key in ['gateway_sha256', 'source_sha256', 'cli_tree_sha256', 'bun_sha256', 'node_sha256', 'effective_xdg'])):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError, AttributeError): blockers.append('successful_same_owner_foundation_missing')
    if not lease_held: blockers.extend(inspect_ledger(root, args.run_id, window if window_valid else None))
    # Avoid additional runtime/account discovery when prerequisites already fail.
    if not blockers:
        blockers.extend(native.inspect_runtime_binding(plan, root))
        control = native.load_staging_control()
        try: control.verify_staging(root)
        except control.StagingRestoreError: blockers.append('staging_health_or_ownership_failed')
        try: os.lstat('/data/tokligence/zen/secondary-oauth.json'); blockers.append('production_secondary_path_present')
        except FileNotFoundError: pass
        except OSError: blockers.append('production_secondary_absence_unverified')
    return list(dict.fromkeys(blockers))


def admit_case(args, root):
    try:
        raw = pathlib.Path(args.plan).read_bytes()
        plan = json.loads(raw)
    except (OSError, ValueError): raise CaseNotAdmitted(['case_plan_unavailable'])
    if not isinstance(plan, dict): raise CaseNotAdmitted(['case_plan_invalid'])
    try: blockers = inspect_case(plan, root, args)
    except (OSError, ValueError, KeyError, TypeError, AttributeError): raise CaseNotAdmitted(['case_admission_unverifiable'])
    if blockers: raise CaseNotAdmitted(blockers)
    return {'window': plan['window'], 'minimum_gap_seconds': plan['minimum_gap_seconds'],
            'plan_sha256': hashlib.sha256(raw).hexdigest(), 'plan': plan}


def recheck_case(case, args, root):
    # Called only after PacedGuard owns the live lease and reserved the run ID.
    # Recheck immutable inputs without treating our own lease/ID as a conflict.
    try:
        if native.sha(args.plan) != case['plan_sha256']: raise CaseNotAdmitted(['case_plan_changed'])
        blockers = inspect_case(case['plan'], root, args, lease_held=True)
    except (OSError, ValueError, TypeError, KeyError, AttributeError): raise CaseNotAdmitted(['case_binding_unverifiable'])
    if blockers: raise CaseNotAdmitted(blockers)


class PacedGuard(LiveGuard):
    def __init__(self, *args, minimum_gap_seconds=120, **kwargs):
        super().__init__(*args, **kwargs)
        if type(minimum_gap_seconds) not in (int, float) or not 0 <= minimum_gap_seconds <= 600:
            raise ValueError('Invalid pacing interval')
        self.gap = minimum_gap_seconds
        self.condition = threading.Condition(self.mutex)
        self.next_at = 0

    def __enter__(self):
        super().__enter__()
        try:
            prior = [parse_time(entry.get('last_dispatch_reserved_at') or entry.get('finished'))
                     for entry in self.ledger['runs'].values() if entry.get('requests', 0)]
            prior = [value for value in prior if value]
            remaining = max(0, ((max(prior) + datetime.timedelta(seconds=self.gap)) - utc_now()).total_seconds()) if prior else 0
            if remaining > 600: self.stop('Future reservation timestamp requires investigation')
            self.next_at = time.monotonic() + remaining
            return self
        except BaseException:
            self.lock.close()
            raise

    def reserve(self, max_tokens, cancelled=None):
        with self.condition:
            while not self.blocked and time.monotonic() < self.next_at:
                if cancelled and cancelled(): self.stop('CLI client disconnected; no further traffic')
                remaining = self.next_at - time.monotonic()
                self.condition.wait(min(.025, remaining) if cancelled else remaining)
            super().reserve(max_tokens, cancelled=cancelled)
            self.next_at = time.monotonic() + self.gap
            self.entry['last_dispatch_reserved_at'] = utc_now().isoformat()
            self._save()

    def stop(self, *args, **kwargs):
        try: return super().stop(*args, **kwargs)
        finally:
            with self.condition: self.condition.notify_all()
