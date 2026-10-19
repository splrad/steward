import { createHash } from 'node:crypto';
import { beforeEach, describe, it, expect } from 'vitest';
import { candidatePaths, candidateProjection, canonicalReleaseJson } from '../../core/src/release-note-receipt.js';
import { receiptFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { readReleaseCandidateFacts } from '../src/release-candidate.js';

function classificationEnvelope(pull = 17, policy = sha('c')) {
  const bytes = Buffer.alloc(186); bytes[0] = 4; bytes.writeUInt32BE(9001, 1); bytes.writeUInt32BE(pull, 5);
  Buffer.from(sha('d'), 'hex').copy(bytes, 9); Buffer.from(policy, 'hex').copy(bytes, 133);
  createHash('sha256').update(bytes.subarray(0, 154)).digest().copy(bytes, 154);
  return `v4:${bytes.toString('base64url')}`;
}
let gh: any, pull: any, checks: any[], timeline: any[], headEntries: any[], currentEntries: any[], truncated: boolean, pages: number;
const receipt = () => ({ ...receiptFixture(), pullNumber: 17 });
beforeEach(() => {
  truncated = false; pages = 1;
  const r = receipt(), blobs = new Map<string, string>();
  const blob = (content: string) => { const bytes = Buffer.from(content), id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); blobs.set(id, content); return id; };
  const files = candidatePaths(r);
  const targetEntries = [{ path: 'VERSION', mode: '100644', type: 'blob', sha: blob('1.2.3\n') }];
  headEntries = [...targetEntries, { path: files[0], mode: '100644', type: 'blob', sha: blob(canonicalReleaseJson(candidateProjection(r))) }, { path: files[1], mode: '100644', type: 'blob', sha: blob(notesFixture) }];
  currentEntries = headEntries;
  pull = { number: 17, base: { repo: { id: 9001 }, ref: 'trunk', sha: sha('a') }, head: { repo: { id: 9001 }, ref: r.branch, sha: sha('d') }, user: { id: 301115370 }, draft: false, state: 'open', merged: false, auto_merge: null, merge_commit_sha: sha('e'), merged_by: { id: 3, type: 'User' }, merged_at: '2026-10-18T00:01:00Z' };
  checks = [{ id: 1, name: 'PR Classification Gate', app: { id: 42 }, head_sha: sha('d'), status: 'completed', conclusion: 'success', external_id: classificationEnvelope() },
    { id: 2, name: 'PR Validation Gate', app: { id: 42 }, head_sha: sha('d'), status: 'completed', conclusion: 'success', external_id: `9001:17:${sha('d')}:123:1` }];
  timeline = [{ __typename: 'MergedEvent', actor: { __typename: 'User', databaseId: 3 }, commit: { oid: sha('e') } }];
  gh = {
    getWorkflowRun: async () => ({ id: 123, run_attempt: 1, repository: { id: 9001 }, head_sha: sha('d'), event: 'pull_request', path: '.github/workflows/pr-validation.yml', workflow_id: 99, workflow_url: 'https://api.github.com/repos/sample/neutral-product/actions/required_workflows/99', status: 'completed', conclusion: 'success' }),
    listWorkflowAttemptJobs: async () => [{ name: 'validate', run_id: 123, run_attempt: 1, head_sha: sha('d'), conclusion: 'success', steps: [{ name: `validation-policy:${sha('c')}`, status: 'completed', conclusion: 'success' }] }],
    getPullRequest: async () => structuredClone(pull),
    getGitCommit: async (_o: string, _r: string, id: string) => ({ sha: id, tree: { sha: id === sha('a') ? sha('b') : id === sha('f') ? sha('1') : sha('2') }, parents: [{ sha: sha('a') }] }),
    getGitTree: async (_o: string, _r: string, id: string) => ({ sha: id, truncated, tree: id === sha('b') ? targetEntries : id === sha('1') ? currentEntries : headEntries }),
    getRef: async () => ({ object: { sha: sha('f') } }),
    listAllCheckRuns: async (_o: string, _r: string, _head: string, filter: string) => { expect(filter).toBe('all'); return checks; },
    listPullRequestReviews: async () => [{ id: 10, user: { id: 2, login: 'reviewer', type: 'User' }, commit_id: sha('d'), state: 'APPROVED', submitted_at: '2026-10-18T00:00:00Z' }],
    request: async (_method: string, path: string, body?: any) => {
      if (path.includes('/git/blobs/')) { const id = path.split('/').at(-1)!, content = blobs.get(id)!; return { sha: id, size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') }; }
      if (path.endsWith('/permission')) return { user: { id: 2 }, permission: 'write' };
      if (path === '/graphql') { const second = body.variables.cursor !== null; return { data: { repository: { databaseId: 9001, pullRequest: { timelineItems: { nodes: pages === 2 && !second ? [] : timeline, pageInfo: { hasNextPage: pages === 2 && !second, endCursor: 'page1' } } } } } }; }
      throw new Error('unexpected path ' + path);
    },
  };
});
describe('authoritative GitHub candidate facts', () => {
  it('folds historical reviews before bounded permission reads and preserves dismissals and change requests', async () => {
    const review = (id: number, actor: number, state = 'APPROVED') => ({ id, user: { id: actor, login: `actor-${actor}`, type: 'User' }, commit_id: sha('d'), state, submitted_at: '2026-10-18T00:00:00Z' });
    const history = Array.from({ length: 100 }, (_, i) => review(i + 1, 2));
    history.push(review(101, 2, 'DISMISSED'), review(102, 3, 'CHANGES_REQUESTED'), review(103, 3, 'COMMENTED'));
    history.push(...Array.from({ length: 100 }, (_, i) => review(200 + i, 1000 + i, 'COMMENTED')));
    history.push(...Array.from({ length: 9 }, (_, i) => review(400 + i, 10 + i)));
    gh.listPullRequestReviews = async () => [...history].reverse();
    const original = gh.request, actors: number[] = []; let active = 0, peak = 0;
    gh.request = async (method: string, path: string, body: any) => {
      if (!path.endsWith('/permission')) return original(method, path, body);
      const actor = Number(/actor-(\d+)/.exec(path)![1]); actors.push(actor); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { user: { id: actor }, permission: 'write' };
    };
    const result = await readReleaseCandidateFacts(gh, receipt(), 42, 301115370);
    expect(actors).toEqual(Array.from({ length: 9 }, (_, i) => 10 + i)); expect(peak).toBe(4);
    expect(result.reviews).toHaveLength(11);
    expect(result.reviews.find(r => r.actorId === 2)?.state).toBe('DISMISSED');
    expect(result.reviews.find(r => r.actorId === 3)?.state).toBe('CHANGES_REQUESTED');
  });
  it.each(['old-policy', 'missing', 'attempt', 'foreign-run'])('rejects validation without current policy provenance: %s', async kind => {
    const original = await gh.listWorkflowAttemptJobs();
    if (kind === 'old-policy') original[0].steps[0].name = `validation-policy:${sha('f')}`;
    if (kind === 'missing') original[0].steps = [];
    if (kind === 'attempt') original[0].run_attempt = 2;
    if (kind === 'foreign-run') original[0].run_id = 124;
    gh.listWorkflowAttemptJobs = async () => original;
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).checksPassed).toBe(false);
  });
  it('reads exact scoped trees, checks and reviewer identity without trusting PR body', async () => {
    pull.body = '{"approved":true}'; const result = await readReleaseCandidateFacts(gh, receipt(), 42, 301115370);
    expect(result.notes).toBe(notesFixture); expect(result.checksPassed).toBe(true); expect(result.reviews[0]?.permission).toBe('write'); expect(result.productTreeUnchanged).toBe(true);
  });
  it.each(['fork', 'author', 'branch', 'base'])('rejects spoofed %s candidate identity', async kind => {
    if (kind === 'fork') pull.head.repo.id = 1;
    if (kind === 'author') pull.user.id = 1;
    if (kind === 'branch') pull.head.ref = 'steward/release-notes/foreign';
    if (kind === 'base') pull.base.ref = 'other';
    await expect(readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).rejects.toThrow('PR_IDENTITY');
  });
  it('rejects truncated Git trees', async () => { truncated = true; await expect(readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).rejects.toThrow('TREE_TRUNCATED'); });
  it('a same-head check for another PR cannot authorize this candidate', async () => {
    checks[0].external_id = classificationEnvelope(18);
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).checksPassed).toBe(false);
  });
  it('stale policy, unbound checks and newer failed runs stop approval', async () => {
    const original = checks[0].external_id;
    for (const external_id of [classificationEnvelope(17, sha('f')), 'unknown']) {
      checks[0].external_id = external_id; expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).checksPassed).toBe(false);
    }
    checks[0].external_id = original; checks.push({ ...checks[0], id: 10, conclusion: 'failure' });
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).checksPassed).toBe(false);
  });
  it('reads all merge-history pages and recognizes human manual merge', async () => {
    pull.merged = true; pull.state = 'closed'; pages = 2;
    const result = await readReleaseCandidateFacts(gh, receipt(), 42, 301115370);
    expect(result.manualMerge).toBe(true); expect(result.productTreeUnchanged).toBe(true); expect(result.merge?.commitSha).toBe(sha('e'));
  });
  it.each(['AutoMergeEnabledEvent', 'AddedToMergeQueueEvent'])('rejects %s at merge time even when merged_by is human', async __typename => {
    pull.merged = true; timeline.unshift({ __typename });
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).manualMerge).toBe(false);
  });
  it('disabled auto-merge followed by a real manual merge is allowed', async () => {
    pull.merged = true; timeline.unshift({ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'AutoMergeDisabledEvent' });
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).manualMerge).toBe(true);
  });
  it('product/default-branch changes after approval are detected', async () => {
    pull.merged = true; currentEntries = [...headEntries, { path: 'code.ts', mode: '100644', type: 'blob', sha: sha('9') }];
    expect((await readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).productTreeUnchanged).toBe(false);
  });
  it('PR changes between initial and final reads stop evaluation', async () => {
    let reads = 0; gh.getPullRequest = async () => ({ ...pull, state: ++reads === 1 ? 'open' : 'closed' });
    await expect(readReleaseCandidateFacts(gh, receipt(), 42, 301115370)).rejects.toThrow('PR_READ_DRIFT');
  });
});
