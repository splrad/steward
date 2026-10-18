import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubRequestError } from '../../github/src/client.js';
import { receiptDigest, newReleaseReceipt, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { factsFixture, frozenFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { ReleaseReceiptClient, withReleaseClaim, publishReleaseCandidate } from '../../runner/src/release-lifecycle.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { handleReleaseRequest } from '../src/release-api.js';
import { ReleaseTestDb } from './release-test-db.js';
import { ReleaseGenerationStore } from '../src/release-generation-store.js';
import { generationPlan } from '../../core/src/release-production.js';

const state = vi.hoisted(() => ({ gh: null as any, facts: null as any, capability: { enabled: true, state: 'active', builds: [] } }));
vi.mock('../src/pr-body-api.js', async original => ({ ...await original<any>(), authorizeSingleRepository: vi.fn(async () => ({
  repository: { id: 9001, full_name: 'sample/neutral-product', default_branch: 'trunk' }, client: state.gh, managed: true,
})) }));
vi.mock('../../github/src/release-candidate.js', async original => ({ ...await original<any>(), readReleaseCandidateFacts: vi.fn(async () => structuredClone(state.facts)) }));
vi.mock('../../../config/repositories.json', () => ({ default: { repositories: { '9001': { delivery: { githubRelease: state.capability }, builds: {} } } } }));

let db: ReleaseTestDb, store: ReleaseReceiptStore, receipts: ReleaseReceiptClient, remote: any, creates: number, publishes: number, uploads: number, directory: string;
let lost: 'create' | 'upload' | 'publish' | null;
const missing = () => { throw new GitHubRequestError(404, 'GET', '/test', 'missing'); };
const env = () => ({ ORGANIZATION_ID: '1', ORGANIZATION_LOGIN: 'sample', APP_ID: '42', INSTALLATION_ID: '2', POLICY_SHA: sha('c'), ISSUE_SNAPSHOTS: db.binding() });
beforeEach(async () => {
  db = new ReleaseTestDb(); store = new ReleaseReceiptStore(db.binding()); state.facts = factsFixture(); state.capability.state = 'active';
  creates = publishes = uploads = 0; remote = null; lost = null; directory = await mkdtemp(join(tmpdir(), 'release-chain-'));
  state.gh = {
    getImmutableReleaseStatus: async () => ({ enabled: true }),
    getReleaseByTag: async () => remote ?? missing(),
    getGitRef: async () => remote?.draft === false ? { object: { type: 'commit', sha: sha('a') } } : missing(),
    getLatestRelease: async () => remote?.draft === false ? remote : missing(),
    listReleases: async () => remote ? [remote] : [],
    request: async (_method: string, path: string) => path.endsWith('/releases/99') ? remote ?? missing() : missing(),
    createRelease: async (_owner: string, _repo: string, value: any) => {
      creates++; remote = { ...value, id: 99, author: { id: 301115370 }, html_url: 'https://github.com/sample/neutral-product/releases/tag/v1.2.3', upload_url: 'https://uploads.github.com/repos/sample/neutral-product/releases/99/assets{?name}', assets: [] };
      if (lost === 'create') { lost = null; throw new Error('response lost'); } return remote;
    },
    updateRelease: async (_owner: string, _repo: string, id: number, patch: any) => {
      expect(id).toBe(99); publishes++; remote = { ...remote, ...patch, immutable: true };
      if (lost === 'publish') { lost = null; throw new Error('response lost'); } return remote;
    },
  };
  receipts = new ReleaseReceiptClient('https://runtime.test', 'scoped-token', 9001, 'v1.2.3', (async (url: any, init: RequestInit) =>
    (await handleReleaseRequest(new Request(String(url), init), env()))!) as typeof fetch);
});
afterEach(async () => { db.database.close(); await rm(directory, { recursive: true }); vi.restoreAllMocks(); });

it('accepts a generation-only ticket without granting receipt, object or publication access', async () => {
  const generation = new ReleaseGenerationStore(db.binding());
  await generation.prepare(9001, 'v1.2.3', generationPlan('a'.repeat(64), sha('c'), ['source']));
  const token = await generation.ticket(9001, 'v1.2.3', Date.now());
  const get = (suffix: string) => handleReleaseRequest(new Request('https://runtime.test/internal/releases/9001/' + suffix, { headers: { authorization: `Bearer ${token}` } }), env());
  expect((await get('v1.2.3/generation'))?.status).toBe(200);
  for (const suffix of ['v1.2.3', 'v1.2.3/permit', 'v1.2.4/generation', `objects/${'a'.repeat(64)}/0`]) expect((await get(suffix))?.status).not.toBe(200);
  expect(creates + publishes + uploads).toBe(0);
});

async function seed(asset = false) {
  const frozen = frozenFixture();
  if (asset) {
    const bytes = Buffer.from('asset bytes'); await writeFile(join(directory, 'app.zip'), bytes);
    frozen.assets = [{ name: 'app.zip', size: bytes.length, sha256: receiptDigest(bytes) }];
    frozen.build = { runId: 1, artifactId: 2, artifactName: 'assets', headSha: sha('c') };
    frozen.manifests = [{ schemaVersion: 1, repositoryId: 9001, fullName: frozen.fullName, buildId: 'release', profile: 'custom-adapter-v1', targetSha: sha('a'), policySha: sha('c'), version: '1.2.3', inputsSha256: 'f'.repeat(64),
      artifacts: [{ id: 'app', kind: 'file', file: 'app.zip', mediaType: 'application/zip', ...{ size: bytes.length, sha256: receiptDigest(bytes) } }] }];
  }
  const r = newReleaseReceipt(frozen, notesFixture);
  const { candidateProjection, canonicalReleaseJson } = await import('../../core/src/release-note-receipt.js');
  state.facts.projection = canonicalReleaseJson(candidateProjection(r));
  await store.prepare({ ...r, pullNumber: 17, headSha: sha('d'), phase: 'awaiting-review' }, 'now');
}
async function approveAndMerge() {
  await withReleaseClaim(receipts, s => s.act('review'));
  state.facts.merged = true; state.facts.closed = true; state.facts.manualMerge = true;
  state.facts.merge = { actorId: 3, commitSha: sha('e'), mergedAt: '2026-10-18T00:01:00Z' };
  await withReleaseClaim(receipts, s => s.act('review'));
}
async function publish() {
  return withReleaseClaim(receipts, session => publishReleaseCandidate({ gh: state.gh, session, assetDirectory: directory, verifyDownloads: async r => { expect(r.frozen.assets.every(a => remote.assets.some((v: any) => v.name === a.name && v.digest === `sha256:${a.sha256}`))).toBe(true); },
    upload: async (_release, asset) => {
      uploads++; remote.assets.push({ id: 100, name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}` });
      if (lost === 'upload') { lost = null; throw new Error('response lost'); }
    },
  }));
}

describe('receipt API and publisher with SQLite persistence', () => {
  it('blocks publication when a higher stable release is not GitHub latest', async () => {
    await seed(); await approveAndMerge();
    state.gh.listReleases = async () => [{ id: 100, tag_name: 'v3.0.0', draft: false, prerelease: false }];
    state.gh.getLatestRelease = async () => ({ id: 101, tag_name: 'v1.0.0' });
    await expect(publish()).rejects.toThrow('VERSION_NOT_INCREASING');
    expect(creates + publishes + uploads).toBe(0);
  });
  it('prepares from content-addressed source/evidence, verifies VERSION, and resumes the same durable candidate', async () => {
    const f = frozenFixture();
    const raw = Buffer.from(`tree ${sha('b')}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\ninitial\n`);
    const id = createHash('sha1').update(`commit ${raw.length}\0`).update(raw).digest('hex'); f.productTargetSha = id;
    const version = Buffer.from('1.2.3\n'), blobId = createHash('sha1').update(`blob ${version.length}\0`).update(version).digest('hex');
    const source = Buffer.from(JSON.stringify({ schemaVersion: 2, repositoryId: 9001, defaultBranch: 'trunk', targetSha: id, productTree: sha('b'), policySha: sha('c'), targetTag: 'v1.2.3', boundary: { kind: 'full-tree' },
      commits: [{ sha: id, tree: sha('b'), parents: [], objectSha256: receiptDigest(raw) }], changes: [{ path: 'VERSION', previousPath: null, status: 'A', before: null, after: { mode: '100644', oid: blobId } }], gaps: [],
      objects: [{ oid: id, type: 'commit', size: raw.length, sha256: receiptDigest(raw), rawBase64: raw.toString('base64'), encoding: 'utf8' }, { oid: blobId, type: 'blob', size: version.length, sha256: receiptDigest(version), rawBase64: version.toString('base64'), encoding: 'utf8' }], coverage: { commits: 1, changedFiles: 1, retainedObjects: 2, retainedBytes: raw.length + version.length } }) + '\n');
    f.sourceDigest = receiptDigest(source);
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceDigest: f.sourceDigest, coverage: { commitShas: [id], paths: ['VERSION'] }, internalChanges: [], unknowns: [] }) + '\n');
    f.evidenceDigest = receiptDigest(evidence);
    state.gh.getGitCommit = async () => ({ sha: id, tree: { sha: sha('b') } });
    state.gh.getGitTree = async () => ({ sha: sha('b'), truncated: false, tree: [{ path: 'VERSION', sha: blobId, mode: '100644', type: 'blob' }] });
    state.gh.request = async (_m: string, path: string) => path.includes('/git/blobs/') ? { sha: blobId, size: version.length, encoding: 'base64', content: version.toString('base64') } : { id: 1, type: 'User' };
    await expect(receipts.request('prepare', { frozen: f, draftNotes: notesFixture })).rejects.toThrow('OBJECT_MISSING');
    await receipts.putObject(source); await receipts.putObject(evidence);
    const first = await receipts.request<ReleaseReceipt>('prepare', { frozen: f, draftNotes: notesFixture });
    expect(first.phase).toBe('prepared'); expect(first.frozen.productTargetSha).toBe(id);
    expect(await receipts.request('prepare', { frozen: f, draftNotes: notesFixture })).toEqual(first);
    await expect(receipts.request('prepare', { frozen: { ...f, targetTag: 'v9.0.0' }, draftNotes: notesFixture })).rejects.toThrow('PREPARE_IDENTITY');
    expect(await receipts.request('revisions/1')).toEqual(first);
  });
  it('approval alone performs zero release writes; manual merge publishes exact approved bytes once', async () => {
    await seed(); await withReleaseClaim(receipts, s => s.act('review'));
    expect((await store.get(9001, 'v1.2.3'))?.phase).toBe('approved');
    await expect(publish()).rejects.toThrow('NOT_APPROVED_AND_MERGED'); expect(creates).toBe(0);
    await approveAndMerge(); expect((await publish()).phase).toBe('verified');
    expect(remote.body).toBe(notesFixture); expect(remote.target_commitish).toBe(sha('a'));
    expect(remote.target_commitish).not.toBe(state.facts.merge.commitSha);
    expect((await publish()).phase).toBe('verified'); expect(creates).toBe(1); expect(publishes).toBe(1);
  });
  it.each(['create', 'upload', 'publish'] as const)('recovers a lost %s response without a duplicate object', async stage => {
    await seed(true); await approveAndMerge(); lost = stage;
    try { await publish(); } catch (error) { expect(stage).not.toBe('create'); expect(String(error)).toContain('response lost'); }
    expect((await publish()).phase).toBe('verified'); expect(creates).toBe(1); expect(uploads).toBe(1); expect(publishes).toBe(1);
    expect((await store.get(9001, 'v1.2.3'))?.assetIds).toEqual({ 'app.zip': 100 });
  });
  it('pending capability cannot publish and cannot be activated through receipt state', async () => {
    await seed(); await approveAndMerge(); state.capability.state = 'pending';
    await expect(publish()).rejects.toThrow('CAPABILITY'); expect(creates).toBe(0);
  });
  it('manual pause survives review events and resume is explicit', async () => {
    await seed(); await approveAndMerge(); await withReleaseClaim(receipts, s => s.act('pause'));
    await expect(withReleaseClaim(receipts, s => s.act('review'))).rejects.toThrow('SEALED');
    await expect(withReleaseClaim(receipts, s => s.act('review'))).rejects.toThrow('SEALED');
    await expect(publish()).rejects.toThrow('NOT_APPROVED_AND_MERGED'); expect(creates).toBe(0);
    await withReleaseClaim(receipts, s => s.act('resume')); expect((await publish()).phase).toBe('verified');
  });
  it.each(['head', 'body', 'product', 'approval', 'manual'])('fresh %s drift blocks writes', async kind => {
    await seed(); await approveAndMerge();
    if (kind === 'head') state.facts.headSha = sha('f');
    if (kind === 'body') state.facts.notes = notesFixture.replace('导入', '导出');
    if (kind === 'product') state.facts.productTreeUnchanged = false;
    if (kind === 'approval') state.facts.reviews[0].state = 'DISMISSED';
    if (kind === 'manual') state.facts.manualMerge = false;
    await expect(publish()).rejects.toThrow(); expect(creates).toBe(0);
  });
  it('unowned release and occupied tag stop without changing remote objects', async () => {
    await seed(); await approveAndMerge(); remote = { id: 55, draft: true, body: 'foreign' };
    await expect(publish()).rejects.toThrow('EXTERNAL_RELEASE'); expect(creates).toBe(0); expect(remote.body).toBe('foreign');
    remote = null; state.gh.getGitRef = async () => ({ object: { type: 'commit', sha: sha('a') } });
    await expect(publish()).rejects.toThrow('TAG_OCCUPIED'); expect(creates).toBe(0);
  });
  it('unknown draft-creation outcome is retained instead of blindly creating again', async () => {
    await seed(); await approveAndMerge();
    state.gh.createRelease = async () => { creates++; throw new Error('network unknown'); };
    await expect(publish()).rejects.toThrow('network unknown');
    await expect(publish()).rejects.toThrow('CREATION_OUTCOME_UNKNOWN'); expect(creates).toBe(1);
    expect((await store.get(9001, 'v1.2.3'))?.operation?.kind).toBe('create-release');
  });
  it('explicit recovery waits out the prior job and proves absence before permitting another creation', async () => {
    await seed(); await approveAndMerge(); const original = state.gh.createRelease;
    state.gh.createRelease = async () => { creates++; throw new Error('network unknown'); };
    await expect(publish()).rejects.toThrow('network unknown');
    await expect(withReleaseClaim(receipts, s => s.act('retry-create'))).rejects.toThrow('CREATION_STILL_UNCERTAIN');
    state.gh.listReleases = async () => [];
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60_000);
    await withReleaseClaim(receipts, s => s.act('retry-create')); expect(creates).toBe(1);
    state.gh.createRelease = original; expect((await publish()).phase).toBe('verified'); expect(creates).toBe(2);
  });
  it('conflicting asset bytes block recovery without delete/reupload', async () => {
    await seed(true); await approveAndMerge(); lost = 'upload'; await expect(publish()).rejects.toThrow();
    remote.assets[0].digest = 'sha256:' + '0'.repeat(64);
    await expect(publish()).rejects.toThrow('ASSET_CONFLICT'); expect(uploads).toBe(1); expect(publishes).toBe(0);
  });
  it('published body drift is reported and never overwritten', async () => {
    await seed(); await approveAndMerge(); await publish(); remote.body = 'human later edit';
    await expect(publish()).rejects.toThrow('REMOTE_IDENTITY'); expect(remote.body).toBe('human later edit'); expect(publishes).toBe(1);
  });
  it('changed local asset bytes block before creating draft', async () => {
    await seed(true); await approveAndMerge(); await writeFile(join(directory, 'app.zip'), 'wrong');
    await expect(publish()).rejects.toThrow('ASSET_FILE'); expect(creates).toBe(0);
  });
});
