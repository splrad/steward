import {GitHubRetryError,retryAfterTime} from './bounded-retry-after.js';
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
type EventState={delivery:string;event:string;repositoryName?:string;phase:'pending'|'reserved'|'sent'|'excluded'|'unconfirmed'|'rejected';rejection?:string;policy?:string;retryAt?:number;aggregate?:boolean;expires?:number};
type QualityRecord=EventState & {kind?:'quality';target:Target};
const debounce=60_000,retention=30*86400_000;
function qualityKey(r:QualityRecord){return digest(JSON.stringify([...(r.aggregate?[]:[r.delivery,r.event]),r.target.repository_id,r.target.pull_number,r.target.head_sha])).slice(7);}
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
  const repositoryName=payload.repository.full_name;
  if(typeof repositoryName!=='string'||!/^splrad\/[A-Za-z0-9_.-]+$/.test(repositoryName))return;
  const record:QualityRecord={delivery,event,target,repositoryName,phase:'pending',aggregate:true};
  const ns=env.BOUNDED_RECHECK,stub=ns.get(ns.idFromName('quality:v1:'+qualityKey(record)));
  const response=await stub.fetch(new Request('https://bounded.internal/quality-event',{method:'POST',body:JSON.stringify(record)}));
  ensure(response.ok,'QUALITY_REGISTRATION');
}
export class WorkflowEvent {
  constructor(private storage:DurableObjectStorage,private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env)){}
  async register(record:QualityRecord){
    if(record.aggregate){
      await this.storage.transaction(async t=>{
        const seen=await t.get<string[]>('qualityDeliveries')??[];
        const uncertain=await t.get<{delivery:string;policy?:string;expires:number}[]>('qualityUnconfirmed')??[];
        const current=await t.get<QualityRecord>('qualityEvent'),now=Date.now();
        if(current?.phase==='pending' && current.retryAt && await t.getAlarm()===null){
          await t.setAlarm(Math.max(now,current.retryAt));
        }
        if(current?.delivery===record.delivery||seen.includes(record.delivery)||uncertain.some(entry=>entry.delivery===record.delivery&&now<entry.expires))return;
        if(current?.phase==='reserved'||current?.phase==='unconfirmed'){
          const entry={delivery:current.delivery,policy:current.policy,expires:current.expires??now+retention};
          await t.put('qualityUnconfirmed',[...uncertain.filter(item=>now<item.expires).slice(-127),entry]);
          console.error(JSON.stringify({operation:'workflow-dispatch-unconfirmed',kind:'quality',target:current.target,...entry}));
        }
        await t.put('qualityDeliveries',[...seen.slice(-127),record.delivery]);
        if(current?.phase==='pending' && current.retryAt){
          await t.put('qualityEvent',{...current,expires:now+retention});return;
        }
        const retryAt=now+debounce;
        await t.put('qualityEvent',{...record,retryAt,expires:now+retention});
        await t.setAlarm(retryAt);
      });
      return;
    }
    await this.storage.transaction(async t=>{
      const prior=await t.get<QualityRecord>('qualityEvent'),now=Date.now();
      if(!prior){
        await t.put('qualityEvent',{...record,phase:'pending',retryAt:now});
        await t.setAlarm(now);
      }
    });
    await this.forward();
  }
  async alarm(){
    const current=await this.storage.get<QualityRecord>('qualityEvent');
    if(!current)return;
    const now=Date.now();
    if(current.expires && now>=current.expires){
      await this.storage.transaction(async t=>{
        const latest=await t.get<QualityRecord>('qualityEvent');
        if(latest?.expires && Date.now()>=latest.expires){
          await t.delete('qualityEvent');await t.delete('qualityDeliveries');await t.delete('qualityUnconfirmed');await t.deleteAlarm();
        }
      });return;
    }
    if(current.phase==='reserved'){
      await this.storage.transaction(async t=>{
        const latest=await t.get<QualityRecord>('qualityEvent');
        if(latest?.delivery!==current.delivery||latest.phase!=='reserved')return;
        const expires=latest.expires??now+retention;
        await t.put('qualityEvent',{...latest,phase:'unconfirmed',expires});await t.setAlarm(expires);
        console.error(JSON.stringify({operation:'workflow-dispatch-unconfirmed',kind:latest.kind??'quality',target:latest.target,delivery:latest.delivery,policy:latest.policy}));
      });return;
    }
    if(current.phase!=='pending'||!current.retryAt)return;
    if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){
      const expires=current.expires??now+retention;
      await this.storage.transaction(async t=>{
        const latest=await t.get<QualityRecord>('qualityEvent');
        if(latest?.delivery!==current.delivery||latest.phase!=='pending')return;
        await t.put('qualityEvent',{...latest,expires});await t.setAlarm(Math.min(expires,now+5*debounce));
      });return;
    }
    if(current.retryAt>Date.now()){
      await this.storage.setAlarm(current.retryAt);
      return;
    }
    if(current.expires)await this.storage.setAlarm(current.expires);
    await this.forward();
  }
  async forward(){
    const record=await this.storage.get<QualityRecord>('qualityEvent');
    if(!record||record.phase==='sent'||record.phase==='excluded'||record.phase==='rejected')return;
    ensure(record.phase==='pending','QUALITY_POST_UNCONFIRMED');
    ensure(!record.retryAt||Date.now()>=record.retryAt,'QUALITY_RATE_LIMIT');
    ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUALITY_QUIESCED');
    // The explicit release pin fences older controllers whose quality workflow lacks these inputs.
    const deployment=this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA;
    ensure(deployment,'QUALITY_DEPLOYMENT');
    const reader=this.reader();
    let claimed=false;
    let policy:string;
    try{
      try{policy=await promotedController(reader,deployment,this.env);}
      catch(error){
        if(!(error instanceof PendingPromotion))throw error;
        await promotionMessage(this.env,deployment,'wait',{policy:deployment,key:qualityKey(record),kind:'quality',generation:error.generation});
        return;
      }
      const name=await approvedQualityRepository(reader,policy,record.target.repository_id);
      if(!name || (record.repositoryName!==undefined && name!==record.repositoryName)) {
        await this.storage.transaction(async t=>{
          const current=await t.get<QualityRecord>('qualityEvent');
          if(current?.phase!=='pending'||current.delivery!==record.delivery)return;
          await t.put('qualityEvent',{...current,phase:'excluded',policy});if(current.expires)await t.setAlarm(current.expires);else await t.deleteAlarm();
        });
        return;
      }
      await dispatchFixed(reader,CENTRAL.id,'quality-language-summary.yml',policy,{...record.target,policy_sha:policy},async()=>{
        claimed=await this.storage.transaction(async t=>{
          const current=await t.get<QualityRecord>('qualityEvent');
          if(current?.phase!=='pending'||current.delivery!==record.delivery||(current.retryAt&&Date.now()<current.retryAt))return false;
          await t.put('qualityEvent',{...current,phase:'reserved',policy});await t.setAlarm(Date.now()+debounce);return true;
        });
        return claimed;
      });
    }catch(error){
      const message=error instanceof Error?error.message:'';
      // A 503 after the POST may have come from a proxy after GitHub accepted it.
      if(error instanceof GitHubRetryError && error.httpStatus===503 && error.dispatchAttempted)throw error;
      const now=Date.now();
      const retryAt=retryAfterTime(error,now,now+60000-1);
      if(retryAt!==undefined || (claimed && /^GITHUB_HTTP_(400|401|403|404|409|410|422|429)$/.test(message))){
        const rateLimited=message==='GITHUB_HTTP_429'||retryAt!==undefined;
        const next=rateLimited ? Math.max(now+1000,retryAt??now+60000) : undefined;
        await this.storage.transaction(async t=>{
          const current=await t.get<QualityRecord>('qualityEvent');
          if(!current || current.delivery!==record.delivery || current.phase!==(claimed?'reserved':'pending'))return;
          const retryAt=next===undefined?0:Math.max(current.retryAt??0,next);
          await t.put('qualityEvent',{...current,phase:'pending',retryAt});
          if(retryAt||current.expires)await t.setAlarm(retryAt||current.expires!);else await t.deleteAlarm();
        });
      }
      throw error;
    }
    if(claimed)await this.storage.transaction(async t=>{
      const current=await t.get<QualityRecord>('qualityEvent');
      if(current?.delivery===record.delivery&&current.phase==='reserved'){
        await t.put('qualityEvent',{...current,phase:'sent',policy});
        if(current.expires)await t.setAlarm(current.expires);else await t.deleteAlarm();
      }
    });
  }
}
