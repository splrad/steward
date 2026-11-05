import { decodeSettingsReport } from './settings-report.js';
import { decodeMaintenanceRecord } from './maintenance.js';
import { decodePagesMaintenance } from './pages-maintenance.js';
import { decodeCompletionArchive } from './release-history.js';
import { decodeQualityCache } from './quality-language-summary.js';
import { decodeCandidateArchive } from './release-candidate-record.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from '../../../schema/release-state.schema.json' with { type: 'json' };
import historicalRepositorySchema from '../../../schema/repository-state-v2.schema.json' with { type: 'json' };
import { assertDeliveryPath } from './delivery-config.js';
import { decodeBuildJson } from './build-manifest.js';
import { sha256Hex } from './fingerprint.js';
import { decodeNativeArchive, decodeNativeReadObservation, decodeNativeDispatchObservation, decodeNativeRetryLimit, decodeNativePublication, decodeNativeChannel, decodeNativeChannelRead, decodeNormalizedDelivery, decodeNativeSourceRejection } from './native-evidence.js';

const ajv = new Ajv2020({ strict: true });
(addFormatsModule as unknown as typeof import('ajv-formats').default)(ajv);
ajv.addSchema(schema);
const validators = Object.fromEntries(['repository', 'cycle', 'executionEvidence', 'health', 'bootstrap'].map(name => [name,
  ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })]));
const historicalRepositoryValidator=ajv.compile(historicalRepositorySchema);
const fail = (reason: string): never => { throw new Error(`RELEASE_OBSERVATION: ${reason}`); };
const integer = (value: number) => Number.isSafeInteger(value) && value > 0;
const sha = (value: string) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value.length === 40;
const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
function time(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('UTC timestamp');
  const canonical=value.replace(/(?:\.(\d{1,3}))?Z$/,(_,fraction:string|undefined)=>`.${(fraction??'').padEnd(3,'0')}Z`);
  if (new Date(Date.parse(value)).toISOString()!==canonical) fail('UTC timestamp');
  return Date.parse(value);
}
function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }
function exact(value: object, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('closed fields');
}
interface RepositoryFields {
  repositoryId: number; defaultBranch: string; revision: number;
  lastObservedDefaultSha: string | null; lastCompletedCycleId: string | null; activeCycleId: string | null;
  candidate: null | { id: string; prNumber: number | null; branch: string; baseSha: string; generatedSnapshotPath: string | null;
    publishedHead: string | null; editingAckHead?: string | null; statusCommentId: number | null; contentGenerationDigest: string;
    adoptionOverride: object | null; observedLabelEventIds: number[]; pendingWrite: object | null };
  nextCheckAt: string | null; lastProgressAt: string | null; lastErrorCode: string | null;
}
export type RepositoryRecord = RepositoryFields & ({schemaVersion:3;releaseAdoption:{sourceSha:string;prNumber:number}} | {schemaVersion:2;releaseAdoption?:never});
export function assertRepositoryWrite(value: RepositoryRecord, previous?: RepositoryRecord | null): asserts value is RepositoryFields & {schemaVersion:3;releaseAdoption:{sourceSha:string;prNumber:number}} {
  if(!value||value.schemaVersion!==3)throw new Error('RELEASE_OBSERVATION: historical repository is read-only');
  if(previous?.schemaVersion===3&&(value.releaseAdoption.sourceSha!==previous.releaseAdoption.sourceSha||value.releaseAdoption.prNumber!==previous.releaseAdoption.prNumber))fail('release adoption changed');
}
export interface CycleUnit { id: string; version: string; tag: string; releaseId: number | null; assets: { id: string; path: string; size: number; sha256: string }[]; notesDigest: string | null; manifestDigest: string | null }
export interface CycleRecord {
  id: string; prNumber: number; sourceSha: string; controllerSha: string; deliveryConfigSha: string; units: CycleUnit[];
  requiredChannels: { unitId: string; channelId: string }[];
  dispatches: { requestKey: string; operationKey: string; purpose: 'build' | 'channel-submit' | 'channel-verify'; workflowId: number;
    ref: string; sourceSha: string; targetKey: string; inputs: Record<string, string>; inputDigest: string; executionSha: string;
    sentAt: string; searchWindows: { start: string; end: string; observedAt: string; complete: boolean }[]; canonicalRunId: number | null;
    nativeResponseEvidencePath: string | null; continuationOfRunId: number | null; retryLimitEvidencePath: string | null }[];
  publications: { unitId: string; tag: string; sourceSha: string; manifestDigest: string; releaseId: number | null; centralRunId: number; centralRunAttempt: number;
    draftBeforeIds: number[]; firstSentAt: string; expectedBodyDigest: string; observedAt: string }[];
  channelFacts: { unitId: string; channelId: string; [key: string]: unknown }[];
  executionEvidence: { waveKey: string; runId: number; runAttempt: number; workflowId: number; jobIds: number[]; executorControllerSha: string; nativeEvidencePath: string; outcomeEvidencePath: string | null; observedAt: string }[];
  completionObservations: { inputSetDigest: string; evidenceSetDigest: string; observedAt: string; evidencePath: string }[];
  completedEvidencePath: string | null; repairOf: string | null; approvedRepairDecision: { cycleId: string; sourceSha: string; [key: string]: unknown } | null;
}
export type BusinessOutcome = 'WAIT' | 'UNKNOWN' | 'BUSINESS_FAILED' | 'EFFECT_CONFIRMED' | 'REJECTED_BEFORE_BUSINESS' | 'FACT_CONFLICT';
export interface ExecutionEvidence {
  repositoryId: number; cycleId: string; workflowId: number; runId: number; runAttempt: number; entry: 'build' | 'channel' | 'publish';
  jobId: number | null; unitId: string | null; channelId: string | null; invocationKey: string; inputDigest: string;
  startedAt: string; businessStartedProven: boolean; nativeEvidencePath: string; outcome: BusinessOutcome | null;
  completedAt: string | null; objectEvidencePaths: string[]; observedAt: string;
}
interface RecordKinds { repository: RepositoryRecord; cycle: CycleRecord; executionEvidence: ExecutionEvidence }
/** Paths select the decoder. Schema versions and cached phase flags never select execution. */
export function parseReleaseRecord<K extends keyof RecordKinds>(kind: K, value: unknown): RecordKinds[K] {
  const validate = kind==='repository'&&(value as {schemaVersion?:number})?.schemaVersion===2?historicalRepositoryValidator:validators[kind];
  if (!validate || !validate(value)) fail(`invalid ${kind} record: ${ajv.errorsText(validate?.errors)}`);
  const walk = (node: unknown, key = '') => {
    if (typeof node === 'string' && (key.endsWith('Path') || key === 'path' || key === 'objectEvidencePaths')) {
      try { assertDeliveryPath(node); } catch { fail('evidence path'); }
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, key); }
    else if (node && typeof node === 'object') for (const [key, item] of Object.entries(node)) walk(item, key);
  };
  walk(value);
  if (kind === 'repository') {
    const record = value as RepositoryRecord;
    if (record.candidate && !unique(record.candidate.observedLabelEventIds)) fail('duplicate label event');
  }
  if (kind === 'cycle') {
    const record = value as CycleRecord;
    if (record.id !== `pr-${record.prNumber}-${record.sourceSha}` || !record.units.length || !unique(record.units.map(unit => unit.id))) fail('cycle identity');
    const pair = (value: { unitId: string; channelId: string }) => JSON.stringify([value.unitId, value.channelId]);
    if (!unique(record.requiredChannels.map(pair)) || record.requiredChannels.some(item => !record.units.some(unit => unit.id === item.unitId))) fail('required channels');
    for (const unit of record.units) if (!unique(unit.assets.map(asset => asset.id)) || !unique(unit.assets.map(asset => asset.path.toLowerCase()))) fail('duplicate asset');
    if (!unique(record.dispatches.map(item => item.requestKey))) fail('duplicate request');
    for (const request of record.dispatches) {
      if (request.sourceSha !== record.sourceSha || request.canonicalRunId !== null && request.nativeResponseEvidencePath === null
        || (request.continuationOfRunId === null) !== (request.retryLimitEvidencePath === null)) fail('dispatch evidence');
      const inputs=request.inputs;
      if (inputs.cycle_id!==record.id || inputs.source_sha!==record.sourceSha || inputs.controller_sha!==record.controllerSha
        || inputs.operation_key!==request.operationKey) fail('dispatch input identity');
      if (request.purpose==='build') {
        exact(inputs,['cycle_id','operation_key','source_sha','controller_sha']);
        if(request.executionSha!==record.sourceSha || request.ref!==`steward/build/${record.id}`) fail('build dispatch source');
      } else {
        exact(inputs,['cycle_id','operation_key','request_key','source_sha','execution_sha','controller_sha','mode','targets_json']);
        if(inputs.request_key!==request.requestKey || inputs.execution_sha!==request.executionSha || request.purpose!==`channel-${inputs.mode}`) fail('channel dispatch source');
        const targets=decodeBuildJson(new TextEncoder().encode(inputs.targets_json));
        if(!Array.isArray(targets) || !targets.length) return fail('channel targets');
        for(const target of targets) {
          exact(target,['unitId','channelId','version','releaseId','manifestDigest']);
          const unit=record.units.find(unit=>unit.id===target.unitId);
          if(!unit || !/^[a-z][a-z0-9-]*$/.test(target.channelId) || target.version!==unit.version || !integer(target.releaseId)
            || target.releaseId!==unit.releaseId || !digest(target.manifestDigest) || target.manifestDigest!==unit.manifestDigest) fail('channel target identity');
        }
        if(!unique(targets.map(pair))) fail('duplicate channel target');
      }
      for (const window of request.searchWindows) if (time(window.end) < time(window.start) || time(window.observedAt) < time(window.end)) fail('search window');
    }
    const decision = record.approvedRepairDecision;
    // A cycle first carries the decision that admitted it. If that repair also
    // fails, its own newly verified decision is retained here; the admission
    // edge remains recoverable from the protected cycle history.
    if (record.repairOf === record.id || record.repairOf !== null && decision === null
      || decision !== null && decision.cycleId !== record.id && decision.cycleId !== record.repairOf
      || decision?.cycleId === record.id && decision.sourceSha !== record.sourceSha) fail('repair identity');
  }
  if (kind === 'executionEvidence') {
    const record = value as ExecutionEvidence;
    if (time(record.observedAt) < time(record.startedAt) || record.completedAt && (time(record.completedAt) < time(record.startedAt) || time(record.completedAt) > time(record.observedAt))) fail('execution chronology');
  }
  return structuredClone(value) as RecordKinds[K];
}
export function decodeReleaseRecord<K extends keyof RecordKinds>(kind: K, bytes: Uint8Array): RecordKinds[K] {
  return parseReleaseRecord(kind, decodeBuildJson(bytes));
}

/** Fixed path ownership is a caller boundary, not a replacement for native App permissions. */
export function stateRecordOwner(targetRef: string, path: string): 'release' | 'quality' | 'settings' | 'bootstrap' | 'pages' | 'health' | 'maintenance' {
  assertDeliveryPath(path);
  if(path.split('/').some(part=>/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) return fail('state device path');
  if (targetRef==='steward/release-state') {
    if (path==='state.json' || /^cycles\/pr-[1-9][0-9]*-[a-f0-9]{40}\.json$/.test(path)
      || /^(?:generated|content)\/[A-Za-z0-9_/-]+\.md$/.test(path)
      || /^(?:generated|content)\/[A-Za-z0-9_/-]+\.json$/.test(path)
      || /^evidence\/executions\/[a-f0-9]{64}\.json$/.test(path)
      || /^evidence\/reads\/[a-f0-9]{64}\.json$/.test(path)
      || /^evidence\/(?:dispatch|retry-limit|publication|completion|channel|channel-read|normalized-delivery|source-rejection)\/[a-f0-9]{64}\.json$/.test(path)
      || /^evidence\/native\/[1-9][0-9]*-[1-9][0-9]*\/[a-f0-9]{64}\.json$/.test(path)) return 'release';
    if (/^maintenance\/[A-Za-z0-9_-]+\.json$/.test(path)) return 'maintenance';
  }
  if (targetRef==='steward/governance-state') {
    if (/^quality\/[1-9][0-9]*(?:\/[a-f0-9]{40}\.md|\.json)$/.test(path)) return 'quality';
    if (/^settings\/[1-9][0-9]*-[1-9][0-9]*\.(?:md|json)$/.test(path)) return 'settings';
    if (/^bootstrap\/[1-9][0-9]*-[1-9][0-9]*\.json$/.test(path)) return 'bootstrap';
    if (/^maintenance\/pages\/(?:[1-9][0-9]*|dispatch-[a-f0-9]{64})\.json$/.test(path)) return 'pages';
  }
  if (targetRef==='steward/automation-health' && path==='health.json') return 'health';
  return fail('state path ownership');
}

/** Decode only implemented domain contracts. A future owner cannot pass arbitrary JSON. */
export function decodeStateFile(targetRef: string, path: string, bytes: Uint8Array, repositoryId: number): unknown {
  if (!integer(repositoryId) || bytes.byteLength>512*1024) return fail('state file bound');
  const owner=stateRecordOwner(targetRef,path);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if (text.startsWith('\ufeff') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
    || text.includes('\r') && !(owner==='quality' && path.endsWith('.md'))) return fail('state UTF-8 LF');
  if (path.endsWith('.md')) return text;
  if (owner==='release') {
    if(path.startsWith('generated/') || path.startsWith('content/')) return decodeCandidateArchive(bytes,repositoryId);
    if(path.startsWith('evidence/completion/')) {
      const record=decodeCompletionArchive(bytes);
      if(record.repositoryId!==repositoryId)return fail('completion repository');
      return record;
    }
    if(path.startsWith('evidence/source-rejection/')) {
      const record=decodeNativeSourceRejection(bytes);if(record.repositoryId!==repositoryId)return fail('source rejection repository');return record;
    }
    if(path.startsWith('evidence/normalized-delivery/')) {
      const record=decodeNormalizedDelivery(bytes);if(record.repositoryId!==repositoryId)return fail('normalized delivery repository');return record;
    }
    if(path.startsWith('evidence/channel-read/')) {
      const record=decodeNativeChannelRead(bytes);if(record.repositoryId!==repositoryId)return fail('channel read repository');return record;
    }
    if(path.startsWith('evidence/channel/')) {
      const record=decodeNativeChannel(bytes);if(record.repositoryId!==repositoryId)return fail('channel repository');return record;
    }
    if(path.startsWith('evidence/publication/')) {
      const record=decodeNativePublication(bytes);
      if(record.repositoryId!==repositoryId)return fail('publication repository');
      return record;
    }
    if(path.startsWith('evidence/retry-limit/')) {
      const record=decodeNativeRetryLimit(bytes);
      if(record.repositoryId!==repositoryId)return fail('retry limit repository');
      return record;
    }
    if(path.startsWith('evidence/dispatch/')) {
      const record=decodeNativeDispatchObservation(bytes);
      if(record.repositoryId!==repositoryId)return fail('dispatch observation repository');
      return record;
    }
    if(path.startsWith('evidence/reads/')) {
      const record=decodeNativeReadObservation(bytes);
      if(record.repositoryId!==repositoryId)return fail('read observation repository');
      return record;
    }
    if(path.startsWith('evidence/native/')) {
      const record=decodeNativeArchive(bytes);
      if(record.repositoryId!==repositoryId || !path.startsWith(`evidence/native/${record.run.id}-${record.run.runAttempt}/`)) return fail('native archive identity');
      return record;
    }
    if(path==='state.json') {
      const record=decodeReleaseRecord('repository',bytes);
      if(record.repositoryId!==repositoryId) return fail('state repository identity');
      return record;
    }
    if(path.startsWith('cycles/')) {
      const record=decodeReleaseRecord('cycle',bytes);
      if(path!==`cycles/${record.id}.json`) return fail('state cycle path');
      return record;
    }
    const record=decodeReleaseRecord('executionEvidence',bytes);
    if(record.repositoryId!==repositoryId) return fail('state repository identity');
    return record;
  }
  if(owner==='settings') return decodeSettingsReport(decodeBuildJson(bytes),repositoryId,path);
  if(owner==='maintenance') return decodeMaintenanceRecord(bytes,repositoryId,path);
  if(owner==='pages') return decodePagesMaintenance(bytes,repositoryId,path);
  if(owner==='quality') {
    // Source Markdown, identifiers and translations are content. Validate the
    // complete JSON envelope first, then keep strict checks on its metadata.
    const value=decodeQualityCache(decodeBuildJson(bytes,'oci'),repositoryId,Number(path.split('/')[1]!.replace('.json','')));
    const metadata=structuredClone(value);
    for(const head of Object.values(metadata.heads))for(const source of head.sources)source.bodyMarkdown='content';
    for(const entry of Object.values(metadata.entries)) {
      entry.segment.bodyMarkdown='content';entry.segment.originalIdentifiers=[];
      if(entry.result) {
        entry.result.originalIdentifiers=[];
        entry.result.problemZh=entry.result.impactZh=entry.result.suggestionZh='content';
      }
    }
    decodeBuildJson(new TextEncoder().encode(JSON.stringify(metadata)));
    return value;
  }
  if(owner!=='health' && owner!=='bootstrap') return fail('owner schema connection pending');
  const value=decodeBuildJson(bytes) as Record<string, any>;
  if(!validators[owner]!(value)) return fail(`invalid ${owner} record`);
  if(owner==='health') {
    if(!unique(value.errorCodes) || value.scanCompletedAt!==null && time(value.scanCompletedAt)>time(value.observedAt)) return fail('health observation');
  } else {
    if(value.repositoryId!==repositoryId || path!==`bootstrap/${value.runId}-${value.runAttempt}.json`
      || !unique(value.affectedRules.map((rule:{ruleId:number})=>rule.ruleId))) return fail('bootstrap identity');
  }
  return value;
}

export interface NativeWaveIdentity {
  repositoryId: number; cycleId: string; workflowId: number; runId: number; runAttempt: number; entry: 'build' | 'channel' | 'publish';
}
export async function nativeWaveKey(identity: NativeWaveIdentity): Promise<string> {
  if (![identity.repositoryId, identity.workflowId, identity.runId, identity.runAttempt].every(integer)
    || !/^pr-[1-9][0-9]*-[a-f0-9]{40}$/.test(identity.cycleId) || !['build','channel','publish'].includes(identity.entry)) fail('wave identity');
  return sha256Hex(JSON.stringify([identity.repositoryId, identity.cycleId, identity.workflowId, identity.runId, identity.runAttempt,
    ...(identity.entry === 'publish' ? ['publish'] : [])]));
}
export interface NativeAttemptEvidence extends NativeWaveIdentity {
  sourceSha: string; inputDigest: string; executorControllerSha: string; actorId: number;
  status: 'requested' | 'queued' | 'pending' | 'waiting' | 'in_progress' | 'completed'; observedAt: string; jobsComplete: boolean;
  jobs: { id: number; steps: { number: number; name: string; startedAt: string | null; completedAt: string | null; conclusion: string | null }[] }[];
  invocations: { evidence: ExecutionEvidence; jobId: number; stepNumber: number }[];
  sourceUrl: string; evidenceDigest: string;
}
export interface NativeRunCoverage {
  runId: number; workflowId: number; entry: NativeWaveIdentity['entry']; sourceSha: string; inputDigest: string; actorId: number;
  latestAttempt: number; availability: 'live' | 'expired' | 'unavailable';
}
export interface NativeAttemptSet { complete: boolean; runs: NativeRunCoverage[]; attempts: NativeAttemptEvidence[] }
export interface ArchivedAttempt { stateCommit: string; rawDigest: string; attempt: NativeAttemptEvidence }
export type CompletionTruth = 'PASS' | 'WAIT' | 'UNKNOWN' | 'CONFLICT';
export interface CompletionSource {
  repositoryId: number; cycleId: string; sourceSha: string; deliveryConfigSha: string;
  units: { id: string; version: string; tag: string; releaseId: number; authorId: number; manifestDigest: string; notesDigest: string;
    assets: { path: string; size: number; sha256: string }[] }[];
  requiredChannels: { unitId: string; channelId: string; version: string; digest: string; inputDigest: string; private: boolean }[];
}
export interface CompletionEvidence {
  source: CompletionSource; sourceComplete: boolean; observedAt: string; releasesComplete: boolean; channelsComplete: boolean;
  releases: { unitId: string; releaseId: number; tag: string; sourceSha: string; version: string; authorId: number;
    draft: boolean; immutable: boolean; manifestDigest: string; notesDigest: string; assets: { path: string; size: number; sha256: string }[]; evidenceDigest: string }[];
  channels: { unitId: string; channelId: string; version: string; digest: string; inputDigest: string; nativeObjectId: string;
    accepted: boolean; indexed: boolean; rejected: boolean; visible: boolean; observedAt: string; evidenceDigest: string }[];
  consumptions: { unitId: string; channelId: string; version: string; digest: string; inputDigest: string; repositoryId: number; sourceSha: string;
    runId: number; jobId: number; conclusion: 'success' | 'failure'; consumedDigest: string; logDigest: string; evidenceDigest: string }[];
  inFlightWaveKeys: string[]; unknownWriteKeys: string[];
}
function assertCompletionSource(value: CompletionSource): void {
  exact(value, ['repositoryId','cycleId','sourceSha','deliveryConfigSha','units','requiredChannels']);
  if (!integer(value.repositoryId) || !sha(value.sourceSha) || !sha(value.deliveryConfigSha)
    || !new RegExp(`^pr-[1-9][0-9]*-${value.sourceSha}$`).test(value.cycleId)
    || !Array.isArray(value.units) || !value.units.length || !Array.isArray(value.requiredChannels)) fail('completion source');
  for (const unit of value.units) {
    exact(unit,['id','version','tag','releaseId','authorId','manifestDigest','notesDigest','assets']);
    if (![unit.id,unit.version,unit.tag].every(value=>typeof value==='string'&&value.length>0) || !integer(unit.releaseId) || !integer(unit.authorId) || !digest(unit.manifestDigest) || !digest(unit.notesDigest)
      || !Array.isArray(unit.assets) || !unit.assets.length || !unique(unit.assets.map(asset=>asset.path.toLowerCase()))) fail('completion unit');
    for (const asset of unit.assets) {
      exact(asset,['path','size','sha256']); assertDeliveryPath(asset.path);
      if (!integer(asset.size) || !digest(asset.sha256)) fail('completion asset');
    }
  }
  for (const channel of value.requiredChannels) {
    exact(channel,['unitId','channelId','version','digest','inputDigest','private']);
    if (![channel.unitId,channel.channelId,channel.version].every(value=>typeof value==='string'&&value.length>0) || !digest(channel.digest) || !digest(channel.inputDigest) || typeof channel.private!=='boolean') fail('completion channel');
  }
}
function stable(value: unknown): string {
  const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value && typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)])):value;
  return JSON.stringify(sorted(value));
}
/** Reconcile fixed obligations with native objects and actual consumption. Cached completion flags are not inputs. */
export function evaluateCompletion(expected: CompletionSource, observation: CompletionEvidence, now: string) {
  const [source, facts] = structuredClone([expected, observation]) as [CompletionSource, CompletionEvidence];
  assertCompletionSource(source); assertCompletionSource(facts.source);
  exact(facts, ['source','sourceComplete','observedAt','releasesComplete','channelsComplete','releases','channels','consumptions','inFlightWaveKeys','unknownWriteKeys']);
  if (![facts.sourceComplete,facts.releasesComplete,facts.channelsComplete].every(value=>typeof value==='boolean')
    || ![facts.releases,facts.channels,facts.consumptions,facts.inFlightWaveKeys,facts.unknownWriteKeys].every(Array.isArray)) fail('completion observations');
  for (const item of facts.releases) {
    exact(item,['unitId','releaseId','tag','sourceSha','version','authorId','draft','immutable','manifestDigest','notesDigest','assets','evidenceDigest']);
    if (typeof item.draft!=='boolean' || typeof item.immutable!=='boolean' || !Array.isArray(item.assets)) fail('native release fields');
  }
  for (const item of facts.channels) {
    exact(item,['unitId','channelId','version','digest','inputDigest','nativeObjectId','accepted','indexed','rejected','visible','observedAt','evidenceDigest']);
    if (![item.accepted,item.indexed,item.rejected,item.visible].every(value=>typeof value==='boolean')) fail('native channel fields');
  }
  for (const item of facts.consumptions) {
    exact(item,['unitId','channelId','version','digest','inputDigest','repositoryId','sourceSha','runId','jobId','conclusion','consumedDigest','logDigest','evidenceDigest']);
    if (!['success','failure'].includes(item.conclusion)) fail('consumption conclusion');
  }
  const clock = time(now); time(facts.observedAt);
  if (!integer(source.repositoryId) || !sha(source.sourceSha) || !sha(source.deliveryConfigSha) || !source.units.length
    || !unique(source.units.map(unit => unit.id))) fail('completion source');
  const pair = (item: {unitId:string;channelId:string}) => JSON.stringify([item.unitId,item.channelId]);
  if (!unique(source.requiredChannels.map(pair)) || source.requiredChannels.some(item => !source.units.some(unit => unit.id===item.unitId))) fail('completion obligations');
  const reasons: { key: string; result: CompletionTruth; reason: string }[] = [];
  const add = (key: string, result: CompletionTruth, reason: string) => reasons.push({key,result,reason});
  const normalized = (value: CompletionSource) => stable({...value,units:[...value.units].map(unit=>({...unit,assets:[...unit.assets].sort((a,b)=>a.path.localeCompare(b.path))})).sort((a,b)=>a.id.localeCompare(b.id)),requiredChannels:[...value.requiredChannels].sort((a,b)=>pair(a).localeCompare(pair(b)))});
  if (!facts.sourceComplete) add('source','UNKNOWN','incomplete-source');
  else if (normalized(source)!==normalized(facts.source)) add('source','CONFLICT','source-or-obligations-changed');
  if (time(facts.observedAt)>clock) add('source','CONFLICT','future-observation');
  for (const unit of source.units) {
    const key=`unit:${unit.id}`, matches=facts.releases.filter(item=>item.unitId===unit.id);
    if (!facts.releasesComplete) { add(key,'UNKNOWN','incomplete-release-read'); continue; }
    if (matches.length>1) { add(key,'CONFLICT','duplicate-release'); continue; }
    const actual=matches[0];
    if (!actual) { add(key,'WAIT','release-not-created'); continue; }
    if (!integer(unit.releaseId) || !integer(unit.authorId) || !digest(unit.manifestDigest) || !digest(unit.notesDigest)
      || !digest(actual.evidenceDigest) || !unique(actual.assets.map(asset=>asset.path))) { add(key,'CONFLICT','invalid-release-evidence'); continue; }
    const assets=(values:typeof unit.assets)=>stable([...values].sort((a,b)=>a.path.localeCompare(b.path)));
    if (actual.releaseId!==unit.releaseId || actual.authorId!==unit.authorId || actual.sourceSha!==source.sourceSha || actual.version!==unit.version || actual.tag!==unit.tag
      || actual.manifestDigest!==unit.manifestDigest || actual.notesDigest!==unit.notesDigest || assets(actual.assets)!==assets(unit.assets)) add(key,'CONFLICT','release-source-or-bytes');
    else if (actual.draft || !actual.immutable) add(key,'WAIT','release-not-final');
    else add(key,'PASS','native-release-and-bytes');
  }
  for (const channel of source.requiredChannels) {
    const key=`channel:${channel.unitId}:${channel.channelId}`, matches=facts.channels.filter(item=>pair(item)===pair(channel));
    if (!facts.channelsComplete) { add(key,'UNKNOWN','incomplete-channel-read'); continue; }
    if (matches.length>1) { add(key,'CONFLICT','duplicate-channel'); continue; }
    const actual=matches[0];
    if (!actual) { add(key,'WAIT','channel-not-observed'); continue; }
    if (actual.version!==channel.version || actual.digest!==channel.digest || actual.inputDigest!==channel.inputDigest || actual.rejected
      || !digest(actual.evidenceDigest) || !actual.nativeObjectId) { add(key,'CONFLICT','channel-source-or-rejection'); continue; }
    const age=clock-time(actual.observedAt);
    if (age<0) { add(key,'CONFLICT','future-channel-observation'); continue; }
    if (channel.private && age>10*60_000) { add(key,'WAIT','private-probe-expired'); continue; }
    if (!actual.accepted || !actual.indexed || !actual.visible) { add(key,'WAIT','channel-pending'); continue; }
    const evidence=facts.consumptions.filter(item=>pair(item)===pair(channel));
    if (!evidence.length) { add(key,'UNKNOWN','consumption-proof-missing'); continue; }
    if (evidence.some(item=>item.version!==channel.version || item.digest!==channel.digest || item.consumedDigest!==channel.digest || item.inputDigest!==channel.inputDigest
      || item.repositoryId!==source.repositoryId || item.sourceSha!==source.sourceSha || !integer(item.runId) || !integer(item.jobId)
      || !digest(item.logDigest) || !digest(item.evidenceDigest))) { add(key,'CONFLICT','consumption-source-or-bytes'); continue; }
    if (!evidence.some(item=>item.conclusion==='success')) add(key,'WAIT','consumption-not-successful');
    else add(key,'PASS','native-channel-and-consumption');
  }
  for (const key of facts.inFlightWaveKeys) add(key,'WAIT','business-in-flight');
  for (const key of facts.unknownWriteKeys) add(key,'UNKNOWN','unknown-write');
  const mainReasons = reasons.filter(item => !item.key.startsWith('channel:'));
  const channelReasons = reasons.filter(item => item.key.startsWith('channel:'));
  const result:CompletionTruth = mainReasons.some(item=>item.result==='CONFLICT')?'CONFLICT':mainReasons.some(item=>item.result==='UNKNOWN')?'UNKNOWN':mainReasons.some(item=>item.result==='WAIT')?'WAIT':'PASS';
  const distributionResult:CompletionTruth = channelReasons.some(item=>item.result==='CONFLICT')?'CONFLICT':channelReasons.some(item=>item.result==='UNKNOWN')?'UNKNOWN':channelReasons.some(item=>item.result==='WAIT')?'WAIT':'PASS';
  return {result,distributionResult,reasons};
}
