import { expect, it } from 'vitest';
import { selectReleaseProducers, producerArtifactName, assertReleaseJobResults, type RunIdentity, type ProducerJob, type ProducerArtifact } from '../src/release-run.js';
const unit = { id: 'app', builds: [{ id: 'windows' }, { id: 'linux' }] };
const identity: RunIdentity = { repositoryId: 1, unitId: 'app', sourceSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40), runId: 42, attempt: 2 };
const job = (buildId: string, attempt: number, conclusion = 'success'): ProducerJob => ({ id: attempt * 10 + (buildId === 'windows' ? 1 : 2), runId: 42, attempt, buildId, sourceSha: identity.sourceSha, controllerSha: identity.controllerSha, status: 'completed', conclusion });
const artifact = (buildId: string, attempt: number): ProducerArtifact => ({ id: attempt * 100 + (buildId === 'windows' ? 1 : 2), runId: 42, name: producerArtifactName(identity, buildId, attempt), expired: false, digest: 'sha256:' + 'c'.repeat(64) });
function observation() { return { complete: true, jobs: [job('windows', 1), job('linux', 1, 'failure'), job('linux', 2)], artifacts: [artifact('windows', 1), artifact('linux', 2)] }; }
it.each([{ builds: [] }, { builds: [{ id: '' }] }, { builds: [{ id: 'windows' }, { id: 'windows' }] }])('rejects an empty or ambiguous expected producer set', ({ builds }) => {
  expect(() => selectReleaseProducers({ id: 'app', builds }, identity, observation())).toThrow('expected producer set');
});
it('retains successful rows from earlier attempts in the same run', () => {
  const result = selectReleaseProducers(unit, identity, observation());
  expect(result.producers.map(p => [p.buildId, p.attempt, p.artifactId])).toEqual([['windows', 1, 101], ['linux', 2, 202]]);
  expect(selectReleaseProducers(unit, identity, { ...observation(), frozen: result })).toEqual(result);
});
it('selects the last successful result and refuses to replace frozen producers', () => {
  const input = observation(), frozen = selectReleaseProducers(unit, identity, input);
  input.jobs.push(job('windows', 2)); input.artifacts.push(artifact('windows', 2));
  expect(selectReleaseProducers(unit, identity, input).producers[0]!.artifactId).toBe(201);
  expect(() => selectReleaseProducers(unit, identity, { ...input, frozen })).toThrow('frozen');
});
it.each(['partial', 'cross-run', 'source', 'controller', 'expired', 'unknown-expiry', 'missing', 'duplicate-artifact', 'duplicate-job', 'cancelled', 'future', 'digest', 'active'])('rejects %s producer evidence', kind => {
  const input = observation();
  if (kind === 'partial') input.complete = false;
  if (kind === 'cross-run') input.artifacts[0]!.runId++;
  if (kind === 'source') input.jobs[0]!.sourceSha = 'd'.repeat(40);
  if (kind === 'controller') input.jobs[0]!.controllerSha = 'd'.repeat(40);
  if (kind === 'expired') input.artifacts[0]!.expired = true;
  if (kind === 'unknown-expiry') delete (input.artifacts[0] as Partial<ProducerArtifact>).expired;
  if (kind === 'missing') input.artifacts.pop();
  if (kind === 'duplicate-artifact') input.artifacts.push({ ...input.artifacts[0]!, id: 999 });
  if (kind === 'duplicate-job') input.jobs.push({ ...input.jobs[0]!, id: 999 });
  if (kind === 'cancelled') input.jobs[0]!.conclusion = 'cancelled';
  if (kind === 'future') input.jobs[0]!.attempt = 3;
  if (kind === 'digest') input.artifacts[0]!.digest = 'unknown';
  if (kind === 'active') input.jobs[0]!.status = 'in_progress';
  expect(() => selectReleaseProducers(unit, identity, input)).toThrow('RELEASE_RUN');
});
it('allows only deliberate signing skips and verify-only production skips', () => {
  const results = { identity: 'success', build: 'success', collect: 'success', sign: 'skipped', inspect: 'success', attest: 'success', publish: 'success' };
  expect(() => assertReleaseJobResults('build', 'none', results)).not.toThrow();
  for (const key of ['identity', 'build', 'collect', 'inspect', 'attest', 'publish']) {
    for (const status of ['skipped', 'failure', 'cancelled', '']) expect(() => assertReleaseJobResults('build', 'none', { ...results, [key]: status })).toThrow();
  }
  expect(() => assertReleaseJobResults('build', 'authenticode', results)).toThrow();
  expect(() => assertReleaseJobResults('verify', 'none', { identity: 'success', build: 'skipped', collect: 'skipped', sign: 'skipped', inspect: 'skipped', attest: 'skipped', publish: 'skipped' })).not.toThrow();
});

import { prepareChannelDispatch, channelTargetsDigest, verifyChannelProbe, selectChannelDispatch, verifyChannelResult, channelBusinessResults } from '../src/release-run.js';
import { evidenceFixture, S, C, D, START, END, NOW } from './native-evidence-fixture.js';
import { nativeRunFact, jobFact, inspectNativeCycle } from '../src/native-release-evidence.js';
import { createHash } from 'node:crypto';
import { readChannelSourceRejections, channelReadyTargets, channelPreparationResults, dispatchObservationFile } from '../src/release-run.js';
import { decodeNativeSourceRejection } from '../../core/src/native-evidence.js';
function channelFixture() {
  const f=evidenceFixture(),cycle=f.context.cycle;
  Object.assign(cycle.units[0]!,{releaseId:20,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.exe',size:3,sha256:'f'.repeat(64)}]});
  cycle.requiredChannels=[{unitId:'app',channelId:'ghcr-assets'},{unitId:'app',channelId:'winget'}];cycle.dispatches=[];
  const targets=cycle.requiredChannels.map(channel=>({...channel,version:'1.0.0',releaseId:20,manifestDigest:'d'.repeat(64)}));
  const request=prepareChannelDispatch(f.context,10,'trunk',D,'submit',targets,START);request.canonicalRunId=100;cycle.dispatches.push(request);
  const run=nativeRunFact({...f.runs.get(1),path:'.github/workflows/steward-release-channels.yml',head_sha:D,head_branch:'trunk',display_title:'Channels '+request.requestKey,conclusion:'success'});
  const job=jobFact({...f.jobs.get(1)![0],name:'observe',head_sha:D,conclusion:'success'});
  const report={schemaVersion:1 as const,cycleId:cycle.id,sourceSha:S,executionSha:D,controllerSha:C,targetsDigest:channelTargetsDigest(f.context,targets),nativeRunId:100,runAttempt:1,
    items:targets.map(target=>({unitId:target.unitId,channelId:target.channelId,version:target.version,readStatus:'PENDING' as const,exists:true,digest:null,accepted:false,indexed:false,observedAt:END,evidenceKind:'github-pr:55'}))};
  return {...f,targets,request,run,job,report};
}
it.each(['search','native-response'])('archives a moved source through %s only with complete zero-business jobs and exact rejection logs',async mode=>{
  const f=channelFixture();f.request.canonicalRunId=null;
  const native={...f.runs.get(1),head_sha:'f'.repeat(40),head_branch:'trunk',path:f.run.path,display_title:f.run.displayTitle};
  const job={...f.jobs.get(1)![0],head_sha:native.head_sha,name:'source-check',steps:[{number:2,name:'Verify native source',started_at:START,completed_at:END,conclusion:'failure'}]};
  const bytes=Buffer.from(JSON.stringify({'run-name':'Channels ${{ inputs.request_key }}',on:{workflow_dispatch:{inputs:Object.fromEntries(Object.keys(f.request.inputs).map(key=>[key,{type:'string',required:true}]))}}}));
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path.includes('/workflows/10/runs?')){expect(mode).toBe('search');expect(path).not.toContain('head_sha');return f.response({total_count:1,workflow_runs:[native]});}
    if(path.includes('/jobs?'))return f.response({total_count:1,jobs:[job]});
    if(path.endsWith('/logs'))return f.response(`${END} STEWARD_SOURCE_REJECTED {"status":"REJECTED","reason":"SOURCE_REF_MOVED"}\n`);
    if(path.includes('/contents/'))return f.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
    return f.response(native);
  }};
  const value:any={schemaVersion:1,repositoryId:f.context.repositoryId,cycleId:f.context.cycle.id,requestKey:f.request.requestKey,observedAt:NOW,
    kind:'RESPONSE',senderNonce:null,status:200,response:{workflow_run_id:native.id,run_url:`https://api.github.com/repos/${f.context.repository}/actions/runs/${native.id}`,
    html_url:`https://github.com/${f.context.repository}/actions/runs/${native.id}`},run:null,window:null,pages:[],matches:[],errorCode:null,nextCheckAt:null};
  const responses=mode==='native-response'?[{path:dispatchObservationFile(value).path,commit:D,value}]:[];
  const files=await readChannelSourceRejections(f.context,[],io,NOW,responses);expect(files).toHaveLength(1);
  const proof={path:files[0]!.path,commit:D,value:decodeNativeSourceRejection(Buffer.from(files[0]!.content))};
  expect(selectChannelDispatch(f.context,f.report.items,[],[proof]).kind).toBe('reselect');
  expect((await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[],sourceRejections:[proof]})).readObservation.disposition).toBe('COMPLETE');
  expect(await readChannelSourceRejections(f.context,[proof],io,NOW,responses)).toEqual([]);
  if(responses.length){
    await expect(readChannelSourceRejections(f.context,[],io,NOW,[{...responses[0]!,path:'evidence/dispatch/'+'0'.repeat(64)+'.json'}])).rejects.toThrow('source response provenance');
    const wrong=structuredClone(value);wrong.response.run_url='https://api.github.com/repos/other/repo/actions/runs/100';
    await expect(readChannelSourceRejections(f.context,[],io,NOW,[{path:dispatchObservationFile(wrong).path,commit:D,value:wrong}])).rejects.toThrow('source response identity');
    const other=structuredClone(value);other.response.workflow_run_id=101;other.response.run_url=other.response.run_url.replace('/100','/101');other.response.html_url=other.response.html_url.replace('/100','/101');
    await expect(readChannelSourceRejections(f.context,[],io,NOW,[...responses,{path:dispatchObservationFile(other).path,commit:D,value:other}])).rejects.toThrow('ambiguous source response');
    native.id=101;await expect(readChannelSourceRejections(f.context,[],io,NOW,responses)).rejects.toThrow('source response Run ID');native.id=100;
  }
  job.steps[0]!.name='business-submit';await expect(readChannelSourceRejections(f.context,[],io,NOW,responses)).rejects.toThrow('zero-business');
});
it.each(['active','wrong-actor','started','wrong-log','changed-ref'])('rejects %s source-rejection claims',kind=>{
  const f=channelFixture();f.request.canonicalRunId=null;
  const value:any={schemaVersion:1,repositoryId:1,cycleId:f.context.cycle.id,requestKey:f.request.requestKey,expectedExecutionSha:D,observedAt:NOW,
    workflowBlobSha:C,run:{...f.run,headSha:'f'.repeat(40)},jobs:[{...f.job,name:'source-check',headSha:'f'.repeat(40),conclusion:'failure',steps:[]}],logDigest:'f'.repeat(64),reason:'SOURCE_REF_MOVED'};
  if(kind==='active')value.run.status='in_progress';if(kind==='wrong-actor')value.run.actorId++;
  if(kind==='started')value.jobs[0].steps=[{number:2,name:'business-submit',startedAt:START,completedAt:END,conclusion:'success'}];
  if(kind==='wrong-log')value.logDigest='invalid';if(kind==='changed-ref')value.expectedExecutionSha=S;
  const content=JSON.stringify(value)+'\n',file={path:`evidence/source-rejection/${createHash('sha256').update(content).digest('hex')}.json`,commit:D,value};
  expect(()=>selectChannelDispatch(f.context,f.report.items,[],[file])).toThrow();
});
it('filters pending verify targets before native matrix expansion with zero business-start receipts',()=>{
  const f=channelFixture();f.job.name='channel-prepare';f.job.steps=[{number:3,name:'business-channel-readiness',startedAt:START,completedAt:null,conclusion:null}];
  const reads=f.report.items.map((item,i)=>({...item,accepted:i===0,indexed:i===0}));
  const ready=channelReadyTargets(f.context,f.targets,'verify',reads,NOW);expect(ready.ready).toEqual([f.targets[0]]);expect(ready.pending).toEqual([f.targets[1]]);
  const receipts=channelPreparationResults(f.context,f.request,f.run,f.job,ready.ready,END);
  expect(receipts.every(result=>!result.execution.businessStartedProven)).toBe(true);expect(receipts[1]!.reasonCode).toBe('DEPENDENCY_NOT_READY');
  expect(channelReadyTargets(f.context,f.targets,'submit',reads,NOW).ready).toHaveLength(2);
  expect(()=>channelReadyTargets(f.context,f.targets,'verify',reads,'2026-10-26T00:20:00Z')).toThrow('readiness unknown');
});
it('binds a sorted same-mode ready set to the actual non-main default branch R while retaining S',()=>{
  const f=channelFixture(),request=prepareChannelDispatch(f.context,10,'trunk',D,'verify',[...f.targets].reverse(),START);
  expect(request.ref).toBe('trunk');expect(request.executionSha).toBe(D);expect(request.sourceSha).toBe(S);
  expect(JSON.parse(request.inputs.targets_json!)).toEqual(f.targets);
  expect(request.inputs.request_key).toBe(request.requestKey);expect(request.inputs.operation_key).toBe(request.operationKey);
});
it('keeps the semantic target digest stable across execution branch revisions',()=>{
  const f=channelFixture(),a=prepareChannelDispatch(f.context,10,'trunk',D,'submit',f.targets,START),b=prepareChannelDispatch(f.context,10,'trunk','f'.repeat(40),'submit',f.targets,START);
  expect(a.requestKey).not.toBe(b.requestKey);expect(channelTargetsDigest(f.context,JSON.parse(a.inputs.targets_json!))).toBe(channelTargetsDigest(f.context,JSON.parse(b.inputs.targets_json!)));
});
it.each(['foreign-release','foreign-digest','extra-target','duplicate'])('rejects %s targets',kind=>{
  const f=channelFixture(),targets=structuredClone(f.targets);
  if(kind==='foreign-release')targets[0]!.releaseId++;
  if(kind==='foreign-digest')targets[0]!.manifestDigest='a'.repeat(64);
  if(kind==='extra-target')targets[0]!.channelId='unconfigured';
  if(kind==='duplicate')targets.push(targets[0]!);
  expect(()=>prepareChannelDispatch(f.context,10,'trunk',D,'submit',targets,START)).toThrow();
});
it('keeps accepted PR submission pending until indexing and independent consumption',()=>{
  const f=channelFixture();expect(selectChannelDispatch(f.context,f.report.items,[f.run]).kind).toBe('wait');
  const reads=f.report.items.map(item=>({...item,readStatus:'OK' as const,accepted:true,indexed:true}));
  const next=selectChannelDispatch(f.context,reads,[f.run]);expect(next.kind).toBe('new');if(next.kind==='new'){expect(next.mode).toBe('verify');expect(next.targets).toHaveLength(2);}
});
it('resumes the complete failed native request rather than shrinking its successful units',()=>{
  const f=channelFixture();f.run.conclusion='failure';
  const result=selectChannelDispatch(f.context,f.report.items,[f.run]);expect(result.kind).toBe('existing');
  if(result.kind==='existing')expect(JSON.parse(result.request.inputs.targets_json!)).toHaveLength(2);
});
it.each(['waiting','in_progress','queued'])('observes %s business without a second dispatch',status=>{
  const f=channelFixture();f.run.status=status as typeof f.run.status;expect(selectChannelDispatch(f.context,f.report.items,[f.run]).kind).toBe('existing');
});
it('indexes after 31 days using fresh observation without treating waiting as a failure',()=>{
  const f=channelFixture();const now='2026-11-26T00:02:00.000Z',start='2026-11-26T00:00:00.000Z',end='2026-11-26T00:01:00.000Z';
  f.job.startedAt=start;f.job.completedAt=end;f.report.items.forEach(item=>{item.observedAt=end;item.accepted=true;item.indexed=true;});
  expect(verifyChannelProbe(f.context,f.targets,f.report,f.run,f.job,now).fresh).toBe(true);
  const next=selectChannelDispatch(f.context,f.report.items,[f.run]);expect(next.kind).toBe('new');if(next.kind==='new')expect(next.mode).toBe('verify');
});
it('does not refresh probe time when an old artifact is read or uploaded again',()=>{
  const f=channelFixture();expect(verifyChannelProbe(f.context,f.targets,f.report,f.run,f.job,NOW).fresh).toBe(true);
  expect(verifyChannelProbe(f.context,f.targets,f.report,f.run,f.job,'2026-10-26T00:11:00.001Z').fresh).toBe(false);
});
it.each(['extra','foreign-run','foreign-source','foreign-R','future','outside-window','self-hash','oversize','duplicate'])('rejects %s probe payload',kind=>{
  const f=channelFixture(),report:any=structuredClone(f.report);
  if(kind==='extra')report.command='shell';
  if(kind==='foreign-run')report.nativeRunId++;
  if(kind==='foreign-source')report.sourceSha=D;
  if(kind==='foreign-R')report.executionSha=S;
  if(kind==='future')report.items[0].observedAt='2026-10-27T00:00:00Z';
  if(kind==='outside-window')report.items[0].observedAt='2026-10-25T23:59:59Z';
  if(kind==='self-hash')report.archiveDigest='f'.repeat(64);
  if(kind==='oversize')report.items[0].evidenceKind='x'.repeat(20000);
  if(kind==='duplicate')report.items[1]=report.items[0];
  expect(()=>verifyChannelProbe(f.context,f.targets,report,f.run,f.job,NOW)).toThrow();
});
it('retains null facts on read denial and never treats denial as absence or complete',()=>{
  const f=channelFixture(),items=f.report.items.map(item=>({...item,readStatus:'AUTH_UNKNOWN' as const,exists:null,digest:null,accepted:null,indexed:null}));
  expect(verifyChannelProbe(f.context,f.targets,{...f.report,items},f.run,f.job,NOW).fresh).toBe(true);
  expect(selectChannelDispatch(f.context,items,[f.run]).kind).toBe('unknown');
  items[0]!.exists=false as any;expect(()=>verifyChannelProbe(f.context,f.targets,{...f.report,items},f.run,f.job,NOW)).toThrow('unknown probe facts');
});
it('requires actual verify-mode native job success for consumed bytes and records actual job IDs',()=>{
  const f=channelFixture(),request=prepareChannelDispatch(f.context,10,'trunk',D,'verify',f.targets,START);request.canonicalRunId=100;
  f.run.displayTitle='Channels '+request.requestKey;f.job.name='verify/ghcr-assets/app';
  f.job.steps[0]!.name='business-ghcr-verify';f.job.steps[0]!.conclusion='success';
  const payload={...f.report,items:[{...f.targets[0],nativeObjectId:'sha256:'+'9'.repeat(64),digest:'d'.repeat(64),accepted:true,indexed:true,consumed:true,observedAt:END}]};
  expect(verifyChannelResult(f.context,request,f.run,f.job,payload).consumed).toBe(true);
  const result=channelBusinessResults(f.context,request,f.run,f.job,f.targets[0]!,NOW)[0]!;
  expect(result.execution.entry).toBe('channel');expect(result.execution.jobId).toBe(f.job.id);expect(result.execution.outcome).toBe('EFFECT_CONFIRMED');
  f.job.conclusion='failure';expect(()=>verifyChannelResult(f.context,request,f.run,f.job,payload)).toThrow();
});

it('selects exact-source producers from distinct Runs and records their actual identities',()=>{
  const input=observation();input.jobs=input.jobs.filter(job=>job.conclusion==='success');
  input.jobs[1]!.runId=77;input.jobs[1]!.attempt=5;
  input.artifacts[1]!.runId=77;input.artifacts[1]!.name=producerArtifactName({...identity,runId:77},'linux',5);
  const selected=selectReleaseProducers(unit,identity,input);
  expect(selected.producers[1]).toEqual({buildId:'linux',jobId:22,runId:77,attempt:5,artifactId:202});
  input.jobs.push({...input.jobs[1]!,id:99,runId:88});
  expect(()=>selectReleaseProducers(unit,identity,input)).toThrow('ambiguous producer run');
});
