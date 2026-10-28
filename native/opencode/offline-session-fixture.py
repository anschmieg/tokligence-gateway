"""Actual persisted official CLI lifecycle; only within the capture network namespace."""
import http.server, json, os, pathlib, signal, socket, subprocess, sys, threading, time
from official_control import profile_environment
if len(sys.argv) != 3 or os.readlink('/proc/self/ns/net') == sys.argv[1]:
    raise SystemExit('Separate network namespace required')
root = pathlib.Path('/work')
os.umask(0o077)
model = sys.argv[2]
hits = []
held = threading.Event()
closed = threading.Event()
class Server(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        hits.append({'body': body, 'headers': {k.lower(): v for k, v in self.headers.items() if k.lower() not in ('authorization', 'cookie')}, 'public': self.headers.get('authorization') == 'Bearer public'})
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        if len(hits) == 4:
            self.wfile.write(b': waiting\n\n'); self.wfile.flush(); held.set()
            self.connection.settimeout(8)
            try:
                if self.connection.recv(1) == b'': closed.set()
            except OSError: pass
            return
        delta = {'content': 'OFFLINE_SESSION_OK'}
        finish = 'stop'
        if len(hits) == 1:
            delta = {'reasoning_content': 'fixture official reasoning', 'tool_calls': [
                {'index': i, 'id': 'official_read_' + str(i), 'type': 'function', 'function': {'name': 'read', 'arguments': json.dumps({'filePath': '/work/profile/fixture.txt'})}}
                for i in range(2)]}
            finish = 'tool_calls'
        for item, reason in [(delta, None), ({}, finish)]:
            self.wfile.write(('data: ' + json.dumps({'id': 'fixture', 'choices': [{'index': 0, 'delta': item, 'finish_reason': reason}]}) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Server)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with socket.create_connection(('1.1.1.1',443), timeout=.2): pass
    raise RuntimeError('External network available')
except OSError: pass
home = root / 'profile'; home.mkdir(exist_ok=True)
(home / 'fixture.txt').write_text('OFFICIAL_READ_FIXTURE')
subprocess.run(['/usr/bin/git', 'init', '--quiet', str(home)], check=True, env={'PATH': '/usr/bin:/bin', 'HOME': str(home)})
env = profile_environment(home, 'http://127.0.0.1:' + str(server.server_port) + '/v1', model)
config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
config['permission'] = {'*': 'deny', 'read': {'*': 'deny', 'fixture.txt': 'allow'}}
env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
base = ['/cli', 'run', '--pure', '--model', 'opencode/' + model, '--title', 'Offline lifecycle', '--format', 'json']
def run(args, label):
    child = subprocess.Popen(base + args, env=env, cwd=home, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try: out, err = child.communicate(timeout=25)
    except BaseException:
        child.kill(); child.communicate(); raise
    (root / (label + '.stdout')).write_text(out); (root / (label + '.stderr')).write_text(err)
    assert child.returncode == 0, label + ' failed'
    return [json.loads(line) for line in out.splitlines() if line.startswith('{')]
try:
    first = run(['Read fixture.txt twice using the read tool, then reply OFFLINE_SESSION_OK.'], 'first')
    assert len(hits) == 2, 'initial tool loop request count'
    session = next(item['sessionID'] for item in first if item.get('sessionID'))
    replay = hits[1]['body']['messages']
    results = [m for m in replay if m['role'] == 'tool']
    assert {m['tool_call_id'] for m in results} == {'official_read_0', 'official_read_1'}, 'parallel result identities'
    assert all('OFFICIAL_READ_FIXTURE' in m['content'] for m in results), 'scoped Read result'
    assert any(m.get('reasoning_content') == 'fixture official reasoning' for m in replay), 'actual reasoning replay'
    run(['--session', session, 'Continue the same session; reply OFFLINE_SESSION_OK.'], 'resume')
    assert len(hits) == 3 and any(m.get('tool_call_id') == 'official_read_0' for m in hits[2]['body']['messages']), 'persisted tool history after CLI restart'
    child = subprocess.Popen(base + ['--session', session, 'Wait for the final response.'], env=env, cwd=home, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert held.wait(15), 'cancel request did not arrive'
        child.send_signal(signal.SIGINT)
        try: child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.communicate(); raise AssertionError('CLI required forced kill during cancellation')
        assert closed.wait(3), 'cancel did not close provider socket'
    finally:
        if child.poll() is None: child.kill(); child.communicate()
    run(['--session', session, 'Resume after cancellation; reply OFFLINE_SESSION_OK.'], 'after-cancel')
    assert len(hits) == 5, 'cancellation or resume caused extra inference'
    keys = ['x-opencode-session', 'x-opencode-project']
    for key in keys:
        assert hits[0]['headers'].get(key) and len({h['headers'].get(key) for h in hits}) == 1, 'unstable ' + key
    summary = {'external_network_blocked': True, 'exit_code': 0, 'requests': len(hits), 'marker_received': True, 'public_auth_only': all(h['public'] for h in hits), 'parallel_tool_results': True, 'reasoning_replayed': True, 'persisted_resume': True, 'cancellation_closed': True, 'cancellation_graceful': True, 'resume_after_cancel': True, 'stable_session_headers': True, 'scope': 'actual_official_cli_synthetic_lifecycle'}
    (root / 'requests.json').write_text(json.dumps(hits, indent=2))
    (root / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
finally:
    (root / 'requests.json').write_text(json.dumps(hits, indent=2))
    server.shutdown(); server.server_close()
