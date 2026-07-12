import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_ADAPTER_CONTRACT_VERSION,
  ReleaseContractError,
  evaluateReleaseTrigger,
  evaluateReleasePublication,
  parseReleaseAdapterContext,
  parseReleaseAssetsManifest,
  parseReleasePlan,
  type ReleaseOutputFile,
} from '../packages/core/src/index.js';

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/release/${name}.json`, import.meta.url), 'utf8'));
}

const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const outputFiles: ReleaseOutputFile[] = [{
  path: 'packages/steward-sandbox-v1.2.3.zip',
  type: 'file',
  size: 42,
  sha256: digest,
}];

describe('Release adapter contract', () => {
  it('triggers only enabled exact repository paths', () => {
    expect(evaluateReleaseTrigger({
      enabled: false,
      triggerPaths: ['release/version.txt'],
      changedFiles: ['release/version.txt'],
    })).toEqual({ state: 'ignored', reason: 'feature-disabled', matchedPaths: [] });
    expect(evaluateReleaseTrigger({
      enabled: true,
      triggerPaths: ['release/version.txt'],
      changedFiles: ['docs/release.md'],
    })).toEqual({ state: 'ignored', reason: 'trigger-path-not-matched', matchedPaths: [] });
    expect(evaluateReleaseTrigger({
      enabled: true,
      triggerPaths: ['release/**/version.txt', 'package.json', 'release/**/version.txt'],
      changedFiles: ['src/index.ts', 'Release/sandbox/version.txt'],
    })).toEqual({ state: 'planned', reason: 'trigger-path-matched', matchedPaths: ['release/**/version.txt'] });
  });

  it('parses a strict versioned context bound to repository, PR, and merge SHA', async () => {
    const context = await fixture('context');
    expect(parseReleaseAdapterContext(context)).toEqual({
      contractVersion: RELEASE_ADAPTER_CONTRACT_VERSION,
      repository: { id: 1296725030, fullName: 'splrad/steward-sandbox' },
      pullRequest: { number: 14, mergeSha: '0123456789012345678901234567890123456789' },
    });
    expect(() => parseReleaseAdapterContext({
      ...(context as object),
      contractVersion: 2,
    })).toThrow(ReleaseContractError);
    expect(() => parseReleaseAdapterContext({
      ...(context as object),
      trusted: true,
    })).toThrow('unknown properties');
    expect(() => parseReleaseAdapterContext({
      contractVersion: 1,
      repository: { id: 1, fullName: 'not-a-repository' },
      pullRequest: { number: 1, mergeSha: 'a'.repeat(40) },
    })).toThrow('owner/repository');
  });

  it('parses only safe, complete plan output', async () => {
    const plan = await fixture('plan');
    expect(parseReleasePlan(plan)).toEqual(plan);
    for (const tagName of ['@', '../v1', 'refs//v1', 'v1.lock', 'v1~2', 'v1 2']) {
      expect(() => parseReleasePlan({ ...(plan as object), tagName })).toThrow('safe Git tag');
    }
    expect(() => parseReleasePlan({ ...(plan as object), releaseTitle: ' ' })).toThrow('non-empty string');
    expect(() => parseReleasePlan({ ...(plan as object), extra: true })).toThrow('unknown properties');
  });

  it('builds only when no tag/Release pair exists and skips an identical published Release', () => {
    const mergeSha = 'a'.repeat(40);
    expect(evaluateReleasePublication({ mergeSha, tagName: 'v1.2.3' }))
      .toEqual({ state: 'planned', reason: 'release-available' });
    expect(evaluateReleasePublication({
      mergeSha,
      tagName: 'v1.2.3',
      tagCommitSha: mergeSha,
      release: { id: 7, tagName: 'v1.2.3', draft: false },
    })).toEqual({ state: 'ignored', reason: 'already-published' });
  });

  it('fails closed for incomplete, draft, mismatched, or conflicting publication state', () => {
    const mergeSha = 'a'.repeat(40);
    const release = { id: 7, tagName: 'v1.2.3', draft: false };
    expect(() => evaluateReleasePublication({ mergeSha, tagName: 'v1.2.3', tagCommitSha: mergeSha }))
      .toThrow('incomplete existing tag/Release pair');
    expect(() => evaluateReleasePublication({ mergeSha, tagName: 'v1.2.3', release }))
      .toThrow('incomplete existing tag/Release pair');
    expect(() => evaluateReleasePublication({
      mergeSha, tagName: 'v1.2.3', tagCommitSha: mergeSha, release: { ...release, draft: true },
    })).toThrow('must be false');
    expect(() => evaluateReleasePublication({
      mergeSha, tagName: 'v1.2.3', tagCommitSha: 'b'.repeat(40), release,
    })).toThrow('does not target');
    expect(() => evaluateReleasePublication({
      mergeSha, tagName: 'v1.2.3', tagCommitSha: mergeSha, release: { ...release, tagName: 'v2.0.0' },
    })).toThrow('does not match');
  });

  it('accepts existing non-empty files and verifies declared size and checksum', async () => {
    expect(parseReleaseAssetsManifest(await fixture('assets'), outputFiles)).toEqual(await fixture('assets'));
  });

  it('rejects unsafe, missing, duplicate, empty, non-file, and mismatched assets', async () => {
    const manifest = await fixture('assets') as { contractVersion: number; assets: Record<string, unknown>[] };
    const withAsset = (asset: Record<string, unknown>) => ({
      ...manifest,
      assets: [{ ...manifest.assets[0], ...asset }],
    });
    for (const path of [
      '/absolute.zip', 'C:/absolute.zip', '../escape.zip', 'packages/../escape.zip',
      'packages\\asset.zip', './asset.zip', 'packages//asset.zip', 'packages/asset.', 'packages/asset /file.zip',
    ]) {
      expect(() => parseReleaseAssetsManifest(withAsset({ path }), outputFiles)).toThrow();
    }
    expect(() => parseReleaseAssetsManifest({ ...manifest, assets: [] }, outputFiles)).toThrow('non-empty array');
    expect(() => parseReleaseAssetsManifest(withAsset({ path: 'missing.zip' }), outputFiles)).toThrow('does not exist');
    expect(() => parseReleaseAssetsManifest(manifest, [{ ...outputFiles[0]!, size: 0 }])).toThrow('non-empty file');
    expect(() => parseReleaseAssetsManifest(manifest, [{ ...outputFiles[0]!, type: 'symlink' }])).toThrow('regular file');
    expect(() => parseReleaseAssetsManifest(withAsset({ size: 41 }), outputFiles)).toThrow('does not match');
    expect(() => parseReleaseAssetsManifest(withAsset({ sha256: 'f'.repeat(64) }), outputFiles)).toThrow('does not match');
    expect(() => parseReleaseAssetsManifest(manifest, [
      ...outputFiles,
      { ...outputFiles[0]!, path: 'PACKAGES/STEWARD-SANDBOX-V1.2.3.ZIP' },
    ])).toThrow('duplicate path');
    expect(() => parseReleaseAssetsManifest({
      ...manifest,
      assets: [manifest.assets[0], { ...manifest.assets[0], path: 'PACKAGES/STEWARD-SANDBOX-V1.2.3.ZIP' }],
    }, outputFiles))
      .toThrow('duplicates asset path');
    expect(() => parseReleaseAssetsManifest({
      ...manifest,
      assets: [manifest.assets[0], { ...manifest.assets[0], path: 'other.zip' }],
    }, [...outputFiles, { ...outputFiles[0]!, path: 'other.zip' }]))
      .toThrow('duplicates upload name');
  });
});
