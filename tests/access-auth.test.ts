import {
  SignJWT,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  verifyCloudflareAccessPrincipal,
  verifyCloudflareAccessRequest,
  type CloudflareAccessEnvironment,
} from '../packages/access-auth/src/index.js';

describe('Cloudflare Access authentication', () => {
  it('returns the exact service principal while preserving the decision wrapper', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const clientId = 'expected-client.access';
    const token = await new SignJWT({
      type: 'app',
      sub: '',
      common_name: clientId,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'access-key-1' })
      .setIssuer('https://test-team.cloudflareaccess.com')
      .setAudience('z'.repeat(64))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const request = new Request('https://steward.example.test/private', {
      headers: { 'cf-access-jwt-assertion': token },
    });
    const env: CloudflareAccessEnvironment = {
      ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
      ACCESS_POLICY_AUD: 'z'.repeat(64),
      ACCESS_EXPECTED_CLIENT_ID: clientId,
    };
    const jwksFetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: 'access-key-1', alg: 'RS256', use: 'sig' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(verifyCloudflareAccessPrincipal(
      request,
      env,
      jwksFetch as unknown as typeof fetch,
    )).resolves.toEqual({
      decision: 'authorized',
      principal: {
        type: 'service',
        clientId,
      },
    });
    await expect(verifyCloudflareAccessRequest(
      request,
      env,
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('authorized');
    expect(jwksFetch).toHaveBeenCalledOnce();
  });

  it('fails unavailable configuration closed before fetching a JWKS', async () => {
    const jwksFetch = vi.fn();
    await expect(verifyCloudflareAccessPrincipal(
      new Request('https://steward.example.test/private', {
        headers: { 'cf-access-jwt-assertion': 'x'.repeat(64) },
      }),
      {
        ACCESS_TEAM_DOMAIN: 'invalid domain',
        ACCESS_POLICY_AUD: 'z'.repeat(64),
        ACCESS_EXPECTED_CLIENT_ID: 'expected-client.access',
      },
      jwksFetch as unknown as typeof fetch,
    )).resolves.toEqual({ decision: 'unavailable' });
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it('honors caller cancellation when a warm JWKS cache avoids fetch', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const clientId = 'cache-cancel-client.access';
    const audience = 'y'.repeat(64);
    const token = await new SignJWT({
      type: 'app',
      sub: '',
      common_name: clientId,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'cache-key-1' })
      .setIssuer('https://cache-team.cloudflareaccess.com')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const request = new Request('https://steward.example.test/private', {
      headers: { 'cf-access-jwt-assertion': token },
    });
    const env: CloudflareAccessEnvironment = {
      ACCESS_TEAM_DOMAIN: 'cache-team.cloudflareaccess.com',
      ACCESS_POLICY_AUD: audience,
      ACCESS_EXPECTED_CLIENT_ID: clientId,
    };
    const jwksFetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{
        ...jwk,
        kid: 'cache-key-1',
        alg: 'RS256',
        use: 'sig',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(verifyCloudflareAccessPrincipal(
      request,
      env,
      jwksFetch as unknown as typeof fetch,
    )).resolves.toMatchObject({ decision: 'authorized' });

    const controller = new AbortController();
    controller.abort(new Error('caller disconnected'));
    await expect(verifyCloudflareAccessPrincipal(
      request,
      env,
      jwksFetch as unknown as typeof fetch,
      controller.signal,
    )).resolves.toEqual({ decision: 'unavailable' });
    expect(jwksFetch).toHaveBeenCalledOnce();
  });
});
