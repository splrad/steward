import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { archiveFile, inspectNativeCycle, recoverNativeCycle, nativeEvidenceTransport, nativeRequestIdentity, nativeRunFact, jobFact, NativeEvidenceReader } from '../src/native-release-evidence.js';
import { channelEvidenceFile, channelTargetsDigest } from '../src/release-run.js';
import { decodeStateFile } from '../../core/src/release-observation.js';
import { evidenceFixture, NOW, D, S, digest, zipResult } from './native-evidence-fixture.js';

it('uses the canonical repository endpoint because GitHub rejects its trailing-slash variant',async()=>{
  const calls:string[]=[];
  const io=nativeEvidenceTransport('fixture-token',async(url:any)=>{
    calls.push(String(url));return new Response(JSON.stringify({id:1}),{status:String(url)==='https://api.github.com/repos/example/product'?200:404});
  });
  expect(await new NativeEvidenceReader(io,'example/product').json('')).toEqual({id:1});
  expect(calls).toEqual(['https://api.github.com/repos/example/product']);
});
it('permits native created-time ranges in queries while rejecting encoded path traversal',async()=>{
  const calls:string[]=[],io=nativeEvidenceTransport('fixture-token',async(url:any)=>{
    calls.push(String(url));return new Response('{}',{status:200});
  });
  const path='/repos/example/product/actions/runs?created=2026-10-31T09%3A00%3A00Z..2026-10-31T10%3A00%3A00Z';
  expect((await io.request('GET',path)).status).toBe(200);expect(calls).toEqual(['https://api.github.com'+path]);
  for(const bad of ['/repos/example/../product','/repos/example/%2e%2e/product','/repos/example/%5c..%5cproduct','/repos/example/product#fragment'])
    await expect(io.request('GET',bad)).rejects.toThrow('API path');
  expect(calls).toHaveLength(1);
});
it('reads original attempt evidence and validates the latest native outcome',async()=>{
  const f=evidenceFixture(2),r=await inspectNativeCycle(f.context,[],f.io,NOW);
  expect(r.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[]});
  expect(r.archives).toHaveLength(2);expect(r.archives[0]!.logs[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.calls.some(call=>call.includes('/attempts/1/jobs'))).toBe(true);expect(f.calls.every(call=>call.startsWith('GET'))).toBe(true);
});
it('keeps timestamped skipped business steps out of native result collection and the failure budget',async()=>{
  const f=evidenceFixture();
  for(const job of f.jobs.get(1)!)for(const step of job.steps)if(step.name.startsWith('business-'))step.conclusion='skipped';
  const result=await inspectNativeCycle(f.context,[],f.io,NOW);
  expect(result.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[]});
  expect(result.native.attempts[0]!.invocations).toEqual([]);
  expect(f.calls.some(call=>call.endsWith('/logs'))).toBe(false);
});
it.each(['same-second','next-second'])('uses native second precision for %s receipts without replacing their precise completion time',async kind=>{
  const f=evidenceFixture(),result=f.results.get(1)!;
  result.execution.startedAt='2026-10-26T00:01:00.232Z';
  result.execution.completedAt=kind==='same-second'?'2026-10-26T00:01:00.233Z':'2026-10-26T00:01:01.000Z';
  result.execution.observedAt=result.execution.completedAt;
  const actual=await inspectNativeCycle(f.context,[],f.io,NOW);
  if(kind==='same-second'){
    expect(actual.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[]});
    expect(actual.native.attempts[0]!.invocations[0]!.evidence.completedAt).toBe(result.execution.completedAt);
  }else expect(actual.readObservation.disposition).not.toBe('COMPLETE');
});
it('keeps raw retained job projections while counting their original business execution only once, including expiry',async()=>{
  const f=evidenceFixture(2);
  f.jobs.set(2,[{...structuredClone(f.jobs.get(1)![0]),id:2000,run_attempt:2}]);
  const result=await inspectNativeCycle(f.context,[],f.io,NOW);
  expect(result.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[]});
  
  expect(result.archives[1]!.jobs[0]!.id).toBe(2000);expect(result.native.attempts[1]!.jobs).toEqual([]);
  expect(f.calls.some(call=>call.includes('/jobs/2000/logs'))).toBe(false);
  const history=result.archives.map(value=>({...archiveFile(value),commit:D,value}));
  f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},410));
  const expired=await inspectNativeCycle(f.context,history,f.io,NOW);
  expect(expired.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[]});
  expect(expired.archived[1]!.attempt.jobs).toEqual([]);
});
it('preserves repository ID, original Run, source and budget across rename and visibility changes, including archived native history',async()=>{
  const f=evidenceFixture(2),before=JSON.stringify(f.context.cycle),original=await inspectNativeCycle(f.context,[],f.io,NOW);
  const history=original.archives.map(value=>({...archiveFile(value),commit:D,value}));
  f.context.repository='example/renamed';
  const io={...f.io,request:async(method:'GET'|'POST',path:string,limit?:number,body?:object)=>f.io.request(method,path.replace('/repos/example/renamed','/repos/example/product'),limit,body)};
  for(const visibility of ['private','public']) {
    f.overrides.set('GET /repos/example/product',f.response({id:1,full_name:'example/renamed',default_branch:'main',archived:false,disabled:false,visibility}));
    const live=await inspectNativeCycle(f.context,history,io,NOW);expect(live.currentFacts).toEqual(original.currentFacts);
  }
  f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},410));
  const restored=await inspectNativeCycle(f.context,history,io,NOW);
  expect(restored.readObservation.disposition).toBe('COMPLETE');
  expect(JSON.stringify(f.context.cycle)).toBe(before);expect(f.calls.some(x=>x.startsWith('POST'))).toBe(false);
});
it.each(['archived','disabled','replacement-id','uninstalled'])('stops %s evidence reads and resumes the original objects after access is restored',async mode=>{
  const f=evidenceFixture(2),repo={id:1,full_name:'example/product',default_branch:'main',archived:false,disabled:false};
  f.overrides.set('GET /repos/example/product',f.response({...repo,archived:mode==='archived',disabled:mode==='disabled',id:mode==='replacement-id'?2:1},mode==='uninstalled'?403:200));
  await expect(inspectNativeCycle(f.context,[],f.io,NOW)).rejects.toThrow();
  expect(f.calls).toEqual(['GET /repos/example/product']);f.overrides.clear();
  const restored=await inspectNativeCycle(f.context,[],f.io,NOW);expect(restored.readObservation.disposition).toBe('COMPLETE');expect(f.request.canonicalRunId).toBe(100);
  expect(f.calls.some(x=>x.startsWith('POST'))).toBe(false);
});
it('accepts the exact producer ZIP when logs have expired and validates the closed payload',async()=>{
  const f=evidenceFixture();f.setLogs(false);f.artifact();const r=await inspectNativeCycle(f.context,[],f.io,NOW);
  expect(r.readObservation.disposition).toBe('COMPLETE');expect(r.archives[0]!.producers[0]!.artifactId).toBe(700);
  expect(f.calls.some(call=>call.endsWith('/logs'))).toBe(false);
  const file=archiveFile(r.archives[0]!);expect(decodeStateFile('steward/release-state',file.path,Buffer.from(file.content),1)).toEqual(r.archives[0]);
});
it.each(['digest','job-window','source','attempt','closed-fields','zip-entry','unknown-schema'])('rejects a %s result artifact without guessing a failed attempt',async mode=>{
  const f=evidenceFixture();f.setLogs(false);const result:any=structuredClone(f.results.get(1)!);
  if(mode==='source')result.sourceSha=D;if(mode==='attempt')result.execution.runAttempt=2;if(mode==='closed-fields')result.allowedJobs=['build'];if(mode==='unknown-schema')result.schemaVersion=2;
  const id=f.artifact(1,result);
  if(mode==='digest')f.artifacts[0].digest='sha256:'+'0'.repeat(64);
  if(mode==='job-window')f.artifacts[0].created_at='2026-10-28T00:00:00Z';
  if(mode==='zip-entry'){const bytes=zipResult(result,'unexpected.json');f.downloads.set(id,bytes);f.artifacts[0].digest='sha256:'+digest(bytes);f.artifacts[0].size_in_bytes=bytes.length;}
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).not.toBe('COMPLETE');
});
it.each([403,404,429,500])('keeps HTTP %i unknown without treating access loss as zero budget or expiration',async status=>{
  const f=evidenceFixture();f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({message:'fixture-secret'},status,{'retry-after':'120'}));
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).not.toBe('COMPLETE');expect(r.errors[0]).toEqual({code:`HTTP_${status}`,retryAfter:'120'});expect(JSON.stringify(r)).not.toContain('fixture-secret');
});
it.each(['actor','fork','head','ref','workflow','request-digest'])('blocks %s mismatch before native rerun',async field=>{
  const f=evidenceFixture();const run=f.runs.get(1);
  if(field==='actor')run.actor.id=99;if(field==='fork')run.head_repository.id=99;if(field==='head')run.head_sha=D;if(field==='ref')run.head_branch='main';if(field==='workflow')run.path='.github/workflows/other.yml';
  if(field==='request-digest'){f.request.inputDigest='0'.repeat(64);await expect(inspectNativeCycle(f.context,[],f.io,NOW)).rejects.toThrow('request digest');return;}
  const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);expect(r.status).toBe('UNKNOWN');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('treats started steps without result/log proof as UNKNOWN',async()=>{
  const f=evidenceFixture();f.setLogs(false);const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(r.status).toBe('UNKNOWN');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('archives and reads back before rerun and adopts a lost response by observing the actual native attempt',async()=>{
  const f=evidenceFixture();f.setAccepted();f.setThrowPost();const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(r).toMatchObject({status:'ACCEPTED',observedAttempt:2,archiveHead:D});
  expect(f.calls.filter(call=>call.startsWith('POST'))).toEqual(['POST /repos/example/product/actions/runs/100/rerun-failed-jobs']);
  expect(f.calls.indexOf('ARCHIVE_READBACK')).toBeLessThan(f.calls.findIndex(call=>call.startsWith('POST')));
  expect(JSON.stringify(r)).not.toContain('secret-shaped');
});
it('compares latest and attempt metadata with their own endpoints while preserving original Run and attempt times',async()=>{
  const f=evidenceFixture(2);f.runs.get(2).created_at='2026-10-26T00:00:01.000Z';f.setAccepted();const original=f.io.request;
  f.io.request=async(method,path,...args)=>{
    const response=await original(method,path,...args);
    if(method==='GET'&&path==='/repos/example/product/actions/runs/100'){
      const run=JSON.parse(Buffer.from(response.bytes).toString());run.created_at=f.runs.get(1).created_at;run.updated_at='2026-10-26T00:00:59.000Z';return f.response(run);
    }
    return response;
  };
  const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(result).toMatchObject({status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'});expect(result.observation.archives[0]!.run.updatedAt).toBe('2026-10-26T00:01:00.000Z');
  expect(result.observation.latestRuns[0]!.updatedAt).toBe('2026-10-26T00:00:59.000Z');
  expect(result.observation.archives[1]!.run.createdAt).toBe('2026-10-26T00:00:01.000Z');
  expect(result.observation.latestRuns[0]!.createdAt).toBe('2026-10-26T00:00:00.000Z');
});
it.each(['unknown','missing-readback','changed-readback'])('does not rerun after %s archive write',async mode=>{
  const f=evidenceFixture();const original=f.store.archive;
  f.store.archive=async files=>{const saved=await original(files);if(mode==='unknown')saved.status='UNKNOWN';if(mode==='missing-readback')saved.records=[];if(mode==='changed-readback')saved.records[0]!.value.inputDigest='0'.repeat(64);return saved;};
  const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);expect(r).toMatchObject({status:'UNKNOWN',reason:'ARCHIVE_NOT_CONFIRMED'});expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('does not invent an attempt or resend within the invocation when a native response is still unobserved',async()=>{
  const f=evidenceFixture();f.setThrowPost();const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(r).toMatchObject({status:'UNKNOWN',reason:'RERUN_NOT_YET_OBSERVED',observedAttempt:1});expect(f.calls.filter(call=>call.startsWith('POST'))).toHaveLength(1);
});
it('does not automatically rerun an already retried native Run',async()=>{
  const f=evidenceFixture(3);const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);expect(r).toMatchObject({status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'});expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('retains partial facts but refuses changing runs and incomplete pagination',async()=>{
  const f=evidenceFixture();const path='GET /repos/example/product/actions/runs/100/attempts/1/jobs?per_page=100';
  f.overrides.set(path,f.response({total_count:2,jobs:f.jobs.get(1)}));
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).not.toBe('COMPLETE');expect(r.errors[0]!.code).toContain('incomplete pagination');
});
it('follows all official page links and rejects repeated identities',async()=>{
  const f=evidenceFixture();const first='/repos/example/product/actions/runs/100/attempts/1/jobs?per_page=100',second=first+'&page=2';
  const job=f.jobs.get(1)![0],other={...job,id:1001,name:'collect',steps:[]};
  f.overrides.set('GET '+first,f.response({total_count:2,jobs:[job]},200,{link:`<https://api.github.com${second}>; rel="next"`}));
  f.overrides.set('GET '+second,f.response({total_count:2,jobs:[other]}));
  expect((await inspectNativeCycle(f.context,[],f.io,NOW)).readObservation.disposition).toBe('COMPLETE');
  f.overrides.set('GET '+second,f.response({total_count:2,jobs:[job]}));expect((await inspectNativeCycle(f.context,[],f.io,NOW)).readObservation.disposition).not.toBe('COMPLETE');
});
it('recovers an expired Run from original protected archives and verifies every native identity and digest',async()=>{
  const f=evidenceFixture(2),first=await inspectNativeCycle(f.context,[],f.io,NOW);
  const history=first.archives.map(value=>({path:archiveFile(value).path,commit:D,value}));
  f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},410));
  expect((await inspectNativeCycle(f.context,history,f.io,NOW)).readObservation.disposition).toBe('COMPLETE');
  history[0]!.path=history[0]!.path.replace(/\/[^/]+\.json$/,'/'+'0'.repeat(64)+'.json');
  await expect(inspectNativeCycle(f.context,history,f.io,NOW)).rejects.toThrow('archive provenance');
});
it('does not use archived success to bypass a live permission failure',async()=>{
  const f=evidenceFixture(),first=await inspectNativeCycle(f.context,[],f.io,NOW);
  const history=first.archives.map(value=>({path:archiveFile(value).path,commit:D,value}));
  f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},403));
  expect((await inspectNativeCycle(f.context,history,f.io,NOW)).readObservation.disposition).not.toBe('COMPLETE');
});
it('keeps another active native wave waiting without rerunning it',async()=>{
  const f=evidenceFixture();f.runs.get(1).status='in_progress';f.runs.get(1).conclusion=null;
  expect((await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW)).status).toBe('WAIT');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('uses no token on the signed download origin and rejects cross-origin redirects',async()=>{
  const calls:{url:string;headers:Headers}[]=[];
  const io=nativeEvidenceTransport('fixture-token',async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init?.headers)});
    return calls.length===1?new Response(null,{status:302,headers:{location:'https://fixture.blob.core.windows.net/log?signature=fixture'}}):new Response('log');
  });
  await io.request('GET','/repos/example/product/actions/jobs/1/logs');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer fixture-token');expect(calls[1]!.headers.has('authorization')).toBe(false);
  const unsafe=nativeEvidenceTransport('fixture-token',async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid/log'}}));
  await expect(unsafe.request('GET','/repos/example/product/actions/jobs/1/logs')).rejects.toThrow('download origin');
});
it('keeps business-before rejection at zero failures and lets the App recover the same original Run',async()=>{
  const f=evidenceFixture();f.runs.get(1).triggering_actor.id=99;f.jobs.get(1)![0].steps=[];
  f.setAccepted();const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(r.status).toBe('ACCEPTED');expect(r.observation.readObservation.disposition).toBe('COMPLETE');
});
it('never accepts a log result from another invocation or a future attempt',async()=>{
  const f=evidenceFixture();f.results.get(1)!.execution.runAttempt=2;
  expect((await inspectNativeCycle(f.context,[],f.io,NOW)).readObservation.disposition).not.toBe('COMPLETE');
});
it('checks artifact effects before believing a failure outcome and does not deduct a confirmed effect',async()=>{
  const f=evidenceFixture(),bytes=Buffer.from('native build bytes'),id=900;
  f.results.get(1)!.objects=[{kind:'artifact',id,digest:digest(bytes)}];
  f.artifacts.push({id,name:'build-output',expired:false,workflow_run:{id:100,head_sha:S},digest:'sha256:'+digest(bytes),size_in_bytes:bytes.length});f.downloads.set(id,bytes);
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).toBe('COMPLETE');expect(r.native.attempts[0]!.invocations[0]!.evidence.outcome).toBe('EFFECT_CONFIRMED');
  expect((await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW)).reason).toBe('EFFECTS_ARCHIVED');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('keeps the original build input digest after release IDs are frozen later in the same cycle',async()=>{
  const f=evidenceFixture();f.context.cycle.units[0]!.releaseId=7;f.context.cycle.units[0]!.manifestDigest='e'.repeat(64);
  expect((await inspectNativeCycle(f.context,[],f.io,NOW)).readObservation.disposition).toBe('COMPLETE');
});
it('uses original archives for explicitly expired logs of a still-readable terminal Run',async()=>{
  const f=evidenceFixture(),first=await inspectNativeCycle(f.context,[],f.io,NOW);f.setLogs(false);
  const history=first.archives.map(value=>({value,path:archiveFile(value).path,commit:D}));
  expect((await inspectNativeCycle(f.context,history,f.io,NOW)).readObservation.disposition).toBe('COMPLETE');
});
it('does not fall back to old logs on a permission failure',async()=>{
  const f=evidenceFixture(),first=await inspectNativeCycle(f.context,[],f.io,NOW);
  f.overrides.set('GET /repos/example/product/actions/jobs/1000/logs',f.response({},403));
  const history=first.archives.map(value=>({value,path:archiveFile(value).path,commit:D}));
  expect((await inspectNativeCycle(f.context,history,f.io,NOW)).readObservation.disposition).not.toBe('COMPLETE');
});
it('detects source/status movement during a scan and keeps it out of the rerun branch',async()=>{
  const f=evidenceFixture();let reads=0;
  f.overrides.set('GET /repos/example/product/actions/runs/100',()=>f.response({...f.runs.get(1),run_attempt:++reads===1?1:2}));
  const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);expect(r.status).toBe('UNKNOWN');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
function channelFixture() {
  const f=evidenceFixture(),cycle=f.context.cycle,unit=cycle.units[0]!;unit.releaseId=7;unit.manifestDigest='f'.repeat(64);cycle.requiredChannels=[{unitId:'app',channelId:'npm'}];
  Object.assign(f.request,{purpose:'channel-verify',ref:'main',executionSha:D});
  f.request.inputs={cycle_id:cycle.id,operation_key:'0'.repeat(64),request_key:'0'.repeat(64),source_sha:S,execution_sha:D,controller_sha:cycle.controllerSha,mode:'verify',targets_json:JSON.stringify([{unitId:'app',channelId:'npm',version:unit.version,releaseId:7,manifestDigest:unit.manifestDigest}])};
  Object.assign(f.request,nativeRequestIdentity(1,cycle,f.request));f.request.inputs.operation_key=f.request.operationKey;f.request.inputs.request_key=f.request.requestKey;
  Object.assign(f.runs.get(1),{path:'.github/workflows/steward-release-channels.yml',head_sha:D,head_branch:'main',display_title:`Verify ${f.request.requestKey}`,conclusion:'success'});
  Object.assign(f.jobs.get(1)![0],{name:'channel-prepare',head_sha:D,conclusion:'success'});f.jobs.get(1)![0].steps[0].conclusion='success';
  const result=f.results.get(1)!;result.executionSha=D;result.reasonCode='DEPENDENCY_NOT_READY';result.execution.entry='channel';result.execution.channelId='npm';result.execution.businessStartedProven=false;result.execution.outcome='WAIT';result.execution.inputDigest=f.request.inputDigest;
  result.execution.invocationKey=digest(JSON.stringify([1,cycle.id,10,100,1,'channel',1000,2,'app','npm',f.request.inputDigest]));
  f.artifact();const bytes=Buffer.from('readiness');f.artifacts[0].workflow_run.head_sha=D;
  const readyId=901;result.objects=[{kind:'artifact',id:readyId,digest:digest(bytes)}];
  // Closed pending result was produced by this exact workflow and has an exact object expectation.
  const resultBytes=zipResult(result);f.downloads.set(700,resultBytes);f.artifacts[0].digest='sha256:'+digest(resultBytes);f.artifacts[0].size_in_bytes=resultBytes.length;
  f.artifacts.push({id:readyId,name:'ready-observation',expired:false,workflow_run:{id:100,head_sha:D},digest:'sha256:'+digest(bytes),size_in_bytes:bytes.length});f.downloads.set(readyId,bytes);
  const run={...nativeRunFact(f.runs.get(1)),id:200},job={...jobFact(f.jobs.get(1)![0]),id:2000,runId:200,name:'observe',steps:[]};
  const payload={schemaVersion:1,cycleId:cycle.id,sourceSha:S,executionSha:D,controllerSha:cycle.controllerSha,targetsDigest:channelTargetsDigest(f.context,JSON.parse(f.request.inputs.targets_json!)),nativeRunId:200,runAttempt:1,
    items:[{unitId:'app',channelId:'npm',version:unit.version,readStatus:'OK',exists:true,digest:null,accepted:true,indexed:true,observedAt:job.completedAt,evidenceKind:'native-index'}]};
  const value={schemaVersion:1 as const,repositoryId:1,cycleId:cycle.id,sourceSha:S,observedAt:NOW,kind:'PROBE' as const,run,job,artifact:{id:readyId,name:'probe',digest:'sha256:'+digest(bytes),createdAt:job.completedAt!},payload:JSON.stringify(payload)};
  const probe=channelEvidenceFile(value),readHistory={complete:true,observations:[],channelEvidence:[{path:probe.path,commit:D,value}]};
  f.setLogs(false);return {...f,readHistory};
}
it('recovers a successful pending Run through its exact native channel-prepare job, without --failed',async()=>{
  const f=channelFixture();f.setAccepted();const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW,f.readHistory);
  expect(r.status).toBe('ACCEPTED');expect(f.calls.filter(call=>call.startsWith('POST'))).toEqual(['POST /repos/example/product/actions/jobs/1000/rerun']);expect(r.observation.readObservation.disposition).toBe('COMPLETE');
});
it.each(['missing','duplicate'])('rejects %s channel-prepare identity instead of guessing an executable job',async kind=>{
  const f=channelFixture();if(kind==='missing')f.jobs.get(1)![0].name='other';else f.jobs.get(1)!.push({...f.jobs.get(1)![0],id:1001,steps:[]});
  await expect(recoverNativeCycle(f.context,100,f.store,[],f.io,NOW,f.readHistory)).rejects.toThrow('channel-prepare identity');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('resolves the actual pinned runner checkout through a reusable workflow instead of assuming its workflow commit is the runner commit',async()=>{
  const f=evidenceFixture();
  const blob=(text:string)=>{const bytes=Buffer.from(text);return f.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});};
  f.overrides.set(`GET /repos/example/product/contents/.github/workflows/steward-release-publish.yml?ref=${S}`,blob(`jobs:\n  build:\n    uses: splrad/steward/.github/workflows/product-release.yml@${D}\n`));
  const controller='b'.repeat(40);
  f.overrides.set(`GET /repos/splrad/steward/contents/.github/workflows/product-release.yml?ref=${D}`,blob(`jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${S}\n        with:\n          repository: splrad/steward\n          ref: ${controller}\n`));
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).toBe('COMPLETE');expect(r.archives[0]!.executorControllerSha).toBe(controller);expect(r.archives[0]!.sourceBlobs).toHaveLength(2);
});
it('streams native object digests under the existing build size bound without retaining the entire object in memory',async()=>{
  const bytes=Buffer.from('native streamed artifact');
  const io=nativeEvidenceTransport(undefined,async()=>new Response(bytes));
  expect(await io.downloadDigest!('/repos/example/product/actions/artifacts/1/zip',bytes.length)).toMatchObject({status:200,size:bytes.length,digest:digest(bytes)});
  await expect(io.downloadDigest!('/repos/example/product/actions/artifacts/1/zip',2)).rejects.toThrow('response bound');
});
it('rejects a result naming a unit outside the frozen cycle',async()=>{
  const f=evidenceFixture();const e=f.results.get(1)!.execution;e.unitId='other';e.invocationKey=digest(JSON.stringify([1,e.cycleId,10,100,1,'build',1000,2,'other',null,e.inputDigest]));
  const r=await inspectNativeCycle(f.context,[],f.io,NOW);expect(r.readObservation.disposition).not.toBe('COMPLETE');expect(r.errors[0]!.code).toContain('result unit');
});
it('derives the 1/5/15/60 minute read backoff from prior observations without changing the business budget',async()=>{
  const f=evidenceFixture();f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},503));
  const observations:Awaited<ReturnType<typeof inspectNativeCycle>>['readObservation'][]=[];let now=NOW;
  for(const delay of [1,5,15,60,60]) {
    const result=await inspectNativeCycle(f.context,[],f.io,now,{complete:true,observations});
    expect(result.readObservation.disposition).toBe('RETRY');expect(Date.parse(result.readObservation.nextCheckAt!)-Date.parse(now)).toBe(delay*60_000);
    expect(result.readObservation.disposition).not.toBe('COMPLETE');observations.push(result.readObservation);now=result.readObservation.nextCheckAt!;
  }
});
it('respects Retry-After as a lower bound and archives the failure observation before yielding',async()=>{
  const f=evidenceFixture();f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},429,{'retry-after':'3600'}));
  const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(Date.parse(r.observation.readObservation.nextCheckAt!)-Date.parse(NOW)).toBe(3600_000);
  expect(f.saved.some(path=>path.startsWith('evidence/reads/'))).toBe(true);expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
  for(const kind of ['log','producer','object']) {
    const nested=evidenceFixture();let path='actions/jobs/1000/logs';
    if(kind==='producer'){nested.artifact();path='actions/artifacts/700';}
    if(kind==='object'){nested.results.get(1)!.objects=[{kind:'artifact',id:900,digest:'e'.repeat(64)}];path='actions/artifacts/900';}
    nested.overrides.set('GET /repos/example/product/'+path,nested.response({},429,{'retry-after':'7200'}));
    const observation=await inspectNativeCycle(nested.context,[],nested.io,NOW);
    expect(Date.parse(observation.readObservation.nextCheckAt!)-Date.parse(NOW)).toBe(7200_000);expect(observation.readObservation.disposition).not.toBe('COMPLETE');
  }
});
it.each([false,true])('requires complete Git history before declaring expired original evidence unrecoverable: %s',async complete=>{
  const f=evidenceFixture();f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},410));
  const r=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW,{complete,observations:[]});
  expect(r.observation.readObservation.disposition).toBe(complete?'UNRECOVERABLE':'RETRY');
  expect(r.reason).toBe(complete?'EVIDENCE_UNRECOVERABLE':'EVIDENCE_INCOMPLETE');expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('only treats 404 as lost history after the authenticated complete native run inventory also proves absence',async()=>{
  const f=evidenceFixture();f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},404));
  f.overrides.set('GET /repos/example/product/actions/workflows/10/runs?per_page=100',f.response({total_count:0,workflow_runs:[]}));
  expect((await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[]})).readObservation.disposition).toBe('UNRECOVERABLE');
  f.overrides.set('GET /repos/example/product/actions/workflows/10/runs?per_page=100',f.response({},403));
  expect((await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[]})).readObservation.disposition).toBe('RETRY');
});
it('reuses unchanged original facts instead of appending every old attempt on each scheduler scan',async()=>{
  const f=evidenceFixture(),first=await inspectNativeCycle(f.context,[],f.io,NOW);
  const history=first.archives.map(value=>({value,path:archiveFile(value).path,commit:D}));
  const second=await inspectNativeCycle(f.context,history,f.io,'2026-10-26T00:03:00.000Z',{complete:true,observations:[first.readObservation]});
  expect(second.archives.map(archiveFile)).toEqual(first.archives.map(archiveFile));expect(second.readObservation).toEqual(first.readObservation);
  expect(f.calls.filter(call=>call==='GET /repos/example/product/actions/runs/100')).toHaveLength(4);
});
