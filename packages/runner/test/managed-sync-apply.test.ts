import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { applyManagedPreview } from '../src/managed-sync-apply.js';
import { gitBlob } from '../src/managed-sync-preview.js';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
it.each(['valid', 'human-change', 'forged-worktree-hash', 'forged-both-hashes', 'staged-change', 'untracked-collision', 'preview-change', 'policy', 'repository', 'traversal', 'head'])('applies only the checked local preview: %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'managed-apply-')); roots.push(root); registerOfflineFixtureRoot(root);
  const target = join(root, 'target'), preview = join(root, 'preview'); await mkdir(target); await mkdir(join(preview, 'files'), { recursive: true });
  const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', target, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init'); await git('config', 'user.name', 'Offline Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  const before = Buffer.from('old\n'), after = Buffer.from('new\n'); await writeFile(join(target, 'AGENTS.md'), before);
  await git('add', 'AGENTS.md'); await git('commit', '-m', 'offline fixture');
  const head = await git('rev-parse', 'HEAD'), policy = 'b'.repeat(40);
  const report = { schemaVersion: 1, repositoryId: 1, expectedBaseSha: head, policySha: policy, remoteWrites: 0,
    files: [{ path: 'AGENTS.md', beforeBlob: gitBlob(before), beforeSha256: hash(before), afterBlob: gitBlob(after), afterSha256: hash(after) }] };
  await writeFile(join(preview, 'files/AGENTS.md'), kind === 'preview-change' ? 'tampered' : after);
  if (kind === 'human-change') await writeFile(join(target, 'AGENTS.md'), 'human edits');
  if (['forged-worktree-hash', 'forged-both-hashes', 'staged-change'].includes(kind)) {
    const human = Buffer.from('human edits'); await writeFile(join(target, 'AGENTS.md'), human);
    report.files[0]!.beforeSha256 = hash(human);
    if (kind === 'forged-both-hashes') report.files[0]!.beforeBlob = gitBlob(human);
    if (kind === 'staged-change') await git('add', 'AGENTS.md');
  }
  if (kind === 'untracked-collision') {
    report.files[0]!.path = 'NEW.md';
    Object.assign(report.files[0]!, { beforeBlob: null, beforeSha256: hash(Buffer.from('human edits')) });
    await writeFile(join(target, 'NEW.md'), 'human edits'); await writeFile(join(preview, 'files/NEW.md'), after);
  }
  if (kind === 'policy') report.policySha = 'c'.repeat(40);
  if (kind === 'repository') report.repositoryId++;
  if (kind === 'traversal') report.files[0]!.path = '../escape';
  if (kind === 'head') report.expectedBaseSha = 'd'.repeat(40);
  await writeFile(join(preview, 'preview.json'), JSON.stringify(report));
  const result = applyManagedPreview(preview, target, 1, policy);
  if (kind === 'valid') { expect(await result).toEqual(['AGENTS.md']); expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('new\n'); }
  else { await expect(result).rejects.toThrow('MANAGED_'); expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe(['human-change', 'forged-worktree-hash', 'forged-both-hashes', 'staged-change'].includes(kind) ? 'human edits' : 'old\n'); if (kind === 'untracked-collision') expect(await readFile(join(target, 'NEW.md'), 'utf8')).toBe('human edits'); }
});
