import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_PATH,
  ManifestValidationError,
  canonicalManifestJson,
  decodeBase64Utf8,
  encodeBase64Utf8,
  loadDefaultBranchManifest,
  manifestDigest,
  normalizeManifest,
  parseManifest,
  sha256HexUtf8,
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
    expect(() => parseManifest({ ...manifest(), webhookSecret: 'not-allowed' })).toThrow('unknown property "webhookSecret"');
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

  it('rejects incomplete and duplicate classification decision mappings', () => {
    const missingDecisions = structuredClone(cadFontClassification) as unknown as Record<string, unknown>;
    delete missingDecisions.decisions;
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: missingDecisions as unknown as ClassificationConfiguration,
    }))).toThrow('missing required property "decisions"');

    const duplicateType = structuredClone(cadFontClassification);
    duplicateType.decisions.kinds.byConventionalType.push({ type: 'FEAT', kind: 'kind:other' });
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: duplicateType,
    }))).toThrow(/duplicate types: FEAT/);
  });

  it('rejects dangling decision references and unusable conditions', () => {
    const dangling = structuredClone(cadFontClassification);
    dangling.decisions.publicLabels.rules[0] = {
      label: 'missing-label',
      whenAny: {
        kinds: ['kind:missing'],
        areas: ['area:missing'],
        conventionalTypes: ['missing-type'],
      },
    };
    dangling.decisions.publicLabels.fallbackByKind[0] = {
      kind: 'kind:missing',
      label: 'missing-label',
    };
    dangling.decisions.publicLabels.fallback = 'missing-label';
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: dangling,
    }))).toThrow(/unknown public label/);

    const emptyCondition = structuredClone(cadFontClassification);
    emptyCondition.decisions.publicLabels.rules[0] = {
      label: 'documentation',
      whenAny: { kinds: [] },
    };
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: emptyCondition,
    }))).toThrow(/non-empty condition/);
  });

  it('rejects empty docs-only rules', () => {
    const invalid = structuredClone(cadFontClassification);
    invalid.decisions.kinds.docsOnly.pathRules[0] = { prefixes: [] };
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: invalid,
    }))).toThrow(/non-empty include condition/);
  });

  it('rejects duplicate release mappings and invalid regular expressions', () => {
    const duplicateRelease = structuredClone(cadFontClassification);
    duplicateRelease.releaseCategories.push(structuredClone(duplicateRelease.releaseCategories[0]!));
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: duplicateRelease,
    }))).toThrow(/duplicate release labels/);

    const invalidPattern = structuredClone(cadFontClassification);
    invalidPattern.releaseCategories[0]!.textPatterns.push('[');
    expect(() => parseManifest(manifest({
      features: features({ classification: true }),
      classification: invalidPattern,
    }))).toThrow(/invalid text pattern/);
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

  it('produces the same digest for equivalent key and login ordering', async () => {
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
    const [leftDigest, rightDigest] = await Promise.all([manifestDigest(left), manifestDigest(right)]);
    expect(leftDigest).toBe(rightDigest);
    expect(leftDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the minimal Manifest digest protocol stable', async () => {
    expect(await manifestDigest(manifest())).toBe('a11460bf88e95e41420062d58e514737dc884b2ea4d32d1e203021787ad8dbfe');
  });
});

describe('Portable text encoding and digests', () => {
  it('uses the standard Web Crypto SHA-256 UTF-8 contract', async () => {
    expect(await sha256HexUtf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256HexUtf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256HexUtf8('叠境 LayerScape 🧰')).toBe('09c1c87bfbcd7d312ebbd829a4082b11a151874755d5a7fb432a902aa5193307');
    expect(await sha256HexUtf8('é')).not.toBe(await sha256HexUtf8('e\u0301'));
  });

  it('round-trips UTF-8 text with standard padded base64', () => {
    expect(encodeBase64Utf8('叠境 LayerScape 🧰')).toBe('5Y+g5aKDIExheWVyU2NhcGUg8J+nsA==');
    for (const value of ['', '叠境 LayerScape 🧰', '界'.repeat(20_000)]) {
      const encoded = encodeBase64Utf8(value);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(decodeBase64Utf8(encoded)).toBe(value);
      expect(decodeBase64Utf8(encoded.replace(/.{48}/g, '$&\n'))).toBe(value);
    }
  });

  it('rejects invalid base64 padding bits and invalid UTF-8', () => {
    expect(() => decodeBase64Utf8('Zh==')).toThrow('Invalid base64 text');
    expect(() => decodeBase64Utf8('Zm9=')).toThrow('Invalid base64 text');
    expect(() => decodeBase64Utf8('Zg')).toThrow('Invalid base64 text');
    expect(decodeBase64Utf8('Zg', { allowUnpadded: true })).toBe('f');
    expect(() => decodeBase64Utf8('8J-nsA==')).toThrow('Invalid base64 text');
    expect(decodeBase64Utf8('8J-nsA==', { allowUrlSafe: true })).toBe('🧰');
    expect(() => decodeBase64Utf8('/w==')).toThrow('Invalid UTF-8 text');
    expect(decodeBase64Utf8('77u/e30=')).toBe('\uFEFF{}');
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
    expect(loaded.configDigest).toBe(await manifestDigest(manifest()));
  });

  it('rejects invalid JSON, invalid base64, and repositories without a default branch', async () => {
    const client = (defaultBranch: string, content: string): ManifestRepositoryClient => ({
      getRepository: async () => ({ defaultBranch }),
      getFile: async () => ({ type: 'file', encoding: 'base64', content, sha: 'blob-sha' }),
    });
    await expect(loadDefaultBranchManifest(client('', 'e30='), 'splrad', 'empty')).rejects.toThrow('no default branch');
    await expect(loadDefaultBranchManifest(client('main', 'not base64'), 'splrad', 'invalid')).rejects.toThrow('invalid base64');
    await expect(loadDefaultBranchManifest(client('main', 'Zh=='), 'splrad', 'invalid')).rejects.toThrow('invalid base64 or UTF-8');
    await expect(loadDefaultBranchManifest(client('main', '/w=='), 'splrad', 'invalid')).rejects.toThrow('invalid base64 or UTF-8');
    await expect(loadDefaultBranchManifest(client('main', Buffer.from('{').toString('base64')), 'splrad', 'invalid')).rejects.toThrow('not valid JSON');
    await expect(loadDefaultBranchManifest(client('main', '77u/e30='), 'splrad', 'invalid')).rejects.toThrow('not valid JSON');
  });

  it('rejects directory and incomplete GitHub content responses', async () => {
    const client: ManifestRepositoryClient = {
      getRepository: async () => ({ defaultBranch: 'main' }),
      getFile: async () => ({ type: 'dir' }),
    };
    await expect(loadDefaultBranchManifest(client, 'splrad', 'invalid')).rejects.toThrow('invalid Steward manifest file response');
  });
});
