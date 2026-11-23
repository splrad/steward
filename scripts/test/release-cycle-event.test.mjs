import {channelResultUrl, registerOfficialMergedCycle} from '../release-record.mjs';
import {mergedBuildCycle} from '../../packages/runner/dist/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
test('only the acknowledged official merge can register and dispatch a build',async()=>{
  const event={kind:'official-merge',repositoryId:product.id,prNumber:192,head:later,sourceSha:source,
    mergedAt:'2026-11-23T00:00:00Z',title:'chore(main): release 1.2.3',body:'approved'};
  const key=sha256([product.id,event.kind,event.prNumber,source,later]);
  validateEvent(event,key);
  assert.throws(()=>validateEvent({...event,sourceSha:later},key),/CYCLE_EVENT_KEY/);
  const calls=[],ports={officialMerge:async value=>{calls.push(value);return {status:'CYCLE_READY',cycleId:'exact'};},
    invoke:async(...args)=>{calls.push(args);return {status:'BOUND'};}};
  assert.equal((await advanceEvent(event,{})).reason,'OFFICIAL_RELEASE_DISABLED');
  assert.equal((await advanceEvent(event,{...ports,officialStage:'prepare'})).reason,'OFFICIAL_RELEASE_BUILD_EVENT_REQUIRED');
  assert.deepEqual(calls,[]);
  assert.deepEqual(await advanceEvent(event,ports),{status:'BOUND',cycleId:'exact'});
  assert.deepEqual(calls,[event,['dispatch-build','exact',null,true]]);
});
test('a paused merge cannot claim a cycle and a previously claimed merge drains the same cycle', async () => {
  const bot = 301115370, controller = 'd'.repeat(40), body = 'Approved release notes';
  const event = { kind:'official-merge',repositoryId:product.id,prNumber:192,head:later,sourceSha:source,body };
  const request = { repositoryId:product.id,repository:product.name,defaultBranch:product.defaultBranch,appBotId:bot };
  const config = Buffer.from(JSON.stringify({ 'separate-pull-requests':true, packages:{ '.':{'release-type':'simple'} } }));
  const delivery = Buffer.from('{"schemaVersion":3}');
  const name = 'delivery-github-release-' + '$' + '{{ github.repository_id }}-root-' + '$' +
    '{{ github.sha }}-' + '$' + '{{ github.run_id }}-' + '$' + '{{ github.run_attempt }}';
  const workflow = Buffer.from(JSON.stringify({jobs:{deliver:{name:'delivery/root',steps:[{
    id:'upload-github-release',name:'Upload GitHub release delivery',uses:'actions/upload-artifact@'+'1'.repeat(40),
    with:{name,path:'dist/*'},
  }]}}}));
  const receipt = { repositoryId:product.id,repository:product.name,defaultBranch:product.defaultBranch,authorId:bot,
    prNumber:192,sourceSha:source,candidateHead:later,path:'.',version:'1.0.0',tag:'v1.0.0',
    configDigest:sha256(config),pullBodyDigest:sha256(body),bodyDigest:sha256(body),body };
  const cycle=mergedBuildCycle({prNumber:receipt.prNumber,sourceSha:source,controllerSha:controller,
    repository:product.name,repositoryId:product.id,deliveryBlobSha:createHash('sha1').update('blob '+delivery.length+'\0').update(delivery).digest('hex'),
    delivery:JSON.parse(delivery),releasePlease:JSON.parse(config),workflow,
    units:[{id:'root',path:'.',version:receipt.version,tag:receipt.tag}],
    officialRelease:{headSha:receipt.candidateHead,pullBodyDigest:receipt.pullBodyDigest,bodyDigest:receipt.bodyDigest}});
  const ledger={repository:{schemaVersion:3,defaultBranch:product.defaultBranch,activeCycleId:null,revision:5},cycles:[]};
  const create=['creation','update'], integrity=['deletion','non_fast_forward'];
  let admissions=0;
  const readers={config,delivery,workflow,controllerSha:controller,readBytes:async()=>Buffer.from('{}'),
    admit:async()=>{admissions++;throw Error('RELEASE_REPOSITORY_PAUSED');},
    io:{async request(method,path){
      assert.equal(method,'GET');
      let native;
      if(path.includes('/rules/branches/'))native=[...create.map(type=>({type,ruleset_id:1})),...integrity.map(type=>({type,ruleset_id:2}))];
      else {
        const id=Number(path.split('/').at(-1));
        assert.ok(id===1||id===2);
        native={id,enforcement:'active',target:'branch',bypass_actors:id===2?[]:[{actor_type:'Integration',actor_id:4243096,bypass_mode:'always'}],
          rules:(id===1?create:integrity).map(type=>({type,parameters:{update_allows_fetch_and_merge:false}}))};
      }
      return {status:200,bytes:Buffer.from(JSON.stringify(native))};
    }}};
  const register=()=>registerOfficialMergedCycle(request,ledger,receipt,readers);
  const invokes=[];
  const ports={officialMerge:register,invoke:async(...args)=>{invokes.push(args);return {status:'BOUND'};}};
  await assert.rejects(advanceEvent(event,ports), /RELEASE_REPOSITORY_PAUSED/);
  assert.deepEqual(invokes,[]);
  assert.equal(admissions,1);
  // A replay of the already-claimed, exact cycle remains consumable during the pause.
  ledger.cycles.push({value:cycle});
  ledger.repository.activeCycleId=cycle.id;
  assert.deepEqual(await advanceEvent(event,ports), {status:'BOUND',cycleId:cycle.id});
  assert.deepEqual(invokes,[['dispatch-build',cycle.id,null,true]]);
  assert.equal(admissions,1);
});
test('default pushes wait for an official merged receipt before starting a cycle',async()=>{
  const state={repository:{candidate:{prNumber:192}},cycles:[]};
  const ports={snapshot:async()=>state,get:async path=>{
    assert.equal(path,'git/ref/heads/'+product.defaultBranch);
    return {object:{sha:later}};
  },invoke:async()=>assert.fail('unregistered source started a cycle')};
  assert.deepEqual(await advanceEvent(push(source),ports),{status:'WAIT',reason:'SUPERSEDED_PUSH'});
  assert.deepEqual(await advanceEvent(push(later),ports),{status:'WAIT',reason:'OFFICIAL_MERGE_REQUIRED'});
});
test('repeated pushes preserve completed freeze-only cycles in both delivery formats',async()=>{
  for(const workflowDelivery of [false,true]) {
    const unit={id:'internal-docs',...(workflowDelivery?{githubDisabled:true}:{})};
    const cycle={id:'cycle',sourceSha:source,units:[unit],dispatches:[{purpose:'build',canonicalRunId:42}],
      freezeCompletedAt:'2026-10-30T01:00:00Z',...(workflowDelivery?{workflowDelivery}:{freezeOnly:[{unitId:unit.id}]})};
    const ports={snapshot:async()=>({cycles:[{value:cycle}]}),get:async()=>({object:{sha:later}}),
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

test('official draft preparation recovers a lost canonical build binding on the original completed Run',async()=>{
  const request={purpose:'build',operationKey:'e'.repeat(64),requestKey:'f'.repeat(64),canonicalRunId:null,workflowId:410998652,
    ref:'steward/build/pr-192-'+source,executionSha:source,sentAt:'2026-11-19T01:00:00Z'};
  const run={id:83,run_attempt:1,status:'completed',conclusion:'success',repository:{id:product.id},head_repository:{id:product.id},
    head_sha:source,head_branch:request.ref,actor:{id:301115370},triggering_actor:{id:301115370},event:'workflow_dispatch',workflow_id:410998652,
    path:'.github/workflows/steward-release-publish.yml',created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:01:00Z',
    display_title:'Build '+request.operationKey};
  const cycle={id:'cycle',officialRelease:{},dispatches:[request]};
  const event={repositoryId:product.id,kind:'run',runId:83,attempt:1};
  const calls=[];
  let recoveredId=run.id;
  const ports={get:async()=>run,snapshot:async()=>({cycles:[{value:structuredClone(cycle)}]}),
    botId:301115370,officialStage:'prepare',invoke:async(command,id,runId,_allowProbe,recoverOnly)=>{
      calls.push([command,id,runId,recoverOnly]);
      if (recoverOnly) cycle.dispatches[0].canonicalRunId=recoveredId;
      return {status:'BOUND'};
    }};
  assert.deepEqual(await advanceEvent(event,ports),{status:'BOUND',cycleId:'cycle'});
  assert.deepEqual(calls,[['dispatch-build','cycle',null,true],['publish','cycle',null,undefined]]);
  for (const canonical of [null,84]) {
    calls.length=0;
    request.canonicalRunId=null;
    recoveredId=canonical;
    assert.equal((await advanceEvent(event,ports)).reason,'CANONICAL_RUN_UNCONFIRMED');
    assert.deepEqual(calls,[['dispatch-build','cycle',null,true]]);
  }
});

test('retains each native attempt receipt even if the first upload acknowledgement was lost',async()=>{
  const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/release-cycle-event.yml',import.meta.url),'utf8'));
  const upload=workflow.jobs['release-coordinator'].steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name,'release-cycle-${{ inputs.request_key }}-${{ github.run_attempt }}');
  assert.equal(upload.with.overwrite,undefined);
  assert.equal(workflow.concurrency.group,'steward-release-coordinator');
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
    get:async path=>{paths.push(path);return {object:{sha:source}};}});
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
  for(const code of ['CYCLE_ACTOR','BOUNDED_RUN_SOURCE','OFFICIAL_RELEASE_MERGE_RECEIPT_CONFLICT'])
    assert.equal(publicCycleError(new Error(code)),code);
  for(const error of [null,new Error('OFFICIAL_RELEASE_MERGE_RECEIPT_CONFLICT: repo details'),new Error('network response details')])
    assert.equal(publicCycleError(error),'CYCLE_EVENT_STOPPED');
});

test('push diagnostics distinguish the failing operation and keep its original failure',async()=>{
  const state={cycles:[]};
  for(const [port,stage,message,diagnostic] of [
    ['snapshot','LEDGER_READ','CYCLE_PRIVATE_VALUE','CYCLE_EVENT_STOPPED\nstage=LEDGER_READ category=UNCLASSIFIED'],
    ['get','SOURCE_READ','NATIVE_HTTP_403','CYCLE_EVENT_STOPPED\nstage=SOURCE_READ category=NATIVE_HTTP_403'],
  ]) {
    const calls=[];
    const ports={snapshot:async()=>state,get:async()=>({object:{sha:source}})};
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
