import { repositoryPathPatternMatches } from './fingerprint.js';

export const RELEASE_ADAPTER_CONTRACT_VERSION = 1 as const;

export class ReleaseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseContractError';
  }
}

export interface ReleaseAdapterContext {
  contractVersion: typeof RELEASE_ADAPTER_CONTRACT_VERSION;
  repository: {
    id: number;
    fullName: string;
  };
  pullRequest: {
    number: number;
    mergeSha: string;
  };
}

export interface ReleasePlan {
  contractVersion: typeof RELEASE_ADAPTER_CONTRACT_VERSION;
  displayVersion: string;
  buildId: string;
  tagName: string;
  releaseTitle: string;
}

export interface ReleaseAsset {
  path: string;
  name: string;
  mediaType: string;
  size?: number;
  sha256?: string;
}

export interface ReleaseAssetsManifest {
  contractVersion: typeof RELEASE_ADAPTER_CONTRACT_VERSION;
  assets: ReleaseAsset[];
}

export interface ReleaseOutputFile {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  sha256?: string;
}

export interface ReleaseTriggerDecision {
  state: 'ignored' | 'planned';
  reason: 'feature-disabled' | 'trigger-path-not-matched' | 'trigger-path-matched';
  matchedPaths: string[];
}

type JsonObject = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ReleaseContractError(`${path} ${message}`);
}

function object(value: unknown, path: string, allowed: readonly string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const result = value as JsonObject;
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(path, `contains unknown properties: ${unknown.sort().join(', ')}`);
  return result;
}

function contractVersion(value: unknown, path: string): typeof RELEASE_ADAPTER_CONTRACT_VERSION {
  if (value !== RELEASE_ADAPTER_CONTRACT_VERSION) {
    fail(path, `must equal ${RELEASE_ADAPTER_CONTRACT_VERSION}`);
  }
  return RELEASE_ADAPTER_CONTRACT_VERSION;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(path, 'must be a positive integer');
  return Number(value);
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(path, 'must be a non-empty string without surrounding whitespace');
  }
  if (value.length > maximum) fail(path, `must not exceed ${maximum} characters`);
  if (/\p{Cc}/u.test(value)) fail(path, 'must not contain control characters');
  return value;
}

function repositoryPath(value: unknown, path: string): string {
  const result = text(value, path, 1024);
  if (result.startsWith('/') || /^[A-Za-z]:/.test(result) || result.includes('\\')) {
    fail(path, 'must be a relative POSIX path');
  }
  const segments = result.split('/');
  if (segments.some((segment) => (
    !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')
  ))) {
    fail(path, 'contains an unsafe path segment');
  }
  return result;
}

function uploadName(value: unknown, path: string): string {
  const result = text(value, path, 255);
  if (result === '.' || result === '..' || /[\\/]/.test(result)) fail(path, 'must be a file name');
  return result;
}

function tagName(value: unknown, path: string): string {
  const result = text(value, path, 255);
  const segments = result.split('/');
  if (result === '@'
    || result.startsWith('/')
    || result.endsWith('/')
    || result.endsWith('.')
    || result.endsWith('.lock')
    || result.includes('..')
    || result.includes('@{')
    || segments.some((segment) => !segment || segment.startsWith('.'))
    || /[\s~^:?*[\\]/.test(result)) {
    fail(path, 'is not a safe Git tag name');
  }
  return result;
}

function optionalSize(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, path);
}

function optionalSha256(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail(path, 'must be a SHA-256 hex digest');
  return value.toLowerCase();
}

export function evaluateReleaseTrigger(input: {
  enabled: boolean;
  triggerPaths: readonly string[];
  changedFiles: readonly string[];
}): ReleaseTriggerDecision {
  if (!input.enabled) return { state: 'ignored', reason: 'feature-disabled', matchedPaths: [] };
  const matchedPaths = [...new Set(input.triggerPaths.filter((pattern) => (
    input.changedFiles.some((file) => repositoryPathPatternMatches(file, pattern))
  )))].sort();
  return matchedPaths.length
    ? { state: 'planned', reason: 'trigger-path-matched', matchedPaths }
    : { state: 'ignored', reason: 'trigger-path-not-matched', matchedPaths: [] };
}

export function parseReleaseAdapterContext(value: unknown): ReleaseAdapterContext {
  const root = object(value, '$', ['contractVersion', 'repository', 'pullRequest']);
  const version = contractVersion(root.contractVersion, '$.contractVersion');
  const repository = object(root.repository, '$.repository', ['id', 'fullName']);
  const pullRequest = object(root.pullRequest, '$.pullRequest', ['number', 'mergeSha']);
  const fullName = text(repository.fullName, '$.repository.fullName', 201);
  if (!/^[^\s/]+\/[^\s/]+$/.test(fullName)) fail('$.repository.fullName', 'must use owner/repository form');
  const mergeSha = text(pullRequest.mergeSha, '$.pullRequest.mergeSha', 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(mergeSha)) fail('$.pullRequest.mergeSha', 'must be a 40-character commit SHA');
  return {
    contractVersion: version,
    repository: {
      id: positiveInteger(repository.id, '$.repository.id'),
      fullName,
    },
    pullRequest: {
      number: positiveInteger(pullRequest.number, '$.pullRequest.number'),
      mergeSha,
    },
  };
}

export function parseReleasePlan(value: unknown): ReleasePlan {
  const root = object(value, '$', [
    'contractVersion', 'displayVersion', 'buildId', 'tagName', 'releaseTitle',
  ]);
  return {
    contractVersion: contractVersion(root.contractVersion, '$.contractVersion'),
    displayVersion: text(root.displayVersion, '$.displayVersion', 128),
    buildId: text(root.buildId, '$.buildId', 256),
    tagName: tagName(root.tagName, '$.tagName'),
    releaseTitle: text(root.releaseTitle, '$.releaseTitle', 256),
  };
}

export function parseReleaseAssetsManifest(
  value: unknown,
  outputFiles: readonly ReleaseOutputFile[],
): ReleaseAssetsManifest {
  const root = object(value, '$', ['contractVersion', 'assets']);
  contractVersion(root.contractVersion, '$.contractVersion');
  if (!Array.isArray(root.assets) || !root.assets.length) fail('$.assets', 'must be a non-empty array');
  const files = new Map<string, ReleaseOutputFile>();
  const foldedFilePaths = new Set<string>();
  for (const [index, candidate] of outputFiles.entries()) {
    const safePath = repositoryPath(candidate.path, `outputFiles[${index}].path`);
    const foldedPath = safePath.toLowerCase();
    if (files.has(safePath) || foldedFilePaths.has(foldedPath)) {
      fail('outputFiles', `contains duplicate path: ${safePath}`);
    }
    files.set(safePath, { ...candidate, path: safePath });
    foldedFilePaths.add(foldedPath);
  }
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const names = new Set<string>();
  const assets = root.assets.map((candidate, index): ReleaseAsset => {
    const path = `$.assets[${index}]`;
    const asset = object(candidate, path, ['path', 'name', 'mediaType', 'size', 'sha256']);
    const assetPath = repositoryPath(asset.path, `${path}.path`);
    const foldedPath = assetPath.toLowerCase();
    const name = uploadName(asset.name, `${path}.name`);
    const foldedName = name.toLowerCase();
    if (paths.has(assetPath) || foldedPaths.has(foldedPath)) fail(path, `duplicates asset path: ${assetPath}`);
    if (names.has(foldedName)) fail(path, `duplicates upload name: ${name}`);
    paths.add(assetPath);
    foldedPaths.add(foldedPath);
    names.add(foldedName);
    const file = files.get(assetPath);
    if (!file) fail(`${path}.path`, `does not exist in the output directory: ${assetPath}`);
    if (file.type !== 'file') fail(`${path}.path`, 'must reference a regular file');
    if (!Number.isSafeInteger(file.size) || file.size <= 0) fail(`${path}.path`, 'must reference a non-empty file');
    const size = optionalSize(asset.size, `${path}.size`);
    if (size !== undefined && size !== file.size) fail(`${path}.size`, 'does not match the output file');
    const sha256 = optionalSha256(asset.sha256, `${path}.sha256`);
    if (sha256 !== undefined && sha256 !== optionalSha256(file.sha256, `outputFiles[${index}].sha256`)) {
      fail(`${path}.sha256`, 'does not match the output file');
    }
    return {
      path: assetPath,
      name,
      mediaType: (() => {
        const mediaType = text(asset.mediaType, `${path}.mediaType`, 255);
        if (!/^[^\s/]+\/[^\s/]+$/.test(mediaType)) fail(`${path}.mediaType`, 'must be an Internet media type');
        return mediaType;
      })(),
      ...(size === undefined ? {} : { size }),
      ...(sha256 === undefined ? {} : { sha256 }),
    };
  });
  return {
    contractVersion: RELEASE_ADAPTER_CONTRACT_VERSION,
    assets: assets.sort((left, right) => left.path.localeCompare(right.path, 'en')),
  };
}
