#!/usr/bin/env python3
"""Add native OpenAI-compatible opt-in redirect policy to prepared pinned source.
No deployment, credentials, downloads or inference. Existing source changes must
match the exact pinned predecessors before any file mutation.
"""
import argparse,hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parent
PIN='250d598175db61a4e99ac38b9164ed04745754e5'
FILES={'internal/runtime/executor/openai_compat_executor.go':'62189994027d9d67f06ecee0bad75729fced64051b20f71fa45dbfbf890e92b4','internal/config/config_types.go':'8d1e10602e470dfce5b95bd90e1779498f2811c04849aab1fe08a67d34b2c592'}
def digest(data):return hashlib.sha256(data).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--prepared-source',required=True,type=pathlib.Path);args=p.parse_args();source=args.prepared_source.resolve(strict=True)
 manifest=json.loads((source/'provider-budget-manifest.json').read_text())
 if manifest.get('base_commit')!=PIN: p.error('unexpected source pin')
 raw={name:(source/name).read_bytes() for name in FILES}
 for name,want in FILES.items():
  if digest(raw[name])!=want:p.error('input digest mismatch; refusing in-place overwrite')
 name='internal/runtime/executor/openai_compat_executor.go';anchor='helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)'
 if raw[name].decode().count(anchor)!=5:p.error('executor construction sites differ')
 changes={name:raw[name].decode().replace(anchor,'e.dispatchHTTPClient(ctx, auth, 0)').encode()}
 name='internal/config/config_types.go';anchor='type OpenAICompatibility struct {'
 if raw[name].decode().count(anchor)!=1:p.error('configuration structure differs')
 changes[name]=raw[name].decode().replace(anchor,anchor+'\n\t// DisableRedirects rejects automatic HTTP redirect dispatches for this route.\n\tDisableRedirects bool `yaml:"disable-redirects,omitempty" json:"disable-redirects,omitempty"`\n').encode()
 for name in ['openai_compat_redirect_policy.go','openai_compat_redirect_policy_test.go']:
  target='internal/runtime/executor/'+name
  if (source/target).exists():p.error('policy output exists')
  changes[target]=(ROOT/'patches/native_openai_redirect'/name).read_bytes()
 for name,data in changes.items():(source/name).write_bytes(data)
 report={'base_commit':PIN,'inputs':FILES,'outputs':{name:digest(data) for name,data in changes.items()},'policy':'explicit per-provider disable-redirects; default unchanged','deployed':False}
 (source/'native-redirect-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'prepared':str(source),'deployed':False}))
if __name__=='__main__':main()
