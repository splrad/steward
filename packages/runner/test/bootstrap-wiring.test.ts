import {expect,it,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import YAML from 'yaml';
import {decodeStateFile} from '../../core/src/release-observation.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';

const module=()=>import(pathToFileURL(resolve('scripts/repository-bootstrap.mjs')).href);
it('bootstrap-only selection validates before credentials and never services other installed repositories',async()=>{
  const {bootstrapOnly,bootstrapWake,decodeAcceptanceTarget,parseAcceptanceTarget}=await module();
  expect(bootstrapOnly({})).toBe(false);
  expect(bootstrapOnly({GITHUB_EVENT_NAME:'workflow_dispatch',STEWARD_BOOTSTRAP_ONLY:'true'})).toBe(true);
  for(const raw of ['0','12','TRUE'])expect(()=>bootstrapOnly({GITHUB_EVENT_NAME:'workflow_dispatch',STEWARD_BOOTSTRAP_ONLY:raw})).toThrow();
  expect(()=>bootstrapOnly({GITHUB_EVENT_NAME:'push',STEWARD_BOOTSTRAP_ONLY:'true'})).toThrow();
  const target={schemaVersion:1,repositoryId:12,purpose:'bootstrap-only'};
  expect(decodeAcceptanceTarget(target)).toBe(12);
  for(const bad of [{...target,repositoryId:0},{...target,extra:true},{...target,purpose:'templates'}])expect(()=>decodeAcceptanceTarget(bad)).toThrow();
  expect(()=>parseAcceptanceTarget('{"repositoryId":private-canary}')).toThrow(/^BOOTSTRAP_ACCEPTANCE_TARGET_INVALID$/);
  const service=vi.fn(async()=>({status:'EXISTING'})),discover=async()=>[{id:12,private:true},{id:13,private:true}];
  expect(await bootstrapWake({discover,service,repositoryId:12})).toEqual({repositories:1,ready:0,existing:1,failed:0});
  expect(service.mock.calls).toEqual([[{id:12,private:true}]]);
  service.mockClear();
  for(const list of [[{id:13}],[{id:12,private:false}],[{id:12,private:true,archived:true}],[{id:12,private:true},{id:12,private:true}]])await expect(bootstrapWake({discover:async()=>list,service,repositoryId:12})).rejects.toThrow('TARGET_NOT_INSTALLED');
  expect(service).not.toHaveBeenCalled();
});
it.each([{single:false,changed:false},{single:true,changed:false},{single:true,changed:true}])('real bootstrap entry separates scoped credentials (%j)',async({single,changed})=>{
  const {main}=await module(),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const values={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',
    STEWARD_DEFAULT_BRANCH:'main',GITHUB_EVENT_NAME:'workflow_dispatch',STEWARD_CONTROLLER_SHA:'a'.repeat(40),
    GOVERNANCE_APP_ID:'88',GOVERNANCE_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    GITHUB_TOKEN:'workflow-fixture',GITHUB_RUN_ID:'21',GITHUB_RUN_ATTEMPT:'1',GITHUB_STEP_SUMMARY:'',STEWARD_BOOTSTRAP_ONLY:String(single)};
  for(const [key,value] of Object.entries(values))vi.stubEnv(key,value);
  const repository={id:12,name:'fixture',full_name:'splrad/fixture',default_branch:'develop',owner:{id:302208797},archived:false,disabled:false,private:true};
  const calls:{path:string;method:string;body:any}[]=[],requests:any[]=[],revoked:string[]=[];
  let credential=0;
  const transport=async(input:any,init:any)=>{
    const url=new URL(String(input)),path=decodeURIComponent(url.pathname),method=init.method??'GET',headers=new Headers(init.headers);
    const body=init.body?JSON.parse(init.body):undefined;calls.push({path,method,body});
    expect(url.origin).toBe('https://api.github.com');expect(headers.get('x-github-api-version')).toBe('2026-03-10');
    let value:any,status=200;
    if(path==='/app')value={id:88,slug:'fixture-governance'};
    else if(path==='/orgs/splrad/installation')value={id:8,app_id:88,account:{id:302208797},suspended_at:null};
    else if(path==='/users/fixture-governance[bot]'){
      expect(headers.has('authorization')).toBe(false);value={id:33,login:'fixture-governance[bot]',type:'Bot'};
    }else if(path==='/repos/splrad/steward/actions/runs/21')value={workflow_id:42};
    else if(path==='/repos/splrad/steward-settings')value={id:1447987054,private:true,default_branch:'main'};
    else if(path==='/repos/splrad/steward-settings/contents/acceptance/bootstrap-target.json')value={type:'file',encoding:'base64',size:200,content:Buffer.from(JSON.stringify({schemaVersion:1,repositoryId:12,purpose:'bootstrap-only'})).toString('base64')};
    else if(path==='/app/installations/8/access_tokens'){
      expect(headers.get('authorization')).toMatch(/^bearer /i);requests.push(body);credential++;
      value={token:'ghs_fixture'+credential,expires_at:new Date(Date.now()+3600000).toISOString()};status=201;
    }else if(path==='/installation/repositories')value={total_count:1,repositories:[repository]};
    else if(path==='/installation/token'&&method==='DELETE'){revoked.push(headers.get('authorization')!);status=204;}
    else if(path==='/repos/splrad/fixture')value={...repository,private:!changed};
    else if(path==='/repos/splrad/fixture/actions/variables/STEWARD_BOOTSTRAP_RECOVERY'){status=404;value={message:'Not Found'};}
    else if(path==='/repos/splrad/fixture/git/matching-refs/')value=[{ref:'refs/heads/develop',object:{sha:'b'.repeat(40)}}];
    else if(path==='/repos/splrad/fixture/commits')value=[{sha:'b'.repeat(40),parents:[],author:{id:44},commit:{message:'Existing user commit'}}];
    else throw Error('UNEXPECTED_BOOTSTRAP_ENDPOINT');
    return new Response(status===204?null:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  };
  try{
    expect(await main(transport)).toEqual({repositories:1,ready:0,existing:changed?0:1,failed:changed?1:0});
    if(changed){
      expect(requests).toEqual([{repository_ids:[1447987054],permissions:{metadata:'read',contents:'read'}},{permissions:{metadata:'read'}},{repository_ids:[12],permissions:{metadata:'read'}}]);
      expect(revoked).toHaveLength(3);expect(new Set(revoked).size).toBe(3);
      expect(calls.filter(c=>!['GET','DELETE'].includes(c.method)).map(c=>c.path)).toEqual(Array(3).fill('/app/installations/8/access_tokens'));
      return;
    }
    expect(requests).toEqual([...(single?[{repository_ids:[1447987054],permissions:{metadata:'read',contents:'read'}}]:[]),{permissions:{metadata:'read'}},...(single?[{repository_ids:[12],permissions:{metadata:'read'}}]:[]),{repository_ids:[12],permissions:{metadata:'read',contents:'write',administration:'write',actions_variables:'write',organization_administration:'write'}}]);
    expect(revoked).toHaveLength(single?4:2);expect(new Set(revoked).size).toBe(single?4:2);
    expect(calls.filter(c=>!['GET','DELETE'].includes(c.method)).map(c=>c.path)).toEqual(Array(single?4:2).fill('/app/installations/8/access_tokens'));
  }finally{if(changed)process.exitCode=0;vi.unstubAllEnvs();}
});
const actors=[4243096,88].map(actor_id=>({actor_id,actor_type:'Integration',bypass_mode:'always'}));
const nativeRule=(id:number)=>({id,source:'splrad',source_type:'Organization',enforcement:'active',target:'branch',
  conditions:{ref_name:{include:['refs/heads/steward/governance-state'],exclude:[] as string[]},repository_name:{include:['~ALL'],exclude:[],protected:false}},
  rules:id===1?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}],
  bypass_actors:id===1?actors:[]});

it('bootstrap and template jobs enumerate independently, separate keys and keep failure/cancellation semantics',async()=>{
  const raw=await readFile('.github/workflows/sync-managed.yml','utf8'),workflow=YAML.parse(raw),{bootstrap,templates}=workflow.jobs;
  expect(Object.keys(workflow.jobs)).toEqual(['bootstrap','templates','automation-health']);expect(workflow.permissions).toEqual({contents:'read',actions:'read'});
  expect(bootstrap.concurrency).toEqual({group:'steward-governance-mutation','cancel-in-progress':false,queue:'max'});
  expect(templates.needs).toBe('bootstrap');expect(templates.if).toContain('!cancelled()');expect(templates.if).not.toMatch(/success\(/);
  expect(templates.concurrency['cancel-in-progress']).toBe(false);
  expect(templates.if).toContain('!inputs.bootstrap_only');
  expect(bootstrap.if).toContain("vars.STEWARD_BOOTSTRAP_APPLY == 'true'");
  expect(bootstrap.if).not.toContain('STEWARD_TEMPLATE_APPLY');
  expect(bootstrap.if).toContain("github.event_name == 'workflow_dispatch' && inputs.bootstrap_only");
  expect(bootstrap.steps.at(-1).env.STEWARD_BOOTSTRAP_ONLY).toContain('inputs.bootstrap_only');
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['health_only','bootstrap_only']);
  expect(workflow.jobs['automation-health'].if).toContain('!inputs.bootstrap_only');
  for(const job of [bootstrap,templates]) {
    expect(job.if).toContain("vars.STEWARD_TEMPLATE_APPLY == 'true'");expect(job.environment.name).toBe('steward-automation');
    expect(job.steps[0].with).toEqual({ref:'${{ github.workflow_sha }}','fetch-depth':0,'persist-credentials':false});
    expect(job.steps[2].env).toBeUndefined();expect(job.steps[2].run).toContain('npm ci --ignore-scripts');
  }
  expect(bootstrap.steps.at(-1).env).toHaveProperty('GOVERNANCE_APP_PRIVATE_KEY');expect(bootstrap.steps.at(-1).env).not.toHaveProperty('STEWARD_APP_PRIVATE_KEY');
  expect(templates.steps.at(-1).env).toHaveProperty('STEWARD_APP_PRIVATE_KEY');expect(templates.steps.at(-1).env).not.toHaveProperty('GOVERNANCE_APP_PRIVATE_KEY');
  expect(raw).not.toMatch(/matrix:|outputs:|upload-artifact|create-pull-request|managed-sync (targets|preview|apply|preflight)/);
});
it('a failed or pending repository does not hide failure or stop independent repositories and exposes only counts',async()=>{
  const {bootstrapWake}=await module(),{templateWake}=await import(pathToFileURL(resolve('scripts/template-delivery.mjs')).href);
  const repos=[{id:1,full_name:'splrad/private-canary'},{id:2,full_name:'splrad/other'}];let calls=0;
  const b=await bootstrapWake({discover:async()=>repos,service:async(r:any)=>{calls++;if(r.id===1)throw Error('private-canary');return {status:'EXISTING'};}});
  expect(b).toEqual({repositories:2,ready:0,existing:1,failed:1});expect(calls).toBe(2);
  const t=await templateWake({discover:async()=>repos,deliver:async(r:any)=>{if(r.id===1)throw Error('private-canary');return {status:'NO_DIFF'};}});
  expect(t).toEqual({repositories:2,delivered:0,unchanged:1,closed:0,failed:1,deferred:0});expect(JSON.stringify({b,t})).not.toContain('canary');
});
it('first governance ref requires actual organization scope and both writer/integrity roles',async()=>{
  const {verifyGovernanceCreation}=await module();let mutate=(r:any)=>r;
  const io={async request(_method:string,path:string){return {status:200,value:path.includes('/rulesets?')?[{id:1},{id:2}]:mutate(nativeRule(Number(path.split('/').at(-1))))};}};
  const repo={id:12,name:'fixture',full_name:'splrad/fixture'};await verifyGovernanceCreation(io,repo,88);
  for(const variant of [(r:any)=>({...r,source:'another'}),(r:any)=>({...r,bypass_actors:actors}),
    (r:any)=>({...r,conditions:{...r.conditions,repository_name:{include:['~ALL'],exclude:['fix*'],protected:false}}})]) {
    mutate=variant;await expect(verifyGovernanceCreation(io,repo,88)).rejects.toThrow();
  }
});
it('reads organization scope from the organization endpoint when repository projection omits it',async()=>{
  const {verifyGovernanceCreation}=await module(),calls:string[]=[];
  const io={async request(_method:string,path:string){calls.push(path);
    if(path.includes('/rulesets?'))return {status:200,value:[{id:1},{id:2}]};
    const rule=nativeRule(Number(path.split('/').at(-1)));
    if(path.startsWith('/repos/'))delete (rule.conditions as any).repository_name;
    return {status:200,value:rule};
  }};
  await verifyGovernanceCreation(io,{id:12,name:'fixture',full_name:'splrad/fixture'},88);
  expect(calls).toContain('/orgs/splrad/rulesets/1');expect(calls).toContain('/orgs/splrad/rulesets/2');
});
it('accepts shared integrity rules only when they explicitly cover the governance ref without exclusions',async()=>{
  const {verifyGovernanceCreation}=await module();
  let included=['refs/heads/steward/release-state','refs/heads/steward/governance-state','refs/heads/steward/automation-health'],excluded:string[]=[];
  const writerIncluded=['refs/heads/steward/governance-state'];
  const io={async request(_method:string,path:string){
    if(path.includes('/rulesets?'))return {status:200,value:[{id:1},{id:2}]};
    const rule=nativeRule(Number(path.split('/').at(-1)));
    if(rule.id===2)rule.conditions.ref_name={include:included,exclude:excluded};
    else rule.conditions.ref_name.include=writerIncluded;
    return {status:200,value:rule};
  }};
  const repository={id:12,name:'fixture',full_name:'splrad/fixture'};
  await verifyGovernanceCreation(io,repository,88);
  included=['refs/heads/steward/release-state'];
  await expect(verifyGovernanceCreation(io,repository,88)).rejects.toThrow('STATE_CREATION_PROTECTION');
  included=['refs/heads/steward/governance-state','refs/heads/steward/release-state'];excluded=['refs/heads/steward/governance-state'];
  await expect(verifyGovernanceCreation(io,repository,88)).rejects.toThrow('STATE_RULE');
  excluded=[];writerIncluded.push('refs/heads/steward/release-state');
  await expect(verifyGovernanceCreation(io,repository,88)).rejects.toThrow('STATE_WRITER_SCOPE');
});
it('native variable absence is 404 only; 403 and transport failures remain distinct failures',async()=>{
  const {bootstrapNativeIO}=await module();
  for(const status of [404,403]) {
    const io=bootstrapNativeIO('fixture-token',async(url:any,init:any)=>{
      expect(String(url)).toBe('https://api.github.com/repos/splrad/fixture/actions/variables/STEWARD_BOOTSTRAP_RECOVERY');
      expect(init.headers.authorization).toBe('token fixture-token');return new Response(JSON.stringify({message:'fixture'}),{status,headers:{'content-type':'application/json'}});
    });
    expect((await io.request('GET','/repos/splrad/fixture/actions/variables/STEWARD_BOOTSTRAP_RECOVERY')).status).toBe(status);
  }
});
it('preserves the required all-refs slash after the installed Octokit template parser',async()=>{
  const {bootstrapNativeIO}=await module(),calls:string[]=[];
  const io=bootstrapNativeIO('fixture-token',async(url:any,init:any)=>{
    calls.push(String(url));expect(init.headers['x-github-api-version']).toBe('2026-03-10');
    const correct=String(url)==='https://api.github.com/repos/splrad/fixture/git/matching-refs/';
    return new Response(JSON.stringify({message:correct?'Git Repository is empty.':'Not Found'}),{status:correct?409:404,headers:{'content-type':'application/json'}});
  });
  expect(await io.request('GET','/repos/splrad/fixture/git/matching-refs/')).toMatchObject({status:409,value:{message:'Git Repository is empty.'}});
  expect(calls).toHaveLength(1);
});
it('actual Git bootstrap archive initializes its protected state branch, reads back origin and reconciles repeats',async()=>{
  const {archiveBootstrap}=await module(),{writeReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'bootstrap-archive-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const env=isolatedBuildEnvironment(process.env,profile),execute=promisify(execFile);
    const git=async(...args:string[])=>(await execute('git',args,{cwd:remote,env,windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=develop');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'# Repository\n');await git('add','README.md');await git('commit','--signoff','-m','Initial');const first=await git('rev-parse','HEAD');
    const repository={id:12,name:'fixture',full_name:'splrad/fixture',default_branch:'develop'};
    const io={async request(_method:string,path:string):Promise<any>{
      if(path==='/repos/splrad/fixture')return {status:200,value:repository};
      if(path.includes('/git/ref/')) {try{return {status:200,value:{ref:'refs/heads/steward/governance-state',object:{sha:await git('rev-parse','--verify','refs/heads/steward/governance-state')}}};}catch{return {status:404,value:{}};}}
      if(path.includes('/rulesets?'))return {status:200,value:[{id:1},{id:2}]};
      if(path.includes('/rules/branches/'))return {status:200,value:[{type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}]};
      if(path.includes('/rulesets/'))return {status:200,value:nativeRule(Number(path.split('/').at(-1)))};
      throw Error(path);
    }};
    const record={schemaVersion:1,repositoryId:12,defaultBranch:'develop',workflowId:42,runId:21,runAttempt:1,controllerSha:'a'.repeat(40),firstCommitSha:first,phase:'RESTORED',affectedRules:[]};
    const options={write:async(request:any,auth:any)=>{expect(request.remote).toBe('https://github.com/splrad/fixture.git');expect(request.writer).toBe('bootstrap');return writeReleaseRecords({...request,remote},auth);},
      executeGit:async(command:string,args:string[],options:any)=>execute(command,args.map(a=>a==='https://github.com/splrad/fixture.git'?remote:a),options)};
    const input={root,repository,token:'fixture-token',appId:88,identity:{name:'Fixture',email:'fixture@example.invalid'},record,origin:'external',io};
    await expect(archiveBootstrap({...input,origin:'app',originCorrection:true,requireExistingArchive:true},options)).rejects.toThrow('ORIGIN_ARCHIVE_MISSING');
    const head=await archiveBootstrap(input,options);expect(await archiveBootstrap(input,options)).toBe(head);
    const text=await git('show',`${head}:bootstrap/21-1.json`);expect(JSON.parse(text).firstCommitOrigin).toBe('external');
    expect(decodeStateFile('steward/governance-state','bootstrap/21-1.json',Buffer.from(text),12)).toMatchObject({firstCommitSha:first,firstCommitOrigin:'external'});
    expect((await git('show','-s','--format=%B',head)).split('Signed-off-by:')).toHaveLength(2);
    await expect(archiveBootstrap({...input,origin:'app'},options)).rejects.toThrow('ARCHIVE_CONFLICT');
    await expect(archiveBootstrap({...input,origin:'app',originCorrection:true,record:{...record,controllerSha:'d'.repeat(40)}},options)).rejects.toThrow('ARCHIVE_CONFLICT');
    const corrected=await archiveBootstrap({...input,origin:'app',originCorrection:true},options);
    expect(corrected).not.toBe(head);expect(await git('rev-parse',`${corrected}^`)).toBe(head);
    const correctedRecord=JSON.parse(await git('show',`${corrected}:bootstrap/21-1.json`));
    expect(correctedRecord).toEqual({...JSON.parse(text),firstCommitOrigin:'app'});
    expect(JSON.parse(await git('show',`${head}:bootstrap/21-1.json`)).firstCommitOrigin).toBe('external');
    expect(await archiveBootstrap({...input,origin:'app',originCorrection:true},options)).toBe(corrected);
    expect(await git('rev-parse','refs/heads/develop')).toBe(first);

  }finally{await rm(root,{recursive:true,force:true});}
},120000);

it('repairs only a proven private completed archive origin and never recreates recovery or commits',async()=>{
  const {reconcileBootstrapOrigin}=await module();
  const repository={id:12,name:'fixture',full_name:'splrad/fixture',default_branch:'main',private:true,owner:{id:302208797},archived:false,disabled:false};
  const identity={id:33,name:'fixture[bot]',email:'33+fixture[bot]@users.noreply.github.com'};
  const record={schemaVersion:1,repositoryId:12,defaultBranch:'main',workflowId:42,runId:21,runAttempt:1,controllerSha:'a'.repeat(40),firstCommitSha:'b'.repeat(40),phase:'RESTORED',affectedRules:[]};
  let origin='external',author=33,privateRepo=true,recovery:any=null,badSource=false,body='# Repository\n';
  const calls:any[]=[],writes:any[]=[],sources:any[]=[];
  const io={async request(method:string,path:string){expect(method).toBe('GET');calls.push(path);let value:any;
    if(path.includes('/commits?'))value=[{sha:record.firstCommitSha,parents:[],author:{id:author},commit:{message:`chore: initialize repository\n\nSigned-off-by: ${identity.name} <${identity.email}>\nSteward-Bootstrap-Run: 1296724484/21/1`}}];
    else if(path.includes('/contents/bootstrap/'))value={type:'file',encoding:'base64',size:500,content:Buffer.from(JSON.stringify({...record,firstCommitOrigin:origin})).toString('base64')};
    else if(path.includes('/contents/README.md'))value={encoding:'base64',content:Buffer.from(body).toString('base64')};
    else if(path.includes('/actions/variables/'))return {status:recovery?200:404,value:recovery??{}};
    else if(path==='/repos/splrad/fixture')value={...repository,private:privateRepo};
    else throw Error('unexpected '+path);
    return {status:200,value};
  }};
  const invoke=()=>reconcileBootstrapOrigin({root:'unused',repository,token:'fixture',appId:88,identity,io,verifySource:async(r:any)=>{sources.push(r);if(badSource)throw Error('source');}},async(args:any)=>{writes.push(args);return 'c'.repeat(40);});
  expect(await invoke()).toBe(true);expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({origin:'app',originCorrection:true,requireExistingArchive:true,record});expect(sources).toEqual([record]);
  writes.length=0;origin='app';expect(await invoke()).toBe(false);
  origin='external';author=34;expect(await invoke()).toBe(false);author=33;
  body='# Repository';expect(await invoke()).toBe(false);body='# Repository\n';
  privateRepo=false;await expect(invoke()).rejects.toThrow('ORIGIN_TARGET');privateRepo=true;
  recovery={name:'STEWARD_BOOTSTRAP_RECOVERY',value:'pending'};await expect(invoke()).rejects.toThrow('ORIGIN_RECOVERY_PRESENT');recovery=null;
  badSource=true;await expect(invoke()).rejects.toThrow('source');expect(writes).toHaveLength(0);
});
it('bootstrap native source verification accepts the fixed governance event and preserves historical recovery checks',async()=>{
  const {verifyBootstrapSource}=await module();const sha='a'.repeat(40);
  const source={workflowId:42,runId:21,runAttempt:1,controllerSha:sha},env={STEWARD_DEFAULT_BRANCH:'main',STEWARD_CONTROLLER_SHA:sha};
  for(const event of ['repository_dispatch','workflow_dispatch','push','schedule']){
    let run:any={repository:{id:1296724484},head_repository:{id:1296724484},head_sha:sha,head_branch:'main',workflow_id:42,run_attempt:1,event,actor:{id:353238212,login:'splrad-governance[bot]'}};
    const calls:any[]=[];const io={request:async(_method:string,path:string)=>({status:200,value:path.includes('/runs/')?run:{path:'.github/workflows/sync-managed.yml',state:'active'}})};
    const execute=async(...args:any[])=>{calls.push(args);};await verifyBootstrapSource(io,source,env,execute);
    expect(calls[0][1]).toEqual(['--no-replace-objects','merge-base','--is-ancestor',sha,sha]);
    if(event==='repository_dispatch'){
      for(const patch of [{actor:{id:1,login:'splrad-governance[bot]'}},{head_sha:'b'.repeat(40)},{head_repository:{id:1}},{run_attempt:0}]){
        const saved=run;run={...saved,...patch};await expect(verifyBootstrapSource(io,source,env,execute)).rejects.toThrow('SOURCE_RUN');run=saved;
      }
    }
  }
});
