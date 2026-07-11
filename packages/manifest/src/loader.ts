import { canonicalManifestJson, manifestDigest, normalizeManifest } from './normalize.js';
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
  const compact = content.replaceAll(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('GitHub returned invalid base64 manifest content');
  }
  return Buffer.from(compact, 'base64').toString('utf8');
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
  return {
    manifest,
    canonicalJson: canonicalManifestJson(manifest),
    configDigest: manifestDigest(manifest),
    source: {
      path: MANIFEST_PATH,
      ref: metadata.defaultBranch,
      blobSha: file.sha,
    },
  };
}
