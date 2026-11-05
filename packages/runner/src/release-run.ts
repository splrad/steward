import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { isolatedBuildEnvironment } from './build-environment.js';
import { parseDeliveryConfig } from '../../core/src/delivery-config.js';
import { join } from 'node:path';
import { downloadNativeArtifact } from './native-artifact-download.js';
import { nativeJobOrigins, withinNativeJobWindow } from '../../core/src/native-job-origins.js';
import { parseDocument } from 'yaml';
import { parseReleaseRecord, type CycleRecord } from '../../core/src/release-observation.js';
import { decodeNativeDispatchObservation, decodeNativeSourceRejection, type NativeSourceRejection, type NativeDispatchObservation, type NativeRun } from '../../core/src/native-evidence.js';
import { parseNativeResult, decodeNativeChannel, decodeNativeChannelRead, type NativeChannelRead, type NativeChannelEvidence, type NativeJob, type NativeResult } from '../../core/src/native-evidence.js';
import { normalizedDeliveryFile, verifyNormalizedDelivery } from './release-pipeline.js';
import { NativeEvidenceReader, formalReleaseReader, nativeRunFact, nativeRequestIdentity, validateEvidenceContext, EvidenceReadError, stableReleaseFacts, stableAssetFacts, sameChannelOperation,
  verifyNativeSourceRejection, inspectNativeCycle, sourceRun, type SourceRejectionFile, type RetryLimitFile, type ArchivedFile,
  jobFact, type EvidenceContext, type EvidenceTransport, type ArchiveFile } from './native-release-evidence.js';
export interface RunIdentity { repositoryId: number; unitId: string; sourceSha: string; controllerSha: string; runId: number; attempt: number }
export interface ProducerReceipt { buildId: string; jobId: number; runId?: number; attempt: number; artifactId: number }
export interface ProducerJob { id: number; runId: number; attempt: number; buildId: string; sourceSha: string; controllerSha: string; status: string; conclusion: string | null }
export interface ProducerArtifact { id: number; runId: number; name: string; expired: boolean; digest: string }
function fail(reason: string): never { throw new Error(`RELEASE_RUN: ${reason}`); }
export function producerArtifactName(identity: Pick<RunIdentity, 'repositoryId' | 'unitId' | 'sourceSha' | 'runId'>, buildId: string, attempt: number): string {
  return `release-${identity.repositoryId}-${identity.unitId}-${buildId}-${identity.sourceSha}-${identity.runId}-${attempt}`;
}
/** Select IDs from complete native job/artifact inventories, never from name search order. */
export function selectReleaseProducers(unit: { id: string; builds: readonly { id: string }[] }, identity: RunIdentity, input: {
  complete: boolean; jobs: ProducerJob[]; artifacts: ProducerArtifact[];
  frozen?: { producers: ProducerReceipt[]; digests: Record<string, string> };
}): { producers: ProducerReceipt[]; digests: Record<string, string> } {
  if (!input.complete || unit.id !== identity.unitId || ![identity.repositoryId, identity.runId, identity.attempt].every(n => Number.isSafeInteger(n) && n > 0)
    || ![identity.sourceSha, identity.controllerSha].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('identity or incomplete inventory');
  if (!Array.isArray(unit.builds) || !unit.builds.length || unit.builds.some(build => !build || typeof build.id !== 'string' || !build.id.trim())
    || new Set(unit.builds.map(build => build.id)).size !== unit.builds.length) fail('expected producer set');
  if (new Set(input.jobs.map(job => job.id)).size !== input.jobs.length || new Set(input.artifacts.map(artifact => artifact.id)).size !== input.artifacts.length) fail('duplicate native ID');
  const producers: ProducerReceipt[] = [], digests: Record<string, string> = {};
  for (const build of unit.builds) {
    const jobs = input.jobs.filter(job => job.buildId === build.id);
    if (jobs.some(job => !Number.isSafeInteger(job.runId) || job.runId < 1 || job.sourceSha !== identity.sourceSha || job.controllerSha !== identity.controllerSha
      || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.runId===identity.runId && job.attempt>identity.attempt || !Number.isSafeInteger(job.id) || job.id < 1)) fail('producer source identity');
    if (new Set(jobs.map(job => `${job.runId}:${job.attempt}`)).size !== jobs.length) fail('ambiguous job attempt');
    if(new Set(jobs.map(job=>job.runId)).size>1)fail('ambiguous producer run');
    const job = jobs.filter(job => job.status === 'completed' && job.conclusion === 'success').sort((a, b) => b.attempt - a.attempt)[0];
    if (!job) fail('missing successful build');
    if (jobs.some(other => other.status !== 'completed' && other.attempt >= job.attempt)) fail('producer still active');
    const matches = input.artifacts.filter(artifact => artifact.name === producerArtifactName({...identity,runId:job.runId}, build.id, job.attempt));
    if (matches.length !== 1) fail('missing or duplicate producer artifact');
    const artifact = matches[0]!;
    if (artifact.runId !== job.runId || artifact.expired !== false || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      || !Number.isSafeInteger(artifact.id) || artifact.id < 1) fail('artifact source or digest');
    producers.push({ buildId: build.id, jobId: job.id, ...(job.runId!==identity.runId?{runId:job.runId}:{}), attempt: job.attempt, artifactId: artifact.id }); digests[String(artifact.id)] = artifact.digest;
  }
  const result = { producers, digests };
  if (input.frozen && JSON.stringify(input.frozen) !== JSON.stringify(result)) fail('frozen release producers changed');
  return result;
}

export function assertReleaseJobResults(mode: 'build' | 'verify' | 'product', signing: 'none' | 'authenticode' | 'apple-notarized' | undefined, results: Record<string, string>) {
  if (mode === 'product') {
    for (const job of ['admit', 'build', 'sign', 'evidence', 'freeze']) if (results[job] !== 'success') fail(`unexpected ${job} result`);
    return;
  }
  if (results.identity !== 'success') fail('identity did not succeed');
  const production = ['build', 'collect', 'sign', 'inspect', 'attest', 'publish'];
  for (const job of production) {
    const expected = mode === 'verify' || (job === 'sign' && signing === 'none') ? 'skipped' : 'success';
    if (results[job] !== expected) fail(`unexpected ${job} result`);
  }
}

/** Post-step receipts use the actual native step timestamps and conclusions, including failure paths. */
export function productBusinessResults(context: EvidenceContext, request: CycleRecord['dispatches'][number], run: NativeRun,
  job: NativeJob, unitId: string, observedAt: string, objects: NativeResult['objects'] = [], notStarted: readonly number[] = []): NativeResult[] {
  verifyExecutionSource(run, { ...context, request });
  if (request.canonicalRunId !== run.id || request.purpose !== 'build'
    || job.runId !== run.id || job.runAttempt !== run.runAttempt || job.headSha !== context.cycle.sourceSha
    || !context.cycle.units.some(unit => unit.id === unitId)) fail('business result source');
  return job.steps.filter(step => step.name.startsWith('business-') && step.startedAt && step.completedAt).map(step => {
    const businessStartedProven = step.conclusion !== 'skipped' && !notStarted.includes(step.number),
      outcome = !businessStartedProven ? 'REJECTED_BEFORE_BUSINESS' : step.conclusion === 'success' ? 'EFFECT_CONFIRMED' : 'BUSINESS_FAILED';
    const invocationKey = sha256(JSON.stringify([context.repositoryId, context.cycle.id, run.workflowId, run.id, run.runAttempt,
      'build', job.id, step.number, unitId, null, request.inputDigest]));
    return parseNativeResult({ schemaVersion: 1, sourceSha: context.cycle.sourceSha, executionSha: run.headSha, stepNumber: step.number, reasonCode: 'RESULT',
      execution: { repositoryId: context.repositoryId, cycleId: context.cycle.id, workflowId: run.workflowId, runId: run.id, runAttempt: run.runAttempt,
        entry: 'build', jobId: job.id, unitId, channelId: null, invocationKey, inputDigest: request.inputDigest, startedAt: step.startedAt,
        businessStartedProven, nativeEvidencePath: `evidence/executions/${invocationKey}.json`, outcome, completedAt: step.completedAt,
        objectEvidencePaths: [], observedAt }, objects: outcome === 'EFFECT_CONFIRMED' ? objects : [] });
  });
}

type Dispatch = CycleRecord['dispatches'][number];
export function verifyDispatchWorkflow(bytes:Uint8Array,request:Pick<Dispatch,'purpose'|'inputs'>) {
  const document=parseDocument(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{uniqueKeys:true});
  if(document.errors.length)fail('dispatch workflow YAML');
  const workflow=document.toJS({maxAliasCount:0}),inputs=workflow?.on?.workflow_dispatch?.inputs;
  if(!inputs||Object.keys(inputs).sort().join(',')!==Object.keys(request.inputs).sort().join(',')
    ||Object.values(inputs).some((input:any)=>input?.type!=='string'||input.required!==true)
    ||typeof workflow['run-name']!=='string'||!workflow['run-name'].includes(request.purpose==='build'?'${{ inputs.operation_key }}':'${{ inputs.request_key }}'))fail('dispatch workflow interface');
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value)>0;
const workflowPath = (request: Dispatch) => `.github/workflows/steward-release-${request.purpose==='build'?'publish':'channels'}.yml`;
/** A title is only a search filter. Native IDs, source, actor and immutable binding are checked separately. */
export function verifyExecutionSource(actualRun: NativeRun, requestIdentity: EvidenceContext & { request: Dispatch }, frozenEvidence?: { canonicalRunId: number }) {
  const {request,repositoryId,appBotId}=requestIdentity;
  if(!validId(actualRun.id) || !validId(actualRun.runAttempt) || !validId(actualRun.triggeringActorId)
    || actualRun.repositoryId!==repositoryId || actualRun.headRepositoryId!==repositoryId || actualRun.workflowId!==request.workflowId
    || actualRun.path!==workflowPath(request) || actualRun.event!=='workflow_dispatch' || actualRun.headSha!==request.executionSha
    || actualRun.headBranch!==request.ref || actualRun.actorId!==appBotId
    || !Number.isFinite(Date.parse(actualRun.createdAt)) || Date.parse(actualRun.createdAt)<Math.floor(Date.parse(request.sentAt)/1000)*1000
    || typeof actualRun.displayTitle!=='string' || !actualRun.displayTitle.includes(request.purpose==='build'?request.operationKey:request.requestKey)
    || request.canonicalRunId!==null && actualRun.id!==request.canonicalRunId
    || frozenEvidence && actualRun.id!==frozenEvidence.canonicalRunId) fail('execution source');
  return actualRun;
}
export function prepareBuildDispatch(context: EvidenceContext, workflowId: number, sentAt: string): Dispatch {
  if(!validId(workflowId) || !Number.isFinite(Date.parse(sentAt)))fail('dispatch preparation');
  const cycle=parseReleaseRecord('cycle',context.cycle);
  const request:Dispatch={requestKey:'0'.repeat(64),operationKey:'0'.repeat(64),purpose:'build',workflowId,ref:`steward/build/${cycle.id}`,
    sourceSha:cycle.sourceSha,targetKey:'pending',inputs:{cycle_id:cycle.id,operation_key:'0'.repeat(64),source_sha:cycle.sourceSha,controller_sha:cycle.controllerSha},
    inputDigest:'0'.repeat(64),executionSha:cycle.sourceSha,sentAt:new Date(Math.floor(Date.parse(sentAt)/1000)*1000).toISOString(),searchWindows:[],canonicalRunId:null,
    nativeResponseEvidencePath:null,continuationOfRunId:null,retryLimitEvidencePath:null};
  Object.assign(request,nativeRequestIdentity(context.repositoryId,cycle,request));request.inputs.operation_key=request.operationKey;
  return request;
}

export interface ChannelTarget { unitId: string; channelId: string; version: string; releaseId: number; manifestDigest: string }
export function channelTargets(context: EvidenceContext, targets: ChannelTarget[]) {
  const sorted = structuredClone(targets).sort((a,b)=>a.unitId.localeCompare(b.unitId)||a.channelId.localeCompare(b.channelId));
  if (!sorted.length || new Set(sorted.map(target=>JSON.stringify([target.unitId,target.channelId]))).size !== sorted.length) fail('channel target set');
  for (const target of sorted) {
    const unit = context.cycle.units.find(unit=>unit.id===target.unitId);
    if (Object.keys(target).sort().join(',') !== 'channelId,manifestDigest,releaseId,unitId,version' || !unit
      || !context.cycle.requiredChannels.some(channel=>channel.unitId===target.unitId&&channel.channelId===target.channelId)
      || unit.releaseId!==target.releaseId || !validId(target.releaseId) || unit.version!==target.version
      || unit.manifestDigest!==target.manifestDigest || !/^[a-f0-9]{64}$/.test(target.manifestDigest)) fail('channel target identity');
  }
  return sorted;
}
export function channelTargetsDigest(context: EvidenceContext, targets: ChannelTarget[]) {
  return sha256(JSON.stringify([1,context.repositoryId,context.cycle.id,context.cycle.sourceSha,context.cycle.deliveryConfigSha,
    channelTargets(context,targets).map(target=>[target.unitId,target.channelId,target.version,target.releaseId,target.manifestDigest])]));
}
export function prepareChannelDispatch(context: EvidenceContext, workflowId: number, defaultBranch: string, executionSha: string,
  mode: 'submit'|'verify', targets: ChannelTarget[], sentAt: string): Dispatch {
  if (!validId(workflowId) || !/^[a-f0-9]{40}$/.test(executionSha) || !defaultBranch || defaultBranch.startsWith('refs/')
    || !['submit','verify'].includes(mode) || !Number.isFinite(Date.parse(sentAt))) fail('channel dispatch source');
  const selected=channelTargets(context,targets), request:Dispatch={requestKey:'0'.repeat(64),operationKey:'0'.repeat(64),purpose:`channel-${mode}`,
    workflowId,ref:defaultBranch,sourceSha:context.cycle.sourceSha,targetKey:'pending',executionSha,
    inputs:{cycle_id:context.cycle.id,source_sha:context.cycle.sourceSha,execution_sha:executionSha,controller_sha:context.cycle.controllerSha,
      targets_json:JSON.stringify(selected),mode,operation_key:'0'.repeat(64),request_key:'0'.repeat(64)},inputDigest:'0'.repeat(64),
    sentAt:new Date(Math.floor(Date.parse(sentAt)/1000)*1000).toISOString(),searchWindows:[],canonicalRunId:null,nativeResponseEvidencePath:null,
    continuationOfRunId:null,retryLimitEvidencePath:null};
  Object.assign(request,nativeRequestIdentity(context.repositoryId,context.cycle,request));
  request.inputs.operation_key=request.operationKey;request.inputs.request_key=request.requestKey;return request;
}
export interface ChannelReadItem {
  unitId:string;channelId:string;version:string;readStatus:'OK'|'NOT_FOUND_CONFIRMED'|'PENDING'|'AUTH_UNKNOWN'|'TRANSIENT'|'CONFLICT';
  exists:boolean|null;digest:string|null;accepted:boolean|null;indexed:boolean|null;observedAt:string;evidenceKind:string;
}
export interface ChannelProbe {
  schemaVersion:1;cycleId:string;sourceSha:string;executionSha:string;controllerSha:string;targetsDigest:string;
  nativeRunId:number;runAttempt:number;items:ChannelReadItem[];
}
type ChannelRecord={path:string;commit:string;value:any;content?:string};
export function directChannelFile(value:NativeChannelRead):ArchiveFile {
  const content=JSON.stringify(value)+'\n';decodeNativeChannelRead(Buffer.from(content));
  return {path:`evidence/channel-read/${sha256(content)}.json`,content,sha256:sha256(content)};
}
export function verifyDirectChannelRead(context:EvidenceContext,record:ChannelRecord,now:string) {
  const value=decodeNativeChannelRead(Buffer.from(JSON.stringify(record.value))),bytes=Buffer.from(value.delivery);
  if(record.path!==directChannelFile(value).path||!/^[a-f0-9]{40}$/.test(record.commit)||value.repositoryId!==context.repositoryId
    ||value.cycleId!==context.cycle.id||value.sourceSha!==context.cycle.sourceSha)fail('direct read provenance');
  const original=JSON.parse(value.delivery);
  const delivery=Object.hasOwn(original,'normalizedDelivery')
    ?verifyNormalizedDelivery(context,{path:normalizedDeliveryFile(original).path,commit:record.commit,value:original}).normalizedDelivery
    :parseDeliveryConfig(original);
  if(!Object.hasOwn(original,'normalizedDelivery')&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==context.cycle.deliveryConfigSha)fail('direct read provenance');
  const targets=channelTargets(context,value.sources.map(source=>{const unit=context.cycle.units.find(unit=>unit.id===source.unitId)!;
    return {unitId:source.unitId,channelId:source.channelId,version:source.version,releaseId:unit?.releaseId!,manifestDigest:unit?.manifestDigest!};}));
  if(value.targetsDigest!==channelTargetsDigest(context,targets))fail('direct read targets');
  const reads:ChannelReadItem[]=value.sources.map(source=>{
    const channel=delivery.units.find(unit=>unit.id===source.unitId)?.channels.find(channel=>channel.id===source.channelId);
    if(!channel||channel.location!==source.location||Date.parse(source.observedAt)>Date.parse(now))fail('direct read source');
    const item:ChannelReadItem={unitId:source.unitId,channelId:source.channelId,version:source.version,observedAt:source.observedAt,
      readStatus:'PENDING',exists:true,digest:null,accepted:false,indexed:false,evidenceKind:source.channelId};
    const raw=JSON.parse(source.body);
    if(source.kind==='GHCR') {
      if(source.channelId!=='ghcr-assets'||!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(source.location)
        ||raw.tags?.name!==source.location.slice(8)||!Array.isArray(raw.tags.tags)||raw.tags.tags.some((tag:unknown)=>typeof tag!=='string'))fail('registry inventory');
      if(!raw.tags.tags.includes(source.version)) {
        if(raw.descriptor!==null)fail('registry absence');
        Object.assign(item,{readStatus:'NOT_FOUND_CONFIRMED',exists:false});
      } else {
        if(!/^sha256:[a-f0-9]{64}$/.test(raw.descriptor?.digest)||!Number.isSafeInteger(raw.descriptor?.size)||raw.descriptor.size<1)fail('registry descriptor');
        Object.assign(item,{readStatus:'OK',digest:raw.descriptor.digest,accepted:true,indexed:true});
      }
    } else {
      const fact=context.cycle.channelFacts.find(fact=>fact.unitId===source.unitId&&fact.channelId===source.channelId);
      if(source.channelId!=='winget'||!fact?.nativeObjectId||String(raw.number)!==fact.nativeObjectId||raw.base?.repo?.full_name!=='microsoft/winget-pkgs'
        ||raw.head?.ref!==`steward/${source.location}/${source.version}`||typeof raw.merged!=='boolean'||!['open','closed'].includes(raw.state))fail('WinGet PR identity');
      if(raw.merged)fail('native index reader required');
      Object.assign(item,{evidenceKind:`github-pr:${raw.number}`,readStatus:raw.state==='closed'?'CONFLICT':'PENDING'});
    }
    return item;
  });
  return {reads,fresh:reads.every(item=>Date.parse(now)-Date.parse(item.observedAt)<=600_000)};
}
/** Combine independently timestamped direct/probe facts without refreshing their native observation time. */
export function retainedChannelObservations(context:EvidenceContext,records:ChannelRecord[],now:string) {
  const selected=new Map<string,{item:ChannelReadItem;file:ChannelRecord}>();
  for(const file of records) {
    if(file.value.cycleId!==context.cycle.id)continue;
    let checked:{reads:ChannelReadItem[];fresh:boolean};
    if(file.path.startsWith('evidence/channel-read/'))checked=verifyDirectChannelRead(context,file,now);
    else if(file.path.startsWith('evidence/channel/')&&file.value.kind==='PROBE') {
      const raw=decodeNativeChannel(Buffer.from(JSON.stringify(file.value))),payload=JSON.parse(raw.payload);
      if(file.path!==channelEvidenceFile(raw).path||!/^[a-f0-9]{40}$/.test(file.commit))fail('probe archive provenance');
      const targets=channelTargets(context,payload.items.map((item:ChannelReadItem)=>{const unit=context.cycle.units.find(unit=>unit.id===item.unitId)!;
        return {unitId:item.unitId,channelId:item.channelId,version:item.version,releaseId:unit?.releaseId!,manifestDigest:unit?.manifestDigest!};}));
      const probe=verifyChannelProbe(context,targets,payload,raw.run,raw.job,now);checked={reads:probe.report.items,fresh:probe.fresh};
    } else continue;
    if(!checked.fresh)continue;
    for(const item of checked.reads) {const key=JSON.stringify([item.unitId,item.channelId]),old=selected.get(key);
      if(old&&item.observedAt===old.item.observedAt&&JSON.stringify(item)!==JSON.stringify(old.item))fail('conflicting simultaneous channel reads');
      if(!old||item.observedAt>old.item.observedAt)selected.set(key,{item,file});}
  }
  return {reads:[...selected.values()].map(value=>value.item),files:selected};
}
export type OrasRead=(args:readonly string[])=>Promise<string>;
export async function nativeOrasRead(args:readonly string[]):Promise<string> {
  // No credential/config inheritance; only these fixed read commands are accepted.
  if(!(args.length===5&&args[0]==='repo'&&args[1]==='tags'&&args[3]==='--format'&&args[4]==='json'
    ||args.length===4&&args[0]==='manifest'&&args[1]==='fetch'&&args[2]==='--descriptor')
    ||!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9_.+-]*)?$/.test(args[0]==='repo'?args[2]!:args[3]!))fail('native registry read command');
  const home=await mkdtemp(join(tmpdir(),'steward-registry-read-'));
  try {const auth=join(home,'auth.json');await writeFile(auth,'{"auths":{}}');
    return (await promisify(execFile)('oras',[...args,'--registry-config',auth],{env:isolatedBuildEnvironment(process.env,home),encoding:'utf8',maxBuffer:2*1024*1024,timeout:60_000,windowsHide:true})).stdout;
  } finally {await rm(home,{recursive:true,force:true});}
}
export async function readDirectChannelTargets(context:EvidenceContext,targets:ChannelTarget[],io:EvidenceTransport,now:string,oras:OrasRead=nativeOrasRead,history:ChannelRecord[]=[]) {
  const reader=new NativeEvidenceReader(io,context.repository);let source:any,legacy:ReturnType<typeof verifyNormalizedDelivery>|undefined;
  try {source=await reader.json(`contents/.github/delivery.json?ref=${context.cycle.sourceSha}`);}catch(error) {
    if ((error instanceof EvidenceReadError) && error.status === 404) {
      const records=history.filter(r=>r.path.startsWith('evidence/normalized-delivery/')&&r.value.cycleId===context.cycle.id);
      if(records.length)legacy=verifyNormalizedDelivery(context,records[0]!);
    }
    if (!legacy) {
      if ((error instanceof EvidenceReadError) && [401,403,404].includes(error.status)) return {files:[] as ArchiveFile[],reads:[] as ChannelReadItem[]};
      throw error;
    }
  }
  const bytes=legacy?Buffer.from(JSON.stringify(legacy)):Buffer.from(source.content??'','base64');
  if(!legacy&&(source.type!=='file'||source.encoding!=='base64'||source.size!==bytes.length||source.sha!==context.cycle.deliveryConfigSha
    ||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==source.sha))fail('direct delivery source');
  const delivery=legacy?.normalizedDelivery??parseDeliveryConfig(JSON.parse(bytes.toString('utf8'))),sources:NativeChannelRead['sources']=[];
  for(const target of targets) {
    const channel=delivery.units.find(unit=>unit.id===target.unitId)?.channels.find(channel=>channel.id===target.channelId);
    if(!channel)fail('undeclared direct target');
    try {
      let kind:'GHCR'|'WINGET_PR',body:string;
      if(channel.id==='ghcr-assets') {
        const tags=JSON.parse(await oras(['repo','tags',channel.location,'--format','json']));
        const descriptor=Array.isArray(tags.tags)&&tags.tags.includes(target.version)?JSON.parse(await oras(['manifest','fetch','--descriptor',`${channel.location}:${target.version}`])):null;
        kind='GHCR';body=JSON.stringify({tags,descriptor});
      } else if(channel.id==='winget') {
        const fact=context.cycle.channelFacts.find(fact=>fact.unitId===target.unitId&&fact.channelId===target.channelId);
        if(typeof fact?.nativeObjectId!=='string'||!/^\d+$/.test(fact.nativeObjectId))continue;
        const pr=await new NativeEvidenceReader(io,'microsoft/winget-pkgs').json(`pulls/${fact.nativeObjectId}`);
        if(pr.merged===true)continue; // WinGet's native index lives in the product Windows job.
        kind='WINGET_PR';body=JSON.stringify({number:pr.number,state:pr.state,merged:pr.merged,head:{ref:pr.head?.ref},base:{repo:{full_name:pr.base?.repo?.full_name}}});
      } else continue;
      const evidence={unitId:target.unitId,channelId:target.channelId,version:target.version,location:channel.location,observedAt:now,kind,body};
      const single:NativeChannelRead={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,
        targetsDigest:channelTargetsDigest(context,[target]),observedAt:now,delivery:bytes.toString('utf8'),sources:[evidence]};
      verifyDirectChannelRead(context,{...directChannelFile(single),commit:'0'.repeat(40),value:single},now);
      sources.push(evidence);
    } catch { /* Unknown reads automatically use the product's least-privilege probe. */ }
  }
  if(!sources.length)return {files:[] as ArchiveFile[],reads:[] as ChannelReadItem[]};
  const selected=targets.filter(target=>sources.some(source=>source.unitId===target.unitId&&source.channelId===target.channelId));
  const value:NativeChannelRead={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,
    targetsDigest:channelTargetsDigest(context,selected),observedAt:now,delivery:bytes.toString('utf8'),sources};
  const file=directChannelFile(value),checked=verifyDirectChannelRead(context,{...file,commit:'0'.repeat(40),value},now);
  return {files:[file],reads:checked.reads};
}
export function channelReadyTargets(context:EvidenceContext,targets:ChannelTarget[],mode:'submit'|'verify',reads:ChannelReadItem[],now:string) {
  channelTargets(context,targets);
  if(reads.length!==targets.length)fail('readiness coverage');
  const ready:ChannelTarget[]=[],pending:ChannelTarget[]=[];
  for(const target of targets) {
    const matches=reads.filter(item=>item.unitId===target.unitId&&item.channelId===target.channelId),item=matches[0];
    if(matches.length!==1||!item||Object.keys(item).sort().join(',')!=='accepted,channelId,digest,evidenceKind,exists,indexed,observedAt,readStatus,unitId,version'
      ||item.version!==target.version||!Number.isFinite(Date.parse(item.observedAt))||Date.parse(item.observedAt)>Date.parse(now)
      ||Date.parse(now)-Date.parse(item.observedAt)>600_000||!['OK','PENDING','NOT_FOUND_CONFIRMED'].includes(item.readStatus)
      ||![item.exists,item.accepted,item.indexed].every(value=>typeof value==='boolean')
      ||item.readStatus==='NOT_FOUND_CONFIRMED'&&(item.exists||item.accepted||item.indexed||item.digest!==null))fail('readiness unknown');
    (mode==='submit'||item.exists&&item.accepted&&item.indexed?ready:pending).push(target);
  }
  return {ready,pending};
}
export function channelPreparationResults(context:EvidenceContext,request:Dispatch,run:NativeRun,job:NativeJob,ready:ChannelTarget[],now:string) {
  verifyExecutionSource(run,{...context,request});
  const step=job.steps.find(step=>step.name==='business-channel-readiness');
  if(request.canonicalRunId!==run.id||job.name!=='channel-prepare'||job.runId!==run.id||job.runAttempt!==run.runAttempt||job.headSha!==run.headSha||!step?.startedAt)fail('prepare native identity');
  return (JSON.parse(request.inputs.targets_json!) as ChannelTarget[]).map(target=>{
    const pending=!ready.some(value=>value.unitId===target.unitId&&value.channelId===target.channelId);
    const invocationKey=sha256(JSON.stringify([context.repositoryId,context.cycle.id,run.workflowId,run.id,run.runAttempt,'channel',job.id,step.number,target.unitId,target.channelId,request.inputDigest]));
    return parseNativeResult({schemaVersion:1,sourceSha:context.cycle.sourceSha,executionSha:run.headSha,stepNumber:step.number,reasonCode:pending?'DEPENDENCY_NOT_READY':'RESULT',
      execution:{repositoryId:context.repositoryId,cycleId:context.cycle.id,workflowId:run.workflowId,runId:run.id,runAttempt:run.runAttempt,entry:'channel',jobId:job.id,
        unitId:target.unitId,channelId:target.channelId,invocationKey,inputDigest:request.inputDigest,startedAt:step.startedAt,businessStartedProven:false,
        nativeEvidencePath:`evidence/executions/${invocationKey}.json`,outcome:'REJECTED_BEFORE_BUSINESS',completedAt:now,objectEvidencePaths:[],observedAt:now},objects:[]});
  });
}
/** A probe is read evidence only. Its age comes from the original native job, never upload/cache time. */
export function verifyChannelProbe(context:EvidenceContext,targets:ChannelTarget[],payload:unknown,run:NativeRun,job:NativeJob,now:string) {
  const report=payload as ChannelProbe, exact=(value:object,keys:string[])=>value&&Object.keys(value).sort().join(',')===keys.sort().join(',');
  if(!exact(report,['schemaVersion','cycleId','sourceSha','executionSha','controllerSha','targetsDigest','nativeRunId','runAttempt','items'])
    ||report.schemaVersion!==1||report.cycleId!==context.cycle.id||report.sourceSha!==context.cycle.sourceSha||report.controllerSha!==context.cycle.controllerSha
    ||report.targetsDigest!==channelTargetsDigest(context,targets)||report.executionSha!==run.headSha||report.nativeRunId!==run.id||report.runAttempt!==run.runAttempt
    ||run.repositoryId!==context.repositoryId||run.headRepositoryId!==context.repositoryId||run.actorId!==context.appBotId
    ||run.path!=='.github/workflows/steward-release-channels.yml'||run.event!=='workflow_dispatch'||job.runId!==run.id||job.runAttempt!==run.runAttempt
    ||job.headSha!==run.headSha||job.name!=='observe'||job.status!=='completed'||job.conclusion!=='success'||!job.startedAt||!job.completedAt
    ||!Array.isArray(report.items)||report.items.length!==targets.length||Buffer.byteLength(JSON.stringify(report))>4096+4096*targets.length) fail('probe source or bound');
  const seen=new Set<string>();let oldest=Infinity;
  for(const item of report.items) {
    const key=JSON.stringify([item.unitId,item.channelId]), target=targets.find(target=>target.unitId===item.unitId&&target.channelId===item.channelId),time=Date.parse(item.observedAt);
    if(!exact(item,['unitId','channelId','version','readStatus','exists','digest','accepted','indexed','observedAt','evidenceKind'])||!target||target.version!==item.version||seen.has(key)
      ||!['OK','NOT_FOUND_CONFIRMED','PENDING','AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(item.readStatus)||!Number.isFinite(time)||!withinNativeJobWindow(item.observedAt,job.startedAt,job.completedAt)
      ||time>Date.parse(now)||typeof item.evidenceKind!=='string'||!item.evidenceKind||item.evidenceKind.length>200)fail('probe item');
    seen.add(key);oldest=Math.min(oldest,time);
    if(['AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(item.readStatus)) {
      if([item.exists,item.digest,item.accepted,item.indexed].some(value=>value!==null))fail('unknown probe facts');
    } else {
      if(![item.exists,item.accepted,item.indexed].every(value=>typeof value==='boolean')||item.digest!==null&&!/^sha256:[a-f0-9]{64}$/.test(item.digest))fail('probe native facts');
      if(item.readStatus==='NOT_FOUND_CONFIRMED'&&(item.exists!==false||item.digest!==null||item.accepted!==false||item.indexed!==false))fail('probe absence');
      if(item.readStatus==='OK'&&item.exists!==true)fail('probe visibility');
    }
  }
  return {report:structuredClone(report),fresh:Date.parse(now)-oldest<=10*60_000,observedAt:new Date(oldest).toISOString()};
}

/** Ready targets share one native Run. Existing unresolved requests always win over a newly reduced set. */
export function selectChannelDispatch(context:EvidenceContext,reads:ChannelReadItem[],runs:NativeRun[],rejections:SourceRejectionFile[]=[]) {
  const rejected=new Set(rejections.filter(file=>file.value.cycleId===context.cycle.id).map(file=>verifyNativeSourceRejection(context,file).requestKey));
  const requestsInScope=context.cycle.dispatches.filter(value=>value.purpose!=='build'&&!rejected.has(value.requestKey));
  for(const request of requestsInScope) {
    if(context.cycle.dispatches.some(next=>next.continuationOfRunId===request.canonicalRunId&&request.canonicalRunId!==null))continue;
    if(request.canonicalRunId===null)return {kind:'existing' as const,request};
    const run=runs.find(run=>run.id===request.canonicalRunId);if(!run)return {kind:'unknown' as const};
    verifyExecutionSource(run,{...context,request});
    if(run.status!=='completed'||run.conclusion!=='success')return {kind:'existing' as const,request};
  }
  for(const request of context.cycle.dispatches.filter(value=>rejected.has(value.requestKey)).reverse()) {
    if(!requestsInScope.some(next=>sameChannelOperation(request,next)&&next.executionSha!==request.executionSha&&Date.parse(next.sentAt)>=Date.parse(request.sentAt)))return {kind:'reselect' as const,request};
  }
  const submit:ChannelTarget[]=[],verify:ChannelTarget[]=[];
  for(const channel of context.cycle.requiredChannels) {
    const unit=context.cycle.units.find(unit=>unit.id===channel.unitId)!, matches=reads.filter(read=>read.unitId===channel.unitId&&read.channelId===channel.channelId);
    if(matches.length!==1)return {kind:'unknown' as const};const read=matches[0]!;
    if(['AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(read.readStatus))return {kind:'unknown' as const};
    const target={...channel,version:unit.version,releaseId:unit.releaseId!,manifestDigest:unit.manifestDigest!};channelTargets(context,[target]);
    const requests=requestsInScope.filter(request=>JSON.parse(request.inputs.targets_json!).some((value:ChannelTarget)=>value.unitId===target.unitId&&value.channelId===target.channelId));
    if(read.exists===false&&!requests.some(request=>request.purpose==='channel-submit'))submit.push(target);
    if(read.exists&&read.accepted&&read.indexed&&!requests.some(request=>request.purpose==='channel-verify'))verify.push(target);
  }
  return verify.length?{kind:'new' as const,mode:'verify' as const,targets:verify}:submit.length?{kind:'new' as const,mode:'submit' as const,targets:submit}:{kind:'wait' as const};
}

export function channelBusinessResults(context:EvidenceContext,request:Dispatch,run:NativeRun,job:NativeJob,target:ChannelTarget,observedAt:string,objects:NativeResult['objects']=[]) {
  verifyExecutionSource(run,{...context,request});channelTargets(context,[target]);
  if(request.purpose==='build'||request.canonicalRunId!==run.id||job.runId!==run.id
    ||job.runAttempt!==run.runAttempt||job.headSha!==request.executionSha)fail('channel result source');
  return job.steps.filter(step=>step.name.startsWith('business-')&&step.startedAt&&step.completedAt).map(step=>{
    const started=step.conclusion!=='skipped',outcome=!started?'REJECTED_BEFORE_BUSINESS':step.conclusion==='success'?'EFFECT_CONFIRMED':'BUSINESS_FAILED';
    const invocationKey=sha256(JSON.stringify([context.repositoryId,context.cycle.id,run.workflowId,run.id,run.runAttempt,'channel',job.id,step.number,target.unitId,target.channelId,request.inputDigest]));
    return parseNativeResult({schemaVersion:1,sourceSha:context.cycle.sourceSha,executionSha:run.headSha,stepNumber:step.number,reasonCode:'RESULT',execution:{
      repositoryId:context.repositoryId,cycleId:context.cycle.id,workflowId:run.workflowId,runId:run.id,runAttempt:run.runAttempt,entry:'channel',jobId:job.id,
      unitId:target.unitId,channelId:target.channelId,invocationKey,inputDigest:request.inputDigest,startedAt:step.startedAt,businessStartedProven:started,
      nativeEvidencePath:`evidence/executions/${invocationKey}.json`,outcome,completedAt:step.completedAt,objectEvidencePaths:[],observedAt},objects:outcome==='EFFECT_CONFIRMED'?objects:[]});
  });
}
export function dispatchObservationFile(observation: NativeDispatchObservation): ArchiveFile {
  const content=JSON.stringify(observation,null,2)+'\n',sha256Value=sha256(content);
  decodeNativeDispatchObservation(Buffer.from(content));
  return {path:`evidence/dispatch/${sha256Value}.json`,content,sha256:sha256Value};
}
export interface DispatchStore {
  /** Atomically save the cycle and raw observation with the existing fast-forward writer, then read back. */
  save(cycle:CycleRecord, files:ArchiveFile[]):Promise<{status:string;head:string|null}>;
}
export interface DispatchHistory { complete: boolean; observations:NativeDispatchObservation[]; retryLimits?:RetryLimitFile[]; archives?:ArchivedFile[]; sourceRejections?:SourceRejectionFile[];
  publication?:NonNullable<import('./native-release-evidence.js').ReadHistory['publication']> }

/** Download and verify the original formal bytes; continuation never selects a build. */
export async function verifyContinuationReleases(context:EvidenceContext,io:EvidenceTransport) {
  const reader=await formalReleaseReader(context,io);
  for(const unit of context.cycle.units) {
    if(unit.releaseId===null||!unit.assets.length||unit.manifestDigest===null||unit.notesDigest===null)fail('frozen release required');
    const release=await reader.json(`releases/${unit.releaseId}`),assets=await reader.pages(`releases/${unit.releaseId}/assets`,'');
    if(release.id!==unit.releaseId||release.tag_name!==unit.tag||release.author?.id!==context.appBotId||release.draft!==false||release.immutable!==true
      ||typeof release.body!=='string'||sha256(release.body)!==unit.notesDigest||(await reader.json(`commits/${encodeURIComponent(unit.tag)}`)).sha!==context.cycle.sourceSha
      ||assets.length!==unit.assets.length||new Set(assets.map(asset=>asset.name)).size!==assets.length)fail('formal release identity');
    for(const asset of assets) {
      const actual=await reader.downloadDigest(`releases/assets/${asset.id}`);
      if(actual.size!==asset.size||!unit.assets.some(expected=>expected.path===asset.name&&expected.size===actual.size&&expected.sha256===actual.digest))fail('formal release bytes');
    }
    if(JSON.stringify(stableReleaseFacts(release))!==JSON.stringify(stableReleaseFacts(await reader.json(`releases/${unit.releaseId}`)))||JSON.stringify(stableAssetFacts(assets))!==JSON.stringify(stableAssetFacts(await reader.pages(`releases/${unit.releaseId}/assets`,''))))fail('formal release changed');
  }
}

async function searchDispatchRuns(context:EvidenceContext, request:Dispatch, io:EvidenceTransport, end:string, includeMoved=false) {
  const root=`/repos/${context.repository}/actions/workflows/${request.workflowId}/runs`;
  const pages:NativeDispatchObservation['pages']=[], matches=new Map<number,NativeRun>();let requests=0;
  const start=Math.floor(Date.parse(request.sentAt)/1000),last=Math.floor(Date.parse(end)/1000);
  if(last<start)fail('dispatch search chronology');
  const stamp=(seconds:number)=>new Date(seconds*1000).toISOString().replace('.000Z','Z');
  const window=async(low:number,high:number):Promise<void>=>{
    const query=new URLSearchParams({event:'workflow_dispatch',...(includeMoved?{}:{head_sha:request.executionSha}),branch:request.ref,created:`${stamp(low)}..${stamp(high)}`,per_page:'100'});
    let total:number|null=null,count=0;const seen=new Set<number>();
    for(let page=1;;page++) {
      if(++requests>200)fail('dispatch search bound');
      const path=`${root}?${query}&page=${page}`,response=await io.request('GET',path);
      if(response.status!==200)throw new EvidenceReadError(response.status,response.headers.get('retry-after'));
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));
      if(!Number.isSafeInteger(data.total_count)||data.total_count<0||!Array.isArray(data.workflow_runs)||data.workflow_runs.length>100)fail('dispatch inventory');
      if(total!==null && total!==data.total_count)fail('dispatch inventory changed');total=data.total_count;
      const ids=data.workflow_runs.map((run:any)=>run.id);
      if(ids.some((id:unknown)=>!validId(id)) || new Set(ids).size!==ids.length)fail('dispatch inventory IDs');
      pages.push({url:`https://api.github.com${path}`,totalCount:total!,runIds:ids});
      // GitHub caps filtered searches at 1000. Split even when the count is exactly 1000.
      if(total!>=1000) {
        if(low===high)fail('dispatch search saturated second');
        const middle=Math.floor((low+high)/2);await window(low,middle);await window(middle+1,high);return;
      }
      for(const raw of data.workflow_runs) {
        if(seen.has(raw.id))fail('dispatch inventory duplicate');seen.add(raw.id);count++;
        if(!Number.isFinite(Date.parse(raw.created_at)) || Date.parse(raw.created_at)<low*1000 || Date.parse(raw.created_at)>high*1000+999)fail('dispatch inventory window');
        if(typeof raw.display_title!=='string' || !raw.display_title.includes(request.purpose==='build'?request.operationKey:request.requestKey))continue;
        const fact=nativeRunFact(raw);
        try {verifyExecutionSource(fact,{...context,request:includeMoved?{...request,executionSha:fact.headSha}:request});}catch {continue;}
        if(Date.parse(fact.createdAt)<=Date.parse(end))matches.set(fact.id,fact);
      }
      if(count===total)return;
      if(count>total! || data.workflow_runs.length<100)fail('dispatch inventory incomplete');
    }
  };
  await window(start,last);
  return {pages,matches:[...matches.values()].sort((a,b)=>a.id-b.id)};
}

/** A moved ref is recoverable only after the complete native Run proves that no business step started. */
export async function readChannelSourceRejections(context:EvidenceContext,history:SourceRejectionFile[],io:EvidenceTransport,observedAt:string,
  responseHistory:{path:string;commit:string;value:NativeDispatchObservation}[]=[]) {
  const verified=new Set(history.filter(file=>file.value.cycleId===context.cycle.id).map(file=>verifyNativeSourceRejection(context,file).requestKey)),files:ArchiveFile[]=[];
  const reader=new NativeEvidenceReader(io,context.repository);
  for(const request of context.cycle.dispatches.filter(request=>request.purpose!=='build'&&request.canonicalRunId===null&&!verified.has(request.requestKey))) {
    // The archived native 200 response identifies one exact Run even when the
    // time-filtered inventory cannot expose it. Apply the same response identity
    // checks as canonical binding; never substitute a caller-provided Run ID.
    const returned=new Set<number>();
    for(const file of responseHistory.filter(file=>file.value.requestKey===request.requestKey)) {
      const value=decodeNativeDispatchObservation(Buffer.from(JSON.stringify(file.value)));
      if(!/^[a-f0-9]{40}$/.test(file.commit)||dispatchObservationFile(value).path!==file.path
        ||value.repositoryId!==context.repositoryId||value.cycleId!==context.cycle.id)fail('source response provenance');
      if(value.kind!=='RESPONSE'||value.status!==200||value.response===null)continue;
      const response=value.response;
      if(response.run_url!==`https://api.github.com/repos/${context.repository}/actions/runs/${response.workflow_run_id}`
        ||response.html_url!==`https://github.com/${context.repository}/actions/runs/${response.workflow_run_id}`)fail('source response identity');
      returned.add(response.workflow_run_id);
    }
    if(returned.size>1)fail('ambiguous source response');
    let matches:NativeRun[];
    if(returned.size) {
      const id=[...returned][0]!,run=nativeRunFact(await reader.json(`actions/runs/${id}`));
      if(run.id!==id)fail('source response Run ID');
      verifyExecutionSource(run,{...context,request:{...request,executionSha:run.headSha}});matches=[run];
    } else matches=(await searchDispatchRuns(context,request,io,observedAt,true)).matches;
    // A matching original Run, an active duplicate, or ambiguous dispatch result must still be reconciled normally.
    if(matches.length!==1)continue;
    const run=matches[0]!;
    if(run.headSha===request.executionSha||run.status!=='completed'||run.runAttempt!==1)continue;
    const jobs=(await reader.pages(`actions/runs/${run.id}/attempts/1/jobs`,'jobs')).map(jobFact);
    const source=jobs.find(job=>job.name==='source-check'&&job.conclusion==='failure');if(!source)continue;
    const logs=(await reader.response(`actions/jobs/${source.id}/logs`)).bytes;
    const markers=new TextDecoder('utf-8',{fatal:true}).decode(logs).split(/\r?\n/).flatMap(line=>{
      const match=/^\d{4}-\d\d-\d\dT\S+ STEWARD_SOURCE_REJECTED (\{.*\})$/.exec(line);
      return match?[JSON.parse(match[1]!)]:[];
    });
    if(markers.length!==1||JSON.stringify(markers[0])!==JSON.stringify({status:'REJECTED',reason:'SOURCE_REF_MOVED'}))continue;
    const workflow=await reader.json(`contents/${run.path}?ref=${run.headSha}`),bytes=Buffer.from(workflow.content??'','base64');
    if(workflow.type!=='file'||workflow.encoding!=='base64'||workflow.size!==bytes.length||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==workflow.sha)fail('source rejection workflow');
    verifyDispatchWorkflow(bytes,request);
    const value:NativeSourceRejection={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,requestKey:request.requestKey,
      expectedExecutionSha:request.executionSha,observedAt,workflowBlobSha:workflow.sha,run,jobs,logDigest:createHash('sha256').update(logs).digest('hex'),reason:'SOURCE_REF_MOVED'};
    decodeNativeSourceRejection(Buffer.from(JSON.stringify(value)));
    if(JSON.stringify(run)!==JSON.stringify(nativeRunFact(await reader.json(`actions/runs/${run.id}`)))
      ||JSON.stringify(jobs)!==JSON.stringify((await reader.pages(`actions/runs/${run.id}/attempts/1/jobs`,'jobs')).map(jobFact)))fail('source rejection changed');
    const content=JSON.stringify(value)+'\n',digest=sha256(content);files.push({path:`evidence/source-rejection/${digest}.json`,content,sha256:digest});
  }
  return files;
}

/** An unbound request can be sent only after its PREPARED observation is adopted in protected Git. */
export async function dispatchNativeRun(input:EvidenceContext, requestKey:string, store:DispatchStore, history:DispatchHistory,
  io:EvidenceTransport, observedAt=new Date().toISOString()) {
  const context=validateEvidenceContext(input),cycle=context.cycle,request=cycle.dispatches.find(value=>value.requestKey===requestKey);
  if(!request || !history.complete || !Number.isFinite(Date.parse(observedAt)))fail('dispatch history required');
  const observations=history.observations.filter(value=>value.repositoryId===context.repositoryId && value.cycleId===cycle.id && value.requestKey===requestKey)
    .map(value=>decodeNativeDispatchObservation(Buffer.from(JSON.stringify(value)))).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
  const result=(status:string,reason:string,nextCheckAt:string|null=null)=>({status,reason,canonicalRunId:request.canonicalRunId,nextCheckAt});
  if(request.canonicalRunId!==null)return result('BOUND','CANONICAL_RUN_IMMUTABLE');
  if(request.continuationOfRunId!==null)return result('BLOCKED','NATIVE_MAINTENANCE_REQUIRED');
  const reader=new NativeEvidenceReader(io,context.repository);
  const observation=(kind:NativeDispatchObservation['kind']):NativeDispatchObservation=>({schemaVersion:1,repositoryId:context.repositoryId,cycleId:cycle.id,requestKey,
    observedAt,kind,senderNonce:kind==='PREPARED'?randomBytes(16).toString('hex'):null,status:null,response:null,run:null,window:null,pages:[],matches:[],errorCode:null,nextCheckAt:null});
  const save=async(value:NativeDispatchObservation,bind?:NativeRun)=>{
    const file=dispatchObservationFile(value);
    if(bind) {verifyExecutionSource(bind,{...context,request});request.canonicalRunId=bind.id;request.nativeResponseEvidencePath=file.path;}
    if(value.kind==='SEARCH')request.searchWindows.push({...value.window!,observedAt,complete:true});
    const written=await store.save(cycle,[file]);
    if(!['APPLIED','UNCHANGED'].includes(written.status)||!written.head) {
      if(bind){request.canonicalRunId=null;request.nativeResponseEvidencePath=null;}
      return false;
    }
    observations.push(value);return written.status;
  };
  const readRun=async(id:number)=>verifyExecutionSource(nativeRunFact(await reader.json(`actions/runs/${id}`)),{...context,request});
  try {
    const repo=await reader.json('');
    if(repo.id!==context.repositoryId || repo.full_name!==context.repository || repo.archived || repo.disabled)fail('dispatch repository');
    const workflow=await reader.json(`actions/workflows/${request.workflowId}`);
    if(workflow.id!==request.workflowId || workflow.path!==workflowPath(request) || workflow.state!=='active')fail('dispatch workflow');
    const ref=await reader.json(`git/ref/heads/${request.ref}`);
    if(ref.ref!==`refs/heads/${request.ref}` || ref.object?.type!=='commit' || ref.object.sha!==request.executionSha)fail('SOURCE_REF_MOVED');
    // A previously archived 200 response remains authoritative after a lost binding write.
    const returned=observations.filter(value=>value.kind==='RESPONSE' && value.status===200 && value.response!==null);
    if(returned.length) {
      const prior=returned[0]!,run=await readRun(prior.response!.workflow_run_id),value={...observation('RESPONSE'),status:200,response:prior.response,run};
      return await save(value,run)?result('BOUND','NATIVE_RESPONSE_BOUND'):result('UNKNOWN','BINDING_NOT_ADOPTED');
    }
    const prepared=observations.filter(value=>value.kind==='PREPARED');
    if(prepared.length) {
      const found=await searchDispatchRuns(context,request,io,observedAt),value={...observation('SEARCH'),window:{start:request.sentAt,end:observedAt},...found};
      const first=found.matches[0];
      if(first) {
        const run=await readRun(first.id);
        return await save(value,run)?result('BOUND','EARLIEST_NATIVE_RUN_BOUND'):result('UNKNOWN','BINDING_NOT_ADOPTED');
      }
      if(!await save(value))return result('UNKNOWN','SEARCH_NOT_ADOPTED');
      const latest=prepared.at(-1)!,empty=observations.filter(value=>value.kind==='SEARCH' && value.matches.length===0
        && value.window?.start===request.sentAt && Date.parse(value.observedAt)>=Date.parse(latest.observedAt));
      const interval=[5,15,60][Math.min(prepared.length-1,2)]!*60_000;
      const firstEmpty=empty[0],retryAt=Math.max(Date.parse(latest.observedAt)+interval,Date.parse(firstEmpty?.observedAt??observedAt)+5*60_000,
        ...observations.map(value=>Date.parse(value.nextCheckAt??'')||0));
      if(empty.length<2 || Date.parse(observedAt)<retryAt)return result('WAIT','DISPATCH_VISIBILITY_WINDOW',new Date(retryAt).toISOString());
    } else if(observations.some(value=>value.kind!=='READ_FAILURE'))fail('dispatch preparation missing');
    const deferred=Math.max(0,...observations.map(value=>Date.parse(value.nextCheckAt??'')||0));
    if(Date.parse(observedAt)<deferred)return result('WAIT','NATIVE_RETRY_AFTER',new Date(deferred).toISOString());
    const preparedValue=observation('PREPARED');
    // UNCHANGED means another caller may already own this exact attempt. It cannot grant a second send.
    if(await save(preparedValue)!=='APPLIED')return result('UNKNOWN','DISPATCH_INTENT_NOT_NEW');
    let response;
    try {response=await io.request('POST',reader.path(`actions/workflows/${request.workflowId}/dispatches`),512*1024,{ref:request.ref,inputs:request.inputs});}
    catch {const value={...observation('RESPONSE'),errorCode:'DISPATCH_RESPONSE_LOST',nextCheckAt:new Date(Date.parse(observedAt)+5*60_000).toISOString()};
      await save(value);return result('UNKNOWN',value.errorCode,value.nextCheckAt);}
    const value=observation('RESPONSE');value.status=response.status;
    if(response.status===200) {
      try {
        const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));
        if(!validId(data.workflow_run_id) || data.run_url!==`https://api.github.com/repos/${context.repository}/actions/runs/${data.workflow_run_id}`
          || data.html_url!==`https://github.com/${context.repository}/actions/runs/${data.workflow_run_id}`)fail('dispatch response identity');
        value.response={workflow_run_id:data.workflow_run_id,run_url:data.run_url,html_url:data.html_url};
      }catch {value.errorCode='DISPATCH_RESPONSE_INVALID';}
    } else value.errorCode=`DISPATCH_HTTP_${response.status}`;
    const retryAfter=response.headers.get('retry-after'), reset=response.headers.get('x-ratelimit-reset');
    const delay=retryAfter ? (/^\d+$/.test(retryAfter)?Date.parse(observedAt)+Number(retryAfter)*1000:Date.parse(retryAfter)) : reset ? Number(reset)*1000 : 0;
    value.nextCheckAt=new Date(Math.max(Date.parse(observedAt)+5*60_000,Number.isFinite(delay)?delay:0)).toISOString();
    // Archive the original response before any read which can fail.
    if(!await save(value))return result('UNKNOWN','RESPONSE_NOT_ADOPTED',value.nextCheckAt);
    if(!value.response)return result('UNKNOWN',value.errorCode!,value.nextCheckAt);
    const run=await readRun(value.response.workflow_run_id),bound={...value,run,nextCheckAt:null};
    return await save(bound,run)?result('BOUND','NATIVE_RESPONSE_BOUND'):result('UNKNOWN','BINDING_NOT_ADOPTED');
  } catch(error) {
    const value=observation('READ_FAILURE');value.status=error instanceof EvidenceReadError?error.status:null;
    value.errorCode=error instanceof EvidenceReadError?`NATIVE_HTTP_${error.status}`:error instanceof Error && error.message.includes('SOURCE_REF_MOVED')?'SOURCE_REF_MOVED':'NATIVE_DISPATCH_EVIDENCE_UNAVAILABLE';
    const retryAfter=error instanceof EvidenceReadError?error.retryAfter:null;
    const retry=retryAfter?(/^\d+$/.test(retryAfter)?Date.parse(observedAt)+Number(retryAfter)*1000:Date.parse(retryAfter)):0;
    value.nextCheckAt=new Date(Math.max(Date.parse(observedAt)+5*60_000,Number.isFinite(retry)?retry:0)).toISOString();
    await save(value);return result(value.errorCode==='SOURCE_REF_MOVED'?'BLOCKED':'UNKNOWN',value.errorCode,value.nextCheckAt);
  }
}

export interface ChannelResultItem {
  unitId:string;channelId:string;version:string;releaseId:number;manifestDigest:string;nativeObjectId:string;digest:string;
  accepted:boolean;indexed:boolean;consumed:boolean;observedAt:string;
}
export function verifyChannelResult(context:EvidenceContext,request:Dispatch,run:NativeRun,job:NativeJob,payload:any) {
  verifyExecutionSource(run,{...context,request});
  const keys=(value:object,expected:string[])=>value&&Object.keys(value).sort().join(',')===expected.sort().join(',');
  const targets=channelTargets(context,JSON.parse(request.inputs.targets_json!));
  if(!keys(payload,['schemaVersion','cycleId','sourceSha','executionSha','controllerSha','targetsDigest','nativeRunId','runAttempt','items'])
    ||payload.schemaVersion!==1||payload.cycleId!==context.cycle.id||payload.sourceSha!==context.cycle.sourceSha||payload.controllerSha!==context.cycle.controllerSha
    ||payload.executionSha!==run.headSha||payload.targetsDigest!==channelTargetsDigest(context,targets)||payload.nativeRunId!==run.id||payload.runAttempt!==run.runAttempt
    ||job.runId!==run.id||job.runAttempt!==run.runAttempt||job.headSha!==run.headSha
    ||job.status!=='completed'||job.conclusion!=='success'||!job.startedAt||!job.completedAt||!Array.isArray(payload.items)||payload.items.length!==1)fail('channel result identity');
  const item=payload.items[0] as ChannelResultItem,target=targets.find(target=>target.unitId===item.unitId&&target.channelId===item.channelId);
  if(!keys(item,['unitId','channelId','version','releaseId','manifestDigest','nativeObjectId','digest','accepted','indexed','consumed','observedAt'])||!target
    ||item.version!==target.version||item.releaseId!==target.releaseId||item.manifestDigest!==target.manifestDigest||item.digest!==target.manifestDigest
    ||typeof item.nativeObjectId!=='string'||!item.nativeObjectId||![item.accepted,item.indexed,item.consumed].every(value=>typeof value==='boolean')
    ||!Number.isFinite(Date.parse(item.observedAt))||!withinNativeJobWindow(item.observedAt,job.startedAt,job.completedAt)
    ||job.name!==`${request.inputs.mode}/${item.channelId}/${item.unitId}`||item.consumed&&request.purpose!=='channel-verify'
    ||request.purpose==='channel-verify'&&(!item.consumed||!item.accepted||!item.indexed))fail('channel result native fields');
  return structuredClone(item);
}
export function channelEvidenceFile(value:NativeChannelEvidence):ArchiveFile {
  const content=JSON.stringify(value)+'\n',sha=sha256(content);decodeNativeChannel(Buffer.from(content));
  return {path:`evidence/channel/${sha}.json`,content,sha256:sha};
}
/** Read only artifacts produced by the exact trusted job, including upload responses lost before collect. */
export async function readChannelArtifacts(context:EvidenceContext,run:NativeRun,targets:ChannelTarget[],request:Dispatch|null,
  root:string,controllerDirectory:string,token:string,io:EvidenceTransport,now:string) {
  const reader=new NativeEvidenceReader(io,context.repository),attempts=await reader.jobAttempts(run.id,run.runAttempt),
    jobs=nativeJobOrigins(attempts).filter(({job})=>job.runAttempt===run.runAttempt).map(({origin})=>origin),
    artifacts=await reader.pages(`actions/runs/${run.id}/artifacts`,'artifacts'),files:ArchiveFile[]=[],reads:ChannelReadItem[]=[],results:ChannelResultItem[]=[];
  if(jobs.some(job=>job.headSha!==run.headSha))fail('channel job source');
  const digest=channelTargetsDigest(context,targets),expected=request
    ?targets.map(target=>({prefix:`channel-${request.requestKey}-${target.unitId}-${target.channelId}-${run.id}`,job:`${request.inputs.mode}/${target.channelId}/${target.unitId}`}))
    :[{prefix:`probe-${context.cycle.id}-${digest}-${run.id}`,job:'observe'}];
  for(const entry of expected) {
    const nativeJobs=jobs.filter(job=>job.name===entry.job);
    if(!nativeJobs.length)continue;
    if(nativeJobs.length!==1)fail('ambiguous channel artifact');
    const originRun=nativeJobs[0]!.runAttempt===run.runAttempt?run:nativeRunFact(await reader.json(`actions/runs/${run.id}/attempts/${nativeJobs[0]!.runAttempt}`));
    if(originRun.id!==run.id||originRun.runAttempt!==nativeJobs[0]!.runAttempt||originRun.headSha!==run.headSha||originRun.workflowId!==run.workflowId)fail('channel origin run');
    const matching=artifacts.filter(artifact=>artifact.name===`${entry.prefix}-${originRun.runAttempt}`);
    if(!matching.length)continue;
    if(matching.length!==1||nativeJobs.length!==1)fail('ambiguous channel artifact');
    const artifact=matching[0],job=nativeJobs[0]!;
    if(request===null&&(artifact.expired===true||job.status==='completed'&&job.conclusion!=='success'))continue;
    if(artifact.workflow_run?.id!==run.id||artifact.workflow_run?.head_sha!==run.headSha||artifact.expired!==false||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      ||job.status!=='completed'||job.conclusion!=='success'||!job.startedAt||!job.completedAt
      ||Date.parse(artifact.created_at)<=Date.parse(job.startedAt)||Date.parse(artifact.created_at)>Date.parse(job.completedAt))fail('channel artifact provenance');
    const home=join(root,String(artifact.id)),directory=join(root,`report-${artifact.id}`);await mkdir(root,{recursive:true});
    await downloadNativeArtifact({fullName:context.repository,artifactId:artifact.id,digest:artifact.digest,names:['report.json'],directory,policyDirectory:controllerDirectory,home},token);
    const payload=await readFile(join(directory,'report.json'),'utf8');
    if(Buffer.byteLength(payload)>4096+4096*targets.length)fail('probe size bound');
    const current=await reader.json(`actions/artifacts/${artifact.id}`);
    if(JSON.stringify([current.id,current.name,current.digest,current.workflow_run,current.created_at,current.expired])!==JSON.stringify([artifact.id,artifact.name,artifact.digest,artifact.workflow_run,artifact.created_at,artifact.expired]))fail('channel artifact changed');
    const value:NativeChannelEvidence={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,observedAt:now,
      kind:request?'RESULT':'PROBE',run:originRun,job,artifact:{id:artifact.id,name:artifact.name,digest:artifact.digest,createdAt:artifact.created_at},payload};
    if(request)results.push(verifyChannelResult(context,request,originRun,job,JSON.parse(payload)));
    else {const checked=verifyChannelProbe(context,targets,JSON.parse(payload),originRun,job,now);if(checked.fresh)reads.push(...checked.report.items);}
    files.push(channelEvidenceFile(value));
  }
  return {files,reads,results};
}

/** Short read-only probe Runs own credentials and native index tools unavailable to the central reader. */
export async function observeNativeChannels(context:EvidenceContext,history:ChannelRecord[],
  root:string,controllerDirectory:string,token:string,io:EvidenceTransport,now:string,oras:OrasRead=nativeOrasRead) {
  const reader=new NativeEvidenceReader(io,context.repository),repository=await reader.json('');
  if(repository.id!==context.repositoryId||repository.full_name!==context.repository||repository.archived!==false||repository.disabled!==false)fail('channel repository');
  const allTargets=channelTargets(context,context.cycle.requiredChannels.map(channel=>{
    const unit=context.cycle.units.find(unit=>unit.id===channel.unitId)!;return {...channel,version:unit.version,releaseId:unit.releaseId!,manifestDigest:unit.manifestDigest!};
  }));
  const files:ArchiveFile[]=[],results:{item:ChannelResultItem;evidence:NativeChannelEvidence;path:string}[]=[],runs:NativeRun[]=[];
  for(const record of history.filter(record=>record.value.cycleId===context.cycle.id&&record.value.kind==='RESULT')) {
    const value=decodeNativeChannel(Buffer.from(JSON.stringify(record.value))),request=context.cycle.dispatches.find(request=>request.canonicalRunId===value.run.id);
    if(!request||channelEvidenceFile(value).path!==record.path)fail('archived channel provenance');
    results.push({item:verifyChannelResult(context,request,value.run,value.job,JSON.parse(value.payload)),evidence:value,path:record.path});
  }
  for(const request of context.cycle.dispatches.filter(request=>request.purpose!=='build'&&request.canonicalRunId!==null)) {
    let run:NativeRun;
    try {run=verifyExecutionSource(nativeRunFact(await reader.json(`actions/runs/${request.canonicalRunId}`)),{...context,request});}
    catch(error) {
      // An archived successful observation remains evidence, never a new execution or reset of failures.
      const prior=history.filter(record=>record.value.kind==='RESULT'&&record.value.run.id===request.canonicalRunId).sort((a,b)=>b.value.run.runAttempt-a.value.run.runAttempt)[0];
      if (!((error instanceof EvidenceReadError) && [404,410].includes(error.status)) || !prior) throw error;
      // An authorized, complete inventory distinguishes deletion from an inaccessible Run.
      const inventory=await reader.pages(`actions/workflows/${request.workflowId}/runs`,'workflow_runs');
      if(inventory.some(value=>value.id===request.canonicalRunId))throw error;
      run=prior.value.run;
    }
    runs.push(run);
    if(run.status==='completed'&&!history.some(record=>record.value.kind==='RESULT'&&record.value.run.id===run.id&&record.value.run.runAttempt===run.runAttempt)) {
      const observed=await readChannelArtifacts(context,run,JSON.parse(request.inputs.targets_json!),request,join(root,`business-${run.id}-${run.runAttempt}`),controllerDirectory,token,io,now);
      files.push(...observed.files);
      for(const file of observed.files){const value=decodeNativeChannel(Buffer.from(file.content));results.push({item:verifyChannelResult(context,request,run,value.job,JSON.parse(value.payload)),evidence:value,path:file.path});}
    }
  }
  const workflow=await reader.json('actions/workflows/steward-release-channels.yml');
  if(workflow.path!=='.github/workflows/steward-release-channels.yml'||workflow.state!=='active')fail('channel workflow unavailable');
  const executionSha=(await reader.json(`commits/${encodeURIComponent(repository.default_branch)}`)).sha;
  const direct=await readDirectChannelTargets(context,allTargets,io,now,oras,history);files.push(...direct.files);
  const targets=allTargets.filter(target=>!direct.reads.some(item=>item.unitId===target.unitId&&item.channelId===target.channelId));
  if(!targets.length)return {files,results,runs,reads:direct.reads,probe:'OBSERVED' as const,executionSha,defaultBranch:repository.default_branch,workflowId:workflow.id};
  const digest=channelTargetsDigest(context,targets);
  const requestKey=sha256(JSON.stringify(['observe',digest,executionSha]));
  const inputs={cycle_id:context.cycle.id,source_sha:context.cycle.sourceSha,execution_sha:executionSha,controller_sha:context.cycle.controllerSha,
    targets_json:JSON.stringify(targets),mode:'observe',operation_key:digest,request_key:requestKey};
  const workflowFile=await reader.json(`contents/${workflow.path}?ref=${executionSha}`);
  const workflowBytes=Buffer.from(workflowFile.content??'','base64');
  if(workflowFile.type!=='file'||workflowFile.encoding!=='base64'||workflowFile.size!==workflowBytes.length
    ||createHash('sha1').update(`blob ${workflowBytes.length}\0`).update(workflowBytes).digest('hex')!==workflowFile.sha)fail('probe workflow source');
  verifyDispatchWorkflow(workflowBytes,{purpose:'channel-submit',inputs});
  const matches=new Map<number,NativeRun>();
  const readWindow=async(start:number,end:number):Promise<void>=>{
    const query=new URLSearchParams({event:'workflow_dispatch',branch:repository.default_branch,head_sha:executionSha,
      created:`${new Date(start).toISOString()}..${new Date(end).toISOString()}`,per_page:'100'});
    const first=await reader.json(`actions/workflows/${workflow.id}/runs?${query}`);
    if(!Number.isSafeInteger(first.total_count)||first.total_count<0)fail('probe inventory');
    if(first.total_count>=1000){if(end-start<2000)fail('probe saturated second');const middle=Math.floor((start+end)/2000)*1000;await readWindow(start,middle);await readWindow(middle+1000,end);return;}
    for(const raw of await reader.pages(`actions/workflows/${workflow.id}/runs?${query}`,'workflow_runs')) {
      const run=nativeRunFact(raw);
      if(!run.displayTitle.includes(requestKey))continue;
      if(run.repositoryId!==context.repositoryId||run.headRepositoryId!==context.repositoryId||run.workflowId!==workflow.id||run.headSha!==executionSha
        ||run.headBranch!==repository.default_branch||run.path!==workflow.path||run.event!=='workflow_dispatch'||run.actorId!==context.appBotId)fail('probe Run identity');
      matches.set(run.id,run);
    }
  };
  await readWindow(Date.parse(now)-30*60*60_000,Date.parse(now));
  // Include all in-flight statuses regardless of age; no recent-N cap can hide a waiting probe.
  for(const status of ['requested','queued','pending','waiting','in_progress']) {
    for(const raw of await reader.pages(`actions/workflows/${workflow.id}/runs?event=workflow_dispatch&status=${status}&head_sha=${executionSha}`,'workflow_runs')) {
      const run=nativeRunFact(raw);if(run.displayTitle.includes(requestKey)&&run.actorId===context.appBotId&&run.headBranch===repository.default_branch)matches.set(run.id,run);
    }
  }
  for(const run of [...matches.values()].sort((a,b)=>b.id-a.id)) {
    if(run.status!=='completed')return {files,results,runs,reads:direct.reads,probe:'WAIT' as const,executionSha,defaultBranch:repository.default_branch,workflowId:workflow.id};
    const old=history.find(record=>record.value.kind==='PROBE'&&record.value.run.id===run.id&&record.value.run.runAttempt===run.runAttempt);
    if(old) {
      const checked=verifyChannelProbe(context,targets,JSON.parse(old.value.payload),old.value.run,old.value.job,now);
      if(checked.fresh)return {files,results,runs,reads:[...direct.reads,...checked.report.items],probe:'OBSERVED' as const,executionSha,defaultBranch:repository.default_branch,workflowId:workflow.id};
      continue;
    }
    const observed=await readChannelArtifacts(context,run,targets,null,join(root,`probe-${run.id}-${run.runAttempt}`),controllerDirectory,token,io,now);
    files.push(...observed.files);
    if(observed.reads.length===targets.length)return {files,results,runs,reads:[...direct.reads,...observed.reads],probe:'OBSERVED' as const,executionSha,defaultBranch:repository.default_branch,workflowId:workflow.id};
  }
  if((await reader.json(`commits/${encodeURIComponent(repository.default_branch)}`)).sha!==executionSha)fail('probe source moved');
  // No business request or budget is written for this read-only dispatch. Lost responses are found by the same semantic key on the next wake.
  try {await io.request('POST',`/repos/${context.repository}/actions/workflows/${workflow.id}/dispatches`,512*1024,{ref:repository.default_branch,inputs});}catch{/* Next wake reconciles matching native Runs. */}
  return {files,results,runs,reads:direct.reads,probe:'REQUESTED' as const,executionSha,defaultBranch:repository.default_branch,workflowId:workflow.id};
}
