import { digestCanonicalManifestJson } from './digest.js';
import { decodeBase64Utf8 } from './encoding.js';
import { normalizeManifest } from './normalize.js';
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

export interface ManifestRepositoryClient {
  getRepository(owner: string, repository: string): Promise<RepositoryMetadata>;
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

export async function loadDefaultBranchManifest(
  client: ManifestRepositoryClient,
  owner: string,
  repository: string,
): Promise<LoadedManifest> {
  const metadata = await client.getRepository(owner, repository);
  if (!metadata.defaultBranch) throw new Error('GitHub repository has no default branch');

  const file = await client.getFile(owner, repository, MANIFEST_PATH, metadata.defaultBranch);
  if (file.type !== 'file' || file.encoding !== 'base64' || !file.content || !file.sha) {
    throw new Error('GitHub returned an invalid Steward manifest file response');
  }
  const manifest = normalizeManifest(parseManifest(parseJson(decodeBase64(file.content))));
  const canonicalJson = JSON.stringify(manifest);
  return {
    manifest,
    canonicalJson,
    configDigest: await digestCanonicalManifestJson(canonicalJson),
    source: {
      path: MANIFEST_PATH,
      ref: metadata.defaultBranch,
      blobSha: file.sha,
    },
  };
}
