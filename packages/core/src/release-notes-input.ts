/** Immutable source identity; provider calls and authorization stay outside core. */
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
export interface ReleaseSourceIdentity { repositoryId: number; defaultBranch: string; targetSha: string; controllerSha: string }
export type ReleaseBoundary = { kind: 'tag'; sha: string; reference: string; version: string } | { kind: 'baseline'; sha: string; reference: string } | { kind: 'full-tree' };
export interface ReleaseSourceUnit { id: string; path: string; version: string; tag: string }
export interface SourcePull { number: number; repositoryId: number; baseRef: string; mergeSha: string; headSha: string; mergedAt: string; authorId: number; files: readonly { path: string; status: string; previousPath?: string }[] }
export interface ReleaseSourceCommit { sha: string; parents: readonly string[] }
export interface ReleaseSourceRow extends ReleaseSourceCommit { pulls: readonly SourcePull[] }
export interface ReleaseSourceInput extends ReleaseSourceIdentity {
  schemaVersion: 3;
  boundary: ReleaseBoundary;
  commits: readonly { sha: string; parents: readonly string[]; pullNumbers: readonly number[] }[];
}
export function assertSourceIdentity(identity: ReleaseSourceIdentity): void {
  if (!Number.isSafeInteger(identity.repositoryId) || identity.repositoryId <= 0 || typeof identity.defaultBranch !== 'string' || !identity.defaultBranch.trim() || /[\x00-\x1f\x7f]/.test(identity.defaultBranch)) sourceFailure('repository identity');
  sourceSha(identity.targetSha); sourceSha(identity.controllerSha);
}
/** Git determines the range. A commit can have zero or several supplementary PRs. */
export function attributeReleaseSources(identity: ReleaseSourceIdentity, boundary: ReleaseBoundary, rows: readonly ReleaseSourceRow[]): ReleaseSourceInput {
  assertSourceIdentity(identity);
  if (!['tag', 'baseline', 'full-tree'].includes(boundary.kind)) sourceFailure('boundary kind');
  if (boundary.kind !== 'full-tree') {
    sourceSha(boundary.sha);
    if (!boundary.reference.trim()) sourceFailure('boundary reference');
  }
  const seen = new Set<string>(); const pulls = new Map<number, string>();
  const commits = rows.map(row => {
    sourceSha(row.sha);
    if (seen.has(row.sha) || (boundary.kind !== 'full-tree' && row.sha === boundary.sha)) sourceFailure('duplicate or included boundary');
    seen.add(row.sha);
    if (new Set(row.parents).size !== row.parents.length) sourceFailure('duplicate parent');
    row.parents.forEach(sourceSha);
    const numbers = new Set<number>();
    for (const pull of row.pulls) {
      if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || numbers.has(pull.number) || pull.repositoryId !== identity.repositoryId || !pull.baseRef.trim() || !Number.isFinite(Date.parse(pull.mergedAt)) || !Number.isSafeInteger(pull.authorId) || pull.authorId <= 0) sourceFailure(`PR identity: ${row.sha}`);
      sourceSha(pull.headSha); sourceSha(pull.mergeSha); numbers.add(pull.number);
      const paths = pull.files.map(file => file.path);
      if (new Set(paths).size !== paths.length || paths.some(path => !path || /[\x00]/.test(path))) sourceFailure(`PR files: #${pull.number}`);
      const snapshot = JSON.stringify({ ...pull, files: [...pull.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
      if (pulls.has(pull.number) && pulls.get(pull.number) !== snapshot) throw new ReleaseSourceError('RN_SOURCE_STALE', `PR #${pull.number} changed within collection`);
      pulls.set(pull.number, snapshot);
    }
    return { sha: row.sha, parents: [...row.parents], pullNumbers: [...numbers].sort((a, b) => a - b) };
  }).sort((a, b) => a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0);
  if (rows.length && !seen.has(identity.targetSha)) sourceFailure('target missing from range');
  if (!rows.length && (boundary.kind === 'full-tree' || boundary.sha !== identity.targetSha)) sourceFailure('empty range');
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));
  const active = new Set<string>(), visited = new Set<string>();
  const pending: { sha: string; exit: boolean }[] = rows.length ? [{ sha: identity.targetSha, exit: false }] : [];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exit) { active.delete(item.sha); visited.add(item.sha); continue; }
    if (active.has(item.sha)) sourceFailure('commit cycle');
    if (visited.has(item.sha)) continue;
    const commit = bySha.get(item.sha);
    if (!commit) { if (boundary.kind === 'full-tree') sourceFailure('incomplete full-tree range'); continue; }
    active.add(item.sha); pending.push({ sha: item.sha, exit: true });
    for (const parent of [...commit.parents].reverse()) pending.push({ sha: parent, exit: false });
  }
  if (visited.size !== rows.length) sourceFailure('unreachable commit');
  return { schemaVersion: 3, repositoryId: identity.repositoryId, defaultBranch: identity.defaultBranch, targetSha: identity.targetSha, controllerSha: identity.controllerSha, boundary: structuredClone(boundary), commits };
}
