import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {parse} from 'yaml';
import {releaseBuildCommand} from '../src/release-build-command.js';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../github/src/index.js',async original=>({...await original<any>(),createInstallationToken:vi.fn(async()=> 'fixture')}));
vi.mock('../src/release-lifecycle.js',async original=>({...await original<any>(),ReleaseReceiptClient:class {request=request;}}));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
const workflow=parse(readFileSync(new URL('../../../.github/workflows/release-build.yml',import.meta.url),'utf8'));
it.each(['initial','request','migration','invalid-request','invalid-dispatch','both'])('resolves actual workflow run-name slots: %s',async mode=>{
 const policy='a'.repeat(40),inputs:Record<string,string>={repositoryId:'9001',targetTag:'v1.2.3',requestKey:'',dispatchKey:''};
 if(['request','both'].includes(mode))inputs.requestKey='b'.repeat(64);
 if(['migration','both'].includes(mode))inputs.dispatchKey='c'.repeat(64);
 if(mode==='invalid-request')inputs.requestKey='invalid';
 if(mode==='invalid-dispatch')inputs.dispatchKey='invalid';
 const title=workflow['run-name'].replace(/\$\{\{ inputs\.(\w+) \}\}/g,(_text:string,key:string)=>inputs[key]);
 for(const [key,value]of Object.entries({APP_ID:'1',INSTALLATION_ID:'1',STEWARD_APP_PRIVATE_KEY:'fixture',RUNTIME_URL:'https://runtime.example/'}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:10,repository:{id:1296724484},head_sha:policy,path:'.github/workflows/release-build.yml',event:'workflow_dispatch',status:'completed',run_attempt:1,display_title:title})));
 request.mockResolvedValue(null);
 const invoke=()=>releaseBuildCommand({operation:'resolve','policy-sha':policy,'run-id':'10'});
 if(mode.startsWith('invalid')||mode==='both'){
  await expect(invoke()).rejects.toThrow('BUILD_RUN_NAME');expect(request).not.toHaveBeenCalled();
 }else{
  await expect(invoke()).resolves.toBeUndefined();expect(request).toHaveBeenCalledWith('build-request',{action:'find',runId:10,attempt:1});
 }
});
