import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { githubHeaders } from '../../github/src/api-version.js';
import { completeMergedPull } from '../../github/src/merged-pull.js';
import { collectAllPages, nextLink } from '../../github/src/pagination.js';
import { buildLimits, decodeBuildJson } from '../../core/src/build-manifest.js';
import { decodeNativeArchive, decodeNativeReadObservation, decodeNativeRetryLimit, decodeNativeSourceRejection, parseNativeResult, type NativeChannelEvidence, type NativeSourceRejection, type NativeRetryLimit, type NativeArchive, type NativeRun, type NativeJob, type NativeResult, type NativeReadObservation } from '../../core/src/native-evidence.js';
import { nativeWaveKey, parseReleaseRecord, type CycleRecord, type NativeAttemptEvidence, type NativeAttemptSet, type ArchivedAttempt } from '../../core/src/release-observation.js';
import { extractArtifactFile } from './artifact-file.js';
import { nativeJobOrigins, withinNativeJobWindow, type NativeJobAttempt } from '../../core/src/native-job-origins.js';
import { nativeRerunLimitAnnotation } from '../../core/src/native-limit-annotation.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const stableReleaseFacts=(release:any)=>({id:release.id,tag_name:release.tag_name,target_commitish:release.target_commitish,
  authorId:release.author?.id,draft:release.draft,immutable:release.immutable,body:release.body,upload_url:release.upload_url,html_url:release.html_url});
export const stableAssetFacts=(assets:any[])=>assets.map(asset=>({id:asset.id,name:asset.name,size:asset.size,digest:asset.digest,state:asset.state,
  label:asset.label,uploaderId:asset.uploader?.id})).sort((a,b)=>a.id-b.id);
const sameFacts = (a: unknown, b: unknown) => JSON.stringify(a,(key,value)=>key==='observedAt'?undefined:value) === JSON.stringify(b,(key,value)=>key==='observedAt'?undefined:value);
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(`NATIVE_EVIDENCE: ${reason}`); }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const utc = (value: unknown): string => {
  check(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'event time');
  return new Date(value).toISOString();
};
export interface EvidenceResponse { status: number; headers: Headers; bytes: Uint8Array }
export interface EvidenceTransport {
  /** Same bounded transport with no API credential, used only for public formal objects. */
  anonymous?():EvidenceTransport;
  request(method: 'GET' | 'POST', path: string, limit?: number, body?: object): Promise<EvidenceResponse>;
  downloadDigest?(path: string, limit: number): Promise<{ status: number; digest: string; size: number; retryAfter: string | null }>;
}
export interface EvidenceContext { repository: string; repositoryId: number; appBotId: number; cycle: CycleRecord }
export interface ArchiveFile { path: string; content: string; sha256: string }
export interface ArchivedFile { path: string; commit: string; value: NativeArchive }
export interface RetryLimitFile { path:string; commit:string; value:NativeRetryLimit }
export interface SourceRejectionFile {path:string;commit:string;value:NativeSourceRejection}
export interface ReadHistory { complete: boolean; observations: NativeReadObservation[]; retryLimits?:RetryLimitFile[]; sourceRejections?:SourceRejectionFile[];
  channelEvidence?:{path:string;commit:string;value:NativeChannelEvidence|import('../../core/src/native-evidence.js').NativeChannelRead}[]; publication?:{native:NativeAttemptSet;missing:string[];archived?:ArchivedAttempt[]} }
export function verifyNativeSourceRejection(context:EvidenceContext,file:SourceRejectionFile) {
  const value=decodeNativeSourceRejection(Buffer.from(JSON.stringify(file.value))),request=context.cycle.dispatches.find(request=>request.requestKey===value.requestKey);
  check(/^[a-f0-9]{40}$/.test(file.commit)&&file.path===`evidence/source-rejection/${hash(JSON.stringify(value)+'\n')}.json`
    &&value.repositoryId===context.repositoryId&&value.cycleId===context.cycle.id&&request&&request.purpose!=='build'&&request.canonicalRunId===null
    &&request.executionSha===value.expectedExecutionSha&&value.run.workflowId===request.workflowId&&value.run.headBranch===request.ref
    &&value.run.actorId===context.appBotId&&value.run.triggeringActorId===context.appBotId&&value.run.displayTitle.includes(request.requestKey)
    &&Date.parse(value.run.createdAt)>=Math.floor(Date.parse(request.sentAt)/1000)*1000,'source rejection provenance');
  return value;
}
export interface EvidenceStore {
  // Implemented by the fixed Git transport, never selected by persisted state.
  archive(files: ArchiveFile[]): Promise<{ status: string; head: string | null; records: ArchivedFile[]; files?:ArchiveFile[] }>;
}
export class EvidenceReadError extends Error {
  constructor(public readonly status: number, public readonly retryAfter: string | null) { super(`NATIVE_HTTP_${status}`); }
}

/** One explicit token, exact GitHub origin, bounded reads; redirected blob reads carry no credential. */
export function nativeEvidenceTransport(token: string | undefined, transport: typeof fetch = fetch): EvidenceTransport {
  const open=async(method:'GET'|'POST',path:string,body?:object)=>{
    const pathname=path.split('?')[0]!;
    let decoded:string;try{decoded=decodeURIComponent(pathname);}catch{throw new Error('NATIVE_EVIDENCE: API path');}
    check(path.startsWith('/repos/') && !decoded.includes('..') && !decoded.includes('\\')
      && !/[\x00-\x1f\x7f]/.test(decoded) && !path.includes('#'), 'API path');
    const headers = new Headers(githubHeaders(token ?? ''));
    if (!token) headers.delete('authorization');
    if (/\/releases\/assets\/[1-9][0-9]*$/.test(path)) headers.set('accept','application/octet-stream');
    if(body!==undefined) {check(method==='POST','request body');headers.set('content-type','application/json');}
    let response = await transport(`https://api.github.com${path}`, { method, headers, ...(body===undefined?{}:{body:JSON.stringify(body)}), redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (method === 'GET' && response.status === 302) {
      const url = new URL(response.headers.get('location') ?? '');
      check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
        && ['.blob.core.windows.net', '.actions.githubusercontent.com', '.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix)), 'download origin');
      await response.body?.cancel();
      response = await transport(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    }
    return response;
  };
  return { anonymous:()=>nativeEvidenceTransport(undefined,transport), async request(method, path, limit = 8 * 1024 * 1024, body) {
    const response=await open(method,path,body);
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        check(Number(response.headers.get('content-length') ?? 0) <= limit, 'response bound');
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; check(size <= limit, 'response bound'); chunks.push(part.value); }
      } finally { await reader.cancel(); reader.releaseLock(); }
    }
    return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
  }, async downloadDigest(path,limit) {
    const response=await open('GET',path), digest=createHash('sha256');let size=0;
    if(response.body) {
      const reader=response.body.getReader();
      try {
        check(Number(response.headers.get('content-length')??0)<=limit,'response bound');
        for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=limit,'response bound');digest.update(part.value);}
      } finally {await reader.cancel();reader.releaseLock();}
    }
    return {status:response.status,digest:digest.digest('hex'),size,retryAfter:response.headers.get('retry-after')};
  } };
}

export class NativeEvidenceReader {
  constructor(readonly io: EvidenceTransport, readonly repository: string) {}
  path(path: string) { return `/repos/${this.repository}${path ? '/'+path : ''}`; }
  async response(path: string, limit?: number) {
    const result = await this.io.request('GET', this.path(path), limit);
    if (result.status !== 200) throw new EvidenceReadError(result.status, result.headers.get('retry-after'));
    return result;
  }
  async json(path: string) {
    const value=JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await this.response(path)).bytes));
    const pull=/^pulls\/([1-9][0-9]*)$/.exec(path);
    return pull ? completeMergedPull(this.repository,Number(pull[1]),value,()=>this.pages(`issues/${pull[1]}/events`,'')) : value;
  }
  async jobAttempts(runId: number, latestAttempt: number): Promise<NativeJobAttempt[]> {
    check(positive(runId) && positive(latestAttempt), 'job history identity');
    const attempts: NativeJobAttempt[] = [];
    for (let attempt = 1; attempt <= latestAttempt; attempt++) {
      const jobs = (await this.pages(`actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs')).map(jobFact);
      check(jobs.every(job => job.runId === runId && job.runAttempt === attempt), 'job history source');
      attempts.push({ attempt, jobs });
    }
    return attempts;
  }
  async downloadDigest(path:string) {
    if(this.io.downloadDigest) {
      const result=await this.io.downloadDigest(this.path(path),buildLimits.maxTotalBytes+16*1024*1024);
      if(result.status!==200)throw new EvidenceReadError(result.status,result.retryAfter);
      return {digest:result.digest,size:result.size};
    }
    const bytes=(await this.response(path,buildLimits.maxTotalBytes+16*1024*1024)).bytes;
    return {digest:hash(bytes),size:bytes.length};
  }
  async pages(path: string, field: string, identity: 'id' | 'name' = 'id'): Promise<any[]> {
    let total: number | null = null;
    const first = this.path(`${path}${path.includes('?') ? '&' : '?'}per_page=100`), endpoint = new URL(first, 'https://api.github.com');
    const values = await collectAllPages<any>(first, async next => {
      const url = new URL(next, 'https://api.github.com');
      check(url.origin === endpoint.origin && url.pathname === endpoint.pathname && !url.username && !url.password && !url.hash, 'pagination origin');
      for (const [key, value] of endpoint.searchParams) check(url.searchParams.get(key) === value, 'pagination query');
      check([...url.searchParams.keys()].every(key => endpoint.searchParams.has(key) || key === 'page'), 'pagination query');
      const response = await this.io.request('GET', url.pathname + url.search);
      if (response.status !== 200) throw new EvidenceReadError(response.status, response.headers.get('retry-after'));
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes));
      check(field ? Number.isSafeInteger(body.total_count) && body.total_count >= 0 && Array.isArray(body[field]) : Array.isArray(body), 'pagination envelope');
      if (field && total === null) total = body.total_count;
      if (field) check(total === body.total_count, 'pagination changed');
      const link = nextLink(response.headers);
      return { items: field ? body[field] : body, ...(link ? { next: link } : {}) };
    });
    check((!field || values.length === total) && new Set(values.map(value => value[identity])).size === values.length
      && values.every(value => identity === 'id' ? positive(value.id) : typeof value.name === 'string' && value.name.length > 0), 'incomplete pagination');
    return [...values];
  }
}

export async function formalReleaseReader(context:EvidenceContext,io:EvidenceTransport) {
  const repository=await new NativeEvidenceReader(io,context.repository).json('');
  check(repository.id===context.repositoryId&&repository.full_name===context.repository&&typeof repository.private==='boolean'
    &&repository.archived===false&&repository.disabled===false,'formal repository visibility');
  const selected=repository.private?io:io.anonymous?.();check(selected,'anonymous formal reader required');
  return new NativeEvidenceReader(selected,context.repository);
}
export function nativeRunFact(raw: any): NativeRun {
  return { id: raw.id, repositoryId: raw.repository?.id, headRepositoryId: raw.head_repository?.id, workflowId: raw.workflow_id,
    path: raw.path, event: raw.event, headSha: raw.head_sha, headBranch: raw.head_branch, actorId: raw.actor?.id,
    triggeringActorId: raw.triggering_actor?.id, runAttempt: raw.run_attempt, status: raw.status, conclusion: raw.conclusion,
    createdAt: utc(raw.created_at), updatedAt: utc(raw.updated_at), displayTitle: raw.display_title };
}
export function jobFact(raw: any): NativeJob {
  check(Array.isArray(raw.steps), 'job steps');
  return { id: raw.id, runId: raw.run_id, runAttempt: raw.run_attempt, headSha: raw.head_sha, name: raw.name, status: raw.status, conclusion: raw.conclusion,
    startedAt: raw.started_at === null ? null : utc(raw.started_at), completedAt: raw.completed_at === null ? null : utc(raw.completed_at),
    steps: raw.steps.map((step: any) => ({ number: step.number, name: step.name, startedAt: step.started_at === null ? null : utc(step.started_at),
      completedAt: step.completed_at === null ? null : utc(step.completed_at), conclusion: step.conclusion })) };
}
const compareIdentityText = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;
function channelIdentityTargets(request:CycleRecord['dispatches'][number]):[string,string,string,number,string][] {
  const targets=JSON.parse(request.inputs.targets_json!);
  check(Array.isArray(targets)&&targets.length>0,'channel identity targets');
  for(const target of targets)check(target&&Object.keys(target).sort().join(',')==='channelId,manifestDigest,releaseId,unitId,version'
    &&typeof target.unitId==='string'&&typeof target.channelId==='string'&&typeof target.version==='string'
    &&positive(target.releaseId)&&typeof target.manifestDigest==='string'&&/^[a-f0-9]{64}$/.test(target.manifestDigest),'channel identity target');
  check(new Set(targets.map(target=>JSON.stringify([target.unitId,target.channelId]))).size===targets.length,'duplicate channel identity target');
  return targets.sort((a,b)=>compareIdentityText(a.unitId,b.unitId)||compareIdentityText(a.channelId,b.channelId))
    .map(target=>[target.unitId,target.channelId,target.version,target.releaseId,target.manifestDigest]);
}
export function nativeRequestIdentity(repositoryId: number, cycle: CycleRecord, request: CycleRecord['dispatches'][number]) {
  const unitVersions=[...cycle.units].sort((a,b)=>compareIdentityText(a.id,b.id)).map(unit=>[unit.id,unit.version]);
  const mode=request.purpose==='build'?'build':request.inputs.mode!;
  const targetSet=request.purpose==='build'?unitVersions:channelIdentityTargets(request);
  if(request.purpose==='build')check(request.executionSha===cycle.sourceSha,'build identity source');
  else for(const [unitId,channelId,version,releaseId,manifestDigest] of targetSet) {
    const unit=cycle.units.find(unit=>unit.id===unitId);
    check(unit&&unit.version===version&&unit.releaseId===releaseId&&unit.manifestDigest===manifestDigest
      &&cycle.requiredChannels.some(channel=>channel.unitId===unitId&&channel.channelId===channelId),'channel identity frozen target');
  }
  const targetKey=JSON.stringify([2,request.workflowId,request.ref,request.executionSha,cycle.sourceSha,request.purpose,mode,targetSet]);
  const inputDigest=hash(JSON.stringify([4,cycle.id,cycle.sourceSha,request.executionSha,cycle.controllerSha,cycle.deliveryConfigSha,unitVersions,targetSet,mode]));
  const operationKey=hash(JSON.stringify([2,repositoryId,cycle.id,request.purpose,targetKey,inputDigest]));
  return {targetKey,inputDigest,operationKey,requestKey:hash(JSON.stringify([operationKey,request.continuationOfRunId]))};
}
// Read-only verification of archived format 3 keys. New requests always use format 4.
function legacyRequestIdentity(repositoryId: number, cycle: CycleRecord, request: CycleRecord['dispatches'][number]) {
  const targets = request.purpose === 'build' ? [] : JSON.parse(request.inputs.targets_json!);
  const units = request.purpose === 'build' ? cycle.units : cycle.units.filter(unit => targets.some((target: any) => target.unitId === unit.id));
  const unitIds = units.map(unit => unit.id).sort(), channelIds = [...new Set<string>(targets.map((target: any) => target.channelId))].sort();
  const mode = request.purpose === 'build' ? 'build' : request.inputs.mode!;
  const inputDigest = hash(JSON.stringify([3, cycle.id, cycle.sourceSha, request.executionSha, cycle.controllerSha, cycle.deliveryConfigSha,
    [...units].sort((a,b)=>a.id.localeCompare(b.id)).map(unit=>[unit.id,unit.version]),
    request.purpose==='build' ? [] : [...units].filter(unit=>unit.releaseId!==null).sort((a,b)=>a.releaseId!-b.releaseId!).map(unit=>[unit.releaseId,unit.manifestDigest]), channelIds, mode]));
  const targetKey = JSON.stringify([request.workflowId, request.ref, request.executionSha, cycle.sourceSha, unitIds, channelIds, mode]);
  const operationKey = hash(JSON.stringify([1, repositoryId, cycle.id, request.purpose, targetKey, inputDigest]));
  return { targetKey, inputDigest, operationKey, requestKey: hash(JSON.stringify([operationKey, request.continuationOfRunId])) };
}
export function sameChannelOperation(a:CycleRecord['dispatches'][number],b:CycleRecord['dispatches'][number]) {
  return a.purpose!=='build'&&a.purpose===b.purpose&&a.workflowId===b.workflowId&&a.sourceSha===b.sourceSha
    &&a.inputs.cycle_id===b.inputs.cycle_id&&a.inputs.controller_sha===b.inputs.controller_sha&&a.inputs.mode===b.inputs.mode
    &&JSON.stringify(channelIdentityTargets(a))===JSON.stringify(channelIdentityTargets(b));
}
export function validateEvidenceContext(input: EvidenceContext): EvidenceContext {
  check(Object.keys(input).sort().join(',') === 'appBotId,cycle,repository,repositoryId', 'context fields');
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) && !input.repository.split('/').some(part => ['.', '..'].includes(part))
    && positive(input.repositoryId) && positive(input.appBotId), 'context identity');
  const context = { ...input, cycle: parseReleaseRecord('cycle', input.cycle) };
  const legacyTargets=new Map<string,string>();
  for (const request of context.cycle.dispatches) {
    const identity = nativeRequestIdentity(context.repositoryId, context.cycle, request);
    const matches=(value:typeof identity)=>Object.entries(value).every(([key,item])=>request[key as keyof typeof identity]===item);
    if(!matches(identity)) {
      check(matches(legacyRequestIdentity(context.repositoryId,context.cycle,request)),'request digest');
      if(request.purpose!=='build') {
        const targets=JSON.stringify(channelIdentityTargets(request)),prior=legacyTargets.get(request.operationKey);
        check(prior===undefined||prior===targets,'legacy request target conflict');
        legacyTargets.set(request.operationKey,targets);
      }
    }
    if(request.continuationOfRunId!==null)check(context.cycle.dispatches.some(prior=>prior.canonicalRunId===request.continuationOfRunId && sameChannelOperation(prior,request)),'continuation history');
  }
  const ids=context.cycle.dispatches.flatMap(request=>request.canonicalRunId===null?[]:[request.canonicalRunId]);
  check(new Set(ids).size===ids.length,'duplicate canonical run');
  return context;
}
export function sourceRun(context: EvidenceContext, request: CycleRecord['dispatches'][number], run: NativeRun) {
  const path = request.purpose === 'build' ? '.github/workflows/steward-release-publish.yml' : '.github/workflows/steward-release-channels.yml';
  check(run.id === request.canonicalRunId && run.repositoryId === context.repositoryId && run.headRepositoryId === context.repositoryId
    && run.workflowId === request.workflowId && run.path === path && run.event === 'workflow_dispatch' && run.headSha === request.executionSha
    && run.headBranch === request.ref && run.actorId === context.appBotId && positive(run.triggeringActorId)
    && Date.parse(run.createdAt) >= Math.floor(Date.parse(request.sentAt)/1000)*1000 && run.displayTitle.includes(request.purpose === 'build' ? request.operationKey : request.requestKey), 'run source');
}
export function retryLimitFile(value:NativeRetryLimit):ArchiveFile {
  const content=JSON.stringify(value,null,2)+'\n',sha256=hash(content);
  decodeNativeRetryLimit(Buffer.from(content));return {path:`evidence/retry-limit/${sha256}.json`,content,sha256};
}
/** Verify the full archived attempt chain before a limit proof can authorize continuation. */
export function verifyNativeRetryLimit(context:EvidenceContext,file:RetryLimitFile,history:ArchivedFile[]) {
  const proof=decodeNativeRetryLimit(Buffer.from(JSON.stringify(file.value))), request=context.cycle.dispatches.find(item=>item.requestKey===proof.requestKey);
  check(request && /^[a-f0-9]{40}$/.test(file.commit) && retryLimitFile(proof).path===file.path
    &&proof.repositoryId===context.repositoryId&&proof.cycleId===context.cycle.id&&proof.operationKey===request.operationKey,'limit provenance');
  sourceRun(context,request,proof.firstRun);sourceRun(context,request,proof.terminalRun);
  check(proof.sourceUrl===`https://api.github.com/repos/${context.repository}/actions/runs/${proof.terminalRun.id}`,'limit source');
  for(const [i,path] of proof.attemptEvidencePaths.entries()) {
    const archived=history.find(item=>item.path===path);
    check(archived && /^[a-f0-9]{40}$/.test(archived.commit)&&archiveFile(archived.value).path===path
      &&archived.value.requestKey===request.requestKey&&archived.value.inputDigest===request.inputDigest
      &&archived.value.run.runAttempt===i+1&&archived.value.run.status==='completed'&&!archived.value.missingNativeKeys.length,'limit attempt coverage');
    sourceRun(context,request,archived.value.run);
    if(i===0)check(same(archived.value.run,proof.firstRun),'limit first Run');
    if(i===proof.attemptEvidencePaths.length-1)check(same(archived.value.run,proof.terminalRun),'limit terminal Run');
  }
  if(proof.response) {
    const response=proof.response;
    check(hash(response.body)===response.digest&&response.sourceUrl===`${proof.sourceUrl}/rerun-failed-jobs`,'limit response provenance');
    // Unknown/permission/rate-limit responses do not prove a rerun limit. The REST docs do not promise one fixed error string.
    let body;try{body=JSON.parse(response.body);}catch{check(false,'limit response JSON');}
    check(response.status===422&&typeof body.message==='string'
      &&/\b(?:re-?runs?|re-?running|attempts?)\b/i.test(body.message)&&/\b(?:maximum|limit)\b/i.test(body.message)&&/\b50\b/.test(body.message),'explicit native rerun limit');
  }
  if(proof.platform)verifyPlatformLimit(context.repository,proof.terminalRun,proof.platform);
  return proof;
}
function verifyPlatformLimit(repository:string,run:NativeRun,platform:NonNullable<NativeRetryLimit['platform']>) {
  const {suite,page}=platform;
  check(suite.id===platform.checkSuiteId&&suite.repositoryId===run.repositoryId&&suite.headSha===run.headSha
    &&suite.appId===15368&&suite.appSlug==='github-actions'&&suite.status==='completed'&&suite.conclusion==='startup_failure'&&suite.runsRerequestable===false
    &&platform.suiteSourceUrl===`https://api.github.com/repos/${repository}/check-suites/${suite.id}`,'platform limit suite');
  check(run.status==='completed'&&run.conclusion==='startup_failure'&&page.status===200
    &&page.sourceUrl===`https://github.com/${repository}/actions/runs/${run.id}`&&hash(page.body)===page.digest
    &&nativeRerunLimitAnnotation(page.body,repository,run.id),'platform limit annotation');
}
async function workflowSource(reader: NativeEvidenceReader, run: NativeRun) {
  const workflow = await reader.json(`actions/workflows/${run.workflowId}`);
  check(workflow.id === run.workflowId && workflow.path === run.path, 'workflow identity');
  const controllers = new Set<string>(), sourceBlobs:NativeArchive['sourceBlobs']=[],visited=new Set<string>();
  const read=async(source:NativeEvidenceReader,path:string,commitSha:string):Promise<void>=>{
  const key=JSON.stringify([source.repository,path,commitSha]);if(visited.has(key))return;visited.add(key);
  check(visited.size<=100,'workflow source bound');
  const blob = await source.json(`contents/${path}?ref=${commitSha}`);
  check(blob.type === 'file' && blob.encoding === 'base64' && typeof blob.content === 'string' && blob.size <= 512*1024, 'workflow blob');
  const bytes = Buffer.from(blob.content, 'base64');
  check(bytes.length === blob.size && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === blob.sha, 'workflow bytes');
  sourceBlobs.push({repository:source.repository,path,commitSha,blobSha:blob.sha});
  const document = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { uniqueKeys: true });
  check(!document.errors.length, 'workflow YAML');
  const yaml = document.toJS({ maxAliasCount: 0 });
  for (const job of Object.values(yaml.jobs ?? {}) as any[]) {
    const match = typeof job.uses === 'string' && /^splrad\/steward\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([a-f0-9]{40})$/.exec(job.uses);
    if (match) await read(new NativeEvidenceReader(reader.io,'splrad/steward'),match[1]!,match[2]!);
    else if(typeof job.uses==='string' && job.uses.startsWith('./.github/workflows/'))await read(source,job.uses.slice(2),commitSha);
    for (const step of job.steps ?? []) if (/^actions\/checkout@[a-f0-9]{40}$/.test(step.uses ?? '') && step.with?.repository === 'splrad/steward') {
      check(/^[a-f0-9]{40}$/.test(step.with.ref ?? ''), 'runner pin'); controllers.add(step.with.ref);
    }
  }
  };
  await read(reader,run.path,run.headSha);
  check(controllers.size === 1, 'executor source unavailable');
  return { executorControllerSha: [...controllers][0]!, workflowBlobSha: sourceBlobs[0]!.blobSha,sourceBlobs };
}
function validateResult(result: NativeResult, archive: NativeArchive, jobId: number) {
  const execution = result.execution, job = archive.jobs.find(job => job.id === jobId), step = job?.steps.find(step => step.number === result.stepNumber);
  check(step && step.conclusion !== 'skipped' && step.name.startsWith('business-') && execution.jobId === jobId && execution.repositoryId === archive.repositoryId
    && execution.cycleId === archive.cycleId && execution.workflowId === archive.run.workflowId && execution.runId === archive.run.id
    && execution.runAttempt === archive.run.runAttempt && result.sourceSha === archive.sourceSha && result.executionSha === archive.run.headSha
    && execution.inputDigest === archive.inputDigest && execution.entry === (archive.run.path.endsWith('steward-release-publish.yml') ? 'build' : 'channel'), 'result identity');
  check(execution.invocationKey === hash(JSON.stringify([archive.repositoryId, archive.cycleId, archive.run.workflowId, archive.run.id,
    archive.run.runAttempt, execution.entry, jobId, result.stepNumber, execution.unitId, execution.channelId, execution.inputDigest])), 'invocation identity');
  check(step.startedAt && withinNativeJobWindow(execution.startedAt,step.startedAt,step.completedAt)
    && (!execution.completedAt || utc(execution.completedAt) >= utc(execution.startedAt)
      && withinNativeJobWindow(execution.completedAt,step.startedAt,step.completedAt)), 'result chronology');
  check(new Set(result.objects.map(object=>`${object.kind}:${object.id}`)).size === result.objects.length, 'duplicate object');
}
async function resultZip(bytes: Uint8Array): Promise<NativeResult> {
  const root = await mkdtemp(join(tmpdir(), 'steward-native-evidence-'));
  try {
    const path = join(root, 'result.zip'); await writeFile(path, bytes, { flag: 'wx' });
    const files = await extractArtifactFile(path, join(root, 'result'), { maxFiles: 1, maxFileBytes: 512*1024, maxTotalBytes: 512*1024 });
    check(files.size === 1 && files.has('result.json'), 'result artifact entries');
    return parseNativeResult(decodeBuildJson(await readFile(files.get('result.json')!.path)));
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function objectRead(reader: NativeEvidenceReader, object: NativeResult['objects'][number], archive: NativeArchive, context:EvidenceContext,errors:{code:string;retryAfter:string|null}[]): Promise<NativeArchive['objects'][number]> {
  const path = object.kind === 'artifact' ? `actions/artifacts/${object.id}` : `releases/${object.id}`;
  const proof: NativeArchive['objects'][number] = { kind: object.kind, id: object.id, expectedDigest: object.digest, actualDigest: null,
    status: 'UNKNOWN', observedAt: archive.observedAt, sourceUrl: `https://api.github.com${reader.path(path)}` };
  try {
    const native = await reader.json(path); check(native.id === object.id, 'object ID');
    if (object.kind === 'artifact') {
      check(native.workflow_run?.id === archive.run.id && native.workflow_run.head_sha === archive.run.headSha, 'object producer');
      if (native.expired) return proof;
      const downloaded = await reader.downloadDigest(`actions/artifacts/${object.id}/zip`);
      proof.actualDigest = downloaded.digest;
      check(native.digest === `sha256:${proof.actualDigest}`, 'object archive digest');
    } else {
      const unit=context.cycle.units.find(unit=>unit.releaseId===object.id);
      check(unit && native.tag_name===unit.tag && native.author?.id===context.appBotId,'release source');
      if(!unit.assets.length || unit.manifestDigest===null || unit.notesDigest===null)return proof;
      check(native.draft===false && native.immutable===true && hash(native.body)===unit.notesDigest,'release frozen facts');
      check((await reader.json(`commits/${encodeURIComponent(unit.tag)}`)).sha===context.cycle.sourceSha,'release tag source');
      // Match the frozen cycle byte set as well as the producer's object digest.
      const assets = await reader.pages(`releases/${object.id}/assets`, '');
      check(assets.length===unit.assets.length && new Set(assets.map(asset=>asset.name)).size===assets.length,'release asset set');
      const hashes = [];
      for (const asset of assets) {
        const downloaded = await reader.downloadDigest(`releases/assets/${asset.id}`);
        check(downloaded.size===asset.size,'asset size');
        check(unit.assets.some(expected=>expected.path===asset.name && expected.size===downloaded.size && expected.sha256===downloaded.digest),'release asset bytes');
        hashes.push([asset.id, asset.name, asset.size, downloaded.digest]);
      }
      check(same(stableReleaseFacts(native),stableReleaseFacts(await reader.json(path))) && same(stableAssetFacts(assets),stableAssetFacts(await reader.pages(`releases/${object.id}/assets`,''))),'release changed');
      proof.actualDigest = hash(JSON.stringify([native.id,native.tag_name,native.target_commitish,native.draft,native.immutable,native.body,hashes.sort((a,b)=>Number(a[0])-Number(b[0]))]));
    }
    proof.status = proof.actualDigest === object.digest ? 'MATCH' : 'CONFLICT';
  } catch (error) {
    if(error instanceof EvidenceReadError)errors.push({code:`HTTP_${error.status}`,retryAfter:error.retryAfter});
    // A private 404 is not absence. Only a complete native inventory can prove absence.
    if (error instanceof EvidenceReadError && error.status === 404) {
      try {
        const list = object.kind === 'artifact' ? await reader.pages(`actions/runs/${archive.run.id}/artifacts`, 'artifacts') : await reader.pages('releases', '');
        if (!list.some(item=>item.id === object.id)) proof.status = 'ABSENT';
      } catch(error) { if(error instanceof EvidenceReadError)errors.push({code:`HTTP_${error.status}`,retryAfter:error.retryAfter}); }
    } else if (error instanceof Error && error.message.startsWith('NATIVE_EVIDENCE:')) proof.status = 'CONFLICT';
  }
  return proof;
}

export function archiveFile(archive: NativeArchive): ArchiveFile {
  const content = JSON.stringify(archive) + '\n', sha256 = hash(content);
  decodeNativeArchive(Buffer.from(content));
  return { path: `evidence/native/${archive.run.id}-${archive.run.runAttempt}/${sha256}.json`, content, sha256 };
}
export function nativeReadFile(observation:NativeReadObservation):ArchiveFile {
  const content=JSON.stringify(observation)+'\n',sha256=hash(content);decodeNativeReadObservation(Buffer.from(content));
  return {path:`evidence/reads/${sha256}.json`,content,sha256};
}
function archiveExecutions(archive: NativeArchive, previous: NativeArchive[]) {
  const attempts: NativeJobAttempt[] = [];
  for (let attempt = 1; attempt < archive.run.runAttempt; attempt++) {
    const prior = previous.filter(value => value.run.id === archive.run.id && value.run.runAttempt === attempt)
      .sort((a,b) => b.observedAt.localeCompare(a.observedAt))[0];
    check(prior && prior.repositoryId === archive.repositoryId && prior.cycleId === archive.cycleId
      && prior.requestKey === archive.requestKey && prior.inputDigest === archive.inputDigest
      && prior.executorControllerSha === archive.executorControllerSha && prior.workflowBlobSha === archive.workflowBlobSha
      && prior.run.workflowId === archive.run.workflowId && prior.run.status === 'completed', 'job origin prior archive');
    attempts.push({ attempt, jobs: prior.jobs });
  }
  attempts.push({ attempt: archive.run.runAttempt, jobs: archive.jobs });
  return nativeJobOrigins(attempts).filter(({job,origin}) => job === origin && job.runAttempt === archive.run.runAttempt).map(({job}) => job);
}
export async function archiveAttempt(archive: NativeArchive, previous: NativeArchive[] = []): Promise<NativeAttemptEvidence> {
  const executed = archiveExecutions(archive, previous);
  const file = archiveFile(archive), invocations = new Map<string, NativeAttemptEvidence['invocations'][number]>();
  const results = [...archive.producers.map(item=>({jobId:item.jobId,result:item.result})), ...archive.logs.flatMap(log=>log.markers.map(marker=>({jobId:log.jobId,result:marker.result})))];
  results.sort((a,b)=>a.result.execution.observedAt.localeCompare(b.result.execution.observedAt));
  for (const { jobId, result } of results) {
    check(executed.some(job => job.id === jobId), 'retained job result attributed to later attempt');
    validateResult(result, archive, jobId);
    const evidence = structuredClone(result.execution), step = archive.jobs.find(job=>job.id===jobId)!.steps.find(step=>step.number===result.stepNumber)!;
    const objects = result.objects.map(object=>archive.objects.find(proof=>proof.kind===object.kind && proof.id===object.id && proof.expectedDigest===object.digest));
    if (evidence.outcome==='FACT_CONFLICT' || objects.some(proof=>proof?.status==='CONFLICT')) evidence.outcome='FACT_CONFLICT';
    else if (objects.length && objects.every(proof=>proof?.status==='MATCH')) {
      evidence.outcome='EFFECT_CONFIRMED';
      if(archive.run.status==='completed' && step.completedAt && !evidence.completedAt && step.completedAt>=evidence.startedAt)evidence.completedAt=step.completedAt;
    }
    else if (objects.some(proof=>!proof || proof.status==='UNKNOWN')) evidence.outcome='UNKNOWN';
    else if (evidence.businessStartedProven && archive.run.status==='completed' && step.completedAt
      && (objects.length && objects.every(proof=>proof?.status==='ABSENT') || evidence.outcome==='BUSINESS_FAILED' && ['failure','cancelled','timed_out'].includes(step.conclusion ?? ''))) {
      evidence.completedAt??=step.completedAt>=evidence.startedAt?step.completedAt:null;
      evidence.outcome=evidence.completedAt?'BUSINESS_FAILED':'UNKNOWN';
    } else if (evidence.outcome==='BUSINESS_FAILED' || evidence.outcome==='EFFECT_CONFIRMED' || evidence.businessStartedProven && evidence.outcome===null) evidence.outcome='UNKNOWN';
    evidence.observedAt=archive.observedAt; evidence.nativeEvidencePath=file.path;
    evidence.objectEvidencePaths=evidence.outcome==='BUSINESS_FAILED'||evidence.outcome==='EFFECT_CONFIRMED' ? [file.path] : [];
    const previous=invocations.get(evidence.invocationKey);
    if (previous && previous.evidence.businessStartedProven && !evidence.businessStartedProven) throw new Error('NATIVE_EVIDENCE: start fact removed');
    if(previous?.evidence.outcome==='EFFECT_CONFIRMED' && evidence.outcome!=='EFFECT_CONFIRMED') throw new Error('NATIVE_EVIDENCE: result conflict');
    invocations.set(evidence.invocationKey,{jobId,stepNumber:result.stepNumber,evidence});
  }
  return { repositoryId:archive.repositoryId,cycleId:archive.cycleId,workflowId:archive.run.workflowId,runId:archive.run.id,runAttempt:archive.run.runAttempt,
    entry:archive.run.path.endsWith('steward-release-publish.yml')?'build':'channel',sourceSha:archive.sourceSha,inputDigest:archive.inputDigest,
    executorControllerSha:archive.executorControllerSha,actorId:archive.run.actorId,status:archive.run.status,observedAt:archive.observedAt,
    jobsComplete:!archive.missingNativeKeys.length,jobs:executed.map(job=>({id:job.id,steps:job.steps})),invocations:[...invocations.values()],
    sourceUrl:`https://api.github.com/repos/${archive.repository}/actions/runs/${archive.run.id}/attempts/${archive.run.runAttempt}`,evidenceDigest:file.sha256 };
}

export async function inspectNativeCycle(input: EvidenceContext, history: ArchivedFile[] = [], io = nativeEvidenceTransport(process.env.GH_TOKEN), observedAt = new Date().toISOString(),readHistory:ReadHistory={complete:false,observations:[]}) {
  const context=validateEvidenceContext(input), reader=new NativeEvidenceReader(io,context.repository), archives:NativeArchive[]=[], missingNativeKeys:string[]=[], errors:{code:string;retryAfter:string|null}[]=[];
  const native:NativeAttemptSet={complete:true,runs:[],attempts:[]}, archived:ArchivedAttempt[]=[], latestRuns:NativeRun[]=[];let unrecoverable=false;
  const repo=await reader.json(''); check(repo.id===context.repositoryId && repo.full_name===context.repository && repo.archived===false && repo.disabled===false,'repository source');
  for (const request of context.cycle.dispatches) {
    if(request.continuationOfRunId!==null) {
      try {
        const file=readHistory.retryLimits?.find(item=>item.path===request.retryLimitEvidencePath);check(file,'limit proof missing');
        const proof=verifyNativeRetryLimit(context,file,history);
        const parent=context.cycle.dispatches.find(item=>item.canonicalRunId===request.continuationOfRunId);
        check(proof.terminalRun.id===request.continuationOfRunId&&parent&&proof.requestKey===parent.requestKey
          &&sameChannelOperation(parent,request),'continuation source');
      }catch{missingNativeKeys.push(`request:${request.requestKey}:native-limit-proof-required`);}
    }
    if(request.canonicalRunId===null) {
      const proof=readHistory.sourceRejections?.find(file=>file.value.requestKey===request.requestKey);
      if(proof) {try{verifyNativeSourceRejection(context,proof);}catch{missingNativeKeys.push(`request:${request.requestKey}:source-rejection`);}}
      else missingNativeKeys.push(`request:${request.requestKey}:canonical-run`);continue;
    }
    const runId=request.canonicalRunId;
    try {
      const latest=nativeRunFact(await reader.json(`actions/runs/${runId}`)); sourceRun(context,request,latest);
      const source=await workflowSource(reader,latest);
      const artifacts=await reader.pages(`actions/runs/${runId}/artifacts`,'artifacts');
      for(let attempt=1;attempt<=latest.runAttempt;attempt++) {
        const run=nativeRunFact(await reader.json(`actions/runs/${runId}/attempts/${attempt}`)); sourceRun(context,request,run);check(run.runAttempt===attempt,'attempt identity');
        const jobs=(await reader.pages(`actions/runs/${runId}/attempts/${attempt}/jobs`,'jobs')).map(jobFact);
        check(jobs.every(job=>job.runId===runId && job.runAttempt===attempt && job.headSha===run.headSha),'job source');
        const archive:NativeArchive={schemaVersion:1,repositoryId:context.repositoryId,repository:context.repository,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,
          requestKey:request.requestKey,inputDigest:request.inputDigest,...source,observedAt:utc(observedAt),run,jobs,producers:[],logs:[],objects:[],missingNativeKeys:[]};
        for(const job of archiveExecutions(archive, archives)) {
          const started=job.steps.filter(step=>step.name.startsWith('business-') && step.startedAt && step.conclusion!=='skipped');
          if(!started.length)continue;
          for(const step of started) {
            const name=`steward-result-${runId}-${attempt}-${job.id}-${step.number}`;
            const producers=artifacts.filter(artifact=>artifact.name===name && !artifact.expired);
            check(producers.length<=1,'ambiguous result producer');
            if(!producers.length)continue;
            try {
              const producer=await reader.json(`actions/artifacts/${producers[0].id}`);
              check(same(producer,producers[0]) && producer.workflow_run?.id===runId && producer.workflow_run.head_sha===run.headSha
                && utc(producer.created_at)>=job.startedAt! && job.completedAt && utc(producer.created_at)<=job.completedAt,'result producer identity');
              const bytes=(await reader.response(`actions/artifacts/${producer.id}/zip`,4*1024*1024)).bytes;
              check(producer.digest===`sha256:${hash(bytes)}` && producer.size_in_bytes===bytes.length,'producer digest');
              const result=await resultZip(bytes);validateResult(result,archive,job.id);check(result.stepNumber===step.number,'producer step');
              archive.producers.push({artifactId:producer.id,name,digest:hash(bytes),size:bytes.length,createdAt:utc(producer.created_at),expiresAt:utc(producer.expires_at),jobId:job.id,result});
            } catch(error) {
              archive.missingNativeKeys.push(`artifact:${producers[0].id}:result`);
              if(error instanceof EvidenceReadError)errors.push({code:`HTTP_${error.status}`,retryAfter:error.retryAfter});
            }
          }
          // Exact result artifact is sufficient; otherwise recover only closed, timestamped log markers.
          if(started.every(step=>archive.producers.some(producer=>producer.jobId===job.id && producer.result.stepNumber===step.number)))continue;
          try {
            const bytes=(await reader.response(`actions/jobs/${job.id}/logs`)).bytes, text=new TextDecoder('utf-8',{fatal:true}).decode(bytes), markers:NativeArchive['logs'][number]['markers']=[];
            for(const line of text.split(/\r?\n/)) {
              const match=/^(\S+) (BUSINESS_STARTED|STEWARD_RESULT) (\{.*\})$/.exec(line); if(!match)continue;
              const result=parseNativeResult(decodeBuildJson(Buffer.from(match[3]!)));validateResult(result,archive,job.id);
              if(match[2]==='BUSINESS_STARTED')check(result.execution.businessStartedProven && result.execution.outcome===null,'start marker');
              const eventAt=utc(match[1]);check(withinNativeJobWindow(eventAt,job.startedAt!,job.completedAt),'log event time');
              markers.push({eventAt,result});
            }
            archive.logs.push({jobId:job.id,digest:hash(bytes),markers});
          } catch(error) {
            if(error instanceof EvidenceReadError && error.status!==410)errors.push({code:`HTTP_${error.status}`,retryAfter:error.retryAfter});
            // A live Run can outlast its logs. Reuse original terminal facts only
            // on explicit expiry, with the same native job/step and source bytes.
            if(error instanceof EvidenceReadError && error.status===410) {
              const prior=history.filter(file=>file.value.run.id===runId && file.value.run.runAttempt===attempt && file.value.run.status==='completed')
                .sort((a,b)=>b.value.observedAt.localeCompare(a.value.observedAt))[0];
              if(prior) {
                check(archiveFile(prior.value).path===prior.path && /^[a-f0-9]{40}$/.test(prior.commit),'archive provenance');
                check(same(prior.value.run,run) && prior.value.inputDigest===archive.inputDigest && prior.value.sourceSha===archive.sourceSha
                  && prior.value.executorControllerSha===archive.executorControllerSha && prior.value.workflowBlobSha===archive.workflowBlobSha
                  && same(prior.value.jobs.find(value=>value.id===job.id),job),'archive immutable identity');
                archive.producers.push(...prior.value.producers.filter(value=>value.jobId===job.id));
                archive.logs.push(...prior.value.logs.filter(value=>value.jobId===job.id));
                archive.objects.push(...prior.value.objects);
              }
            }
          }
        }
        const results=[...archive.producers.map(value=>value.result),...archive.logs.flatMap(log=>log.markers.map(marker=>marker.result))];
        for(const result of results) {
          const execution=result.execution;
          check(execution.unitId===null || context.cycle.units.some(unit=>unit.id===execution.unitId),'result unit');
          if(request.purpose==='build')check(execution.channelId===null,'build channel');
          else check(JSON.parse(request.inputs.targets_json!).some((target:{unitId:string;channelId:string})=>target.unitId===execution.unitId && target.channelId===execution.channelId),'result target');
        }
        const objects=new Map(results.flatMap(result=>result.objects).map(object=>[JSON.stringify(object),object]));
        for(const object of objects.values()) {
          const proof=await objectRead(reader,object,archive,context,errors);
          const old=archive.objects.find(value=>value.kind===proof.kind && value.id===proof.id && value.expectedDigest===proof.expectedDigest);
          if(!old)archive.objects.push(proof);
          else if(proof.status!=='UNKNOWN')Object.assign(old,proof);
        }
        const after=nativeRunFact(await reader.json(`actions/runs/${runId}/attempts/${attempt}`));
        const jobsAfter=(await reader.pages(`actions/runs/${runId}/attempts/${attempt}/jobs`,'jobs')).map(jobFact);
        check(same(run,after) && same(jobs,jobsAfter),'attempt changed');
        const existing=history.find(file=>file.value.run.id===runId && file.value.run.runAttempt===attempt && sameFacts(file.value,archive));
        if(existing)check(archiveFile(existing.value).path===existing.path && /^[a-f0-9]{40}$/.test(existing.commit),'archive provenance');
        // Unchanged native facts reuse their original observation; scans do not
        // append another copy of every terminal attempt merely because time passed.
        const recorded=existing?.value ?? archive;
        native.attempts.push(await archiveAttempt(recorded, archives)); archives.push(recorded);
      }
      check(same(latest,nativeRunFact(await reader.json(`actions/runs/${runId}`))) && same(artifacts,await reader.pages(`actions/runs/${runId}/artifacts`,'artifacts')),'run changed');
      latestRuns.push(latest);
      native.runs.push({runId,workflowId:request.workflowId,entry:request.purpose==='build'?'build':'channel',sourceSha:context.cycle.sourceSha,
        inputDigest:request.inputDigest,actorId:context.appBotId,latestAttempt:latest.runAttempt,availability:'live'});
    } catch(error) {
      // 404 can hide a private repository. Only explicit 410 plus complete protected history is archive fallback.
      const prior=history.filter(file=>file.value.run.id===runId);
      let expired=error instanceof EvidenceReadError && error.status===410;
      if(error instanceof EvidenceReadError && error.status===404 && (prior.length||readHistory.complete)) {
        try {
          const runs=await reader.pages(`actions/workflows/${request.workflowId}/runs`,'workflow_runs');
          expired=!runs.some(run=>run.id===runId);
        } catch { /* Permission loss or incomplete pagination is not expiration. */ }
      }
      if(expired && prior.length) {
        for(const file of prior) check(/^[a-f0-9]{40}$/.test(file.commit) && archiveFile(file.value).path===file.path,'archive provenance');
        for(const file of prior) {
          check(/^[a-f0-9]{40}$/.test(file.commit) && archiveFile(file.value).path===file.path,'archive provenance');
          sourceRun(context,request,file.value.run);check(file.value.requestKey===request.requestKey && file.value.inputDigest===request.inputDigest,'archive request');
          const attempt=await archiveAttempt(file.value,prior.map(file=>file.value));archived.push({stateCommit:file.commit,rawDigest:hash(JSON.stringify(attempt)),attempt});
        }
        native.runs.push({runId,workflowId:request.workflowId,entry:request.purpose==='build'?'build':'channel',sourceSha:context.cycle.sourceSha,inputDigest:request.inputDigest,
          actorId:context.appBotId,latestAttempt:Math.max(...prior.map(file=>file.value.run.runAttempt)),availability:'expired'});
      } else {
        missingNativeKeys.push(`run:${runId}:native-read`);
        if(expired && readHistory.complete && !prior.length)unrecoverable=true;
        errors.push({code:error instanceof EvidenceReadError?`HTTP_${error.status}`:error instanceof Error && error.message.startsWith('NATIVE_EVIDENCE:')?error.message:'NATIVE_READ_UNAVAILABLE',retryAfter:error instanceof EvidenceReadError?error.retryAfter:null});
      }
    }
  }
  if(readHistory.publication) {archived.push(...(readHistory.publication.archived??[]));native.runs.push(...readHistory.publication.native.runs);native.attempts.push(...readHistory.publication.native.attempts);
    missingNativeKeys.push(...readHistory.publication.missing);if(!readHistory.publication.native.complete)missingNativeKeys.push('central-publication:incomplete');
  } else if(context.cycle.publications.length)missingNativeKeys.push('central-publication:original-evidence-required');
  // Validate the latest native attempt, without deriving a cross-stage failure budget.
  const latest = native.runs.flatMap(run => {
    const observations = run.availability==='expired' ? archived.map(item=>item.attempt) : native.attempts;
    return observations.filter(item=>item.runId===run.runId && item.runAttempt===run.latestAttempt)
      .sort((a,b)=>b.observedAt.localeCompare(a.observedAt)).slice(0,1);
  });
  const unknown=new Set(missingNativeKeys), conflicts=new Set<string>(), inFlight=new Set<string>();
  for(const item of latest) {
    const key=await nativeWaveKey(item);
    if(!item.jobsComplete)unknown.add(`${key}:jobs-incomplete`);
    if(item.status!=='completed'){inFlight.add(key);continue;}
    for(const job of item.jobs)for(const step of job.steps) {
      if(step.name.startsWith('business-') && step.startedAt && step.conclusion!=='skipped'
        && !item.invocations.some(inv=>inv.jobId===job.id && inv.stepNumber===step.number))unknown.add(`${key}:step:${job.id}:${step.number}:missing-result`);
    }
    for(const {evidence,jobId,stepNumber} of item.invocations) {
      const step=item.jobs.find(job=>job.id===jobId)?.steps.find(step=>step.number===stepNumber);
      if(!step || step.conclusion==='skipped' || !step.name.startsWith('business-')
        || evidence.jobId!==jobId && !(item.entry==='publish' && evidence.jobId===null)
        || await nativeWaveKey(evidence)!==key || evidence.inputDigest!==item.inputDigest
        || Date.parse(evidence.observedAt)>Date.parse(item.observedAt)
        || evidence.businessStartedProven && (!step.startedAt || !withinNativeJobWindow(evidence.startedAt,step.startedAt,step.completedAt))) {
        conflicts.add(`${key}:invocation-source`);continue;
      }
      if(evidence.outcome==='FACT_CONFLICT')conflicts.add(evidence.invocationKey);
      else if(evidence.outcome===null || evidence.outcome==='UNKNOWN'
        || ['WAIT','REJECTED_BEFORE_BUSINESS'].includes(evidence.outcome) && evidence.businessStartedProven
        || ['BUSINESS_FAILED','EFFECT_CONFIRMED'].includes(evidence.outcome)
          && (evidence.outcome==='BUSINESS_FAILED' && !evidence.businessStartedProven || !evidence.completedAt || !evidence.objectEvidencePaths.length))
        unknown.add(`${key}:${evidence.invocationKey}:missing-business-proof`);
    }
  }
  const currentFacts={unknownEvidence:[...unknown].sort(),conflictEvidence:[...conflicts].sort(),inFlightWaveKeys:[...inFlight].sort()};
  native.complete=unknown.size===0;
  const missing=[...new Set([...unknown,...conflicts])].sort();
  let consecutive=0;
  const prior=readHistory.observations.map(value=>decodeNativeReadObservation(Buffer.from(JSON.stringify(value))))
    .filter(value=>value.repositoryId===context.repositoryId && value.cycleId===context.cycle.id && value.observedAt<utc(observedAt))
    .sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
  for(const value of prior){if(value.disposition!=='RETRY')break;consecutive++;}
  let nextCheckAt:string|null=null;
  if(missing.length&&!unrecoverable) {
    let next=Date.parse(observedAt)+[1,5,15,60][Math.min(consecutive,3)]!*60_000;
    for(const error of errors)if(error.retryAfter!==null) {
      const lower=/^[0-9]+$/.test(error.retryAfter)?Date.parse(observedAt)+Number(error.retryAfter)*1000:Date.parse(error.retryAfter);
      if(Number.isFinite(lower) && Number.isFinite(new Date(lower).getTime()))next=Math.max(next,lower);
    }
    nextCheckAt=new Date(next).toISOString();
  }
  let readObservation:NativeReadObservation={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,observedAt:utc(observedAt),
    sourceUrl:`https://api.github.com/repos/${context.repository}/actions/runs`,missingNativeKeys:missing,errorCodes:errors.map(error=>error.code),
    disposition:unrecoverable?'UNRECOVERABLE':missing.length?'RETRY':'COMPLETE',nextCheckAt};
  if(unrecoverable)readObservation.errorCodes.push('EVIDENCE_UNRECOVERABLE');
  if(readObservation.disposition==='COMPLETE' && prior[0]?.disposition==='COMPLETE' && sameFacts(prior[0],readObservation))readObservation=prior[0];
  return {context,archives,history,native,archived,currentFacts,missingNativeKeys,errors,observedAt:utc(observedAt),readObservation,latestRuns};
}

/** Fixed native rerun connection. Every invocation re-reads all history, archives, then reads the exact Run again. */
export async function recoverNativeCycle(input: EvidenceContext, runId: number, store: EvidenceStore, history: ArchivedFile[] = [],
  io = nativeEvidenceTransport(process.env.GH_TOKEN), observedAt = new Date().toISOString(),readHistory:ReadHistory={complete:false,observations:[]}) {
  const observation=await inspectNativeCycle(input,history,io,observedAt,readHistory), {context,currentFacts}=observation;
  const saved=await store.archive([...observation.archives.map(archiveFile),nativeReadFile(observation.readObservation)]);
  if(!['APPLIED','UNCHANGED'].includes(saved.status) || !saved.head || observation.archives.filter(archive=>archive.run.status==='completed').some(archive=>
    !saved.records.some(record=>record.path===archiveFile(archive).path && archiveFile(record.value).sha256===archiveFile(archive).sha256)))
    return {status:'UNKNOWN',reason:'ARCHIVE_NOT_CONFIRMED',observation};
  if(observation.readObservation.disposition==='UNRECOVERABLE')return {status:'BLOCKED',reason:'EVIDENCE_UNRECOVERABLE',observation};
  if(currentFacts.unknownEvidence.length || currentFacts.conflictEvidence.length)return {status:'UNKNOWN',reason:'EVIDENCE_INCOMPLETE',observation};
  if(currentFacts.inFlightWaveKeys.length)return {status:'WAIT',reason:'RUN_IN_FLIGHT',observation};
  const request=context.cycle.dispatches.find(request=>request.canonicalRunId===runId);check(request,'canonical run required');
  if(context.cycle.dispatches.some(item=>item.continuationOfRunId===runId))return {status:'SATISFIED',reason:'CONTINUATION_RETAINS_ORIGINAL_HISTORY',observation};
  const expired=observation.native.runs.some(run=>run.runId===runId&&run.availability==='expired');
  const originals=expired?history.filter(file=>file.value.run.id===runId).map(file=>file.value):observation.archives.filter(archive=>archive.run.id===runId);
  const chain=[...new Map([...originals].sort((a,b)=>a.observedAt.localeCompare(b.observedAt)).map(archive=>[archive.run.runAttempt,archive])).values()].sort((a,b)=>a.run.runAttempt-b.run.runAttempt);
  const archive=chain.at(-1);
  if(!archive)return {status:'UNKNOWN',reason:'ORIGINAL_RUN_EVIDENCE_REQUIRED',observation};
  const reader=new NativeEvidenceReader(io,context.repository), latestBefore=expired?archive.run:nativeRunFact(await reader.json(`actions/runs/${runId}`));sourceRun(context,request,latestBefore);
  // Latest-Run and attempt endpoints have independently updated metadata. Check
  // stability against the same endpoint, then bind both views to one execution.
  if(!expired && (!same(latestBefore,observation.latestRuns.find(run=>run.id===runId))
    || Date.parse(archive.run.createdAt)<Date.parse(latestBefore.createdAt)
    || !same({...latestBefore,createdAt:archive.run.createdAt,updatedAt:archive.run.updatedAt},archive.run)))return {status:'WAIT',reason:'RUN_CHANGED',observation};
  const before=expired?archive.run:nativeRunFact(await reader.json(`actions/runs/${runId}/attempts/${latestBefore.runAttempt}`));sourceRun(context,request,before);
  if(!same(before,archive.run))return {status:'WAIT',reason:'RUN_CHANGED',observation};
  const results=[...archive.producers.map(value=>value.result),...archive.logs.flatMap(log=>log.markers.map(marker=>marker.result))];
  if(results.some(result=>result.reasonCode==='SOURCE_REF_MOVED'))return {status:'CONFLICT',reason:'SOURCE_REF_MOVED',observation};
  const attempt=observation.native.attempts.find(item=>item.runId===runId && item.runAttempt===before.runAttempt)??observation.archived.find(item=>item.attempt.runId===runId&&item.attempt.runAttempt===before.runAttempt)!.attempt;
  if(attempt.invocations.length && attempt.invocations.every(invocation=>['EFFECT_CONFIRMED','REJECTED_BEFORE_BUSINESS'].includes(invocation.evidence.outcome??''))
    && !results.some(result=>result.reasonCode==='DEPENDENCY_NOT_READY'))
    return {status:'SATISFIED',reason:'EFFECTS_ARCHIVED',observation};
  if(expired || before.runAttempt>=51 || Date.parse(observedAt)-Date.parse(chain[0]!.run.createdAt)>30*24*60*60_000)
    return {status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED',runId,observation};
  // One automatic native rerun per Run; further failures remain visible for native maintenance.
  if(before.runAttempt>1)return {status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED',runId,observation};
  let path:string;
  if(['failure','cancelled','timed_out','action_required'].includes(before.conclusion ?? ''))path=`actions/runs/${runId}/rerun-failed-jobs`;
  else if(before.conclusion==='success' && results.some(result=>result.reasonCode==='DEPENDENCY_NOT_READY')) {
    // Only fresh native observations may wake a successful pending run.
    let ready=false;
    const {retainedChannelObservations,channelReadyTargets}=await import('./release-run.js');
    const targets=context.cycle.requiredChannels.map(channel=>{const unit=context.cycle.units.find(unit=>unit.id===channel.unitId)!;return {...channel,version:unit.version,releaseId:unit.releaseId!,manifestDigest:unit.manifestDigest!};});
    try {
      const observed=retainedChannelObservations(context,readHistory.channelEvidence??[],observedAt);
      const pending=results.filter(result=>result.reasonCode==='DEPENDENCY_NOT_READY').map(result=>targets.find(target=>target.unitId===result.execution.unitId&&target.channelId===result.execution.channelId)!);
      const reads=observed.reads.filter(item=>pending.some(target=>target.unitId===item.unitId&&target.channelId===item.channelId));
      if(reads.length===pending.length)ready=channelReadyTargets(context,pending,request.purpose==='channel-submit'?'submit':'verify',reads,observedAt).ready.length>0;
    }catch {return {status:'UNKNOWN',reason:'PREPARATION_PROBE_INVALID',observation};}
    if(!ready)return {status:'WAIT',reason:'DEPENDENCY_NOT_READY',observation};
    const jobs=archive.jobs.filter(job=>job.name==='channel-prepare');check(jobs.length===1 && jobs[0]!.status==='completed','channel-prepare identity');
    path=`actions/jobs/${jobs[0]!.id}/rerun`;
  } else return {status:'SATISFIED',reason:'NO_NATIVE_RECOVERY_REQUIRED',observation};
  let response:EvidenceResponse|undefined;
  try {response=await io.request('POST',reader.path(path));} catch { /* Unknown write response: only exact-object readback follows. */ }
  try {
    const after=nativeRunFact(await reader.json(`actions/runs/${runId}`));sourceRun(context,request,after);
    if(after.runAttempt>before.runAttempt)return {status:'ACCEPTED',runId,observedAttempt:after.runAttempt,archiveHead:saved.head,observation};
    if(after.runAttempt<before.runAttempt)throw new Error('NATIVE_EVIDENCE: attempt regressed');
    return {status:'UNKNOWN',reason:response && ![201,202].includes(response.status)?`RERUN_HTTP_${response.status}`:'RERUN_NOT_YET_OBSERVED',runId,observedAttempt:after.runAttempt,archiveHead:saved.head,observation};
  } catch {return {status:'UNKNOWN',reason:'RERUN_READBACK_UNAVAILABLE',runId,archiveHead:saved.head,observation};}
}
