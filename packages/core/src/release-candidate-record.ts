import { decodeBuildJson } from './build-manifest.js';
import { sha256Hex } from './fingerprint.js';
import { validateCandidateFiles } from './release-candidate.js';
import { retryableContentRejection, validateContentInput, validateContentResult } from './release-content.js';

export interface CandidateArchiveChunk {
  schemaVersion: 1; repositoryId: number; candidateId: string;
  documentKind: 'session' | 'content' | 'cache' | 'generated' | 'adoption' | 'native-input' | 'content-result' | 'content-payload' | 'content-evidence' | 'cache-entry' | 'merged-candidate' | 'repair-decision';
  documentDigest: string; index: number; count: number; content: string;
}
const exact = (value: any, keys: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value)
  || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('CANDIDATE_RECORD_FIELDS'); };
/** Closed UTF-8 archive fragments. Complete typed documents are verified after digest-bound assembly. */
export function decodeCandidateArchive(bytes: Uint8Array, repositoryId: number): CandidateArchiveChunk {
  const record = decodeBuildJson(bytes) as CandidateArchiveChunk;
  exact(record, ['schemaVersion', 'repositoryId', 'candidateId', 'documentKind', 'documentDigest', 'index', 'count', 'content']);
  if (record.schemaVersion !== 1 || record.repositoryId !== repositoryId || !/^[a-f0-9]{64}$/.test(record.candidateId)
    || !['session', 'content', 'cache', 'generated', 'adoption', 'native-input', 'content-result', 'content-payload', 'content-evidence', 'cache-entry', 'merged-candidate', 'repair-decision'].includes(record.documentKind) || !/^[a-f0-9]{64}$/.test(record.documentDigest)
    || !Number.isSafeInteger(record.count) || record.count < 1 || !Number.isSafeInteger(record.index) || record.index < 0 || record.index >= record.count
    || typeof record.content !== 'string' || new TextEncoder().encode(record.content).length > 256 * 1024) throw new Error('CANDIDATE_ARCHIVE_INVALID');
  return record;
}
function snapshot(value: any) {
  exact(value, ['schemaVersion', 'baseSha', 'files', 'units', 'configDigest', 'sourceDigest']);
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.baseSha) || !/^[a-f0-9]{64}$/.test(value.configDigest)
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !Array.isArray(value.files) || !Array.isArray(value.units)) throw new Error('CANDIDATE_SNAPSHOT_INVALID');
  validateCandidateFiles(value.files);
  for (const file of value.files) exact(file, ['path', 'mode', 'content']);
  for (const unit of value.units) { exact(unit, ['id', 'path', 'version', 'tag']); if (Object.values(unit).some(v => typeof v !== 'string' || !v)) throw new Error('CANDIDATE_UNIT_INVALID'); }
}
export async function decodeCandidateDocument(chunks: CandidateArchiveChunk[]): Promise<any> {
  if (!chunks.length) throw new Error('CANDIDATE_ARCHIVE_MISSING');
  const first = chunks[0]!, ordered = [...chunks].sort((a, b) => a.index - b.index);
  if (first.count !== chunks.length || ordered.some((c, i) => c.index !== i || c.count !== first.count || c.documentDigest !== first.documentDigest
    || c.documentKind !== first.documentKind || c.repositoryId !== first.repositoryId || c.candidateId !== first.candidateId)) throw new Error('CANDIDATE_ARCHIVE_COVERAGE');
  const text = ordered.map(c => c.content).join('');
  if (await sha256Hex(text) !== first.documentDigest) throw new Error('CANDIDATE_ARCHIVE_DIGEST');
  const value = JSON.parse(text);
  if (first.documentKind === 'generated') snapshot(value);
  else if (first.documentKind === 'content') {
    exact(value, ['input', 'payloadPaths', 'evidencePath']); validateContentInput(value.input);
    if (value.input.repositoryId !== first.repositoryId || value.input.candidateId !== first.candidateId) throw new Error('CONTENT_ARCHIVE_IDENTITY');
    for (const batch of value.input.batches) {
      if (typeof value.payloadPaths[batch.id] !== 'string' || !value.payloadPaths[batch.id].startsWith(`content/${first.candidateId}/`)) throw new Error('CONTENT_PAYLOAD_PATH');
    }
    if (typeof value.evidencePath !== 'string' || !value.evidencePath.startsWith(`content/${first.candidateId}/`)) throw new Error('CONTENT_EVIDENCE_PATH');
  } else if (first.documentKind === 'content-payload') {
    exact(value, ['stage', 'unitIds', 'units', 'sources', 'items', 'background']);
    if (!['DRAFT', 'CONTEXT', 'DIFF', 'COMPOSE'].includes(value.stage) || !Array.isArray(value.sources) || !Array.isArray(value.items) || !Array.isArray(value.background)) throw new Error('CONTENT_PAYLOAD_INVALID');
  } else if (first.documentKind === 'content-evidence') {
    exact(value, ['manifests', 'gaps']);
    if (!Array.isArray(value.manifests) || !Array.isArray(value.gaps)) throw new Error('CONTENT_EVIDENCE_INVALID');
  } else if (first.documentKind === 'cache') {
    exact(value, ['entries']);
    if (!Array.isArray(value.entries)) throw new Error('CONTENT_CACHE_INVALID');
    for (const entry of value.entries) {
      exact(entry, ['key', 'path', 'digest']);
      if (!/^[a-f0-9]{64}$/.test(entry.key) || !/^[a-f0-9]{64}$/.test(entry.digest) || !entry.path.startsWith(`content/${first.candidateId}/cache/`)) throw new Error('CONTENT_CACHE_INVALID');
    }
  } else if (first.documentKind === 'cache-entry') {
      const entry = value;
      exact(entry, ['inputDigest', 'configDigest', 'attempts', 'result', ...('split' in entry ? ['split'] : [])]);
      if (!/^[a-f0-9]{64}$/.test(entry.inputDigest) || !/^[a-f0-9]{64}$/.test(entry.configDigest)
        || !Array.isArray(entry.attempts)
        || entry.attempts.length > 3 && entry.attempts.slice(0, -1).some((attempt: any) => !attempt || !retryableContentRejection(attempt))
        || 'split' in entry && typeof entry.split !== 'boolean') throw new Error('CONTENT_CACHE_INVALID');
  } else if (first.documentKind === 'session') {
    exact(value, ['generated', 'pending', 'identity', 'conflict', 'preview', 'adoption']);
    if (value.generated) snapshot(value.generated);
    if (value.pending) {
      exact(value.pending, ['write', 'generated']); snapshot(value.pending.generated);
      const write = value.pending.write; exact(write, ['expectedHead', 'baseSha', 'proposedCommit', 'generatedDigest', 'objects']);
      if (write.expectedHead !== null && !/^[a-f0-9]{40}$/.test(write.expectedHead) || !/^[a-f0-9]{40}$/.test(write.baseSha)
        || !/^[a-f0-9]{40}$/.test(write.proposedCommit) || !/^[a-f0-9]{64}$/.test(write.generatedDigest) || !Array.isArray(write.objects)) throw new Error('CANDIDATE_PENDING_INVALID');
      for (const object of write.objects) { exact(object, ['oid', 'type', 'bytes']); if (!/^[a-f0-9]{40}$/.test(object.oid) || !['blob', 'tree', 'commit'].includes(object.type) || typeof object.bytes !== 'string') throw new Error('CANDIDATE_OBJECT_INVALID'); }
    }
    if (value.conflict) { exact(value.conflict, ['head', 'generated', 'paths']); snapshot(value.conflict.generated); }
    if (value.identity) {
      exact(value.identity, ['authorsDigest', 'sourceDigest', 'actors', 'contributors', 'units']);
      if (!/^[a-f0-9]{64}$/.test(value.identity.authorsDigest) || !/^[a-f0-9]{64}$/.test(value.identity.sourceDigest)
        || !Array.isArray(value.identity.actors) || !Array.isArray(value.identity.units)) throw new Error('CANDIDATE_IDENTITY_INVALID');
      for (const unit of value.identity.units) { exact(unit, ['id', 'actors', 'contributors']); if (!Array.isArray(unit.actors)) throw new Error('CANDIDATE_IDENTITY_INVALID'); }
    }
    if (value.preview !== null && typeof value.preview !== 'string') throw new Error('CANDIDATE_PREVIEW_INVALID');
    if (value.adoption) exact(value.adoption, ['humanHead', 'generatedBase', 'differences']);
  } else if (first.documentKind === 'content-result') {
    exact(value, ['stage', 'sourceIds', 'result']);
    if (!['DRAFT', 'CONTEXT', 'DIFF', 'COMPOSE'].includes(value.stage) || !Array.isArray(value.sourceIds)) throw new Error('CONTENT_RESULT_INVALID');
    validateContentResult(value.stage, JSON.stringify(value.result), value.sourceIds);
  } else if (first.documentKind === 'merged-candidate') {
    exact(value, ['schemaVersion', 'cycleId', 'sourceSha', 'stateCommit', 'candidate', 'session', 'pull', 'documents']);
    exact(value.pull, ['number', 'head', 'branch', 'base', 'repositoryId', 'mergedAt', 'mergeCommitSha']);
    exact(value.candidate, ['id', 'prNumber', 'branch', 'baseSha', 'generatedSnapshotPath', 'publishedHead', ...('editingAckHead' in value.candidate ? ['editingAckHead'] : []), 'statusCommentId',
      'contentGenerationDigest', 'adoptionOverride', 'observedLabelEventIds', 'pendingWrite']);
    if (value.schemaVersion !== 1 || value.candidate.id !== first.candidateId || value.candidate.prNumber !== value.pull.number
      || value.cycleId !== `pr-${value.pull.number}-${value.sourceSha}` || value.pull.repositoryId !== first.repositoryId
      || value.pull.mergeCommitSha !== value.sourceSha || value.pull.head !== value.candidate.publishedHead
      || value.pull.branch !== value.candidate.branch || !Number.isFinite(Date.parse(value.pull.mergedAt))
      || ![value.sourceSha, value.stateCommit, value.pull.head, value.candidate.baseSha].every(v => /^[a-f0-9]{40}$/.test(v))
      || value.candidate.pendingWrite !== null || !value.session.generated || !value.session.identity || value.session.pending || value.session.conflict
      || !Array.isArray(value.documents) || !value.documents.length) throw new Error('MERGED_CANDIDATE_IDENTITY');
    const sessionText = JSON.stringify(value.session);
    await decodeCandidateDocument([{ ...first, documentKind: 'session', index: 0, count: 1, content: sessionText, documentDigest: await sha256Hex(sessionText) }]);
    const paths = new Set<string>();
    for (const document of value.documents) {
      exact(document, ['path', 'sha256']);
      if (!/^(?:generated|content)\/[A-Za-z0-9_/-]+\.(?:md|json)$/.test(document.path)
        || !/^[a-f0-9]{64}$/.test(document.sha256) || paths.has(document.path)) throw new Error('MERGED_CANDIDATE_DOCUMENTS');
      paths.add(document.path);
    }
    if (!paths.has(`generated/${first.candidateId}/session.json`) || !paths.has(value.candidate.generatedSnapshotPath)) throw new Error('MERGED_CANDIDATE_DOCUMENTS');
  } else if (first.documentKind === 'repair-decision') {
    exact(value, ['schemaVersion', 'repositoryId', 'repository', 'cycleId', 'sourceSha', 'observedAt', 'originalStateCommit',
      'originalCandidateId', 'event', 'originalActiveCycleIds', 'objects', 'inventories']);
    exact(value.event, ['id', 'actorId', 'createdAt', 'label', 'url']);
    exact(value.inventories, ['issueEventsCount', 'issueEventsDigest', 'releasesCount', 'releasesDigest', 'tagsCount', 'tagsDigest']);
    if (value.schemaVersion !== 1 || value.repositoryId !== first.repositoryId || value.originalCandidateId !== first.candidateId
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) || !/^pr-[1-9][0-9]*-[a-f0-9]{40}$/.test(value.cycleId)
      || !value.cycleId.endsWith('-' + value.sourceSha) || ![value.sourceSha, value.originalStateCommit].every(v => /^[a-f0-9]{40}$/.test(v))
      || ![value.event.id, value.event.actorId].every(v => Number.isSafeInteger(v) && v > 0)
      || ![value.observedAt, value.event.createdAt].every(v => Number.isFinite(Date.parse(v))) || Date.parse(value.event.createdAt) > Date.parse(value.observedAt)
      || !/^release:(?:abandoned|supersede-required)(?::[a-z][a-z0-9-]*)?$/.test(value.event.label)
      || value.event.url !== `https://api.github.com/repos/${value.repository}/issues/events/${value.event.id}`
      || !Array.isArray(value.originalActiveCycleIds) || !value.originalActiveCycleIds.includes(value.cycleId)
      || value.originalActiveCycleIds.some((v: unknown) => typeof v !== 'string' || !/^pr-[1-9][0-9]*-[a-f0-9]{40}$/.test(v))
      || new Set(value.originalActiveCycleIds).size !== value.originalActiveCycleIds.length || !Array.isArray(value.objects) || !value.objects.length)
      throw new Error('REPAIR_DECISION_ARCHIVE_IDENTITY');
    for (const object of value.objects) {
      exact(object, ['unitId', 'tag', 'sourceSha', 'releaseId']);
      if (!/^[a-z][a-z0-9-]*$/.test(object.unitId) || typeof object.tag !== 'string' || !object.tag || object.sourceSha !== value.sourceSha
        || object.releaseId !== null && (!Number.isSafeInteger(object.releaseId) || object.releaseId < 1)) throw new Error('REPAIR_DECISION_ARCHIVE_OBJECT');
    }
    if (new Set(value.objects.map((object: any) => object.unitId)).size !== value.objects.length) throw new Error('REPAIR_DECISION_ARCHIVE_OBJECT');
    for (const key of ['issueEvents', 'releases', 'tags']) if (!Number.isSafeInteger(value.inventories[key + 'Count']) || value.inventories[key + 'Count'] < 0
      || !/^[a-f0-9]{64}$/.test(value.inventories[key + 'Digest'])) throw new Error('REPAIR_DECISION_ARCHIVE_INVENTORY');
  } else if (first.documentKind === 'native-input') {
    exact(value, ['facts', 'protections']);
    exact(value.protections, ['branch', 'tags']);
    exact(value.facts, ['baseSha', 'defaultBranch', 'config', 'manifest', 'commitCount', 'releases', 'tags', 'boundaries', 'releaseInventoryComplete', 'protectionsEvidencePath']);
    if (!validNativeInput(value.facts)) throw new Error('CANDIDATE_NATIVE_INPUT_INVALID');
  } else {
    exact(value, ['humanHead', 'generatedBase', 'differences']); validateCandidateFiles(value.differences);
  }
  return value;
}
function validNativeInput(value: any) {
  return /^[a-f0-9]{40}$/.test(value.baseSha) && typeof value.config === 'string' && typeof value.manifest === 'string'
    && Number.isSafeInteger(value.commitCount) && value.commitCount > 0 && value.releaseInventoryComplete === true
    && Array.isArray(value.releases) && Array.isArray(value.tags) && Array.isArray(value.boundaries);
}
