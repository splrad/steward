import {expect,it} from 'vitest';
import {reconcileCycleHistory,type CycleCompletionFact,type RepairDecisionFact} from '../src/release-history.js';
import type {CompletionSource,CompletionEvidence,CycleRecord} from '../src/release-observation.js';
const S='a'.repeat(40),C='b'.repeat(40),D='c'.repeat(40),H='d'.repeat(64),NOW='2026-10-27T00:00:00.000Z';
export function historyCycle(n=1):{cycle:CycleRecord;fact:CycleCompletionFact} {
  const sourceSha=n===1?S:C,id=`pr-${n}-${sourceSha}`,unit={id:'app',version:`1.0.${n}`,tag:`v1.0.${n}`,releaseId:n,manifestDigest:H,notesDigest:H,assets:[{id:'app',path:'app.zip',size:1,sha256:H}]};
  const cycle:CycleRecord={id,prNumber:n,sourceSha,controllerSha:C,deliveryConfigSha:D,units:[unit],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
  const source:CompletionSource={repositoryId:1,cycleId:id,sourceSha,deliveryConfigSha:D,units:[{...unit,releaseId:n,authorId:42,assets:unit.assets.map(({path,size,sha256})=>({path,size,sha256}))}],requiredChannels:[]};
  const u=source.units[0]!,{id:unitId,...release}=u;
  const observation:CompletionEvidence={source,sourceComplete:true,observedAt:NOW,releasesComplete:true,channelsComplete:true,
    releases:[{...release,unitId,sourceSha,draft:false,immutable:true,evidenceDigest:H}],channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]};
  return {cycle,fact:{cycleId:id,source,observation,kind:'live',provenanceComplete:true}};
}
function input(values= [historyCycle()]) {
  return {repositoryId:1,inventoryComplete:true,cycles:values.map(v=>v.cycle),discovered:values.map((v,i)=>({id:v.cycle.id,prNumber:v.cycle.prNumber,sourceSha:v.cycle.sourceSha,mergedAt:`2026-10-${25+i}T00:00:00.000Z`})),
    completions:values.map(v=>v.fact),decisions:[] as RepairDecisionFact[],repairActorId:99,now:NOW};
}
it('uses fresh actual completion and treats persisted pointers only as locators',()=>{
  const v=historyCycle(),i=input([v]);v.cycle.completedEvidencePath='evidence/fake.json';
  expect(reconcileCycleHistory(i)).toMatchObject({result:'PASS',activeCycleIds:[],lastCompletedCycleId:v.cycle.id});
  i.completions=[];expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
});
it.each(['inventory','source','provenance','fresh'])('cannot complete with missing %s',kind=>{
  const i=input();if(kind==='inventory')i.inventoryComplete=false;if(kind==='source')i.discovered=[];
  if(kind==='provenance')i.completions[0]!.provenanceComplete=false;if(kind==='fresh')i.completions[0]!.kind='historical';
  expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
});
it('preserves earlier complete delivery when an old object is delisted, while requiring the newest source live',()=>{
  const old=historyCycle(),latest=historyCycle(2);old.fact.kind='historical';
  const i=input([old,latest]),delisted=structuredClone(old.fact);delisted.kind='live';delisted.observation.releases=[];i.completions.push(delisted);
  expect(reconcileCycleHistory(i).result).toBe('PASS');latest.fact.observation.releases=[];expect(reconcileCycleHistory(i).result).toBe('WAIT');
});
it('keeps unknown writes and changed fixed obligations closed',()=>{
  const i=input();i.completions[0]!.observation.unknownWriteKeys=[H];expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
  i.completions[0]!.observation.unknownWriteKeys=[];i.cycles[0]!.units[0]!.version='2.0.0';expect(reconcileCycleHistory(i).result).toBe('CONFLICT');
});
function repair() {
  const old=historyCycle(),replacement=historyCycle(2);old.fact.observation.releases=[];
  const decision={eventId:10,actorId:99,createdAt:NOW,cycleId:old.cycle.id,sourceSha:S,unitIds:['app'],releaseIds:[1],tags:['v1.0.1'],evidencePath:'evidence/repair.json'};
  replacement.cycle.repairOf=old.cycle.id;replacement.cycle.approvedRepairDecision=decision;
  const i=input([old,replacement]);i.decisions=[{...decision,originalStateCommit:D,originalActiveCycleIds:[old.cycle.id]}];return i;
}
it('retains old repair fields without discharging a failed historical version',()=>{const i=repair();expect(reconcileCycleHistory(i)).toMatchObject({result:'WAIT',dischargedCycleIds:[]});});
