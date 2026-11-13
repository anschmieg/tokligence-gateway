#!/usr/bin/env python3
"""Root-run, read-only export of selected static keys from running VPS gateways.
No OAuth fields/DBs, no service stop/restart/config writes, no secret stdout.
Output is a private agent-owned export for the authorized staging migration.
"""
import json,os,pathlib,pwd,re,subprocess
ROOT=pathlib.Path('/home/agent/cliproxy-staging')
NAMES=['OPENROUTER_API_KEY','MISTRAL_API_KEY','CEREBRAS_API_KEY','GROQ_API_KEY','NVIDIA_API_KEY','TOGETHER_API_KEY','NOUS_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY']

def main():
 if os.geteuid()!=0:raise RuntimeError('Run as root on personal/VPS; agent cannot access deployment Docker')
 if ROOT.is_symlink() or not ROOT.is_dir():raise RuntimeError('Unexpected staging root')
 target=ROOT/'secrets/deployed-static-keys'
 if target.is_symlink():raise RuntimeError('Export directory symlink refused')
 target.mkdir(mode=0o700,exist_ok=True)
 account=pwd.getpwnam('agent');os.chown(target,account.pw_uid,account.pw_gid);target.chmod(0o700)
 candidates={}
 for proc in pathlib.Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   args=(proc/'cmdline').read_bytes().split(b'\0')
   if not any(a==b'tgw-proxy.mjs' or a.endswith(b'/tgw-proxy.mjs') for a in args):continue
   match=re.search(r'docker-([0-9a-f]{64})\.scope',(proc/'cgroup').read_text())
   if match:candidates[match[1]]=int(proc.name)
  except (FileNotFoundError,PermissionError,ProcessLookupError):continue
 if not candidates:raise RuntimeError('No running deployed gateway identified; no export performed')
 report=[]
 for container,pid in candidates.items():
  # Inspect only non-secret status/port metadata, never full Docker Config.Env.
  running=subprocess.run(['docker','inspect','--format','{{.State.Running}}',container],capture_output=True,text=True,check=True).stdout.strip()
  if running!='true':raise RuntimeError('Gateway container stopped during discovery')
  program='const names='+json.dumps(NAMES)+'; const out={}; for(const name of names){if(process.env[name])out[name]=process.env[name]} process.stdout.write(JSON.stringify(out));'
  result=subprocess.run(['docker','exec','--env','NODE_OPTIONS=','--env','NODE_PATH=',container,'node','-e',program],capture_output=True,check=True)
  values=json.loads(result.stdout)
  if any(k not in NAMES or not isinstance(v,str) or '\n' in v or '\r' in v or '\x00' in v for k,v in values.items()):raise RuntimeError('Selected static-key data has unexpected shape')
  path=target/(container+'.env')
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  os.fchown(fd,account.pw_uid,account.pw_gid)
  with os.fdopen(fd,'w') as output:
   for name,value in values.items():output.write(name+'='+json.dumps(value)+'\n')
   output.flush();os.fsync(output.fileno())
  ports=subprocess.run(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',container],capture_output=True,text=True,check=True).stdout
  report.append({'container':container,'gateway_pid':pid,'ports':json.loads(ports),'key_names':sorted(values),'export':str(path)})
 report_path=target/'inventory.json'
 fd=os.open(report_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.fchown(fd,account.pw_uid,account.pw_gid)
 with os.fdopen(fd,'w') as output:json.dump({'source':'running deployed VPS gateway processes','containers':report},output,indent=2)
 print(json.dumps({'deployed_gateways':len(report),'provider_key_names':[r['key_names'] for r in report],'private_inventory':str(report_path),'oauth_read_or_copied':False,'service_changes':False}))

if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'outcome':'not_completed','reason':str(error) if isinstance(error,RuntimeError) else type(error).__name__,'secrets_printed':False}));raise SystemExit(2)
