import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { centralBuildClient, dispatchReleaseBuild } from '../src/release-build-api.js';
import { dispatchMigrationBuild } from '../src/release-migration-dispatch.js';
import { legacyReleaseRetired, assertLegacyReleaseDispatchActive } from '../src/release-retirement.js';

const env = (): Env => ({ LEGACY_RELEASE_RETIRED: 'true', ORGANIZATION_ID: '302208797', ORGANIZATION_LOGIN: 'splrad', APP_ID: '4243096', INSTALLATION_ID: '145952003', STEWARDSHIP_REPOSITORY: 'splrad/steward', POLICY_SHA: 'a'.repeat(40), ISSUE_SNAPSHOTS: { prepare() { throw new Error('unexpected D1 access'); } } as unknown as D1Database });
afterEach(() => { vi.unstubAllGlobals(); });
describe('scoped legacy release retirement', () => {
  it('blocks only release workflow dispatch at both caller boundaries', () => {
    for (const workflow of ['release.yml', 'release-build.yml', 'release-build-complete.yml']) {
      expect(() => assertLegacyReleaseDispatchActive(env(), workflow)).toThrow('LEGACY_RELEASE_RETIRED');
      expect(() => assertLegacyReleaseDispatchActive({}, workflow)).not.toThrow();
    }
    expect(() => assertLegacyReleaseDispatchActive(env(), 'onboard-repository.yml')).not.toThrow();
  });
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s before storage, authentication or network', async method => {
    const network = vi.fn(() => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', network);
    for (const path of ['v1.2.3', 'v1.2.3/permit', 'v1.2.3/operation', 'v1.2.3/generation', 'v1.2.3/generation-graph', 'v1.2.3/build', 'v1.2.3/migrate-policy', 'objects/abc/0']) {
      for (const token of ['', 'Bearer release-generation.fixture', 'Bearer release-generation-graph.fixture']) {
        const response = await worker.fetch(new Request('https://runtime.test/internal/releases/1187527897/' + path, { method, headers: { authorization: token } }), env());
        expect(response.status).toBe(410); expect(await response.json()).toEqual({ error: 'LEGACY_RELEASE_RETIRED' });
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('blocks build and migration dispatch before minting a write token or reserving D1', async () => {
    const network = vi.fn(() => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', network);
    await expect(centralBuildClient(env(), true)).rejects.toThrow('LEGACY_RELEASE_RETIRED');
    await expect(dispatchReleaseBuild(env(), 1187527897, 'v1.2.3', 'fixture')).rejects.toThrow('LEGACY_RELEASE_RETIRED');
    await expect(dispatchMigrationBuild(env(), { repositoryId: '1187527897' })).rejects.toThrow('LEGACY_RELEASE_RETIRED');
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps health and unrelated route behavior', async () => {
    expect((await worker.fetch(new Request('https://runtime.test/health'), env())).status).toBe(200);
    expect((await worker.fetch(new Request('https://runtime.test/unrelated'), env())).status).toBe(404);
  });
  it('preserves the historical contract when the switch is absent or explicitly false', () => {
    expect(legacyReleaseRetired({})).toBe(false);
    expect(legacyReleaseRetired({ LEGACY_RELEASE_RETIRED: 'false' })).toBe(false);
  });
});
