import {identityKey,type RecordState} from './bounded-recheck.js';
import {digest,ensure,type BoundedEnv} from './bounded-recheck-github.js';
export interface VerifiedWakeContext {kind:'validated-manual-candidate';repositoryId:number;prNumber:number;sourceSha:string;identityDigest:string;eventId:number;normalRunId:number;attempt:number;projectionPending:boolean;projectionBefore:{commentId:number|null;bodyDigest:string|null;previewDigest:string};}
function config(raw:string){const v=JSON.parse(raw);ensure(v&&Object.keys(v).sort().join(',')==='acceptanceId,controllerSha,deploymentSha,identityDigest,notAfter,prNumber,repositoryId,schemaVersion,sourceSha','ACCEPTANCE_SCHEMA');ensure(v.schemaVersion===1&&v.repositoryId===1187527897&&Number.isSafeInteger(v.prNumber)&&v.prNumber>0&&/^[a-f0-9]{64}$/.test(v.acceptanceId)&&/^sha256:[a-f0-9]{64}$/.test(v.identityDigest)&&[v.sourceSha,v.controllerSha,v.deploymentSha].every(s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s))&&typeof v.notAfter==='string'&&new Date(v.notAfter).toISOString()===v.notAfter,'ACCEPTANCE_FIELDS');return v;}
/** Only the independently verified normal/manual path supplies context. Public registration rejects it. */
export async function initialWake(storage:DurableObjectStorage,env:BoundedEnv,wake:()=>Promise<void>,context?:VerifiedWakeContext,clock:()=>number=Date.now){
 const now=clock();let immediate=false;
 await storage.transaction(async t=>{const r=await t.get<RecordState>('record');ensure(r,'INITIAL_WAKE_RECORD');if(r.firstImmediateWake)return;
  if(r.initialClaimed||r.intent||r.status!=='PENDING'||now>=r.deadline){r.firstImmediateWake={kind:'already-claimed',at:now};await t.put('record',r);return;}
  const c=env.BOUNDED_ACCEPTANCE_SKIP_ONCE?config(env.BOUNDED_ACCEPTANCE_SKIP_ONCE):null;
  const match=c&&context?.kind==='validated-manual-candidate'&&context.projectionPending===true&&r.identity.stage==='candidate'&&context.repositoryId===c.repositoryId&&context.prNumber===c.prNumber&&context.sourceSha===c.sourceSha&&context.identityDigest===c.identityDigest&&digest(identityKey(r.identity))===c.identityDigest&&r.identity.sourceSha===c.sourceSha&&r.policySha===c.controllerSha&&r.deploymentSha===c.deploymentSha&&env.BOUNDED_CONTROLLER_SHA===c.controllerSha&&env.BOUNDED_DEPLOYMENT_SHA===c.deploymentSha&&now<Date.parse(c.notAfter)&&Date.parse(c.notAfter)<=r.deadline;
  r.firstImmediateWake={kind:match?'skipped':'normal',at:now,...(match?{acceptance:{...c,eventId:context!.eventId,normalRunId:context!.normalRunId,attempt:context!.attempt,t0:r.t0,deadline:r.deadline,alarmAt:r.nextAt,projectionBefore:context!.projectionBefore}}:{})};
  ensure(r.nextAt!==null,'INITIAL_WAKE_ALARM');await t.put('record',r);await t.setAlarm(r.nextAt);immediate=!match;
 });
 if(immediate)await wake();
}
