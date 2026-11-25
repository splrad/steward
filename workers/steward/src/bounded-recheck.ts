import {GitHubRetryError,retryAfterTime,rejectedDispatch} from './bounded-retry-after.js';
import { createHash } from 'node:crypto';
/** Bounded wake intents only. Git/Run/channel facts remain authoritative. */
export type Stage = 'candidate' | 'winget-pr' | 'winget-index';
export type Status = 'PENDING' | 'PAUSED' | 'CANCELLED' | 'DONE' | 'NEEDS_ATTENTION';
const minute = 60_000;
export const POLICIES = {
  'winget-pr': { offsets: [15,60,180,360,...Array.from({length:27},(_,i)=>(18+i*12)*60)], duration: 14*24*60 },
  'winget-index': { offsets: [5,15,30,60,120,240,...Array.from({length:7},(_,i)=>600+i*360)], duration: 48*60 },
} as const;
export interface Identity {
  repositoryId: number; cycleId: string; channel: 'candidate' | 'winget'; version: string;
  artifactDigest: string; sourceSha: string; stage: Stage; epoch: string;
  upstreamPR: { number: number; nodeId: string } | null;
}
export interface Registration { identity: Identity; t0: number; policySha: string; deploymentSha: string }
export interface Intent { key: string; sequence: number; claimedAt: number; confirmations: number; generation: number; runId?: number; retryAfter?:number; executionPolicySha?:string }
export interface RecordState extends Registration {
  schemaVersion: 1; status: Status; deadline: number; nextAt: number | null; nextSlot: number;
  consumed: number; initialClaimed: boolean; generation: number; intent: Intent | null;
  reason: string; evidence: string | null; notificationPending: boolean;
  retryAfter?:number;
  executionSha?:string;
  executionAnchorSha?:string;
  firstImmediateWake?: {kind:'normal'|'skipped'|'already-claimed';at:number;acceptance?:Record<string,unknown>};
}
export interface Store { transaction<T>(fn: (current: RecordState | null) => { record: RecordState | null; result: T }): Promise<T>; read(): Promise<RecordState | null> }
export type Outcome = { kind: 'pending'; retryAfter?: number } | { kind: 'done'; evidence: string } |
  { kind: 'stop'; reason: string } | { kind:'pause'; reason:string } | {kind:'index';mergedAt:number;evidence:string} | { kind: 'unknown'; runId?: number;retryAfter?:number };
/** These are fixed domain operations, never commands/URLs/workflow names from input. */
export interface Effects { observe(r: Readonly<RecordState>, intent: Readonly<Intent>): Promise<Outcome>; confirm(r: Readonly<RecordState>, intent: Readonly<Intent>): Promise<Outcome> }
const confirmations = [1,5,15].map(n=>n*minute);
function assert(v: unknown, message: string): asserts v { if(!v) throw new Error(message); }
function exactKeys(x: object, keys: string[]) { assert(Object.keys(x).sort().join(',')===keys.sort().join(','),'CLOSED_SCHEMA'); }
export function validateRegistration(v: Registration, now: number): void {
  assert(v && typeof v==='object','REGISTRATION'); exactKeys(v,['identity','t0','policySha','deploymentSha']);
  const i=v.identity; assert(i && typeof i==='object','IDENTITY');
  exactKeys(i,['repositoryId','cycleId','channel','version','artifactDigest','sourceSha','stage','epoch','upstreamPR']);
  assert((i.stage==='candidate'?Number.isSafeInteger(i.repositoryId)&&i.repositoryId>0:i.repositoryId===1187527897) && (i.stage==='candidate'||Object.hasOwn(POLICIES,i.stage)),'FIXED_TARGET');
  assert(i.channel===(i.stage==='candidate'?'candidate':'winget'),'STAGE_CHANNEL');
  for(const s of [i.cycleId,i.version,i.epoch]) assert(typeof s==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(s),'IDENTITY_STRING');
  assert(/^sha256:[a-f0-9]{64}$/.test(i.artifactDigest),'DIGEST');
  for(const s of [i.sourceSha,v.policySha,v.deploymentSha]) assert(/^[a-f0-9]{40}$/.test(s),'SOURCE_SHA');
  assert(Number.isSafeInteger(v.t0) && v.t0>0 && v.t0<=now,'ORIGINAL_T0');
  if(i.stage==='candidate') assert(i.upstreamPR===null,'CANDIDATE_PR');
  else { assert(i.upstreamPR && typeof i.upstreamPR==='object','UPSTREAM_PR'); exactKeys(i.upstreamPR,['number','nodeId']); assert(Number.isSafeInteger(i.upstreamPR.number)&&i.upstreamPR.number>0&&/^[A-Za-z0-9_=-]{1,128}$/.test(i.upstreamPR.nodeId),'UPSTREAM_PR'); }
}
export function identityKey(i: Identity): string { return JSON.stringify([i.repositoryId,i.cycleId,i.channel,i.version,i.artifactDigest,i.upstreamPR?.nodeId??null,i.upstreamPR?.number??null,i.stage,i.epoch,i.sourceSha]); }
export function objectKey(i:Identity):string {return identityKey({...i,stage:i.channel==='winget'?'winget-pr':i.stage});}
function stop(r:RecordState,status:Status,reason:string) { r.status=status;r.reason=reason;r.nextAt=null;r.generation++;r.notificationPending=status==='NEEDS_ATTENTION'; }
function next(r:RecordState, now:number, notBefore=now) {
  assert(r.identity.stage!=='candidate','CANDIDATE_OBSERVATION_RETIRED');
  const p=POLICIES[r.identity.stage];
  while(r.nextSlot<p.offsets.length && r.t0+p.offsets[r.nextSlot]!*minute<=now) r.nextSlot++;
  while(r.nextSlot<p.offsets.length && r.t0+p.offsets[r.nextSlot]!*minute<notBefore) r.nextSlot++;
  if(notBefore>r.deadline || now>=r.deadline) { stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');return; }
  r.nextAt=r.nextSlot<p.offsets.length?r.t0+p.offsets[r.nextSlot]!*minute:r.deadline;
}
export class BoundedRecheck {
  constructor(private store:Store,private effects:Effects,private clock:()=>number=Date.now,private executionSha?:string,
    private executionAnchorSha?:string) {}
  async register(input:Registration):Promise<RecordState> {
    const now=this.clock();
    validateRegistration(input,now);
    const stage=input.identity.stage;
    assert(stage!=='candidate','CANDIDATE_OBSERVATION_RETIRED');
    assert(typeof this.executionSha==='string'&&/^[a-f0-9]{40}$/.test(this.executionSha),'EXECUTION_PIN_REQUIRED');
    return this.store.transaction(r=>{
      if(r) { assert(identityKey(r.identity)===identityKey(input.identity) && r.t0===input.t0 && r.policySha===input.policySha && r.deploymentSha===input.deploymentSha,'REGISTRATION_CONFLICT');return {record:r,result:r}; }
      const record:RecordState={...input,executionSha:this.executionSha!,...(this.executionAnchorSha?{executionAnchorSha:this.executionAnchorSha}:{}),schemaVersion:1,status:'PENDING',deadline:input.t0+POLICIES[stage].duration*minute,nextAt:now,nextSlot:0,consumed:0,initialClaimed:false,generation:1,intent:null,reason:'REGISTERED',evidence:null,notificationPending:false};
      if(now>=record.deadline) stop(record,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');
      return {record,result:record};
    });
  }
  async control(action:'pause'|'resume'|'cancel',expectedGeneration:number):Promise<RecordState> {
    const now=this.clock(); return this.store.transaction(r=>{
      assert(r && r.generation===expectedGeneration,'STALE_GENERATION');
      assert(r.identity.stage!=='candidate','CANDIDATE_OBSERVATION_RETIRED');
      if(action==='cancel' && r.status!=='DONE') stop(r,'CANCELLED','CANCELLED');
      else if(action==='pause' && r.status==='PENDING') stop(r,'PAUSED','PAUSED');
      else if(action==='resume' && r.status==='PAUSED') {
        r.status='PENDING';r.generation++;
        // An in-flight/unknown POST cannot be forgotten by pause/resume.
        if(now>r.deadline||(!r.initialClaimed&&now===r.deadline)||Math.max(r.retryAfter??0,r.intent?.retryAfter??0)>r.deadline) stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');
        else if(r.intent) { r.intent.generation=r.generation;r.nextAt=Math.max(now,r.retryAfter??0,r.intent.retryAfter??0); }
        else if(!r.initialClaimed) r.nextAt=now;
        else next(r,now,r.retryAfter??now);
      }
      return {record:r,result:r};
    });
  }
  async wake():Promise<void> {
    const now=this.clock();
    const claim=await this.store.transaction(r=>{
      if(r?.identity.stage==='candidate')return {record:null,result:null};
      if(!r || r.status!=='PENDING'||r.nextAt===null||r.nextAt>now) return {record:r,result:null};
      if(now>r.deadline||(!r.initialClaimed&&now===r.deadline)||Math.max(r.retryAfter??0,r.intent?.retryAfter??0)>r.deadline) {stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');return {record:r,result:null};}
      if((r.retryAfter??0)>now){r.nextAt=Math.min(r.retryAfter!,r.deadline);return {record:r,result:null};}
      if(r.intent) {
        if(r.intent.confirmations>=3) {stop(r,'NEEDS_ATTENTION','UNKNOWN_DELIVERY');return {record:r,result:null};}
        r.intent.confirmations++;
        const following=confirmations[r.intent.confirmations];
        r.nextAt=following===undefined?null:Math.min(r.intent.claimedAt+following,r.deadline);
        if(following===undefined){ r.status='NEEDS_ATTENTION';r.reason='UNKNOWN_DELIVERY';r.notificationPending=true; }
        // Reserve the confirmation before GET; a crash never resets the allowance.
        return {record:r,result:{record:structuredClone(r),intent:structuredClone(r.intent),confirm:true}};
      }
      const p=POLICIES[r.identity.stage];
      if(r.initialClaimed && r.nextSlot>=p.offsets.length) {stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');return {record:r,result:null};}
      let sequence=0;
      if(r.initialClaimed) {sequence=r.nextSlot+1;r.nextSlot++;r.consumed++;} else r.initialClaimed=true;
      r.intent={key:createHash('sha256').update(`${identityKey(r.identity)}:${sequence}`).digest('hex'),sequence,claimedAt:now,confirmations:0,generation:r.generation};
      r.nextAt=Math.min(now+minute,r.deadline);
      return {record:r,result:{record:structuredClone(r),intent:structuredClone(r.intent),confirm:false}};
    });
    if(!claim)return;
    let outcome:Outcome;
    try {
      outcome = claim.confirm
        ? await this.effects.confirm(claim.record,claim.intent)
        : await this.effects.observe(claim.record,claim.intent);
    }
    catch (error) {
      const message=error instanceof Error?error.message:'';const retryAfter=retryAfterTime(error,this.clock(),claim.record.deadline);
      const retryableObservation=!claim.confirm && error instanceof GitHubRetryError && (!error.dispatchAttempted || rejectedDispatch(error));
      outcome=['SOURCE_CHANGED','OBSERVATION_SOURCE_CHANGED','CHANNEL_ORIGINAL_IDENTITY'].includes(message)?{kind:'stop',reason:'SOURCE_CHANGED'}:message==='CHANNEL_EXECUTION_PIN'?{kind:'stop',reason:message}:(retryableObservation||claim.record.identity.stage==='winget-pr')&&retryAfter!==undefined?{kind:'pending',retryAfter}:{kind:'unknown',...(retryAfter===undefined?{}:{retryAfter})};
    }
    await this.store.transaction(r=>{
      if(!r || !r.intent || r.intent.key!==claim.intent.key) return {record:r,result:undefined};
      if('retryAfter' in outcome && outcome.retryAfter !== undefined){r.retryAfter=Math.max(r.retryAfter??0,outcome.retryAfter);r.intent.retryAfter=r.retryAfter;if(r.status==='PENDING'&&r.nextAt!==null)r.nextAt=Math.min(Math.max(r.nextAt,r.retryAfter),r.deadline);}
      if(r.intent.generation!==claim.intent.generation || r.generation!==claim.record.generation || (r.status!=='PENDING' && !(claim.confirm && claim.intent.confirmations===3 && r.reason==='UNKNOWN_DELIVERY'))) {
        // A late verified fact is retained for handoff, never a new timer or permission.
        if(outcome.kind==='done'&&r.status!=='DONE')r.evidence=outcome.evidence;
        return {record:r,result:undefined};
      }
      const now=this.clock();
      if(outcome.kind==='index'&&now>r.deadline){r.evidence=outcome.evidence;stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');}
      else if(outcome.kind==='index') {
        assert(r.identity.stage==='winget-pr'&&Number.isSafeInteger(outcome.mergedAt)&&outcome.mergedAt>=r.t0&&outcome.mergedAt<=now,'INDEX_TRANSITION');
        r.identity={...r.identity,stage:'winget-index'};r.t0=outcome.mergedAt;r.deadline=outcome.mergedAt+POLICIES['winget-index'].duration*minute;
        r.status='PENDING';r.notificationPending=false;r.nextSlot=0;r.consumed=0;r.initialClaimed=false;r.intent=null;r.generation++;r.evidence=outcome.evidence;r.reason='MERGED_TO_INDEX';r.nextAt=now;
        if(now>r.deadline)stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');
      }
      else if(outcome.kind==='done') {r.evidence=outcome.evidence;if(now>r.deadline)stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');else stop(r,'DONE','VERIFIED_DONE');}
      else if(now>r.deadline) stop(r,'NEEDS_ATTENTION','WINDOW_EXHAUSTED');
      else if(outcome.kind==='pause') {if(!claim.confirm)r.intent=null;stop(r,'PAUSED',outcome.reason);}
      else if(outcome.kind==='stop') stop(r,'NEEDS_ATTENTION',outcome.reason);
      else if(outcome.kind==='pending') {r.status='PENDING';r.notificationPending=false;r.intent=null;next(r,now,outcome.retryAfter??now);}
      else {
        if(outcome.runId!==undefined)r.intent.runId=outcome.runId;
        if(r.intent.confirmations>=3 || now>=r.deadline || (outcome.retryAfter??0)>r.deadline) stop(r,'NEEDS_ATTENTION','UNKNOWN_DELIVERY');
        else { const at=r.intent.claimedAt+confirmations[r.intent.confirmations]!;r.nextAt=Math.min(Math.max(at,now,outcome.retryAfter??0),r.deadline); }
      }
      return {record:r,result:undefined};
    });
  }
}
