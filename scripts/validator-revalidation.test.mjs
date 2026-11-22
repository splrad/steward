import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {discoverPulls,epoch,reconcileValidators,validatorJournal} from './validator-revalidation.mjs';
import {compareValidatorSources} from './validator-source.mjs';
import {validationController} from './validation-input.mjs';
import {validatorPath} from './required-workflow-binding.mjs';
import {nativeReleaseApp} from '../packages/runner/dist/index.js';

const previous='a'.repeat(40),validator='b'.repeat(40),head='c'.repeat(40),bot=301115370;
const repo={id:44,full_name:'splrad/private-product',default_branch:'main'};
const path='/repos/'+repo.full_name;
const binding=(sha=validator)=>({ruleset_id:18883080,ruleset_source:'splrad',ruleset_source_type:'Organization',
  type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:validatorPath,sha}]}});
const clone=structuredClone;

test('the shipped App bundle mints and revokes only the target repository revalidation credential',async()=>{
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const scopes=[],requests=[];
  const app=await nativeReleaseApp(key,async(input,init)=>{
    const path=new URL(input).pathname;
    requests.push(init.method+' '+path);
    if(path==='/app')return Response.json({id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'});
    if(path==='/orgs/splrad/installation')return Response.json({id:123,app_id:4243096,account:{id:302208797}});
    if(path==='/users/splrad-steward%5Bbot%5D'||path==='/users/splrad-steward[bot]')return Response.json({id:bot,type:'Bot'});
    if(path.endsWith('/access_tokens')){
      const scope=JSON.parse(init.body);scopes.push(scope);
      return Response.json({token:'fixture-validator',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:scope.permissions},{status:201});
    }
    if(path==='/installation/repositories')return Response.json({total_count:1,repositories:[repo]});
    if(path==='/installation/token')return new Response(null,{status:204});
    assert.fail(path);
  });
  assert.equal(await app.forRepository(repo.id,async token=>token,'validator-revalidation'),'fixture-validator');
  assert.deepEqual(scopes,[{repository_ids:[repo.id],permissions:{metadata:'read',pull_requests:'write',actions:'read'}}]);
  assert.equal(requests.at(-1),'DELETE /installation/token');
});

function fixture() {
  const state=epoch(previous,validator),changes=[],records=[],events=[],runs=[],files={},jobs=[];
  const pr={id:320,node_id:'PR_fixture',number:32,state:'open',draft:false,merged:false,title:'Existing policy PR',
    base:{ref:'main',repo},head:{ref:'author/policy-change',repo,sha:head},body:'User content'};
  const actor={id:bot};
  let value=null,mergeQueueReads=0,runtime={mergeQueue:false,crashAfterClose:false,crashAfterReopen:false};
  const io={async request(method,url,body){
    const u=new URL(url,'https://api.github.com'),route=u.pathname;
    if(route.includes('/actions/variables')) {
      assert.ok(route.startsWith('/repos/splrad/steward-settings/'));
      if(method!=='GET'){value=body.value;return {status:method==='POST'?201:204};}
      return value===null?{status:404}:{status:200,value:{name:'STEWARD_VALIDATOR_REVALIDATION',value}};
    }
    if(method==='PATCH'){
      assert.equal(route,path+'/pulls/32');
      assert.deepEqual(Object.keys(body),['state']);
      assert.notEqual(pr.state,body.state);
      if(body.state==='closed'&&runtime.loseClose)throw Error('close response not observed');
      changes.push(body.state);pr.state=body.state;
      events.push({id:events.length+1,event:pr.state==='closed'?'closed':'reopened',actor});
      return {status:200,value:clone(pr)};
    }
    assert.equal(method,'GET');
    if(route===path+'/pulls/32') {
      if(runtime.crashAfterClose&&pr.state==='closed'||runtime.crashAfterReopen&&changes.at(-1)==='open')throw Error('process interrupted');
      return {status:200,value:clone(pr)};
    }
    if(route===path+'/rules/branches/main')return {status:200,value:[{ruleset_id:18883080,type:'pull_request',
      ruleset_source:'splrad',ruleset_source_type:'Organization'},binding(),{ruleset_id:10,type:'deletion'}]};
    if(route===path+'/pulls')return {status:200,value:pr.state==='open'?[clone(pr)]:[]};
    if(route===path+'/issues/32/events')return {status:200,value:clone(events)};
    if(route===path+'/actions/runs')return {status:200,value:{total_count:runs.length,workflow_runs:clone(runs)}};
    if(route.includes('/attempts/')&&route.endsWith('/jobs')){
      const runId=Number(route.split('/').at(-4));
      const selected=jobs.filter(job=>job.run_id===runId);
      return {status:200,value:{total_count:selected.length,jobs:clone(selected)}};
    }
    if(route.startsWith(path+'/actions/runs/'))return {status:200,value:clone(runs.find(run=>route.endsWith(String(run.id))))};
    throw Error('Unexpected fixture path '+route);
  },async graphql(query,{id}){
    if(query.includes('WorkflowRun'))return {node:{file:files[id]}};
    const isInMergeQueue=runtime.mergeQueue||++mergeQueueReads>=(runtime.queueOnRead??Infinity);
    return {node:{id,number:pr.number,headRefOid:pr.head.sha,isInMergeQueue}};
  }};
  const journal=validatorJournal(io),app={discover:async()=>[repo]},ioFor=async(id,op)=>{
    assert.equal(id,repo.id);return op(io);
  };
  const run=async({draining=false}={})=>{
    const restored=await journal.load();
    await reconcileValidators(restored??state,app,ioFor,journal,async()=>{},async row=>records.push(row),{draining,now:()=>runtime.now??Date.now()});
    return journal.load();
  };
  const addRun=(id,source,status,conclusion,title,attempt=1)=>{
    const run={id,node_id:'WFR_'+id,path:validatorPath,event:'pull_request',repository:repo,head_repository:repo,
      head_sha:pr.head.sha,head_branch:pr.head.ref,pull_requests:[],status,conclusion,run_attempt:attempt,
      display_title:title??`Native validation PR 32 / ${pr.head.sha} / main`};
    if(conclusion==='success')jobs.push({id:id*10,run_id:id,run_attempt:attempt,head_sha:pr.head.sha,name:'SPLRAD Validation',status,conclusion});
    runs.push(run);files[run.node_id]={path:validatorPath,repositoryFileUrl:`https://github.com/splrad/steward/blob/${source}/${validatorPath}`};
    return run;
  };
  return {state,pr,changes,records,events,runtime,run,addRun,io,app,ioFor,journal,jobs};
}

test('an actual rule shape with no per-rule ID limits discovery and private records stay in the private journal', async()=>{
  const f=fixture();
  await discoverPulls(f.app,f.ioFor,f.state);
  assert.equal(f.state.pulls[0].head,head);
  assert.equal(f.state.pulls[0].status,'queued');
  f.addRun(5,previous,'completed','success');
  f.addRun(6,validator,'completed','success',`Native validation PR 31 / ${head} / main`);
  let result=await f.run();
  assert.equal(result.pulls[0].status,'reopened');
  assert.deepEqual(f.changes,['closed','open']);
  await f.run();
  assert.deepEqual(f.changes,['closed','open']);
  const active=f.addRun(7,validator,'in_progress',null);
  result=await f.run();
  assert.equal(result.pulls[0].status,'in_progress');
  active.status='completed';active.conclusion='success';active.run_attempt=2;
  f.jobs.push({id:71,run_id:7,run_attempt:1,head_sha:head,name:'SPLRAD Validation',status:'completed',conclusion:'success'});
  assert.equal((await f.run()).pulls[0].status,'in_progress');
  Object.assign(f.jobs.at(-1),{id:72,run_attempt:2});
  result=await f.run();
  assert.deepEqual(result.pulls[0].run,{id:7,attempt:2,source:validator,head,status:'completed',conclusion:'success',job:72});
  assert.deepEqual(f.changes,['closed','open']);
  assert.equal(f.pr.body,'User content');
  assert.doesNotMatch(JSON.stringify(f.records),/private-product|author\/policy-change|PR_fixture|"head"|"job"/);
});

test('recovers an App close exactly once after loss of the close or reopen readback',async()=>{
  const f=fixture();
  f.runtime.crashAfterClose=true;
  await assert.rejects(f.run(),/PULLS_PENDING/);
  assert.equal((await f.journal.load()).pulls[0].status,'prepared');
  assert.deepEqual(f.changes,['closed']);
  f.runtime.crashAfterClose=false;f.runtime.crashAfterReopen=true;
  await assert.rejects(f.run(),/PULLS_PENDING/);
  f.runtime.crashAfterReopen=false;
  assert.equal((await f.run()).pulls[0].status,'reopened');
  assert.deepEqual(f.changes,['closed','open']);
});

test('a later human close never authorizes an App reopen',async()=>{
  const f=fixture();f.runtime.crashAfterClose=true;
  await assert.rejects(f.run(),/PULLS_PENDING/);
  f.runtime.crashAfterClose=false;
  f.events.push({id:2,event:'reopened',actor:{id:102}},{id:3,event:'closed',actor:{id:102}});
  assert.equal((await f.run()).pulls[0].status,'manual');
  assert.deepEqual(f.changes,['closed']);
  assert.equal(f.pr.state,'closed');
});

test('retains an unconfirmed close during rotation and restores it after its native event appears',async()=>{
  const f=fixture();f.runtime.loseClose=true;
  let state=await f.run();
  assert.equal(f.pr.state,'open');
  assert.equal(state.pulls[0].closeRequest,'unknown');
  state=await f.run({draining:true});
  assert.equal(state.pulls[0].status,'prepared');
  assert.deepEqual(f.changes,[]);
  f.pr.state='closed';f.events.push({id:1,event:'closed',actor:{id:bot}});
  state=await f.run({draining:true});
  assert.equal(state.pulls[0].status,'reopened');
  assert.deepEqual(f.changes,['open']);
});

test('an advancing head retains its predecessor evidence and reconciles the native Run for the new head',async()=>{
  const f=fixture();
  f.addRun(10,validator,'in_progress',null);
  assert.equal((await f.run()).pulls[0].run.id,10);
  const newer='d'.repeat(40);
  f.pr.head.sha=newer;
  let state=await f.run();
  assert.deepEqual(state.pulls.map(entry=>[entry.head,entry.status]),[[head,'superseded'],[newer,'waiting']]);
  assert.equal(state.pulls[0].run.id,10);
  await f.run();
  assert.deepEqual(f.changes,[]);
  f.addRun(11,validator,'completed','success');
  state=await f.run();
  assert.equal(state.pulls[1].status,'success');
  assert.equal(state.pulls[1].run.head,newer);
  assert.equal(state.pulls[1].run.job,110);
  assert.deepEqual(f.changes,[]);
});

test('a head change while the App close is outstanding restores the PR and tracks the new validation',async()=>{
  const f=fixture();f.runtime.crashAfterClose=true;
  await assert.rejects(f.run(),/PULLS_PENDING/);
  const newer='d'.repeat(40);
  f.pr.head.sha=newer;f.runtime.crashAfterClose=false;
  const state=await f.run();
  assert.deepEqual(state.pulls.map(entry=>[entry.head,entry.status]),[[head,'superseded'],[newer,'waiting']]);
  assert.deepEqual(f.changes,['closed','open']);
});

test('never cycles a PR with an exact pending or failed Run, a draft, merge management, or a release candidate',async()=>{
  for(const type of ['failed','running','draft','queue','autoMerge','release','legacyRelease']){
    const f=fixture();
    if(type==='failed')f.addRun(99,validator,'completed','failure');
    if(type==='running')f.addRun(99,validator,'queued',null);
    if(type==='draft')f.pr.draft=true;
    if(type==='queue')f.runtime.mergeQueue=true;
    if(type==='autoMerge')f.pr.auto_merge={enabled_at:'record'};
    if(type==='release')f.pr.head.ref='steward/release-candidate';
    if(type==='legacyRelease')f.pr.labels=[{name:'autorelease: pending'}];
    const expected=type==='failed'?'failure':type==='running'?'in_progress':'waiting';
    assert.equal((await f.run()).pulls[0].status,expected);
    assert.equal((await f.run()).pulls[0].status,expected);
    assert.deepEqual(f.changes,[]);
  }
});

test('keeps the PR open when merge management appears immediately before the close',async()=>{
  const f=fixture();f.runtime.queueOnRead=3;
  const state=await f.run();
  assert.equal(state.pulls[0].status,'waiting');
  assert.equal(state.pulls[0].reason,'merge-management');
  assert.deepEqual(f.changes,[]);
});

test('validator compares the exact local execution graph in both trees and accepts a newer protected data source',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'steward-validator-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=','-c','core.autocrlf=false',...args],{cwd:directory,windowsHide:true,encoding:'utf8'}).trim();
  const file=async(path,bytes)=>{const target=join(directory,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);};
  const commit=()=>{git('add','-A');git('commit','-qm','fixture');return git('rev-parse','HEAD');};
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('config','commit.gpgsign','false');
  await file(validatorPath,'name: Native\njobs:\n  test:\n    steps:\n      - run: node policy/scripts/a.mjs\n      - run: node target/scripts/irrelevant.mjs\n');
  await file('scripts/a.mjs',"import './b.mjs';\nimport './security-policy.mjs';\nexport const text='scripts/irrelevant.mjs';\n");
  await file('scripts/b.mjs',"new URL('../config/policy.json', import.meta.url);\n");
  await file('scripts/security-policy.mjs','export const taggedPolicy=true;\n');
  await file('config/review/security-common.md','original\n');
  await file('copier.yml','_subdirectory: templates\n');
  await file('config/policy.json','{}\n');
  await file('scripts/irrelevant.mjs','0\n');
  await file('.npmrc','engine-strict=true\n');
  const first=commit();
  await file('scripts/irrelevant.mjs','1\n');
  const unrelated=commit();
  assert.equal((await compareValidatorSources(directory,first,unrelated)).changed,false);
  await file('scripts/b.mjs',"new URL('../config/policy.json', import.meta.url);\nexport const changed=1;\n");
  const script=commit();
  assert.deepEqual((await compareValidatorSources(directory,first,script)).files,['scripts/b.mjs']);
  await file('scripts/c.mjs','export const future=1;\n');
  await file('scripts/b.mjs',"import './c.mjs';\n");
  await rm(join(directory,'config/policy.json'));
  const graph=commit();
  assert.deepEqual((await compareValidatorSources(directory,script,graph)).files,['config/policy.json','scripts/b.mjs','scripts/c.mjs']);
  await file('.npmrc','engine-strict=false\n');
  const npmPolicy=commit();
  assert.deepEqual((await compareValidatorSources(directory,graph,npmPolicy)).files,['.npmrc']);
  await file('config/review/security-common.md','updated\n');
  assert.deepEqual((await compareValidatorSources(directory,npmPolicy,commit())).files,['config/review/security-common.md']);
  git('update-ref','refs/remotes/origin/steward/validated-controller',graph);
  git('checkout','--detach','-q',script);
  assert.equal(validationController(directory,script),graph);
  git('checkout','--detach','-q',graph);
  await file(validatorPath,'name: Native\njobs:\n  test:\n    steps:\n      - uses: ./policy/.github/actions/check\n');
  await file('.github/actions/check/action.yml','runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bash "${{ github.action_path }}/inspect.sh"\n');
  await file('.github/actions/check/inspect.sh','true\n');
  const action=commit();
  await file('.github/actions/check/inspect.sh','false\n');
  const actionUpdate=commit();
  assert.deepEqual((await compareValidatorSources(directory,action,actionUpdate)).files,['.github/actions/check/inspect.sh']);
  await file(validatorPath,'name: Native\njobs:\n  test:\n    steps:\n      - working-directory: policy\n        run: npm run verify-local\n');
  const indirect=commit();
  await assert.rejects(compareValidatorSources(directory,actionUpdate,indirect),/INDIRECT_PACKAGE_COMMAND/);
  git('checkout','--detach','-q',graph);
  await file('scripts/c.mjs',"await import(process.env.LOCAL_MODULE);\n");
  const unresolved=commit();
  await assert.rejects(compareValidatorSources(directory,graph,unresolved),/DYNAMIC_MODULE/);
});
