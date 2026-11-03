#!/usr/bin/env python3
"""Derive an evidence-enabled scenario from the shared isolated host harness.
Unique anchors prevent silent drift; no copied fork of the sandbox supervisor.
"""
import argparse
from pathlib import Path
q=argparse.ArgumentParser();q.add_argument('--output',type=Path,required=True);a=q.parse_args()
if a.output.exists():q.error('output must be NEW')
source=Path(__file__).resolve().parents[1]/'free-model-hub/testing/isolated_host_smoke.py'
s=source.read_text()
anchor="            config['models']['canonical-routing']={'max-attempts':6,'free-fallbacks':{'nemotron':['glm-4.7-flash']}}"
replacement='''            config['observability']={'logs':{'debug':True}}
            def bench(score):
                return [{'name':name,'score':score,'metric':'pass@1','version':'fixture-v1','harness':'fixture-agent','variant':'fixture-default','source':'https://example.org/fixture'} for name in ('Terminal-Bench','DeepSWE')]
            evidence={'models':{'fixture/nemotron':{'id':'fixture/nemotron','family':'nemotron','benchmarks':bench(90)},'fixture/glm':{'id':'fixture/glm','family':'glm','benchmarks':bench(89)}},'providers':{'openrouter':{'models':{MODEL:{'canonical_model_id':'fixture/nemotron'},'glm-4.7-flash:free':{'canonical_model_id':'fixture/glm'}}},'kilo':{'models':{MODEL:{'canonical_model_id':'fixture/nemotron'}}}},'_evidence':{'retrieved_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}}
            evidence['providers']['kilo']=evidence['providers']['openrouter']
            evidence['providers']['retiredfixture']=evidence['providers']['openrouter']
            evidence['providers']['paidfixture']={'models':{MODEL:{'canonical_model_id':'fixture/nemotron'}}}
            (WORK/'fallback-evidence.json').write_text(json.dumps(evidence))
            config['models']['canonical-routing']={'max-attempts':6,'evidence-catalog':'/work/fallback-evidence.json','require-comparable-evidence':True}
'''.rstrip()
if s.count(anchor)!=1:raise RuntimeError('shared policy-config anchor differs')
s=s.replace(anchor,replacement)
anchor="            stage='canonical_cost_policy'"
replacement='''            stage='canonical_cost_policy'
            deadline=time.monotonic()+10
            while 'fallback evidence metadata loaded' not in (WORK/'backend.log').read_text(errors='replace'):
                if time.monotonic()>deadline:raise GateFailure('evidence_not_loaded')
                time.sleep(.05)
            gate('catalog_evidence_loaded',True)'''
if s.count(anchor)!=1:raise RuntimeError('shared stage anchor differs')
s=s.replace(anchor,replacement)
a.output.write_text(s)
