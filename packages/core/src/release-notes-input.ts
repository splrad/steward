/** R02 source contract. Network facts and trusted policy records are supplied by the adapter. */
export class ReleaseSourceError extends Error {
  constructor(public readonly code: 'RN_SOURCE_INCOMPLETE' | 'RN_SOURCE_STALE' | 'RN_SOURCE_AMBIGUOUS', detail: string) {
    super(`${code}: ${detail}`);
  }
}
export const sourceFailure = (detail: string): never => { throw new ReleaseSourceError('RN_SOURCE_INCOMPLETE', detail); };
export const sourceSha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) return sourceFailure('invalid commit SHA');
  return value;
};
export interface ReleaseSourceIdentity { repositoryId: number; defaultBranch: string; targetSha: string; policySha: string }
export interface ReleaseBoundary { kind: 'stable-release' | 'adoption'; sha: string; reference: string }
export interface SourcePull { number: number; repositoryId: number; baseRef: string; mergeSha: string; headSha: string; mergedAt: string; authorId: number; files: readonly { path: string; status: string; previousPath?: string }[] }
export interface ReleaseSourceRow { sha: string; firstParent: string | null; pulls: readonly SourcePull[] }
/** These records must come from the central store at policySha, never candidate files or PR text. */
export interface ManagedReviewRecord { candidateId: string; repositoryId: number; policySha: string; targetTag: string; pullNumber: number; headSha: string; mergeSha: string; authorId: number }
export interface ReleaseSourceInput extends ReleaseSourceIdentity {
  schemaVersion: 1;
  boundary: ReleaseBoundary;
  commits: readonly { sha: string; pullNumber: number; kind: 'product' | 'review-record'; candidateId: string | null }[];
}
export function assertSourceIdentity(identity: ReleaseSourceIdentity): void {
  if (!Number.isSafeInteger(identity.repositoryId) || identity.repositoryId <= 0 || typeof identity.defaultBranch !== 'string' || !identity.defaultBranch.trim()) sourceFailure('repository identity');
  sourceSha(identity.targetSha); sourceSha(identity.policySha);
}
export function attributeReleaseSources(identity: ReleaseSourceIdentity, boundary: ReleaseBoundary, rows: readonly ReleaseSourceRow[], reviews: readonly ManagedReviewRecord[] = []): ReleaseSourceInput {
  assertSourceIdentity(identity); sourceSha(boundary.sha);
  if (!['stable-release', 'adoption'].includes(boundary.kind) || !boundary.reference.trim()) sourceFailure('boundary record');
  if (!rows.length || rows[0]?.sha !== identity.targetSha) sourceFailure('empty or incomplete range');
  const seen = new Set<string>(); const numbers = new Set<number>(); const usedReviews = new Set<string>();
  const commits = rows.map((row, index) => {
    sourceSha(row.sha);
    if (seen.has(row.sha) || row.sha === boundary.sha) sourceFailure('duplicate or included boundary');
    seen.add(row.sha);
    if (row.firstParent !== (rows[index + 1]?.sha ?? boundary.sha)) sourceFailure(`broken first-parent range: ${row.sha}`);
    if (row.pulls.length !== 1) throw new ReleaseSourceError(row.pulls.length ? 'RN_SOURCE_AMBIGUOUS' : 'RN_SOURCE_INCOMPLETE', `commit ${row.sha}: expected one merged PR, found ${row.pulls.length}`);
    const pull = row.pulls[0]!;
    if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || numbers.has(pull.number) || pull.repositoryId !== identity.repositoryId || pull.baseRef !== identity.defaultBranch || pull.mergeSha !== row.sha || !Number.isFinite(Date.parse(pull.mergedAt)) || !Number.isSafeInteger(pull.authorId) || pull.authorId <= 0) sourceFailure(`PR identity: ${row.sha}`);
    sourceSha(pull.headSha); numbers.add(pull.number);
    const paths = pull.files.map(file => file.path);
    if (!paths.length || new Set(paths).size !== paths.length) sourceFailure(`PR files: #${pull.number}`);
    const matches = reviews.filter(record => record.pullNumber === pull.number || record.mergeSha === row.sha);
    if (matches.length > 1) throw new ReleaseSourceError('RN_SOURCE_AMBIGUOUS', 'candidate records');
    const record = matches[0];
    const candidatePaths = pull.files.some(file => [file.path, file.previousPath ?? ''].some(path => path.startsWith('.release-notes/candidates/')));
    if (!record && candidatePaths) sourceFailure(`unregistered candidate PR: #${pull.number}`);
    if (record) {
      if (!record.candidateId || usedReviews.has(record.candidateId) || record.repositoryId !== identity.repositoryId || record.policySha !== identity.policySha || record.pullNumber !== pull.number || record.mergeSha !== row.sha || record.headSha !== pull.headSha || record.authorId !== pull.authorId || !/^v\d+\.\d+\.\d+$/.test(record.targetTag)) sourceFailure('candidate identity');
      const prefix = `.release-notes/candidates/${record.targetTag}/`;
      const expected = [prefix + 'candidate.json', prefix + 'release-notes.zh-CN.md'].sort();
      if (JSON.stringify([...paths].sort()) !== JSON.stringify(expected) || pull.files.some(file => !['added', 'modified'].includes(file.status) || file.previousPath !== undefined)) sourceFailure('candidate exact file scope');
      usedReviews.add(record.candidateId);
    }
    return { sha: row.sha, pullNumber: pull.number, kind: record ? 'review-record' as const : 'product' as const, candidateId: record?.candidateId ?? null };
  });
  return { schemaVersion: 1, repositoryId: identity.repositoryId, defaultBranch: identity.defaultBranch, targetSha: identity.targetSha, policySha: identity.policySha, boundary: { kind: boundary.kind, sha: boundary.sha, reference: boundary.reference }, commits };
}
