import {readFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

export const forkRunName='Product CI ${{ github.event.pull_request.number }} ${{ github.event.pull_request.base.sha }} ${{ github.event.pull_request.head.sha }}';

export function matchesRun(run,path,event,type) {
  const pr=event.pull_request;
  if(run.repository?.id!==event.repository.id||run.path!==path||run.event!==type)return false;
  if(type==='push')return run.head_repository?.id===event.repository.id&&run.head_sha===event.after
    &&event.ref==='refs/heads/'+run.head_branch;
  return type==='pull_request'&&run.head_sha===pr.head.sha&&run.head_repository?.id===pr.head.repo.id
    &&run.pull_requests?.some(item=>item.number===pr.number&&item.base?.repo?.id===pr.base.repo.id
      &&item.base?.ref===pr.base.ref&&item.base?.sha===pr.base.sha&&item.head?.repo?.id===pr.head.repo.id
      &&item.head?.sha===pr.head.sha&&item.head?.ref===pr.head.ref);
}

// GitHub may omit PR associations on forks. Its run title is useful only if the
// platform attributes the actual workflow definition to our exact checked blob.
export function boundForkRun(run,path,event,type,boundNames){
  const pr=event.pull_request;
  if(type!=='pull_request'||!pr||pr.head.repo.id===event.repository.id||run.pull_requests?.length!==0
    ||!boundNames.includes(path)||run.path!==path||run.event!==type||run.repository?.id!==event.repository.id
    ||run.head_repository?.id!==pr.head.repo.id||run.head_branch!==pr.head.ref||run.head_sha!==pr.head.sha
    ||run.display_title!==`Product CI ${pr.number} ${pr.base.sha} ${pr.head.sha}`)return false;
  return true;
}

export function workflowSource(file,path,event,head){
  const sources=[event.repository.full_name,event.pull_request?.head.repo.full_name].filter(Boolean);
  return file?.path===path&&sources.some(repo=>file.repositoryFileUrl===`https://github.com/${repo}/blob/${head}/${path}`);
}

class IncompleteJobsSnapshot extends Error {}

function corroboratesAttempt(run,jobs,checks,attemptHistory) {
  const prior=new Set();
  for(const job of attemptHistory){
    if(job.run_id!==run.id||job.head_sha!==run.head_sha||!Number.isSafeInteger(job.id)||job.id<=0
      ||!Number.isSafeInteger(job.run_attempt)||job.run_attempt<1||job.run_attempt>run.run_attempt)
      throw Error('Product CI job attempt history mismatch');
    if(job.run_attempt<run.run_attempt)prior.add(job.id);
  }
  const expected=new Map();
  for(const check of checks){
    if(check.app?.id!==15368)continue;
    const detail=`https://github.com/${run.repository.full_name}/actions/runs/${run.id}/job/${check.id}`;
    if(check.check_suite?.id!==run.check_suite_id||check.head_sha!==run.head_sha||check.details_url!==detail
      ||!Number.isSafeInteger(check.id)||check.id<=0)throw Error('Product CI check suite source mismatch');
    // The suite spans retries. The Actions history assigns attempts to Check
    // Run IDs, including carried jobs whose start time predates this retry.
    if(prior.has(check.id))continue;
    if(expected.has(check.id))throw Error('Product CI duplicate check run');
    expected.set(check.id,check);
  }
  return jobs.length===expected.size&&jobs.every(job=>{
    const check=expected.get(job.id);
    return check?.name===job.name&&check.status===job.status&&check.conclusion===job.conclusion;
  });
}

async function readAttemptJobs(run,loadJobs,{deadline=Infinity,wait=delay,loadChecks,loadAttemptHistory}={}) {
  const problem=()=>Error(run.path+' run '+run.id+' attempt '+run.run_attempt+' has incomplete job evidence');
  if(!Number.isSafeInteger(run.check_suite_id)||run.check_suite_id<=0
    ||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||typeof loadChecks!=='function'
    ||run.run_attempt>1&&typeof loadAttemptHistory!=='function')throw problem();
  const observedIds=new Set();
  let previous;
  for(let pause=1000;;pause*=2){
    let jobs;
    try {jobs=await loadJobs(run);}
    catch(error){if(!(error instanceof IncompleteJobsSnapshot))throw error;}
    let snapshot;
    if(jobs){
      if(new Set(jobs.map(job=>job.id)).size!==jobs.length||jobs.some(job=>
        !Number.isSafeInteger(job.id)||job.id<=0||typeof job.name!=='string'||!job.name||
        job.run_id!==run.id||job.head_sha!==run.head_sha||job.run_attempt!==run.run_attempt
        ||job.status==='completed'&&job.conclusion!=null&&!['success','skipped'].includes(job.conclusion)))throw problem();
      for(const job of jobs)observedIds.add(job.id);
      const complete=jobs.every(job=>job.status==='completed'&&['success','skipped'].includes(job.conclusion));
      if(complete&&jobs.length===observedIds.size&&jobs.some(job=>job.conclusion==='success'
        &&job.steps?.some(step=>step.status==='completed'&&step.conclusion==='success'))){
        let checks,attemptHistory;
        try {
          [checks,attemptHistory]=await Promise.all([loadChecks(run),run.run_attempt>1?loadAttemptHistory(run):[]]);
        }
        catch(error){if(!(error instanceof IncompleteJobsSnapshot))throw error;}
        if(checks&&corroboratesAttempt(run,jobs,checks,attemptHistory)){
          snapshot=JSON.stringify(jobs.map(job=>[job.id,job.name,job.conclusion]).sort((a,b)=>a[0]-b[0]));
          if(snapshot===previous)return jobs;
        }
      }
    }
    // Keep every seen ID and require consecutive terminal inventories agreed
    // by both the Actions attempt and its independently listed Check Runs.
    previous=snapshot;
    if(pause>8000||Date.now()+pause>=deadline)throw problem();
    await wait(pause);
  }
}

export async function evidence(paths,runs,event,type,loadJobs,boundNames=[],loadFile=async()=>null,pending=new Set(),options={}) {
  if(!Array.isArray(paths)||!paths.length)throw Error('VALIDATION_PRODUCT_CI_NOT_CONFIGURED: .github/product-ci.json');
  const receipts=[];
  for(const path of paths){
    let run;
    for(const candidate of runs.filter(item=>item.path===path).sort((a,b)=>b.id-a.id)){
      if(matchesRun(candidate,path,event,type)||boundForkRun(candidate,path,event,type,boundNames)){
        run=candidate;break;
      }
    }
    if(run&&run.status!=='completed')pending.add(path);
    if(!run||run.status!=='completed')continue;
    if(run.conclusion!=='success')throw Error(path+' run '+run.id+' concluded '+run.conclusion);
    if(!workflowSource(await loadFile(run.node_id),path,event,run.head_sha))
      throw Error(path+' run '+run.id+' workflow source does not match the declared commit');
    const jobs=await readAttemptJobs(run,loadJobs,options);
    const current=options.readRun&&await options.readRun(run.id);
    if(options.readRun&&(current?.id!==run.id||current.node_id!==run.node_id||current.workflow_id!==run.workflow_id
      ||current.check_suite_id!==run.check_suite_id||current.run_started_at!==run.run_started_at
      ||current.run_attempt!==run.run_attempt||current.status!=='completed'
      ||current.conclusion!=='success'||!(matchesRun(current,path,event,type)||boundForkRun(current,path,event,type,boundNames))))
      throw Error(path+' run '+run.id+' attempt '+run.run_attempt+' changed while reading job evidence');
    receipts.push({workflow:path,id:run.id,attempt:run.run_attempt,jobs:jobs.map(job=>({id:job.id,name:job.name,conclusion:job.conclusion}))});
  }
  return receipts;
}

// Retry only idempotent evidence reads. Callers retain validation and terminal-error handling.
export async function readEvidenceResponse(read,deadline,wait=delay) {
  for(let attempt=0;;attempt++) {
    let response,networkError;
    try {response=await read();}
    catch(error) {
      if(attempt>=2||!['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT'].includes(error?.cause?.code))throw error;
      networkError=error;
    }
    const header=response?.headers.get('retry-after')??null;
    if(response) {
      const transient=[429,500,502,503,504].includes(response.status)||response.status===403&&header!==null;
      if(!transient||attempt>=2)return response;
    }
    const now=Date.now(),minimum=header===null?0:/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-now;
    const pause=Math.max(1000*2**attempt,Number.isNaN(minimum)?0:minimum);
    if(now+pause>=deadline) {
      if(networkError)throw networkError;
      return response;
    }
    await response?.body?.cancel();
    await wait(pause);
    if(Date.now()>=deadline)throw Error('Product CI evidence read deadline reached');
  }
}

async function main(){
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const type=process.env.GITHUB_EVENT_NAME,paths=JSON.parse(process.env.PRODUCT_WORKFLOWS);
  const head=event.pull_request?.head.sha??event.after;
  const root=process.env.GITHUB_API_URL+'/repos/'+event.repository.full_name+'/';
  async function read(url){
    const response=await readEvidenceResponse(()=>fetch(url,{redirect:'error',headers:{Authorization:'Bearer '+process.env.GH_TOKEN,
      Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}),deadline);
    if(!response.ok)throw Error('Product CI evidence HTTP '+response.status);
    return response.json();
  }
  async function list(route,key){
    const rows=[];
    let total;
    const incomplete=()=>key==='workflow_runs'
      ?Error('Product CI incomplete '+key):new IncompleteJobsSnapshot('Product CI incomplete '+key);
    for(let page=1;;page++){
      const url=new URL(root+route);
      url.searchParams.set('page',page);url.searchParams.set('per_page','100');
      const data=await read(url);
      if(!Array.isArray(data[key]))throw Error('Product CI response missing '+key);
      if(!Number.isSafeInteger(data.total_count)||data.total_count<0)throw Error('Product CI invalid count '+key);
      if(total!==undefined&&total!==data.total_count)throw incomplete();
      total=data.total_count;
      rows.push(...data[key]);
      if(rows.length===total)return rows;
      if(data[key].length<100||rows.length>total)throw incomplete();
    }
  }
  const boundNames=JSON.parse(process.env.BOUND_NAMES);
  const fileCache=new Map();
  async function loadFile(id){
    if(!fileCache.has(id)){
      const response=await readEvidenceResponse(()=>fetch(process.env.GITHUB_GRAPHQL_URL,{method:'POST',redirect:'error',
        headers:{Authorization:'Bearer '+process.env.GH_TOKEN,'Content-Type':'application/json'},
        body:JSON.stringify({query:'query($id:ID!){node(id:$id){... on WorkflowRun{file{path repositoryFileUrl}}}}',variables:{id}})}),deadline);
      if(!response.ok)throw Error('Workflow file provenance HTTP '+response.status);
      const data=await response.json();
      if(data.errors)throw Error('Workflow file provenance unavailable');
      fileCache.set(id,data.data?.node?.file);
    }
    return fileCache.get(id);
  }
  const start=Date.now(),deadline=start+60*60*1000;
  for(;;){
    const runs=await list('actions/runs?event='+type+'&head_sha='+head,'workflow_runs');
    const pending=new Set();
    const results=await evidence(paths,runs,event,type,run=>list('actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs','jobs'),
      boundNames,loadFile,pending,{deadline,readRun:id=>read(root+'actions/runs/'+id),
        loadChecks:run=>list('check-suites/'+run.check_suite_id+'/check-runs?filter=all','check_runs'),
        loadAttemptHistory:run=>list('actions/runs/'+run.id+'/jobs?filter=all','jobs')});
    if(results.length===paths.length){
      const report=JSON.stringify(results,null,2);
      console.log(report);await appendFile(process.env.GITHUB_STEP_SUMMARY,'```json\n'+report+'\n```\n');return;
    }
    const missing=paths.filter(path=>!results.some(item=>item.workflow===path));
    if(Date.now()-start>=3*60*1000&&missing.some(path=>!pending.has(path)))throw Error('No matching Actions run: '+missing.filter(path=>!pending.has(path)).join(', '));
    if(Date.now()>=deadline)throw Error('Missing completed product CI for '+missing.join(', '));
    console.log('Awaiting '+missing.join(', '));await delay(30000);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
