import apiVersion from "../config/github-api.json" with { type: "json" };
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Octokit} from '@octokit/rest';
import {createAppAuth} from '@octokit/auth-app';
import YAML from 'yaml';
import {isolatedBuildEnvironment,resolvePolicyTool} from '../packages/runner/dist/index.js';
import {requiredWorkflowBinding as binding} from './required-workflow-binding.mjs';
import {createSourceGuard,publishControllerSource} from './controller-source.mjs';

const repo='/repos/splrad/steward',rulePath='/orgs/splrad/rulesets/18883080';
const validationPath='.github/workflows/pr-validation-native.yml';
const check=(condition,code)=>{if(!condition)throw Error('PROMOTION_'+code);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const quiet={debug(){},info(){},warn(){},error(){}};

export function promotionIO(token,transport=fetch) {
  const client=new Octokit({auth:token,log:quiet,request:{fetch:transport,headers:{'x-github-api-version':apiVersion.version}}});
  client.hook.before('request',options=>{options.headers['x-github-api-version']=apiVersion.version;});
  return {graphql: (...args)=>client.graphql(...args),async request(method,path,body){
    try {const r=await client.request(`${method} ${path}`,{...body,request:{signal:AbortSignal.timeout(60000)}});return {status:r.status,value:r.data};}
    catch(e){if(e.status)return {status:e.status,value:e.response?.data};throw Error('PROMOTION_TRANSPORT');}
  }};
}
async function get(io,path,absent=false) {
  const r=await io.request('GET',path);if(absent&&r.status===404)return null;
  check(r.status===200,`NATIVE_READ_${Number.isInteger(r.status)?r.status:'UNKNOWN'}`);return r.value;
}
async function pages(io,path,key) {
  const values=[];let total;
  for(let page=1;page<=10000;page++) {
    const value=await get(io,`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    check(positive(value.total_count)||value.total_count===0,'PAGINATION');
    check(total===undefined||total===value.total_count,'PAGINATION_CHANGED');total=value.total_count;
    const batch=value[key];check(Array.isArray(batch),'PAGINATION');values.push(...batch);
    if(values.length===total){check(new Set(values.map(v=>v.id)).size===values.length,'DUPLICATE');return values;}
    check(batch.length===100&&values.length<total,'PAGINATION_INCOMPLETE');
  }
  throw Error('PROMOTION_PAGINATION_INCOMPLETE');
}
export function validationJobNames(document) {
  check(document?.name==='SPLRAD Steward / Native Validation'&&document.on?.push?.branches?.includes('main'),'VALIDATION_DEFINITION');
  const jobs=Object.values(document.jobs??{}),names=jobs.map(j=>j.name);
  check(jobs.length>1&&jobs.every(j=>!j.strategy&&typeof j.name==='string'&&!j.name.includes('${{'))
    &&new Set(names).size===names.length&&names.includes('SPLRAD Validation'),'VALIDATION_JOBS');
  return names;
}

/** A display name is never authority: the registered native ID and path must both match. */
export async function selectPromotion(io,{workflowId,event,sourceRunId,controllerSha,requiredJobs,skippableJobs=[]}) {
  check(Array.isArray(skippableJobs)&&skippableJobs.every(name=>requiredJobs.includes(name)&&name!=='SPLRAD Validation'),'SKIP_POLICY');
  check(positive(workflowId)&&sha(controllerSha)&&['workflow_run','schedule','workflow_dispatch'].includes(event),'ENTRY');
  const current=await get(io,`${repo}/commits/main`);check(sha(current.sha),'MAIN');
  if(current.sha!==controllerSha)return {status:'STALE'};
  const workflow=await get(io,`${repo}/actions/workflows/${workflowId}`);
  check(workflow.id===workflowId&&workflow.path===validationPath&&workflow.name==='SPLRAD Steward / Native Validation','WORKFLOW');
  if(workflow.state!=='active')return {status:'DISABLED'};
  let run;
  if(event==='workflow_run'){check(positive(sourceRunId),'RUN_ID');run=await get(io,`${repo}/actions/runs/${sourceRunId}`);}
  else {
    const runs=await pages(io,`${repo}/actions/workflows/${workflowId}/runs?event=push&branch=main&head_sha=${current.sha}`,'workflow_runs');
    if(!runs.length)return {status:'WAITING_VALIDATION'};
    runs.sort((a,b)=>b.id-a.id);run=await get(io,`${repo}/actions/runs/${runs[0].id}`);
  }
  check(positive(run.id)&&positive(run.run_attempt)&&run.repository?.id===1296724484&&run.head_repository?.id===1296724484
    &&run.workflow_id===workflowId&&run.path===validationPath&&run.event==='push'&&run.head_branch==='main','RUN_SOURCE');
  if(run.head_sha!==current.sha)return {status:'STALE'};
  if(run.status!=='completed'||run.conclusion!=='success')return {status:'WAITING_VALIDATION'};
  const jobs=await pages(io,`${repo}/actions/runs/${run.id}/jobs?filter=all`,'jobs');
  const selected=[];
  for(const name of requiredJobs) {
    const candidates=jobs.filter(j=>j.name===name);
    check(candidates.length>0&&candidates.every(j=>j.run_id===run.id&&j.head_sha===current.sha&&positive(j.run_attempt)&&j.run_attempt<=run.run_attempt),'JOBS_SOURCE');
    candidates.sort((a,b)=>b.run_attempt-a.run_attempt);
    check(candidates.filter(j=>j.run_attempt===candidates[0].run_attempt).length===1,'JOBS_AMBIGUOUS');
    // The successful trusted aggregate has already checked which scope outputs require each conditional job.
    check(candidates[0].status==='completed'&&(candidates[0].conclusion==='success'
      ||skippableJobs.includes(name)&&candidates[0].conclusion==='skipped'),'JOBS_INCOMPLETE');selected.push(candidates[0].id);
  }
  const after=await get(io,`${repo}/actions/runs/${run.id}`);
  check(after.run_attempt===run.run_attempt&&after.status==='completed'&&after.conclusion==='success'
    &&after.head_sha===run.head_sha&&after.workflow_id===workflowId&&after.event==='push'
    &&after.repository?.id===1296724484&&after.head_repository?.id===1296724484&&after.path===validationPath&&after.head_branch==='main','RUN_CHANGED');
  if((await get(io,`${repo}/commits/main`)).sha!==current.sha)return {status:'STALE'};
  return {status:'ELIGIBLE',sha:current.sha,runId:run.id,runAttempt:run.run_attempt,workflowId,jobIds:selected};
}
function mutable(rule) {
  check(rule.id===18883080&&rule.source==='splrad'&&rule.source_type==='Organization'&&rule.target==='branch'
    &&rule.enforcement==='active'&&Array.isArray(rule.rules)&&Array.isArray(rule.bypass_actors)&&rule.conditions,'RULE');
  return Object.fromEntries(['name','target','enforcement','bypass_actors','conditions','rules'].map(k=>[k,structuredClone(rule[k])]));
}

/** PUT is not a CAS. Only rules are sent; unrelated fields are compared before and after. */
export async function promoteRequiredWorkflow(io,target,assertCurrent,record) {
  check(sha(target),'TARGET');
  for(let attempt=1;attempt<=3;attempt++) {
    const original=await get(io,rulePath),before=mutable(original),old=binding(before).sha;
    await record({kind:'rules-before',attempt,before:original,adoptedSha:old,target});
    if(old===target)return {status:'ALREADY_ADOPTED',sha:target};
    await assertCurrent();
    const latest=await get(io,rulePath),fresh=mutable(latest);
    if(!same(before,fresh)){await record({kind:'rules-changed-before-write',attempt,current:latest});continue;}
    const expected=structuredClone(fresh);binding(expected).sha=target;
    await assertCurrent();
    let response='unknown';
    try {response=(await io.request('PUT',rulePath,{rules:expected.rules})).status;}catch{}
    const observed=await get(io,rulePath),after=mutable(observed);await record({kind:'rules-after',attempt,response,after:observed});
    if(same(after,expected))return {status:'ADOPTED',sha:target};
    const actual=binding(after).sha,rest=structuredClone(after);binding(rest).sha=old;
    check(same(rest,before),'EXTERNAL_RULE_CHANGE');
    if(actual!==old&&actual!==target)await record({kind:'rules-third-value',attempt,sha:actual});
  }
  throw Error('PROMOTION_RECONCILIATION_LIMIT');
}

export async function publishTemplateTag(io,plan,assertCurrent,record) {
  check(plan&&sha(plan.commit)&&['UNCHANGED','CREATE'].includes(plan.status),'TEMPLATE_PLAN');
  check(plan.tags&&typeof plan.tags==='object'&&!Array.isArray(plan.tags)
    &&Object.entries(plan.tags).every(([ref,value])=>ref.startsWith('refs/tags/')&&sha(value)),'TEMPLATE_REFS');
  const readTags=async()=>{
    const refs=await get(io,`${repo}/git/matching-refs/tags/`);
    check(Array.isArray(refs)&&refs.every(r=>r.ref?.startsWith('refs/tags/')&&sha(r.object?.sha))
      &&new Set(refs.map(r=>r.ref)).size===refs.length,'TEMPLATE_REFS');
    return Object.fromEntries(refs.map(r=>[r.ref,r.object.sha]));
  };
  const observed=await readTags();await record({kind:'template-refs-before',observed});
  check(same(observed,plan.tags),'TEMPLATE_REFS_CHANGED');
  if(plan.status==='UNCHANGED')return {status:'UNCHANGED'};
  check(/^v[0-9][A-Za-z0-9.!+-]*$/.test(plan.tag),'TEMPLATE_TAG');
  const path=`${repo}/git/ref/tags/${encodeURIComponent(plan.tag)}`;
  const read=()=>get(io,path,true);
  const matches=r=>r?.ref===`refs/tags/${plan.tag}`&&r.object?.type==='commit'&&r.object.sha===plan.commit;
  const prior=await read();if(prior){check(matches(prior),'TAG_CONFLICT');return {status:'ALREADY_PUBLISHED',tag:plan.tag};}
  await assertCurrent();let response='unknown';
  try{response=(await io.request('POST',`${repo}/git/refs`,{ref:`refs/tags/${plan.tag}`,sha:plan.commit})).status;}catch{}
  const after=await read();await record({kind:'template-tag',response,tag:plan.tag,commit:plan.commit,observed:after});
  check(matches(after),'TAG_UNCONFIRMED');
  const refs=await readTags();await record({kind:'template-refs-after',observed:refs});
  check(same(refs,{...plan.tags,[`refs/tags/${plan.tag}`]:plan.commit}),'TEMPLATE_REFS_CHANGED');
  return {status:'PUBLISHED',tag:plan.tag};
}

export async function withGovernanceCredential(env,operation,transport=fetch) {
  const appId=Number(env.GOVERNANCE_APP_ID);check(positive(appId)&&appId!==4243096,'APP_ID');
  const app=new Octokit({authStrategy:createAppAuth,auth:{appId,privateKey:env.GOVERNANCE_APP_PRIVATE_KEY},log:quiet,
    request:{fetch:transport,headers:{'x-github-api-version':apiVersion.version}}});
  app.hook.before('request',options=>{options.headers['x-github-api-version']=apiVersion.version;});
  const fact=(await app.request('GET /app')).data,installation=(await app.request('GET /orgs/splrad/installation')).data;
  check(fact.id===appId&&fact.slug==='splrad-governance'&&installation.app_id===appId&&installation.account?.id===302208797&&!installation.suspended_at,'APP_IDENTITY');
  const permissions={organization_administration:'write',contents:'write',metadata:'read'};
  const credential=(await app.request('POST /app/installations/{installation_id}/access_tokens',{installation_id:installation.id,repository_ids:[1296724484],permissions})).data;
  check(typeof credential.token==='string'&&credential.token,'TOKEN');const io=promotionIO(credential.token,transport);
  try {
    check(same(credential.permissions,permissions),'TOKEN_PERMISSIONS');
    const scope=await get(io,'/installation/repositories?per_page=100');
    check(scope.total_count===1&&scope.repositories?.length===1&&scope.repositories[0].id===1296724484&&scope.repositories[0].full_name==='splrad/steward','TOKEN_SCOPE');
    return await operation(io);
  }finally{const revoked=await io.request('DELETE','/installation/token');check(revoked.status===204,'TOKEN_REVOKE');}
}

export async function verifyPromotionSource(env,transport=fetch) {
  check(env.GITHUB_REPOSITORY==='splrad/steward'&&env.GITHUB_REPOSITORY_ID==='1296724484'&&env.GITHUB_REF==='refs/heads/main'
    &&sha(env.STEWARD_CONTROLLER_SHA)&&positive(Number(env.GITHUB_RUN_ID)),'CENTRAL');
  const document=YAML.parse(await readFile(validationPath,'utf8')),requiredJobs=validationJobNames(document);
  const skippableJobs=Object.entries(document.jobs).filter(([key,job])=>!['scope','summary'].includes(key)&&job.if).map(([,job])=>job.name);
  return selectPromotion(promotionIO(env.GITHUB_TOKEN,transport),{workflowId:Number(env.NATIVE_VALIDATION_WORKFLOW_ID),event:env.GITHUB_EVENT_NAME,
    sourceRunId:Number(env.SOURCE_VALIDATION_RUN_ID),controllerSha:env.STEWARD_CONTROLLER_SHA,requiredJobs,skippableJobs});
}
export async function preflight(env=process.env,transport=fetch) {
  check(!env.GOVERNANCE_APP_PRIVATE_KEY,'PREFLIGHT_PRIVILEGE');
  const source=await verifyPromotionSource(env,transport);
  const output=resolve(env.PROMOTION_EVIDENCE_DIRECTORY??'promotion-evidence');await mkdir(output,{recursive:true});
  await writeFile(join(output,'source-preflight.json'),JSON.stringify(source)+'\n',{mode:0o600});
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,`eligible=${source.status==='ELIGIBLE'}\n`);
  return source;
}

export async function wakePublishedTemplate(io,published,assertCurrent,record) {
  if(published.status!=='PUBLISHED')return;
  await assertCurrent();
  // One fixed event, no private data or caller-selected ref. Unknown responses are
  // recorded by the existing failed run and recovered through explicit sync dispatch.
  const response=await io.request('POST',`${repo}/dispatches`,{event_type:'steward-template-event',client_payload:{schemaVersion:1}});
  check(response.status===204,'TEMPLATE_WAKE_UNCONFIRMED');
  await record({kind:'template-wake',status:'ACCEPTED'});
}

export async function recordPromotionFailure(error,record) {
  const code=/^(?:PROMOTION|CONTROLLER_SOURCE|NATIVE_RULE_PARAMETERS)_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'PROMOTION_UNAVAILABLE';
  await record({kind:'failure',code});throw Error(code);
}

export async function main(env=process.env,transport=fetch) {
  const output=resolve(env.PROMOTION_EVIDENCE_DIRECTORY??'promotion-evidence');await mkdir(output,{recursive:true});
  const record=value=>appendFile(join(output,'observations.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
  try {
  const read=promotionIO(env.GITHUB_TOKEN,transport);
  // Re-read native evidence with no reliance on preflight files/outputs for write authorization.
  const source=await verifyPromotionSource(env,transport);
  await record({kind:'source',...source});if(source.status!=='ELIGIBLE'){process.stdout.write(`Promotion: ${source.status}\n`);return;}
  const assertCurrent=async()=>check((await get(read,`${repo}/commits/main`)).sha===source.sha,'MAIN_MOVED');
  const uv=await resolvePolicyTool('uv'),profile=join(output,'profile'),clean=isolatedBuildEnvironment(env,profile);
  await mkdir(profile,{recursive:true});
  // The checkout is the reviewed central source. Refresh tags without executing repository hooks.
  const execute=promisify(execFile);
  await execute('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=','fetch','--tags','--no-recurse-submodules','origin'],{env:clean,windowsHide:true,timeout:90000});
  const planPath=join(output,'template-plan.json');
  await execute(uv,['run','--project','tools/template','--frozen','--no-sync','python','tools/template/promotion.py','--central',process.cwd(),'--commit',source.sha,'--output',planPath],{env:clean,windowsHide:true,timeout:120000});
  const plan=JSON.parse(await readFile(planPath,'utf8'));await record({kind:'template-plan',...plan});
  await assertCurrent();
  await withGovernanceCredential(env,async io=>{
    // The source namespace must be protected before any promotion write occurs.
    const guard=createSourceGuard(io,Number(env.GOVERNANCE_APP_ID),assertCurrent);
    await guard();
    const adopted=await promoteRequiredWorkflow(io,source.sha,guard,record);await record({kind:'rules-result',...adopted});
    const published=await publishTemplateTag(io,plan,guard,record);await record({kind:'template-result',...published});
    const controller=await publishControllerSource(io,source.sha,Number(env.GOVERNANCE_APP_ID),guard,record);
    await record({kind:'controller-source-result',...controller});
    await wakePublishedTemplate(io,published,guard,record);
  },transport);
  process.stdout.write('Promotion: adopted and reconciled\n');
  }catch(error){
    await recordPromotionFailure(error,record);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const execute=process.argv.length===2?main:process.argv.length===3&&process.argv[2]==='--check-source'?preflight:null;
  if(!execute){process.stderr.write('PROMOTION_ENTRY\n');process.exitCode=1;}
  else execute().catch(()=>{process.stderr.write('PROMOTION_UNAVAILABLE\n');process.exitCode=1;});
}
