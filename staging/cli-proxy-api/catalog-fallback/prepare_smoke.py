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
anchor="            gate('disabled_opencode_preserved',digest(WORK/'auth/opencode-fixture.json')==seeded_hash)"
replacement='''            gate('profile_auth_required',api('/coding/v1/models',key=None)[0]==401)
            profile=get_json('/coding/v1/models',CLIENT_KEY)
            profile_ids={m['id'] for m in profile['data']}
            full_ids={m['id'] for m in get_json('/v1/models',CLIENT_KEY)['data']}
            gate('profile_curated_from_full_catalog',bool(profile_ids) and profile_ids<=full_ids and profile['model_role']=='hint' and profile['cost_policy']=='free-only')
            start=len(policy_calls)
            status,raw=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='nemotron-3.5-lightning',messages=[{'role':'user','content':'profile-coding'}]))
            calls=policy_calls[start:]
            gate('profile_native_http_hint_routing',status==200 and b'[DONE]' in raw and len(calls)==1 and all(t!='Bearer fixture-paid' for _,t,_ in calls))
            gate('profile_opaque_unknown_hint_refused',api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='unavailable-hint',previous_response_id='resp_fixture',messages=[{'role':'user','content':'profile-opaque'}]))[0]>=400 and len(policy_calls)==start+1)
            before=len(policy_calls)
            status,raw=api('/coding/v1/messages',CLIENT_KEY,{'model':'nemotron-3.5-lightning','max_tokens':16,'stream':True,'messages':[{'role':'user','content':'profile-messages'}]})
            gate('profile_native_messages_stream',status==200 and b'message_start' in raw and b'message_stop' in raw and len(policy_calls)==before+1 and api.profile_header=='coding')
            before=len(policy_calls)
            status,raw=api('/coding/v1/responses',CLIENT_KEY,{'model':'nemotron-3.5-lightning','max_output_tokens':16,'stream':True,'input':'profile-responses'})
            gate('profile_native_responses_stream',status==200 and b'response.completed' in raw and len(policy_calls)==before+1 and api.profile_header=='coding')
            before=len(policy_calls)
            status,_=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='nemotron-3.5-lightning',tools=[{'type':'web_search'}],messages=[{'role':'user','content':'profile-metered-tool'}]))
            gate('profile_unknown_feature_cost_refused_before_dispatch',status==400 and len(policy_calls)==before)
            gate('disabled_opencode_preserved',digest(WORK/'auth/opencode-fixture.json')==seeded_hash)'''
if s.count(anchor)!=1:raise RuntimeError('profile integration gate anchor differs')
s=s.replace(anchor,replacement)
anchor="and counts['stream_origin'] == (3 if policy_mode else 1 if catalog_mode else 3 if canonical_mode else 5 if multi_mode else 1)"
if s.count(anchor)!=1:raise RuntimeError('shared shutdown stream count anchor differs')
s=s.replace(anchor,"and counts['stream_origin'] == (6 if policy_mode else 1 if catalog_mode else 3 if canonical_mode else 5 if multi_mode else 1)")
anchor="            return response.code, raw"
if s.count(anchor)!=1:raise RuntimeError('API header capture anchor differs')
s=s.replace(anchor,"            api.profile_header=response.headers.get('X-Gateway-Profile')\n"+anchor)
a.output.write_text(s)
