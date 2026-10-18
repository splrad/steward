import { createHash } from 'node:crypto';
import { candidatePaths, canonicalReleaseJson, candidateProjection, releaseAssert, releaseSha, type CandidateReviewFacts, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { GitHubClient, GitHubRequestError } from './client.js';
import { decodeClassificationCheckEnvelope } from '../../core/src/check-envelope.js';
import { comparePublicVersions, parsePublicVersion } from '../../core/src/release-version.js';

export async function assertIncreasingReleaseVersion(gh: Pick<GitHubClient, 'listReleases'>, owner: string, repo: string, tag: string, ownReleaseId?: number | null): Promise<void> {
  const target = parsePublicVersion(tag.slice(1));
  for (const release of await gh.listReleases(owner, repo)) {
    if (release.draft || release.prerelease || release.id === ownReleaseId) continue;
    releaseAssert(/^v\d+\.\d+\.\d+$/.test(release.tag_name)
      && comparePublicVersions(target, parsePublicVersion(release.tag_name.slice(1))) > 0, 'VERSION_NOT_INCREASING');
  }
}

export async function optionalReleaseRead<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch (error) { if (error instanceof GitHubRequestError && error.status === 404) return null; throw error; }
}
export async function releaseTree(gh: GitHubClient, owner: string, repo: string, commit: string) {
  const object = await gh.getGitCommit(owner, repo, commit);
  releaseAssert(object.sha === commit && releaseSha(object.tree?.sha), 'COMMIT');
  const result = await gh.getGitTree(owner, repo, object.tree.sha);
  releaseAssert(result.sha === object.tree.sha && result.truncated === false && Array.isArray(result.tree), 'TREE_TRUNCATED');
  const entries = result.tree.filter((e: any) => e.type !== 'tree');
  releaseAssert(new Set(entries.map((e: any) => e.path)).size === entries.length && entries.every((e: any) => typeof e.path === 'string' && releaseSha(e.sha)), 'TREE_ENTRIES');
  return { object, entries: entries as { path: string; sha: string; mode: string; type: string }[] };
}
export function changedTreePaths(a: Awaited<ReturnType<typeof releaseTree>>, b: Awaited<ReturnType<typeof releaseTree>>): string[] {
  const left = new Map(a.entries.map(e => [e.path, `${e.mode}:${e.sha}`])), right = new Map(b.entries.map(e => [e.path, `${e.mode}:${e.sha}`]));
  return [...new Set([...left.keys(), ...right.keys()])].filter(path => left.get(path) !== right.get(path)).sort();
}
export async function readCandidateBlob(gh: GitHubClient, owner: string, repo: string, tree: Awaited<ReturnType<typeof releaseTree>>, path: string): Promise<string> {
  const entry = tree.entries.find(e => e.path === path);
  releaseAssert(entry?.type === 'blob' && entry.mode === '100644', 'CANDIDATE_FILE');
  const blob = await gh.request<any>('GET', `/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
  releaseAssert(blob.sha === entry.sha && blob.encoding === 'base64' && typeof blob.content === 'string' && blob.size <= 128 * 1024, 'BLOB');
  const bytes = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
  releaseAssert(bytes.length === blob.size && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === entry.sha, 'BLOB_INTEGRITY');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
/** All facts here are fetched from GitHub; candidate files never self-report approvals. */
export async function readReleaseCandidateFacts(gh: GitHubClient, r: ReleaseReceipt, appId: number, botUserId: number): Promise<CandidateReviewFacts> {
  const f = r.frozen, [owner, repo] = f.fullName.split('/') as [string, string];
  releaseAssert(r.pullNumber, 'PR_UNBOUND');
  const pull = await gh.getPullRequest(owner, repo, r.pullNumber);
  releaseAssert(pull.number === r.pullNumber && pull.base?.repo?.id === f.repositoryId && pull.head?.repo?.id === f.repositoryId
    && pull.user?.id === botUserId && pull.head.ref === r.branch && pull.base.ref === f.defaultBranch && releaseSha(pull.head.sha), 'PR_IDENTITY');
  const target = await releaseTree(gh, owner, repo, f.productTargetSha), head = await releaseTree(gh, owner, repo, pull.head.sha);
  releaseAssert(target.object.tree.sha === f.productTree, 'PRODUCT_TREE');
  const [projectionPath, notesPath] = candidatePaths(r);
  const projection = await readCandidateBlob(gh, owner, repo, head, projectionPath);
  const notes = await readCandidateBlob(gh, owner, repo, head, notesPath);
  releaseAssert(projection === canonicalReleaseJson(candidateProjection(r)), 'PROJECTION');
  const files = changedTreePaths(target, head);
  const checks = await gh.listAllCheckRuns(owner, repo, pull.head.sha, 'all');
  const latestChecks = new Map<string, any>();
  let ambiguous = false;
  for (const check of [...checks].sort((a, b) => a.id - b.id)) {
    if (check.app?.id !== appId || check.head_sha !== pull.head.sha || !['PR Classification Gate', 'PR Validation Gate'].includes(check.name)) continue;
    const envelope = decodeClassificationCheckEnvelope(check.external_id);
    const marker = /^([1-9]\d*):([1-9]\d*):([a-f0-9]{40}):(pending|failure|[1-9]\d*:[1-9]\d*(?::pending)?)$/.exec(String(check.external_id));
    const identity = envelope ?? (marker ? { repositoryId: Number(marker[1]), pullRequestNumber: Number(marker[2]), headSha: marker[3] } : null);
    if (!identity || identity.repositoryId !== f.repositoryId || identity.headSha !== pull.head.sha) { ambiguous = true; continue; }
    if (identity.pullRequestNumber !== r.pullNumber) continue;
    if (check.name === 'PR Classification Gate' && check.conclusion === 'success' && envelope?.policySha !== f.policySha) { ambiguous = true; continue; }
    latestChecks.set(check.name, check);
  }
  const checksPassed = !ambiguous && ['PR Classification Gate', 'PR Validation Gate'].every(name => latestChecks.get(name)?.status === 'completed' && latestChecks.get(name)?.conclusion === 'success');
  const rawReviews = await gh.listPullRequestReviews(owner, repo, pull.number);
  const reviews: CandidateReviewFacts['reviews'] = [];
  for (const review of rawReviews) {
    if (review.state === 'PENDING') continue;
    let permission = 'none';
    if (review.user?.type === 'User') {
      const access = await gh.request<any>('GET', `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(review.user.login)}/permission`);
      releaseAssert(access.user?.id === review.user.id, 'REVIEWER_IDENTITY'); permission = access.permission;
    }
    reviews.push({ id: review.id, actorId: review.user?.id, type: review.user?.type, permission, headSha: review.commit_id, state: review.state, submittedAt: review.submitted_at });
  }
  let manualMerge = false, merge: CandidateReviewFacts['merge'] = null;
  let productTreeUnchanged: boolean;
  if (pull.merged === true) {
    releaseAssert(releaseSha(pull.merge_commit_sha), 'MERGE_SHA');
    const merged = await releaseTree(gh, owner, repo, pull.merge_commit_sha);
    const parent = merged.object.parents?.[0]?.sha;
    releaseAssert(releaseSha(parent), 'MERGE_PARENT');
    const beforeMerge = await releaseTree(gh, owner, repo, parent);
    const defaultRef = await gh.getRef(owner, repo, `heads/${f.defaultBranch}`);
    const current = await releaseTree(gh, owner, repo, defaultRef.object.sha);
    const allowed = candidatePaths(r);
    productTreeUnchanged = [changedTreePaths(target, merged), changedTreePaths(beforeMerge, merged), changedTreePaths(target, current)]
      .every(paths => paths.every(path => allowed.includes(path)));
    productTreeUnchanged &&= await readCandidateBlob(gh, owner, repo, merged, notesPath) === notes
      && await readCandidateBlob(gh, owner, repo, merged, projectionPath) === projection
      && await readCandidateBlob(gh, owner, repo, current, notesPath) === notes
      && await readCandidateBlob(gh, owner, repo, current, projectionPath) === projection;
    let cursor: string | null = null, autoMerge = false, queued = false, automatedMerge = true, mergeActor: number | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result: any = await gh.request('POST', '/graphql', { query: `query ReleaseMergeEvidence($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){databaseId pullRequest(number:$number){timelineItems(first:100,after:$cursor){nodes{__typename ... on MergedEvent{actor{__typename ... on User{databaseId}} commit{oid}}} pageInfo{hasNextPage endCursor}}}}}`, variables: { owner, repo, number: pull.number, cursor } });
      releaseAssert(!result.errors?.length && result.data?.repository?.databaseId === f.repositoryId, 'MERGE_HISTORY');
      const timeline = result.data.repository.pullRequest?.timelineItems;
      releaseAssert(Array.isArray(timeline?.nodes), 'MERGE_HISTORY');
      for (const event of timeline.nodes) {
        if (['AutoMergeEnabledEvent', 'AutoSquashEnabledEvent', 'AutoRebaseEnabledEvent'].includes(event.__typename)) autoMerge = true;
        if (event.__typename === 'AutoMergeDisabledEvent') autoMerge = false;
        if (event.__typename === 'AddedToMergeQueueEvent') queued = true;
        if (event.__typename === 'RemovedFromMergeQueueEvent') queued = false;
        if (event.__typename === 'MergedEvent' && event.commit?.oid === pull.merge_commit_sha && event.actor?.__typename === 'User') { mergeActor = event.actor.databaseId; automatedMerge = autoMerge || queued; }
      }
      if (timeline.pageInfo?.hasNextPage === false) break;
      releaseAssert(page < 99 && typeof timeline.pageInfo?.endCursor === 'string' && !cursors.has(timeline.pageInfo.endCursor), 'MERGE_HISTORY_TRUNCATED');
      cursor = timeline.pageInfo.endCursor; cursors.add(cursor!);
    }
    manualMerge = !automatedMerge && pull.auto_merge === null && pull.merged_by?.type === 'User' && mergeActor === pull.merged_by.id;
    merge = { actorId: pull.merged_by?.id, commitSha: pull.merge_commit_sha, mergedAt: pull.merged_at };
  } else {
    const base = await releaseTree(gh, owner, repo, pull.base.sha);
    productTreeUnchanged = r.candidateBase ? changedTreePaths(target, base).every(path => candidatePaths(r).includes(path)) : changedTreePaths(target, base).length === 0;
  }
  const refreshed = await gh.getPullRequest(owner, repo, r.pullNumber);
  releaseAssert(refreshed.head?.sha === pull.head.sha && refreshed.base?.sha === pull.base.sha && refreshed.merged === pull.merged && refreshed.state === pull.state, 'PR_READ_DRIFT');
  return { headSha: pull.head.sha, projection, notes, files, closed: pull.state === 'closed', merged: pull.merged === true, checksPassed: checksPassed && pull.draft === false,
    reviews, merge, manualMerge, productTreeUnchanged };
}
