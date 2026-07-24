import {
  SignJWT,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsControlReceipt,
  buildStewardRuntimeDiagnosticsTransportRequest,
  canonicalStewardRuntimeDiagnosticsControlReceiptJson,
  canonicalStewardRuntimeDiagnosticsTransportRequestJson,
} from '../packages/core/src/index.js';
import {
  createDiagnosticsHandler,
  diagnosticsCloudflareTimeoutMs,
  diagnosticsControlTimeoutMs,
  diagnosticsOverallTimeoutMs,
  maximumDiagnosticsRequestBytes,
  verifyCloudflareAccessRequest,
  type DiagnosticsAccessDecision,
  type DiagnosticsDependencies,
  type DiagnosticsEnv,
} from '../packages/diagnostics/src/index.js';

const accountId = '5efbba9a3813a37ac45e70cfa9f01cb5';
const eventQueueId = 'b957c244a4bf478887da90ad3fe10909';
const deadLetterQueueId = '7fb7d65f37774837ae7a22f71f7dde4c';
const stableVersion = '32b8936f-bbf7-4342-946c-ac9b730eb497';
const deploymentId = '7b85e57e-9ef3-4271-9625-7884e4ddbc1c';
const replacementDeploymentId = '8c96f680-b5b9-45c1-ae3c-ddd6da3a0cc7';
const subject = {
  repositoryId: 1_298_587_318,
  repositoryFullName: 'splrad/steward-sandbox-install-e2e',
} as const;

function transportRequest() {
  return buildStewardRuntimeDiagnosticsTransportRequest({
    nonce: 'c'.repeat(64),
    subject,
  });
}

function request(
  body = canonicalStewardRuntimeDiagnosticsTransportRequestJson(
    transportRequest(),
  ),
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request(
    'https://steward-diagnostics.alearner-5ef.workers.dev/v1/runtime-diagnostics',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-access-jwt-assertion': 'signed-access-assertion',
        ...headers,
      },
      body,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    success: status >= 200 && status < 300,
    result: body,
  }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface RuntimeOptions {
  readonly deploymentIds?: readonly string[];
  readonly deploymentVersions?: readonly {
    readonly versionId: string;
    readonly percentage: number;
  }[];
  readonly eventPaused?: unknown;
  readonly eventConsumerScriptField?:
    | 'script'
    | 'script_name'
    | 'both'
    | 'conflicting'
    | 'missing'
    | 'invalid_script'
    | 'invalid_script_name';
  readonly eventDeliveryDelay?: number;
  readonly eventRetentionSeconds?: number;
  readonly eventProducers?: readonly {
    readonly type: string;
    readonly scriptName?: string;
  }[];
  readonly eventConfigurationStatus?: number;
  readonly deploymentIdAfterQueueRead?: string;
  readonly dlqBacklog?: number;
  readonly dlqBacklogBytes?: number;
  readonly dlqOldestMessageTimestampMs?: number;
  readonly dlqPaused?: unknown;
  readonly dlqDeliveryDelay?: number;
  readonly dlqRetentionSeconds?: number;
  readonly dlqProducers?: readonly {
    readonly type: string;
    readonly scriptName?: string;
  }[];
  readonly dlqConsumers?: readonly unknown[];
  readonly dlqMetricsStatus?: number;
  readonly controlStatus?: number;
  readonly controlVersion?: string;
  readonly accessDecision?: DiagnosticsAccessDecision;
}

function runtime(options: RuntimeOptions = {}): {
  readonly env: DiagnosticsEnv;
  readonly dependencies: DiagnosticsDependencies & {
    readonly fetchMock: ReturnType<typeof vi.fn>;
    readonly verifyAccessMock: ReturnType<typeof vi.fn>;
  };
  readonly control: {
    readonly fetch: ReturnType<typeof vi.fn>;
  };
} {
  let deploymentRead = 0;
  let queueReadObserved = false;
  const fetchMock = vi.fn(async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deployments')) {
      const ids = options.deploymentIds ?? [deploymentId, deploymentId];
      const id = queueReadObserved && options.deploymentIdAfterQueueRead
        ? options.deploymentIdAfterQueueRead
        : ids[Math.min(deploymentRead, ids.length - 1)] ?? deploymentId;
      deploymentRead += 1;
      return json({
        deployments: [{
        id,
        created_on: '2026-07-24T01:30:00.000Z',
        strategy: 'percentage',
        versions: (
          options.deploymentVersions ?? [
            { versionId: stableVersion, percentage: 100 },
            {
              versionId: 'c2312517-bd5c-4041-a9cd-b6642dbf7e21',
              percentage: 0,
            },
          ]
        ).map((version) => ({
          version_id: version.versionId,
          percentage: version.percentage,
        })),
        }],
      });
    }
    queueReadObserved = true;
    const token = new Headers(init?.headers).get('authorization');
    if (token !== 'Bearer queues-read-token') {
      return json(null, 403);
    }
    const isEvent = url.pathname.includes(eventQueueId);
    if (url.pathname.endsWith('/consumers')) {
      const scriptField = options.eventConsumerScriptField ?? 'script';
      const scriptReference = scriptField === 'script'
        ? { script: 'steward-coordinator' }
        : scriptField === 'script_name'
          ? { script_name: 'steward-coordinator' }
          : scriptField === 'both'
            ? {
                script: 'steward-coordinator',
                script_name: 'steward-coordinator',
              }
            : scriptField === 'conflicting'
              ? {
                  script: 'steward-coordinator',
                  script_name: 'other-coordinator',
                }
              : scriptField === 'invalid_script'
                ? {
                    script: 123,
                    script_name: 'steward-coordinator',
                  }
                : scriptField === 'invalid_script_name'
                  ? {
                      script: 'steward-coordinator',
                      script_name: 123,
                    }
                  : {};
      return json(isEvent ? [{
        type: 'worker',
        ...scriptReference,
        dead_letter_queue: 'steward-events-dlq',
        settings: {
          batch_size: 10,
          max_wait_time_ms: 1_000,
          max_retries: 3,
          retry_delay: 5,
        },
      }] : options.dlqConsumers ?? []);
    }
    if (url.pathname.endsWith('/metrics')) {
      const status = isEvent ? 200 : options.dlqMetricsStatus ?? 200;
      return json({
        backlog_count: isEvent ? 0 : options.dlqBacklog ?? 0,
        backlog_bytes: isEvent ? 0 : options.dlqBacklogBytes ?? 0,
        oldest_message_timestamp_ms: isEvent
          ? 0
          : options.dlqOldestMessageTimestampMs ?? 0,
      }, status);
    }
    return json({
      queue_id: isEvent ? eventQueueId : deadLetterQueueId,
      queue_name: isEvent ? 'steward-events' : 'steward-events-dlq',
      producers: (
        isEvent
          ? options.eventProducers ?? [
            { type: 'worker', scriptName: 'steward-ingress' },
            { type: 'worker', scriptName: 'steward-coordinator' },
          ]
          : options.dlqProducers ?? []
      ).map((producer) => ({
        type: producer.type,
        ...(producer.scriptName === undefined
          ? {}
          : { script: producer.scriptName }),
      })),
      settings: {
        ...(
          (isEvent ? options.eventPaused : options.dlqPaused) !== undefined
            ? {
                delivery_paused: isEvent
                  ? options.eventPaused
                  : options.dlqPaused,
              }
            : {}
        ),
        delivery_delay: isEvent
          ? options.eventDeliveryDelay ?? 0
          : options.dlqDeliveryDelay ?? 0,
        message_retention_period: isEvent
          ? options.eventRetentionSeconds ?? 86_400
          : options.dlqRetentionSeconds ?? 86_400,
      },
    }, isEvent ? options.eventConfigurationStatus ?? 200 : 200);
  });
  const control = {
    fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      if (options.controlStatus && options.controlStatus !== 200) {
        return new Response('unavailable', { status: options.controlStatus });
      }
      const parsed = JSON.parse(String(init?.body)) as {
        nonce: string;
        subject: typeof subject;
        environment: 'production';
      };
      return new Response(
        canonicalStewardRuntimeDiagnosticsControlReceiptJson(
          buildStewardRuntimeDiagnosticsControlReceipt({
            nonce: parsed.nonce,
            subject: parsed.subject,
            environment: parsed.environment,
            controlRevision: {
              stewardCommit: 'e'.repeat(40),
              workerVersionId: options.controlVersion ?? stableVersion,
              workerVersionTag: `steward-${'e'.repeat(40)}`,
              workerVersionCreatedAt: '2026-07-24T01:00:00.000Z',
            },
          }),
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }),
  };
  const verifyAccessMock = vi.fn().mockResolvedValue(
    options.accessDecision ?? 'authorized',
  );
  return {
    env: {
      CONTROL: control,
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_POLICY_AUD: 'a'.repeat(64),
      ACCESS_EXPECTED_CLIENT_ID: 'client-id.access',
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_WORKERS_READ_TOKEN: 'workers-read-token',
      CLOUDFLARE_QUEUES_READ_TOKEN: 'queues-read-token',
      EVENT_QUEUE_ID: eventQueueId,
      DEAD_LETTER_QUEUE_ID: deadLetterQueueId,
    },
    dependencies: {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-07-24T02:00:00.000Z'),
      verifyAccess: verifyAccessMock,
      fetchMock,
      verifyAccessMock,
    },
    control,
  };
}

describe('Access-protected runtime diagnostics gateway', () => {
  it('aggregates live deployment, private Control, Queue, and DLQ evidence', async () => {
    const current = runtime();
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      transportVersion: 1,
      audience: 'steward-runtime-diagnostics',
      nonce: 'c'.repeat(64),
      envelope: {
        schemaVersion: 1,
        subject,
        observedAt: '2026-07-24T02:00:00.000Z',
        diagnostics: {
          controlRevision: {
            stewardCommit: 'e'.repeat(40),
            workerVersionId: stableVersion,
            workerDeploymentId: deploymentId,
            environment: 'production',
          },
          queue: 'ready',
          control: 'ready',
          deadLetterQueue: 'clear',
        },
      },
    });
    expect(current.dependencies.fetchMock).toHaveBeenCalledTimes(7);
    for (const [, init] of current.dependencies.fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe('manual');
    }
    expect(current.dependencies.verifyAccessMock.mock.calls[0]?.[2])
      .toBeInstanceOf(AbortSignal);
    const deploymentCalls = current.dependencies.fetchMock.mock.calls.filter(
      ([input]) => String(input).endsWith('/deployments'),
    );
    expect(deploymentCalls).toHaveLength(2);
    for (const [, init] of deploymentCalls) {
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer workers-read-token');
    }
    expect(current.control.fetch).toHaveBeenCalledOnce();
    const controlInit = current.control.fetch.mock.calls[0]?.[1];
    expect(controlInit?.signal).toBeInstanceOf(AbortSignal);
    const controlHeaders = new Headers(controlInit?.headers);
    expect(controlHeaders.get('cloudflare-workers-version-key'))
      .toBe(`steward-repository-${subject.repositoryId}`);
    expect(controlHeaders.get('cloudflare-workers-version-overrides')).toBeNull();
    expect(controlHeaders.get('authorization')).toBeNull();
    expect(controlHeaders.get('cf-access-jwt-assertion')).toBeNull();
  });

  it('accepts documented and matching dual aliases with an explicit unpaused value', async () => {
    for (const eventConsumerScriptField of [
      'script_name',
      'both',
    ] satisfies readonly RuntimeOptions['eventConsumerScriptField'][]) {
      const current = runtime({
        eventPaused: false,
        eventConsumerScriptField,
      });
      const response = await createDiagnosticsHandler(
        current.dependencies,
      ).fetch(request(), current.env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        envelope: {
          diagnostics: {
            queue: 'ready',
            control: 'ready',
            deadLetterQueue: 'clear',
          },
        },
      });
    }
  });

  it('fails closed on an invalid pause value or conflicting consumer aliases', async () => {
    for (const options of [
      { eventPaused: 'false' },
      { eventPaused: null },
      { eventPaused: 0 },
      { eventConsumerScriptField: 'conflicting' },
      { eventConsumerScriptField: 'missing' },
      { eventConsumerScriptField: 'invalid_script' },
      { eventConsumerScriptField: 'invalid_script_name' },
    ] satisfies readonly RuntimeOptions[]) {
      const current = runtime(options);
      const response = await createDiagnosticsHandler(
        current.dependencies,
      ).fetch(request(), current.env);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'runtime-diagnostics-unavailable',
      });
    }
  });

  it('rejects missing Access proof before reading request or upstream state', async () => {
    const current = runtime({ accessDecision: 'denied' });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request('not-json'), current.env);
    expect(response.status).toBe(403);
    expect(current.dependencies.fetchMock).not.toHaveBeenCalled();
    expect(current.control.fetch).not.toHaveBeenCalled();
  });

  it('reports Access configuration or JWKS failure as unavailable, not credential denial', async () => {
    const current = runtime({ accessDecision: 'unavailable' });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request('not-json'), current.env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'runtime-diagnostics-unavailable',
    });
    expect(current.dependencies.fetchMock).not.toHaveBeenCalled();
    expect(current.control.fetch).not.toHaveBeenCalled();
  });

  it('uses a bounded end-to-end budget with smaller Cloudflare and Control budgets', () => {
    expect(diagnosticsOverallTimeoutMs).toBe(25_000);
    expect(diagnosticsCloudflareTimeoutMs).toBe(5_000);
    expect(diagnosticsControlTimeoutMs).toBe(10_000);
    expect(diagnosticsCloudflareTimeoutMs).toBeLessThan(
      diagnosticsControlTimeoutMs,
    );
    expect(diagnosticsControlTimeoutMs).toBeLessThan(
      diagnosticsOverallTimeoutMs,
    );
  });

  it('propagates caller cancellation into a pending upstream response body', async () => {
    const current = runtime();
    let bodyCancelled = false;
    current.dependencies.fetchMock.mockImplementationOnce(async () =>
      new Response(new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const controller = new AbortController();
    const pending = createDiagnosticsHandler(current.dependencies).fetch(
      request(undefined, {}, controller.signal),
      current.env,
    );
    await vi.waitFor(() => {
      expect(current.dependencies.fetchMock).toHaveBeenCalledOnce();
    });
    controller.abort();

    expect((await pending).status).toBe(503);
    expect(bodyCancelled).toBe(true);
    expect(current.control.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when deployment changes around the actual Control probe', async () => {
    const current = runtime({
      deploymentIds: [
        deploymentId,
        '33333333-3333-4333-8333-333333333333',
      ],
    });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(503);
  });

  it('fails closed when deployment changes during the Queue observation window', async () => {
    const current = runtime({
      deploymentIdAfterQueueRead: replacementDeploymentId,
    });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'runtime-diagnostics-unavailable',
    });
    const paths = current.dependencies.fetchMock.mock.calls.map(
      ([input]) => new URL(String(input)).pathname,
    );
    expect(paths.at(0)).toContain('/deployments');
    expect(paths.at(-1)).toContain('/deployments');
    expect(paths.slice(1, -1).some((path) => path.includes('/queues/'))).toBe(true);
  });

  it('fails closed when the executing Control version is outside the active deployment', async () => {
    const current = runtime({
      controlVersion: '11111111-1111-4111-8111-111111111111',
    });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(503);
  });

  it('does not claim production during an active percentage split', async () => {
    const current = runtime({
      deploymentVersions: [
        { versionId: stableVersion, percentage: 90 },
        {
          versionId: 'c2312517-bd5c-4041-a9cd-b6642dbf7e21',
          percentage: 10,
        },
      ],
    });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(503);
    expect(current.control.fetch).not.toHaveBeenCalled();
  });

  it('does not accept a zero-percent candidate as the production Control version', async () => {
    const current = runtime({
      controlVersion: 'c2312517-bd5c-4041-a9cd-b6642dbf7e21',
    });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(503);
  });

  it('reports only proven topology drift as degraded and a non-empty DLQ as pending', async () => {
    const current = runtime({ eventPaused: true, dlqBacklog: 2 });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      envelope: {
        diagnostics: {
          queue: 'degraded',
          control: 'ready',
          deadLetterQueue: 'pending',
        },
      },
    });
  });

  it('requires both intentional worker producers and the full primary Queue contract', async () => {
    const withoutDeferredWakeupProducer = runtime({
      eventProducers: [
        { type: 'worker', scriptName: 'steward-ingress' },
      ],
    });
    const missingProducerResponse = await createDiagnosticsHandler(
      withoutDeferredWakeupProducer.dependencies,
    ).fetch(request(), withoutDeferredWakeupProducer.env);
    expect(missingProducerResponse.status).toBe(200);
    await expect(missingProducerResponse.json()).resolves.toMatchObject({
      envelope: { diagnostics: { queue: 'degraded' } },
    });

    const shortRetention = runtime({ eventRetentionSeconds: 86_399 });
    const shortRetentionResponse = await createDiagnosticsHandler(
      shortRetention.dependencies,
    ).fetch(request(), shortRetention.env);
    await expect(shortRetentionResponse.json()).resolves.toMatchObject({
      envelope: { diagnostics: { queue: 'degraded' } },
    });

    const delayedDelivery = runtime({ eventDeliveryDelay: 1 });
    const delayedDeliveryResponse = await createDiagnosticsHandler(
      delayedDelivery.dependencies,
    ).fetch(request(), delayedDelivery.env);
    await expect(delayedDeliveryResponse.json()).resolves.toMatchObject({
      envelope: { diagnostics: { queue: 'degraded' } },
    });
  });

  it('requires the DLQ retention, delivery delay, zero-producer, and zero-consumer contract', async () => {
    for (const options of [
      { dlqPaused: true },
      { dlqRetentionSeconds: 86_399 },
      { dlqDeliveryDelay: 1 },
      {
        dlqProducers: [{
          type: 'worker',
          scriptName: 'unexpected-dlq-producer',
        }],
      },
      {
        dlqConsumers: [{
          type: 'worker',
          script_name: 'unexpected-consumer',
          dead_letter_queue: '',
          settings: {
            batch_size: 1,
            max_wait_time_ms: 1_000,
            max_retries: 0,
            retry_delay: 0,
          },
        }],
      },
    ] satisfies readonly RuntimeOptions[]) {
      const current = runtime(options);
      const response = await createDiagnosticsHandler(
        current.dependencies,
      ).fetch(request(), current.env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        envelope: {
          diagnostics: {
            queue: 'ready',
            deadLetterQueue: 'unavailable',
          },
        },
      });
    }
  });

  it('uses unavailable only for a DLQ whose live metrics cannot be proven', async () => {
    const current = runtime({ dlqMetricsStatus: 503 });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      envelope: {
        diagnostics: {
          queue: 'ready',
          deadLetterQueue: 'unavailable',
        },
      },
    });
  });

  it('does not call the DLQ clear when any metrics dimension is non-zero', async () => {
    for (const options of [
      { dlqBacklogBytes: 1 },
      { dlqOldestMessageTimestampMs: 1 },
    ] satisfies readonly RuntimeOptions[]) {
      const current = runtime(options);
      const response = await createDiagnosticsHandler(
        current.dependencies,
      ).fetch(request(), current.env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        envelope: {
          diagnostics: {
            deadLetterQueue: 'pending',
          },
        },
      });
    }
  });

  it('does not relabel unreadable primary Queue evidence as degraded', async () => {
    const current = runtime({ eventConfigurationStatus: 503 });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(503);
  });

  it('preserves repository access denial without exposing the private Control body', async () => {
    const current = runtime({ controlStatus: 403 });
    const response = await createDiagnosticsHandler(
      current.dependencies,
    ).fetch(request(), current.env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'access-denied' });
  });

  it('rejects malformed and oversized request bodies without any upstream call', async () => {
    const malformed = runtime();
    expect((await createDiagnosticsHandler(malformed.dependencies).fetch(
      request('{"transportVersion":1}'),
      malformed.env,
    )).status).toBe(400);
    expect(malformed.control.fetch).not.toHaveBeenCalled();

    const oversized = runtime();
    expect((await createDiagnosticsHandler(oversized.dependencies).fetch(
      request(`"${'x'.repeat(maximumDiagnosticsRequestBytes)}"`),
      oversized.env,
    )).status).toBe(400);
    expect(oversized.control.fetch).not.toHaveBeenCalled();
  });
});

describe('Cloudflare Access JWT verification', () => {
  it('caches a validated JWKS while enforcing issuer, audience, and service client on every request', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      type: 'app',
      sub: '',
      common_name: 'expected-client.access',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'access-key-1' })
      .setIssuer('https://test-team.cloudflareaccess.com')
      .setAudience('z'.repeat(64))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const accessRequest = request(undefined, {
      'cf-access-jwt-assertion': token,
    });
    const env: DiagnosticsEnv = {
      CONTROL: { fetch: vi.fn() },
      ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
      ACCESS_POLICY_AUD: 'z'.repeat(64),
      ACCESS_EXPECTED_CLIENT_ID: 'expected-client.access',
    };
    const jwksFetch = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: 'access-key-1', alg: 'RS256', use: 'sig' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(verifyCloudflareAccessRequest(
      accessRequest,
      env,
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('authorized');
    expect(jwksFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    await expect(verifyCloudflareAccessRequest(
      accessRequest,
      { ...env, ACCESS_POLICY_AUD: 'y'.repeat(64) },
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('denied');
    await expect(verifyCloudflareAccessRequest(
      accessRequest,
      { ...env, ACCESS_EXPECTED_CLIENT_ID: 'other-client.access' },
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('denied');
    expect(jwksFetch).toHaveBeenCalledOnce();
  });

  it('rejects a missing assertion without fetching the JWKS', async () => {
    const jwksFetch = vi.fn();
    await expect(verifyCloudflareAccessRequest(
      new Request(
        'https://steward-diagnostics.alearner-5ef.workers.dev/v1/runtime-diagnostics',
      ),
      {
        CONTROL: { fetch: vi.fn() },
        ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
        ACCESS_POLICY_AUD: 'z'.repeat(64),
        ACCESS_EXPECTED_CLIENT_ID: 'expected-client.access',
      },
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('denied');
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it('keeps caller cancellation bound to a cold JWKS fetch despite the shared cache', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({
      type: 'app',
      sub: '',
      common_name: 'expected-client.access',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'cancelled-key' })
      .setIssuer('https://cancel-team.cloudflareaccess.com')
      .setAudience('z'.repeat(64))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const jwksFetch = vi.fn((
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
    }));
    const pending = verifyCloudflareAccessRequest(
      request(undefined, { 'cf-access-jwt-assertion': token }),
      {
        CONTROL: { fetch: vi.fn() },
        ACCESS_TEAM_DOMAIN: 'cancel-team.cloudflareaccess.com',
        ACCESS_POLICY_AUD: 'z'.repeat(64),
        ACCESS_EXPECTED_CLIENT_ID: 'expected-client.access',
      },
      jwksFetch as unknown as typeof fetch,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(jwksFetch).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(pending).resolves.toBe('unavailable');
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('distinguishes invalid Access configuration and JWKS outage from bad credentials', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({
      type: 'app',
      sub: '',
      common_name: 'expected-client.access',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'unavailable-key' })
      .setIssuer('https://test-team.cloudflareaccess.com')
      .setAudience('z'.repeat(64))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const env: DiagnosticsEnv = {
      CONTROL: { fetch: vi.fn() },
      ACCESS_TEAM_DOMAIN: 'not a team domain',
      ACCESS_POLICY_AUD: 'z'.repeat(64),
      ACCESS_EXPECTED_CLIENT_ID: 'expected-client.access',
    };
    const accessRequest = request(undefined, {
      'cf-access-jwt-assertion': token,
    });
    const jwksFetch = vi.fn(async () => new Response('unavailable', {
      status: 503,
    }));

    await expect(verifyCloudflareAccessRequest(
      accessRequest,
      env,
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('unavailable');
    expect(jwksFetch).not.toHaveBeenCalled();

    await expect(verifyCloudflareAccessRequest(
      accessRequest,
      {
        ...env,
        ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
      },
      jwksFetch as unknown as typeof fetch,
    )).resolves.toBe('unavailable');
    expect(jwksFetch).toHaveBeenCalledOnce();

    for (const malformedFetch of [
      vi.fn(async () => new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })),
      vi.fn(async () => new Response(JSON.stringify({
        keys: [{
          kty: 'RSA',
          alg: 'RS256',
          use: 'sig',
          kid: 'malformed-key',
          n: '*',
          e: 'AQAB',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    ]) {
      await expect(verifyCloudflareAccessRequest(
        accessRequest,
        {
          ...env,
          ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
        },
        malformedFetch as unknown as typeof fetch,
      )).resolves.toBe('unavailable');
    }
  });
});
