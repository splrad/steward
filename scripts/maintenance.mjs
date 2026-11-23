import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {jobFact,originalJobExecutions,activeMaintenanceWorkflows,maintenanceJobKeys,maintenanceDisposition,maintenanceFailed,decodeMaintenanceRecord,assertMaintenanceProgress} from '../packages/runner/dist/index.js';
import {writeReleaseRecords} from './release-record.mjs';
import {centralRegistrationWorkflow, registrationRunName} from './repository-registration-policy.mjs';

const repositoryId=1296724484;
const policyRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const check=(value,code)=>{if(!value)throw Error('MAINTENANCE_'+code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const utc=value=>{check(typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)),'TIME');return new Date(value).toISOString();};
const identity=r=>[r.id,r.workflow_id,r.repository?.id,r.head_repository?.id,r.path,r.head_sha,r.head_branch,r.event,r.created_at];
const observation=r=>[...identity(r),r.run_attempt,r.status,r.conclusion,r.updated_at];
const isRegistrationRun=run=>run.path===centralRegistrationWorkflow&&run.event==='repository_dispatch'
  &&run.display_title===registrationRunName;

export async function maintenanceDefinition(file) {
  check(activeMaintenanceWorkflows.includes(file),'WORKFLOW');
  const parsed=YAML.parseDocument(await readFile(join(policyRoot,'.github/workflows',file),'utf8'));
  check(!parsed.errors.length,'DEFINITION');const d=parsed.toJS({maxAliasCount:100}),keys=maintenanceJobKeys(file);
  const currentKeys=keys.filter(key=>key!=='automation-health'||Object.hasOwn(d.jobs,key));
  check(same(Object.keys(d.jobs).sort(),[...currentKeys].sort()),'DEFINITION_JOBS');
  const names={};
  for(const key of keys) {
    const j=d.jobs[key];
    if(!j&&key==='automation-health'){names[key]=key;continue;}
    const name=j.name??key;
    check(typeof name==='string'&&!name.includes('${{'),'DEFINITION_NAME');
    names[key]=name;
    // A failed health job must never drag successful business jobs into a rerun.
    const needs=Array.isArray(j.needs)?j.needs:j.needs?[j.needs]:[];
    check(key==='automation-health'?needs.length===0:!needs.includes('automation-health'),'HEALTH_DEPENDENCY');
  }
  // Runs created before retirement still occur in the maintenance lookback and saved records.
  const events = Object.keys(d.on);
  if (file === 'sync-managed.yml') events.push('push', 'schedule');
  return {file,names,events};
}
function source(run,workflow,definition,branch) {
  check(positive(run.id)&&positive(run.run_attempt)&&run.repository?.id===repositoryId&&run.head_repository?.id===repositoryId
    &&run.workflow_id===workflow.id&&run.path===workflow.path&&run.head_branch===branch&&sha(run.head_sha)
    &&definition.events.includes(run.event)&&(['push','schedule','workflow_dispatch','workflow_run'].includes(run.event)
      ||definition.file==='sync-managed.yml'&&run.event==='repository_dispatch'),'RUN_SOURCE');
  utc(run.created_at);utc(run.updated_at);
}
function jobsProjection(raw,run,definition) {
  check(Array.isArray(raw)&&raw.length>0&&new Set(raw.map(j=>j.id)).size===raw.length,'JOBS');
  for(const j of raw) check(j.run_id===run.id&&j.head_sha===run.head_sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt,'JOB_SOURCE');
  // Historical Sync Runs may still report the skipped registration job.
  if(definition.file==='sync-managed.yml')raw=raw.filter(j=>{
    if(j.name!=='register')return true;
    check(j.status==='completed'&&j.conclusion==='skipped','REGISTRATION_ROUTE');
    return false;
  });
  const originals=new Set(originalJobExecutions(Array.from({length:run.run_attempt},(_,i)=>({attempt:i+1,
    jobs:raw.filter(j=>j.run_attempt===i+1).map(jobFact)}))).map(j=>j.id));
  return raw.filter(j=>originals.has(j.id)).map(j=>{
    check(positive(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt
      &&j.status==='completed'&&Array.isArray(j.steps),'JOB_SOURCE');
    const key=Object.keys(definition.names).find(k=>definition.names[k]===j.name);
    check(key,'UNREGISTERED_JOB');
    return {id:j.id,key,matrixIndex:null,attempt:j.run_attempt,conclusion:j.conclusion,empty:null,found:null};
  }).sort((a,b)=>a.attempt-b.attempt||a.id-b.id);
}

export async function recoverMaintenanceRun({reader,io,workflow,definition,branch,runId,store,coordinator,expectedRun,beforePost,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}) {
  check(activeMaintenanceWorkflows.includes(definition.file),'WORKFLOW');
  const run=await reader.json(`actions/runs/${runId}`);source(run,workflow,definition,branch);check(run.id===runId,'RUN_ID');
  if(expectedRun) {
    check(same(identity(run),identity(expectedRun)),'EVENT_IDENTITY');
    if(run.run_attempt>expectedRun.run_attempt)return {status:'SUPERSEDED'};
    check(run.run_attempt===expectedRun.run_attempt,'EVENT_ATTEMPT');
    if(run.status==='completed')check(run.conclusion===expectedRun.conclusion,'EVENT_CONCLUSION');
  }
  if(run.status!=='completed')return {status:'WAIT'};
  if(isRegistrationRun(run))return {status:'REGISTRATION'};
  const jobs=jobsProjection(await reader.pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),run,definition);
  const after=await reader.json(`actions/runs/${runId}`);source(after,workflow,definition,branch);
  if(!same(observation(run),observation(after)))return {status:'WAIT'};
  const prior=await store.load(runId);
  const record=decodeMaintenanceRecord(Buffer.from(JSON.stringify({schemaVersion:1,repositoryId,workflowFile:definition.file,workflowId:workflow.id,runId,
    headSha:run.head_sha,headBranch:branch,event:run.event,createdAt:utc(run.created_at),runAttempt:run.run_attempt,conclusion:run.conclusion,
    jobs,observedAt:new Date(now()).toISOString(),requests:prior?.requests??[]})),repositoryId,`maintenance/${runId}.json`);
  if(prior)assertMaintenanceProgress(prior,record);
  const disposition=maintenanceDisposition(record);
  // A health-only failure neither creates a maintenance failure record nor consumes a recovery request.
  if(disposition==='SATISFIED'&&!prior)return {status:'SATISFIED'};
  if(!prior&&disposition==='UNKNOWN')return {status:'UNKNOWN'};
  const unchanged=expectedRun&&prior&&same({...prior,observedAt:record.observedAt},record);
  if(!unchanged)await store.save(record,prior);
  if(disposition!=='FAILED')return {status:disposition};
  if(now()-Date.parse(record.createdAt)>30*24*60*60_000)return {status:'EXPIRED'};
  // An accepted response waits for native visibility. An unknown/rejected send can be reconciled once
  // by a later serialized coordinator wake, using fresh complete facts and the second reserved slot.
  if(record.requests.some(r=>r.fromAttempt===run.run_attempt&&(r.responseStatus===201
    ||r.coordinatorRunId===coordinator.runId&&r.coordinatorRunAttempt===coordinator.runAttempt
    ||expectedRun&&r.coordinatorRunId!==coordinator.runId)))return {status:'UNKNOWN'};
  if(!maintenanceFailed(run.conclusion))return {status:'UNKNOWN'};
  // A native failed-jobs rerun executes the original workflow revision.
  const retiredJob = record.jobs.findLast(job => job.key === 'automation-health');
  if (retiredJob && !['success', 'skipped'].includes(retiredJob.conclusion)) return {status:'UNKNOWN'};
  if(beforePost)await beforePost();
  const claim=structuredClone(record);
  claim.requests.push({fromAttempt:run.run_attempt,requestedAt:new Date(now()).toISOString(),coordinatorRunId:coordinator.runId,coordinatorRunAttempt:coordinator.runAttempt,responseStatus:null});
  claim.observedAt=claim.requests.at(-1).requestedAt;
  await store.save(claim,unchanged?prior:record);
  // Persisted intent ownership and exact native source must both still agree before the only POST.
  check(same(await store.load(runId),claim),'CLAIM_CHANGED');
  const active=await reader.json(`actions/workflows/${workflow.id}`);
  if(active.id!==workflow.id||active.path!==workflow.path||active.state!=='active')return {status:'WAIT'};
  const fresh=await reader.json(`actions/runs/${runId}`);source(fresh,workflow,definition,branch);
  if(!same(observation(fresh),observation(run)))return {status:'WAIT'};
  if(beforePost)await beforePost();
  let response;
  try{response=await io.request('POST',reader.path(`actions/runs/${runId}/rerun-failed-jobs`));}catch{}
  const responseRecord=structuredClone(claim);responseRecord.requests.at(-1).responseStatus=response?.status??null;responseRecord.observedAt=new Date(now()).toISOString();
  await store.save(responseRecord,claim);
  // GitHub may acknowledge a rerun before the next attempt becomes visible.
  const delays=expectedRun&&response?.status===201?[0,2000,4000,8000]:[0];
  for(const delay of delays) {
    if(delay)await wait(delay);
    const observed=await reader.json(`actions/runs/${runId}`);source(observed,workflow,definition,branch);
    check(same(identity(observed),identity(run))&&observed.run_attempt>=run.run_attempt,'RERUN_SOURCE');
    if(observed.run_attempt>run.run_attempt)return {status:'ACCEPTED'};
  }
  return {status:'UNKNOWN'};
}

/** The store writes exactly one central maintenance path through the existing fast-forward connection. */
export function maintenanceGitStore({refresh,writeDirectory,defaultBranch,token,identity,beforePush},write=writeReleaseRecords) {
  const current=async()=>{const state=await refresh();check(state.snapshot.repositoryId===repositoryId&&state.snapshot.targetRef==='steward/release-state','STATE_SCOPE');return state;};
  const find=(state,id)=>state.snapshot.domainRecords.find(r=>r.path===`maintenance/${id}.json`)??null;
  return {
    async load(id){return find(await current(),id)?.value??null;},
    async save(value,expected) {
      const path=`maintenance/${value.runId}.json`,content=JSON.stringify(value)+'\n';decodeMaintenanceRecord(Buffer.from(content),repositoryId,path);
      const state=await current(),previous=find(state,value.runId);
      check(same(previous?.value??null,expected),'STATE_CHANGED');
      if(previous)assertMaintenanceProgress(previous.value,value);
      if(previous?.content===content&&state.snapshot.currentPaths.includes(path))return;
      const previousSha256=state.snapshot.currentPaths.includes(path)?hash(await state.readBytes(path)):null;
      const directory=join(writeDirectory,hash(JSON.stringify([state.snapshot.head,path,content])));await mkdir(writeDirectory,{recursive:true});
      const result=await write({directory,remote:state.remote,repositoryId,defaultBranch,targetRef:'steward/release-state',writer:'maintenance',
        expectedHead:state.snapshot.head,allowedPaths:[path],changes:[{path,content,sha256:hash(content),previousSha256}],identity},{token,beforePush});
      check(['APPLIED','UNCHANGED'].includes(result.status),'ARCHIVE_UNCONFIRMED');
      const readback=await current();check(readback.snapshot.currentPaths.includes(path)&&find(readback,value.runId)?.content===content,'ARCHIVE_READBACK');
    }
  };
}
