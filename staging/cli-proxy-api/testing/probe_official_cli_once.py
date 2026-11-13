#!/usr/bin/env python3
"""Explicit user-requested official CLI control, not a gateway/public fallback.

One same-account Beam request. Current OAuth access is read only; no refresh
credential/database is passed to the CLI. Existing hold and quarantine persist.
"""
import fcntl,hashlib,http.server,ipaddress,json,os,re,signal,subprocess,threading,time,urllib.request
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging');OLD=Path('/home/agent/tokligence-staging')
RUN='official-cli-oauth-control-20261102-v1';MODEL='beam-free'
SHA='dcc7e6f4ac1672e1884dcb8d26ab333e55ffc3f080e01a7a60177aa05f54935f'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None

def main():
 os.umask(0o077);locks=[]
 for p in [OLD/'live-probe.lock',ROOT/'state/freehub-deployment.lock',ROOT/'state/provider-acceptance-20261102/run.lock']:
  f=p.open('r');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(f)
 out=ROOT/'state'/RUN;out.mkdir(mode=0o700)
 report=ROOT/(RUN+'.json')
 if report.exists():raise RuntimeError('existing control; never replay')
 binary=ROOT/'bin/opencode-official-2.2.5'
 if hashlib.sha256(binary.read_bytes()).hexdigest()!=SHA:raise RuntimeError('official CLI identity mismatch')
 key=(ROOT/'secrets/management.key').read_text().strip()
 address=next(a for a in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(a).version==4)
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 def get(p):
  with opener.open(urllib.request.Request('http://'+address+':8080'+p,headers={'Authorization':'Bearer '+key}),timeout=15) as f:return json.load(f)
 cfg=get('/v8/management/config/plugins/configs/opencode')
 if MODEL not in cfg.get('models',[]) or MODEL in cfg.get('console_disabled_models',[]):raise RuntimeError('reviewed free model not admitted')
 if cfg.get('inference_base_url')!='https://opencode.ai/inference/openai/v1':raise RuntimeError('endpoint differs')
 accounts=[e for e in get('/v8/management/credentials')['files'] if e.get('provider')=='opencode']
 if len(accounts)!=2 or any(not e.get('disabled') for e in accounts):raise RuntimeError('quarantine changed')
 values=[];files=[]
 for e in accounts:
  p=ROOT/'auth'/e['name']
  if p.parent.resolve()!=(ROOT/'auth').resolve():raise RuntimeError('unexpected auth path')
  files.append(p);v=json.loads(p.read_text())['credential'];m=v['metadata']
  if v.get('type')!='oauth' or not v.get('access') or v.get('expires',0)<time.time()*1000+300000:raise RuntimeError('native owner must supply valid OAuth access')
  values.append((e,v,m))
 if len({(m.get('accountID'),m.get('orgID'),m.get('server')) for _,_,m in values})!=1:raise RuntimeError('comparison would change account or organization')
 _,credential,metadata=max(values,key=lambda item:item[0].get('created_at',''))
 if not metadata.get('accountID') or not metadata.get('orgID'):raise RuntimeError('scope identity missing')
 headers=cfg.get('console_headers',{})
 if headers.get('x-opencode-org-id')!=metadata['orgID']:raise RuntimeError('Console organization mismatch')
 ledger=OLD/'live-probe-ledger.json';ld=json.loads(ledger.read_text())
 if ld.get('cooldown_until')!='2026-11-03T07:42:08.980115+00:00':raise RuntimeError('newer or changed hold requires review')
 files += [ledger,ROOT/'secrets/client-api-key',ROOT/'plugins/opencode.so',ROOT/'plugins/free-model-hub.so']
 files += list(ROOT.glob('cliproxy-*-live-20261102-v1*.json'))
 hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
 result=dict(run=RUN,model=MODEL,phase='prepared',native_cli_version='2.2.5',native_cli_sha256=SHA,account_scope='existing_same_OAuth_account_and_org',credential_delivery='read_only_access_token_in_private_child_config',oauth_refresh_owners=1,cli_refresh_credential=False,request_budget=1,output_budget=1024,local_hold_exception='explicit_user_request_for_one_official_CLI_probe',gateway_quarantine_preserved=True,started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
 def save():report.write_text(json.dumps(result,indent=2)+'\n')
 with report.open('x') as f:json.dump(result,f)
 home=out/'profile';home.mkdir(mode=0o700)
 plugin=home/'guard';plugin.mkdir();(plugin/'package.json').write_text(json.dumps({'name':'official-control-guard','type':'module','exports':{'./server':'./index.js'}}));(plugin/'index.js').write_text((ROOT/'official_cli_probe_guard.mjs').read_text())
 count={'local_bridge_gets':0}
 class Stub(http.server.BaseHTTPRequestHandler):
  def log_message(self,*a):pass
  def do_GET(self):
   if self.path!='/guard-bridge':self.send_error(404);return
   count['local_bridge_gets']+=1;self.send_response(204);self.end_headers()
 stub=http.server.ThreadingHTTPServer(('127.0.0.1',0),Stub);stub.daemon_threads=True
 threading.Thread(target=stub.serve_forever,daemon=True).start()
 config={'plugins':[str(plugin)],'policies':[{'action':'tool.use','resource':'*','effect':'deny'}],'permissions':[{'action':'*','resource':'*','effect':'deny'}], 'providers':{'opencode':{'package':'@opencode/ai/providers/openai-compatible','headers':headers,'settings':{'baseURL':cfg['inference_base_url'],'apiKey':credential['access']},'models':{MODEL:{'capabilities':{'tools':False,'input':['text'],'output':['text']},'cost':{'input':0,'output':0,'cache':{'read':0,'write':0}},'limit':{'context':100000,'output':1024}}}}}}
 env={'PATH':'/usr/bin:/bin','HOME':str(home),'PWD':str(home),'OPENCODE_DB':str(home/'opencode.db'),'OPENCODE_CONFIG_DIR':str(home/'config'),'OPENCODE_CONFIG_CONTENT':json.dumps(config),'OPENCODE_CONFIG_PROJECT_DISABLE':'1','OPENCODE_DISABLE_CLAUDE_CODE':'1','OPENCODE_DISABLE_MODELS_FETCH':'1','OPENCODE_DISABLE_FFF':'1','OPENCODE_FILEWATCHER_DISABLE':'1','OPENCODE_DISABLE_AUTOUPDATE':'1','DO_NOT_TRACK':'1','OPENCODE_PASSWORD':'one-shot-private-server','OPENCODE_PROBE_DIR':str(out),'OPENCODE_PROBE_ENDPOINT':cfg['inference_base_url']+'/chat/completions','OPENCODE_PROBE_MODEL':MODEL,'OPENCODE_PROBE_AUTH_SHA256':hashlib.sha256(('Bearer '+credential['access']).encode()).hexdigest(),'OPENCODE_PROBE_ORG':metadata['orgID'],'OPENCODE_PROBE_BRIDGE':f'http://127.0.0.1:{stub.server_port}/guard-bridge'}
 for n in ['DATA','CONFIG','CACHE','STATE']:env['XDG_'+n+'_HOME']=str(home/n.lower())
 children=[];logs=[]
 def spawn(args,name):
  a=(out/(name+'.stdout')).open('w');b=(out/(name+'.stderr')).open('w');logs.extend([a,b]);p=subprocess.Popen([str(binary),*args],cwd=home,env=env,stdin=subprocess.DEVNULL,stdout=a,stderr=b,start_new_session=True);children.append(p);return p
 try:
  host=spawn(['serve','--hostname','127.0.0.1','--port','0'],'server');deadline=time.monotonic()+25;endpoint=None
  while time.monotonic()<deadline:
   if host.poll() is not None:raise RuntimeError('official CLI server exited')
   match=re.search(r'server listening on (http://127.0.0.1:\d+)',(out/'server.stdout').read_text())
   if match:endpoint=match[1];break
   time.sleep(.1)
  if not endpoint:raise RuntimeError('official CLI startup timeout')
  result['phase']='running';save()
  cli=spawn(['run','--server',endpoint,'--model','opencode/'+MODEL,'--title','Official CLI control','--format','json','Reply with exactly CLI_OK. Do not use tools.'],'client')
  code=cli.wait(timeout=65);text=(out/'client.stdout').read_text()
  result.update(exit_code=code,marker_received='CLI_OK' in text)
 except Exception as error:result.update(phase='failed',error_type=type(error).__name__)
 finally:
  for child in reversed(children):
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   child.wait(timeout=3)
  for f in logs:f.close()
  stub.server_close()
  physical=out/'physical-request.json';reply=out/'provider-response.json'
  result.update(physical_requests=int(physical.exists()),guard_loaded=(out/'guard-ready.json').exists(),local_bridge_gets=count['local_bridge_gets'],protected_state_unchanged=all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in hashes.items()))
  if reply.exists():result['provider_response']=json.loads(reply.read_text())
  result['phase']='pass' if result.get('marker_received') and result.get('exit_code')==0 and result.get('provider_response',{}).get('status')==200 and result['physical_requests']==1 and result['protected_state_unchanged'] else 'failed'
  result['finished_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save();print(json.dumps(result),flush=True)

if __name__=='__main__':main()
