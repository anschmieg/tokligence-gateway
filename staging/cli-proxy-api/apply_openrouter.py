#!/usr/bin/env python3
"""VPS-only native activation helper, key delivered over authenticated SSH stdin.
Does not call provider inference/verify/test APIs. No OAuth owner changes.
"""
import datetime,hashlib,json,os,pathlib,re,sys,urllib.request,urllib.error
ROOT=pathlib.Path('/home/agent/cliproxy-staging');BASE='http://100.74.55.86:4195'
MODEL='nvidia/nemotron-3.5-lightning:free';ALIAS='openrouter/nemotron-3.5-lightning-free'

def main():
 os.umask(0o077);sys.path.insert(0,str(ROOT));import cliproxy_lifecycle as life
 lock=life.lock_root(ROOT)
 payload=json.load(sys.stdin)
 if payload.get('model')!=MODEL or payload.get('alias')!=ALIAS or not re.fullmatch(r'sk-or-v1-[A-Za-z0-9_-]{32,}',payload.get('key','')):raise RuntimeError('Unexpected activation input')
 report_path=ROOT/'openrouter-activation.json'
 previous=json.loads(report_path.read_text()) if report_path.exists() else None
 if previous and (sys.argv[1:]!=['--resume-policy'] or previous.get('phase')!='installing_native_policy' or previous.get('inference_requests')!=0 or previous.get('model')!=MODEL):raise RuntimeError('Activation already recorded; inspect state instead of replay')
 manifest=json.loads((ROOT/'native-redirect-deployment.json').read_text())
 binary=ROOT/'bin/cli-proxy-api';config=ROOT/'config/config.yaml'
 if hashlib.sha256(binary.read_bytes()).hexdigest()!=manifest['binary_sha256'] or manifest.get('version')!='8.0.49-tokligence.3':raise RuntimeError('Opt-in native redirect policy backend is required')
 if not life.identity_matches(life.load_record(ROOT),binary,config):raise RuntimeError('Native process identity differs')
 key=(ROOT/'secrets/management.key').read_text().strip()
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def api(path,method='GET',body=None,etag=None):
  headers={'Authorization':'Bearer '+key}
  if body is not None:headers['Content-Type']='application/json'
  if etag:headers['If-Match']=etag
  req=urllib.request.Request(BASE+'/v8/management/'+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
  with opener.open(req,timeout=10) as r:return json.load(r),r.headers.get('ETag')
 cfg,etag=api('config')
 if cfg['routing']['retry']['request-retry']!=0 or cfg['routing']['retry']['max-retry-credentials']!=1:raise RuntimeError('Native retry admission failed')
 providers=cfg.get('api-keys',{}).get('openai-compatibility',[]) or []
 if any(x.get('name')=='openrouter' for x in providers):raise RuntimeError('Existing OpenRouter route requires revision review')
 policy={'models':[{'name':MODEL,'protocol':'openai'},{'name':ALIAS,'protocol':'openai'}],
         'params':{'provider':{'allow_fallbacks':False,'max_price':{'prompt':0,'completion':0,'request':0,'image':0}},'plugins':[]}}
 rule_payload=cfg.get('requests',{}).get('payload',{}) or {}
 if not isinstance(rule_payload,dict):raise RuntimeError('Native payload config is not an object')
 rules=rule_payload.get('override') or []
 if policy not in rules:rules.append(policy)
 rule_payload['override']=rules
 # Persist safety rules BEFORE making a credential/model route available.
 report={'phase':'installing_native_policy','provider':'openrouter','model':MODEL,'alias':ALIAS,'inference_requests':0,'evidence':payload['evidence']}
 if previous:report['recovered_from']={'phase':previous['phase'],'reason':'v8 payload path corrected before route activation','original_evidence':previous.get('evidence')}
 report_path.write_text(json.dumps(report,indent=2))
 api('config/requests/payload','PUT',rule_payload,etag)
 cfg,etag=api('config')
 entry={'name':'openrouter','base-url':'https://openrouter.ai/api/v1','request-retry':0,'disable-redirects':True,'disable-cooling':False,
        'keys':[{'api-key':payload['key']}],'models':[{'name':MODEL,'alias':ALIAS,'is-compat':True}]}
 providers=cfg.get('api-keys',{}).get('openai-compatibility',[]) or []
 api('config/api-keys/openai-compatibility','PUT',providers+[entry],etag)
 actual,_=api('config/api-keys/openai-compatibility')
 matches=[x for x in actual if x.get('name')=='openrouter']
 if len(matches)!=1 or not matches[0].get('disable-redirects') or matches[0].get('request-retry')!=0:raise RuntimeError('Native saved route policy differs')
 report.update(phase='configured',zero_price_model=True,automatic_redirects=False,provider_fallbacks=False,paid_provider_plugins=False,live_acceptance='untested')
 report_path.write_text(json.dumps(report,indent=2))
 print(json.dumps({k:v for k,v in report.items() if k!='evidence'}))

if __name__=='__main__':
 try:main()
 except urllib.error.HTTPError as error:print(json.dumps({'status':'blocked','reason':'native_management_http_error','http_status':error.code,'inference_requests':0}));raise SystemExit(2)
 except Exception as error:print(json.dumps({'status':'blocked','reason':str(error) if isinstance(error,RuntimeError) else type(error).__name__,'inference_requests':0}));raise SystemExit(2)
