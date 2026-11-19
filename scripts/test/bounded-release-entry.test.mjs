import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {createHash} from 'node:crypto';
import {candidateEvidence,validateCandidateEvent,sha256,product} from '../bounded-candidate-contract.mjs';
import {processNormalCandidateEvent} from '../release-candidate-event.mjs';
import {entryGuard,resultOutcome,applyCandidateEvent} from '../bounded-release-entry.mjs';
const head='a'.repeat(40),id=1296724484,root='/repos/splrad/steward';
function fixture(mode='observe') {
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:String(id),GITHUB_REF:'refs/heads/main',
    STEWARD_CONTROLLER_SHA:head,STEWARD_EXPECTED_PAUSED_RELEASE:'311600220',GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'2',BOUNDED_MODE:mode};
  const file=mode==='normal'?'release-candidate-event.yml':mode==='observe'?'release-observe.yml':'bounded-release-event.yml';
  const run={id:42,workflow_id:77,run_attempt:2,repository:{id},head_repository:{id},head_sha:head,head_branch:'main',
    path:`.github/workflows/${file}`,event:'workflow_dispatch'};
  const data={ [root]:{id,default_branch:'main'},[`${root}/git/ref/heads/main`]:{object:{sha:head}},
    [`${root}/actions/runs/42/attempts/2`]:run,[`${root}/actions/workflows/311600220`]:{id:311600220,path:'.github/workflows/release.yml',state:'disabled_manually'},[`${root}/actions/workflows/${file}`]:{id:77,path:run.path,state:'active'}};
  const get=async path=>{assert.ok(path in data,path);return data[path];};
  return {env,run,data,get};
}
for(const mode of ['observe','event','normal'])test(`accepts exact native ${mode} entry`,async()=>{
  const f=fixture(mode);assert.equal(await entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),f.run);
});
test('disabled adoption config stops before native reads',async()=>{
  const f=fixture();await assert.rejects(entryGuard(f.env,()=>assert.fail('native read'),{enabled:false}),/NOT_CONNECTED/);
});
for(const mode of ['observe','event','normal'])for(const drift of ['main','run'])test(`${mode} rejects ${drift} SHA differing from workflow controller`,async()=>{
  const f=fixture(mode);
  if(drift==='main')f.data[`${root}/git/ref/heads/main`].object.sha='b'.repeat(40);
  else f.run.head_sha='b'.repeat(40);
  await assert.rejects(entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),/BOUNDED_RUN_SOURCE/);
});
for(const drift of ['pause','source','attempt','fork','path','event','release','new-disabled','workflow-id'])test(`rejects ${drift} drift`,async()=>{
  const f=fixture();
  if(drift==='pause')f.env.STEWARD_EXPECTED_PAUSED_RELEASE='' ;
  if(drift==='source')f.data[`${root}/git/ref/heads/main`].object.sha='b'.repeat(40);
  if(drift==='attempt')f.run.run_attempt=1;
  if(drift==='fork')f.run.head_repository.id=1;
  if(drift==='path')f.run.path='.github/workflows/release.yml';
  if(drift==='event')f.run.event='pull_request';
  if(drift==='release')f.data[`${root}/actions/workflows/311600220`].state='active';
  if(drift==='new-disabled')f.data[`${root}/actions/workflows/release-observe.yml`].state='disabled_manually';
  if(drift==='workflow-id')f.run.workflow_id=78;
  await assert.rejects(entryGuard(f.env,f.get,{enabled:true,deploymentSha:head}),/BOUNDED_/);
});
test('unknown or generic READY result is not done',()=>{
  assert.equal(resultOutcome({status:'READY'}),'needs_attention');
  assert.equal(resultOutcome({status:'READY',reason:'CACHED_OBSERVATION'}),'needs_attention');
  assert.equal(resultOutcome({status:'READY',reason:'MANUAL_PROJECTION'}),'needs_attention');
  assert.equal(resultOutcome({status:'READY',reason:'CACHED_OBSERVATION',projectionEvidence:{commentId:1,bodyDigest:'a'.repeat(64),previewDigest:'b'.repeat(64)}}),'done');
  assert.equal(resultOutcome({reason:'SOURCE_CHANGED'}),'source_changed');
  assert.equal(resultOutcome({reason:'EDITING'}),'paused');
  assert.equal(resultOutcome({status:'CONFLICT',reason:'HUMAN_EDIT_CONFLICT'}),'needs_attention');
});
test('fixed observation workflows contain no schedule or default coordinator execution',async()=>{
  for(const name of ['release-observe','bounded-release-event','release-candidate-event']) {
    const value=YAML.parse(await readFile(new URL(`../../.github/workflows/${name}.yml`,import.meta.url),'utf8'));
    assert.equal(value.on.schedule,undefined);
    assert.ok(value.on.workflow_dispatch.inputs.policy_sha.required);
    for(const job of Object.values(value.jobs))for(const step of job.steps)assert.ok(!step.run?.includes('node scripts/release-coordinator.mjs'));
  }
});
for(const name of ['release-observe','bounded-release-event','release-candidate-event'])test(`${name} rejects stale policy/workflow before any job step`,async()=>{
  const value=YAML.parse(await readFile(new URL(`../../.github/workflows/${name}.yml`,import.meta.url),'utf8'));
  const jobs=Object.values(value.jobs);assert.equal(jobs.length,1);const job=jobs[0];
  assert.ok(job.if.includes('inputs.policy_sha == github.sha'));assert.ok(job.if.includes('github.workflow_sha == github.sha'));
  const evaluate=context=>job.if.split(' && ').every(term=>{const [left,right]=term.split(' == ');return context[left]=== (right.startsWith("'")?right.slice(1,-1):context[right]);});
  const context={'github.repository_id':'1296724484','github.ref':'refs/heads/main','vars.STEWARD_EXPECTED_PAUSED_RELEASE':'311600220',
    'github.event_name':'workflow_dispatch','inputs.policy_sha':head,'github.sha':head,'github.workflow_sha':head};
  assert.equal(evaluate(context),true);
  for(const field of ['inputs.policy_sha','github.sha','github.workflow_sha'])assert.equal(evaluate({...context,[field]:'b'.repeat(40)}),false);
  assert.equal(job.steps[0].with.ref,'${{ github.workflow_sha }}');
});
function candidateFixture(changeSession=()=>{}) {
  const digest='d'.repeat(64),commit='b'.repeat(40),prefix=`/repos/${product.name}`;
  const candidate={id:digest,prNumber:192,branch:'steward/release-candidate',baseSha:head,generatedSnapshotPath:`generated/${digest}/${digest}.json`,publishedHead:head,
    editingAckHead:null,statusCommentId:null,contentGenerationDigest:digest,adoptionOverride:null,observedLabelEventIds:[],pendingWrite:null};
  const state={schemaVersion:3,releaseAdoption:{sourceSha:head,prNumber:1},repositoryId:product.id,defaultBranch:'main',revision:1,
    lastObservedDefaultSha:head,lastCompletedCycleId:null,activeCycleId:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null,candidate};
  const contributors={contributors:[],unresolved:0};
  const session={generated:{schemaVersion:1,baseSha:head,files:[],units:[{id:'layerscape',path:'.',version:'1.0.0',tag:'v1.0.0'}],configDigest:digest,sourceDigest:digest},
    identity:{authorsDigest:digest,sourceDigest:digest,actors:[],contributors,units:[{id:'layerscape',actors:[],contributors}]},pending:null,conflict:null,preview:null,adoption:null};
  changeSession(session);
  const text=JSON.stringify(session),middle=Math.floor(text.length/2),path=`generated/${digest}/session.json`;
  const chunks=[text.slice(0,middle),text.slice(middle)].map((content,index)=>({schemaVersion:1,repositoryId:product.id,candidateId:digest,
    documentKind:'session',documentDigest:sha256(text),index,count:2,content}));
  const generatedText=JSON.stringify(session.generated),generatedChunk={schemaVersion:1,repositoryId:product.id,candidateId:digest,documentKind:'generated',documentDigest:sha256(generatedText),index:0,count:1,content:generatedText};
  const files={'state.json':state,[path]:chunks[0],[path.replace('.json','-1.json')]:chunks[1],[candidate.generatedSnapshotPath]:generatedChunk};
  const data={ [prefix]:{owner:{id:302208797},visibility:"public",private:false,id:product.id,full_name:product.name,default_branch:'main'},
    [`${prefix}/git/ref/heads/steward/release-state`]:{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:commit}},
    [`${prefix}/git/ref/heads/main`]:{object:{sha:head}},
    [`${prefix}/pulls/192`]:{number:192,state:'open',merged:false,labels:[],head:{sha:head,ref:candidate.branch,repo:{id:product.id}},base:{ref:'main',repo:{id:product.id}}},
    [`${prefix}/issues/events/7`]:{id:7,event:'unlabeled',created_at:'2026-11-16T12:00:00Z',label:{name:'release:editing'},issue:{number:192,repository_url:`https://api.github.com/repos/${product.name}`}}};
  let corrupt=false;
  const get=async url=>{
    if(url.startsWith(`${prefix}/contents/`)) {
      assert.ok(url.endsWith(`?ref=${commit}`),'immutable file read');
      const name=url.slice(`${prefix}/contents/`.length).split('?')[0];assert.ok(name in files);
      const bytes=Buffer.from(JSON.stringify(files[name]));
      return {type:'file',path:name,encoding:'base64',size:bytes.length,content:bytes.toString('base64'),
        sha:corrupt?head:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
    }
    assert.ok(url in data,url);return data[url];
  };
  return {get,data,state,chunks,files,generatedChunk,prefix,setCorrupt:()=>{corrupt=true;}};
}
test('candidate evidence permits unaffected units but rejects losing a frozen unit',async()=>{
  const target={...product,units:[{id:'layerscape',path:'.'},{id:'ui',path:'ui'}]};
  assert.equal((await candidateEvidence(candidateFixture().get,{product:target})).identity.version,'1.0.0');
  const missing=candidateFixture(s=>s.identity.units.push({...s.identity.units[0],id:'ui'}));
  await assert.rejects(candidateEvidence(missing.get,{product:target}),/CANDIDATE_FROZEN_UNIT_COVERAGE/);
  const recovered=await candidateEvidence(missing.get,{product:target,requireReady:false});
  assert.equal(recovered.identity,null);
  assert.equal(recovered.selectionChanged,true);
});
test('normal recovery reads a conflict with a new frozen unit set without claiming the old identity',async()=>{
  const f=candidateFixture(s=>{
    const next={...s.generated,units:[{...s.generated.units[0],id:'ui',path:'ui'}]};
    s.identity.units[0].id='ui';
    s.conflict={head,generated:next,paths:['CHANGELOG.md']};
  });
  const target={...product,units:[{id:'layerscape',path:'.'},{id:'ui',path:'ui'}]};
  const recovered=await candidateEvidence(f.get,{product:target,requireReady:false});
  assert.equal(recovered.identity,null);
  assert.equal(recovered.selectionChanged,true);
  await assert.rejects(candidateEvidence(f.get,{product:target}),/CANDIDATE_OBSERVATION_NOT_READY/);
});
test('a conflict relocating the same unit is stale for the new product path',async()=>{
  const f=candidateFixture(s=>{
    s.conflict={head,generated:{...s.generated,units:[{...s.generated.units[0],path:'packages/cli'}]},paths:['CHANGELOG.md']};
  });
  const target={...product,units:[{id:'layerscape',path:'packages/cli'}]};
  const recovered=await candidateEvidence(f.get,{product:target,requireReady:false});
  assert.equal(recovered.identity,null);
  assert.equal(recovered.selectionChanged,true);
  await assert.rejects(candidateEvidence(f.get,{product:target}),/CANDIDATE_OBSERVATION_NOT_READY/);
});
test('unlabel recovery can regenerate an older unit path before any conflict is recorded',async()=>{
  const f=candidateFixture(),target={...product,units:[{id:'layerscape',path:'packages/app'}]};
  const hint={repositoryId:target.id,prNumber:192,eventId:7};
  await assert.rejects(candidateEvidence(f.get,{product:target,requireReady:false}),/CANDIDATE_UNIT_NOT_SELECTED/);
  const source='e'.repeat(40);
  f.data[f.prefix+'/git/ref/heads/main'].object.sha=source;
  const {validateNormalCandidateEvent}=await import('../bounded-candidate-contract.mjs');
  const recovered=await validateNormalCandidateEvent(hint,source,f.get,target);
  assert.equal(recovered.identity,null);
  assert.equal(recovered.selectionChanged,true);
  await assert.rejects(candidateEvidence(f.get,{product:target}),/CANDIDATE_UNIT_NOT_SELECTED/);
});
test('native event binds exact PR and assembled immutable session',async()=>{
  const f=candidateFixture(),v=await validateCandidateEvent({repositoryId:product.id,prNumber:192,eventId:7},f.get);
  assert.equal(v.identity.version,'1.0.0');assert.equal(v.t0,Date.parse('2026-11-16T12:00:00Z'));assert.equal(v.evidence.prNumber,192);
});
for(const kind of ['blob','chunk','event-object','label','source','pending'])test(`native contract rejects ${kind}`,async()=>{
  const f=candidateFixture();
  if(kind==='blob')f.setCorrupt();
  if(kind==='chunk')f.chunks[1].documentDigest='e'.repeat(64);
  if(kind==='event-object')f.data[`${f.prefix}/issues/events/7`].issue.number=193;
  if(kind==='label')f.data[`${f.prefix}/issues/events/7`].label.name='unrelated';
  if(kind==='source')f.data[`${f.prefix}/git/ref/heads/main`].object.sha='c'.repeat(40);
  if(kind==='pending')f.state.activeCycleId=`pr-192-${head}`;
  await assert.rejects(validateCandidateEvent({repositoryId:product.id,prNumber:192,eventId:7},f.get));
});
for(const expired of [false,true])test(`real unlabeled event retains old window, expired=${expired}`,async()=>{
  const identity={epoch:'fixed'},registration={identity,t0:200,policySha:head,deploymentSha:head},producer={runId:42};
  const record={...registration,t0:100,deadline:150,generation:3,consumed:2,status:'PAUSED'},calls=[];
  const output=await applyCandidateEvent(registration,producer,{pull:{labels:[]},event:{event:'unlabeled'}},async(action,body)=>{
    calls.push(action);
    if(action==='status')return record;
    assert.equal(action,'resume');assert.deepEqual(body,{identity,expectedGeneration:3,producer});
    return {...record,generation:4,status:expired?'NEEDS_ATTENTION':'PENDING'};
  });
  assert.deepEqual(calls,['status','resume']);assert.equal(output.status,expired?'NEEDS_ATTENTION':'PENDING');
});
test('terminal object is not registered or resumed by a later event',async()=>{
  const registration={identity:{epoch:'fixed'},t0:200,policySha:head,deploymentSha:head};
  assert.deepEqual(await applyCandidateEvent(registration,{}, {pull:{labels:[]},event:{event:'unlabeled'}},async action=>{
    assert.equal(action,'status');return {...registration,t0:100,generation:3,status:'DONE'};
  }),{status:'DONE'});
});
test('superseded unlabeled event cannot resume current editing candidate',async()=>{
  await assert.rejects(applyCandidateEvent({}, {}, {pull:{labels:[{name:'release:editing'}]},event:{event:'unlabeled'}},()=>assert.fail('control write')),/SUPERSEDED/);
});
const normalInput=sourceSha=>({hint:{repositoryId:product.id,prNumber:192,eventId:7},sourceSha,requestKey:'f'.repeat(64),
  producer:{repositoryId:id,runId:42,attempt:1,controllerSha:head}});
test('normal event invokes only candidate processing and binds current source',async()=>{
  const f=candidateFixture();let calls=0;
  const result=await processNormalCandidateEvent(normalInput(head),{get:f.get,invoke:async({before,sourceSha})=>{
    calls++;assert.equal(before.pull.number,192);assert.equal(sourceSha,head);return {status:'READY',head};
  }});
  assert.equal(calls,1);assert.equal(result.outcome,'candidate_updated');
  assert.equal(result.candidateIdentity.sourceSha,head);
  assert.deepEqual(Object.keys(result).sort(),['schemaVersion','requestKey','producer','event','sourceSha','status','reason','outcome','stateBefore','stateAfter','candidateIdentity'].sort());
});
test('normal source advancement permits human protection without falsifying current cache',async()=>{
  const f=candidateFixture(),newSource='c'.repeat(40);f.data[`${f.prefix}/git/ref/heads/main`].object.sha=newSource;
  const result=await processNormalCandidateEvent(normalInput(newSource),{get:f.get,invoke:async()=>({status:'CONFLICT',reason:'HUMAN_EDIT_CONFLICT'})});
  assert.equal(result.outcome,'protected');assert.equal(result.candidateIdentity.sourceSha,head);
  await assert.rejects(validateCandidateEvent(normalInput(newSource).hint,f.get),/SOURCE_CHANGED/);
});
for(const kind of ['source','wrong-event','closed','unknown-labels','superseded'])test(`normal rejects ${kind} before candidate invocation`,async()=>{
  const f=candidateFixture(),pr=f.data[`${f.prefix}/pulls/192`];
  if(kind==='source')f.data[`${f.prefix}/git/ref/heads/main`].object.sha='c'.repeat(40);
  if(kind==='wrong-event')f.data[`${f.prefix}/issues/events/7`].issue.number=193;
  if(kind==='closed')pr.state='closed';
  if(kind==='unknown-labels')delete pr.labels;
  if(kind==='superseded')pr.labels=[{name:'release:editing'}];
  await assert.rejects(processNormalCandidateEvent(normalInput(head),{get:f.get,invoke:()=>assert.fail('candidate must not run')}));
});
test('normal refuses to publish success after source moves during work',async()=>{
  const f=candidateFixture();
  await assert.rejects(processNormalCandidateEvent(normalInput(head),{get:f.get,invoke:async()=>{
    f.data[`${f.prefix}/git/ref/heads/main`].object.sha='c'.repeat(40);return {status:'READY'};
  }}),/SOURCE_CHANGED/);
});
test('normal event does not label unknown result as completion',async()=>{
  const f=candidateFixture();
  const v=await processNormalCandidateEvent(normalInput(head),{get:f.get,invoke:async()=>({status:'WAIT',reason:'WRITE_UNKNOWN'})});
  assert.equal(v.outcome,'needs_attention');
});
for(const kind of ['closed','editing','human-head'])test(`normal rechecks ${kind} after candidate processing`,async()=>{
  const f=candidateFixture(),pr=f.data[`${f.prefix}/pulls/192`];
  const task=processNormalCandidateEvent(normalInput(head),{get:f.get,invoke:async()=>{
    if(kind==='closed')pr.state='closed';
    if(kind==='editing')pr.labels=[{name:'release:editing'}];
    if(kind==='human-head')pr.head.sha='e'.repeat(40);
    return {status:'READY',head};
  }});
  if(kind==='human-head')await assert.rejects(task,/HEAD_MOVED/);
  else assert.equal((await task).outcome,kind==='closed'?'needs_attention':'paused');
});

// This cache-only job is constrained by the adopted five-minute observation budget.
test('candidate observer uses the five-minute job budget',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {parse}=await import('yaml');
  const workflow=parse(await readFile(new URL('../../.github/workflows/release-observe.yml',import.meta.url),'utf8'));
  assert.equal(workflow.jobs.observe['timeout-minutes'],5);
});

for(const mode of ['normal','event','observe'])test(`unbound deployment blocks ${mode} before native reads`,async()=>{
  const f=fixture(mode);for(const deploymentSha of [null,undefined,'bad'])await assert.rejects(entryGuard(f.env,()=>assert.fail('native read'),{enabled:true,deploymentSha}),/NOT_CONNECTED/);
});
for(const kind of ['missing','content','owner','kind','digest','chunk'])test(`generated archive refuses ${kind} drift`,async()=>{
  const f=candidateFixture();
  if(kind==='missing')delete f.files[f.state.candidate.generatedSnapshotPath];
  if(kind==='content'){const value=JSON.parse(f.generatedChunk.content);value.sourceDigest='0'.repeat(64);f.generatedChunk.content=JSON.stringify(value);f.generatedChunk.documentDigest=sha256(f.generatedChunk.content);}
  if(kind==='owner')f.generatedChunk.candidateId='0'.repeat(64);if(kind==='kind')f.generatedChunk.documentKind='session';
  if(kind==='digest')f.generatedChunk.documentDigest='0'.repeat(64);if(kind==='chunk')f.generatedChunk.count=2;
  await assert.rejects(validateCandidateEvent({repositoryId:product.id,prNumber:192,eventId:7},f.get));
});

test('complete split generated archive is bound to the session',async()=>{
  const f=candidateFixture(),chunk=f.generatedChunk,text=chunk.content,middle=Math.floor(text.length/2);
  chunk.count=2;chunk.content=text.slice(0,middle);
  f.files[f.state.candidate.generatedSnapshotPath.replace('.json','-1.json')]={...chunk,index:1,content:text.slice(middle)};
  assert.equal((await validateCandidateEvent({repositoryId:product.id,prNumber:192,eventId:7},f.get)).identity.version,'1.0.0');
});

test('reviewed registrations and native public repository facts must both match before state reads',async()=>{
  const target={id:72,name:'splrad/second-product',defaultBranch:'trunk'};
  const repository={id:72,full_name:target.name,default_branch:'trunk',owner:{id:302208797},private:false,visibility:'public'};
  for(const change of [{private:true},{visibility:'internal'},{owner:{id:1}},{default_branch:'main'},{full_name:'splrad/unregistered'}]) {
    let reads=0;
    await assert.rejects(candidateEvidence(async()=>{reads++;return {...repository,...change};},{product:target}),/BOUNDED_REPOSITORY/);
    assert.equal(reads,1);
  }
  const reads=[];
  await assert.rejects(candidateEvidence(async path=>{reads.push(path);return reads.length===1?repository:{};},{product:target}),/BOUNDED_STATE_REF/);
  assert.equal(reads[1],'/repos/splrad/second-product/git/ref/heads/steward/release-state');
});
