import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import stateSchema from '../../../schema/release-state.schema.json' with { type: 'json' };
import { decodeBuildJson } from './build-manifest.js';
import type { ExecutionEvidence } from './release-observation.js';

export interface NativeResult {
  schemaVersion: 1; sourceSha: string; executionSha: string; stepNumber: number;
  reasonCode: 'RESULT' | 'NOT_BOUND' | 'DEPENDENCY_NOT_READY' | 'SOURCE_REF_MOVED' | 'ACTOR_REJECTED';
  execution: ExecutionEvidence;
  objects: { kind: 'artifact' | 'release'; id: number; digest: string }[];
}
export interface NativeJob {
  id: number; runId: number; runAttempt: number; headSha: string; name: string; status: string; conclusion: string | null;
  startedAt: string | null; completedAt: string | null;
  steps: { number: number; name: string; startedAt: string | null; completedAt: string | null; conclusion: string | null }[];
}
export interface NativeRun {
  id: number; repositoryId: number; headRepositoryId: number; workflowId: number; path: string;
  event: string; headSha: string; headBranch: string; actorId: number; triggeringActorId: number;
  runAttempt: number; status: 'requested' | 'queued' | 'pending' | 'waiting' | 'in_progress' | 'completed'; conclusion: string | null;
  createdAt: string; updatedAt: string; displayTitle: string;
}
export interface NativeArchive {
  schemaVersion: 1; repositoryId: number; repository: string; cycleId: string; sourceSha: string;
  requestKey: string; inputDigest: string; executorControllerSha: string; workflowBlobSha: string;
  sourceBlobs: { repository: string; path: string; commitSha: string; blobSha: string }[];
  observedAt: string; run: NativeRun; jobs: NativeJob[];
  producers: { artifactId: number; name: string; digest: string; size: number; createdAt: string; expiresAt: string;
    jobId: number; result: NativeResult }[];
  logs: { jobId: number; digest: string; markers: { eventAt: string; result: NativeResult }[] }[];
  objects: { kind: 'artifact' | 'release'; id: number; expectedDigest: string; actualDigest: string | null;
    status: 'MATCH' | 'ABSENT' | 'CONFLICT' | 'UNKNOWN'; observedAt: string; sourceUrl: string }[];
  missingNativeKeys: string[];
}
export interface NativeReadObservation {
  schemaVersion: 1; repositoryId: number; cycleId: string; observedAt: string; sourceUrl: string;
  missingNativeKeys: string[]; errorCodes: string[]; disposition: 'COMPLETE' | 'RETRY' | 'UNRECOVERABLE'; nextCheckAt: string | null;
}
/** Content-addressed observations of dispatch transport, never a future Run/attempt. */
export interface NativeDispatchObservation {
  schemaVersion: 1; repositoryId: number; cycleId: string; requestKey: string; observedAt: string;
  kind: 'PREPARED' | 'RESPONSE' | 'SEARCH' | 'READ_FAILURE';
  senderNonce: string | null;
  status: number | null; response: { workflow_run_id: number; run_url: string; html_url: string } | null;
  run: NativeRun | null; window: { start: string; end: string } | null;
  pages: { url: string; totalCount: number; runIds: number[] }[]; matches: NativeRun[];
  errorCode: string | null; nextCheckAt: string | null;
}
/** Original native Run observations and the platform bound, not a cached retry counter. */
export interface NativeRetryLimit {
  schemaVersion: 1|2; repositoryId: number; cycleId: string; requestKey: string; operationKey: string;
  observedAt: string; sourceUrl: string; firstRun: NativeRun; terminalRun: NativeRun;
  reason: 'AGE' | 'RERUN_COUNT' | 'PLATFORM_LIMIT'; attemptEvidencePaths: string[];
  response: { sourceUrl: string; status: number; body: string; digest: string } | null;
  platform?: {checkSuiteId:number;suiteSourceUrl:string;suite:{id:number;repositoryId:number;appId:number;appSlug:string;headSha:string;status:string;conclusion:string;runsRerequestable:boolean};
    page:{sourceUrl:string;status:number;body:string;digest:string}};
}
export interface NativePublication {
  schemaVersion:1; repositoryId:number; cycleId:string; sourceSha:string; observedAt:string;
  centralRun:NativeRun; job:NativeJob; stepNumber:number; execution:ExecutionEvidence;
  startEvidencePath:string|null; targetsDigest:string;
  targets:{unitId:string;tag:string;manifestDigest:string;bodyDigest:string}[];
  objects:{unitId:string;releaseId:number|null;status:'MATCH'|'ABSENT'|'CONFLICT'|'UNKNOWN';digest:string|null;sourceUrl:string}[];
  attempts:{run:NativeRun;jobs:NativeJob[]}[];
}
export interface NativeChannelEvidence {
  schemaVersion:1;repositoryId:number;cycleId:string;sourceSha:string;observedAt:string;kind:'PROBE'|'RESULT';
  run:NativeRun;job:NativeJob;artifact:{id:number;name:string;digest:string;createdAt:string};payload:string;
}
/** Read-only native responses; no business execution or consumption is asserted here. */
export interface NativeChannelRead {
  schemaVersion:1;repositoryId:number;cycleId:string;sourceSha:string;targetsDigest:string;observedAt:string;delivery:string;
  sources:{unitId:string;channelId:string;version:string;location:string;observedAt:string;kind:'GHCR'|'WINGET_PR';body:string}[];
}
export interface NormalizedDeliveryEvidence {
  schemaVersion:1;repositoryId:number;cycleId:string;sourceSha:string;controllerSha:string;observedAt:string;
  descriptor:{blobSha:string;content:string};
  originalChannels:{catalogBlobSha:string;unitId:string;channelId:string;kind:string;location:string;required:boolean}[];
  manifests:{unitId:string;content:string}[];
  normalizedDelivery:{schemaVersion:1;units:import('./delivery-config.js').DeliveryUnit[]};
}
export interface NativeSourceRejection {
  schemaVersion:1;repositoryId:number;cycleId:string;requestKey:string;expectedExecutionSha:string;observedAt:string;
  workflowBlobSha:string;run:NativeRun;jobs:NativeJob[];logDigest:string;reason:'SOURCE_REF_MOVED';
}

const string = { type: 'string', minLength: 1, maxLength: 2048 };
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$', minLength: 40, maxLength: 40 };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 };
const timestamp = { type: 'string', format: 'date-time', pattern: 'Z$' };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: object) => ({ type: 'array', items, maxItems: 10000 });
const closed = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const objectKind = { enum: ['artifact', 'release'] };
const resultSchema = closed({ schemaVersion: { const: 1 }, sourceSha: sha, executionSha: sha, stepNumber: id,
  reasonCode: { enum: ['RESULT', 'NOT_BOUND', 'DEPENDENCY_NOT_READY', 'SOURCE_REF_MOVED', 'ACTOR_REJECTED'] },
  execution: { $ref: `${stateSchema.$id}#/$defs/executionEvidence` },
  objects: array(closed({ kind: objectKind, id, digest })) });
const runSchema = closed({ id, repositoryId: id, headRepositoryId: id, workflowId: id, path: string, event: string,
  headSha: sha, headBranch: string, actorId: id, triggeringActorId: id, runAttempt: id,
  status: { enum: ['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed'] }, conclusion: nullable(string), createdAt: timestamp, updatedAt: timestamp, displayTitle: string });
const jobSchema = closed({ id, runId: id, runAttempt: id, headSha: sha, name: string, status: string, conclusion: nullable(string),
  startedAt: nullable(timestamp), completedAt: nullable(timestamp), steps: array(closed({ number: id, name: string,
    startedAt: nullable(timestamp), completedAt: nullable(timestamp), conclusion: nullable(string) })) });
const archiveSchema = closed({ schemaVersion: { const: 1 }, repositoryId: id, repository: { ...string, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
  cycleId: { ...string, pattern: '^pr-[1-9][0-9]*-[a-f0-9]{40}$' }, sourceSha: sha, requestKey: digest, inputDigest: digest,
  executorControllerSha: sha, workflowBlobSha: sha, observedAt: timestamp, run: runSchema, jobs: array(jobSchema),
  sourceBlobs: array(closed({ repository: string, path: string, commitSha: sha, blobSha: sha })),
  producers: array(closed({ artifactId: id, name: string, digest, size: id, createdAt: timestamp, expiresAt: timestamp, jobId: id, result: resultSchema })),
  logs: array(closed({ jobId: id, digest, markers: array(closed({ eventAt: timestamp, result: resultSchema })) })),
  objects: array(closed({ kind: objectKind, id, expectedDigest: digest, actualDigest: nullable(digest),
    status: { enum: ['MATCH', 'ABSENT', 'CONFLICT', 'UNKNOWN'] }, observedAt: timestamp, sourceUrl: string })), missingNativeKeys: array(string) });
const ajv = new Ajv2020({ strict: true });
(addFormatsModule as unknown as typeof import('ajv-formats').default)(ajv);
ajv.addSchema(stateSchema);
const resultValidator = ajv.compile(resultSchema), archiveValidator = ajv.compile(archiveSchema);
const rejectionValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  requestKey:digest,expectedExecutionSha:sha,observedAt:timestamp,workflowBlobSha:sha,run:runSchema,jobs:array(jobSchema),logDigest:digest,reason:{const:'SOURCE_REF_MOVED'}}));
export function decodeNativeSourceRejection(bytes:Uint8Array):NativeSourceRejection {
  const input=decodeBuildJson(bytes);if(!rejectionValidator(input))throw new Error('NATIVE_SOURCE_REJECTION: contract');
  const value=input as unknown as NativeSourceRejection,run=value.run;
  if(run.repositoryId!==value.repositoryId||run.headRepositoryId!==value.repositoryId||run.headSha===value.expectedExecutionSha
    ||run.path!=='.github/workflows/steward-release-channels.yml'||run.event!=='workflow_dispatch'||run.status!=='completed'||run.runAttempt!==1
    ||!value.jobs.length||new Set(value.jobs.map(job=>job.id)).size!==value.jobs.length||value.jobs.some(job=>job.runId!==run.id||job.runAttempt!==1||job.headSha!==run.headSha
      ||job.status!=='completed'||job.steps.some(step=>step.name.startsWith('business-')&&step.startedAt!==null&&step.conclusion!=='skipped'))
    ||value.jobs.filter(job=>job.name==='source-check'&&job.conclusion==='failure').length!==1)throw new Error('NATIVE_SOURCE_REJECTION: zero-business proof');
  return structuredClone(value);
}
const channelValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  sourceSha:sha,observedAt:timestamp,kind:{enum:['PROBE','RESULT']},run:runSchema,job:jobSchema,
  artifact:closed({id,name:string,digest:{type:'string',pattern:'^sha256:[a-f0-9]{64}$'},createdAt:timestamp}),payload:{type:'string',minLength:1,maxLength:4*1024*1024}}));
const channelReadValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  sourceSha:sha,targetsDigest:digest,observedAt:timestamp,delivery:{type:'string',minLength:1,maxLength:1024*1024},sources:array(closed({unitId:string,channelId:string,version:string,location:string,
    observedAt:timestamp,kind:{enum:['GHCR','WINGET_PR']},body:{type:'string',minLength:1,maxLength:2*1024*1024}}))}));
const normalizedDeliveryValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  sourceSha:sha,controllerSha:sha,observedAt:timestamp,descriptor:closed({blobSha:sha,content:{type:'string',minLength:1,maxLength:1024*1024}}),
  originalChannels:array(closed({catalogBlobSha:sha,unitId:string,channelId:string,kind:string,location:string,required:{type:'boolean'}})),
  manifests:array(closed({unitId:string,content:{type:'string',minLength:1,maxLength:2*1024*1024}})),
  normalizedDelivery:closed({schemaVersion:{const:1},units:array(closed({id:string,path:string,notesPath:string,
    assets:array(closed({id:string,name:string,mediaType:string})),channels:array(closed({id:string,required:{type:'boolean'},location:string}))}))})}));
export function decodeNormalizedDelivery(bytes:Uint8Array):NormalizedDeliveryEvidence {
  const value=decodeBuildJson(bytes,'oci');if(!normalizedDeliveryValidator(value))throw new Error('NORMALIZED_DELIVERY: contract');
  const raw=value as unknown as NormalizedDeliveryEvidence;
  decodeBuildJson(Buffer.from(JSON.stringify({...raw,descriptor:{...raw.descriptor,content:'raw'},manifests:raw.manifests.map(m=>({...m,content:'raw'}))})));
  return structuredClone(value) as unknown as NormalizedDeliveryEvidence;
}
export function decodeNativeChannelRead(bytes:Uint8Array):NativeChannelRead {
  const input=decodeBuildJson(bytes,'oci');if(!channelReadValidator(input))throw new Error('NATIVE_CHANNEL_READ: contract');
  const value=input as unknown as NativeChannelRead;
  decodeBuildJson(Buffer.from(JSON.stringify({...value,delivery:'raw',sources:value.sources.map(s=>({...s,body:'raw'}))})));
  if(!value.sources.length||!value.cycleId.endsWith('-'+value.sourceSha)||new Set(value.sources.map(s=>JSON.stringify([s.unitId,s.channelId]))).size!==value.sources.length
    ||value.sources.some(s=>Date.parse(s.observedAt)>Date.parse(value.observedAt)))throw new Error('NATIVE_CHANNEL_READ: source');
  return structuredClone(value);
}
export function decodeNativeChannel(bytes:Uint8Array):NativeChannelEvidence {
  const input=decodeBuildJson(bytes,'oci');if(!channelValidator(input))throw new Error('NATIVE_CHANNEL: envelope');
  const value=input as unknown as NativeChannelEvidence;
  decodeBuildJson(Buffer.from(JSON.stringify({...value,payload:'raw'})));
  const payload=decodeBuildJson(Buffer.from(value.payload)) as any;
  if(!value.cycleId.endsWith('-'+value.sourceSha)||value.run.repositoryId!==value.repositoryId||value.run.headRepositoryId!==value.repositoryId
    ||value.run.path!=='.github/workflows/steward-release-channels.yml'||value.run.event!=='workflow_dispatch'||value.job.runId!==value.run.id
    ||value.job.runAttempt!==value.run.runAttempt||value.job.headSha!==value.run.headSha||value.job.status!=='completed'
    ||!value.job.startedAt||!value.job.completedAt||Date.parse(value.artifact.createdAt)<=Date.parse(value.job.startedAt)
    ||Date.parse(value.artifact.createdAt)>Date.parse(value.job.completedAt)||Date.parse(value.observedAt)<Date.parse(value.job.completedAt)
    ||payload.schemaVersion!==1||payload.cycleId!==value.cycleId||payload.sourceSha!==value.sourceSha||payload.executionSha!==value.run.headSha
    ||payload.nativeRunId!==value.run.id||payload.runAttempt!==value.run.runAttempt||!Array.isArray(payload.items)
    ||Buffer.byteLength(value.payload)>4096+4096*payload.items.length)throw new Error('NATIVE_CHANNEL: native source');
  return structuredClone(value);
}
const publicationValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  sourceSha:sha,observedAt:timestamp,centralRun:runSchema,job:jobSchema,stepNumber:id,execution:{$ref:`${stateSchema.$id}#/$defs/executionEvidence`},
  startEvidencePath:nullable(string),targetsDigest:digest,targets:array(closed({unitId:string,tag:string,manifestDigest:digest,bodyDigest:digest})),
  objects:array(closed({unitId:string,releaseId:nullable(id),status:{enum:['MATCH','ABSENT','CONFLICT','UNKNOWN']},digest:nullable(digest),sourceUrl:string})),
  attempts:array(closed({run:runSchema,jobs:array(jobSchema)}))}));
export function decodeNativePublication(bytes:Uint8Array):NativePublication {
  const value=decodeBuildJson(bytes);
  if(!publicationValidator(value))throw new Error('NATIVE_PUBLICATION: contract');
  const r=value as unknown as NativePublication,e=r.execution,run=r.centralRun,job=r.job;
  if(!r.cycleId.endsWith('-'+r.sourceSha)||e.repositoryId!==r.repositoryId||e.cycleId!==r.cycleId||e.entry!=='publish'
    ||e.runId!==run.id||e.workflowId!==run.workflowId||e.runAttempt!==run.runAttempt||e.jobId!==job.id||job.runId!==run.id
    ||job.runAttempt!==run.runAttempt||job.headSha!==run.headSha||!job.steps.some(s=>s.number===r.stepNumber&&s.name.startsWith('business-'))
    ||!e.businessStartedProven||!r.targets.length||new Set(r.targets.map(t=>t.unitId)).size!==r.targets.length
    ||r.startEvidencePath===null&&(e.outcome!==null||r.objects.length>0||r.attempts.length>0)
    ||r.startEvidencePath!==null&&(!r.attempts.length||r.attempts.some((a,i)=>a.run.id!==run.id||a.run.runAttempt!==i+1
      ||a.run.repositoryId!==run.repositoryId||a.run.headSha!==run.headSha||a.run.workflowId!==run.workflowId
      ||a.jobs.some(job=>job.runId!==run.id||job.runAttempt!==i+1||job.headSha!==run.headSha))))throw new Error('NATIVE_PUBLICATION: identity');
  return structuredClone(r);
}
const limitValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  requestKey:digest,operationKey:digest,observedAt:timestamp,sourceUrl:string,firstRun:runSchema,terminalRun:runSchema,
  reason:{enum:['AGE','RERUN_COUNT']},attemptEvidencePaths:array(string),
  response:nullable(closed({sourceUrl:string,status:{type:'integer',minimum:400,maximum:599},body:{type:'string',maxLength:8192},digest}))}));
const platformLimitValidator=ajv.compile(closed({schemaVersion:{const:2},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  requestKey:digest,operationKey:digest,observedAt:timestamp,sourceUrl:string,firstRun:runSchema,terminalRun:runSchema,reason:{const:'PLATFORM_LIMIT'},attemptEvidencePaths:array(string),response:{type:'null'},
  platform:closed({checkSuiteId:id,suiteSourceUrl:string,suite:closed({id,repositoryId:id,appId:id,appSlug:string,headSha:sha,status:string,conclusion:string,runsRerequestable:{type:'boolean'}}),
    page:closed({sourceUrl:string,status:{const:200},body:{type:'string',minLength:1,maxLength:384*1024},digest})})}));
export function decodeNativeRetryLimit(bytes:Uint8Array):NativeRetryLimit {
  const value=decodeBuildJson(bytes,'oci');
  if(!limitValidator(value)&&!platformLimitValidator(value))throw new Error('NATIVE_RETRY_LIMIT: contract');
  const record=value as unknown as NativeRetryLimit, a=record.firstRun,b=record.terminalRun;
  decodeBuildJson(Buffer.from(JSON.stringify({...record,...(record.platform?{platform:{...record.platform,page:{...record.platform.page,body:'raw'}}}:{})})));
  const identity=(run:NativeRun)=>JSON.stringify([run.id,run.repositoryId,run.headRepositoryId,run.workflowId,run.path,run.event,run.headSha,run.headBranch,run.actorId,run.displayTitle]);
  if(identity(a)!==identity(b)||a.repositoryId!==record.repositoryId||a.runAttempt!==1||b.status!=='completed'||!b.conclusion
    ||Date.parse(b.createdAt)<Date.parse(a.createdAt)||Date.parse(b.createdAt)>Date.parse(b.updatedAt)
    ||Date.parse(record.observedAt)<Date.parse(b.updatedAt)||record.attemptEvidencePaths.length!==b.runAttempt
    ||new Set(record.attemptEvidencePaths).size!==b.runAttempt
    ||record.attemptEvidencePaths.some((path,i)=>!new RegExp(`^evidence/native/${b.id}-${i+1}/[a-f0-9]{64}\\.json$`).test(path))
    ||record.reason==='AGE'&&Date.parse(record.observedAt)-Date.parse(a.createdAt)<=30*24*60*60_000
    ||record.reason==='RERUN_COUNT'&&(b.runAttempt-1<50||!record.response||record.response.status!==422)
    ||record.reason==='PLATFORM_LIMIT'&&(record.schemaVersion!==2||b.runAttempt<50||b.conclusion!=='startup_failure'||!record.platform||record.response!==null))
    throw new Error('NATIVE_RETRY_LIMIT: identity or bound');
  return structuredClone(record);
}
const dispatchValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  requestKey:digest,observedAt:timestamp,kind:{enum:['PREPARED','RESPONSE','SEARCH','READ_FAILURE']},senderNonce:nullable({type:'string',pattern:'^[a-f0-9]{32}$',minLength:32,maxLength:32}),status:nullable({type:'integer',minimum:100,maximum:599}),
  response:nullable(closed({workflow_run_id:id,run_url:string,html_url:string})),run:nullable(runSchema),window:nullable(closed({start:timestamp,end:timestamp})),
  pages:array(closed({url:string,totalCount:{type:'integer',minimum:0},runIds:array(id)})),matches:array(runSchema),errorCode:nullable(string),nextCheckAt:nullable(timestamp)}));
export function decodeNativeDispatchObservation(bytes:Uint8Array):NativeDispatchObservation {
  const value=decodeBuildJson(bytes);
  if(!dispatchValidator(value))throw new Error('NATIVE_DISPATCH: observation contract');
  const record=value as unknown as NativeDispatchObservation;
  if((record.kind==='PREPARED')!==(record.senderNonce!==null)
    ||record.window && (Date.parse(record.window.start)>Date.parse(record.window.end) || Date.parse(record.window.end)>Date.parse(record.observedAt))
    || record.kind==='SEARCH' && (!record.window || !record.pages.length || record.errorCode!==null)
    || record.kind==='PREPARED' && (record.status!==null || record.response!==null || record.run!==null || record.window!==null || record.pages.length || record.matches.length)
    || record.run && record.run.repositoryId!==record.repositoryId
    || record.matches.some(run=>run.repositoryId!==record.repositoryId)
    || record.nextCheckAt && Date.parse(record.nextCheckAt)<Date.parse(record.observedAt))throw new Error('NATIVE_DISPATCH: observation identity');
  return structuredClone(record);
}
const readValidator=ajv.compile(closed({schemaVersion:{const:1},repositoryId:id,cycleId:{...string,pattern:'^pr-[1-9][0-9]*-[a-f0-9]{40}$'},
  observedAt:timestamp,sourceUrl:string,missingNativeKeys:array(string),errorCodes:array(string),disposition:{enum:['COMPLETE','RETRY','UNRECOVERABLE']},nextCheckAt:nullable(timestamp)}));
export function decodeNativeReadObservation(bytes:Uint8Array):NativeReadObservation {
  const value=decodeBuildJson(bytes);
  if(!readValidator(value))throw new Error('NATIVE_EVIDENCE: read observation contract');
  return structuredClone(value) as unknown as NativeReadObservation;
}
export function parseNativeResult(value: unknown): NativeResult {
  if (!resultValidator(value)) throw new Error('NATIVE_EVIDENCE: result contract');
  return structuredClone(value) as unknown as NativeResult;
}
export function decodeNativeArchive(bytes: Uint8Array): NativeArchive {
  const value = decodeBuildJson(bytes);
  if (!archiveValidator(value)) throw new Error('NATIVE_EVIDENCE: archive contract');
  const archive = value as unknown as NativeArchive;
  if (archive.repository.split('/').some(part => part === '.' || part === '..')
    || archive.run.repositoryId !== archive.repositoryId || !archive.cycleId.endsWith(`-${archive.sourceSha}`)) throw new Error('NATIVE_EVIDENCE: archive identity');
  return structuredClone(archive);
}
