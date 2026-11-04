#!/usr/bin/env python3
"""Extend the existing mandatory-netns host harness with session-policy cases."""
import argparse,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
if a.output.exists():p.error('output must be new')
with tempfile.TemporaryDirectory() as d:
 t=Path(d)/'base.py';subprocess.run([sys.executable,str(Path(__file__).with_name('prepare_smoke.py')),'--output',str(t)],check=True);s=t.read_text()
s=s.replace('def api(path, key=MANAGEMENT_KEY, body=None):','def api(path, key=MANAGEMENT_KEY, body=None, extra_headers=None, method=None):')
s=s.replace("req = urllib.request.Request('http://127.0.0.1:18080' + path,", "headers.update(extra_headers or {})\n        req = urllib.request.Request('http://127.0.0.1:18080' + path,")
s=s.replace('data=None if body is None else json.dumps(body).encode(), headers=headers)','data=None if body is None else json.dumps(body).encode(), headers=headers,method=method)')
s=s.replace("api.profile_header=response.headers.get('X-Gateway-Profile')","api.profile_header=response.headers.get('X-Gateway-Profile');api.response_headers=dict(response.headers)")
s=s.replace("'keys':[{'api-key':'fixture-paid'}],'disable-redirects':True,'models':[{'name':MODEL}]", "'keys':[{'api-key':'fixture-paid'}],'disable-redirects':True,'models':[{'name':MODEL,'max-context-length':8192,'input-modalities':['text'],'output-modalities':['text']}]")
s=s.replace("        (WORK/'config.yaml').write_text(json.dumps(config))", "        if policy_mode:\n            config['models']['canonical-routing']['profiles']={'chat':{'task':'general','max-models':12,'cost-policy':'session','preferred-model':'glm-4.7-flash'},'coding':{'task':'coding','max-models':12,'cost-policy':'session','preferred-model':'nemotron-3.5-lightning'}}\n        (WORK/'config.yaml').write_text(json.dumps(config))",1)
aidx=s.index("        if policy_mode:\n            stage='canonical_cost_policy'");bidx=s.index("        stage = 'management_console'",aidx)
s=s[:aidx]+'''        if policy_mode:
            stage='session_billing_policy'
            deadline=time.monotonic()+20
            while True:
                rows=get_json('/v1/models',CLIENT_KEY)['data'];byid={m['id']:m for m in rows}
                if byid.get('glm-4.7-flash',{}).get('has_free_routes') and get_json('/coding/v1/models',CLIENT_KEY).get('data'):break
                if time.monotonic()>deadline:raise GateFailure('evidence_or_free_catalog_missing')
                time.sleep(.1)
            gate('virtual_aliases_discovered',all(byid.get(x,{}).get('virtual') for x in ('chat','coding')))
            chat_view=get_json('/chat/v1/models',CLIENT_KEY);coding_view=get_json('/coding/v1/models',CLIENT_KEY)
            gate('configured_defaults_disclosed_and_first',chat_view['preferred_model']=='glm-4.7-flash' and chat_view['data'][0]['id']=='glm-4.7-flash' and chat_view['data'][0]['profile_preferred'] is True and coding_view['preferred_model']=='nemotron-3.5-lightning' and coding_view['data'][0]['id']=='nemotron-3.5-lightning')
            gate('original_rows_canonical',all(m.get('canonical') for m in rows if not m.get('virtual')))
            gate('routing_control_requires_auth',api('/v1/routing/session',None,extra_headers={'X-Gateway-Session':'s'})[0]==401)
            base={'stream':True,'max_tokens':8,'messages':[{'role':'user','content':'policy-override'}]}
            status,raw=api('/v1/chat/completions',CLIENT_KEY,dict(base,model='kilo-kilo/'+MODEL))
            gate('qualified_free_override',status==200 and b'[DONE]' in raw)
            for model,case in [('nemotron-3.5-lightning','policy-plain'),('nemotron-3.5-lightning:free','policy-free')]:
                before=len(policy_calls)
                status,_=api('/v1/chat/completions',CLIENT_KEY,dict(base,model=model,messages=[{'role':'user','content':case}]))
                gate('normal_binding_'+case,status>=400 and all(m==MODEL and t!='Bearer fixture-paid' for _,t,m in policy_calls[before:]))
            session={'X-Gateway-Session':'smoke-session','X-Gateway-Request-Kind':'main','X-Gateway-Prompt-ID':'smoke-prompt'}
            def control(profile,body=None,headers=None):
                status,raw=api('/v1/routing/session?profile='+profile,CLIENT_KEY,body,headers or session,'PUT' if body is not None else 'GET')
                require(status==200,'session_control');return json.loads(raw)
            gate('default_sub',control('coding')['policy']=='SUB')
            p=control('coding',{'policy':'PAID'});again=control('coding',{'policy':'PAID'})
            gate('idempotent_explicit_set',p['version']==again['version'])
            before=len(policy_calls)
            paidbody=dict(base,model='nemotron-3.5-lightning',messages=[{'role':'user','content':'policy-plain'}]);paidbody.pop('max_tokens')
            status,raw=api('/coding/v1/chat/completions',CLIENT_KEY,paidbody,session)
            paid_request=api.response_headers.get('X-Gateway-Request-Id') or api.response_headers.get('X-Gateway-Request-ID')
            gate('explicit_paid_preferred_model',status==200 and b'[DONE]' in raw and policy_calls[-1][1]=='Bearer fixture-paid' and all(m==MODEL for _,_,m in policy_calls[before:]))
            gate('unknown_entitlement_not_mislabelled_free',api.response_headers.get('X-Gateway-Billing-Class')=='UNKNOWN')
            before=len(policy_calls)
            status,raw=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='nemotron-3.5-lightning:free',messages=[{'role':'user','content':'policy-free'}]),session)
            gate('free_suffix_uses_similarity_never_paid',status==200 and b'[DONE]' in raw and policy_calls[-1][2]=='glm-4.7-flash:free' and all(t!='Bearer fixture-paid' for _,t,_ in policy_calls[before:]) and api.response_headers.get('X-Gateway-Billing-Class')=='FREE')
            main_request=api.response_headers.get('X-Gateway-Request-Id') or api.response_headers.get('X-Gateway-Request-ID')
            control('coding',{'policy':'FREE'})
            child={'X-Gateway-Session':'child-session','X-Gateway-Parent-Session':'smoke-session','X-Gateway-Request-Kind':'subagent','X-Gateway-Parent-Request-ID':main_request}
            gate('subagent_policy_inherits',control('coding',headers=child)['policy']=='FREE')
            gate('profile_scope_isolation',control('chat')['policy']=='SUB')
            gate('new_session_defaults_sub',control('coding',headers={'X-Gateway-Session':'unrelated'})['policy']=='SUB')
            status,raw=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='glm-4.7-flash'),child)
            gate('subagent_inference',status==200 and b'[DONE]' in raw)
            status,raw=api('/v1/chat/completions',CLIENT_KEY,dict(base,model='chat'))
            gate('chat_alias_selectable',status==200 and b'[DONE]' in raw and api.profile_header=='chat')
            status,raw=api('/coding/v1/messages',CLIENT_KEY,{'model':'glm-4.7-flash','max_tokens':8,'stream':True,'messages':[{'role':'user','content':'profile-messages'}]},session)
            gate('messages_stream',status==200 and b'message_stop' in raw)
            status,raw=api('/v1/messages',CLIENT_KEY,{'model':'chat','max_tokens':8,'stream':True,'messages':[{'role':'user','content':'profile-message-alias'}]})
            gate('messages_alias_stream',status==200 and b'message_stop' in raw and api.profile_header=='chat')
            status,raw=api('/coding/v1/responses',CLIENT_KEY,{'model':'glm-4.7-flash','max_output_tokens':8,'stream':True,'input':'profile-responses'},session)
            gate('responses_stream',status==200 and b'response.completed' in raw)
            aux=dict(session,**{'X-Gateway-Request-Kind':'compaction'})
            status,raw=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='glm-4.7-flash'),aux)
            gate('compaction_inherits',status==200 and api.response_headers.get('X-Gateway-Billing-Policy')=='FREE')
            status,raw=api('/v1/routing/requests?profile=coding',CLIENT_KEY,extra_headers=session)
            events=json.loads(raw)['data'];byrequest={e['request_id']:e for e in events}
            gate('telemetry_actual_route_and_correlation',status==200 and byrequest[paid_request]['billing_class']=='UNKNOWN' and byrequest[main_request]['billing_class']=='FREE' and all(e['completed_at'] and e['state']=='completed' for e in events))
            gate('auxiliary_events_distinguished',{'main','subagent','compaction'}<=set(e['kind'] for e in events))
            status,raw=api('/v1/routing/requests?profile=coding',CLIENT_KEY,extra_headers={'X-Gateway-Session':'unrelated'})
            gate('session_telemetry_isolated',status==200 and not json.loads(raw)['data'])
            before=len(policy_calls)
            status,_=api('/coding/v1/chat/completions',CLIENT_KEY,dict(base,model='glm-4.7-flash',tools=[{'type':'web_search'}]),session)
            gate('unverified_feature_costs_refused',status==400 and len(policy_calls)==before)
            gate('disabled_opencode_preserved',digest(WORK/'auth/opencode-fixture.json')==seeded_hash)
            gate('only_deliberate_calls',counts['inference_posts']==len(policy_calls) and counts['unexpected_http']==0)
            report['policy_calls']=[{'case':c,'lane':('unknown-metered' if t=='Bearer fixture-paid' else 'free'),'model':m} for c,t,m in policy_calls]
            report['telemetry']=events
            return 0
''' +s[bidx:]
s=s.replace("counts['stream_origin'] == (6 if policy_mode", "counts['stream_origin'] == (9 if policy_mode")
a.output.write_text(s)
