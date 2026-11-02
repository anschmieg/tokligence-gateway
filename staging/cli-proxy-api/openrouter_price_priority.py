#!/usr/bin/env python3
"""Partition OpenRouter free/PAYGO models using stock native provider groups.

No dispatcher patch or pricing guesses: exact upstream :free IDs and the official
free router are free; all other/unknown IDs are low-priority. Keys/models remain
unchanged. Does not enable any new paid route or a free-to-paid fallback.
"""
import copy,json,urllib.parse

def price_tiers(providers):
 result=[];names={p['name'].lower() for p in providers}
 for entry in providers:
  host=urllib.parse.urlparse(entry.get('base-url','')).hostname
  if host not in ('openrouter.ai','www.openrouter.ai'):
   result.append(copy.deepcopy(entry));continue
  free=[];paid=[]
  for model in entry.get('models',[]):
   upstream=model.get('name','')
   known_free=('*' not in upstream and (upstream.endswith(':free') or upstream=='openrouter/free'))
   (free if known_free else paid).append(copy.deepcopy(model))
  if free and paid:
   paid_name=entry['name']+'-paygo'
   if paid_name.lower() in names:raise ValueError('PAYGO provider name already exists; inspect rather than merge')
   names.add(paid_name.lower())
   f=copy.deepcopy(entry);f.update(priority=0,models=free);result.append(f)
   p=copy.deepcopy(entry);p.update(name=paid_name,priority=-10,models=paid);result.append(p)
  else:
   p=copy.deepcopy(entry);p['priority']=0 if free else -10;result.append(p)
 return result

if __name__=='__main__':
 import fcntl,hashlib,ipaddress,os,time,urllib.request
 from pathlib import Path
 os.umask(0o077);r=Path('/home/agent/cliproxy-staging')
 journal=r/'state/openrouter-price-priority-v1.json'
 lock=(r/'state/freehub-deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 acceptance=(r/'state/provider-acceptance-20261102/run.lock').open('a');fcntl.flock(acceptance,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if journal.exists():raise RuntimeError('existing priority operation; inspect instead of replay')
 ip=next(x for x in (r/'state/coolify-container-address').read_text().split() if ipaddress.ip_address(x).version==4)
 key=(r/'secrets/management.key').read_text().strip();url='http://'+ip+':8080/v8/management/config/api-keys/openai-compatibility'
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open(urllib.request.Request(url,headers={'Authorization':'Bearer '+key}),timeout=20) as response:before=json.load(response);etag=response.headers['ETag']
 after=price_tiers(before)
 record={'phase':'reserved','started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'provider_inference_calls':0,'free_priority':0,'paygo_priority':-10,'groups_added':len(after)-len(before)}
 with journal.open('x') as output:json.dump(record,output)
 q=urllib.request.Request(url,method='PUT',data=json.dumps(after).encode(),headers={'Authorization':'Bearer '+key,'If-Match':etag,'Content-Type':'application/json'})
 with opener.open(q,timeout=20) as response:response.read()
 with opener.open(urllib.request.Request(url,headers={'Authorization':'Bearer '+key}),timeout=20) as response:actual=json.load(response)
 def normalized(x):
  if isinstance(x,dict):return {k:normalized(v) for k,v in x.items() if k!='auth-index'}
  if isinstance(x,list):return [normalized(v) for v in x]
  return x
 if normalized(actual)!=normalized(after):raise RuntimeError('priority write differs; inspect journal')
 record['phase']='configured';journal.write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
