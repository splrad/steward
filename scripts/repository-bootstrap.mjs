import {parseAcceptanceTarget} from './bootstrap-acceptance.mjs';
export {decodeAcceptanceTarget,parseAcceptanceTarget} from './bootstrap-acceptance.mjs';
import {createAppAuth} from '@octokit/auth-app';
import {Octokit} from '@octokit/rest';
import {readFile,mkdtemp,mkdir,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {bootstrapRepository,isolatedBuildEnvironment} from '../packages/runner/dist/index.js';
import {readReleaseRecords,writeReleaseRecords} from './release-record.mjs';
import {assertQualityProtection} from './quality-language-summary.mjs';
import {completeNativeRuleParameters} from './native-rule-parameters.mjs';

const branch='steward/governance-state',check=(value,code)=>{if(!value)throw Error('BOOTSTRAP_'+code);};
const log={debug(){},info(){},warn(){},error(){}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function bootstrapNativeIO(token,transport=fetch) {
  const nativeFetch=(url,init)=>{
    // Octokit's URL template parser removes the slash required by GitHub's all-refs endpoint.
    const target=new URL(String(url));
    if(init?.method==='GET'&&target.origin==='https://api.github.com'&&/^\/repos\/[^/]+\/[^/]+\/git\/matching-refs$/.test(target.pathname))target.pathname+='/';
    return transport(target,init);
  };
  const client=new Octokit({auth:token,log,request:{fetch:nativeFetch,headers:{'x-github-api-version':'2026-03-10'}}});
  client.hook.before('request',options=>{options.headers['x-github-api-version']='2026-03-10';});
  return {async request(method,path,body){
    try {const r=await client.request(`${method} ${path}`,{...body,request:{signal:AbortSignal.timeout(60_000)}});
      const value=method==='GET'&&/\/rulesets\/\d+$/.test(path)?await completeNativeRuleParameters(client,r.data):r.data;
      return {status:r.status,value};}
    catch(error){if(error.status)return {status:error.status,value:error.response?.data};throw Error('BOOTSTRAP_TRANSPORT');}
  }};
}
async function get(io,path,optional=false) {
  const response=await io.request('GET',path);
  if(optional&&response.status===404)return null;check(response.status===200,'NATIVE_READ');return response.value;
}
async function pages(io,path) {
  const result=[];
  for(let page=1;page<=10000;page++) {const items=await get(io,`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    check(Array.isArray(items),'PAGINATION');result.push(...items);if(items.length<100)return result;}
  throw Error('BOOTSTRAP_PAGINATION');
}
function qualityIO(io) {return {async get(path){return {value:await get(io,path),headers:new Headers()};}};}

/** Native rule definitions establish first-ref authority; actual effective rules are checked after creation. */
export async function verifyGovernanceCreation(io,repository,appId) {
  const summaries=await pages(io,`/repos/${repository.full_name}/rulesets?includes_parents=true`),found=new Set();
  for(const summary of summaries) {
    const projected=await get(io,`/repos/${repository.full_name}/rulesets/${summary.id}`);
    // Repository projections omit organization repository-name conditions.
    const rule=projected.source_type==='Organization'&&projected.source==='splrad'
      ?await get(io,`/orgs/splrad/rulesets/${summary.id}`):projected;
    if(rule.enforcement!=='active'||rule.target!=='branch'||JSON.stringify(rule.conditions?.ref_name?.include)!==JSON.stringify([`refs/heads/${branch}`]))continue;
    check(rule.id===summary.id&&JSON.stringify(rule.conditions.ref_name.exclude)==='[]','STATE_RULE');
    check(rule.source_type==='Organization'&&rule.source==='splrad'&&JSON.stringify(rule.conditions.repository_name?.include)==='["~ALL"]'
      &&rule.conditions.repository_name.protected===false&&rule.conditions.repository_name.exclude.every(name=>/^[A-Za-z0-9_.-]+$/.test(name)&&name!==repository.name),'STATE_RULE_SCOPE');
    const types=rule.rules.map(r=>r.type);
    if(types.includes('creation')||types.includes('update')) {
      check(rule.bypass_actors.length===2&&[4243096,appId].every(id=>rule.bypass_actors.some(a=>a.actor_id===id&&a.actor_type==='Integration'&&a.bypass_mode==='always'))
        &&rule.rules.every(r=>r.type!=='update'||r.parameters?.update_allows_fetch_and_merge===false),'STATE_WRITER');
    }
    if(types.includes('non_fast_forward')||types.includes('deletion'))check(rule.bypass_actors.length===0,'STATE_INTEGRITY');
    for(const type of types)found.add(type);
  }
  check(['creation','update','non_fast_forward','deletion'].every(type=>found.has(type)),'STATE_CREATION_PROTECTION');
}

export async function archiveBootstrap({root,repository,token,appId,identity,record,origin,io},
  {read=readReleaseRecords,write=writeReleaseRecords,executeGit=promisify(execFile)}={}) {
  check(record.phase==='RESTORED'&&/^[a-f0-9]{40}$/.test(record.firstCommitSha??'')&&['app','external'].includes(origin),'ARCHIVE_FACTS');
  const prefix=`/repos/${repository.full_name}`;
  const observed=await get(io,prefix);check(observed.id===repository.id&&observed.default_branch===repository.default_branch,'ARCHIVE_TARGET');
  const ref=await get(io,`${prefix}/git/ref/heads/${branch}`,true);
  if(ref)await assertQualityProtection(qualityIO(io),repository.full_name,appId);
  else await verifyGovernanceCreation(io,repository,appId);
  const directory=await mkdtemp(join(root,'bootstrap-state-')),profile=join(directory,'profile');await mkdir(profile);
  const env=isolatedBuildEnvironment(process.env,profile),remote=`https://github.com/${repository.full_name}.git`;
  Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${remote}.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
  const git=async(...args)=>(await executeGit('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=','-c','core.fsmonitor=false',...args],
    {cwd:directory,env,windowsHide:true,timeout:90_000})).stdout.trim();
  await git('init','--initial-branch=bootstrap-read');
  let snapshot={head:null,domainRecords:[]};
  const refresh=async()=>{await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
    const head=await git('rev-parse','FETCH_HEAD');await git('update-ref',`refs/heads/${branch}`,head);
    return read({directory,targetRef:branch,repositoryId:repository.id});};
  if(ref){snapshot=await refresh();check(snapshot.head===ref.object?.sha,'ARCHIVE_REF_CHANGED');}
  const path=`bootstrap/${record.runId}-${record.runAttempt}.json`,content=JSON.stringify({...record,firstCommitOrigin:origin},null,2)+'\n';
  const existing=snapshot.domainRecords.find(r=>r.path===path);
  if(existing) {check(existing.content===content,'ARCHIVE_CONFLICT');return snapshot.head;}
  const result=await write({directory:join(directory,'write'),remote,repositoryId:repository.id,defaultBranch:repository.default_branch,targetRef:branch,
    writer:'bootstrap',expectedHead:snapshot.head,allowedPaths:[path],changes:[{path,content,sha256:hash(content),previousSha256:null}],identity},{token});
  check(['APPLIED','UNCHANGED'].includes(result.status),'ARCHIVE_WRITE');
  snapshot=await refresh();check(snapshot.domainRecords.find(r=>r.path===path)?.content===content,'ARCHIVE_READBACK');
  await assertQualityProtection(qualityIO(io),repository.full_name,appId);return snapshot.head;
}

export function bootstrapOnly(env) {
  const raw=env.STEWARD_BOOTSTRAP_ONLY??'false';
  check(raw==='false'||raw==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch','TARGET_INPUT');
  return raw==='true';
}
export async function bootstrapWake({discover,service,repositoryId=null}) {
  const counts={repositories:0,ready:0,existing:0,failed:0};
  const installed=await discover();
  check(repositoryId===null||positive(repositoryId)&&installed.filter(r=>r.id===repositoryId&&r.private===true&&!r.archived&&!r.disabled).length===1,'TARGET_NOT_INSTALLED');
  for(const repository of installed) {
    if(repositoryId!==null&&repository.id!==repositoryId)continue;
    if(repository.archived||repository.disabled)continue;
    counts.repositories++;
    try {const result=await service(repository);if(result.status==='EXISTING')counts.existing++;else counts.ready++;}
    catch{counts.failed++;}
  }
  return counts;
}

export async function main(transport=fetch) {
  const nativeTransport=(input,init)=>{
    const headers=new Headers(init?.headers);headers.set('X-GitHub-Api-Version','2026-03-10');
    return transport(input,{...init,headers});
  };
  const env=process.env,appId=Number(env.GOVERNANCE_APP_ID),single=bootstrapOnly(env);
  check(env.GITHUB_REPOSITORY==='splrad/steward'&&env.GITHUB_REPOSITORY_ID==='1296724484'&&env.GITHUB_REF===`refs/heads/${env.STEWARD_DEFAULT_BRANCH}`
    &&['push','schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)&&/^[a-f0-9]{40}$/.test(env.STEWARD_CONTROLLER_SHA??'')&&positive(appId)&&appId!==4243096,'CENTRAL_IDENTITY');
  const config=JSON.parse(await readFile('config/governance/bootstrap.json','utf8'));
  check(config.schemaVersion===1&&Object.keys(config).sort().join(',')==='rules,schemaVersion'&&Array.isArray(config.rules),'CONFIG');
  const app=new Octokit({authStrategy:createAppAuth,auth:{appId,privateKey:env.GOVERNANCE_APP_PRIVATE_KEY},log,request:{fetch:nativeTransport}});
  app.hook.before('request',options=>{options.headers['x-github-api-version']='2026-03-10';});
  const fact=(await app.request('GET /app')).data,installation=(await app.request('GET /orgs/splrad/installation')).data;
  check(fact.id===appId&&installation.app_id===appId&&installation.account?.id===302208797&&!installation.suspended_at,'GOVERNANCE_APP');
  const publicReader=new Octokit({log,request:{fetch:nativeTransport}});
  const bot=(await publicReader.request('GET /users/{username}',{username:fact.slug+'[bot]'})).data;check(bot.type==='Bot'&&positive(bot.id),'BOT');
  const identity={name:bot.login,email:`${bot.id}+${bot.login}@users.noreply.github.com`,id:bot.id};
  const central=bootstrapNativeIO(env.GITHUB_TOKEN,transport),controller=await get(central,`/repos/splrad/steward/actions/runs/${env.GITHUB_RUN_ID}`);
  const source={workflowId:controller.workflow_id,runId:Number(env.GITHUB_RUN_ID),runAttempt:Number(env.GITHUB_RUN_ATTEMPT),controllerSha:env.STEWARD_CONTROLLER_SHA};
  const verifySource=async s=>{
    const run=await get(central,`/repos/splrad/steward/actions/runs/${s.runId}`),workflow=await get(central,`/repos/splrad/steward/actions/workflows/${s.workflowId}`);
    check(run.repository?.id===1296724484&&run.head_repository?.id===1296724484&&run.head_sha===s.controllerSha&&run.head_branch===env.STEWARD_DEFAULT_BRANCH
      &&run.workflow_id===s.workflowId&&run.run_attempt>=s.runAttempt&&['push','schedule','workflow_dispatch'].includes(run.event)
      &&workflow.path==='.github/workflows/sync-managed.yml'&&workflow.state==='active','SOURCE_RUN');
    await promisify(execFile)('git',['--no-replace-objects','merge-base','--is-ancestor',s.controllerSha,env.STEWARD_CONTROLLER_SHA],{windowsHide:true});
  };
  const credential=async(repositoryId,permissions)=>{
    const value=await app.auth({type:'installation',installationId:installation.id,refresh:true,permissions,...(repositoryId?{repositoryIds:[repositoryId]}:{})});
    const io=bootstrapNativeIO(value.token,transport);return {token:value.token,io,revoke:async()=>{const r=await io.request('DELETE','/installation/token');check(r.status===204,'TOKEN_REVOKE');}};
  };
  const root=await mkdtemp(join(tmpdir(),'steward-bootstrap-'));
  let repositoryId=null;
  if(single) {
    const c=await credential(1447987054,{metadata:'read',contents:'read'});
    try {
      const admin=await get(c.io,'/repos/splrad/steward-settings');
      check(admin.id===1447987054&&admin.private===true&&admin.default_branch==='main','ACCEPTANCE_ADMIN');
      const file=await get(c.io,'/repos/splrad/steward-settings/contents/acceptance/bootstrap-target.json?ref=main');
      check(file.type==='file'&&file.encoding==='base64'&&file.size<=1024,'ACCEPTANCE_FILE');
      repositoryId=parseAcceptanceTarget(Buffer.from(file.content,'base64').toString('utf8'));
    }finally{await c.revoke();}
  }
  const counts=await bootstrapWake({repositoryId,discover:async()=>{
    const c=await credential(null,{metadata:'read'});
    try {const result=[];let total=null;
      for(let page=1;page<=10000;page++) {
        const value=await get(c.io,`/installation/repositories?per_page=100&page=${page}`);
        check(total===null||total===value.total_count,'INSTALLATION_CHANGED');total=value.total_count;result.push(...value.repositories);
        if(result.length===total){check(new Set(result.map(r=>r.id)).size===total&&result.every(r=>r.owner?.id===302208797),'INSTALLATION_SCOPE');return result;}
        check(value.repositories.length===100,'INSTALLATION_INCOMPLETE');
      }throw Error('BOOTSTRAP_INSTALLATION_INCOMPLETE');
    }finally{await c.revoke();}
  },service:async repository=>{
    if(single) {
      const reader=await credential(repository.id,{metadata:'read'});
      try {
        const current=await get(reader.io,`/repos/${repository.full_name}`);
        check(current.id===repository.id&&current.full_name===repository.full_name&&current.owner?.id===302208797
          &&current.private===true&&!current.archived&&!current.disabled,'TARGET_CHANGED');
      }finally{await reader.revoke();}
    }
    const c=await credential(repository.id,{metadata:'read',contents:'write',administration:'write',actions_variables:'write',organization_administration:'write'});
    try {
      const scope=await get(c.io,'/installation/repositories');check(scope.total_count===1&&scope.repositories[0]?.id===repository.id,'TOKEN_SCOPE');
      return await bootstrapRepository(repository,source,config.rules,c.io,{requirePrivate:single,identity,now:()=>new Date().toISOString(),verifySource,
        verifyProtection:async r=>{const rules=await pages(c.io,`/repos/${r.full_name}/rules/branches/${encodeURIComponent(r.default_branch)}`);
          check(rules.some(rule=>rule.type==='pull_request')&&rules.some(rule=>rule.type==='required_status_checks'),'DEFAULT_PROTECTION');},
        archive:(record,origin)=>archiveBootstrap({root,repository,token:c.token,appId,identity:{name:identity.name,email:identity.email},record,origin,io:c.io})});
    }finally{await c.revoke();}
  }});
  const summary=JSON.stringify(counts)+'\n';process.stdout.write(summary);if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,summary);
  if(counts.failed)process.exitCode=1;
  return counts;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('BOOTSTRAP_UNAVAILABLE\n');process.exitCode=1;});
