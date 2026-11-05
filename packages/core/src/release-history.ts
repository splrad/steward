import {decodeBuildJson} from './build-manifest.js';
import {evaluateCompletion,parseReleaseRecord,type CompletionSource,type CompletionEvidence,type CompletionTruth,type CycleRecord} from './release-observation.js';

export interface CompletionArchive {
  schemaVersion:1; repositoryId:number; cycleId:string; source:CompletionSource; observation:CompletionEvidence;
  provenance:{path:string;digest:string;sourceUrl:string;observedAt:string}[];
}
const fail=(reason:string):never=>{throw new Error('RELEASE_HISTORY: '+reason);};
const keys=(value:object,expected:string[])=>{if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==expected.sort().join(','))fail('closed contract');};
export function decodeCompletionArchive(bytes:Uint8Array):CompletionArchive {
  const value=decodeBuildJson(bytes) as unknown as CompletionArchive;
  keys(value,['schemaVersion','repositoryId','cycleId','source','observation','provenance']);
  if(value.schemaVersion!==1||value.repositoryId!==value.source.repositoryId||value.cycleId!==value.source.cycleId||!Array.isArray(value.provenance)||!value.provenance.length)fail('completion provenance');
  evaluateCompletion(value.source,value.observation,value.observation.observedAt);
  for(const proof of value.provenance) {
    keys(proof,['path','digest','sourceUrl','observedAt']);
    if(!/^evidence\/(?:native\/[1-9][0-9]*-[1-9][0-9]*|publication|channel|channel-read)\/[a-f0-9]{64}\.json$/.test(proof.path)
      ||!proof.path.endsWith('/'+proof.digest+'.json')||!/^https:\/\/[^\s]+$/.test(proof.sourceUrl)||!Number.isFinite(Date.parse(proof.observedAt))
      ||Date.parse(proof.observedAt)>Date.parse(value.observation.observedAt))fail('raw evidence provenance');
  }
  const digests=new Set(value.provenance.map(proof=>proof.digest));
  if([...value.observation.releases,...value.observation.channels,...value.observation.consumptions].some(fact=>!digests.has(fact.evidenceDigest)))fail('unbacked native observation');
  return structuredClone(value);
}
export interface CycleHistoryFact {id:string;prNumber:number;sourceSha:string;mergedAt:string}
export interface CycleCompletionFact {cycleId:string;source:CompletionSource;observation:CompletionEvidence;kind:'live'|'historical';provenanceComplete:boolean}
export interface RepairDecisionFact {
  eventId:number;actorId:number;createdAt:string;cycleId:string;sourceSha:string;unitIds:string[];releaseIds:number[];tags:string[];
  originalStateCommit:string;originalActiveCycleIds:string[];evidencePath:string;
}
export function completionMatchesCycle(repositoryId:number,cycle:CycleRecord,source:CompletionSource) {
  const assets=(values:{path:string;size:number;sha256:string}[])=>values.map(({path,size,sha256})=>({path,size,sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  const units=source.units.map(u=>[u.id,u.version,u.tag,u.releaseId,u.manifestDigest,u.notesDigest,assets(u.assets)]).sort(),expected=cycle.units.map(u=>[u.id,u.version,u.tag,u.releaseId,u.manifestDigest,u.notesDigest,assets(u.assets)]).sort();
  const channels=(values:{unitId:string;channelId:string}[])=>values.map(v=>JSON.stringify([v.unitId,v.channelId])).sort().join(',');
  return source.repositoryId===repositoryId&&source.cycleId===cycle.id&&source.sourceSha===cycle.sourceSha&&source.deliveryConfigSha===cycle.deliveryConfigSha
    &&JSON.stringify(units)===JSON.stringify(expected)&&channels(source.requiredChannels)===channels(cycle.requiredChannels);
}
/** Explicit recovery only: inspect historical facts without repair ancestry or discharge decisions. */
export function reconcileCycleHistory(input:{repositoryId:number;inventoryComplete:boolean;cycles:CycleRecord[];discovered:CycleHistoryFact[];
  completions:CycleCompletionFact[];decisions:RepairDecisionFact[];repairActorId:number;now:string}) {
  keys(input,['repositoryId','inventoryComplete','cycles','discovered','completions','decisions','repairActorId','now']);
  const cycles=input.cycles.map(cycle=>parseReleaseRecord('cycle',cycle)),reasons:{cycleId:string;result:CompletionTruth;reason:string}[]=[];
  const add=(cycleId:string,result:CompletionTruth,reason:string)=>reasons.push({cycleId,result,reason});
  if(!input.inventoryComplete)add('history','UNKNOWN','INCOMPLETE_SOURCE_HISTORY');
  const discovered=[...input.discovered].sort((a,b)=>a.mergedAt.localeCompare(b.mergedAt)||a.id.localeCompare(b.id));
  if(new Set(cycles.map(c=>c.id)).size!==cycles.length||new Set(discovered.map(c=>c.id)).size!==discovered.length)fail('duplicate cycle');
  for(const fact of discovered) {
    if(!Number.isFinite(Date.parse(fact.mergedAt))||fact.id!==`pr-${fact.prNumber}-${fact.sourceSha}`)fail('source cycle');
    if(!cycles.some(c=>c.id===fact.id))add(fact.id,'UNKNOWN','CYCLE_RECORD_RECONSTRUCTION_REQUIRED');
  }
  const states=new Map<string,CompletionTruth>();
  for(const cycle of cycles) {
    if(!discovered.some(f=>f.id===cycle.id&&f.sourceSha===cycle.sourceSha&&f.prNumber===cycle.prNumber)){add(cycle.id,'UNKNOWN','MERGED_SOURCE_UNPROVEN');states.set(cycle.id,'UNKNOWN');continue;}
    const facts=input.completions.filter(f=>f.cycleId===cycle.id),live=facts.filter(f=>f.kind==='live').sort((a,b)=>b.observation.observedAt.localeCompare(a.observation.observedAt))[0];
    const historical=facts.filter(f=>f.kind==='historical'&&f.provenanceComplete&&evaluateCompletion(f.source,f.observation,f.observation.observedAt).result==='PASS')
      .sort((a,b)=>b.observation.observedAt.localeCompare(a.observation.observedAt))[0];
    // The most recent admitted source and every unfinished source need a fresh native read.
    const needsLive=cycle.id===discovered.at(-1)?.id||!historical;
    const selected=needsLive?live:historical;
    if(!selected||!selected.provenanceComplete){add(cycle.id,'UNKNOWN',needsLive?'FRESH_COMPLETION_REQUIRED':'ORIGINAL_COMPLETION_REQUIRED');states.set(cycle.id,'UNKNOWN');continue;}
    const source=selected.source;
    if(!completionMatchesCycle(input.repositoryId,cycle,source)) {
      add(cycle.id,'CONFLICT','FROZEN_OBLIGATIONS_CHANGED');states.set(cycle.id,'CONFLICT');continue;
    }
    const evaluated=evaluateCompletion(source,selected.observation,needsLive?input.now:selected.observation.observedAt),result=evaluated.result;
    states.set(cycle.id,result);add(cycle.id,result,needsLive?'NATIVE_COMPLETION':'ORIGINAL_DELIVERY_PROVENANCE');
  }
  const blockers=reasons.filter(r=>r.result!=='PASS');
  const result:CompletionTruth=blockers.some(r=>r.result==='CONFLICT')?'CONFLICT':blockers.some(r=>r.result==='UNKNOWN')?'UNKNOWN':blockers.length?'WAIT':'PASS';
  return {result,reasons,dischargedCycleIds:[] as string[],activeCycleIds:discovered.filter(c=>states.get(c.id)!=='PASS').map(c=>c.id),
    lastCompletedCycleId:[...discovered].reverse().find(c=>states.get(c.id)==='PASS')?.id??null};
}
