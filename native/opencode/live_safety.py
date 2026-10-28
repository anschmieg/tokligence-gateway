"""Persistent, single-owner budgets for staging probes. No provider credentials are stored."""
import contextlib
import datetime
import fcntl
import http.server
import http.client
import socket
import select
import hmac
import json
import os
import pathlib
import re
import threading
import urllib.error
import urllib.request
import urllib.parse


class ProbeStopped(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


open_gateway = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open


def gateway_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1', 'localhost') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Live probes require a loopback HTTP gateway without URL credentials')
    return value.rstrip('/')


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else None
    except ValueError:
        return None


def recorded_cooldowns(root, ledger):
    """Same read-only evidence sources for admission and locked dispatch."""
    root = pathlib.Path(root)
    cooldowns = [parse_time(ledger.get('cooldown_until'))]
    for name in ['public-native-probe.json', 'live-matrix-results.json']:
        evidence = root / name
        if not evidence.exists():
            continue
        report = json.loads(evidence.read_text())
        cooldowns.append(parse_time(report.get('retry_at')))
        cooldowns.extend(parse_time(item.get('reset')) for item in report.get('results', []))
    return [value for value in cooldowns if value and value > utc_now()]


class LiveGuard:
    def __init__(self, root, run_id, requests, output_tokens, window=None):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', run_id):
            raise ValueError('Invalid run ID')
        if not 1 <= requests <= 40 or not 1 <= output_tokens <= 220000:
            raise ValueError('Invalid probe budget')
        self.window = window
        self.root = pathlib.Path(root)
        self.run_id = run_id
        self.limit = requests
        self.output_limit = output_tokens
        self.mutex = threading.RLock()
        self.forward_lock = threading.Lock()
        self.blocked = None
        self.count = 0
        self.output_count = 0
        self.status = None
        self.lock = None

    def __enter__(self):
        self.lock = (self.root / 'live-probe.lock').open('a+')
        os.fchmod(self.lock.fileno(), 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = self.root / 'live-probe-ledger.json'
            self.ledger = json.loads(path.read_text()) if path.exists() else {'runs': {}}
            future = recorded_cooldowns(self.root, self.ledger)
            if future:
                self.ledger['cooldown_until'] = max(future).isoformat()
                self._save()
                raise ProbeStopped('Recorded provider cooldown is still active')
            if self.window:
                window = self.window
                if (not isinstance(window, dict) or set(window) != {'id', 'request_budget', 'output_budget', 'allowed_runs'}
                        or not isinstance(window['id'], str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', window['id'])
                        or type(window['request_budget']) is not int or not 1 <= window['request_budget'] <= 40
                        or type(window['output_budget']) is not int or not 1 <= window['output_budget'] <= 220000
                        or not isinstance(window['allowed_runs'], list) or not window['allowed_runs']
                        or any(not isinstance(run, str) for run in window['allowed_runs'])
                        or self.run_id not in window['allowed_runs']):
                    raise ProbeStopped('Invalid or unselected live window')
                windows = self.ledger.setdefault('windows', {})
                previous = windows.get(window['id'])
                if previous is not None and previous != window:
                    raise ProbeStopped('Existing live window limits cannot be changed')
                windows[window['id']] = window
            if self.run_id in self.ledger['runs']:
                raise ProbeStopped('Run ID already reserved; previous probes are never replayed')
            self.entry = {'started': utc_now().isoformat(), 'status': 'in_progress', 'requests': 0,
                          'reserved_output_tokens': 0, 'request_budget': self.limit,
                          'output_budget': self.output_limit}
            if self.window:
                self.entry['window_id'] = self.window['id']
            self.ledger['runs'][self.run_id] = self.entry
            self._save()  # Reserve identity before any network request, including after crashes.
            return self
        except BaseException:
            self.lock.close()
            raise

    def _save(self):
        pending = self.root / 'live-probe-ledger.pending'
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(self.ledger, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(pending, self.root / 'live-probe-ledger.json')
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def reserve(self, max_tokens):
        with self.mutex:
            if self.blocked:
                raise ProbeStopped(self.blocked)
            if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or not 1 <= max_tokens <= 8192:
                self.stop('Invalid output budget')
            if self.count >= self.limit or self.output_count + max_tokens > self.output_limit:
                self.stop('Probe request or output budget exhausted')
            if self.window:
                entries = [entry for entry in self.ledger['runs'].values() if entry.get('window_id') == self.window['id']]
                if (sum(entry.get('requests', 0) for entry in entries) >= self.window['request_budget']
                        or sum(entry.get('reserved_output_tokens', 0) for entry in entries) + max_tokens > self.window['output_budget']):
                    self.stop('Aggregate live window budget exhausted')
            self.count += 1
            self.output_count += max_tokens
            self.entry.update(requests=self.count, reserved_output_tokens=self.output_count)
            self._save()  # Reservations survive transport errors; no automatic retry/refund.

    def stop(self, reason, status=None, failure=None):
        with self.mutex:
            if self.blocked and (status not in (401, 403, 429) or self.status in (401, 403, 429)):
                raise ProbeStopped(self.blocked)
            self.blocked = reason
            self.status = status
            self.entry.update(status='blocked', reason=reason)
            if status is not None:
                self.entry['upstream_status'] = status
            code = (failure or {}).get('code')
            if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,80}', code):
                self.entry['upstream_code'] = code
            request_id = (failure or {}).get('upstream_request_id')
            if isinstance(request_id, str) and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9A-HJKMNP-TV-Z]{26}', request_id):
                self.entry['upstream_request_id'] = request_id
            if status in (401, 403, 429):
                reset = parse_time((failure or {}).get('retry_at'))
                # Unknown limits/auth failures require investigation, not repeated timer probes.
                if not reset or reset <= utc_now():
                    reset = utc_now() + datetime.timedelta(days=1)
                self.ledger['cooldown_until'] = reset.isoformat()
                self.entry['upstream_status'] = status
            self._save()
            raise ProbeStopped(reason)

    def __exit__(self, exc_type, exc, tb):
        try:
            with self.mutex:
                self.entry.update(finished=utc_now().isoformat(), status='blocked' if self.blocked else 'interrupted' if exc else 'finished')
                self._save()
        finally:
            self.lock.close()


@contextlib.contextmanager
def claude_relay(guard, base_url, model, authorization, timeout):
    """Observe and budget every actual CLI inference call, including attempted retries."""
    base_url = gateway_url(base_url)
    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_):
            pass

        def reply(self, status, body):
            try:
                self.send_response(status)
                self.send_header('Content-Type', getattr(self, '_reply_type', 'application/json'))
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return True
            except OSError:
                self.close_connection = True
                return False

        def do_POST(self):
            try:
                if not hmac.compare_digest(self.headers.get('authorization', '').encode(), authorization.encode()):
                    self.reply(401, b'{"error":{"type":"authentication_error","message":"Invalid probe authorization"}}')
                    return
                route = urllib.parse.urlsplit(self.path)
                if route.scheme or route.netloc or route.path != '/v1/messages' or route.query not in ('', 'beta=true'):
                    raise ValueError('Only the Messages probe endpoint is allowed')
                length = int(self.headers.get('content-length', '0'))
                if not 0 < length <= 16 * 1024 * 1024:
                    raise ValueError('Invalid probe body length')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('Probe body must be an object')
                if body.get('model') != 'opencode-native/' + model:
                    raise ValueError('CLI attempted an unselected model')
                if 'stream' in body and not isinstance(body['stream'], bool):
                    raise ValueError('Invalid CLI stream flag')
                tokens = body.get('max_tokens')
                if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 1:
                    raise ValueError('Invalid CLI output limit')
                body['max_tokens'] = min(tokens, 8192)
                with guard.forward_lock:
                    status, raw = self.forward(body)
                self._reply_type = 'text/event-stream' if body.get('stream') else 'application/json'
                if not self.reply(status, raw):
                    guard.stop('CLI response delivery failed; no further traffic')
            except ProbeStopped:
                self._reply_type = 'application/json'
                self.reply(guard.status or 429, b'{"error":{"type":"rate_limit_error","message":"Probe stopped by persistent safety guard"}}')
            except (ValueError, TypeError, KeyError) as error:
                try:
                    fixed = {'Only the Messages probe endpoint is allowed', 'Invalid probe body length',
                             'Probe body must be an object', 'CLI attempted an unselected model',
                             'Invalid CLI stream flag', 'Invalid CLI output limit', 'Probe response exceeded limit'}
                    guard.stop(str(error) if str(error) in fixed else 'Invalid CLI probe request')
                except ProbeStopped:
                    self.reply(400, b'{"error":{"type":"invalid_request_error","message":"Invalid CLI probe request"}}')
            except (OSError, urllib.error.URLError, http.client.HTTPException):
                try:
                    guard.stop('CLI probe transport failed')
                except ProbeStopped:
                    self.reply(502, b'{"error":{"type":"api_error","message":"CLI probe transport failed"}}')

        def forward(self, body):
            def peer_gone():
                try:
                    return bool(select.select([self.connection], [], [], 0)[0]) and self.connection.recv(1, socket.MSG_PEEK) == b''
                except OSError:
                    return True
            if peer_gone():
                guard.stop('CLI client disconnected; no further traffic')
            guard.reserve(body['max_tokens'])
            user = body.get('metadata', {}).get('user_id') if isinstance(body.get('metadata'), dict) else None
            if isinstance(user, str):
                try: user = json.loads(user)
                except ValueError: user = None
            session = user.get('session_id') if isinstance(user, dict) else None
            if not isinstance(session, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,255}', session):
                session = 'live-cli-' + guard.run_id + '-' + model
            parsed = urllib.parse.urlsplit(base_url)
            connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
            done = threading.Event()
            cancelled = threading.Event()
            transport = {}
            def watch_client():
                while not done.wait(.025):
                    if not peer_gone(): continue
                    cancelled.set()
                    upstream = transport.get('socket')
                    if upstream:
                        try: upstream.shutdown(socket.SHUT_RDWR)
                        except OSError: pass
                    return
            watcher = threading.Thread(target=watch_client, daemon=True)
            watcher.start()
            status = None
            try:
                connection.connect()
                transport['socket'] = connection.sock
                if cancelled.is_set():
                    guard.stop('CLI client disconnected; no further traffic')
                connection.request('POST', '/v1/messages', body=json.dumps(body).encode(), headers={
                    'Authorization': authorization, 'Content-Type': 'application/json', 'x-session-id': session})
                response = connection.getresponse()
                status = response.status
                try:
                    raw = response.read(32 * 1024 * 1024 + 1)
                except (OSError, http.client.HTTPException):
                    # Do not lose an observed rejection if the client disconnects
                    # or its error body fails while the socket is being closed.
                    if status >= 300: raw = b''
                    else: raise
                if len(raw) > 32 * 1024 * 1024:
                    raise ValueError('Probe response exceeded limit')
                if status >= 300:
                    try: failure = json.loads(raw).get('error', {})
                    except (ValueError, AttributeError): failure = {}
                    if not isinstance(failure, dict): failure = {}
                    guard.stop('Provider rejected the probe; no further traffic', status, failure)
                if cancelled.is_set():
                    guard.stop('CLI client disconnected; no further traffic')
                if body.get('stream'):
                    if 'text/event-stream' not in response.getheader('Content-Type', ''):
                        guard.stop('CLI probe returned an unexpected stream protocol', 502)
                    terminal = False
                    try: decoded = raw.decode('utf-8')
                    except UnicodeDecodeError: guard.stop('CLI probe contained invalid stream encoding', 502)
                    for frame in decoded.replace('\r\n', '\n').split('\n\n'):
                        lines = frame.splitlines()
                        data = '\n'.join(line[5:].lstrip() for line in lines if line.startswith('data:'))
                        if not data: continue
                        try: event = json.loads(data)
                        except ValueError: guard.stop('CLI probe contained malformed stream data', 502)
                        if not isinstance(event, dict) or event.get('type') == 'error' or 'error' in event:
                            guard.stop('CLI probe contained an embedded stream error', 502)
                        if terminal:
                            guard.stop('CLI probe contained output after stream completion', 502)
                        terminal = event.get('type') == 'message_stop'
                    if not terminal: guard.stop('CLI probe stream ended without completion', 502)
                else:
                    try: document = json.loads(raw)
                    except ValueError: guard.stop('CLI probe contained malformed response data', 502)
                    if not isinstance(document, dict) or 'error' in document:
                        guard.stop('CLI probe contained an embedded response error', 502)
                return status, raw
            except (OSError, http.client.HTTPException):
                if cancelled.is_set(): guard.stop('CLI client disconnected; no further traffic')
                raise
            finally:
                done.set()
                connection.close()
                watcher.join(timeout=1)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = False  # Hold the OS lease until all forwarded requests finish.
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
