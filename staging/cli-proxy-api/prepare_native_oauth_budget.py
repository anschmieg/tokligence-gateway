#!/usr/bin/env python3
"""Pinned native Antigravity/Codex redirect guard. No build or deployment."""
import argparse,hashlib,json
from pathlib import Path
FILES={
 'internal/runtime/executor/antigravity_executor.go':None,
 'internal/runtime/executor/helps/utls_client.go':None,
}
def sha(data):return hashlib.sha256(data).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--prepared-source',type=Path,required=True);a=p.parse_args();root=a.prepared_source
 originals={name:(root/name).read_bytes() for name in FILES}
 pins=json.loads((Path(__file__).parent/'patches/native_oauth_budget/pins.json').read_text())
 for name,data in originals.items():
  if sha(data)!=pins[name]:p.error('input source differs')
 changes={}
 name='internal/runtime/executor/antigravity_executor.go';anchor='defer func() { clientOut = httptransport.Decorate(ctx, clientOut) }()'
 text=originals[name].decode()
 if text.count(anchor)!=1:p.error('Antigravity anchor differs')
 changes[name]=text.replace(anchor,'defer func() { clientOut = helps.NativeOAuthBudgetClient(httptransport.Decorate(ctx, clientOut), auth) }()').encode()
 name='internal/runtime/executor/helps/utls_client.go';anchor='clientOut = httptransport.Decorate(ctx, clientOut)';text=originals[name].decode()
 if text.count(anchor)!=1:p.error('Codex client anchor differs')
 changes[name]=text.replace(anchor,'clientOut = NativeOAuthBudgetClient(httptransport.Decorate(ctx, clientOut), auth)').encode()
 for name in ('native_oauth_budget.go','native_oauth_budget_test.go'):
  rel='internal/runtime/executor/helps/'+name
  if (root/rel).exists():p.error('output exists')
  changes[rel]=(Path(__file__).parent/'patches/native_oauth_budget'/name).read_bytes()
 for name,data in changes.items():(root/name).write_bytes(data)
 (root/'native-oauth-budget-manifest.json').write_text(json.dumps({'inputs':pins,'outputs':{n:sha(d) for n,d in changes.items()},'deployed':False},indent=2)+'\n')
 print(json.dumps({'prepared':str(root),'deployed':False}))
if __name__=='__main__':main()
