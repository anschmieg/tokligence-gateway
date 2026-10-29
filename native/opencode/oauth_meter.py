"""Accounting for actual native Bun fetch calls; never forwards provider traffic."""
import contextlib
import hmac
import http.server
import json
import secrets
import threading
from live_safety import ProbeStopped
from official_control import public_failure


@contextlib.contextmanager
def native_meter(guard, model, max_tokens=1024, allow_tools=False, max_calls=1, capture_requests=False, allowed_request_fields=None):
    authorization = 'Bearer ' + secrets.token_hex(32)
    calls = 0

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup(); self.connection.settimeout(5)

        def log_message(self, *_): pass

        def do_POST(self):
            nonlocal calls
            code = 200
            try:
                if not hmac.compare_digest(self.headers.get('authorization', ''), authorization):
                    code = 401
                else:
                    size = int(self.headers.get('content-length', '0'))
                    if not 0 < size <= 2 * 1024 * 1024: guard.stop('Native meter invalid body')
                    value = json.loads(self.rfile.read(size))
                    if not isinstance(value, dict): raise ValueError('Native meter object required')
                    if guard.blocked and not (self.path == '/outcome' and getattr(guard, 'pending_error_body', False)):
                        raise ProbeStopped(guard.blocked)
                    if self.path == '/reserve':
                        if (value.get('model') != (model() if callable(model) else model) or value.get('competing_limit') is not False
                                or value.get('cookies') is not False or value.get('oauth_bearer') is not True or value.get('stream') is not True
                                or type(value.get('max_tokens')) is not int or not 1 <= value['max_tokens'] <= max_tokens
                                or type(value.get('tools')) is not int or (value['tools'] and not allow_tools)):
                            guard.stop('Native meter model/auth/output/tool contract mismatch')
                        if allowed_request_fields is not None and (not isinstance(value.get('request'), dict) or set(value['request']) - allowed_request_fields):
                            guard.stop('Native reference contains unreviewed body fields')
                        with guard.forward_lock:
                            if calls >= max_calls: guard.stop('Native reference phase request budget exhausted')
                            guard.reserve(value['max_tokens'])
                            calls += 1
                            if capture_requests:
                                if not isinstance(value.get('request'), dict): guard.stop('Native meter missing request capture')
                                if not hasattr(guard, 'native_requests'): guard.native_requests = []
                                guard.native_requests.append(value['request'])
                    elif self.path in ('/outcome', '/observed-rejection'):
                        status = value.get('status')
                        if type(status) is not int or not 300 <= status <= 599: guard.stop('Native meter invalid status')
                        if not isinstance(value.get('headers', {}), dict): raise ValueError('Native meter headers required')
                        failure = public_failure(str(value.get('body', '')).encode(), value.get('headers', {}))
                        if self.path == '/observed-rejection':
                            guard.pending_error_body = True
                            if failure.get('retry_at'):
                                guard.entry['upstream_retry_at'] = failure['retry_at']
                                guard.entry['retry_at_source'] = 'provider'
                            else: guard.entry['retry_at_source'] = 'conservative_unknown'
                            guard.stop('Native OAuth control rejected; no further traffic', status, failure)
                        if getattr(guard, 'pending_error_body', False) and guard.status == status:
                            # Header rejection is already durable. Add only the
                            # allowlisted details recovered from the bounded body.
                            with guard.mutex:
                                for key in ['code', 'upstream_request_id']:
                                    if key in failure and (key != 'code' or failure[key] != 'upstream_http_error'):
                                        guard.entry['upstream_code' if key == 'code' else key] = failure[key]
                                if failure.get('retry_at'):
                                    if guard.entry.get('retry_at_source') == 'conservative_unknown':
                                        guard.ledger['cooldown_until'] = failure['retry_at']
                                    guard.entry['upstream_retry_at'] = failure['retry_at']
                                    guard.entry['retry_at_source'] = 'provider'
                                guard._save()
                                guard.pending_error_body = False
                        else:
                            if failure.get('retry_at'): guard.entry['upstream_retry_at'] = failure['retry_at']
                            guard.entry['retry_at_source'] = 'provider' if failure.get('retry_at') else 'conservative_unknown'
                            guard.stop('Native OAuth control rejected; no further traffic', status, failure)
                    elif self.path != '/background':
                        reason = value.get('reason')
                        safe = reason if reason in {'unexpected_native_destination', 'invalid_native_request_body', 'native_transport_failed', 'invalid_native_control_response'} else 'invalid_protocol_action'
                        guard.stop('Native meter refused: ' + safe)
            except ProbeStopped: code = 200 if self.path in ('/outcome', '/observed-rejection') else 429
            except (ValueError, TypeError, OSError):
                try: guard.stop('Native meter protocol failed')
                except ProbeStopped: pass
                code = 400
            self.send_response(code); self.send_header('Content-Length', '2'); self.end_headers()
            try: self.wfile.write(b'{}')
            except OSError: pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try: yield {'meter': 'http://127.0.0.1:' + str(server.server_port), 'authorization': authorization}
    finally: server.shutdown(); server.server_close(); thread.join()
