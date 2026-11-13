#!/usr/bin/env python3
"""One-shot reviewed native identity rollout. Coolify token on stdin only.
No inference, credential copies, redirects, retries or broad config replacement.
"""
import argparse,copy,fcntl,hashlib,ipaddress,json,os,shutil,sys,time,urllib.request
from pathlib import Path
R=Path('/home/agent/cliproxy-staging');APP='iog8gk8g8o0s44840g4o4sso'
OLD='6d3e3525aacf372b02cce8bebd770b983e9728afe27361c95977422c5c52f7a6'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def clean(v):
 if isinstance(v,dict):return {k:clean(x) for k,x in v.items() if k not in ['auth-index','auth_index']}
 if isinstance(v,list):return [clean(x) for x in v]
 return v
def main():
 os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('--native-sha',required=True);p.add_argument('--source',required=True);a=p.parse_args()
 token=json.load(sys.stdin)['token'];key=(R/'secrets/management.key').read_text().strip()
 lock=(R/'state/freehub-deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 journal=R/'model-identities-deployment-v1.json';target=R/'bin/cli-proxy-api';pending=R/'model-identities-native.pending';backup=R/'bin/cli-proxy-api-before-identities'
 if journal.exists() or backup.exists():raise RuntimeError('existing operation; inspect, never replay')
 if sha(target)!=OLD or sha(pending)!=a.native_sha:raise RuntimeError('native artifact differs')
 runtime=(R/'state/coolify-runtime.lock').open('r')
 def held():
  try:fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return True
  fcntl.flock(runtime,fcntl.LOCK_UN);return False
 if not held():raise RuntimeError('existing owner absent')
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def origin():
  ip=next(x for x in (R/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(x).version==4)
  if not ipaddress.ip_address(ip).is_private:raise RuntimeError('unexpected origin')
  return 'http://'+ip+':8080'
 def req(url,secret,method='GET',body=None,etag=None):
  h={'Authorization':'Bearer '+secret,'Content-Type':'application/json'}
  if etag:h['If-Match']=etag
  if url.startswith('http://127.0.0.1:8000'):h['Host']='panel.nothing.pink'
  q=urllib.request.Request(url,method=method,headers=h,data=None if body is None else json.dumps(body).encode())
  with op.open(q,timeout=25) as response:return json.load(response),response.headers.get('ETag')
 def api(path,method='GET',body=None,etag=None):return req(origin()+path,key,method,body,etag)
 def cool(path,method='GET'):return req('http://127.0.0.1:8000/api/v1/'+path,token,method)[0]
 config=api('/v8/management/config')[0];client=config['access']['api-keys'][0]
 rows=req(origin()+'/v1/models',client)[0]['data'];original_ids={m['id'] for m in rows}
 expected=['llm7-llm7/GLM-5.3-Flash','orca/z-ai/glm-5.3-flash-free','requesty/nvidia/nemotron-3.5-lightning-30b-a3b','kilo-kilo/nvidia/nemotron-3.5-lightning:free','openrouter/nemotron-3.5-lightning-free']
 if not set(expected)<=original_ids:raise RuntimeError('reviewed source models unavailable')
 state_path=Path(config['plugins']['configs']['free-model-hub']['state_dir'])/'state.json'
 aliases=json.loads(state_path.read_text()).get('model_aliases',{})
 if aliases.get('llm7:llm7/GLM-5.3-Flash') not in [None,'glm-5.3-flash']:raise RuntimeError('operator GLM alias already set')
 protected=[R/'plugins/opencode.so',R/'plugins/free-model-hub.so',R/'config/static/management.html']
 protected += [x for x in (R/'auth').glob('*.json') if json.loads(x.read_text()).get('type')=='opencode']
 protected += list(R.glob('*live*.json'))
 hashes={str(p):sha(p) for p in protected};auth_names={p.name for p in (R/'auth').glob('*.json')}
 result={'phase':'prepared','source_commit':a.source,'backend_sha256':a.native_sha,'freehub_sha256':sha(R/'plugins/free-model-hub.so'),'provider_inference_requests':0,'login_requests':0}
 def save():journal.write_text(json.dumps(result,indent=2)+'\n')
 with journal.open('x') as h:json.dump(result,h)
 try:
  # Existing plugin's scoped alias API persists one vendor alias. It keeps the
  # qualified ID, uses current catalog presence, and never touches credentials.
  api('/v0/management/plugins/free-model-hub/models/alias','POST',{'model':'llm7:llm7/GLM-5.3-Flash','alias':'glm-5.3-flash'})
  if json.loads(state_path.read_text()).get('model_aliases',{})!={**aliases,'llm7:llm7/GLM-5.3-Flash':'glm-5.3-flash'}:raise RuntimeError('plugin alias state differs')
  result['phase']='plugin_alias_configured';save()
  cool('applications/'+APP+'/stop?docker_cleanup=false','POST');deadline=time.monotonic()+90
  while held():
   if time.monotonic()>deadline:raise RuntimeError('owner did not stop')
   time.sleep(1)
  fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB);shutil.copyfile(target,backup);backup.chmod(0o700);os.replace(pending,target);target.chmod(0o700);fcntl.flock(runtime,fcntl.LOCK_UN)
  deployment=cool('applications/'+APP+'/start','POST').get('deployment_uuid')
  if not deployment:raise RuntimeError('missing deployment identity')
  result.update(phase='native_swapped',deployment_uuid=deployment);save();deadline=time.monotonic()+360
  while time.monotonic()<deadline:
   status=cool('deployments/'+deployment).get('status')
   if status=='finished':break
   if status in ['failed','cancelled']:raise RuntimeError('Coolify deploy failed')
   time.sleep(3)
  else:raise RuntimeError('Coolify pending; inspect journal')
  if not held() or not api('/healthz')[0]:raise RuntimeError('new owner unhealthy')
  leaf='/v8/management/config/api-keys/openai-compatibility'
  before,etag=api(leaf);updated=copy.deepcopy(before)
  rules={'openrouter':('nvidia/nemotron-3.5-lightning:free','nemotron-3.5-lightning'),'requesty':('nvidia/nemotron-3.5-lightning-30b-a3b','nemotron-3.5-lightning'),'orcarouter':('z-ai/glm-5.3-flash-free','glm-5.3-flash')}
  found=set()
  for provider in updated:
   name=provider['name'].lower()
   if name not in rules:continue
   source,alias=rules[name];found.add(name);d=provider.get('model-discovery',{})
   if not d.get('enabled') or not d.get('free-only'):raise RuntimeError('free discovery is not enabled')
   current=d.setdefault('aliases',[])
   if any(m.get('alias')==alias and m.get('name')!=source for m in current):raise RuntimeError('discovery alias conflict')
   if not any(m.get('alias')==alias and m.get('name')==source for m in current):current.append({'name':source,'alias':alias,'is-compat':True})
   if name=='openrouter':
    # Move only the old reviewed canonical row into catalog-backed aliases.
    provider['models']=[m for m in provider['models'] if not (m.get('alias')==alias and m.get('name')==source)]
  if found!=set(rules):raise RuntimeError('provider identity changed')
  api(leaf,'PUT',updated,etag);result['phase']='identity_rules_configured';save()
  deadline=time.monotonic()+100
  while True:
   rows=req(origin()+'/v1/models',client)[0]['data'];byid={m['id']:m for m in rows}
   glm=byid.get('glm-5.3-flash',{});light=byid.get('nemotron-3.5-lightning',{})
   if set(glm.get('providers',[]))=={'freehub','openai-compatible-orcarouter'} and set(light.get('providers',[]))=={'freehub','openai-compatible-openrouter','openai-compatible-requesty'} and set(expected)<=set(byid):break
   if time.monotonic()>deadline:raise RuntimeError('canonical publication incomplete')
   time.sleep(1)
  actual=api('/v8/management/config')[0]
  if clean(actual.get('api-keys',{}).get('openai-compatibility'))!=clean(updated):raise RuntimeError('identity config differs')
  before_rest=copy.deepcopy(config);after_rest=copy.deepcopy(actual)
  before_rest['api-keys'].pop('openai-compatibility');after_rest['api-keys'].pop('openai-compatibility')
  if clean(before_rest)!=clean(after_rest):raise RuntimeError('unrelated config changed')
  if any(sha(Path(p))!=value for p,value in hashes.items()):raise RuntimeError('protected state changed')
  if not auth_names<={p.name for p in (R/'auth').glob('*.json')}:raise RuntimeError('account removed')
  result.update(phase='deployed',one_native_owner=True,canonical_models={m:byid[m] for m in ['glm-5.3-flash','nemotron-3.5-lightning']},qualified_source_ids_preserved=True,unrelated_config_preserved=True,protected_state_preserved=True,all_original_ids_preserved=original_ids<=set(byid),model_count=len(rows),new_alias_ids=sorted(set(byid)-original_ids),runtime_claim='Published and isolated-host verified; no new live inference or all-model parity claim.')
  save();print(json.dumps(result),flush=True)
 except Exception as e:
  result.update(phase='failed',error_type=type(e).__name__);save();print(json.dumps({'phase':'failed','error_type':type(e).__name__,'journal':str(journal)}));raise
if __name__=='__main__':main()
