import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Octokit} from '@octokit/rest';
import {downloadArtifactArchive} from '../packages/runner/dist/index.js';
import {authorized,fileText,requestPath} from './configuration-authorization.mjs';
import {prepareTarget,trialKey} from './configuration-selection.mjs';

export const must=(value,message)=>{if(!value) throw Error(message);};
export const positive=value=>{must(/^[1-9][0-9]*$/.test(String(value))&&Number.isSafeInteger(Number(value)),'Invalid numeric identity');return Number(value);};
const branchPrefix='steward/repository-configuration-';
export const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const trialPath='.github/workflows/repository-configuration-trial.yml';
const bot=301115370;
const exec=promisify(execFile);

export function client(token,repository) {
  const api=new Octokit({auth:token});
  api.target={owner:repository.owner.login,repo:repository.name};
  return api;
}

export async function trustedWorkflow(api,path,source,base) {
  const [actual,current,expected]=await Promise.all([fileText(api,path,source),fileText(api,path,base),readFile('templates/repository/'+path,'utf8')]);
  must(actual && actual===current && actual.replaceAll('\r\n','\n')===expected.replaceAll('\r\n','\n'),'Adopt the reviewed configuration workflow first');
}

export async function readArchive(api,token,repo,run,name,request=false) {
  const all=await api.paginate(api.rest.actions.listWorkflowRunArtifacts,{...api.target,run_id:run.id,per_page:100});
  const matches=all.filter(a=>a.name===name);
  must(matches.length===1,'Missing or ambiguous artifact '+name);
  const asset=matches[0];
  must(!asset.expired && Date.parse(asset.expires_at)>Date.now(),'Expired artifact '+name);
  must(asset.workflow_run?.id===run.id && asset.workflow_run.repository_id===repo.id
    && asset.workflow_run.head_repository_id===repo.id && asset.workflow_run.head_sha===run.head_sha,'Unknown archive source');
  const directory=await mkdtemp(join(tmpdir(),'configuration-archive-'));
  try {
    const path=join(directory,'native.zip');
    await downloadArtifactArchive(fetch,token,repo.full_name,asset.id,asset.size_in_bytes,asset.digest,path,async()=>{
      const current=(await api.rest.actions.getWorkflowRun({...api.target,run_id:run.id})).data;
      must(current.run_attempt===run.run_attempt && current.conclusion==='success','A newer attempt superseded this result');
    });
    const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP};
    const result=await exec('python',['tools/template/configuration_archive.py',path,...(request?['--request']:[])],{env,maxBuffer:8*1024*1024});
    return {data:JSON.parse(result.stdout),asset};
  } finally {await rm(directory,{recursive:true,force:true});}
}

export async function getRun(api,repo,id,attempt) {
  const run=(await api.rest.actions.getWorkflowRun({...api.target,run_id:positive(id)})).data;
  must(run.repository.id===repo.id && run.head_repository?.id===repo.id && run.run_attempt===positive(attempt)
    && run.status==='completed' && run.conclusion==='success','Stale, foreign, or unsuccessful workflow run');
  return run;
}

export async function requestFromRun(api,token,repo,id,attempt,base,archive=readArchive) {
  const run=await getRun(api,repo,id,attempt);
  if(run.path===trialPath) {
    must(run.event==='workflow_dispatch' && run.actor.id===bot && run.triggering_actor.id===bot && run.head_branch===repo.default_branch,'Unexpected build trial source');
    await trustedWorkflow(api,trialPath,run.head_sha,base);
    return {run,data:{trial:{id:run.id,attempt:run.run_attempt}}};
  }
  must(run.path===requestPath && ['workflow_dispatch','push','pull_request','pull_request_review'].includes(run.event),'Unknown configuration request source');
  if(['workflow_dispatch','push'].includes(run.event)) must(run.head_branch===repo.default_branch && run.head_sha===base,'Default branch moved; run again');
  await trustedWorkflow(api,requestPath,run.head_sha,base);
  const {data}=await archive(api,token,repo,run,'configuration-request-'+run.id+'-'+run.run_attempt,true);
  must(data.event===run.event && data.repository===repo.id && data.actor===run.actor.id && Number(data.run)===run.id
    && Number(data.attempt)===run.run_attempt,'Configuration request identity mismatch');
  if(data.pull) must(data.pull.head===run.head_sha && positive(data.pull.number),'PR head moved');
  else must(data.source===run.head_sha,'Source moved');
  if(!['push','pull_request_review'].includes(run.event)) {
    for(const actor of [run.actor,run.triggering_actor]) must(await authorized(api,actor,base),'Repository administrator or explicit delegate required');
  } else if(run.run_attempt>1) must(await authorized(api,run.triggering_actor,base),'Unauthorized rerun');
  return {run,data};
}

export async function trialInventory(api,token,repo,base,head,target,recipe,archive=readArchive) {
  const run=await getRun(api,repo,target.run,target.attempt);
  let name;
  if(run.path===trialPath) {
    const key=trialKey(head,target.unit,target.target,recipe);
    await trustedWorkflow(api,trialPath,run.head_sha,base);
    must(run.event==='workflow_dispatch' && run.actor.id===bot && run.triggering_actor.id===bot
      && run.head_branch===repo.default_branch && run.display_title==='Configuration trial '+head+' '+target.unit+'/'+target.target+' '+key,
      'Trial is not bound to the reviewed head and target');
    name='trial-'+key+'-'+run.id+'-'+run.run_attempt;
  } else {
    must(run.path===target.workflow && run.head_sha===(target.sourceSha??head),'Existing build does not match the selected workflow and source');
    name=target.archive;
  }
  if(run.path!==trialPath && run.head_sha!==head) {
    const [a,b]=await Promise.all([head,run.head_sha].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
    must(a.data.commit.tree.sha===b.data.commit.tree.sha,'Existing build inputs have changed');
  }
  const result=await archive(api,token,repo,run,name);
  const jobs=await api.paginate(api.rest.actions.listJobsForWorkflowRunAttempt,{...api.target,run_id:run.id,attempt_number:run.run_attempt,per_page:100});
  const producers=jobs.filter(job=>job.conclusion==='success' && job.id===(target.jobId??job.id)
    && (run.path===trialPath?job.name==='build':job.name===target.nativeJobName)
    && job.steps?.some(step=>step.conclusion==='success' && Date.parse(step.started_at)-1000<=Date.parse(result.asset.created_at)
      && Date.parse(step.completed_at)+1000>=Date.parse(result.asset.created_at)
      && (run.path===trialPath?step.name==='Archive build directory':step.name===target.uploadStep)));
  must(producers.length===1,'Could not bind the archive to one producer job and upload step');
  const created=Date.parse(result.asset.created_at);
  if(run.path!==trialPath) for(const job of jobs.filter(job=>job.id!==producers[0].id)) {
    const start=Date.parse(job.started_at),end=Date.parse(job.completed_at);
    must(Number.isFinite(start) && Number.isFinite(end) && (end+1000<created || start-1000>created),
      'Concurrent jobs prevent binding this archive to one producer. Use the isolated product trial.');
  }
  return result.data;
}

export async function findEvidence(api,token,repo,base,head,target,model,callback,inspect=trialInventory) {
  const sourceWorkflow=target.workflow && model.workflows.find(w=>w.path===target.workflow);
  const original=sourceWorkflow?.document.jobs?.[target.job];
  const substitute=value=>String(value).replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g,(_,k)=>String(target.matrix?.[k]??''));
  let recipe;
  try {recipe=prepareTarget(model,target).recipe;} catch { /* Native evidence can predate or exceed the fixed trial adapter. */ }
  const sources=[head];
  if(sourceWorkflow && base!==head) {
    const [candidate,adopted]=await Promise.all([head,base].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
    if(candidate.data.commit.tree.sha===adopted.data.commit.tree.sha) sources.push(base);
  }
  const names=new Set([trialPath,...(sourceWorkflow?[sourceWorkflow.path]:[])]);
  const list=callback?[await getRun(api,repo,callback.id,callback.attempt)]:[];
  if(!callback) for(const path of names) {
    const options={...api.target,workflow_id:path.split('/').at(-1),status:'success',per_page:100};
    if(path===trialPath) options.branch=repo.default_branch;
    try {
      for(const source of path===trialPath?[null]:sources) list.push(...await api.paginate(api.rest.actions.listWorkflowRuns,{...options,...(source?{head_sha:source}:{})}));
    }
    catch(error){if(error.status!==404)throw error;}
  }
  for(const run of list) {
    if(!names.has(run.path) || run.head_repository?.id!==repo.id)continue;
    const binding={run:run.id,attempt:run.run_attempt};
    if(run.path===trialPath) {
      if(!recipe)continue;
      const key=trialKey(head,target.unit,target.target,recipe);
      if(run.display_title!=='Configuration trial '+head+' '+target.unit+'/'+target.target+' '+key)continue;
    } else {
      if(!sources.includes(run.head_sha) || !original)continue;
      binding.sourceSha=run.head_sha;
      const upload=(original.steps??[]).filter(s=>s.uses?.startsWith('actions/upload-artifact@') && substitute(s.with?.name??'artifact')===target.archive);
      const jobName=original.name?substitute(original.name):target.job+(Object.keys(target.matrix??{}).length?' ('+Object.values(target.matrix).join(', ')+')':'');
      if(upload.length!==1)continue;
      binding.nativeJobName=jobName;
      binding.uploadStep=upload[0].name??'Run '+upload[0].uses;
    }
    const files=await inspect(api,token,repo,base,head,{...target,...binding},recipe);
    return {head,binding,files,url:run.html_url};
  }
}

export async function dispatchTrial(api,actions,repo,base,head,target,recipe) {
  await trustedWorkflow(api,trialPath,base,base);
  const key=trialKey(head,target.unit,target.target,recipe);
  const title='Configuration trial '+head+' '+target.unit+'/'+target.target+' '+key;
  const runs=await api.paginate(api.rest.actions.listWorkflowRuns,{...api.target,workflow_id:trialPath.split('/').at(-1),branch:repo.default_branch,event:'workflow_dispatch',per_page:100});
  const prior=runs.filter(r=>r.display_title===title && r.actor.id===bot);
  if(prior.some(r=>r.status!=='completed' || r.conclusion==='success')) return;
  await actions.rest.actions.createWorkflowDispatch({...api.target,workflow_id:trialPath.split('/').at(-1),ref:repo.default_branch,
    inputs:{head,unit:target.unit,target:target.target,key,runner:recipe.runner,output:recipe.output,tools:JSON.stringify(recipe.tools)}});
}
export async function rerunValidation(api,actions,pr) {
  const runs=await api.paginate(api.rest.actions.listWorkflowRunsForRepo,{...api.target,head_sha:pr.head.sha,event:'pull_request',per_page:100});
  for(const run of runs.filter(r=>r.path.endsWith('/pr-validation-native.yml') && r.status==='completed' && r.conclusion==='failure')) {
    const jobs=await api.paginate(api.rest.actions.listJobsForWorkflowRunAttempt,{...api.target,run_id:run.id,attempt_number:run.run_attempt,per_page:100});
    const failed=jobs.filter(job=>job.name==='Validation scope' && job.conclusion==='failure'
      && job.steps?.some(step=>step.name==='Authorize repository configuration' && step.conclusion==='failure'));
    for(const job of failed) await actions.rest.actions.reRunJobForWorkflowRun({...api.target,job_id:job.id});
  }
}

export async function openPull(api,repo) {
  const all=await api.paginate(api.rest.pulls.list,{...api.target,base:repo.default_branch,state:'open',per_page:100});
  const list=all.filter(p=>p.head.repo?.id===repo.id && p.head.ref.startsWith(branchPrefix));
  must(list.length<=1,'Ambiguous open configuration PR');
  const pr=list[0];
  if(pr) must(pr.user.id===bot && pr.head.repo.id===repo.id,'Configuration branch belongs to another author');
  return pr;
}

export async function commitFiles(api,repo,branch,head,changes,message) {
  const input={branch:{repositoryNameWithOwner:repo.full_name,refName:branch},expectedHeadOid:head,
    message:{headline:'chore: 配置 '+repo.name+' 仓库功能',body:message+'\n\nSigned-off-by: splrad-steward[bot] <301115370+splrad-steward[bot]@users.noreply.github.com>'},
    fileChanges:{additions:[...changes].map(([path,bytes])=>({path,contents:Buffer.from(bytes).toString('base64')}))}};
  const response=await api.graphql('mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',{input});
  return response.createCommitOnBranch.commit.oid;
}
