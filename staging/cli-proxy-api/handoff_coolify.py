#!/usr/bin/env python3
"""One sequential native host -> existing Coolify app handoff. VPS-only.
Reviewed artifact hashes and API token arrive via private stdin; never printed.
No OAuth credential/database copying, provider inference or refresh calls.
"""
import fcntl,hashlib,json,os,pathlib,sys,time,urllib.request
ROOT=pathlib.Path('/home/agent/cliproxy-staging');APP='iog8gk8g8o0s44840g4o4sso'
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as source:
  for block in iter(lambda:source.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def atomic(path,data):
 temp=path.with_name(path.name+'.pending')
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 os.replace(temp,path);fd=os.open(path.parent,os.O_RDONLY);os.fsync(fd);os.close(fd)
def main():
 import yaml
 os.umask(0o077);p=json.load(sys.stdin);sys.path.insert(0,str(ROOT));import cliproxy_lifecycle as life
 owner=life.lock_root(ROOT);journal=ROOT/'coolify-owner-handoff.json';ready=ROOT/'state/coolify-owner.ready'
 if journal.exists() or ready.exists():raise RuntimeError('Handoff already recorded; inspect instead of replay')
 binary=ROOT/'bin/cli-proxy-api';config=ROOT/'config/config.yaml';panel=ROOT/'config/static/management.html'
 candidate=ROOT/'bin/cli-proxy-api-cloudflare.pending';candidate_panel=ROOT/'config/static/management-cloudflare.pending.html'
 if digest(binary)!='e19d936e7bb82b6e4d200e972386e073d2647e386950ef41aab842a45ccefeb4':raise RuntimeError('Unexpected current backend')
 if digest(candidate)!=p['binary_sha256'] or digest(candidate_panel)!=p['panel_sha256']:raise RuntimeError('Candidate artifact hash differs')
 record=life.load_record(ROOT)
 if not life.identity_matches(record,binary,config):raise RuntimeError('Host process ownership differs')
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}));key=(ROOT/'secrets/management.key').read_text().strip()
 def get(url,key,host=None):
  headers={'Authorization':'Bearer '+key}
  if host:headers['Host']=host
  with op.open(urllib.request.Request(url,headers=headers),timeout=20) as r:return json.load(r)
 files=get('http://100.74.55.86:4195/v0/management/auth-files',key)['files'];credentials=[x for x in files if x.get('provider')=='opencode']
 if len(credentials)!=1 or not credentials[0].get('disabled'):raise RuntimeError('OpenCode must remain quarantined')
 # Read only the existing API client-key value from authorized app environment;
 # native OAuth stays in its existing auth-dir, never in this migration payload.
 envs=get('http://127.0.0.1:8000/api/v1/applications/'+APP+'/envs',p['coolify_token'],'panel.nothing.pink')
 legacy=[x['value'] for x in envs if x.get('key')=='TOKLIGENCE_AUTH_SECRET' and not x.get('is_preview')]
 if len(legacy)!=1 or not legacy[0]:raise RuntimeError('Existing production client authentication is unavailable')
 cfg=yaml.safe_load(config.read_text());current_keys=cfg['access']['api-keys'];report_files=[ROOT/'cliproxy-opencode-live-20261102-v1.json',ROOT/'cliproxy-openrouter-live-20261102-v1.json']
 for existing in [ROOT/'coolify-before-alpha/native-config.yaml',ROOT/'coolify-before-alpha/native-panel.html',ROOT/'bin/cli-proxy-api-pre-coolify']:
  if existing.exists():raise RuntimeError('Rollback artifact already exists; inspect prior operation')
 report={'phase':'prepared','app_uuid':APP,'source_commit':p['source_commit'],'old_backend_sha256':digest(binary),'binary_sha256':p['binary_sha256'],'panel_sha256':p['panel_sha256'],'live_evidence':{str(f.relative_to(ROOT)):digest(f) for f in report_files},'provider_inference_requests':0,'credential_quarantined':True,'oauth_copied':False}
 journal.write_text(json.dumps(report,indent=2))
 if not life.terminate_verified(int(record['pid']),force=False):raise RuntimeError('Owned host process did not stop; refusing container ownership')
 (ROOT/life.RECORD_NAME).unlink()
 fd=os.open(ROOT/'state/opencode-sessions.json.lock',os.O_RDONLY)
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 finally:os.close(fd)
 backup=ROOT/'coolify-before-alpha'
 for name,source in [('native-config.yaml',config),('native-panel.html',panel)]:
  target=backup/name
  if target.exists():raise RuntimeError('Rollback artifact exists')
  target.write_bytes(source.read_bytes());target.chmod(0o600)
 prior=ROOT/'bin/cli-proxy-api-pre-coolify'
 if prior.exists():raise RuntimeError('Backend rollback artifact exists')
 os.replace(binary,prior);os.replace(candidate,binary);binary.chmod(0o700)
 cfg['server']['host']='0.0.0.0';cfg['server']['port']=8080
 if legacy[0] not in current_keys:current_keys.append(legacy[0])
 atomic(config,yaml.safe_dump(cfg,sort_keys=False).encode());os.replace(candidate_panel,panel);panel.chmod(0o600)
 report.update(phase='container_ready',old_host_stopped=True,legacy_client_key_preserved=True)
 journal.write_text(json.dumps(report,indent=2));atomic(ready,(p['source_commit']+'\n').encode())
 print(json.dumps({k:v for k,v in report.items() if k!='live_evidence'}))
if __name__=='__main__':main()
