import {it as test, vi, afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error The CLI module is JavaScript without a declaration file.
import {validateInitialization,initializeProduct,closeout192} from '../../../scripts/layerscape-release-initialize.mjs';

afterEach(()=>vi.unstubAllEnvs());
type Options={remoteHead?:string;fetchedHead?:string;stateStatus?:number;private?:boolean;matches?:unknown;matchesStatus?:number;closeoutHead?:string};
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
test('the closeout operation requires an exact state head and central read token',()=>{
  const env={...environment(),RELEASE_OPERATION:'closeout-192',EXPECTED_STATE_HEAD:state,GITHUB_TOKEN:'read-only'};
  assert.equal(validateInitialization(env).closeoutHead,state);
  for(const change of [{EXPECTED_STATE_HEAD:''},{RELEASE_OPERATION:'closeout'},{GITHUB_TOKEN:''}])
    assert.throws(()=>validateInitialization({...env,...change}),/SOURCE/);
});

async function fixture(options:Options,operation:(fixture:Fixture)=>Promise<void>) {
  vi.stubEnv('STEWARD_APP_PRIVATE_KEY','test-only-private-key-sentinel');
  const root=await mkdtemp(join(tmpdir(),'layerscape-init-test-'));
  const calls:string[][]=[],reads:Fixture['reads']=[];let writes=0;
  const plan=validateInitialization(options.closeoutHead?{...environment(),RELEASE_OPERATION:'closeout-192',
    EXPECTED_STATE_HEAD:options.closeoutHead,GITHUB_TOKEN:'read-only'}:environment());
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
  try {await operation({run:()=>initializeProduct(plan,{root,app,fetcher,execute,initialize,centralIo:{}}),calls,reads,get writes(){return writes;}});}
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
test('closeout stops before Git or state writes when the approved release-state head moved',async()=>fixture({
  stateStatus:200,closeoutHead:head,
},async f=>{
  await assert.rejects(f.run(),/STATE_CHANGED/);
  assert.equal(f.writes,0);
  assert.deepEqual(f.calls,[]);
}));

function closeoutFixture(mode:'apply'|'closed'|'no-archive'|'moved-candidate'|'moved-main'|'moved-controller'|'moved-state') {
  const sourceSha='3755e1426c3d9776927658480fe610b298c27813',cycleId='pr-192-'+sourceSha,applied='d'.repeat(40);
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  const observedAt='2026-11-19T06:55:17Z',requiredChannels=['ghcr-assets','winget'].map(channelId=>({
    unitId:'layerscape',channelId,version:'1.0.0',digest:digest('manifest'),inputDigest:digest(channelId),private:false,
  }));
  const unit={id:'layerscape',version:'1.0.0',tag:'v1.0.0',releaseId:450956063,authorId:301115370,
    manifestDigest:digest('manifest'),notesDigest:digest('notes'),assets:[{path:'payload.zip',size:10,sha256:digest('bytes')}]};
  const source={repositoryId:1187527897,cycleId,sourceSha,deliveryConfigSha:head,units:[unit],requiredChannels};
  const {id,...release}=unit,payload='native publication result',evidenceDigest=digest(payload);
  const provenance=[{path:'evidence/publication/'+evidenceDigest+'.json',digest:evidenceDigest,sourceUrl:'https://api.github.com/repos/splrad/LayerScape',observedAt}];
  const observation={source,sourceComplete:true,observedAt,releasesComplete:true,channelsComplete:true,
    releases:[{...release,unitId:id,sourceSha,draft:false,immutable:true,evidenceDigest}],
    channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]};
  const completion={schemaVersion:1,repositoryId:1187527897,cycleId,source,observation,provenance};
  const completionPath='evidence/completion/'+digest(JSON.stringify(completion)+'\n')+'.json';
  const cycle={id:cycleId,units:[unit],requiredChannels,channelFacts:[{nativeObjectId:'484181',acceptedAt:null}],completedEvidencePath:completionPath};
  const candidateId=digest('candidate'),sessionPath='generated/'+candidateId+'/session.json';
  const sessionText=JSON.stringify({generated:null,pending:null,identity:null,conflict:null,preview:null,adoption:null});
  const session={path:sessionPath,value:{schemaVersion:1,repositoryId:1187527897,candidateId,documentKind:'session',
    documentDigest:digest(sessionText),index:0,count:1,content:sessionText}};
  const active={activeCycleId:cycleId,lastCompletedCycleId:null,candidate:{prNumber:201,id:candidateId,publishedHead:head}};
  const closed={...active,activeCycleId:null,lastCompletedCycleId:cycleId};
  const before={head:state,history:[],cycles:[{value:cycle}],repository:['closed','no-archive'].includes(mode)?closed:active,
    currentPaths:[sessionPath],domainRecords:mode==='no-archive'?[session]:
      [session,{path:completionPath,value:completion},{path:provenance[0]!.path,content:payload}]};
  let current=state,currentMain=head,currentController=controller,writes=0;
  const bytes=(value:unknown)=>({status:200,bytes:Buffer.from(JSON.stringify(value))});
  const io={async request(_method:string,path:string){
    if(path.endsWith('/ref/heads/main'))return bytes({ref:'refs/heads/main',object:{type:'commit',sha:currentMain}});
    if(path.endsWith('/ref/heads/steward/release-state'))
      return bytes({ref:'refs/heads/steward/release-state',object:{type:'commit',sha:current}});
    if(path.endsWith('/pulls/201'))return bytes({number:201,state:'open',
      head:{ref:'steward/release-candidate',repo:{id:1187527897},sha:mode==='moved-candidate'?state:head},base:{ref:'main'}});
    const sources:Record<string,unknown>={'state.json':closed,['cycles/'+cycleId+'.json']:cycle,[completionPath]:completion};
    for(const [file,value] of Object.entries(sources))if(path.endsWith('/contents/'+file+'?ref='+applied))
      return bytes({path:file,encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64')});
    throw new Error('unexpected read '+path);
  }};
  const centralIo={async request(){return bytes({object:{sha:currentController}});}};
  const inspectHistory=async(_request:unknown,hooks:{beforeArchivePush():Promise<void>;completionReader(cycle:unknown):unknown})=>{
    assert.equal(hooks.completionReader(cycle),completion);
    if(mode==='moved-main')currentMain=state;
    if(mode==='moved-controller')currentController=head;
    await hooks.beforeArchivePush();
    writes++;
    current=mode==='moved-state'?head:applied;
    return {result:'PASS',archiveHead:applied,lastCompletedCycleId:cycleId};
  };
  return {run:()=>closeout192({closeoutHead:state,controllerSha:controller,baseSha:head},{repository:'splrad/LayerScape'},{
    io,centralIo,readRecords:async()=>before,readCompletion:async()=>completion,inspectHistory,
  }),get writes(){return writes;}};
}

test('closeout archives GitHub completion while retaining candidate and channel facts',async()=>{
  const f=closeoutFixture('apply');
  assert.equal((await f.run()).status,'APPLIED');
  assert.equal(f.writes,1);
});
test('a fully evidenced closeout can be read again without a write',async()=>{
  const f=closeoutFixture('closed');
  assert.equal((await f.run()).status,'UNCHANGED');
  assert.equal(f.writes,0);
});
test('a completed pointer without its archive is rejected',async()=>{
  const f=closeoutFixture('no-archive');
  await assert.rejects(f.run(),/NOT_APPLIED/);
  assert.equal(f.writes,0);
});
test('closeout rejects a candidate head outside the protected session',async()=>{
  const f=closeoutFixture('moved-candidate');
  await assert.rejects(f.run(),/STATE_CHANGED/);
  assert.equal(f.writes,0);
});
for(const mode of ['moved-main','moved-controller'] as const)
  test('a source change detected at the push boundary prevents a write: '+mode,async()=>{
    const f=closeoutFixture(mode);
    await assert.rejects(f.run(),/STATE_CHANGED/);
    assert.equal(f.writes,0);
  });
test('a moved state ref after the push prevents an applied result',async()=>{
  await assert.rejects(closeoutFixture('moved-state').run(),/STATE_CHANGED/);
});

for(const options of [{remoteHead:state},{fetchedHead:state},{stateStatus:403},{private:true},
  {matches:[{ref:'refs/heads/steward/release-state'}]},{matches:{}},{matchesStatus:403}]) {
  test('changed or unreadable source stops before writes '+JSON.stringify(options),async()=>fixture(options,async f=>{
    await assert.rejects(f.run());assert.equal(f.writes,0);
  }));
}
