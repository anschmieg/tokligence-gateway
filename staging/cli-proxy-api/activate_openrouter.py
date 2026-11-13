#!/usr/bin/env python3
"""Prepare/apply ONE verified-free native OpenRouter route using an existing key.
No inference. No credentials in arguments, stdout, or tracked files. The remote
native API remains the config owner; writes use If-Match and preserve old rules.
"""
import argparse,datetime,decimal,json,pathlib,re,shlex,subprocess,urllib.request
MODEL='nvidia/nemotron-3.5-lightning:free'
ALIAS='openrouter/nemotron-3.5-lightning-free'
CATALOG='https://openrouter.ai/api/v1/models'
SSH=['ssh','-F','/home/t3/.ssh/fra-agent.conf','fra-agent']

def read_key(path):
 try:lines=path.read_text().splitlines()
 except PermissionError:raise RuntimeError('Credential source is not readable by this process')
 found=[]
 for line in lines:
  match=re.match(r'^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$',line)
  if match:
   try:parts=shlex.split(match[1],comments=True,posix=True)
   except ValueError:raise RuntimeError('Existing OpenRouter key syntax is unsupported')
   if len(parts)!=1:raise RuntimeError('Existing OpenRouter key syntax is unsupported')
   found.append(parts[0])
 if len(found)!=1 or not re.fullmatch(r'sk-or-v1-[A-Za-z0-9_-]{32,}',found[0]):raise RuntimeError('One valid existing OpenRouter key is required')
 return found[0]

def free_model():
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open(CATALOG,timeout=20) as response:raw=response.read(12*1024*1024+1)
 if len(raw)>12*1024*1024:raise RuntimeError('Public model catalog exceeds limit')
 models=[m for m in json.loads(raw).get('data',[]) if m.get('id')==MODEL]
 if len(models)!=1:raise RuntimeError('Selected free model absent from current catalog')
 prices=models[0].get('pricing',{})
 try:zero=prices.get('prompt') is not None and prices.get('completion') is not None and all(decimal.Decimal(str(p))==0 for p in prices.values() if p is not None)
 except decimal.InvalidOperation:zero=False
 if not MODEL.endswith(':free') or not zero:raise RuntimeError('Selected model is not currently zero-priced')
 return {'source':CATALOG,'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'model':MODEL,'pricing':prices}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--env-file',required=True,type=pathlib.Path,help='Authorized export from the actual deployed gateway; no assumed workspace credential source');parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 key=read_key(args.env_file);evidence=free_model()
 if not args.apply:print(json.dumps({'ready':True,'provider':'openrouter','model':MODEL,'zero_price_verified':True,'key_present':True,'inference_requests':0}));return
 helper=pathlib.Path(__file__).with_name('apply_openrouter.py')
 subprocess.run(['scp','-F','/home/t3/.ssh/fra-agent.conf',str(helper),'fra-agent:/home/agent/cliproxy-staging/apply_openrouter.py'],check=True,capture_output=True)
 value={'key':key,'evidence':evidence,'model':MODEL,'alias':ALIAS}
 result=subprocess.run(SSH+['python3','/home/agent/cliproxy-staging/apply_openrouter.py'],input=json.dumps(value).encode(),capture_output=True)
 try:report=json.loads(result.stdout)
 except ValueError:raise RuntimeError('Remote activation failed; private diagnostics require inspection')
 print(json.dumps(report))
 if result.returncode:raise SystemExit(result.returncode)

if __name__=='__main__':
 try:main()
 except RuntimeError as error:print(json.dumps({'status':'not_started','reason':str(error)}));raise SystemExit(2)
