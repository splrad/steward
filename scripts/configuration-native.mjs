import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Octokit} from '@octokit/rest';
import {downloadArtifactArchive} from '../packages/runner/dist/index.js';
import {matchesMatrixName,observedArchiveTemplate,runArchiveName,staticMatrixRows} from './configuration-build.mjs';
import {channelUploadSteps} from './configuration-selection.mjs';

export const must=(value,message)=>{if(!value) throw Error(message);};
export const positive=value=>{must(/^[1-9][0-9]*$/.test(String(value))&&Number.isSafeInteger(Number(value)),'Invalid numeric identity');return Number(value);};
const branchPrefix='steward/repository-configuration-';
export const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const exec=promisify(execFile);

export function client(token,repository) {
  const api=new Octokit({auth:token});
  api.target={owner:repository.owner.login,repo:repository.name};
  return api;
}

export async function readArchive(api,token,repo,run,name,stage) {
  const all=await api.paginate(api.rest.actions.listWorkflowRunArtifacts,{...api.target,run_id:run.id,per_page:100});
  const matches=all.filter(a=>a.name===name);
  must(matches.length===1,'Missing or ambiguous artifact '+name);
  const asset=matches[0];
  must(!asset.expired && Date.parse(asset.expires_at)>Date.now(),'Expired artifact '+name);
  must(asset.workflow_run?.id===run.id && asset.workflow_run.repository_id===repo.id
    && asset.workflow_run.head_repository_id===repo.id
    && asset.workflow_run.head_sha===run.head_sha,'Unknown archive source');
  const directory=await mkdtemp(join(tmpdir(),'configuration-archive-'));
  try {
    const path=join(directory,'native.zip');
    await downloadArtifactArchive(fetch,token,repo.full_name,asset.id,asset.size_in_bytes,asset.digest,path,async()=>{
      const current=(await api.rest.actions.getWorkflowRun({...api.target,run_id:run.id})).data;
      must(current.run_attempt===run.run_attempt && current.conclusion==='success','A newer attempt superseded this result');
    });
    const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP};
    const result=await exec('python',['tools/template/configuration_archive.py',path,...(stage?['--stage',stage.directory,'--files',JSON.stringify(stage.paths)]:[])],{env,maxBuffer:8*1024*1024});
    return {data:JSON.parse(result.stdout),asset};
  } finally {await rm(directory,{recursive:true,force:true});}
}

async function getRun(api,repo,id,attempt) {
  const run=(await api.rest.actions.getWorkflowRun({...api.target,run_id:positive(id)})).data;
  must(run.repository.id===repo.id && run.head_repository?.id===repo.id
    && run.run_attempt===positive(attempt) && run.status==='completed' && run.conclusion==='success',
    'Stale, foreign, or unsuccessful workflow run');
  return run;
}

async function archiveOwner(api,jobs,job,step,asset) {
  const created=Date.parse(asset.created_at),start=Date.parse(step.started_at),end=Date.parse(step.completed_at);
  if(!(start-1000<=created && end+1000>=created))return false;
  const overlaps=jobs.some(j=>j.id!==job.id && !(Date.parse(j.completed_at)+1000<created || Date.parse(j.started_at)-1000>created));
  if(!overlaps)return true;
  const response=await api.rest.actions.downloadJobLogsForWorkflowRun({...api.target,job_id:job.id}).catch(error=>{
    if(error.status===404 || error.status===410)return null;
    throw error;
  });
  if(!response)return false;
  const logs=typeof response.data==='string'?response.data:Buffer.from(response.data).toString('utf8');
  const line='Artifact '+asset.name+' has been successfully uploaded! Final size is '+asset.size_in_bytes+' bytes. Artifact ID is '+asset.id;
  return logs.split(/\r?\n/).some(raw=>{
    const i=raw.indexOf(' '),time=Date.parse(raw.slice(0,i));
    return time>=start && time<end+1000 && raw.slice(i+1)===line && !job.steps.some(other=>other!==step
      && Date.parse(other.started_at)<=time && Date.parse(other.completed_at)+1000>time);
  });
}

export async function trialInventory(api,token,repo,base,head,target,archive=readArchive) {
  const run=await getRun(api,repo,target.run,target.attempt);
  must(run.path===target.workflow && run.head_sha===(target.sourceSha??head),'Existing build does not match the selected workflow and source');
  const name=runArchiveName(target.archive,run);
  must(name && (!target.evidenceArchive || target.evidenceArchive===name),'Selected archive changed; refresh product evidence');
  if(run.head_sha!==head) {
    const [a,b]=await Promise.all([head,run.head_sha].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
    must(a.data.commit.tree.sha===b.data.commit.tree.sha,'Existing build inputs have changed');
  }
  const result=await archive(api,token,repo,run,name);
  const jobs=await api.paginate(api.rest.actions.listJobsForWorkflowRunAttempt,{...api.target,run_id:run.id,attempt_number:run.run_attempt,per_page:100});
  const producers=jobs.filter(job=>job.conclusion==='success' && job.id===(target.jobId??job.id)
    && job.name===target.nativeJobName
    && job.steps?.some(step=>step.conclusion==='success' && Date.parse(step.started_at)-1000<=Date.parse(result.asset.created_at)
      && Date.parse(step.completed_at)+1000>=Date.parse(result.asset.created_at)
      && step.name===target.uploadStep));
  must(producers.length===1,'Could not bind the archive to one producer job and upload step');
  const owner=producers[0],steps=owner.steps.filter(s=>s.name===target.uploadStep && s.conclusion==='success');
  must(steps.length===1 && await archiveOwner(api,jobs,owner,steps[0],result.asset),'Could not bind the archive to the product upload step');
  return result.data;
}

function matchingJob(workflow,id,name) {
  const jobs=Object.entries(workflow.document.jobs).filter(([key,job])=>job.name?matchesMatrixName(job.name,name):
    key===name || job.strategy?.matrix && name.startsWith(key+' (') && name.endsWith(')'));
  return jobs.length===1 && jobs[0][0]===id;
}

export async function dynamicBuildInputs(api,repo,head,base,model) {
  const variants=new Map();
  for(const workflow of model.workflows) {
    if(/\/steward-release-|\/pages\.ya?ml$/.test(workflow.path))continue;
    const dynamic=Object.entries(workflow.document?.jobs??{}).filter(([,job])=>staticMatrixRows(job.strategy?.matrix)===null
      && job.steps?.some(s=>/^actions\/upload-artifact@[a-f0-9]{40}$/.test(s.uses??'')));
    if(!dynamic.length)continue;
    const revisions=[head];
    if(head!==base) {
      const [a,b]=await Promise.all([head,base].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
      if(a.data.commit.tree.sha===b.data.commit.tree.sha) revisions.push(base);
    }
    for(const revision of revisions) {
      const runs=await api.paginate(api.rest.actions.listWorkflowRuns,{...api.target,workflow_id:workflow.path.split('/').at(-1),
        head_sha:revision,status:'success',per_page:100}).catch(error=>{if(error.status===404)return [];throw error;});
      for(const run of runs) {
        if(run.repository?.id!==repo.id || run.head_repository?.id!==repo.id || run.head_sha!==revision
          || run.path!==workflow.path || run.conclusion!=='success')continue;
        const params={...api.target,run_id:run.id,per_page:100};
        const [jobs,artifacts]=await Promise.all([api.paginate(api.rest.actions.listJobsForWorkflowRunAttempt,{...params,attempt_number:run.run_attempt}),
          api.paginate(api.rest.actions.listWorkflowRunArtifacts,params)]);
        for(const [id,spec] of dynamic) for(const job of jobs) {
          if(job.conclusion!=='success' || !matchingJob(workflow,id,job.name))continue;
          for(const s of spec.steps.filter(s=>/^actions\/upload-artifact@[a-f0-9]{40}$/.test(s.uses??''))) {
            const uploadStep=s.name??'Run '+s.uses;
            const steps=job.steps.filter(step=>step.name===uploadStep && step.conclusion==='success');
            if(steps.length!==1)continue;
            for(const a of artifacts) {
              const archive=observedArchiveTemplate(s.with?.name??'artifact',a.name,run);
              if(a.expired || archive===undefined || a.workflow_run?.head_sha!==revision
                || a.workflow_run.id!==run.id || a.workflow_run.repository_id!==repo.id || a.workflow_run.head_repository_id!==repo.id)continue;
              if(!await archiveOwner(api,jobs,job,steps[0],a))continue;
              const variant={workflow:workflow.path,job:id,nativeJobName:job.name,uploadStep,archive};
              const key=JSON.stringify(variant);
              if(!variants.has(key))variants.set(key,variant.archive===a.name?variant:{...variant,observedArchive:a.name});
            }
          }
        }
      }
    }
  }
  return [...variants.keys()].sort().map(k=>variants.get(k));
}

export async function findEvidence(api,token,repo,base,head,target,model,callback,inspect=trialInventory) {
  const sourceWorkflow=target.workflow && model.workflows.find(w=>w.path===target.workflow);
  const original=sourceWorkflow?.document.jobs?.[target.job];
  const substitute=value=>String(value).replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g,(_,k)=>String(target.matrix?.[k]??''));
  const sources=[head];
  if(sourceWorkflow && base!==head) {
    const [candidate,adopted]=await Promise.all([head,base].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
    if(candidate.data.commit.tree.sha===adopted.data.commit.tree.sha) sources.push(base);
  }
  if(!original)return;
  const list=callback?[await getRun(api,repo,callback.id,callback.attempt)]:[];
  if(!callback) {
    const options={...api.target,workflow_id:sourceWorkflow.path.split('/').at(-1),status:'success',per_page:100};
    try {
      for(const source of sources)list.push(...await api.paginate(api.rest.actions.listWorkflowRuns,{...options,head_sha:source}));
    } catch(error){if(error.status!==404)throw error;}
  }
  for(const run of list) {
    if(run.path!==sourceWorkflow.path || run.head_repository?.id!==repo.id || !sources.includes(run.head_sha))continue;
    if(!['push','workflow_dispatch','schedule'].includes(run.event) || target.nativeEvent && target.nativeEvent!==run.event)continue;
    if(run.event==='workflow_dispatch' && Object.keys(sourceWorkflow.document.on?.workflow_dispatch?.inputs??{}).length)continue;
    if(!run.head_branch || target.nativeRef && run.head_branch!==target.nativeRef)continue;
    if(!target.nativeOnly && !target.nativeRef) {
      const refs=new Set(list.filter(r=>r.path===run.path && r.event===run.event && r.head_sha===run.head_sha
        && r.head_repository?.id===repo.id).map(r=>r.head_branch));
      if(refs.size!==1)throw Error('多个分支或标签在同一提交运行了 '+run.path+'，请明确原生运行的分支或标签。');
    }
    if(target.nativeJobName && !matchingJob(sourceWorkflow,target.job,target.nativeJobName))continue;
    const archive=runArchiveName(target.archive,run);
    if(!archive)continue;
    const upload=(original.steps??[]).filter(s=>/^actions\/upload-artifact@[a-f0-9]{40}$/.test(s.uses??'') &&
      (target.nativeJobName && target.uploadStep ? (s.name??'Run '+s.uses)===target.uploadStep && observedArchiveTemplate(s.with?.name??'artifact',archive,run)===target.archive : runArchiveName(substitute(s.with?.name??'artifact'),run)===archive));
    if(upload.length!==1)continue;
    const binding={run:run.id,attempt:run.run_attempt,nativeEvent:run.event,observedRef:run.head_branch,
      nativeRef:run.head_branch.startsWith(branchPrefix)?repo.default_branch:run.head_branch,sourceSha:run.head_sha,evidenceArchive:archive,
      nativeJobName:target.nativeJobName??(original.name?substitute(original.name):target.job+(Object.keys(target.matrix??{}).length?' ('+Object.values(target.matrix).join(', ')+')':'')),
      uploadStep:upload[0].name??'Run '+upload[0].uses};
    try {
      const files=await inspect(api,token,repo,base,head,{...target,...binding});
      return {head,binding,files,url:run.html_url};
    } catch(error) {
      if(!/^(Expired artifact|Missing or ambiguous artifact|Could not bind the archive|Concurrent jobs prevent|Stale, foreign, or unsuccessful workflow run)/.test(error.message)) throw error;
    }
  }
}

// Job names and immutable artifact metadata are supplied by Actions, not the editable configuration PR.
export async function nativeChannelJobs(api,repo,head,base,source,targets,token,archive=readArchive) {
  const found=new Set(),revisions=new Set([head]);
  if(base!==head) {
    const [a,b]=await Promise.all([head,base].map(ref=>api.rest.repos.getCommit({...api.target,ref})));
    if(a.data.commit.tree.sha===b.data.commit.tree.sha) revisions.add(base);
  }
  for(const revision of revisions) {
    const runs=await api.paginate(api.rest.actions.listWorkflowRuns,{...api.target,workflow_id:source.path.split('/').at(-1),
      head_sha:revision,event:'workflow_dispatch',status:'success',per_page:100}).catch(error=>{if(error.status===404)return [];throw error;});
    for(const run of runs) {
      const title=/^Channels (submit|verify) ([a-f0-9]{64})$/.exec(run.display_title??'');
      if(!title || run.repository?.id!==repo.id || run.head_repository?.id!==repo.id || run.head_sha!==revision
        || run.event!=='workflow_dispatch' || run.path!==source.path || run.conclusion!=='success') continue;
      const args={...api.target,run_id:run.id,per_page:100};
      const [jobs,artifacts]=await Promise.all([api.paginate(api.rest.actions.listJobsForWorkflowRunAttempt,{...args,attempt_number:run.run_attempt}),
        api.paginate(api.rest.actions.listWorkflowRunArtifacts,args)]);
      for(const {unitId,channelId} of targets) {
        const name=title[1]+'/'+channelId+'/'+unitId,receipt='channel-'+title[2]+'-'+unitId+'-'+channelId+'-'+run.id+'-'+run.run_attempt;
        const producers=jobs.filter(j=>j.name===name && j.head_sha===revision && j.run_id===run.id && j.run_attempt===run.run_attempt && j.conclusion==='success');
        const matches=artifacts.filter(a=>a.name===receipt && a.workflow_run?.id===run.id && a.workflow_run?.head_sha===revision
          && a.workflow_run?.repository_id===repo.id && a.workflow_run?.head_repository_id===repo.id && /^sha256:[a-f0-9]{64}$/.test(a.digest??''));
        if(producers.length!==1 || matches.length!==1 || matches[0].expired)continue;
        const declarations=Object.entries(source.document.jobs).flatMap(([id,job])=>channelUploadSteps(job,id,title[1],unitId,channelId,{unitId,channelId}));
        if(declarations.length!==1)continue;
        const step=declarations[0],steps=(producers[0].steps??[]).filter(s=>s.name===(step.name??'Run '+step.uses) && s.conclusion==='success');
        if(steps.length!==1 || !await archiveOwner(api,jobs,producers[0],steps[0],matches[0]))continue;
        const report=await archive(api,token,repo,run,receipt);
        if(report.asset.id===matches[0].id && report.data.length===1 && report.data[0].path==='report.json')found.add(name);
      }
    }
  }
  return found;
}

export async function commitFiles(api,repo,branch,head,changes,message,headline='chore: 配置 '+repo.name+' 仓库功能') {
  const input={branch:{repositoryNameWithOwner:repo.full_name,branchName:branch},expectedHeadOid:head,
    message:{headline,body:message+'\n\nSigned-off-by: splrad-steward[bot] <301115370+splrad-steward[bot]@users.noreply.github.com>'},
    fileChanges:{additions:[...changes].map(([path,bytes])=>({path,contents:Buffer.from(bytes).toString('base64')}))}};
  const response=await api.graphql('mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',{input});
  return response.createCommitOnBranch.commit.oid;
}
