#!/usr/bin/env python3
"""Session control/status helper. No retries, redirects, stored keys or inference."""
import argparse,json,os,subprocess,sys,uuid,urllib.request,urllib.parse
from datetime import datetime

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def display(rows,session,request_id=None,color=True):
 candidates=[r for r in rows if r.get('session')==session and (r.get('request_id')==request_id if request_id else r.get('kind')=='main')]
 if not candidates:return ' – '
 def started(row):
  value=row.get('started_at','')
  try:return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
  except ValueError:
   try:return float(value)
   except ValueError:return float('-inf')
 row=max(candidates,key=started)
 label=row.get('billing_class','UNKNOWN')
 if row.get('state')=='awaiting_route' or label not in ('FREE','SUB','PAID'):return ' – '
 if not color:return label
 return '\x1b['+{'FREE':'33','SUB':'34','PAID':'31'}[label]+'m'+label+'\x1b[0m'

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',nargs='?',default='toggle',choices=['','free','sub','paid','toggle','get','status','launch']);p.add_argument('--session',default=os.environ.get('NOTHING_GATEWAY_SESSION'));p.add_argument('--profile',default=os.environ.get('NOTHING_GATEWAY_PROFILE','chat'));p.add_argument('--base-url',default='https://code.nothing.pink');p.add_argument('--request-id');p.add_argument('--no-color',action='store_true');p.add_argument('--command',nargs=argparse.REMAINDER);a=p.parse_args()
 if not a.profile or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in a.profile):p.error('invalid profile slug')
 parsed=urllib.parse.urlsplit(a.base_url)
 if parsed.scheme!='https' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):p.error('base URL must be an HTTPS origin')
 if a.action=='launch':
  env=os.environ.copy();session=a.session or uuid.uuid4().hex
  if not env.get('NOTHING_API_KEY'):p.error('load NOTHING_API_KEY using the existing secret mechanism')
  env['NOTHING_GATEWAY_SESSION']=session;env['NOTHING_GATEWAY_PROFILE']=a.profile;env['ANTHROPIC_BASE_URL']=a.base_url.rstrip('/')+'/'+a.profile;env['ANTHROPIC_AUTH_TOKEN']=env['NOTHING_API_KEY'];env.setdefault('ANTHROPIC_MODEL',a.profile)
  headers=[x for x in env.get('ANTHROPIC_CUSTOM_HEADERS','').splitlines() if x and not x.lower().startswith(('x-gateway-session:','x-gateway-parent-session:','x-gateway-request-kind:'))]
  # Do not label ALL Claude traffic as foreground: auxiliary classification must
  # come from an adapter that knows the individual request's actual purpose.
  headers.append('X-Gateway-Session: '+session);env['ANTHROPIC_CUSTOM_HEADERS']='\n'.join(headers)
  return subprocess.call(a.command or ['claude'],env=env)
 if not a.session:
  if a.action=='status':print(' – ');return 0
  p.error('session required via --session or NOTHING_GATEWAY_SESSION')
 key=os.environ.get('NOTHING_API_KEY')
 if not key:
  if a.action=='status':print(' – ');return 0
  p.error('load NOTHING_API_KEY using the existing secret mechanism')
 headers={'Authorization':'Bearer '+key,'X-Gateway-Session':a.session,'Content-Type':'application/json'}
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 base=a.base_url.rstrip('/')+'/v1/routing/'
 def call(path,body=None):
  data=None if body is None else json.dumps(body).encode()
  req=urllib.request.Request(base+path+'?profile='+urllib.parse.quote(a.profile),data=data,headers=headers,method='GET' if body is None else 'PUT')
  with op.open(req,timeout=5) as r:return json.load(r)
 try:
  if a.action=='status':
   rows=call('requests')['data'];print(display(rows,a.session,a.request_id,not a.no_color));return 0
  policy=call('session')
  if a.action!='get':
   value=a.action.upper()
   if a.action in ('','toggle'):value={'FREE':'SUB','SUB':'PAID','PAID':'FREE'}[policy['policy']]
   policy=call('session',{'policy':value})
  print(json.dumps(policy));return 0
 except Exception:
  if a.action=='status':print(' – ');return 0
  print('Gateway session control failed; no retry or inference performed.',file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
