import registry from '../../../config/pages-completion.json' with {type:'json'};
import {rejectedDispatch,retryAfterTime} from './bounded-retry-after.js';
import {BoundedGitHub,CENTRAL,TARGET,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {dispatchFixed} from './bounded-recheck-effects.js';

type Site={repositoryId:number;repository:string;workflowId:number};
type Locator={id:number;run_attempt:number;head_sha:string;conclusion:string};
type Retry={site:Site;hint:Locator;policy:string;reservation:string;due:number;expires:number};
type Watch=Pick<Retry,'site'|'hint'|'policy'|'expires'>;
type StoredWatch=Watch & {startedAt?:number};
const probeInterval=5*60000;
const failed=new Set(['failure','cancelled','timed_out','action_required','startup_failure']);
const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const path='.github/workflows/pages.yml';
const receiver='pages-maintenance-event.yml';

// Called only after handleWebhook has verified the raw HMAC and installation scope.
export async function forwardPagesCompletion(env:BoundedEnv,event:string,p:any,g:GitReader,sites:readonly Site[]=registry.publicSites) {
  const repo=p.repository,hint=p.workflow_run;
  if(!sites.length||env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='workflow_run'||p.action!=='completed'
    ||!p.installation?.id||p.installation.id!==Number(env.INSTALLATION_ID)
    ||repo?.id!==TARGET.id||repo.full_name!==TARGET.name||repo.private!==false||repo.has_pages!==true
    ||repo.fork!==false||repo.archived!==false||repo.disabled!==false||hint?.path!==path||!failed.has(hint.conclusion))return;
  const site=sites.find(s=>s.repositoryId===repo.id&&s.repository===repo.full_name&&s.workflowId===hint.workflow_id);
  if(!site)return;
  ensure(positive(hint.id)&&positive(hint.run_attempt),'PAGES_LOCATOR');
  await forward(env,site,{id:hint.id,run_attempt:hint.run_attempt,head_sha:hint.head_sha,conclusion:hint.conclusion},g);
}
async function recordReceipt(db:D1Database,g:GitReader,site:Site,hint:Locator,policySha:string,reservedAt:string){
  const key=[site.repositoryId,site.workflowId,hint.id,hint.run_attempt];
  const title=`Pages completion ${site.repositoryId} ${hint.id} ${hint.run_attempt}`;
  // Permit ordinary clock skew between the GitHub event and the worker clock.
  const since=new Date(Date.parse(reservedAt)-60000).toISOString();
  const until=new Date(Date.parse(reservedAt)+5*60000).toISOString();
  const window=encodeURIComponent(since+'..'+until);
  const list=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/workflows/${receiver}/runs?event=workflow_dispatch&head_sha=${policySha}&created=${window}&per_page=100`);
  ensure(Array.isArray(list.workflow_runs)&&list.total_count===list.workflow_runs.length,'PAGES_RECEIPT_WINDOW');
  const matches=list.workflow_runs.filter((r:any)=>r.path==='.github/workflows/'+receiver&&r.display_title===title&&r.event==='workflow_dispatch'
    &&r.actor?.id===301115370&&r.repository?.id===CENTRAL.id&&r.head_repository?.id===CENTRAL.id&&r.head_branch==='main'&&r.head_sha===policySha);
  ensure(matches.length<=1,'PAGES_RECEIPT_AMBIGUOUS');
  if(!matches.length)return false;
  ensure(positive(matches[0].id),'PAGES_RECEIPT_ID');
  const saved=await db.prepare('UPDATE pages_completion_dispatches SET central_run_id=? WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=? AND controller_sha=? AND reserved_at=? AND retry_after IS NULL AND (central_run_id IS NULL OR central_run_id=?)')
    .bind(matches[0].id,...key,policySha,reservedAt,matches[0].id).run();
  ensure(saved.success&&saved.meta.changes===1,'PAGES_RECEIPT_STORE');return true;
}
async function forward(env:BoundedEnv,site:Site,hint:Locator,g:GitReader,retry?:Retry,schedule?:(ticket:Retry)=>Promise<void>){
  const db=env.ISSUE_SNAPSHOTS;
  ensure(db,'PAGES_DISPATCH_STORAGE');
  const key=[site.repositoryId,site.workflowId,hint.id,hint.run_attempt];
  // This primary key deliberately excludes the delivery ID, D and M. A redelivery or
  // a rollout cannot acquire a fresh right to send for the same product attempt.
  const existing=await db.prepare('SELECT controller_sha,reserved_at,run_created_at,retry_after,central_run_id FROM pages_completion_dispatches WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=?')
    .bind(...key).first<{controller_sha:string;reserved_at:string;run_created_at:string;retry_after:number|null;central_run_id:number|null}>();
  if(existing?.central_run_id)return;
  const retrying=!!retry && !!existing && existing.reserved_at===retry.reservation &&
    existing.retry_after!==null && Date.now()>=existing.retry_after && existing.controller_sha===retry.policy && env.BOUNDED_CONTROLLER_SHA===retry.policy;
  const reservedAt=retrying?new Date(Math.max(Date.now(),Date.parse(retry!.reservation)+1)).toISOString():
    existing?.reserved_at??new Date().toISOString();
  const scheduleRetry=async(ticket:Retry)=>{
    if(schedule){await schedule(ticket);return;}
    ensure(env.BOUNDED_RECHECK,'PAGES_RETRY_STORAGE');
    const object=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('pages-retry:v1:'+key.join(':')));
    const result=await object.fetch(new Request('https://bounded.internal/pages-retry',{method:'POST',body:JSON.stringify(ticket)}));
    ensure(result.ok,'PAGES_RETRY_REGISTRATION');
  };
  if(!retrying && retry && (!existing || existing.retry_after===null))return;
  if(existing&&!retrying){
    if(existing.retry_after!==null){
      if(existing.controller_sha===env.BOUNDED_CONTROLLER_SHA)await scheduleRetry({site,hint,policy:existing.controller_sha,
        reservation:existing.reserved_at,due:existing.retry_after,expires:Date.parse(existing.run_created_at)+30*86400_000});
      return;
    }
    ensure(await recordReceipt(db,g,site,hint,existing.controller_sha,reservedAt),'PAGES_DISPATCH_UNCONFIRMED');return;
  }
  const base='/repos/'+TARGET.name;
  const workflow=await g.json(TARGET.id,base+'/actions/workflows/pages.yml');
  if(workflow.id!==site.workflowId||workflow.path!==path||workflow.state!=='active')return;
  const run=await g.json(TARGET.id,base+'/actions/runs/'+hint.id);
  if(run.repository?.private!==false||run.repository.full_name!==site.repository||run.repository.id!==site.repositoryId
    ||run.head_repository?.id!==site.repositoryId||run.workflow_id!==site.workflowId||run.path!==path
    ||run.id!==hint.id||run.run_attempt!==hint.run_attempt||run.status!=='completed'||run.conclusion!==hint.conclusion
    ||!['push','release','workflow_dispatch'].includes(run.event)||!/^[a-f0-9]{40}$/.test(run.head_sha)||run.head_sha!==hint.head_sha)return;
  const created=Date.parse(run.created_at);
  ensure(Number.isFinite(created),'PAGES_ORIGINAL_RUN_TIME');
  // The original run plus two recovery attempts are in scope. Forward the third
  // completion so the central receiver can report exhaustion without a fourth run.
  if(Date.now()-created>30*86400_000||run.run_attempt>3)return;
  const pin=env.BOUNDED_CONTROLLER_SHA;
  ensure(typeof pin==='string'&&/^[a-f0-9]{40}$/.test(pin),'PAGES_CONTROLLER');
  // Refuse to relay when the current central policy removed the site before D was redeployed.
  const policyPath='config/pages-completion.json';
  const file=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/contents/${policyPath}?ref=${pin}`);
  ensure(file.type==='file'&&file.path===policyPath&&file.encoding==='base64'&&typeof file.content==='string'
    &&positive(file.size)&&file.size<=16384,'PAGES_REGISTRY');
  const bytes=Buffer.from(file.content,'base64');
  ensure(bytes.length===file.size,'PAGES_REGISTRY_SIZE');
  const policy=JSON.parse(bytes.toString('utf8'));
  ensure(Array.isArray(policy.publicSites),'PAGES_REGISTRY_SCHEMA');
  if(!policy.publicSites.some((s:Site)=>s.repositoryId===site.repositoryId&&s.repository===site.repository&&s.workflowId===site.workflowId))return;

  let ownsClaim=false;
  const reserve=async()=>{
    const current=await g.json(TARGET.id,base);
    ensure(current.id===site.repositoryId&&current.full_name===site.repository,'PAGES_REPOSITORY_CHANGED');
    if(current.private!==false||current.fork!==false||current.has_pages!==true||current.archived!==false||current.disabled!==false)return false;
    if(!retrying){
      ensure(env.BOUNDED_RECHECK,'PAGES_RETRY_STORAGE');
      const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('pages-retry:v1:'+key.join(':')));
      const response=await stub.fetch(new Request('https://bounded.internal/pages-watch',{method:'POST',
        body:JSON.stringify({site,hint,policy:pin,expires:created+30*86400_000})}));
      ensure(response.ok,'PAGES_WATCH_REGISTRATION');
    }
    const result=retrying?await db.prepare('UPDATE pages_completion_dispatches SET reserved_at=?,retry_after=NULL WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=? AND controller_sha=? AND reserved_at=? AND retry_after=? AND central_run_id IS NULL')
      .bind(reservedAt,...key,pin,retry!.reservation,existing!.retry_after).run():await db.prepare('INSERT INTO pages_completion_dispatches(repository_id,workflow_id,run_id,attempt,controller_sha,reserved_at,run_created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repository_id,workflow_id,run_id,attempt) DO NOTHING')
      .bind(...key,pin,reservedAt,new Date(created).toISOString()).run();
    ensure(result.success&&[0,1].includes(result.meta.changes),'PAGES_DISPATCH_CLAIM');
    ownsClaim=result.meta.changes===1;
    return ownsClaim;
  };
  try {
    await dispatchFixed(g,CENTRAL.id,receiver,pin,{
      repository_id:String(site.repositoryId),workflow_id:String(site.workflowId),run_id:String(run.id),attempt:String(run.run_attempt),policy_sha:pin,
    },reserve);
  }catch(error) {
    if(ownsClaim && rejectedDispatch(error)){
      const now=Date.now(),due=Math.max(now+1000,retryAfterTime(error,now,now+60000-1)??now+60000);
      const ticket:Retry={site,hint,policy:pin,reservation:reservedAt,due,expires:created+30*86400_000};
      const saved=await db.prepare('UPDATE pages_completion_dispatches SET retry_after=? WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=? AND controller_sha=? AND reserved_at=? AND central_run_id IS NULL')
        .bind(due,...key,pin,reservedAt).run();
      ensure(saved.success&&saved.meta.changes===1,'PAGES_REJECTION_STORE');
      await scheduleRetry(ticket);return;
    }
    if(ownsClaim&&await recordReceipt(db,g,site,hint,pin,reservedAt))return;
    throw error; // Keep the reservation even if the POST response or the worker was interrupted.
  }
  if(ownsClaim)ensure(await recordReceipt(db,g,site,hint,pin,reservedAt),'PAGES_DISPATCH_UNCONFIRMED');
}


// Only an explicit HTTP rejection can produce a retry ticket. D1 still grants
// the sole dispatch right, including across process restarts and rollbacks.
export class PagesRetry {
  constructor(private store:DurableObjectStorage,private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env),
    private sites:readonly Site[]=registry.publicSites){}
  async watch(watch:Watch){
    await this.store.transaction(async t=>{
      if(await t.get('pagesWatch'))return;
      await t.put('pagesWatch',{...watch,startedAt:Date.now()});
      if(!await t.get('pagesRetry'))await t.setAlarm(Math.min(watch.expires,Date.now()+probeInterval));
    });
  }
  private async reconcileWatch(){
    const watch=await this.store.get<StoredWatch>('pagesWatch');if(!watch)return;
    if(Date.now()<watch.expires && (this.env.BOUNDED_RECHECK_ENABLED!=='true'||this.env.BOUNDED_CONTROLLER_SHA!==watch.policy)){
      await this.store.setAlarm(Math.min(watch.expires,Date.now()+probeInterval));return;
    }
    const {site,hint,policy,expires}=watch;
    const active=this.sites.some(s=>s.repositoryId===site.repositoryId&&s.workflowId===site.workflowId&&s.repository===site.repository);
    if(active && Date.now()<expires){
      await this.store.setAlarm(Math.min(expires,Date.now()+probeInterval));
      const db=this.env.ISSUE_SNAPSHOTS;ensure(db,'PAGES_DISPATCH_STORAGE');
      const row=await db.prepare('SELECT reserved_at,retry_after,central_run_id,controller_sha FROM pages_completion_dispatches WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=?')
        .bind(site.repositoryId,site.workflowId,hint.id,hint.run_attempt).first<{reserved_at:string;retry_after:number|null;central_run_id:number|null;controller_sha:string}>();
      if(!row && Date.now()<(watch.startedAt??0)+3*probeInterval)return;
      if(row?.central_run_id===null&&row.controller_sha===policy){
        if(row.retry_after!==null){
          await this.schedule({...watch,reservation:row.reserved_at,due:row.retry_after});return;
        }
        // Probe only the original receipt window. Keep the reservation after the
        // bounded observation period so a later webhook can still confirm it.
        const deadline=Math.min(expires,Date.parse(row.reserved_at)+3*probeInterval);
        if(Date.now()<deadline){
          try{if(!await recordReceipt(db,this.reader(),site,hint,policy,row.reserved_at))return;}
          catch(error){
            const now=Date.now(),floor=retryAfterTime(error,now,deadline);
            if(floor===undefined)throw error;
            await this.store.setAlarm(Math.min(deadline,Math.max(now+probeInterval,floor)));return;
          }
        }
      }
    }
    await this.store.transaction(async t=>{
      await t.delete('pagesWatch');
      if(!await t.get('pagesRetry'))await t.deleteAlarm();
    });
  }
  async schedule(ticket:Retry){
    await this.store.transaction(async t=>{
      const prior=await t.get<Retry>('pagesRetry');
      if(prior && prior.reservation>ticket.reservation)return;
      if(prior?.reservation===ticket.reservation)ticket.due=Math.max(prior.due,ticket.due);
      if(ticket.due>=ticket.expires){await t.delete('pagesRetry');await t.deleteAlarm();return;}
      await t.put('pagesRetry',ticket);await t.setAlarm(ticket.due);
    });
  }
  async alarm(){
    const ticket=await this.store.get<Retry>('pagesRetry');if(!ticket){await this.reconcileWatch();return;}
    const now=Date.now();if(now<ticket.due){await this.store.setAlarm(ticket.due);return;}
    const site=this.sites.find(s=>s.repositoryId===ticket.site.repositoryId&&s.repository===ticket.site.repository&&s.workflowId===ticket.site.workflowId);
    if(Date.now()<ticket.expires && (this.env.BOUNDED_RECHECK_ENABLED!=='true'||this.env.BOUNDED_CONTROLLER_SHA!==ticket.policy)){
      await this.store.setAlarm(Math.min(ticket.expires,Date.now()+probeInterval));return;
    }
    let again:number|undefined;
    if(site && now<ticket.expires){
      // Arm recovery before I/O. A crash after acquiring the D1 reservation
      // makes this ticket stale and can never authorize a second POST.
      await this.store.setAlarm(Math.min(now+60000,ticket.expires));
      try{await forward(this.env,site,ticket.hint,this.reader(),ticket,next=>this.schedule(next));}
      catch(error){again=Math.max(now+60000,retryAfterTime(error,now,now+60000-1)??0);}
    }
    await this.store.transaction(async t=>{
      const current=await t.get<Retry>('pagesRetry');
      if(current?.reservation!==ticket.reservation||current.due!==ticket.due)return;
      if(again!==undefined && again<ticket.expires){
        current.due=again;await t.put('pagesRetry',current);await t.setAlarm(again);
      }else{
        await t.delete('pagesRetry');
        if(await t.get('pagesWatch'))await t.setAlarm(Date.now()+probeInterval);else await t.deleteAlarm();
      }
    });
  }
}
