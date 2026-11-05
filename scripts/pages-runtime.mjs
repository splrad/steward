import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {NativeEvidenceReader,nativeEvidenceTransport,validatePagesSource,jobFact,nativeJobOrigins} from '../packages/runner/dist/index.js';
import {desiredPagesSource,pagesContent,pagesInputDigest,pagesWorkflow} from './select-pages-source.mjs';

const check=(v,code)=>{if(!v)throw Error('PAGES_'+code);};
const positive=v=>Number.isSafeInteger(v)&&v>0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const pagesArtifactName=(source,runId,attempt)=>`github-pages-${runId}-${attempt}-${source.inputDigest}`;

/** Read the immutable product workflow's controller pin; never select arbitrary executable inputs. */
export function pagesDefinition(bytes) {
  const parsed=YAML.parseDocument(bytes.toString());check(!parsed.errors.length,'YAML');
  const d=parsed.toJS({maxAliasCount:100}),pin=d.env?.STEWARD_CONTROLLER_SHA;
  check(/^[a-f0-9]{40}$/.test(pin??'')&&same(Object.keys(d.jobs??{}).sort(),['build','deploy','select']),'DEFINITION');
  check(d.concurrency?.group==='steward-pages-${{ github.repository_id }}'&&d.concurrency?.['cancel-in-progress']===false,'SERIALIZATION');
  for(const key of ['select','deploy']) {
    const steps=d.jobs[key].steps??[];
    const controllers=steps.filter(s=>s.with?.repository==='splrad/steward');
    check(controllers.length===1&&controllers[0].with.ref===pin&&controllers[0].with.path==='controller'
      &&controllers[0].with['persist-credentials']===false,'CONTROLLER_PIN');
  }
  check(d.jobs.deploy.environment?.name==='github-pages'&&d.jobs.deploy.needs?.includes('build')&&d.jobs.deploy.needs?.includes('select'),'DEPLOY_NEEDS');
  check(same(Object.keys(d.on??{}).sort(),['push','release','workflow_dispatch'])&&same(d.on.release.types,['published']),'EVENTS');
  check(same(Object.keys(d.on.workflow_dispatch.inputs??{}).sort(),['input_digest','release_id','source_mode','source_sha']),'INPUTS');
  return {controllerSha:pin};
}

/** A pin belongs to source S, not to the coordinator's newer main. */
export async function currentPagesSource(options,ports={}) {
  if(options.mode==='')return {status:'DISABLED'};
  const read=ports.readContent??pagesContent;
  const desired=await desiredPagesSource(options,ports);
  if(desired.status!=='READY')return desired;
  const definition=pagesDefinition(await read(options.reader,pagesWorkflow,desired.source.sourceSha));
  const source={...desired.source,controllerSha:definition.controllerSha};source.inputDigest=pagesInputDigest(source);
  validatePagesSource(source);return {status:'READY',source};
}

export function assertPagesRun(run,source,workflowId) {
  check(positive(run.id)&&positive(run.run_attempt)&&run.repository?.id===source.repositoryId&&run.head_repository?.id===source.repositoryId
    &&run.workflow_id===workflowId&&run.path===pagesWorkflow&&run.head_sha===source.sourceSha
    &&run.head_branch===source.ref.replace(/^refs\/(heads|tags)\//,'')
    &&(source.mode==='default-branch'?['push','workflow_dispatch']:['release','workflow_dispatch']).includes(run.event),'RUN_SOURCE');
}
async function deploymentJob(reader,source,deployment,status,{runId,attempt,completed}={}) {
  const prefix=`https://github.com/${reader.repository}/actions/runs/`;
  if(typeof status.log_url!=='string'||!status.log_url.startsWith(prefix))return null;
  const match=/^([1-9][0-9]*)(?:\/job\/([1-9][0-9]*))?$/.exec(status.log_url.slice(prefix.length));
  if(!match||runId!==undefined&&Number(match[1])!==runId)return null;
  const run=await reader.json(`actions/runs/${match[1]}`),workflow=await reader.json('actions/workflows/pages.yml');
  check(run.repository?.id===source.repositoryId&&run.head_repository?.id===source.repositoryId&&run.workflow_id===workflow.id
    &&run.path===pagesWorkflow&&run.head_sha===deployment.sha,'DEPLOYMENT_SOURCE');
  const jobs=await reader.pages(`actions/runs/${run.id}/jobs?filter=all`,'jobs');
  check(jobs.every(j=>j.run_id===run.id&&j.head_sha===deployment.sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt),'DEPLOYMENT_JOB_SOURCE');
  const origins=nativeJobOrigins(Array.from({length:run.run_attempt},(_,i)=>({attempt:i+1,jobs:jobs.filter(j=>j.run_attempt===i+1).map(jobFact)})));
  const candidates=origins.filter(({job,origin})=>/^deploy\/[a-f0-9]{64}$/.test(origin.name)
    &&(attempt===undefined||origin.runAttempt===attempt)&&(!match[2]||job.id===Number(match[2])));
  const matching=[...new Set(candidates.map(({origin})=>origin.id))].map(id=>jobs.find(j=>j.id===id));
  if(matching.length!==1)return null;
  const job=matching[0];
  const step=job.steps?.find(s=>s.name==='Deploy Pages'&&s.conclusion==='success');
  if(completed&&!step)return {skipped:true};
  if(completed)check(Number.isFinite(Date.parse(step.completed_at)),'DEPLOYMENT_TIME');
  check(job.run_attempt<=run.run_attempt&&positive(deployment.id),'DEPLOYMENT_JOB');
  return {deploymentId:deployment.id,runId:run.id,runAttempt:job.run_attempt,jobId:job.id,sourceSha:run.head_sha,inputDigest:job.name.slice(7),
    deployedAt:step?.completed_at??null,environment:'github-pages',state:status.state,environmentUrl:status.environment_url??null};
}

/** Native Environment deployment IDs and exact job URLs provide durable correlation after log/artifact expiry. */
export async function pagesDeployment(reader,source,filter={}) {
  validatePagesSource(source);
  const deployments=await reader.pages('deployments?environment=github-pages','');
  const candidates=[];
  for(const d of deployments) {
    check(d.environment==='github-pages'&&positive(d.id)&&typeof d.created_at==='string','DEPLOYMENT');
    const statuses=await reader.pages(`deployments/${d.id}/statuses`,'');
    const latest=statuses.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id)[0];
    if(!latest)continue;
    if(filter.runId!==undefined) {
      if(d.sha===source.sourceSha)candidates.push({d,status:latest});
    }else candidates.push({d,status:latest});
  }
  candidates.sort((a,b)=>Date.parse(b.status.created_at)-Date.parse(a.status.created_at)||b.status.id-a.status.id);
  const actual=[];
  // A duplicate/stale job can create an Environment deployment while skipping the deploy Action.
  // Its success/inactive status does not replace the site. Order real successful deploy steps instead.
  for(const {d,status} of candidates) {
    const proof=await deploymentJob(reader,source,d,status,{...filter,completed:filter.runId===undefined||filter.completed===true});
    if(!proof&&status.state==='success'&&filter.runId===undefined)throw Error('PAGES_DEPLOYMENT_UNCONFIRMED');
    if(proof&&!proof.skipped)actual.push(proof);
  }
  actual.sort((a,b)=>Date.parse(b.deployedAt)-Date.parse(a.deployedAt)||b.deploymentId-a.deploymentId);
  const latest=actual[0];return latest&&(filter.anySource||latest.sourceSha===source.sourceSha&&latest.inputDigest===source.inputDigest)?latest:null;
}

export async function checkPagesArtifact(reader,source,{runId,attempt,artifactId},now=Date.now()) {
  check([runId,attempt,artifactId].every(positive),'ARTIFACT_ID');
  const workflow=await reader.json('actions/workflows/pages.yml');check(workflow.path===pagesWorkflow&&workflow.state==='active','WORKFLOW');
  const run=await reader.json(`actions/runs/${runId}`);assertPagesRun(run,source,workflow.id);check(run.run_attempt===attempt,'ATTEMPT');
  const origins=nativeJobOrigins(await reader.jobAttempts(runId,attempt));
  const build=origins.filter(({job})=>job.runAttempt===attempt&&job.name===`build/${source.inputDigest}`).map(({origin})=>origin);
  check(build.length===1&&build[0].runId===runId&&build[0].headSha===source.sourceSha
    &&build[0].status==='completed'&&build[0].conclusion==='success'
    &&build[0].steps.some(s=>s.name==='Upload Pages artifact'&&s.conclusion==='success'),'BUILD_PROOF');
  const producerAttempt=build[0].runAttempt;
  const artifacts=await reader.pages(`actions/runs/${runId}/artifacts`,'artifacts');
  const name=pagesArtifactName(source,runId,producerAttempt),found=artifacts.filter(a=>a.name===name);
  check(found.length===1,'ARTIFACT_SET');const a=found[0];
  check(a.id===artifactId&&a.expired===false&&Date.parse(a.expires_at)>now&&a.size_in_bytes>0&&/^sha256:[a-f0-9]{64}$/.test(a.digest)
    &&a.workflow_run?.id===runId&&a.workflow_run?.head_sha===source.sourceSha,'ARTIFACT_SOURCE');
  return {artifactId,artifactName:name,artifactDigest:a.digest,buildJobId:build[0].id,runId,runAttempt:producerAttempt};
}

export async function preflightPages({reader,source,options,invocation},ports={}) {
  validatePagesSource(source);
  const current=await (ports.currentSource??currentPagesSource)(options);
  if(current.status!=='READY'||!same(current.source,source))return {status:'STALE'};
  const existing=await (ports.deployment??pagesDeployment)(reader,source);
  if(existing)return {status:'SATISFIED',source,deployment:existing};
  const artifact=await checkPagesArtifact(reader,source,invocation);
  // Last read after native artifact and deployment queries closes the slow-build window.
  const fresh=await (ports.currentSource??currentPagesSource)(options);
  return fresh.status==='READY'&&same(fresh.source,source)?{status:'READY',source,artifact}:{status:'STALE'};
}

async function main() {
  check(process.argv.length===3&&['check','record'].includes(process.argv[2]),'ARGUMENTS');
  const reader=new NativeEvidenceReader(nativeEvidenceTransport(process.env.GH_TOKEN),process.env.GITHUB_REPOSITORY);
  const source=validatePagesSource(JSON.parse(process.env.PAGES_SOURCE));
  check(reader.repository===source.repository&&Number(process.env.GITHUB_REPOSITORY_ID)===source.repositoryId
    &&process.env.STEWARD_CONTROLLER_SHA===source.controllerSha&&process.env.GITHUB_SHA===source.sourceSha&&process.env.GITHUB_REF===source.ref,'INVOCATION');
  const options={reader,repositoryId:source.repositoryId,mode:process.env.STEWARD_DOCS_SOURCE??'',unitId:process.env.STEWARD_DOCS_UNIT??'',controllerSha:source.controllerSha};
  if(options.mode==='release') {
    options.appBotId=301115370;
  }
  const invocation={runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),artifactId:Number(process.env.PAGES_ARTIFACT_ID)};
  let result;
  if(process.argv[2]==='check')result=await preflightPages({reader,source,options,invocation});
  else {
    const prior=JSON.parse(await readFile('pages-evidence.json','utf8'));check(prior.status==='READY'&&same(prior.source,source),'PREFLIGHT_RECORD');
    const deployment=await pagesDeployment(reader,source,{runId:invocation.runId,attempt:invocation.attempt,completed:true});
    check(deployment,'DEPLOYMENT_READBACK');result={...prior,status:'DEPLOYED',deployment};
  }
  await writeFile('pages-evidence.json',JSON.stringify(result,null,2)+'\n');
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`deploy=${result.status==='READY'}\n${result.status==='READY'?`artifact_name=${result.artifact.artifactName}\n`:''}`);
  console.log(JSON.stringify({status:result.status}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error(/^PAGES_[A-Z_]+$/.test(error.message)?error.message:'PAGES_NATIVE_UNAVAILABLE');process.exitCode=1;
});
