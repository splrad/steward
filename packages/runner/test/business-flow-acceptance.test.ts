// @ts-nocheck
import {it as test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {validatePlan,boundedClient,digest,executePlan} from '../../../scripts/business-flow-acceptance.mjs';
const sha='a'.repeat(40),env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main',GITHUB_SHA:sha,WORKFLOW_SHA:sha};
const plan={schemaVersion:1,kind:'release',controllerSha:sha,maxRequests:1,repository:{id:1,full_name:'test/product',private:true,default_branch:'main'},baseSha:sha,stateSha:sha};
test('requires exact approved bytes and native main first-attempt provenance',()=>{
  const raw=JSON.stringify(plan);assert.equal(validatePlan(raw,digest(raw),env).maxRequests,1);
  for(const change of [{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_REF:'refs/pull/1/merge'},{WORKFLOW_SHA:'b'.repeat(40)},{GITHUB_REPOSITORY_ID:'2'}])assert.throws(()=>validatePlan(raw,digest(raw),{...env,...change}));
  assert.throws(()=>validatePlan(raw+' ',digest(raw),env));
});
test('rejects excluded repositories and more than one generation per invocation',()=>{
  for(const p of [{...plan,maxRequests:2},{...plan,repository:{...plan.repository,full_name:'splrad/steward-e08-product'}}]){const raw=JSON.stringify(p);assert.throws(()=>validatePlan(raw,digest(raw),env));}
});
test('zero-generation replay blocks before preflight or request; failure consumes the single local allowance',async()=>{
  let sent=0,reads=0;const sdk={preflight:async()=>{reads++;return 'READY';},call:async()=>{sent++;throw Error('RESPONSE_UNKNOWN');}};
  const zero=boundedClient(sdk,0);assert.throws(()=>zero.preflight());await assert.rejects(zero.call('x'));assert.equal(reads,0);assert.equal(sent,0);
  const one=boundedClient(sdk,1);assert.equal(await one.preflight(),'READY');await assert.rejects(one.call('x'));assert.throws(()=>one.preflight());await assert.rejects(one.call('x'));assert.equal(sent,1);
});
test('workflow keeps one gated consumer and plan values out of public dispatch inputs',async()=>{
  const {readFile}=await import('node:fs/promises'),{parse}=await import('yaml');
  const w=parse(await readFile('.github/workflows/business-flow-acceptance.yml','utf8')),j=w.jobs.acceptance;
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.equal(w.on.workflow_dispatch.inputs.authorize.default,false);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(),['approved_plan_sha256','approved_sha','authorize','consumer']);
  for(const gate of ['github.run_attempt == 1','inputs.authorize','inputs.approved_sha == github.sha','github.workflow_sha == github.sha'])assert.ok(j.if.includes(gate));
  assert.equal(j.permissions['copilot-requests'],'write');assert.equal(w.permissions['copilot-requests'],undefined);
  const consumers=j.steps.filter(s=>s.env?.STEWARD_COPILOT_TOKEN);assert.equal(consumers.length,1);
  assert.equal(consumers[0].env.STEWARD_COPILOT_TOKEN,'${{ github.token }}');assert.equal(consumers[0].env.STEWARD_ACCEPTANCE_PLAN,'${{ secrets.STEWARD_E10_ACCEPTANCE_PLAN }}');
  for(const step of j.steps.filter(s=>s!==consumers[0]))assert.doesNotMatch(JSON.stringify(step),/secrets\./);
});

test('changed PR or store snapshot stops the actual acceptance entry before cache save and model execution',async()=>{
  let movedPr=false,movedState=false,saves=0,opened=0;
  const repository={id:1,full_name:'test/product',default_branch:'main',private:true};
  vi.doMock('../../../scripts/quality-language-summary.mjs',()=>({
    qualityNativeIO:()=>({get:async(path)=>({value:path.endsWith('/pulls/1')?{number:1,state:'open',head:{sha:movedPr?'b'.repeat(40):sha},base:{repo:{id:1},ref:"main",sha}}:path.includes('/git/ref/')?{object:{sha}}:{...repository,archived:false,disabled:false}})}),
    openQualityStore:async()=>{opened++;return {snapshot:{head:movedState?'b'.repeat(40):sha},cache:()=>null,forPull:()=>({save:async()=>{saves++;}})};},
  }));
  const p={...plan,kind:'quality',repository,pr:1,head:sha,sources:[],governanceAppId:2,configVersion:'v1',sourceSetDigest:'a'.repeat(64)};
  const app={forQualityRepository:async(_id,callback)=>callback('fake-token')};
  movedPr=true;await assert.rejects(executePlan(p,{root:'.',controllerDirectory:process.cwd(),app,modelToken:''}),/HEAD_CHANGED/);assert.equal(opened,0);
  movedPr=false;movedState=true;await assert.rejects(executePlan(p,{root:'.',controllerDirectory:process.cwd(),app,modelToken:''}),/STATE_CHANGED/);assert.equal(opened,1);assert.equal(saves,0);
  vi.doUnmock('../../../scripts/quality-language-summary.mjs');
});

test('native candidate rejects a changed actual initial Git snapshot before business writes',async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const {isolatedBuildEnvironment}=await import('../src/build-environment.js');
  const {registerOfflineFixtureRoot}=await import('./offline-fixtures.js');
  const root=await mkdtemp(join(tmpdir(),'candidate-state-pin-'));registerOfflineFixtureRoot(root);
  try{
    const remote=join(root,'remote'),directory=join(root,'read');await mkdir(remote);await mkdir(directory);
    const env=isolatedBuildEnvironment(process.env,root),git=async(cwd,...args)=>(await promisify(execFile)('git',args,{cwd,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git(remote,'init','--initial-branch=steward/release-state');await git(remote,'config','user.name','Fixture');await git(remote,'config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'state.json'),JSON.stringify({schemaVersion:3,repositoryId:1,defaultBranch:'main',revision:0,releaseAdoption:{sourceSha:sha,prNumber:1},lastObservedDefaultSha:sha,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null})+'\n');
    await git(remote,'add','.');await git(remote,'commit','-m','fixture');const actual=await git(remote,'rev-parse','HEAD');await git(directory,'init');
    const {nativeReleaseCandidate}=await import('../../../scripts/release-candidate.mjs');let requests=0;
    const fetcher=async()=>{requests++;return new Response(JSON.stringify({object:{sha:actual,type:'commit'}}));};
    const request={directory,writeDirectory:join(root,'writes'),remote,repository:'test/product',repositoryId:1,defaultBranch:'main'};
    await assert.rejects(nativeReleaseCandidate(request,{token:'write',readToken:'read',controllerSha:sha,expectedStateSha:'b'.repeat(40),fetcher,temporaryRoot:root}),/CANDIDATE_STATE_CHANGED/);
    assert.equal(requests,1);assert.equal(await git(remote,'rev-parse','HEAD'),actual);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);

test('rechecks approved base and full sources after generation before publishing a Check',async()=>{
  for(const changed of ['base','source','empty','empty-zero','pr-base-before','pr-base-after','pr-base-sha']){
    let calls=0,published=0,reads=0;
    const repository={id:1,full_name:'test/product',default_branch:'main',private:true};
    const source={sourceCommentId:'review:1',sourceCommit:sha,sourceUrl:'https://github.com/test/product/pull/1',severity:'P1',bodyMarkdown:'Check input.',updatedAt:'2026-11-07T00:00:00Z'};
    vi.doMock('../../../scripts/quality-language-summary.mjs',()=>({
      qualityNativeIO:()=>({get:async(path)=>({value:path.endsWith('/pulls/1')?{number:1,state:'open',head:{sha},base:{repo:{id:1},ref:changed==='pr-base-before'||changed==='pr-base-after'&&calls>0?'other':'main',sha:changed==='pr-base-sha'? 'b'.repeat(40):sha}}:path.includes('/git/ref/')?{object:{sha:changed==='base'&&calls>0&&path.endsWith('/main')?'b'.repeat(40):sha}}:{...repository,archived:false,disabled:false}})}),
      openQualityStore:async()=>({snapshot:{head:sha},cache:()=>null,forPull:()=>({save:async()=>({commit:sha})})}),
    }));
    vi.doMock('../dist/index.js',async()=>{
      const real=await vi.importActual('../dist/index.js');
      return {...real,collectQualitySources:async()=>{reads++;if(changed.startsWith('empty'))return [];return [changed==='source'&&calls>0?{...source,bodyMarkdown:'Changed input.'}:source];},
        copilotQualityClient:()=>({preflight:async()=>({status:'READY'}),call:async segments=>{calls++;return {model:'fake',usage:null,items:segments.map(({bodyMarkdown,...item})=>({...item,problemZh:'检查输入。',impactZh:'原文未说明',suggestionZh:'原文未说明'}))};}}),
        publishQualityCheck:async()=>{published++;return {pending:0,complete:1};}};
    });
    const p={...plan,kind:'quality',maxRequests:changed==='empty-zero'?0:1,repository,pr:1,head:sha,sources:[{kind:'review',id:2,login:'quality'}],governanceAppId:2,configVersion:'v1',sourceSetDigest:digest(JSON.stringify([source]))};
    const app={forQualityRepository:async(_id,callback)=>callback('fake-token')};
    await assert.rejects(executePlan(p,{root:'.',controllerDirectory:process.cwd(),app,modelToken:''}),changed.startsWith('pr-base')?/HEAD_CHANGED/:changed.startsWith('empty')?/SOURCE_EMPTY/:changed==='base'?/BASE_CHANGED/:/SOURCE_CHANGED/);
    assert.equal(calls,changed.startsWith('empty')||changed==='pr-base-before'||changed==='pr-base-sha'?0:1);assert.equal(published,0);if(changed==='source')assert.equal(reads,2);
    vi.doUnmock('../../../scripts/quality-language-summary.mjs');vi.doUnmock('../dist/index.js');
  }
});

test('controlled zero-call stop persists pending input and resumes once without regenerating completed work',async()=>{
  let cache=null,calls=0,checkWrites=0;
  const repository={id:1,full_name:'test/product',default_branch:'main',private:true};
  const source={sourceCommentId:'review:1',sourceCommit:sha,sourceUrl:'https://github.com/test/product/pull/1',severity:'P1',bodyMarkdown:'Check input.',updatedAt:'2026-11-07T00:00:00Z'};
  vi.doMock('../../../scripts/quality-language-summary.mjs',()=>({
    qualityNativeIO:()=>({get:async(path)=>({value:path.endsWith('/pulls/1')?{number:1,state:'open',head:{sha},base:{repo:{id:1},ref:'main',sha}}:path.includes('/git/ref/')?{object:{sha}}:{...repository,archived:false,disabled:false}})}),
    openQualityStore:async()=>({snapshot:{head:sha},cache:()=>cache,forPull:()=>({save:async(value)=>{cache=JSON.parse(JSON.stringify(value));return {commit:sha};}})}),
  }));
  vi.doMock('../dist/index.js',async()=>{
    const real=await vi.importActual('../dist/index.js');
    return {...real,collectQualitySources:async()=>[source],
      copilotQualityClient:()=>({preflight:async()=>({status:'READY'}),call:async segments=>{calls++;return {model:'fake',usage:null,items:segments.map(({bodyMarkdown,...item})=>({...item,problemZh:'检查输入。',impactZh:'原文未说明',suggestionZh:'原文未说明'}))};}}),
      publishQualityCheck:async(_context,value)=>{checkWrites++;return real.renderQualitySummary(value);}};
  });
  const p={...plan,kind:'quality',maxRequests:0,expectControlledStop:true,repository,pr:1,head:sha,sources:[{kind:'review',id:2,login:'quality'}],governanceAppId:2,configVersion:'v1',sourceSetDigest:digest(JSON.stringify([source]))};
  const app={forQualityRepository:async(_id,callback)=>callback('fake-token')},options={root:'.',controllerDirectory:process.cwd(),app,modelToken:''};
  assert.deepEqual(await executePlan(p,options),{kind:'quality',status:'CONTROLLED_STOP',calls:0,pending:1});
  assert.equal(calls,0);assert.equal(Object.values(cache.entries)[0].attempts.length,0);
  assert.equal((await executePlan({...p,maxRequests:1,expectControlledStop:false},options)).status,'COMPLETE');assert.equal(calls,1);
  assert.equal((await executePlan({...p,maxRequests:0,expectControlledStop:false},options)).calls,0);assert.equal(calls,1);assert.equal(checkWrites,3);
  vi.doUnmock('../../../scripts/quality-language-summary.mjs');vi.doUnmock('../dist/index.js');
});

test('release local call limit preserves the first batch and stops before a second request intent',async()=>{
  const {planContentBatches,resumeContentBatches}=await vi.importActual('../dist/index.js');
  const input={schemaVersion:2,repositoryId:1,candidateId:digest('candidate'),baseSha:sha,controllerSha:sha,configDigest:digest('config'),sourceManifestDigest:digest('manifest'),
    units:['app','second'].map(id=>({id,path:id,version:'1.0.0',tag:id+'/v1.0.0'})),boundaries:['app','second'].map(unitId=>({unitId,kind:'full-tree',sha:null,reference:null})),batches:[]};
  const sources=input.units.map(({id})=>({id:digest(id),unitId:id,path:id+'/README.md',previousPath:null,status:'CURATED',oid:sha,mode:'100644',byteLength:6,encoding:'utf8',sha256:digest('示例'),start:0,end:6,text:'示例',stage:'CONTEXT'}));
  const work=await planContentBatches(input,sources),cache={};let calls=0,preflights=0,persisted;
  const client=boundedClient({preflight:async()=>{preflights++;return 'READY';},call:async text=>{calls++;const p=JSON.parse(text);return {model:'fake',usage:null,text:JSON.stringify({paragraphs:[{sourceIds:[p.sources[0].id],section:'changes',textZh:'增加使用说明。',qualification:'SOURCE_CONFIRMED'}]})};}},1);
  await assert.rejects(resumeContentBatches(work,cache,{...client,now:()=>new Date().toISOString(),editing:async()=>false,save:async(w,c)=>{persisted=JSON.parse(JSON.stringify({work:w,cache:c}));}}),/ACCEPTANCE_CALL_LIMIT/);
  assert.equal(calls,1);assert.equal(preflights,1);
  assert.equal(persisted.work.input.batches[0].status,'READY');assert.equal(persisted.work.input.batches[0].attempts[0].status,'RETURNED');
  assert.equal(persisted.work.input.batches[1].status,'PENDING');assert.deepEqual(persisted.work.input.batches[1].attempts,[]);
  assert.deepEqual(work.input.batches[1].attempts,[]);assert.equal(Object.values(persisted.cache).filter(e=>e.result).length,1);
});

test('manual content recovery is confined to one private sample and a single approved request',()=>{
  const grant=Object.fromEntries(['candidateId','batchId','previousAttemptSha256','authorizationId','outputContractSha256'].map(k=>[k,'a'.repeat(64)]));
  const recovery={...plan,repository:{id:1448797077,full_name:'splrad/steward-e10-lifecycle-20261107',private:true,default_branch:'main'},releaseRecovery:grant};
  const check=p=>{const raw=JSON.stringify(p);return validatePlan(raw,digest(raw),env);};
  assert.deepEqual(check(recovery).releaseRecovery,grant);
  for(const change of [{maxRequests:0},{repository:plan.repository},{repository:{...recovery.repository,private:false}},{releaseRecovery:{...grant,extra:true}},{releaseRecovery:{...grant,batchId:'invalid'}}])assert.throws(()=>check({...recovery,...change}),/RELEASE_RECOVERY_PLAN/);
});
