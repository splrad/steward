import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsTransportResponse,
  parseStewardRuntimeDiagnosticsEnvelope,
  parseStewardRuntimeDiagnosticsTransportRequest,
} from '../packages/core/src/index.js';
import {
  AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT,
  createAuthenticatedRuntimeDiagnosticsProvider,
  MAX_RUNTIME_DIAGNOSTICS_RESPONSE_BYTES,
  PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
  readRuntimeDiagnostics,
  RUNTIME_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  type RuntimeDiagnosticsProvider,
} from '../packages/cli/src/runtime-diagnostics.js';

const target = {
  repositoryId: 17,
  repositoryFullName: 'splrad/LayerScape',
} as const;
const fallbackObservedAt = '2026-07-23T01:00:00.000Z';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    subject: target,
    observedAt: '2026-07-23T00:59:00.000Z',
    diagnostics: {
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: 'worker-version-1',
        workerDeploymentId: 'worker-deployment-1',
        environment: 'canary',
      },
      queue: 'ready',
      control: 'ready',
      deadLetterQueue: 'clear',
    },
    ...overrides,
  };
}

function provider(result: unknown): RuntimeDiagnosticsProvider {
  return {
    read: vi.fn(async () => result) as RuntimeDiagnosticsProvider['read'],
  };
}

const accessEnvironment = {
  STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_ID: 'access-client-id',
  STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET: 'access-client-secret',
} as const;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function authenticatedProvider(
  fetcher: typeof fetch,
  environment: NodeJS.ProcessEnv = accessEnvironment,
): RuntimeDiagnosticsProvider {
  const value = createAuthenticatedRuntimeDiagnosticsProvider(environment, fetcher);
  expect(value).toBeDefined();
  return value!;
}

describe('private runtime diagnostics reader', () => {
  it('returns unavailable metadata without calling a provider', async () => {
    await expect(readRuntimeDiagnostics(undefined, target, fallbackObservedAt)).resolves.toEqual({
      status: 'unknown',
      reason: 'runtime-metadata-unavailable',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it.each([
    'runtime-metadata-unavailable',
    'permission-denied',
    'transport-error',
    'invalid-response',
  ] as const)('preserves the provider unknown reason %s', async (reason) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'unknown', reason }),
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason,
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('maps a thrown provider error to transport-error', async () => {
    const failingProvider: RuntimeDiagnosticsProvider = {
      async read() {
        throw new Error('private transport failed');
      },
    };
    await expect(readRuntimeDiagnostics(
      failingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason: 'transport-error',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('strictly parses the response body and injects the local source', async () => {
    const result = await readRuntimeDiagnostics(
      provider({ status: 'response', body: envelope() }),
      target,
      fallbackObservedAt,
    );
    expect(result).toEqual({
      status: 'known',
      envelope: envelope(),
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
    });
    expect(result).not.toHaveProperty('observedAt');
  });

  it.each([
    { repositoryId: 18, repositoryFullName: target.repositoryFullName },
    { repositoryId: target.repositoryId, repositoryFullName: 'splrad/Other' },
  ])('rejects a response bound to another repository: %#', async (subject) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'response', body: envelope({ subject }) }),
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason: 'repository-identity-mismatch',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('compares GitHub repository full names case-insensitively', async () => {
    await expect(readRuntimeDiagnostics(
      provider({
        status: 'response',
        body: envelope({
          subject: {
            repositoryId: target.repositoryId,
            repositoryFullName: 'SPLRAD/layerscape',
          },
        }),
      }),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
  });

  it('does not let a provider mutate the trusted target identity', async () => {
    const mutableTarget = { ...target };
    const mutatingProvider: RuntimeDiagnosticsProvider = {
      async read(received) {
        expect(Reflect.set(received, 'repositoryId', 999)).toBe(false);
        expect(Reflect.set(received, 'repositoryFullName', 'splrad/Other')).toBe(false);
        return { status: 'response', body: envelope() };
      },
    };
    await expect(readRuntimeDiagnostics(
      mutatingProvider,
      mutableTarget,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
    expect(mutableTarget).toEqual(target);
  });

  it.each([
    null,
    {},
    { status: 'response' },
    { status: 'response', body: envelope(), extra: true },
    { status: 'unknown' },
    { status: 'unknown', reason: 'snapshot-changed' },
    { status: 'unknown', reason: 'permission-denied', extra: true },
  ])('rejects a malformed provider wrapper %#', async (wrapper) => {
    await expect(readRuntimeDiagnostics(
      provider(wrapper),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('fails closed when inspecting a hostile provider wrapper throws', async () => {
    const wrapper = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile wrapper');
      },
    });
    await expect(readRuntimeDiagnostics(
      provider(wrapper),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it.each([
    null,
    {},
    envelope({ schemaVersion: 2 }),
    envelope({ source: 'wire-controlled-source' }),
    envelope({ observedAt: 'not-a-timestamp' }),
    envelope({ subject: { ...target, repositoryId: 0 } }),
  ])('rejects a malformed response body %#', async (body) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'response', body }),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('does not cache provider responses between reads', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'response', body: envelope() })
      .mockResolvedValueOnce({
        status: 'unknown',
        reason: 'runtime-metadata-unavailable',
      });
    const changingProvider = { read } as RuntimeDiagnosticsProvider;

    await expect(readRuntimeDiagnostics(
      changingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
    await expect(readRuntimeDiagnostics(
      changingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'runtime-metadata-unavailable',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, target);
    expect(read).toHaveBeenNthCalledWith(2, target);
  });
});

describe('authenticated runtime diagnostics provider', () => {
  it('uses only the fixed HTTPS endpoint and a strict no-cache POST contract', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = parseStewardRuntimeDiagnosticsTransportRequest(
        JSON.parse(String(init?.body)) as unknown,
      );
      expect(request.subject).toEqual(target);
      return jsonResponse(buildStewardRuntimeDiagnosticsTransportResponse({
        nonce: request.nonce,
        envelope: parseStewardRuntimeDiagnosticsEnvelope(envelope()),
      }));
    });
    const diagnostics = authenticatedProvider(fetcher as unknown as typeof fetch, {
      ...accessEnvironment,
      STEWARD_RUNTIME_DIAGNOSTICS_URL: 'https://attacker.invalid/diagnostics',
    });

    await expect(diagnostics.read(target)).resolves.toEqual({
      status: 'response',
      body: envelope(),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0]!;
    expect(input).toBe(AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT);
    expect(new URL(String(input)).protocol).toBe('https:');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headers.get('cf-access-client-id')).toBe('access-client-id');
    expect(headers.get('cf-access-client-secret')).toBe('access-client-secret');
  });

  it('generates a fresh 32-byte nonce for every read', async () => {
    const nonces: string[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = parseStewardRuntimeDiagnosticsTransportRequest(
        JSON.parse(String(init?.body)) as unknown,
      );
      nonces.push(request.nonce);
      return jsonResponse(buildStewardRuntimeDiagnosticsTransportResponse({
        nonce: request.nonce,
        envelope: parseStewardRuntimeDiagnosticsEnvelope(envelope()),
      }));
    }) as unknown as typeof fetch;
    const diagnostics = authenticatedProvider(fetcher);

    await diagnostics.read(target);
    await diagnostics.read(target);

    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(nonces[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('requires both Access credentials before any request can be sent', () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(createAuthenticatedRuntimeDiagnosticsProvider({}, fetcher)).toBeUndefined();
    expect(() => createAuthenticatedRuntimeDiagnosticsProvider({
      STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_ID: 'client-id',
    }, fetcher)).toThrow('must be configured together');
    expect(() => createAuthenticatedRuntimeDiagnosticsProvider({
      STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET: 'client-secret',
    }, fetcher)).toThrow('must be configured together');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'permission-denied'],
    [403, 'permission-denied'],
    [404, 'runtime-metadata-unavailable'],
    [429, 'transport-error'],
    [500, 'transport-error'],
    [599, 'transport-error'],
    [400, 'invalid-response'],
    [409, 'invalid-response'],
  ] as const)('maps HTTP %i to %s', async (status, reason) => {
    const diagnostics = authenticatedProvider(
      vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch,
    );
    await expect(diagnostics.read(target)).resolves.toEqual({
      status: 'unknown',
      reason,
    });
  });

  it('maps network failures and the fixed thirty-second deadline to transport-error', async () => {
    const failing = authenticatedProvider(
      vi.fn(async () => {
        throw new TypeError('connection reset');
      }) as unknown as typeof fetch,
    );
    await expect(failing.read(target)).resolves.toEqual({
      status: 'unknown',
      reason: 'transport-error',
    });

    const requestDeadline = new AbortController();
    const bodyDeadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(requestDeadline.signal)
      .mockReturnValueOnce(bodyDeadline.signal);
    try {
      const hanging = authenticatedProvider(
        vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>(
          (_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          },
        )) as unknown as typeof fetch,
      );
      const result = hanging.read(target);
      expect(timeout).toHaveBeenNthCalledWith(
        1,
        RUNTIME_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      );
      requestDeadline.abort();
      await expect(result).resolves.toEqual({
        status: 'unknown',
        reason: 'transport-error',
      });

      const stalledBody = authenticatedProvider(
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          const body = new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                controller.error(new Error('aborted'));
              });
            },
          });
          return new Response(body, {
            headers: { 'content-type': 'application/json' },
          });
        }) as unknown as typeof fetch,
      );
      const stalledResult = stalledBody.read(target);
      expect(timeout).toHaveBeenNthCalledWith(
        2,
        RUNTIME_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      );
      bodyDeadline.abort();
      await expect(stalledResult).resolves.toEqual({
        status: 'unknown',
        reason: 'transport-error',
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    null,
    'text/plain',
    'application/jsonp',
    'application/problem+json',
    'application/json; charset=iso-8859-1',
    'application/json; charset=utf-8; profile=unexpected',
  ])('rejects an invalid response content type: %s', async (contentType) => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = parseStewardRuntimeDiagnosticsTransportRequest(
        JSON.parse(String(init?.body)) as unknown,
      );
      const headers = contentType === null ? {} : { 'content-type': contentType };
      return new Response(JSON.stringify(buildStewardRuntimeDiagnosticsTransportResponse({
        nonce: request.nonce,
        envelope: parseStewardRuntimeDiagnosticsEnvelope(envelope()),
      })), { headers });
    }) as unknown as typeof fetch;
    await expect(authenticatedProvider(fetcher).read(target)).resolves.toEqual({
      status: 'unknown',
      reason: 'invalid-response',
    });
  });

  it('rejects an oversized response before parsing it', async () => {
    const diagnostics = authenticatedProvider(
      vi.fn(async () => new Response(
        'x'.repeat(MAX_RUNTIME_DIAGNOSTICS_RESPONSE_BYTES + 1),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    );
    await expect(diagnostics.read(target)).resolves.toEqual({
      status: 'unknown',
      reason: 'invalid-response',
    });
  });

  it('rejects invalid UTF-8, malformed JSON, unknown wrapper fields, and a nonce mismatch', async () => {
    const responses: Response[] = [
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{', {
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const queued = responses.shift();
      if (queued) return queued;
      const request = parseStewardRuntimeDiagnosticsTransportRequest(
        JSON.parse(String(init?.body)) as unknown,
      );
      if (responses.length === 0) {
        responses.push(jsonResponse({
          ...buildStewardRuntimeDiagnosticsTransportResponse({
            nonce: request.nonce,
            envelope: parseStewardRuntimeDiagnosticsEnvelope(envelope()),
          }),
          extra: true,
        }));
      }
      return jsonResponse(buildStewardRuntimeDiagnosticsTransportResponse({
        nonce: request.nonce === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
        envelope: parseStewardRuntimeDiagnosticsEnvelope(envelope()),
      }));
    }) as unknown as typeof fetch;
    const diagnostics = authenticatedProvider(fetcher);

    for (let index = 0; index < 4; index += 1) {
      await expect(diagnostics.read(target)).resolves.toEqual({
        status: 'unknown',
        reason: 'invalid-response',
      });
    }
  });
});
