import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
