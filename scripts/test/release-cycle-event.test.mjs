import {channelResultUrl} from '../release-record.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Handlebars from 'handlebars';
import YAML from 'yaml';
import { advanceEvent, validateEvent, publicCycleError, withCycleCleanup } from '../release-cycle-event.mjs';
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
