import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { previewManagedSync, gitBlob, safeManagedPath, type PreviewInput, type GitSnapshot } from '../src/managed-sync-preview.js';
// Only Git's fixed merge-file invocation may run; no hooks, repository or network.
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync(command: string, args: string[], options: any) {
    if (command !== 'git' || JSON.stringify(args.slice(0, 9)) !== '["merge-file","-p","--diff3","-L","CURRENT","-L","BASE","-L","NEW"]'
      || args.length !== 12 || options.shell !== false) throw new Error('TEST_SUBPROCESS_DENIED');
    return original.spawnSync(command, args, options);
  } };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'managed-preview-')); roots.push(root);
  const directory = join(root, 'input'); await mkdir(join(directory, 'files'), { recursive: true });
  const bytes = Buffer.from('9.2.2\n'); await writeFile(join(directory, 'files/VERSION'), bytes);
  const input: PreviewInput = { repositoryId: 1187527897, fullName: 'splrad/LayerScape', defaultBranch: 'main', expectedBaseSha: 'a'.repeat(40), policySha: 'b'.repeat(40), configuredPolicySha: 'b'.repeat(40), revokedPolicyShas: [], mode: 'onboard', targetDirectory: join(root, 'target'), sourceDirectories: { 'splrad/steward': join(root, 'policy') },
    rules: [{ source: 'schema/source.json', destination: 'schema/source.json', mode: 'whole', dependencyFields: [], sourceRepository: 'splrad/steward', sourceSha: 'b'.repeat(40) }],
    onboarding: { directory, manifest: { schemaVersion: 1, repositoryId: 1187527897, fullName: 'splrad/LayerScape', defaultBranch: 'main', expectedBaseSha: 'a'.repeat(40), mode: 'onboard', initializeManifest: false, files: [{ targetPath: 'VERSION', beforeBlob: null, payloadPath: 'files/VERSION', sha256: createHash('sha256').update(bytes).digest('hex') }] } }, outputDirectory: join(root, 'out') };
  const target = new Map<string, Buffer>(), blobs = new Map<string, Buffer>(); const sources = new Map([[input.policySha, Buffer.from('schema bytes\n')]]);
  const snapshot: GitSnapshot = { head: async () => input.expectedBaseSha, file: async (directory, sha, path) => {
    if (directory === input.targetDirectory && sha === input.expectedBaseSha) return target.get(path) ?? null;
    if (directory === input.sourceDirectories['splrad/steward'] && sources.has(sha) && path === 'schema/source.json') return sources.get(sha)!;
    throw new Error('unexpected snapshot read');
  }, blob: async (_, id) => { const value = blobs.get(id); if (!value) throw new Error('missing fixture blob'); return value; } };
  const adopt = async () => {
    const report = await previewManagedSync(input, snapshot);
    for (const { path } of report.files) { const bytes = await readFile(join(input.outputDirectory, 'files', path)); target.set(path, bytes); blobs.set(gitBlob(bytes), bytes); }
    input.mode = 'sync'; delete input.onboarding; input.outputDirectory = join(root, 'next'); return report;
  };
  return { root, input, target, blobs, snapshot, adopt, setSource: (bytes: string) => { const sha = createHash('sha1').update(bytes).digest('hex'); sources.set(sha, Buffer.from(bytes)); input.policySha = input.configuredPolicySha = input.rules[0]!.sourceSha = sha; } };
}
const merge = async (current: string, base: string, next: string) => { if (current !== base && current !== next) throw new Error('CONFLICT'); return next; };
it('writes an isolated exact preview and repeat sync has no changed paths', async () => {
  const f = await fixture(); const report = await f.adopt();
  expect(report.remoteWrites).toBe(0); expect(report.files.map(file => file.path)).toEqual(['.github/steward-adoption.json', 'schema/source.json', 'VERSION']);
  const second = await previewManagedSync(f.input, f.snapshot, merge); expect(second.files).toEqual([]);
  expect((await readFile(join(f.input.outputDirectory, 'preview.json'), 'utf8'))).toContain('"remoteWrites": 0');
});
it('merges from the adopted Git blob and retains exact source and target digests', async () => {
  const f = await fixture(); await f.adopt(); f.setSource('new schema\n');
  const report = await previewManagedSync(f.input, f.snapshot, merge);
  expect(report.files.map(file => file.path)).toEqual(['.github/steward-adoption.json', 'schema/source.json']);
  const adoption = JSON.parse(await readFile(join(f.input.outputDirectory, 'files/.github/steward-adoption.json'), 'utf8'));
  expect(adoption.files[0].targetBlob).toBe(gitBlob(Buffer.from('new schema\n')));
});
it.each(['wrong-policy', 'revoked', 'wrong-repo', 'wrong-head', 'wrong-digest', 'overlap', 'existing-human', 'manifest', 'credential', 'output'])('stops %s before writing output', async kind => {
  const f = await fixture();
  if (kind === 'wrong-policy') f.input.configuredPolicySha = 'c'.repeat(40);
  if (kind === 'revoked') f.input.revokedPolicyShas.push(f.input.policySha);
  if (kind === 'wrong-repo') f.input.onboarding!.manifest.repositoryId++;
  if (kind === 'wrong-head') f.snapshot.head = async () => 'c'.repeat(40);
  if (kind === 'wrong-digest') f.input.onboarding!.manifest.files[0]!.sha256 = 'c'.repeat(64);
  if (kind === 'overlap') f.input.onboarding!.manifest.files[0]!.targetPath = 'schema/source.json';
  if (kind === 'existing-human') f.target.set('schema/source.json', Buffer.from('human work'));
  if (kind === 'manifest') f.input.onboarding!.manifest.files[0]!.targetPath = '.release-please-manifest.json';
  if (kind === 'credential') await writeFile(join(f.input.onboarding!.directory, 'files/VERSION'), '-----BEGIN PRIVATE KEY-----');
  if (kind === 'output') f.input.outputDirectory = join(f.input.targetDirectory, 'out');
  await expect(previewManagedSync(f.input, f.snapshot, merge)).rejects.toThrow();
  await expect(stat(f.input.outputDirectory)).rejects.toThrow();
});
it.each(['conflict', 'base-digest', 'missing-adoption', 'removed-path', 'binary'])('rejects %s in normal sync', async kind => {
  const f = await fixture(); await f.adopt();
  if (kind === 'conflict') { f.target.set('schema/source.json', Buffer.from('human work')); f.setSource('central new work'); }
  if (kind === 'base-digest') { for (const id of f.blobs.keys()) f.blobs.set(id, Buffer.from('corrupt base')); }
  if (kind === 'missing-adoption') f.target.delete('.github/steward-adoption.json');
  if (kind === 'removed-path') f.input.rules = [];
  if (kind === 'binary') f.setSource('nul\0data');
  await expect(previewManagedSync(f.input, f.snapshot, merge)).rejects.toThrow();
});
it.each(['../secret', '/etc/passwd', 'dir\\file', '.git/config', 'a/./b', 'CON', 'dir/NUL.txt', 'trailing.', 'a//b'])('rejects unsafe path %s', path => {
  expect(() => safeManagedPath(path)).toThrow();
});

it.each(['reviewed', 'human-change', 'unregistered'])('first review-section migration binds the exact old blob: %s', async kind => {
  const f = await fixture(), before = Buffer.from('# Existing reviewed rules\n');
  const rule = { source: 'config/review/rules.json', destination: 'AGENTS.md', mode: 'section' as const, dependencyFields: [],
    sourceRepository: 'splrad/steward', sourceSha: f.input.policySha, renderer: 'review' as const, profile: 'layerscape',
    startMarker: '<!-- steward:review:start -->', endMarker: '<!-- steward:review:end -->', adoptionBeforeBlob: gitBlob(before) };
  f.input.rules = [rule]; f.target.set('AGENTS.md', kind === 'human-change' ? Buffer.from('unreviewed human text') : before);
  if (kind === 'unregistered') delete (rule as any).adoptionBeforeBlob;
  const original = f.snapshot.file;
  f.snapshot.file = async (directory, sha, path) => directory === f.input.sourceDirectories['splrad/steward']
    ? readFile(path) : original(directory, sha, path);
  if (kind !== 'reviewed') { await expect(previewManagedSync(f.input, f.snapshot)).rejects.toThrow('requires migration'); return; }
  const report = await previewManagedSync(f.input, f.snapshot);
  const generated = await readFile(join(f.input.outputDirectory, 'files/AGENTS.md'), 'utf8');
  expect(generated).toMatch(/^<!-- steward:review:start -->\n/);
  expect(generated).toMatch(/<!-- steward:review:end -->\n$/);
  expect(report.files.find(file => file.path === 'AGENTS.md')?.beforeBlob).toBe(gitBlob(before));
});

it('preserves product edits through consecutive syncs and later independent central changes', async () => {
  const f = await fixture(); f.setSource('a\nb\nc\nd\ne\n'); await f.adopt();
  f.target.set('schema/source.json', Buffer.from('human\nb\nc\nd\ne\n'));
  f.setSource('a\nb\nc\nd\ncentral\n');
  // Use the real Git three-way merge, then adopt its actual output as a committed snapshot.
  const first = await previewManagedSync(f.input, f.snapshot);
  for (const { path } of first.files) {
    const bytes = await readFile(join(f.input.outputDirectory, 'files', path));
    f.target.set(path, bytes); f.blobs.set(gitBlob(bytes), bytes);
  }
  expect(f.target.get('schema/source.json')!.toString()).toBe('human\nb\nc\nd\ncentral\n');
  f.input.outputDirectory = join(f.root, 'third');
  expect((await previewManagedSync(f.input, f.snapshot)).files).toEqual([]);
  f.setSource('a\nb\nc\nd\ncentral-two\n'); f.input.outputDirectory = join(f.root, 'fourth');
  await previewManagedSync(f.input, f.snapshot);
  expect(await readFile(join(f.input.outputDirectory, 'files/schema/source.json'), 'utf8')).toBe('human\nb\nc\nd\ncentral-two\n');
});
it('fails closed when the prior rendered source cannot be proven', async () => {
  const f = await fixture(); await f.adopt();
  const adoption = JSON.parse(f.target.get('.github/steward-adoption.json')!.toString());
  adoption.files[0].sourceBlob = 'f'.repeat(40);
  f.target.set('.github/steward-adoption.json', Buffer.from(JSON.stringify(adoption)));
  await expect(previewManagedSync(f.input, f.snapshot, merge)).rejects.toThrow('unproven source baseline');
});
