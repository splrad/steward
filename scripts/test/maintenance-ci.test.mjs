import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';
import {branch,workflow,eventIdentity,liveIdentity,verifyTree,verifyResults,digest} from '../maintenance-ci.mjs';

const B='b'.repeat(40), H='c'.repeat(40), M='d'.repeat(40), P='a'.repeat(40);
const R='e'.repeat(40), S='1'.repeat(40), T='f'.repeat(40);
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
    else if([M,R,S].some(ref=>path.endsWith(`/commits/${ref}`)))
      value={sha:path.split('/').at(-1),parents:[{sha:B},{sha:H}],commit:{tree:{sha:T}}};
    else if(path.endsWith(`/compare/${P}...main`))value={status:'ahead',merge_base_commit:{sha:P}};
    else throw Error('unexpected API path');
    mutator(path,value,reads);return value;
  };
}
test('fresh API proof rejects moved refs, unsigned head, wrong merge parents and unadopted policy',async()=>{
  assert.deepEqual(await liveIdentity(identity(),api()),{...identity(),liveMerge:M});
  const mutations=[
    (p,v,n)=>{if(p.endsWith('/pulls/400')&&n===2)v.head.sha=B;},
    (p,v)=>{if(p.includes('/git/ref/'))v.object.sha=P;},
    (p,v)=>{if(p.endsWith(`/commits/${H}`))v.commit.verification.verified=false;},
    (p,v)=>{if(v.parents)v.parents.reverse();},
    (p,v)=>{if(v.status)v.status='diverged';},
  ];
  for(const mutation of mutations)await assert.rejects(liveIdentity(identity(),api(mutation)));
});

test('a stable equivalent synthetic merge retains the immutable event identity and records both SHAs',async()=>{
  const checked=[];
  const get=api((p,v,n)=>{
    if(p.endsWith('/git/ref/pull/400/merge'))v.object.sha=R;
    if(p.endsWith(`/commits/${R}`)||p.endsWith(`/commits/${S}`))checked.push(v.sha);
  });
  assert.deepEqual(await liveIdentity(identity(),get),{...identity(),liveMerge:R});
  assert.deepEqual(checked,[R]);
  await assert.rejects(liveIdentity(identity(),api((p,v,n)=>{
    if(p.endsWith('/git/ref/pull/400/merge'))v.object.sha=n===1?R:S;
  })),/merge ref moved during validation/);
});

test('rebuilt merge proof rejects changed trees, parents, missing objects and inconsistent API identity',async()=>{
  const changes=[v=>v.commit.tree.sha=B,v=>delete v.commit.tree,
    v=>v.parents.reverse(),v=>v.parents.push({sha:P}),v=>v.parents[0].sha=P,
    v=>v.parents[1].sha=P,v=>v.sha=M];
  for(const read of [1,2])for(const change of changes){
    const get=api((p,v,n)=>{
      if(p.endsWith('/git/ref/pull/400/merge')&&n===read)v.object.sha=R;
      if(p.endsWith(`/commits/${R}`))change(v);
    });
    await assert.rejects(liveIdentity(identity(),get),/merge rebuilt|merge ref moved/);
  }
  const get=api((p,v)=>{if(p.endsWith('/git/ref/pull/400/merge'))v.object.sha=R;});
  await assert.rejects(liveIdentity(identity(),p=>{
    if(p.endsWith(`/commits/${R}`))throw Error('API 404');
    return get(p);
  }),/API 404/);
  await assert.rejects(liveIdentity(identity(),api((p,v)=>{
    if(p.endsWith(`/commits/${M}`))delete v.commit.tree;
  })),/merge tree/);
});

test('equivalent merge proof never permits moved base/head refs or an unsigned head',async()=>{
  for(const read of [1,2])for(const changed of ['base','head','pull']){
    await assert.rejects(liveIdentity(identity(),api((p,v,n)=>{
      if(p.endsWith('/git/ref/pull/400/merge'))v.object.sha=R;
      if(n!==read)return;
      if(changed==='base'&&p.endsWith(`/git/ref/heads/${branch}`))v.object.sha=P;
      if(changed==='head'&&p.includes('/git/ref/heads/')&&!p.endsWith(branch))v.object.sha=P;
      if(changed==='pull'&&p.endsWith('/pulls/400'))v.head.sha=P;
    })),/moved/);
  }
  await assert.rejects(liveIdentity(identity(),api((p,v)=>{
    if(p.endsWith('/git/ref/pull/400/merge'))v.object.sha=R;
    if(p.endsWith(`/commits/${H}`))v.commit.verification.verified=false;
  })),/unsigned head/);
});

test('PR321 reopen regression accepts the recorded same-parent same-tree synthetic rebuild',async()=>{
  const input={repositoryId:1296724484,pullNumber:321,
    base:'21be466b5689a0b8df76249eb1c9249359a6d57a',head:'8b2211bcf8711e8e0a2c8e8404eed78fe03ae03e',
    headRef:'codex/maintenance-entry-20261111',merge:'c4f582991c5bcb2aebda9f84a54a0816f9851cc0',
    policy:'e3417d9e8b77824c854e00edbcebd486adc8cc20'};
  const current='6c91a0ef3977d068b01fd7a1869ff57161cecb89', tree='a9737fb41e8ed046f1eccf684d7d3411ca095e05';
  const root='/repos/splrad/steward';
  const rows=new Map([
    [`${root}/pulls/321`,{number:321,state:'open',base:{sha:input.base,ref:branch,repo:{id:1296724484}},
      head:{sha:input.head,ref:input.headRef,repo:{id:1296724484}}}],
    [`${root}/git/ref/heads/${branch}`,{object:{sha:input.base}}],
    [`${root}/git/ref/heads/${input.headRef}`,{object:{sha:input.head}}],
    [`${root}/git/ref/pull/321/merge`,{object:{sha:current}}],
    [`${root}/commits/${input.head}`,{sha:input.head,commit:{verification:{verified:true,reason:'valid'}}}],
    [`${root}/compare/${input.policy}...main`,{status:'identical',merge_base_commit:{sha:input.policy}}],
  ]);
  for(const value of [input.merge,current])rows.set(`${root}/commits/${value}`,
    {sha:value,parents:[{sha:input.base},{sha:input.head}],commit:{tree:{sha:tree}}});
  const get=async path=>{assert.ok(rows.has(path));return structuredClone(rows.get(path));};
  assert.deepEqual(await liveIdentity(input,get),{...input,liveMerge:current});
  rows.get(`${root}/commits/${current}`).commit.tree.sha=B;
  await assert.rejects(liveIdentity(input,get),/merge rebuilt/);
});

test('merge identity permits same-PR workflow, test and tool updates while preserving historical recovery bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'maintenance-ci-'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=',...args],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  try {
    git('init','--initial-branch=base');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await mkdir(join(root,'.github/workflows'),{recursive:true});
    await writeFile(join(root,'.github/workflows/old.yml'),'name: Old\non: pull_request\njobs: {test: {runs-on: ubuntu-latest, steps: [{run: echo safe}]}}\n');
    await writeFile(join(root,'history.txt'),'historical\n');
    await writeFile(join(root,'.node-version'),'1.2.3\n');
    await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:'1.2.3'},packageManager:'npm@4.5.6',devDependencies:{npm:'4.5.6'}}));
    git('add','.');git('commit','--no-gpg-sign','-m','base');const base=git('rev-parse','HEAD');
    git('checkout','-b','update');git('mv','.github/workflows/old.yml','.github/workflows/renamed.yml');
    await writeFile(join(root,'.node-version'),'2.3.4\n');
    await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:'2.3.4'},packageManager:'npm@5.6.7',devDependencies:{npm:'5.6.7'},scripts:{test:'vitest run'}}));
    await writeFile(join(root,'.github/workflows/new.yml'),'name: New\non: push\njobs: {test: {runs-on: ubuntu-latest, steps: [{run: echo new}]}}\n');
    git('add','.');git('commit','--no-gpg-sign','-m','ordinary update');const head=git('rev-parse','HEAD');
    git('checkout','base');git('merge','--no-ff','--no-gpg-sign','-m','merge','update');const merge=git('rev-parse','HEAD');
    const policy={immutable:{'history.txt':digest('historical\n')}};
    const source={base,head,merge};verifyTree(root,source,policy);
    const rebuilt=git('commit-tree','HEAD^{tree}','-p',base,'-p',head,'-m','rebuilt synthetic merge');
    git('checkout','--detach',rebuilt);
    assert.throws(()=>verifyTree(root,source,policy),/checkout/);
    git('checkout','--detach',merge);
    assert.throws(()=>verifyTree(root,{...source,head:base},policy),/merge parents/);
    assert.throws(()=>verifyTree(root,source,{immutable:{'history.txt':digest('modified')}}),/historical contract/);
    await writeFile(join(root,'history.txt'),'dirty workspace');verifyTree(root,source,policy);
    git('restore','history.txt');git('checkout','update');
    await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:'9.9.9'},packageManager:'npm@5.6.7',devDependencies:{npm:'5.6.7'}}));
    git('add','.');git('commit','--no-gpg-sign','-m','inconsistent declaration');const bad=git('rev-parse','HEAD');
    git('checkout','--detach',base);git('merge','--no-ff','--no-gpg-sign','-m','bad declaration',bad);
    assert.throws(()=>verifyTree(root,{base,head:bad,merge:git('rev-parse','HEAD')},policy),/toolchain contract/);
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

test('version sources remain API helper, locked central mise and same-PR maintenance manifest',async()=>{
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
