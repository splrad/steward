import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import YAML from 'yaml';
import {entryGuard} from '../bounded-release-entry.mjs';

const head='a'.repeat(40),id=1296724484,root='/repos/splrad/steward';
function fixture(mode='normal') {
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:String(id),GITHUB_REF:'refs/heads/main',
    STEWARD_CONTROLLER_SHA:head,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'2',BOUNDED_MODE:mode};
  const file={normal:'release-candidate-event.yml',
    cycle:'release-cycle-event.yml',pages:'pages-maintenance-event.yml'}[mode];
  const run={id:42,workflow_id:77,run_attempt:2,repository:{id},head_repository:{id},head_sha:head,head_branch:'main',
    path:`.github/workflows/${file}`,event:'workflow_dispatch'};
  const data={ [root]:{id,default_branch:'main'},[`${root}/git/ref/heads/main`]:{object:{sha:head}},
    [`${root}/actions/runs/42/attempts/2`]:run,[`${root}/actions/workflows/${file}`]:{id:77,path:run.path,state:'active'}};
  const get=async path=>{assert.ok(path in data,path);return data[path];};
  return {env,run,data,get};
}
for(const mode of ['normal','cycle','pages'])test(`accepts exact native ${mode} entry`,async()=>{
  const f=fixture(mode);assert.equal(await entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),f.run);
});
for(const mode of ['normal','cycle','pages'])test(`disabled or unbound ${mode} stops before native reads`,async()=>{
  const f=fixture(mode),neverRead=()=>assert.fail('native read');
  await assert.rejects(entryGuard(f.env,neverRead,{enabled:false}),/NOT_CONNECTED/);
  for(const deploymentSha of [null,undefined,'bad'])
    await assert.rejects(entryGuard(f.env,neverRead,{enabled:true,deploymentSha}),/NOT_CONNECTED/);
});
for(const mode of ['normal','cycle','pages'])for(const drift of ['main','run'])test(`${mode} rejects ${drift} SHA differing from workflow controller`,async()=>{
  const f=fixture(mode);
  if(drift==='main')f.data[`${root}/git/ref/heads/main`].object.sha='b'.repeat(40);
  else f.run.head_sha='b'.repeat(40);
  await assert.rejects(entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),/BOUNDED_RUN_SOURCE/);
});
for(const drift of ['source','attempt','fork','path','event','new-disabled','workflow-id'])test(`rejects ${drift} drift`,async()=>{
  const f=fixture();
  if(drift==='source')f.data[`${root}/git/ref/heads/main`].object.sha='b'.repeat(40);
  if(drift==='attempt')f.run.run_attempt=1;
  if(drift==='fork')f.run.head_repository.id=1;
  if(drift==='path')f.run.path='.github/workflows/release.yml';
  if(drift==='event')f.run.event='pull_request';
  if(drift==='new-disabled')f.data[`${root}/actions/workflows/release-candidate-event.yml`].state='disabled_manually';
  if(drift==='workflow-id')f.run.workflow_id=78;
  await assert.rejects(entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),/BOUNDED_/);
});
test('the official candidate workflow requires a policy SHA and has no schedule',async()=>{
  const value=YAML.parse(await readFile(new URL('../../.github/workflows/release-candidate-event.yml',import.meta.url),'utf8'));
  assert.equal(value.on.schedule,undefined);
  assert.ok(value.on.workflow_dispatch.inputs.policy_sha.required);
});
test('official candidate rejects stale policy/workflow before any job step',async()=>{
  const value=YAML.parse(await readFile(new URL('../../.github/workflows/release-candidate-event.yml',import.meta.url),'utf8'));
  const jobs=Object.values(value.jobs);assert.equal(jobs.length,1);const job=jobs[0];
  assert.ok(job.if.includes('inputs.policy_sha == github.sha'));assert.ok(job.if.includes('github.workflow_sha == github.sha'));
  const evaluate=context=>job.if.split(' && ').every(term=>{const [left,right]=term.split(' == ');return context[left]=== (right.startsWith("'")?right.slice(1,-1):context[right]);});
  const context={'github.actor_id':'301115370','github.repository_id':'1296724484','github.ref':'refs/heads/main',
    'github.event_name':'workflow_dispatch','inputs.policy_sha':head,'github.sha':head,'github.workflow_sha':head};
  assert.equal(evaluate(context),true);
  for(const field of ['inputs.policy_sha','github.sha','github.workflow_sha'])assert.equal(evaluate({...context,[field]:'b'.repeat(40)}),false);
  assert.equal(evaluate({...context,'github.actor_id':'42'}),false);
  assert.equal(job.steps[0].with.ref,'${{ github.workflow_sha }}');
});
for(const mode of ['normal','cycle','pages'])test(`${mode} rejects main movement during native admission`,async()=>{
  const f=fixture(mode);
  let mainReads=0;
  const get=async path=>{
    if(path.endsWith('/git/ref/heads/main')&&++mainReads===2)return {object:{sha:'b'.repeat(40)}};
    return f.get(path);
  };
  await assert.rejects(entryGuard(f.env,get,{enabled:true,deploymentSha:head}),/BOUNDED_RUN_SOURCE/);
  assert.equal(mainReads,2);
});
test('the current workflow tree has no legacy all-repository writer',async()=>{
  const files=await readdir(new URL('../../.github/workflows/',import.meta.url));
  assert.ok(!files.some(file=>/^release\.ya?ml$/i.test(file)));
  for(const file of files.filter(file=>/\.ya?ml$/i.test(file))) {
    const yaml=await readFile(new URL(`../../.github/workflows/${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(yaml,/STEWARD_EXPECTED_PAUSED_RELEASE|node scripts\/release-coordinator\.mjs/);
  }
});
