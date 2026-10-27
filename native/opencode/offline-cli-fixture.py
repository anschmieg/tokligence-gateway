"""Internal fixture; launch through capture-official-cli.py for OS network isolation."""
import os, pathlib, json, socket, threading, http.server, subprocess, signal, time, sys
if len(sys.argv) != 2 or os.readlink('/proc/self/ns/net') == sys.argv[1]:
 raise SystemExit('Refusing capture without a separate network namespace')
root=pathlib.Path('/work')
os.umask(0o077)
hits=[]
class Server(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))))
  headers={k.lower():v for k,v in self.headers.items() if k.lower() not in ('authorization','cookie','proxy-authorization')}
  auth='public' if self.headers.get('authorization') == 'Bearer public' else 'unexpected-or-missing'
  hits.append({'path':self.path,'headers':headers,'authentication':auth,'body':body})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for delta,finish in [({'role':'assistant','content':'OFFLINE_CAPTURE_OK'},None),({},'stop')]:
   self.wfile.write(('data: '+json.dumps({'id':'offline','object':'chat.completion.chunk','choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Server)
threading.Thread(target=server.serve_forever,daemon=True).start()
blocked=False
try:
 with socket.create_connection(('1.1.1.1',443),timeout=.2):pass
except OSError:blocked=True
if not blocked:raise RuntimeError('External network unexpectedly available')
config={'formatter':False,'lsp':False,'permission':'deny','share':'disabled','provider':{'opencode':{'id':'opencode','name':'OpenCode','env':[],'npm':'@ai-sdk/openai-compatible','models':{'beam-free':{'id':'beam-free','name':'Synthetic Beam','attachment':False,'reasoning':False,'temperature':False,'tool_call':True,'limit':{'context':100000,'output':1000},'cost':{'input':0,'output':0},'options':{}}},'options':{'baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'public'}}}}
home=root/'profile';home.mkdir(exist_ok=True)
env={'PATH':'/usr/bin:/bin','HOME':str(home),'OPENCODE_TEST_HOME':str(home),'OPENCODE_CONFIG_CONTENT':json.dumps(config),'OPENCODE_AUTH_CONTENT':'{}','OPENCODE_DISABLE_PROJECT_CONFIG':'1','OPENCODE_PURE':'1','OPENCODE_DISABLE_AUTOUPDATE':'1','OPENCODE_DISABLE_AUTOCOMPACT':'1','OPENCODE_DISABLE_MODELS_FETCH':'1','OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER':'1','OPENCODE_DISABLE_FFF':'1','DO_NOT_TRACK':'1'}
for key,name in [('CONFIG','config'),('DATA','data'),('STATE','state'),('CACHE','cache')]:env['XDG_'+key+'_HOME']=str(home/name)
started=time.monotonic()
p=subprocess.Popen(['/cli','run','--pure','--model','opencode/beam-free','--title','Offline capture','--format','json','--print-logs','Reply exactly OFFLINE_CAPTURE_OK. Do not use tools.'],cwd=home,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
timedout=False
try:out,err=p.communicate(timeout=40)
except subprocess.TimeoutExpired:
 timedout=True;p.kill();out,err=p.communicate()
(root/'stdout.txt').write_text(out);(root/'stderr.txt').write_text(err);(root/'requests.json').write_text(json.dumps(hits,indent=2))
summary={'external_network_blocked':blocked,'exit_code':p.returncode,'timeout':timedout,'seconds':round(time.monotonic()-started,2),'requests':len(hits),'marker_received':'OFFLINE_CAPTURE_OK' in out,'stdout_bytes':len(out),'stderr_bytes':len(err),'request_paths':[h['path'] for h in hits],'public_auth_only':bool(hits) and all(h['authentication']=='public' for h in hits),'overrides':['loopback provider endpoint','synthetic model metadata','public key','no tools','no updates/catalog fetch/plugins/project config']}
(root/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary),flush=True)
