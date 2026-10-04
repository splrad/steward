import { minimatch } from 'minimatch';
import { assertDeliveryPath, type DeliveryConfiguration } from './delivery-config.js';
import { assertNativeVersion, parsePublicVersion } from './release-version.js';
import { sha256Hex } from './fingerprint.js';

export const buildProfiles = ['dotnet-assets-v1', 'node-package-v1', 'oci-image-v1', 'custom-adapter-v1'] as const;
export type BuildProfile = typeof buildProfiles[number];
export class BuildContractError extends Error {
  constructor(public readonly code: 'RN_BUILD_INVALID' | 'RN_BUILD_PATH' | 'RN_BUILD_OUTPUT' | 'RN_BUILD_LIMIT' | 'RN_BUILD_VERSION' | 'RN_BUILD_DIGEST') {
    super(code);
    this.name = 'BuildContractError';
  }
}
export function buildFail(code: BuildContractError['code']): never { throw new BuildContractError(code); }
export function decodeBuildJson(bytes: Uint8Array, policy: 'contract' | 'oci' = 'contract'): unknown {
  if (policy !== 'contract' && policy !== 'oci') buildFail('RN_BUILD_INVALID');
  if (bytes.byteLength > 512 * 1024) buildFail('RN_BUILD_LIMIT');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return buildFail('RN_BUILD_INVALID'); }
  if (source.startsWith('\ufeff')) buildFail('RN_BUILD_INVALID');
  let result: unknown;
  try { result = JSON.parse(source); } catch { return buildFail('RN_BUILD_INVALID'); }
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (let cursor = 0; cursor < source.length;) {
    const character = source[cursor++]!;
    if (character === '{') stack.push({ keys: new Set(), key: true });
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === ',') { const frame = stack.at(-1); if (frame) frame.key = true; }
    else if (character === '"') {
      const start = cursor - 1;
      while (cursor < source.length) { const next = source[cursor++]; if (next === '\\') cursor++; else if (next === '"') break; }
      const text = JSON.parse(source.slice(start, cursor)) as string;
      if (/[\ud800-\udfff]/u.test(text) || (policy === 'contract' && /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text))) buildFail('RN_BUILD_INVALID');
      const frame = stack.at(-1);
      if (frame?.key) { if (frame.keys.has(text)) buildFail('RN_BUILD_INVALID'); frame.keys.add(text); frame.key = false; }
    } else if (character === '-' || /[0-9]/u.test(character)) {
      const start = cursor - 1;
      while (cursor < source.length && !/[\s,}\]]/u.test(source[cursor]!)) cursor++;
      if (!Number.isFinite(Number(source.slice(start, cursor)))) buildFail('RN_BUILD_INVALID');
    }
  }
  return result;
}
export interface BuildIdentity {
  repositoryId: number; fullName: string; buildId: string; profile: BuildProfile;
  targetSha: string; policySha: string; version: string | null;
}
export interface BuildOutputRule { id: string; kind: 'file' | 'oci-image'; match?: string; count: number; mediaType?: string }
export interface BuildUnit { profile: BuildProfile; inputs: Record<string, unknown>; outputs: BuildOutputRule[] }
export interface BuildPlan extends BuildIdentity {
  inputs: Record<string, unknown>; inputsSha256: string; outputs: BuildOutputRule[];
  runner: 'windows-latest' | 'ubuntu-latest'; timeoutMinutes: 45;
  permissions: { contents: 'read' }; environment: null; persistCredentials: false;
}
export interface FileArtifact { id: string; kind: 'file'; file: string; mediaType: string; size: number; sha256: string }
export interface ImageArtifact { id: string; kind: 'oci-image'; reference: string; digest: string }
export type BuildArtifact = FileArtifact | ImageArtifact;
export interface BuildManifest extends BuildIdentity { schemaVersion: 1; inputsSha256: string; artifacts: BuildArtifact[] }
export const buildLimits = { maxFiles: 128, maxFileBytes: 1024 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 } as const;
const idPattern = /^[a-z][a-z0-9-]*$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const ociPathComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const ociDomainComponent = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ociRemoteName = `${ociPathComponent}(?:/${ociPathComponent})*`;
const ociName = `(?:${ociDomainComponent}(?:\\.${ociDomainComponent})*(?::[0-9]+)?/)?${ociRemoteName}`;
const ociRepositoryPattern = new RegExp(`^(?:${ociDomainComponent}(?:\\.${ociDomainComponent})*(?::[0-9]+)?/)?(${ociRemoteName})$`, 'u');
const ociReferencePattern = new RegExp(`^(${ociName})(?::[a-z0-9_][a-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`, 'u');
function validOciRepository(repository: string): boolean {
  const match = ociRepositoryPattern.exec(repository);
  return match !== null && match[1]!.length <= 255;
}
export function buildOciRepository(fullName: string): string {
  if (typeof fullName !== 'string') buildFail('RN_BUILD_INVALID');
  const repository = fullName.toLowerCase();
  if (!validOciRepository(repository)) buildFail('RN_BUILD_INVALID');
  return repository;
}
function validOciReference(reference: string, digest: string): boolean {
  const match = ociReferencePattern.exec(reference);
  return match !== null && validOciRepository(match[1]!) && reference.endsWith(`@${digest}`);
}
const inputFields: Record<BuildProfile, readonly string[]> = {
  'dotnet-assets-v1': ['project', 'configuration', 'framework', 'runtime'],
  'node-package-v1': ['directory', 'lockfile', 'buildTask', 'packageManager'],
  'oci-image-v1': ['context', 'dockerfile', 'platforms'],
  'custom-adapter-v1': ['entrypoint', 'runtime', 'runnerFamily'],
};
function exact(value: object, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) buildFail('RN_BUILD_INVALID');
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) buildFail('RN_BUILD_INVALID');
}
export function assertBuildIdentity(identity: BuildIdentity): void {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) buildFail('RN_BUILD_INVALID');
  if (!Number.isSafeInteger(identity.repositoryId) || identity.repositoryId <= 0 || typeof identity.fullName !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(identity.fullName)
    || typeof identity.buildId !== 'string' || !idPattern.test(identity.buildId) || !buildProfiles.includes(identity.profile) || typeof identity.targetSha !== 'string' || !shaPattern.test(identity.targetSha) || identity.targetSha.length !== 40
    || typeof identity.policySha !== 'string' || !shaPattern.test(identity.policySha) || identity.policySha.length !== 40
    || (identity.version !== null && typeof identity.version !== 'string')) buildFail('RN_BUILD_INVALID');
  if (identity.version !== null) {
    try { parsePublicVersion(identity.version); } catch { buildFail('RN_BUILD_INVALID'); }
  }
  if (identity.profile === 'oci-image-v1') buildOciRepository(identity.fullName);
}
export function assertBuildPath(path: string, options: { glob?: boolean; root?: boolean; version?: boolean } = {}): void {
  if (typeof path !== 'string') buildFail('RN_BUILD_PATH');
  try { assertDeliveryPath(path, options); } catch { buildFail('RN_BUILD_PATH'); }
  // Windows devices and alternate streams cannot form portable artifacts.
  if (path !== '.' && path.split('/').some(part => /[<>"|]/u.test(part) || /[ .]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) buildFail('RN_BUILD_PATH');
}
export async function planBuild(identity: BuildIdentity, unit: BuildUnit): Promise<BuildPlan> {
  assertBuildIdentity(identity);
  exact(unit, ['profile', 'inputs', 'outputs']);
  if (identity.profile !== unit.profile) buildFail('RN_BUILD_INVALID');
  exact(unit.inputs, inputFields[unit.profile]);
  const inputs: Record<string, unknown> = {};
  for (const field of inputFields[unit.profile]) {
    const value = unit.inputs[field];
    if (field === 'platforms') {
      if (!Array.isArray(value) || !value.length || Array.from(value).some(item => typeof item !== 'string' || !/^linux\/(?:amd64|arm64)$/u.test(item)) || new Set(value).size !== value.length) buildFail('RN_BUILD_INVALID');
      inputs[field] = [...value].sort();
    } else {
      if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) buildFail('RN_BUILD_INVALID');
      inputs[field] = value;
    }
  }
  for (const field of ['project', 'directory', 'lockfile', 'context', 'dockerfile', 'entrypoint']) {
    if (typeof inputs[field] === 'string') assertBuildPath(inputs[field], { root: ['directory', 'context'].includes(field) });
  }
  if (unit.profile === 'dotnet-assets-v1' && (inputs.configuration !== 'Release' || !/^net[0-9]+(?:\.[0-9]+)?(?:-windows)?$/u.test(String(inputs.framework)) || !/^(?:win|linux|osx)-(?:x64|arm64)$/u.test(String(inputs.runtime)))) buildFail('RN_BUILD_INVALID');
  if (unit.profile === 'node-package-v1' && (inputs.packageManager !== 'npm' || !idPattern.test(String(inputs.buildTask)))) buildFail('RN_BUILD_INVALID');
  if (unit.profile === 'custom-adapter-v1' && (!String(inputs.entrypoint).startsWith('tools/') || !['pwsh', 'node', 'bash'].includes(String(inputs.runtime)) || !['windows', 'linux'].includes(String(inputs.runnerFamily)) || (inputs.runtime === 'bash' && inputs.runnerFamily !== 'linux'))) buildFail('RN_BUILD_INVALID');
  if (!Array.isArray(unit.outputs) || !unit.outputs.length || unit.outputs.length > buildLimits.maxFiles
    || unit.outputs.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))
    || new Set(unit.outputs.map(rule => rule.id)).size !== unit.outputs.length) buildFail('RN_BUILD_OUTPUT');
  for (const rule of unit.outputs) {
    exact(rule, unit.profile === 'oci-image-v1' ? ['id', 'kind', 'count'] : ['id', 'kind', 'match', 'count', 'mediaType']);
    if (typeof rule.id !== 'string' || !idPattern.test(rule.id) || !Number.isSafeInteger(rule.count) || rule.count < 1 || rule.count > buildLimits.maxFiles) buildFail('RN_BUILD_OUTPUT');
    if (unit.profile === 'oci-image-v1') { if (rule.kind !== 'oci-image' || rule.count !== 1) buildFail('RN_BUILD_OUTPUT'); }
    else {
      if (rule.kind !== 'file' || typeof rule.match !== 'string' || typeof rule.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(rule.mediaType)) buildFail('RN_BUILD_OUTPUT');
      assertBuildPath(rule.match, { glob: true, version: true });
      if (identity.version === null && rule.match.includes('{version}')) buildFail('RN_BUILD_VERSION');
      assertBuildPath(rule.match.replaceAll('{version}', identity.version ?? ''), { glob: true });
    }
  }
  const expandedIds = unit.outputs.flatMap(rule => Array.from({ length: rule.count }, (_, index) => rule.count === 1 ? rule.id : `${rule.id}-${index + 1}`));
  if (expandedIds.length > buildLimits.maxFiles || new Set(expandedIds).size !== expandedIds.length) buildFail('RN_BUILD_OUTPUT');
  const runner = unit.profile === 'dotnet-assets-v1' || (unit.profile === 'custom-adapter-v1' && inputs.runnerFamily === 'windows') ? 'windows-latest' : 'ubuntu-latest';
  const outputs = unit.outputs.map(rule => ({ ...rule }));
  return { ...identity, inputs, inputsSha256: await sha256Hex(`${JSON.stringify(inputs)}\n`), outputs, runner,
    timeoutMinutes: 45, permissions: { contents: 'read' }, environment: null, persistCredentials: false };
}
export function matchBuildFiles(plan: BuildPlan, files: readonly string[]): { id: string; file: string; mediaType: string }[] {
  if (!files.length || files.length > buildLimits.maxFiles || new Set(files.map(file => file.toLowerCase())).size !== files.length) buildFail('RN_BUILD_OUTPUT');
  files.forEach(file => assertBuildPath(file));
  const assigned = new Set<string>(); const ids = new Set<string>();
  const assets: { id: string; file: string; mediaType: string }[] = [];
  for (const rule of plan.outputs) {
    if (rule.kind !== 'file') buildFail('RN_BUILD_OUTPUT');
    const pattern = rule.match!.replaceAll('{version}', plan.version ?? '');
    const matched = files.filter(file => minimatch(file, pattern, { dot: true, nocase: false, nonegate: true, nocomment: true, noext: true, nobrace: true, noglobstar: false })).sort();
    if (matched.length !== rule.count) buildFail('RN_BUILD_OUTPUT');
    matched.forEach((file, index) => {
      const id = rule.count === 1 ? rule.id : `${rule.id}-${index + 1}`;
      if (assigned.has(file) || ids.has(id)) buildFail('RN_BUILD_OUTPUT');
      assigned.add(file); ids.add(id); assets.push({ id, file, mediaType: rule.mediaType! });
    });
  }
  if (assigned.size !== files.length) buildFail('RN_BUILD_OUTPUT');
  return assets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function checkBuildNativeVersion(plan: BuildPlan, native: string | null): void {
  if (plan.version === null) return;
  if (native === null) buildFail('RN_BUILD_VERSION');
  try { assertNativeVersion(parsePublicVersion(plan.version), native); } catch { buildFail('RN_BUILD_VERSION'); }
}
export function canonicalBuildManifest(manifest: BuildManifest): string {
  exact(manifest, ['schemaVersion', 'repositoryId', 'fullName', 'buildId', 'profile', 'targetSha', 'policySha', 'version', 'inputsSha256', 'artifacts']);
  assertBuildIdentity(manifest);
  if (manifest.schemaVersion !== 1 || typeof manifest.inputsSha256 !== 'string' || !digestPattern.test(manifest.inputsSha256) || manifest.inputsSha256.length !== 64 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > buildLimits.maxFiles) buildFail('RN_BUILD_INVALID');
  const ids = new Set<string>(); const filenames = new Set<string>();
  let total = 0;
  const artifacts = Array.from(manifest.artifacts, asset => {
    if (!asset || typeof asset !== 'object') buildFail('RN_BUILD_INVALID');
    if (typeof asset.id !== 'string' || !idPattern.test(asset.id) || ids.has(asset.id)) buildFail('RN_BUILD_OUTPUT');
    ids.add(asset.id);
    if (asset.kind === 'file') {
      exact(asset, ['id', 'kind', 'file', 'mediaType', 'size', 'sha256']); assertBuildPath(asset.file);
      if (manifest.profile === 'oci-image-v1' || filenames.has(asset.file.toLowerCase()) || typeof asset.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(asset.mediaType) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > buildLimits.maxFileBytes || typeof asset.sha256 !== 'string' || !digestPattern.test(asset.sha256) || asset.sha256.length !== 64) buildFail('RN_BUILD_OUTPUT');
      filenames.add(asset.file.toLowerCase()); total += asset.size;
      return { id: asset.id, kind: asset.kind, file: asset.file, mediaType: asset.mediaType, size: asset.size, sha256: asset.sha256 };
    }
    exact(asset, ['id', 'kind', 'reference', 'digest']);
    if (asset.kind !== 'oci-image' || manifest.profile !== 'oci-image-v1' || typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) || asset.digest.length !== 71 || typeof asset.reference !== 'string' || !validOciReference(asset.reference, asset.digest)) buildFail('RN_BUILD_OUTPUT');
    return { id: asset.id, kind: asset.kind, reference: asset.reference, digest: asset.digest };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (total > buildLimits.maxTotalBytes) buildFail('RN_BUILD_LIMIT');
  const serialized = `${JSON.stringify({ schemaVersion: 1, repositoryId: manifest.repositoryId, fullName: manifest.fullName, buildId: manifest.buildId,
    profile: manifest.profile, targetSha: manifest.targetSha, policySha: manifest.policySha, version: manifest.version, inputsSha256: manifest.inputsSha256, artifacts })}\n`;
  if (new TextEncoder().encode(serialized).byteLength > 512 * 1024) buildFail('RN_BUILD_LIMIT');
  return serialized;
}
export function parseBuildManifest(bytes: Uint8Array): BuildManifest {
  const value = decodeBuildJson(bytes);
  try {
    canonicalBuildManifest(value as BuildManifest);
    return value as BuildManifest;
  } catch (error) {
    if (error instanceof BuildContractError) throw error;
    return buildFail('RN_BUILD_INVALID');
  }
}
export function deliveryBuildReadiness(configuration: DeliveryConfiguration, successfulBuilds: readonly string[]): { githubRelease: 'disabled' | 'ready' | 'blocked'; deployments: Record<string, 'ready' | 'blocked'>; packages: Record<string, 'ready' | 'blocked'> } {
  selectDeliveryBuilds(configuration);
  if (new Set(successfulBuilds).size !== successfulBuilds.length || successfulBuilds.some(id => !Object.hasOwn(configuration.builds, id))) buildFail('RN_BUILD_INVALID');
  const successful = new Set(successfulBuilds);
  const ready = (ids: readonly string[]) => ids.every(id => successful.has(id)) ? 'ready' as const : 'blocked' as const;
  const release = configuration.delivery.githubRelease;
  const githubRelease = release.enabled && release.state === 'active' ? ready(release.builds) : 'disabled';
  return { githubRelease,
    deployments: Object.fromEntries(configuration.delivery.deployments.filter(entry => entry.state === 'active').map(entry => [entry.id, entry.source === 'github-release' && githubRelease !== 'ready' ? 'blocked' : ready(entry.builds)])),
    packages: Object.fromEntries(configuration.delivery.packages.filter(entry => entry.state === 'active').map(entry => [entry.id, ready(entry.builds)])) };
}
export function selectDeliveryBuilds(configuration: DeliveryConfiguration): string[] {
  const release = configuration.delivery.githubRelease;
  const references = [
    ...(release.enabled && release.state === 'active' ? release.builds : []),
    ...configuration.delivery.deployments.filter(entry => entry.state === 'active').flatMap(entry => entry.builds),
    ...configuration.delivery.packages.filter(entry => entry.state === 'active').flatMap(entry => entry.builds),
  ];
  if (references.some(id => !Object.hasOwn(configuration.builds, id))) buildFail('RN_BUILD_INVALID');
  return [...new Set(references)];
}
