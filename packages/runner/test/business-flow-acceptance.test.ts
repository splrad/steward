// @ts-nocheck
import {it as test} from 'vitest';
import assert from 'node:assert/strict';
import {validatePlan,boundedClient,digest} from '../../../scripts/business-flow-acceptance.mjs';
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
