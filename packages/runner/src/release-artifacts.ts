import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactNames, type ReleaseUnit } from '../../core/src/release-descriptor.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../schema/artifact-manifest.schema.json' with { type: 'json' };
const validate = new Ajv2020({ strict: true }).compile(schema);

export interface ReleaseIdentity {
  repositoryId: number; fullName: string; unitId: string; version: string; packageVersion: string; tag: string;
  sourceSha: string; policySha: string; descriptorSha256: string; templateSha256: string;
  runId: number; attempt: number; toolLocks: Record<string, string>;
  producers: { buildId: string; jobId: number; attempt: number; artifactId: number }[];
}
export interface FileDigest { path: string; size: number; sha256: string }
export interface ReleaseManifest extends ReleaseIdentity {
  schemaVersion: 2;
  artifacts: (FileDigest & { id: string; kind: string; mediaType: string; platform: string; architecture: string })[];
  evidence: FileDigest[];
}
export type NativeInspector = (file: string) => Promise<string | { resourceOnly: 'font-archive' }>;
const fail = (reason: string): never => { throw new Error(`RELEASE_ARTIFACTS: ${reason}`); };
export function validateReleaseManifest(input: unknown): asserts input is ReleaseManifest {
  if (!validate(input)) fail('manifest schema');
}
export async function fileDigest(directory: string, name: string): Promise<FileDigest> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) fail('unsafe asset name');
  const path = join(directory, name), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size >= 2 ** 31) fail('invalid asset file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path: name, size: info.size, sha256: hash.digest('hex') };
}
function identity(input: ReleaseIdentity, unit: ReleaseUnit) {
  if (input.unitId !== unit.id || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !/^[\w.-]+\/[\w.-]+$/.test(input.fullName) || !input.tag || /[\s\x00-\x1f]/.test(input.tag)
    || ![input.sourceSha, input.policySha].every(value => /^[a-f0-9]{40}$/.test(value))
    || ![input.descriptorSha256, input.templateSha256, ...Object.values(input.toolLocks)].every(value => /^[a-f0-9]{64}$/.test(value))
    || !Object.keys(input.toolLocks).length || ![input.runId, input.attempt].every(value => Number.isSafeInteger(value) && value > 0)) fail('invalid identity');
  if (input.producers.length !== unit.builds.length || new Set(input.producers.map(item => item.buildId)).size !== unit.builds.length
    || input.producers.some(item => !unit.builds.some(build => build.id === item.buildId)
      || ![item.jobId, item.attempt, item.artifactId].every(value => Number.isSafeInteger(value) && value > 0) || item.attempt > input.attempt)) fail('producer identity');
}
export async function inspectReleaseArtifacts(unit: ReleaseUnit, directory: string, input: ReleaseIdentity, inspect: NativeInspector): Promise<ReleaseManifest> {
  identity(input, unit);
  const names = artifactNames(unit, input.version, input.packageVersion);
  const actual = (await readdir(directory)).sort(), expected = [...names.values()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.length > 996) fail('business asset set mismatch');
  const artifacts: ReleaseManifest['artifacts'] = [];
  for (const artifact of unit.artifacts) {
    const name = names.get(artifact.id)!;
    // Metadata inspection is mandatory; unsupported formats must reject in the adapter.
    const digest = await fileDigest(directory, name), metadata = await inspect(join(directory, name));
    if (typeof metadata === 'string' ? metadata !== input.packageVersion
      : !(metadata.resourceOnly === 'font-archive' && artifact.kind === 'archive' && artifact.mediaType === 'application/zip')) fail('native version or format mismatch');
    artifacts.push({ ...digest, id: artifact.id, kind: artifact.kind, mediaType: artifact.mediaType, platform: artifact.platform, architecture: artifact.architecture });
  }
  const manifest = { ...structuredClone(input), schemaVersion: 2 as const, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)), evidence: [] };
  validateReleaseManifest(manifest); return manifest;
}
export async function sealReleaseArtifacts(directory: string, manifest: ReleaseManifest): Promise<ReleaseManifest> {
  validateReleaseManifest(manifest);
  if (manifest.evidence.length) fail('already sealed');
  for (const artifact of manifest.artifacts) {
    if (JSON.stringify(await fileDigest(directory, artifact.path)) !== JSON.stringify({ path: artifact.path, size: artifact.size, sha256: artifact.sha256 })) fail('business bytes changed');
  }
  const names = ['sbom.spdx.json', 'release-notes.md'];
  const expected = [...manifest.artifacts.map(item => item.path), ...names].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('evidence set mismatch');
  const sbom = JSON.parse(await readFile(join(directory, names[0]!), 'utf8'));
  if (!/^SPDX-2\.[0-9]+$/.test(sbom.spdxVersion) || sbom.SPDXID !== 'SPDXRef-DOCUMENT' || !Array.isArray(sbom.packages)) fail('invalid SBOM');
  const notes = await readFile(join(directory, names[1]!), 'utf8');
  if (!notes.includes(manifest.version) || !notes.includes(manifest.sourceSha) || !notes.includes(manifest.policySha)) fail('notes identity');
  const sealed = { ...manifest, evidence: await Promise.all(names.map(name => fileDigest(directory, name))) };
  await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(sealed, null, 2) + '\n', { flag: 'wx' });
  const checksums = [...sealed.artifacts, ...sealed.evidence, await fileDigest(directory, 'artifact-manifest.json')]
    .sort((a, b) => a.path.localeCompare(b.path)).map(item => `${item.sha256}  ${item.path}\n`).join('');
  await writeFile(join(directory, 'SHA256SUMS'), checksums, { flag: 'wx' });
  return sealed;
}
export async function verifySealedArtifacts(directory: string, expected: ReleaseManifest): Promise<void> {
  validateReleaseManifest(expected);
  const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8'));
  if (JSON.stringify(manifest) !== JSON.stringify(expected) || expected.evidence.map(item => item.path).sort().join(',') !== 'release-notes.md,sbom.spdx.json') fail('sealed manifest mismatch');
  const files = [...expected.artifacts, ...expected.evidence, await fileDigest(directory, 'artifact-manifest.json')];
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...files.map(item => item.path), 'SHA256SUMS'].sort())) fail('final asset set mismatch');
  for (const item of files) {
    const actual = await fileDigest(directory, item.path);
    if (actual.sha256 !== item.sha256 || actual.size !== item.size) fail('final bytes mismatch');
  }
  const sums = files.sort((a, b) => a.path.localeCompare(b.path)).map(item => `${item.sha256}  ${item.path}\n`).join('');
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== sums) fail('checksum list mismatch');
}
