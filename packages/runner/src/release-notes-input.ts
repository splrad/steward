import { createHash } from 'node:crypto';
import type { GitHubClient } from '../../github/src/client.js';
import { attributeReleaseSources, assertSourceIdentity, ReleaseSourceError, sourceFailure, sourceSha, type ReleaseBoundary, type ReleaseSourceIdentity, type ReleaseSourceCommit, type ReleaseSourceRow } from '../../core/src/release-notes-input.js';

type SourceClient = Pick<GitHubClient, 'listPullsForCommit' | 'getPullRequest' | 'listPullFiles' | 'listPullCommits' | 'listLabels'>;
export interface GitSourceRange extends ReleaseSourceIdentity { boundary: ReleaseBoundary; commits: readonly ReleaseSourceCommit[] }
function unique(values: readonly any[], key: (value: any) => unknown, label: string) {
  if (new Set(values.map(key)).size !== values.length) sourceFailure(`duplicate ${label}`);
}
function text(value: unknown): value is string { return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value); }
function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** Supplement a complete Git range. PR metadata never selects or truncates its commits. */
export async function collectReleaseSources(gh: SourceClient, owner: string, repo: string, source: GitSourceRange) {
  assertSourceIdentity(source);
  attributeReleaseSources(source, source.boundary, source.commits.map(commit => ({ ...commit, pulls: [] })));
  const facts = new Map<number, { pull: any; files: any[]; commits: any[]; labels: any[] }>();
  const rows: ReleaseSourceRow[] = [];
  for (const commit of [...source.commits].sort((a, b) => a.sha < b.sha ? -1 : 1)) {
    const associated = await gh.listPullsForCommit(owner, repo, commit.sha);
    unique(associated, item => item.number, 'PR associations');
    const pulls = [];
    for (const association of [...associated].sort((a, b) => a.number - b.number)) {
      if (!Number.isSafeInteger(association?.number) || association.number <= 0) sourceFailure('association number');
      if (!association.merged_at || association.base?.repo?.id !== source.repositoryId || !text(association.base?.ref) || !association.base.ref.trim()) sourceFailure(`association identity: ${commit.sha}`);
      sourceSha(association.merge_commit_sha);
      let fact = facts.get(association.number);
      if (!fact) {
        const pull = await gh.getPullRequest(owner, repo, association.number);
        if (pull.number !== association.number || !pull.merged || pull.merged_at !== association.merged_at || pull.base?.repo?.id !== source.repositoryId || pull.base?.ref !== association.base.ref || pull.merge_commit_sha !== association.merge_commit_sha) sourceFailure(`PR identity: ${commit.sha}`);
        if (!text(pull.title) || !(pull.body === null || text(pull.body)) || !text(pull.user?.login) || !['User', 'Bot', 'Organization', 'Mannequin'].includes(pull.user?.type) || !text(pull.head?.ref) || !natural(pull.head?.repo?.id) || pull.head.repo.id === 0 || !Number.isSafeInteger(pull.user?.id) || pull.user.id <= 0) sourceFailure('PR author or source identity');
        sourceSha(pull.head.sha); sourceSha(pull.base.sha);
        const [rawFiles, rawCommits, rawLabels] = await Promise.all([gh.listPullFiles(owner, repo, pull.number), gh.listPullCommits(owner, repo, pull.number), gh.listLabels(owner, repo, pull.number)]);
        const files = [...rawFiles], commits = [...rawCommits], labels = [...rawLabels];
        if (!commits.length || pull.changed_files !== files.length || pull.commits !== commits.length) sourceFailure(`PR pagination: #${pull.number}`);
        unique(files, f => f.filename, 'files'); unique(commits, c => c.sha, 'commits'); unique(labels, l => l.name, 'labels');
        if (files.some(f => !text(f.filename) || !f.filename || !text(f.status) || !natural(f.additions) || !natural(f.deletions) || (f.previous_filename !== undefined && !text(f.previous_filename))) || commits.some(c => typeof c.sha !== 'string' || !/^[a-f0-9]{40}$/.test(c.sha) || !text(c.commit?.message)) || labels.some(l => !text(l.name))) sourceFailure('malformed PR facts');
        files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
        commits.sort((a, b) => a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0);
        labels.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        fact = structuredClone({ pull, files, commits, labels }); facts.set(pull.number, fact);
      }
      const { pull, files, commits } = fact;
      if (pull.merged_at !== association.merged_at || pull.merge_commit_sha !== association.merge_commit_sha || pull.base.ref !== association.base.ref) throw new ReleaseSourceError('RN_SOURCE_STALE', `PR #${pull.number} association changed`);
      if (pull.merge_commit_sha !== commit.sha && !commits.some(item => item.sha === commit.sha)) sourceFailure(`PR commit association: #${pull.number}`);
      pulls.push({ number: pull.number, repositoryId: pull.base.repo.id, baseRef: pull.base.ref, mergeSha: pull.merge_commit_sha, headSha: pull.head.sha, mergedAt: pull.merged_at, authorId: pull.user.id, files: files.map(f => ({ path: f.filename, status: f.status, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) })) });
    }
    rows.push({ sha: commit.sha, parents: [...commit.parents], pulls });
  }
  const input = attributeReleaseSources(source, source.boundary, rows);
  const orderedFacts = [...facts.values()].sort((a, b) => a.pull.number - b.pull.number);
  const sourceFacts = orderedFacts.map(({ pull, files, commits, labels }) => ({ number: pull.number, title: pull.title, body: pull.body ?? '', mergedAt: pull.merged_at, mergeSha: pull.merge_commit_sha, head: { repositoryId: pull.head.repo.id, ref: pull.head.ref, sha: pull.head.sha }, base: { repositoryId: pull.base.repo.id, ref: pull.base.ref, sha: pull.base.sha }, author: { id: pull.user.id, login: pull.user.login, type: pull.user.type }, files: files.map(f => ({ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, additions: f.additions, deletions: f.deletions })), commits: commits.map(c => ({ sha: c.sha, message: c.commit.message })), labels: labels.map(l => l.name) }));
  const bytes = JSON.stringify({ input, sourceFacts }) + '\n';
  return { input, facts: orderedFacts, bytes, inputSha256: createHash('sha256').update(bytes).digest('hex') };
}
export function assertReleaseSourcesUnchanged(before: { bytes: string }, after: { bytes: string }): void {
  if (before.bytes !== after.bytes) throw new ReleaseSourceError('RN_SOURCE_STALE', 'release source facts changed');
}
