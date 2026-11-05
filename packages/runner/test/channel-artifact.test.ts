import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChannelArtifacts,prepareChannelDispatch,channelTargetsDigest,channelEvidenceFile } from '../src/release-run.js';
import { nativeRunFact } from '../src/native-release-evidence.js';
import * as downloads from '../src/native-artifact-download.js';
import { evidenceFixture,S,C,D,START,END,NOW } from './native-evidence-fixture.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['valid','formatted','retained','expired','wrong-run','duplicate','future-payload','self-artifact','changed-digest','failed-probe'])('recovers probe by exact Run artifact inventory without trusting upload output: %s',async kind=>{
  const f=evidenceFixture(),unit=f.context.cycle.units[0]!;
  Object.assign(unit,{releaseId:20,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.zip',size:1,sha256:'f'.repeat(64)}]});
  f.context.cycle.requiredChannels=[{unitId:'app',channelId:'winget'}];
  const targets=[{unitId:'app',channelId:'winget',version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}];
  const request=prepareChannelDispatch(f.context,10,'trunk',D,'submit',targets,START);
  const run=nativeRunFact({...f.runs.get(1),path:'.github/workflows/steward-release-channels.yml',head_sha:D,head_branch:'trunk',display_title:request.requestKey,conclusion:'success'});
  const job={...f.jobs.get(1)![0],name:'observe',head_sha:D,conclusion:kind==='failed-probe'?'failure':'success',steps:[]};
  const digest=channelTargetsDigest(f.context,targets),artifact={id:700,name:`probe-${f.context.cycle.id}-${digest}-100-1`,digest:'sha256:'+'e'.repeat(64),
    workflow_run:{id:kind==='wrong-run'?101:100,head_sha:D},created_at:END,expired:kind==='expired'};
  const payload:any={schemaVersion:1,cycleId:f.context.cycle.id,sourceSha:S,executionSha:D,controllerSha:C,targetsDigest:digest,nativeRunId:100,runAttempt:1,
    items:[{unitId:'app',channelId:'winget',version:unit.version,readStatus:'PENDING',exists:true,digest:null,accepted:false,indexed:false,observedAt:kind==='future-payload'?'2026-10-26T00:03:00Z':END,evidenceKind:'github-pr:3'}]};
  if(kind==='self-artifact')payload.artifactId=700;
  const originalRun=structuredClone(run);if(kind==='retained')run.runAttempt=2;
  const io={request:async(_method:string,path:string)=>{
    if(path.endsWith('/attempts/1'))return f.response({...f.runs.get(1),path:originalRun.path,head_sha:D,head_branch:'trunk',display_title:request.requestKey,conclusion:'success'});
    if(path.includes('/jobs?'))return f.response({total_count:1,jobs:[path.includes('/attempts/2/')?{...job,id:2000,run_attempt:2}:job]});
    if(path.endsWith('/artifacts/700'))return f.response({...artifact,...(kind==='changed-digest'?{digest:'sha256:'+'f'.repeat(64)}:{})});
    return f.response({total_count:kind==='duplicate'?2:1,artifacts:kind==='duplicate'?[artifact,{...artifact,id:701}]:[artifact]});
  }};
  const download=vi.spyOn(downloads,'downloadNativeArtifact').mockImplementation(async(input,token)=>{
    expect(token).toBe('fixture-read-token');expect(input.artifactId).toBe(700);expect(input.digest).toBe(artifact.digest);expect(input.names).toEqual(['report.json']);
    await mkdir(input.directory);await writeFile(join(input.directory,'report.json'),kind==='formatted'?JSON.stringify(payload,null,2)+'\n':JSON.stringify(payload));
  });
  const root=await mkdtemp(join(tmpdir(),'channel-artifact-'));roots.push(root);
  const result=readChannelArtifacts(f.context,run,targets,null,root,'controller','fixture-read-token',io,NOW);
  if(['valid','formatted','retained'].includes(kind)){
    const value=await result;expect(value.files).toHaveLength(1);expect(value.reads).toEqual(payload.items);
    const record=JSON.parse(value.files[0]!.content);expect(record).toMatchObject({artifact:{id:700},job:{id:1000},run:{runAttempt:1}});
    if(kind==='formatted'){
      expect(record.payload).toBe(JSON.stringify(payload,null,2)+'\n');
      expect(()=>channelEvidenceFile({...record,artifact:{...record.artifact,name:record.artifact.name+'\n'}})).toThrow();
      expect(()=>channelEvidenceFile({...record,payload:record.payload.replace('"schemaVersion": 1','"schemaVersion": 1,"schemaVersion": 1')})).toThrow();
      expect(()=>channelEvidenceFile({...record,payload:record.payload.replace('github-pr:3','github-pr:3\\n')})).toThrow();
    }
  }
  else if(kind==='expired'||kind==='failed-probe'){expect((await result).files).toEqual([]);expect(download).not.toHaveBeenCalled();}
  else await expect(result).rejects.toThrow();
});
