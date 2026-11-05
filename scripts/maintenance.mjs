import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {NativeEvidenceReader,jobFact,originalJobExecutions,maintenanceWorkflows,maintenanceJobKeys,maintenanceDisposition,maintenanceFailed,decodeMaintenanceRecord,assertMaintenanceProgress} from '../packages/runner/dist/index.js';
import {writeReleaseRecords} from './release-record.mjs';

const repository='splrad/steward',repositoryId=1296724484;
const policyRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const check=(value,code)=>{if(!value)throw Error('MAINTENANCE_'+code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const utc=value=>{check(typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)),'TIME');return new Date(value).toISOString();};
const identity=r=>[r.id,r.workflow_id,r.repository?.id,r.head_repository?.id,r.path,r.head_sha,r.head_branch,r.event,r.created_at];
const observation=r=>[...identity(r),r.run_attempt,r.status,r.conclusion,r.updated_at];

export async function maintenanceDefinition(file) {
  check(maintenanceWorkflows.includes(file),'WORKFLOW');
  const parsed=YAML.parseDocument(await readFile(join(policyRoot,'.github/workflows',file),'utf8'));
  check(!parsed.errors.length,'DEFINITION');const d=parsed.toJS({maxAliasCount:100}),keys=maintenanceJobKeys(file);
  const currentKeys=keys.filter(key=>key!=='automation-health'||Object.hasOwn(d.jobs,key));
  check(same(Object.keys(d.jobs).sort(),[...currentKeys].sort()),'DEFINITION_JOBS');
  const names={};
  for(const key of keys) {
    const j=d.jobs[key];
    if(!j&&key==='automation-health'){names[key]=key;continue;}
    const name=j.name??key;
    check(typeof name==='string'&&(key==='update'?name==='update (${{ strategy.job-index }})':!name.includes('${{')),'DEFINITION_NAME');
    names[key]=name;
    // A failed health job must never drag successful business jobs into a rerun.
    const needs=Array.isArray(j.needs)?j.needs:j.needs?[j.needs]:[];
    check(key==='automation-health'?needs.length===0:!needs.includes('automation-health'),'HEALTH_DEPENDENCY');
  }
  return {file,names,events:Object.keys(d.on)};
}
function source(run,workflow,definition,branch) {
  check(positive(run.id)&&positive(run.run_attempt)&&run.repository?.id===repositoryId&&run.head_repository?.id===repositoryId
    &&run.workflow_id===workflow.id&&run.path===workflow.path&&run.head_branch===branch&&sha(run.head_sha)
    &&definition.events.includes(run.event)&&['push','schedule','workflow_dispatch','workflow_run'].includes(run.event),'RUN_SOURCE');
  utc(run.created_at);utc(run.updated_at);
}
function jobsProjection(raw,run,definition) {
  check(Array.isArray(raw)&&raw.length>0&&new Set(raw.map(j=>j.id)).size===raw.length,'JOBS');
  for(const j of raw) check(j.run_id===run.id&&j.head_sha===run.head_sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt,'JOB_SOURCE');
  const originals=new Set(originalJobExecutions(Array.from({length:run.run_attempt},(_,i)=>({attempt:i+1,
    jobs:raw.filter(j=>j.run_attempt===i+1).map(jobFact)}))).map(j=>j.id));
  return raw.filter(j=>originals.has(j.id)).map(j=>{
    check(positive(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt
      &&j.status==='completed'&&Array.isArray(j.steps),'JOB_SOURCE');
    let key=Object.keys(definition.names).find(k=>definition.names[k]===j.name),matrixIndex=null;
    if(definition.file==='update-dependencies.yml'&&typeof j.name==='string') {
      const match=/^update \((0|[1-9][0-9]*)\)$/.exec(j.name);
      if(match){key='update';matrixIndex=Number(match[1]);}
      if(j.name==='update'&&j.conclusion==='skipped')key='update';
    }
    check(key,'UNREGISTERED_JOB');
    const marker=name=>{const values=j.steps.filter(s=>s.name===name);check(values.length<=1,'MARKER_DUPLICATE');return values[0]?.conclusion??null;};
    return {id:j.id,key,matrixIndex,attempt:j.run_attempt,conclusion:j.conclusion,
      empty:key==='targets'?marker('update-targets-empty'):null,found:key==='targets'?marker('update-targets-found'):null};
  }).sort((a,b)=>a.attempt-b.attempt||a.id-b.id);
}

/** Read all pages and bisect GitHub's filtered 1000-result windows. */
export async function maintenanceRunWindow(reader,workflowId,branch,start,end) {
  check(positive(workflowId)&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end,'WINDOW');
  const path=`actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&created=${new Date(start*1000).toISOString()}..${new Date(end*1000).toISOString()}`;
  const first=await reader.json(path+'&per_page=100');check(Number.isSafeInteger(first.total_count)&&first.total_count>=0,'INVENTORY');
  if(first.total_count>=1000) {
    check(start<end,'WINDOW_SATURATED');const mid=Math.floor((start+end)/2);
    return [...await maintenanceRunWindow(reader,workflowId,branch,start,mid),...await maintenanceRunWindow(reader,workflowId,branch,mid+1,end)];
  }
  const runs=await reader.pages(path,'workflow_runs');check(runs.length<1000,'WINDOW_CHANGED');
  check(runs.every(r=>r.workflow_id===workflowId&&r.repository?.id===repositoryId&&r.head_repository?.id===repositoryId
    &&r.head_branch===branch&&Date.parse(utc(r.created_at))>=start*1000&&Date.parse(utc(r.created_at))<(end+1)*1000),'INVENTORY_SOURCE');
  return runs;
}

export async function recoverMaintenanceRun({reader,io,workflow,definition,branch,runId,store,coordinator,now=Date.now}) {
  const run=await reader.json(`actions/runs/${runId}`);source(run,workflow,definition,branch);check(run.id===runId,'RUN_ID');
  if(run.status!=='completed')return {status:'WAIT'};
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
  await store.save(record,prior);
  if(disposition!=='FAILED')return {status:disposition};
  if(now()-Date.parse(record.createdAt)>30*24*60*60_000)return {status:'EXPIRED'};
  // An accepted response waits for native visibility. An unknown/rejected send can be reconciled once
  // by a later serialized coordinator wake, using fresh complete facts and the second reserved slot.
  if(record.requests.some(r=>r.fromAttempt===run.run_attempt&&(r.responseStatus===201
    ||r.coordinatorRunId===coordinator.runId&&r.coordinatorRunAttempt===coordinator.runAttempt)))return {status:'UNKNOWN'};
  if(!maintenanceFailed(run.conclusion))return {status:'UNKNOWN'};
  const claim=structuredClone(record);
  claim.requests.push({fromAttempt:run.run_attempt,requestedAt:new Date(now()).toISOString(),coordinatorRunId:coordinator.runId,coordinatorRunAttempt:coordinator.runAttempt,responseStatus:null});
  claim.observedAt=claim.requests.at(-1).requestedAt;
  await store.save(claim,record);
  // Persisted intent ownership and exact native source must both still agree before the only POST.
  check(same(await store.load(runId),claim),'CLAIM_CHANGED');
  const active=await reader.json(`actions/workflows/${workflow.id}`);
  if(active.id!==workflow.id||active.path!==workflow.path||active.state!=='active')return {status:'WAIT'};
  const fresh=await reader.json(`actions/runs/${runId}`);source(fresh,workflow,definition,branch);
  if(!same(observation(fresh),observation(run)))return {status:'WAIT'};
  let response;
  try{response=await io.request('POST',reader.path(`actions/runs/${runId}/rerun-failed-jobs`));}catch{}
  const responseRecord=structuredClone(claim);responseRecord.requests.at(-1).responseStatus=response?.status??null;responseRecord.observedAt=new Date(now()).toISOString();
  await store.save(responseRecord,claim);
  const observed=await reader.json(`actions/runs/${runId}`);source(observed,workflow,definition,branch);
  check(same(identity(observed),identity(run))&&observed.run_attempt>=run.run_attempt,'RERUN_SOURCE');
  return {status:observed.run_attempt>run.run_attempt?'ACCEPTED':'UNKNOWN'};
}

/** The store writes exactly one central maintenance path through the existing fast-forward connection. */
export function maintenanceGitStore({refresh,writeDirectory,defaultBranch,token,identity},write=writeReleaseRecords) {
  const current=async()=>{const state=await refresh();check(state.snapshot.repositoryId===repositoryId&&state.snapshot.targetRef==='steward/release-state','STATE_SCOPE');return state;};
  const find=(state,id)=>state.snapshot.domainRecords.find(r=>r.path===`maintenance/${id}.json`)??null;
  return {
    async list(){return (await current()).snapshot.domainRecords.filter(r=>/^maintenance\/[1-9][0-9]*\.json$/.test(r.path)).map(r=>r.value);},
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
        expectedHead:state.snapshot.head,allowedPaths:[path],changes:[{path,content,sha256:hash(content),previousSha256}],identity},{token});
      check(['APPLIED','UNCHANGED'].includes(result.status),'ARCHIVE_UNCONFIRMED');
      const readback=await current();check(readback.snapshot.currentPaths.includes(path)&&find(readback,value.runId)?.content===content,'ARCHIVE_READBACK');
    }
  };
}

/** One bounded pass over fixed central consumers; no dispatch, enable, product target or arbitrary command. */
export async function serviceMaintenance({io,store,defaultBranch,coordinator},now=Date.now) {
  const started=now(),deadline=started+5*60_000,counts={observed:0,recovered:0,waiting:0,exhausted:0,unknown:0},errors=new Set();let requests=0;
  const bounded={request:async(method,path,...args)=>{check(now()<deadline&&requests++<1000,'READ_BUDGET');check(path==='/repos/splrad/steward'||path.startsWith('/repos/splrad/steward/'),'API_SCOPE');return io.request(method,path,...args);}};
  const reader=new NativeEvidenceReader(bounded,repository);
  const repoResponse=await bounded.request('GET','/repos/splrad/steward');check(repoResponse.status===200,'REPOSITORY_READ');
  const repo=JSON.parse(Buffer.from(repoResponse.bytes).toString('utf8'));check(repo.id===repositoryId&&repo.full_name===repository&&repo.default_branch===defaultBranch&&!repo.archived&&!repo.disabled,'REPOSITORY');
  const origin=await reader.json(`actions/runs/${coordinator.runId}`);
  check(origin.id===coordinator.runId&&origin.run_attempt===coordinator.runAttempt&&origin.repository?.id===repositoryId&&origin.head_repository?.id===repositoryId
    &&origin.head_branch===defaultBranch&&origin.head_sha===coordinator.controllerSha&&origin.path==='.github/workflows/release.yml'
    &&['schedule','workflow_dispatch'].includes(origin.event),'COORDINATOR');
  const known=await store.list(),start=Math.floor(started/1000)-30*24*3600,end=Math.floor(started/1000),candidates=[];
  for(const file of maintenanceWorkflows) {
    try {
      const definition=await maintenanceDefinition(file),workflow=await reader.json(`actions/workflows/${file}`);
      check(positive(workflow.id)&&workflow.path===`.github/workflows/${file}`,'WORKFLOW_ID');
      if(workflow.state!=='active'){counts.waiting++;continue;}
      const runs=await maintenanceRunWindow(reader,workflow.id,defaultBranch,start,end);
      const ids=new Set(runs.filter(r=>r.status==='completed'&&maintenanceFailed(r.conclusion)).map(r=>r.id));
      for(const r of known)if(r.workflowFile===file){check(r.workflowId===workflow.id,'WORKFLOW_REPLACED');ids.add(r.runId);}
      for(const runId of ids)candidates.push({workflow,definition,runId,lastObserved:known.find(r=>r.runId===runId)?.observedAt??'1970-01-01T00:00:00.000Z'});
    }catch{counts.unknown++;errors.add('MAINTENANCE_DISCOVERY_UNAVAILABLE');}
  }
  candidates.sort((a,b)=>a.lastObserved.localeCompare(b.lastObserved)||a.runId-b.runId);
  for(const candidate of candidates) {
    if(now()>=deadline||requests>=1000){counts.unknown++;errors.add('MAINTENANCE_READ_BUDGET');break;}
    try {
      const result=await recoverMaintenanceRun({...candidate,reader,io:bounded,branch:defaultBranch,store,coordinator,now});counts.observed++;
      if(result.status==='ACCEPTED')counts.recovered++;
      else if(['EXHAUSTED','EXPIRED'].includes(result.status)){counts.exhausted++;errors.add('MAINTENANCE_RECOVERY_EXHAUSTED');}
      else if(result.status==='UNKNOWN'){counts.unknown++;errors.add('MAINTENANCE_EVIDENCE_REQUIRED');}
      else counts.waiting++;
    }catch{counts.unknown++;errors.add('MAINTENANCE_EVIDENCE_REQUIRED');}
  }
  return {counts,errorCodes:[...errors].sort(),requests,elapsedMs:now()-started};
}
