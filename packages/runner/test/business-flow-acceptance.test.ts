// @ts-nocheck
import {it as test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {validatePlan,boundedClient,digest,executePlan} from '../../../scripts/business-flow-acceptance.mjs';
const sha='a'.repeat(40),env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main',GITHUB_SHA:sha,WORKFLOW_SHA:sha};
const plan={schemaVersion:1,kind:'quality',controllerSha:sha,maxRequests:1,
  repository:{id:1,full_name:'test/product',private:true,default_branch:'main'},baseSha:sha,stateSha:sha,
  pr:1,head:sha,sources:[{kind:'review',id:2,login:'quality'}],sourceSetDigest:'a'.repeat(64),governanceAppId:2,configVersion:'v1'};
test('manual dispatch exposes only active consumers and selects their environments',()=>{
  const workflow=YAML.parse(readFileSync('.github/workflows/business-flow-acceptance.yml','utf8'));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.consumer.options,['quality','quality-initialize']);
  assert.equal(workflow.jobs.acceptance.environment.name,'steward-release-notes');
});
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

test('manual acceptance rejects the retired release consumer and private target',()=>{
  const check=p=>{const raw=JSON.stringify(p);return validatePlan(raw,digest(raw),env);};
  for (const kind of ['release','release-initialize']) assert.throws(()=>check({...plan,kind}),/ACCEPTANCE_MODE/);
  assert.throws(()=>check({...plan,releaseRecovery:{}}),/RELEASE_RECOVERY_RETIRED/);
  const retired={id:1448797077,full_name:'splrad/steward-e10-lifecycle-20261107',private:true,default_branch:'main'};
  assert.throws(()=>check({...plan,repository:retired}),/RETIRED_REPOSITORY/);
});
