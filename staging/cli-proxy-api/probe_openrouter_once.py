#!/usr/bin/env python3
"""One accounted real Messages-stream tool proposal, no tool execution/retry."""
import datetime,hashlib,json,pathlib,re,sys,urllib.request,urllib.error
ROOT=pathlib.Path('/home/agent/cliproxy-staging');BASE='http://100.74.55.86:4195'
MODEL='openrouter/nemotron-3.5-lightning-free';UPSTREAM='nvidia/nemotron-3.5-lightning:free'
RUN='cliproxy-openrouter-live-20261102-v1'

def parse_stream(raw):
 blocks={};start=False;stop=False;reason=None
 for line in raw.decode('utf-8').splitlines():
  if not line.startswith('data:'):continue
  event=json.loads(line[5:].lstrip());kind=event.get('type')
  if stop:raise RuntimeError('data after Messages terminal')
  if kind=='error':raise RuntimeError('embedded Messages error')
  if kind=='message_start':start=event.get('message',{}).get('role')=='assistant'
  if kind=='content_block_start':blocks[event['index']]=dict(event['content_block'])
  if kind=='content_block_delta' and event.get('delta',{}).get('type')=='input_json_delta':
   block=blocks[event['index']];block['_json']=block.get('_json','')+event['delta']['partial_json']
  if kind=='message_delta':reason=event.get('delta',{}).get('stop_reason',reason)
  if kind=='message_stop':stop=True
 if not start or not stop or reason!='tool_use':raise RuntimeError('Messages tool terminal missing')
 calls=[b for b in blocks.values() if b.get('type')=='tool_use']
 if len(calls)!=1 or not calls[0].get('id') or calls[0].get('name')!='report_ready':raise RuntimeError('tool proposal identity differs')
 value=json.loads(calls[0]['_json']) if calls[0].get('_json') else calls[0].get('input')
 if value!={'status':'READY'}:raise RuntimeError('tool proposal arguments differ')
 return {'messages_stream_verified':True,'tool_proposal_verified':True,'tool_execution':'not_requested','reasoning_replay':'untested'}

def main():
 import yaml
 report_path=ROOT/(RUN+'.json')
 manifest=json.loads((ROOT/'native-redirect-deployment.json').read_text())
 if hashlib.sha256((ROOT/'bin/cli-proxy-api').read_bytes()).hexdigest()!=manifest['binary_sha256']:raise RuntimeError('Native backend no longer matches reviewed deployment')
 if report_path.exists():raise RuntimeError('Report exists; no replay')
 activation=json.loads((ROOT/'openrouter-activation.json').read_text())
 if activation.get('phase')!='configured' or activation.get('model')!=UPSTREAM:raise RuntimeError('Native activation is not complete')
 cfg=yaml.safe_load((ROOT/'config/config.yaml').read_text())
 providers=cfg.get('api-keys',{}).get('openai-compatibility',[])
 selected=[p for p in providers if p.get('name')=='openrouter']
 if len(selected)!=1 or not selected[0].get('disable-redirects') or selected[0].get('request-retry')!=0 or len(selected[0].get('keys',[]))!=1:raise RuntimeError('Native dispatch policy differs')
 if cfg['routing']['retry']['request-retry']!=0 or cfg['routing']['retry']['max-retry-credentials']!=1:raise RuntimeError('Global dispatch policy differs')
 rules=cfg.get('requests',{}).get('payload',{}).get('override',[])
 expected={'allow_fallbacks':False,'max_price':{'prompt':0,'completion':0,'request':0,'image':0}}
 if not any(r.get('params',{}).get('provider')==expected and r.get('params',{}).get('plugins')==[] and any(m.get('name')==UPSTREAM for m in r.get('models',[])) for r in rules):raise RuntimeError('Free-route payload policy differs')
 sys.path.insert(0,'/home/agent/tokligence-staging/gateway/native/opencode')
 from live_safety import LiveGuard,ProbeStopped,open_gateway
 state=ROOT/'live/openrouter';state.mkdir(parents=True,exist_ok=True,mode=0o700)
 window={'id':'cliproxy-openrouter-window-20261102-v1','request_budget':1,'output_budget':1024,'allowed_runs':[RUN]}
 result={'provider':'openrouter','model':MODEL,'live':True,'request_budget':1,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 key=(ROOT/'secrets/client-api-key').read_text().strip()
 try:
  with LiveGuard(state,RUN,1,1024,window=window) as guard:
   guard.reserve(1024)
   body={'model':MODEL,'stream':True,'max_tokens':1024,'messages':[{'role':'user','content':'Call report_ready with status READY.'}],
         'tools':[{'name':'report_ready','description':'Return fixture readiness. No side effects.','input_schema':{'type':'object','properties':{'status':{'type':'string','enum':['READY']}},'required':['status'],'additionalProperties':False}}],
         'tool_choice':{'type':'tool','name':'report_ready'}}
   req=urllib.request.Request(BASE+'/v1/messages',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','anthropic-version':'2023-06-01','x-session-id':RUN})
   try:
    with open_gateway(req,timeout=180) as response:
     raw=response.read(2*1024*1024+1);result['status']=response.status
    if len(raw)>2*1024*1024:raise RuntimeError('Response exceeds probe limit')
    result.update(parse_stream(raw),outcome='passed')
   except urllib.error.HTTPError as error:
    result.update(outcome='rejected',status=error.code)
    guard.stop('OpenRouter probe rejected; no retry',error.code)
   except (ValueError,RuntimeError,OSError,urllib.error.URLError):
    result['outcome']='invalid_or_uncertain';guard.stop('OpenRouter response malformed or uncertain; no retry')
   finally:result['dispatch_reservations']=guard.count
 except ProbeStopped:result.setdefault('outcome','refused')
 finally:
  report_path.write_text(json.dumps(result,indent=2))
 print(json.dumps(result));return 0 if result['outcome']=='passed' else 2
if __name__=='__main__':
 try:raise SystemExit(main())
 except RuntimeError as error:print(json.dumps({'outcome':'not_started','reason':str(error)}));raise SystemExit(2)
