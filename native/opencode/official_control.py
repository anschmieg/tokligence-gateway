"""Public-only official CLI control. No OAuth credentials or live model discovery."""
import contextlib
import base64
import datetime
import email.utils
import http.server
import http.client
import json
import os
import pathlib
import re
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request

from live_safety import NoRedirect, ProbeStopped, parse_time, utc_now

ENDPOINT = 'https://opencode.ai/inference/openai/v1'
CATALOG = pathlib.Path(__file__).with_name('official-models.json')
open_public = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open


def profile_environment(home, relay, model, max_tokens=1024):
    """Same profile recipe used by the network-blocked official CLI regression."""
    catalog = json.loads(CATALOG.read_text())
    info = catalog['opencode']['models'].get(model)
    if not info or info['cost']['input'] != 0 or info['cost']['output'] != 0:
        raise ValueError('Select an explicitly zero-cost public model')
    if not isinstance(max_tokens, int) or not 1 <= max_tokens <= 1024:
        raise ValueError('Official control output limit must be within1024')
    home = pathlib.Path(home)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Keep the original catalog metadata; only the requested output budget is reduced.
    catalog_path = home / 'models.json'
    catalog_path.write_text(json.dumps(catalog))
    config = {'formatter': False, 'lsp': False, 'permission': 'deny', 'share': 'disabled',
              'provider': {'opencode': {'options': {'baseURL': relay},
                                       'models': {model: {'limit': {'context': info['limit']['context'], 'output': max_tokens}}}}}}
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'OPENCODE_TEST_HOME': str(home),
           'OPENCODE_CONFIG_CONTENT': json.dumps(config), 'OPENCODE_AUTH_CONTENT': '{}',
           'OPENCODE_MODELS_PATH': str(catalog_path), 'OPENCODE_DISABLE_PROJECT_CONFIG': '1',
           'OPENCODE_PURE': '1', 'OPENCODE_DISABLE_AUTOUPDATE': '1',
           'OPENCODE_DISABLE_AUTOCOMPACT': '1', 'OPENCODE_DISABLE_MODELS_FETCH': '1',
           'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER': '1', 'OPENCODE_DISABLE_FFF': '1',
           'DO_NOT_TRACK': '1'}
    for key in ['CONFIG', 'DATA', 'STATE', 'CACHE']:
        env['XDG_' + key + '_HOME'] = str(home / key.lower())
    return env


def public_failure(raw, headers):
    """Extract bounded diagnostics, never raw provider messages or arbitrary fields."""
    try:
        failure = json.loads(raw).get('error', {})
    except (ValueError, AttributeError):
        failure = {}
    if not isinstance(failure, dict):
        failure = {}
    known = {'FreeUsageLimitError', 'RateLimitError', 'GoUsageLimitError', 'AuthError', 'ModelError',
             'CreditsError', 'MonthlyLimitError', 'RegionError', 'DataPolicyError',
             'rate_limit_error', 'invalid_request_error', 'authentication_error'}
    candidate = failure.get('type') or failure.get('code')
    out = {'code': candidate if isinstance(candidate, str) and candidate in known else 'upstream_http_error'}
    reset = parse_time(failure.get('retry_at'))
    retry = headers.get('retry-after')
    if retry:
        try:
            if re.fullmatch(r'[0-9]{1,8}', retry):
                reset = utc_now() + datetime.timedelta(seconds=int(retry))
            else:
                reset = email.utils.parsedate_to_datetime(retry)
        except (ValueError, TypeError, OverflowError):
            pass
    if reset and reset.tzinfo and reset > utc_now():
        out['retry_at'] = reset.isoformat()
    request_id = headers.get('x-opencode-log-id') or headers.get('x-request-id')
    if isinstance(request_id, str) and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', request_id):
        out['upstream_request_id'] = request_id
    return out


def control_endpoint(fixture_upstream=None):
    if fixture_upstream is None:
        return ENDPOINT
    parsed = urllib.parse.urlsplit(fixture_upstream)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path.rstrip('/') != '/v1':
        raise ValueError('Synthetic upstream must be loopback HTTP /v1')
    return fixture_upstream.rstrip('/')


@contextlib.contextmanager
def official_relay(guard, model, fixture_upstream=None, timeout=60, bun_binary=None):
    target = control_endpoint(fixture_upstream)
    if model not in json.loads(CATALOG.read_text())['opencode']['models']:
        raise ValueError('Unknown free control model')

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def reply(self, status, raw):
            self.send_response(status)
            self.send_header('Content-Type', 'text/event-stream' if status == 200 else 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            try:
                if self.path != '/v1/chat/completions' or self.headers.get('authorization') != 'Bearer public':
                    raise ValueError('Official control requires public Chat Completions')
                length = int(self.headers.get('content-length', '0'))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError('Invalid control body length')
                raw = self.rfile.read(length)
                body = json.loads(raw)
                if not isinstance(body, dict) or body.get('model') != model or body.get('stream') is not True or body.get('tools'):
                    raise ValueError('Unexpected official control payload')
                tokens = body.get('max_tokens')
                if not isinstance(tokens, int) or isinstance(tokens, bool) or not 1 <= tokens <= 1024 or 'max_completion_tokens' in body:
                    raise ValueError('Official output limit was not preserved')
                headers = {'Authorization': 'Bearer public', 'Content-Type': 'application/json'}
                for key in ['user-agent', 'x-opencode-client', 'x-opencode-project', 'x-opencode-request', 'x-opencode-session']:
                    if value := self.headers.get(key):
                        headers[key] = value
                with guard.forward_lock:
                    guard.reserve(tokens)
                    with guard.mutex:
                        if guard.blocked:
                            raise ProbeStopped(guard.blocked)
                        guard.entry['request_metadata'] = {'header_names': sorted(headers),
                            'user_agent': headers.get('user-agent'), 'model': model,
                            'max_tokens': tokens, 'stream': True}
                        guard._save()
                    if bun_binary:
                        payload = {'url': target + '/chat/completions', 'headers': headers,
                                   'body': base64.b64encode(raw).decode(), 'timeout': timeout,
                                   'fixture': fixture_upstream is not None}
                        child = subprocess.run([str(bun_binary), str(pathlib.Path(__file__).with_name('public-bun-transport.mjs'))],
                            input=json.dumps(payload), capture_output=True, text=True, timeout=timeout + 5,
                            env={'PATH': '/usr/bin:/bin'})
                        if child.returncode:
                            raise ValueError('Bun transport failed; private child diagnostics withheld')
                        reply = json.loads(child.stdout)
                        status, data = reply['status'], base64.b64decode(reply['body'], validate=True)
                        failure = public_failure(data, reply['headers']) if status >= 300 else None
                    else:
                        request = urllib.request.Request(target + '/chat/completions', data=raw, headers=headers)
                        try:
                            response = open_public(request, timeout=timeout)
                        except urllib.error.HTTPError as error:
                            response = error
                        with response:
                            status = response.status
                            try:
                                data = response.read(16 * 1024 if status >= 300 else 2 * 1024 * 1024 + 1)
                            except (OSError, urllib.error.URLError, http.client.HTTPException):
                                if status < 300:
                                    raise
                                data = b''
                            failure = public_failure(data, response.headers) if status >= 300 else None
                    if len(data) > 2 * 1024 * 1024:
                        raise ValueError('Control response exceeded limit')
                    if failure:
                        guard.stop('Official public control rejected; no further traffic', status, failure)
                self.reply(status, data)
            except ProbeStopped:
                status = guard.status if guard.status in (401, 403, 429) else 400
                actual = guard.entry.get('upstream_code')
                code = actual if actual and actual != 'upstream_http_error' else ('rate_limit_error' if status == 429 else 'ProbeStopped')
                self.reply(status, json.dumps({'error': {'type': code, 'message': 'Control stopped by safety guard'}}).encode())
            except (ValueError, TypeError, KeyError, OSError, urllib.error.URLError, subprocess.TimeoutExpired):
                try:
                    guard.stop('Official public control validation or transport failed')
                except ProbeStopped:
                    self.reply(400, b'{"error":{"type":"ProbeStopped","message":"Control validation or transport failed"}}')

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port) + '/v1'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
