import {assertTemplateWake} from './template-entry.mjs';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, open, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isolatedBuildEnvironment, resolvePolicyTool, nativeReleaseApp } from '../packages/runner/dist/index.js';

/** Fixed delivery step. Dependencies must already be installed in a credential-free step. */
export async function deliverRepositoryTemplate(request, { writeToken, readToken, centralReadToken },
  { controllerDirectory = process.cwd(), root = tmpdir(), resolveTool = resolvePolicyTool, spawnChild = spawn } = {}) {
  if (![writeToken,readToken,centralReadToken].every(value=>typeof value==='string'&&value.length>0&&!/[\r\n\0]/.test(value))
    || writeToken===readToken || writeToken===centralReadToken) throw Error('TEMPLATE_CREDENTIAL_BOUNDARY');
  const [uv,gh] = await Promise.all([resolveTool('uv'),resolveTool('gh')]);
  const directory=await mkdtemp(join(root,'steward-template-step-')),profile=join(directory,'profile');
  const input=join(directory,'request.json'),output=join(directory,'result.json');
  await writeFile(input,JSON.stringify({...request,central:resolve(controllerDirectory),temporaryRoot:directory}),{flag:'wx',mode:0o600});
  const log=await open(join(directory,'private.log'),'wx',0o600);
  const env={...isolatedBuildEnvironment(process.env,profile),STEWARD_TEMPLATE_TOKEN:writeToken,
    STEWARD_TEMPLATE_READ_TOKEN:readToken,STEWARD_CENTRAL_READ_TOKEN:centralReadToken};
  let code;
  try {code=await new Promise((done,reject)=>{
    const child=spawnChild(uv,['run','--project','tools/template','--frozen','--no-sync','python','tools/template/delivery.py',
      '--request',input,'--output',output,'--gh',gh],{cwd:resolve(controllerDirectory),env,windowsHide:true,timeout:18*60_000,stdio:['ignore',log.fd,log.fd]});
    child.on('error',reject);child.on('close',value=>done(value??1));
  });}finally{await log.close();}
  let result;try{result=JSON.parse(await readFile(output,'utf8'));}catch{throw Error('TEMPLATE_DELIVERY_UNAVAILABLE');}
  if(code!==0 || !['DELIVERED','UNCHANGED','NO_DIFF','CLOSED'].includes(result.status))throw Error('TEMPLATE_DELIVERY_INCOMPLETE');
  return result;
}

/** The fixed job serializes all repositories and keeps discovered private names out of matrix/output. */
export async function templateWake({discover,deliver},clock=Date.now) {
  const counts={repositories:0,delivered:0,unchanged:0,closed:0,failed:0,deferred:0},deadline=clock()+18*60_000;
  for(const repository of await discover()) {
    if(repository.archived||repository.disabled)continue;counts.repositories++;
    if(clock()>=deadline){counts.deferred++;continue;}
    try {
      const result=await deliver(repository);
      if(result.status==='DELIVERED')counts.delivered++;
      else if(['NO_DIFF','UNCHANGED'].includes(result.status))counts.unchanged++;
      else if(result.status==='CLOSED')counts.closed++;
      else counts.failed++;
    }catch{counts.failed++;}
  }
  return counts;
}

export async function main() {
  const env=process.env,runId=Number(env.GITHUB_RUN_ID);
  assertTemplateWake(env,env.GITHUB_EVENT_PATH?JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8')):{});
  if(env.GITHUB_REPOSITORY!=='splrad/steward'||env.GITHUB_REPOSITORY_ID!=='1296724484'||env.GITHUB_REF!==`refs/heads/${env.STEWARD_DEFAULT_BRANCH}`
    ||!['repository_dispatch','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||!Number.isSafeInteger(runId)||runId<1
    ||!(/^[a-f0-9]{40}$/.test(env.STEWARD_CONTROLLER_SHA??'')))throw Error('TEMPLATE_CENTRAL_IDENTITY');
  const root=await mkdtemp(join(tmpdir(),'steward-template-wake-')),selection=join(root,'selection.json');
  const uv=await resolvePolicyTool('uv');
  await promisify(execFile)(uv,['run','--project','tools/template','--frozen','--no-sync','python','tools/template/copier_bridge.py','select',
    '--central',process.cwd(),'--template-sha',env.STEWARD_CONTROLLER_SHA,'--output',selection],
    {env:isolatedBuildEnvironment(env,join(root,'profile')),windowsHide:true,timeout:120_000});
  const {templateSha}=JSON.parse(await readFile(selection,'utf8'));
  if(!/^[a-f0-9]{40}$/.test(templateSha))throw Error('TEMPLATE_SELECTION');
  const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
  const counts=await templateWake({discover:()=>app.discover(),deliver:repository=>app.forTemplateRepository(repository.id,(writeToken,readToken)=>
    deliverRepositoryTemplate({repository:repository.full_name,repositoryId:repository.id,defaultBranch:repository.default_branch,runId,
      workflowSha:env.STEWARD_CONTROLLER_SHA,templateSha,bot:{id:app.appBotId,login:app.appBotLogin}},
      {writeToken,readToken,centralReadToken:env.GITHUB_TOKEN},{root}))});
  const summary=JSON.stringify(counts)+'\n';process.stdout.write(summary);if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,summary);
  if(counts.failed||counts.deferred)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('TEMPLATE_UNAVAILABLE\n');process.exitCode=1;});
