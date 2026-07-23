import { env, exports } from 'cloudflare:workers';
import {
  importJWK,
  SignJWT,
  type JWK,
} from 'jose';
import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsTransportRequest,
  canonicalStewardRuntimeDiagnosticsTransportRequestJson,
  parseStewardRuntimeDiagnosticsTransportResponse,
} from '../packages/core/src/index.js';
import { diagnosticsFixture } from './diagnostics-fixture.js';

interface DiagnosticsRuntimeExport {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface DiagnosticsTestEnv {
  readonly TEST_ACCESS_PRIVATE_JWK: string;
}

const diagnosticsRuntime = (
  exports as unknown as { default: DiagnosticsRuntimeExport }
).default;
const diagnosticsTestEnv = env as unknown as DiagnosticsTestEnv;
const nonce = 'c'.repeat(64);

async function accessAssertion(): Promise<string> {
  const privateJwk = JSON.parse(
    diagnosticsTestEnv.TEST_ACCESS_PRIVATE_JWK,
  ) as JWK;
  const privateKey = await importJWK(privateJwk, 'RS256');
  const issuedAt = Math.floor(Date.now() / 1_000);
  return await new SignJWT({
    type: 'app',
    sub: '',
    common_name: diagnosticsFixture.clientId,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: diagnosticsFixture.keyId,
    })
    .setIssuer(`https://${diagnosticsFixture.teamDomain}`)
    .setAudience(diagnosticsFixture.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(privateKey);
}

function diagnosticsRequest(assertion?: string): Request {
  const headers = new Headers({
    'content-type': 'application/json',
  });
  if (assertion !== undefined) {
    headers.set('cf-access-jwt-assertion', assertion);
  }
  return new Request(
    'https://steward-diagnostics.alearner-5ef.workers.dev/v1/runtime-diagnostics',
    {
      method: 'POST',
      headers,
      body: canonicalStewardRuntimeDiagnosticsTransportRequestJson(
        buildStewardRuntimeDiagnosticsTransportRequest({
          nonce,
          subject: diagnosticsFixture.subject,
        }),
      ),
    },
  );
}

describe('Diagnostics gateway in workerd', () => {
  it('verifies Access and crosses the Control service binding before returning complete evidence', async () => {
    const assertion = await accessAssertion();
    const startedAt = Date.now();
    const response = await diagnosticsRuntime.fetch(
      diagnosticsRequest(assertion),
    );
    const completedAt = Date.now();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type'))
      .toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const result = parseStewardRuntimeDiagnosticsTransportResponse(
      JSON.parse(await response.text()) as unknown,
    );
    expect(result).toEqual({
      transportVersion: 1,
      audience: 'steward-runtime-diagnostics',
      nonce,
      envelope: {
        schemaVersion: 1,
        subject: diagnosticsFixture.subject,
        observedAt: result.envelope.observedAt,
        diagnostics: {
          controlRevision: {
            stewardCommit: diagnosticsFixture.stewardCommit,
            workerVersionId: diagnosticsFixture.stableVersionId,
            workerDeploymentId: diagnosticsFixture.deploymentId,
            environment: 'production',
          },
          queue: 'ready',
          control: 'ready',
          deadLetterQueue: 'clear',
        },
      },
    });
    const observedAt = Date.parse(result.envelope.observedAt);
    expect(observedAt).toBeGreaterThanOrEqual(startedAt);
    expect(observedAt).toBeLessThanOrEqual(completedAt);
  });

  it('rejects a missing Access assertion with 403', async () => {
    const response = await diagnosticsRuntime.fetch(diagnosticsRequest());

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({
      error: 'access-denied',
    });
  });
});
