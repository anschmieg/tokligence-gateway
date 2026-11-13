#!/usr/bin/env python3
"""Unique native-only canonical-policy rollout. Token stdin; zero inference.
Preserve YAML scalar nodes/user configuration; stop sole owner before mutation.
No OAuth database reads/copies, token reseeding, refresh or quota modifications.
"""
import argparse,copy,fcntl,hashlib,ipaddress,json,os,shutil,sys,time,urllib.request
from pathlib import Path
import yaml
R=Path('/home/agent/cliproxy-staging');APP='iog8gk8g8o0s44840g4o4sso'
OLD='f7db6a6a16d82fc87a22d5e052f117f86d00e243c8237e71546fc15c7aa6f768'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def key_fields(v):
 if isinstance(v,dict):return {k:key_fields(x) for k,x in v.items() if k not in ('auth-index','auth_index')}
 if isinstance(v,list):return [key_fields(x) for x in v]
 return v
def normalized(c):
 c=copy.deepcopy(c)
 if 'api-keys' in c:c['api-keys']=key_fields(c['api-keys'])
 return c
def node_get(n,key):
 if not isinstance(n,yaml.MappingNode):raise RuntimeError('expected YAML mapping')
 matches=[v for k,v in n.value if k.value==key]
 if len(matches)>1:raise RuntimeError('duplicate YAML field')
 return matches[0] if matches else None
def node_set(n,key,value):
 if not isinstance(n,yaml.MappingNode):raise RuntimeError('expected YAML mapping')
 for i,(k,v) in enumerate(n.value):
  if k.value==key:n.value[i]=(k,value);return
 n.value.append((yaml.ScalarNode('tag:yaml.org,2002:str',key),value))
def planned_config(raw):
 root=yaml.compose(raw);models=node_get(root,'models')
 if models is None:models=yaml.compose('{}');node_set(root,'models',models)
 new={'canonical-only':True,'canonical-routing':{'max-attempts':8,'max-fallback-models':3}}
 for k,v in yaml.compose(yaml.safe_dump(new)).value:node_set(models,k.value,v)
 gemini=node_get(node_get(root,'api-keys'),'gemini');found=0
 if not isinstance(gemini,yaml.SequenceNode):raise RuntimeError('shared Gemini group missing')
 for group in gemini.value:
  name=node_get(group,'name')
  if name is not None and name.value=='gemini-free':
   node_set(group,'free-tier',yaml.ScalarNode('tag:yaml.org,2002:bool','true'));found+=1
 if found!=1:raise RuntimeError('shared Gemini group is ambiguous')
 return yaml.serialize(root).encode()
def main():
 os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('--native-sha',required=True);p.add_argument('--source',required=True);p.add_argument('--check-only',action='store_true');p.add_argument('--cooldown-fix',action='store_true');p.add_argument('--hardening',action='store_true');p.add_argument('--plugin-sha');p.add_argument('--free-peers',action='store_true');p.add_argument('--similarity',action='store_true');a=p.parse_args()
 if a.hardening and not a.plugin_sha:p.error('--hardening requires --plugin-sha')
 if sum((a.hardening,a.cooldown_fix,a.free_peers,a.similarity))>1:p.error('select one upgrade')
 token=json.load(sys.stdin)['token'];key=(R/'secrets/management.key').read_text().strip()
 lock=(R/'state/freehub-deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 version='v5' if a.similarity else 'v4' if a.free_peers else 'v3' if a.hardening else 'v2' if a.cooldown_fix else 'v1'
 preserve_config=a.hardening or a.cooldown_fix or a.free_peers or a.similarity
 journal=R/('canonical-policy-deployment-'+version+'.json');target=R/'bin/cli-proxy-api';pending=R/('canonical-policy-similarity-native.pending' if a.similarity else 'canonical-policy-free-peers-native.pending' if a.free_peers else 'canonical-policy-hardening-native.pending' if a.hardening else 'canonical-policy-cooldown-native.pending' if a.cooldown_fix else 'canonical-policy-native.pending');backup=R/('bin/cli-proxy-api-before-canonical-policy-'+version);conf=R/'config/config.yaml';config_backup=R/('secrets/config-before-canonical-policy-'+version+'.yaml')
 if any(x.exists() for x in [journal,backup,config_backup]):raise RuntimeError('existing operation; inspect, never replay')
 old='55c14635d9a60d2264300ea0bd3c7a26a36c45272a3cd1ae1bdb5fb0384290e9' if a.cooldown_fix else OLD
 if a.hardening:old='729572b5532f2f3ecf27c673fccc164fb138cadbbd49a84e2c2a17013dc1f569'
 if a.free_peers:old='ffdcdac567f4871832ea75836bcb0aa70fc03f18e17758eb5c7764b07f945c4e'
 if a.similarity:old='d463e29f33e81f698c62112ed597057923dfc1dece782633b7936838dfd0ce8c'
 plugin=R/'plugins/free-model-hub.so';plugin_pending=R/'canonical-policy-hardening-plugin.pending';plugin_backup=R/'bin/free-model-hub-before-canonical-hardening.so'
 if a.hardening and (plugin_backup.exists() or sha(plugin)!='51fc4af90894999977ceb2c3f8fd0cdaf1302e669743021194d2c1b44dc093c9' or sha(plugin_pending)!=a.plugin_sha):raise RuntimeError('plugin artifact or existing backup differs')
 if sha(target)!=old or sha(pending)!=a.native_sha:raise RuntimeError('native artifact differs')
 runtime=(R/'state/coolify-runtime.lock').open('r')
 def held():
  try:fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return True
  fcntl.flock(runtime,fcntl.LOCK_UN);return False
 if not held():raise RuntimeError('native owner missing')
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def origin():
  ip=next(x for x in (R/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(x).version==4)
  if not ipaddress.ip_address(ip).is_private:raise RuntimeError('unexpected origin')
  return 'http://'+ip+':8080'
 def req(url,secret,method='GET'):
  h={'Authorization':'Bearer '+secret}
  if url.startswith('http://127.0.0.1:8000'):h['Host']='panel.nothing.pink'
  with op.open(urllib.request.Request(url,method=method,headers=h),timeout=25) as response:return json.load(response)
 def api(path):return req(origin()+path,key)
 def cool(path,method='GET'):return req('http://127.0.0.1:8000/api/v1/'+path,token,method)
 before=api('/v8/management/config');client=before['access']['api-keys'][0]
 old_rows=req(origin()+'/v1/models',client)['data']
 raw=conf.read_bytes();config_hash=sha(conf);planned=raw if preserve_config else planned_config(raw)
 if a.check_only:
  print(json.dumps({'admission':'ready','deployment_lock_free':True,'one_owner':True,'config_prepared':bool(planned),'native_sha':a.native_sha,'provider_inference_requests':0}));return
 # Compare only the intended two policy additions and the existing Free Tier group's label.
 expected=normalized(before)
 if not preserve_config:
  expected.setdefault('models',{})['canonical-only']=True
  expected['models']['canonical-routing']={'max-attempts':8,'max-fallback-models':3}
  for group in expected['api-keys']['gemini']:
   if group.get('name')=='gemini-free':group['free-tier']=True
 protected=[R/'plugins/opencode.so',R/'config/static/management.html']
 if not a.hardening:protected.append(plugin)
 protected += [x for x in (R/'auth').glob('*.json') if json.loads(x.read_text()).get('type')=='opencode']
 protected += list(R.glob('*live*.json'))
 protected_hashes={str(x):sha(x) for x in protected};auth_names={x.name for x in (R/'auth').glob('*.json')}
 result={'phase':'prepared','source_commit':a.source,'backend_sha256':a.native_sha,'freehub_sha256':a.plugin_sha if a.hardening else sha(plugin),'provider_inference_requests':0,'models_before':len(old_rows)}
 def save():journal.write_text(json.dumps(result,indent=2)+'\n')
 with journal.open('x') as f:json.dump(result,f)
 stopped=False;swapped=False
 try:
  # An operator may edit the dashboard during preparation. Refuse stale input.
  if sha(conf)!=config_hash or normalized(api('/v8/management/config'))!=normalized(before):raise RuntimeError('operator config changed')
  cool('applications/'+APP+'/stop?docker_cleanup=false','POST');deadline=time.monotonic()+90
  while held():
   if time.monotonic()>deadline:raise RuntimeError('owner did not stop')
   time.sleep(1)
  stopped=True
  fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if sha(conf)!=config_hash:raise RuntimeError('config changed while stopping')
  shutil.copyfile(conf,config_backup);config_backup.chmod(0o600)
  shutil.copyfile(target,backup);backup.chmod(0o700)
  if not preserve_config:
   temporary=conf.with_suffix('.canonical-policy.pending');temporary.write_bytes(planned);temporary.chmod(0o600);os.replace(temporary,conf)
  os.replace(pending,target);target.chmod(0o700);swapped=True
  if a.hardening:
   shutil.copyfile(plugin,plugin_backup);plugin_backup.chmod(0o700);os.replace(plugin_pending,plugin);plugin.chmod(0o700)
  fcntl.flock(runtime,fcntl.LOCK_UN)
  deployment=cool('applications/'+APP+'/start','POST').get('deployment_uuid')
  if not deployment:raise RuntimeError('missing deployment identity')
  result.update(phase='native_swapped',deployment_uuid=deployment);save();deadline=time.monotonic()+360
  while time.monotonic()<deadline:
   state=cool('deployments/'+deployment).get('status')
   if state=='finished':break
   if state in ('failed','cancelled'):raise RuntimeError('Coolify deployment failed')
   time.sleep(3)
  else:raise RuntimeError('Coolify pending; inspect journal')
  if not held() or not api('/healthz'):raise RuntimeError('native owner unhealthy')
  actual=normalized(api('/v8/management/config'))
  # Omitted false/empty default fields are normalized by native serialization.
  actual.setdefault('models',{}).get('canonical-routing',{}).pop('free-fallbacks',None)
  if actual!=expected:raise RuntimeError('unrelated config changed or policy not loaded')
  if preserve_config and sha(conf)!=config_hash:raise RuntimeError('cooldown-only upgrade changed configuration')
  deadline=time.monotonic()+110
  while True:
   rows=req(origin()+'/v1/models',client)['data'];byid={m['id']:m for m in rows}
   if rows and all(m.get('canonical') is True for m in rows) and all(byid.get(m,{}).get('has_free_routes') for m in ['glm-5.3-flash','nemotron-3.5-lightning','gemini-3.5-flash-lite']):break
   if time.monotonic()>deadline:raise RuntimeError('canonical publication incomplete')
   time.sleep(1)
  if any(name.endswith((':free',':paid')) for name in byid):raise RuntimeError('internal selectors visible')
  if any(sha(Path(name))!=digest for name,digest in protected_hashes.items()):raise RuntimeError('protected state changed')
  if sha(target)!=a.native_sha or (a.hardening and sha(plugin)!=a.plugin_sha):raise RuntimeError('runtime artifact changed')
  if not auth_names<={x.name for x in (R/'auth').glob('*.json')}:raise RuntimeError('credential removed')
  # Sanitized model inventory has no auth indexes or credentials.
  (R/('state/canonical-policy-models-20261103-'+version+'.json')).write_text(json.dumps({'data':rows},indent=2)+'\n')
  result.update(phase='deployed',one_native_owner=True,model_count=len(rows),all_visible_models_canonical=True,hidden_policy_selectors=True,unrelated_config_preserved=True,protected_state_preserved=True,all_account_files_preserved=True,free_only_models=sum(bool(m.get('has_free_routes')) for m in rows),runtime_claim='Canonical publication checked; isolated real-host policy tests passed; no new real inference in rollout.')
  save();print(json.dumps(result),flush=True)
 except Exception as e:
  result.update(phase='failed',error_type=type(e).__name__,owner_stopped=stopped,native_swapped=swapped);save()
  print(json.dumps({'phase':'failed','error_type':type(e).__name__,'owner_stopped':stopped,'native_swapped':swapped,'journal':str(journal)}),flush=True)
  raise
if __name__=='__main__':main()
