import { digestCanonicalManifestJson } from './digest.js';
import { decodeBase64Utf8 } from './encoding.js';
import { canonicalManifestJson, normalizeManifest } from './normalize.js';
import { parseManifest } from './schema.js';
import { MANIFEST_PATH, type StewardManifest } from './types.js';

export interface RepositoryMetadata {
  defaultBranch: string | null;
}

export interface RepositoryFile {
  type: string;
  encoding?: string;
  content?: string;
  sha?: string;
}

export interface ManifestRepositoryClient<TMetadata extends RepositoryMetadata = RepositoryMetadata> {
  getRepository(owner: string, repository: string): Promise<TMetadata>;
  getFile(owner: string, repository: string, path: string, ref: string): Promise<RepositoryFile>;
}

export interface LoadedManifest {
  manifest: StewardManifest;
  canonicalJson: string;
  configDigest: string;
  source: {
    path: typeof MANIFEST_PATH;
    ref: string;
    blobSha: string;
  };
}

export interface DefaultBranchManifestBinding<TMetadata extends RepositoryMetadata = RepositoryMetadata> {
  repository: TMetadata;
  loadManifest(): Promise<LoadedManifest>;
}

function assertLoadedManifestSource(source: LoadedManifest['source']): void {
  if (!source || typeof source !== 'object') throw new Error('Steward manifest source is invalid');
  if (source.path !== MANIFEST_PATH) throw new Error(`Steward manifest source path must be ${MANIFEST_PATH}`);
  if (typeof source.ref !== 'string' || !source.ref.trim() || source.ref !== source.ref.trim()) {
    throw new Error('Steward manifest source requires a ref without surrounding whitespace');
  }
  if (typeof source.blobSha !== 'string' || !source.blobSha.trim() || source.blobSha !== source.blobSha.trim()) {
    throw new Error('Steward manifest source requires a blob SHA without surrounding whitespace');
  }
}

function decodeBase64(content: string): string {
  try {
    return decodeBase64Utf8(content);
  } catch {
    throw new Error('GitHub returned invalid base64 or UTF-8 manifest content');
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Steward manifest is not valid JSON: ${detail}`);
  }
}

export async function verifyLoadedManifest(loaded: LoadedManifest): Promise<LoadedManifest> {
  assertLoadedManifestSource(loaded.source);
  const canonicalManifest = normalizeManifest(parseManifest(parseJson(loaded.canonicalJson)));
  const canonicalJson = canonicalManifestJson(canonicalManifest);
  if (loaded.canonicalJson !== canonicalJson) {
    throw new Error('Steward manifest canonical JSON is not normalized');
  }
  const objectManifest = normalizeManifest(parseManifest(structuredClone(loaded.manifest)));
  if (canonicalManifestJson(objectManifest) !== canonicalJson) {
    throw new Error('Steward manifest object does not match its canonical JSON');
  }
  const configDigest = await digestCanonicalManifestJson(canonicalJson);
  if (!/^[a-f0-9]{64}$/i.test(loaded.configDigest) || loaded.configDigest.toLowerCase() !== configDigest) {
    throw new Error('Steward manifest config digest does not match its canonical JSON');
  }
  return {
    manifest: canonicalManifest,
    canonicalJson,
    configDigest,
    source: { ...loaded.source },
  };
}

async function loadManifestAtRef(
  client: Pick<ManifestRepositoryClient, 'getFile'>,
  owner: string,
  repository: string,
  ref: string,
): Promise<LoadedManifest> {
  if (!ref.trim() || ref !== ref.trim()) throw new Error('Steward manifest load requires a ref');
  const file = await client.getFile(owner, repository, MANIFEST_PATH, ref);
  if (file.type !== 'file' || file.encoding !== 'base64' || !file.content || !file.sha) {
    throw new Error('GitHub returned an invalid Steward manifest file response');
  }
  const manifest = normalizeManifest(parseManifest(parseJson(decodeBase64(file.content))));
  const canonicalJson = canonicalManifestJson(manifest);
  return await verifyLoadedManifest({
    manifest,
    canonicalJson,
    configDigest: await digestCanonicalManifestJson(canonicalJson),
    source: {
      path: MANIFEST_PATH,
      ref,
      blobSha: file.sha,
    },
  });
}

export async function loadDefaultBranchManifest(
  client: ManifestRepositoryClient,
  owner: string,
  repository: string,
): Promise<LoadedManifest> {
  return (await loadDefaultBranchManifestContext(client, owner, repository)).manifest;
}

export async function loadDefaultBranchManifestContext<TMetadata extends RepositoryMetadata>(
  client: ManifestRepositoryClient<TMetadata>,
  owner: string,
  repository: string,
): Promise<{ repository: TMetadata; manifest: LoadedManifest }> {
  const binding = await bindDefaultBranchManifest(client, owner, repository);
  return {
    repository: binding.repository,
    manifest: await binding.loadManifest(),
  };
}

export async function bindDefaultBranchManifest<TMetadata extends RepositoryMetadata>(
  client: ManifestRepositoryClient<TMetadata>,
  owner: string,
  repository: string,
): Promise<DefaultBranchManifestBinding<TMetadata>> {
  const metadata = await client.getRepository(owner, repository);
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch) throw new Error('GitHub repository has no default branch');
  if (defaultBranch !== defaultBranch.trim()) {
    throw new Error('GitHub repository default branch must not contain surrounding whitespace');
  }
  return {
    repository: metadata,
    loadManifest: async () => await loadManifestAtRef(client, owner, repository, defaultBranch),
  };
}
