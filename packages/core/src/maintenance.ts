import {decodeBuildJson} from './build-manifest.js';

/** Historical record vocabulary. Retired workflows remain decodable, never eligible for recovery. */
export const maintenanceWorkflows = ['sync-managed.yml','settings-sync.yml','update-dependencies.yml','quality-language-summary.yml','governance-promotion.yml'] as const;
/** Current central recovery targets; settings and Renovate use their native providers. */
export const activeMaintenanceWorkflows = ['sync-managed.yml','quality-language-summary.yml','governance-promotion.yml'] as const;
export type MaintenanceWorkflow = typeof maintenanceWorkflows[number];
export function maintenanceJobKeys(file: MaintenanceWorkflow): readonly string[] {
  switch(file) {
    case 'sync-managed.yml': return ['bootstrap','templates','automation-health'];
    case 'settings-sync.yml': return ['settings-sync'];
    // Retain historical health-only attempts when reading an older dependency Run.
    case 'update-dependencies.yml': return ['targets','update','automation-health'];
    case 'quality-language-summary.yml': return ['quality-summary'];
    case 'governance-promotion.yml': return ['promote'];
  }
}
export interface MaintenanceJob {
  id:number; key:string; matrixIndex:number|null; attempt:number; conclusion:string;
  empty:string|null; found:string|null;
}
export interface MaintenanceRecord {
  schemaVersion:1; repositoryId:number; workflowFile:MaintenanceWorkflow; workflowId:number; runId:number;
  headSha:string; headBranch:string; event:string; createdAt:string; runAttempt:number; conclusion:string;
  jobs:MaintenanceJob[]; observedAt:string;
  requests:{fromAttempt:number; requestedAt:string; coordinatorRunId:number; coordinatorRunAttempt:number; responseStatus:number|null}[];
}
const check=(ok:unknown,code:string):void=>{if(!ok)throw new Error('MAINTENANCE_'+code);};
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const exact=(v:any,keys:string[])=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),'FIELDS');
const utc=(v:any)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const conclusions=['success','failure','cancelled','timed_out','action_required','skipped','neutral','stale','startup_failure'];
export const maintenanceFailed=(v:string)=>['failure','cancelled','timed_out','action_required','startup_failure'].includes(v);
export function decodeMaintenanceRecord(bytes:Uint8Array,repositoryId:number,path:string):MaintenanceRecord {
  const v=decodeBuildJson(bytes) as MaintenanceRecord;
  exact(v,['schemaVersion','repositoryId','workflowFile','workflowId','runId','headSha','headBranch','event','createdAt','runAttempt','conclusion','jobs','observedAt','requests']);
  check(v.schemaVersion===1&&repositoryId===1296724484&&v.repositoryId===repositoryId&&maintenanceWorkflows.includes(v.workflowFile),'SCOPE');
  check(positive(v.workflowId)&&positive(v.runId)&&positive(v.runAttempt)&&path===`maintenance/${v.runId}.json`,'IDENTITY');
  check(/^[a-f0-9]{40}$/.test(v.headSha)&&typeof v.headBranch==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(v.headBranch)
    &&['push','schedule','workflow_dispatch',...(v.workflowFile==='governance-promotion.yml'?['workflow_run']:[])].includes(v.event),'SOURCE');
  check(utc(v.createdAt)&&utc(v.observedAt)&&v.createdAt<=v.observedAt&&conclusions.includes(v.conclusion),'OBSERVATION');
  check(Array.isArray(v.jobs)&&v.jobs.length>0&&new Set(v.jobs.map(j=>j.id)).size===v.jobs.length,'JOBS');
  for(const j of v.jobs) {
    exact(j,['id','key','matrixIndex','attempt','conclusion','empty','found']);
    check(positive(j.id)&&positive(j.attempt)&&j.attempt<=v.runAttempt&&maintenanceJobKeys(v.workflowFile).includes(j.key)&&conclusions.includes(j.conclusion),'JOB');
    check(j.key==='update'?j.matrixIndex===null||Number.isSafeInteger(j.matrixIndex)&&Number(j.matrixIndex)>=0:j.matrixIndex===null,'MATRIX');
    check(j.key==='targets'?[j.empty,j.found].every(s=>s===null||conclusions.includes(s)):j.empty===null&&j.found===null,'MARKERS');
  }
  check(new Set(v.jobs.map(j=>JSON.stringify([j.key,j.matrixIndex,j.attempt]))).size===v.jobs.length,'DUPLICATE_JOB');
  check(Array.isArray(v.requests)&&v.requests.length<=2,'REQUESTS');
  for(const [i,r] of v.requests.entries()) {
    exact(r,['fromAttempt','requestedAt','coordinatorRunId','coordinatorRunAttempt','responseStatus']);
    check(positive(r.fromAttempt)&&r.fromAttempt<=v.runAttempt&&(!i||r.fromAttempt>=v.requests[i-1]!.fromAttempt)
      &&utc(r.requestedAt)&&r.requestedAt>=v.createdAt&&r.requestedAt<=v.observedAt&&positive(r.coordinatorRunId)&&positive(r.coordinatorRunAttempt)
      &&(r.responseStatus===null||Number.isInteger(r.responseStatus)&&r.responseStatus>=100&&r.responseStatus<=599),'REQUEST');
  }
  return structuredClone(v);
}
/** Classify complete native job facts, retaining prior successful jobs after partial reruns. */
export function maintenanceDisposition(record:MaintenanceRecord):'FAILED'|'SATISFIED'|'UNKNOWN'|'EXHAUSTED' {
  const attempts=[...new Set(record.jobs.map(j=>j.attempt))].sort((a,b)=>a-b);
  if(attempts.length!==record.runAttempt||attempts.some((attempt,i)=>attempt!==i+1))return 'UNKNOWN';
  const latest=new Map<string,MaintenanceJob>();
  for(const j of record.jobs) {const key=JSON.stringify([j.key,j.matrixIndex]);if(!latest.has(key)||latest.get(key)!.attempt<j.attempt)latest.set(key,j);}
  const business=[...latest.values()].filter(j=>j.key!=='automation-health');
  if(maintenanceJobKeys(record.workflowFile).filter(key=>key!=='automation-health').some(key=>!business.some(j=>j.key===key)))return 'UNKNOWN';
  const failures=new Set(record.jobs.filter(j=>j.key!=='automation-health'&&maintenanceFailed(j.conclusion)).map(j=>j.attempt));
  if(record.workflowFile==='update-dependencies.yml') {
    const targets=business.filter(j=>j.key==='targets'),updates=business.filter(j=>j.key==='update');
    if(targets.length!==1)return 'UNKNOWN';
    const t=targets[0]!;
    if(t.conclusion==='success') {
      if(t.empty==='success'&&t.found==='skipped')return updates.every(j=>j.conclusion==='skipped')?'SATISFIED':'UNKNOWN';
      if(t.found!=='success'||t.empty!=='skipped')return 'UNKNOWN';
      if(updates.some(j=>j.matrixIndex===null)||updates.map(j=>j.matrixIndex!).sort((a,b)=>a-b).some((n,i)=>n!==i))return 'UNKNOWN';
    }
  }
  if(business.some(j=>maintenanceFailed(j.conclusion)))return failures.size>=3||record.requests.length>=2?'EXHAUSTED':'FAILED';
  return business.every(j=>j.conclusion==='success')?'SATISFIED':'UNKNOWN';
}
export function assertMaintenanceProgress(before:MaintenanceRecord,after:MaintenanceRecord):void {
  for(const key of ['schemaVersion','repositoryId','workflowFile','workflowId','runId','headSha','headBranch','event','createdAt'] as const)check(before[key]===after[key],'IMMUTABLE_SOURCE');
  check(after.runAttempt>=before.runAttempt&&after.observedAt>=before.observedAt,'REGRESSION');
  for(const job of before.jobs)check(after.jobs.some(j=>JSON.stringify(j)===JSON.stringify(job)),'JOB_REMOVED');
  for(const [i,old] of before.requests.entries()) {
    const found=after.requests[i];check(found,'REQUEST_REMOVED');
    check(found!.fromAttempt===old.fromAttempt&&found!.requestedAt===old.requestedAt&&found!.coordinatorRunId===old.coordinatorRunId&&found!.coordinatorRunAttempt===old.coordinatorRunAttempt
      &&(old.responseStatus===null||found!.responseStatus===old.responseStatus),'REQUEST_CHANGED');
  }
}
