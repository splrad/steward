import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';
import {branch,workflow,eventIdentity,liveIdentity,workflowDigest,verifyTree,verifyResults,digest} from '../maintenance-ci.mjs';

const B='b'.repeat(40), H='c'.repeat(40), M='d'.repeat(40), P='a'.repeat(40);
const pull=()=>({number:400,state:'open',base:{sha:B,ref:branch,repo:{id:1296724484}},
  head:{sha:H,ref:'dependabot/npm_and_yarn/example',repo:{id:1296724484,full_name:'splrad/steward'}}});
const event=()=>({number:400,repository:{id:1296724484,full_name:'splrad/steward'},pull_request:pull()});
const env={GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',
  GITHUB_REF:'refs/pull/400/merge',GITHUB_SHA:M,WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:workflow,WORKFLOW_SHA:P};
const identity=()=>eventIdentity(event(),env);

test('ordinary same-repository signed-update identity is not tied to PR307 or its author',()=>{
  assert.equal(identity().pullNumber,400);
  for(const patch of [{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_REPOSITORY_ID:'1'},
    {WORKFLOW_REPOSITORY:'fork/steward'},{WORKFLOW_PATH:'.github/workflows/fake.yml'},
    {WORKFLOW_SHA:'main'},{GITHUB_REF:'refs/heads/main'}]) assert.throws(()=>eventIdentity(event(),{...env,...patch}));
  for(const change of [p=>p.head.repo.id=1,p=>p.base.ref='main',p=>p.head.sha='main',p=>p.state='closed',p=>p.head.ref='x#fragment']){
    const value=event();change(value.pull_request);assert.throws(()=>eventIdentity(value,env));
  }
});

test('final job fails closed for skipped, cancelled, failed or missing native jobs',()=>{
  const needs=Object.fromEntries(['source','test','dependency'].map(name=>[name,{result:'success'}]));
  verifyResults(needs);
  for(const name of Object.keys(needs)) for(const result of ['skipped','cancelled','failure',undefined]){
    const changed=structuredClone(needs);changed[name].result=result;
    assert.throws(()=>verifyResults(changed));
  }
  assert.throws(()=>verifyResults({}));
});

function api(mutator=()=>{}) {
  let reads=0;
  return async path=>{
    let value;
    if(path.endsWith('/pulls/400')){reads++;value=pull();}
    else if(path.endsWith(`/git/ref/heads/${branch}`))value={object:{sha:B}};
    else if(path.includes('/git/ref/heads/'))value={object:{sha:H}};
    else if(path.endsWith('/git/ref/pull/400/merge'))value={object:{sha:M}};
    else if(path.endsWith(`/commits/${H}`))value={sha:H,commit:{verification:{verified:true,reason:'valid'}}};
    else if(path.endsWith(`/commits/${M}`))value={sha:M,parents:[{sha:B},{sha:H}]};
    else if(path.endsWith(`/compare/${P}...main`))value={status:'ahead',merge_base_commit:{sha:P}};
    else throw Error('unexpected API path');
    mutator(path,value,reads);return value;
  };
}
test('fresh API proof rejects moved refs, unsigned head, wrong merge parents and unadopted policy',async()=>{
  assert.deepEqual(await liveIdentity(identity(),api()),identity());
  const mutations=[
    (p,v,n)=>{if(p.endsWith('/pulls/400')&&n===2)v.head.sha=B;},
    (p,v)=>{if(p.includes('/git/ref/'))v.object.sha=P;},
    (p,v)=>{if(v.commit)v.commit.verification.verified=false;},
    (p,v)=>{if(v.parents)v.parents.reverse();},
    (p,v)=>{if(v.status)v.status='diverged';},
  ];
  for(const mutation of mutations)await assert.rejects(liveIdentity(identity(),api(mutation)));
});

test('workflow semantics permit only pinned action commit changes, not permission/command expansion',()=>{
  const text='on: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@'+P+'\n      - run: npm test\n';
  assert.equal(workflowDigest(text),workflowDigest(text.replace(P,H)));
  assert.notEqual(workflowDigest(text),workflowDigest(text.replace('actions/checkout','unknown/action')));
  assert.throws(()=>workflowDigest(text.replace(P,H),['actions/checkout@'+P]),/unapproved action/);
  assert.equal(workflowDigest(text,['actions/checkout@'+P]),workflowDigest(text));
  assert.notEqual(workflowDigest(text),workflowDigest(text.replace('contents: read','contents: write')));
  assert.notEqual(workflowDigest(text),workflowDigest(text.replace('npm test','echo pass')));
  assert.throws(()=>workflowDigest(text.replace(P,'main')));
  assert.throws(()=>workflowDigest(text+'jobs: {}\n'));
});

test('real merge Git tree verifies both parents, inventory and immutable PR307 contract',async()=>{
  const root=await mkdtemp(join(tmpdir(),'maintenance-ci-'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=',...args],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  try {
    git('init','--initial-branch=base');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await mkdir(join(root,'.github/workflows'),{recursive:true});
    await mkdir(join(root,'scripts'));await writeFile(join(root,'scripts/check.mjs'),'console.log(1);');
    const w='name: Test\non: pull_request\njobs: {test: {steps: [{run: npm test}]}}\n';
    await writeFile(join(root,'.github/workflows/test.yml'),w);await writeFile(join(root,'history.txt'),'historical\n');
    await writeFile(join(root,'.node-version'),'1.2.3\n');
    await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:'1.2.3'},packageManager:'npm@4.5.6'}));
    git('add','.');git('commit','--no-gpg-sign','-m','base');const base=git('rev-parse','HEAD');
    git('checkout','-b','update');await writeFile(join(root,'README.md'),'candidate\n');git('add','.');git('commit','--no-gpg-sign','-m','update');const head=git('rev-parse','HEAD');
    git('checkout','base');git('merge','--no-ff','--no-gpg-sign','-m','merge','update');const merge=git('rev-parse','HEAD');
    const policy={toolchainSource:base,validationSource:base,workflows:{'.github/workflows/test.yml':[workflowDigest(w)]},immutable:{'history.txt':digest('historical\n')}};
    const source={base,head,merge};verifyTree(root,source,policy);
    assert.throws(()=>verifyTree(root,{...source,head:base},policy),/merge parents/);
    assert.throws(()=>verifyTree(root,source,{...policy,workflows:{}}),/inventory/);
    assert.throws(()=>verifyTree(root,source,{...policy,immutable:{'history.txt':digest('modified')}}),/historical contract/);
    assert.throws(()=>verifyTree(root,source,{...policy,toolchainSource:'main'}),/approved toolchain source/);
    assert.throws(()=>verifyTree(root,source,{...policy,validationSource:'main'}),/approved validation source/);
    // A candidate cannot turn the required checks into successful no-ops.
    for (const [file, content, reason] of [
      ['package.json',JSON.stringify({engines:{node:'1.2.3'},packageManager:'npm@4.5.6',scripts:{test:'echo pass'}}),/validation commands changed/],
      ['scripts/check.mjs','// bypass',/validation implementation changed/],
    ]) {
      git('checkout','--detach',head);await writeFile(join(root,file),content);git('add',file);
      git('commit','--no-gpg-sign','-m','tampered validation');const altered=git('rev-parse','HEAD');
      git('checkout','--detach',base);git('merge','--no-ff','--no-gpg-sign','-m','tampered merge',altered);
      assert.throws(()=>verifyTree(root,{base,head:altered,merge:git('rev-parse','HEAD')},policy),reason);
    }
    git('checkout','--detach',merge);
    // Dirty working files cannot substitute for Git tree evidence.
    await writeFile(join(root,'history.txt'),'untrusted workspace\n');verifyTree(root,source,policy);
    git('restore','history.txt');git('checkout','update');
    await writeFile(join(root,'.node-version'),'2.3.4\n');
    await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:'2.3.4'},packageManager:'npm@4.5.6'}));
    git('add','.');git('commit','--no-gpg-sign','-m','unapproved version');const changedHead=git('rev-parse','HEAD');
    git('checkout','--detach',base);git('merge','--no-ff','--no-gpg-sign','-m','candidate toolchain','update');
    assert.throws(()=>verifyTree(root,{base,head:changedHead,merge:git('rev-parse','HEAD')},policy),/toolchain upgrade requires central adoption/);

  } finally {await rm(root,{recursive:true,force:true});}
});

test('workflow isolates candidate execution and never requests production permissions or secrets',async()=>{
  const text=await readFile(new URL('../../.github/workflows/maintenance-validation.yml',import.meta.url),'utf8');
  const value=YAML.parse(text);
  assert.equal(value.concurrency,undefined, 'ruleset workflows must not cancel pending or running required checks');
  assert.deepEqual(value.permissions,{'contents':'read','pull-requests':'read'});
  assert.deepEqual(Object.keys(value.on),['pull_request']);
  assert.deepEqual(value.jobs.final.needs,['source','test','dependency']);
  assert.equal(value.jobs.final.if,'${{ always() }}');
  for(const job of Object.values(value.jobs)){
    assert.equal(job.environment,undefined);assert.equal(job.permissions,undefined);
    assert.equal(job['continue-on-error'],undefined);
  }
  assert.doesNotMatch(text,/secrets\.|id-token:|wrangler|d1 migrations|workflow_dispatch|pull_request_target/);
  assert.doesNotMatch(JSON.stringify(value.jobs.test),/MAINTENANCE_READ_TOKEN|GH_TOKEN|GITHUB_TOKEN|policy\/scripts/);
  for(const name of ['source','final']) assert.equal(value.jobs[name].steps[0].with.ref,'${{ job.workflow_sha }}');
});

test('version sources remain API helper, locked central mise and approved maintenance manifest',async()=>{
  const text=await readFile(new URL('../../.github/workflows/maintenance-validation.yml',import.meta.url),'utf8');
  const value=YAML.parse(text);
  for(const name of ['source','final']) {
    assert.equal(value.jobs[name].steps.find(s=>s.uses?.startsWith('jdx/mise-action@')).with.install_args,'--locked');
    assert.equal(value.jobs[name].steps.some(s=>s.uses?.startsWith('actions/setup-node@')),false);
  }
  assert.equal(value.jobs.test.steps.find(s=>s.uses?.startsWith('actions/setup-node@')).with['node-version-file'],'.node-version');
  const source=await readFile(new URL('../maintenance-ci.mjs',import.meta.url),'utf8');
  assert.match(source,/githubHeaders\(token\)/);
  assert.doesNotMatch(source,/X-GitHub-Api-Version|2022-11-28|24\.22\.0/);
});
