import {effectiveValidator,matchesValidationPull,validatorCommit,validatorRunSource} from './required-workflow-binding.mjs';

const name='STEWARD_VALIDATOR_REVALIDATION';
export const journalRepository={id:1447987054,name:'splrad/steward-settings'};
const variables=`/repos/${journalRepository.name}/actions/variables`;
const key=`${variables}/${name}`;
const check=(ok,reason,status)=>{if(!ok)throw Object.assign(Error('VALIDATOR_REVALIDATION_'+reason),{status});};
const number=value=>Number.isSafeInteger(value)&&value>0;
const active=new Set(['queued','waiting','prepared','reopened','in_progress']);
const actorId=301115370;
// GitHub user IDs for dependabot[bot] and renovate[bot]. Both interpret a closed PR as a declined update.
const dependencyBotIds=new Set([49699333,29139614]);
const synchronizeGrace=2*60*1000;

async function get(io,path) {
  const result=await io.request('GET',path);
  check(result.status===200&&result.value!=null,'READ_'+result.status,result.status);
  return result.value;
}

async function pages(io,path,list,identity=row=>row.id) {
  const rows=[];
  for(let page=1;page<=100;page++) {
    const data=await get(io,`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    const batch=list?data[list]:data;
    check(Array.isArray(batch),'PAGE');
    rows.push(...batch);
    if(batch.length<100||list&&data.total_count===rows.length) {
      check((!list||data.total_count===rows.length)&&new Set(rows.map(identity)).size===rows.length,'INCOMPLETE_PAGE');
      return rows;
    }
  }
  throw Error('VALIDATOR_REVALIDATION_INCOMPLETE_PAGE');
}

export function validatorJournal(io) {
  let saved;
  async function read() {
    const response=await io.request('GET',key);
    if(response.status===404)return null;
    check(response.status===200&&response.value?.name===name&&typeof response.value.value==='string','JOURNAL_READ',response.status);
    return response.value.value;
  }
  return {
    async load() {
      saved=await read();
      if(saved===null)return null;
      const state=JSON.parse(saved);
      check(state.schema===1&&validatorCommit(state.previous)&&validatorCommit(state.validator)
        &&state.previous!==state.validator&&['discover','observe'].includes(state.phase)&&Array.isArray(state.pulls),'JOURNAL_SCHEMA');
      for(const entry of state.pulls)check(number(entry.repoId)&&/^splrad\/[\w.-]+$/.test(entry.repo)
        &&number(entry.number)&&validatorCommit(entry.head)&&number(entry.headRepo)&&typeof entry.headRef==='string'
        &&typeof entry.base==='string'&&['queued','waiting','prepared','reopened','in_progress','success','failure',
          'superseded','manual'].includes(entry.status)
        &&(entry.notBefore===undefined||number(entry.notBefore))
        &&(entry.closeRequest===undefined||['pending','accepted','rejected','unknown'].includes(entry.closeRequest))
        &&(entry.status!=='prepared'||Number.isSafeInteger(entry.marker)&&entry.marker>=0),'JOURNAL_ENTRY');
      return state;
    },
    async save(state) {
      const raw=JSON.stringify(state);
      if(saved===raw)return;
      check(Buffer.byteLength(raw)<=47*1024,'JOURNAL_SIZE');
      check(await read()===saved,'JOURNAL_CONCURRENT');
      let writeStatus;
      try {({status:writeStatus}=await io.request(saved===null?'POST':'PATCH',saved===null?variables:key,{name,value:raw}));}catch{}
      check(await read()===raw,'JOURNAL_WRITE',writeStatus);
      saved=raw;
    }
  };
}

export function epoch(previous,validator) {
  return {schema:1,previous,validator,phase:'discover',pulls:[]};
}

const prefix=repo=>'/repos/'+repo;
const scope=(io,repo,base)=>pages(io,`${prefix(repo)}/rules/branches/${encodeURIComponent(base)}`,null,
  rule=>JSON.stringify([rule.ruleset_id,rule.type,rule.parameters??null]));
const exactPull=(pr,entry)=>pr.number===entry.number&&pr.base?.ref===entry.base&&pr.base?.repo?.id===entry.repoId
  &&pr.head?.sha===entry.head&&pr.head?.repo?.id===entry.headRepo&&pr.head?.ref===entry.headRef;
const ownedRelease=pr=>pr.user?.id===301115370&&typeof pr.head?.ref==='string'&&pr.head.repo?.id===pr.base?.repo?.id
  &&(pr.head.ref==='release-please--branches--'+pr.base.ref || pr.head.ref.startsWith('release-please--branches--'+pr.base.ref+'--components--'));

function revalidationWait(pr) {
  if(dependencyBotIds.has(pr.user?.id))return 'dependency-managed';
  if(ownedRelease(pr))return 'release-managed';
  if(pr.draft)return 'draft';
  // GitHub does not schedule pull_request for a conflicted merge. A behind PR
  // can instead be reopened with an older event base, unusable by the strict gate.
  if(pr.mergeable===false||pr.mergeable_state==='dirty')return 'merge-conflict';
  if(pr.mergeable_state==='behind')return 'base-behind';
  if(pr.mergeable!==true||!['clean','unstable','blocked','has_hooks'].includes(pr.mergeable_state))
    return 'mergeability-pending';
  return null;
}

export async function discoverPulls(app,ioFor,state) {
  const entries=[];
  for(const repo of await app.discover()) {
    if(repo.archived||repo.disabled||!/^splrad\/[\w.-]+$/.test(repo.full_name))continue;
    await ioFor(repo.id,async io=>{
      const rule=effectiveValidator(await scope(io,repo.full_name,repo.default_branch),{optional:true});
      if(rule===null)return;
      check(rule===state.validator,'EFFECTIVE_SCOPE');
      const prs=await pages(io,`${prefix(repo.full_name)}/pulls?state=open&base=${encodeURIComponent(repo.default_branch)}`);
      for(const pr of prs) {
        check(pr.base?.repo?.id===repo.id&&pr.base?.ref===repo.default_branch&&number(pr.number),'PULL_SCOPE');
        if(!number(pr.head?.repo?.id)||!validatorCommit(pr.head.sha))continue;
        entries.push({repoId:repo.id,repo:repo.full_name,number:pr.number,base:pr.base.ref,
          head:pr.head.sha,headRepo:pr.head.repo.id,headRef:pr.head.ref,status:'queued'});
      }
    });
  }
  state.pulls=entries;
  state.phase='observe';
}

async function matchingRun(io,pr,source) {
  const path=`${prefix(pr.base.repo.full_name)}/actions/runs?event=pull_request&head_sha=${pr.head.sha}`;
  const rows=await pages(io,path,'workflow_runs');
  for(const run of rows.filter(run=>matchesValidationPull(run,pr)).sort((a,b)=>b.id-a.id)) {
    if(await validatorRunSource(io.graphql,run)!==source)continue;
    const current=await get(io,`${prefix(pr.base.repo.full_name)}/actions/runs/${run.id}`);
    check(matchesValidationPull(current,pr)&&current.id===run.id&&current.node_id===run.node_id&&current.workflow_id===run.workflow_id
      &&number(current.run_attempt)&&typeof current.status==='string','RUN_CHANGED');
    const receipt={id:current.id,attempt:current.run_attempt,source,head:current.head_sha,status:current.status,conclusion:current.conclusion};
    if(current.status!=='completed'||current.conclusion!=='success')return receipt;
    const jobs=await pages(io,`${prefix(pr.base.repo.full_name)}/actions/runs/${run.id}/attempts/${current.run_attempt}/jobs`,'jobs');
    const aggregate=jobs.filter(job=>job.name==='SPLRAD Validation');
    const [job]=aggregate;
    const after=await get(io,`${prefix(pr.base.repo.full_name)}/actions/runs/${run.id}`);
    if(aggregate.length!==1||!number(job.id)||job.run_id!==run.id||job.run_attempt!==current.run_attempt
      ||job.head_sha!==current.head_sha||job.status!=='completed'||job.conclusion!=='success'
      ||!matchesValidationPull(after,pr)||after.node_id!==current.node_id||after.run_attempt!==current.run_attempt
      ||after.status!=='completed'||after.conclusion!=='success')return {...receipt,evidence:'pending'};
    return {...receipt,job:job.id};
  }
  return null;
}

async function lastTransition(io,path) {
  const events=await pages(io,path);
  return events.filter(event=>['closed','reopened','merged'].includes(event.event)).sort((a,b)=>b.id-a.id)[0];
}

async function mutate(io,path,state) {
  // The caller always reads the resulting PR and native event, even after a lost response.
  let response;
  try {response=await io.request('PATCH',path,{state});}catch{}
  return response?.status??'unknown';
}

async function mergeManaged(io,pr) {
  if(pr.auto_merge)return true;
  check(typeof pr.node_id==='string'&&pr.node_id,'PULL_NODE');
  const result=await io.graphql('query($id:ID!){node(id:$id){... on PullRequest{id number headRefOid isInMergeQueue autoMergeRequest{enabledAt}}}}',{id:pr.node_id});
  const pull=result?.node;
  check(pull?.id===pr.node_id&&pull.number===pr.number&&pull.headRefOid===pr.head.sha
    &&typeof pull.isInMergeQueue==='boolean','PULL_GRAPHQL');
  return pull.isInMergeQueue||pull.autoMergeRequest!=null;
}

export async function reconcilePull(io,state,entry,save,guard,record,{draining=false,now=Date.now}={}) {
  const root=prefix(entry.repo),path=`${root}/pulls/${entry.number}`,events=`${root}/issues/${entry.number}/events`;
  const observed=async()=>get(io,path);
  const change=async(status,more={})=>{
    delete entry.reason;
    Object.assign(entry,more,{status});
    await save();
    await record({kind:'validator-pull',validator:state.validator,status});
  };
  const supersede=async pr=>{
    // A synchronize event normally schedules the new head itself. Keep the old
    // evidence and watch the exact successor before considering a missing Run.
    if(!draining&&pr.state==='open'&&!pr.merged&&pr.number===entry.number&&pr.base?.repo?.id===entry.repoId
      &&pr.base?.ref===entry.base&&number(pr.head?.repo?.id)&&typeof pr.head.ref==='string'&&pr.head.ref
      &&validatorCommit(pr.head.sha)&&!exactPull(pr,entry)
      &&!state.pulls.some(other=>active.has(other.status)&&exactPull(pr,other))){
      // A later mergeability check can move the successor back to waiting.
      const reopenEvent=state.pulls.find(other=>exactPull(pr,other)&&number(other.reopenEvent))?.reopenEvent;
      state.pulls.push({repoId:entry.repoId,repo:entry.repo,number:entry.number,base:entry.base,
        head:pr.head.sha,headRepo:pr.head.repo.id,headRef:pr.head.ref,
        status:reopenEvent?'reopened':'waiting',reopenEvent,reason:'synchronize',notBefore:now()+synchronizeGrace});
    }
    return change('superseded');
  };
  const observeRun=run=>change(run.status!=='completed'||run.evidence==='pending'?'in_progress':run.conclusion==='success'?'success':'failure',{run});
  // A PREPARED write is a durable intent, including the last native state transition.
  // Only this App's later close authorizes a reopen. No fresh work starts while draining.
  if(entry.status==='prepared') {
    const pr=await observed(),last=await lastTransition(io,events);
    if(pr.merged||last?.event==='merged')return supersede(pr);
    if(pr.state==='closed') {
      if(last?.id>entry.marker&&last.event==='closed'&&last.actor?.id===actorId){
        await guard();
        const fresh=await observed(),transition=await lastTransition(io,events);
        if(fresh.state!=='closed'||fresh.merged||transition?.id!==last.id)return;
        const response=await mutate(io,path,'open');
        const reopened=await observed(),after=await lastTransition(io,events);
        if(reopened.state!=='open'||after?.event!=='reopened'||after.actor?.id!==actorId||after.id<=last.id)
          return record({kind:'validator-reopen-pending',response});
        entry.reopenEvent=after.id;
        return exactPull(reopened,entry)?change('reopened'):supersede(reopened);
      }
      if(last?.id>entry.marker)return change('manual');
      return record({kind:'validator-close-evidence-pending'});
    }
    if(last?.id>entry.marker){
      if(last.event!=='reopened'||last.actor?.id!==actorId)return change('manual');
      entry.reopenEvent=last.id;
      return exactPull(pr,entry)?change('reopened'):supersede(pr);
    }
    // An open snapshot cannot rule out a delayed close after transport loss.
    // Keep its original marker until a native transition proves what happened.
    if(entry.closeRequest&&entry.closeRequest!=='rejected')return record({kind:'validator-close-unconfirmed'});
    if(draining||!exactPull(pr,entry))return supersede(pr);
  }else if(draining)return;

  const pr=await observed();
  if(pr.state!=='open'||!exactPull(pr,entry))return supersede(pr);
  const binding=effectiveValidator(await scope(io,entry.repo,entry.base));
  check(binding===state.validator,'PULL_PIN_MOVED');
  const run=await matchingRun(io,pr,state.validator);
  if(run)return observeRun(run);
  if(entry.status==='in_progress')return record({kind:'validator-run-readback-pending'});
  const wait=revalidationWait(pr);
  if(wait)return change('waiting',{reason:wait});
  if(entry.status==='reopened'||entry.reopenEvent)return record({kind:'validator-native-run-pending'});
  if(entry.notBefore>now())return record({kind:'validator-synchronize-run-pending'});
  if(await mergeManaged(io,pr))return change('waiting',{reason:'merge-management'});
  if(entry.status!=='prepared'){
    const last=await lastTransition(io,events);
    await change('prepared',{marker:last?.id??0});
  }
  await guard();
  const fresh=await observed(),last=await lastTransition(io,events);
  if(fresh.state!=='open'||!exactPull(fresh,entry)||(last?.id??0)!==entry.marker)return;
  const freshWait=revalidationWait(fresh);
  if(freshWait)return change('waiting',{reason:freshWait});
  if(await mergeManaged(io,fresh))return change('waiting',{reason:'merge-management'});
  const native=await matchingRun(io,fresh,state.validator);
  if(native)return observeRun(native);
  await change('prepared',{closeRequest:'pending'});
  const beforeClose=await observed();
  if(beforeClose.state!=='open'||!exactPull(beforeClose,entry)){
    return change('prepared',{closeRequest:'rejected'});
  }
  const finalWait=revalidationWait(beforeClose);
  if(finalWait||await mergeManaged(io,beforeClose))
    return change('waiting',{reason:finalWait??'merge-management',closeRequest:'rejected'});
  const response=await mutate(io,path,'closed');
  const closeRequest=response>=200&&response<300?'accepted'
    :[400,401,403,404,409,410,422,429].includes(response)?'rejected':'unknown';
  await change('prepared',{closeRequest});
  await record({kind:'validator-close-request',response});
  // Re-enter once when the close is visible. A delayed close stays prepared for recovery.
  if((await observed()).state==='closed')await reconcilePull(io,state,entry,save,guard,record,{draining,now});
}

export async function reconcileValidators(state,app,ioFor,journal,guard,record,{draining=false,now=Date.now}={}) {
  if(state.phase==='discover'&&!draining){
    await guard();
    await discoverPulls(app,ioFor,state);
    await journal.save(state);
  }
  let errors=0;
  for(const entry of state.pulls) {
    if(!active.has(entry.status)||draining&&entry.status!=='prepared')continue;
    try {await ioFor(entry.repoId,io=>reconcilePull(io,state,entry,()=>journal.save(state),guard,record,{draining,now}));}
    catch(error) {
      errors++;
      const code=/^(?:PROMOTION|CONTROLLER_SOURCE|VALIDATOR(?:_REVALIDATION)?)_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'VALIDATOR_REVALIDATION_UNAVAILABLE';
      await record({kind:'validator-revalidation-pull-error',code});
    }
  }
  const counts=Object.fromEntries([...new Set(state.pulls.map(entry=>entry.status))]
    .map(status=>[status,state.pulls.filter(entry=>entry.status===status).length]));
  await record({kind:'validator-revalidation',validator:state.validator,draining,counts});
  check(!errors,'PULLS_PENDING');
}

export function hasPendingValidators(state) {
  return state.phase==='discover'||state.pulls.some(entry=>active.has(entry.status));
}
