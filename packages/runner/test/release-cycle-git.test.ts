import { afterEach, expect, it } from 'vitest';
import { releaseProtectionFixture } from './fixtures/release-protection.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ghReleaseFixture } from './gh-release-fixture.js';
import { evidenceFixture, digest, zipResult, C, D, NOW } from './native-evidence-fixture.js';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { prepareChannelDispatch, channelTargetsDigest, channelEvidenceFile, dispatchObservationFile } from '../src/release-run.js';
import { inspectNativeCycle, nativeRunFact, jobFact } from '../src/native-release-evidence.js';
import { evaluateCompletion } from '../../core/src/release-observation.js';
const { writeReleaseRecords, readReleaseRecords, releaseCommand, readNativeCompletion, observeReleaseChannels, inspectRepositoryHistory, publicationAssetFacts } =
  await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const blob=(b:Buffer)=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

it('assigns valid collision-free metadata IDs and retains the original frozen IDs on reentry',async()=>{
  const f=await ghReleaseFixture(),manifest=structuredClone(f.target.manifest);manifest.artifacts[0]!.id='metadata-sha256sums';
  const assets=await publicationAssetFacts({assets:[]},manifest,f.adapter.names(f.target),f.target.directory);
  expect(new Set(assets.map((a:any)=>a.id)).size).toBe(7);expect(assets.every((a:any)=>/^[a-z][a-z0-9-]*$/.test(a.id))).toBe(true);
  expect(assets.find((a:any)=>a.path==='SHA256SUMS').id).toBe('metadata-sha256sums-1');
  assets.find((a:any)=>a.path==='SHA256SUMS').id='original-checksums';
  expect(await publicationAssetFacts({assets},manifest,f.adapter.names(f.target),f.target.directory)).toEqual(assets);
});

it('publishes seven bytesets, waits for both channels, recovers protected consumption and opens the next-candidate gate',async()=>{
  const root=await mkdtemp(join(tmpdir(),'release-cycle-git-'));roots.push(root);registerOfflineFixtureRoot(root);
  const seed=join(root,'seed'),remote=join(root,'remote.git');await mkdir(seed);
  const identity={name:'Offline cycle',email:'cycle@example.invalid'},env=isolatedBuildEnvironment(process.env,root);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:seed,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=main');await git('config','user.name',identity.name);await git('config','user.email',identity.email);
  await writeFile(join(seed,'README.md'),'Before adopted boundary\n');await git('add','.');await git('commit','--signoff','-m','Initial source');const B=await git('rev-parse','HEAD');
  const delivery={schemaVersion:1,repositoryAuthors:[{id:7,evidence:'Explicit fixture author'}],units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',
    assets:['app','dll','fonts'].map((id,i)=>({id,name:['app.exe','dll.zip','fonts.zip'][i],mediaType:'application/octet-stream'})),
    channels:[{id:'ghcr-assets',required:true,location:'ghcr.io/fixture/product'},{id:'winget',required:true,location:'Fixture.Product'}]}]};
  const deliveryBytes=Buffer.from(JSON.stringify(delivery,null,2)+'\n');await mkdir(join(seed,'.github'));await writeFile(join(seed,'.github/delivery.json'),deliveryBytes);
  await writeFile(join(seed,'release-please-config.json'),JSON.stringify({'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}}));
  await writeFile(join(seed,'.release-please-manifest.json'),'{".":"1.2.3"}');await writeFile(join(seed,'VERSION'),'1.2.3\n');
  await mkdir(join(seed,'.github/workflows'));
  await writeFile(join(seed,'.github/workflows/steward-release-publish.yml'),'name: Fixture publish\n');
  await writeFile(join(seed,'.github/workflows/steward-release-channels.yml'),'name: Fixture channels\n');
  await writeFile(join(seed,'.github/release-template.md.mustache'),'Fixture template\n');
  await git('add','.');await git('commit','--signoff','-m','Adopted product source');const A=await git('rev-parse','HEAD');
  await writeFile(join(seed,'README.md'),'Candidate reviewed source\n');await git('add','.');await git('commit','--signoff','-m','Merge release candidate');const S=await git('rev-parse','HEAD');
  await git('init','--bare',remote);await git('push','--porcelain',remote,'HEAD:refs/heads/main');
  const f=await ghReleaseFixture(S),native=evidenceFixture(),cycle=native.context.cycle,unit=cycle.units[0]!;
  Object.assign(cycle,{id:`pr-2-${S}`,prNumber:2,sourceSha:S,deliveryConfigSha:blob(deliveryBytes),dispatches:[],requiredChannels:delivery.units[0]!.channels.map(c=>({unitId:'app',channelId:c.id}))});
  native.context.repository='fixture/product';
  const assets=await Promise.all(f.adapter.names(f.target).map(async path=>{const bytes=await readFile(join(f.target.directory,path));return {id:f.target.manifest.artifacts.find(a=>a.path===path)?.id??'metadata-'+path.toLowerCase().replaceAll('.','-'),path,size:bytes.length,sha256:digest(bytes)};}));
  Object.assign(unit,{version:'1.2.3',tag:'v1.2.3',releaseId:20,assets,manifestDigest:assets.find(a=>a.path==='artifact-manifest.json')!.sha256,notesDigest:assets.find(a=>a.path==='release-notes.md')!.sha256});
  const state={schemaVersion:3,releaseAdoption:{sourceSha:A,prNumber:1},repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:S,lastCompletedCycleId:null,activeCycleId:cycle.id,
    candidate:{id:'e'.repeat(64),prNumber:2,branch:'steward/release-candidate',baseSha:B,generatedSnapshotPath:null,publishedHead:S,editingAckHead:null,statusCommentId:null,contentGenerationDigest:digest('candidate'),adoptionOverride:null,observedLabelEventIds:[],pendingWrite:null},nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
  const file=(path:string,value:unknown)=>{const content=JSON.stringify(value)+'\n';return {path,content,sha256:digest(content),previousSha256:null};};
  const initial=[file('state.json',state),file(`cycles/${cycle.id}.json`,cycle)];
  await writeReleaseRecords({directory:join(root,'initial'),remote,repositoryId:1,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',expectedHead:null,allowedPaths:initial.map(f=>f.path),changes:initial,identity});
  const input={directory:remote,writeDirectory:join(root,'writes'),remote,repository:'fixture/product',repositoryId:1,defaultBranch:'main',appBotId:42,cycleId:cycle.id,runId:null,identity};
  const read=()=>readReleaseRecords({directory:remote,targetRef:'steward/release-state',repositoryId:1});
  let now=NOW,merged=false,registry=false,probe:any=null;const runs=new Map<number,any>(),jobs=new Map<number,any[]>(),logs=new Map<number,string>(),artifactObjects=new Map<number,{bytes:Buffer;raw:any}>();
  const pr={id:2002,number:2,merged:true,merged_at:NOW,merge_commit_sha:S,user:{id:42},head:{ref:'steward/release-candidate',repo:{id:1}},base:{ref:'main',repo:{id:1}}};
  const workflow=await readFile('templates/release/steward-release-channels.yml'),sourceWorkflow=Buffer.from(`jobs:\n  verify:\n    steps:\n      - uses: actions/checkout@${D}\n        with:\n          repository: splrad/steward\n          ref: ${C}\n`);
  const response=native.response;
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path.endsWith('/product'))return response({id:1,full_name:'fixture/product',default_branch:'main',archived:false,disabled:false,private:false});
    if(releaseProtectionFixture(path))return response(releaseProtectionFixture(path));
    if(path.endsWith('/git/ref/heads/steward/release-state'))return response({object:{sha:await git('-C',remote,'rev-parse','refs/heads/steward/release-state')}});
    if(path.includes('/git/blobs/')){const content=await git('-C',remote,'cat-file','blob',path.split('/').at(-1)!);return response({content:Buffer.from(content+'\n').toString('base64')});}
    if(path.includes('/commits/')&&path.includes('/pulls'))return response([pr]);
    if(path.includes('/commits/'))return response({sha:S});
    if(path.includes('/pulls?'))return response([pr]);if(path.endsWith('/pulls/2'))return response(pr);
    if(path.endsWith('/pulls/1'))return response({...pr,number:1,merge_commit_sha:A,head:{...pr.head,ref:'onboarding'}});
    if(path.endsWith('/pulls/33'))return response({number:33,state:merged?'closed':'open',merged,head:{ref:'steward/Fixture.Product/1.2.3'},base:{repo:{full_name:'microsoft/winget-pkgs'}}});
    if(path.includes('/contents/')){const b=path.includes('delivery.json')?deliveryBytes:path.includes('ref='+S)?workflow:sourceWorkflow;return response({type:'file',encoding:'base64',content:b.toString('base64'),size:b.length,sha:blob(b)});}
    if(path.includes('/actions/workflows/')&&!path.includes('/runs'))return response({id:10,path:'.github/workflows/steward-release-channels.yml',state:'active'});
    if(path.includes('/workflows/10/runs?'))return response({total_count:probe?1:0,workflow_runs:probe?[probe]:[]});
    const runMatch=/\/actions\/runs\/(\d+)(.*)$/.exec(path);if(runMatch){const id=Number(runMatch[1]),tail=runMatch[2]!;
      if(tail.includes('/artifacts'))return response({total_count:0,artifacts:[]});
      if(tail.includes('/jobs'))return response({total_count:jobs.get(id)!.length,jobs:jobs.get(id)});return response(runs.get(id));}
    const logMatch=/\/jobs\/(\d+)\/logs$/.exec(path);if(logMatch)return response(logs.get(Number(logMatch[1]))!);
    const artifactMatch=/\/actions\/artifacts\/(\d+)(\/zip)?$/.exec(path);if(artifactMatch){const a=artifactObjects.get(Number(artifactMatch[1]))!;return artifactMatch[2]?{status:200,headers:new Headers(),bytes:a.bytes}:response(a.raw);}
    const assetMatch=/\/releases\/assets\/(\d+)$/.exec(path);if(assetMatch){const a=[...f.remote.values()].find(a=>a.id===Number(assetMatch[1]))!;return {status:200,headers:new Headers(),bytes:a.bytes};}
    if(path.includes('/releases/20/assets?'))return response([...f.remote].map(([name,a])=>({id:a.id,name,size:a.bytes.length,state:'uploaded'})));
    if(path.endsWith('/releases/20'))return response(f.release);
    throw Error('unhandled cycle native read '+path);
  },anonymous:()=>({request:io.request})};
  const centralRun={id:900,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,path:'.github/workflows/release.yml',event:'schedule',head_sha:C,head_branch:'main',actor:{id:81},triggering_actor:{id:81},run_attempt:1,status:'in_progress',conclusion:null as string|null,created_at:NOW,updated_at:NOW,display_title:'Release'};
  const centralJob={id:901,run_id:900,run_attempt:1,head_sha:C,name:'release-coordinator',status:'in_progress',conclusion:null as string|null,started_at:NOW,completed_at:null as string|null,steps:[{number:3,name:'business-release-coordinator',started_at:NOW,completed_at:null as string|null,conclusion:null as string|null}]};
  const centralIo={request:async(method:string,path:string)=>{expect(method).toBe('GET');if(path.endsWith('/steward'))return response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});if(path.includes('/workflows/20'))return response({id:20,path:centralRun.path});if(path.includes('/jobs?'))return response({total_count:1,jobs:[centralJob]});return response(centralRun);}};
  const options={io,centralIo,now:()=>now,centralInvocation:{runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'}};
  f.state.loseUpload=f.state.loseBody=f.state.losePublish=true;
  const published=await releaseCommand('publish',input,{...options,publisher:async()=>{
    expect((await read()).domainRecords.some((r:any)=>r.path.startsWith('evidence/publication/')&&r.value.startEvidencePath===null)).toBe(true);
    await f.adapter.publish(f.target);
  }});
  expect(published).toMatchObject({status:'OBSERVED',publishInvoked:true});expect(f.remote.size).toBe(7);
  Object.assign(centralRun,{status:'completed',conclusion:'success',updated_at:NOW});Object.assign(centralJob,{status:'completed',conclusion:'success',completed_at:NOW});Object.assign(centralJob.steps[0]!,{conclusion:'success',completed_at:NOW});
  // Submission is a native external fact; it cannot stand in for acceptance, indexing or consumption.
  const fact={unitId:'app',channelId:'winget',nativeObjectId:'33',nativeUrl:'https://github.com/microsoft/winget-pkgs/pull/33',inputDigest:channelTargetsDigest(native.context,[{unitId:'app',channelId:'winget',version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}]),submittedAt:NOW,acceptedAt:null,indexedAt:null,verificationRunId:null,verifiedEvidencePath:null,observedAt:NOW,nextCheckAt:null};
  async function adopt(values:{path:string;content:string;sha256:string}[]) {
    const snapshot=await read(),changes=values.map(v=>({...v,previousSha256:snapshot.history.find((r:any)=>r.path===v.path&&r.status==='DECODED')?digest(snapshot.domainRecords.find((r:any)=>r.path===v.path)?.content??JSON.stringify(snapshot.cycles[0].value)+'\n'):null}));
    // Exact current tree bytes, including formatting, govern updates.
    for(const change of changes)if(change.previousSha256!==null)change.previousSha256=digest(await promisify(execFile)('git',['-C',remote,'show',`refs/heads/steward/release-state:${change.path}`],{env,encoding:'buffer',windowsHide:true}).then(r=>r.stdout));
    const saved=await writeReleaseRecords({directory:join(root,'adopt-'+digest(JSON.stringify(changes))),remote,repositoryId:1,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:changes.map(c=>c.path),changes,identity});expect(saved.status).toBe('APPLIED');
  }
  let current=(await read()).cycles[0].value;current.channelFacts=[fact];await adopt([file(`cycles/${cycle.id}.json`,current)]);
  const oras=async(args:readonly string[])=>JSON.stringify(args[0]==='repo'?{name:'fixture/product',tags:registry?['1.2.3']:[]}:{digest:'sha256:'+'a'.repeat(64),size:100});
  const waiting=await observeReleaseChannels(input,{...options,controllerDirectory:process.cwd(),oras});
  await readNativeCompletion(input,(await read()).cycles[0].value,options);expect(waiting).toMatchObject({status:'OBSERVED',reason:'MAIN_RELEASE_VERIFIED',completion:{result:'PASS',distributionResult:'WAIT'}});
  expect((await read()).cycles[0].value.completedEvidencePath).toMatch(/^evidence\/completion\//);
  now='2026-11-26T00:02:00.000Z';
  expect(await observeReleaseChannels(input,{...options,controllerDirectory:process.cwd(),oras})).toMatchObject({status:'OBSERVED',reason:'MAIN_RELEASE_VERIFIED'});
  current=(await read()).cycles[0].value;const context={...native.context,cycle:current};
  const main=await readNativeCompletion(input,current,options);expect(evaluateCompletion(main.source,main.observation,now).result).toBe('PASS');
  now='2026-11-26T00:04:00.000Z';
  const targets=current.requiredChannels.map((c:any)=>({...c,version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest}));
  const request=prepareChannelDispatch(context,10,'main',S,'verify',targets,'2026-11-26T00:03:00.000Z');request.canonicalRunId=201;current.dispatches.push(request);
  const start='2026-11-26T00:03:00.000Z';
  const run={...native.runs.get(1),id:201,workflow_id:10,path:'.github/workflows/steward-release-channels.yml',head_sha:S,head_branch:'main',display_title:request.requestKey,created_at:start,updated_at:now,conclusion:'success'};runs.set(201,run);
  const dispatchProof=dispatchObservationFile({schemaVersion:1,repositoryId:1,cycleId:cycle.id,requestKey:request.requestKey,observedAt:now,kind:'RESPONSE',senderNonce:null,status:200,
    response:{workflow_run_id:201,run_url:'https://api.github.com/repos/fixture/product/actions/runs/201',html_url:'https://github.com/fixture/product/actions/runs/201'},
    run:nativeRunFact(run),window:null,pages:[],matches:[],errorCode:null,nextCheckAt:null});
  request.nativeResponseEvidencePath=dispatchProof.path;const evidenceFiles=[dispatchProof];
  await adopt([file(`cycles/${cycle.id}.json`,current),dispatchProof]);
  Object.assign(run,{status:'in_progress',conclusion:null});
  const duringChannel=await readNativeCompletion(input,current,options);
  expect(evaluateCompletion(duringChannel.source,duringChannel.observation,now)).toMatchObject({result:'PASS',distributionResult:'WAIT'});
  Object.assign(run,{status:'completed',conclusion:'success'});

  for(let i=0;i<targets.length;i++) {
    const target=targets[i],job={...native.jobs.get(1)![0],id:501+i,run_id:201,head_sha:S,name:`verify/${target.channelId}/app`,conclusion:'success',started_at:start,completed_at:now,steps:[{number:2,name:'business-channel',started_at:start,completed_at:now,conclusion:'success'}]};
    jobs.set(201,[...(jobs.get(201)??[]),job]);
    const payload={schemaVersion:1,cycleId:cycle.id,sourceSha:S,executionSha:S,controllerSha:C,targetsDigest:channelTargetsDigest(context,targets),nativeRunId:201,runAttempt:1,
      items:[{...target,nativeObjectId:i===0?'sha256:'+'a'.repeat(64):'33',digest:unit.manifestDigest,accepted:true,indexed:true,consumed:true,observedAt:now}]};
    const bytes=zipResult(payload,'report.json'),id=701+i;artifactObjects.set(id,{bytes,raw:{id,workflow_run:{id:201,head_sha:S},expired:false,digest:'sha256:'+digest(bytes)}});
    const execution={...native.results.get(1)!.execution,cycleId:cycle.id,runId:201,jobId:job.id,entry:'channel',channelId:target.channelId,inputDigest:request.inputDigest,startedAt:start,completedAt:now,observedAt:now,outcome:'EFFECT_CONFIRMED',
      invocationKey:digest(JSON.stringify([1,cycle.id,10,201,1,'channel',job.id,2,'app',target.channelId,request.inputDigest]))};
    logs.set(job.id,`${now} STEWARD_RESULT ${JSON.stringify({schemaVersion:1,sourceSha:S,executionSha:S,stepNumber:2,reasonCode:'RESULT',execution,objects:[{kind:'artifact',id,digest:digest(bytes)}]})}\n`);
    evidenceFiles.push(channelEvidenceFile({schemaVersion:1,repositoryId:1,cycleId:cycle.id,sourceSha:S,observedAt:now,kind:'RESULT',run:nativeRunFact(run),job:jobFact(job),artifact:{id,name:`channel-${request.requestKey}-app-${target.channelId}-201-1`,digest:'sha256:'+digest(bytes),createdAt:now},payload:JSON.stringify(payload)}));
  }
  // Windows index evidence is scoped to its unreadable target; GHCR remains a central native GET.
  const winget=[targets[1]],key=channelTargetsDigest(context,winget);probe={...run,id:202,display_title:digest(JSON.stringify(['observe',key,S]))};
  const probeJob={...jobs.get(201)![1],id:601,run_id:202,name:'observe',steps:[]};
  const payload={schemaVersion:1,cycleId:cycle.id,sourceSha:S,executionSha:S,controllerSha:C,targetsDigest:key,nativeRunId:202,runAttempt:1,items:[{unitId:'app',channelId:'winget',version:unit.version,readStatus:'OK',exists:true,digest:null,accepted:true,indexed:true,observedAt:now,evidenceKind:'github-pr:33'}]};
  evidenceFiles.push(channelEvidenceFile({schemaVersion:1,repositoryId:1,cycleId:cycle.id,sourceSha:S,observedAt:now,kind:'PROBE',run:nativeRunFact(probe),job:jobFact(probeJob),artifact:{id:800,name:'probe',digest:'sha256:'+digest('probe'),createdAt:now},payload:JSON.stringify(payload)}));
  await adopt([file(`cycles/${cycle.id}.json`,current),...evidenceFiles]);merged=true;registry=true;
  expect(await observeReleaseChannels(input,{...options,controllerDirectory:process.cwd(),oras})).toMatchObject({status:'OBSERVED',reason:'DISTRIBUTION_VERIFIED'});
  const completed=await read();expect(completed.cycles[0].value.completedEvidencePath).toMatch(/^evidence\/completion\//);
  const fresh=await readNativeCompletion(input,completed.cycles[0].value,options);expect(evaluateCompletion(fresh.source,fresh.observation,now).result).toBe('PASS');
  expect(fresh.observation.consumptions).toHaveLength(2);expect(fresh.provenance.some((p:any)=>p.path.startsWith('evidence/channel-read/'))).toBe(true);
  await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state');await git('checkout','--detach','FETCH_HEAD');
  await git('rm','-r','--','evidence');await git('commit','--signoff','-m','Offline current evidence cache loss');await git('push','--porcelain',remote,'HEAD:refs/heads/steward/release-state');
  const recovered=await read();expect(recovered.domainRecords.filter((r:any)=>r.path.startsWith('evidence/')).length).toBeGreaterThan(6);
  expect(await inspectRepositoryHistory(input,{...options,completionReader:(value:any)=>readNativeCompletion(input,value,options)})).toMatchObject({result:'PASS',inventoryComplete:true,lastCompletedCycleId:cycle.id});
  const closed=await read();expect(closed.repository).toMatchObject({activeCycleId:null,candidate:null,lastCompletedCycleId:cycle.id});
  // The candidate checkout still holds the pre-completion state. The native
  // adapter must refresh it, then adopt the next ordinary candidate identity.
  await git('-C',remote,'update-ref','refs/tags/v1.2.3',S);
  const {nativeReleaseCandidate}=await import(pathToFileURL(resolve('scripts/release-candidate.mjs')).href);
  let generations=0;
  const fetcher=(async(input:any,init:any)=>{
    expect(init.method).toBe('GET');const path=decodeURIComponent(new URL(String(input)).pathname);let value:any;
    if(path.includes('/git/ref/heads/')){const branch=path.split('/git/ref/heads/')[1]!;let sha;try{sha=await git('-C',remote,'rev-parse','--verify',`refs/heads/${branch}`);}catch{return new Response('{}',{status:404});}value={ref:`refs/heads/${branch}`,object:{type:'commit',sha}};}
    else if(path.endsWith('/rules/branches/main'))value=[{type:'non_fast_forward'},{type:'deletion'}];
    else if(path.endsWith('/rulesets'))value=[{id:6,target:'tag',enforcement:'active'}];
    else if(path.endsWith('/rulesets/6'))value={id:6,target:'tag',enforcement:'active',conditions:{ref_name:{include:['~ALL'],exclude:[]}},rules:[{type:'deletion'},{type:'non_fast_forward'}]};
    else if(path.endsWith('/releases'))value=[f.release];
    else if(path.endsWith('/releases/tags/'+unit.tag))value=f.release;
    else if(path.endsWith('/tags'))value=[{name:unit.tag,commit:{sha:S}}];
    else if(path.endsWith('/git/ref/tags/'+unit.tag))value={ref:'refs/tags/'+unit.tag,object:{type:'commit',sha:S}};
    else if(path.endsWith('/actions/workflows'))value={total_count:0,workflows:[]};
    else if(path.endsWith('/pulls'))value=[];
    else {const result=await io.request('GET',path);return new Response(Buffer.from(result.bytes).toString('utf8'),{status:result.status});}
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
  expect(await nativeReleaseCandidate({...input,directory:seed,writeDirectory:join(root,'next-candidate')},{token:'fixture-write',readToken:'fixture-read',controllerSha:C,fetcher,temporaryRoot:root,now:()=>now,
    generator:async(request:any)=>{generations++;expect(request.facts.releases[0]).toMatchObject({id:20,sha:S,draft:false});return {status:'UNCHANGED'};}})).toMatchObject({status:'WAIT',reason:'UNCHANGED'});
  expect(generations).toBe(1);const next=await read();expect(next.repository.candidate.id).not.toBe(state.candidate.id);
  expect(next.repository).toMatchObject({activeCycleId:null,lastCompletedCycleId:cycle.id,candidate:{prNumber:null,baseSha:S}});
  // Reobserving completed history must preserve the next candidate and its
  // original draft/session identity, including before its PR-create response.
  const reobserved=await inspectRepositoryHistory(input,{...options,completionReader:(value:any)=>readNativeCompletion(input,value,options)});
  expect(reobserved,JSON.stringify(reobserved)).toMatchObject({result:'PASS'});
  expect((await read()).repository.candidate).toEqual(next.repository.candidate);
},process.platform==='win32'?360_000:150_000);
