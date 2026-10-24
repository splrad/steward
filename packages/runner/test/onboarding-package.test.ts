import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { previewManagedSync, gitBlob, type GitSnapshot, type PreviewInput, type OnboardingManifest } from '../src/managed-sync-preview.js';
import { parseManagedFileConfig } from '../src/managed-file-config.js';
import baseline from './fixtures/layerscape-onboarding-base.json' with { type: 'json' };
import owners from '../../../config/managed-files.json' with { type: 'json' };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-package-')); roots.push(root);
  const directory = resolve('config/onboarding/1187527897');
  const manifest: OnboardingManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  expect(manifest.expectedBaseSha).toBe(baseline.sourceCommit);
  const policy = 'b'.repeat(40), target = new Map(Object.entries(baseline.files).map(([path, value]) => [path, Buffer.from(value)]));
  let head = baseline.sourceCommit;
  const input: PreviewInput = { repositoryId: manifest.repositoryId, fullName: manifest.fullName, defaultBranch: 'main', expectedBaseSha: manifest.expectedBaseSha,
    policySha: policy, configuredPolicySha: policy, revokedPolicyShas: [], mode: 'onboard', targetDirectory: join(root, 'target'),
    sourceDirectories: { 'splrad/steward': process.cwd() }, rules: parseManagedFileConfig(owners).repositories['1187527897']!.map(rule => ({ ...rule, sourceSha: policy })),
    onboarding: { directory, manifest }, outputDirectory: join(root, 'first') };
  const snapshot: GitSnapshot = { head: async () => head, file: async (directory, sha, path) => {
    if (directory === input.targetDirectory) { if (sha !== head) throw new Error('wrong snapshot commit'); return target.get(path) ?? null; }
    if (sha !== policy || directory !== process.cwd()) throw new Error('wrong policy snapshot');
    return readFile(resolve(path));
  }, blob: async () => { throw new Error('onboard must not merge unknown blobs'); } };
  const adopt = async () => {
    const report = await previewManagedSync(input, snapshot);
    for (const file of report.files) target.set(file.path, await readFile(join(input.outputDirectory, 'files', file.path)));
    head = 'c'.repeat(40); input.outputDirectory = join(root, 'repeat');
    return report;
  };
  return { input, target, snapshot, adopt };
}
it('renders the actual reviewed product package with one writer per path and a fixed policy caller', async () => {
  const f = await fixture(), report = await f.adopt();
  expect(report.remoteWrites).toBe(0); expect(new Set(report.files.map(file => file.path)).size).toBe(report.files.length);
  expect(f.target.get('VERSION')!.toString()).toBe('9.2.2\n');
  const rp = JSON.parse(f.target.get('release-please-config.json')!.toString());
  expect(rp.packages['.']).toEqual({ 'release-type': 'simple', 'version-file': 'VERSION', 'changelog-path': 'CHANGELOG.md' });
  expect(rp['bootstrap-sha']).toMatch(/^[a-f0-9]{40}$/);
  expect(f.target.get('.github/workflows/steward-release-publish.yml')!.toString()).toContain('@' + f.input.policySha);
  expect(f.target.get('AGENTS.md')!.toString()).toContain('<!-- steward:review:start -->');
  const repeated = await previewManagedSync(f.input, f.snapshot);
  expect(repeated).toMatchObject({ reason: 'already-adopted', files: [], expectedBaseSha: 'c'.repeat(40) });
});
it('repeated onboarding preserves a newer RP version and changelog without comparing the first base SHA', async () => {
  const f = await fixture(); await f.adopt();
  f.target.set('VERSION', Buffer.from('9.3.0\n'));
  f.target.set('.release-please-manifest.json', Buffer.from('{".":"9.3.0"}\n'));
  f.target.set('CHANGELOG.md', Buffer.from('# Changelog\n\n## 9.3.0\nReviewed changes\n'));
  expect(await previewManagedSync(f.input, f.snapshot)).toMatchObject({ reason: 'already-adopted', files: [] });
  expect(f.target.get('VERSION')!.toString()).toBe('9.3.0\n');
});
it.each(['human-before', 'payload-hash', 'partial', 'version-mismatch', 'different-policy', 'invalid-source-blob', 'forged-source-blob'])('blocks %s instead of resetting product content', async kind => {
  const f = await fixture();
  if (kind === 'human-before') f.target.set('AGENTS.md', Buffer.from('human edits'));
  else if (kind === 'payload-hash') f.input.onboarding!.manifest.files[0]!.sha256 = '0'.repeat(64);
  else {
    await f.adopt();
    if (kind === 'partial') f.target.delete('global.json');
    if (kind === 'version-mismatch') f.target.set('VERSION', Buffer.from('9.3.0\n'));
    if (kind === 'different-policy') { const a = JSON.parse(f.target.get('.github/steward-adoption.json')!.toString()); a.policySha = 'd'.repeat(40); f.target.set('.github/steward-adoption.json', Buffer.from(JSON.stringify(a))); }
    if (kind.endsWith('source-blob')) { const a = JSON.parse(f.target.get('.github/steward-adoption.json')!.toString()); a.files[0].sourceBlob = kind === 'invalid-source-blob' ? 'invalid' : 'f'.repeat(40); f.target.set('.github/steward-adoption.json', Buffer.from(JSON.stringify(a))); }
  }
  await expect(previewManagedSync(f.input, f.snapshot)).rejects.toThrow();
});
