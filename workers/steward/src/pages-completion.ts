import registry from '../../../config/pages-completion.json' with {type:'json'};
import {rejectedDispatch,retryAfterTime} from './bounded-retry-after.js';
import {BoundedGitHub,CENTRAL,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {dispatchFixed} from './bounded-recheck-effects.js';

type Site={repositoryId:number;repository:string;workflowId:number};
type Locator={id:number;run_attempt:number;head_sha:string;conclusion:string};
type Retry={site:Site;hint:Locator;policy:string;reservation:string;due:number;expires:number};
type ReceiptQuery={site:Site;hint:Locator;policy:string;reservation:string};
type Watch=Pick<Retry,'site'|'hint'|'policy'|'expires'>;
type Intake=Watch & {attempts:number;due:number;exhausted?:boolean};
type StoredWatch=Watch & {startedAt?:number};
const probeInterval=5*60000;
const failed=new Set(['failure','cancelled','timed_out','action_required','startup_failure']);
const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const path='.github/workflows/pages.yml';
const receiver='pages-maintenance-event.yml';

// Called only after handleWebhook has verified the raw HMAC and installation scope.
export async function forwardPagesCompletion(env:BoundedEnv,event:string,p:any,sites:readonly Site[]=registry.publicSites) {
  const repo=p.repository,hint=p.workflow_run;
  if(!sites.length||env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='workflow_run'||p.action!=='completed'
    ||!p.installation?.id||p.installation.id!==Number(env.INSTALLATION_ID)
    ||!repo||repo.private!==false||repo.has_pages!==true
    ||repo.fork!==false||repo.archived!==false||repo.disabled!==false||hint?.path!==path||!failed.has(hint.conclusion))return;
  const site=sites.find(s=>s.repositoryId===repo.id&&s.repository===repo.full_name&&s.workflowId===hint.workflow_id);
  if(!site)return;
  ensure(positive(hint.id)&&positive(hint.run_attempt),'PAGES_LOCATOR');
  const policy=env.BOUNDED_CONTROLLER_SHA,created=Date.parse(hint.created_at);
  if(!/^[a-f0-9]{40}$/.test(hint.head_sha)||hint.run_attempt>3||!Number.isFinite(created)||created+30*86400_000<=Date.now())return;
  ensure(typeof policy==='string'&&/^[a-f0-9]{40}$/.test(policy)&&env.BOUNDED_RECHECK,'PAGES_INTAKE_STORAGE');
  const locator:Locator={id:hint.id,run_attempt:hint.run_attempt,head_sha:hint.head_sha,conclusion:hint.conclusion};
  const key=[site.repositoryId,site.workflowId,hint.id,hint.run_attempt];
  const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('pages-retry:v1:'+key.join(':')));
  const response=await stub.fetch(new Request('https://bounded.internal/pages-intake',{method:'POST',
    body:JSON.stringify({site,hint:locator,policy,expires:Math.min(created,Date.now())+30*86400_000})}));
  ensure(response.ok,'PAGES_INTAKE_REGISTRATION');
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
async function forward(env:BoundedEnv,site:Site,hint:Locator,g:GitReader,owner:PagesRetry,retry?:Retry){
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
  const receipt=(policy:string)=>owner.receipt({site,hint,policy,reservation:reservedAt});
  if(!retrying && retry && (!existing || existing.retry_after===null))return;
  if(existing&&!retrying){
    if(existing.retry_after!==null){
      if(existing.controller_sha===env.BOUNDED_CONTROLLER_SHA)await owner.schedule({site,hint,policy:existing.controller_sha,
        reservation:existing.reserved_at,due:existing.retry_after,expires:Date.parse(existing.run_created_at)+30*86400_000});
      return;
    }
    ensure(await receipt(existing.controller_sha),'PAGES_DISPATCH_UNCONFIRMED');return;
  }
  const base='/repos/'+site.repository;
  const workflow=await g.json(site.repositoryId,base+'/actions/workflows/pages.yml');
  if(workflow.id!==site.workflowId||workflow.path!==path||workflow.state!=='active')return;
  const run=await g.json(site.repositoryId,base+'/actions/runs/'+hint.id);
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
    const current=await g.json(site.repositoryId,base);
    ensure(current.id===site.repositoryId&&current.full_name===site.repository,'PAGES_REPOSITORY_CHANGED');
    if(current.private!==false||current.fork!==false||current.has_pages!==true||current.archived!==false||current.disabled!==false)return false;
    if(!retrying)await owner.watch({site,hint,policy:pin,expires:created+30*86400_000});
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
      await owner.schedule(ticket);return;
    }
    if(ownsClaim&&await receipt(pin))return;
    throw error; // Keep the reservation even if the POST response or the worker was interrupted.
  }
  if(ownsClaim)ensure(await receipt(pin),'PAGES_DISPATCH_UNCONFIRMED');
}


// Only an explicit HTTP rejection can produce a retry ticket. D1 still grants
// the sole dispatch right, including across process restarts and rollbacks.
export class PagesRetry {
  constructor(private store:DurableObjectStorage,private env:BoundedEnv,private reader:(site:Site)=>GitReader=site=>new BoundedGitHub(env,undefined,undefined,{id:site.repositoryId,name:site.repository}),
    private sites:readonly Site[]=registry.publicSites){}
  async intake(incoming:Watch){
    const now=Date.now();
    const claim=await this.store.transaction(async t=>{
      const prior=await t.get<Intake>('pagesIntake');
      const item=prior??{...incoming,due:now,attempts:0};
      if(item.exhausted){
        if(now>=item.expires)await t.delete('pagesIntake');
        else if(await t.getAlarm()===null)await t.setAlarm(item.expires);
        return;
      }
      if(item.due>now){
        if(await t.getAlarm()===null)await t.setAlarm(item.due);
        return;
      }
      const active=this.sites.some(site=>site.repositoryId===item.site.repositoryId&&site.repository===item.site.repository&&site.workflowId===item.site.workflowId);
      if(!active||now>=item.expires){await t.delete('pagesIntake');return;}
      if(item.attempts>=4){
        await t.put('pagesIntake',{...item,exhausted:true});await t.setAlarm(item.expires);return;
      }
      item.due=Math.min(item.expires,now+probeInterval);
      if(this.env.BOUNDED_RECHECK_ENABLED!=='true'||this.env.BOUNDED_CONTROLLER_SHA!==item.policy){
        await t.put('pagesIntake',item);await t.setAlarm(item.due);return;
      }
      item.attempts++;await t.put('pagesIntake',item);
      if(await t.getAlarm()===null)await t.setAlarm(item.due);
      return item;
    });
    if(!claim)return;
    let failure:unknown;
    try{await forward(this.env,claim.site,claim.hint,this.reader(claim.site),this);}
    catch(error){failure=error;}
    let reserved=false;
    if(failure&&await this.store.get('pagesWatch')){
      const {site,hint}=claim;
      const row=await this.env.ISSUE_SNAPSHOTS!.prepare('SELECT 1 AS present FROM pages_completion_dispatches WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=?')
        .bind(site.repositoryId,site.workflowId,hint.id,hint.run_attempt).first();
      reserved=!!row;
    }
    await this.store.transaction(async t=>{
      const current=await t.get<Intake>('pagesIntake');
      if(current?.attempts!==claim.attempts||current.due!==claim.due)return;
      const hasOwner=!!(await t.get('pagesRetry')||await t.get('pagesWatch'));
      if(failure&&!reserved && !await t.get('pagesRetry') && current.attempts<4 && Date.now()<current.expires){
        const floor=retryAfterTime(failure,Date.now(),current.expires);
        current.due=Math.min(current.expires,Math.max(current.due,floor??0));
        await t.put('pagesIntake',current);await t.setAlarm(current.due);return;
      }
      if(failure&&!reserved&&!await t.get('pagesRetry') && current.attempts>=4){
        current.due=Math.max(current.due,retryAfterTime(failure,Date.now(),current.expires)??0);
        await t.put('pagesIntake',{...current,exhausted:true});await t.setAlarm(current.expires);
        console.error(JSON.stringify({operation:'pages-preflight-exhausted',repositoryId:claim.site.repositoryId,
          workflowId:claim.site.workflowId,runId:claim.hint.id,attempt:claim.hint.run_attempt}));return;
      }
      await t.delete('pagesIntake');if(!hasOwner)await t.deleteAlarm();
    });
    if(failure)throw failure;
  }
  async receipt(query:ReceiptQuery){
    const now=Date.now(),prior=await this.store.get<{reservation:string;until:number}>('pagesReceiptCooldown');
    if(prior?.reservation===query.reservation && now<prior.until)return false;
    const db=this.env.ISSUE_SNAPSHOTS;ensure(db,'PAGES_DISPATCH_STORAGE');
    try{return await recordReceipt(db,this.reader(query.site),query.site,query.hint,query.policy,query.reservation);}
    catch(error){
      const floor=retryAfterTime(error,Date.now(),Date.parse(query.reservation)+30*86400_000);
      if(floor===undefined)throw error;
      await this.store.transaction(async t=>{
        const current=await t.get<{reservation:string;until:number}>('pagesReceiptCooldown');
        if(!current||current.reservation<query.reservation||current.reservation===query.reservation&&current.until<floor)
          await t.put('pagesReceiptCooldown',{reservation:query.reservation,until:floor});
      });
      return false;
    }
  }
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
          if(!await this.receipt({site,hint,policy,reservation:row.reserved_at})){
            const cooldown=await this.store.get<{reservation:string;until:number}>('pagesReceiptCooldown');
            if(cooldown?.reservation===row.reserved_at)
              await this.store.setAlarm(Math.min(deadline,Math.max(Date.now()+probeInterval,cooldown.until)));
            return;
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
    const ticket=await this.store.get<Retry>('pagesRetry');if(!ticket){
      const intake=await this.store.get<Intake>('pagesIntake');
      if(intake){
        try{await this.intake(intake);}catch{/* The intake or reservation already owns its next alarm. */}
        if(await this.store.get('pagesIntake'))return;
      }
      await this.reconcileWatch();return;
    }
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
      try{await forward(this.env,site,ticket.hint,this.reader(site),this,ticket);}
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
