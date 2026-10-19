import { createHash } from 'node:crypto';
import { receiptDigest, releaseAssert, releaseSha, canonicalReleaseJson, type FrozenRelease } from './release-note-receipt.js';

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

export function validateReleaseEvidence(bytes: Uint8Array, f: FrozenRelease, source: any): void {
  releaseAssert(bytes.length <= 512 * 1024 && receiptDigest(bytes) === f.evidenceDigest, 'EVIDENCE_DIGEST');
  const e = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  releaseAssert(e.schemaVersion === 1 && e.sourceDigest === f.sourceDigest && Array.isArray(e.internalChanges) && Array.isArray(e.unknowns)
    && Array.isArray(e.coverage?.commitShas) && Array.isArray(e.coverage?.paths), 'EVIDENCE');
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  releaseAssert(same(e.coverage.commitShas, source.commits.map((c: any) => c.sha)) && same(e.coverage.paths, source.changes.map((c: any) => c.path)), 'EVIDENCE_COVERAGE');
  releaseAssert([...e.internalChanges, ...e.unknowns].every(v => typeof v === 'string' && v.length <= 8000), 'EVIDENCE_TEXT');
}
