import {createHash} from 'node:crypto';
import {decodeCompletionArchive,reconcileCycleHistory,type CompletionArchive,type CycleCompletionFact,type CycleHistoryFact,type RepairDecisionFact} from '../../core/src/release-history.js';
import {evaluateCompletion,type CycleRecord,type RepositoryRecord} from '../../core/src/release-observation.js';
import {NativeEvidenceReader,type EvidenceTransport} from './native-release-evidence.js';

interface ProtectedRecord {path:string;commit:string;value:any;content?:string}
export interface HistorySnapshot {
  repositoryId:number;repository:string;defaultBranch:string;appBotId:number;head:string;defaultHead:string;releaseAdoption:{sourceSha:string;prNumber:number}|null;
  reachable:string[];cycles:{value:CycleRecord}[];domainRecords:ProtectedRecord[];
  cycleHistory?:{commit:string;value:CycleRecord}[];
  repositoryHistory:{commit:string;committedAt:string;value:RepositoryRecord}[];
}
export function completionFile(value:CompletionArchive) {
  const content=JSON.stringify(value)+'\n',sha256=createHash('sha256').update(content).digest('hex');decodeCompletionArchive(Buffer.from(content));
  return {path:`evidence/completion/${sha256}.json`,content,sha256};
}
/** Full native PR enumeration is cross-checked with actual Git reachability and retained candidate identities. */
export async function inspectCycleHistory(snapshot:HistorySnapshot,io:EvidenceTransport,now:string,
  fresh?: (cycle:CycleRecord)=>Promise<CycleCompletionFact|undefined>,originalState?: (commit:string)=>Promise<{cycles:CycleRecord[];completions:CompletionArchive[]}>,
  verifySource?: (pr:any,cycle:CycleRecord|undefined)=>Promise<boolean>,handoff?:CycleRecord) {
  const reader=new NativeEvidenceReader(io,snapshot.repository),discovered:CycleHistoryFact[]=[],decisions:RepairDecisionFact[]=[],completions:CycleCompletionFact[]=[];
  const reasons:string[]=[],nativePulls:any[]=[],nativeDecisions:any[]=[];
  let complete=!!snapshot.releaseAdoption,repairActorId=0;
  // This proposal comes from the fixed adapter after it verifies the merged PR,
  // reviewed tree and archived generation. It is not an admitted old obligation.
  if(handoff&&snapshot.cycles.some(record=>record.value.id===handoff.id))throw new Error('RELEASE_HISTORY: handoff already admitted');
  const edgeCycles=snapshot.cycles.map(({value})=>structuredClone(value));
  const repository=await reader.json('');
  if(repository.id!==snapshot.repositoryId||repository.full_name!==snapshot.repository||repository.default_branch!==snapshot.defaultBranch
    ||repository.archived!==false||repository.disabled!==false)throw new Error('RELEASE_HISTORY: native repository identity');
  const head=async()=>({defaultHead:(await reader.json(`commits/${encodeURIComponent(snapshot.defaultBranch)}`)).sha,
    stateHead:(await reader.json('git/ref/heads/steward/release-state')).object?.sha});
  const before=await head();
  if(before.defaultHead!==snapshot.defaultHead||before.stateHead!==snapshot.head)complete=false;
  try {
    const closed=await reader.pages('pulls?state=closed&sort=created&direction=asc',''),pulls=new Map(closed.map(p=>[p.number,p]));
    // There is no recent-N window. Every reachable commit since the adopted boundary is covered.
    for(const commit of snapshot.reachable)for(const pr of await reader.pages(`commits/${commit}/pulls`,''))pulls.set(pr.number,pr);
    const candidates=snapshot.repositoryHistory.flatMap(record=>record.value.candidate?[record.value.candidate]:[]),branches=new Set(['steward/release-candidate',...candidates.map(c=>c.branch)]);
    for(const list of pulls.values()) {
      const known=candidates.some(c=>c.prNumber===list.number),possible=known||branches.has(list.head?.ref);
      if(!possible)continue;
      const pr=await reader.json(`pulls/${list.number}`);nativePulls.push(pr);
      if(!pr.merged)continue;
      if(pr.base?.repo?.id!==snapshot.repositoryId||pr.base?.ref!==snapshot.defaultBranch||pr.head?.repo?.id!==snapshot.repositoryId
        ||!branches.has(pr.head?.ref)||pr.user?.id!==snapshot.appBotId) {complete=false;reasons.push('CANDIDATE_IDENTITY_UNPROVEN');continue;}
      if(!snapshot.reachable.includes(pr.merge_commit_sha))continue;
      discovered.push({id:`pr-${pr.number}-${pr.merge_commit_sha}`,prNumber:pr.number,sourceSha:pr.merge_commit_sha,mergedAt:pr.merged_at});
      const cycle=snapshot.cycles.find(r=>r.value.prNumber===pr.number&&r.value.sourceSha===pr.merge_commit_sha)?.value
        ??(handoff&&handoff.prNumber===pr.number&&handoff.sourceSha===pr.merge_commit_sha?handoff:undefined);
      if(!verifySource||!await verifySource(pr,cycle)) {
        complete=false;reasons.push('NATIVE_SOURCE_VERSION_UNPROVEN');
      }
    }
  }catch{complete=false;reasons.push('NATIVE_HISTORY_UNAVAILABLE');}
  for(const record of snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/completion/'))) {
    try {
      const value=decodeCompletionArchive(Buffer.from(JSON.stringify(record.value))),file=completionFile(value);
      if(file.path!==record.path||value.source.units.some(unit=>unit.authorId!==snapshot.appBotId)||!/^[a-f0-9]{40}$/.test(record.commit))throw new Error('completion provenance');
      const provenanceComplete=value.provenance.every(proof=>snapshot.domainRecords.some(raw=>raw.path===proof.path&&/^[a-f0-9]{40}$/.test(raw.commit)
        &&raw.content!==undefined&&createHash('sha256').update(raw.content).digest('hex')===proof.digest));
      completions.push({cycleId:value.cycleId,source:value.source,observation:value.observation,kind:'historical',provenanceComplete});
    }catch{complete=false;reasons.push('COMPLETION_ARCHIVE_INVALID');}
  }
  if(handoff&&discovered.filter(fact=>fact.id===handoff.id&&fact.prNumber===handoff.prNumber&&fact.sourceSha===handoff.sourceSha).length!==1) {
    complete=false;reasons.push('HANDOFF_SOURCE_UNPROVEN');
  }
  const previous=discovered.filter(fact=>fact.id!==handoff?.id);
  const latest=[...previous].sort((a,b)=>a.mergedAt.localeCompare(b.mergedAt)).at(-1)?.id;
  for(const {value:cycle} of snapshot.cycles)if(fresh&&(cycle.id===latest||!completions.some(fact=>fact.cycleId===cycle.id&&fact.provenanceComplete
    &&evaluateCompletion(fact.source,fact.observation,fact.observation.observedAt).result==='PASS'))) {
    try{const value=await fresh(cycle);if(value&&value.kind==='live')completions.push(value);}catch{reasons.push('FRESH_COMPLETION_UNAVAILABLE');}
  }
  // Re-read the actual source/PR identities after the observation window before adopting any derived cache.
  const after=await head();
  if(JSON.stringify(before)!==JSON.stringify(after))complete=false;
  for(const pr of nativePulls) {
    const current=await reader.json(`pulls/${pr.number}`);
    if(JSON.stringify([current.base?.repo?.id,current.base?.ref,current.head?.repo?.id,current.head?.ref,current.merged,current.merge_commit_sha])
      !==JSON.stringify([pr.base?.repo?.id,pr.base?.ref,pr.head?.repo?.id,pr.head?.ref,pr.merged,pr.merge_commit_sha]))complete=false;
  }
  const result=reconcileCycleHistory({repositoryId:snapshot.repositoryId,inventoryComplete:complete,cycles:edgeCycles,discovered:previous,
    completions,decisions,repairActorId,now});
  return {...result,inventoryComplete:complete,defaultHead:before.defaultHead,stateHead:before.stateHead,discovered,nativePulls,nativeDecisions,
    verifiedDecisions:decisions,edgeCycles,readReasons:reasons,pendingHandoff:handoff?.id??null};
}
