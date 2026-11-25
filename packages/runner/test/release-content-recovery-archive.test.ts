import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {selectContentArchive,verifyContentRecoveryArchive}=await import(pathToFileURL(resolve('scripts/release-content-recovery.mjs')).href);
const {acceptanceErrorCode}=await import(pathToFileURL(resolve('scripts/business-flow-acceptance.mjs')).href);
import { CONTENT_OUTPUT_SCHEMA, contentOutputSchema, verifyContentAttemptReceipts } from '../../core/src/release-content.js';

it('bounds public failure diagnostics to machine codes',()=>{
  expect(acceptanceErrorCode(Error('ACCEPTANCE_SOURCE_CHANGED'))).toBe('ACCEPTANCE_SOURCE_CHANGED');
  expect(acceptanceErrorCode(Error('CONTENT_RECOVERY_BINDING'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
  expect(acceptanceErrorCode(Error('secret text'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
  expect(acceptanceErrorCode(Error('ACCEPTANCE_SOURCE_CHANGED\nprivate'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
});

it('reads the original address for a previously transferred receipt',async()=>{
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const generated=digest('archive'),controller='a'.repeat(40),candidate='historical';
  const transferred=digest(['content-archive-transfer/v1',generated,controller]);
  const saved={input:{candidateId:candidate,controllerSha:controller,batches:[{attempts:[{recovery:{archiveContentDigest:generated}}]}]}};
  const read=async(path:string)=>{expect(path).toBe(`content/${candidate}/${transferred}/manifest.json`);return saved;};
  const result=await selectContentArchive({id:candidate,contentGenerationDigest:transferred},generated,{loadDocument:read,controllerSha:controller});
  expect(result).toEqual({digest:transferred,transferBaseDigest:generated});
});

it('rejects an archived recovery receipt with an incomplete locator',async()=>{
  const sha='a'.repeat(64);
  const attempt={ordinal:1,startedAt:'2026-11-08T00:00:00Z',status:'REJECTED' as const,model:'fixture',usage:null,errorCode:'CONTENT_OUTPUT_SCHEMA'};
  const recovery={previousAttemptSha256:sha,authorizationId:sha,outputContractSha256:sha,archiveContentDigest:sha};
  await expect(verifyContentAttemptReceipts([attempt,{...attempt,ordinal:2,recovery}])).rejects.toThrow('CONTENT_ATTEMPT_SCHEMA');
});

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(conditionalDigest?: string){
  const format = conditionalDigest ? {conditional:true} : {};
  const identity={repositoryId:1,defaultBranch:'main',targetSha:'a'.repeat(40),controllerSha:'b'.repeat(40)};
  const unit={id:'app',path:'.',version:'1.0.0',tag:'v1.0.0'},boundary={kind:'full-tree'};
  const evidence={manifests:[{unit,identity,boundary,commits:[{sha:identity.targetSha}]}],gaps:[]};
  const input={schemaVersion:2,repositoryId:1,candidateId:hash('candidate'),baseSha:identity.targetSha,controllerSha:identity.controllerSha,
    units:[unit],boundaries:[{unitId:'app',kind:'full-tree',sha:null,reference:null}],sourceManifestDigest:hash(evidence.manifests),configDigest:hash('config'),batches:[]};
  const source={id:hash('source'),unitId:'app',path:'README.md',previousPath:null,status:'CURATED',oid:identity.targetSha,mode:'100644',byteLength:6,encoding:'utf8',sha256:hash('示例'),start:0,end:6,text:'示例',stage:'CONTEXT'};
  const payload={...format,stage:'DRAFT',unitIds:[unit.id],units:[unit],sources:[source],items:[],background:[]};
  const inputDigest=hash(payload),id=hash([input.candidateId,input.configDigest,inputDigest]);
  const batch={id,stage:'DRAFT',unitIds:[unit.id],sourceIds:[source.id],inputDigest,status:'PENDING',attempts:[],nextCheckAt:null,resultPath:null,errorCode:null};
  const pending={input:{...input,batches:[batch]},payloads:{[id]:payload},evidence};
  const work=structuredClone(pending),old=pending;
  const attempt={ordinal:1,startedAt:'2026-11-08T00:00:00Z',status:'REJECTED',model:'fixture',usage:null,errorCode:'CONTENT_OUTPUT_SCHEMA'};
  Object.assign(batch,{status:'FAILED',errorCode:'CONTENT_OUTPUT_SCHEMA',attempts:[attempt]});
  const protections={branch:[{type:'deletion'},{type:'workflows',ruleset_id:18883080,ruleset_source:'splrad',ruleset_source_type:'Organization',
    parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:'d'.repeat(40)}]}}],tags:[{type:'deletion'}]};
  const archiveProtectionDigest=hash([protections.branch,protections.tags]),protectionPath=`generated/protections-${archiveProtectionDigest}.json`;
  const facts={baseSha:identity.targetSha,config:'fixed',protectionsEvidencePath:protectionPath},authorsDigest=hash('authors');
  const archiveContentDigest=hash([hash(facts),input.configDigest,authorsDigest]),root=`content/${input.candidateId}/${archiveContentDigest}/`;
  const manifest={...format,input:old.input,payloadPaths:{[batch.id]:root+`batches/${batch.id}.json`},evidencePath:root+'source-manifest.json'};
  const docs={[root+'manifest.json']:manifest,[manifest.payloadPaths[batch.id]!]:old.payloads[batch.id],[manifest.evidencePath]:evidence,[protectionPath]:{facts,protections}};
  const nextEvidence=structuredClone(evidence);nextEvidence.manifests[0]!.identity.controllerSha='c'.repeat(40);
  work.input.controllerSha='c'.repeat(40);
  work.input.sourceManifestDigest=hash(nextEvidence.manifests);
  work.evidence=nextEvidence;
  const currentProtections=structuredClone(protections);currentProtections.branch[1]!.parameters!.workflows[0]!.sha='e'.repeat(40);
  const currentFacts={...facts,protectionsEvidencePath:`generated/protections-${hash([currentProtections.branch,currentProtections.tags])}.json`};
  const key=hash([batch.inputDigest,input.configDigest]),cache={[key]:{...format,inputDigest:batch.inputDigest,configDigest:input.configDigest,attempts:[structuredClone(attempt)],result:null}};
  const grant={candidateId:input.candidateId,batchId:batch.id,previousAttemptSha256:hash(attempt),authorizationId:hash('approval'),outputContractSha256:conditionalDigest ?? hash(CONTENT_OUTPUT_SCHEMA),archiveContentDigest,archiveProtectionDigest};
  const io={loadDocument:async (path:string)=>docs[path]??null,facts:currentFacts,protections:currentProtections,authorsDigest};
  return {work,cache,grant,io,docs,manifest,old,attempt,key,root,protectionPath};
}
it.each(['pending snapshot','recorded transfer'])('verifies %s using only reads',async kind=>{
  const f=fixture();
  if(kind==='recorded transfer'){
    const {candidateId,batchId,...receipt}=f.grant;
    Object.assign(f.work.input.batches[0]!,{status:'FAILED',errorCode:'CONTENT_OUTPUT_SCHEMA',
      attempts:[structuredClone(f.attempt),{...f.attempt,ordinal:2,recovery:receipt}]});
  }
  const before=JSON.stringify(f);
  await expect(verifyContentRecoveryArchive(f.work,f.cache,f.grant,f.io)).resolves.toEqual({
    candidateId:f.grant.candidateId,batchId:f.grant.batchId,previousAttemptSha256:hash(f.attempt)});
  expect(JSON.stringify(f)).toBe(before);
});
it.each(['missing-archive','missing-pair','path','facts','protection','pin','workflow-ref','duplicate-workflow','source','identity','config','payload','history','old-result','old-nextCheck','unknown','other-rejection','second-failure','cache','grant','contract','unsafe-locator','receipt-authorization'])('refuses mismatched historical evidence: %s',async kind=>{
  // Fault injection deliberately creates invalid documents and receipts.
  const f:any=fixture();
  if(kind==='missing-archive')delete f.docs[f.root+'manifest.json'];
  if(kind==='missing-pair')delete f.grant.archiveProtectionDigest;
  if(kind==='path')f.manifest.evidencePath='other.json';
  if(kind==='facts')f.io.facts.baseSha='d'.repeat(40);
  if(kind==='protection')f.io.protections.tags.push({type:'update'});
  if(kind==='pin')f.io.protections.branch[1].parameters.workflows[0].sha='d'.repeat(40);
  if(kind==='workflow-ref')f.io.protections.branch[1].parameters.workflows[0].ref='main';
  if(kind==='duplicate-workflow')f.io.protections.branch.push({...f.io.protections.branch[1],parameters:{workflows:[]}});
  if(kind==='source')f.work.evidence.manifests[0].commits.push({sha:'d'.repeat(40)});
  if(kind==='identity')f.work.input.repositoryId=2;
  if(kind==='config')f.work.input.configDigest=hash('changed');
  if(kind==='payload')f.work.payloads[f.grant.batchId].sources[0].text='变化';
  if(kind==='history')f.work.input.batches[0].attempts=[structuredClone(f.attempt)];
  if(kind==='old-result')f.manifest.input.batches[0].resultPath='results/prior.json';
  if(kind==='old-nextCheck')f.manifest.input.batches[0].nextCheckAt='2027-01-01T00:00:00Z';
  if(kind==='unknown')f.manifest.input.batches[0].attempts[0].status='UNKNOWN';
  if(kind==='other-rejection')f.manifest.input.batches[0].attempts[0].errorCode='WAIT_AUTH';
  if(kind==='second-failure')f.manifest.input.batches[0].attempts.push({...f.attempt,ordinal:2});
  if(kind==='cache')f.cache[f.key].attempts[0].model='different';
  if(kind==='grant')f.grant.previousAttemptSha256=hash('wrong');
  if(kind==='contract')f.grant.outputContractSha256=hash('different schema');
  if(kind==='unsafe-locator')f.grant.candidateId='../other';
  if(kind==='receipt-authorization'){
    const {candidateId,batchId,...receipt}=f.grant;
    Object.assign(f.work.input.batches[0]!,{status:'FAILED',attempts:[f.attempt,{...f.attempt,ordinal:2,recovery:{...receipt,authorizationId:hash('different')}}]});
  }
  const before=JSON.stringify(f);await expect(verifyContentRecoveryArchive(f.work,f.cache,f.grant,f.io)).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE');expect(JSON.stringify(f)).toBe(before);
});

const waitUntil = '2026-11-08T00:01:00.000Z';

function recorded(attemptStatus: string, attemptCode: string | null, batchStatus: string, batchCode: string | null, nextCheckAt: string | null, conditionalDigest?: string) {
  const f = fixture(conditionalDigest);
  const batch = f.work.input.batches[0]!;
  const {candidateId, batchId, ...recovery} = f.grant;
  Object.assign(batch, {status: batchStatus, errorCode: batchCode, nextCheckAt,
    attempts: [structuredClone(f.attempt), {...f.attempt, ordinal: 2, status: attemptStatus, errorCode: attemptCode, recovery}]});
  return f;
}

const validStates = [
  ['SENT', null, 'RUNNING', null, null],
  ['SENT', null, 'FAILED', 'RESPONSE_UNKNOWN', null],
  ['UNKNOWN', 'RESPONSE_UNKNOWN', 'FAILED', 'RESPONSE_UNKNOWN', null],
  ['REJECTED', 'CONTENT_OUTPUT_SCHEMA', 'FAILED', 'CONTENT_OUTPUT_SCHEMA', null],
  ['REJECTED', 'WAIT_AUTH', 'WAIT_AUTH', 'WAIT_AUTH', waitUntil],
  ['REJECTED', 'WAIT_QUOTA', 'WAIT_QUOTA', 'WAIT_QUOTA', waitUntil],
  ['REJECTED', 'WAIT_AUTH', 'FAILED', 'WAIT_AUTH', waitUntil],
  ['REJECTED', 'WAIT_QUOTA', 'FAILED', 'WAIT_QUOTA', waitUntil],
] as const;

it.each(validStates)('reads recorded %s %s as %s, %s, %s', async (...state) => {
  const f = recorded(...state);
  const before = JSON.stringify(f);
  await expect(verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io)).resolves.toMatchObject({batchId: f.grant.batchId});
  expect(JSON.stringify(f)).toBe(before);
});

const invalidStates = [
  ['SENT', null, 'PENDING', null, null],
  ['SENT', null, 'FAILED', null, null],
  ['SENT', 'CONTENT_OUTPUT_SCHEMA', 'RUNNING', null, null],
  ['SENT', null, 'RUNNING', null, waitUntil],
  ['UNKNOWN', 'RESPONSE_UNKNOWN', 'READY', null, null],
  ['UNKNOWN', 'WAIT_AUTH', 'FAILED', 'WAIT_AUTH', null],
  ['REJECTED', 'CONTENT_OUTPUT_SCHEMA', 'PENDING', null, null],
  ['REJECTED', 'CONTENT_OUTPUT_SCHEMA', 'FAILED', null, null],
  ['REJECTED', 'RESPONSE_UNKNOWN', 'FAILED', 'RESPONSE_UNKNOWN', null],
  ['REJECTED', 'CONTENT_OUTPUT_SCHEMA', 'FAILED', 'CONTENT_OUTPUT_SCHEMA', waitUntil],
  ['REJECTED', 'WAIT_QUOTA', 'WAIT_AUTH', 'WAIT_QUOTA', waitUntil],
  ['REJECTED', 'WAIT_AUTH', 'FAILED', 'WAIT_AUTH', null],
  ['REJECTED', 'WAIT_AUTH', 'WAIT_AUTH', 'WAIT_AUTH', 'unparseable'],
  ['REJECTED', 'WAIT_AUTH', 'WAIT_AUTH', 'WAIT_AUTH', '2026-11-08T00:00:59.999Z'],
] as const;

it.each(invalidStates)('refuses recorded %s %s with %s, %s, %s', async (...state) => {
  const f = recorded(...state);
  await expect(verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io)).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE');
});

it('refuses a result path on an unsuccessful batch', async () => {
  const f = recorded('REJECTED', 'CONTENT_OUTPUT_SCHEMA', 'FAILED', 'CONTENT_OUTPUT_SCHEMA', null);
  Object.assign(f.work.input.batches[0]!, {resultPath: 'results/other.json'});
  await expect(verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io)).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE');
});

function returned(sameGeneration = false, conditionalDigest?: string) {
  const f = recorded('RETURNED', null, 'READY', null, null, conditionalDigest);
  if (sameGeneration) {
    const original = f.docs[f.protectionPath] as {facts: typeof f.io.facts; protections: typeof f.io.protections};
    f.io.facts = original.facts;
    f.io.protections = original.protections;
  }
  const batch = f.work.input.batches[0]!;
  const generated = hash([hash(f.io.facts), f.work.input.configDigest, f.io.authorsDigest]);
  const directory = sameGeneration ? hash(['content-archive-transfer/v1', generated, f.work.input.controllerSha]) : generated;
  const path = `content/${f.grant.candidateId}/${directory}/results/${batch.id}.json`;
  Object.assign(batch, {resultPath: path});
  const document = {...(conditionalDigest ? {conditional:true} : {}),stage: 'DRAFT', sourceIds: batch.sourceIds, result: {paragraphs: [{sourceIds: batch.sourceIds,
    section: 'summary', textZh: '离线验证说明。', qualification: 'UNVERIFIED'}]}};
  const chunks = [{schemaVersion: 1, repositoryId: f.work.input.repositoryId, candidateId: f.grant.candidateId, documentKind: 'content-result',
    documentDigest: hash(document), index: 0, count: 1, content: JSON.stringify(document)}];
  const reads: string[] = [];
  const io = {...f.io, loadResultChunks: async (requested: string) => {reads.push(requested); return requested === path ? chunks : []; }};
  return {...f, io, batch, document, chunks, reads, path};
}

it('binds returned content to the archived conditional contract', async () => {
  const historical = '73d81fa29397a2b09c536e388ee8a6f793f1d0fa8957cfcab73523f1748d2cf7';
  for (const digest of [historical, hash(contentOutputSchema(true))]) {
    const f = returned(false, digest);
    const check = () => verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io);
    await expect(check()).resolves.toMatchObject({batchId:f.batch.id});
    Object.assign(f.document.result.paragraphs[0]!, {section:'acquisition', textZh:'**安装**。使用本版安装包。'});
    Object.assign(f.chunks[0]!, {content:JSON.stringify(f.document), documentDigest:hash(f.document)});
    if (digest === historical) await expect(check()).resolves.toMatchObject({batchId:f.batch.id});
    else await expect(check()).rejects.toThrow('CONTENT_OUTPUT_SCHEMA');
  }
  const ordinary = fixture();
  ordinary.grant.outputContractSha256 = historical;
  await expect(verifyContentRecoveryArchive(ordinary.work, ordinary.cache, ordinary.grant, ordinary.io)).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE');
});

it.each([false, true])('reads the archived result from its derived directory (same digest: %s)', async sameGeneration => {
  const f = returned(sameGeneration);
  const before = JSON.stringify([f.work, f.cache, f.chunks]);
  await expect(verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io)).resolves.toMatchObject({batchId: f.batch.id});
  expect(f.reads).toEqual([f.path]);
  expect(JSON.stringify([f.work, f.cache, f.chunks])).toBe(before);
});

it.each(['batch-status', 'attempt-error', 'batch-error', 'next-check', 'missing-path', 'relative-path', 'other-generation', 'other-batch',
  'missing-chunks', 'candidate', 'repository', 'kind', 'digest', 'sources', 'result-schema', 'conditional'])('refuses inconsistent returned result: %s', async kind => {
  const f = returned();
  const last = f.batch.attempts[1]!;
  const chunk = f.chunks[0]!;
  if (kind === 'batch-status') f.batch.status = 'FAILED';
  if (kind === 'attempt-error') Object.assign(last, {errorCode: 'CONTENT_OUTPUT_SCHEMA'});
  if (kind === 'batch-error') Object.assign(f.batch, {errorCode: 'RESPONSE_UNKNOWN'});
  if (kind === 'next-check') Object.assign(f.batch, {nextCheckAt: waitUntil});
  if (kind === 'missing-path') f.batch.resultPath = null;
  if (kind === 'relative-path') Object.assign(f.batch, {resultPath: `results/${f.batch.id}.json`});
  if (kind === 'other-generation') Object.assign(f.batch, {resultPath: f.root + `results/${f.batch.id}.json`});
  if (kind === 'other-batch') Object.assign(f.batch, {resultPath: f.path.replace(f.batch.id + '.json', hash('other') + '.json')});
  if (kind === 'missing-chunks') f.chunks.length = 0;
  if (kind === 'candidate') chunk.candidateId = hash('other');
  if (kind === 'repository') chunk.repositoryId++;
  if (kind === 'kind') chunk.documentKind = 'content';
  if (kind === 'digest') chunk.documentDigest = hash('other');
  if (kind === 'sources' || kind === 'result-schema' || kind === 'conditional') {
    if (kind === 'sources') {
      f.document.sourceIds = [hash('other')];
      f.document.result.paragraphs[0]!.sourceIds = f.document.sourceIds;
    }
    if (kind === 'result-schema') f.document.result.paragraphs[0]!.qualification = 'unknown';
    if (kind === 'conditional') Object.assign(f.document, {conditional: true});
    chunk.content = JSON.stringify(f.document);
    chunk.documentDigest = hash(f.document);
  }
  await expect(verifyContentRecoveryArchive(f.work, f.cache, f.grant, f.io)).rejects.toThrow();
});
