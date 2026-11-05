import {channelPreparationResults,channelTargetsDigest,channelEvidenceFile,verifyContinuationReleases} from '../src/release-run.js';
import {nativeRunFact,jobFact,nativeRequestIdentity,type ArchivedFile,type ArchiveFile} from '../src/native-release-evidence.js';
import {expect,it} from 'vitest';
import {recoverNativeCycle} from '../src/native-release-evidence.js';
import {evidenceFixture,D,digest,NOW} from './native-evidence-fixture.js';
it('stops at the native age limit without dispatching a replacement Run',async()=>{
 const f=evidenceFixture();const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,'2026-11-26T00:02:00.000Z');
 expect(result).toMatchObject({status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'});
 expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
it('alerts after one automatic native rerun rather than constructing a cross-stage budget',async()=>{
 const f=evidenceFixture(2);const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
 expect(result).toMatchObject({status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'});
 expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});

function channel(attempts=1,mode:'submit'|'verify'='submit') {
  const f=evidenceFixture(attempts),unit=f.context.cycle.units[0]!;
  Object.assign(unit,{releaseId:50,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.zip',size:1,sha256:'f'.repeat(64)}]});
  f.context.cycle.requiredChannels=[{unitId:'app',channelId:'test'}];
  f.request.purpose=`channel-${mode}`;f.request.ref='main';f.request.inputs={cycle_id:f.context.cycle.id,source_sha:f.context.cycle.sourceSha,
    controller_sha:f.context.cycle.controllerSha,execution_sha:f.request.executionSha,operation_key:'0'.repeat(64),request_key:'0'.repeat(64),mode,
    targets_json:JSON.stringify([{unitId:'app',channelId:'test',version:unit.version,releaseId:50,manifestDigest:unit.manifestDigest}])};
  Object.assign(f.request,nativeRequestIdentity(1,f.context.cycle,f.request));f.request.inputs.operation_key=f.request.operationKey;f.request.inputs.request_key=f.request.requestKey;
  for(const [i,run] of f.runs) {
    run.path='.github/workflows/steward-release-channels.yml';run.head_branch='main';run.display_title=f.request.requestKey;
    const result=f.results.get(i)!;result.execution.entry='channel';result.execution.channelId='test';result.execution.inputDigest=f.request.inputDigest;
    result.execution.invocationKey=digest(JSON.stringify([1,f.context.cycle.id,10,100,i,'channel',i*1000,2,'app','test',f.request.inputDigest]));
  }
  const records:ArchivedFile[]=[],files:ArchiveFile[]=[];
  const original=f.store.archive;
  f.store.archive=async next=>{const saved=await original(next);records.push(...saved.records);files.push(...next);return {...saved,records:[...records],files:[...files]};};
  return {...f,records,files};
}
it.each([false,true])('pending preparation has zero failures and current readiness=%s controls exact job rerun',async ready=>{
  const f=channel(1,'verify'),raw=f.runs.get(1),job=f.jobs.get(1)![0];
  raw.conclusion='success';job.name='channel-prepare';job.conclusion='success';job.steps[0].name='business-channel-readiness';job.steps[0].conclusion='success';
  f.results.set(1,channelPreparationResults(f.context,f.request,nativeRunFact(raw),jobFact(job),[],job.completed_at)[0]!);
  f.overrides.set('GET /repos/example/product/actions/jobs/1000/logs',f.response(`${job.completed_at} STEWARD_RESULT ${JSON.stringify(f.results.get(1))}\n`));
  const probeRun={...nativeRunFact(raw),id:200},probeJob={...jobFact(job),id:2000,runId:200,name:'observe',steps:[]},targets=JSON.parse(f.request.inputs.targets_json!);
  const payload=JSON.stringify({schemaVersion:1,cycleId:f.context.cycle.id,sourceSha:f.context.cycle.sourceSha,executionSha:raw.head_sha,controllerSha:f.context.cycle.controllerSha,
    targetsDigest:channelTargetsDigest(f.context,targets),nativeRunId:200,runAttempt:1,items:[{unitId:'app',channelId:'test',version:'1.0.0',readStatus:ready?'OK':'PENDING',exists:true,digest:null,accepted:ready,indexed:ready,observedAt:job.completed_at,evidenceKind:'github-pr:3'}]});
  const value={schemaVersion:1 as const,repositoryId:1,cycleId:f.context.cycle.id,sourceSha:f.context.cycle.sourceSha,observedAt:NOW,kind:'PROBE' as const,
    run:probeRun,job:probeJob,artifact:{id:300,name:'probe',digest:'sha256:'+'a'.repeat(64),createdAt:job.completed_at},payload};
  const file=channelEvidenceFile(value);
  const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW,{complete:true,observations:[],channelEvidence:[{path:file.path,commit:D,value}]});
  expect(result.observation.currentFacts.unknownEvidence).toEqual([]);
  expect(f.calls.some(call=>call==='POST /repos/example/product/actions/jobs/1000/rerun')).toBe(ready);
  expect(f.calls.some(call=>call.includes('/rerun-failed-jobs'))).toBe(false);
});
it('ignores native download counters while still checking formal asset identities and bytes',async()=>{
  const f=channel(),unit=f.context.cycle.units[0]!;unit.notesDigest=digest('notes');unit.assets[0]!.sha256=digest('f');let count=0;
  const io={anonymous:()=>io,request:async(_method:string,path:string)=>{
    if(path==='/repos/example/product')return f.response({id:1,full_name:'example/product',private:false,archived:false,disabled:false});
    if(path.endsWith('/assets/51'))return f.response('f');
    if(path.includes('/assets?'))return f.response([{id:51,name:'app.zip',size:1,download_count:count++}]);
    if(path.includes('/commits/'))return f.response({sha:f.context.cycle.sourceSha});
    return f.response({id:50,tag_name:unit.tag,author:{id:42},body:'notes',draft:false,immutable:true,assets:[{download_count:count++}]});
  }};
  await expect(verifyContinuationReleases(f.context,io)).resolves.toBeUndefined();expect(count).toBeGreaterThan(1);
});
