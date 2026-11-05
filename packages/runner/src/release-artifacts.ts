import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactNames, type ReleaseUnit } from '../../core/src/release-descriptor.js';
import { assertDeliveryAssetName } from '../../core/src/delivery-config.js';
import { inspectBuildFile, verifyBuildFileStates, type NativeVersionInspector } from './build-manifest.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ProducerReceipt } from './release-run.js';
import schema from '../../../schema/artifact-manifest.schema.json' with { type: 'json' };
import type { DeliveryUnit } from '../../core/src/delivery-config.js';
import { deliveryAssetNames } from '../../core/src/delivery-config.js';
const validate = new Ajv2020({ strict: true }).compile(schema);

export interface ReleaseIdentity {
  repositoryId: number; fullName: string; unitId: string; version: string; packageVersion: string; tag: string;
  sourceSha: string; policySha: string; descriptorSha256: string; templateSha256: string;
  runId: number; attempt: number; toolLocks: Record<string, string>;
  producers: ProducerReceipt[];
}
export interface FileDigest { path: string; size: number; sha256: string }
export interface ReleaseManifest extends ReleaseIdentity {
  schemaVersion: 2;
  artifacts: (FileDigest & { id: string; kind: string; mediaType: string; platform: string; architecture: string })[];
  evidence: FileDigest[];
}
export interface ProductReleaseManifest {
  schemaVersion: 3; repositoryId: number; fullName: string; cycleId: string; requestKey: string; unitId: string;
  version: string; packageVersion: string; tag: string; sourceSha: string; controllerSha: string; buildRef: string;
  deliverySha256: string; templateSha256: string; runId: number; attempt: number; toolLocks: Record<string, string>;
  producers: ProducerReceipt[]; artifacts: (FileDigest & { id: string; mediaType: string })[]; evidence: FileDigest[];
}
const productSchema = structuredClone(schema) as any;
productSchema.properties.schemaVersion = { const: 3 };
for (const [before, after] of [['policySha', 'controllerSha'], ['descriptorSha256', 'deliverySha256']]) {
  productSchema.properties[after!] = productSchema.properties[before!]; delete productSchema.properties[before!];
  productSchema.required = productSchema.required.map((key: string) => key === before ? after : key);
}
Object.assign(productSchema.properties, { cycleId: { type: 'string', pattern: '^pr-[1-9][0-9]*-[a-f0-9]{40}$' },
  requestKey: { type: 'string', pattern: '^[a-f0-9]{64}$' }, buildRef: { type: 'string', pattern: '^refs/heads/steward/build/pr-[1-9][0-9]*-[a-f0-9]{40}$' } });
productSchema.required.push('cycleId', 'requestKey', 'buildRef');
for (const key of ['kind', 'platform', 'architecture']) {
  delete productSchema.properties.artifacts.items.properties[key];
  productSchema.properties.artifacts.items.required = productSchema.properties.artifacts.items.required.filter((value: string) => value !== key);
}
const validateProduct = new Ajv2020({ strict: true }).compile(productSchema);
export function validateProductManifest(input: unknown): asserts input is ProductReleaseManifest {
  if (!validateProduct(input)) throw new Error('RELEASE_ARTIFACTS: product manifest schema');
  const manifest = input as unknown as ProductReleaseManifest;
  if (manifest.buildRef !== 'refs/heads/steward/build/' + manifest.cycleId || !manifest.cycleId.endsWith('-' + manifest.sourceSha))
    throw new Error('RELEASE_ARTIFACTS: product source');
}
export async function inspectProductArtifacts(unit: DeliveryUnit, directory: string, input: Omit<ProductReleaseManifest, 'schemaVersion' | 'artifacts' | 'evidence'>, inspect: NativeInspector): Promise<ProductReleaseManifest> {
  unit = structuredClone(unit); input = structuredClone(input);
  if (!input.producers.length || new Set(input.producers.map(item => item.buildId)).size !== input.producers.length
    || input.producers.some(item => ![item.jobId, item.runId??input.runId, item.attempt, item.artifactId].every(value => Number.isSafeInteger(value) && value > 0) || (item.runId??input.runId)===input.runId && item.attempt > input.attempt)) fail('producer identity');
  const names = deliveryAssetNames(unit, input.version, input.packageVersion), expected = [...names.values()].sort(), states = new Map<string, Stats>();
  if (input.unitId !== unit.id || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('business asset set mismatch');
  const inspector: NativeVersionInspector = Object.assign(async () => { throw new Error('PATH_INSPECTOR_REQUIRED'); }, { inspectPath: inspect });
  const artifacts: ProductReleaseManifest['artifacts'] = [];
  for (const asset of unit.assets) {
    const name = names.get(asset.id)!, result = await inspectBuildFile(directory, name, inspector, 2 ** 31 - 1);
    if (typeof result.native === 'string' ? result.native !== input.packageVersion
      : result.native?.resourceOnly !== 'font-archive' || asset.mediaType !== 'application/zip') fail('native version or format mismatch');
    states.set(name, result.state); artifacts.push({ id: asset.id, path: name, size: result.size, sha256: result.sha256, mediaType: asset.mediaType });
  }
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('business asset set mismatch');
  await verifyBuildFileStates(directory, states);
  const manifest: ProductReleaseManifest = { ...structuredClone(input), schemaVersion: 3, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)), evidence: [] };
  validateProductManifest(manifest); return manifest;
}
export type NativeInspector = (file: string) => Promise<string | { resourceOnly: 'font-archive' }>;
const fail = (reason: string): never => { throw new Error(`RELEASE_ARTIFACTS: ${reason}`); };
export function validateReleaseManifest(input: unknown): asserts input is ReleaseManifest {
  if (!validate(input)) fail('manifest schema');
}
export async function fileDigest(directory: string, name: string): Promise<FileDigest> {
  try { assertDeliveryAssetName(name); } catch { fail('unsafe asset name'); }
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
      || ![item.jobId, item.runId??input.runId, item.attempt, item.artifactId].every(value => Number.isSafeInteger(value) && value > 0) || (item.runId??input.runId)===input.runId && item.attempt > input.attempt)) fail('producer identity');
}
export async function inspectReleaseArtifacts(unit: ReleaseUnit, directory: string, input: ReleaseIdentity, inspect: NativeInspector): Promise<ReleaseManifest> {
  unit = structuredClone(unit); input = structuredClone(input);
  identity(input, unit);
  const names = artifactNames(unit, input.version, input.packageVersion);
  const actual = (await readdir(directory)).sort(), expected = [...names.values()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.length > 996) fail('business asset set mismatch');
  const artifacts: ReleaseManifest['artifacts'] = [];
  const states = new Map<string, Stats>();
  const inspector: NativeVersionInspector = Object.assign(async () => { throw new Error('PATH_INSPECTOR_REQUIRED'); }, { inspectPath: inspect });
  for (const artifact of unit.artifacts) {
    const name = names.get(artifact.id)!;
    // Metadata inspection is mandatory; unsupported formats must reject in the adapter.
    const { size, sha256, native: metadata, state } = await inspectBuildFile(directory, name, inspector, 2 ** 31 - 1);
    if (typeof metadata === 'string' ? metadata !== input.packageVersion
      : !(metadata?.resourceOnly === 'font-archive' && artifact.kind === 'archive' && artifact.mediaType === 'application/zip')) fail('native version or format mismatch');
    states.set(name, state);
    artifacts.push({ path: name, size, sha256, id: artifact.id, kind: artifact.kind, mediaType: artifact.mediaType, platform: artifact.platform, architecture: artifact.architecture });
  }
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('business asset set mismatch');
  await verifyBuildFileStates(directory, states);
  const manifest = { ...structuredClone(input), schemaVersion: 2 as const, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)), evidence: [] };
  validateReleaseManifest(manifest); return manifest;
}
async function sealFiles<T extends ReleaseManifest | ProductReleaseManifest>(directory: string, manifest: T): Promise<T> {
  if (manifest.schemaVersion === 3) validateProductManifest(manifest); else validateReleaseManifest(manifest);
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
  if (!notes.includes(manifest.version) || !notes.includes(manifest.sourceSha) || !notes.includes(manifest.schemaVersion === 3 ? manifest.controllerSha : manifest.policySha)) fail('notes identity');
  const sealed = { ...manifest, evidence: await Promise.all(names.map(name => fileDigest(directory, name))) };
  await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(sealed, null, 2) + '\n', { flag: 'wx' });
  const checksums = [...sealed.artifacts, ...sealed.evidence, await fileDigest(directory, 'artifact-manifest.json')]
    .sort((a, b) => a.path.localeCompare(b.path)).map(item => `${item.sha256}  ${item.path}\n`).join('');
  await writeFile(join(directory, 'SHA256SUMS'), checksums, { flag: 'wx' });
  return sealed;
}
export async function sealReleaseArtifacts(directory: string, manifest: ReleaseManifest): Promise<ReleaseManifest> { return sealFiles(directory, manifest); }
export async function sealProductArtifacts(directory: string, manifest: ProductReleaseManifest): Promise<ProductReleaseManifest> { return sealFiles(directory, manifest); }
export async function verifySealedArtifacts(directory: string, expected: ReleaseManifest | ProductReleaseManifest): Promise<void> {
  if (expected.schemaVersion === 3) validateProductManifest(expected); else validateReleaseManifest(expected);
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
