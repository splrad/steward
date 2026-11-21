import {GitHubRetryError,rejectedDispatch,retryAfterTime} from './bounded-retry-after.js';
import {channelWorkflow as channelPath,defaultBuildWorkflow as publishPath,dispatchWorkflow,isBuildWorkflow} from '../../../packages/core/src/release-workflow.js';
import {PendingPromotion,promotionMessage} from './release-promotion.js';
import {promotedController} from './bounded-controller.js';
import {readCycle} from './bounded-winget-evidence.js';
import {BoundedGitHub, candidateReader, CENTRAL, TARGET, digest, ensure, type ProductTarget, type BoundedEnv, type GitReader} from './bounded-recheck-github.js';

const workflow = 'release-cycle-event.yml';
const prefix = '/repos/' + CENTRAL.name;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
type Hint = {repositoryId: number; kind: 'push'; sourceSha: string} | {repositoryId: number; kind: 'run'; runId: number; attempt: number} | {repositoryId:number;kind:'publication';runId:number;attempt:number;productRepositoryId?:number};
type Stage = 'prepare' | 'confirm' | 'received' | 'unknown';
type SignedSource=Pick<ProductTarget,'name'|'defaultBranch'>;
type ReleaseIntake={hint:Hint;source:SignedSource;tries:number;next:number};
type Relay = {hint: Hint; stage: Stage; tries: number; next: number; policy: string; reserved: number; runId?: number; reason?: string; waitingFor?:string; resumedFor?:string; paused?:boolean};

type RelayProduct=ProductTarget & {publishWorkflowId?:number;channelWorkflowId?:number;buildWorkflow?:string};
const legacyWorkflowTarget={...TARGET,publishWorkflowId:410998652,channelWorkflowId:410998651};
async function workflowProduct(g:GitReader,target:ProductTarget,path:string):Promise<RelayProduct> {
  ensure(isBuildWorkflow(path)||path===channelPath,'RELEASE_WORKFLOW_PATH');
  const workflow=await g.json(target.id,`/repos/${target.name}/actions/workflows/${path.split('/').at(-1)}`);
  ensure(workflow.path===path&&positive(workflow.id)&&workflow.state==='active','RELEASE_NATIVE_WORKFLOW');
  return {...target,...(path===channelPath?{channelWorkflowId:workflow.id}:{publishWorkflowId:workflow.id,buildWorkflow:path})};
}
export function releaseHint(event: string, p: any, installation: string | undefined,product:RelayProduct=legacyWorkflowTarget): Hint | undefined {
  const repo = p.repository;
  if (p.installation?.id === Number(installation) && repo?.id === CENTRAL.id && repo.full_name === CENTRAL.name &&
      event === 'workflow_run' && p.action === 'completed' && p.workflow_run?.path === '.github/workflows/'+workflow &&
      p.workflow_run.status === 'completed' && p.workflow_run.event === 'workflow_dispatch' && p.workflow_run.actor?.id === 301115370 &&
      p.workflow_run.head_repository?.id === CENTRAL.id && p.workflow_run.head_branch === 'main' &&
      positive(p.workflow_run.id) && positive(p.workflow_run.run_attempt) && /^Release cycle [a-f0-9]{64}$/.test(p.workflow_run.display_title))
    return {repositoryId:CENTRAL.id,kind:'publication',runId:p.workflow_run.id,attempt:p.workflow_run.run_attempt};
  if (!p.installation?.id || p.installation.id !== Number(installation) || repo?.id !== product.id ||
      repo.full_name !== product.name || repo.default_branch !== product.defaultBranch || repo.archived !== false || repo.fork !== false) return;
  if (event === 'push' && p.ref === 'refs/heads/'+product.defaultBranch && p.deleted === false && sha(p.after) && !/^0+$/.test(p.after))
    return {repositoryId: product.id, kind: 'push', sourceSha: p.after};
  if (event !== 'workflow_run' || p.action !== 'completed') return;
  const run = p.workflow_run;
  if (run?.head_repository?.id !== product.id || run.status !== 'completed' || run.event !== 'workflow_dispatch' ||
      run.actor?.id !== 301115370 || !positive(run.id) || !positive(run.run_attempt)) return;
  const publish = /^steward\/build\/[A-Za-z0-9_.-]{1,128}$/.test(run.head_branch) && run.workflow_id === product.publishWorkflowId && run.path === (product.buildWorkflow??publishPath) && /^Build [a-f0-9]{64}$/.test(run.display_title);
  const channels = run.head_branch===product.defaultBranch && run.workflow_id === product.channelWorkflowId && run.path === '.github/workflows/steward-release-channels.yml' && (/^Channels (submit|verify) [a-f0-9]{64}$/.test(run.display_title) || run.conclusion==='success' && /^Channels observe [a-f0-9]{64}$/.test(run.display_title));
  if (publish || channels) return {repositoryId: product.id, kind: 'run', runId: run.id, attempt: run.run_attempt};
}
export function relayKey(h: Hint) {
  return digest(JSON.stringify(h.kind === 'push' ? [h.repositoryId,h.kind,h.sourceSha] : [h.repositoryId,h.kind,h.runId,h.attempt,...(h.kind==='publication'&&h.productRepositoryId!==undefined?[h.productRepositoryId]:[])])).slice(7);
}
export async function acceptReleaseHint(env: BoundedEnv, event: string, payload: any) {
  if (env.BOUNDED_RECHECK_ENABLED !== 'true') return;
  const repo=payload.repository, run=payload.workflow_run;
  let source:SignedSource|undefined;
  let hint=releaseHint(event,payload,env.INSTALLATION_ID);
  if(hint?.kind==='publication') {
    const parentKey=run.display_title.slice('Release cycle '.length),ns=env.BOUNDED_RECHECK;
    ensure(ns,'PUBLICATION_NAMESPACE');
    const parent=ns.get(ns.idFromName('cycle:v1:'+parentKey));
    const response=await parent.fetch(new Request('https://bounded.internal/release-cycle-status',{method:'POST',body:'{}'}));
    ensure(response.ok,'PUBLICATION_PARENT');
    const prior=await response.json() as Relay|null;
    ensure(prior&&prior.reserved>0&&prior.policy===run.head_sha&&relayKey(prior.hint)===parentKey&&
      (prior.runId===undefined||prior.runId===run.id),'PUBLICATION_RESERVATION');
    if(prior.hint.kind==='publication')return;
    hint={...hint,productRepositoryId:prior.hint.repositoryId};
  }else{
    if(event!=='push' && !(event==='workflow_run'&&payload.action==='completed'&&run?.status==='completed'&&run.event==='workflow_dispatch'&&
      run.actor?.id===301115370&&run.head_repository?.id===repo?.id&&(isBuildWorkflow(run.path)||run.path===channelPath)))return;
    if(!repo||repo.private!==false||repo.archived!==false||repo.fork!==false||repo.owner?.id!==302208797||
       !positive(repo.id)||!payload.installation?.id||payload.installation.id!==Number(env.INSTALLATION_ID))return;
    if(event==='push'&&(payload.ref!=='refs/heads/'+repo.default_branch||payload.deleted!==false||!sha(payload.after)||/^0+$/.test(payload.after)))return;
    if(typeof repo.full_name!=='string'||!/^splrad\/[A-Za-z0-9_.-]+$/.test(repo.full_name)||
       typeof repo.default_branch!=='string'||!repo.default_branch||repo.disabled===true||
       (repo.visibility!==undefined&&repo.visibility!=='public'))return;
    source={name:repo.full_name,defaultBranch:repo.default_branch};
    if(event==='workflow_run'&&!positive(run.workflow_id))return;
    const product={id:repo.id,...source,publishWorkflowId:run?.workflow_id,channelWorkflowId:run?.workflow_id,buildWorkflow:run?.path};
    hint=releaseHint(event,payload,env.INSTALLATION_ID,product);
  }
  if (!hint) return;
  ensure(env.BOUNDED_RECHECK,'RELEASE_RELAY_NAMESPACE');
  const stub = env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('cycle:v1:' + relayKey(hint)));
  const response = await stub.fetch(new Request('https://bounded.internal/release-cycle',{method:'POST',body:JSON.stringify(source?{hint,source}:hint)}));
  ensure(response.ok,'RELEASE_RELAY_REGISTRATION');
}
export class ReleaseRelay {
  constructor(private storage: DurableObjectStorage, private env: BoundedEnv, private reader: () => GitReader = () => new BoundedGitHub(env), private now = Date.now) {}
  async register(hint: Hint,source?:SignedSource) {
    if(source){
      await this.storage.transaction(async t=>{
        if(await t.get('releaseCycle'))return;
        const pending=await t.get<ReleaseIntake>('releaseIntake')??{hint,source,tries:0,next:this.now()};
        await t.put('releaseIntake',pending);
        if(pending.tries<4 && this.env.BOUNDED_RECHECK_ENABLED==='true')await t.setAlarm(Math.max(this.now(),pending.next));
      });
      const existing=await this.storage.get<Relay>('releaseCycle');
      if(!existing)return;
    }
    const prior=await this.storage.get<Relay>('releaseCycle');
    if(prior?.stage==='unknown' && !prior.reserved && prior.reason==='PREPARATION_EXHAUSTED' && prior.waitingFor){
      const policy=await promotedController(this.reader(),this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA,this.env);
      await this.wakePromoted(policy,true);return;
    }
    await this.storage.transaction(async t => {
      const old=await t.get<Relay>('releaseCycle');
      if(old){
        if(old.paused && this.env.BOUNDED_RECHECK_ENABLED==='true' && relayKey(old.hint)===relayKey(hint)){
          delete old.paused;await t.put('releaseCycle',old);await t.setAlarm(Math.max(this.now(),old.next));
        }
        return;
      }
      const record: Relay = {hint,stage:'prepare',tries:0,next:this.now(),policy:'',reserved:0};
      await t.put('releaseCycle',record);
      await t.setAlarm(record.next);
    });
  }
  async wakePromoted(policy:string,redelivery=false,controller=policy){
    await this.storage.transaction(async t=>{
      const r=await t.get<Relay>('releaseCycle');
      if(!r || r.paused || r.reserved || (!redelivery && r.waitingFor!==policy) || !r.waitingFor || r.resumedFor===controller ||
         (r.stage!=='prepare' && !(r.stage==='unknown'&&r.reason==='PREPARATION_EXHAUSTED')))return;
      r.stage='prepare';r.next=this.now();r.resumedFor=controller;delete r.waitingFor;
      // One additional preflight for this newly verified promotion, retaining the prior count and business key.
      await t.put('releaseCycle',r);await t.setAlarm(r.next);
    });
  }
  private async qualify(){
    const pending=await this.storage.transaction(async t=>{
      if(await t.get('releaseCycle'))return;
      const p=await t.get<ReleaseIntake>('releaseIntake');
      if(!p||p.next>this.now()||p.tries>=4)return;
      if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){await t.deleteAlarm();return;}
      p.tries++;p.next=this.now()+[60000,300000,900000,0][p.tries-1]!;
      await t.put('releaseIntake',p);
      if(p.tries===4)await t.deleteAlarm();else await t.setAlarm(p.next);
      return p;
    });
    if(!pending)return;
    let target:ProductTarget|undefined;
    try{target=(await this.reader().forCandidate?.(pending.hint.repositoryId))?.target;}
    catch(error){
      const retryAt=retryAfterTime(error,this.now(),pending.next);
      if(retryAt!==undefined&&pending.tries<4&&retryAt>pending.next){
        await this.storage.transaction(async t=>{
          const current=await t.get<ReleaseIntake>('releaseIntake');
          if(!current||current.tries!==pending.tries||await t.get('releaseCycle'))return;
          current.next=retryAt;await t.put('releaseIntake',current);await t.setAlarm(current.next);
        });
      }
      return;
    }
    await this.storage.transaction(async t=>{
      const current=await t.get<ReleaseIntake>('releaseIntake');
      if(!current||current.tries!==pending.tries||await t.get('releaseCycle'))return;
      await t.delete('releaseIntake');
      if(!target||target.id!==pending.hint.repositoryId||target.name!==pending.source.name||
         target.defaultBranch!==pending.source.defaultBranch){await t.deleteAlarm();return;}
      const r:Relay={hint:pending.hint,stage:'prepare',tries:0,next:this.now(),policy:'',reserved:0};
      await t.put('releaseCycle',r);await t.setAlarm(r.next);
    });
  }
  async alarm() {
    if(!await this.storage.get('releaseCycle'))await this.qualify();
    const r = await this.storage.get<Relay>('releaseCycle');
    if (!r || r.stage === 'received' || r.stage === 'unknown' || r.next > this.now()) return;
    const g = this.reader(), key = relayKey(r.hint);
    // A transactional claim advances the budget and schedules recovery before external IO.
    const claim = await this.storage.transaction(async t => {
      const current = await t.get<Relay>('releaseCycle');
      if (!current || current.stage !== r.stage || current.tries !== r.tries || current.next !== r.next) return false;
      if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){
        current.paused=true;await t.put('releaseCycle',current);await t.deleteAlarm();return false;
      }
      if (r.tries >= (r.resumedFor && r.stage==='prepare' ? 5 : 4)) {
        await t.put('releaseCycle',{...r,stage:'unknown',reason:r.stage === 'prepare' ? 'PREPARATION_EXHAUSTED' : 'DELIVERY_UNKNOWN'});
        await t.deleteAlarm();
        return false;
      }
      r.tries++;
      r.next = this.now() + [60000,300000,900000][Math.min(r.tries-1,2)]!;
      await t.put('releaseCycle',r);
      await t.setAlarm(r.next);
      return true;
    });
    if (!claim) return;
    const save = async (changes: Partial<Relay>) => this.storage.transaction(async t => {
      const current = await t.get<Relay>('releaseCycle');
      if (!current || current.stage !== r.stage || current.tries !== r.tries || current.next !== r.next) return false;
      Object.assign(current,changes);
      await t.put('releaseCycle',current);
      if (current.stage === 'received' || current.stage === 'unknown') await t.deleteAlarm();
      else await t.setAlarm(current.next);
      return true;
    });
    try {
      ensure(this.env.BOUNDED_RECHECK_ENABLED === 'true','RELEASE_RELAY_PAUSED');
      if (r.stage === 'prepare') {
        if (r.hint.kind === 'run') {
          const scoped=await candidateReader(g,r.hint.repositoryId);
          const target=scoped.target??TARGET;
          const run=await scoped.json(target.id,'/repos/'+target.name+'/actions/runs/'+r.hint.runId+'/attempts/'+r.hint.attempt);
          const product=scoped.target?await workflowProduct(scoped,target,run.path):legacyWorkflowTarget;
          const repeated=releaseHint('workflow_run',{action:'completed',repository:{id:target.id,full_name:target.name,default_branch:target.defaultBranch,fork:false,archived:false},
            installation:{id:Number(this.env.INSTALLATION_ID)},workflow_run:run},this.env.INSTALLATION_ID,product);
          ensure(run.repository?.id===target.id && sha(run.head_sha) && repeated && relayKey(repeated)===key,'RELEASE_PRODUCT_RUN');
          if(run.path!==channelPath){
            const cycleId=run.head_branch.slice('steward/build/'.length),{cycle}=await readCycle(scoped,cycleId);
            const matches=cycle.dispatches?.filter((d:any)=>d.purpose==='build' && d.ref===run.head_branch &&
              d.executionSha===run.head_sha && d.sourceSha===cycle.sourceSha && cycle.sourceSha===run.head_sha &&
              d.workflowId===run.workflow_id && dispatchWorkflow(d)===run.path && (d.canonicalRunId===null || d.canonicalRunId===run.id) &&
              run.display_title==='Build '+d.operationKey && Date.parse(run.created_at)>=Math.floor(Date.parse(d.sentAt)/1000)*1000);
            ensure(matches?.length===1,'RELEASE_BUILD_DISPATCH');
          }
        }
        if (r.hint.kind === 'publication') {
          const run = await g.json(CENTRAL.id,prefix+'/actions/runs/'+r.hint.runId+'/attempts/'+r.hint.attempt);
          const parentKey = /^Release cycle ([a-f0-9]{64})$/.exec(run.display_title)?.[1];
          ensure(parentKey && run.id === r.hint.runId && run.run_attempt === r.hint.attempt && run.status === 'completed' &&
            run.path === '.github/workflows/'+workflow && run.head_branch === 'main' && run.event === 'workflow_dispatch' &&
            run.actor?.id === 301115370 && run.head_repository?.id === CENTRAL.id && run.repository?.id === CENTRAL.id,'PUBLICATION_RUN');
          const ns=this.env.BOUNDED_RECHECK;
          ensure(ns,'PUBLICATION_NAMESPACE');
          const parent=ns.get(ns.idFromName('cycle:v1:'+parentKey));
          const response=await parent.fetch(new Request('https://bounded.internal/release-cycle-status',{method:'POST',body:'{}'}));
          ensure(response.ok,'PUBLICATION_PARENT');
          const prior=await response.json() as Relay|null;
          ensure(prior && prior.reserved>0 && prior.policy===run.head_sha && relayKey(prior.hint)===parentKey &&
            (prior.runId===undefined||prior.runId===run.id),'PUBLICATION_RESERVATION');
          const first=run.run_attempt===1?run:await g.json(CENTRAL.id,prefix+'/actions/runs/'+run.id+'/attempts/1');
          ensure(first.id===run.id && first.run_attempt===1 && first.head_sha===prior.policy && first.display_title===run.display_title &&
            first.repository?.id===CENTRAL.id && first.head_repository?.id===CENTRAL.id && first.actor?.id===301115370 &&
            first.path===run.path && first.head_branch==='main' && first.event==='workflow_dispatch' &&
            Date.parse(first.created_at)>=prior.reserved-60000 && Date.parse(first.created_at)<=prior.reserved+300000,'PUBLICATION_FIRST_ATTEMPT');
          if(prior.hint.kind==='publication'){await save({stage:'received',reason:'PUBLICATION_CONSUMED'});return;}
          ensure(prior.hint.repositoryId===(r.hint.productRepositoryId??TARGET.id),'PUBLICATION_PRODUCT_BINDING');
          const artifact=await g.artifact(CENTRAL.id,run.id,'release-cycle-'+parentKey+'-'+run.run_attempt,'result.json');
          const v=artifact.value;
          ensure(v?.schemaVersion===1 && v.requestKey===parentKey && v.producer?.repositoryId===CENTRAL.id &&
            v.producer.runId===run.id && v.producer.attempt===run.run_attempt && v.producer.controllerSha===run.head_sha &&
            v.event?.repositoryId===prior.hint.repositoryId && v.event.kind===prior.hint.kind && relayKey(v.event)===parentKey &&
            typeof v.publishInvoked==='boolean','PUBLICATION_ARTIFACT');
          if(!v.publishInvoked){await save({stage:'received',reason:'NO_PUBLICATION'});return;}
        }
        const policy=await promotedController(g,this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA,this.env);
        const own = await g.json(CENTRAL.id,prefix+'/actions/workflows/'+workflow);
        ensure(own.state === 'active' && own.path === '.github/workflows/'+workflow,'RELEASE_RELAY_WORKFLOW');
        await g.prepareDispatch?.(CENTRAL.id);
        const reserved = this.now();
        if (!await save({stage:'confirm',tries:0,policy,reserved,next:reserved+60000})) return;
        try{
          await g.json(CENTRAL.id,prefix+'/actions/workflows/'+workflow+'/dispatches','POST',{ref:'main',inputs:{event_json:JSON.stringify(r.hint),request_key:key,policy_sha:policy}});
        }catch(error){
          if(!rejectedDispatch(error))throw error;
          const now=this.now(),due=retryAfterTime(error,now,now+60000-1)!;
          await this.storage.transaction(async t=>{
            const current=await t.get<Relay>('releaseCycle');
            if(current?.stage!=='confirm'||current.reserved!==reserved||current.policy!==policy||current.runId)return;
            current.reserved=0;current.tries=r.tries;
            delete current.waitingFor;
            if(r.tries>=(r.resumedFor?5:4)){
              current.stage='unknown';current.reason='DISPATCH_RATE_LIMIT_EXHAUSTED';await t.deleteAlarm();
            }else{
              current.stage='prepare';current.next=Math.max(r.next,due);await t.setAlarm(current.next);
            }
            await t.put('releaseCycle',current);
          });
        }
        return;
      }
      const window = encodeURIComponent(new Date(r.reserved-60000).toISOString()+'..'+new Date(r.reserved+300000).toISOString());
      const list = await g.json(CENTRAL.id,prefix+'/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+r.policy+'&created='+window+'&per_page=100');
      ensure(Array.isArray(list.workflow_runs) && list.total_count === list.workflow_runs.length,'RELEASE_RELAY_WINDOW');
      const hits = list.workflow_runs.filter((x:any) => x.path === '.github/workflows/'+workflow && x.display_title === 'Release cycle '+key &&
        x.event === 'workflow_dispatch' && x.actor?.id === 301115370 && x.repository?.id === CENTRAL.id && x.head_repository?.id === CENTRAL.id &&
        x.head_sha === r.policy && x.head_branch === 'main' && positive(x.id) && x.run_attempt === 1);
      ensure(hits.length === 1,'RELEASE_RELAY_RECEIPT_UNKNOWN');
      await save({stage:'received',runId:hits[0].id});
    } catch (error) {
      // After the reservation, only confirmation may advance. A lost POST response never authorizes another POST.
      if(error instanceof PendingPromotion && r.stage==='prepare'){
        const final=r.tries>=4;
        if(await save({waitingFor:error.sha,...(final?{stage:'unknown' as const,reason:'PREPARATION_EXHAUSTED'}:{})}) && this.env.BOUNDED_RECHECK)
          await promotionMessage(this.env,error.sha,'wait',{policy:error.sha,key,kind:'cycle',generation:error.generation});
        return;
      }
      const retryAt=retryAfterTime(error,this.now(),r.next);
      const attemptedDispatch = error instanceof GitHubRetryError && error.dispatchAttempted;
      if (r.tries < 4 && retryAt !== undefined && retryAt > r.next && !attemptedDispatch) {
        await save({next:retryAt});return;
      }
      if (r.tries >= 4) await save({stage:'unknown',reason:r.stage === 'prepare' ? 'PREPARATION_EXHAUSTED' : 'DELIVERY_UNKNOWN'});
    }
  }
}
