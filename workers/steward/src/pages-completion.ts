import registry from '../../../config/pages-completion.json' with {type:'json'};
import {CENTRAL,TARGET,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {dispatchFixed} from './bounded-recheck-effects.js';

type Site={repositoryId:number;repository:string;workflowId:number};
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
  const db=env.ISSUE_SNAPSHOTS;
  ensure(db,'PAGES_DISPATCH_STORAGE');
  const key=[site.repositoryId,site.workflowId,hint.id,hint.run_attempt];
  // This primary key deliberately excludes the delivery ID, D and M. A redelivery or
  // a rollout cannot acquire a fresh right to send for the same product attempt.
  const existing=await db.prepare('SELECT controller_sha,reserved_at,central_run_id FROM pages_completion_dispatches WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=?')
    .bind(...key).first<{controller_sha:string;reserved_at:string;central_run_id:number|null}>();
  if(existing?.central_run_id)return;
  const reservedAt=existing?.reserved_at??new Date().toISOString();
  const title=`Pages completion ${site.repositoryId} ${hint.id} ${hint.run_attempt}`;
  const receipt=async(policySha:string)=>{
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
    const saved=await db.prepare('UPDATE pages_completion_dispatches SET central_run_id=? WHERE repository_id=? AND workflow_id=? AND run_id=? AND attempt=? AND controller_sha=? AND (central_run_id IS NULL OR central_run_id=?)')
      .bind(matches[0].id,...key,policySha,matches[0].id).run();
    ensure(saved.success&&saved.meta.changes===1,'PAGES_RECEIPT_STORE');return true;
  };
  if(existing){ensure(await receipt(existing.controller_sha),'PAGES_DISPATCH_UNCONFIRMED');return;}
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
    const result=await db.prepare('INSERT INTO pages_completion_dispatches(repository_id,workflow_id,run_id,attempt,controller_sha,reserved_at,run_created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repository_id,workflow_id,run_id,attempt) DO NOTHING')
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
    if(ownsClaim&&await receipt(pin))return;
    throw error; // Keep the reservation even if the POST response or the worker was interrupted.
  }
  if(ownsClaim)ensure(await receipt(pin),'PAGES_DISPATCH_UNCONFIRMED');
}
