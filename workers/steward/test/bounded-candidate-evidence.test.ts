import {GitHubRetryError} from '../src/bounded-retry-after.js';
import {promotedControllerFixture} from './promoted-controller-fixture.js';
import {generatedProjectionPreview,generatedStatusBody,verifyGeneratedProjection} from '../src/bounded-candidate-projection.js';
import {NativeCandidateCoordinator,acceptNativeCandidateEvent,nativeHintKey,type NativeHint} from '../src/bounded-native-event.js';
import {SqliteDurableStorage} from './bounded-storage.js';
import {DurableRecheckStore} from '../src/bounded-recheck-do.js';
import {BoundedRecheck} from '../src/bounded-recheck.js';
import {FixedRecheckEffects} from '../src/bounded-recheck-effects.js';
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {candidateFacts,verifiedProducer} from '../src/bounded-candidate-evidence.js';
import {applyVerifiedCandidateEvent,CandidateEventCoordinator} from '../src/bounded-release-event.js';
import {digest,TARGET,CENTRAL,type GitReader} from '../src/bounded-recheck-github.js';
const sha=(c:string)=>c.repeat(40),key=(c:string)=>c.repeat(64),t0=Date.now()-60000;
const conditionalNoteTemplate=readFileSync(new URL('../../../templates/repository/.github/release-template.md.mustache',import.meta.url),'utf8');
async function fixture(){
 const generated={baseSha:sha('a'),units:[{id:'layerscape',path:'.',version:'1.0.0'}],files:[{path:'.release-notes/layerscape.md',mode:'100644',content:'Notes\n'}]},document:any={generated,pending:null,identity:{id:'existing',units:[{id:'layerscape',contributors:{contributors:[]}}]},conflict:null,preview:'# .release-notes/layerscape.md\n\nNotes\n'},session=JSON.stringify(document);
 const state={schemaVersion:3,repositoryId:TARGET.id,activeCycleId:null as string|null,candidate:{id:key('b'),pendingWrite:null,baseSha:sha('a'),publishedHead:sha('c'),generatedSnapshotPath:`generated/${key('b')}/${key('a')}.json`,statusCommentId:7,prNumber:192,branch:'steward/candidate'}};
 const path=`generated/${key('b')}/session.json`,files:any={'state.json':state,[path]:{schemaVersion:1,repositoryId:TARGET.id,candidateId:key('b'),documentKind:'session',index:0,count:1,documentDigest:digest(session).slice(7),content:session}};
 files[state.candidate.generatedSnapshotPath]={schemaVersion:1,repositoryId:TARGET.id,candidateId:key('b'),documentKind:'generated',index:0,count:1,documentDigest:digest(JSON.stringify(generated)).slice(7),content:JSON.stringify(generated)};
 const pull={number:192,state:'open',merged:false,labels:[],head:{repo:{id:TARGET.id},ref:'steward/candidate',sha:sha('d')},base:{repo:{id:TARGET.id},ref:'main'}};
 const event={id:123,actor:{id:7},event:'unlabeled',label:{name:'release:editing'},issue:{number:192,repository_url:`https://api.github.com/repos/${TARGET.name}`},created_at:new Date(t0).toISOString()};
 const run={id:99,actor:{id:301115370},run_attempt:2,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},path:'.github/workflows/bounded-release-event.yml',head_sha:sha('e'),head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',display_title:`Bounded release event ${key('f')}`,run_started_at:new Date(t0).toISOString(),updated_at:new Date(t0+50000).toISOString()};
 let artifact:any;
 const g:GitReader={async json(_id,p){if(p.includes('/git/trees/'))return {truncated:false,tree:p.includes(generated.baseSha)?[]:generated.files.filter(f=>f.content!==null).map(f=>{const b=Buffer.from(f.content);return {path:f.path,mode:f.mode,type:'blob',sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')};})};if(p.endsWith('/git/ref/heads/steward/release-state'))return {ref:'refs/heads/steward/release-state',object:{type:'commit',sha:sha('1')}};if(p.endsWith('/git/ref/heads/main'))return {object:{sha:sha('a')}};if(p.includes('/contents/')){const path=p.split('/contents/')[1]!.split('?')[0]!,b=Buffer.from(JSON.stringify(files[path]));return {path,type:'file',encoding:'base64',size:b.length,sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),content:b.toString('base64')};}if(p.endsWith('/pulls/192'))return pull;if(p.includes('/issues/192/comments?'))return [{id:7,user:{id:301115370},issue_url:`https://api.github.com/repos/${TARGET.name}/issues/192`,body:generatedStatusBody({state,pull,session:document},document.preview,sha('1'))}];if(p.endsWith('/issues/events/123'))return event;if(p.endsWith('/actions/runs/99/attempts/2'))return run;throw Error(p);},async artifact(){return artifact;}};
 const facts=await candidateFacts(g),registration={identity:facts.identity,t0,policySha:sha('e'),deploymentSha:sha('2')},producer={repositoryId:CENTRAL.id,runId:99,attempt:2,requestKey:key('f')};
 artifact={artifactId:12,digest:digest('bytes'),createdAt:new Date(t0+40000).toISOString(),value:{schemaVersion:1,requestKey:producer.requestKey,registration,producer:{repositoryId:CENTRAL.id,runId:99,attempt:2,controllerSha:sha('e')},sourceEvidence:{...facts.evidence,eventId:123,eventCreatedAt:event.created_at}}};
 const env={BOUNDED_CONTROLLER_SHA:sha('e'),BOUNDED_DEPLOYMENT_SHA:sha('2')} as any;
 return {g,env,registration,producer,artifact,run,pull,event,files,state,document};
}
describe('candidate producer evidence and event controls',()=>{
 it('observes a candidate with a separately owned cycle at the same protected commit',async()=>{
   const f=await fixture(),source=sha('d'),id=`pr-180-${source}`;
   f.state.activeCycleId=id;
   f.files[`cycles/${id}.json`]={id,prNumber:180,sourceSha:source};
   const paths:string[]=[];
   const g:GitReader={...f.g,json:async(repo,path)=>{paths.push(path);return f.g.json(repo,path);}};
   expect((await candidateFacts(g)).identity).toEqual(f.registration.identity);
   expect(paths.filter(p=>p.includes('/contents/cycles/'))).toEqual([
     `/repos/${TARGET.name}/contents/cycles/${id}.json?ref=${sha('1')}`
   ]);
 });
 it.each(['same PR','missing','wrong id','wrong owner','wrong source','invalid pointer','bad blob'])('refuses uncertain cycle ownership: %s',async scenario=>{
   const f=await fixture(),source=sha('d'),number=scenario==='same PR'?192:180,id=`pr-${number}-${source}`;
   f.state.activeCycleId=scenario==='invalid pointer'?'../state':id;
   if(scenario!=='missing')f.files[`cycles/${id}.json`]={
     id:scenario==='wrong id'?'other':id,prNumber:scenario==='wrong owner'?181:number,
     sourceSha:scenario==='wrong source'?sha('e'):source,
   };
   const g:GitReader={...f.g,json:async(repo,path)=>{
     const result=await f.g.json(repo,path);
     return scenario==='bad blob'&&path.includes('/contents/cycles/')?{...result,sha:sha('0')}:result;
   }};
   await expect(candidateFacts(g,false,true)).rejects.toThrow();
 });
 it.each(['ui','layerscape'])('reads a protected conflict for %s on a new path without returning a stale identity',async id=>{
   const f=await fixture();
   const chunk=f.files[`generated/${f.state.candidate.id}/session.json`];
   const session=JSON.parse(chunk.content);
   session.identity.units[0].id=id;
   session.conflict={head:f.pull.head.sha,generated:{...session.generated,units:[{id,path:'ui',version:'2.0.0'}]},paths:['CHANGELOG.md']};
   chunk.content=JSON.stringify(session);chunk.documentDigest=digest(chunk.content).slice(7);
   const g={...f.g,target:{...TARGET,units:[{id,path:'ui'}]}};
   expect((await candidateFacts(g,false,true)).identity).toBeNull();
   await expect(candidateFacts(g)).rejects.toThrow('SESSION_NOT_READY');
   expect((await candidateFacts(f.g,false,true)).identity).toBeNull();
   await expect(candidateFacts(f.g)).rejects.toThrow('SESSION_NOT_READY');
 });
 it('admits only recovery after the default branch moved a unit out of the old snapshot',async()=>{
   const f=await fixture(),target={...TARGET,units:[{id:'layerscape',path:'packages/app'}]};
   const g={...f.g,target};
   await expect(candidateFacts(g,false,true)).rejects.toThrow('CANDIDATE_UNIT_NOT_SELECTED');
   const moved:GitReader={...g,json:async(id,path,method,body)=>path.endsWith('/git/ref/heads/main')?
     {object:{sha:sha('e')}}:f.g.json(id,path,method,body)};
   expect((await candidateFacts(moved,false,true)).identity).toBeNull();
   await expect(candidateFacts(moved)).rejects.toThrow('CANDIDATE_UNIT_NOT_SELECTED');
 });
 it('binds a fixed successful Run to independently read Git identity and native event',async()=>{const f=await fixture();expect((await verifiedProducer(f.g,f.env,f)).registration).toEqual(f.registration);});
 it.each(['epoch','cycleId','requestKey','attempt','target'] as const)('rejects borrowing successful Run for a different %s',async kind=>{const f=await fixture();const input=structuredClone({registration:f.registration,producer:f.producer});if(kind==='epoch'||kind==='cycleId')input.registration.identity[kind]='other';else if(kind==='target')input.registration.identity.repositoryId=1 as any;else input.producer[kind]=kind==='requestKey'?key('0'):1 as never;await expect(verifiedProducer(f.g,f.env,input)).rejects.toThrow();});
 it('rejects an artifact from an older producer attempt even when Run succeeded',async()=>{const f=await fixture();f.artifact.value.producer.attempt=1;await expect(verifiedProducer(f.g,f.env,f)).rejects.toThrow('PRODUCER_ATTEMPT');});
 it('rejects prior-attempt artifact time and superseded native events',async()=>{const f=await fixture();f.artifact.createdAt=new Date(t0-1).toISOString();await expect(verifiedProducer(f.g,f.env,f)).rejects.toThrow('PRODUCER_ARTIFACT_WINDOW');f.artifact.createdAt=new Date(t0+1).toISOString();(f.pull.labels as any[]).push({name:'release:editing'});await expect(verifiedProducer(f.g,f.env,f)).rejects.toThrow('PRODUCER_EVENT_SUPERSEDED');});
 it('unlabeled resumes the original epoch without re-registering or replacing t0',async()=>{const f=await fixture(),v=await verifiedProducer(f.g,f.env,f),calls:any[]=[];const record={...f.registration,t0:t0-100000,status:'PAUSED',generation:7};const stub={async fetch(req:Request){const action=new URL(req.url).pathname,body=await req.json();calls.push({action,body});return Response.json(record);}};await applyVerifiedCandidateEvent(stub as any,v);expect(calls.map(x=>x.action)).toEqual(['/status','/resume']);expect(calls[1].body).toEqual({expectedGeneration:7});expect(record.t0).toBe(t0-100000);});
 it('terminal expired object is not re-registered or resumed by a later event',async()=>{const f=await fixture(),v=await verifiedProducer(f.g,f.env,f),calls:string[]=[];await applyVerifiedCandidateEvent({async fetch(req:Request){calls.push(new URL(req.url).pathname);return Response.json({...f.registration,status:'NEEDS_ATTENTION',generation:3});}} as any,v);expect(calls).toEqual(['/status']);});
 it('duplicate early event alarm cannot consume confirmations or call GitHub',async()=>{const record={status:'PENDING',nextAt:200,checks:1};let calls=0;const storage={transaction:async(fn:any)=>fn({get:async()=>record}),get:async()=>record};await new CandidateEventCoordinator(storage as any,{} as any,()=>{calls++;throw Error('unexpected');},()=>100).alarm();expect(calls).toBe(0);expect(record.checks).toBe(1);});
});

it.each(['normal','rollback','official-cutover','cutover-after-redelivery'] as const)('one durable event POST reaches verified candidate observation through the frozen B artifacts: %s',async mode=>{
 const f=await fixture();let now=t0;const posts:string[]=[];let observationKey='';const facts=await candidateFacts(f.g);
 const observer={...f.run,id:100,run_attempt:1,path:'.github/workflows/release-observe.yml',run_started_at:new Date(t0+1000).toISOString(),updated_at:new Date(t0+50000).toISOString()};
 const g:GitReader={async json(id,path,method,body){if(method==='POST'){posts.push(path);if(path.endsWith('/release-observe.yml/dispatches'))observationKey=(body as any).inputs.request_key;return null;}if(id===CENTRAL.id){const promoted=promotedControllerFixture(path,f.registration.policySha,f.registration.deploymentSha);if(promoted)return promoted;}if(path.endsWith('/actions/workflows/bounded-release-event.yml'))return {path:'.github/workflows/bounded-release-event.yml',state:'active'};if(path.endsWith('/actions/workflows/release-observe.yml'))return {path:'.github/workflows/release-observe.yml',state:'active'};if(path.includes('/bounded-release-event.yml/runs?'))return {total_count:1,workflow_runs:[f.run]};if(path.includes('/release-observe.yml/runs?'))return {total_count:1,workflow_runs:[{...observer,display_title:'Observe candidate '+observationKey}]};if(path.endsWith('/actions/runs/100'))return {...observer,display_title:'Observe candidate '+observationKey};return f.g.json(id,path,method,body);},async artifact(id,runId,name,file){if(runId===99)return f.g.artifact(id,runId,name,file);expect(name).toBe('candidate-observation-'+observationKey);expect(file).toBe('result.json');return {artifactId:13,digest:digest('observation'),createdAt:new Date(t0+40000).toISOString(),value:{schemaVersion:1,requestKey:observationKey,identity:f.registration.identity,runId:100,runAttempt:1,repositoryId:CENTRAL.id,controllerSha:f.registration.policySha,sourceSha:f.registration.identity.sourceSha,observedAt:new Date(t0+30000).toISOString(),stateBefore:facts.evidence,stateAfter:facts.evidence,outcome:'done',status:'READY',reason:'CACHED_OBSERVATION',projectionEvidence:{commentId:7,bodyDigest:digest(generatedStatusBody(facts,facts.session.preview,facts.evidence.stateCommit)).slice(7),previewDigest:digest(facts.session.preview).slice(7)}}};}};
 const storage=new SqliteDurableStorage(),eventStorage=new SqliteDurableStorage(),store=new DurableRecheckStore(storage as any),env={...f.env,BOUNDED_RECHECK_ENABLED:'true'} as any;
 const engine=new BoundedRecheck(store,new FixedRecheckEffects(env,()=>g),()=>now);
 const stub={async fetch(req:Request){const b=await req.json() as any;const action=new URL(req.url).pathname;return Response.json(action==='/status'?await store.read():await engine.register(b.registration));}};env.BOUNDED_RECHECK={idFromName:(s:string)=>s,get:()=>stub};
 const coordinator=()=>new CandidateEventCoordinator(eventStorage as any,env,()=>g,()=>now),input={event:{repositoryId:TARGET.id,prNumber:192,eventId:123},requestKey:f.producer.requestKey,policySha:f.registration.policySha,createdAt:t0};
 await coordinator().register(input);await coordinator().register(input);expect(posts).toHaveLength(1);
 if(mode!=='normal'){
   env.LEGACY_RELEASE_HANDOFF_IDS=JSON.stringify([TARGET.id]);
   now=t0+60000;await coordinator().alarm();
   expect(await eventStorage.get('event')).toMatchObject({status:'PAUSED',reason:'LEGACY_RELEASE_HANDOFF',nextAt:null,checks:1});
   expect(await store.read()).toBeNull();
   await coordinator().register(input);
   env.LEGACY_RELEASE_HANDOFF_IDS='[]';
   let official=mode==='official-cutover';
   g.forCandidate=async()=>({...g,target:{...TARGET,...(official?{officialCandidate:true as const}:{})}});
   await coordinator().register(input);
   expect(posts).toHaveLength(1);
   if(mode==='official-cutover'||mode==='cutover-after-redelivery'){
     official=true;
     await coordinator().alarm();
     expect(await store.read()).toBeNull();
     expect(await eventStorage.get('event')).toMatchObject({status:'PAUSED',reason:'LEGACY_RELEASE_HANDOFF',nextAt:null,checks:mode==='official-cutover'?1:2});
     return;
   }
   expect(await eventStorage.get('event')).toMatchObject({status:'PENDING',reason:'VERIFIED_NATIVE_REDELIVERY_RESUME',nextAt:now,checks:1});
 }
 now=t0+60000;await coordinator().alarm();expect((await eventStorage.get<any>('event')).status).toBe('REGISTERED');expect((await store.read())?.status).toBe('PENDING');await engine.wake();expect(posts).toHaveLength(2);now+=60000;await engine.wake();expect((await store.read())?.status).toBe('DONE');await coordinator().alarm();await engine.wake();expect(posts).toHaveLength(2);
});

async function normalFixture(){
 const f=await fixture(),hint:NativeHint={repositoryId:TARGET.id,prNumber:192,actorId:7,action:'unlabeled',updatedAt:f.event.created_at},key=nativeHintKey(hint),facts=await candidateFacts(f.g);let now=t0+60000,unavailable=false,readError:string|null=null,artifactError:string|null=null,losePost=false,posts=0,reads=0;
 const run={...f.run,id:101,run_attempt:1,path:'.github/workflows/release-candidate-event.yml',display_title:'Candidate event '+key,created_at:new Date(now).toISOString(),status:'completed'};
 const artifact={artifactId:31,digest:digest('normal'),createdAt:new Date(t0+40000).toISOString(),value:{schemaVersion:1,requestKey:key,producer:{repositoryId:CENTRAL.id,runId:101,attempt:1,controllerSha:f.registration.policySha},event:{repositoryId:TARGET.id,prNumber:192,eventId:123},sourceSha:f.registration.identity.sourceSha,status:'READY',reason:null,outcome:'candidate_updated',stateBefore:facts.evidence,stateAfter:facts.evidence,candidateIdentity:f.registration.identity}};
 const g:GitReader={async json(id,path,method,body){if(method==='POST'){run.created_at=new Date(now).toISOString();run.run_started_at=new Date(now+1000).toISOString();run.updated_at=new Date(now+50000).toISOString();artifact.createdAt=new Date(now+40000).toISOString();posts++;expect(path).toContain('/release-candidate-event.yml/dispatches');expect(Object.keys((body as any).inputs).sort()).toEqual(['event_json','policy_sha','request_key','source_sha']);if(losePost)throw Error('NETWORK_RESPONSE_LOST');return null;}reads++;if(readError)throw Error(readError);if(unavailable)throw Error('SOURCE_TEMPORARILY_UNREADABLE');if(id===CENTRAL.id){const promoted=promotedControllerFixture(path,f.registration.policySha,f.registration.deploymentSha);if(promoted)return promoted;}if(path.endsWith('/actions/workflows/release-candidate-event.yml'))return {path:'.github/workflows/release-candidate-event.yml',state:'active'};if(path.includes('/issues/192/events?'))return [f.event];if(path.includes('/release-candidate-event.yml/runs?'))return {total_count:1,workflow_runs:[run]};if(path.endsWith('/actions/runs/101/attempts/1'))return run;return f.g.json(id,path,method,body);},async artifact(){if(artifactError)throw Error(artifactError);return artifact;}};
 const eventStorage=new SqliteDurableStorage(),objectStorage=new SqliteDurableStorage(),store=new DurableRecheckStore(objectStorage as any),env={...f.env,BOUNDED_RECHECK_ENABLED:'true'} as any;const engine=new BoundedRecheck(store,{observe:async()=>({kind:'unknown'}),confirm:async()=>({kind:'unknown'})},()=>now);
 const objectStub={async fetch(req:Request){const b=await req.json() as any,a=new URL(req.url).pathname;return Response.json(a==='/status'?await store.read():a==='/register'?await engine.register(b.registration):await engine.control(a.slice(1) as any,b.expectedGeneration));}};
 const coordinator=()=>new NativeCandidateCoordinator(eventStorage as any,env,()=>g,()=>now);env.BOUNDED_RECHECK={idFromName:(s:string)=>s,get:(id:string)=>id.startsWith('native:')?{async fetch(req:Request){return Response.json(await coordinator().register(await req.json() as any));}}:objectStub};
 return {f,hint,key,g,env,run,artifact,eventStorage,store,engine,coordinator,time:(n:number)=>{now=n;},clock:()=>now,missingArtifact:()=>{artifactError='ARTIFACT_UNIQUE';},artifactFailure:(s:string|null)=>{artifactError=s;},readError:(s:string|null)=>{readError=s;},unavailable:(v:boolean)=>{unavailable=v;},losePost:()=>{losePost=true;},posts:()=>posts,reads:()=>reads};
}
describe('durable normal candidate event chain',()=>{
 it.each(['rollback','already-adopted','adopted-after-redelivery'] as const)('handles a verified in-flight normal receipt during handoff: %s',async mode=>{
  const f=await normalFixture();
  await f.coordinator().register({hint:f.hint,deliveryId:'initial'});
  await f.coordinator().alarm();
  expect(f.posts()).toBe(1);
  f.env.LEGACY_RELEASE_HANDOFF_IDS=JSON.stringify([TARGET.id]);
  f.time(f.clock()+60000);await f.coordinator().alarm();
  const paused=await f.eventStorage.get<any>('nativeEvent');
  expect(paused).toMatchObject({status:'PAUSED',reason:'LEGACY_RELEASE_HANDOFF',nextAt:null,knownRunId:101,
    pausedFrom:{status:'CONFIRMING'},evidence:{runId:101},receiptDeferred:true});
  expect(await f.store.read()).toBeNull();
  f.env.LEGACY_RELEASE_HANDOFF_IDS='[]';
  let official=mode==='already-adopted';
  f.g.forCandidate=async()=>({...f.g,target:{...TARGET,...(official?{officialCandidate:true as const}:{})}});
  await f.coordinator().register({hint:f.hint,deliveryId:'same-event'});
  if(mode==='adopted-after-redelivery')official=true;
  await f.coordinator().alarm();
  const state=await f.eventStorage.get<any>('nativeEvent');
  expect([state.dispatchedAt,state.knownRunId,state.confirmations]).toEqual([paused.dispatchedAt,101,paused.confirmations]);
  expect(f.posts()).toBe(1);
  if(mode==='rollback'){
   expect(state).toMatchObject({status:'REGISTERED',handoff:{status:'COMPLETE'}});
   expect((await f.store.read())?.status).toBe('PENDING');
  }else{
   expect(state).toMatchObject({status:'PAUSED',reason:'LEGACY_RELEASE_HANDOFF',nextAt:null});
   expect(await f.store.read()).toBeNull();
  }
 });
 it('stops legacy candidate intake and cancels promotion wake for its unposted claim',async()=>{
  const f=await normalFixture();
  await f.coordinator().register({hint:f.hint,deliveryId:'already-registered'});
  const before=await f.eventStorage.get<any>('nativeEvent');
  before.waitingForPromotion=f.hint.updatedAt;await f.eventStorage.put('nativeEvent',before);
  const scoped={...f.env,LEGACY_RELEASE_HANDOFF_IDS:JSON.stringify([TARGET.id])};
  const coordinator=new NativeCandidateCoordinator(f.eventStorage as any,scoped,()=>f.g,()=>f.clock());
  await coordinator.wakePromoted(before.waitingForPromotion);
  expect(await coordinator.register({hint:f.hint,deliveryId:'late-repeat'})).toBeNull();
  await coordinator.alarm();
  expect(await f.eventStorage.get('nativeEvent')).toMatchObject({status:'PAUSED',reason:'LEGACY_RELEASE_HANDOFF',
    nextAt:null,deadline:before.deadline,preparations:0,dispatchedAt:null,claim:0});
  expect(f.posts()).toBe(0);
 });
 it('recovers a durable hint after candidate discovery fails without redelivery or duplicate dispatch',async()=>{
  const f=await normalFixture();
  let attempts=0;
  f.g.forCandidate=async()=>{
   if(++attempts===1)throw Error('SOURCE_TEMPORARILY_UNREADABLE');
   return {...f.g,target:TARGET};
  };
  const payload={installation:{id:123},repository:{id:TARGET.id,full_name:TARGET.name,default_branch:'main',private:false},
   action:'unlabeled',label:{name:'release:editing'},sender:{id:7},pull_request:{...f.f.pull,updated_at:f.hint.updatedAt}};
  const receive=(delivery:string)=>acceptNativeCandidateEvent({...f.env,INSTALLATION_ID:'123'},'pull_request',payload,delivery);
  await receive('delivery-1');
  const original=await f.eventStorage.get<any>('nativeEvent');
  expect(original.status).toBe('PREPARING');
  expect(f.reads()).toBe(0);expect(attempts).toBe(0);
  await f.coordinator().alarm();expect(attempts).toBe(1);expect(f.posts()).toBe(0);
  f.time(f.clock()+60000);await f.coordinator().alarm();expect(f.posts()).toBe(1);
  await receive('delivery-2');await f.coordinator().alarm();
  const recovered=await f.eventStorage.get<any>('nativeEvent');
  expect(recovered.firstDeliveryId).toBe('delivery-1');expect(recovered.deadline).toBe(original.deadline);
  expect(f.posts()).toBe(1);
 });
 it.each(['fork','wrong base','closed','missing head'])('discards %s candidate notifications before allocating storage',async kind=>{
  const f=await normalFixture(),pull=structuredClone(f.f.pull) as any;
  if(kind==='fork')pull.head.repo.id++;else if(kind==='wrong base')pull.base.ref='other';
  else if(kind==='closed')pull.state='closed';else delete pull.head;
  const env={...f.env,INSTALLATION_ID:'123',BOUNDED_RECHECK:{idFromName:()=>{throw Error('unexpected allocation');}}};
  await acceptNativeCandidateEvent(env,'pull_request',{installation:{id:123},repository:{id:TARGET.id,full_name:TARGET.name,default_branch:'main',private:false},
   action:'reopened',sender:{id:7},pull_request:{...pull,updated_at:f.hint.updatedAt}},'fork-test');
  expect(await f.eventStorage.get('nativeEvent')).toBeUndefined();expect(f.reads()).toBe(0);
 });
 it('protects an ineligible repository without dispatch or further alarms',async()=>{
  const f=await normalFixture();f.g.forCandidate=async()=>undefined;
  await f.coordinator().register({hint:f.hint,deliveryId:'not-registered'});
  await f.coordinator().alarm();
  expect(await f.eventStorage.get('nativeEvent')).toMatchObject({status:'PROTECTED',nextAt:null});
  expect(f.posts()).toBe(0);
 });
 it('pauses the archived registration across a failed read and a protected migration result',async()=>{
   const f=await normalFixture(),source=sha('b'),read=f.g.json.bind(f.g);
   f.g.target={...TARGET,units:[{id:'layerscape',path:'packages/app'}]};
   f.g.json=async(id,path,method,body)=>id===TARGET.id&&path.endsWith('/git/ref/heads/main')?
     {object:{sha:source}}:read(id,path,method,body);
   Object.assign(f.artifact.value,{sourceSha:source,outcome:'protected',candidateIdentity:null,status:'WAIT'});
   await f.engine.register(f.f.registration);
   await f.coordinator().register({hint:f.hint,deliveryId:'migration'});
   f.unavailable(true);await f.coordinator().alarm();
   expect(f.posts()).toBe(0);
   f.unavailable(false);f.time(f.clock()+60000);await f.coordinator().alarm();
   expect((await f.store.read())?.status).toBe('PAUSED');
   f.time(f.clock()+60000);await f.coordinator().alarm();
   expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PROTECTED');
   expect((await f.store.read())?.status).toBe('PAUSED');
   expect(f.posts()).toBe(1);
 });
 it('temporary first read failure recovers from persisted alarm and never reposts a lost response',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});f.unavailable(true);await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).preparations).toBe(1);expect(f.posts()).toBe(0);f.unavailable(false);f.losePost();f.time(f.clock()+60000);await f.coordinator().alarm();expect(f.posts()).toBe(1);expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('CONFIRMING');f.time(f.clock()+60000);await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('REGISTERED');expect((await f.store.read())?.t0).toBe(t0);await f.coordinator().alarm();expect(f.posts()).toBe(1);});
 it('unreadable preparation stops after fixed offsets, with no normal POST',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});const start=f.clock();f.unavailable(true);for(const m of [0,1,5,15]){f.time(start+m*60000);await f.coordinator().alarm();}expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('NEEDS_ATTENTION');expect(await f.eventStorage.get('__alarm')).toBeUndefined();expect(f.posts()).toBe(0);});
 it('pauses existing old recheck before one normal dispatch, then resumes the same epoch window',async()=>{const f=await normalFixture();await f.engine.register(f.f.registration);await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();expect((await f.store.read())?.status).toBe('PAUSED');const deadline=(await f.store.read())?.deadline;f.time(f.clock()+60000);await f.coordinator().alarm();expect((await f.store.read())?.status).toBe('PENDING');expect((await f.store.read())?.deadline).toBe(deadline);expect(f.posts()).toBe(1);});
 it('does not register a fabricated candidate identity from a successful normal Run',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();f.artifact.value.candidateIdentity={...f.f.registration.identity,epoch:'other'};f.time(f.clock()+60000);await f.coordinator().alarm();expect(await f.store.read()).toBeNull();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('CONFIRMING');});
});

describe('normal completion event after bounded discovery',()=>{
 async function waiting(){const f=await normalFixture();f.run.status='in_progress';await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock();for(const m of [1,5,15]){f.time(start+m*60000);await f.coordinator().alarm();}return f;}
 it('three discoveries bind one running Run, then native completion consumes once without polling or POST',async()=>{const f=await waiting(),r=await f.eventStorage.get<any>('nativeEvent');expect(r.status).toBe('AWAITING_RECEIPT');expect(r.knownRunId).toBe(101);expect(r.confirmations).toBe(3);expect(r.nextAt).toBe(r.deadline);f.run.status='completed';await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('REGISTERED');const record=await f.store.read();await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});expect(await f.store.read()).toEqual(record);expect(f.posts()).toBe(1);});
 it.each(['attempt','run','pin'] as const)('rejects wrong %s before consuming a native completion',async kind=>{const f=await waiting();f.run.status='completed';await f.coordinator().receipt({runId:kind==='run'?102:101,attempt:kind==='attempt'?2:1,policySha:kind==='pin'?'0'.repeat(40):f.f.registration.policySha});expect(await f.store.read()).toBeNull();expect((await f.eventStorage.get<any>('nativeEvent')).receiptConsumed).not.toBe(true);});
 it('deadline wins against late completion and cannot activate a new object',async()=>{const f=await waiting(),r=await f.eventStorage.get<any>('nativeEvent');f.time(r.deadline);f.run.status='completed';await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});await f.coordinator().alarm();expect(await f.store.read()).toBeNull();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('NEEDS_ATTENTION');expect(f.posts()).toBe(1);});
});

it('preserves the native receipt window when the final discovery GET fails for an already bound Run',async()=>{
 const f=await normalFixture();f.run.status='in_progress';await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock();
 for(const m of [1,5]){f.time(start+m*60000);await f.coordinator().alarm();}
 f.unavailable(true);f.time(start+15*60000);await f.coordinator().alarm();const waiting=await f.eventStorage.get<any>('nativeEvent');
 expect(waiting.status).toBe('AWAITING_RECEIPT');expect(waiting.knownRunId).toBe(101);expect(waiting.confirmations).toBe(3);expect(waiting.nextAt).toBe(waiting.deadline);
 f.unavailable(false);f.run.status='completed';await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});
 expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('REGISTERED');expect((await f.store.read())?.deadline).toBe(waiting.deadline);expect(f.posts()).toBe(1);
});

it('does not silently replace existing object policy pins or reset its original window',async()=>{const f=await fixture(),calls:string[]=[],prior={identity:f.registration.identity,policySha:sha('9'),deploymentSha:f.registration.deploymentSha,t0:t0-60000,deadline:t0+60000,status:'PAUSED',generation:2};const stub={async fetch(req:Request){calls.push(new URL(req.url).pathname);return Response.json(prior);}};await expect(applyVerifiedCandidateEvent(stub as any,{registration:f.registration,editing:false} as any)).rejects.toThrow('EVENT_OBJECT_IDENTITY');expect(calls).toEqual(['/status']);expect(prior.t0).toBe(t0-60000);expect(prior.policySha).toBe(sha('9'));});

function refreshFixture(f:Awaited<ReturnType<typeof fixture>>){const text=JSON.stringify(f.document),chunk=f.files[`generated/${key('b')}/session.json`];chunk.content=text;chunk.documentDigest=digest(text).slice(7);const generated=JSON.stringify(f.document.generated),g=f.files[f.state.candidate.generatedSnapshotPath];g.content=generated;g.documentDigest=digest(generated).slice(7);}
describe('generated candidate projection completion',()=>{
 it('recomputes exact note and escaped contributor preview with canonical newlines',()=>{const session={generated:{files:[{path:'.release-notes/alias.md',content:'Notes\r\n'}]},identity:{units:[{id:'layerscape',contributors:{contributors:[{profileUrl:'https://github.com/x',avatarUrl:'https://avatars.githubusercontent.com/u/1?v=4',alt:'x&y'}]}}]}};expect(generatedProjectionPreview(session)).toBe('# .release-notes/alias.md\n\nNotes\n## 贡献者\n\n<a href="https:&#x2F;&#x2F;github.com&#x2F;x"><img src="https:&#x2F;&#x2F;avatars.githubusercontent.com&#x2F;u&#x2F;1?v&#x3D;4" alt="x&amp;y" width="32" height="32" /></a> \n');});
 it('uses the archived template for conditional candidate verification',async()=>{
   const f=await fixture(),session=f.document;
   session.identity.noteTemplate=conditionalNoteTemplate;
   session.generated.units[0].tag='v1.0.0';
   session.identity.units[0].notesPath=session.generated.files[0].path='docs/release-current.md';
   session.generated.files[0].content='## 🐛 错误修复\n\n**启动**。已修复错误。\n';
   session.identity.units[0].contributors.contributors=[{id:42,login:'x',profileUrl:'https://github.com/x',avatarUrl:'https://avatars.githubusercontent.com/u/42',alt:'x'}];
   const preview=generatedProjectionPreview(session);
   expect(preview).toContain('width="48" height="48"');
   expect(preview).toContain('# docs/release-current.md');
   expect(preview).toContain(`[查看候选源码](<https://github.com/${TARGET.name}/tree/${session.generated.baseSha}>)`);
   session.preview=preview;refreshFixture(f);
   const facts=await candidateFacts(f.g);
   const body=generatedStatusBody(facts,preview,facts.evidence.stateCommit);
   await expect(verifyGeneratedProjection(f.g,facts,{commentId:7,bodyDigest:digest(body).slice(7),
     previewDigest:digest(preview).slice(7)})).resolves.toMatchObject({number:192});
 });
 it.each(['short','long','wrong-repo','unrelated-commit','changed-blob','symlink','duplicate','forged-body','missing-proof','protected'] as const)('requires independent immutable projection evidence: %s',async scenario=>{
  const f=await fixture();const long=['long','wrong-repo','unrelated-commit','changed-blob','symlink'].includes(scenario);if(long)f.document.generated.files[0].content='x'.repeat(50*1024);f.document.preview=generatedProjectionPreview(f.document);if(scenario==='protected')f.document.conflict={head:f.pull.head.sha,generated:f.document.generated,paths:['CHANGELOG.md']};refreshFixture(f);
  const facts=await candidateFacts(f.g),linkCommit=sha('3'),body=generatedStatusBody(facts,f.document.preview,linkCommit),comment={id:7,user:{id:301115370},issue_url:`https://api.github.com/repos/${TARGET.name}/issues/192`,body:scenario==='wrong-repo'?body.replace(TARGET.name,'other/repo'):scenario==='forged-body'?body+'x':body};
  const path=`generated/${f.state.candidate.id}/preview.md`,text=scenario==='changed-blob'?f.document.preview+'x':f.document.preview,bytes=Buffer.from(text),blobSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const g:GitReader={async json(id,p,method,payload){if(p.includes('/comments?'))return scenario==='duplicate'?[comment,{...comment,id:8}]:[comment];if(p.includes('/compare/'))return {base_commit:{sha:linkCommit},merge_base_commit:{sha:scenario==='unrelated-commit'?sha('4'):linkCommit},status:'ahead'};if(p.includes('/git/trees/'+linkCommit))return {truncated:false,tree:[{path,type:'blob',mode:scenario==='symlink'?'120000':'100644',sha:blobSha}]};if(p.includes('/preview.md?'))return {path,type:'file',encoding:'base64',size:bytes.length,sha:blobSha,content:bytes.toString('base64')};return f.g.json(id,p,method,payload);},artifact:f.g.artifact};
  const evidence=scenario==='missing-proof'?null:{commentId:7,bodyDigest:digest(comment.body).slice(7),previewDigest:digest(f.document.preview).slice(7)};
  if(['short','long'].includes(scenario))expect((await verifyGeneratedProjection(g,facts,evidence)).number).toBe(192);else await expect(verifyGeneratedProjection(g,facts,evidence)).rejects.toThrow();
 });
 it.each(['owner','kind','digest','content','count'] as const)('rejects generated archive %s mismatch independently of session',async kind=>{const f=await fixture(),g=f.files[f.state.candidate.generatedSnapshotPath];if(kind==='owner')g.candidateId=key('c');if(kind==='kind')g.documentKind='session';if(kind==='digest')g.documentDigest=key('0');if(kind==='content'){g.content=JSON.stringify({...f.document.generated,baseSha:sha('9')});g.documentDigest=digest(g.content).slice(7);}if(kind==='count')g.count=0;await expect(candidateFacts(f.g)).rejects.toThrow();});
});

it('normal result rejects a borrowed Run outside the original dispatch intent window',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();f.run.created_at=new Date(t0-60000).toISOString();f.time(f.clock()+60000);await f.coordinator().alarm();expect(await f.store.read()).toBeNull();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('CONFIRMING');});

it.each(['missing','bytes','mode','extra','truncated'])('rejects generated projection when actual native head has %s drift',async kind=>{const f=await fixture(),facts=await candidateFacts(f.g);const g:GitReader={async json(id,p,m,b){const value=await f.g.json(id,p,m,b);if(p.includes('/git/trees/'+f.pull.head.sha)){if(kind==='missing')value.tree=[];if(kind==='bytes')value.tree[0].sha=sha('9');if(kind==='mode')value.tree[0].mode='100755';if(kind==='extra')value.tree.push({path:'extra',type:'blob',mode:'100644',sha:sha('8')});if(kind==='truncated')value.truncated=true;}return value;},artifact:f.g.artifact};await expect(verifyGeneratedProjection(g,facts,{commentId:7,bodyDigest:digest(generatedStatusBody(facts,facts.session.preview,facts.evidence.stateCommit)).slice(7),previewDigest:digest(facts.session.preview).slice(7)})).rejects.toThrow(kind==='truncated'?'NATIVE_TREE_INCOMPLETE':'GENERATED_FILES_MISMATCH');});
it('recovers a throttled write-token preflight before reserving the native dispatch',async()=>{
 const f=await normalFixture();let attempts=0;
 f.g.prepareDispatch=async id=>{
  expect(id).toBe(CENTRAL.id);
  if(++attempts===1)throw Error('RETRY_AFTER:180');
 };
 await f.coordinator().register({hint:f.hint,deliveryId:'token-preflight'});
 const start=f.clock();await f.coordinator().alarm();
 const record=await f.eventStorage.get<any>('nativeEvent');
 expect(record).toMatchObject({status:'PREPARING',dispatchedAt:null,confirmations:0,nextAt:start+180000});
 f.time(start+60000);await f.coordinator().alarm();expect(attempts).toBe(1);expect(f.posts()).toBe(0);
 f.time(record.nextAt);await f.coordinator().alarm();await f.coordinator().alarm();
 expect(f.posts()).toBe(1);expect(attempts).toBe(2);
});
it('durably defers rate-limited native preparation without early reads or resetting its original window',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});const start=f.clock();f.readError('RETRY_AFTER:3600');await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');expect(r.nextAt).toBe(start+3600000);expect(r.preparations).toBe(1);const reads=f.reads();f.time(start+60000);await f.coordinator().alarm();expect(f.reads()).toBe(reads);f.readError(null);f.time(r.nextAt);await f.coordinator().alarm();expect(f.posts()).toBe(1);expect((await f.eventStorage.get<any>('nativeEvent')).deadline).toBe(r.deadline);});
it('rate-limited confirmation keeps one POST and defers a native receipt until the persisted floor',async()=>{const f=await normalFixture();f.run.status='in_progress';await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock();f.time(start+60000);await f.coordinator().alarm();f.readError('RETRY_AFTER:3600');f.time(start+5*60000);await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');expect(r.confirmations).toBe(2);const reads=f.reads();f.run.status='completed';const receipt={runId:101,attempt:1,policySha:f.f.registration.policySha};await f.coordinator().receipt(receipt);await f.coordinator().receipt(receipt);expect(f.reads()).toBe(reads);expect((await f.eventStorage.get<any>('nativeEvent')).receiptDeferred).toBe(true);f.readError(null);f.time(r.nextAt);await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('REGISTERED');expect(f.posts()).toBe(1);});
it('native rate limit beyond original deadline terminates without further alarm or dispatch',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});f.readError('RETRY_AFTER:10000');await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).reason).toBe('RATE_LIMIT_WINDOW_EXHAUSTED');expect(await f.eventStorage.get('__alarm')).toBeUndefined();expect(f.posts()).toBe(0);});

it('fourth and final reserved preparation may succeed once, with no fifth POST or attempt',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});const start=f.clock();f.unavailable(true);for(const n of [0,1,5]){f.time(start+n*60000);await f.coordinator().alarm();}f.unavailable(false);f.time(start+15*60000);await f.coordinator().alarm();expect(f.posts()).toBe(1);expect((await f.eventStorage.get<any>('nativeEvent')).preparations).toBe(4);await f.coordinator().alarm();expect(f.posts()).toBe(1);});
it.each(['success','second-limit','deadline'])('unique receipt has at most one durable rate-limit retry: %s',async scenario=>{const f=await normalFixture();f.run.status='in_progress';await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock();for(const n of [1,5,15]){f.time(start+n*60000);await f.coordinator().alarm();}f.run.status='completed';f.time(start+20*60000);f.readError(scenario==='deadline'?'RETRY_AFTER:10800':'RETRY_AFTER:3600');const receipt={runId:101,attempt:1,policySha:f.f.registration.policySha};await f.coordinator().receipt(receipt);const r=await f.eventStorage.get<any>('nativeEvent'),reads=f.reads();await f.coordinator().receipt(receipt);expect(f.reads()).toBe(reads);expect(r.confirmations).toBe(3);if(scenario==='deadline'){expect(r.status).toBe('NEEDS_ATTENTION');expect(await f.eventStorage.get('__alarm')).toBeUndefined();return;}expect(r.receiptRetryUsed).toBe(true);expect(r.receiptDeferred).toBe(true);expect(r.nextAt).toBe(start+80*60000);f.time(r.nextAt);f.readError(scenario==='success'?null:'RETRY_AFTER:60');await f.coordinator().alarm();const final=await f.eventStorage.get<any>('nativeEvent');expect(final.status).toBe(scenario==='success'?'REGISTERED':'NEEDS_ATTENTION');if(scenario==='second-limit')expect(final.reason).toBe('RECEIPT_RATE_LIMIT_EXHAUSTED');await f.coordinator().receipt(receipt);await f.coordinator().alarm();expect(f.posts()).toBe(1);expect(final.confirmations).toBe(3);expect(await f.eventStorage.get('__alarm')).toBeUndefined();});

it.each(['preparation','unknown-post','known-run'])('same signed hint resumes paused %s only at original pins and budget',async kind=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});if(kind!=='preparation'){f.run.status='in_progress';await f.coordinator().alarm();f.time(f.clock()+60000);if(kind==='known-run')await f.coordinator().alarm();}const before=await f.eventStorage.get<any>('nativeEvent');f.env.BOUNDED_RECHECK_ENABLED='false';f.time(before.nextAt);await f.coordinator().alarm();const paused=await f.eventStorage.get<any>('nativeEvent');expect(paused.status).toBe('PAUSED');expect(await f.eventStorage.get('__alarm')).toBeUndefined();f.env.BOUNDED_RECHECK_ENABLED='true';await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PAUSED');const pins=f.env.BOUNDED_CONTROLLER_SHA;f.env.BOUNDED_CONTROLLER_SHA=sha('9');await f.coordinator().register({hint:f.hint,deliveryId:'d2'});expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PAUSED');f.env.BOUNDED_CONTROLLER_SHA=pins;await f.coordinator().register({hint:f.hint,deliveryId:'d3'});const restored=await f.eventStorage.get<any>('nativeEvent');for(const k of ['receivedAt','deadline','preparations','confirmations','knownRunId','dispatchedAt','receiptConsumed','receiptRetryUsed'])expect(restored[k]).toEqual(before[k]);expect(restored.status).toBe(before.status);await f.coordinator().register({hint:f.hint,deliveryId:'d4'});expect(await f.eventStorage.get('nativeEvent')).toEqual(restored);if(kind!=='preparation'){await f.coordinator().alarm();expect(f.posts()).toBe(1);}});
it('native redelivery cannot resume a superseded label, unknown paused phase or expired window',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});f.env.BOUNDED_RECHECK_ENABLED='false';await f.coordinator().alarm();f.env.BOUNDED_RECHECK_ENABLED='true';(f.f.pull.labels as any[]).push({name:'release:editing'});await expect(f.coordinator().register({hint:f.hint,deliveryId:'d2'})).rejects.toThrow('NATIVE_EVENT_SUPERSEDED');expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PAUSED');f.f.pull.labels=[];const r=await f.eventStorage.get<any>('nativeEvent');delete r.pausedFrom;await f.eventStorage.put('nativeEvent',r);await f.coordinator().register({hint:f.hint,deliveryId:'d3'});expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PAUSED');f.time(r.deadline);await f.coordinator().register({hint:f.hint,deliveryId:'d4'});expect(f.posts()).toBe(0);expect(await f.eventStorage.get('__alarm')).toBeUndefined();});

it('paused native redelivery before persisted rate floor performs no Git reads or rearm',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});const start=f.clock();f.readError('RETRY_AFTER:3600');await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');r.pausedFrom={status:r.status,nextAt:r.nextAt};r.status='PAUSED';r.nextAt=null;await f.eventStorage.put('nativeEvent',r);await f.eventStorage.deleteAlarm();f.readError(null);const reads=f.reads();f.time(start+60000);await f.coordinator().register({hint:f.hint,deliveryId:'d2'});expect(f.reads()).toBe(reads);expect(await f.eventStorage.get('__alarm')).toBeUndefined();f.time(r.retryAfter);await f.coordinator().register({hint:f.hint,deliveryId:'d3'});expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PREPARING');expect((await f.eventStorage.get<any>('nativeEvent')).preparations).toBe(1);});

it.each(['skipped','success-no-artifact'])('normal skipped job %s never registers or reposts and ends within original window',async scenario=>{const f=await normalFixture();f.run.conclusion=scenario==='skipped'?'skipped':'success';f.missingArtifact();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock(),deadline=(await f.eventStorage.get<any>('nativeEvent')).deadline;for(const n of [1,5,15]){f.time(start+n*60000);await f.coordinator().alarm();}f.time(deadline);await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');expect(r.status).toBe('NEEDS_ATTENTION');expect(r.confirmations).toBe(3);expect(r.deadline).toBe(deadline);expect(f.posts()).toBe(1);expect(await f.store.read()).toBeNull();expect(await f.eventStorage.get('__alarm')).toBeUndefined();});
it.each(['event','observe'])('%s guard-skipped/no-artifact outcomes never produce DONE or a second POST',async mode=>{for(const conclusion of ['skipped','success']){const f=await fixture();let now=t0,posts=0,requestKey=f.producer.requestKey;const run={...f.run,run_attempt:mode==='event'?2:1,path:mode==='event'?'.github/workflows/bounded-release-event.yml':'.github/workflows/release-observe.yml',conclusion};const g:GitReader={async json(id,path,method,body){if(method==='POST'){posts++;requestKey=(body as any).inputs.request_key;return null;}if(id===CENTRAL.id){const promoted=promotedControllerFixture(path,f.registration.policySha,f.registration.deploymentSha);if(promoted)return promoted;}if(path.endsWith('/actions/workflows/bounded-release-event.yml'))return {path:'.github/workflows/bounded-release-event.yml',state:'active'};if(path.endsWith('/actions/workflows/release-observe.yml'))return {path:'.github/workflows/release-observe.yml',state:'active'};const value={...run,display_title:(mode==='event'?'Bounded release event ':'Observe candidate ')+requestKey};if(path.includes('/runs?'))return {total_count:1,workflow_runs:[value]};if(path.includes('/actions/runs/99'))return value;return f.g.json(id,path,method,body);},async artifact(){throw Error('ARTIFACT_UNIQUE');}};const storage=new SqliteDurableStorage(),store=new DurableRecheckStore(storage as any),env={...f.env,BOUNDED_RECHECK_ENABLED:'true'} as any;if(mode==='event'){const c=new CandidateEventCoordinator(storage as any,env,()=>g,()=>now);await c.register({event:{repositoryId:TARGET.id,prNumber:192,eventId:123},requestKey,policySha:f.registration.policySha,createdAt:t0});for(const n of [1,5,15]){now=t0+n*60000;await c.alarm();}expect((await storage.get<any>('event')).status).toBe('NEEDS_ATTENTION');expect((await storage.get<any>('event')).deadline).toBe(t0+120*60000);}else{const c=new BoundedRecheck(store,new FixedRecheckEffects(env,()=>g),()=>now);await c.register(f.registration);await c.wake();for(const n of [1,5,15]){now=t0+n*60000;await c.wake();}expect((await store.read())?.status).toBe('NEEDS_ATTENTION');expect((await store.read())?.deadline).toBe(t0+120*60000);}expect(posts).toBe(1);expect(await storage.get('__alarm')).toBeUndefined();}});

it('third discovery durably binds a completed Run before its artifact is rate limited',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const start=f.clock();f.unavailable(true);for(const n of [1,5]){f.time(start+n*60000);await f.coordinator().alarm();}await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});f.unavailable(false);f.artifactFailure('RETRY_AFTER:60');f.time(start+15*60000);await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');expect(r.knownRunId).toBe(101);expect(r.status).toBe('AWAITING_RECEIPT');expect(r.confirmations).toBe(3);expect(r.nextAt).toBe(r.retryAfter);expect((await f.eventStorage.get<any>('nativeEvent')).receiptDeferred).toBe(true);f.artifactFailure(null);f.time(r.retryAfter);await f.coordinator().alarm();const final=await f.eventStorage.get<any>('nativeEvent');expect(final.status).toBe('REGISTERED');expect(final.confirmations).toBe(3);expect(final.deadline).toBe(r.deadline);expect(f.posts()).toBe(1);});

it('a newer protected receipt before reservation prevents stale ready handoff effects',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),arrived=new Promise<void>(r=>{entered=r;}),original=f.g.artifact;let calls=0;f.g.artifact=async(...args)=>{if(++calls===1){const value=structuredClone(await original(...args));entered();await gate;return value;}return original(...args);};f.time(f.clock()+60000);const old=f.coordinator().alarm();await arrived;f.artifact.value.outcome='protected';await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});expect((await f.eventStorage.get<any>('nativeEvent')).status).toBe('PROTECTED');release();await old;expect(await f.store.read()).toBeNull();expect((await f.eventStorage.get<any>('nativeEvent')).handoff).toBeUndefined();expect(f.posts()).toBe(1);});
it('reserved handoff cannot be preempted by a completion receipt between target status and registration',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),arrived=new Promise<void>(r=>{entered=r;}),get=f.env.BOUNDED_RECHECK.get;let blocked=false;f.env.BOUNDED_RECHECK.get=(id:string)=>{const original=get(id);return {async fetch(req:Request){if(!blocked&&new URL(req.url).pathname==='/status'){blocked=true;entered();await gate;}return original.fetch(req);}};};f.time(f.clock()+60000);const work=f.coordinator().alarm();await arrived;const reserved=await f.eventStorage.get<any>('nativeEvent');expect(reserved.handoff.status).toBe('RESERVED');f.artifact.value.outcome='protected';await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});expect((await f.eventStorage.get<any>('nativeEvent')).claim).toBe(reserved.claim);release();await work;const final=await f.eventStorage.get<any>('nativeEvent');expect(final.status).toBe('REGISTERED');expect(final.handoff.status).toBe('COMPLETE');expect(final.handoff.steps.map((s:any)=>[s.action,s.state])).toEqual([['status','ACK'],['register','ACK']]);expect(f.posts()).toBe(1);});
it.each(['lost-response','deadline'])('handoff %s retains evidence without replaying unknown controls',async scenario=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const get=f.env.BOUNDED_RECHECK.get,deadline=(await f.eventStorage.get<any>('nativeEvent')).deadline;let registrations=0;f.env.BOUNDED_RECHECK.get=(id:string)=>{const original=get(id);return {async fetch(req:Request){const action=new URL(req.url).pathname;if(action==='/register')registrations++;const result=await original.fetch(req);if(scenario==='deadline'&&action==='/status')f.time(deadline);if(scenario==='lost-response'&&action==='/register')throw Error('LOST_TARGET_RESPONSE');return result;}};};f.time(f.clock()+60000);await f.coordinator().alarm();const final=await f.eventStorage.get<any>('nativeEvent');expect(final.status).toBe('NEEDS_ATTENTION');expect(final.handoff.status).toBe('INDETERMINATE');expect(final.evidence.runId).toBe(101);await f.coordinator().receipt({runId:101,attempt:1,policySha:f.f.registration.policySha});await f.coordinator().alarm();expect(registrations).toBe(scenario==='deadline'?0:1);expect(f.posts()).toBe(1);expect(await f.eventStorage.get('__alarm')).toBeUndefined();});
it('crash after handoff reservation leaves original deadline alarm that ends without external replay',async()=>{const f=await normalFixture();await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const get=f.env.BOUNDED_RECHECK.get;let entered!:()=>void;const arrived=new Promise<void>(r=>{entered=r;});f.env.BOUNDED_RECHECK.get=(id:string)=>{const original=get(id);return {async fetch(req:Request){if(new URL(req.url).pathname==='/status'){entered();return new Promise<Response>(()=>{});}return original.fetch(req);}};};f.time(f.clock()+60000);void f.coordinator().alarm();await arrived;const r=await f.eventStorage.get<any>('nativeEvent');expect(await f.eventStorage.get('__alarm')).toBe(r.deadline);f.time(r.deadline);await f.coordinator().alarm();expect((await f.eventStorage.get<any>('nativeEvent')).reason).toBe('HANDOFF_WINDOW_EXHAUSTED');expect(await f.eventStorage.get('__alarm')).toBeUndefined();expect(f.posts()).toBe(1);});

it('handoff keeps target expectedGeneration CAS and never retries a stale resume with a fresh generation',async()=>{const f=await normalFixture();await f.engine.register(f.f.registration);await f.coordinator().register({hint:f.hint,deliveryId:'d'});await f.coordinator().alarm();const get=f.env.BOUNDED_RECHECK.get;let changed=false;f.env.BOUNDED_RECHECK.get=(id:string)=>{const original=get(id);return {async fetch(req:Request){const response=await original.fetch(req);if(!changed&&new URL(req.url).pathname==='/status'){changed=true;const old=await response.clone().json() as any;await f.engine.control('resume',old.generation);await f.engine.control('pause',old.generation+1);}return response;}};};f.time(f.clock()+60000);await f.coordinator().alarm();const r=await f.eventStorage.get<any>('nativeEvent');expect(r.status).toBe('NEEDS_ATTENTION');expect(r.handoff.steps.at(-1).action).toBe('resume');expect(r.handoff.steps.at(-1).expectedGeneration).toBe(2);expect(r.handoff.steps.at(-1).state).toBe('INTENT');expect((await f.store.read())?.generation).toBe(4);expect((await f.store.read())?.status).toBe('PAUSED');expect(f.posts()).toBe(1);});

it.each([429,403,503])('preserves native dispatch identity across HTTP %s and restart',async status=>{
 const f=await normalFixture(),json=f.g.json.bind(f.g);let posts=0;
 f.g.json=async(id,path,method,body)=>{
  if(method==='POST'&&++posts===1)throw new GitHubRetryError(status,'180',true);
  return json(id,path,method,body);
 };
 await f.coordinator().register({hint:f.hint,deliveryId:'native-dispatch'});await f.coordinator().alarm();
 const state=await f.eventStorage.get<any>('nativeEvent');expect(state.nextAt).toBe(f.clock()+180000);
 expect(state.status).toBe(status===503?'CONFIRMING':'PREPARING');
 f.time(state.nextAt);await f.coordinator().alarm();await f.coordinator().alarm();
 expect(posts).toBe(status===503?1:2);
});
