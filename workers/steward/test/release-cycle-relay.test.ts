import {GitHubRetryError} from '../src/bounded-retry-after.js';
import {describe,expect,it} from 'vitest';
import {ReleaseRelay,releaseHint,relayKey,acceptReleaseHint} from '../src/release-cycle-relay.js';
import {CENTRAL,TARGET} from '../src/bounded-recheck-github.js';
import {SqliteDurableStorage} from './bounded-storage.js';

const pin='1'.repeat(40),deployment='2'.repeat(40);
const repo={id:TARGET.id,full_name:TARGET.name,default_branch:'main',fork:false,archived:false};
const payload={installation:{id:7},repository:repo,ref:'refs/heads/main',after:pin,deleted:false};
const hint=releaseHint('push',payload,'7')!;
const receipt={id:12,run_attempt:1,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},path:'.github/workflows/release-cycle-event.yml',
  head_branch:'main',head_sha:pin,actor:{id:301115370},event:'workflow_dispatch',display_title:'Release cycle '+relayKey(hint)};
function fixture(){
 const storage=new SqliteDurableStorage();
 const env={BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:deployment};
 const state={now:Date.now(),promoted:'3'.repeat(40),posts:0,hits:[] as any[]};
 const g={async json(id:number,path:string,method?:string){
   expect(id).toBe(CENTRAL.id);
   if(method==='POST'){state.posts++;throw Error('unknown POST response');}
   if(path.includes('/git/ref/heads/'))return {ref:'refs/heads/'+(path.endsWith('main')?'main':'steward/validated-controller'),object:{type:'commit',sha:path.endsWith('main')?pin:state.promoted}};
   if(path.includes('/contents/')){const content=Buffer.from(JSON.stringify({enabled:true,schemaVersion:1,deploymentSha:deployment}));return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:content.length,content:content.toString('base64')};}
   if(path.includes('/runs?'))return {total_count:state.hits.length,workflow_runs:state.hits};
   if(path.endsWith('/release-cycle-event.yml'))return {state:'active',path:receipt.path};
   throw Error(path);
 }};
 const relay=new ReleaseRelay(storage as any,env as any,()=>g as any,()=>state.now);
 const tick=async()=>{state.now=await storage.get<number>('__alarm')??state.now;await relay.alarm();};
 return {state,relay,storage,tick,env,g};
}
describe('release cycle relay',()=>{
 it('retains signed product source and excludes unrelated repos and branches and forwards successful probes',()=>{
  expect(hint).toEqual({repositoryId:TARGET.id,kind:'push',sourceSha:pin});
  expect(releaseHint('push',payload,'8')).toBeUndefined();
  expect(releaseHint('push',{...payload,ref:'refs/heads/topic'},'7')).toBeUndefined();
  const run={id:12,run_attempt:2,head_repository:{id:TARGET.id},head_branch:'main',actor:{id:301115370},status:'completed',event:'workflow_dispatch',path:'.github/workflows/steward-release-channels.yml',workflow_id:410998651,display_title:'Channels submit '+'f'.repeat(64)};
  const p={...payload,action:'completed',workflow_run:run};
  expect(releaseHint('workflow_run',p,'7')).toEqual({repositoryId:TARGET.id,kind:'run',runId:12,attempt:2});
  const build={...run,workflow_id:410998652,path:'.github/workflows/steward-release-publish.yml',display_title:'Build '+'a'.repeat(64),head_branch:'steward/build/pr-192-'+pin};
  expect(releaseHint('workflow_run',{...p,workflow_run:build},'7')).toEqual({repositoryId:TARGET.id,kind:'run',runId:12,attempt:2});
  expect(releaseHint('workflow_run',{...p,workflow_run:{...build,head_branch:'main'}},'7')).toBeUndefined();
  run.display_title='Channels observe '+'f'.repeat(64);expect(releaseHint('workflow_run',p,'7')).toBeUndefined();Object.assign(run,{conclusion:'success'});expect(releaseHint('workflow_run',p,'7')?.kind).toBe('run');
 });
 it('routes only a same-repository candidate synchronize event with its exact new head',()=>{
  const pull = {number:201,state:'open',merged:false,base:{ref:'main',repo:{id:TARGET.id}},
    head:{ref:'steward/release-candidate',repo:{id:TARGET.id},sha:pin}};
  const p = {...payload,action:'synchronize',number:201,pull_request:pull};
  expect(releaseHint('pull_request',p,'7')).toEqual({repositoryId:TARGET.id,kind:'candidate-head',prNumber:201,head:pin});
  expect(releaseHint('pull_request',{...p,pull_request:{...pull,merged:null}},'7')?.kind).toBe('candidate-head');
  const {after, ...creation} = p;
  expect(releaseHint('pull_request',{...creation,action:'opened'},'7')).toEqual(releaseHint('pull_request',p,'7'));
  expect(releaseHint('pull_request',{...p,action:'edited'},'7')).toBeUndefined();
  expect(releaseHint('pull_request',{...p,after:deployment},'7')).toBeUndefined();
  expect(releaseHint('pull_request',{...p,pull_request:{...pull,head:{...pull.head,ref:'topic'}}},'7')).toBeUndefined();
  expect(releaseHint('pull_request',{...p,pull_request:{...pull,head:{...pull.head,repo:{id:99}}}},'7')).toBeUndefined();
 });

 it('rewakes on each trusted bot body edit independently of the head delivery',()=>{
  const body='<!-- steward:candidate-homepage:'+'a'.repeat(64)+' -->';
  const pull={number:201,state:'open',merged:false,body,base:{ref:'main',repo:{id:TARGET.id}},
    head:{ref:'steward/release-candidate',repo:{id:TARGET.id},sha:pin}};
  const edit={...payload,action:'edited',number:201,pull_request:pull,sender:{id:301115370},changes:{body:{from:'Previous body'}}};
  const delivery = '35fcb56f-61cf-4a3d-a31a-24d2582253a3';
  const hint=releaseHint('pull_request',edit,'7',undefined,delivery)!;
  expect(hint).toEqual({repositoryId:TARGET.id,kind:'candidate-head',prNumber:201,head:pin,delivery});
  const head = releaseHint('pull_request',{...edit,action:'synchronize'},'7')!;
  expect(relayKey(hint)).not.toBe(relayKey(head));
  expect(relayKey(releaseHint('pull_request',edit,'7',undefined,delivery)!)).toBe(relayKey(hint));
  const next = releaseHint('pull_request',edit,'7',undefined,'f7872c8d-a174-49c1-95a0-764ff509b452')!;
  expect(relayKey(next)).not.toBe(relayKey(hint));
  expect(releaseHint('pull_request',edit,'7')).toBeUndefined();
  expect(releaseHint('pull_request',{...edit,sender:{id:42}},'7',undefined,delivery)).toBeUndefined();
  expect(releaseHint('pull_request',{...edit,changes:{title:{from:'Old'}}},'7',undefined,delivery)).toBeUndefined();
 });
 it('accepts only the closed-and-merged official PR snapshot and deduplicates its review text by merge identity',async()=>{
  const target={...repo,private:false,visibility:'public',disabled:false,owner:{id:302208797}};
  const pull={number:301,state:'closed',merged:true,merged_at:'2026-11-23T00:00:00Z',merge_commit_sha:deployment,
    user:{id:301115370},body:'Header\n---\n## [1.1.0](https://github.com/example)\n\n发布说明。\n---\nFooter',
    title:'chore(main): release 1.1.0',labels:[{name:'autorelease: pending'}],base:{ref:'main',repo:{id:TARGET.id}},
    head:{ref:'release-please--branches--main',repo:{id:TARGET.id},sha:pin}};
  const event={...payload,repository:target,action:'closed',number:301,pull_request:pull};
  const accepted=releaseHint('pull_request',event,'7')!;
  expect(accepted).toEqual({repositoryId:TARGET.id,kind:'official-merge',prNumber:301,head:pin,sourceSha:deployment,
    mergedAt:pull.merged_at,title:pull.title,body:pull.body});
  expect(relayKey(releaseHint('pull_request',{...event,pull_request:{...pull,body:'different delivery text'}},'7')!)).toBe(relayKey(accepted));
  for(const change of [{merged:false},{user:{id:42}},{labels:[]},{head:{...pull.head,repo:{id:3}}},{head:{...pull.head,ref:'feature'}}])
    expect(releaseHint('pull_request',{...event,pull_request:{...pull,...change}},'7')).toBeUndefined();
  const recorded:any[]=[];
  const env={BOUNDED_RECHECK_ENABLED:'true',INSTALLATION_ID:'7',BOUNDED_RECHECK:{idFromName:(name:string)=>name,get:(name:string)=>({
    async fetch(r:Request){recorded.push([name,await r.json()]);return new Response(null,{status:204});}
  })}};
  await acceptReleaseHint(env as any,'pull_request',event);
  expect(recorded).toEqual([['cycle:v1:'+relayKey(accepted),{hint:accepted,source:{name:TARGET.name,defaultBranch:'main'}}]]);
  const tagged={...event,action:'labeled',label:{name:'autorelease: tagged'},sender:{id:301115370},
    pull_request:{...pull,labels:[{name:'autorelease: tagged'}]}};
  expect(releaseHint('pull_request',tagged,'7')).toEqual({repositoryId:TARGET.id,kind:'official-refresh',prNumber:301,head:pin,releasedSha:deployment});
  expect(releaseHint('pull_request',{...tagged,sender:{id:42}},'7')).toBeUndefined();
  for(const action of ['opened','synchronize','ready_for_review','reopened'])
    expect(releaseHint('pull_request',{...event,action,pull_request:{...pull,state:'open',merged:false}},'7')).toBeUndefined();
  const edit={...event,action:'edited',sender:{id:42,type:'User'},changes:{body:{from:'old'}},
    pull_request:{...pull,state:'open',merged:false}};
  expect(releaseHint('pull_request',edit,'7')?.kind).toBe('official-edit');
  expect(releaseHint('pull_request',{...edit,sender:{id:301115370,type:'Bot'}},'7')).toBeUndefined();
 });
 it('routes only the app bot creation of a status comment on an open pull request',()=>{
  const event={...payload,action:'created',sender:{id:301115370},issue:{number:201,state:'open',pull_request:{}},comment:{
    id:51,user:{id:301115370},body:'<!-- steward:candidate-status:'+'a'.repeat(64)+' -->\nStatus'}};
  expect(releaseHint('issue_comment',event,'7')).toEqual({repositoryId:TARGET.id,kind:'candidate-status',prNumber:201,commentId:51});
  expect(releaseHint('issue_comment',{...event,action:'edited'},'7')).toBeUndefined();
  expect(releaseHint('issue_comment',{...event,issue:{number:201,state:'open'}},'7')).toBeUndefined();
  expect(releaseHint('issue_comment',{...event,comment:{...event.comment,user:{id:42}}},'7')).toBeUndefined();
 });
 it('retains its original object across promotion lag, response loss and duplicate registration',async()=>{
  const f=fixture();await f.relay.register(hint);await f.tick();expect(f.state.posts).toBe(0);
  f.state.promoted=pin;await f.tick();expect(f.state.posts).toBe(1);
  const stored=await f.storage.get('releaseCycle');await f.relay.register(hint);expect(await f.storage.get('releaseCycle')).toEqual(stored);
  f.state.hits=[{...receipt,head_sha:'0'.repeat(40)}];await f.tick();
  f.state.hits=[receipt];await f.tick();expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'received',runId:12});
  expect(await f.storage.get('__alarm')).toBeUndefined();expect(f.state.posts).toBe(1);
 });
 it.each([['queued',null],['in_progress',null],['completed','failure'],['completed','success']])(
  'keeps the receiver run ID across duplicate hints when the run is %s/%s',async(status,conclusion)=>{
   const f=fixture();f.state.promoted=pin;
   await f.relay.register(hint);await f.tick();
   f.state.hits=[{...receipt,status,conclusion}];await f.tick();
   await f.relay.register(hint);await f.tick();
   expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'received',runId:receipt.id});
   expect(f.state.posts).toBe(1);
 });
 it('closes unknown delivery without repeat POST or idle alarm',async()=>{
  const f=fixture();f.state.promoted=pin;await f.relay.register(hint);
  for(let i=0;i<6;i++)await f.tick();
  expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'unknown',reason:'DELIVERY_UNKNOWN'});
  expect(await f.storage.get('__alarm')).toBeUndefined();expect(f.state.posts).toBe(1);
 });
});
it('recovers a never-posted event after promotion without another POST for unknown delivery',async()=>{
 const f=fixture();await f.relay.register(hint);
 for(let i=0;i<4;i++)await f.tick();
 expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'unknown',reserved:0,waitingFor:pin,tries:4});
 f.state.promoted=pin;await f.relay.wakePromoted(pin);await f.tick();expect(f.state.posts).toBe(1);
 for(let i=0;i<4;i++)await f.tick();
 expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'unknown',reason:'DELIVERY_UNKNOWN'});
 await f.relay.register(hint);await f.relay.wakePromoted(pin);await f.tick();expect(f.state.posts).toBe(1);
});
it('binds a protected build ref and the original operation before dispatch',async()=>{
 const cycleId='pr-192-'+pin, op='a'.repeat(64), ref='steward/build/'+cycleId, f=fixture();
 const created=new Date().toISOString();
 const run={id:101,run_attempt:2,status:'completed',head_sha:pin,head_branch:ref,event:'workflow_dispatch',actor:{id:301115370},
   repository:{id:TARGET.id},head_repository:{id:TARGET.id},workflow_id:410998652,path:'.github/workflows/steward-release-publish.yml',display_title:'Build '+op,created_at:created};
 const cycle={id:cycleId,sourceSha:pin,dispatches:[{purpose:'build',ref,executionSha:pin,sourceSha:pin,workflowId:410998652,canonicalRunId:101,operationKey:op,sentAt:created}]};
 const {createHash}=await import('node:crypto');
 const bytes=Buffer.from(JSON.stringify(cycle)), blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 let post:any;
 const reader={json:async(id:number,path:string,method?:string,body?:unknown)=>{
   if(path.endsWith('/attempts/2'))return run;
   if(path.endsWith('/heads/steward/release-state'))return {ref:'refs/heads/steward/release-state',object:{type:'commit',sha:pin}};
   if(path.includes('/contents/cycles/'))return {path:'cycles/'+cycleId+'.json',type:'file',encoding:'base64',size:bytes.length,sha:blob,content:bytes.toString('base64')};
   if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha:pin}};
   if(path.includes('/contents/config/')){const b=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:deployment}));return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:b.length,content:b.toString('base64')};}
   if(method==='POST'){post=body;return null;}
   return {state:'active',path:receipt.path};
 }};
 const relay=new ReleaseRelay(f.storage as any,{INSTALLATION_ID:'7',BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:deployment} as any,()=>reader as any,()=>f.state.now);
 const h=releaseHint('workflow_run',{...payload,action:'completed',workflow_run:run},'7')!;
 await relay.register(h);await relay.alarm();expect(JSON.parse(post.inputs.event_json)).toEqual({repositoryId:TARGET.id,kind:'run',runId:101,attempt:2});
});
it('treats a validated custom path as a build completion and rejects the same Run with a different path',()=>{
 const path='.github/workflows/发布 构建.yml',workflowId=300,source='a'.repeat(40);
 const target={...TARGET,buildWorkflow:path,publishWorkflowId:workflowId},run={
  id:20,run_attempt:1,status:'completed',event:'workflow_dispatch',actor:{id:301115370},
  head_repository:{id:TARGET.id},head_branch:'steward/build/pr-1-'+source,display_title:'发行业务 '+'b'.repeat(64),
  workflow_id:workflowId,path
 };
 const hint=(workflow_run:typeof run)=>releaseHint('workflow_run',{...payload,action:'completed',workflow_run},'7',target);
 expect(hint(run)).toEqual({repositoryId:TARGET.id,kind:'run',runId:20,attempt:1});
 expect(hint({...run,path:'.github/workflows/other-cli.yaml'})).toBeUndefined();
});
it('verifies the original reservation before forwarding a repaired publication artifact from attempt two',async()=>{
 const f=fixture(), firstTime=new Date(f.state.now).toISOString(), after=new Date(f.state.now+3600000).toISOString();
 const source={...receipt,created_at:firstTime,status:'completed'}, second={...source,run_attempt:2,created_at:after};
 const parent={hint,policy:pin,reserved:f.state.now,runId:source.id};
 const ns={idFromName:(s:string)=>s,get:()=>({fetch:async()=>Response.json(parent)})};
 let posts=0;
 const g={json:async(_id:number,path:string,method?:string)=>{
   if(path.endsWith('/attempts/1'))return source;
   if(path.endsWith('/attempts/2'))return second;
   if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha:pin}};
   if(path.includes('/contents/config/')){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:deployment}));return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};}
   if(method==='POST')posts++;return {state:'active',path:receipt.path};
 },artifact:async(_repo:number,id:number,name:string,file:string)=>{expect([id,name,file]).toEqual([source.id,'release-cycle-'+relayKey(hint)+'-2','result.json']);return {value:{schemaVersion:1,requestKey:relayKey(hint),event:hint,producer:{repositoryId:CENTRAL.id,runId:source.id,attempt:2,controllerSha:pin},publishInvoked:true}};}};
 const h=releaseHint('workflow_run',{installation:{id:7},repository:{id:CENTRAL.id,full_name:CENTRAL.name},action:'completed',workflow_run:second},'7')!;
 expect(h).toEqual({repositoryId:CENTRAL.id,kind:'publication',runId:source.id,attempt:2});
 const relay=new ReleaseRelay(f.storage as any,{BOUNDED_RECHECK:ns,BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:deployment} as any,()=>g as any,()=>f.state.now);
 await relay.register(h);await relay.alarm();expect(posts).toBe(1);
});
it('quiesces an unconfirmed POST and resumes its existing confirmation budget on redelivery',async()=>{
 const f=fixture();f.state.promoted=pin;await f.relay.register(hint);await f.tick();
 const before=await f.storage.get<any>('releaseCycle');
 f.env.BOUNDED_RECHECK_ENABLED='false';await f.tick();
 expect(await f.storage.get('releaseCycle')).toEqual({...before,paused:true});expect(await f.storage.get('__alarm')).toBeUndefined();
 f.env.BOUNDED_RECHECK_ENABLED='true';await f.relay.register(hint);f.state.hits=[receipt];await f.tick();
 expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'received',runId:12});expect(f.state.posts).toBe(1);
});
it('quiesces a pending WinGet submit without consuming its preparation budget',async()=>{
 const {WingetSubmit}=await import('../src/bounded-winget-submit.js');
 const storage=new SqliteDurableStorage(),env={BOUNDED_RECHECK_ENABLED:'true'},time=Date.now();
 const submit=new WingetSubmit(storage as any,env as any,()=>{throw Error('unexpected IO')},()=>time);
 const h={id:9,attempt:2,title:'Channels submit '+'a'.repeat(64)};
 await submit.register(h);const before=await storage.get<any>('wingetSubmit');
 env.BOUNDED_RECHECK_ENABLED='false';await submit.alarm();
 expect(await storage.get('wingetSubmit')).toEqual({...before,paused:true});expect(await storage.get('__alarm')).toBeUndefined();
 env.BOUNDED_RECHECK_ENABLED='true';await submit.register(h);
 expect(await storage.get('wingetSubmit')).toEqual(before);expect(await storage.get('__alarm')).toBe(time);
});

it.each(['eligible','unregistered','changed branch'] as const)('durably accepts signed push before product discovery: %s',async eligibility=>{
 const f=fixture();f.state.promoted=pin;let reads=0;
 const reader={...f.g,forCandidate:async()=>{
   if(++reads===1)throw Error('RETRY_AFTER:180');
   return eligibility==='unregistered'?undefined:{...f.g,target:{...TARGET,defaultBranch:eligibility==='eligible'?'main':'moved'}};
 }};
 const coordinator=()=>new ReleaseRelay(f.storage as any,f.env as any,()=>reader as any,()=>f.state.now);
 const env={...f.env,INSTALLATION_ID:'7',BOUNDED_RECHECK:{idFromName:(key:string)=>key,get:()=>({fetch:async(req:Request)=>{
  const {hint,source}=await req.json() as any;await coordinator().register(hint,source);return Response.json({});
 }})}};
 const receive=()=>acceptReleaseHint(env as any,'push',{...payload,repository:{...repo,private:false,owner:{id:302208797}}});
 await receive();expect(reads).toBe(0);expect(await f.storage.get('releaseIntake')).toMatchObject({hint,tries:0});expect(await f.storage.get('releaseCycle')).toBeUndefined();
 await coordinator().alarm();expect(f.state.posts).toBe(0);expect(await f.storage.get('__alarm')).toBe(f.state.now+180000);f.state.now=(await f.storage.get<number>('__alarm'))!;
 await coordinator().alarm();await receive();await coordinator().alarm();
 expect(f.state.posts).toBe(eligibility==='eligible'?1:0);expect(reads).toBe(eligibility==='eligible'?2:3);
});

it('rechecks the native workflow ID for a signed product completion before dispatch',async()=>{
 const f=fixture();f.state.promoted=pin;
 const source={name:TARGET.name,defaultBranch:'main'};
 const path='.github/workflows/steward-release-channels.yml';
 const run={id:101,run_attempt:1,head_repository:{id:TARGET.id},repository:{id:TARGET.id},head_sha:pin,
  head_branch:'main',actor:{id:301115370},status:'completed',event:'workflow_dispatch',workflow_id:412,path,display_title:'Channels submit '+'f'.repeat(64)};
 const scoped={target:TARGET,json:async(_id:number,url:string)=>url.includes('/attempts/')?run:{id:444,state:'active',path}};
 const reader={...f.g,forCandidate:async()=>scoped};
 const relay=()=>new ReleaseRelay(f.storage as any,{...f.env,INSTALLATION_ID:'7'} as any,()=>reader as any,()=>f.state.now);
 const env={...f.env,INSTALLATION_ID:'7',BOUNDED_RECHECK:{idFromName:(key:string)=>key,get:()=>({fetch:async(req:Request)=>{
  const v=await req.json() as any;expect(v.source).toEqual(source);await relay().register(v.hint,v.source);return Response.json({});
 }})}};
 await acceptReleaseHint(env as any,'workflow_run',{installation:{id:7},action:'completed',repository:{...repo,private:false,owner:{id:302208797}},workflow_run:run});
 expect(await f.storage.get('releaseIntake')).toBeDefined();await relay().alarm();
 expect(f.state.posts).toBe(0);expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'prepare',reserved:0});
 run.workflow_id=444;f.state.now=(await f.storage.get<number>('__alarm'))!;await relay().alarm();expect(f.state.posts).toBe(1);
});

it.each([429,403,503])('distinguishes release dispatch HTTP %s from an unknown delivery',async status=>{
 const f=fixture();f.state.promoted=pin;let posts=0;
 const reader={...f.g,json:async(id:number,path:string,method?:string)=>{
  if(method==='POST'){if(++posts===1)throw new GitHubRetryError(status,'180',true);return {};}
  return f.g.json(id,path,method);
 }};
 const object=()=>new ReleaseRelay(f.storage as any,f.env as any,()=>reader as any,()=>f.state.now);
 await object().register(hint);await object().alarm();
 const current=await f.storage.get<any>('releaseCycle');
 if(status===503){
  expect(current.stage).toBe('confirm');f.state.now=current.next;await object().alarm();expect(posts).toBe(1);
 }else{
  expect(current).toMatchObject({stage:'prepare',reserved:0,next:f.state.now+180000});
  await object().register(hint);await object().alarm();expect(posts).toBe(1);
  f.state.now=current.next;await object().alarm();await object().alarm();expect(posts).toBe(2);
 }
});
