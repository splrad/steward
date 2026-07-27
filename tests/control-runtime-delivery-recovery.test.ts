import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDeliveryRecoveryPageRequestV1,
  buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json,
  canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json,
  parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  parseStewardRuntimeDeliveryRecoveryPageReceiptV1,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';
import {
  createControlRuntimeHandler,
  type ControlRuntimeDependencies,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const stewardCommit = 'a'.repeat(40);
const recoveryControlSharedSecret =
  'recovery-control-shared-secret-for-tests-0001';
const recoveryCapabilityContext = 'steward-recovery-control-v1';
const capabilityNonce = '99999999-9999-4999-8999-999999999999';
const controlRevision: StewardRuntimeControlRevisionV1 = {
  stewardCommit,
  workerVersionId: '11111111-1111-4111-8111-111111111111',
  workerVersionTag: `steward-${stewardCommit}`,
  workerVersionCreatedAt: '2026-07-27T00:00:00.000Z',
};
const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: controlRevision.workerVersionId,
    tag: controlRevision.workerVersionTag,
    timestamp: controlRevision.workerVersionCreatedAt,
  },
  RECOVERY_CONTROL_SHARED_SECRET: recoveryControlSharedSecret,
};

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(recoveryControlSharedSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  ));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function request(
  path: string,
  body: string,
  protocol = 'delivery-recovery-1',
  revision = controlRevision,
  options: {
    readonly timestamp?: string;
    readonly signedBody?: string;
    readonly includeCapability?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-steward-internal-protocol': protocol,
  });
  if (options.includeCapability !== false) {
    const digest = await sha256Hex(options.signedBody ?? body);
    const signature = await hmacHex([
      recoveryCapabilityContext,
      'POST',
      path,
      digest,
      timestamp,
      capabilityNonce,
      revision.stewardCommit,
      revision.workerVersionId,
      revision.workerVersionTag,
      revision.workerVersionCreatedAt,
    ].join('\n'));
    headers.set('x-steward-recovery-capability-timestamp', timestamp);
    headers.set('x-steward-recovery-capability-nonce', capabilityNonce);
    headers.set('x-steward-recovery-capability-signature', signature);
  }
  return new Request(`https://control.internal${path}`, {
    method: 'POST',
    headers,
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function pageRequest(
  revision: StewardRuntimeControlRevisionV1 = controlRevision,
): string {
  return canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(
    buildStewardRuntimeDeliveryRecoveryPageRequestV1({
      scanId: '22222222-2222-4222-8222-222222222222',
      cursor: null,
      expectedControlRevision: revision,
    }),
  );
}

function redeliveryRequest(): string {
  return canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(
    buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
      scanId: '22222222-2222-4222-8222-222222222222',
      intentId: '33333333-3333-4333-8333-333333333333',
      attemptId: 41,
      guid: 'delivery-guid',
      expectedControlRevision: controlRevision,
    }),
  );
}

function runtime(
  fetcher: typeof fetch,
  token: () => Promise<string> = async () => 'app-jwt',
): {
  readonly handler: ReturnType<typeof createControlRuntimeHandler>;
  readonly appToken: ReturnType<typeof vi.fn>;
} {
  const appToken = vi.fn(token);
  const dependencies: ControlRuntimeDependencies = {
    fetch: fetcher,
    appToken,
  };
  return {
    handler: createControlRuntimeHandler(dependencies),
    appToken,
  };
}

describe('private Control GitHub delivery recovery', () => {
  it('lists all App deliveries without a failure-only provider filter', async () => {
    const fetcher = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const provider = new Request(input, init);
      expect(provider.method).toBe('GET');
      expect(provider.url).toBe(
        'https://api.github.com/app/hook/deliveries?per_page=100',
      );
      expect(new URL(provider.url).searchParams.has('status')).toBe(false);
      expect(provider.headers.get('authorization')).toBe('Bearer app-jwt');
      return new Response(JSON.stringify([{
        id: 41,
        guid: 'delivery-guid',
        delivered_at: '2026-07-27T00:01:02Z',
        redelivery: false,
        status: 'Failed to connect',
        status_code: 0,
        installation_id: 7,
        repository_id: 9,
        event: 'pull_request',
        action: 'opened',
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request('/v1/delivery-recovery/github/page', pageRequest()),
      env,
    );

    expect(response.status).toBe(200);
    expect(current.appToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(parseStewardRuntimeDeliveryRecoveryPageReceiptV1(
      await response.json(),
    )).toMatchObject({
      scanId: '22222222-2222-4222-8222-222222222222',
      cursor: null,
      nextCursor: null,
      attempts: [{
        id: 41,
        guid: 'delivery-guid',
        deliveredAt: '2026-07-27T00:01:02.000Z',
        status: 'Failed to connect',
      }],
      controlRevision,
    });
  });

  it('returns an accepted receipt only for GitHub HTTP 202', async () => {
    const fetcher = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const provider = new Request(input, init);
      expect(provider.method).toBe('POST');
      expect(provider.url).toBe(
        'https://api.github.com/app/hook/deliveries/41/attempts',
      );
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
      ),
      env,
    );

    expect(response.status).toBe(202);
    expect(parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
      await response.json(),
    )).toMatchObject({
      intentId: '33333333-3333-4333-8333-333333333333',
      attemptId: 41,
      guid: 'delivery-guid',
      controlRevision,
    });
  });

  it('rejects revision drift before App JWT or network access', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const current = runtime(fetcher);
    const driftedRevision = {
      ...controlRevision,
      stewardCommit: 'b'.repeat(40),
      workerVersionTag: `steward-${'b'.repeat(40)}`,
    };
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/page',
        pageRequest(driftedRevision),
        'delivery-recovery-1',
        driftedRevision,
      ),
      env,
    );

    expect(response.status).toBe(409);
    expect(current.appToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves GitHub rate-limit retry guidance', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ message: 'API rate limit exceeded' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '12',
          'x-github-request-id': 'request-id',
        },
      },
    )) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request('/v1/delivery-recovery/github/page', pageRequest()),
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    await expect(response.json()).resolves.toEqual({
      error: 'github-rate-limited',
    });
  });

  it('treats an uncertain redelivery result as unavailable', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('connection lost after provider acceptance');
    }) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
      ),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'github-redelivery-result-unknown',
    });
  });

  it('classifies pre-I/O credential failure without touching GitHub', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const current = runtime(fetcher, async () => {
      throw new Error('private key unavailable');
    });
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
      ),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'github-redelivery-control-unavailable',
    });
    expect(current.appToken).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies a provider 5xx after POST as unknown', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Service unavailable' }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    )) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
      ),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'github-redelivery-result-unknown',
      providerStatus: 503,
    });
  });

  it('classifies a definite provider 4xx response as rejected', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Resource not accessible' }),
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
      },
    )) as typeof fetch;
    const current = runtime(fetcher);
    const response = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
      ),
      env,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'github-redelivery-rejected',
      providerStatus: 403,
    });
  });

  it('keeps undocumented or timeout-like POST responses unknown', async () => {
    for (const status of [302, 408, 409, 410]) {
      const fetcher = vi.fn(async () => new Response(
        JSON.stringify({ message: 'ambiguous POST result' }),
        {
          status,
          headers: {
            'content-type': 'application/json',
            ...(status === 302
              ? { location: 'https://api.github.com/redirected' }
              : {}),
          },
        },
      )) as typeof fetch;
      const current = runtime(fetcher);
      const response = await current.handler.fetch(
        await request(
          '/v1/delivery-recovery/github/redeliver',
          redeliveryRequest(),
        ),
        env,
      );

      expect(response.status, `provider status ${status}`).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'github-redelivery-result-unknown',
      });
    }
  });

  it('propagates caller cancellation into the bounded GitHub POST', async () => {
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const fetcher = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      providerStarted();
      const signal = init?.signal;
      expect(signal).toBeDefined();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason),
        { once: true },
      );
    })) as typeof fetch;
    const current = runtime(fetcher);
    const controller = new AbortController();
    const pending = current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/redeliver',
        redeliveryRequest(),
        'delivery-recovery-1',
        controlRevision,
        { signal: controller.signal },
      ),
      env,
    );
    await started;
    controller.abort(new Error('caller cancelled'));
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'github-redelivery-result-unknown',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, tampered, and expired capabilities before JWT or GitHub I/O', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const current = runtime(fetcher);
    const path = '/v1/delivery-recovery/github/page';
    const body = pageRequest();
    const missing = await current.handler.fetch(
      await request(
        path,
        body,
        'delivery-recovery-1',
        controlRevision,
        { includeCapability: false },
      ),
      env,
    );
    const tampered = await current.handler.fetch(
      await request(
        path,
        body,
        'delivery-recovery-1',
        controlRevision,
        { signedBody: `${body}\n` },
      ),
      env,
    );
    const expired = await current.handler.fetch(
      await request(
        path,
        body,
        'delivery-recovery-1',
        controlRevision,
        {
          timestamp: new Date(Date.now() - 61_000).toISOString(),
        },
      ),
      env,
    );

    for (const response of [missing, tampered, expired]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'recovery-control-capability-required',
      });
    }
    expect(current.appToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps both routes private and fail-closed', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const current = runtime(fetcher);
    const wrongProtocol = await current.handler.fetch(
      await request(
        '/v1/delivery-recovery/github/page',
        pageRequest(),
        '1',
      ),
      env,
    );
    const malformed = await current.handler.fetch(
      await request('/v1/delivery-recovery/github/page', '{}'),
      env,
    );

    expect(wrongProtocol.status).toBe(403);
    expect(malformed.status).toBe(400);
    expect(current.appToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
