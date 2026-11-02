import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(process.argv[2],'utf8');
function fn(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
const api=fn('  function api(', '  // identity is');
for(const keyless of [true,false]){
 let request;
 const context={KEYLESS_SAME_ORIGIN:keyless,stopped:false,HOST_PREFIX:'@host',HOST_MGMT:'/admin/v0/management',MGMT:'/admin/v0/management/plugins/free-model-hub',
 managementKey(){if(keyless)throw Error('keyless mode read browser credentials');return 'fixture-native-key';},
 haltOnAuthFailure(){return false;},Promise,JSON,
 fetch(url,options){request={url,options};return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});}};
 runInNewContext(api+'\nresult=api("POST","/accounts/add",{vendor:"groq",api_key:"fixture-only"});',context);
 await context.result;
 assert.equal(request.url,'/admin/v0/management/plugins/free-model-hub/accounts/add');
 assert.equal(request.options.headers.Authorization,keyless?undefined:'Bearer fixture-native-key');
}
const failure=fn('  function haltOnAuthFailure(', '  // revealKeyInput');
let revealed=false;
const box={hidden:false};
const context={KEYLESS_SAME_ORIGIN:true,stopped:false,authReady:true,logTimer:null,
 stopLoginPolling(){},revealKeyInput(){revealed=true;},setKeyStatus(){},banner(){},document:{getElementById(){return box;}}};
runInNewContext(failure+'\nresult=haltOnAuthFailure(401);',context);
assert.equal(context.result,true);assert.equal(context.stopped,true);assert.equal(context.authReady,false);
assert.equal(revealed,false);assert.equal(box.hidden,true);
console.log('console keyless/native-key requests and failure handling: pass');
