import {PendingPromotion,promotionMessage} from './release-promotion.js';
import {promotedController} from './bounded-controller.js';
import {rejectedDispatch,retryAfterTime} from './bounded-retry-after.js';
import {manualProjectionBefore} from './bounded-manual-evidence.js';
import type {VerifiedWakeContext} from './bounded-initial-wake.js';
import {BoundedGitHub,candidateReader,TARGET,CENTRAL,digest,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {candidateFacts} from './bounded-candidate-evidence.js';
import {dispatchFixed} from './bounded-recheck-effects.js';
import {APP_BOT_ID} from './bounded-winget-evidence.js';
import {identityKey,objectKey,type Identity,type RecordState,type Registration} from './bounded-recheck.js';
import {applyVerifiedCandidateEvent} from './bounded-release-event.js';
const minute=60000,prepareOffsets=[0,1,5,15],confirmOffsets=[1,5,15];
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export interface NativeHint {repositoryId:number;prNumber:number;actorId:number;action:'labeled'|'unlabeled'|'reopened';updatedAt:string}
export interface PreparedEvent {event:{repositoryId:number;prNumber:number;eventId:number};t0:number;sourceSha:string;before:Record<string,unknown>;priorIdentity:Identity|null}
export interface NativeHandoff {claim:number;startedAt:number;steps:{sequence:number;target:string;action:string;expectedGeneration?:number;at:number;state:'INTENT'|'ACK'}[];status:'RESERVED'|'COMPLETE'|'INDETERMINATE'}
export interface NativeEventRecord {
 controllerAnchorSha?:string; waitingForPromotion?:string;
 schemaVersion:1;hint:NativeHint;requestKey:string;firstDeliveryId:string;policySha:string;deploymentSha:string;
 receivedAt:number;deadline:number;nextAt:number|null;preparations:number;confirmations:number;claim:number;
 status:'PREPARING'|'CONFIRMING'|'AWAITING_RECEIPT'|'REGISTERED'|'PREVIOUSLY_COMPLETED'|'PROTECTED'|'NEEDS_ATTENTION'|'PAUSED';
 handoff?:NativeHandoff;pausedFrom?:{status:'PREPARING'|'CONFIRMING'|'AWAITING_RECEIPT';nextAt:number};reason:string;prepared:PreparedEvent|null;dispatchedAt:number|null;knownRunId:number|null;evidence:unknown;receiptConsumed?:boolean;receiptDeferred?:boolean;receiptRetryUsed?:boolean;retryAfter?:number;lateReceipt?:{runId:number;attempt:number;at:number};
}
function exact(v:any,keys:string){ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys,'NATIVE_SCHEMA');}
export function nativeHintKey(h:NativeHint){return digest(JSON.stringify([h.repositoryId,h.prNumber,h.actorId,h.action,h.updatedAt])).slice(7);}
function validateHint(h:NativeHint){exact(h,'action,actorId,prNumber,repositoryId,updatedAt');ensure(Number.isSafeInteger(h.repositoryId)&&h.repositoryId>0&&Number.isSafeInteger(h.prNumber)&&h.prNumber>0&&Number.isSafeInteger(h.actorId)&&h.actorId>0&&['labeled','unlabeled','reopened'].includes(h.action)&&typeof h.updatedAt==='string'&&Number.isFinite(Date.parse(h.updatedAt)),'NATIVE_HINT');}
/** Only called after existing HMAC and organization checks. No Git/network read precedes durable acceptance. */
export async function acceptNativeCandidateEvent(env:BoundedEnv,event:string,payload:any,deliveryId:string){
 if(env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='pull_request'||payload.repository?.private!==false||!Number.isSafeInteger(payload.repository?.id)||!payload.installation?.id||payload.installation.id!==Number(env.INSTALLATION_ID)||!['labeled','unlabeled','reopened'].includes(payload.action))return;
 if(payload.action!=='reopened'&&payload.label?.name!=='release:editing')return;
 ensure(env.BOUNDED_RECHECK&&sha(env.BOUNDED_CONTROLLER_SHA)&&sha(env.BOUNDED_DEPLOYMENT_SHA),'NATIVE_CONFIGURATION');
 const repo=payload.repository;
 if(repo.id<=0||repo.fork===true||repo.archived===true||repo.disabled===true||
    (repo.visibility!==undefined&&repo.visibility!=='public')||!repo.default_branch)return;
 const pull=payload.pull_request;
 // Candidate discovery accepts only same-repository PRs into the default branch.
 // These signed facts are available before allocating an object or an alarm.
 if(pull?.state!=='open'||pull.merged!==false||pull.head?.repo?.id!==repo.id||
    pull.base?.repo?.id!==repo.id||pull.base?.ref!==repo.default_branch)return;
 const hint:NativeHint={repositoryId:repo.id,prNumber:payload.pull_request?.number,actorId:payload.sender?.id,action:payload.action,updatedAt:payload.pull_request?.updated_at};validateHint(hint);
 ensure(/^[A-Za-z0-9-]{1,128}$/.test(deliveryId),'NATIVE_DELIVERY');const key=nativeHintKey(hint),stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('native:v1:'+key));
 const result=await stub.fetch(new Request('https://bounded.internal/native-event',{method:'POST',body:JSON.stringify({hint,deliveryId})}));ensure(result.ok,'NATIVE_DURABLE_ACCEPTANCE');
}
/** Native completion delivery is only a locator for the already known normal Run. */
export async function acceptNativeCandidateCompletion(env:BoundedEnv,event:string,payload:any){
 if(env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='workflow_run'||payload.action!=='completed'||payload.repository?.id!==CENTRAL.id)return;
 const run=payload.workflow_run,match=/^Candidate event ([a-f0-9]{64})$/.exec(run?.display_title??'');if(!match||run.path!=='.github/workflows/release-candidate-event.yml')return;
 ensure(env.BOUNDED_RECHECK&&Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0&&sha(run.head_sha),'NORMAL_RECEIPT_LOCATOR');
 const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('native:v1:'+match[1]));const response=await stub.fetch(new Request('https://bounded.internal/native-receipt',{method:'POST',body:JSON.stringify({runId:run.id,attempt:run.run_attempt,policySha:run.head_sha})}));ensure(response.ok,'NORMAL_RECEIPT_ACCEPTANCE');
}
export async function resolveNativeEvent(g:GitReader,h:NativeHint):Promise<PreparedEvent>{
 g=await candidateReader(g,h.repositoryId);const target=g.target??TARGET;
 const facts=await candidateFacts(g,false,true);ensure(facts.pull.number===h.prNumber&&facts.pull.state==='open'&&!facts.pull.merged&&Array.isArray(facts.pull.labels),'NATIVE_CANDIDATE');
 const editing=facts.pull.labels.some((x:any)=>x.name==='release:editing');ensure(!(h.action==='labeled'&&!editing)&&!(h.action==='unlabeled'&&editing),'NATIVE_EVENT_SUPERSEDED');
 const events:any[]=[];let complete=false;
 for(let page=1;page<=5;page++){const part=await g.json(target.id,`/repos/${target.name}/issues/${h.prNumber}/events?per_page=100&page=${page}`);ensure(Array.isArray(part),'NATIVE_EVENTS');events.push(...part);if(part.length<100){complete=true;break;}}
 ensure(complete,'NATIVE_EVENT_PAGINATION');const hits=events.filter(e=>e.event===h.action&&e.actor?.id===h.actorId&&e.created_at===h.updatedAt&&(h.action==='reopened'||e.label?.name==='release:editing'));ensure(hits.length===1&&Number.isSafeInteger(hits[0].id),'NATIVE_EVENT_AMBIGUOUS');
 const e=await g.json(target.id,`/repos/${target.name}/issues/events/${hits[0].id}`);ensure(e.id===hits[0].id&&e.issue?.number===h.prNumber&&e.issue?.repository_url===`https://api.github.com/repos/${target.name}`&&e.actor?.id===h.actorId&&e.created_at===h.updatedAt&&e.event===h.action&&(h.action==='reopened'||e.label?.name==='release:editing'),'NATIVE_EVENT_BINDING');
 const main=await g.json(target.id,`/repos/${target.name}/git/ref/heads/${encodeURIComponent(target.defaultBranch)}`);ensure(sha(main.object?.sha),'NATIVE_SOURCE');
 return {event:{repositoryId:target.id,prNumber:h.prNumber,eventId:e.id},t0:Date.parse(e.created_at),sourceSha:main.object.sha,before:facts.evidence,priorIdentity:facts.priorIdentity};
}
async function objectPost(env:BoundedEnv,identity:Identity,action:string,body:unknown){ensure(env.BOUNDED_RECHECK,'NAMESPACE');const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('recheck:v1:'+digest(objectKey(identity)).slice(7)));const response=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify(body)}));ensure(response.ok,'NATIVE_OBJECT_CONTROL');return response.json() as Promise<any>;}
export async function verifyNormalResult(g:GitReader,r:NativeEventRecord,run:any){
 g=await candidateReader(g,r.hint.repositoryId);const target=g.target??TARGET;
 const p=r.prepared!;ensure(run.id===r.knownRunId&&run.run_attempt===1&&run.repository?.id===CENTRAL.id&&run.head_repository?.id===CENTRAL.id&&run.actor?.id===APP_BOT_ID&&run.path==='.github/workflows/release-candidate-event.yml'&&run.event==='workflow_dispatch'&&run.head_branch==='main'&&run.head_sha===r.policySha&&run.display_title===`Candidate event ${r.requestKey}`&&run.status==='completed'&&run.conclusion==='success','NORMAL_RUN');
 const a=await g.artifact(CENTRAL.id,run.id,`candidate-event-${r.requestKey}`,'result.json'),v=a.value;
 exact(v,'candidateIdentity,event,outcome,producer,reason,requestKey,schemaVersion,sourceSha,stateAfter,stateBefore,status');exact(v.producer,'attempt,controllerSha,repositoryId,runId');exact(v.event,'eventId,prNumber,repositoryId');
 ensure(v.schemaVersion===1&&v.requestKey===r.requestKey&&v.sourceSha===p.sourceSha&&v.producer.repositoryId===CENTRAL.id&&v.producer.runId===run.id&&v.producer.attempt===1&&v.producer.controllerSha===r.policySha&&Object.entries(p.event).every(([k,value])=>v.event[k]===value),'NORMAL_ARTIFACT_BINDING');
 const created=Date.parse(a.createdAt??''),start=Date.parse(run.run_started_at),end=Date.parse(run.updated_at),runCreated=Date.parse(run.created_at);ensure([created,start,end,runCreated].every(Number.isFinite)&&runCreated>=r.dispatchedAt!-1000&&runCreated<=r.dispatchedAt!+30000&&start>=runCreated&&created>=start&&created<=end,'NORMAL_ARTIFACT_WINDOW');
 exact(v.stateBefore,'documentDigest,head,path,prNumber,stateCommit');exact(v.stateAfter,'documentDigest,head,path,prNumber,stateCommit');ensure(Object.entries(p.before).every(([k,value])=>v.stateBefore[k]===value),'NORMAL_BEFORE');
 const current=await candidateFacts(g,false,true);ensure(Object.entries(current.evidence).every(([k,value])=>v.stateAfter[k]===value)&&current.pull.number===p.event.prNumber&&current.pull.state==='open'&&!current.pull.merged&&Array.isArray(current.pull.labels),'NORMAL_AFTER');
 const native=await g.json(target.id,`/repos/${target.name}/issues/events/${p.event.eventId}`);ensure(native.id===p.event.eventId&&native.issue?.number===p.event.prNumber&&native.issue?.repository_url===`https://api.github.com/repos/${target.name}`&&native.actor?.id===r.hint.actorId&&native.event===r.hint.action&&native.created_at===r.hint.updatedAt&&(native.event==='reopened'||native.label?.name==='release:editing')&&Date.parse(native.created_at)===p.t0,'NORMAL_NATIVE_EVENT');
 const main=await g.json(target.id,`/repos/${target.name}/git/ref/heads/${encodeURIComponent(target.defaultBranch)}`);ensure(main.object?.sha===p.sourceSha,'NORMAL_SOURCE_MOVED');const editing=current.pull.labels.some((x:any)=>x.name==='release:editing');
 const evidence={requestKey:v.requestKey,runId:run.id,attempt:1,artifactId:a.artifactId,digest:a.digest,outcome:v.outcome,reason:v.reason,stateAfter:v.stateAfter};
 if(editing||v.outcome==='paused'||v.outcome==='protected'||v.candidateIdentity===null||!current.identity||current.identity.sourceSha!==p.sourceSha)return {kind:'protected' as const,evidence};
 if(current.manual){ensure(v.reason==='MANUAL_VALIDATED','MANUAL_PRODUCER_PIN');const checked=await candidateFacts(g);ensure(identityKey(checked.identity)===identityKey(current.identity),'SOURCE_CHANGED');}
 exact(v.candidateIdentity,'artifactDigest,channel,cycleId,epoch,repositoryId,sourceSha,stage,upstreamPR,version');
 ensure(v.outcome===(current.manual?'manual_validated':'candidate_updated')&&v.status==='READY'&&identityKey(v.candidateIdentity)===identityKey(current.identity),'NORMAL_RESULT_NOT_READY');
 const registration:Registration={identity:current.identity,t0:p.t0,policySha:r.policySha,deploymentSha:r.deploymentSha};let wakeContext:VerifiedWakeContext|undefined;if(current.manual){const snapshot=await manualProjectionBefore(g,current);wakeContext={kind:'validated-manual-candidate',repositoryId:target.id,prNumber:p.event.prNumber,sourceSha:p.sourceSha,identityDigest:digest(identityKey(current.identity)),eventId:p.event.eventId,normalRunId:run.id,attempt:1,projectionPending:snapshot.pending,projectionBefore:snapshot.before};}
 return {kind:'ready' as const,registration,wakeContext,manualProducerSha:current.manual?.producer.controllerSha,editing,event:native,evidence,artifactId:a.artifactId,artifactDigest:a.digest};
}
export class NativeCandidateCoordinator {
 constructor(private storage:DurableObjectStorage,private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env),private clock:()=>number=Date.now){}
 private async save(t:DurableObjectTransaction,r:NativeEventRecord){await t.put('nativeEvent',r);if(r.nextAt===null)await t.deleteAlarm();else await t.setAlarm(r.nextAt);}
 async register(input:{hint:NativeHint;deliveryId:string}){
  validateHint(input.hint);const now=this.clock(),t0=Date.parse(input.hint.updatedAt);ensure(t0<=now&&sha(this.env.BOUNDED_CONTROLLER_SHA)&&sha(this.env.BOUNDED_DEPLOYMENT_SHA),'NATIVE_TIME_OR_PIN');
  const paused=await this.storage.get<NativeEventRecord>('nativeEvent');let resumeClaim:number|undefined;
  if(paused?.status==='PAUSED'&&paused.pausedFrom&&paused.requestKey===nativeHintKey(input.hint)&&this.env.BOUNDED_RECHECK_ENABLED==='true'&&(paused.controllerAnchorSha??paused.policySha)===this.env.BOUNDED_CONTROLLER_SHA&&paused.deploymentSha===this.env.BOUNDED_DEPLOYMENT_SHA&&now<paused.deadline&&now>=(paused.retryAfter??0)){const proof=await resolveNativeEvent(this.reader(),input.hint);ensure(proof.t0===t0&&(!paused.prepared||proof.sourceSha===paused.prepared.sourceSha&&JSON.stringify(proof.event)===JSON.stringify(paused.prepared.event)),'NATIVE_RESUME_SOURCE');resumeClaim=paused.claim;}
  return this.storage.transaction(async t=>{const old=await t.get<NativeEventRecord>('nativeEvent');if(old){ensure(old.requestKey===nativeHintKey(input.hint),'NATIVE_CONFLICT');if(old.status==='PAUSED'&&old.pausedFrom&&resumeClaim===old.claim){const at=this.clock();if(at>=old.deadline||(old.retryAfter??0)>=old.deadline){old.status='NEEDS_ATTENTION';old.reason='EVENT_WINDOW_EXHAUSTED';old.nextAt=null;}else{old.status=old.pausedFrom.status;old.nextAt=Math.min(Math.max(at,old.pausedFrom.nextAt,old.retryAfter??0),old.deadline);old.reason='VERIFIED_NATIVE_REDELIVERY_RESUME';}delete old.pausedFrom;await this.save(t,old);}return old;}
   const r:NativeEventRecord={schemaVersion:1,hint:input.hint,requestKey:nativeHintKey(input.hint),firstDeliveryId:input.deliveryId,policySha:this.env.BOUNDED_CONTROLLER_SHA!,deploymentSha:this.env.BOUNDED_DEPLOYMENT_SHA!,receivedAt:now,deadline:t0+120*minute,nextAt:now,preparations:0,confirmations:0,claim:0,status:'PREPARING',reason:'SIGNED_EVENT_DURABLE',prepared:null,dispatchedAt:null,knownRunId:null,evidence:null};if(now>=r.deadline){r.status='NEEDS_ATTENTION';r.reason='EVENT_EXPIRED';r.nextAt=null;}await this.save(t,r);return r;});
 }
 async alarm(){
  const now=this.clock();let claimed:NativeEventRecord|null=null;
  await this.storage.transaction(async t=>{const r=await t.get<NativeEventRecord>('nativeEvent');if(!r||!['PREPARING','CONFIRMING','AWAITING_RECEIPT'].includes(r.status)||r.nextAt===null||r.nextAt>now)return;
   if(r.handoff){if(now>=r.deadline){r.status='NEEDS_ATTENTION';r.reason='HANDOFF_WINDOW_EXHAUSTED';r.handoff.status='INDETERMINATE';r.nextAt=null;}else r.nextAt=r.deadline;await this.save(t,r);return;}
   if(this.env.BOUNDED_RECHECK_ENABLED!=='true'||(r.controllerAnchorSha??r.policySha)!==this.env.BOUNDED_CONTROLLER_SHA||r.deploymentSha!==this.env.BOUNDED_DEPLOYMENT_SHA){r.pausedFrom={status:r.status as 'PREPARING'|'CONFIRMING'|'AWAITING_RECEIPT',nextAt:r.nextAt};r.status='PAUSED';r.reason='QUIESCED_OR_PIN_CHANGED';r.nextAt=null;await this.save(t,r);return;}
   if(now>=r.deadline){r.status='NEEDS_ATTENTION';r.reason='EVENT_WINDOW_EXHAUSTED';r.nextAt=null;await this.save(t,r);return;}
   if(r.receiptDeferred){if((r.retryAfter??0)>now){r.nextAt=Math.min(r.retryAfter!,r.deadline);await this.save(t,r);return;}r.receiptDeferred=false;r.claim++;r.status=r.confirmations>=3?'AWAITING_RECEIPT':'CONFIRMING';r.nextAt=r.confirmations>=3?r.deadline:Math.min(Math.max(now,r.dispatchedAt!+confirmOffsets[r.confirmations]!*minute),r.deadline);await this.save(t,r);claimed={...structuredClone(r),receiptDeferred:true};return;}
   if(r.status==='AWAITING_RECEIPT'){r.nextAt=r.deadline;await this.save(t,r);return;}
   if((r.retryAfter??0)>now){r.nextAt=Math.min(r.retryAfter!,r.deadline);await this.save(t,r);return;}
   r.claim++;if(r.status==='PREPARING'){r.preparations++;const offset=prepareOffsets.slice(r.preparations).find(n=>r.receivedAt+n*minute>now);r.nextAt=offset===undefined?null:Math.min(r.receivedAt+offset*minute,r.deadline);if(r.nextAt===null){r.status='NEEDS_ATTENTION';r.reason='PREPARATION_UNAVAILABLE';}}
   else {r.confirmations++;const offset=confirmOffsets[r.confirmations];r.nextAt=offset===undefined?null:Math.min(r.dispatchedAt!+offset*minute,r.deadline);if(offset===undefined){r.status=r.knownRunId===null?'NEEDS_ATTENTION':'AWAITING_RECEIPT';r.reason=r.knownRunId===null?'UNKNOWN_DELIVERY':'KNOWN_RUN_AWAITING_RECEIPT';r.nextAt=r.knownRunId===null?null:r.deadline;}}
   await this.save(t,r);claimed=structuredClone(r);});
  if(!claimed)return;const r=claimed as NativeEventRecord;
  try{if(r.dispatchedAt===null)await this.prepare(r);else await this.confirm(r);}catch(error){
   if(error instanceof PendingPromotion && r.dispatchedAt===null && r.preparations<4 && this.env.BOUNDED_RECHECK){
    await this.storage.transaction(async t=>{
     const latest=await t.get<NativeEventRecord>('nativeEvent');
     if(!latest||latest.claim!==r.claim||latest.dispatchedAt!==null||latest.status!=='PREPARING')return;
     latest.waitingForPromotion=error.sha;await this.save(t,latest);
    });
    await promotionMessage(this.env,error.sha,'wait',{policy:error.sha,key:r.requestKey,kind:'native',generation:error.generation});
    // Preserve the original slot if enrollment fails. After acknowledgement only the
    // matching promotion or the original deadline should wake this unposted request.
    await this.storage.transaction(async t=>{
     const latest=await t.get<NativeEventRecord>('nativeEvent');
     if(!latest||latest.claim!==r.claim||latest.waitingForPromotion!==error.sha||latest.status!=='PREPARING')return;
     latest.nextAt=latest.deadline;await this.save(t,latest);
    });
    return;
   }
   if(r.dispatchedAt===null && error instanceof Error && ['PRIOR_RECORD_IDENTITY','PRIOR_VERSION_UNRESOLVED','PRIOR_OBSERVATION_RECEIPT','PRIOR_OBSERVATION_ORDER'].includes(error.message)){
    await this.storage.transaction(async t=>{const latest=await t.get<NativeEventRecord>('nativeEvent');
     if(latest?.claim!==r.claim || latest.dispatchedAt!==null || latest.status==='PAUSED')return;
     latest.status='NEEDS_ATTENTION';latest.reason=error.message;latest.nextAt=null;await this.save(t,latest);});
   }else await this.deferRateLimit(r,error,!!r.receiptDeferred);
  }
 }
 async wakePromoted(policy:string){
  await this.storage.transaction(async t=>{
   const r=await t.get<NativeEventRecord>('nativeEvent');
   if(!r||r.status!=='PREPARING'||r.dispatchedAt!==null||r.waitingForPromotion!==policy||this.clock()>=r.deadline||r.preparations>=4)return;
   delete r.waitingForPromotion;r.nextAt=Math.min(Math.max(this.clock(),r.retryAfter??0),r.deadline);await this.save(t,r);
  });
 }
 async receipt(input:{runId:number;attempt:number;policySha:string}){
  exact(input,'attempt,policySha,runId');const now=this.clock();let claimed:NativeEventRecord|null=null;
  await this.storage.transaction(async t=>{const r=await t.get<NativeEventRecord>('nativeEvent');if(!r||r.knownRunId!==input.runId||input.attempt!==1||input.policySha!==r.policySha||(r.controllerAnchorSha??r.policySha)!==this.env.BOUNDED_CONTROLLER_SHA||r.deploymentSha!==this.env.BOUNDED_DEPLOYMENT_SHA)return;
   if(r.handoff)return;
   if(now>=r.deadline){r.lateReceipt={runId:input.runId,attempt:input.attempt,at:now};await t.put('nativeEvent',r);return;}
   if(!['CONFIRMING','AWAITING_RECEIPT'].includes(r.status)||r.receiptConsumed||this.env.BOUNDED_RECHECK_ENABLED!=='true')return;
   r.receiptConsumed=true;if((r.retryAfter??0)>now){r.receiptDeferred=true;r.nextAt=Math.min(r.retryAfter!,r.deadline);await this.save(t,r);return;}r.claim++;await this.save(t,r);claimed=structuredClone(r);});
  if(claimed){try{await this.confirm(claimed);}catch(error){await this.deferRateLimit(claimed,error,true);}}
 }
 private async deferRateLimit(r:NativeEventRecord,error:unknown,receiptAttempt=false){
  const now=this.clock(),at=retryAfterTime(error,now,r.deadline);if(at===undefined)return;
  await this.storage.transaction(async t=>{const latest=await t.get<NativeEventRecord>('nativeEvent');if(!latest||latest.claim!==r.claim||latest.handoff||['REGISTERED','PREVIOUSLY_COMPLETED','PROTECTED'].includes(latest.status))return;latest.retryAfter=Math.max(latest.retryAfter??0,at);
   if(!receiptAttempt && r.dispatchedAt===null && latest.dispatchedAt!==null && latest.knownRunId===null && rejectedDispatch(error)){
    latest.dispatchedAt=null;latest.prepared=null;latest.confirmations=0;
    if(latest.preparations>=prepareOffsets.length){
     latest.status='NEEDS_ATTENTION';latest.reason='DISPATCH_RATE_LIMIT_EXHAUSTED';latest.nextAt=null;
     await this.save(t,latest);return;
    }
    latest.reason='DISPATCH_REJECTED';
    if(latest.status==='PAUSED')latest.pausedFrom={status:'PREPARING',nextAt:latest.retryAfter};
   }
   if(latest.status==='PAUSED'){await t.put('nativeEvent',latest);return;}
   if(latest.retryAfter>=latest.deadline){latest.status='NEEDS_ATTENTION';latest.reason='RATE_LIMIT_WINDOW_EXHAUSTED';latest.nextAt=null;}
   else if(receiptAttempt){if(latest.receiptRetryUsed){latest.status='NEEDS_ATTENTION';latest.reason='RECEIPT_RATE_LIMIT_EXHAUSTED';latest.nextAt=null;latest.receiptDeferred=false;}else{latest.receiptRetryUsed=true;latest.receiptDeferred=true;latest.status='AWAITING_RECEIPT';latest.reason='RECEIPT_RATE_LIMIT_DEFERRED';latest.nextAt=latest.retryAfter;}}
   else if(latest.dispatchedAt===null&&latest.preparations<prepareOffsets.length){latest.status='PREPARING';latest.nextAt=Math.max(latest.nextAt??now,latest.retryAfter);}
   else if(latest.dispatchedAt!==null&&latest.confirmations<confirmOffsets.length){latest.status='CONFIRMING';latest.nextAt=Math.max(latest.nextAt??now,latest.retryAfter);}
   else if(latest.knownRunId!==null){latest.status='AWAITING_RECEIPT';latest.nextAt=latest.receiptDeferred?latest.retryAfter:latest.deadline;}
   await this.save(t,latest);
  });
 }
 private async reserveHandoff(r:NativeEventRecord,evidence:unknown){return this.storage.transaction(async t=>{const current=await t.get<NativeEventRecord>('nativeEvent');if(!current||current.claim!==r.claim||current.handoff||current.status==='PAUSED'||this.clock()>=current.deadline||this.env.BOUNDED_RECHECK_ENABLED!=='true'||(current.controllerAnchorSha??current.policySha)!==this.env.BOUNDED_CONTROLLER_SHA||current.deploymentSha!==this.env.BOUNDED_DEPLOYMENT_SHA)return false;current.handoff={claim:r.claim,startedAt:this.clock(),steps:[],status:'RESERVED'};current.evidence=evidence;current.nextAt=current.deadline;await this.save(t,current);return true;});}
 private async handoffPost(r:NativeEventRecord,identity:Identity,action:string,body:any){
  const sequence=await this.storage.transaction(async t=>{const current=await t.get<NativeEventRecord>('nativeEvent');ensure(current?.handoff?.claim===r.claim&&current.claim===r.claim&&current.handoff.status==='RESERVED'&&['CONFIRMING','AWAITING_RECEIPT'].includes(current.status),'HANDOFF_FENCE');ensure(this.clock()<current.deadline&&this.env.BOUNDED_RECHECK_ENABLED==='true'&&(current.controllerAnchorSha??current.policySha)===this.env.BOUNDED_CONTROLLER_SHA&&current.deploymentSha===this.env.BOUNDED_DEPLOYMENT_SHA,'HANDOFF_WINDOW_OR_PIN');const sequence=current.handoff.steps.length;current.handoff.steps.push({sequence,target:identityKey(identity),action,...(body.expectedGeneration===undefined?{}:{expectedGeneration:body.expectedGeneration}),at:this.clock(),state:'INTENT'});await this.save(t,current);return sequence;});
  const value=await objectPost(this.env,identity,action,body);
  await this.storage.transaction(async t=>{const current=await t.get<NativeEventRecord>('nativeEvent');ensure(current?.handoff?.claim===r.claim&&current.handoff.steps[sequence]?.state==='INTENT','HANDOFF_ACK_FENCE');current.handoff.steps[sequence]!.state='ACK';await t.put('nativeEvent',current);});return value;
 }
 private async failHandoff(r:NativeEventRecord){await this.storage.transaction(async t=>{const current=await t.get<NativeEventRecord>('nativeEvent');if(!current?.handoff||current.handoff.claim!==r.claim)return;current.handoff.status='INDETERMINATE';current.status='NEEDS_ATTENTION';current.reason='HANDOFF_INDETERMINATE';current.nextAt=null;await this.save(t,current);});}
 private async checkPrior(record:RecordState|null,identity:Identity,r:NativeEventRecord,t0:number) {
  if(!record)return;
  ensure(identityKey(record.identity)===identityKey(identity),'PRIOR_RECORD_IDENTITY');
  if(record.policySha===r.policySha && record.deploymentSha===r.deploymentSha)return;
  ensure(record.schemaVersion===1 && record.status==='DONE' && record.reason==='VERIFIED_DONE' && record.nextAt===null &&
    record.notificationPending===false && sha(record.policySha) && sha(record.deploymentSha) && record.intent &&
    Number.isSafeInteger(record.intent.sequence) && record.intent.sequence>=0 &&
    record.intent.key===digest(identityKey(identity)+':'+record.intent.sequence).slice(7) && record.evidence && t0>record.t0 &&
    t0>record.intent.claimedAt,'PRIOR_VERSION_UNRESOLVED');
  const receipt=JSON.parse(record.evidence);
  ensure(Number.isSafeInteger(receipt.runId) && receipt.runId>0 && receipt.attempt===1 &&
    Number.isSafeInteger(receipt.artifactId) && receipt.artifactId>0 && /^sha256:[a-f0-9]{64}$/.test(receipt.digest) &&
    (record.intent.runId===undefined || record.intent.runId===receipt.runId),'PRIOR_OBSERVATION_RECEIPT');
  const run=await this.reader().json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/${receipt.runId}/attempts/1`);
  ensure(run.id===receipt.runId && run.run_attempt===1 && run.actor?.id===APP_BOT_ID &&
    run.repository?.id===CENTRAL.id && run.head_repository?.id===CENTRAL.id &&
    run.path==='.github/workflows/release-observe.yml' && run.event==='workflow_dispatch' &&
    run.head_sha===(record.intent.executionPolicySha??record.policySha) && run.head_branch==='main' && run.status==='completed' &&
    run.conclusion==='success' && run.display_title===`Observe candidate ${record.intent.key}` &&
    Date.parse(run.updated_at)>=record.t0 && Date.parse(run.updated_at)<t0,'PRIOR_OBSERVATION_ORDER');
 }
 private async prepare(r:NativeEventRecord){
  const g=this.reader();
  let candidate:GitReader;
  try {candidate=await candidateReader(g,r.hint.repositoryId);}
  catch(error){
   if(!(error instanceof Error)||error.message!=='CANDIDATE_NOT_REGISTERED')throw error;
   await this.storage.transaction(async t=>{
    const latest=await t.get<NativeEventRecord>('nativeEvent');
    if(!latest||latest.claim!==r.claim||latest.dispatchedAt!==null||latest.status==='PAUSED')return;
    latest.status='PROTECTED';latest.reason='CANDIDATE_NOT_REGISTERED';latest.nextAt=null;
    await this.save(t,latest);
   });
   return;
  }
  const policy=await promotedController(g,this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA??r.deploymentSha,this.env);
  const prepared=await resolveNativeEvent(candidate,r.hint);ensure(prepared.t0===Date.parse(r.hint.updatedAt),'NATIVE_ORIGINAL_TIME');
  if(prepared.priorIdentity){const current=await objectPost(this.env,prepared.priorIdentity,'status',{});await this.checkPrior(current,prepared.priorIdentity,{...r,policySha:policy},prepared.t0);if(current?.status==='PENDING')await objectPost(this.env,prepared.priorIdentity,'pause',{expectedGeneration:current.generation});}
  await dispatchFixed(g,CENTRAL.id,'release-candidate-event.yml',policy,{event_json:JSON.stringify(prepared.event),source_sha:prepared.sourceSha,request_key:r.requestKey,policy_sha:policy},async()=>{
   const now=this.clock();
   return this.storage.transaction(async t=>{
    const latest=await t.get<NativeEventRecord>('nativeEvent');
    if(!latest||latest.claim!==r.claim||latest.dispatchedAt!==null||latest.status==='PAUSED'||now>=latest.deadline)return false;
    if(policy!==latest.policySha){latest.controllerAnchorSha=latest.controllerAnchorSha??latest.policySha;latest.policySha=policy;}
    latest.prepared=prepared;latest.dispatchedAt=now;latest.status='CONFIRMING';latest.reason='NORMAL_DISPATCH_INTENT';latest.nextAt=Math.min(now+minute,latest.deadline);
    await this.save(t,latest);return true;
   });
  });
 }
 private async confirm(r:NativeEventRecord){
  const g=this.reader();let id=r.knownRunId;
  if(id===null){const window=encodeURIComponent(new Date(r.dispatchedAt!-1000).toISOString()+'..'+new Date(r.dispatchedAt!+30000).toISOString());const list=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/workflows/release-candidate-event.yml/runs?event=workflow_dispatch&head_sha=${r.policySha}&created=${window}&per_page=100`);ensure(Array.isArray(list.workflow_runs)&&list.total_count===list.workflow_runs.length,'NORMAL_RUN_PAGINATION');const hits=list.workflow_runs.filter((x:any)=>x.display_title===`Candidate event ${r.requestKey}`&&x.actor?.id===APP_BOT_ID&&x.repository?.id===CENTRAL.id&&x.head_repository?.id===CENTRAL.id&&x.head_sha===r.policySha&&x.head_branch==='main'&&x.event==='workflow_dispatch'&&x.path==='.github/workflows/release-candidate-event.yml');ensure(hits.length===1,'NORMAL_RUN_UNKNOWN');id=hits[0].id;}
  ensure(Number.isSafeInteger(id)&&id!>0,'NORMAL_RUN_ID');r.knownRunId=id;
  const run=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/${id}/attempts/1`);ensure(run.id===id&&run.run_attempt===1&&run.head_sha===r.policySha&&run.path==='.github/workflows/release-candidate-event.yml'&&run.display_title===`Candidate event ${r.requestKey}`&&run.actor?.id===APP_BOT_ID&&run.repository?.id===CENTRAL.id&&run.head_repository?.id===CENTRAL.id&&run.head_branch==='main'&&run.event==='workflow_dispatch','NORMAL_RUN_BINDING');
  const bound=await this.storage.transaction(async t=>{const latest=await t.get<NativeEventRecord>('nativeEvent');if(!latest||latest.claim!==r.claim||latest.status==='PAUSED')return false;latest.knownRunId=id;if(latest.confirmations>=3){latest.status='AWAITING_RECEIPT';latest.reason='KNOWN_RUN_AWAITING_RECEIPT';latest.nextAt=latest.deadline;}await this.save(t,latest);return true;});if(!bound||run.status!=='completed')return;
  const verified=await verifyNormalResult(g,r,run);const now=this.clock();if(now>=r.deadline)return;
  let previous:Awaited<ReturnType<typeof applyVerifiedCandidateEvent>>;
  if(verified.kind==='ready'){
   if(!await this.reserveHandoff(r,verified.evidence))return;
   try{if(r.prepared?.priorIdentity&&identityKey(r.prepared.priorIdentity)!==identityKey(verified.registration.identity)){const old=await this.handoffPost(r,r.prepared.priorIdentity,'status',{});await this.checkPrior(old,r.prepared.priorIdentity,r,r.prepared.t0);if(old&&['PENDING','PAUSED'].includes(old.status))await this.handoffPost(r,r.prepared.priorIdentity,'cancel',{expectedGeneration:old.generation});}
    const stub={fetch:async(request:Request)=>Response.json(await this.handoffPost(r,verified.registration.identity,new URL(request.url).pathname.slice(1),await request.json()))};previous=await applyVerifiedCandidateEvent(stub as any,verified,{priorIdentity:r.prepared!.priorIdentity,stateAfter:verified.evidence.stateAfter,manualProducerSha:verified.manualProducerSha,eventId:r.prepared!.event.eventId,normalRunId:run.id,requestKey:r.requestKey,producerKey:verified.evidence.requestKey,producerRunId:verified.evidence.runId,eventT0:r.prepared!.t0});
   }catch{await this.failHandoff(r);return;}
  }
  await this.storage.transaction(async t=>{const current=await t.get<NativeEventRecord>('nativeEvent');if(!current||current.claim!==r.claim||current.status==='PAUSED')return;if(this.clock()>=current.deadline){current.status='NEEDS_ATTENTION';current.reason='EVENT_WINDOW_EXHAUSTED';if(current.handoff)current.handoff.status='INDETERMINATE';}else{current.status=previous?'PREVIOUSLY_COMPLETED':verified.kind==='ready'?'REGISTERED':'PROTECTED';current.reason=previous?'VERIFIED_PREVIOUS_COMPLETION':verified.kind==='ready'?'VERIFIED_NORMAL_HANDOFF':'PROTECTED_NOT_READY';if(current.handoff)current.handoff.status='COMPLETE';}current.evidence=previous?{...verified.evidence,previousCompletion:previous}:verified.evidence;current.knownRunId=id;current.nextAt=null;await this.save(t,current);});
 }
}
