import apiVersion from "../config/github-api.json" with { type: "json" };
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
  const root=`/repos/${repository}`,client=new Octokit({auth:token,log:{debug(){},info(){},warn(){},error(){}},request:{fetch:transport,headers:{'x-github-api-version':apiVersion.version}}});
  client.hook.before('request',options=>{options.headers['x-github-api-version']=apiVersion.version;});
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
      const previous=snapshot.domainRecords.find(record=>record.path===`quality/${pr}.json`)?.value;
      const current=cache.heads[cache.currentHead], prior=previous?.heads?.[cache.currentHead];
      if(prior && prior.sourceSetDigest===current.sourceSetDigest && previous.configVersion===cache.configVersion)
        current.observedAt=prior.observedAt;
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
      return {commit:markdown ? await git('log','-1','--format=%H',head,'--',markdown.path) : head};
    }};}};
}

export function qualityTarget(inputs, repositories) {
  const repository = Object.hasOwn(repositories, inputs.repository_id) && repositories[inputs.repository_id];
  check(repository && /^[1-9][0-9]*$/.test(inputs.repository_id) &&
    /^[1-9][0-9]*$/.test(inputs.pull_number) && Number.isSafeInteger(Number(inputs.pull_number)) &&
    /^[a-f0-9]{40}$/.test(inputs.head_sha), 'EVENT_TARGET');
  return {repository, id:Number(inputs.repository_id), pr:Number(inputs.pull_number), head:inputs.head_sha};
}

export async function main() {
  const env = process.env;
  const {inputs, sender, repository:central} = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  check(env.GITHUB_REPOSITORY==='splrad/steward' && env.GITHUB_REPOSITORY_ID==='1296724484' &&
    central?.id===1296724484 && central.default_branch==='main' && env.GITHUB_REF==='refs/heads/main' &&
    env.GITHUB_EVENT_NAME==='workflow_dispatch' && sender?.id===301115370 && env.GITHUB_ACTOR_ID==='301115370' &&
    /^[a-f0-9]{40}$/.test(env.STEWARD_CONTROLLER_SHA) && inputs.policy_sha===env.STEWARD_CONTROLLER_SHA &&
    inputs.policy_sha===env.GITHUB_SHA, 'CENTRAL_IDENTITY');
  const config=JSON.parse(await readFile(new URL('../config/review/quality-language.json',import.meta.url),'utf8'));
  const target=qualityTarget(inputs,config.repositories);
  const root=await mkdtemp(join(tmpdir(),'steward-quality-event-'));
  try {
    const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
    const result=await app.forQualityRepository(target.id,async token=>{
      const io=qualityNativeIO(target.repository,token);
      const {value:repository}=await io.get('/repos/'+target.repository);
      check(repository.id===target.id && repository.full_name===target.repository && repository.owner?.id===302208797 &&
        repository.private===false && repository.visibility==='public' && !repository.archived && !repository.disabled, 'REPOSITORY_CHANGED');
      const {value:pr}=await io.get('/repos/'+target.repository+'/pulls/'+target.pr);
      check(pr.number===target.pr && pr.base?.repo?.id===target.id,'PR_IDENTITY');
      if(pr.state!=='open'||pr.head?.sha!==target.head)return {status:'SUPERSEDED'};
      const state=await openQualityStore(root,repository,token,io,config.governanceAppId);
      const budget={remaining:10,deadline:Date.now()+18*60_000};
      const client=copilotQualityClient(process.cwd(),env.STEWARD_COPILOT_TOKEN??'');
      const {complete,pending}=await serviceQualityPullRequest({repository:target.repository,repositoryId:target.id,
        pullRequestNumber:target.pr,head:target.head,appId,configVersion:config.configVersion},
        config.sources,state.cache(target.pr),io,state.forPull(target.pr),client,budget);
      return {complete,pending,batches:10-budget.remaining};
    });
    const summary=JSON.stringify(result)+'\n';
    process.stdout.write(summary);
    if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,summary);
    if(result.pending)process.exitCode=75;
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('QUALITY_UNAVAILABLE\n');process.exitCode=75;});
