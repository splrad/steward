import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDeliveryRecoveryPageRequestV1,
  buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';
import {
  classifyGitHubAppWebhookDeliveryError,
  createGitHubAppWebhookDeliveriesClient,
  GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES,
  GITHUB_CLOUD_REST_API_VERSION,
} from '../packages/github/src/index.js';

const revision: StewardRuntimeControlRevisionV1 = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-27T03:00:00.000Z',
};

const scanId = '313bcfe7-a5ba-45d0-aefe-999ddc101c25';
const intentId = 'b77ea4cd-183f-4820-b72c-e59a774ab44e';

function providerAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 57,
    guid: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    delivered_at: '2026-07-27T03:04:05Z',
    redelivery: false,
    status: 'Internal Server Error',
    status_code: 500,
    installation_id: 145_952_003,
    repository_id: null,
    event: 'pull_request',
    action: 'synchronize',
    duration: 0.27,
    ...overrides,
  };
}

function pageRequest(cursor: string | null = 'current==') {
  return buildStewardRuntimeDeliveryRecoveryPageRequestV1({
    scanId,
    cursor,
    expectedControlRevision: revision,
  });
}

function redeliveryRequest() {
  return buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
    scanId,
    intentId,
    attemptId: 57,
    guid: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    expectedControlRevision: revision,
  });
}

function client(
  fetchMock: typeof globalThis.fetch,
  signal?: AbortSignal,
) {
  return createGitHubAppWebhookDeliveriesClient({
    appJwt: 'app.jwt.value',
    controlRevision: revision,
    fetch: fetchMock,
    ...(signal ? { signal } : {}),
  });
}

async function capturedFailure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return classifyGitHubAppWebhookDeliveryError(error);
  }
  throw new Error('expected operation to fail');
}

describe('GitHub App webhook deliveries boundary', () => {
  it('lists exactly 100-attempt pages and accepts only a trusted next cursor', async () => {
    const link = [
      '<https://api.github.com/app/hook/deliveries?cursor=next%3D%3D&per_page=100>; rel="next"',
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=previous>; rel="prev"',
    ].join(', ');
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ) => new Response(
        JSON.stringify([providerAttempt()]),
        { status: 200, headers: { link } },
      ),
    );

    const receipt = await client(
      fetchMock as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest());

    expect(receipt).toEqual({
      schemaVersion: 1,
      phase: 'listed-deliveries',
      scanId,
      cursor: 'current==',
      attempts: [{
        id: 57,
        guid: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        deliveredAt: '2026-07-27T03:04:05.000Z',
        redelivery: false,
        status: 'Internal Server Error',
        statusCode: 500,
        installationId: 145_952_003,
        repositoryId: null,
        event: 'pull_request',
        action: 'synchronize',
      }],
      nextCursor: 'next==',
      controlRevision: revision,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.github.com/app/hook/deliveries'
      + '?per_page=100&cursor=current%3D%3D',
    );
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer app.jwt.value');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version'))
      .toBe(GITHUB_CLOUD_REST_API_VERSION);
  });

  it('returns a terminal page without inventing a cursor', async () => {
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ) => new Response('[]', { status: 200 }),
    );
    const receipt = await client(
      fetchMock as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest(null));

    expect(receipt.cursor).toBeNull();
    expect(receipt.nextCursor).toBeNull();
    expect(receipt.attempts).toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/app/hook/deliveries?per_page=100',
    );
  });

  it('rejects revision drift before either GitHub operation performs I/O', async () => {
    const fetchMock = vi.fn();
    const drifted = {
      ...revision,
      stewardCommit: 'b'.repeat(40),
      workerVersionTag: `steward-${'b'.repeat(40)}`,
    };
    const deliveries = client(
      fetchMock as unknown as typeof globalThis.fetch,
    );

    await expect(deliveries.listDeliveries({
      ...pageRequest(),
      expectedControlRevision: drifted,
    })).rejects.toThrow('different Steward Control revision');
    await expect(deliveries.requestRedelivery({
      ...redeliveryRequest(),
      expectedControlRevision: drifted,
    })).rejects.toThrow('different Steward Control revision');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicitly injected fetch and never falls back globally', () => {
    expect(() => createGitHubAppWebhookDeliveriesClient({
      appJwt: 'app.jwt.value',
      controlRevision: revision,
      fetch: undefined as unknown as typeof globalThis.fetch,
    })).toThrow('explicit');
  });

  it.each([
    [
      'cross-origin next',
      '<https://evil.example/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
    ],
    [
      'wrong endpoint',
      '<https://api.github.com/app/hook/other?per_page=100&cursor=next>; rel="next"',
    ],
    [
      'extra query',
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next&page=2>; rel="next"',
    ],
    [
      'duplicate cursor',
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next&cursor=other>; rel="next"',
    ],
    [
      'duplicate next relation',
      [
        '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
        '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=other>; rel="next"',
      ].join(', '),
    ],
    [
      'malformed relation',
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel=next last',
    ],
    [
      'non-advancing cursor',
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=current%3D%3D>; rel="next"',
    ],
  ])('fails closed on a %s Link header', async (_name, link) => {
    const fetchMock = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { link },
    }));
    await expect(client(
      fetchMock as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest())).rejects.toMatchObject({
      name: 'GitHubTransportError',
      reason: 'invalid-response',
    });
  });

  it('fails closed on malformed, over-broad, or duplicate provider attempts', async () => {
    const payloads: unknown[] = [
      {},
      [providerAttempt({ delivered_at: '2026-02-30T03:04:05Z' })],
      [providerAttempt({ action: undefined })],
      Array.from({ length: 101 }, (_, index) =>
        providerAttempt({ id: index + 1 })),
      [providerAttempt(), providerAttempt()],
    ];
    for (const payload of payloads) {
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify(payload),
        { status: 200 },
      ));
      await expect(client(
        fetchMock as unknown as typeof globalThis.fetch,
      ).listDeliveries(pageRequest())).rejects.toMatchObject({
        name: 'GitHubTransportError',
        reason: 'invalid-response',
      });
    }
  });

  it('accepts only an empty 202 response for a redelivery attempt', async () => {
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ) => new Response('', { status: 202 }),
    );
    const receipt = await client(
      fetchMock as unknown as typeof globalThis.fetch,
    ).requestRedelivery(redeliveryRequest());

    expect(receipt).toEqual({
      schemaVersion: 1,
      phase: 'redelivery-accepted',
      scanId,
      intentId,
      attemptId: 57,
      guid: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      controlRevision: revision,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.github.com/app/hook/deliveries/57/attempts',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('manual');

    for (const response of [
      new Response(' ', { status: 202 }),
      new Response('', { status: 200 }),
    ]) {
      const invalidFetch = vi.fn(async () => response);
      await expect(client(
        invalidFetch as unknown as typeof globalThis.fetch,
      ).requestRedelivery(redeliveryRequest())).rejects.toMatchObject({
        name: 'GitHubTransportError',
        reason: 'invalid-response',
      });
    }
  });

  it('classifies rate limits separately from unknown API failures', async () => {
    const rateLimitedFetch = vi.fn(async () => new Response(
      JSON.stringify({ message: 'API rate limit exceeded' }),
      {
        status: 403,
        headers: {
          'retry-after': '17',
          'x-github-request-id': 'request-1',
        },
      },
    ));
    await expect(capturedFailure(() => client(
      rateLimitedFetch as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest()))).resolves.toEqual({
      kind: 'rate-limited',
      retryable: true,
      retryAfterSeconds: 17,
      requestId: 'request-1',
    });

    const unknownFetch = vi.fn(async () => new Response(
      JSON.stringify({ message: 'service unavailable' }),
      {
        status: 503,
        headers: { 'x-github-request-id': 'request-2' },
      },
    ));
    await expect(capturedFailure(() => client(
      unknownFetch as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest()))).resolves.toEqual({
      kind: 'unknown',
      retryable: true,
      status: 503,
      requestId: 'request-2',
    });
  });

  it('keeps POST response loss unknown and non-retryable', async () => {
    const failedFetch = vi.fn(async () => {
      throw new Error('connection closed after request write');
    });
    await expect(capturedFailure(() => client(
      failedFetch as unknown as typeof globalThis.fetch,
    ).requestRedelivery(redeliveryRequest()))).resolves.toEqual({
      kind: 'unknown',
      retryable: false,
      status: null,
      requestId: null,
    });

    await expect(capturedFailure(() => client(
      failedFetch as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest()))).resolves.toEqual({
      kind: 'unknown',
      retryable: true,
      status: null,
      requestId: null,
    });
  });

  it('bounds success and error response bodies before decoding them', async () => {
    const oversized = 'x'.repeat(
      GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES + 1,
    );
    for (const [operation, response] of [
      [
        'GET',
        new Response(oversized, { status: 200 }),
      ],
      [
        'GET error',
        new Response(oversized, { status: 403 }),
      ],
      [
        'POST',
        new Response(oversized, { status: 202 }),
      ],
    ] as const) {
      const fetchMock = vi.fn(async () => response);
      const deliveries = client(
        fetchMock as unknown as typeof globalThis.fetch,
      );
      const promise = operation === 'POST'
        ? deliveries.requestRedelivery(redeliveryRequest())
        : deliveries.listDeliveries(pageRequest());
      await expect(promise).rejects.toMatchObject({
        name: 'GitHubTransportError',
        reason: 'invalid-response',
      });
    }

    const declaredOversized = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: {
        'content-length': String(
          GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES + 1,
        ),
      },
    }));
    await expect(client(
      declaredOversized as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest())).rejects.toMatchObject({
      name: 'GitHubTransportError',
      reason: 'invalid-response',
    });
  });

  it('fails closed when a successful response has no body stream', async () => {
    for (const [operation, response] of [
      ['GET', new Response(null, { status: 200 })],
      ['POST', new Response(null, { status: 202 })],
    ] as const) {
      const fetchMock = vi.fn(async () => response);
      const deliveries = client(
        fetchMock as unknown as typeof globalThis.fetch,
      );
      const promise = operation === 'POST'
        ? deliveries.requestRedelivery(redeliveryRequest())
        : deliveries.listDeliveries(pageRequest());
      await expect(promise).rejects.toMatchObject({
        name: 'GitHubTransportError',
        reason: 'invalid-response',
      });
    }
  });

  it('classifies response-body read failure as a transport network failure', async () => {
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.error(new Error('body stream failed'));
        },
      }),
      { status: 200 },
    ));
    await expect(client(
      fetchMock as unknown as typeof globalThis.fetch,
    ).listDeliveries(pageRequest())).rejects.toMatchObject({
      name: 'GitHubTransportError',
      reason: 'network',
      retryable: true,
    });
  });

  it('propagates caller aborts through fetch and bounded body reads', async () => {
    const controller = new AbortController();
    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ) => new Response(new ReadableStream<Uint8Array>({
        pull() {
          markBodyRead();
          return new Promise<void>(() => undefined);
        },
      }), { status: 200 }),
    );
    const operation = client(
      fetchMock as unknown as typeof globalThis.fetch,
      controller.signal,
    ).listDeliveries(pageRequest());
    await bodyRead;
    controller.abort();

    await expect(operation).rejects.toMatchObject({
      name: 'GitHubTransportError',
      reason: 'network',
      retryable: true,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBe(controller.signal);
  });

  it('does not start GitHub I/O with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();

    await expect(client(
      fetchMock as unknown as typeof globalThis.fetch,
      controller.signal,
    ).listDeliveries(pageRequest())).rejects.toMatchObject({
      name: 'GitHubTransportError',
      reason: 'network',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
