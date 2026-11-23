import {GitHubRetryError,rejectedDispatch,retryAfterTime} from './bounded-retry-after.js';
import {channelWorkflow as channelPath,defaultBuildWorkflow as publishPath,dispatchWorkflow,isBuildWorkflow} from '../../../packages/core/src/release-workflow.js';
import {PendingPromotion,promotionMessage} from './release-promotion.js';
import {promotedController} from './bounded-controller.js';
import {readCycle} from './bounded-winget-evidence.js';
import {BoundedGitHub, candidateReader, CENTRAL, TARGET, digest, ensure, type ProductTarget, type BoundedEnv, type GitReader} from './bounded-recheck-github.js';
import {legacyReleaseHandoff,legacyReleaseHandoffReason} from './legacy-release-handoff.js';

const workflow = 'release-cycle-event.yml';
const candidateWorkflow = 'release-candidate-event.yml';
const prefix = '/repos/' + CENTRAL.name;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const stewardBotId = 301115370;
const pendingLabel = 'autorelease: pending', taggedLabel = 'autorelease: tagged';
function completesOfficialLabels(action: unknown, label: unknown): boolean {
  return (action === 'labeled' && label === taggedLabel) || (action === 'unlabeled' && label === pendingLabel);
}
const deliveryGuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
type Hint = {repositoryId: number; kind: 'push'; sourceSha: string}
  | {repositoryId: number; kind: 'candidate-head'; prNumber: number; head: string; delivery?: string}
  | {repositoryId: number; kind: 'candidate-status'; prNumber: number; commentId: number}
  | {repositoryId: number; kind: 'official-edit'; prNumber: number; head: string; bodyDigest: string; titleDigest: string}
  | {repositoryId: number; kind: 'official-refresh'; prNumber: number; head: string; releasedSha: string}
  | {repositoryId: number; kind: 'official-merge'; prNumber: number; head: string; sourceSha: string; mergedAt: string; title: string; body: string}
  | {repositoryId: number; kind: 'run'; runId: number; attempt: number} | {repositoryId:number;kind:'publication';runId:number;attempt:number;productRepositoryId?:number};
type Stage = 'prepare' | 'confirm' | 'received' | 'unknown';
type SignedSource=Pick<ProductTarget,'name'|'defaultBranch'>;
type ReleaseIntake={hint:Hint;source:SignedSource;tries:number;next:number};
type Relay = {hint: Hint; stage: Stage; tries: number; next: number; policy: string; reserved: number; officialCandidate?: true; officialRelease?: true; runId?: number; reason?: string; waitingFor?:string; resumedFor?:string; paused?:boolean};

const ownerId = (hint: Hint) => hint.kind === 'publication' ? hint.productRepositoryId ?? TARGET.id : hint.repositoryId;
const legacyCandidate = (hint: Hint) => hint.kind === 'candidate-head' || hint.kind === 'candidate-status';
const legacyCandidateRelay = (relay: Relay) => legacyCandidate(relay.hint) ||
  (relay.hint.kind === 'push' && !relay.officialCandidate);
const officialPush = (target: ProductTarget | undefined, hint: Extract<Hint,{kind:'push'}>) =>
  target?.officialCandidate === true && target.sourceSha === hint.sourceSha;
const hexDigest = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]+$/.test(v);
function officialCycle(cycle: Awaited<ReturnType<typeof readCycle>>['cycle']): boolean {
  const receipt=cycle.officialRelease;
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'bodyDigest,headSha,pullBodyDigest' ||
      !sha(receipt.headSha) || !hexDigest(receipt.pullBodyDigest) || !hexDigest(receipt.bodyDigest) ||
      cycle.workflowDelivery !== true || !Array.isArray(cycle.units) || cycle.units.length !== 1 ||
      !positive(cycle.prNumber) || !sha(cycle.sourceSha) || cycle.id !== `pr-${cycle.prNumber}-${cycle.sourceSha}`) return false;
  const unit=cycle.units[0];
  if (!unit || unit.githubDisabled !== undefined || (unit.notesDigest !== null && unit.notesDigest !== receipt.bodyDigest)) return false;
  if (cycle.officialDraftScopeDigest === undefined) return unit.releaseId === null;
  const delivery=unit.githubDelivery;
  return hexDigest(cycle.officialDraftScopeDigest) && (unit.releaseId === null || positive(unit.releaseId)) &&
    Boolean(delivery && positive(delivery.runId) && positive(delivery.attempt) && positive(delivery.artifactId) &&
      typeof delivery.digest === 'string' && delivery.digest.startsWith('sha256:') && hexDigest(delivery.digest.slice(7)));
}

async function boundBuildCycle(g:GitReader,run:any) {
  const cycleId=run.head_branch.slice('steward/build/'.length),{cycle}=await readCycle(g,cycleId);
  const matches=cycle.dispatches?.filter((d:any)=>d.purpose==='build' && d.ref===run.head_branch &&
    d.executionSha===run.head_sha && d.sourceSha===cycle.sourceSha && cycle.sourceSha===run.head_sha &&
    d.workflowId===run.workflow_id && dispatchWorkflow(d)===run.path && (d.canonicalRunId===null || d.canonicalRunId===run.id) &&
    (d.buildWorkflow===undefined?run.display_title==='Build '+d.operationKey:run.display_title.includes(d.operationKey)) &&
    Date.parse(run.created_at)>=Math.floor(Date.parse(d.sentAt)/1000)*1000);
  ensure(matches?.length===1,'RELEASE_BUILD_DISPATCH');
  return cycle;
}

async function officialPublication(g:GitReader,parent:Relay,installation:string|undefined):Promise<boolean> {
  const hint=parent.hint;
  if (hint.kind==='official-merge') return true;
  if (hint.kind!=='run') return false;
  if (parent.officialRelease===true) return true;
  const scoped=await candidateReader(g,hint.repositoryId),target=scoped.target;
  if (!target?.officialCandidate) return false;
  const run=await scoped.json(target.id,`/repos/${target.name}/actions/runs/${hint.runId}/attempts/${hint.attempt}`);
  if (!isBuildWorkflow(run?.path) || run.repository?.id!==target.id || !sha(run.head_sha)) return false;
  const product=await workflowProduct(scoped,target,run.path);
  const observed=releaseHint('workflow_run',{action:'completed',repository:{id:target.id,full_name:target.name,
    default_branch:target.defaultBranch,fork:false,archived:false},installation:{id:Number(installation)},workflow_run:run},installation,product);
  return Boolean(observed && relayKey(observed)===relayKey(hint) && officialCycle(await boundBuildCycle(scoped,run)));
}

type RelayProduct=ProductTarget & {publishWorkflowId?:number;channelWorkflowId?:number;buildWorkflow?:string};
const legacyWorkflowTarget={...TARGET,publishWorkflowId:410998652,channelWorkflowId:410998651};
async function workflowProduct(g:GitReader,target:ProductTarget,path:string):Promise<RelayProduct> {
  ensure(isBuildWorkflow(path)||path===channelPath,'RELEASE_WORKFLOW_PATH');
  const workflow=await g.json(target.id,`/repos/${target.name}/actions/workflows/${encodeURIComponent(path.split('/').at(-1)!)}`);
  ensure(workflow.path===path&&positive(workflow.id)&&workflow.state==='active','RELEASE_NATIVE_WORKFLOW');
  return {...target,...(path===channelPath?{channelWorkflowId:workflow.id}:{publishWorkflowId:workflow.id,buildWorkflow:path})};
}
export function releaseHint(event: string, p: any, installation: string | undefined,product:RelayProduct=legacyWorkflowTarget, deliveryId=''): Hint | undefined {
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
  if (event === 'issue_comment' && p.action === 'created') {
    const issue = p.issue, comment = p.comment;
    if (issue?.pull_request && issue.state === 'open' && positive(issue.number) && positive(comment?.id)
      && p.sender?.id === stewardBotId && comment.user?.id === stewardBotId
      && typeof comment.body === 'string' && /^<!-- steward:candidate-status:[a-f0-9]{64} -->/.test(comment.body))
      return {repositoryId: product.id, kind:'candidate-status', prNumber:issue.number, commentId:comment.id};
  }
  if (event === 'pull_request' && typeof p.pull_request?.head?.ref === 'string' &&
      p.pull_request.head.ref.startsWith('release-please--branches--')) {
    const pull = p.pull_request;
    if (pull.head.ref !== 'release-please--branches--' + product.defaultBranch ||
        !positive(p.number) || pull.number !== p.number || pull.user?.id !== stewardBotId ||
        pull.base?.repo?.id !== product.id || pull.base.ref !== product.defaultBranch ||
        pull.head?.repo?.id !== product.id || !sha(pull.head.sha) || /^0+$/.test(pull.head.sha) ||
        !Array.isArray(pull.labels) ||
        typeof pull.body !== 'string' || typeof pull.title !== 'string') return;
    const pending = pull.labels.some((label: any) => label?.name === pendingLabel);
    const tagged = pull.labels.some((label: any) => label?.name === taggedLabel);
    // The official action adds tagged last. Recovery can instead remove the last pending label.
    if (completesOfficialLabels(p.action,p.label?.name) && p.sender?.id === stewardBotId &&
        tagged && !pending && pull.state === 'closed' && pull.merged === true && sha(pull.merge_commit_sha) &&
        !/^0+$/.test(pull.merge_commit_sha))
      return {repositoryId:product.id,kind:'official-refresh',prNumber:p.number,head:pull.head.sha,releasedSha:pull.merge_commit_sha};
    if (!pending) return;
    if (p.action === 'closed' && pull.state === 'closed' && pull.merged === true && sha(pull.merge_commit_sha) &&
        !/^0+$/.test(pull.merge_commit_sha) && Number.isFinite(Date.parse(pull.merged_at))) {
      return {repositoryId:product.id,kind:'official-merge',prNumber:p.number,head:pull.head.sha,sourceSha:pull.merge_commit_sha,
        mergedAt:pull.merged_at,title:pull.title,body:pull.body};
    }
    if (p.action === 'edited' && pull.state === 'open' && pull.merged !== true && positive(p.sender?.id) &&
        p.sender.id !== stewardBotId && p.sender.type === 'User' && (p.changes?.body || p.changes?.title)) {
      return {repositoryId:product.id,kind:'official-edit',prNumber:p.number,head:pull.head.sha,bodyDigest:digest(pull.body).slice(7),
        titleDigest:digest(pull.title).slice(7)};
    }
    return;
  }
  if (event === 'pull_request' && ['opened','synchronize','edited'].includes(p.action)) {
    const pull = p.pull_request;
    const head = pull?.head?.sha;
    const candidate = pull?.head?.ref === 'steward/release-candidate'
      || typeof pull?.body === 'string' && /<!-- steward:candidate:[a-f0-9]{64} -->/.test(pull.body)
      || Array.isArray(pull?.labels) && pull.labels.some((label: any) => label?.name === 'autorelease: pending');
    // A PATCH that reached GitHub can be applied after its original run ends.
    // Treat each native edit as its own wake, even at a previously seen head.
    const delivery = deliveryId.toLowerCase();
    const editedHomepage = p.action === 'edited' && p.sender?.id === stewardBotId && deliveryGuid.test(delivery)
      && p.changes?.body && Object.hasOwn(p.changes.body, 'from')
      && typeof pull?.body === 'string' && /<!-- steward:candidate-homepage:[a-f0-9]{64} -->/.test(pull.body);
    if (candidate && positive(p.number) && pull?.number === p.number && pull.state === 'open' && (pull.merged === false || pull.merged === null)
      && pull.base?.repo?.id === product.id && pull.base.ref === product.defaultBranch
      && pull.head?.repo?.id === product.id && pull.head.ref !== product.defaultBranch
      && sha(head) && !/^0+$/.test(head) && (p.action === 'opened' || p.action === 'synchronize' && p.after === head || editedHomepage))
      return {repositoryId: product.id, kind: 'candidate-head', prNumber: p.number, head, ...(editedHomepage ? {delivery} : {})};
  }
  if (event !== 'workflow_run' || p.action !== 'completed') return;
  const run = p.workflow_run;
  if (run?.head_repository?.id !== product.id || run.status !== 'completed' || run.event !== 'workflow_dispatch' ||
      run.actor?.id !== 301115370 || !positive(run.id) || !positive(run.run_attempt)) return;
  const buildTitle=product.buildWorkflow===undefined?/^Build [a-f0-9]{64}$/:/[a-f0-9]{64}/;
  const publish = /^steward\/build\/[A-Za-z0-9_.-]{1,128}$/.test(run.head_branch) && run.workflow_id === product.publishWorkflowId && run.path === (product.buildWorkflow??publishPath) && buildTitle.test(run.display_title);
  const channels = run.head_branch===product.defaultBranch && run.workflow_id === product.channelWorkflowId && run.path === '.github/workflows/steward-release-channels.yml' && (/^Channels (submit|verify) [a-f0-9]{64}$/.test(run.display_title) || run.conclusion==='success' && /^Channels observe [a-f0-9]{64}$/.test(run.display_title));
  if (publish || channels) return {repositoryId: product.id, kind: 'run', runId: run.id, attempt: run.run_attempt};
}
export function relayKey(h: Hint) {
  if (h.kind === 'official-merge') return digest(JSON.stringify([h.repositoryId,h.kind,h.prNumber,h.sourceSha,h.head])).slice(7);
  if (h.kind === 'official-edit') return digest(JSON.stringify([h.repositoryId,h.kind,h.prNumber,h.head,h.bodyDigest,h.titleDigest])).slice(7);
  if (h.kind === 'official-refresh') return digest(JSON.stringify([h.repositoryId,h.kind,h.prNumber,h.head,h.releasedSha])).slice(7);
  if (h.kind === 'candidate-head') return digest(JSON.stringify([h.repositoryId,h.kind,h.prNumber,h.head,...(h.delivery ? [h.delivery] : [])])).slice(7);
  if (h.kind === 'candidate-status') return digest(JSON.stringify([h.repositoryId,h.kind,h.prNumber,h.commentId])).slice(7);
  return digest(JSON.stringify(h.kind === 'push' ? [h.repositoryId,h.kind,h.sourceSha] : [h.repositoryId,h.kind,h.runId,h.attempt,...(h.kind==='publication'&&h.productRepositoryId!==undefined?[h.productRepositoryId]:[])])).slice(7);
}
export async function acceptReleaseHint(env: BoundedEnv, event: string, payload: any, deliveryId='',
    reader: () => GitReader = () => new BoundedGitHub(env)) {
  if (env.BOUNDED_RECHECK_ENABLED !== 'true') return;
  const repo=payload.repository, run=payload.workflow_run;
  let source:SignedSource|undefined;
  let hint=releaseHint(event,payload,env.INSTALLATION_ID,undefined,deliveryId);
  if(hint?.kind==='publication') {
    const parentKey=run.display_title.slice('Release cycle '.length),ns=env.BOUNDED_RECHECK;
    ensure(ns,'PUBLICATION_NAMESPACE');
    const parent=ns.get(ns.idFromName('cycle:v1:'+parentKey));
    const response=await parent.fetch(new Request('https://bounded.internal/release-cycle-status',{method:'POST',body:'{}'}));
    ensure(response.ok,'PUBLICATION_PARENT');
    const prior=await response.json() as Relay|null;
    ensure(prior&&prior.reserved>0&&prior.policy===run.head_sha&&relayKey(prior.hint)===parentKey&&
      (prior.runId===undefined||prior.runId===run.id),'PUBLICATION_RESERVATION');
    if(prior.hint.kind==='publication'||prior.hint.kind==='candidate-head'||prior.hint.kind==='candidate-status')return;
    hint={...hint,productRepositoryId:prior.hint.repositoryId};
    if(legacyReleaseHandoff(env,ownerId(hint))&&!await officialPublication(reader(),prior,env.INSTALLATION_ID))return;
  }else{
    if(event!=='push' && !(event==='pull_request'&&(['opened','synchronize','edited','closed'].includes(payload.action) ||
      completesOfficialLabels(payload.action,payload.label?.name)))
      && !(event==='issue_comment'&&payload.action==='created') && !(event==='workflow_run'&&payload.action==='completed'&&run?.status==='completed'&&run.event==='workflow_dispatch'&&
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
    hint=releaseHint(event,payload,env.INSTALLATION_ID,product,deliveryId);
  }
  if (!hint) return;
  if (legacyReleaseHandoff(env,ownerId(hint))) {
    if (legacyCandidate(hint)) return;
    if (hint.kind === 'push' || hint.kind === 'run') {
      if (hint.kind === 'run' && run.path === channelPath) return;
      const scoped = await reader().forCandidate?.(hint.repositoryId);
      if (!scoped?.target?.officialCandidate) return;
      if (hint.kind === 'push' && !officialPush(scoped.target,hint)) return;
      if (hint.kind === 'run' && !officialCycle(await boundBuildCycle(scoped,run))) return;
    }
  }
  ensure(env.BOUNDED_RECHECK,'RELEASE_RELAY_NAMESPACE');
  const stub = env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('cycle:v1:' + relayKey(hint)));
  const response = await stub.fetch(new Request('https://bounded.internal/release-cycle',{method:'POST',body:JSON.stringify(source?{hint,source}:hint)}));
  ensure(response.ok,'RELEASE_RELAY_REGISTRATION');
}
export class ReleaseRelay {
  constructor(private storage: DurableObjectStorage, private env: BoundedEnv, private reader: () => GitReader = () => new BoundedGitHub(env), private now = Date.now) {}
  async register(hint: Hint,source?:SignedSource) {
    if(legacyCandidate(hint)&&legacyReleaseHandoff(this.env,ownerId(hint)))return;
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
        if(old.reason===legacyReleaseHandoffReason&&legacyReleaseHandoff(this.env,ownerId(old.hint)))return;
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
      if(legacyCandidateRelay(r)&&legacyReleaseHandoff(this.env,ownerId(r.hint)))return;
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
      const kind=pending.hint.kind;
      if(legacyReleaseHandoff(this.env,ownerId(pending.hint))&&
         (legacyCandidate(pending.hint)||(pending.hint.kind==='push'&&!officialPush(target,pending.hint)))){
        await t.put('releaseCycle',{hint:pending.hint,stage:'prepare',tries:0,next:pending.next,policy:'',reserved:0,
          reason:legacyReleaseHandoffReason,paused:true} satisfies Relay);
        await t.deleteAlarm();
        return;
      }
      if ((!target.officialCandidate && (kind==='official-merge'||kind==='official-edit'||kind==='official-refresh')) ||
          (target.officialCandidate && (kind==='candidate-head'||kind==='candidate-status'))) {
        await t.deleteAlarm();
        return;
      }
      const r:Relay={hint:pending.hint,stage:'prepare',tries:0,next:this.now(),policy:'',reserved:0,
        ...(target.officialCandidate && (kind==='push'||kind==='official-edit'||kind==='official-refresh')?{officialCandidate:true}:{})};
      await t.put('releaseCycle',r);await t.setAlarm(r.next);
    });
  }
  async alarm() {
    if(!await this.storage.get('releaseCycle'))await this.qualify();
    const r = await this.storage.get<Relay>('releaseCycle');
    if (!r || r.stage === 'received' || r.stage === 'unknown' || r.next > this.now()) return;
    const g = this.reader(), key = relayKey(r.hint);
    const destination = r.officialCandidate ? candidateWorkflow : workflow;
    const title = r.officialCandidate ? 'Candidate event ' : 'Release cycle ';
    const draining = legacyReleaseHandoff(this.env,ownerId(r.hint));
    let officialRelease = r.officialRelease === true || r.hint.kind === 'official-merge';
    // A transactional claim advances the budget and schedules recovery before external IO.
    const claim = await this.storage.transaction(async t => {
      const current = await t.get<Relay>('releaseCycle');
      if (!current || current.stage !== r.stage || current.tries !== r.tries || current.next !== r.next) return false;
      if(this.env.BOUNDED_RECHECK_ENABLED!=='true'||(draining&&r.stage==='prepare'&&legacyCandidateRelay(r))){
        if(draining&&r.stage==='prepare'&&legacyCandidateRelay(r))current.reason=legacyReleaseHandoffReason;
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
      if (changes.officialRelease===undefined && 'officialRelease' in changes) delete current.officialRelease;
      await t.put('releaseCycle',current);
      if ((draining && current.paused && current.reason === legacyReleaseHandoffReason) ||
          current.stage === 'received' || current.stage === 'unknown') await t.deleteAlarm();
      else await t.setAlarm(current.next);
      return true;
    });
    try {
      ensure(this.env.BOUNDED_RECHECK_ENABLED === 'true','RELEASE_RELAY_PAUSED');
      if (r.stage === 'prepare') {
        const stopLegacy = () => save({paused:true,reason:legacyReleaseHandoffReason});
        if (r.hint.kind === 'run') {
          const scoped=await candidateReader(g,r.hint.repositoryId);
          const target=scoped.target??TARGET;
          const run=await scoped.json(target.id,'/repos/'+target.name+'/actions/runs/'+r.hint.runId+'/attempts/'+r.hint.attempt);
          const product=scoped.target?await workflowProduct(scoped,target,run.path):legacyWorkflowTarget;
          const repeated=releaseHint('workflow_run',{action:'completed',repository:{id:target.id,full_name:target.name,default_branch:target.defaultBranch,fork:false,archived:false},
            installation:{id:Number(this.env.INSTALLATION_ID)},workflow_run:run},this.env.INSTALLATION_ID,product);
          ensure(run.repository?.id===target.id && sha(run.head_sha) && repeated && relayKey(repeated)===key,'RELEASE_PRODUCT_RUN');
          if(draining&&run.path===channelPath){await stopLegacy();return;}
          if(run.path!==channelPath){
            officialRelease=officialCycle(await boundBuildCycle(scoped,run));
            if(draining&&!officialRelease){await stopLegacy();return;}
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
          if(draining&&!await officialPublication(g,prior,this.env.INSTALLATION_ID)){await stopLegacy();return;}
          const artifact=await g.artifact(CENTRAL.id,run.id,'release-cycle-'+parentKey+'-'+run.run_attempt,'result.json');
          const v=artifact.value;
          ensure(v?.schemaVersion===1 && v.requestKey===parentKey && v.producer?.repositoryId===CENTRAL.id &&
            v.producer.runId===run.id && v.producer.attempt===run.run_attempt && v.producer.controllerSha===run.head_sha &&
            v.event?.repositoryId===prior.hint.repositoryId && v.event.kind===prior.hint.kind && relayKey(v.event)===parentKey &&
            typeof v.publishInvoked==='boolean','PUBLICATION_ARTIFACT');
          if(!v.publishInvoked){await save({stage:'received',reason:'NO_PUBLICATION'});return;}
        }
        const policy=await promotedController(g,this.env.RELEASE_RELAY_DEPLOYMENT_SHA??this.env.BOUNDED_DEPLOYMENT_SHA,this.env);
        const own = await g.json(CENTRAL.id,prefix+'/actions/workflows/'+destination);
        ensure(own.state === 'active' && own.path === '.github/workflows/'+destination,'RELEASE_RELAY_WORKFLOW');
        const eventJson = JSON.stringify(r.hint);
        if (Buffer.byteLength(eventJson) >= 64_000) {
          await save({stage:'unknown',reason:'RELEASE_RELAY_EVENT_SIZE'});
          return;
        }
        const inputs = {event_json:eventJson,request_key:key,policy_sha:policy};
        if(r.officialCandidate) {
          ensure(r.hint.kind==='push'||r.hint.kind==='official-edit'||r.hint.kind==='official-refresh','RELEASE_RELAY_CANDIDATE_KIND');
          if(draining&&r.hint.kind==='push'){
            const scoped=await candidateReader(g,r.hint.repositoryId);
            if(!officialPush(scoped.target,r.hint)){await stopLegacy();return;}
          }
          if (r.hint.kind==='official-refresh') {
            const scoped=await candidateReader(g,r.hint.repositoryId),target=scoped.target;
            ensure(target?.officialCandidate,'RELEASE_RELAY_CANDIDATE_SCOPE');
            const ref=await scoped.json(target.id,'/repos/'+target.name+'/git/ref/heads/'+encodeURIComponent(target.defaultBranch));
            ensure(ref.ref==='refs/heads/'+target.defaultBranch&&ref.object?.type==='commit'&&sha(ref.object.sha),'RELEASE_RELAY_CANDIDATE_SOURCE');
            Object.assign(inputs,{source_sha:ref.object.sha});
          } else Object.assign(inputs,{source_sha:r.hint.kind==='push'?r.hint.sourceSha:r.hint.head});
        }
        await g.prepareDispatch?.(CENTRAL.id);
        const reserved = this.now();
        if (!await save({stage:'confirm',tries:0,policy,reserved,next:reserved+60000,
          ...(r.hint.kind==='run'?{officialRelease:officialRelease?true:undefined}:{})})) return;
        try{
          await g.json(CENTRAL.id,prefix+'/actions/workflows/'+destination+'/dispatches','POST',{ref:'main',inputs});
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
      const list = await g.json(CENTRAL.id,prefix+'/actions/workflows/'+destination+'/runs?event=workflow_dispatch&head_sha='+r.policy+'&created='+window+'&per_page=100');
      ensure(Array.isArray(list.workflow_runs) && list.total_count === list.workflow_runs.length,'RELEASE_RELAY_WINDOW');
      const hits = list.workflow_runs.filter((x:any) => x.path === '.github/workflows/'+destination && x.display_title === title+key &&
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
