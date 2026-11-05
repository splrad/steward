import { minimatch } from 'minimatch';
import { assertDeliveryPath } from './delivery-config.js';
import { parsePublicVersion } from './release-version.js';

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
export interface BuildOutputRule { id: string; kind: 'file' | 'oci-image'; match?: string; count: number; mediaType?: string; archiveType?: 'dll-archive' | 'font-archive' }
/** Source and materialized artifact expectations; execution belongs to product YAML. */
export interface BuildSource {
  repositoryId: number; fullName: string; buildId: string; kind: 'file' | 'oci-image';
  sourceSha: string; controllerSha: string; version: string | null; packageVersion: string | null; inputsSha256: string;
}
export interface BuildArtifactInput extends BuildSource { outputs: BuildOutputRule[]; platforms: string[] }
export interface BuildArtifactEvidence extends BuildSource { artifacts: BuildArtifact[] }
export interface FileArtifact { id: string; kind: 'file'; file: string; mediaType: string; size: number; sha256: string }
export interface ImageArtifact { id: string; kind: 'oci-image'; reference: string; digest: string }
export type BuildArtifact = FileArtifact | ImageArtifact;
export interface BuildManifest extends BuildIdentity { schemaVersion: 1; inputsSha256: string; artifacts: BuildArtifact[] }
export const buildLimits = { maxFiles: 128, maxNativeVersionBytes: 32 * 1024 * 1024, maxFileBytes: 1024 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 } as const;
const idPattern = /^[a-z][a-z0-9-]*$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const ociPathComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const ociDomainComponent = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ociRemoteName = `${ociPathComponent}(?:/${ociPathComponent})*`;
const ociHost = `(?:${ociDomainComponent}(?:\\.${ociDomainComponent})*|\\[[a-fA-F0-9:]+\\])`;
const ociName = `(?:${ociHost}(?::[0-9]+)?/)?${ociRemoteName}`;
const ociRepositoryPattern = new RegExp(`^(?:${ociHost}(?::[0-9]+)?/)?(${ociRemoteName})$`, 'u');
const ociReferencePattern = new RegExp(`^(${ociName})(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`, 'u');
function validOciRepository(repository: string): boolean {
  const match = ociRepositoryPattern.exec(repository);
  return match !== null && match[1]!.length <= 255;
}
export function assertBuildOciRepository(repository: string): void {
  if (typeof repository !== 'string' || !validOciRepository(repository)) buildFail('RN_BUILD_INVALID');
}
function validOciReference(reference: string, digest: string): boolean {
  const match = ociReferencePattern.exec(reference);
  return match !== null && validOciRepository(match[1]!) && reference.endsWith(`@${digest}`);
}
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
}
export function assertBuildPath(path: string, options: { glob?: boolean; root?: boolean; version?: boolean } = {}): void {
  if (typeof path !== 'string') buildFail('RN_BUILD_PATH');
  try { assertDeliveryPath(path, options); } catch { buildFail('RN_BUILD_PATH'); }
  // Windows devices and alternate streams cannot form portable artifacts.
  if (path !== '.' && path.split('/').some(part => /[<>"|]/u.test(part) || /[ .]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) buildFail('RN_BUILD_PATH');
}
function assertBuildSource(input: BuildSource): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
    || typeof input.fullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$(?![\s\S])/.test(input.fullName)
    || input.fullName.split('/').some(part => part === '.' || part === '..') || typeof input.buildId !== 'string' || !/^[a-z][a-z0-9-]*$(?![\s\S])/u.test(input.buildId)
    || !['file', 'oci-image'].includes(input.kind) || ![input.sourceSha, input.controllerSha].every(value => typeof value === 'string' && /^[a-f0-9]{40}$(?![\s\S])/.test(value))
    || typeof input.inputsSha256 !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(input.inputsSha256)
    || ![input.version, input.packageVersion].every(value => value === null || typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+-]*$(?![\s\S])/.test(value))
    || (input.version === null) !== (input.packageVersion === null)) buildFail('RN_BUILD_INVALID');
}
const sourceFields = ['repositoryId', 'fullName', 'buildId', 'kind', 'sourceSha', 'controllerSha', 'version', 'packageVersion', 'inputsSha256'];
/** Validate finite data and copy it before any asynchronous file inspection. */
export function parseBuildArtifactInput(value: unknown): BuildArtifactInput {
  exact(value as object, [...sourceFields, 'outputs', 'platforms']);
  const input = value as BuildArtifactInput;
  assertBuildSource(input);
  if (!Array.isArray(input.platforms) || (input.kind === 'file' ? input.platforms.length !== 0 : !input.platforms.length)
    || Array.from(input.platforms).some(platform => typeof platform !== 'string' || !/^linux\/(?:amd64|arm64)$(?![\s\S])/.test(platform))
    || new Set(input.platforms).size !== input.platforms.length) buildFail('RN_BUILD_INVALID');
  if (!Array.isArray(input.outputs) || !input.outputs.length || input.outputs.length > buildLimits.maxFiles
    || Array.from(input.outputs).some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))
    || new Set(input.outputs.map(rule => rule.id)).size !== input.outputs.length) buildFail('RN_BUILD_OUTPUT');
  for (const rule of input.outputs) {
    exact(rule, input.kind === 'oci-image' ? ['id', 'kind', 'count'] : ['id', 'kind', 'match', 'count', 'mediaType', ...(rule.archiveType === undefined ? [] : ['archiveType'])]);
    if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]*$(?![\s\S])/u.test(rule.id) || rule.kind !== input.kind || !Number.isSafeInteger(rule.count)
      || rule.count < 1 || rule.count > buildLimits.maxFiles) buildFail('RN_BUILD_OUTPUT');
    if (input.kind === 'oci-image') { if (rule.count !== 1) buildFail('RN_BUILD_OUTPUT'); }
    else {
      if (typeof rule.match !== 'string' || typeof rule.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$(?![\s\S])/.test(rule.mediaType)) buildFail('RN_BUILD_OUTPUT');
      if (rule.archiveType !== undefined && (!['dll-archive', 'font-archive'].includes(rule.archiveType) || !rule.match.endsWith('.zip') || rule.mediaType !== 'application/zip')) buildFail('RN_BUILD_OUTPUT');
      if (rule.archiveType === 'font-archive' && (rule.count !== 1 || /[{}*?\[\]]/.test(rule.match))) buildFail('RN_BUILD_OUTPUT');
      assertBuildPath(rule.match, { glob: true, version: true });
      if (input.version === null && rule.match.includes('{version}')) buildFail('RN_BUILD_VERSION');
      assertBuildPath(rule.match.replaceAll('{version}', input.version ?? ''), { glob: true });
    }
  }
  const ids = input.outputs.flatMap(rule => Array.from({ length: rule.count }, (_, index) => rule.count === 1 ? rule.id : `${rule.id}-${index + 1}`));
  if (ids.length > buildLimits.maxFiles || new Set(ids).size !== ids.length) buildFail('RN_BUILD_OUTPUT');
  return structuredClone(input);
}
export function matchBuildFiles(plan: BuildArtifactInput, files: readonly string[]): { id: string; file: string; mediaType: string }[] {
  plan = parseBuildArtifactInput(plan);
  if (!Array.isArray(files) || !files.length || files.length > buildLimits.maxFiles) buildFail('RN_BUILD_OUTPUT');
  for (const file of files) if (typeof file !== 'string') buildFail('RN_BUILD_OUTPUT');
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) buildFail('RN_BUILD_OUTPUT');
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
export function checkBuildNativeVersion(source: Pick<BuildSource, 'packageVersion'>, native: string | null): void {
  if (source.packageVersion === null) return;
  if (typeof native !== 'string' || native !== source.packageVersion) buildFail('RN_BUILD_VERSION');
}
function canonicalArtifacts(kind: BuildSource['kind'], values: BuildArtifact[]) {
  if (!Array.isArray(values) || !values.length || values.length > buildLimits.maxFiles) buildFail('RN_BUILD_INVALID');
  const ids = new Set<string>(); const filenames = new Set<string>();
  let total = 0;
  const artifacts = Array.from(values, asset => {
    if (!asset || typeof asset !== 'object') buildFail('RN_BUILD_INVALID');
    if (typeof asset.id !== 'string' || !idPattern.test(asset.id) || ids.has(asset.id)) buildFail('RN_BUILD_OUTPUT');
    ids.add(asset.id);
    if (asset.kind === 'file') {
      exact(asset, ['id', 'kind', 'file', 'mediaType', 'size', 'sha256']); assertBuildPath(asset.file);
      if (kind === 'oci-image' || filenames.has(asset.file.toLowerCase()) || typeof asset.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(asset.mediaType) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > buildLimits.maxFileBytes || typeof asset.sha256 !== 'string' || !digestPattern.test(asset.sha256) || asset.sha256.length !== 64) buildFail('RN_BUILD_OUTPUT');
      filenames.add(asset.file.toLowerCase()); total += asset.size;
      return { id: asset.id, kind: asset.kind, file: asset.file, mediaType: asset.mediaType, size: asset.size, sha256: asset.sha256 };
    }
    exact(asset, ['id', 'kind', 'reference', 'digest']);
    if (asset.kind !== 'oci-image' || kind !== 'oci-image' || typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) || asset.digest.length !== 71 || typeof asset.reference !== 'string' || !validOciReference(asset.reference, asset.digest)) buildFail('RN_BUILD_OUTPUT');
    return { id: asset.id, kind: asset.kind, reference: asset.reference, digest: asset.digest };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (total > buildLimits.maxTotalBytes) buildFail('RN_BUILD_LIMIT');
  return artifacts;
}
export function canonicalBuildEvidence(evidence: BuildArtifactEvidence): string {
  exact(evidence, [...sourceFields, 'artifacts']); assertBuildSource(evidence);
  const artifacts = canonicalArtifacts(evidence.kind, evidence.artifacts);
  const serialized = `${JSON.stringify({ repositoryId: evidence.repositoryId, fullName: evidence.fullName, buildId: evidence.buildId,
    kind: evidence.kind, sourceSha: evidence.sourceSha, controllerSha: evidence.controllerSha, version: evidence.version,
    packageVersion: evidence.packageVersion, inputsSha256: evidence.inputsSha256, artifacts })}\n`;
  if (new TextEncoder().encode(serialized).byteLength > 512 * 1024) buildFail('RN_BUILD_LIMIT');
  return serialized;
}
/** Historical schema 1 bytes retain their original profile/policy fields and validation. */
export function canonicalBuildManifest(manifest: BuildManifest): string {
  exact(manifest, ['schemaVersion', 'repositoryId', 'fullName', 'buildId', 'profile', 'targetSha', 'policySha', 'version', 'inputsSha256', 'artifacts']);
  assertBuildIdentity(manifest);
  if (manifest.schemaVersion !== 1 || typeof manifest.inputsSha256 !== 'string' || !digestPattern.test(manifest.inputsSha256) || manifest.inputsSha256.length !== 64 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > buildLimits.maxFiles) buildFail('RN_BUILD_INVALID');
  const artifacts = canonicalArtifacts(manifest.profile === 'oci-image-v1' ? 'oci-image' : 'file', manifest.artifacts);
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
