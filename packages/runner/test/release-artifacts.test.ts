import { mkdtemp, writeFile, rm, readFile, lstat, link } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { expect, it, afterEach } from 'vitest';
import { inspectReleaseArtifacts, sealReleaseArtifacts, verifySealedArtifacts, validateReleaseManifest, type ReleaseIdentity } from '../src/release-artifacts.js';
import type { ReleaseUnit } from '../../core/src/release-descriptor.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const unit: ReleaseUnit = { id: 'product', displayName: 'Product', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/product.md',
  builds: [{ id: 'native', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['app'] }],
  artifacts: [{ id: 'app', file: 'app-${version}.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'native', required: true }], channels: [] };
const identity: ReleaseIdentity = { repositoryId: 1, fullName: 'fixture/product', unitId: 'product', version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), descriptorSha256: 'c'.repeat(64), templateSha256: 'd'.repeat(64), runId: 1, attempt: 2, toolLocks: { 'mise.lock': 'e'.repeat(64) }, producers: [{ buildId: 'native', jobId: 11, attempt: 1, artifactId: 100 }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-artifacts-')); roots.push(root);
  await writeFile(join(root, 'app-1.2.3.exe'), 'fixture bytes; native parsing is exercised by the native inspector integration');
  return root;
}
async function evidence(root: string) {
  await writeFile(join(root, 'sbom.spdx.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] }));
  await writeFile(join(root, 'release-notes.md'), `# Product 1.2.3\n${identity.sourceSha}\n${identity.policySha}\n`);
}
it('seals N+4 with exact hashes and the actual successful producer attempt', async () => {
  const root = await fixture();
  const pending = await inspectReleaseArtifacts(unit, root, identity, async () => '1.2.3');
  await evidence(root); const sealed = await sealReleaseArtifacts(root, pending);
  expect(sealed.producers[0]!.attempt).toBe(1);
  await expect(verifySealedArtifacts(root, sealed)).resolves.toBeUndefined();
  const sums = await readFile(join(root, 'SHA256SUMS'), 'utf8');
  expect(sums.trim().split('\n')).toHaveLength(4);
  expect(sums).not.toContain('SHA256SUMS');
  expect(sealed.evidence).toHaveLength(2);
  await writeFile(join(root, 'app-1.2.3.exe'), 'different bytes');
  await expect(verifySealedArtifacts(root, sealed)).rejects.toThrow('bytes mismatch');
});
it('rejects extra assets, wrong native version, missing producers and future attempts', async () => {
  const root = await fixture();
  await expect(inspectReleaseArtifacts(unit, root, identity, async () => '2.0.0')).rejects.toThrow('native version');
  await expect(inspectReleaseArtifacts(unit, root, { ...identity, producers: [] }, async () => '1.2.3')).rejects.toThrow('producer');
  await expect(inspectReleaseArtifacts(unit, root, { ...identity, producers: [{ ...identity.producers[0]!, attempt: 3 }] }, async () => '1.2.3')).rejects.toThrow('producer');
  await writeFile(join(root, 'extra.zip'), 'extra');
  await expect(inspectReleaseArtifacts(unit, root, identity, async () => '1.2.3')).rejects.toThrow('asset set');
});
it('rejects notes identity mismatch and unknown manifest keys', async () => {
  const root = await fixture(); const pending = await inspectReleaseArtifacts(unit, root, identity, async () => '1.2.3');
  expect(() => validateReleaseManifest({ ...pending, credential: 'fixture' })).toThrow('schema');
  await evidence(root); await writeFile(join(root, 'release-notes.md'), '# another version');
  await expect(sealReleaseArtifacts(root, pending)).rejects.toThrow('notes identity');
});
it('inspects a private byte snapshot with the original filename and removes it afterwards', async () => {
  const root = await fixture(), original = await readFile(join(root, 'app-1.2.3.exe'));
  let snapshot = '';
  const manifest = await inspectReleaseArtifacts(unit, root, identity, async path => {
    snapshot = path;
    expect(dirname(path)).not.toBe(root); expect(basename(path)).toBe('app-1.2.3.exe');
    expect(await readFile(path)).toEqual(original);
    return '1.2.3';
  });
  expect(manifest.artifacts[0]).toMatchObject({ size: original.length, sha256: createHash('sha256').update(original).digest('hex') });
  await expect(lstat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['source', 'snapshot'])('rejects mutation of the %s during native inspection', async location => {
  const root = await fixture(); let snapshot = '';
  await expect(inspectReleaseArtifacts(unit, root, identity, async path => {
    snapshot = path;
    await writeFile(location === 'source' ? join(root, 'app-1.2.3.exe') : path, 'changed bytes');
    return '1.2.3';
  })).rejects.toThrow(location === 'source' ? 'RN_BUILD_PATH' : 'RN_BUILD_DIGEST');
  await expect(lstat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a later inspection changing an earlier file', async () => {
  const root = await fixture(), two = structuredClone(unit);
  two.artifacts.push({ ...two.artifacts[0]!, id: 'other', file: 'other-${version}.exe' });
  two.builds[0]!.expectedArtifacts.push('other');
  await writeFile(join(root, 'other-1.2.3.exe'), 'other bytes');
  await expect(inspectReleaseArtifacts(two, root, identity, async path => {
    if (basename(path).startsWith('other-')) await writeFile(join(root, 'app-1.2.3.exe'), 'changed first asset');
    return '1.2.3';
  })).rejects.toThrow('RN_BUILD_PATH');
});
it('rejects assets added during inspection', async () => {
  const root = await fixture();
  await expect(inspectReleaseArtifacts(unit, root, identity, async () => {
    await writeFile(join(root, 'extra.zip'), 'extra'); return '1.2.3';
  })).rejects.toThrow('asset set');
});
it('rejects hardlinked assets before invoking the native inspector', async () => {
  const root = await fixture(), linkRoot = await fixture();
  await rm(join(root, 'app-1.2.3.exe')); await link(join(linkRoot, 'app-1.2.3.exe'), join(root, 'app-1.2.3.exe'));
  let called = false;
  await expect(inspectReleaseArtifacts(unit, root, identity, async () => { called = true; return '1.2.3'; })).rejects.toThrow('RN_BUILD_LIMIT');
  expect(called).toBe(false);
});
it('freezes caller source and output metadata during inspection', async () => {
  const root = await fixture(), callerUnit = structuredClone(unit), callerIdentity = structuredClone(identity);
  const manifest = await inspectReleaseArtifacts(callerUnit, root, callerIdentity, async () => {
    callerIdentity.sourceSha = 'f'.repeat(40); callerUnit.artifacts[0]!.platform = 'mutated';
    return '1.2.3';
  });
  expect(manifest.sourceSha).toBe(identity.sourceSha); expect(manifest.artifacts[0]!.platform).toBe('windows');
});
it('accepts a font-only result only for its declared ZIP archive', async () => {
  const root = await fixture();
  await expect(inspectReleaseArtifacts(unit, root, identity, async () => ({ resourceOnly: 'font-archive' }))).rejects.toThrow('native version');
  const font = structuredClone(unit);
  font.artifacts[0] = { ...font.artifacts[0]!, file: 'Fonts.zip', kind: 'archive', mediaType: 'application/zip' };
  await rm(join(root, 'app-1.2.3.exe')); await writeFile(join(root, 'Fonts.zip'), 'font bytes');
  await expect(inspectReleaseArtifacts(font, root, identity, async () => ({ resourceOnly: 'font-archive' }))).resolves.toMatchObject({ artifacts: [{ path: 'Fonts.zip' }] });
});
