import { selectPreviousRelease } from '../../core/src/release-notes.js';
import { createHash } from 'node:crypto';
import { GitHubRequestError, type GitHubClient } from '../../github/src/index.js';
import { attributeReleaseSources, assertSourceIdentity, ReleaseSourceError, sourceFailure, sourceSha, type ReleaseBoundary, type ReleaseSourceIdentity, type ManagedReviewRecord } from '../../core/src/release-notes-input.js';

type SourceClient = Pick<GitHubClient, 'listReleases' | 'getGitRef' | 'getGitTag' | 'getCommit' | 'listPullsForCommit' | 'getPullRequest' | 'listPullFiles' | 'listPullCommits' | 'listLabels'>;
export interface TrustedReleaseSourcePolicy {
  /** Explicit central choice when multiple stable tags point to the nearest commit. */
  previousStableTag?: string;
  adoption?: { mode: 'start-at-adoption'; repositoryId: number; policySha: string; boundarySha: string; reference: string };
  reviews?: readonly ManagedReviewRecord[];
}
/** Only call with the central profile loaded at policySha, never product checkout data. */
export function configuredReleaseSourcePolicy(value: unknown, identity: ReleaseSourceIdentity): TrustedReleaseSourcePolicy {
  assertSourceIdentity(identity);
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sourceFailure('source policy');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !['previousStableTag', 'adoption'].includes(key))) sourceFailure('unknown source policy field');
  const result: TrustedReleaseSourcePolicy = {};
  if (object.previousStableTag !== undefined) {
    if (typeof object.previousStableTag !== 'string' || !object.previousStableTag.trim()) sourceFailure('selected stable tag');
    result.previousStableTag = object.previousStableTag as string;
  }
  if (object.adoption !== undefined) {
    if (!object.adoption || typeof object.adoption !== 'object' || Array.isArray(object.adoption)) sourceFailure('adoption policy');
    const adoption = object.adoption as Record<string, unknown>;
    if (Object.keys(adoption).some(key => !['mode', 'boundarySha', 'reference'].includes(key)) || adoption.mode !== 'start-at-adoption' || typeof adoption.reference !== 'string' || !adoption.reference.trim()) sourceFailure('adoption policy fields');
    result.adoption = { mode: 'start-at-adoption', repositoryId: identity.repositoryId, policySha: identity.policySha, boundarySha: sourceSha(adoption.boundarySha), reference: adoption.reference as string };
  }
  if (result.adoption && result.previousStableTag) sourceFailure('conflicting source boundaries');
  return result;
}
export async function collectReleaseRange(gh: SourceClient, owner: string, repo: string, targetSha: string, releases: readonly any[], excludeTag: string, policy: TrustedReleaseSourcePolicy = {}) {
  sourceSha(targetSha);
  const byCommit = new Map<string, any[]>(); const tags = new Set<string>();
  for (const release of releases) {
    if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string') sourceFailure('release enumeration');
    if (release.draft || release.prerelease || release.tag_name === excludeTag) continue;
    if (tags.has(release.tag_name)) sourceFailure('duplicate release tag');
    tags.add(release.tag_name);
    let object;
    try { object = (await gh.getGitRef(owner, repo, `tags/${release.tag_name}`)).object; }
    catch (error) { if (error instanceof GitHubRequestError && error.status === 404) return sourceFailure(`published tag missing: ${release.tag_name}`); throw error; }
    const seen = new Set<string>();
    for (let depth = 0; object?.type === 'tag'; depth++) {
      if (depth >= 5 || seen.has(object.sha)) sourceFailure('tag cycle or depth');
      seen.add(sourceSha(object.sha));
      object = (await gh.getGitTag(owner, repo, object.sha)).object;
    }
    if (object?.type !== 'commit') sourceFailure('tag does not resolve to commit');
    const commit = sourceSha(object.sha);
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), release]);
  }
  const commits: any[] = []; const seen = new Set<string>(); let current = targetSha;
  for (let count = 0; count <= 10_000; count++) {
    if (seen.has(current)) sourceFailure('first-parent cycle');
    seen.add(current);
    const stable = byCommit.get(current);
    if (current !== targetSha && stable) {
      const choice = selectPreviousRelease(stable.map(release => ({ tag: release.tag_name, targetSha: current, draft: false, prerelease: false, publishedAt: release.published_at })), [current], policy.previousStableTag);
      const selected = stable.find(release => release.tag_name === choice?.tag)!;
      return { commits, previousRelease: selected, boundary: { kind: 'stable-release', sha: current, reference: selected.tag_name } as ReleaseBoundary };
    }
    if (current !== targetSha && policy.adoption?.boundarySha === current) {
      if (policy.adoption.mode !== 'start-at-adoption' || !policy.adoption.reference) sourceFailure('adoption record');
      if (policy.previousStableTag) sourceFailure('selected stable tag not reached');
      return { commits, previousRelease: null, boundary: { kind: 'adoption', sha: current, reference: policy.adoption.reference } as ReleaseBoundary };
    }
    if (count === 10_000) return sourceFailure('first-parent limit');
    const commit = await gh.getCommit(owner, repo, current);
    if (commit.sha !== current || !Array.isArray(commit.parents) || commit.parents.some((p: any) => typeof p?.sha !== 'string')) sourceFailure('commit identity or parents');
    commits.push(commit);
    if (!commit.parents.length) sourceFailure('no stable release: explicit start-at-adoption boundary required');
    current = sourceSha(commit.parents[0].sha);
  }
  return sourceFailure('first-parent limit');
}

function unique(values: readonly any[], key: (value: any) => unknown, label: string) {
  if (new Set(values.map(key)).size !== values.length) sourceFailure(`duplicate ${label}`);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
}
function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export async function collectReleaseSources(gh: SourceClient, owner: string, repo: string, identity: ReleaseSourceIdentity, excludeTag: string, policy: TrustedReleaseSourcePolicy = {}) {
  assertSourceIdentity(identity);
  if (policy.adoption && (policy.adoption.repositoryId !== identity.repositoryId || policy.adoption.policySha !== identity.policySha)) sourceFailure('adoption policy binding');
  const history = await collectReleaseRange(gh, owner, repo, identity.targetSha, await gh.listReleases(owner, repo), excludeTag, policy);
  const facts = [];
  const rows = [];
  for (const commit of history.commits) {
    const associated = await gh.listPullsForCommit(owner, repo, commit.sha);
    // Do not discard ambiguous, cross-repository or out-of-range associations.
    if (associated.length !== 1) throw new ReleaseSourceError(associated.length ? 'RN_SOURCE_AMBIGUOUS' : 'RN_SOURCE_INCOMPLETE', `commit ${commit.sha}: ${associated.length} associated PRs`);
    const association = associated[0];
    if (!Number.isSafeInteger(association?.number) || association.number <= 0) sourceFailure('association number');
    if (!association.merged_at || association.base?.repo?.id !== identity.repositoryId || association.base?.ref !== identity.defaultBranch || association.merge_commit_sha !== commit.sha) sourceFailure(`association identity: ${commit.sha}`);
    const pull = await gh.getPullRequest(owner, repo, association.number);
    if (pull.number !== association.number || !pull.merged || pull.merged_at !== association.merged_at || pull.base?.repo?.id !== identity.repositoryId || pull.base?.ref !== identity.defaultBranch || pull.merge_commit_sha !== commit.sha) sourceFailure(`PR identity: ${commit.sha}`);
    if (!text(pull.title) || !(pull.body === null || text(pull.body)) || !text(pull.user?.login) || !text(pull.user?.type) || !text(pull.head?.ref) || !natural(pull.head?.repo?.id) || pull.head.repo.id === 0) sourceFailure('PR author or source identity');
    sourceSha(pull.head.sha); sourceSha(pull.base.sha);
    const [rawFiles, commits, rawLabels] = await Promise.all([gh.listPullFiles(owner, repo, pull.number), gh.listPullCommits(owner, repo, pull.number), gh.listLabels(owner, repo, pull.number)]);
    const files = [...rawFiles]; const labels = [...rawLabels];
    if (!files.length || !commits.length || pull.changed_files !== files.length || pull.commits !== commits.length) sourceFailure(`PR pagination: #${pull.number}`);
    unique(files, f => f.filename, 'files'); unique(commits, c => c.sha, 'commits'); unique(labels, l => l.name, 'labels');
    if (files.some(f => !text(f.filename) || !f.filename || !text(f.status) || !natural(f.additions) || !natural(f.deletions) || (f.previous_filename !== undefined && !text(f.previous_filename))) || commits.some(c => typeof c.sha !== 'string' || !/^[a-f0-9]{40}$/.test(c.sha) || !text(c.commit?.message)) || labels.some(l => !text(l.name))) sourceFailure('malformed PR facts');
    files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
    labels.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    rows.push({ sha: commit.sha, firstParent: commit.parents[0]?.sha ?? null, pulls: [{ number: pull.number, repositoryId: pull.base.repo.id, baseRef: pull.base.ref, mergeSha: pull.merge_commit_sha, headSha: pull.head.sha, mergedAt: pull.merged_at, authorId: pull.user.id, files: files.map(f => ({ path: f.filename, status: f.status, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) })) }] });
    facts.push({ pull, files, commits, labels });
  }
  const input = attributeReleaseSources(identity, history.boundary, rows, policy.reviews);
  // Project only consumed facts; timestamps, API URLs and pagination order are not input identity.
  const sourceFacts = facts.map(({ pull, files, commits, labels }) => ({ number: pull.number, title: pull.title, body: pull.body ?? '', mergedAt: pull.merged_at, mergeSha: pull.merge_commit_sha, head: { repositoryId: pull.head.repo?.id, ref: pull.head.ref, sha: pull.head.sha }, base: { repositoryId: pull.base.repo.id, ref: pull.base.ref, sha: pull.base.sha }, author: { id: pull.user.id, login: pull.user.login, type: pull.user.type }, files: files.map(f => ({ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, additions: f.additions, deletions: f.deletions })), commits: commits.map(c => ({ sha: c.sha, message: c.commit?.message ?? '' })), labels: labels.map(l => l.name) }));
  const bytes = JSON.stringify({ input, sourceFacts }) + '\n';
  return { input, facts, bytes, inputSha256: createHash('sha256').update(bytes).digest('hex') };
}
export function assertReleaseSourcesUnchanged(before: { bytes: string }, after: { bytes: string }): void {
  if (before.bytes !== after.bytes) throw new ReleaseSourceError('RN_SOURCE_STALE', 'release source facts changed');
}
