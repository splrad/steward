import { createHash } from 'node:crypto';
import { receiptDigest, releaseAssert, releaseSha, canonicalReleaseJson, type FrozenRelease } from './release-note-receipt.js';
import { assertSourceIdentity, attributeReleaseSources, type ReleaseSourceIdentity, type ReleaseSourceUnit, type ReleaseBoundary } from './release-notes-input.js';

export interface ReleaseSourceManifestBinding extends ReleaseSourceIdentity {
  unit: ReleaseSourceUnit; productTree: string; boundary: ReleaseBoundary; sourceDigest: string;
}
/** Validates the manifest's identity and complete byte intervals, not unseen Git bytes.
 * The provider must reread the named immutable Git objects to verify their hashes.
 */
export function validateReleaseSourceManifest(bytes: Uint8Array, binding: ReleaseSourceManifestBinding): any {
  assertSourceIdentity(binding);
  releaseAssert(receiptDigest(bytes) === binding.sourceDigest, 'SOURCE_DIGEST');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), source = JSON.parse(text);
  releaseAssert(JSON.stringify(source) + '\n' === text && source.schemaVersion === 3 && !('policySha' in source)
    && source.repositoryId === binding.repositoryId && source.defaultBranch === binding.defaultBranch
    && source.targetSha === binding.targetSha && source.controllerSha === binding.controllerSha
    && source.productTree === binding.productTree && releaseSha(source.productTree)
    && canonicalReleaseJson(source.unit) === canonicalReleaseJson(binding.unit)
    && canonicalReleaseJson(source.boundary) === canonicalReleaseJson(binding.boundary), 'SOURCE_BINDING');
  releaseAssert(Array.isArray(source.commits) && Array.isArray(source.changes) && Array.isArray(source.objects)
    && Array.isArray(source.context) && Array.isArray(source.gaps)
    && source.coverage?.commits === source.commits.length && source.coverage.changedFiles === source.changes.length
    && source.coverage.retainedObjects === source.objects.length, 'SOURCE_COVERAGE');
  const objects = new Map<string, any>(); const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  let size = 0;
  for (const object of source.objects) {
    releaseAssert(releaseSha(object.oid) && !objects.has(object.oid) && ['commit', 'blob'].includes(object.type)
      && Number.isSafeInteger(object.size) && object.size >= 0 && digest(object.sha256)
      && ['utf8', 'binary'].includes(object.encoding) && typeof object.lfsPointer === 'boolean' && !('rawBase64' in object)
      && Array.isArray(object.chunks), 'SOURCE_OBJECT');
    let offset = 0;
    for (const chunk of object.chunks) {
      releaseAssert(chunk.start === offset && Number.isSafeInteger(chunk.end) && chunk.end > offset
        && chunk.end <= object.size && chunk.end - offset <= 1024 * 1024 && digest(chunk.sha256), 'SOURCE_CHUNK_COVERAGE');
      offset = chunk.end;
    }
    releaseAssert(offset === object.size, 'SOURCE_CHUNK_COVERAGE');
    size += object.size; objects.set(object.oid, object);
  }
  releaseAssert(Number.isSafeInteger(size) && size === source.coverage.retainedBytes, 'SOURCE_COVERAGE');
  attributeReleaseSources(binding, binding.boundary, source.commits.map((commit: any) => ({ ...commit, pulls: [] })));
  const referenced = new Set<string>();
  for (const commit of source.commits) {
    const object = objects.get(commit.sha);
    releaseAssert(releaseSha(commit.tree) && object?.type === 'commit' && object.sha256 === commit.objectSha256, 'SOURCE_COMMIT');
    referenced.add(commit.sha);
  }
  const paths = new Set<string>();
  for (const change of source.changes) {
    releaseAssert(typeof change.path === 'string' && change.path.length > 0 && !paths.has(change.path), 'SOURCE_PATH'); paths.add(change.path);
    for (const side of [change.before, change.after]) if (side) {
      releaseAssert(releaseSha(side.oid) && ['100644', '100755', '120000', '160000'].includes(side.mode), 'SOURCE_BLOB_MISSING');
      if (side.mode !== '160000') { releaseAssert(objects.get(side.oid)?.type === 'blob', 'SOURCE_BLOB_MISSING'); referenced.add(side.oid); }
    }
  }
  for (const entry of source.context) if (entry.oid !== null) {
    // A context path may identify a submodule, which is explicitly recorded as a gap.
    if (objects.has(entry.oid)) { releaseAssert(objects.get(entry.oid)?.type === 'blob', 'SOURCE_BLOB_MISSING'); referenced.add(entry.oid); }
    else releaseAssert(source.gaps.some((gap: any) => gap.path === entry.path && gap.oid === entry.oid && gap.reason === 'submodule-reference-only'), 'SOURCE_BLOB_MISSING');
  }
  releaseAssert(referenced.size === objects.size, 'SOURCE_OBJECT_COVERAGE');
  releaseAssert(source.boundary.kind === 'full-tree' ? source.boundaryTree === null : releaseSha(source.boundaryTree), 'SOURCE_BOUNDARY');
  releaseSourceFrontier(source);
  return source;
}

/** Historical schema-2 receipts retain their original policy binding and embedded bytes. */
export function validateReleaseSource(bytes: Uint8Array, f: FrozenRelease): any {
  releaseAssert(bytes.length <= 32 * 1024 * 1024 && receiptDigest(bytes) === f.sourceDigest, 'SOURCE_DIGEST');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), s = JSON.parse(text);
  // The collector emits this exact UTF-8/LF encoding; duplicate keys and BOMs cannot round-trip.
  releaseAssert(JSON.stringify(s) + '\n' === text && s.schemaVersion === 2 && s.repositoryId === f.repositoryId && s.targetSha === f.productTargetSha
    && s.productTree === f.productTree && s.policySha === f.policySha && s.targetTag === f.targetTag && s.defaultBranch === f.defaultBranch, 'SOURCE_BINDING');
  releaseAssert(Array.isArray(s.commits) && Array.isArray(s.changes) && Array.isArray(s.objects) && Array.isArray(s.gaps)
    && s.coverage?.commits === s.commits.length && s.coverage.changedFiles === s.changes.length && s.coverage.retainedObjects === s.objects.length
    && new Set(s.commits.map((c: any) => c.sha)).size === s.commits.length && new Set(s.objects.map((o: any) => o.oid)).size === s.objects.length, 'SOURCE_COVERAGE');
  let size = 0;
  for (const object of s.objects) {
    releaseAssert(['commit', 'blob'].includes(object.type) && releaseSha(object.oid) && typeof object.rawBase64 === 'string', 'SOURCE_OBJECT');
    const raw = Buffer.from(object.rawBase64, 'base64'); size += raw.length;
    releaseAssert(raw.length === object.size && raw.toString('base64') === object.rawBase64 && receiptDigest(raw) === object.sha256
      && createHash('sha1').update(`${object.type} ${raw.length}\0`).update(raw).digest('hex') === object.oid, 'SOURCE_OBJECT');
  }
  releaseAssert(size === s.coverage.retainedBytes && s.commits.every((c: any) => releaseSha(c.sha) && s.objects.some((o: any) => o.oid === c.sha && o.type === 'commit' && o.sha256 === c.objectSha256)), 'SOURCE_COMMIT');
  for (const c of s.commits) {
    const raw = Buffer.from(s.objects.find((o: any) => o.oid === c.sha).rawBase64, 'base64').toString('utf8').split('\n\n')[0]!.split('\n');
    releaseAssert(c.tree === raw.find((line: string) => line.startsWith('tree '))?.slice(5)
      && JSON.stringify(c.parents) === JSON.stringify(raw.filter((line: string) => line.startsWith('parent ')).map((line: string) => line.slice(7))), 'SOURCE_COMMIT_HEADERS');
  }
  for (const change of s.changes) for (const side of [change.before, change.after]) if (side && side.mode !== '160000') {
    releaseAssert(s.objects.some((o: any) => o.type === 'blob' && o.oid === side.oid), 'SOURCE_BLOB_MISSING');
  }
  releaseAssert(canonicalReleaseJson(s.boundary) === canonicalReleaseJson(f.boundary), 'SOURCE_BOUNDARY');
  if (s.boundary.kind === 'full-tree') releaseAssert(s.commits.some((c: any) => c.sha === f.productTargetSha), 'SOURCE_TARGET');
  releaseSourceFrontier(s);
  return s;
}

/** Missing parents must be proven ancestors of the boundary by the provider. */
export function releaseSourceFrontier(source: { targetSha: string; boundary: { kind: string; sha?: string }; commits: { sha: string; parents: string[] }[] }): string[] {
  const commits = new Map(source.commits.map(c => [c.sha, c]));
  const visited = new Set<string>(), frontier = new Set<string>(), pending = [source.targetSha];
  while (pending.length) {
    const sha = pending.pop()!;
    if (visited.has(sha) || frontier.has(sha)) continue;
    const commit = commits.get(sha);
    if (!commit) { frontier.add(sha); continue; }
    visited.add(sha); pending.push(...commit.parents);
  }
  releaseAssert(visited.size === commits.size && (source.boundary.kind !== 'full-tree' || frontier.size === 0), 'SOURCE_COMMIT_COVERAGE');
  return [...frontier];
}

export function releaseEvidenceCoverage(source: any) {
  const commits = source.commits.map((c: any) => c.sha).sort();
  const paths = source.changes.map((c: any) => c.path).sort();
  return { commitCount: commits.length, commitDigest: receiptDigest(canonicalReleaseJson(commits)),
    pathCount: paths.length, pathDigest: receiptDigest(canonicalReleaseJson(paths)) };
}
export function validateReleaseEvidence(bytes: Uint8Array, f: Pick<FrozenRelease, 'sourceDigest' | 'evidenceDigest'>, source: any): void {
  releaseAssert(bytes.length <= 512 * 1024 && receiptDigest(bytes) === f.evidenceDigest, 'EVIDENCE_DIGEST');
  const e = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  releaseAssert([1, 2].includes(e.schemaVersion) && e.sourceDigest === f.sourceDigest && Array.isArray(e.internalChanges) && Array.isArray(e.unknowns), 'EVIDENCE');
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (e.schemaVersion === 1) {
    releaseAssert(Array.isArray(e.coverage?.commitShas) && Array.isArray(e.coverage?.paths), 'EVIDENCE');
    releaseAssert(same(e.coverage.commitShas, source.commits.map((c: any) => c.sha)) && same(e.coverage.paths, source.changes.map((c: any) => c.path)), 'EVIDENCE_COVERAGE');
  } else {
    releaseAssert(canonicalReleaseJson(e.coverage) === canonicalReleaseJson(releaseEvidenceCoverage(source)), 'EVIDENCE_COVERAGE');
  }
  releaseAssert([...e.internalChanges, ...e.unknowns].every(v => typeof v === 'string' && v.length <= 8000), 'EVIDENCE_TEXT');
}
