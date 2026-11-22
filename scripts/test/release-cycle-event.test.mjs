import {channelResultUrl} from '../release-record.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Handlebars from 'handlebars';
import YAML from 'yaml';
import { advanceEvent, validateEvent, publicCycleError, withCycleCleanup } from '../release-cycle-event.mjs';
import { renderCandidateHomepage, syncCandidateHomepage } from '../candidate-homepage.mjs';
import { product, sha256 } from '../bounded-candidate-contract.mjs';
const source='a'.repeat(40), later='b'.repeat(40);
const push=sourceSha=>({kind:'push',repositoryId:product.id,sourceSha});
test('packaged conventional changelog renders two distinct Markdown items', async()=>{
  const renderer=Handlebars.create();
  const template=name=>readFile(new URL('../../packages/runner/dist/'+name+'1.hbs',import.meta.url),'utf8');
  for(const name of ['commit','header','footer'])renderer.registerPartial(name,await template(name));
  const text=renderer.compile(await template('template'))({commitGroups:[{title:'Features',commits:[{subject:'alpha'},{subject:'beta'}]}]});
  assert.match(text,/^\* alpha\n\* beta$/m);
});
test('event key binds native identity independently of the controller revision',()=>{
  validateEvent(push(source),sha256([product.id,'push',source]));
  assert.throws(()=>validateEvent(push(later),sha256([product.id,'push',source])));
  assert.throws(()=>validateEvent({...push(source),cycleId:'foreign'},sha256([product.id,'push',source])));
});
for(const order of [[source,later],[later,source]])test('delayed merge and later push register the same source exactly once '+order[0][0],async()=>{
  const state={head:'1'.repeat(40),repository:{candidate:{prNumber:192}},cycles:[]},calls=[];
  const ports={snapshot:async()=>state,get:async path=>path==='pulls/192'?{merged:true,merge_commit_sha:source}:{object:{sha:later}},
    candidate:async head=>{
      assert.equal(head,later);
      if(!state.repository.candidate)return {status:'WAIT',reason:'UNCHANGED'};
      state.repository.candidate=null;
      state.cycles.push({value:{id:'cycle',sourceSha:source,dispatches:[]}});
      return {status:'CYCLE_READY',cycleId:'cycle',sourceSha:source};
    },invoke:async(command,id)=>{
      assert.equal(id,'cycle'); calls.push(command);
      state.cycles[0].value.dispatches.push({purpose:'build',canonicalRunId:42});
      return {status:'BOUND'};
    }};
  assert.equal((await advanceEvent(push('c'.repeat(40)),ports)).reason,'SUPERSEDED_PUSH');
  for(const sha of order)await advanceEvent(push(sha),ports);
  assert.equal(state.cycles.length,1); assert.equal(state.cycles[0].value.sourceSha,source);
  assert.deepEqual(calls,['dispatch-build']);
});
test('repeated pushes preserve completed freeze-only cycles in both delivery formats',async()=>{
  for(const workflowDelivery of [false,true]) {
    const unit={id:'internal-docs',...(workflowDelivery?{githubDisabled:true}:{})};
    const cycle={id:'cycle',sourceSha:source,units:[unit],dispatches:[{purpose:'build',canonicalRunId:42}],
      freezeCompletedAt:'2026-10-30T01:00:00Z',...(workflowDelivery?{workflowDelivery}:{freezeOnly:[{unitId:unit.id}]})};
    const ports={snapshot:async()=>({cycles:[{value:cycle}]}),get:async()=>({object:{sha:later}}),
      candidate:async()=>assert.fail('same source must not reopen the candidate'),
      invoke:async command=>assert.fail('completed cycle invoked '+command)};
    for(let i=0;i<2;i++)assert.deepEqual(await advanceEvent(push(source),ports),
      {status:'FROZEN',reason:'NO_PUBLICATION_CHANNELS',cycleId:cycle.id});
  }
});
test('a workflow-owned cycle without publication channels can still start its first build',async()=>{
  const cycle={id:'cycle',sourceSha:source,workflowDelivery:true,units:[{id:'internal-docs',githubDisabled:true}],dispatches:[]};
  const calls=[];
  const ports={snapshot:async()=>({cycles:[{value:cycle}]}),get:async()=>({object:{sha:source}}),
    invoke:async(command,id)=>{calls.push([command,id]);return {status:'BOUND'};}};
  assert.deepEqual(await advanceEvent(push(source),ports),{status:'BOUND',cycleId:cycle.id});
  assert.deepEqual(calls,[['dispatch-build',cycle.id]]);
});
test('a publication completion requires its exact archived invocation', async()=>{
  const run={id:52,run_attempt:1,created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',status:'completed',conclusion:'success',
    repository:{id:1296724484},head_repository:{id:1296724484},actor:{id:301115370},head_branch:'main',head_sha:source,
    event:'workflow_dispatch',path:'.github/workflows/release-cycle-event.yml'};
  const state={cycles:[],domainRecords:[]},calls=[];
  const ports={snapshot:async()=>state,botId:301115370,centralGet:async()=>run,
    invoke:async(command,id)=>{calls.push([command,id]); return {status:'OBSERVED'};}};
  const event={kind:'publication',repositoryId:1296724484,runId:52,attempt:1};
  await assert.rejects(advanceEvent(event,ports),/AMBIGUOUS/);
  state.domainRecords.push({path:'evidence/publication/test.json',value:{startEvidencePath:null,centralRun:{id:52,runAttempt:1,headSha:source},cycleId:'cycle'}});
  await advanceEvent(event,ports);
  assert.deepEqual(calls,[['reconcile-publication','cycle'],['observe-channel','cycle'],['dispatch-channel','cycle']]);
  calls.length=0; run.conclusion='failure';
  assert.equal((await advanceEvent(event,ports)).reason,'PUBLICATION_RECEIPT_UNSUCCESSFUL');assert.equal(calls.length,0);
  run.run_attempt=2;run.conclusion='success';
  await advanceEvent({...event,attempt:2},ports);
  assert.deepEqual(calls,[['reconcile-publication','cycle'],['observe-channel','cycle'],['dispatch-channel','cycle']]);
});
test('a WinGet index receipt cannot enqueue another probe',async()=>{
  const {channelTargetsDigest}=await import('../../packages/runner/dist/index.js');
  const cycle={id:'cycle',sourceSha:source,deliveryConfigSha:later,requiredChannels:[{unitId:'layerscape',channelId:'winget'}],
    units:[{id:'layerscape',version:'1.0.0',releaseId:71,manifestDigest:'9'.repeat(64)}]};
  const target={...cycle.requiredChannels[0],version:'1.0.0',releaseId:71,manifestDigest:'9'.repeat(64)};
  const key=sha256(['observe',channelTargetsDigest({repositoryId:product.id,cycle},[target]),later]);
  const run={id:83,run_attempt:1,status:'completed',conclusion:'success',repository:{id:product.id},head_repository:{id:product.id},
    head_sha:later,head_branch:'main',actor:{id:301115370},event:'workflow_dispatch',workflow_id:410998651,
    path:'.github/workflows/steward-release-channels.yml',created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',display_title:'Channels observe '+key};
  const calls=[],ports={get:async()=>run,snapshot:async()=>({cycles:[{value:cycle}]}),botId:301115370,
    invoke:async(command,id,runId,allowProbeDispatch)=>{calls.push([command,id,allowProbeDispatch]);return {status:'OBSERVED'};}};
  const digest=channelTargetsDigest({repositoryId:product.id,cycle},[target]);
  ports.probeArtifacts=async()=>[{expired:false,name:'probe-'+cycle.id+'-'+digest+'-'+run.id+'-1',workflow_run:{id:run.id,head_sha:run.head_sha}}];
  const hint={repositoryId:product.id,kind:'run',runId:83,attempt:1};
  await advanceEvent(hint,ports);
  assert.deepEqual(calls,[['observe-channel','cycle',false],['dispatch-channel','cycle',false]]);
  run.display_title='Channels observe '+'0'.repeat(64);
  await assert.rejects(advanceEvent(hint,ports),/AMBIGUOUS/);
  run.display_title='Channels observe '+key;
  const before=calls.length;
  ports.probeArtifacts=async()=>[{expired:true,name:'probe-'+cycle.id+'-'+digest+'-'+run.id+'-1',workflow_run:{id:run.id,head_sha:run.head_sha}}];
  assert.equal((await advanceEvent(hint,ports)).reason,'PROBE_RECEIPT_UNCONFIRMED');
  assert.equal(calls.length,before);

});
test('a rerun after a lost publication receipt verifies the original attempt without invoking publish again',async()=>{
  const buildKey='e'.repeat(64),request={purpose:'build',operationKey:buildKey,canonicalRunId:83,workflowId:410998652,
    ref:'steward/build/pr-192-'+source,executionSha:source,sentAt:'2026-11-19T01:00:00Z'};
  const run={id:83,run_attempt:1,status:'completed',conclusion:'success',repository:{id:product.id},head_repository:{id:product.id},
    head_sha:source,head_branch:request.ref,actor:{id:301115370},triggering_actor:{id:301115370},event:'workflow_dispatch',workflow_id:410998652,
    path:'.github/workflows/steward-release-publish.yml',created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',display_title:'Build '+buildKey};
  const prior={path:'evidence/publication/start',value:{cycleId:'cycle',startEvidencePath:null,centralRun:{id:52,runAttempt:1,headSha:later}}};
  const state={cycles:[{value:{id:'cycle',dispatches:[request]}}],domainRecords:[prior]},calls=[];
  let status='OBSERVED';
  const ports={get:async()=>run,snapshot:async()=>state,botId:301115370,producer:{runId:52,attempt:2,controllerSha:later},
    invoke:async command=>{calls.push(command);return {status};}};
  const event={repositoryId:product.id,kind:'run',runId:83,attempt:1};
  assert.equal((await advanceEvent(event,ports)).publishInvoked,true);
  status='UNKNOWN';
  assert.equal((await advanceEvent(event,ports)).publishInvoked,false);
  assert.deepEqual(calls,['reconcile-publication','reconcile-publication']);
});

test('retains each native attempt receipt even if the first upload acknowledgement was lost',async()=>{
  const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/release-cycle-event.yml',import.meta.url),'utf8'));
  const upload=workflow.jobs['release-coordinator'].steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name,'release-cycle-${{ inputs.request_key }}-${{ github.run_attempt }}');
  assert.equal(upload.with.overwrite,undefined);
  assert.match(workflow.concurrency.group,/steward-candidate-homepage-\{0\}-\{1\}.*repositoryId.*prNumber/);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.queue, 'max');
});

test('a GitHub-only publication checks its receipt and has no external work even while evidence is pending', async()=>{
  const run={id:52,run_attempt:1,created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',status:'completed',conclusion:'success',
    repository:{id:1296724484},head_repository:{id:1296724484},actor:{id:301115370},head_branch:'main',head_sha:source,
    event:'workflow_dispatch',path:'.github/workflows/release-cycle-event.yml'};
  const archive={path:'evidence/publication/test.json',value:{startEvidencePath:null,centralRun:{id:52,runAttempt:1,headSha:source},cycleId:'only-github'}};
  const state={cycles:[{value:{id:'only-github',requiredChannels:[]}}],domainRecords:[archive]},calls=[];
  const result=await advanceEvent({kind:'publication',repositoryId:1296724484,runId:52,attempt:1},{
    snapshot:async()=>state,centralGet:async()=>run,botId:301115370,
    invoke:async command=>{calls.push(command);return command==='reconcile-publication'?{status:'OBSERVED'}:{status:'WAIT'};}
  });
  assert.equal(result.status,'WAIT');
  assert.deepEqual(calls,['reconcile-publication','observe-channel']);
});
test('a registered fixture repository uses its own default branch while the production pilot rejects it', async()=>{
  const registry=[{id:41,name:'example/tools',defaultBranch:'trunk',channelWorkflowId:42}];
  const event={kind:'push',repositoryId:41,sourceSha:source}, key=sha256([41,'push',source]);
  assert.throws(()=>validateEvent(event,key),/CYCLE_EVENT_KIND/);
  validateEvent(event,key,registry);
  const paths=[];
  const result=await advanceEvent(event,{registry,snapshot:async()=>({cycles:[]}),
    get:async path=>{paths.push(path);return {object:{sha:source}};},candidate:async()=>({status:'WAIT'})});
  assert.deepEqual(paths,['git/ref/heads/trunk']);assert.equal(result.status,'WAIT');
});

test('routes a multi-unit probe only when the report subset belongs to the frozen cycle',async()=>{
  const {channelTargetsDigest}=await import('../../packages/runner/dist/index.js');
  const units=['one','two','three'].map((id,i)=>({id,version:'2.0.0',releaseId:i+11,manifestDigest:String(i+1).repeat(64)}));
  const cycle={id:'cycle',sourceSha:source,controllerSha:source,deliveryConfigSha:later,units,
    requiredChannels:units.map(unit=>({unitId:unit.id,channelId:'ghcr-assets'}))};
  const targets=units.slice(1).map(unit=>({unitId:unit.id,channelId:'ghcr-assets',version:unit.version,releaseId:unit.releaseId,manifestDigest:unit.manifestDigest}));
  const digest=channelTargetsDigest({repositoryId:product.id,cycle},targets);
  const run={id:83,run_attempt:1,status:'completed',conclusion:'success',repository:{id:product.id},head_repository:{id:product.id},
    head_sha:later,head_branch:'main',actor:{id:301115370},event:'workflow_dispatch',workflow_id:410998651,
    path:'.github/workflows/steward-release-channels.yml',created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',
    display_title:'Channels observe '+sha256(['observe',digest,later])};
  const report={schemaVersion:1,sourceSha:source,executionSha:later,controllerSha:source,nativeRunId:83,runAttempt:1,cycleId:cycle.id,targetsDigest:digest,items:targets.map(({unitId,channelId,version})=>({unitId,channelId,version}))};
  const calls=[],ports={snapshot:async()=>({cycles:[{value:cycle}]}),get:async()=>run,botId:301115370,
    probeArtifacts:async()=>[{id:12,name:'probe-cycle-'+digest+'-83-1',expired:false,workflow_run:{id:83,head_sha:later}}],
    probeReport:async()=>report,invoke:async command=>{calls.push(command);return {reason:'DISTRIBUTION_VERIFIED'};}};
  const event={repositoryId:product.id,kind:'run',runId:83,attempt:1};
  assert.equal((await advanceEvent(event,ports)).cycleId,'cycle');
  report.items[0].unitId='foreign';
  await assert.rejects(advanceEvent(event,ports),/AMBIGUOUS/);
  assert.deepEqual(calls,['observe-channel']);
});

test('channel results link the frozen product and package',()=>{
  const item={unitId:'cli',channelId:'ghcr-assets',nativeObjectId:'sha256:fixture'};
  const delivery={units:[{id:'cli',channels:[{id:'ghcr-assets',required:true,location:'ghcr.io/example/cli-assets'}]}]};
  assert.equal(channelResultUrl('Example/CLI',delivery,item),'https://github.com/Example/CLI/pkgs/container/cli-assets');
  assert.throws(()=>channelResultUrl('splrad/LayerScape',delivery,item));
  delivery.units[0].channels[0].location='ghcr.io/example/tools/cli';
  assert.equal(channelResultUrl('Example/CLI',delivery,item),'https://github.com/Example/CLI/pkgs/container/tools%2Fcli');
  delivery.units[0].channels[0].required=false;
  assert.throws(()=>channelResultUrl('Example/CLI',delivery,item));
});

test('reports fixed readback failures without including arbitrary exception details',()=>{
  for(const code of ['CYCLE_ACTOR','BOUNDED_RUN_SOURCE','CANDIDATE_REF_DRIFT','CANDIDATE_PR_HEAD_DRIFT','CANDIDATE_STATE_CONFLICT'])
    assert.equal(publicCycleError(new Error(code)),code);
  for(const error of [null,new Error('CANDIDATE_PR_HEAD_DRIFT: repo details'),new Error('network response details')])
    assert.equal(publicCycleError(error),'CYCLE_EVENT_STOPPED');
});

test('push diagnostics distinguish the failing operation and keep its original failure',async()=>{
  const state={head:'1'.repeat(40),repository:{candidate:null},cycles:[]};
  for(const [port,stage,message,diagnostic] of [
    ['snapshot','LEDGER_READ','CYCLE_PRIVATE_VALUE','CYCLE_EVENT_STOPPED\nstage=LEDGER_READ category=UNCLASSIFIED'],
    ['get','SOURCE_READ','NATIVE_HTTP_403','CYCLE_EVENT_STOPPED\nstage=SOURCE_READ category=NATIVE_HTTP_403'],
    ['candidate','CANDIDATE','CANDIDATE_REF_DRIFT','CANDIDATE_REF_DRIFT\nstage=CANDIDATE'],
    ['candidate','CANDIDATE','NATIVE_HTTP_403: private details','CYCLE_EVENT_STOPPED\nstage=CANDIDATE category=UNCLASSIFIED'],
  ]) {
    const calls=[];
    const ports={snapshot:async()=>state,get:async()=>({object:{sha:source}}),candidate:async()=>({status:'READY'})};
    ports[port]=async()=>{calls.push(stage);throw Error(message)};
    await assert.rejects(advanceEvent(push(source),ports),error=>publicCycleError(error)===diagnostic);
    assert.deepEqual(calls,[stage]);
  }
});


test('run and publication read failures retain their source stage',async()=>{
  const snapshot=async()=>({cycles:[]});
  const unavailable=async()=>{throw Error('NATIVE_HTTP_503')};
  for(const [kind,repositoryId,port] of [['run',product.id,'get'],['publication',1296724484,'centralGet']]) {
    await assert.rejects(advanceEvent({kind,repositoryId,runId:52,attempt:1},{snapshot,[port]:unavailable}),
      error=>publicCycleError(error)==='CYCLE_EVENT_STOPPED\nstage=SOURCE_READ category=NATIVE_HTTP_503');
  }
});

test('a channel probe source error is reported only for runs on the registered workflow path',async()=>{
  const event={kind:'run',repositoryId:product.id,runId:52,attempt:1};
  const run={id:52,run_attempt:1,status:'completed',conclusion:'success',repository:{id:product.id},
    head_repository:{id:product.id},actor:{id:301115370},head_branch:'main',head_sha:source,
    event:'workflow_dispatch',workflow_id:410998651,created_at:'2026-11-19T01:00:00Z',
    updated_at:'2026-11-19T01:01:00Z',display_title:'Channels observe '+source,
    path:'.github/workflows/steward-release-channels.yml'};
  const ports={snapshot:async()=>({cycles:[]}),get:async()=>run,
    probeWorkflow:async()=>{throw Error('NATIVE_HTTP_503');}};
  await assert.rejects(advanceEvent(event,ports),
    error=>publicCycleError(error)==='CYCLE_EVENT_STOPPED\nstage=SOURCE_READ category=NATIVE_HTTP_503');
  run.path='.github/workflows/other.yml';
  await assert.rejects(advanceEvent(event,ports),/CYCLE_EVENT_AMBIGUOUS/);
});

test('cleanup runs once and preserves an earlier business failure',async()=>{
  let calls=0;
  const cleanup=async()=>{calls++;throw Error('private path')};
  const original=new Error('BOUNDED_RUN_SOURCE');
  await assert.rejects(withCycleCleanup(async()=>{throw original},cleanup),error=>error===original);
  await assert.rejects(withCycleCleanup(async()=>1,cleanup),
    error=>publicCycleError(error)==='CYCLE_EVENT_STOPPED\nstage=CLEANUP category=UNCLASSIFIED');
  assert.equal(calls,2);
});


const candidate = {id:'d'.repeat(64),prNumber:201,branch:'steward/release-candidate',statusCommentId:7015204821};
const repository = 'splrad/LayerScape', notesPath = '.release-notes/layerscape.md';
const creation = '当前版本和发布说明见[候选状态](https://github.com/splrad/LayerScape/pull/201#issuecomment-7015204821)。下方是创建 PR 时的变更记录。'
  + '\n\n<details><summary>1.0.1</summary>\n\n## 1.0.1\n\n* 初始化时的条目\n\n</details>'
  + '\n\n编辑发布说明文件前，添加 `release:editing` 标签，等正在写入候选分支的作业结束后再修改。'
  + '\n\n<!-- steward:candidate:' + candidate.id + ' -->';

test('the candidate homepage keeps the complete draft above the original collapsed record and exact links',()=>{
  const markdown = '## 新功能\n\n- 完整的文稿。\n\n### 维护\n\n- 原格式保留。';
  const model = {candidate,repository,head:source,notes:[{path:notesPath,unit:'layerscape',version:'1.1.0',markdown}]};
  const body = renderCandidateHomepage(creation,model);
  assert.ok(body.startsWith('> **候选预览**'));
  assert.ok(body.includes('/blob/steward/release-candidate/'+notesPath));
  assert.ok(body.includes('# 发布说明 · 1.1.0\n\n'+markdown+'\n\n---\n\n## PR 信息'));
  assert.ok(body.includes('/pull/201#issuecomment-7015204821'));
  assert.ok(body.includes('/commit/'+source));
  assert.ok(body.includes('/blob/'+source+'/'+notesPath));
  assert.ok(body.includes('<details>\n<summary>创建 PR 时的变更记录</summary>'));
  assert.ok(body.includes('## 1.0.1\n\n* 初始化时的条目'));
  assert.equal(body.match(/<details>/g).length,1);
  assert.equal(renderCandidateHomepage(body,model),body);
  const migrated = renderCandidateHomepage('历史正文\n\n当前文稿的预览见本 PR 的 Steward 状态评论。\n\n<!-- steward:candidate:'+candidate.id+' -->',model);
  assert.ok(migrated.includes('历史正文'));
  assert.ok(!migrated.includes('当前文稿的预览见本 PR'));
});

test('oversized notes keep the full source links, metadata and creation record',()=>{
  const notes = [{path:notesPath,unit:'layerscape',version:'1.1.0',markdown:'中'.repeat(65536)},
    {path:'docs/release.md',unit:'docs',version:'1.1.2',markdown:'## Docs'}];
  const fits = [{...notes[0],markdown:'中'.repeat(24000)},notes[1]];
  assert.ok(renderCandidateHomepage(creation,{candidate,repository,head:source,notes:fits}).includes(fits[0].markdown));
  const body = renderCandidateHomepage(creation,{candidate,repository,head:source,notes});
  assert.match(body,/发布说明超出 PR 正文长度限制/);
  assert.ok(body.includes('/blob/'+source+'/'+notesPath));
  assert.ok(body.includes('/blob/'+source+'/docs/release.md'));
  assert.match(body,/## 1.0.1/);
});

function candidateHomepageFixture() {
  const current = {head:source, body:creation};
  const writes = [], versions = new Map([[source,'1.1.0'],[later,'1.1.1']]);
  const getPull = async () => ({
    number:candidate.prNumber,state:'open',merged:false,body:current.body,
    head:{ref:candidate.branch,sha:current.head,repo:{id:product.id}},
    base:{ref:'main',repo:{id:product.id}},
  });
  const updateBody = async body => { writes.push(body); current.body = body; };
  return {current,writes,ports:{candidate,units:[{id:'layerscape',path:'.',notesPath}],repository,repositoryId:product.id,defaultBranch:'main',
    getPull,updateBody,fetchHead:async()=>current.head,readHead:async()=>current.head,stateCurrent:async()=>true,wait:async()=>{},
    readFile:async(head,path)=>path==='.release-please-manifest.json' ? JSON.stringify({'.':versions.get(head)}) : '发布说明 '+head,
  }};
}

test('a delayed event for A reconciles the current head B without writing A',async()=>{
  const {current,writes,ports} = candidateHomepageFixture();
  current.head = later;
  const event = {repositoryId:product.id,kind:'candidate-head',prNumber:201,head:source};
  const key = sha256([product.id,event.kind,event.prNumber,event.head]);
  validateEvent(event,key);
  assert.throws(()=>validateEvent({...event,prNumber:202},key),/CYCLE_EVENT_KEY/);
  const result = await advanceEvent(event,{homepage:async value=>{
    assert.deepEqual(value,{prNumber:201});
    return syncCandidateHomepage(ports);
  }});
  assert.deepEqual(result,{status:'READY',reason:'CANDIDATE_HOMEPAGE_UPDATED',head:later});
  assert.equal(writes.length,1);
  assert.match(writes[0],/发布说明 · 1.1.1/);
  assert.equal((await syncCandidateHomepage(ports)).reason,'CANDIDATE_HOMEPAGE_CURRENT');
  assert.equal(writes.length,1);
});

test('a new head before PATCH supersedes the old draft in the same attempt',async()=>{
  const {current,writes,ports} = candidateHomepageFixture();
  const original = ports.readFile;
  ports.readFile = async (head,path) => {
    if (head===source && path===notesPath) current.head = later;
    return original(head,path);
  };
  assert.equal((await syncCandidateHomepage(ports)).head,later);
  assert.equal(writes.length,1);
  assert.match(writes[0],/发布说明 · 1.1.1/);
});

test('a new head during an uncertain PATCH reconciles immediately from the new commit',async()=>{
  const {current,writes,ports} = candidateHomepageFixture();
  const save = ports.updateBody;
  ports.updateBody = async body => {
    await save(body);
    if (writes.length===1) {
      current.head = later;
      throw Error('response lost');
    }
  };
  assert.equal((await syncCandidateHomepage(ports)).head,later);
  assert.equal(writes.length,2);
  assert.ok(current.body.includes('发布说明 '+later));
  assert.ok(!current.body.includes('发布说明 '+source));
});

test('the bot edit wakes reconciliation when PATCH A lands after both head runs finished', async()=>{
  const {current,writes,ports} = candidateHomepageFixture();
  const save = ports.updateBody;
  let delayedBody;
  ports.updateBody = async body => {
    if (current.head===source) {
      delayedBody = body;
      current.head = later;
      throw Error('response lost before the accepted PATCH becomes visible');
    }
    await save(body);
  };
  const a = {repositoryId:product.id,kind:'candidate-head',prNumber:201,head:source};
  const b = {...a,head:later};
  const process = event => advanceEvent(event,{homepage:()=>syncCandidateHomepage(ports)});
  assert.equal((await process(a)).head,later);
  assert.equal((await process(b)).reason,'CANDIDATE_HOMEPAGE_CURRENT');
  assert.equal(writes.length,1);
  current.body = delayedBody;
  assert.ok(current.body.includes('发布说明 '+source));
  const edited = {...b,delivery:'35fcb56f-61cf-4a3d-a31a-24d2582253a3'};
  validateEvent(edited,sha256([product.id,b.kind,b.prNumber,b.head,edited.delivery]));
  assert.throws(()=>validateEvent(edited,sha256([product.id,b.kind,b.prNumber,b.head])),/CYCLE_EVENT_KEY/);
  assert.equal((await process(edited)).head,later);
  assert.ok(current.body.includes('发布说明 '+later));
  assert.equal(writes.length,2);
  assert.equal((await process({...edited,delivery:'f7872c8d-a174-49c1-95a0-764ff509b452'})).reason,'CANDIDATE_HOMEPAGE_CURRENT');
  assert.equal(writes.length,2);
});

test('candidate status delivery is keyed to the real comment and uses the same preview route', async()=>{
  const event = {repositoryId:product.id,kind:'candidate-status',prNumber:201,commentId:51};
  validateEvent(event,sha256([product.id,event.kind,event.prNumber,51]));
  assert.throws(()=>validateEvent({...event,commentId:52},sha256([product.id,event.kind,event.prNumber,51])),/CYCLE_EVENT_KEY/);
  assert.equal((await advanceEvent(event,{homepage:async value=>{
    assert.deepEqual(value,{prNumber:201,commentId:51});
    return {status:'READY',head:later};
  }})).head,later);
});

test('an accepted PATCH with an unavailable response and first readback does not need a second write',async()=>{
  const {writes,ports} = candidateHomepageFixture();
  const save = ports.updateBody, pull = ports.getPull;
  let uncertainRead = false;
  ports.updateBody = async body => {
    await save(body);
    uncertainRead = true;
    throw Error('response lost');
  };
  ports.getPull = async () => {
    if (uncertainRead) { uncertainRead = false; throw Error('readback unavailable'); }
    return pull();
  };
  assert.equal((await syncCandidateHomepage(ports)).status,'READY');
  assert.equal(writes.length,1);
});

test('repeatedly unconfirmed writes time out with a preview failure',async()=>{
  const {ports} = candidateHomepageFixture();
  let writes = 0;
  ports.updateBody = async () => { writes++; throw Error('offline'); };
  assert.deepEqual(await syncCandidateHomepage(ports),{status:'FAILED',reason:'CANDIDATE_HOMEPAGE_WRITE_UNKNOWN'});
  assert.equal(writes,4);
});

test('candidate projection retries unfinished state and records failures outside the release cycle',async()=>{
  const {ports} = candidateHomepageFixture();
  let tries = 0;
  const event = {repositoryId:product.id,kind:'candidate-head',prNumber:201,head:source};
  const onlyPreview = {
    waitForPreview:async()=>{},
    snapshot:()=>assert.fail('release cycle must not be read'),
    invoke:()=>assert.fail('release commands must not be invoked'),
  };
  assert.equal((await advanceEvent(event,{...onlyPreview,homepage:async()=>++tries===1
    ? {status:'WAIT',reason:'CANDIDATE_HOMEPAGE_NOT_READY'} : syncCandidateHomepage(ports)})).status,'READY');
  assert.equal(tries,2);
  assert.deepEqual(await advanceEvent(event,{...onlyPreview,homepage:async()=>({status:'WAIT',reason:'CANDIDATE_HOMEPAGE_NOT_READY'})}),
    {status:'FAILED',reason:'CANDIDATE_HOMEPAGE_NOT_READY'});
  assert.deepEqual(await advanceEvent(event,{...onlyPreview,homepage:async()=>{throw Error('internal details');}}),
    {status:'FAILED',reason:'CANDIDATE_HOMEPAGE_FAILED'});
});
