import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeEvidenceReader,decodePagesMaintenance,assertPagesProgress,pagesRecordPath,maintenanceFailed,nativeGhCommand,nativeReleaseDownload} from '../packages/runner/dist/index.js';
import {currentPagesSource,pagesDeployment,assertPagesRun} from './pages-runtime.mjs';
import {pagesDispatchInputs,pagesRunName,pagesWorkflow,verifyPagesRelease} from './select-pages-source.mjs';
import {writeReleaseRecords} from './release-record.mjs';

const check=(v,c)=>{if(!v)throw Error('PAGES_'+c);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=v=>createHash('sha256').update(v).digest('hex');
const positive=v=>Number.isSafeInteger(v)&&v>0;
const utc=v=>{check(typeof v==='string'&&Number.isFinite(Date.parse(v)),'TIME');return new Date(v).toISOString();};
const runFacts=r=>[r.id,r.workflow_id,r.repository?.id,r.head_repository?.id,r.path,r.head_sha,r.head_branch,r.event,r.run_attempt,r.status,r.conclusion,r.updated_at];

export function pagesGitStore({repositoryId,refresh,writeDirectory,defaultBranch,token,identity},write=writeReleaseRecords) {
  const current=async()=>{const s=await refresh();check(s.snapshot.repositoryId===repositoryId&&s.snapshot.targetRef==='steward/governance-state','STATE_SCOPE');return s;};
  const find=(s,path)=>s.snapshot.domainRecords.find(r=>r.path===path)??null;
  return {
    async load(path){return find(await current(),path)?.value??null;},
    async save(value,expected) {
      const path=pagesRecordPath(value),content=JSON.stringify(value)+'\n';decodePagesMaintenance(Buffer.from(content),repositoryId,path);
      const state=await current(),previous=find(state,path);check(same(previous?.value??null,expected),'STATE_CHANGED');
      if(previous)assertPagesProgress(previous.value,value);
      if(previous?.content===content&&state.snapshot.currentPaths.includes(path))return;
      await mkdir(writeDirectory,{recursive:true});
      const result=await write({directory:join(writeDirectory,hash(JSON.stringify([state.snapshot.head,path,content]))),remote:state.remote,repositoryId,defaultBranch,
        targetRef:'steward/governance-state',writer:'pages',expectedHead:state.snapshot.head,allowedPaths:[path],identity,
        changes:[{path,content,sha256:hash(content),previousSha256:state.snapshot.currentPaths.includes(path)?hash(await state.readBytes(path)):null}]},{token});
      check(['APPLIED','UNCHANGED'].includes(result.status),'ARCHIVE_UNCONFIRMED');
      const after=await current();check(after.snapshot.currentPaths.includes(path)&&find(after,path)?.content===content,'ARCHIVE_READBACK');
    }
  };
}

/** Complete bounded discovery, including old queued/rerun entries without a created lower bound. */
export async function pagesRunInventory(reader,workflow,source,start,end) {
  const window=async(low,high)=>{
    const p=`actions/workflows/${workflow.id}/runs?created=${new Date(low*1000).toISOString()}..${new Date(high*1000).toISOString()}`;
    const first=await reader.json(p+'&per_page=100');check(Number.isSafeInteger(first.total_count)&&first.total_count>=0,'INVENTORY');
    if(first.total_count>=1000){check(low<high,'WINDOW_SATURATED');const mid=Math.floor((low+high)/2);return [...await window(low,mid),...await window(mid+1,high)];}
    const rows=await reader.pages(p,'workflow_runs');check(rows.length<1000,'WINDOW_CHANGED');
    check(rows.every(r=>Date.parse(utc(r.created_at))>=low*1000&&Date.parse(r.created_at)<(high+1)*1000),'WINDOW_SOURCE');return rows;
  };
  const all=await window(start,end);
  for(const status of ['requested','queued','in_progress','waiting','pending']) {
    const p=`actions/workflows/${workflow.id}/runs?status=${status}`,first=await reader.json(p+'&per_page=100');
    check(Number.isSafeInteger(first.total_count)&&first.total_count<1000,'ACTIVE_SATURATED');
    all.push(...await reader.pages(p,'workflow_runs'));
  }
  const unique=new Map();
  for(const r of all) {
    check(positive(r.id)&&r.workflow_id===workflow.id&&r.path===pagesWorkflow&&r.repository?.id===source.repositoryId&&r.head_repository?.id===source.repositoryId,'INVENTORY_SOURCE');
    const prior=unique.get(r.id);check(!prior||same(runFacts(prior),runFacts(r)),'INVENTORY_CHANGED');unique.set(r.id,r);
  }
  return [...unique.values()].filter(r=>r.head_sha===source.sourceSha&&r.head_branch===source.ref.replace(/^refs\/(heads|tags)\//,'')
    &&(source.mode==='default-branch'?['push','workflow_dispatch']:['release','workflow_dispatch']).includes(r.event)
    &&r.display_title===(r.event==='workflow_dispatch'?pagesRunName(source):`Pages ${source.mode} ${source.sourceSha} ${r.event==='release'?source.releaseId:r.id}`)).sort((a,b)=>a.id-b.id);
}

async function sourceOptions(reader,repository,controllerSha,appBotId) {
  const read=async name=>{
    const response=await reader.io.request('GET',reader.path(`actions/variables/${name}`));
    if(response.status===404)return '';
    check(response.status===200,'VARIABLE_UNAVAILABLE');const value=JSON.parse(Buffer.from(response.bytes));
    check(value.name===name&&typeof value.value==='string','VARIABLE');return value.value;
  };
  const mode=await read('STEWARD_DOCS_SOURCE'),unitId=mode==='release'?await read('STEWARD_DOCS_UNIT'):'';
  return {reader,repositoryId:repository.id,mode,unitId,controllerSha,appBotId};
}

/** Fixed product Pages consumer. Records and API writes remain in this repository; no release cycle mutation. */
export async function servicePages({io,repository,store,coordinator,appBotId,token},ports={}) {
  const now=ports.now??Date.now,started=now(),deadline=started+3*60_000;let requests=0;
  const bounded={request:async(method,path,...args)=>{
    check(now()<deadline&&requests++<800,'READ_BUDGET');
    check(path===`/repos/${repository.full_name}`||path.startsWith(`/repos/${repository.full_name}/`),'API_SCOPE');
    if(method==='POST')check(new RegExp(`^/repos/${repository.full_name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/actions/(?:workflows/[1-9][0-9]*/dispatches|runs/[1-9][0-9]*/rerun)$`).test(path),'WRITE_SCOPE');
    return io.request(method,path,...args);
  }};
  const reader=new NativeEvidenceReader(bounded,repository.full_name);
  const current=ports.currentSource??(async()=>currentPagesSource(await sourceOptions(reader,repository,coordinator.controllerSha,appBotId),{
    verifyRelease:input=>verifyPagesRelease(input,{gh:args=>nativeGhCommand(args,token),download:nativeReleaseDownload(token)})}));
  const desired=await current();if(desired.status!=='READY')return {status:desired.status};
  const source=desired.source;check(source.repositoryId===repository.id&&source.repository===repository.full_name,'REPOSITORY');
  const workflow=await reader.json('actions/workflows/pages.yml');check(positive(workflow.id)&&workflow.path===pagesWorkflow,'WORKFLOW');
  if(workflow.state!=='active')return {status:'DISABLED'};
  const deployment=await (ports.deployment??pagesDeployment)(reader,source,{anySource:true});
  if(deployment?.sourceSha===source.sourceSha&&deployment?.inputDigest===source.inputDigest)return {status:'SATISFIED'};
  // A later real site deployment distinguishes a legitimate return to an older source from a duplicate wake.
  // Its native identity is local maintenance context; dispatch inputs stay exactly the four baseline fields.
  const siteDeploymentId=deployment?.deploymentId??null;
  const path=pagesRecordPath({kind:'DISPATCH',source,siteDeploymentId}),prior=await store.load(path);
  if(prior)check(prior.workflowId===workflow.id&&same(prior.source,source),'STATE_SOURCE');
  const inventory=()=>pagesRunInventory(reader,workflow,source,Math.floor(started/1000)-30*86400,Math.floor(now()/1000));
  const allRuns=await inventory();
  const runs=allRuns.filter(r=>r.status!=='completed'||!deployment||Date.parse(r.created_at)>=Date.parse(deployment.deployedAt));
  if(runs.some(r=>r.status!=='completed'))return {status:'WAIT'};
  const bound=prior?.runId?await reader.json(`actions/runs/${prior.runId}`):null;
  if(bound)assertPagesRun(bound,source,workflow.id);
  const run=bound&&maintenanceFailed(bound.conclusion)?bound:runs.find(r=>maintenanceFailed(r.conclusion));
  const stamp=()=>new Date(now()).toISOString();
  const record=prior??{schemaVersion:1,kind:'DISPATCH',repositoryId:repository.id,workflowId:workflow.id,source,runId:null,runAttempt:0,siteDeploymentId,createdAt:stamp(),observedAt:stamp(),requests:[]};
  if(run) {
    assertPagesRun(run,source,workflow.id);
    if(run.status!=='completed')return {status:'WAIT'};
    // Bind once: neither duplicate events nor cache loss may reset the original Run's recovery budget.
    if(record.runId===null){const bound={...record,runId:run.id,observedAt:stamp()};await store.save(bound,prior);}
    if(!maintenanceFailed(run.conclusion))return {status:'UNKNOWN'};
    const runPath=`maintenance/pages/${run.id}.json`,old=await store.load(runPath);
    const value={schemaVersion:1,kind:'RUN',repositoryId:repository.id,workflowId:workflow.id,source,runId:run.id,runAttempt:run.run_attempt,siteDeploymentId:old?old.siteDeploymentId:siteDeploymentId,
      createdAt:utc(run.created_at),observedAt:stamp(),requests:old?.requests??[]};
    await store.save(value,old);
    if(run.run_attempt>=3||value.requests.length>=2)return {status:'EXHAUSTED'};
    if(now()-Date.parse(value.createdAt)>30*86400_000)return {status:'EXPIRED'};
    const last=value.requests.at(-1);
    if(last?.fromAttempt===run.run_attempt&&(last.responseStatus===201||last.coordinatorRunId===coordinator.runId&&last.coordinatorRunAttempt===coordinator.runAttempt
      ||now()-Date.parse(last.requestedAt)<60_000))return {status:'WAIT'};
    const fresh=await current();if(fresh.status!=='READY'||!same(fresh.source,source))return {status:'STALE'};
    const active=await reader.json('actions/workflows/pages.yml');if(active.id!==workflow.id||active.state!=='active')return {status:'DISABLED'};
    const before=await reader.json(`actions/runs/${run.id}`);if(!same(runFacts(before),runFacts(run)))return {status:'WAIT'};
    const claim=structuredClone(value);claim.requests.push({fromAttempt:run.run_attempt,requestedAt:stamp(),coordinatorRunId:coordinator.runId,coordinatorRunAttempt:coordinator.runAttempt,responseStatus:null});claim.observedAt=stamp();
    await store.save(claim,value);check(same(await store.load(runPath),claim),'CLAIM_CHANGED');
    const claimedSource=await current();if(claimedSource.status!=='READY'||!same(claimedSource.source,source))return {status:'STALE'};
    if(!same(runFacts(await reader.json(`actions/runs/${run.id}`)),runFacts(run)))return {status:'WAIT'};
    if((await reader.json('actions/workflows/pages.yml')).state!=='active')return {status:'DISABLED'};
    let response;try{response=await bounded.request('POST',reader.path(`actions/runs/${run.id}/rerun`));}catch{}
    const result=structuredClone(claim);result.requests.at(-1).responseStatus=response?.status??null;result.observedAt=stamp();await store.save(result,claim);
    const after=await reader.json(`actions/runs/${run.id}`);assertPagesRun(after,source,workflow.id);
    return {status:after.run_attempt>run.run_attempt?'ACCEPTED':'UNKNOWN'};
  }
  if(record.requests.length>=3)return {status:'EXHAUSTED'};
  const last=record.requests.at(-1);
  const accepted=last&&runs.some(r=>r.event==='workflow_dispatch'&&Date.parse(r.created_at)>=Date.parse(last.requestedAt));
  if(last&&(last.responseStatus===204&&!accepted||last.coordinatorRunId===coordinator.runId&&last.coordinatorRunAttempt===coordinator.runAttempt||now()-Date.parse(last.requestedAt)<60_000))return {status:'WAIT'};
  if(runs.some(r=>!['success','skipped'].includes(r.conclusion)||now()-Date.parse(r.updated_at)<60_000))return {status:'WAIT'};
  const fresh=await current();if(fresh.status!=='READY'||!same(fresh.source,source))return {status:'STALE'};
  const active=await reader.json('actions/workflows/pages.yml');if(active.id!==workflow.id||active.state!=='active')return {status:'DISABLED'};
  if((await inventory()).some(r=>r.status!=='completed'||maintenanceFailed(r.conclusion)&&(!deployment||Date.parse(r.created_at)>=Date.parse(deployment.deployedAt))))return {status:'WAIT'};
  const claim=structuredClone(record);claim.requests.push({fromAttempt:0,requestedAt:stamp(),coordinatorRunId:coordinator.runId,coordinatorRunAttempt:coordinator.runAttempt,responseStatus:null});claim.observedAt=stamp();
  await store.save(claim,prior);check(same(await store.load(path),claim),'CLAIM_CHANGED');
  const claimedSource=await current();if(claimedSource.status!=='READY'||!same(claimedSource.source,source))return {status:'STALE'};
  if((await inventory()).some(r=>r.status!=='completed'||maintenanceFailed(r.conclusion)&&(!deployment||Date.parse(r.created_at)>=Date.parse(deployment.deployedAt))))return {status:'WAIT'};
  if((await reader.json('actions/workflows/pages.yml')).state!=='active')return {status:'DISABLED'};
  let response;try{response=await bounded.request('POST',reader.path(`actions/workflows/${workflow.id}/dispatches`),undefined,{ref:source.ref,inputs:pagesDispatchInputs(source)});}catch{}
  const result=structuredClone(claim);result.requests.at(-1).responseStatus=response?.status??null;result.observedAt=stamp();await store.save(result,claim);
  const after=await inventory();return {status:after.some(r=>r.event==='workflow_dispatch'&&Date.parse(r.created_at)>=Date.parse(claim.requests.at(-1).requestedAt))?'ACCEPTED':'UNKNOWN'};
}
