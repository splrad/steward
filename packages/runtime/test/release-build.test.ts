import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { frozenFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { makeReleaseBuildRequest, releaseToolchainDigest } from '../../core/src/release-build-request.js';
import { newReleaseReceipt, canonicalReleaseJson, candidateProjection, candidatePaths, assertReleasePermit } from '../../core/src/release-note-receipt.js';
import { factsFixture } from '../../core/test/release-receipt-fixture.js';
import { GitHubRequestError } from '../../github/src/client.js';
import { ReleaseBuildStore } from '../src/release-build-store.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { handleReleaseBuildAction } from '../src/release-build-api.js';
import { handleReleaseRequest } from '../src/release-api.js';
import { ReleaseReceiptClient, withReleaseClaim } from '../../runner/src/release-lifecycle.js';
import { ReleaseTestDb } from './release-test-db.js';
import { freezePersonalization } from '../../core/src/release-personalization.js';

const mock = vi.hoisted(() => ({ central: null as any, config: null as any, dispatch: vi.fn(), trees: {} as any, blobs: {} as any, facts: null as any }));
vi.mock('../../github/src/release-candidate.js', async original => ({ ...await original<any>(),
  releaseTree: vi.fn(async (_g, _o, _r, sha) => mock.trees[sha]),
  readCandidateBlob: vi.fn(async (_g, _o, _r, tree, path) => path === 'VERSION' ? '1.2.3\n' : mock.blobs[path]),
  readReleaseCandidateFacts: vi.fn(async () => mock.facts),
}));
vi.mock('../../core/src/release-bundle.js', async original => ({ ...await original<any>(),
  validateReleaseSource: vi.fn(() => ({ boundary: { kind: 'full-tree' }, commits: [], changes: [] })),
  validateReleaseEvidence: vi.fn(),
}));
vi.mock('../../github/src/index.js', async original => ({ ...await original<any>(),
  createInstallationToken: vi.fn(async () => 'test'),
  GitHubClient: class { constructor() { return mock.central; } }, dispatchWorkflow: mock.dispatch,
}));
vi.mock('../src/pr-body-api.js', async original => ({ ...await original<any>(), authorizeSingleRepository: vi.fn(async () => ({
  repository: { id: 9001, full_name: 'sample/neutral-product', default_branch: 'trunk' }, client: mock.central, managed: true,
})) }));
vi.mock('../../../config/repositories.json', () => ({ default: { repositories: { get '9001'() { return mock.config; } } } }));
let db: ReleaseTestDb, store: ReleaseBuildStore, receipts: ReleaseReceiptStore;
let run: any, artifact: any;
const env = () => ({ ORGANIZATION_ID: '1', ORGANIZATION_LOGIN: 'sample', APP_ID: '42', INSTALLATION_ID: '2', POLICY_SHA: sha('c'), ISSUE_SNAPSHOTS: db.binding() });
const repository = { id: 9001, full_name: 'sample/neutral-product', default_branch: 'trunk' };
beforeEach(() => {
  db = new ReleaseTestDb(); store = new ReleaseBuildStore(db.binding()); receipts = new ReleaseReceiptStore(db.binding()); mock.dispatch.mockReset();
  mock.config = { delivery: { githubRelease: { enabled: true, state: 'pending', builds: ['release'] } }, builds: { release: {
    profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.ps1', runtime: 'pwsh', runnerFamily: 'windows' },
    outputs: [{ id: 'app', kind: 'file', count: 1, match: 'app.zip', mediaType: 'application/zip' }],
  } } };
  run = { id: 10, run_attempt: 1, repository: { id: 1296724484 }, event: 'workflow_dispatch', head_sha: sha('c'), path: '.github/workflows/release-build.yml', status: 'in_progress', conclusion: null };
  artifact = { id: 20, name: 'release-build-result-1', expired: false, workflow_run: { id: 10, head_sha: sha('c') } };
  mock.central = { request: vi.fn(async (_method: string, path: string) => {
    if (path.includes('/actions/runs/')) return run;
    if (path.endsWith('/artifacts/2')) return { expired: true };
    if (path.includes('/actions/artifacts/')) return artifact;
    throw new Error('Unexpected request: ' + path);
  }) };
});
afterEach(() => db.database.close());
async function request(mode: 'initial' | 'rebuild' = 'initial') {
  const f = frozenFixture(); f.toolchainDigest = releaseToolchainDigest;
  if (mode === 'rebuild') f.build = { runId: 1, artifactId: 2, artifactName: 'old', headSha: sha('c') };
  let req = await makeReleaseBuildRequest(f, mock.config, mode, mode === 'rebuild' ? 2 : null);
  if (mode === 'rebuild') {
    f.manifests = [manifest(req.plans[0]!)];
    f.assets = [{ name: 'app.zip', size: 12, sha256: 'a'.repeat(64) }];
    req = await makeReleaseBuildRequest(f, mock.config, mode, 2);
    await receipts.prepare({ ...newReleaseReceipt(f, notesFixture), phase: 'merged' }, 'now');
  }
  return store.prepare(req);
}
function manifest(p: any) {
  return { schemaVersion: 1 as const, repositoryId: 9001, fullName: repository.full_name, buildId: p.buildId, profile: p.profile, targetSha: sha('a'), policySha: sha('c'), version: '1.2.3', inputsSha256: p.inputsSha256,
    artifacts: [{ id: 'app', kind: 'file' as const, file: 'app.zip', mediaType: 'application/zip', size: 12, sha256: 'a'.repeat(64) }] };
}
const action = (body: any) => handleReleaseBuildAction(env(), mock.central, repository, mock.config, 'v1.2.3', body);
function client() { return new ReleaseReceiptClient('https://runtime.test', 'test', 9001, 'v1.2.3', (async (url: any, init: RequestInit) =>
  (await handleReleaseRequest(new Request(String(url), init), env()))!) as typeof fetch); }

it('allows only one racing build and retains the three-attempt budget across fresh stores', async () => {
  let state = await request();
  const results = await Promise.allSettled([store.begin(state, 10, 1), store.begin(state, 11, 1)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  state = (await store.get(state.request.key, 9001, 'v1.2.3'))!;
  expect(await store.begin(state, state.attempts[0]!.runId, 1)).toEqual(state);
  for (let i = 1; i < 3; i++) {
    state = await store.save(state, { ...state, status: 'failed' });
    state = await new ReleaseBuildStore(db.binding()).begin(state, 20 + i, 1);
  }
  state = await store.save(state, { ...state, status: 'failed' });
  await expect(new ReleaseBuildStore(db.binding()).begin(state, 30, 1)).rejects.toThrow('BUILD_RETRY_BUDGET');
  await expect(store.prepare({ ...state.request, key: 'f'.repeat(64) })).rejects.toThrow('BUILD_REQUEST_OCCUPIED');
  expect(await store.get(state.request.key, 9002, 'v1.2.3')).toBeNull();
});
it.each(['release', 'tag', 'same-version', 'older-version'])('rejects %s before source reads or build reservation', async occupied => {
  const missing = () => { throw new GitHubRequestError(404, 'GET', '/fixture', 'missing'); };
  mock.central.getReleaseByTag = async () => occupied === 'release' ? { id: 1 } : missing();
  mock.central.getGitRef = async (_o: string, _r: string, ref: string) => {
    expect(ref).toBe('tags/v1.2.3'); return occupied === 'tag' ? { object: { sha: sha('a') } } : missing();
  };
  mock.central.getLatestRelease = async () => ({ tag_name: occupied === 'older-version' ? 'v1.2.4' : 'v1.2.3' });
  const frozen = { ...frozenFixture(), toolchainDigest: releaseToolchainDigest };
  await expect(action({ action: 'prepare', frozen })).rejects.toThrow(occupied === 'release' || occupied === 'tag' ? 'VERSION_OCCUPIED' : 'VERSION_NOT_INCREASING');
  expect(db.database.prepare('SELECT COUNT(*) AS n FROM release_build_requests').get()?.n).toBe(0);
  expect(mock.dispatch).not.toHaveBeenCalled();
});
it('rejects caller-supplied personalization that the repository profile did not enable', async () => {
  const frozen = { ...frozenFixture(), toolchainDigest: releaseToolchainDigest };
  const personalization = freezePersonalization(9001, frozen.fullName, { repository: { id: 9001, fullName: frozen.fullName }, releaseNotes: {
    personalization: { enabled: true, sections: [{ id: 'usage', type: 'bullet-list', slot: 'beforeActions', title: '使用方式', items: ['通过命令行启动。'] }] },
  } });
  await expect(action({ action: 'prepare', frozen: { ...frozen, personalization } })).rejects.toThrow('PERSONALIZATION');
  expect(mock.central.request).not.toHaveBeenCalled();
  expect(db.database.prepare('SELECT COUNT(*) AS n FROM release_build_requests').get()?.n).toBe(0);
});
it('accepts only the exact workflow run and canonical output mapping', async () => {
  const state = await request(); const body = { key: state.request.key, runId: 10, attempt: 1 };
  run.head_sha = sha('d'); await expect(action({ ...body, action: 'begin' })).rejects.toThrow('BUILD_RUN_PROVENANCE');
  run.head_sha = sha('c'); await action({ ...body, action: 'begin' });
  run.status = 'completed'; run.conclusion = 'success';
  const m = manifest(state.request.plans[0]!);
  const finish = { ...body, action: 'finish', artifactId: 20, toolchainDigest: releaseToolchainDigest, manifests: [m] };
  await expect(action({ ...finish, manifests: [{ ...m, inputsSha256: 'e'.repeat(64) }] })).rejects.toThrow('BUILD_INPUTS');
  expect(await action(finish)).toMatchObject({ status: 'accepted', artifact: { artifactId: 20 } });
  expect(await action(finish)).toMatchObject({ status: 'accepted' });
});
it.each([false, true])('rebuild retains approval only for identical bytes (changed=%s)', async changed => {
  const state = await request('rebuild'), before = (await receipts.get(9001, 'v1.2.3'))!;
  const body = { key: state.request.key, runId: 10, attempt: 1 }; await action({ ...body, action: 'begin' });
  run.status = 'completed'; run.conclusion = 'success';
  const m = manifest(state.request.plans[0]!); if (changed) m.artifacts[0]!.sha256 = 'b'.repeat(64);
  const result = action({ ...body, action: 'finish', artifactId: 20, toolchainDigest: releaseToolchainDigest, manifests: [m] });
  if (changed) await expect(result).rejects.toThrow('REBUILD_CHANGED_REVIEW_REQUIRED'); else await result;
  const after = (await receipts.get(9001, 'v1.2.3'))!;
  expect(after.frozenDigest).toBe(before.frozenDigest); expect(after.approval).toEqual(before.approval);
  expect(after.paused).toBe(changed);
  expect(after.rebuiltAssets?.at(-1)?.build.artifactId).toBe(changed ? undefined : 20);
  if (changed) {
    expect(await store.get(state.request.key, 9001, 'v1.2.3')).toMatchObject({ status: 'failed', error: 'rebuild-changed-review-required', resultManifests: [m] });
    await expect(withReleaseClaim(client(), s => s.act('review'))).rejects.toThrow('SEALED');
    for (const operation of ['pause', 'resume']) await expect(withReleaseClaim(client(), s => s.act(operation))).rejects.toThrow('REBUILD_REVIEW_REQUIRED');
  }
});
it('queues expired assets and recovers a missing completion callback without another build', async () => {
  const state = await request('rebuild');
  expect(await withReleaseClaim(client(), s => s.act('ensure-assets'))).toMatchObject({ assetRecoveryPending: true });
  expect(mock.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ workflow: 'release-build.yml' }));
  await action({ action: 'begin', key: state.request.key, runId: 10, attempt: 1 });
  run.status = 'completed'; run.conclusion = 'success'; mock.dispatch.mockClear();
  await withReleaseClaim(client(), s => s.act('ensure-assets'));
  expect(mock.dispatch).toHaveBeenCalledTimes(1);
  expect(mock.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ workflow: 'release-build-complete.yml', inputs: { runId: '10' } }));
});
it('pauses after three failed builds and does not dispatch a fourth', async () => {
  let state = await request('rebuild');
  for (let i = 0; i < 3; i++) { state = await store.begin(state, 10 + i, 1); state = await store.save(state, { ...state, status: 'failed' }); }
  expect(await withReleaseClaim(client(), s => s.act('ensure-assets'))).toMatchObject({ paused: true, error: 'rebuild-budget-exhausted' });
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('creates one durable new revision, preserves edited notes, and requires a new head approval and manual merge', async () => {
  const state = await request('rebuild');
  const editedNotes = notesFixture.replace('修复导入失败。', '修复导入失败，并保留原始文件。');
  let claim = await receipts.claim(9001, 'v1.2.3', Date.now());
  await receipts.save(claim.receipt, { ...claim.receipt, pullNumber: 17, approvedNotes: editedNotes,
    approval: { reviewId: 1, actorId: 2, headSha: sha('d'), notesDigest: 'f'.repeat(64), submittedAt: '2026-10-18T00:00:00Z' },
    merge: { actorId: 2, commitSha: sha('e'), mergedAt: '2026-10-18T00:01:00Z' } }, claim.token, Date.now());
  await receipts.release(9001, 'v1.2.3', claim.token);
  await action({ action: 'begin', key: state.request.key, runId: 10, attempt: 1 });
  run.status = 'completed'; run.conclusion = 'success';
  const m = manifest(state.request.plans[0]!); m.artifacts[0]!.sha256 = 'b'.repeat(64);
  await expect(action({ action: 'finish', key: state.request.key, runId: 10, attempt: 1, artifactId: 20, manifests: [m], toolchainDigest: releaseToolchainDigest })).rejects.toThrow('REBUILD_CHANGED');
  const old = (await receipts.get(9001, 'v1.2.3'))!;
  const paths = candidatePaths(old);
  mock.trees = { [sha('a')]: { object: { tree: { sha: sha('b') } }, entries: [] },
    [sha('e')]: { object: { tree: { sha: sha('f') } }, entries: paths.map(path => ({ path, type: 'blob', mode: '100644', sha: sha('1') })) } };
  mock.blobs = { [paths[0]]: canonicalReleaseJson(candidateProjection(old)), [paths[1]]: editedNotes };
  const missing = () => { throw new GitHubRequestError(404, 'GET', '/fixture', 'missing'); };
  mock.central.getPullRequest = async () => ({ state: 'closed', merged: true, merge_commit_sha: sha('e') });
  mock.central.getGitRef = async (_o: any, _r: any, ref: string) => ref.startsWith('heads/') ? { object: { sha: sha('e') } } : missing();
  mock.central.getReleaseByTag = missing; mock.central.getLatestRelease = missing;
  mock.central.getGitCommit = async () => ({ sha: sha('a'), tree: { sha: sha('b') } });
  const original = mock.central.request;
  mock.central.request = async (method: string, path: string) => path === '/user/1' ? { id: 1, type: 'User' } : original(method, path);
  await client().putObject(Buffer.from('source')); await client().putObject(Buffer.from('evidence'));
  const revise = () => withReleaseClaim(client(), s => s.act('revise-rebuild', { key: state.request.key }));
  mock.trees[sha('e')].entries.push({ path: 'product.cs', sha: sha('2'), mode: '100644', type: 'blob' });
  await expect(revise()).rejects.toThrow('REVISION_PRODUCT_DRIFT'); mock.trees[sha('e')].entries.pop();
  const next = await revise(); expect(await revise()).toEqual(next);
  expect(next).toMatchObject({ revision: 2, phase: 'prepared', approval: null, merge: null, approvedNotes: null, draftNotes: editedNotes, candidateBase: { sha: sha('e'), tree: sha('f') } });
  expect(next.frozen.assets[0]!.sha256).toBe('b'.repeat(64)); expect(next.frozen.productTargetSha).toBe(old.frozen.productTargetSha);
  expect((await receipts.get(9001, 'v1.2.3', 1))?.approval).toEqual(old.approval);
  expect(() => assertReleasePermit(next)).toThrow('NOT_APPROVED');
  await expect(action({ action: 'reject', key: state.request.key, runId: 10, attempt: 1 })).rejects.toThrow('BUILD_REQUEST_STALE');
  claim = await receipts.claim(9001, 'v1.2.3', Date.now());
  await receipts.save(claim.receipt, { ...claim.receipt, phase: 'awaiting-review', headSha: sha('9'), pullNumber: 18 }, claim.token, Date.now());
  await receipts.release(9001, 'v1.2.3', claim.token);
  mock.facts = { ...factsFixture(), headSha: sha('9'), notes: editedNotes, projection: canonicalReleaseJson(candidateProjection(next)) };
  expect(await withReleaseClaim(client(), s => s.act('review'))).toMatchObject({ phase: 'awaiting-review', approval: null });
  mock.facts.reviews[0].headSha = sha('9');
  expect(await withReleaseClaim(client(), s => s.act('review'))).toMatchObject({ phase: 'approved', merge: null });
  mock.facts.closed = true; mock.facts.merged = true; mock.facts.manualMerge = true;
  mock.facts.merge = { actorId: 3, commitSha: sha('8'), mergedAt: '2026-10-18T00:02:00Z' };
  const approved = await withReleaseClaim(client(), s => s.act('review'));
  expect(approved.phase).toBe('merged'); expect(() => assertReleasePermit(approved)).not.toThrow();
  expect(approved.approvedNotes).toBe(editedNotes);
});
