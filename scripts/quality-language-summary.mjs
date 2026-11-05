import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { nativeReleaseApp, qualityPages, decodeQualityCache, serviceQualityPullRequest, copilotQualityClient,
  isolatedBuildEnvironment } from '../packages/runner/dist/index.js';
import { readReleaseRecords, writeReleaseRecords } from './release-record.mjs';
import { completeNativeRuleParameters } from './native-rule-parameters.mjs';

const branch='steward/governance-state', appId=4243096;
const identity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const check=(value,code)=>{if(!value)throw new Error('QUALITY_'+code);};

export function qualityNativeIO(repository,token,transport=fetch) {
  check(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)&&token,'TARGET');
  const root=`/repos/${repository}`,client=new Octokit({auth:token,log:{debug(){},info(){},warn(){},error(){}},request:{fetch:transport,headers:{'x-github-api-version':'2026-03-10'}}});
  client.hook.before('request',options=>{options.headers['x-github-api-version']='2026-03-10';});
  const allowed=path=>typeof path==='string'&&(path===root||path.startsWith(root+'/'))&&!path.includes('..')&&!path.includes('#')&&!path.includes('\\');
  return {async get(path){
    check(allowed(path),'READ_PATH');const response=await client.request(`GET ${path}`,{request:{signal:AbortSignal.timeout(60_000)}});
    const value=/\/rulesets\/\d+$/.test(path)?await completeNativeRuleParameters(client,response.data):response.data;
    return {value,headers:new Headers(Object.entries(response.headers).filter(([,v])=>typeof v==='string'))};
  },async writeCheck(body,id){
    check(body.name==='SPLRAD Quality 中文说明'&&body.status==='completed'&&body.conclusion==='neutral'
      &&/^[a-f0-9]{40}$/.test(body.head_sha)&&body.external_id.startsWith('splrad-quality:')
      &&Object.keys(body).sort().join(',')==='conclusion,external_id,head_sha,name,output,status','CHECK_WRITE');
    check(body.output&&Object.keys(body.output).sort().join(',')==='summary,title'&&body.output.title==='SPLRAD Quality 中文说明'
      &&typeof body.output.summary==='string'&&Buffer.byteLength(body.output.summary)<=48*1024,'CHECK_OUTPUT');
    check(id===null||Number.isSafeInteger(id)&&id>0,'CHECK_ID');
    const {head_sha,...update}=body;
    return (await client.request(`${id===null?'POST':'PATCH'} ${root}/check-runs${id===null?'':'/'+id}`,id===null?body:update)).data;
  }};
}

export async function assertQualityProtection(io,repository,governanceAppId) {
  check(Number.isSafeInteger(governanceAppId)&&governanceAppId>0&&governanceAppId!==appId,'GOVERNANCE_ID_PENDING');
  const rules=await qualityPages(io,`/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`);
  for(const type of ['creation','update','non_fast_forward','deletion'])check(rules.some(r=>r.type===type&&Number.isSafeInteger(r.ruleset_id)),'PROTECTION');
  for(const id of new Set(rules.filter(r=>['creation','update','non_fast_forward','deletion'].includes(r.type)).map(r=>r.ruleset_id))) {
    const {value:rule}=await io.get(`/repos/${repository}/rulesets/${id}`);
    check(rule.id===id&&rule.enforcement==='active'&&rule.target==='branch'&&Array.isArray(rule.bypass_actors)&&Array.isArray(rule.rules),'PROTECTION');
    const writer=rule.rules.some(r=>r.type==='creation'||r.type==='update');
    if(writer)check(rule.bypass_actors.length===2&&rule.bypass_actors.every(a=>a.actor_type==='Integration'&&a.bypass_mode==='always')
      &&[appId,governanceAppId].every(id=>rule.bypass_actors.some(a=>a.actor_id===id))
      &&rule.rules.every(r=>r.type!=='update'||r.parameters?.update_allows_fetch_and_merge===false),'PROTECTION');
    if(rule.rules.some(r=>r.type==='non_fast_forward'||r.type==='deletion'))check(rule.bypass_actors.length===0,'INTEGRITY');
  }
}

/** The same fixed fast-forward writer used by release facts, restricted to one PR's quality paths. */
export async function openQualityStore(root,repository,token,io,governanceAppId) {
  const {value:current}=await io.get(`/repos/${repository.full_name}`);
  check(current.id===repository.id&&current.full_name===repository.full_name&&current.default_branch===repository.default_branch&&!current.archived&&!current.disabled,'REPOSITORY_CHANGED');
  await assertQualityProtection(io,repository.full_name,governanceAppId);
  // Bootstrap owns initial branch creation. A missing/inaccessible ref is not an empty cache.
  const {value:ref}=await io.get(`/repos/${repository.full_name}/git/ref/heads/${branch}`);
  check(ref.ref===`refs/heads/${branch}`&&ref.object?.type==='commit'&&/^[a-f0-9]{40}$/.test(ref.object.sha),'STATE_REF');
  const remote=`https://github.com/${repository.full_name}.git`,directory=await mkdtemp(join(root,'quality-state-')),profile=await mkdtemp(join(root,'quality-profile-'));
  const environment=isolatedBuildEnvironment(process.env,profile);
  Object.assign(environment,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${remote}.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
  const git=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
    {cwd:directory,env:environment,encoding:'utf8',timeout:90_000,maxBuffer:32*1024*1024,windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=quality-read');await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
  check(await git('rev-parse','FETCH_HEAD')===ref.object.sha,'STATE_MOVED');await git('update-ref',`refs/heads/${branch}`,ref.object.sha);
  let snapshot=await readReleaseRecords({directory,targetRef:branch,repositoryId:repository.id});
  return {snapshot,cache(pr){const record=snapshot.domainRecords.find(r=>r.path===`quality/${pr}.json`);return record?decodeQualityCache(record.value,repository.id,pr):null;},
    forPull(pr){return {async save(cache,markdown){
      check(cache.repositoryId===repository.id&&cache.pullRequestNumber===pr,'CACHE_IDENTITY');
      const files=[{path:`quality/${pr}.json`,content:JSON.stringify(cache,null,2)+'\n'}];
      if(markdown){check(markdown.path===`quality/${pr}/${cache.currentHead}.md`,'MARKDOWN_PATH');files.push(markdown);}
      const changes=files.map(file=>({ ...file,sha256:hash(file.content),previousSha256:snapshot.currentPaths.includes(file.path)?hash(snapshot.domainRecords.find(r=>r.path===file.path).content):null}));
      const parent=await mkdtemp(join(root,'quality-write-'));
      const result=await writeReleaseRecords({directory:join(parent,'checkout'),remote,repositoryId:repository.id,defaultBranch:repository.default_branch,
        targetRef:branch,writer:'quality',expectedHead:snapshot.head,allowedPaths:files.map(f=>f.path),changes,identity},{token});
      check(['APPLIED','UNCHANGED'].includes(result.status),'STATE_WRITE_UNCONFIRMED');
      await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
      const head=await git('rev-parse','FETCH_HEAD');await git('update-ref',`refs/heads/${branch}`,head);
      snapshot=await readReleaseRecords({directory,targetRef:branch,repositoryId:repository.id});
      for(const file of files)check(snapshot.currentPaths.includes(file.path)&&snapshot.domainRecords.find(r=>r.path===file.path)?.content===file.content,'STATE_WRITE_CONFLICT');
      return {commit:head};
    }};}};
}

export async function qualityWake({discover,inventory,service},clock=Date.now) {
  const budget={remaining:10,deadline:clock()+18*60_000},counts={repositories:0,pullRequests:0,complete:0,pending:0,failed:0},ready=[];
  for(const repository of await discover()) {
    if(clock()>=budget.deadline)break;if(repository.archived||repository.disabled)continue;
    try{for(const item of await inventory(repository))ready.push({repository,...item});counts.repositories++;}catch{counts.failed++;}
  }
  ready.sort((a,b)=>Date.parse(a.observedAt??'1970-01-01T00:00:00Z')-Date.parse(b.observedAt??'1970-01-01T00:00:00Z')||a.repository.id-b.repository.id||a.pr-b.pr);
  for(const item of ready){if(clock()>=budget.deadline)break;try{const result=await service(item,budget);counts.pullRequests++;counts.complete+=result.complete;counts.pending+=result.pending;}catch{counts.failed++;}}
  return {...counts,batches:10-budget.remaining};
}

export async function main() {
  check(process.env.GITHUB_REPOSITORY==='splrad/steward'&&process.env.GITHUB_REPOSITORY_ID==='1296724484'
    &&process.env.GITHUB_REF===`refs/heads/${process.env.STEWARD_DEFAULT_BRANCH}`&&['push','schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
    &&/^[a-f0-9]{40}$/.test(process.env.STEWARD_CONTROLLER_SHA??''),'CENTRAL_IDENTITY');
  const config=JSON.parse(await readFile(new URL('../config/review/quality-language.json',import.meta.url),'utf8'));
  check(config.schemaVersion===1&&Object.keys(config).sort().join(',')==='configVersion,governanceAppId,schemaVersion,sources','CONFIG');
  check(config.sources.length>0&&Number.isSafeInteger(config.governanceAppId)&&config.governanceAppId>0,'SOURCE_CONFIG_PENDING');
  const root=await mkdtemp(join(tmpdir(),'steward-quality-wake-'));
  try {
    const app=await nativeReleaseApp(process.env.STEWARD_APP_PRIVATE_KEY??''),client=copilotQualityClient(process.cwd(),process.env.STEWARD_COPILOT_TOKEN??'');
    const counts=await qualityWake({discover:()=>app.discover(),inventory:repository=>app.forQualityRepository(repository.id,async token=>{
      const io=qualityNativeIO(repository.full_name,token),state=await openQualityStore(root,repository,token,io,config.governanceAppId);
      const prs=await qualityPages(io,`/repos/${repository.full_name}/pulls?state=open`);
      check(prs.every(pr=>Number.isSafeInteger(pr.number)&&pr.number>0&&pr.base?.repo?.id===repository.id&&/^[a-f0-9]{40}$/.test(pr.head?.sha))
        &&new Set(prs.map(pr=>pr.number)).size===prs.length,'PR_INVENTORY');
      return prs.map(pr=>({pr:pr.number,head:pr.head.sha,observedAt:state.cache(pr.number)?.heads[pr.head.sha]?.observedAt??null}));
    }),service:({repository,pr,head},budget)=>app.forQualityRepository(repository.id,async token=>{
      const io=qualityNativeIO(repository.full_name,token),state=await openQualityStore(root,repository,token,io,config.governanceAppId);
      return serviceQualityPullRequest({repository:repository.full_name,repositoryId:repository.id,pullRequestNumber:pr,head,appId,configVersion:config.configVersion},
        config.sources,state.cache(pr),io,state.forPull(pr),client,budget);
    })});
    const summary=JSON.stringify(counts)+'\n';process.stdout.write(summary);
    if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
    if(counts.failed)process.exitCode=75;
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('QUALITY_UNAVAILABLE\n');process.exitCode=75;});
