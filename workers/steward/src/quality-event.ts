import {retryAfterTime} from './bounded-retry-after.js';
import {promotedController} from './bounded-controller.js';
import {PendingPromotion,promotionMessage} from './release-promotion.js';
import { BoundedGitHub, CENTRAL, digest, ensure, type BoundedEnv, type GitReader } from './bounded-recheck-github.js';
import { dispatchFixed } from './bounded-recheck-effects.js';

const qualityUser = 223894421;

export function qualityLocator(event:string, payload:any, installationId:number) {
  const repo=payload.repository;
  if (!repo || !Number.isSafeInteger(repo.id) || repo.id <= 0 || repo.private!==false || (repo.visibility!==undefined && repo.visibility!=='public') || repo.owner?.id!==302208797 ||
      repo.archived || repo.disabled || payload.installation?.id!==installationId) return;
  let number:number, head:string;
  if (event==='workflow_run') {
    const run=payload.workflow_run;
    if (payload.action!=='completed' || run?.status!=='completed' || run.conclusion!=='success' ||
        run.repository?.id!==repo.id || run.path!=='dynamic/github-code-quality/codeql' || run.event!=='dynamic') return;
    const match=/^refs\/pull\/([1-9]\d*)\/head$/.exec(run.head_branch);
    if (!match) return;
    number=Number(match[1]);
    head=run.head_sha;
  } else {
    const isReview=event==='pull_request_review' && ['submitted','edited','dismissed'].includes(payload.action);
    const isComment=event==='pull_request_review_comment' && ['created','edited','deleted'].includes(payload.action);
    if (!isReview && !isComment) return;
    const user=(isReview ? payload.review : payload.comment)?.user;
    const pr=payload.pull_request;
    if (user?.id!==qualityUser || user.type!=='Bot' || pr?.base?.repo?.id!==repo.id || pr.state!=='open') return;
    number=pr.number;
    head=pr.head?.sha;
  }
  if (!Number.isSafeInteger(number) || number<=0 || typeof head!=='string' || !/^[0-9a-f]{40}$/.test(head)) return;
  return {repository_id:String(repo.id),pull_number:String(number),head_sha:head};
}

type Target=NonNullable<ReturnType<typeof qualityLocator>>;
type QualityRecord={delivery:string;event:string;target:Target;phase:'pending'|'reserved'|'sent'|'excluded';policy?:string;retryAt?:number};
function qualityKey(r:QualityRecord){return digest(JSON.stringify([r.delivery,r.event,r.target.repository_id,r.target.pull_number,r.target.head_sha])).slice(7);}
async function approvedQualityRepository(reader:GitReader,policy:string,id:string) {
  const path='config/review/quality-language.json';
  const file=await reader.json(CENTRAL.id,`/repos/${CENTRAL.name}/contents/${path}?ref=${policy}`);
  ensure(file?.type==='file' && file.path===path && file.encoding==='base64' &&
    Number.isSafeInteger(file.size) && file.size>0 && file.size<=256*1024,'QUALITY_POLICY_FILE');
  const bytes=Buffer.from(file.content,'base64');
  ensure(bytes.length===file.size,'QUALITY_POLICY_SIZE');
  const config=JSON.parse(bytes.toString('utf8'));
  ensure(config.schemaVersion===1 && config.repositories && typeof config.repositories==='object' &&
    !Array.isArray(config.repositories),'QUALITY_POLICY_SCHEMA');
  const name=Object.hasOwn(config.repositories,id) ? config.repositories[id] : undefined;
  return typeof name==='string' && /^splrad\/[A-Za-z0-9_.-]+$/.test(name) ? name : undefined;
}
export async function dispatchQualityEvent(env:BoundedEnv,event:string,payload:any,delivery:string) {
  const target=qualityLocator(event,payload,Number(env.INSTALLATION_ID));
  if(!target||env.BOUNDED_RECHECK_ENABLED!=='true')return;
  ensure(env.BOUNDED_RECHECK&&/^[a-zA-Z0-9-]{1,128}$/.test(delivery),'QUALITY_DELIVERY');
  const reader=new BoundedGitHub(env);
  const ref=await reader.json(CENTRAL.id,`/repos/${CENTRAL.name}/git/ref/heads/steward/validated-controller`);
  ensure(ref.ref==='refs/heads/steward/validated-controller' && ref.object?.type==='commit' &&
    /^[a-f0-9]{40}$/.test(ref.object.sha),'QUALITY_CONTROLLER_REF');
  const name=await approvedQualityRepository(reader,ref.object.sha,target.repository_id);
  if(typeof name!=='string' || name!==payload.repository.full_name)return;
  const record:QualityRecord={delivery,event,target,phase:'pending'};
  const ns=env.BOUNDED_RECHECK,stub=ns.get(ns.idFromName('quality:v1:'+qualityKey(record)));
  const response=await stub.fetch(new Request('https://bounded.internal/quality-event',{method:'POST',body:JSON.stringify(record)}));
  ensure(response.ok,'QUALITY_REGISTRATION');
}
export class QualityEvent {
  constructor(private storage:DurableObjectStorage,private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env)){}
  async register(record:QualityRecord){
    await this.storage.transaction(async t=>{
      if(!await t.get('qualityEvent'))await t.put('qualityEvent',{...record,phase:'pending'});
    });
    await this.forward();
  }
  async alarm(){
    const current=await this.storage.get<QualityRecord>('qualityEvent');
    if(current?.phase!=='pending'||!current.retryAt||this.env.BOUNDED_RECHECK_ENABLED!=='true')return;
    if(current.retryAt>Date.now()){
      await this.storage.setAlarm(current.retryAt);
      return;
    }
    await this.forward();
  }
  async forward(){
    const record=await this.storage.get<QualityRecord>('qualityEvent');
    if(!record||record.phase==='sent'||record.phase==='excluded')return;
    ensure(record.phase==='pending','QUALITY_POST_UNCONFIRMED');
    ensure(!record.retryAt||Date.now()>=record.retryAt,'QUALITY_RATE_LIMIT');
    ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUALITY_QUIESCED');
    // The explicit release pin fences older controllers whose quality workflow lacks these inputs.
    const deployment=this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA;
    ensure(deployment,'QUALITY_DEPLOYMENT');
    const reader=this.reader();
    let policy:string;
    try{policy=await promotedController(reader,deployment,this.env);}
    catch(error){
      if(!(error instanceof PendingPromotion))throw error;
      await promotionMessage(this.env,deployment,'wait',{policy:deployment,key:qualityKey(record),kind:'quality',generation:error.generation});
      return;
    }
    if(!await approvedQualityRepository(reader,policy,record.target.repository_id)) {
      await this.storage.put('qualityEvent',{...record,phase:'excluded',policy});
      return;
    }
    let claimed=false;
    try{
      await dispatchFixed(reader,CENTRAL.id,'quality-language-summary.yml',policy,{...record.target,policy_sha:policy},async()=>{
        claimed=await this.storage.transaction(async t=>{
          const current=await t.get<QualityRecord>('qualityEvent');
          if(current?.phase!=='pending'||(current.retryAt&&Date.now()<current.retryAt))return false;
          await t.put('qualityEvent',{...current,phase:'reserved',policy});return true;
        });
        return claimed;
      });
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const retryAt=retryAfterTime(error,Date.now(),Number.MAX_SAFE_INTEGER-1);
      if(claimed && (retryAt!==undefined || /^GITHUB_HTTP_(400|401|403|404|409|410|422|429)$/.test(message))){
        const now=Date.now();
        const rateLimited=message==='GITHUB_HTTP_429'||retryAt!==undefined;
        const next=rateLimited && retryAt!==Number.MAX_SAFE_INTEGER ? Math.max(now+1000,retryAt??now+60000) : undefined;
        await this.storage.transaction(async t=>{
          await t.put('qualityEvent',{...record,phase:'pending',retryAt:next??retryAt??0});
          if(next)await t.setAlarm(next);
        });
      }
      throw error;
    }
    if(claimed)await this.storage.put('qualityEvent',{...record,phase:'sent',policy});
  }
}
