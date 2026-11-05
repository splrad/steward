import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerOfflineFixtureRoot, permitOfflineCommand } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { evidenceFixture, digest, NOW } from './native-evidence-fixture.js';
import { archiveFile, inspectNativeCycle } from '../src/native-release-evidence.js';
import { prepareChannelDispatch } from '../src/release-run.js';
import { releaseProtectionFixture } from './fixtures/release-protection.js';

vi.setConfig({testTimeout:30_000});
const {writeReleaseRecords,readReleaseRecords,inspectReleaseEvidence,releaseCommand}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function gitFixture(unbound=false,configure?:(native:ReturnType<typeof evidenceFixture>)=>void) {
  const root=await mkdtemp(join(tmpdir(),'native-evidence-git-'));roots.push(root);registerOfflineFixtureRoot(root);
  const seed=join(root,'seed'),remote=join(root,'remote.git'),profile=join(root,'profile');await mkdir(seed);await mkdir(profile);
  const identity={name:'Offline Evidence',email:'evidence@example.invalid'},env=isolatedBuildEnvironment(process.env,profile);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:seed,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=main');await git('config','user.name',identity.name);await git('config','user.email',identity.email);
  await writeFile(join(seed,'README.md'),'Offline evidence fixture\n');await git('add','--','README.md');await git('commit','--signoff','-m','Offline source');
  await git('init','--bare',remote);await git('push','--porcelain',remote,'HEAD:refs/heads/main');
  const native=evidenceFixture(),state={schemaVersion:3,releaseAdoption:{sourceSha:'a'.repeat(40),prNumber:1},repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:native.context.cycle.id,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
  configure?.(native);
  if(unbound){native.context.cycle.dispatches[0]!.canonicalRunId=null;native.context.cycle.dispatches[0]!.nativeResponseEvidencePath=null;}
  const file=(path:string,value:unknown)=>{const content=JSON.stringify(value)+'\n';return {path,content,sha256:digest(content),previousSha256:null};};
  const changes=[file('state.json',state),file(`cycles/${native.context.cycle.id}.json`,native.context.cycle)];
  const initial=await writeReleaseRecords({directory:join(root,'initial'),remote,repositoryId:1,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',expectedHead:null,allowedPaths:changes.map(file=>file.path),changes,identity});
  expect(initial.status).toBe('APPLIED');
  const input={directory:join(root,'initial'),writeDirectory:join(root,'archives'),remote,repository:'example/product',repositoryId:1,defaultBranch:'main',appBotId:42,cycleId:native.context.cycle.id,runId:null as number|null,identity};
  const transport=native.io.request;
  native.io.request=async(method,path,limit)=>{
    if(method==='GET'&&path==='/repos/example/product/git/ref/heads/steward/release-state'&&!native.overrides.has('GET '+path)) {
      const raw=await git('ls-remote','--heads','--refs',remote,'refs/heads/steward/release-state');
      return native.response({object:{sha:raw.split('\t')[0]}});
    }
    return transport(method,path,limit);
  };
  return {root,remote,git,native,input,initial,file};
}
it.each([false,true])('adopts zero-business source rejection before reselecting the complete channel request at new R; lost response=%s',async lost=>{
  const oldR='d'.repeat(40),newR='e'.repeat(40);
  const f=await gitFixture(false,native=>{
    const unit=native.context.cycle.units[0]!;Object.assign(unit,{releaseId:20,manifestDigest:digest('manifest'),notesDigest:digest('notes'),assets:[{id:'app',path:'app.zip',size:1,sha256:digest('f')}]});
    native.context.cycle.requiredChannels=[{unitId:'app',channelId:'winget'}];
    native.context.cycle.dispatches=[prepareChannelDispatch(native.context,10,'main',oldR,'submit',[{unitId:'app',channelId:'winget',version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}],NOW)];
  });
  const original=f.native.io.request,request=f.native.context.cycle.dispatches[0]!,later='2026-10-26T00:05:00.000Z';
  const workflow='run-name: Channels ${{ inputs.request_key }}\non:\n  workflow_dispatch:\n    inputs:\n'+Object.keys(request.inputs).map(key=>`      ${key}: {type: string, required: true}\n`).join('');
  const bytes=Buffer.from(workflow),sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const run={...f.native.runs.get(1),path:'.github/workflows/steward-release-channels.yml',head_sha:newR,head_branch:'main',display_title:request.requestKey,created_at:NOW,updated_at:later};
  const job={...f.native.jobs.get(1)![0],head_sha:newR,name:'source-check',started_at:NOW,completed_at:later,steps:[]};let sent:any=null;
  f.native.io.request=async(method,path,limit,body)=>{
    if(releaseProtectionFixture(path))return f.native.response(releaseProtectionFixture(path));
    if(path.endsWith('/releases/20'))return f.native.response({id:20,tag_name:'v1.0.0',author:{id:42},body:'notes',draft:false,immutable:true});
    if(path.includes('/releases/20/assets?'))return f.native.response([{id:51,name:'app.zip',size:1}]);
    if(path.endsWith('/releases/assets/51'))return f.native.response('f');
    if(path.endsWith('/commits/v1.0.0'))return f.native.response({sha:f.native.context.cycle.sourceSha});
    if(path.endsWith('/commits/main'))return f.native.response({sha:newR});
    if(path.includes('/workflows/10/runs?'))return f.native.response({total_count:1,workflow_runs:sent?[{...run,id:200,created_at:later,status:'queued',conclusion:null,display_title:sent.inputs.request_key}]:[run]});
    if(path.endsWith('/runs/100'))return f.native.response(run);
    if(path.endsWith('/attempts/1/jobs?per_page=100'))return f.native.response({total_count:1,jobs:[job]});
    if(path.endsWith('/jobs/1000/logs'))return f.native.response(`${later} STEWARD_SOURCE_REJECTED {"status":"REJECTED","reason":"SOURCE_REF_MOVED"}\n`);
    if(path.includes('/contents/'))return f.native.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha});
    if(path.endsWith('/workflows/10'))return f.native.response({id:10,path:run.path,state:'active'});
    if(path.endsWith('/git/ref/heads/main'))return f.native.response({ref:'refs/heads/main',object:{type:'commit',sha:newR}});
    if(method==='POST') {
      const saved=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
      expect(saved.domainRecords.some((record:any)=>record.path.startsWith('evidence/source-rejection/'))).toBe(true);
      sent=body;if(lost)throw Error('fixture response lost');return f.native.response({workflow_run_id:200,run_url:'https://api.github.com/repos/example/product/actions/runs/200',html_url:'https://github.com/example/product/actions/runs/200'});
    }
    if(path.endsWith('/runs/200'))return f.native.response({...run,id:200,created_at:later,status:'queued',conclusion:null,display_title:sent.inputs.request_key});
    return original(method,path,limit,body);
  };
  let result=await releaseCommand('dispatch-channel',f.input,{io:f.native.io,now:()=>later});
  if(lost){expect(result).toMatchObject({status:'UNKNOWN',reason:'DISPATCH_RESPONSE_LOST'});const raw=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});expect(raw.repository.lastErrorCode).toBe('dispatch-response-lost');result=await releaseCommand('dispatch-channel',{...f.input,directory:f.remote},{io:f.native.io,now:()=> '2026-10-26T00:11:00.000Z'});}
  expect(result).toMatchObject({status:'BOUND',canonicalRunId:200});
  const saved=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(saved.cycles[0].value.dispatches).toHaveLength(2);expect(saved.cycles[0].value.dispatches[0]).toEqual(request);
  expect(saved.cycles[0].value.dispatches[1]).toMatchObject({executionSha:newR,sourceSha:request.sourceSha,canonicalRunId:200});
  expect(sent.inputs.targets_json).toBe(request.inputs.targets_json);
},120_000);
it('connects native inspection to a real fast-forward Git archive and keeps the original cycle unchanged',async()=>{
  const f=await gitFixture();const result=await inspectReleaseEvidence(f.input,{io:f.native.io});
  expect(result.status).toBe('OBSERVED');expect(result.archiveHead).not.toBe(f.initial.head);
  const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(readback.head).toBe(result.archiveHead);expect(readback.domainRecords).toHaveLength(2);expect(readback.cycles[0].value).toEqual(f.native.context.cycle);
  expect(await f.git('-C',f.remote,'show','-s','--format=%P',result.archiveHead)).toBe(f.initial.head);
  expect(f.native.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('the built fixed CLI reaches the real Git bridge without depending on an emitted ncc asset',async()=>{
  const f=await gitFixture(),context=join(f.root,'context.json'),output=join(f.root,'output.json');await writeFile(context,JSON.stringify(f.input));
  const args=[resolve('packages/runner/dist/index.js'),'release','candidate','--context',context,'--output',output];permitOfflineCommand(process.execPath,args);
  await promisify(execFile)(process.execPath,args,{cwd:process.cwd(),env:isolatedBuildEnvironment(process.env,join(f.root,'profile')),windowsHide:true});
  expect(JSON.parse(await readFile(output,'utf8'))).toMatchObject({status:'WAIT',reason:'CANDIDATE_SCOPED_READ_CREDENTIAL_REQUIRED'});
});
it.each([false,true])('persists canonical dispatch through real fast-forward commits without a duplicate send; concurrent=%s',async concurrent=>{
  const f=await gitFixture(true),original=f.native.io.request;let sends=0;
  const workflow='run-name: Build ${{ inputs.operation_key }}\non:\n  workflow_dispatch:\n    inputs:\n'+['cycle_id','operation_key','source_sha','controller_sha'].map(key=>`      ${key}: {type: string, required: true}\n`).join('');
  const bytes=Buffer.from(workflow),sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  f.native.io.request=async(method,path,limit,body)=>{
    if(releaseProtectionFixture(path))return f.native.response(releaseProtectionFixture(path));
    if(path.includes('/contents/'))return f.native.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha});
    if(path.endsWith('/actions/workflows/10'))return f.native.response({id:10,path:'.github/workflows/steward-release-publish.yml',state:'active'});
    if(path.includes('/git/ref/heads/steward/build/'))return f.native.response({ref:`refs/heads/${f.native.request.ref}`,object:{type:'commit',sha:f.native.context.cycle.sourceSha}});
    if(method==='POST') {
      sends++;const saved=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
      expect(saved.domainRecords.some((record:any)=>record.value.kind==='PREPARED')).toBe(true);expect(saved.cycles[0].value.dispatches[0].canonicalRunId).toBeNull();
      expect(body).toEqual({ref:f.native.request.ref,inputs:f.native.request.inputs});
      return f.native.response({workflow_run_id:100,run_url:'https://api.github.com/repos/example/product/actions/runs/100',html_url:'https://github.com/example/product/actions/runs/100'});
    }
    return original(method,path,limit,body);
  };
  if(concurrent) {
    await Promise.allSettled([releaseCommand('dispatch-build',f.input,{io:f.native.io,now:()=>NOW}),releaseCommand('dispatch-build',f.input,{io:f.native.io,now:()=>NOW})]);
    expect(sends).toBeLessThanOrEqual(1);
    const persisted=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
    expect(persisted.domainRecords.filter((record:any)=>record.value.kind==='PREPARED').length).toBeGreaterThanOrEqual(1);
    return;
  }
  const result=await releaseCommand('dispatch-build',f.input,{io:f.native.io,now:()=>NOW});expect(result.status).toBe('BOUND');
  const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(readback.cycles[0].value.dispatches[0].canonicalRunId).toBe(100);expect(readback.domainRecords).toHaveLength(3);
  expect(await releaseCommand('dispatch-build',{...f.input,directory:f.remote},{io:f.native.io,now:()=>NOW})).toMatchObject({status:'BOUND'});expect(sends).toBe(1);
},60_000);
it('keeps the archived snapshot and Git object directory paired when saving a native Release binding',async()=>{
  const f=await gitFixture(false,native=>Object.assign(native.context.cycle.units[0]!,{manifestDigest:digest('manifest'),notesDigest:digest('notes'),
    assets:[{id:'app',path:'app.zip',size:1,sha256:digest('f')}]}));
  f.native.overrides.set('GET /repos/example/product/releases/tags/v1.0.0',f.native.response({},404));
  f.native.overrides.set('GET /repos/example/product/releases?per_page=100',f.native.response([]));
  const sha=f.native.context.cycle.controllerSha,run={id:900,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,path:'.github/workflows/release.yml',event:'schedule',
    head_sha:sha,head_branch:'main',actor:{id:81},triggering_actor:{id:81},run_attempt:1,status:'in_progress',conclusion:null,created_at:NOW,updated_at:NOW,display_title:'Release'};
  const job={id:901,run_id:900,run_attempt:1,head_sha:sha,name:'release-coordinator',status:'in_progress',conclusion:null,started_at:NOW,completed_at:null,
    steps:[{number:3,name:'business-release-coordinator',started_at:NOW,completed_at:null,conclusion:null}]};
  const centralIo={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path==='/repos/splrad/steward')return f.native.response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/workflows/20'))return f.native.response({id:20,path:run.path});
    if(path.endsWith('/jobs?per_page=100'))return f.native.response({total_count:1,jobs:[job]});
    if(path.includes('/actions/runs/900'))return f.native.response(run);throw Error('unexpected central source');
  }};
  const transport=f.native.io.request;
  f.native.io.request=async(method,path,limit,body)=>releaseProtectionFixture(path)
    ?f.native.response(releaseProtectionFixture(path)):transport(method,path,limit,body);
  let saved=false,saveError:unknown,archivedHead:string|undefined;
  await inspectReleaseEvidence(f.input,{io:f.native.io,centralIo,centralInvocation:{runId:900,runAttempt:1,controllerSha:sha,defaultBranch:'main'},now:()=>NOW,
    publisher:async(context:any,save:(next:any)=>Promise<void>)=>{
      const archived=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
      archivedHead=archived.head;
      expect(archived.domainRecords.some((record:any)=>record.path.startsWith('evidence/publication/')&&record.value.startEvidencePath===null)).toBe(true);
      // Sharing the remote object database would mask the stale-directory defect.
      await expect(f.git('-C',f.input.directory,'cat-file','-e',archived.head)).rejects.toThrow();
      const next=structuredClone(context.cycle);next.units[0].releaseId=20;
      try {await save(next);saved=true;} catch(error) {saveError=error;throw error;}
    }});
  expect(saveError).toBeUndefined();expect(saved).toBe(true);
  const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(readback.cycles[0].value.units[0].releaseId).toBe(20);
  expect(readback.head).not.toBe(archivedHead);
  expect(await f.git('-C',f.remote,'merge-base','--is-ancestor',archivedHead!,readback.head)).toBe('');
},process.platform==='win32'?120_000:60_000);
it('the actual publication bridge adopts private BUSINESS_STARTED bytes before its publisher and blocks a repeated wake',async()=>{
  const f=await gitFixture(false,native=>Object.assign(native.context.cycle.units[0]!,{manifestDigest:digest('manifest'),notesDigest:digest('notes'),
    assets:[{id:'app',path:'app.zip',size:1,sha256:digest('f')}]}));
  f.native.overrides.set('GET /repos/example/product/releases/tags/v1.0.0',f.native.response({},404));
  f.native.overrides.set('GET /repos/example/product/releases?per_page=100',f.native.response([]));
  const sha=f.native.context.cycle.controllerSha,run={id:900,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,path:'.github/workflows/release.yml',event:'schedule',
    head_sha:sha,head_branch:'main',actor:{id:81},triggering_actor:{id:81},run_attempt:1,status:'in_progress',conclusion:null,created_at:NOW,updated_at:NOW,display_title:'Release'};
  const job={id:901,run_id:900,run_attempt:1,head_sha:sha,name:'release-coordinator',status:'in_progress',conclusion:null,started_at:NOW,completed_at:null,
    steps:[{number:3,name:'business-release-coordinator',started_at:NOW,completed_at:null,conclusion:null}]};
  const centralIo={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path==='/repos/splrad/steward')return f.native.response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/workflows/20'))return f.native.response({id:20,path:run.path});
    if(path.includes('/actions/runs/999'))return path.endsWith('/jobs?per_page=100')
      ?f.native.response({total_count:1,jobs:[{...job,id:902,run_id:999,status:'in_progress',conclusion:null,completed_at:null,steps:job.steps.map(step=>({...step,completed_at:null,conclusion:null}))}]})
      :f.native.response({...run,id:999,status:'in_progress',conclusion:null});
    if(path.endsWith('/jobs?per_page=100'))return f.native.response({total_count:1,jobs:[job]});
    if(path.includes('/actions/runs/900'))return f.native.response(run);throw Error('unexpected central source');
  }};
  let invoked=0;
  const options={io:f.native.io,centralIo,centralInvocation:{runId:900,runAttempt:1,controllerSha:sha,defaultBranch:'main'},now:()=>NOW,publisher:async()=>{
    const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
    const start=readback.domainRecords.find((record:any)=>record.path.startsWith('evidence/publication/')&&record.value.startEvidencePath===null);
    expect(start.value.execution).toMatchObject({businessStartedProven:true,outcome:null,runAttempt:1});invoked++;throw Error('lost publication response');
  }};
  const first=await releaseCommand('publish',f.input,options);expect(first.publishInvoked).toBe(true);expect(invoked).toBe(1);
  const second=await releaseCommand('publish',{...f.input,directory:f.remote},options);expect(second).toMatchObject({status:'WAIT',reason:'RUN_IN_FLIGHT',publishInvoked:false});expect(invoked).toBe(1);
  const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(readback.domainRecords.filter((record:any)=>record.path.startsWith('evidence/publication/')&&record.value.startEvidencePath===null)).toHaveLength(1);
  const nextCycle={...structuredClone(f.native.context.cycle),id:`pr-13-${'d'.repeat(40)}`,prNumber:13,sourceSha:'d'.repeat(40),dispatches:[],publications:[]};
  const nextFile=f.file(`cycles/${nextCycle.id}.json`,nextCycle);
  await writeReleaseRecords({directory:join(f.root,'next-cycle'),remote:f.remote,repositoryId:1,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',
    expectedHead:readback.head,allowedPaths:[nextFile.path],changes:[nextFile],identity:{name:'Offline Evidence',email:'evidence@example.invalid'}});
  const serialized=await releaseCommand('publish',{...f.input,directory:f.remote,cycleId:nextCycle.id},options);
  expect(serialized).toMatchObject({status:'WAIT',reason:'PUBLICATION_IN_FLIGHT',publishInvoked:false});expect(invoked).toBe(1);
  Object.assign(run,{status:'completed',conclusion:'failure'});Object.assign(job,{status:'completed',conclusion:'failure',completed_at:NOW});
  Object.assign(job.steps[0]!,{conclusion:'failure',completed_at:NOW});
  const failed=await releaseCommand('publish',{...f.input,directory:f.remote},{...options,centralInvocation:{...options.centralInvocation,runId:999}});
  expect(failed,JSON.stringify(failed)).toMatchObject({publishInvoked:true});expect(invoked).toBe(2);
  const resumed=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(resumed.domainRecords.some((record:any)=>record.path.startsWith('evidence/publication/')&&record.value.execution.runId===900&&record.value.execution.outcome==='BUSINESS_FAILED')).toBe(true);
  expect(resumed.domainRecords.filter((record:any)=>record.path.startsWith('evidence/publication/')&&record.value.startEvidencePath===null)).toHaveLength(2);

// This fixture performs multiple isolated Git publications and complete history
// readbacks. Windows process startup alone approached 60s in prior full runs.
},process.platform==='win32'?120_000:60_000);
it('only sends a rerun after actual archived Git bytes can be read from the remote ref',async()=>{
  const f=await gitFixture();f.input.runId=100;f.native.setAccepted();f.native.setThrowPost();
  const transport=f.native.io.request;let proved=false;
  f.native.io.request=async(method,path,limit)=>{
    if(method==='POST') {
      const snapshot=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
      expect(snapshot.domainRecords).toHaveLength(2);expect(snapshot.domainRecords.find((record:any)=>record.path.startsWith('evidence/native/')).value.run.runAttempt).toBe(1);proved=true;
    }
    return transport(method,path,limit);
  };
  const result=await inspectReleaseEvidence(f.input,{io:f.native.io});expect(result.status).toBe('ACCEPTED');expect(proved).toBe(true);
  expect(f.native.calls.filter(call=>call.startsWith('POST'))).toHaveLength(1);
});
it('recovers an original archive removed from the current tree through complete Git ancestors',async()=>{
  const f=await gitFixture();await inspectReleaseEvidence(f.input,{io:f.native.io});
  const read=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  await f.git('fetch','--no-tags','--no-recurse-submodules',f.remote,'refs/heads/steward/release-state');await f.git('checkout','--detach','FETCH_HEAD');
  const path=read.domainRecords[0].path;await f.git('rm','--',path);await f.git('commit','--signoff','-m','Offline archive cache loss');await f.git('push','--porcelain',f.remote,'HEAD:refs/heads/steward/release-state');
  const recovered=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  const original=recovered.domainRecords.find((record:any)=>record.path===path);
  expect(original.commit).toBe(read.head);expect(original.value).toEqual(read.domainRecords.find((record:any)=>record.path===path).value);
});
it('rejects stale native state before writing an archive or attempting a rerun',async()=>{
  const f=await gitFixture();f.native.overrides.set('GET /repos/example/product/git/ref/heads/steward/release-state',f.native.response({object:{sha:'d'.repeat(40)}}));
  await expect(inspectReleaseEvidence(f.input,{io:f.native.io})).rejects.toThrow('state snapshot must match native ref');
  expect(f.native.calls.filter(call=>call.startsWith('POST'))).toHaveLength(0);
});
it('rejects a false content-addressed archive path before any Git write',async()=>{
  const f=await gitFixture(),observed=await inspectNativeCycle(f.native.context,[],f.native.io,NOW),file=archiveFile(observed.archives[0]!);
  file.path=file.path.replace(file.sha256,'0'.repeat(64));
  await expect(writeReleaseRecords({directory:join(f.root,'false-archive'),remote:f.remote,repositoryId:1,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',expectedHead:f.initial.head,
    allowedPaths:[file.path],changes:[{...file,previousSha256:null}],identity:f.input.identity})).rejects.toThrow('archive content address');
});
it('withholds rerun when Git was adopted but native ref visibility was lost, then resumes from the same archived bytes',async()=>{
  const f=await gitFixture();f.input.runId=100;
  f.native.overrides.set('GET /repos/example/product/git/ref/heads/steward/release-state',f.native.response({object:{sha:f.initial.head}}));
  const first=await inspectReleaseEvidence(f.input,{io:f.native.io});expect(first).toMatchObject({status:'UNKNOWN',reason:'ARCHIVE_NOT_CONFIRMED'});
  expect(f.native.calls.some(call=>call.startsWith('POST'))).toBe(false);
  const persisted=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});expect(persisted.domainRecords).toHaveLength(2);
  f.input.directory=f.remote;f.native.overrides.delete('GET /repos/example/product/git/ref/heads/steward/release-state');f.native.setAccepted();
  const recovered=await inspectReleaseEvidence(f.input,{io:f.native.io});expect(recovered.status).toBe('ACCEPTED');
  expect(f.native.calls.filter(call=>call.startsWith('POST'))).toHaveLength(1);
  expect((await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1})).head).toBe(persisted.head);
});
it('archives original native evidence and stops outside the rerun window without a replacement Run',async()=>{
  const f=await gitFixture();f.input.runId=100;
  const result=await inspectReleaseEvidence(f.input,{io:f.native.io,now:()=> '2026-11-26T00:02:00.000Z'});
  expect(result).toMatchObject({status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'});
  const readback=await readReleaseRecords({directory:f.remote,targetRef:'steward/release-state',repositoryId:1});
  expect(readback.domainRecords.some((record:any)=>record.path.startsWith('evidence/retry-limit/'))).toBe(false);
  expect(readback.domainRecords.some((record:any)=>record.path.startsWith('evidence/native/100-1/'))).toBe(true);
  expect(readback.cycles[0].value).toEqual(f.native.context.cycle);
  expect(f.native.calls.some(call=>call.startsWith('POST'))).toBe(false);
  const parent=await f.git('-C',f.remote,'show','-s','--format=%P',readback.head);
  expect(parent).toBe(f.initial.head);
},60_000);
