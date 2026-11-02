#!/usr/bin/env python3
"""Sequential staging-only OAuth handoff. No inference, token output or DB copy.
Defaults to read-only admission. --execute retires only command-verified old
staging processes, deletes their one credential, and activates the native host.
On uncertain failure keep both old processes retired; never restart a stale owner.
"""
import argparse,fcntl,hashlib,json,os,pathlib,signal,sqlite3,sys,time,urllib.request
import yaml

OLD=pathlib.Path('/home/agent/tokligence-staging')
NEW=pathlib.Path('/home/agent/cliproxy-staging')
BASE='http://100.74.55.86:4195'
HOST_SHA='1e10ad3b424951fb8437ab8475a8c45c0f3f3775a0873f80556e0478e221200d'

def atomic(path,value):
 tmp=path.with_name(path.name+'.pending')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f: json.dump(value,f);f.flush();os.fsync(f.fileno())
 os.replace(tmp,path)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)

def identity(pid):
 try:
  r=pathlib.Path('/proc')/str(pid)
  stat=(r/'stat').read_text();status=(r/'status').read_text()
  return {'pid':pid,'start':stat[stat.rfind(')')+2:].split()[19], 'uid':int(status.split('Uid:')[1].split()[0]),'cmd':(r/'cmdline').read_bytes().split(b'\0')[:-1]}
 except FileNotFoundError:return None

def owned(name):
 pid=int((OLD/(name+'.pid')).read_text());v=identity(pid)
 want=[str(OLD/'runtime/bun').encode(),b'run',str(OLD/'runtime/opencode/packages/sdk/src/tokligence-bridge.ts').encode()] if name=='worker' else [str(OLD/'runtime/node').encode(),b'tgw-proxy.mjs']
 if not v or v['uid']!=os.geteuid() or v['cmd']!=want: raise RuntimeError('old '+name+' process identity mismatch')
 return v

def stop(v):
 if identity(v['pid'])!=v:raise RuntimeError('old process identity changed')
 os.kill(v['pid'],signal.SIGTERM)
 end=time.monotonic()+30
 while identity(v['pid'])==v and time.monotonic()<end:time.sleep(.1)
 if identity(v['pid'])==v:raise RuntimeError('old owner did not stop gracefully; no token transfer')

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--plugin-sha',required=True);parser.add_argument('--execute',action='store_true');args=parser.parse_args()
 os.umask(0o077)
 sys.path.insert(0,str(NEW));import cliproxy_lifecycle as lifecycle
 lock=lifecycle.lock_root(NEW)
 lifecycle.base.BIND_HOST='100.74.55.86'
 binary=NEW/'bin/cli-proxy-api';config=NEW/'config/config.yaml'
 if hashlib.sha256(binary.read_bytes()).hexdigest()!=HOST_SHA:raise RuntimeError('unexpected native backend')
 if not lifecycle.identity_matches(lifecycle.load_record(NEW),binary,config):raise RuntimeError('native host ownership unverified')
 plugin=NEW/'opencode-reviewed.pending.so'
 if hashlib.sha256(plugin.read_bytes()).hexdigest()!=args.plugin_sha:raise RuntimeError('plugin digest mismatch')
 if (NEW/'opencode-owner-handoff.json').exists():raise RuntimeError('handoff already recorded; no replay')
 key=(NEW/'secrets/management.key').read_text().strip()
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def api(path,method='GET',body=None,etag=None):
  headers={'Authorization':'Bearer '+key}
  if body is not None:headers['Content-Type']='application/json'
  if etag:headers['If-Match']=etag
  req=urllib.request.Request(BASE+'/v8/management/'+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
  with opener.open(req,timeout=10) as r:return json.load(r),r.headers.get('ETag')
 cfg,etag=api('config')
 if cfg['plugins']['enabled'] or list((NEW/'auth').iterdir()):raise RuntimeError('native host is not empty/disabled')
 retry=cfg['routing']['retry']
 if retry['request-retry']!=0 or retry['max-retry-credentials']!=1:raise RuntimeError('native retry budget differs')
 source=sqlite3.connect('file:'+str(OLD/'state/opencode.db')+'?mode=ro',uri=True)
 rows=source.execute('SELECT id,value FROM credential WHERE integration_id=?',('opencode',)).fetchall();source.close()
 if len(rows)!=1:raise RuntimeError('expected exactly one old staging credential')
 native=json.loads(rows[0][1])
 if native.get('type')!='oauth' or native.get('methodID')!='device' or not native.get('access') or not native.get('refresh') or native.get('expires',0)<int(time.time()*1000)+600000:raise RuntimeError('credential invalid or too close to expiry')
 if native.get('metadata',{}).get('server')!='https://opencode.ai/console':raise RuntimeError('unexpected OAuth server')
 gateway,worker=owned('gateway'),owned('worker')
 sys.path.insert(0,str(OLD/'gateway/native/opencode'))
 from live_safety import recorded_cooldowns
 ledger=json.loads((OLD/'live-probe-ledger.json').read_text())
 if recorded_cooldowns(OLD,ledger):raise RuntimeError('newer provider cooldown blocks admission')
 if pathlib.Path('/data/tokligence/zen/secondary-oauth.json').exists():raise RuntimeError('production secondary owner path unexpectedly present')
 if not args.execute:
  print(json.dumps({'ready':True,'inference_requests':0,'old_owner_verified':True,'native_empty':True,'credential_valid':True}));return
 report={'phase':'retiring_old_owner','provider_inference_requests':0,'old_owner_retired':False,'credential_deleted_from_old_db':False,'activated':False}
 atomic(NEW/'opencode-owner-handoff.json',report)
 stop(gateway);stop(worker)
 worker_lock=(OLD/'state/worker.lock').open('r')
 fcntl.flock(worker_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 report['old_owner_retired']=True;report['phase']='old_owner_retired';atomic(NEW/'opencode-owner-handoff.json',report)
 # Starter guard prevents an operator's generic old restart from recreating an owner.
 starter=OLD/'start-worker.py';text=starter.read_text();anchor="root=pathlib.Path('/home/agent/tokligence-staging')"
 if text.count(anchor)!=1:raise RuntimeError('old starter differs; owner remains retired')
 text=text.replace(anchor,anchor+"\nif (root/'oauth-owner-transferred.json').exists(): raise RuntimeError('OAuth owner transferred to CLIProxyAPI; old worker startup is retired')")
 starter.write_text(text)
 atomic(OLD/'oauth-owner-transferred.json',{'owner_root':str(NEW),'automatic_old_restart_forbidden':True})
 envpath=OLD/'worker-env.json';env=json.loads(envpath.read_text());env.pop('OPENCODE_NATIVE_SEED_FILE',None);atomic(envpath,env)
 c=sqlite3.connect(OLD/'state/opencode.db');c.execute('PRAGMA secure_delete=ON');c.execute('BEGIN IMMEDIATE')
 current=c.execute('SELECT id,value FROM credential WHERE integration_id=?',('opencode',)).fetchall()
 if len(current)!=1:raise RuntimeError('credential set changed after stop')
 # Re-read after graceful shutdown so the latest rotated value, never a snapshot,
 # becomes the new owner's credential. The SQL transaction prevents local writers.
 native=json.loads(current[0][1]);envelope={'type':'opencode','storage_version':1,'credential':native}
 pending=NEW/'secrets/opencode-owner-transfer.json';atomic(pending,envelope)
 deleted=c.execute('DELETE FROM credential WHERE id=? AND integration_id=?',(current[0][0],'opencode')).rowcount
 if deleted!=1:raise RuntimeError('credential removal mismatch')
 c.commit();c.execute('PRAGMA wal_checkpoint(FULL)');c.close()
 report['credential_deleted_from_old_db']=True;report['phase']='credential_transferred_inactive';atomic(NEW/'opencode-owner-handoff.json',report)
 plugins=NEW/'plugins';plugins.mkdir(exist_ok=True,mode=0o700)
 if list(plugins.iterdir()):raise RuntimeError('native plugin directory unexpectedly populated')
 os.replace(plugin,plugins/'opencode.so');(plugins/'opencode.so').chmod(0o700)
 (NEW/'state').mkdir(exist_ok=True,mode=0o700)
 current,etag=api('config/plugins')
 if current['enabled']:raise RuntimeError('plugin state changed during handoff')
 next_config={'enabled':True,'dir':str(plugins),'configs':{'opencode':{'enabled':True,'preserve_unsigned_thinking':True,'inference_base_url':'https://opencode.ai/inference/openai/v1','models':['beam-free'],'app_name':'cli','version':'2.1.4','channel':'latest','project_id':'global','session_state_path':str(NEW/'state/opencode-sessions.json')}}}
 api('config/plugins','PUT',next_config,etag)
 os.replace(pending,NEW/'auth/opencode-staging.json')
 end=time.monotonic()+15
 client=(NEW/'secrets/client-api-key').read_text().strip()
 while True:
  req=urllib.request.Request(BASE+'/v1/models',headers={'Authorization':'Bearer '+client})
  with opener.open(req,timeout=3) as r: models=json.load(r)
  if any(m.get('id')=='beam-free' for m in models.get('data',[])):break
  if time.monotonic()>end:raise RuntimeError('new owner did not publish model; old remains retired')
  time.sleep(.2)
 report.update(phase='complete',activated=True,model='beam-free',single_refresh_owner=True)
 atomic(NEW/'opencode-owner-handoff.json',report)
 print(json.dumps(report))

if __name__=='__main__':
 try:main()
 except Exception:print(json.dumps({'status':'blocked','detail':'Handoff refused or interrupted; inspect private phase journal. No automatic restart/retry.'}));raise SystemExit(2)
