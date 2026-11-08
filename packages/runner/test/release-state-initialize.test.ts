// @ts-nocheck
import {it as test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {fetchAdoptionSource,initializePrivateRelease} from '../../../scripts/release-state-initialize.mjs';
import {validatePlan,digest} from '../../../scripts/business-flow-acceptance.mjs';
const sha='a'.repeat(40),gov='b'.repeat(40);
const plan={schemaVersion:1,kind:'release-initialize',controllerSha:sha,maxRequests:0,repository:{id:1448797077,full_name:'splrad/steward-e10-lifecycle-20261107',private:true,default_branch:'main'},baseSha:sha,stateSha:null,releaseAdoption:{sourceSha:sha,prNumber:3}};
test('private initialization requires exact private target, actual adopted source and zero model requests',()=>{
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main',GITHUB_SHA:sha,WORKFLOW_SHA:sha};
  const check=p=>validatePlan(JSON.stringify(p),digest(JSON.stringify(p)),env);assert.equal(check(plan).kind,'release-initialize');
  for(const change of [{maxRequests:1},{stateSha:sha},{repository:{...plan.repository,private:false}},{releaseAdoption:{sourceSha:gov,prNumber:3}},{releaseAdoption:{sourceSha:sha,prNumber:0}}])assert.throws(()=>check({...plan,...change}));
});
test('private source fetch retains complete main ancestry and governance objects without a worktree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adoption-checkout-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote');await mkdir(remote);
    const env=isolatedBuildEnvironment(process.env,root),git=async(cwd,...args)=>(await promisify(execFile)('git',args,{cwd,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git(remote,'init','--initial-branch=main');await git(remote,'config','user.name','Fixture');await git(remote,'config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'app.txt'),'one');await git(remote,'add','.');await git(remote,'commit','-m','feat: add test app');const first=await git(remote,'rev-parse','HEAD');
    await git(remote,'branch','steward/governance-state');await writeFile(join(remote,'app.txt'),'two');await git(remote,'commit','-am','fix: refine app');const base=await git(remote,'rev-parse','HEAD');
    const directory=await fetchAdoptionSource({root,remote,token:'fixture',baseSha:base,governanceSha:first});
    assert.equal(await git(directory,'rev-list','--count','main'),'2');assert.equal(await git(directory,'show','main:app.txt'),'two');
    assert.equal(await git(directory,'rev-parse','steward/governance-state'),first);assert.equal(await git(directory,'rev-parse','--is-shallow-repository'),'false');
    await assert.rejects(fetchAdoptionSource({root,remote,token:'fixture',baseSha:sha,governanceSha:first}),/SOURCE_CHANGED/);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
test('native initialization blocks unknown/existing state and changed private identity before Git',async()=>{
  for(const fault of ['existing','unknown','false404','public','base']) {
    let gitCalls=0;
    const fetcher=async (url,init)=>{
      const path=new URL(url).pathname;

      if(path.endsWith('/git/ref/heads/steward/release-state'))return new Response('{}',{status:fault==='existing'?200:fault==='unknown'?403:404});
      if(path.includes('/git/matching-refs/'))return Response.json(fault==='false404'?[{ref:'refs/heads/steward/release-state'}]:[]);
      if(path.endsWith('/git/ref/heads/main'))return Response.json({object:{sha:fault==='base'?gov:sha}});
      return Response.json({...plan.repository,private:fault!=='public',archived:false,disabled:false});
    };
    await assert.rejects(initializePrivateRelease(plan,{root:tmpdir(),token:'fixture',readToken:'fixture-read',appBotId:301115370,fetcher,execute:async()=>{gitCalls++;throw Error('unexpected git');}}),/ACCEPTANCE_INITIALIZE_/);
    assert.equal(gitCalls,0);
  }
});
test('hosted parent passes complete private request and scoped token to existing adoption writer without printing identifiers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adoption-parent-'));let captured,options;const routed=[];
  vi.doMock('../../../scripts/release-adoption.mjs',()=>({initializeReleaseAdoption:async(request,deps)=>{captured=request;options=deps;return {status:'APPLIED',head:gov,releaseAdoption:plan.releaseAdoption};}}));
  vi.resetModules();
  try {
    const {initializePrivateRelease:initialize}=await import('../../../scripts/release-state-initialize.mjs');
    const fetcher=async (url,init)=>{
      const path=new URL(url).pathname;
      if(path.includes('/pulls')){routed.push(new Headers(init.headers).get('authorization'));return Response.json([]);}
      if(path.endsWith('/git/ref/heads/steward/release-state'))return new Response('{}',{status:404});
      if(path.includes('/git/matching-refs/'))return Response.json([]);
      if(path.endsWith('/git/ref/heads/main'))return Response.json({object:{sha}});
      if(path.endsWith('/git/ref/heads/steward/governance-state'))return Response.json({ref:'refs/heads/steward/governance-state',object:{sha:gov,type:'commit'}});
      return Response.json({...plan.repository,archived:false,disabled:false});
    };
    let fetchCount=0;
    const execute=async(_cmd,args,opts)=>{
      assert.ok(opts.env.GIT_CONFIG_KEY_0.startsWith('http.https://github.com/'));assert.ok(!args.join(' ').includes('fixture-token'));
      if(args.includes('fetch'))fetchCount++;
      return {stdout:args.includes('--is-shallow-repository')?'false':args.includes('FETCH_HEAD')?(fetchCount===1?sha:gov):''};
    };
    assert.deepEqual(await initialize(plan,{root,token:'fixture-token',readToken:'fixture-read-token',appBotId:301115370,fetcher,execute}),{kind:'release-initialize',status:'INITIALIZED',calls:0});
    assert.equal(fetchCount,2);assert.equal(captured.repositoryId,1448797077);assert.deepEqual(captured.releaseAdoption,plan.releaseAdoption);assert.equal(options.token,'fixture-token');
    assert.ok(captured.directory.startsWith(root));assert.ok(captured.writeDirectory.startsWith(root));
    for(const suffix of ['/pulls?state=closed&per_page=100&page=1','/pulls/3','/commits/'+sha+'/pulls?per_page=100&page=2'])await options.io.request('GET','/repos/'+plan.repository.full_name+suffix);
    assert.deepEqual(routed,['Bearer fixture-read-token','Bearer fixture-read-token','Bearer fixture-read-token']);
    await assert.rejects(options.io.request('GET','/repos/'+plan.repository.full_name+'/commits/main'),/BASE_CHANGED/);
  }finally{vi.doUnmock('../../../scripts/release-adoption.mjs');vi.resetModules();await rm(root,{recursive:true,force:true});}
});
