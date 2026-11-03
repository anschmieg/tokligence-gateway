#!/usr/bin/env python3
"""Reconstruct reviewed native input and current extension from pinned upstream.
Requires existing upstream git clone with commit250d5981; output must be NEW.
No downloads, credentials, deployment or inference. Build separately afterward.
"""
import argparse,subprocess,sys,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--upstream',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
if a.output.exists():p.error('output must be new')
a.output.mkdir();base=a.output/'native-base';catalog=a.output/'native-catalog';discovery=a.output/'native-discovery';prepared=a.output/'backend';here=Path(__file__).resolve().parent;root=here.parent

def run(script,*args):subprocess.run([sys.executable,str(root/script),*map(str,args)],check=True)
run('prepare_provider_patch.py','--source',a.upstream,'--output',base,'--unsigned-thinking-compat')
run('prepare_management_patch.py','--prepared-source',base,'--upstream',a.upstream)
run('prepare_native_redirect_patch.py','--prepared-source',base)
run('prepare_native_oauth_budget.py','--prepared-source',base)
subprocess.run(['gofmt','-w',*[str(base/x) for x in ['internal/pluginhost','internal/api','internal/config','internal/runtime/executor']]],check=True)
run('prepare_model_catalog.py','--source',base,'--output',catalog)
run('prepare_model_discovery.py','--source',catalog,'--output',discovery)
# The reviewed .9 fence is intentionally pre-gofmt. All input digests are then
# enforced by prepare_canonical_catalog.py; never weaken pins to accept drift.
fence=(discovery/'sdk/cliproxy/model_registry.go').read_bytes()
subprocess.run(['gofmt','-w',str(discovery/'internal/config'),str(discovery/'sdk/cliproxy')],check=True)
(discovery/'sdk/cliproxy/model_registry.go').write_bytes(fence)
subprocess.run([sys.executable,str(here/'prepare.py'),'--source',str(discovery),'--output',str(prepared)],check=True)
subprocess.run(['gofmt','-w',*[str(prepared/x) for x in ['internal/catalogfallback','internal/registry','internal/api','sdk/api/handlers','sdk/cliproxy']]],check=True)
print(str(prepared))
