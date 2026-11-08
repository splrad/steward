import {it as test, vi, afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error The CLI module is JavaScript without a declaration file.
import {validateInitialization,initializeProduct} from '../../../scripts/layerscape-release-initialize.mjs';

afterEach(()=>vi.unstubAllEnvs());
type Options={remoteHead?:string;fetchedHead?:string;stateStatus?:number;private?:boolean;matches?:unknown;matchesStatus?:number};
type Fixture={run:()=>Promise<{status:string}>;calls:string[][];reads:Array<{url:string;init:RequestInit|undefined}>;readonly writes:number};

const head='a'.repeat(40),controller='b'.repeat(40),state='c'.repeat(40);
const environment=()=>({GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/layerscape-release-initialize.yml@refs/heads/main',
  GITHUB_SHA:controller,WORKFLOW_SHA:controller,APPROVED_CONTROLLER_SHA:controller,AUTHORIZE_INITIALIZATION:'true',EXPECTED_PRODUCT_HEAD:head});
test('only the approved controller, main workflow and explicit target head are admitted',()=>{
  const env=environment();assert.equal(validateInitialization(env).repository.id,1187527897);
  for(const key of Object.keys(env))assert.throws(()=>validateInitialization({...env,[key]:'invalid'}),/SOURCE/);
  assert.throws(()=>validateInitialization({...env,GITHUB_RUN_ATTEMPT:'2'}),/SOURCE/);
});

async function fixture(options:Options,operation:(fixture:Fixture)=>Promise<void>) {
  vi.stubEnv('STEWARD_APP_PRIVATE_KEY','test-only-private-key-sentinel');
  const root=await mkdtemp(join(tmpdir(),'layerscape-init-test-'));
  const calls:string[][]=[],reads:Fixture['reads']=[];let writes=0;
  const plan=validateInitialization(environment());
  const app={appBotId:301115370,forRepository:async(id:number,fn:(token:string)=>Promise<unknown>)=>{assert.equal(id,1187527897);return fn('writer');},
    forCandidateReadRepository:async(id:number,fn:(token:string)=>Promise<unknown>)=>{assert.equal(id,1187527897);return fn('reader');}};
  const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{
    reads.push({url:String(url),init});
    if(String(url).endsWith('/git/ref/heads/main'))return Response.json({object:{sha:options.remoteHead??head}});
    if(String(url).endsWith('/git/matching-refs/heads/steward/release-state'))return Response.json(options.matches??[],{status:options.matchesStatus??200});
    if(String(url).endsWith('/git/ref/heads/steward/release-state'))return options.stateStatus===200
      ?Response.json({object:{sha:state}}):new Response('',{status:options.stateStatus??404});
    if(String(url).endsWith('/repos/splrad/LayerScape'))return Response.json({id:1187527897,full_name:'splrad/LayerScape',
      private:options.private??false,default_branch:'main',archived:false,disabled:false});
    throw Error('unexpected read');
  };
  const execute=async(command:string,args:string[],settings:{env:NodeJS.ProcessEnv})=>{
    assert.equal(command,'git');assert.equal(settings.env.STEWARD_APP_PRIVATE_KEY,undefined);calls.push(args);
    if(args.includes('rev-parse'))return {stdout:args.at(-1)==='refs/heads/main'?(options.fetchedHead??head):state};
    return {stdout:''};
  };
  const initialize=async(request:{repositoryId:number;releaseAdoption:{prNumber:number;sourceSha:string};remote:string},credentials:{token:string})=>{
    writes++;assert.equal(request.repositoryId,1187527897);assert.equal(request.releaseAdoption.prNumber,176);
    assert.equal(request.releaseAdoption.sourceSha,'de10de20b5405d764bfda731ed91d11ac56b5b2c');
    assert.equal(credentials.token,'writer');assert.equal(request.remote,'https://github.com/splrad/LayerScape.git');
    return {status:options.stateStatus===200?'UNCHANGED':'APPLIED',head:state};
  };
  try {await operation({run:()=>initializeProduct(plan,{root,app,fetcher,execute,initialize}),calls,reads,get writes(){return writes;}});}
  finally {await rm(root,{recursive:true,force:true});}
}
test('fresh initialization delegates to the existing writer once without product checkout',async()=>fixture({},async f=>{
  assert.equal((await f.run()).status,'APPLIED');assert.equal(f.writes,1);
  assert.ok(f.calls.every(args=>!args.includes('checkout')));
}));
test('existing state is fetched and delegated for native idempotent reconciliation',async()=>fixture({stateStatus:200},async f=>{
  assert.equal((await f.run()).status,'UNCHANGED');assert.equal(f.writes,1);
  assert.ok(f.calls.some(args=>args.includes('refs/heads/steward/release-state:refs/heads/steward/release-state')));
}));
for(const options of [{remoteHead:state},{fetchedHead:state},{stateStatus:403},{private:true},
  {matches:[{ref:'refs/heads/steward/release-state'}]},{matches:{}},{matchesStatus:403}]) {
  test('changed or unreadable source stops before writes '+JSON.stringify(options),async()=>fixture(options,async f=>{
    await assert.rejects(f.run());assert.equal(f.writes,0);
  }));
}
