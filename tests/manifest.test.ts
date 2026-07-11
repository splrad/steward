import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_PATH,
  ManifestValidationError,
  canonicalManifestJson,
  loadDefaultBranchManifest,
  manifestDigest,
  normalizeManifest,
  parseManifest,
  type ManifestRepositoryClient,
  type ClassificationConfiguration,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const cadFontClassification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function features(overrides: Partial<StewardManifest['features']> = {}): StewardManifest['features'] {
  return {
    prAutomation: false,
    classification: false,
    dcoAdvisory: false,
    governance: false,
    copilotReview: false,
    release: false,
    webhookRelay: false,
    ...overrides,
  };
}

function manifest(overrides: Partial<StewardManifest> = {}): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: {
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        slug: 'splrad-steward',
      },
      maintainers: {
        source: 'organization-team',
        teamSlug: 'maintainers',
      },
      language: 'zh-CN',
    },
    features: features(),
    ...overrides,
  };
}

describe('Manifest schema', () => {
  it('accepts the strict minimal manifest', () => {
    expect(parseManifest(manifest())).toEqual(manifest());
  });

  it('rejects unsupported versions and unknown secret-like fields', () => {
    expect(() => parseManifest({ ...manifest(), schemaVersion: 2 })).toThrow(ManifestValidationError);
    expect(() => parseManifest({ ...manifest(), webhookSecret: 'not-allowed' })).toThrow(/additional properties/);
  });

  it('requires a complete Steward SHA in the optional schema URL', () => {
    expect(() => parseManifest({ ...manifest(), $schema: 'https://raw.githubusercontent.com/splrad/steward/main/schema/steward.schema.json' })).toThrow();
    expect(parseManifest({
      ...manifest(),
      $schema: `https://raw.githubusercontent.com/splrad/steward/${'a'.repeat(40)}/schema/steward.schema.json`,
    }).$schema).toContain('a'.repeat(40));
  });

  it('requires enabled feature configuration and rejects disabled dead configuration', () => {
    expect(() => parseManifest({ ...manifest(), features: features({ classification: true }) })).toThrow();
    expect(() => parseManifest({ ...manifest(), classification: {} })).toThrow();
    expect(() => parseManifest({ ...manifest(), features: features({ release: true }) })).toThrow();
    expect(() => parseManifest({ ...manifest(), release: { triggerPaths: ['Version.props'], runner: 'windows-latest', adapterCommand: ['pwsh'] } })).toThrow();
  });

  it('rejects absolute, traversal, and backslash repository paths', () => {
    for (const triggerPath of ['/Version.props', '../Version.props', 'config/../Version.props', 'config\\Version.props']) {
      expect(() => parseManifest(manifest({
        features: features({ release: true }),
        release: { triggerPaths: [triggerPath], runner: 'windows-latest', adapterCommand: ['pwsh'] },
      }))).toThrow();
    }
  });

  it('supports organization teams and migration-period user lists', () => {
    expect(parseManifest(manifest()).automation.maintainers.source).toBe('organization-team');
    expect(parseManifest(manifest({
      automation: {
        ...manifest().automation,
        maintainers: { source: 'users', logins: ['Axiomoth'] },
      },
    })).automation.maintainers.source).toBe('users');
  });

  it('accepts the current CADFontAutoReplace classification policy without changing its content', () => {
    const configured = manifest({
      features: features({ classification: true }),
      classification: cadFontClassification,
    });
    const parsed = parseManifest(configured);
    expect(parsed.classification).toEqual(cadFontClassification);
    expect(normalizeManifest(parsed).classification).toEqual(cadFontClassification);
  });

  it('rejects inconsistent classification labels and fallback categories', () => {
    const invalid = structuredClone(cadFontClassification);
    invalid.labels.release.push('missing-public-label');
    invalid.releaseCategories.forEach((category) => { category.fallback = false; });
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: invalid,
    }))).toThrow(/exactly one fallback category/);
  });
});

describe('Manifest normalization', () => {
  it('sorts object keys and normalized user identities without reordering semantic arrays', () => {
    const input = manifest({
      automation: {
        ...manifest().automation,
        maintainers: { source: 'users', logins: ['Splrad-Bot', 'axiomoth', 'AXIOMOTH'] },
      },
    });
    const normalized = normalizeManifest(input);
    expect(normalized.automation.maintainers).toEqual({ source: 'users', logins: ['axiomoth', 'splrad-bot'] });
    expect(Object.keys(normalized)).toEqual(['automation', 'features', 'schemaVersion']);
  });

  it('produces the same digest for equivalent key and login ordering', () => {
    const left = manifest({
      automation: {
        ...manifest().automation,
        maintainers: { source: 'users', logins: ['B-User', 'a-user'] },
      },
    });
    const right = manifest({
      automation: {
        language: 'zh-CN',
        maintainers: { source: 'users', logins: ['A-USER', 'b-user'] },
        githubApp: { slug: 'splrad-steward', clientId: 'Iv23liuSr0qd4WLJdZhH' },
      },
    });
    expect(canonicalManifestJson(left)).toBe(canonicalManifestJson(right));
    expect(manifestDigest(left)).toBe(manifestDigest(right));
    expect(manifestDigest(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the minimal Manifest digest protocol stable', () => {
    expect(manifestDigest(manifest())).toBe('a11460bf88e95e41420062d58e514737dc884b2ea4d32d1e203021787ad8dbfe');
  });
});

describe('Default-branch manifest loader', () => {
  it('reads repository metadata first and only fetches the fixed path from the default branch', async () => {
    const calls: string[] = [];
    const content = Buffer.from(JSON.stringify(manifest())).toString('base64');
    const client: ManifestRepositoryClient = {
      getRepository: vi.fn(async (owner, repository) => {
        calls.push(`repository:${owner}/${repository}`);
        return { defaultBranch: 'stable' };
      }),
      getFile: vi.fn(async (owner, repository, path, ref) => {
        calls.push(`file:${owner}/${repository}:${path}@${ref}`);
        return { type: 'file' as const, encoding: 'base64' as const, content, sha: 'blob-sha' };
      }),
    };

    const loaded = await loadDefaultBranchManifest(client, 'splrad', 'steward-sandbox');
    expect(calls).toEqual([
      'repository:splrad/steward-sandbox',
      `file:splrad/steward-sandbox:${MANIFEST_PATH}@stable`,
    ]);
    expect(loaded.source).toEqual({ path: MANIFEST_PATH, ref: 'stable', blobSha: 'blob-sha' });
    expect(loaded.configDigest).toBe(manifestDigest(manifest()));
  });

  it('rejects invalid JSON, invalid base64, and repositories without a default branch', async () => {
    const client = (defaultBranch: string, content: string): ManifestRepositoryClient => ({
      getRepository: async () => ({ defaultBranch }),
      getFile: async () => ({ type: 'file', encoding: 'base64', content, sha: 'blob-sha' }),
    });
    await expect(loadDefaultBranchManifest(client('', 'e30='), 'splrad', 'empty')).rejects.toThrow('no default branch');
    await expect(loadDefaultBranchManifest(client('main', 'not base64'), 'splrad', 'invalid')).rejects.toThrow('invalid base64');
    await expect(loadDefaultBranchManifest(client('main', Buffer.from('{').toString('base64')), 'splrad', 'invalid')).rejects.toThrow('not valid JSON');
  });

  it('rejects directory and incomplete GitHub content responses', async () => {
    const client: ManifestRepositoryClient = {
      getRepository: async () => ({ defaultBranch: 'main' }),
      getFile: async () => ({ type: 'dir' }),
    };
    await expect(loadDefaultBranchManifest(client, 'splrad', 'invalid')).rejects.toThrow('invalid Steward manifest file response');
  });
});
