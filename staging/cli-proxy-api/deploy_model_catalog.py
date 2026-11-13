#!/usr/bin/env python3
"""One-shot catalog/routing or opt-in discovery deployment, no provider inference.

Preserves user configuration; adds one model alias to the current OpenRouter
list with If-Match. Runtime lifetime flock prevents two OAuth refresh owners.
Coolify token is consumed on stdin, never stored or printed. Never replay journal.
"""
import argparse,copy,fcntl,hashlib,ipaddress,json,os,shutil,sys,time,urllib.request
from pathlib import Path
ROOT=Path('/home/agent/cliproxy-staging')
APP='iog8gk8g8o0s44840g4o4sso'
OLD_NATIVE='a8359602b94cb042a5b812750d3742f6ad146bda743b16726ade159e1167bfc0'
OLD_PLUGIN='cdab08acb6eac6367c6f646ef94770cf5ac01c882b5e2ca2e3711958fee2bb08'
CANONICAL='nemotron-3.5-lightning'
UPSTREAM='nvidia/nemotron-3.5-lightning:free'
LEAF='/v8/management/config/api-keys/openai-compatibility'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 os.umask(0o077)
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--native-sha',required=True);p.add_argument('--plugin-sha',required=True);p.add_argument('--source',required=True);p.add_argument('--discovery',action='store_true');a=p.parse_args()
 token=json.load(sys.stdin)['token'];key=(ROOT/'secrets/management.key').read_text().strip();client=(ROOT/'secrets/client-api-key').read_text().strip()
 lock=(ROOT/'state/freehub-deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 journal=ROOT/('model-discovery-deployment-v1.json' if a.discovery else 'model-catalog-routing-deployment-v1.json')
 if journal.exists():raise RuntimeError('existing deployment journal; inspect, never replay')
 pairs=[(ROOT/'bin/cli-proxy-api',ROOT/'model-catalog-native.pending',ROOT/'bin/cli-proxy-api-before-model-catalog',OLD_NATIVE,a.native_sha),(ROOT/'plugins/free-model-hub.so',ROOT/'model-catalog-freehub.pending.so',ROOT/'freehub-before-model-catalog.so',OLD_PLUGIN,a.plugin_sha)]
 if a.discovery:
  if sha(ROOT/'plugins/free-model-hub.so')!='88093bd493a7a62e6e0ed56110fd10ecddd1a477c69d5faa78bfcf87d43c2a7a':raise RuntimeError('existing FreeHub plugin differs')
  pairs=[(ROOT/'bin/cli-proxy-api',ROOT/'model-discovery-native.pending',ROOT/'bin/cli-proxy-api-before-model-discovery','2b36c0918fdec5a44548d457678b149035a899da513be64caa869f3f63251d2b',a.native_sha)]
  pairs.append((ROOT/'plugins/free-model-hub.so',ROOT/'model-discovery-freehub.pending.so',ROOT/'freehub-before-model-discovery.so','88093bd493a7a62e6e0ed56110fd10ecddd1a477c69d5faa78bfcf87d43c2a7a',a.plugin_sha))
 for target,pending,backup,old,new in pairs:
  if backup.exists() or target.is_symlink() or pending.is_symlink() or sha(target)!=old or sha(pending)!=new:raise RuntimeError('artifact or operation identity differs')
 runtime=(ROOT/'state/coolify-runtime.lock').open('r')
 def held():
  try:fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return True
  fcntl.flock(runtime,fcntl.LOCK_UN);return False
 if not held():raise RuntimeError('expected one existing Coolify owner')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def request(url,secret,method='GET',body=None,etag=None):
  headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'}
  if etag:headers['If-Match']=etag
  if url.startswith('http://127.0.0.1:8000'):headers['Host']='panel.nothing.pink'
  req=urllib.request.Request(url,headers=headers,method=method,data=None if body is None else json.dumps(body).encode())
  with opener.open(req,timeout=25) as response:return json.load(response),response.headers.get('ETag')
 def origin():
  addresses=(ROOT/'state/coolify-container-address').read_text().split()
  addr=next(ipaddress.ip_address(x) for x in addresses if ipaddress.ip_address(x).version==4)
  if not addr.is_private:raise RuntimeError('unexpected origin')
  return 'http://'+str(addr)+':8080'
 def api(path,method='GET',body=None,etag=None):return request(origin()+path,key,method,body,etag)
 def cool(path,method='GET'):return request('http://127.0.0.1:8000/api/v1/'+path,token,method)[0]
 configs=api('/v8/management/config/plugins/configs')[0]
 before_models=request(origin()+'/v1/models',client)[0]['data'];old_ids={m['id'] for m in before_models}
 old_llm7={m['id'] for m in before_models if m.get('owned_by','').lower()=='llm7'}
 required_ids=old_ids-old_llm7 if a.discovery else old_ids
 old_openrouter={m['id'] for m in before_models if 'openai-compatible-openrouter' in m.get('providers',[])}
 protected=[ROOT/'plugins/opencode.so',ROOT/'config/static/management.html',ROOT/'secrets/client-api-key']
 protected+=list(ROOT.glob('*live*.json'))
 protected+=[x for x in (ROOT/'auth').glob('*.json') if json.loads(x.read_text()).get('type')=='opencode']
 hashes={str(x):sha(x) for x in protected}
 auth_names={x.name for x in (ROOT/'auth').glob('*.json')}
 result={'phase':'prepared','source_commit':a.source,'backend_sha256':a.native_sha,'plugin_sha256':a.plugin_sha,'provider_inference_requests':0,'login_requests':0}
 def save():
  tmp=journal.with_suffix('.tmp');tmp.write_text(json.dumps(result,indent=2)+'\n');tmp.replace(journal)
 save()
 try:
  cool('applications/'+APP+'/stop?docker_cleanup=false','POST')
  end=time.monotonic()+90
  while held():
   if time.monotonic()>end:raise RuntimeError('existing owner did not stop')
   time.sleep(1)
  fcntl.flock(runtime,fcntl.LOCK_EX|fcntl.LOCK_NB)
  for target,pending,backup,old,new in pairs:
   shutil.copyfile(target,backup);backup.chmod(0o700);os.replace(pending,target);target.chmod(0o700)
  result['phase']='swapped_stopped';save()
  fcntl.flock(runtime,fcntl.LOCK_UN)
  deployment=cool('applications/'+APP+'/start','POST').get('deployment_uuid')
  if not deployment:raise RuntimeError('no Coolify deployment identity')
  result['deployment_uuid']=deployment;save()
  end=time.monotonic()+360;last=None
  while time.monotonic()<end:
   status=cool('deployments/'+deployment).get('status')
   if status!=last:print(json.dumps({'coolify_status':status}),flush=True);last=status
   if status=='finished':break
   if status in ['failed','cancelled']:raise RuntimeError('Coolify deployment failed')
   time.sleep(3)
  else:raise RuntimeError('Coolify pending; inspect journal before recovery')
  if not held() or not api('/healthz')[0]:raise RuntimeError('new owner unhealthy')
  if api('/v8/management/config/plugins/configs')[0]!=configs:raise RuntimeError('plugin settings changed')
  # Lists are native v8 mutation units. Re-read immediately and use its ETag,
  # preserving all concurrent user-added providers/keys/models verbatim.
  providers,etag=api(LEAF)
  updated=copy.deepcopy(providers)
  if a.discovery:
   for provider in updated:
    provider['model-discovery']={'enabled':True,'free-only':True,'refresh-seconds':900}
   api(LEAF,'PUT',updated,etag)
   for path,value in [('model-refresh-seconds',1800),('model-refresh-providers',['freehub'])]:
    _,current_etag=api('/v8/management/config')
    api('/v8/management/config/plugins/'+path,'PUT',value,current_etag)
  else:
   matches=[x for x in updated if x.get('name')=='openrouter']
   if len(matches)!=1:raise RuntimeError('OpenRouter route identity ambiguous')
   models=matches[0].get('models',[])
   if any(m.get('alias')==CANONICAL for x in updated for m in x.get('models',[])):raise RuntimeError('canonical alias already configured; inspect')
   original=next((m for m in models if m.get('name')==UPSTREAM and m.get('alias')=='openrouter/nemotron-3.5-lightning-free'),None)
   if not original or not etag:raise RuntimeError('reviewed OpenRouter model or ETag missing')
   alias=copy.deepcopy(original);alias.update(alias=CANONICAL,**{'display-name':'Nemotron 3.5 Lightning'})
   models.append(alias)
   api(LEAF,'PUT',updated,etag)
  result['phase']='discovery_configured' if a.discovery else 'alias_configured';save()
  end=time.monotonic()+(100 if a.discovery else 40)
  while True:
   rows=request(origin()+'/v1/models',client)[0]['data'];ids={m['id'] for m in rows}
   canonical=next((m for m in rows if m['id']==CANONICAL),{})
   new_discovery=[m['id'] for m in rows if 'openai-compatible-openrouter' in m.get('providers',[]) and m['id'] not in old_openrouter]
   if len(canonical.get('providers',[]))==2 and required_ids<=ids and (not a.discovery or (new_discovery and "llm7-llm7/mistral-Nemo-Instruct-2407" in ids)):break
   if time.monotonic()>end:raise RuntimeError('model publication incomplete')
   time.sleep(1)
  if any(not m.get('owned_by') for m in rows):raise RuntimeError('empty model ownership remains')
  if not all('capabilities' in m for m in rows):raise RuntimeError('rich metadata missing')
  gemini=request(origin()+'/v1beta/models',client)[0]['models']
  if any('tool_calls' in m.get('supportedGenerationMethods',[]) for m in gemini):raise RuntimeError('invalid Gemini generation method remains')
  if any(sha(Path(name))!=value for name,value in hashes.items()):raise RuntimeError('protected state changed')
  if not auth_names<={x.name for x in (ROOT/'auth').glob('*.json')}:raise RuntimeError('existing account file removed')
  actual=api(LEAF)[0]
  # Native management may inject runtime-only auth-index metadata; API strips it on writes.
  def normalized(value):
   if isinstance(value,dict):return {k:normalized(v) for k,v in value.items() if k!='auth-index'}
   if isinstance(value,list):return [normalized(v) for v in value]
   return value
  if normalized(actual)!=normalized(updated):raise RuntimeError('provider settings differ')
  result.update(phase='deployed',model_count=len(rows),all_original_ids_preserved=old_ids<=ids,canonical_id=CANONICAL,canonical_providers=canonical['providers'],all_owners_disclosed=True,gemini_generation_methods_correct=True,protected_state_unchanged=True,existing_accounts_preserved=True)
  if a.discovery:result.update(automatic_model_refresh=True,catalog_refresh_seconds=900,plugin_refresh_seconds=1800,new_openrouter_catalog_contributions=len(new_discovery),new_model_ids=len(ids-old_ids),retired_nonfree_llm7_models=len(old_llm7-ids),all_other_original_ids_preserved=required_ids<=ids)
  save();print(json.dumps(result))
 except Exception as error:
  result.update(phase='failed',error_type=type(error).__name__);save()
  print(json.dumps({'phase':'failed','error_type':type(error).__name__,'journal':str(journal)}),flush=True)
  # Never race an in-flight Coolify job or automatically overwrite user state.
  raise
if __name__=='__main__':main()
