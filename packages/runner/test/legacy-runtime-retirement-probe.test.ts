import { describe, expect, it } from 'vitest';
const modulePath = '../../../scripts/verify-legacy-runtime-retirement.mjs';
const { verifyLegacyRuntimeRetirement } = await import(modulePath);
const input = { url: 'https://runtime.test/', version: '11111111-1111-4111-8111-111111111111', policySha: 'a'.repeat(40), evaluatorSha: 'b'.repeat(40) };
const health = { status: 'ok', version: input.version, policySha: input.policySha, evaluatorSha: input.evaluatorSha, organizationId: 302208797, appId: 4243096, secretsReady: true };
describe('maintenance deployment retirement probe', () => {
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
