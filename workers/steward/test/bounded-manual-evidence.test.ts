import {candidateCommentHeader,formatPreviewBody} from '../src/preview-reference.js';
import {promotedControllerFixture} from './promoted-controller-fixture.js';
import {BoundedGitHub} from '../src/bounded-recheck-github.js';
import {SqliteDurableStorage} from './bounded-storage.js';
import {handleWebhook} from '../src/index.js';
import {NativeCandidateCoordinator,nativeHintKey} from '../src/bounded-native-event.js';
import {applyVerifiedCandidateEvent} from '../src/bounded-release-event.js';
import {objectKey,identityKey} from '../src/bounded-recheck.js';
import type {VerifiedWakeContext} from '../src/bounded-initial-wake.js';
import {FixedRecheckEffects} from '../src/bounded-recheck-effects.js';
import {describe,it,expect,vi} from 'vitest';
import {createHmac,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {manualIdentity,manualBody,manualProjectionBefore,verifyManualHead,verifyManualProjection} from '../src/bounded-manual-evidence.js';
import {candidateFacts} from '../src/bounded-candidate-evidence.js';
import {digest,TARGET,CENTRAL,type GitReader} from '../src/bounded-recheck-github.js';
const sha=(c:string)=>c.repeat(40),key=(c:string)=>c.repeat(64);
function fixture(){
 const m:any={schemaVersion:1,kind:'validated-manual-candidate',repositoryId:TARGET.id,candidateId:key('a'),prNumber:192,branch:'steward/candidate',headSha:sha('b'),sourceSha:sha('c'),units:[{id:'layerscape',path:'.',version:'1.2.3',tag:'v1.2.3',notesPath:'notes/1.2.3.md'}],files:[],projection:{preview:`人工完成稿已核验，保留原文。\n来源：${sha('c')}\n候选 head：${sha('b')}\n版本、交付配置及发布说明已按该 head 核对；尚未合并或发行。\n`,bodyDigest:''},producer:{repositoryId:CENTRAL.id,runId:88,attempt:1,controllerSha:sha('d'),requestKey:key('e')}};
 const blobs:any={'.github/delivery.json':'{}','.release-please-manifest.json':'{}',VERSION:'1.2.3\n','release-please-config.json':'{}','notes/1.2.3.md':'notes\n'};
 m.files=Object.keys(blobs).sort().map(path=>({path,sha256:digest(blobs[path]).slice(7)}));m.projection.bodyDigest=digest(manualBody(m)).slice(7);
 const sourceBlobs={...blobs};
 const state:any={schemaVersion:3,repositoryId:TARGET.id,activeCycleId:null,candidate:{id:m.candidateId,prNumber:m.prNumber,branch:m.branch,statusCommentId:7,baseSha:sha('f'),publishedHead:sha('1'),generatedSnapshotPath:`generated/${m.candidateId}/${key('f')}.json`,pendingWrite:null}};
 const session:any={generated:{baseSha:sha('f'),files:Object.entries(blobs).map(([path,content])=>({path,mode:'100644',content})),units:[{id:'layerscape',version:'1.2.3'}]},pending:null,identity:{id:'old'},manualValidation:m,preview:m.projection.preview};
 const pull:any={number:192,head:{sha:m.headSha,ref:m.branch,repo:{id:TARGET.id}},base:{ref:'main',repo:{id:TARGET.id}},state:'open',merged:false,labels:[]};
 const comments:any[]=[{id:7,user:{id:301115370},issue_url:`https://api.github.com/repos/${TARGET.name}/issues/192`,body:manualBody(m)}];let main=m.sourceSha,stateSha=sha('2');
 const g:GitReader={async json(id,p){if(p.includes('/actions/runs/88/attempts/1'))return {id:88,run_attempt:1,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},path:'.github/workflows/release-candidate-event.yml',head_sha:m.producer.controllerSha,head_branch:'main',actor:{id:301115370},event:'workflow_dispatch',display_title:'Candidate event '+m.producer.requestKey,status:'completed',conclusion:'success'};if(p.includes('/git/trees/'))return {sha:m.headSha,truncated:false,tree:Object.entries(p.includes(m.sourceSha)?sourceBlobs:blobs).map(([path,value])=>{const b=Buffer.from(value as string);return {path,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')};})};if(p.includes('/comments?'))return comments;if(p.includes('/compare/'))return {base_commit:{sha:m.sourceSha},merge_base_commit:{sha:m.sourceSha},status:'ahead'};if(p.endsWith('/git/ref/heads/main'))return {object:{sha:main}};if(p.endsWith('/git/ref/heads/steward/release-state'))return {ref:'refs/heads/steward/release-state',object:{type:'commit',sha:stateSha}};if(p.endsWith('/pulls/192'))return pull;if(p.includes('/contents/')){const path=p.split('/contents/')[1]!.split('?')[0]!;const text=JSON.stringify(session),value=path==='state.json'?JSON.stringify(state):path===state.candidate.generatedSnapshotPath?JSON.stringify({schemaVersion:1,repositoryId:TARGET.id,candidateId:m.candidateId,documentKind:'generated',index:0,count:1,documentDigest:digest(JSON.stringify(session.generated)).slice(7),content:JSON.stringify(session.generated)}):path.endsWith('/session.json')?JSON.stringify({schemaVersion:1,repositoryId:TARGET.id,candidateId:m.candidateId,documentKind:'session',index:0,count:1,documentDigest:digest(text).slice(7),content:text}):blobs[path];const b=Buffer.from(value);return {path,type:'file',encoding:'base64',size:b.length,sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),content:b.toString('base64')};}throw Error(p);},async artifact(){throw Error('unexpected artifact');}};
 const evidence={commentId:7,bodyDigest:m.projection.bodyDigest,previewDigest:digest(m.projection.preview).slice(7)};
 return {m,state,session,pull,comments,g,blobs,sourceBlobs,evidence,main:(s:string)=>{main=s;},stateSha:(s:string)=>{stateSha=s;}};
}
describe('manual fact identity and independent projection evidence',()=>{
 it('binds protected ownership, new source and manual facts without replacing old G',async()=>{const f=fixture(),before=structuredClone(f.session.generated),facts=await candidateFacts(f.g);expect(facts.identity.sourceSha).toBe(f.m.sourceSha);expect(facts.identity).toEqual(manualIdentity(f.m,f.state,f.session));expect(f.session.generated).toEqual(before);await verifyManualProjection(f.g,facts,f.evidence);});
 it('same facts preserve identity across producers',()=>{const f=fixture(),a=manualIdentity(f.m,f.state,f.session);f.m.producer.runId++;expect(manualIdentity(f.m,f.state,f.session)).toEqual(a);});
 it.each(['head','source','pending','owner','extra','files'])('rejects %s drift without old G fallback',async kind=>{const f=fixture();if(kind==='head')f.pull.head.sha=sha('9');if(kind==='source')f.main(sha('9'));if(kind==='pending')f.session.pending={};if(kind==='owner')f.m.prNumber=193;if(kind==='extra')f.m.extra=true;if(kind==='files')f.m.files.reverse();await expect(candidateFacts(f.g)).rejects.toThrow();});
 it('rejects file bytes drifting despite successful producer status',async()=>{const f=fixture();f.blobs.VERSION='9.9.9';await expect(verifyManualHead(f.g,f.m,f.pull,f.session.generated.files)).rejects.toThrow('MANUAL_BLOB_DIGEST');});
 it.each(['bot','other-pr','body','duplicate','comment-id','preview','evidence','state-moved'])('does not finish when projection has %s',async kind=>{const f=fixture(),facts=await candidateFacts(f.g);if(kind==='bot')f.comments[0].user.id=42;if(kind==='other-pr')f.comments[0].issue_url='https://api.github.com/repos/splrad/LayerScape/issues/193';if(kind==='body')f.comments[0].body+='x';if(kind==='duplicate')f.comments.push({...f.comments[0],id:8});if(kind==='comment-id')facts.state.candidate.statusCommentId=9;if(kind==='preview')facts.session.preview='other';if(kind==='evidence')f.evidence.bodyDigest=key('0');if(kind==='state-moved')f.stateSha(sha('8'));if(kind==='closed')f.pull.state='closed';if(kind==='editing')f.pull.labels=[{name:'release:editing'}];await expect(verifyManualProjection(f.g,facts,f.evidence)).rejects.toThrow();});
});

it('canonical manual identity ignores JSON key insertion order within fixed records',()=>{const f=fixture(),identity=manualIdentity(f.m,f.state,f.session);const reverse=(v:any)=>Object.fromEntries(Object.entries(v).reverse());f.m.units=f.m.units.map(reverse);f.m.files=f.m.files.map(reverse);f.m.projection=reverse(f.m.projection);expect(manualIdentity(f.m,f.state,f.session)).toEqual(identity);});

it.each(['valid','historical-producer','late-receipt','late-upload','after-deadline','wrong-run','missing','editing-before-artifact','editing-after-artifact','closed-after-projection'])('manual observer artifact retains explicit control state: %s',async scenario=>{
 const f=fixture(),facts=await candidateFacts(f.g),at=Date.now(),requestKey=key('7'),run:any={id:91,run_attempt:1,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},head_sha:scenario==='historical-producer'?sha('9'):f.m.producer.controllerSha,path:'.github/workflows/release-observe.yml',event:'workflow_dispatch',actor:{id:301115370},head_branch:'main',display_title:'Observe candidate '+requestKey,status:'completed',conclusion:'success',run_started_at:new Date(at).toISOString(),updated_at:new Date(at+2000).toISOString()};
 const value={schemaVersion:1,requestKey,identity:facts.identity,runId:91,runAttempt:1,repositoryId:CENTRAL.id,controllerSha:run.head_sha,sourceSha:facts.identity.sourceSha,observedAt:new Date(at+1000).toISOString(),stateBefore:facts.evidence,stateAfter:facts.evidence,outcome:'done',status:'READY',reason:'MANUAL_PROJECTION',projectionEvidence:scenario==='missing'?null:f.evidence};
 const requests:string[]=[];
 const g:GitReader={async json(id,path,method,body){requests.push(path);if(scenario==='closed-after-projection'&&path.includes('/comments?'))f.pull.state='closed';if(scenario==='editing-after-artifact'&&path.includes('/comments?'))f.pull.labels=[{name:'release:editing'}];if(path.includes('/release-observe.yml/runs?'))return {total_count:1,workflow_runs:[run]};if(path.endsWith('/actions/runs/91'))return run;return f.g.json(id,path,method,body);},async artifact(){if(scenario==='editing-before-artifact')f.pull.labels=[{name:'release:editing'}];return {value,artifactId:22,digest:digest('archive'),createdAt:new Date(at+(scenario==='late-upload'?1900:1000)).toISOString()};}};
 const receipt=['late-receipt','late-upload','after-deadline','wrong-run'].includes(scenario);
 const result=new FixedRecheckEffects({BOUNDED_RECHECK_ENABLED:'true',BOUNDED_CONTROLLER_SHA:sha('0')} as any,()=>g).confirm(
   {identity:facts.identity,policySha:run.head_sha,t0:at-1000,deadline:at+(scenario==='after-deadline'?100:1500)} as any,
   {key:requestKey,claimedAt:at} as any,receipt?(scenario==='wrong-run'?92:91):undefined);
 if(scenario==='wrong-run'){await expect(result).rejects.toThrow('RECEIPT_RUN');return;}
 if(scenario==='after-deadline'){await expect(result).rejects.toThrow('RECEIPT_OBSERVATION_WINDOW');return;}
 if(scenario==='late-receipt'){
   expect((await result).kind).toBe('done');
   const immutable=requests.filter(p=>p.includes('/git/trees/')||p.includes('/contents/')||p.includes('/compare/'));
   expect(immutable.length).toBeGreaterThan(0);
   expect(new Set(immutable).size).toBe(immutable.length);
   expect(requests.filter(p=>p.endsWith('/git/ref/heads/main')).length).toBeGreaterThan(1);
   return;
 }
 if(scenario==='missing')await expect(result).rejects.toThrow('MANUAL_FIELDS');else if(scenario.startsWith('editing'))expect(await result).toEqual({kind:'pause',reason:'EDITING_PAUSED'});else if(scenario.startsWith('closed'))expect(await result).toEqual({kind:'stop',reason:'CANDIDATE_CLOSED'});else expect((await result).kind).toBe('done');
});

it('manual facts do not depend on old generated identity availability',async()=>{const f=fixture();f.session.identity=null;expect((await candidateFacts(f.g)).identity.sourceSha).toBe(f.m.sourceSha);});

it.each(['editing','closed'] as const)('manual %s is an explicit control outcome before any observer POST',async state=>{const f=fixture(),facts=await candidateFacts(f.g);if(state==='editing')f.pull.labels=[{name:'release:editing'}];else f.pull.state='closed';const e=new FixedRecheckEffects({BOUNDED_RECHECK_ENABLED:'true'} as any,()=>f.g);expect(await e.observe({identity:facts.identity,policySha:f.m.producer.controllerSha} as any,{key:key('7')} as any)).toEqual(state==='editing'?{kind:'pause',reason:'EDITING_PAUSED'}:{kind:'stop',reason:'CANDIDATE_CLOSED'});});

it.each(['source.ts','.github/workflows/release.yml','assets/new.png','rename'])('rejects unmanaged manual change %s outside exact old G paths',async path=>{const f=fixture();if(path==='rename'){delete f.blobs.VERSION;f.blobs['renamed-version']='1.2.3';}else f.blobs[path]='changed';await expect(verifyManualHead(f.g,f.m,f.pull,f.session.generated.files)).rejects.toThrow(path==='rename'?'MANUAL_GENERATED_FILE_TREE':'MANUAL_UNMANAGED_CHANGES');});
it('allows managed old G changelog changes outside the five manual facts',async()=>{const f=fixture();f.sourceBlobs['CHANGELOG.md']='old';f.blobs['CHANGELOG.md']='new';f.session.generated.files.push({path:'CHANGELOG.md',mode:'100644',content:'old generated'});await expect(verifyManualHead(f.g,f.m,f.pull,f.session.generated.files)).resolves.toBeDefined();});

describe('read-only handoff of an already completed manual candidate',()=>{
 async function replay() {
  const f=fixture(), facts=await candidateFacts(f.g);
  const registration={identity:facts.identity,policySha:sha('7'),deploymentSha:sha('8'),t0:1000};
  const projection=await manualProjectionBefore(f.g,facts);
  const context:VerifiedWakeContext={kind:'validated-manual-candidate',repositoryId:TARGET.id,prNumber:192,
   sourceSha:facts.identity.sourceSha,identityDigest:digest(identityKey(facts.identity)),eventId:55,normalRunId:56,
   attempt:1,projectionPending:projection.pending,projectionBefore:projection.before};
  const receipt={runId:42,attempt:1,artifactId:43,digest:digest('archive'),projectionEvidence:projection.before,state:facts.evidence};
  const record={...registration,schemaVersion:1,t0:1,deadline:7200001,generation:2,policySha:sha('1'),deploymentSha:sha('2'),
   status:'DONE',reason:'VERIFIED_DONE',nextAt:null,notificationPending:false,intent:{claimedAt:2,sequence:0,key:digest(identityKey(facts.identity)+':0').slice(7),runId:42},evidence:JSON.stringify(receipt)};
  const actions:string[]=[];
  const stub={async fetch(request:Request){actions.push(new URL(request.url).pathname);return Response.json(record);}};
  const replay={priorIdentity:facts.identity,stateAfter:facts.evidence,manualProducerSha:record.policySha,eventId:55,normalRunId:56,requestKey:key('3'),producerKey:key('3'),producerRunId:56,eventT0:1000};
  const run=()=>applyVerifiedCandidateEvent(stub as any,{registration,editing:false,wakeContext:context} as any,replay);
  return {run,record,receipt,context,replay,actions};
 }
 it('links the historical receipt twice without changing the old object or consuming its window',async()=>{
  const f=await replay(),before=structuredClone(f.record);
  for(let n=0;n<2;n++)expect(await f.run()).toMatchObject({policySha:f.record.policySha,deploymentSha:f.record.deploymentSha,
   t0:1,deadline:7200001,generation:2,runId:42,artifactId:43,requestKey:f.record.intent.key});
  expect(f.actions).toEqual(['/status','/status']);expect(f.record).toEqual(before);
 });
 it.each(['PENDING','PAUSED','NEEDS_ATTENTION','CANCELLED'])('never takes over %s across pins',async status=>{
  const f=await replay();f.record.status=status;await expect(f.run()).rejects.toThrow('EVENT_OBJECT_IDENTITY');
  expect(f.actions).toEqual(['/status']);
 });
 it.each(['receipt','state','projection','pending','identity','alarm','notification','unknown','producer','slot'])('rejects changed %s',async kind=>{
  const f=await replay();
  if(kind==='receipt')f.record.intent.runId++;
  if(kind==='state')f.replay.stateAfter={...f.replay.stateAfter,stateCommit:sha('9')};
  if(kind==='projection')f.context.projectionBefore.commentId=99;
  if(kind==='pending')f.context.projectionPending=true;
  if(kind==='identity')f.replay.priorIdentity={...f.replay.priorIdentity,epoch:'other'};
  if(kind==='alarm')Object.assign(f.record,{nextAt:1111});
  if(kind==='notification')f.record.notificationPending=true;
  if(kind==='producer')f.replay.manualProducerSha=sha('3');
  if(kind==='slot')f.record.intent.sequence++;
  if(kind==='unknown')f.record.reason='UNKNOWN_DELIVERY';
  await expect(f.run()).rejects.toThrow();expect(f.actions).toEqual(['/status']);
 });
});

describe('native ingress across a controller or deployment change',()=>{
 async function scenario(mode:string){
  const f=fixture(),current=await candidateFacts(f.g);
  const t0=Date.now()-180000,utc=(n:number)=>new Date(n).toISOString();
  const event={id:57,issue:{number:192,repository_url:'https://api.github.com/repos/'+TARGET.name},
   actor:{id:7},event:'unlabeled',label:{name:'release:editing'},created_at:utc(t0)};
  const hint={repositoryId:TARGET.id,prNumber:192,actorId:7,action:'unlabeled',updatedAt:event.created_at} as const;
  const requestKey=nativeHintKey(hint), policySha=sha('7'),deploymentSha=sha('8'),oldKey=digest(identityKey(current.identity)+':0').slice(7);
  const receipt={runId:42,attempt:1,artifactId:43,digest:digest('old artifact'),projectionEvidence:f.evidence,state:current.evidence};
  const record:any={identity:current.identity,policySha:f.m.producer.controllerSha,deploymentSha:sha('2'),schemaVersion:1,
   t0:t0-86400000,deadline:t0-79200000,generation:2,status:'DONE',reason:'VERIFIED_DONE',nextAt:null,notificationPending:false,
   intent:{sequence:0,claimedAt:t0-86390000,key:oldKey,runId:42},evidence:JSON.stringify(receipt)};
  if(['PENDING','PAUSED','CANCELLED','UNKNOWN_DELIVERY'].includes(mode)){record.status=mode==='UNKNOWN_DELIVERY'?'NEEDS_ATTENTION':mode;record.reason=mode;}
  if(mode==='stale')record.t0=t0+1;
  if(mode==='same-time')record.t0=t0;
  const oldTarget='recheck:v1:'+digest(objectKey(current.identity)).slice(7);
  let now=t0+1000,posts=0;const actions:string[]=[],store=new SqliteDurableStorage();
  const repo={id:CENTRAL.id},baseRun={run_attempt:1,actor:{id:301115370},repository:repo,head_repository:repo,head_branch:'main',
   status:'completed',conclusion:'success',event:'workflow_dispatch'};
  const normal={...baseRun,id:101,path:'.github/workflows/release-candidate-event.yml',head_sha:policySha,
   display_title:'Candidate event '+requestKey,created_at:utc(now),run_started_at:utc(now+1000),updated_at:utc(now+5000)};
  const old={...baseRun,id:42,path:'.github/workflows/release-observe.yml',head_sha:record.policySha,
   display_title:'Observe candidate '+oldKey,updated_at:utc(mode==='simultaneous-completion'?t0:t0-80000000)};
  const g:GitReader={async json(id,path,method,body){
   if(method==='POST'){
    expect((body as any).inputs.request_key).toBe(requestKey);posts++;
    if(mode==='successor'||mode==='conflict-at-confirm'){
     f.m.headSha=sha('9');f.pull.head.sha=f.m.headSha;f.m.projection.preview=f.m.projection.preview.replace(sha('b'),sha('9'));
     f.m.projection.bodyDigest=digest(manualBody(f.m)).slice(7);f.m.producer={...f.m.producer,runId:101,controllerSha:policySha,requestKey};
     f.stateSha(sha('3'));
    }
    if(mode==='conflict-at-confirm'){record.status='PAUSED';record.reason='PAUSED';}
    return null;
   }
   if(path.endsWith('/actions/runs/42/attempts/1'))return old;
   if(path.endsWith('/actions/runs/101/attempts/1'))return normal;
   if(path.includes('/release-candidate-event.yml/runs?'))return {total_count:1,workflow_runs:[normal]};
   if(path.endsWith('/actions/workflows/release-candidate-event.yml'))return {path:normal.path,state:'active'};
   if(id===CENTRAL.id){const promoted=promotedControllerFixture(path,policySha,deploymentSha);if(promoted)return promoted;}
   if(path.includes('/issues/192/events?'))return [event];
   if(path.endsWith('/issues/events/57'))return event;
   return f.g.json(id,path,method,body);
  },async artifact(){
    const after=await candidateFacts(g,false,true);
    return {artifactId:99,digest:digest('new normal'),createdAt:utc(t0+4000),value:{schemaVersion:1,requestKey,
     producer:{repositoryId:CENTRAL.id,runId:mode==='wrong-producer'?999:101,attempt:1,controllerSha:policySha},
     event:{eventId:57,repositoryId:TARGET.id,prNumber:192},sourceSha:f.m.sourceSha,status:'READY',reason:'MANUAL_VALIDATED',
     outcome:'manual_validated',stateBefore:current.evidence,stateAfter:after.evidence,candidateIdentity:after.identity}};
  }};
  let fresh:any=null;
  const env:any={STEWARD_WEBHOOK_SECRET:'fixture-only',LEGACY_RELEASE_RETIRED:'true',LEGACY_VALIDATION_RETIRED:'true',ORGANIZATION_ID:'42',
   INSTALLATION_ID:'41',BOUNDED_RECHECK_ENABLED:'true',BOUNDED_CONTROLLER_SHA:policySha,BOUNDED_DEPLOYMENT_SHA:deploymentSha};
  const worker=()=>new NativeCandidateCoordinator(store as any,env,()=>g,()=>now);
  env.BOUNDED_RECHECK={idFromName:(s:string)=>s,get:(id:string)=>({async fetch(req:Request){
   const action=new URL(req.url).pathname,body=await req.json() as any;
   if(action==='/native-event')return Response.json(await worker().register(body));
   const target=id===oldTarget?'old':'new';actions.push(target+action);
   if(action==='/status')return Response.json(target==='old'?record:fresh);
   if(action==='/register'&&target==='new'){fresh={...body.registration,status:'PENDING',generation:1};return Response.json(fresh);}
   throw Error('unexpected control '+action);
  }})};
  const payload=JSON.stringify({organization:{id:42},installation:{id:41},repository:{id:TARGET.id,full_name:TARGET.name,default_branch:'main',private:false},action:'unlabeled',
   label:{name:'release:editing'},sender:{id:7},pull_request:{number:192,state:'open',merged:false,head:{repo:{id:TARGET.id}},base:{repo:{id:TARGET.id},ref:'main'},updated_at:event.created_at}});
  const signature=createHmac('sha256',env.STEWARD_WEBHOOK_SECRET).update(payload).digest('hex');
  const receive=()=>handleWebhook(new Request('https://fixture.invalid/webhook',{method:'POST',headers:{
   'x-github-event':'pull_request','x-github-delivery':'original-guid','x-hub-signature-256':'sha256='+signature},body:payload}),env);
  const scoped=vi.spyOn(BoundedGitHub.prototype,'forCandidate').mockResolvedValue({...g,target:TARGET});
  try {
    await receive();await worker().alarm();now+=60000;await worker().alarm();
    await receive();await worker().alarm();
  } finally {scoped.mockRestore();}
  return {posts,actions,source:await store.get<any>('nativeEvent'),record};
 }
 it.each(['stale','same-time','simultaneous-completion','PENDING','UNKNOWN_DELIVERY','PAUSED','CANCELLED'])('blocks %s before any dispatch or control',async mode=>{
  const r=await scenario(mode);expect(r.posts).toBe(0);expect(r.actions.length).toBeGreaterThan(0);
  expect(r.actions.every(x=>x==='old/status')).toBe(true);expect(r.source.dispatchedAt).toBeNull();expect(r.source.status).toBe('NEEDS_ATTENTION');expect(r.source.nextAt).toBeNull();
 });
 it('binds a new signed event and normal to the unchanged completed object',async()=>{
  const r=await scenario('done');expect(r.posts).toBe(1);expect(r.actions).toEqual(['old/status','old/status']);
  expect(r.source.status).toBe('PREVIOUSLY_COMPLETED');expect(r.source.evidence.previousCompletion.runId).toBe(42);
  expect(r.source.evidence.runId).toBe(101);expect(r.record.generation).toBe(2);
 });
 it('does not consume a contradictory normal producer',async()=>{
  const r=await scenario('wrong-producer');expect(r.posts).toBe(1);expect(r.actions).toEqual(['old/status']);
  expect(r.source.status).not.toBe('PREVIOUSLY_COMPLETED');
 });
 it('allows a genuine successor only after the prior completion and never cancels it',async()=>{
  const r=await scenario('successor');expect(r.posts).toBe(1);expect(r.actions).toEqual(['old/status','old/status','new/status','new/register']);
  expect(r.source.status).toBe('REGISTERED');
 });
 it('rechecks the prior record before any successor cancellation or registration',async()=>{
  const r=await scenario('conflict-at-confirm');expect(r.posts).toBe(1);expect(r.actions).toEqual(['old/status','old/status']);
  expect(r.source.status).toBe('NEEDS_ATTENTION');
 });
});

describe('manual notes at the generated base',()=>{
 it.each(['valid','conditional v3','long preview','unrelated edit','unrelated head','undeclared notes','wrong preview'])('verifies the exact published-to-human change: %s',async scenario=>{
   const f=fixture(),m=f.m,notes=m.units[0].notesPath;
   m.schemaVersion=3;
   m.units[0].versionPath='VERSION';
   f.state.candidate.baseSha=f.session.generated.baseSha=m.sourceSha;
   f.session.generated.units=[{id:'layerscape',path:'.',tag:'v1.2.3',version:'1.2.3'}];
   f.session.identity.units=[{id:'layerscape',contributors:{contributors:[]}}];
   const declaration={id:'layerscape',path:'.',notesPath:scenario==='undeclared notes'?'other.md':notes};
   f.blobs['.github/delivery.json']=f.sourceBlobs['.github/delivery.json']=JSON.stringify({schemaVersion:2,units:[declaration]});
   f.blobs[notes]='## 更新内容\r\n\r\n人工修改。\r\n\r\n## 恢复\r\n\r\n当前发布资料未提供此项变化的确认信息。\r\n';
   if(scenario==='conditional v3'){
     f.session.identity.noteTemplate=readFileSync(new URL('../../../templates/repository/.github/release-template.md.mustache',import.meta.url),'utf8');
     f.blobs['.github/delivery.json']=f.sourceBlobs['.github/delivery.json']=JSON.stringify({schemaVersion:3,notes:{'.':notes}});
     f.blobs['release-please-config.json']=f.sourceBlobs['release-please-config.json']=JSON.stringify({packages:{'.':{component:'layerscape'}}});
     f.blobs[notes]='## 🐛 错误修复\r\n\r\n**启动**。人工修改。\r\n';
   }
   if(scenario==='long preview')f.blobs[notes]=f.blobs[notes].replace('人工修改。','稿'.repeat(68000));
   m.files=Object.keys(f.blobs).sort().map(path=>({path,sha256:digest(f.blobs[path]).slice(7)}));
   m.projection.preview='# '+notes+'\n\n## 更新内容\n\n人工修改。\n\n';
   if(scenario==='conditional v3')m.projection.preview=
     `# ${notes}\n\n## 本次更新\n\n### 🐛 错误修复\n\n- **启动**。人工修改。\n\n## 版本记录\n\n[查看候选源码](<https://github.com/${TARGET.name}/tree/${m.sourceSha}>)\n`;
   if(scenario==='long preview')m.projection.preview=m.projection.preview.replace('人工修改。','稿'.repeat(68000));
   if(scenario==='wrong preview')m.projection.preview+='旧稿';
   m.projection.bodyDigest=digest(manualBody(m)).slice(7);
   const published=f.state.candidate.publishedHead;
   const g:GitReader={...f.g,json:async(id,path)=>{
     if(scenario==='long preview'){
       const chunkPath=/\/contents\/(generated\/[a-f0-9]{64}\/session(?:-(\d+))?\.json)\?ref=/.exec(path);
       if(chunkPath){
         const text=JSON.stringify(f.session),parts=text.match(/[\s\S]{1,12000}/g)!;
         const index=Number(chunkPath[2]??0);
         const bytes=Buffer.from(JSON.stringify({schemaVersion:1,repositoryId:TARGET.id,candidateId:m.candidateId,
           documentKind:'session',index,count:parts.length,documentDigest:digest(text).slice(7),content:parts[index]}));
         return {path:chunkPath[1],type:'file',encoding:'base64',size:bytes.length,
           sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),content:bytes.toString('base64')};
       }
       const archive=sha('8'),stateCommit=sha('2'),name=`generated/${m.candidateId}/preview.md`;
       const bytes=Buffer.from(m.projection.preview),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
       if(path.endsWith(`/compare/${archive}...${stateCommit}`))return {status:'ahead',base_commit:{sha:archive},merge_base_commit:{sha:archive}};
       if(path.endsWith(`/git/trees/${archive}?recursive=1`))return {truncated:false,tree:[{path:name,type:'blob',mode:'100644',sha:blob}]};
       if(path.endsWith(`/contents/${name}?ref=${archive}`))return {path:name,type:'file',encoding:'base64',size:bytes.length,sha:blob,content:bytes.toString('base64')};
     }
     if(path.includes('/compare/'+published+'...'))return {base_commit:{sha:published},
       merge_base_commit:{sha:scenario==='unrelated head'?sha('9'):published},status:'ahead'};
     if(path.includes('/git/trees/'+published)){
       const tree=await f.g.json(id,path.replace(published,m.sourceSha));
       if(scenario==='unrelated edit')tree.tree.push({path:'unrelated.txt',mode:'100644',type:'blob',sha:sha('3')});
       return tree;
     }
     return f.g.json(id,path);
   }};
   const read=()=>candidateFacts(g);
   if(scenario==='long preview'){
     f.session.preview=m.projection.preview;
     const facts=await candidateFacts(g);
     const header=candidateCommentHeader(m.candidateId,m.headSha,m.units);
     const body=formatPreviewBody(header,m.projection.preview,m.candidateId,TARGET.name,sha('8'));
     expect(Buffer.byteLength(manualBody(m))).toBeGreaterThan(65536);
     expect(Buffer.byteLength(body)).toBeLessThan(48*1024);
     f.comments[0].body=body;
     const evidence={commentId:7,previewDigest:digest(m.projection.preview).slice(7),bodyDigest:digest(body).slice(7)};
     expect(evidence.bodyDigest).not.toBe(m.projection.bodyDigest);
     expect((await manualProjectionBefore(g,facts)).pending).toBe(false);
     await verifyManualProjection(g,facts,evidence);
     f.comments[0].body=body.replace(TARGET.name,'splrad/other');
     expect((await manualProjectionBefore(g,facts)).pending).toBe(true);
     await expect(verifyManualProjection(g,facts,evidence)).rejects.toThrow('MANUAL_COMMENT_BINDING');
   }else if(scenario==='valid'||scenario==='conditional v3')expect((await read()).identity).toEqual(manualIdentity(m,f.state,f.session));
   else await expect(read()).rejects.toThrow({ 'unrelated edit':'MANUAL_NOTE_SCOPE','unrelated head':'MANUAL_PUBLISHED_ANCESTRY',
     'undeclared notes':'MANUAL_NOTE_OWNER','wrong preview':'MANUAL_PROJECTION'}[scenario]);
 });
});

it('counts the entire UTF-8 status comment before choosing its archive link',()=>{
 const id=key('a'),header=candidateCommentHeader(id,sha('b'),[{id:'包',version:'1'}]);
 const available=48*1024-Buffer.byteLength(header);
 const preview='界'.repeat(Math.floor(available/3))+'x'.repeat(available%3);
 expect(Buffer.byteLength(header+preview)).toBe(48*1024);
 expect(formatPreviewBody(header,preview,id,TARGET.name,sha('c'))).toBe(header+preview);
 expect(formatPreviewBody(header,preview+'x',id,TARGET.name,sha('c'))).toContain('/blob/'+sha('c')+'/generated/'+id+'/preview.md');
});
