import {readFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

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

export async function evidence(paths,runs,event,type,loadJobs) {
  if(!Array.isArray(paths)||!paths.length)throw Error('VALIDATION_PRODUCT_CI_NOT_CONFIGURED: .github/product-ci.json');
  const receipts=[];
  for(const path of paths){
    const run=runs.filter(item=>matchesRun(item,path,event,type)).sort((a,b)=>b.id-a.id)[0];
    if(!run||run.status!=='completed')continue;
    if(run.conclusion!=='success')throw Error(path+' run '+run.id+' concluded '+run.conclusion);
    const jobs=await loadJobs(run);
    if(!jobs.length||jobs.some(job=>job.run_id!==run.id||job.head_sha!==run.head_sha||job.run_attempt!==run.run_attempt
      ||job.status!=='completed'||job.conclusion!=='success'
      ||!job.steps?.some(step=>step.status==='completed'&&step.conclusion==='success')))
      throw Error(path+' run '+run.id+' attempt '+run.run_attempt+' has incomplete job evidence');
    receipts.push({workflow:path,id:run.id,attempt:run.run_attempt,jobs:jobs.map(job=>({id:job.id,name:job.name}))});
  }
  return receipts;
}

async function main(){
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const type=process.env.GITHUB_EVENT_NAME,paths=JSON.parse(process.env.PRODUCT_WORKFLOWS);
  const head=event.pull_request?.head.sha??event.after;
  const root=process.env.GITHUB_API_URL+'/repos/'+event.repository.full_name+'/actions/';
  async function list(route,key){
    const rows=[];
    for(let page=1;;page++){
      const url=new URL(root+route);
      url.searchParams.set('page',page);url.searchParams.set('per_page','100');
      const response=await fetch(url,{redirect:'error',headers:{Authorization:'Bearer '+process.env.GH_TOKEN,
        Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
      if(!response.ok)throw Error('Product CI evidence HTTP '+response.status);
      const data=await response.json();
      if(!Array.isArray(data[key]))throw Error('Product CI response missing '+key);
      rows.push(...data[key]);
      if(rows.length===data.total_count)return rows;
      if(data[key].length<100||rows.length>data.total_count)throw Error('Product CI incomplete '+key);
    }
  }
  const deadline=Date.now()+60*60*1000;
  for(;;){
    const runs=await list('runs?event='+type+'&head_sha='+head,'workflow_runs');
    const results=await evidence(paths,runs,event,type,run=>list('runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs','jobs'));
    if(results.length===paths.length){
      const report=JSON.stringify(results,null,2);
      console.log(report);await appendFile(process.env.GITHUB_STEP_SUMMARY,'```json\n'+report+'\n```\n');return;
    }
    const missing=paths.filter(path=>!results.some(item=>item.workflow===path));
    if(Date.now()>=deadline)throw Error('Missing completed product CI for '+missing.join(', '));
    console.log('Awaiting '+missing.join(', '));await delay(30000);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
