import { test, expect, mock, beforeEach } from 'bun:test';
const memory = new Map<string,string>();
const storage = { getItem:(k:string)=>memory.get(k)??null, setItem:(k:string,v:string)=>memory.set(k,v), removeItem:(k:string)=>memory.delete(k) };
const redirects:string[]=[];
const location = {protocol:'https:',hostname:'code.nothing.pink',origin:'https://code.nothing.pink',port:'',assign:(v:string)=>redirects.push(v)};
Object.assign(globalThis,{localStorage:storage,window:{location,addEventListener:()=>{}}});
const configurations:any[]=[];
let rejected=false;
mock.module('@/services/api/client',()=>({apiClient:{getConnectionRevision:()=>1,setConfig:(c:any)=>configurations.push(c)}}));
mock.module('@/services/api/legacyBackendProbe',()=>({LegacyBackendError:class extends Error {},probeLegacyBackend:async()=>false}));
mock.module('@/services/storage/secureStorage',()=>({obfuscatedStorage:{getItem:()=>null,setItem:(k:string,v:any)=>memory.set(k,JSON.stringify(v)),removeItem:(k:string)=>memory.delete(k)}}));
mock.module('@/utils/encryption',()=>({isCurrentObfuscated:()=>true}));
mock.module('@/stores/useConfigStore',()=>({useConfigStore:{getState:()=>({clearCache:()=>{},fetchConfig:async()=>{if(rejected)throw new Error('fixture unauthorized');return {};}})}}));
mock.module('@/stores/useModelsStore',()=>({useModelsStore:{getState:()=>({clearCache:()=>{}})}}));
mock.module('@/stores/useQuotaStore',()=>({useQuotaStore:{getState:()=>({clearQuotaCache:()=>{}})}}));
const {useAuthStore}=await import('../src/stores/useAuthStore');
beforeEach(()=>{memory.clear();configurations.length=0;redirects.length=0;rejected=false;location.protocol='https:';location.hostname='code.nothing.pink';location.origin='https://code.nothing.pink';useAuthStore.setState({isAuthenticated:false,managementKey:'',apiBase:'',rememberPassword:false});});
test('Access login pins origin and sends/persists no management key',async()=>{
 await useAuthStore.getState().login({apiBase:'https://foreign.invalid',managementKey:'must-not-persist',rememberPassword:true});
 expect(configurations.at(-1)).toEqual({apiBase:'https://code.nothing.pink',managementKey:''});
 expect(useAuthStore.getState().isAuthenticated).toBe(true);
 expect(useAuthStore.getState().rememberPassword).toBe(false);
 expect([...memory.values()].join('')).not.toContain('must-not-persist');
});
test('failed management admission never retains a previous authenticated state',async()=>{
 useAuthStore.setState({isAuthenticated:true});rejected=true;
 await expect(useAuthStore.getState().login({apiBase:location.origin,managementKey:''})).rejects.toThrow();
 expect(useAuthStore.getState().isAuthenticated).toBe(false);
});
test('direct native client on another host preserves its ordinary key path',async()=>{
 location.hostname='100.74.55.86';location.protocol='http:';location.origin='http://100.74.55.86:4195';
 await useAuthStore.getState().login({apiBase:location.origin,managementKey:'fixture-direct-key',rememberPassword:false});
 expect(configurations.at(-1)).toEqual({apiBase:location.origin,managementKey:'fixture-direct-key'});
});
test('Access logout clears state and goes to the official logout path',()=>{
 useAuthStore.setState({isAuthenticated:true});useAuthStore.getState().logout();
 expect(useAuthStore.getState().isAuthenticated).toBe(false);
 expect(redirects).toEqual(['/cdn-cgi/access/logout']);
});
