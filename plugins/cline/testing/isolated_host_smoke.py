#!/usr/bin/env python3
"""Cline custom integration only; fake accounts and loopback in a network namespace.
Reuses reviewed OpenCode test utilities, never that provider's assertions/auth.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess

BASE = pathlib.Path(__file__).resolve().parents[2] / "opencode/testing/isolated_host_smoke.py"
spec = importlib.util.spec_from_file_location("provider_smoke_utilities", BASE)
utilities = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utilities)

CLINE_SOURCE = r'''
# Override OpenCode-specific fixture entry point; only utility definitions above
# are reused. No OpenCode profile, credential or inference path is executed.
MODEL_ID = "cline/smoke-model"
class ClineMock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        assert self.path == "/api/v1/chat/completions", "unexpected upstream path"
        assert self.headers.get("Authorization") == "Bearer workos:fake-access-token", "auth format differs"
        report["dispatches"] += 1
        case = str(body["messages"][-1].get("content", ""))
        chunk = {"id":"chatcmpl-cline","object":"chat.completion.chunk","model":"smoke-model"}
        tool = {**chunk,"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"fixture\"}"}}]}}]}
        finish = {**chunk,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls" if case != "text" else "stop"}]}
        text = {**chunk,"choices":[{"index":0,"delta":{"role":"assistant","content":"fixture-text","reasoning_content":"fixture-reasoning"}}]}
        frames = [text if case == "text" else tool,finish]
        wire = b"".join(b"data: "+json.dumps(f).encode()+b"\n\n" for f in frames)+b"data: [DONE]\n\n"
        if case == "late-error": wire += b'data: {"error":{"message":"fixture-late-error"}}\n\n'
        self.send_response(200); self.send_header("Content-Type","text/event-stream")
        self.send_header("Content-Length",str(len(wire))); self.end_headers(); self.wfile.write(wire)

report = {"dispatches":0,"checks":{},"failures":[]}
def main():
    proc = log = mock = None
    try:
        report["isolated"] = ns_isolation_proven(read_net_ns(),OUTER_NS_NET)
        assert report["isolated"], "network isolation unproven"
        mock = http.server.ThreadingHTTPServer(("127.0.0.1",MOCK_PORT),ClineMock)
        threading.Thread(target=mock.serve_forever,daemon=True).start()
        auth = WORK/"auth"; auth.mkdir()
        (auth/"cline.json").write_text(json.dumps({"type":"cline","accessToken":FAKE_ACCESS,"refreshToken":FAKE_REFRESH,"expiresAt":"2050-01-01T00:00:00Z"}))
        plugins = WORK/"plugins"; plugins.mkdir(); shutil.copyfile(PLUGIN,plugins/"cline.so")
        blank = WORK/"blank-catalog.json"; blank.write_text(json.dumps(BLANK_CATALOG))
        cfg={"config-version":8,"server":{"host":"127.0.0.1","port":BACKEND_PORT},
             "oauth":{"auth-dir":str(auth)},"access":{"api-keys":[CALLER_KEY]},
             "management":{"allow-remote":False,"secret-key":"fake-management-only","disable-control-panel":True,"disable-auto-update-panel":True},
             "models":{"catalog":"","codex-catalog":"","devin-catalog":""},
             "routing":{"retry":{"request-retry":0,"max-retry-credentials":1}},
             "plugins":{"enabled":True,"dir":str(plugins),"configs":{"cline":{"enabled":True,"api_base_url":"http://127.0.0.1:%d"%MOCK_PORT,"workos_base_url":"http://127.0.0.1:%d"%MOCK_PORT,"models":[{"id":"smoke-model"}]}}}}
        config = WORK/"config.yaml"; config.write_text(json.dumps(cfg))
        proc,log = start_backend(WORK,"cline",config)
        assert wait_backend_ready(proc), "backend not ready"
        headers={"Authorization":"Bearer "+CALLER_KEY,"Content-Type":"application/json"}
        deadline=time.monotonic()+4
        while True:
            req=urllib.request.Request("http://127.0.0.1:%d/v1/models"%BACKEND_PORT,headers=headers)
            with urllib.request.urlopen(req,timeout=2) as response: catalog=json.loads(response.read())
            if MODEL_ID in [m["id"] for m in catalog["data"]]: break
            assert time.monotonic()<deadline,"model not published"
            time.sleep(.1)
        report["checks"]["publication"]=True
        status,body=post_stream("/v1/chat/completions",{"model":MODEL_ID,"stream":True,"max_tokens":64,"messages":[{"role":"user","content":"text"}]},headers)
        (WORK/"text.sse").write_bytes(body)
        assert status==200 and b"fixture-text" in body and b"fixture-reasoning" in body and b"[DONE]" in body,"chat stream failed"
        report["checks"]["chat_stream"]=True
        tools=[{"name":"lookup","input_schema":{"type":"object","properties":{"key":{"type":"string"}}}}]
        for case in ["tool","late-error"]:
            status,body=post_stream("/v1/messages",{"model":MODEL_ID,"stream":True,"max_tokens":64,"tools":tools,"messages":[{"role":"user","content":case}]},headers)
            (WORK/(case+".sse")).write_bytes(body)
            if case=="tool":
                blocks=assistant_blocks_from_sse(body.decode())
                calls=[b for b in blocks if b.get("type")=="tool_use"]
                assert status==200 and len(calls)==1 and calls[0]["id"]=="call_fixture" and calls[0]["input"]=={"key":"fixture"} and b"event: message_stop" in body,"Messages tool translation failed"
            else:
                assert b'"type":"tool_use"' not in body.replace(b" ",b"") and b"event: message_stop" not in body,"late error committed tools or success"
            report["checks"][case]=True
        assert report["dispatches"]==3,"physical dispatch budget mismatch"
    except Exception as exc:
        report["failures"].append(str(exc))
    finally:
        if proc is not None: stop_backend(proc,log)
        if mock is not None: mock.shutdown()
        report["verdict"]="pass" if not report["failures"] else "fail"
        (WORK/"verdict.json").write_text(json.dumps(report,indent=2))
    return 0 if report["verdict"]=="pass" else 1
if __name__=="__main__": sys.exit(main())
'''

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary",required=True); parser.add_argument("--plugin",required=True); parser.add_argument("--output",required=True)
    args=parser.parse_args()
    if not shutil.which("bwrap"): parser.error("bwrap required; no unsandboxed fallback")
    binary=pathlib.Path(args.binary).resolve(strict=True); plugin=pathlib.Path(args.plugin).resolve(strict=True)
    output=pathlib.Path(args.output).resolve()
    if output.exists() and any(output.iterdir()): parser.error("output must be fresh")
    output.mkdir(parents=True,exist_ok=True,mode=0o700); output.chmod(0o700)
    fixture=output/"fixture.py"
    prefix=utilities.FIXTURE_SOURCE.rsplit('if __name__ == "__main__":',1)[0]
    fixture.write_text(prefix+CLINE_SOURCE)
    command=["bwrap","--unshare-net","--die-with-parent"]
    for name in ["/usr","/lib","/lib64","/bin"]:
        if pathlib.Path(name).exists(): command += ["--ro-bind",name,name]
    command += ["--dir","/etc"]
    for name in ["/etc/passwd","/etc/group","/etc/nsswitch.conf","/etc/hosts"]:
        if pathlib.Path(name).exists(): command += ["--ro-bind",name,name]
    command += ["--ro-bind",str(binary),"/backend","--ro-bind",str(plugin),"/plugin.so","--ro-bind",str(fixture),"/fixture.py","--bind",str(output),"/work","--tmpfs","/tmp","--dev","/dev","--proc","/proc","--chdir","/work","--clearenv","--setenv","PATH","/usr/bin:/bin","--","/usr/bin/python3","/fixture.py",utilities.outer_net_ns_token(),"/backend","/plugin.so","/work"]
    child=subprocess.Popen(command,start_new_session=True)
    try: code=child.wait(timeout=56)
    except subprocess.TimeoutExpired: code=1
    finally:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
    verdict=output/"verdict.json"
    result=json.loads(verdict.read_text()) if verdict.exists() else {"verdict":"fail","failures":["fixture failed or timed out"]}
    print(json.dumps({**result,"artifacts":str(output)}))
    return 0 if code==0 and result["verdict"]=="pass" else 1
if __name__=="__main__": raise SystemExit(main())
