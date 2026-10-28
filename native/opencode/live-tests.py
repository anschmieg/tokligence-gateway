#!/usr/bin/env python3
"""Run bounded live tests on the staging VPS after the configured quota reset."""
import argparse, datetime, json, os, pathlib, subprocess, tempfile, urllib.request, urllib.error, uuid, sys, signal
from live_safety import LiveGuard, ProbeStopped, claude_relay, gateway_url, open_gateway

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', default='/home/agent/tokligence-staging')
parser.add_argument('--url', default='http://127.0.0.1:4190')
parser.add_argument('--request-timeout', type=float, default=690)
parser.add_argument('--not-before', required=True, help='Explicit earliest authorized comparison time, including timezone')
parser.add_argument('--run-id', required=True, help='Unique diagnostic identity; never replayed after reservation')
parser.add_argument('--models', default='glm-5.3-flash-free')
parser.add_argument('--phases', default='basic')
parser.add_argument('--request-budget', type=int, default=1)
parser.add_argument('--output-budget', type=int, default=1024)
args = parser.parse_args()
args.url = gateway_url(args.url)
if datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(args.not_before):
    raise SystemExit('Refusing live traffic before the configured post-reset time')
root = pathlib.Path(args.root)
config = json.loads((root / 'gateway-env.json').read_text())
all_models = ['beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free']
models = args.models.split(',')
phases = args.phases.split(',')
if not models or len(set(models)) != len(models) or any(model not in all_models for model in models):
    parser.error('Select unique, explicitly allowed free models')
if not phases or len(set(phases)) != len(phases) or any(phase not in ['basic', 'tools', 'long', 'claude'] for phase in phases):
    parser.error('Select unique supported phases')
guard = LiveGuard(root, args.run_id, args.request_budget, args.output_budget)
try:
    guard.__enter__()
except (ProbeStopped, BlockingIOError):
    print(json.dumps({'status': 'not_started', 'coverage_incomplete': True, 'reason': 'Active owner, recorded cooldown or previously reserved run ID'}))
    raise SystemExit(2)
results = []

def request(model, messages, scope, **options):
    body = dict(model='opencode-native/' + model, messages=messages, **{'max_tokens': 1024, **options})
    guard.reserve(body['max_tokens'])
    headers = {'Authorization': 'Bearer sk-ant-' + config['TOKLIGENCE_AUTH_SECRET'], 'Content-Type': 'application/json', 'x-session-id': scope}
    req = urllib.request.Request(args.url + '/v1/chat/completions', data=json.dumps(body).encode(), headers=headers)
    try:
        with open_gateway(req, timeout=args.request_timeout) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        try: failure = json.load(error).get('error', {})
        except (ValueError, AttributeError): failure = {}
        if not isinstance(failure, dict): failure = {}
        results.append({'model': model, 'status': error.code, 'code': failure.get('code'), 'reset': failure.get('retry_at'), 'provider_request_id': failure.get('upstream_request_id')})
        guard.stop('Upstream rejected the probe; no further account traffic', error.code, failure)
    except (OSError, urllib.error.URLError):
        guard.stop('Probe transport failed; no further account traffic')

def record(model, name, action):
    print(json.dumps({"model": model, "test": name, "phase": "started"}), flush=True)
    try:
        results.append({'model': model, 'test': name, 'passed': True, **(action() or {})})
    except ProbeStopped:
        results.append({'model': model, 'test': name, 'passed': None, 'status': 'blocked', 'reason': guard.blocked})
        raise
    except Exception as error:
        results.append({'model': model, 'test': name, 'passed': False, 'error_type': type(error).__name__, 'check': str(error)[:200] if isinstance(error, AssertionError) else None})

scopes = {}
def matrix(model, phase):
    scope = scopes.setdefault(model, 'live-matrix-' + uuid.uuid4().hex)
    def basic():
        result = request(model, [{'role': 'user', 'content': 'Reply exactly STAGING_OK.'}], scope)
        assert result['choices'][0]['finish_reason'] == 'stop', 'basic response did not finish successfully'
        assert 'STAGING_OK' in (result['choices'][0]['message'].get('content') or ''), 'basic text marker missing'
    if phase == 'basic': record(model, 'basic', basic)
    def long():
        context = '\n'.join('Fixture record %d: token_%d has value %d.' % (i, i, i * 3) for i in range(3000))
        prompt = context + '\nGive the value of token_2999. Then write at least 1800 words explaining how to validate these records. Finish with LONG_DONE.'
        result = request(model, [{'role': 'user', 'content': prompt}], scope, max_tokens=8192)
        choice = result['choices'][0]; text = choice['message'].get('content') or ''
        assert '8997' in text, 'long context retrieval failed'
        assert len(text) >= 6000, 'response too short for the long-output check'
        assert 'LONG_DONE' in text and choice['finish_reason'] == 'stop', 'long output incomplete'
        return {'input_characters': len(prompt), 'output_characters': len(text)}
    if phase == 'long': record(model, 'long-input-output', long)
    reasoning_check = {'model': model, 'test': 'reasoning-replay', 'passed': None, 'status': 'untested', 'reason': 'No reasoning-bearing continuation completed'}
    if phase == 'tools': results.append(reasoning_check)
    def tools():
        tool = {'type': 'function', 'function': {'name': 'fixture_lookup', 'description': 'Return a named synthetic fixture value.', 'parameters': {'type': 'object', 'properties': {'key': {'type': 'string', 'enum': ['alpha', 'beta']}}, 'required': ['key']}}}
        messages = [{'role': 'user', 'content': 'Call fixture_lookup for alpha and beta in parallel. After both results arrive, report their sum.'}]
        first = request(model, messages, scope, tools=[tool], tool_choice='required', parallel_tool_calls=True)
        assistant = first['choices'][0]['message']; calls = assistant.get('tool_calls', [])
        assert len(calls) >= 2, 'parallel tool calls were not produced'
        messages.append(assistant)
        keys = set()
        for call in calls:
            assert call['function']['name'] == 'fixture_lookup', 'unexpected caller tool'
            key = json.loads(call['function']['arguments'])['key']
            assert key in ('alpha', 'beta'), 'unexpected synthetic fixture key'
            keys.add(key)
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps({'value': {'alpha': 17, 'beta': 25}[key]})})
        assert keys == {'alpha', 'beta'}, 'both requested tools must be called'
        final = request(model, messages, scope, tools=[tool], tool_choice='none')
        assert final['choices'][0]['finish_reason'] == 'stop', 'tool result continuation did not finish successfully'
        assert '42' in (final['choices'][0]['message'].get('content') or ''), 'tool result continuation failed'
        reasoning = assistant.get('reasoning_content') or assistant.get('reasoning')
        if isinstance(reasoning, str) and reasoning.strip():
            reasoning_check.update(passed=True, status='passed', reason='Reasoning-bearing assistant turn replayed in a successful continuation')
        else:
            reasoning_check['reason'] = 'Model returned no textual reasoning; tool continuation alone does not verify reasoning replay'
        return {'tool_calls': len(calls)}
    if phase == 'tools': record(model, 'parallel-tools', tools)
    def claude():
        with tempfile.TemporaryDirectory(prefix='live-claude-', dir=root) as state:
            fixture = pathlib.Path(state) / 'fixture.txt'
            fixture.write_text('Marker: CLAUDE_TOOL_OK.\n' + 'Synthetic fixture context.\n' * 1000)
            authorization = 'Bearer sk-ant-' + config['TOKLIGENCE_AUTH_SECRET']
            env = {'PATH': str(root / 'runtime') + ':/usr/bin:/bin', 'HOME': state, 'CLAUDE_CONFIG_DIR': state, 'ANTHROPIC_AUTH_TOKEN': 'sk-ant-' + config['TOKLIGENCE_AUTH_SECRET'], 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS': '8192', 'MAX_THINKING_TOKENS': '2048'}
            prompt = 'Use Read to read %s. Quote its marker, then write at least 1500 words about validating the fixture. Finish with CLAUDE_LONG_DONE.' % fixture
            before = guard.count
            with claude_relay(guard, args.url, model, authorization, args.request_timeout) as relay:
                env['ANTHROPIC_BASE_URL'] = relay
                argv = [str(root / 'runtime/claude'), '-p', prompt, '--model', 'opencode-native/' + model, '--tools', 'Read', '--allowedTools', 'Read(/%s)' % fixture, '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '5', '--output-format', 'json', '--setting-sources', '']
                child = subprocess.Popen(argv, env=env, cwd=state, text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    stdout, stderr = child.communicate(timeout=900)
                    run = subprocess.CompletedProcess(argv, child.returncode, stdout, stderr)
                finally:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    child.wait()
            if guard.blocked:
                if guard.status:
                    results.append({'model': model, 'phase': 'claude', 'status': guard.status})
                raise ProbeStopped(guard.blocked)
            result = json.loads(run.stdout)
            if result.get('api_error_status') == 429:
                results.append({'model': model, 'phase': 'claude', 'status': 429})
                guard.stop('CLI reported an upstream quota response', 429)
            assert run.returncode == 0 and not result.get('is_error'), 'Claude Code returned an API/agent error'
            text = result.get('result', '')
            assert 'CLAUDE_TOOL_OK' in text and 'CLAUDE_LONG_DONE' in text, 'Claude marker or final delimiter missing'
            assert result.get('num_turns', 0) >= 2, 'Claude did not complete a tool continuation'
            assert guard.count - before >= 2, 'Claude did not make an observed inference continuation'
            assert len(text) >= 5000, 'Claude output too short'
            return {'turns': result.get('num_turns'), 'output_characters': len(text)}
    if phase == 'claude': record(model, 'claude-code-read-and-long-output', claude)

try:
    # Verify short cases for every model before spending quota on long outputs.
    for phase in phases:
        for model in models: matrix(model, phase)
except ProbeStopped:
    results.append({'status': 'stopped', 'reason': guard.blocked})
finally:
    # Early quota stops must account for every check that never ran, including
    # reasoning checks whose phase was never reached.
    recorded = {(item.get('model'), item.get('test')) for item in results}
    for model in all_models:
        for name in ['basic', 'parallel-tools', 'reasoning-replay', 'long-input-output', 'claude-code-read-and-long-output']:
            if (model, name) not in recorded:
                results.append({'model': model, 'test': name, 'passed': None, 'status': 'untested', 'reason': 'Matrix stopped before this check ran'})
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'run_id': args.run_id, 'requests': guard.count, 'reserved_output_tokens': guard.output_count, 'coverage_incomplete': any(item.get('status') in ('untested', 'blocked') for item in results), 'results': results}
    try:
        reports = root / 'live-reports'
        reports.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(reports / (args.run_id + '.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output: json.dump(report, output, indent=2)
        print(json.dumps(report))
    finally:
        guard.__exit__(*sys.exc_info())
raise SystemExit(1 if any(item.get('passed') is False or isinstance(item.get('status'), int) and item['status'] >= 400 for item in results) else 2 if report['coverage_incomplete'] else 0)
