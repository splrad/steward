import {expect,it} from 'vitest';
import {evidenceFixture,D,START,END,NOW} from './native-evidence-fixture.js';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const contract=()=>import(pathToFileURL(resolve('scripts/bounded-winget-contract.mjs')).href);
async function fixture() {
  const {context}=evidenceFixture();context.repositoryId=1187527897;context.repository='splrad/LayerScape';
  context.cycle.dispatches=[];
  Object.assign(context.cycle.units[0]!,{id:'layerscape',releaseId:20,manifestDigest:'d'.repeat(64)});
  context.cycle.requiredChannels=[{unitId:'layerscape',channelId:'winget'}];
  const inputs=(await contract()).boundedWingetInputs(context.cycle,D);
  const run:any={id:100,runAttempt:1,repositoryId:context.repositoryId,headRepositoryId:context.repositoryId,actorId:context.appBotId,
    path:'.github/workflows/steward-release-channels.yml',event:'workflow_dispatch',headSha:D,displayTitle:`Channels observe ${inputs.request_key}`};
  const job:any={runId:100,runAttempt:1,headSha:D,name:'observe',status:'completed',conclusion:'success',startedAt:START,completedAt:END};
  const item={unitId:'layerscape',channelId:'winget',version:'1.0.0',readStatus:'OK',exists:true,digest:null,accepted:true,indexed:true,observedAt:END,evidenceKind:'github-pr:33'};
  const payload={schemaVersion:1,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,executionSha:D,controllerSha:context.cycle.controllerSha,
    targetsDigest:inputs.operation_key,nativeRunId:100,runAttempt:1,items:[item]};
  const identity={repositoryId:context.repositoryId,cycleId:context.cycle.id,stage:'winget-index',channel:'winget',sourceSha:context.cycle.sourceSha,
    version:'1.0.0',artifactDigest:'sha256:'+'d'.repeat(64),upstreamPR:{number:33,nodeId:'PR_33'}};
  const pull={number:33,node_id:'PR_33',merged:true,base:{repo:{full_name:'microsoft/winget-pkgs'}}};
  return {context,inputs,run,job,item,payload,identity,pull};
}
it('builds exactly the existing eight observe inputs from the frozen cycle',async()=>{
  const f=await fixture();expect(Object.keys(f.inputs).sort()).toEqual(['controller_sha','cycle_id','execution_sha','mode','operation_key','request_key','source_sha','targets_json']);
  expect(f.inputs.mode).toBe('observe');expect(JSON.parse(f.inputs.targets_json)).toHaveLength(1);
  expect((await contract()).verifyBoundedWingetProbe(f.context,f.identity,f.payload,f.run,f.job,f.pull,NOW).done).toBe(true);
});
it.each(['wrong-pr','not-indexed','old-observation','failed-job'])('never treats %s as completed indexing',async kind=>{
  const f=await fixture();
  if(kind==='wrong-pr')f.item.evidenceKind='github-pr:34';
  if(kind==='not-indexed')f.item.indexed=false;
  if(kind==='failed-job')f.job.conclusion='failure';
  const check=()=> (contract()).then(m=>m.verifyBoundedWingetProbe(f.context,f.identity,f.payload,f.run,f.job,f.pull,kind==='old-observation'?'2026-10-26T01:00:00Z':NOW));
  if(kind==='failed-job')await expect(check()).rejects.toThrow();else expect((await check()).done).toBe(false);
});
