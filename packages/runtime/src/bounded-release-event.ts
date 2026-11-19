import type {VerifiedWakeContext} from './bounded-initial-wake.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {BoundedGitHub,TARGET,CENTRAL,digest,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {candidateFacts,verifiedProducer} from './bounded-candidate-evidence.js';
import {dispatchFixed} from './bounded-recheck-effects.js';
import {identityKey,objectKey,type Identity,type RecordState} from './bounded-recheck.js';
export interface CandidateEvent {repositoryId:number;prNumber:number;eventId:number}
export interface EventIntent {schemaVersion:1;event:CandidateEvent;requestKey:string;policySha:string;createdAt:number;deadline:number;checks:number;status:'PENDING'|'REGISTERED'|'NEEDS_ATTENTION'|'PAUSED';nextAt:number|null;reason:string}
/** Called only after the existing GitHub webhook HMAC + organization validation. */
export async function acceptBoundedCandidateEvent(env:BoundedEnv,event:string,payload:any,g:GitReader=new BoundedGitHub(env)){
 if(env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='pull_request'||payload.repository?.id!==TARGET.id||!['labeled','unlabeled','reopened'].includes(payload.action))return;
 if(payload.action!=='reopened'&&payload.label?.name!=='release:editing')return;
 ensure(env.BOUNDED_RECHECK&&/^[a-f0-9]{40}$/.test(env.BOUNDED_CONTROLLER_SHA??''),'BOUNDED_EVENT_CONFIGURATION');
 const facts=await candidateFacts(g);ensure(payload.pull_request?.number===facts.pull.number,'EVENT_CANDIDATE');
 const events:any[]=[];let complete=false;
 for(let page=1;page<=5;page++){const part=await g.json(TARGET.id,`/repos/${TARGET.name}/issues/${facts.pull.number}/events?per_page=100&page=${page}`);ensure(Array.isArray(part),'EVENT_LIST');events.push(...part);if(part.length<100){complete=true;break;}}
 ensure(complete,'EVENT_PAGINATION');const matches=events.filter(e=>e.event===payload.action&&e.actor?.id===payload.sender?.id&&e.created_at===payload.pull_request.updated_at&&(e.event==='reopened'||e.label?.name==='release:editing'));
 ensure(matches.length===1&&Number.isSafeInteger(matches[0].id),'EVENT_AMBIGUOUS');
 const native=matches[0];const hint:CandidateEvent={repositoryId:TARGET.id,prNumber:facts.pull.number,eventId:native.id};const requestKey=createHash('sha256').update(JSON.stringify(hint)).digest('hex');
 const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('event:v1:'+requestKey));
 const response=await stub.fetch(new Request('https://bounded.internal/event',{method:'POST',body:JSON.stringify({event:hint,requestKey,policySha:env.BOUNDED_CONTROLLER_SHA,createdAt:Date.parse(native.created_at)})}));ensure(response.ok,'EVENT_REGISTRATION_FAILED');
}
/** A finite bootstrap intent for one verified candidate event, not a generic work queue. */
export class CandidateEventCoordinator {
 constructor(private storage:DurableObjectStorage,private env:BoundedEnv,private g:()=>GitReader=()=>new BoundedGitHub(env),private clock:()=>number=Date.now){}
 async register(input:Omit<EventIntent,'schemaVersion'|'deadline'|'checks'|'status'|'nextAt'|'reason'>){
  const now=this.clock();ensure(input.event.repositoryId===TARGET.id&&input.policySha===this.env.BOUNDED_CONTROLLER_SHA&&Number.isFinite(input.createdAt)&&input.createdAt<=now,'EVENT_IDENTITY');
  let claimed=false;
  await this.storage.transaction(async t=>{const old=await t.get<EventIntent>('event');if(old){ensure(old.requestKey===input.requestKey&&JSON.stringify(old.event)===JSON.stringify(input.event)&&old.policySha===input.policySha&&old.createdAt===input.createdAt,'EVENT_CONFLICT');return;}
   const deadline=input.createdAt+2*60*60_000;const r:EventIntent={...input,schemaVersion:1,deadline,checks:0,status:now>deadline?'NEEDS_ATTENTION':'PENDING',nextAt:now>deadline?null:Math.min(now+60_000,deadline),reason:'BRIDGE_INTENT'};
   // Reuse createdAt as the original event T0; confirmations use dispatch intent time separately.
   await t.put('event',r);await t.put('eventClaimedAt',now);if(r.nextAt!==null)await t.setAlarm(r.nextAt);claimed=r.status==='PENDING';});
  if(claimed){try{await dispatchFixed(this.g(),CENTRAL.id,'bounded-release-event.yml',input.policySha,{request_key:input.requestKey,event_json:JSON.stringify(input.event),policy_sha:input.policySha});}catch{/* The committed intent is recoverable by GET only; never POST again. */}}
 }
 async alarm(){
  const now=this.clock();let claimed:EventIntent|null=null;
  await this.storage.transaction(async t=>{const r=await t.get<EventIntent>('event');if(!r||r.status!=='PENDING'||r.nextAt===null||r.nextAt>now)return;
   if(this.env.BOUNDED_RECHECK_ENABLED!=='true'||now>r.deadline||r.checks>=3){r.status=this.env.BOUNDED_RECHECK_ENABLED!=='true'?'PAUSED':'NEEDS_ATTENTION';r.reason='EVENT_WINDOW_STOPPED';r.nextAt=null;await t.put('event',r);await t.deleteAlarm();return;}
   const at=await t.get<number>('eventClaimedAt');ensure(at!==undefined,'EVENT_CLAIM');r.checks++;const offset=[1,5,15][r.checks];r.nextAt=offset===undefined?null:Math.min(at+offset*60_000,r.deadline);if(offset===undefined){r.status='NEEDS_ATTENTION';r.reason='UNKNOWN_DELIVERY';}
   await t.put('event',r);if(r.nextAt===null)await t.deleteAlarm();else await t.setAlarm(r.nextAt);claimed=r;});
  if(!claimed)return;const r=claimed as EventIntent;
  try{
   const g=this.g();const claimedAt=await this.storage.get<number>('eventClaimedAt');ensure(claimedAt!==undefined,'EVENT_CLAIM');
   const window=encodeURIComponent(new Date(claimedAt-30_000).toISOString()+'..'+new Date(claimedAt+30_000).toISOString());
   const list=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/workflows/bounded-release-event.yml/runs?event=workflow_dispatch&head_sha=${r.policySha}&created=${window}&per_page=100`);ensure(Array.isArray(list.workflow_runs)&&list.workflow_runs.length===list.total_count,'EVENT_RUN_WINDOW');
   const runs=list.workflow_runs.filter((x:any)=>x.repository?.id===CENTRAL.id&&x.path==='.github/workflows/bounded-release-event.yml'&&x.head_sha===r.policySha&&x.display_title===`Bounded release event ${r.requestKey}`&&x.event==='workflow_dispatch');ensure(runs.length===1,'EVENT_RUN_UNKNOWN');const run=runs[0];
   if(run.status!=='completed'||run.conclusion!=='success')return;
   const a=await g.artifact(CENTRAL.id,run.id,`bounded-recheck-registration-${r.requestKey}`,'registration.json');
   const verified=await verifiedProducer(g,this.env,{registration:a.value.registration,producer:{repositoryId:CENTRAL.id,runId:run.id,attempt:run.run_attempt,requestKey:r.requestKey}});
   ensure(this.env.BOUNDED_RECHECK,'NAMESPACE');const name='recheck:v1:'+createHash('sha256').update(objectKey(verified.registration.identity)).digest('hex');const stub=this.env.BOUNDED_RECHECK.get(this.env.BOUNDED_RECHECK.idFromName(name));
   await applyVerifiedCandidateEvent(stub,verified);
   await this.storage.transaction(async t=>{const latest=await t.get<EventIntent>('event');if(latest?.requestKey!==r.requestKey||latest.status==='PAUSED')return;latest.status='REGISTERED';latest.reason='VERIFIED_PRODUCER_REGISTERED';latest.nextAt=null;await t.put('event',latest);await t.deleteAlarm();});
  }catch{/* Durable next confirmation or final UNKNOWN_DELIVERY already committed. */}
 }
}

interface CompletedManualReplay {
 priorIdentity: Identity | null;
 stateAfter: unknown;
 manualProducerSha?: string;
 eventId:number; normalRunId:number; requestKey:string; producerKey:string; producerRunId:number; eventT0:number;
}
function previousCompletion(record:RecordState,context:VerifiedWakeContext,replay:CompletedManualReplay) {
 ensure(record.schemaVersion===1 && record.status==='DONE' && record.reason==='VERIFIED_DONE' &&
   record.nextAt===null && record.notificationPending===false && record.identity.stage==='candidate' &&
   /^[0-9a-f]{40}$/.test(record.policySha) && /^[0-9a-f]{40}$/.test(record.deploymentSha) &&
   record.policySha===replay.manualProducerSha && replay.eventT0>record.t0 &&
   replay.eventId===context.eventId && replay.normalRunId===context.normalRunId && context.attempt===1 &&
   replay.producerRunId===context.normalRunId && replay.requestKey===replay.producerKey &&
   replay.priorIdentity && identityKey(replay.priorIdentity)===identityKey(record.identity) &&
   context.kind==='validated-manual-candidate' && !context.projectionPending &&
   context.identityDigest===digest(identityKey(record.identity)),'EVENT_OBJECT_IDENTITY');
 const intent=record.intent;
 ensure(intent && replay.eventT0>intent.claimedAt && Number.isSafeInteger(intent.sequence) && intent.sequence>=0 &&
   intent.key===digest(identityKey(record.identity)+':'+intent.sequence).slice(7) && record.evidence,'COMPLETION_RECEIPT_MISSING');
 const receipt=JSON.parse(record.evidence);
 ensure(Number.isSafeInteger(receipt.runId) && receipt.runId>0 && receipt.attempt===1 &&
   (intent.runId===undefined || intent.runId===receipt.runId) &&
   Number.isSafeInteger(receipt.artifactId) && receipt.artifactId>0 && /^sha256:[a-f0-9]{64}$/.test(receipt.digest) &&
   isDeepStrictEqual(receipt.state,replay.stateAfter) && isDeepStrictEqual(receipt.projectionEvidence,context.projectionBefore),
   'COMPLETION_RECEIPT_CHANGED');
 return {policySha:record.policySha,deploymentSha:record.deploymentSha,t0:record.t0,deadline:record.deadline,
   generation:record.generation,requestKey:intent.key,runId:receipt.runId,attempt:receipt.attempt,
   artifactId:receipt.artifactId,digest:receipt.digest};
}
/** Both bootstrap and authenticated event controls preserve the original object's window. */
export async function applyVerifiedCandidateEvent(stub:Pick<DurableObjectStub,'fetch'>,verified:Awaited<ReturnType<typeof verifiedProducer>>&{wakeContext?:VerifiedWakeContext},replay?:CompletedManualReplay){
 const post=async(action:string,body:unknown)=>{const response=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify(body)}));ensure(response.ok,'EVENT_OBJECT_CONTROL');return response.json() as Promise<any>;};
 let record=await post('status',{});if(record===null)record=await post('register',{registration:verified.registration,...(verified.wakeContext?{wakeContext:verified.wakeContext}:{})});
 // Only the verified native normal path supplies the protected state and projection.
 if(replay && verified.wakeContext && !verified.editing && identityKey(record.identity)===identityKey(verified.registration.identity) &&
    (record.policySha!==verified.registration.policySha || record.deploymentSha!==verified.registration.deploymentSha)){
   ensure(verified.registration.t0===replay.eventT0,'REPLAY_ORIGINAL_TIME');
   return previousCompletion(record,verified.wakeContext,replay);
 }
 ensure(identityKey(record.identity)===identityKey(verified.registration.identity)&&record.policySha===verified.registration.policySha&&record.deploymentSha===verified.registration.deploymentSha,'EVENT_OBJECT_IDENTITY');
 const action=verified.editing&&record.status==='PENDING'?'pause':!verified.editing&&record.status==='PAUSED'?'resume':null;
 if(action)await post(action,{expectedGeneration:record.generation});
}
