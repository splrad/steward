import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { mergeCandidate, prepareCandidateWrite, resumeCandidateWrite, pushPreparedCandidate, type CandidateWritePort, type PreparedCandidateWrite } from '../src/release-candidate-update.js';
import type { CandidateSnapshot } from '../../core/src/release-candidate.js';
import { advanceReleaseCandidate, type CandidateSession, type CandidateRuntime, type CandidatePullRequest } from '../src/release-candidate.js';

vi.setConfig({ testTimeout: 60_000 });
const roots: string[] = [], digest = 'd'.repeat(64), identity = { name: 'Candidate Fixture', email: 'candidate@example.invalid' };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'candidate-test-')); roots.push(root); registerOfflineFixtureRoot(root);
  const repo = join(root, 'source'); await mkdir(repo); const env = isolatedBuildEnvironment(process.env, root);
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: repo, env, encoding: 'utf8', windowsHide: true })).stdout.trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', identity.name); await git('config', 'user.email', identity.email);
  await mkdir(join(repo, '.release-notes')); await writeFile(join(repo, 'code.txt'), 'first\n');
  const notes = '## 概述\n\n原来概述\n\n## 更新内容\n\n原来内容\n\n## 恢复\n\n原来恢复\n';
  await writeFile(join(repo, '.release-notes/app.md'), notes); await git('add', '.'); await git('commit', '--signoff', '-m', 'feat: initial');
  const B = await git('rev-parse', 'HEAD');
  const snapshot = (baseSha = B, content = notes): CandidateSnapshot => ({ schemaVersion: 1, baseSha, configDigest: digest, sourceDigest: digest,
    units: [{ id: 'app', path: '.', version: '1.1.0', tag: 'v1.1.0' }], files: [{ path: '.release-notes/app.md', mode: '100644', content }] });
  const commit = async (path: string, content: string, message = 'Human edit') => { await writeFile(join(repo, path), content); await git('add', '--', path); await git('commit', '--signoff', '-m', message); return git('rev-parse', 'HEAD'); };
  return { root, repo, git, B, notes, snapshot, commit };
}
it('stops on human edits instead of merging with new main', async () => {
  const f = await fixture(), G = f.snapshot(); await f.git('switch', '-c', 'steward/release-candidate');
  await f.commit('.release-notes/app.md', f.notes.replace('原来概述', '人工概述'));
  const H = await f.commit('.release-notes/app.md', f.notes.replace('原来概述', '人工概述').replace('原来恢复', '人工恢复'));
  await f.git('switch', 'main'); const B = await f.commit('code.txt', 'main advanced\n', 'fix: source');
  const N = f.snapshot(B, f.notes.replace('原来内容', '自动更新内容'));
  const merged = await mergeCandidate(f.repo, G, H, N, f.root);
  expect(merged).toMatchObject({status:'CONFLICT',conflictPaths:['.release-notes/app.md']});
  expect(await f.git('show', `${H}:.release-notes/app.md`)).toContain('人工恢复');
});
it('preserves H and G on text conflict and rejects manual non-note code', async () => {
  const f = await fixture(), G = f.snapshot(), H = await f.commit('.release-notes/app.md', f.notes.replace('原来内容', '人工内容'));
  const N = f.snapshot(f.B, f.notes.replace('原来内容', '生成内容'));
  const merged = await mergeCandidate(f.repo, G, H, N, f.root);
  expect(merged).toMatchObject({ status: 'CONFLICT', conflictPaths: ['.release-notes/app.md'] });
  expect(await f.git('rev-parse', 'HEAD')).toBe(H); expect(G.files[0]!.content).toBe(f.notes);
  const changed = await f.commit('code.txt', 'manual code\n');
  expect((await mergeCandidate(f.repo, G, changed, f.snapshot(), f.root)).conflictPaths).toContain('code.txt');
});
it('stops on legacy human notes and preserves their bytes', async () => {
  const f = await fixture(), text = f.notes.replace('原来内容', '人工发布内容'), H = await f.commit('.release-notes/app.md', text);
  const result = await mergeCandidate(f.repo, null, H, f.snapshot(), f.root);
  expect(result.status).toBe('CONFLICT');
  expect(await f.git('show', `${H}:.release-notes/app.md`)).toBe(text.trim());
});
it('distinguishes empty notes from a deleted note and rejects delete/modify conflicts', async () => {
  const f = await fixture(), H = await f.commit('.release-notes/app.md', '');
  const result = await mergeCandidate(f.repo, f.snapshot(), H, f.snapshot(f.B, 'New\n'), f.root);
  expect(result.status).toBe('CONFLICT');
  await f.git('rm', '--', '.release-notes/app.md'); await f.git('commit', '--signoff', '-m', 'Delete notes');
  expect((await mergeCandidate(f.repo, f.snapshot(), await f.git('rev-parse', 'HEAD'), f.snapshot(f.B, 'New\n'), f.root)).status).toBe('CONFLICT');
});
function writer() {
  const old = 'a'.repeat(40), proposed = 'b'.repeat(40), base = 'c'.repeat(40), human = 'd'.repeat(40);
  const prepared: PreparedCandidateWrite = { expectedHead: old, baseSha: base, proposedCommit: proposed, generatedDigest: digest, objects: [] };
  const state = { head: old as string | null, editing: false, closed: false, baseSha: base };
  const events: string[] = [];
  const port: CandidateWritePort = { read: async () => ({ ...state }), isAncestor: async (a, b) => a === proposed && b === human,
    push: async () => { events.push('push'); state.head = proposed; }, persistPending: async () => { events.push('pending'); }, finish: async () => { events.push('finish'); } };
  return { prepared, state, port, events, proposed, human };
}
it('archives pending before push, recovers an accepted lost response and later human descendant', async () => {
  const f = writer(); f.port.push = async () => { f.events.push('push'); f.state.head = f.human; throw new Error('lost response'); };
  expect(await resumeCandidateWrite(f.prepared, f.port)).toEqual({ status: 'APPLIED', head: f.human });
  expect(f.events).toEqual(['pending', 'push', 'finish']);
  f.events.length = 0; await resumeCandidateWrite(f.prepared, f.port); expect(f.events).toEqual(['finish']);
});
it.each(['editing', 'closed', 'head', 'baseSha'])('rechecks %s immediately before the push', async field => {
  const f = writer(); f.port.persistPending = async () => { (f.state as any)[field] = ['editing', 'closed'].includes(field) ? true : 'e'.repeat(40); };
  expect((await resumeCandidateWrite(f.prepared, f.port)).status).toBe('CHANGED_BEFORE_PUSH'); expect(f.events).toEqual([]);
});
it('state failure sends no push and an unaccepted response remains pending', async () => {
  const f = writer(); f.port.persistPending = async () => { throw new Error('state unavailable'); };
  await expect(resumeCandidateWrite(f.prepared, f.port)).rejects.toThrow('state unavailable'); expect(f.events).toEqual([]);
  f.port.persistPending = async () => {}; f.port.push = async () => { throw new Error('not accepted'); };
  expect((await resumeCandidateWrite(f.prepared, f.port)).status).toBe('UNKNOWN');
});
it('restores archived Git objects after directory loss and recovers a real accepted push followed by a human commit', async () => {
  const f = await fixture(), remote = join(f.root, 'remote.git'); await f.git('init', '--bare', remote); await f.git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
  const N = f.snapshot(f.B, f.notes.replace('原来内容', '新增内容'));
  const merged = await mergeCandidate(f.repo, null, f.B, N, f.root);
  const persisted = JSON.stringify(await prepareCandidateWrite(f.repo, null, N, merged, identity, f.root));
  const prepared = JSON.parse(persisted) as PreparedCandidateWrite; let pushes = 0, finalized = '';
  const head = async () => { const output = await f.git('ls-remote', '--heads', '--refs', remote, 'refs/heads/steward/release-candidate'); return output ? output.split('\t')[0]! : null; };
  const port: CandidateWritePort = {
    read: async () => ({ head: await head(), editing: false, closed: false, baseSha: f.B }),
    persistPending: async () => {}, finish: async (_write, actual) => { finalized = actual; },
    isAncestor: async (a, b) => { try { await f.git('-C', remote, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } },
    push: async proposal => {
      pushes++; await pushPreparedCandidate(f.repo, remote, 'steward/release-candidate', proposal, undefined, f.root);
      await f.git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate'); await f.git('switch', '-c', 'human-after-response', 'FETCH_HEAD');
      await f.commit('.release-notes/app.md', N.files[0]!.content!.replace('原来概述', '随后人工修改'));
      await f.git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate'); throw new Error('accepted response lost');
    },
  };
  expect((await resumeCandidateWrite(prepared, port)).status).toBe('APPLIED'); expect(finalized).toBe(await head()); expect(finalized).not.toBe(prepared.proposedCommit);
  expect((await resumeCandidateWrite(JSON.parse(persisted), port)).status).toBe('APPLIED'); expect(pushes).toBe(1);
  expect(await f.git('-C', remote, 'show', `${finalized}:.release-notes/app.md`)).toContain('随后人工修改');
});
it('native non-force push rejects concurrent human divergence', async () => {
  const f = await fixture(), remote = join(f.root, 'remote.git'); await f.git('init', '--bare', remote); await f.git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  const N = f.snapshot(f.B, f.notes.replace('原来内容', '自动修改'));
  const prepared = await prepareCandidateWrite(f.repo, f.B, N, await mergeCandidate(f.repo, f.snapshot(), f.B, N, f.root), identity, f.root);
  const human = await f.commit('.release-notes/app.md', f.notes.replace('原来内容', '并发人工修改'));
  await f.git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  await expect(pushPreparedCandidate(f.repo, remote, 'steward/release-candidate', prepared, undefined, f.root)).rejects.toThrow('CANDIDATE_PUSH_UNKNOWN');
  expect(await f.git('ls-remote', '--heads', '--refs', remote, 'refs/heads/steward/release-candidate')).toContain(human);
});
async function controllerFixture() {
  const f = await fixture(), remote = join(f.root, 'remote.git'); await f.git('init', '--bare', remote); await f.git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  const candidate = { id: digest, prNumber: 9, branch: 'steward/release-candidate', baseSha: f.B, generatedSnapshotPath: `generated/${digest}/before.json`, publishedHead: f.B,
    editingAckHead: null, statusCommentId: null, contentGenerationDigest: digest, adoptionOverride: null, observedLabelEventIds: [], pendingWrite: null };
  const session: CandidateSession = { repository: { schemaVersion: 3, releaseAdoption:{sourceSha:'a'.repeat(40),prNumber:1}, repositoryId: 1, defaultBranch: 'main', revision: 0, lastObservedDefaultSha: f.B, lastCompletedCycleId: null,
    activeCycleId: null, candidate, nextCheckAt: null, lastProgressAt: null, lastErrorCode: null }, generated: f.snapshot(), pending: null, identity: null, conflict: null, preview: null, adoption: null };
  const pr: CandidatePullRequest = { number: 9, head: f.B, branch: candidate.branch, base: 'main', state: 'open', merged: false, editing: false, body: 'Human metadata' };
  const comments = [{ id: 8, authorId: 999, body: `<!-- steward:candidate-status:${digest} -->\nHuman comment` }], saved: CandidateSession[] = [];
  let pushes = 0, generations = 0, snapshot = f.snapshot();
  const io: CandidateRuntime = { workspace: f.repo, temporaryRoot: f.root, repository: 'fixture/product', defaultBranch: 'main', appBotId: 42, identity,
    now: () => '2026-10-27T00:00:00Z', source: async () => ({ baseSha: f.B, authors: [{ id: 7, evidence: 'Verified' }], authorsDigest: digest }),
    pullRequests: async () => [pr], legacyCandidate: async () => null, generation: async () => { generations++; return { status: 'READY', snapshot, title: 'Upstream title', body: 'Upstream body' }; },
    content: async () => ({ status: 'READY', files: [], actors: [], unitActors: { app: [] } }), save: async value => { saved.push(structuredClone(value)); return 'f'.repeat(40); },
    branchHead: async () => pr.head, isAncestor: async (a, b) => { try { await f.git('-C', remote, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } },
    push: async (branch, prepared) => { pushes++; await pushPreparedCandidate(f.repo, remote, branch, prepared, undefined, f.root); pr.head = prepared.proposedCommit;
      await f.git('fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${branch}`); },
    createPullRequest: async () => { throw new Error('must retain the same PR'); }, comments: async () => structuredClone(comments),
    createComment: async (_pr, body) => { comments.push({ id: 10, authorId: 42, body }); },
    updateComment: async (id, body) => { expect(id).toBe(10); comments.find(c => c.id === id)!.body = body; },
  };
  return { ...f, io, session, pr, comments, saved, setSnapshot: (value: CandidateSnapshot) => { snapshot = value; }, pushes: () => pushes, generations: () => generations };
}
it('a large same-PR preview links the exact archive commit and changes only the bot-owned comment', async () => {
  const f = await controllerFixture(), text = '## 更新内容\n\n' + '发布内容\n'.repeat(6000); f.setSnapshot(f.snapshot(f.B, text));
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'READY', prNumber: 9 });
  expect(f.session.preview).toContain(text); expect(f.comments[0]!.body).toContain('Human comment');
  const own = f.comments.find(c => c.authorId === 42)!; expect(Buffer.byteLength(own.body)).toBeLessThanOrEqual(48 * 1024);
  expect(own.body).toContain(`/blob/${'f'.repeat(40)}/generated/${digest}/preview.md`); expect(f.pr.body).toBe('Human metadata');
});
it.each(['retired', 'human-change', 'unrelated-open'])('starts the next candidate with a %s fixed branch without discarding edits', async kind => {
  const f = await controllerFixture(), closed = { ...f.pr, state: 'closed' as const, merged: true };
  f.session.repository.lastCompletedCycleId = `pr-9-${f.B}`;
  f.session.repository.candidate = null; f.session.generated = null;
  const B = await f.commit('code.txt', 'Next reviewed product implementation\n');
  f.io.source = async () => ({ baseSha: B, authors: [{ id: 7, evidence: 'Verified' }], authorsDigest: digest });
  f.setSnapshot(f.snapshot(B, f.notes.replace('原来内容', '下一周期内容')));
  let next: CandidatePullRequest | null = kind === 'unrelated-open' ? { ...closed, state: 'open', merged: false, number: 11 } : null;
  if (kind === 'human-change') f.pr.head = await f.commit('code.txt', 'Unreviewed branch edit\n');
  f.io.pullRequests = async () => [closed, ...(next ? [next] : [])];
  f.io.createPullRequest = async value => { next = { number: 10, head: f.pr.head, branch: value.branch, base: value.base,
    state: 'open', merged: false, editing: false, body: value.body }; };
  if (kind === 'unrelated-open') {
    await expect(advanceReleaseCandidate(f.session, f.io)).rejects.toThrow('CANDIDATE_UNRELATED_OPEN_PR');
    expect(f.pushes()).toBe(0); return;
  }
  const result = await advanceReleaseCandidate(f.session, f.io);
  if (kind === 'human-change') { expect(result).toMatchObject({ status: 'CONFLICT', reason: 'SOURCE_CHANGED' }); expect(f.pushes()).toBe(0); return; }
  expect(result).toMatchObject({ status: 'READY', prNumber: 10 });
  expect(f.pushes()).toBe(1);
  expect(await f.git('show', `${f.pr.head}:code.txt`)).toBe('Next reviewed product implementation');
  expect(await f.git('show', '-s', '--format=%P', f.pr.head)).toBe(`${closed.head} ${B}`);
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'READY', prNumber: 10 });
  expect(f.pushes()).toBe(1);
});
it('keeps human differences paused without reclassifying them as generated', async () => {
  const f = await controllerFixture(), N = structuredClone(f.session.generated!);
  const reviewed = f.notes.replace('原来概述', '人工审核概述').replace(/\n/g, '\r\n');
  const human = await f.commit('.release-notes/app.md', reviewed);
  f.pr.head = human; f.session.conflict = { head: f.B, generated: N, paths: ['code.txt'] };
  expect(await advanceReleaseCandidate(f.session,f.io)).toMatchObject({status:'CONFLICT',reason:'HUMAN_EDIT_CONFLICT'});
  expect(f.pushes()).toBe(0);
  expect(await f.git('show', `${human}:.release-notes/app.md`)).toBe(reviewed.trim());
});
it('an unaccepted pending write is archived before pausing for editing, with no deadlock or push', async () => {
  const f = await controllerFixture(), N = f.snapshot(f.B, f.notes.replace('原来内容', '自动内容'));
  const prepared = await prepareCandidateWrite(f.repo, f.B, N, await mergeCandidate(f.repo, f.snapshot(), f.B, N, f.root), identity, f.root);
  f.session.pending = { write: prepared, generated: N }; f.session.repository.candidate!.pendingWrite = { proposedCommit: prepared.proposedCommit };
  f.pr.editing = true;
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ reason: 'EDITING', head: f.B });
  expect(f.session.pending).toBeNull(); expect(f.session.repository.candidate!.pendingWrite).toBeNull(); expect(f.session.repository.candidate!.editingAckHead).toBeNull();
  expect(f.pushes()).toBe(0); expect(f.generations()).toBe(0);
});
it('legacy six-section notes are not automatically rewritten', async () => {
  const f = await fixture(), legacy = '## 概述\n\n人工概述\n\n## 兼容性\n\n人工兼容性\n\n## 升级与迁移\n\n人工升级\n\n## 安装说明\n\n人工安装\n\n## 已知问题\n\n人工问题\n\n## 恢复\n\n人工恢复\n';
  const H = await f.commit('.release-notes/app.md', legacy), N = f.snapshot(f.B, legacy.replace('## 兼容性', '## 更新内容\n\n新功能。\n\n## 兼容性'));
  const result=await mergeCandidate(f.repo,null,H,N,f.root);expect(result.status).toBe('CONFLICT');
  expect(await f.git('show',`${H}:.release-notes/app.md`)).toBe(legacy.trim());
});
it.each(['base', 'head'])('retires a known unadopted proposal after %s drift and resumes the same PR', async change => {
  const f = await controllerFixture(), G = structuredClone(f.session.generated), N = f.snapshot(f.B, f.notes.replace('原来内容', '自动内容'));
  const prepared = await prepareCandidateWrite(f.repo, f.B, N, await mergeCandidate(f.repo, f.snapshot(), f.B, N, f.root), identity, f.root);
  f.session.pending = { write: prepared, generated: N };
  const advanced = change === 'base' ? await f.commit('code.txt', 'main changed\n', 'fix: main')
    : await f.commit('.release-notes/app.md', f.notes.replace('原来概述', '并发人工概述'));
  if (change === 'head') {
    f.pr.head = advanced; await f.git('push', '--porcelain', join(f.root, 'remote.git'), 'HEAD:refs/heads/steward/release-candidate');
  } else f.io.source = async () => ({ baseSha: advanced, authors: [{ id: 7, evidence: 'Verified' }], authorsDigest: digest });
  f.setSnapshot(f.snapshot(change === 'base' ? advanced : f.B, N.files[0]!.content!));
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'WAIT', reason: 'REPLAN' });
  expect(f.session.pending).toBeNull(); expect(f.session.generated).toEqual(G); expect(f.pushes()).toBe(0);
  if (change === 'head') { expect(await advanceReleaseCandidate(f.session,f.io)).toMatchObject({status:'CONFLICT'}); expect(f.pushes()).toBe(0); return; }
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'READY', prNumber: 9 });
  expect(f.pushes()).toBe(1); expect(f.pr.body).toBe('Human metadata');
  const notes = await f.git('show', `${f.pr.head}:.release-notes/app.md`); expect(notes).toContain('自动内容');
  if (change === 'head') expect(notes).toContain('并发人工概述');
});
it('keeps the durable proposal and G when adoption history cannot be read', async () => {
  const f = await controllerFixture(), G = structuredClone(f.session.generated), N = f.snapshot(f.B, f.notes.replace('原来内容', '自动内容'));
  const prepared = await prepareCandidateWrite(f.repo, f.B, N, await mergeCandidate(f.repo, f.snapshot(), f.B, N, f.root), identity, f.root);
  f.session.pending = { write: prepared, generated: N }; f.pr.editing = true;
  f.io.isAncestor = async () => { throw new Error('history unavailable'); };
  await expect(advanceReleaseCandidate(f.session, f.io)).rejects.toThrow('history unavailable');
  expect(f.session.pending!.write.proposedCommit).toBe(prepared.proposedCommit); expect(f.session.generated).toEqual(G);
  expect(f.session.repository.candidate!.editingAckHead).toBeNull(); expect(f.pushes()).toBe(0);
});
it.each(['editing', 'base'])('does not publish READY content when %s changes during generation', async change => {
  const f = await controllerFixture(), G = structuredClone(f.session.generated);
  f.io.content = async () => {
    if (change === 'editing') f.pr.editing = true;
    else f.io.source = async () => ({ baseSha: 'e'.repeat(40), authors: [{ id: 7, evidence: 'Verified' }], authorsDigest: digest });
    return { status: 'READY', files: [], actors: [], unitActors: { app: [] } };
  };
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'WAIT', reason: change === 'editing' ? 'PR_CHANGED_DURING_GENERATION' : 'SOURCE_DRIFT' });
  expect(f.session.generated).toEqual(G); expect(f.pr.head).toBe(f.B); expect(f.pushes()).toBe(0);
});
it('freezes contributors per unit and renders only that unit native identities', async () => {
  const f = await controllerFixture(), snapshot = f.snapshot();
  snapshot.units.push({ id: 'lib', path: 'lib', version: '2.0.0', tag: 'lib-v2.0.0' });
  snapshot.files.push({ path: '.release-notes/lib.md', mode: '100644', content: '## 更新内容\n\n库的更新。\n' }); f.setSnapshot(snapshot);
  const actor = (id: number) => ({ id, login: `user-${id}`, type: 'User' as const, profileUrl: `https://github.com/user-${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` });
  f.io.content = async () => ({ status: 'READY', files: [], actors: [actor(10), actor(11), null], unitActors: { app: [actor(10)], lib: [actor(11), null] } });
  expect(await advanceReleaseCandidate(f.session, f.io)).toMatchObject({ status: 'READY', prNumber: 9 });
  expect(f.session.identity!.units.map(u => [u.id, u.contributors.contributors.map(c => c.id), u.contributors.unresolved])).toEqual([['app', [10], 0], ['lib', [11], 1]]);
  const [app, lib] = f.session.preview!.split('# .release-notes/lib.md');
  expect(app).toContain('user-10'); expect(app).not.toContain('user-11'); expect(lib).toContain('user-11'); expect(lib).not.toContain('user-10');
});

it('does not gate candidate generation on an existing cycle or channel completion',async()=>{
  const f=await controllerFixture(); f.session.repository.activeCycleId=`pr-8-${f.B}`;
  expect(await advanceReleaseCandidate(f.session,f.io)).toMatchObject({status:'READY',prNumber:9});
  expect(f.generations()).toBe(1);
});
it('keeps the reviewed candidate bytes when automatic draft generation fails',async()=>{
  const f=await controllerFixture(), previous=structuredClone(f.session.generated), head=f.pr.head;
  f.io.content=async()=>({status:'FAILED'});
  expect(await advanceReleaseCandidate(f.session,f.io)).toMatchObject({status:'WAIT',reason:'CONTENT_FAILED'});
  expect(f.session.generated).toEqual(previous);expect(f.pr.head).toBe(head);expect(f.pushes()).toBe(0);
});
