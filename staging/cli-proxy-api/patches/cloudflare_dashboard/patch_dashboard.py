#!/usr/bin/env python3
"""Patch pinned native panel for same-origin Cloudflare Access authentication.
No management secret, fake key, authentication bypass, or provider requests.
"""
import argparse,pathlib,subprocess,tarfile,tempfile,hashlib,json
PIN='4e4aeff23f9f82b3ccdbe48b2e774d5dc918234e'
def replace(text,anchor,new):
 if text.count(anchor)!=1:raise RuntimeError('Pinned dashboard anchor differs')
 return text.replace(anchor,new)
def main():
 p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=pathlib.Path);p.add_argument('--output',required=True,type=pathlib.Path);a=p.parse_args()
 if a.output.exists():p.error('Output exists; refusing replay')
 if subprocess.check_output(['git','-C',str(a.source),'rev-parse','HEAD'],text=True).strip()!=PIN:p.error('Unexpected dashboard source')
 with tempfile.TemporaryFile() as f:
  subprocess.run(['git','-C',str(a.source),'archive',PIN],stdout=f,check=True);f.seek(0);a.output.mkdir(mode=0o700)
  with tarfile.open(fileobj=f) as archive:archive.extractall(a.output,filter='data')
 utils=a.output/'src/utils/cloudflareAccess.ts'
 utils.write_text("export const isCloudflareAccessHost = (): boolean => typeof window !== 'undefined' && window.location.protocol === 'https:' && window.location.hostname === 'code.nothing.pink';\n")
 s=a.output/'src/stores/useAuthStore.ts';t=s.read_text();before=hashlib.sha256(s.read_bytes()).hexdigest()
 t=replace(t,"import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';", "import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';\nimport { isCloudflareAccessHost } from '@/utils/cloudflareAccess';\n\nif (isCloudflareAccessHost()) {\n localStorage.removeItem(STORAGE_KEY_AUTH);\n localStorage.removeItem('managementKey');\n localStorage.removeItem('isLoggedIn');\n if (window.location.pathname === '/management.html') window.location.replace('/dashboard'+window.location.hash);\n}")
 t=replace(t,"restoreSessionPromise = (async () => {", "restoreSessionPromise = (async () => {\n          if (isCloudflareAccessHost()) {\n            try {\n              await get().login({apiBase:window.location.origin+'/admin', managementKey:'', rememberPassword:false});\n              return true;\n            } catch { return false; }\n          }")
 t=replace(t,"hasRestorableSession: () => {", "hasRestorableSession: () => {\n        if (isCloudflareAccessHost()) return true;")
 t=replace(t,"const apiBase = normalizeApiBase(credentials.apiBase);", "const apiBase = isCloudflareAccessHost() ? window.location.origin+'/admin' : normalizeApiBase(credentials.apiBase);")
 t=replace(t,"const managementKey = credentials.managementKey.trim();", "const managementKey = isCloudflareAccessHost() ? '' : credentials.managementKey.trim();")
 t=replace(t,"const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;", "const rememberPassword = isCloudflareAccessHost() ? false : (credentials.rememberPassword ?? get().rememberPassword ?? false);")
 t=replace(t,"localStorage.removeItem('isLoggedIn');\n      },", "localStorage.removeItem('isLoggedIn');\n        if (isCloudflareAccessHost()) window.location.assign('/cdn-cgi/access/logout');\n      },")
 t=replace(t,"if (!managementKey || !apiBase) {", "if ((!managementKey && !isCloudflareAccessHost()) || !apiBase) {")
 t=replace(t,"set({ connectionStatus: 'error' });", "set({ connectionStatus: 'error', ...(isCloudflareAccessHost() ? {isAuthenticated:false, managementKey:''} : {}) });")
 s.write_text(t)
 f=a.output/'src/pages/LoginPage.tsx';t=f.read_text();anchor="export function LoginPage()" if 'export function LoginPage()' in t else None
 t="import { isCloudflareAccessHost } from '@/utils/cloudflareAccess';\n"+t
 pos=t.index('  return (',t.index('  const handleSubmit'))
 t=t[:pos]+'''  if (isCloudflareAccessHost()) {
    return <main style={{padding:48,fontFamily:'system-ui'}}>
      <h1>Gateway administration</h1>
      <p>{autoLoading ? 'Checking your Cloudflare Access session…' : 'Cloudflare Access sign-in is required. No management key is needed.'}</p>
      {!autoLoading && <button onClick={() => window.location.assign('/cdn-cgi/access/logout')}>Sign in again with Cloudflare Access</button>}
    </main>;
  }

'''+t[pos:];f.write_text(t)
 (a.output/'cloudflare-dashboard-manifest.json').write_text(json.dumps({'source_commit':PIN,'access_host':'code.nothing.pink','auth_store_input_sha256':before,'patched':{str(f.relative_to(a.output)):hashlib.sha256(f.read_bytes()).hexdigest(),str(s.relative_to(a.output)):hashlib.sha256(s.read_bytes()).hexdigest()},'management_key_in_browser':False},indent=2))
 print(json.dumps({'prepared':str(a.output),'source':PIN}))
if __name__=='__main__':main()
