import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Handlebars from 'handlebars';
import { advanceEvent, validateEvent } from '../release-cycle-event.mjs';
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
  const run={id:52,run_attempt:1,created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',status:'completed',
    repository:{id:1296724484},head_repository:{id:1296724484},actor:{id:301115370},head_branch:'main',head_sha:source,
    event:'workflow_dispatch',path:'.github/workflows/release-cycle-event.yml'};
  const state={cycles:[],domainRecords:[]},calls=[];
  const ports={snapshot:async()=>state,botId:301115370,centralGet:async()=>run,
    invoke:async(command,id)=>{calls.push([command,id]); return {status:'OBSERVED'};}};
  const event={kind:'publication',repositoryId:1296724484,runId:52,attempt:1};
  await assert.rejects(advanceEvent(event,ports),/AMBIGUOUS/);
  state.domainRecords.push({path:'evidence/publication/test.json',value:{centralRun:{id:52,runAttempt:1,headSha:source},cycleId:'cycle'}});
  await advanceEvent(event,ports);
  assert.deepEqual(calls,[['observe-channel','cycle'],['dispatch-channel','cycle']]);
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
  const hint={repositoryId:product.id,kind:'run',runId:83,attempt:1};
  await advanceEvent(hint,ports);
  assert.deepEqual(calls,[['observe-channel','cycle',false],['dispatch-channel','cycle',false]]);
  run.display_title='Channels observe '+'0'.repeat(64);
  await assert.rejects(advanceEvent(hint,ports),/AMBIGUOUS/);
});
