#!/usr/bin/env python3
"""Run bounded live tests on the staging VPS after the configured quota reset."""
import argparse, datetime, json, os, pathlib, subprocess, tempfile, urllib.request, urllib.error, uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', default='/home/agent/tokligence-staging')
parser.add_argument('--url', default='http://127.0.0.1:4190')
parser.add_argument('--request-timeout', type=float, default=690)
parser.add_argument('--not-before', default='2026-10-27T00:05:00+00:00')
args = parser.parse_args()
if datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(args.not_before):
    raise SystemExit('Refusing live traffic before the configured post-reset time')
root = pathlib.Path(args.root)
config = json.loads((root / 'gateway-env.json').read_text())
models = ['beam-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free']
results = []
class Quota(Exception): pass

def request(model, messages, scope, **options):
    body = dict(model='opencode-native/' + model, messages=messages, max_tokens=8192, **options)
    headers = {'Authorization': 'Bearer sk-ant-' + config['TOKLIGENCE_AUTH_SECRET'], 'Content-Type': 'application/json', 'x-session-id': scope}
    req = urllib.request.Request(args.url + '/v1/chat/completions', data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=args.request_timeout) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        try: failure = json.load(error).get('error', {})
        except (ValueError, AttributeError): failure = {}
        if error.code == 429:
            results.append({'model': model, 'status': 429, 'code': failure.get('code'), 'reset': failure.get('retry_at'), 'provider_request_id': failure.get('upstream_request_id')})
            raise Quota()
        raise RuntimeError('HTTP %s: %s' % (error.code, failure.get('code', 'invalid_error_response')))

def record(model, name, action):
    print(json.dumps({"model": model, "test": name, "phase": "started"}), flush=True)
    try:
        results.append({'model': model, 'test': name, 'passed': True, **(action() or {})})
    except Quota: raise
    except Exception as error:
        results.append({'model': model, 'test': name, 'passed': False, 'error_type': type(error).__name__, 'check': str(error)[:200] if isinstance(error, AssertionError) else None})

scopes = {}
def matrix(model, phase):
    scope = scopes.setdefault(model, 'live-matrix-' + uuid.uuid4().hex)
    def basic():
        result = request(model, [{'role': 'user', 'content': 'Reply exactly STAGING_OK.'}], scope)
        assert 'STAGING_OK' in (result['choices'][0]['message'].get('content') or ''), 'basic text marker missing'
    if phase == 'basic': record(model, 'basic', basic)
    def long():
        context = '\n'.join('Fixture record %d: token_%d has value %d.' % (i, i, i * 3) for i in range(3000))
        prompt = context + '\nGive the value of token_2999. Then write at least 1800 words explaining how to validate these records. Finish with LONG_DONE.'
        result = request(model, [{'role': 'user', 'content': prompt}], scope)
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
            env = {'PATH': str(root / 'runtime') + ':/usr/bin:/bin', 'HOME': state, 'CLAUDE_CONFIG_DIR': state, 'ANTHROPIC_BASE_URL': args.url, 'ANTHROPIC_AUTH_TOKEN': 'sk-ant-' + config['TOKLIGENCE_AUTH_SECRET'], 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1'}
            prompt = 'Use Read to read %s. Quote its marker, then write at least 1500 words about validating the fixture. Finish with CLAUDE_LONG_DONE.' % fixture
            run = subprocess.run([str(root / 'runtime/claude'), '-p', prompt, '--model', 'opencode-native/' + model, '--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '5', '--output-format', 'json', '--setting-sources', ''], env=env, cwd=state, text=True, capture_output=True, timeout=900)
            result = json.loads(run.stdout)
            if result.get('api_error_status') == 429:
                results.append({'model': model, 'test': 'claude-code', 'status': 429}); raise Quota()
            assert run.returncode == 0 and not result.get('is_error'), 'Claude Code returned an API/agent error'
            text = result.get('result', '')
            assert 'CLAUDE_TOOL_OK' in text and 'CLAUDE_LONG_DONE' in text, 'Claude marker or final delimiter missing'
            assert result.get('num_turns', 0) >= 2, 'Claude did not complete a tool continuation'
            assert len(text) >= 5000, 'Claude output too short'
            return {'turns': result.get('num_turns'), 'output_characters': len(text)}
    if phase == 'claude': record(model, 'claude-code-read-and-long-output', claude)

try:
    # Verify short cases for every model before spending quota on long outputs.
    for phase in ['basic', 'tools', 'long', 'claude']:
        for model in models: matrix(model, phase)
except Quota:
    results.append({'status': 'stopped', 'reason': 'Fresh upstream quota response; no further account traffic'})
finally:
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'coverage_incomplete': any(item.get('status') == 'untested' for item in results), 'results': results}
    fd = os.open(root / 'live-matrix-results.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(report, output, indent=2)
    print(json.dumps(report))
raise SystemExit(1 if any(item.get('passed') is False or item.get('status') == 429 for item in results) else 2 if report['coverage_incomplete'] else 0)
