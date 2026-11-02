#!/usr/bin/env python3
"""Apply pinned native management Access/quarantine seams to prepared v8.0.49.
No downloads, credentials, network calls or deployment. Exact-source admission.
"""
import argparse,pathlib,hashlib,json,subprocess
PIN='250d598175db61a4e99ac38b9164ed04745754e5'
INPUTS={'handler.go':'c52eb5e58c292f942b21392ef8bd15bbe1776ee30f2b0d5af075a289164e3053','api_tools.go':'42dd488921fac47051ac957295e4296fd48712354b68e5f1a672794560df3855'}
def sha(b):return hashlib.sha256(b).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--prepared-source',required=True,type=pathlib.Path);p.add_argument('--upstream',required=True,type=pathlib.Path);a=p.parse_args();root=pathlib.Path(__file__).resolve().parent
 if json.loads((a.prepared_source/'provider-budget-manifest.json').read_text()).get('base_commit')!=PIN:p.error('Prepared source differs')
 d=a.prepared_source/'internal/api/handlers/management';changes={}
 for name,expected in INPUTS.items():
  original=subprocess.check_output(['git','-C',str(a.upstream),'show',PIN+':internal/api/handlers/management/'+name])
  if sha(original)!=expected:p.error('Pinned management input differs')
  old='\t\tclientIP := c.ClientIP()' if name=='handler.go' else '\tauth := h.authByIndex(authIndex)\n'
  new='\t\tif cfAccessGate(c) {\n\t\t\treturn\n\t\t}\n\n'+old if name=='handler.go' else old+'\tif managementQuarantineGuard(c, auth) {\n\t\treturn\n\t}\n'
  if original.decode().count(old)!=1:p.error('Pinned anchor differs')
  desired=original.decode().replace(old,new).encode()
  if (d/name).read_bytes() not in [original,desired]:p.error('Existing management edits differ')
  changes[name]=desired
 for folder,names in [('cloudflare_management',['cloudflare_access.go','cloudflare_access_test.go']),('management_quarantine',['management_quarantine.go','management_quarantine_test.go'])]:
  for name in names:
   value=(root/'patches'/folder/name).read_bytes()
   if (d/name).exists() and (d/name).read_bytes()!=value:p.error('Existing helper differs')
   changes[name]=value
 route = a.prepared_source/'internal/api/server_routes.go'
 original_route = subprocess.check_output(['git','-C',str(a.upstream),'show',PIN+':internal/api/server_routes.go'])
 if sha(original_route) != 'a22703ae5533111f51f03cb037ca1f15a4ced10ebd95d1fa06159245c36fb5bb':p.error('Pinned routes input differs')
 anchor = '\ts.engine.GET("/management.html", s.serveManagementControlPanel)'
 if original_route.decode().count(anchor) != 1:p.error('Pinned panel route differs')
 desired_route = original_route.decode().replace(anchor, anchor+'\n\ts.engine.GET("/dashboard", s.serveManagementControlPanel)').encode()
 if route.read_bytes() not in [original_route,desired_route]:p.error('Existing routes differ')
 for name,value in changes.items():(d/name).write_bytes(value)
 route.write_bytes(desired_route)
 manifest={'base_commit':PIN,'input_hashes':INPUTS,'routes_input_sha256':sha(original_route),'routes_output_sha256':sha(desired_route),'outputs':{name:sha(data) for name,data in changes.items()},'auth':'verified Cloudflare assertion or existing native management key; inference unchanged','credential_quarantine':'disabled credentials refused before management upstream HTTP'}
 (a.prepared_source/'management-auth-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'prepared':str(a.prepared_source),'files':len(changes),'deployed':False}))
if __name__=='__main__':main()
