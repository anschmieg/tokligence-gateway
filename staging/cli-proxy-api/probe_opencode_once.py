#!/usr/bin/env python3
"""One accounted post-handoff staging request. No automatic retry/fallback."""
import datetime,hashlib,json,pathlib,re,sqlite3,sys,urllib.request,urllib.error
OLD=pathlib.Path('/home/agent/tokligence-staging');NEW=pathlib.Path('/home/agent/cliproxy-staging')
RUN='cliproxy-opencode-live-20261102-v1'
WINDOW={'id':'cliproxy-opencode-live-window-20261102-v1','request_budget':1,'output_budget':1024,'allowed_runs':[RUN]}
BASE='http://100.74.55.86:4195'
EXPECTED_PLUGIN='36673558ea2fde158f7103a38d1c35cdba550698281a154c4d2a755ae06149fa'

def main():
 import yaml
 sys.path.insert(0,str(OLD/'gateway/native/opencode'))
 from live_safety import LiveGuard,ProbeStopped,open_gateway
 report_path=NEW/(RUN+'.json')
 if report_path.exists():raise RuntimeError('probe report exists; never replay')
 handoff=json.loads((NEW/'opencode-owner-handoff.json').read_text())
 if handoff.get('phase')!='complete' or not handoff.get('single_refresh_owner'):raise RuntimeError('handoff not complete')
 c=sqlite3.connect('file:'+str(OLD/'state/opencode.db')+'?mode=ro',uri=True)
 if c.execute('SELECT count(*) FROM credential').fetchone()[0]!=0:raise RuntimeError('old credential owner not empty')
 if hashlib.sha256((NEW/'plugins/opencode.so').read_bytes()).hexdigest()!=EXPECTED_PLUGIN:raise RuntimeError('plugin digest mismatch')
 cfg=yaml.safe_load((NEW/'config/config.yaml').read_text())
 if cfg['routing']['retry']['request-retry']!=0 or cfg['routing']['retry']['max-retry-credentials']!=1:raise RuntimeError('retry policy mismatch')
 if cfg['plugins']['configs']['opencode']['models']!=['beam-free']:raise RuntimeError('model allowlist mismatch')
 if len(list((NEW/'auth').glob('*.json')))!=1:raise RuntimeError('credential inventory mismatch')
 result={'model':'beam-free','provider':'opencode','auth_mode':'oauth','live':True,'request_budget':1,'output_budget':1024,'reasoning_replay':'untested','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 key=(NEW/'secrets/client-api-key').read_text().strip()
 try:
  with LiveGuard(OLD,RUN,1,1024,window=WINDOW) as guard:
   guard.reserve(1024)
   body={'model':'beam-free','max_tokens':1024,'stream':False,'messages':[{'role':'user','content':'Reply with exactly STAGING_OK and nothing else.'}]}
   req=urllib.request.Request(BASE+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','x-session-id':RUN})
   try:
    with open_gateway(req,timeout=180) as response:
     data=json.load(response);result['status']=response.status
    choices=data.get('choices',[]);message=choices[0].get('message',{}) if len(choices)==1 else {}
    if len(choices)!=1 or choices[0].get('finish_reason')!='stop' or message.get('role')!='assistant' or 'STAGING_OK' not in (message.get('content') or ''):
     result['outcome']='invalid_response';guard.stop('Unexpected completion; stop further account traffic')
    result.update(outcome='passed',returned_text_match=True,reasoning_received=bool(message.get('reasoning_content') or message.get('reasoning')),usage=data.get('usage',{}))
   except urllib.error.HTTPError as error:
    try:failure=json.load(error).get('error',{})
    except Exception:failure={}
    message=failure.get('message','') if isinstance(failure,dict) else ''
    match=re.search(r'request_id=([A-Za-z0-9._:-]{1,128})',message)
    sanitized={'code':failure.get('code') if isinstance(failure,dict) else None,'upstream_request_id':match.group(1) if match else None}
    result.update(outcome='rejected',status=error.code,**sanitized)
    guard.stop('Provider/gateway rejected probe; stop further account traffic',error.code,sanitized)
   except (ValueError,OSError,urllib.error.URLError):
    result['outcome']='transport_or_malformed';guard.stop('Uncertain inference outcome; stop all diagnostic traffic')
   finally:result['dispatch_reservations']=guard.count
 except ProbeStopped:
  result.setdefault('outcome','refused');result['further_traffic']='stopped'
 finally:
  fd=__import__('os').open(report_path,__import__('os').O_WRONLY|__import__('os').O_CREAT|__import__('os').O_EXCL,0o600)
  with __import__('os').fdopen(fd,'w') as f:json.dump(result,f,indent=2)
 print(json.dumps(result));return 0 if result['outcome']=='passed' else 2

if __name__=='__main__':
 try:raise SystemExit(main())
 except RuntimeError as error:print(json.dumps({'outcome':'not_started','reason':str(error)}));raise SystemExit(2)
