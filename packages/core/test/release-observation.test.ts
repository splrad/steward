import { describe, expect, it } from 'vitest';
import { decodeReleaseRecord, evaluateCompletion, parseReleaseRecord,
  type BusinessOutcome, type NativeAttemptEvidence, type RepositoryRecord, type CycleRecord, type CompletionSource, type CompletionEvidence } from '../src/release-observation.js';

const S='a'.repeat(40), C='b'.repeat(40), D='c'.repeat(40), H='d'.repeat(64), E='e'.repeat(64);
const cycleId=`pr-12-${S}`, start='2026-10-27T00:00:00.000Z', end='2026-10-27T00:01:00.000Z', now='2026-10-27T00:02:00.000Z';
const repository:RepositoryRecord={schemaVersion:2,repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
const cycle:CycleRecord={id:cycleId,prNumber:12,sourceSha:S,controllerSha:C,deliveryConfigSha:D,
  units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],
  requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
function wave(runId=100,runAttempt=1,outcome:BusinessOutcome='BUSINESS_FAILED',entry:NativeAttemptEvidence['entry']='build'):NativeAttemptEvidence {
  return {repositoryId:1,cycleId,workflowId:10,runId,runAttempt,entry,sourceSha:S,inputDigest:H,executorControllerSha:C,actorId:42,
    status:'completed',observedAt:now,jobsComplete:true,jobs:[{id:1,steps:[{number:1,name:'business-build',startedAt:start,completedAt:end,conclusion:'failure'}]}],
    invocations:[{jobId:1,stepNumber:1,evidence:{repositoryId:1,cycleId,workflowId:10,runId,runAttempt,entry,jobId:1,unitId:'app',channelId:null,
      invocationKey:H,inputDigest:H,startedAt:start,businessStartedProven:!['WAIT','REJECTED_BEFORE_BUSINESS'].includes(outcome),nativeEvidencePath:'evidence/native.json',outcome,completedAt:end,objectEvidencePaths:['evidence/object.json'],observedAt:now}}],
    sourceUrl:`https://api.github.com/repos/example/product/actions/runs/${runId}`,evidenceDigest:E};
}
describe('closed factual schema 2',()=>{
  it('retains a decision on its original cycle before a repair cycle exists',()=>{
    const value=structuredClone(cycle);
    value.approvedRepairDecision={eventId:1,actorId:99,createdAt:now,cycleId:value.id,sourceSha:S,
      unitIds:['app'],releaseIds:[],tags:['v1.2.3'],evidencePath:'generated/repair.json'};
    expect(parseReleaseRecord('cycle',value)).toEqual(value);
    value.approvedRepairDecision.cycleId=`pr-99-${D}`;
    expect(()=>parseReleaseRecord('cycle',value)).toThrow('repair identity');
  });
  it('allows a failed repair to record its own decision while retaining repairOf',()=>{
    const value=structuredClone(cycle);value.repairOf=`pr-1-${C}`;
    value.approvedRepairDecision={eventId:2,actorId:99,createdAt:now,cycleId:value.id,sourceSha:S,
      unitIds:['app'],releaseIds:[],tags:['v1.2.3'],evidencePath:'generated/repair.json'};
    expect(parseReleaseRecord('cycle',value).repairOf).toBe(value.repairOf);
    value.approvedRepairDecision.sourceSha=D;
    expect(()=>parseReleaseRecord('cycle',value)).toThrow('repair identity');
  });
  const buildRequest=()=>({requestKey:E,operationKey:H,purpose:'build' as const,workflowId:10,ref:`steward/build/${cycleId}`,sourceSha:S,targetKey:'fixed-target',
    inputs:{cycle_id:cycleId,operation_key:H,source_sha:S,controller_sha:C},inputDigest:H,executionSha:S,sentAt:start,searchWindows:[],canonicalRunId:null,nativeResponseEvidencePath:null,continuationOfRunId:null,retryLimitEvidencePath:null});
  it('accepts only fixed build dispatch fields and binds their source to the cycle',()=>{
    const value=structuredClone(cycle);value.dispatches=[buildRequest()];expect(parseReleaseRecord('cycle',value)).toEqual(value);
    value.dispatches[0]!.inputs.controller_sha=D;expect(()=>parseReleaseRecord('cycle',value)).toThrow('dispatch input identity');
  });
  it.each(['shell','plugin','workflow','allowed_jobs'])('rejects arbitrary dispatch input %s',field=>{
    const value=structuredClone(cycle);value.dispatches=[buildRequest()];value.dispatches[0]!.inputs[field]='unexpected';
    expect(()=>parseReleaseRecord('cycle',value)).toThrow('invalid cycle record');
  });
  it('binds channel targets to the frozen units and rejects embedded command fields',()=>{
    const value=structuredClone(cycle);value.units[0]!.releaseId=7;value.units[0]!.manifestDigest=H;
    const target={unitId:'app',channelId:'winget',version:'1.2.3',releaseId:7,manifestDigest:H};
    value.dispatches=[{...buildRequest(),purpose:'channel-submit',ref:'main',executionSha:D,inputs:{cycle_id:cycleId,operation_key:H,request_key:E,source_sha:S,execution_sha:D,controller_sha:C,mode:'submit',targets_json:JSON.stringify([target])}}];
    expect(parseReleaseRecord('cycle',value)).toEqual(value);
    value.dispatches[0]!.inputs.targets_json=JSON.stringify([{...target,shell:'run something'}]);expect(()=>parseReleaseRecord('cycle',value)).toThrow('closed fields');
    value.dispatches[0]!.inputs.targets_json=JSON.stringify([{...target,releaseId:99}]);expect(()=>parseReleaseRecord('cycle',value)).toThrow('target identity');
  });
  it('accepts an actual pre-PR candidate with explicit nulls and preserves G/H/N fields',()=>{
    const candidate={id:H,prNumber:null,branch:'release-please--branches--main',baseSha:S,generatedSnapshotPath:null,publishedHead:null,editingAckHead:null,statusCommentId:null,contentGenerationDigest:H,adoptionOverride:null,observedLabelEventIds:[],pendingWrite:null};
    expect(parseReleaseRecord('repository',{...repository,candidate})).toEqual({...repository,candidate});
    expect(parseReleaseRecord('cycle',cycle)).toEqual(cycle);
  });
  it.each(['phase','status','businessRound','failureCount','allowedJobs','nextAttempt','ignored','retired','authorizationRevision'])('rejects writable authority/cache field %s',field=>{
    expect(()=>parseReleaseRecord('repository',{...repository,[field]:1})).toThrow();
    expect(()=>parseReleaseRecord('cycle',{...cycle,[field]:1})).toThrow();
  });
  it.each([0,1,3,'2',null])('rejects unknown or unsupported state schema %j',schemaVersion=>{
    expect(()=>parseReleaseRecord('repository',{...repository,schemaVersion})).toThrow();
  });
  it.each(['{"schemaVersion":2,"schemaVersion":2}','\ufeff{}','{"a":"\\ud800"}','{"a":1e400}'])('strictly decodes raw bytes %s',source=>{
    expect(()=>decodeReleaseRecord('repository',new TextEncoder().encode(source))).toThrow();
  });
  it('rejects source/PR id mismatch and foreign required units',()=>{
    expect(()=>parseReleaseRecord('cycle',{...cycle,prNumber:13})).toThrow('cycle identity');
    expect(()=>parseReleaseRecord('cycle',{...cycle,requiredChannels:[{unitId:'other',channelId:'winget'}]})).toThrow('required channels');
  });
  it('rejects path escape and missing explicit nullable fields',()=>{
    expect(()=>parseReleaseRecord('cycle',{...cycle,completedEvidencePath:'evidence/../outside.json'})).toThrow();
    const value=structuredClone(repository) as Partial<RepositoryRecord>; delete value.activeCycleId;
    expect(()=>parseReleaseRecord('repository',value)).toThrow();
  });
  it('copies mutable caller records and rejects a result dated before its start',()=>{
    const value=structuredClone(cycle),parsed=parseReleaseRecord('cycle',value);value.units[0]!.version='changed';expect(parsed.units[0]!.version).toBe('1.2.3');
    const evidence=wave().invocations[0]!.evidence;
    expect(()=>parseReleaseRecord('executionEvidence',{...evidence,completedAt:'2026-10-26T00:00:00Z'})).toThrow('chronology');
  });
});
function completion() {
  const source:CompletionSource={repositoryId:1,cycleId,sourceSha:S,deliveryConfigSha:D,units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:7,authorId:42,manifestDigest:H,notesDigest:E,assets:[{path:'app.zip',size:12,sha256:H}]}],requiredChannels:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,private:false}]};
  const facts:CompletionEvidence={source:structuredClone(source),sourceComplete:true,observedAt:now,releasesComplete:true,channelsComplete:true,
    releases:[{...source.units[0]!,unitId:'app',sourceSha:S,draft:false,immutable:true,evidenceDigest:E} as CompletionEvidence['releases'][number]],
    channels:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,nativeObjectId:'native-pr-9',accepted:true,indexed:true,rejected:false,visible:true,observedAt:now,evidenceDigest:H}],
    consumptions:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,repositoryId:1,sourceSha:S,runId:100,jobId:10,conclusion:'success',consumedDigest:H,logDigest:E,evidenceDigest:H}],inFlightWaveKeys:[],unknownWriteKeys:[]};
  delete (facts.releases[0] as unknown as Record<string,unknown>).id;
  return {source,facts};
}
describe('four-valued completion',()=>{
  it('requires all native objects and actual consumption, independent of object key order',()=>{
    const {source,facts}=completion();expect(evaluateCompletion(source,facts,now).result).toBe('PASS');
    facts.source=JSON.parse(JSON.stringify(facts.source).replace('"repositoryId":1,','').replace('{','{"repositoryId":1,'));
    expect(evaluateCompletion(source,facts,now).result).toBe('PASS');
  });
  it.each(['source','release-read','channel-read','consumption','unknown-write'])('returns UNKNOWN for %s gaps',kind=>{
    const {source,facts}=completion();if(kind==='source')facts.sourceComplete=false;if(kind==='release-read')facts.releasesComplete=false;
    if(kind==='channel-read')facts.channelsComplete=false;if(kind==='consumption')facts.consumptions=[];if(kind==='unknown-write')facts.unknownWriteKeys=[H];
    expect(evaluateCompletion(source,facts,now)[['channel-read','consumption'].includes(kind)?'distributionResult':'result']).toBe('UNKNOWN');
  });
  it.each(['draft','mutable','missing-release','pending','invisible','live-wave','failed-consumption'])('returns WAIT for %s',kind=>{
    const {source,facts}=completion();if(kind==='draft')facts.releases[0]!.draft=true;if(kind==='mutable')facts.releases[0]!.immutable=false;if(kind==='missing-release')facts.releases=[];
    if(kind==='pending')facts.channels[0]!.indexed=false;if(kind==='invisible')facts.channels[0]!.visible=false;if(kind==='live-wave')facts.inFlightWaveKeys=[H];if(kind==='failed-consumption')facts.consumptions[0]!.conclusion='failure';
    expect(evaluateCompletion(source,facts,now)[['pending','invisible','failed-consumption'].includes(kind)?'distributionResult':'result']).toBe('WAIT');
  });
  it.each(['source','required','bytes','actor','tag','manifest','notes','rejected','digest','consumption','duplicate'])('returns CONFLICT for %s changes',kind=>{
    const {source,facts}=completion();if(kind==='source')facts.source.sourceSha=C;if(kind==='required')facts.source.requiredChannels=[];
    if(kind==='bytes')facts.releases[0]!.assets[0]!.sha256=E;if(kind==='actor')facts.releases[0]!.authorId=99;if(kind==='tag')facts.releases[0]!.tag='another';
    if(kind==='manifest')facts.releases[0]!.manifestDigest=E;if(kind==='notes')facts.releases[0]!.notesDigest=H;if(kind==='rejected')facts.channels[0]!.rejected=true;
    if(kind==='digest')facts.channels[0]!.digest=E;if(kind==='consumption')facts.consumptions[0]!.consumedDigest=E;if(kind==='duplicate')facts.releases.push(structuredClone(facts.releases[0]!));
    if(kind==='source')facts.source.cycleId=`pr-12-${C}`;
    expect(evaluateCompletion(source,facts,now)[['rejected','digest','consumption'].includes(kind)?'distributionResult':'result']).toBe('CONFLICT');
  });
  it('keeps private probe TTL tied to original observation time and accepts the exact ten-minute boundary',()=>{
    const {source,facts}=completion();source.requiredChannels[0]!.private=true;facts.source=structuredClone(source);
    expect(evaluateCompletion(source,facts,'2026-10-27T00:12:00.000Z').result).toBe('PASS');
    facts.observedAt='2026-10-27T00:12:00.001Z';expect(evaluateCompletion(source,facts,facts.observedAt).distributionResult).toBe('WAIT');
  });
  it('checks every changed unit and cannot remove a required channel to get PASS',()=>{
    const {source,facts}=completion();source.units.push({...structuredClone(source.units[0]!),id:'second'});facts.source=structuredClone(source);
    expect(evaluateCompletion(source,facts,now).result).toBe('WAIT');facts.source.requiredChannels=[];expect(evaluateCompletion(source,facts,now).result).toBe('CONFLICT');
  });
  it.each(['phase','activeCycleId','completedEvidencePath','lastCompletedCycleId'])('does not accept cached %s as authority',field=>{
    const {source,facts}=completion();expect(()=>evaluateCompletion(source,{...facts,[field]:'PASS'} as never,now)).toThrow('closed fields');
  });
});

it('keeps a pending distribution visible without blocking a verified GitHub release',()=>{const {source,facts}=completion();facts.channels=[];facts.consumptions=[];expect(evaluateCompletion(source,facts,now)).toMatchObject({result:'PASS',distributionResult:'WAIT'});});
