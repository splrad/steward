// @ts-nocheck
import {it,expect} from 'vitest';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createEmptyGovernanceRoot,initializeQualityState} from '../../../scripts/quality-state-initialize.mjs';
import {validatePlan,digest} from '../../../scripts/business-flow-acceptance.mjs';
import {isolatedBuildEnvironment} from '../dist/index.js';
const run=promisify(execFile),sha='a'.repeat(40);
const plan={schemaVersion:1,kind:'quality-initialize',maxRequests:0,stateSha:null,controllerSha:sha,baseSha:sha,governanceAppId:5639432,repository:{id:1296724484,full_name:'splrad/steward',private:false,default_branch:'main'}};
it('initialization is limited to exact public central target, zero calls and an absent state',()=>{
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main',GITHUB_SHA:sha,WORKFLOW_SHA:sha};
  const check=p=>validatePlan(JSON.stringify(p),digest(JSON.stringify(p)),env);
  expect(check(plan)).toEqual(plan);
  for(const p of [{...plan,maxRequests:1},{...plan,stateSha:sha},{...plan,baseSha:'b'.repeat(40)},{...plan,repository:{...plan.repository,private:true}},{...plan,repository:{...plan.repository,id:1}}])expect(()=>check(p)).toThrow();
});
for(const mode of ['success','lost-push-response','concurrent-root'])it(`real Git empty-root creation: ${mode}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'quality-root-test-'));registerOfflineFixtureRoot(root);
  try {
    const home=join(root,'home');await mkdir(home);const env=isolatedBuildEnvironment(process.env,home);
    const git=async(cwd,...args)=>(await run('git',['-c','core.hooksPath=',...args],{cwd,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    const remote=join(root,'remote.git');await git(root,'init','--bare',remote);
    const seed=join(root,'seed');await mkdir(seed);await git(seed,'init','--initial-branch=main');await git(seed,'config','user.name','Fixture');await git(seed,'config','user.email','fixture@example.invalid');await git(seed,'commit','--allow-empty','--no-gpg-sign','-m','Existing product');await git(seed,'push','--porcelain',remote,'HEAD:refs/heads/main');
    const main=await git(remote,'rev-parse','refs/heads/main');
    const directory=join(root,'write');await mkdir(directory);let pushes=0,other=null;
    const readHead=()=>git(remote,'rev-parse','refs/heads/steward/governance-state');
    const execute=async(file,args,options)=>{const result=await run(file,args,options);if(args.includes('push')){pushes++;if(mode==='lost-push-response')throw Error('lost response');}return result;};
    const action=()=>createEmptyGovernanceRoot({directory,remote,environment:env,controllerSha:sha,readHead,beforePush:async()=>{
      if(mode==='concurrent-root'){
        await git(seed,'checkout','--orphan','different');await git(seed,'commit','--allow-empty','--no-gpg-sign','-m','Concurrent owner');other=await git(seed,'rev-parse','HEAD');await git(seed,'push','--porcelain',remote,'HEAD:refs/heads/steward/governance-state');
      }
    }},execute);
    if(mode==='concurrent-root'){await expect(action()).rejects.toThrow('WRITE_UNCONFIRMED');expect(await readHead()).toBe(other);}
    else {const head=await action();expect(await readHead()).toBe(head);expect(await git(remote,'ls-tree','-r',head)).toBe('');expect(await git(remote,'show','-s','--format=%P',head)).toBe('');expect(pushes).toBe(1);}
    expect(await git(remote,'rev-parse','refs/heads/main')).toBe(main);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
for(const mode of ['existing','inaccessible','unlisted-rules','false-404'])it(`native guard stops before Git or writes: ${mode}`,async()=>{
  let executions=0,writes=0;
  const fetcher=async(url,init)=>{
    if(init.method!=='GET')writes++;
    const path=new URL(String(url)).pathname;let status=200,value={};
    if(path==='/repos/splrad/steward')value={...plan.repository,owner:{id:302208797},archived:false,disabled:false};
    else if(path.endsWith('/git/ref/heads/main'))value={object:{sha}};
    else if(path.endsWith('/git/ref/heads/steward/governance-state')){status=mode==='existing'?200:mode==='inaccessible'?403:404;value={};}
    else if(path.includes('matching-refs'))value=mode==='false-404'?[{ref:'refs/heads/steward/governance-state'}]:[];
    else if(path.endsWith('/rulesets'))value=[];
    else throw Error('Unexpected request '+path);
    return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  };
  await expect(initializeQualityState(plan,{root:tmpdir(),token:'fixture',fetcher,execute:async()=>{executions++;throw Error('must not execute');}})).rejects.toThrow();
  expect(executions).toBe(0);expect(writes).toBe(0);
});