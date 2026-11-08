import { describe, expect, it, vi } from 'vitest';
const modulePath = '../../../scripts/verify-legacy-runtime-retirement.mjs';
const { verifyLegacyRuntimeRetirement } = await import(modulePath);
const input = { url: 'https://runtime.test/', version: '11111111-1111-4111-8111-111111111111', policySha: 'a'.repeat(40), evaluatorSha: 'b'.repeat(40) };
const health = { status: 'ok', version: input.version, policySha: input.policySha, evaluatorSha: input.evaluatorSha, organizationId: 302208797, appId: 4243096, secretsReady: true };
describe('maintenance deployment retirement probe', () => {
  it.each([
    { ...input, url: 'https://runtime.test:8443/' },
    { ...input, version: 'a'.repeat(36) },
    { ...input, version: '-'.repeat(36) },
  ])('rejects malformed input before network: %j', async invalid => {
    const transport = vi.fn();
    await expect(verifyLegacyRuntimeRetirement(invalid, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('accepts reordered identity fields and unrelated health metadata', async () => {
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { note: 'additional metadata', ...Object.fromEntries(Object.entries(health).reverse()) })))
      .resolves.toMatchObject({ status: 'verified' });
  });
  it.each(['status', 'policySha', 'evaluatorSha', 'organizationId', 'appId', 'secretsReady'])('rejects changed required health field %s', async field => {
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { ...health, [field]: null }))).rejects.toThrow('changed during');
  });

  it('requires matching identity and effective unauthenticated retired route', async () => {
    const seen: string[] = [];
    const result = await verifyLegacyRuntimeRetirement(input, async (url: URL, init: RequestInit) => {
      seen.push(url.pathname); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return url.pathname === '/health' ? Response.json(health) : Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } });
    });
    expect(result.status).toBe('verified'); expect(seen).toHaveLength(3);
  });
  it.each([200, 401, 403, 404, 500])('rejects old route status %s even with healthy Worker', async status => {
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname === '/health' ? Response.json(health) : Response.json({}, { status }))).rejects.toThrow('retirement is not effective');
  });
  it('rejects wrong version and deployment changes', async () => {
    await expect(verifyLegacyRuntimeRetirement(input, async () => Response.json({ ...health, version: 'other' }))).rejects.toThrow('identity mismatch');
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { ...health, version: 'other' }))).rejects.toThrow('changed during');
  });
});

const deployModulePath = '../../../scripts/deploy-legacy-runtime.mjs';
const { runDeploymentTransaction } = await import(deployModulePath);
describe('actual maintenance deployment success path', () => {
  it('never probes or returns success after a failed deployment', async () => {
    const probe = vi.fn();
    await expect(runDeploymentTransaction(async () => { throw new Error('deploy failed'); }, probe)).rejects.toThrow('deploy failed');
    expect(probe).not.toHaveBeenCalled();
  });
  it('does not return success after a failed retirement probe', async () => {
    await expect(runDeploymentTransaction(async () => ({ version: input.version }), async () => { throw new Error('probe failed'); })).rejects.toThrow('probe failed');
  });
  it('rejects missing or mismatched probe evidence', async () => {
    for (const evidence of [undefined, { status: 'verified', version: 'other' }]) {
      await expect(runDeploymentTransaction(async () => ({ version: input.version }), async () => evidence)).rejects.toThrow('did not verify');
    }
  });
  it('returns only a probed barrier, not an inflight handover assertion', async () => {
    expect(await runDeploymentTransaction(async () => ({ version: input.version }), async () => ({ status: 'verified', version: input.version })))
      .toEqual({ status: 'barrier-installed-and-probed', version: input.version });
  });
});
