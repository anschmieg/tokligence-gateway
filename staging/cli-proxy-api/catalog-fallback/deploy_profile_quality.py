#!/usr/bin/env python3
"""One-shot task-profile quality preference rollout. Run on the existing gateway owner.
Token arrives on stdin, never argv/logs. No inference, account writes or OAuth copy.
"""
import argparse,copy,fcntl,hashlib,ipaddress,json,os,shutil,sys,time,urllib.request
from pathlib import Path
import yaml
ROOT=Path('/home/agent/cliproxy-staging')
APP='iog8gk8g8o0s44840g4o4sso'
OLD='989f50db280424ce8ef41cdec406134f0f19d6a3cf78604ec5c14cd64993203e'
JOURNAL=ROOT/'profile-quality-deployment-v1.json'
BINARY=ROOT/'bin/cli-proxy-api'
PENDING=ROOT/'bin/profile-quality-v1.pending'
CONFIG=ROOT/'config/config.yaml'
BACKUP_BIN=ROOT/'bin/cli-proxy-api-before-profile-quality-v1'
BACKUP_CFG=ROOT/'secrets/config-before-profile-quality-v1.yaml'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def find(node,key):
 if not isinstance(node,yaml.MappingNode):raise RuntimeError('expected mapping')
 values=[v for k,v in node.value if k.value==key]
 if len(values)>1:raise RuntimeError('duplicate configuration field')
 return values[0] if values else None
def setnode(node,key,value):
 for i,(k,v) in enumerate(node.value):
  if k.value==key:node.value[i]=(k,value);return
 node.value.append((yaml.ScalarNode('tag:yaml.org,2002:str',key),value))
def planned(raw):
 node=yaml.compose(raw);routing=find(find(node,'models'),'canonical-routing');profiles=find(routing,'profiles');additions={}
 for name,model in [('chat','nemotron-3-ultra-550b-a55b'),('coding','glm-5.3-flash')]:
  existing=find(profiles,name)
  if existing is None:raise RuntimeError('existing profile missing')
  data=yaml.safe_load(yaml.serialize(existing));data['preferred-model']=model;setnode(profiles,name,yaml.compose(yaml.safe_dump(data)));additions[name]=data
 result=yaml.serialize(node).encode();expected=copy.deepcopy(yaml.safe_load(raw))
 for name,data in additions.items():expected['models']['canonical-routing']['profiles'][name]['preferred-model']=data['preferred-model']
 if yaml.safe_load(result)!=expected:raise RuntimeError('configuration scope differs')
 return result,{},additions
def normalized(value):
 if isinstance(value,dict):return {k:normalized(v) for k,v in value.items() if k not in ('auth_index','auth-index')}
 if isinstance(value,list):return [normalized(v) for v in value]
 return value
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def main():
 os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('--native-sha',required=True);p.add_argument('--source',required=True);p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if len(a.native_sha)!=64 or any(c not in '0123456789abcdef' for c in a.native_sha+a.source):raise RuntimeError('invalid artifact identity')
 token=json.load(sys.stdin)['token'];key=(ROOT/'secrets/management.key').read_text().strip()
 lock=(ROOT/'state/freehub-deployment.lock').open('r+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if JOURNAL.exists() or BACKUP_BIN.exists() or BACKUP_CFG.exists():raise RuntimeError('existing operation; inspect, never replay')
 if sha(BINARY)!=OLD or not PENDING.exists() or sha(PENDING)!=a.native_sha:raise RuntimeError('artifact admission differs')
 runtime=(ROOT/'state/coolify-runtime.lock').open('r')
 def held():
  try:fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return True
  fcntl.flock(runtime,fcntl.LOCK_UN);return False
 if not held():raise RuntimeError('native owner absent')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 def origin():
  ip=next(x for x in (ROOT/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(x).version==4)
  if not ipaddress.ip_address(ip).is_private:raise RuntimeError('unexpected origin')
  return 'http://'+ip+':8080'
 def req(url,secret,method='GET'):
  headers={'Authorization':'Bearer '+secret}
  if url.startswith('http://127.0.0.1:8000'):headers['Host']='panel.nothing.pink'
  with opener.open(urllib.request.Request(url,headers=headers,method=method),timeout=25) as res:return json.load(res)
 def api(path):return req(origin()+path,key)
 def cool(path,method='GET'):return req('http://127.0.0.1:8000/api/v1/'+path,token,method)
 before=api('/v8/management/config');client=before['access']['api-keys'][0]
 rows_before=req(origin()+'/v1/models',client)['data'];ids_before={m['id'] for m in rows_before}
 raw=CONFIG.read_bytes();config_hash=sha(CONFIG);updated,values,additions=planned(raw);new_hash=hashlib.sha256(updated).hexdigest()
 expected=copy.deepcopy(before);routing=expected.setdefault('models',{}).setdefault('canonical-routing',{});routing.update(values);routing.setdefault('profiles',{}).update(additions)
 protected=[ROOT/'plugins/opencode.so',ROOT/'plugins/free-model-hub.so',ROOT/'config/static/management.html']
 for path in (ROOT/'auth').glob('*.json'):
  if json.loads(path.read_text()).get('type')=='opencode':protected.append(path)
 protected+=list(ROOT.glob('*live*.json'))
 ledger=Path('/home/agent/tokligence-staging/live-probe-ledger.json')
 if ledger.exists():protected.append(ledger)
 protected_hashes={str(path):sha(path) for path in protected};auth_names={x.name for x in (ROOT/'auth').glob('*.json')}
 if a.check_only:
  print(json.dumps({'admission':'ready','one_owner':True,'scope':'native artifact and additive metadata/profile configuration only','models_before':len(rows_before),'provider_inference_requests':0}));return
 result={'phase':'prepared','source_commit':a.source,'native_sha256':a.native_sha,'provider_inference_requests':0,'models_before':len(rows_before),'default_billing_policy':'SUB','profile_cost_policy':'session'}
 def save():JOURNAL.write_text(json.dumps(result,indent=2)+'\n')
 with JOURNAL.open('x') as f:json.dump(result,f)
 stopped=False;swapped=False;runtime_owned=False;start_pending=False
 def stop_owner():
  nonlocal stopped,runtime_owned
  if runtime_owned:return
  stopped=True
  cool('applications/'+APP+'/stop?docker_cleanup=false','POST');deadline=time.monotonic()+90
  while held():
   if time.monotonic()>deadline:raise RuntimeError('owner did not stop')
   time.sleep(1)
  fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB);runtime_owned=True
 def start_owner():
  nonlocal runtime_owned,start_pending
  fcntl.flock(runtime,fcntl.LOCK_UN);runtime_owned=False;start_pending=True
  deployment=cool('applications/'+APP+'/start','POST').get('deployment_uuid')
  if not deployment:raise RuntimeError('missing deployment identity')
  result['deployment_uuid']=deployment;save();deadline=time.monotonic()+360
  while time.monotonic()<deadline:
   status=cool('deployments/'+deployment).get('status')
   if status=='finished':
    start_pending=False;return
   if status in ('failed','cancelled'):
    start_pending=False;raise RuntimeError('deployment failed')
   time.sleep(3)
  raise RuntimeError('deployment pending; inspect journal')
 try:
  if sha(CONFIG)!=config_hash or normalized(api('/v8/management/config'))!=normalized(before):raise RuntimeError('operator configuration changed')
  stop_owner();stopped=True
  if sha(CONFIG)!=config_hash:raise RuntimeError('configuration changed while stopping')
  shutil.copyfile(CONFIG,BACKUP_CFG);BACKUP_CFG.chmod(0o600);shutil.copyfile(BINARY,BACKUP_BIN);BACKUP_BIN.chmod(0o700)
  temporary=CONFIG.with_suffix('.profile-quality.pending');temporary.write_bytes(updated);temporary.chmod(0o600);os.replace(temporary,CONFIG)
  os.replace(PENDING,BINARY);BINARY.chmod(0o700);swapped=True;result['phase']='swapped';save()
  start_owner()
  if not held() or not api('/healthz'):raise RuntimeError('native owner unhealthy')
  if normalized(api('/v8/management/config'))!=normalized(expected) or sha(CONFIG)!=new_hash:raise RuntimeError('configuration not preserved')
  deadline=time.monotonic()+150
  while True:
   rows=req(origin()+'/v1/models',client)['data'];profile=req(origin()+'/coding/v1/models',client)
   if rows and profile.get('data') and not profile.get('evidence_stale'):break
   if time.monotonic()>deadline:raise RuntimeError('curated profile not ready')
   time.sleep(3)
  ids={m['id'] for m in rows};profile_ids={m['id'] for m in profile['data']}
  if not profile_ids<=ids or profile.get('cost_policy')!='session':raise RuntimeError('profile contract differs')
  byid={row['id']:row for row in rows}
  if not all(byid.get(name,{}).get('virtual') and byid[name].get('default_billing_policy')=='SUB' for name in ('chat','coding')):raise RuntimeError('profile aliases not published')
  if not all(byid[name].get('preferred_model')==additions[name]['preferred-model'] for name in ('chat','coding')):raise RuntimeError('alias preference not updated')
  if profile.get('preferred_model')!=additions['coding']['preferred-model']:raise RuntimeError('curated preference not disclosed')
  if api('/healthz') is None:raise RuntimeError('health unavailable')
  with opener.open(urllib.request.Request(origin()+'/v1/routing/session?profile=chat',headers={'Authorization':'Bearer '+client,'X-Gateway-Session':'deployment-readonly-check-v1'}),timeout=15) as response:control=json.load(response)
  if control.get('policy')!='SUB':raise RuntimeError('session default differs')
  if any(sha(Path(path))!=digest for path,digest in protected_hashes.items()):raise RuntimeError('protected state changed')
  if auth_names!={x.name for x in (ROOT/'auth').glob('*.json')}:raise RuntimeError('account inventory changed')
  result.update(phase='deployed',one_native_owner=True,model_count=len(rows),profile_model_count=len(profile_ids),profile_ids=sorted(profile_ids),old_catalog_ids_retained=len(ids_before-ids)==0,withdrawn_catalog_ids=sorted(ids_before-ids),unrelated_config_preserved=True,accounts_preserved=True,protected_state_preserved=True,aliases=['chat','coding'],preferred_models={name:data['preferred-model'] for name,data in additions.items()},session_control_default='SUB',public_ingress_verified=False,live_provider_evaluation=False)
  save();print(json.dumps(result),flush=True)
 except Exception as error:
  result.update(phase='failed',error_type=type(error).__name__,native_swapped=swapped);save()
  # Roll back only our exact config generation; never overwrite concurrent
  # operator edits or restore OAuth files/tokens to an earlier generation.
  try:
   if start_pending:
    result['rollback']='pending_Coolify_operation_requires_parent_inspection'
   elif swapped and sha(CONFIG)==new_hash:
    stop_owner();shutil.copyfile(BACKUP_BIN,BINARY);BINARY.chmod(0o700);shutil.copyfile(BACKUP_CFG,CONFIG);CONFIG.chmod(0o600);start_owner();result['rollback']='restored_previous_native_and_config'
   elif runtime_owned or (stopped and not held()):start_owner();result['rollback']='owner_restarted'
   else:result['rollback']='preserved_current_owner_and_operator_configuration'
  except Exception as rollback_error:result['rollback']='requires_parent_recovery';result['rollback_error_type']=type(rollback_error).__name__
  save();print(json.dumps(result),flush=True);raise SystemExit(1)
if __name__=='__main__':main()
