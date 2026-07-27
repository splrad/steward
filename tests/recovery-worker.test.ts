import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  buildStewardRuntimeDeliveryRecoveryPageReceiptV1,
  canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  parseStewardRuntimeDeliveryRecoveryPageRequestV1,
  parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';
import {
  canonicalDeliveryRecoveryCommandJson,
  parseDeliveryRecoveryCommand,
} from '../packages/recovery/src/contracts.js';
import {
  DeliveryRecoveryConflictError,
} from '../packages/recovery/src/ledger-contracts.js';
import {
  createDeliveryRecoveryHandler,
  type DeliveryRecoveryDependencies,
  type DeliveryRecoveryEnv,
  type DeliveryRecoveryLedgerStub,
} from '../packages/recovery/src/worker.js';

const now = '2026-07-27T01:02:03.000Z';
const revision: StewardRuntimeControlRevisionV1 = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: '11111111-1111-4111-8111-111111111111',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-27T00:00:00.000Z',
};
const initialLedgerRevision = '1'.repeat(64);
const nextLedgerRevision = '2'.repeat(64);
const requestId = '22222222-2222-4222-8222-222222222222';
const entryId = '3'.repeat(64);
const recoveryControlSharedSecret =
  'recovery-control-shared-secret-for-tests-0001';
const scanLeaseExpiresAt = '2026-07-27T01:12:03.000Z';
const providerWindowStart = '2026-07-24T01:17:03.000Z';

function retentionGapCoverage(
  windowStart = providerWindowStart,
) {
  return {
    status: 'retention-gap' as const,
    coverageFrom: windowStart,
    providerWindowStart: windowStart,
    gap: {
      reason: 'checkpoint-missing' as const,
      from: null,
      to: windowStart,
    },
  };
}

function retainedCoverage(
  checkpoint: string,
  windowStart = providerWindowStart,
) {
  return {
    status: 'retained-window' as const,
    coverageFrom: checkpoint,
    providerWindowStart: windowStart,
    gap: null,
  };
}

function githubAttempt(id: number, deliveredAt: string) {
  return {
    id,
    guid: `delivery-guid-${id}`,
    deliveredAt,
    redelivery: false,
    status: 'OK',
    statusCode: 200,
    installationId: null,
    repositoryId: null,
    event: 'ping',
    action: null,
  };
}

function emptyRedeliveryIntents() {
  return {
    prepared: 0,
    dispatching: 0,
    deferred: 0,
    accepted: 0,
    unknown: 0,
    rejected: 0,
    total: 0,
  };
}

function publicRequest(body: string, signal?: AbortSignal): Request {
  return new Request('https://recovery.example/v1/recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
    ...(signal ? { signal } : {}),
  });
}

function command(value: Record<string, unknown>): string {
  return canonicalDeliveryRecoveryCommandJson(
    parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      requestId,
      requestedAt: now,
      ...value,
    }),
  );
}

async function expectedControlSignature(
  request: Request,
  body: string,
): Promise<string> {
  const timestamp = request.headers.get(
    'x-steward-recovery-capability-timestamp',
  )!;
  const nonce = request.headers.get('x-steward-recovery-capability-nonce')!;
  const digestBytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  ));
  const digest = [...digestBytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const message = [
    'steward-recovery-control-v1',
    'POST',
    new URL(request.url).pathname,
    digest,
    timestamp,
    nonce,
    revision.stewardCommit,
    revision.workerVersionId,
    revision.workerVersionTag,
    revision.workerVersionCreatedAt,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(recoveryControlSharedSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  ));
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function inspection() {
  return {
    schemaVersion: 1 as const,
    ledgerRevision: initialLedgerRevision,
    counts: {
      pending: 0,
      enqueued: 0,
      unknown: 0,
      actionRequired: 0,
      quarantined: 0,
    },
    entries: [],
    truncated: false,
  };
}

function githubInspection(
  overrides: Partial<{
    generation: number;
    checkpoint: string | null;
    active: null;
    unresolvedRedeliveryIntents: number;
    ledgerRevision: string;
  }> = {},
) {
  return {
    generation: 0,
    checkpoint: null,
    coverage: null,
    active: null,
    redeliveryIntents: emptyRedeliveryIntents(),
    unresolvedRedeliveryIntents: 0,
    ledgerRevision: initialLedgerRevision,
    ...overrides,
  };
}

function ledgerStub(
  overrides: Partial<Record<keyof DeliveryRecoveryLedgerStub, unknown>> = {},
): DeliveryRecoveryLedgerStub {
  return {
    captureDlq: vi.fn(async () => ({
      status: 'captured',
      entryId,
      state: 'pending',
      cycleCount: 1,
      replayCount: 0,
      ledgerRevision: nextLedgerRevision,
    })),
    inspect: vi.fn(async () => inspection()),
    authorizeReplay: vi.fn(async () => ({
      status: 'authorized',
      commandId: requestId,
      entryCount: 1,
      ledgerRevision: nextLedgerRevision,
    })),
    nextReplay: vi.fn(async () => ({
      status: 'complete',
      commandId: requestId,
      ledgerRevision: nextLedgerRevision,
    })),
    recordReplayEnqueued: vi.fn(async () => ({
      status: 'recorded',
      commandId: requestId,
      entryId,
      state: 'enqueued',
      ledgerRevision: nextLedgerRevision,
    })),
    recordReplayUnknown: vi.fn(async () => ({
      status: 'recorded',
      commandId: requestId,
      entryId,
      state: 'unknown',
      ledgerRevision: nextLedgerRevision,
    })),
    beginGitHubScan: vi.fn(async (value: unknown) => {
      const input = value as {
        scanId: string;
        leaseExpiresAt: string;
        coverageMode: 'continue' | 'establish';
        providerWindowStart: string;
      };
      return {
        status: 'begun',
        generation: 1,
        scanId: input.scanId,
        cursor: null,
        pageCount: 0,
        attemptCount: 0,
        checkpointBefore: null,
        leaseExpiresAt: input.leaseExpiresAt,
        coverageMode: input.coverageMode,
        coverage: retentionGapCoverage(input.providerWindowStart),
        ledgerRevision: nextLedgerRevision,
      };
    }),
    recordGitHubScanPage: vi.fn(async (value: unknown) => {
      const input = value as {
        scanId: string;
        nextCursor: string | null;
        attempts: readonly unknown[];
        leaseExpiresAt: string;
      };
      return {
        status: 'recorded',
        generation: 1,
        scanId: input.scanId,
        pageCount: 1,
        attemptCount: input.attempts.length,
        nextCursor: input.nextCursor,
        leaseExpiresAt: input.leaseExpiresAt,
        ledgerRevision: nextLedgerRevision,
      };
    }),
    completeGitHubScan: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string };
      return {
        status: 'completed',
        generation: 1,
        scanId: input.scanId,
        checkpoint: now,
        pageCount: 1,
        attemptCount: 1,
        coverage: retentionGapCoverage(),
        ledgerRevision: nextLedgerRevision,
      };
    }),
    nextGitHubRedelivery: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string };
      return {
        status: 'complete',
        generation: 1,
        scanId: input.scanId,
        ledgerRevision: nextLedgerRevision,
      };
    }),
    recordGitHubRedeliveryAccepted: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string; intentId: string };
      return {
        status: 'recorded',
        generation: 1,
        scanId: input.scanId,
        intentId: input.intentId,
        state: 'accepted',
        ledgerRevision: nextLedgerRevision,
      };
    }),
    recordGitHubRedeliveryUnknown: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string; intentId: string };
      return {
        status: 'recorded',
        generation: 1,
        scanId: input.scanId,
        intentId: input.intentId,
        state: 'unknown',
        ledgerRevision: nextLedgerRevision,
      };
    }),
    recordGitHubRedeliveryDeferred: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string; intentId: string };
      return {
        status: 'recorded',
        generation: 1,
        scanId: input.scanId,
        intentId: input.intentId,
        state: 'deferred',
        ledgerRevision: nextLedgerRevision,
      };
    }),
    recordGitHubRedeliveryRejected: vi.fn(async (value: unknown) => {
      const input = value as { scanId: string; intentId: string };
      return {
        status: 'recorded',
        generation: 1,
        scanId: input.scanId,
        intentId: input.intentId,
        state: 'rejected',
        ledgerRevision: nextLedgerRevision,
      };
    }),
    inspectGitHubScan: vi.fn(async () => githubInspection()),
    ...overrides,
  } as unknown as DeliveryRecoveryLedgerStub;
}

function runtime(
  stub: DeliveryRecoveryLedgerStub,
  options: {
    readonly control?: DeliveryRecoveryEnv['CONTROL']['fetch'];
    readonly send?: DeliveryRecoveryEnv['EVENT_QUEUE']['send'];
    readonly access?: DeliveryRecoveryDependencies['verifyAccess'];
    readonly now?: DeliveryRecoveryDependencies['now'];
  } = {},
) {
  const control = options.control ?? vi.fn(async () =>
    new Response(null, { status: 503 }));
  const send = options.send ?? vi.fn(async () => undefined);
  const env: DeliveryRecoveryEnv = {
    DELIVERY_RECOVERY_LEDGER: {
      getByName: vi.fn(() => stub),
    },
    CONTROL: { fetch: control },
    EVENT_QUEUE: { send },
    RECOVERY_CONTROL_SHARED_SECRET: recoveryControlSharedSecret,
  };
  const defaultAccess: DeliveryRecoveryDependencies['verifyAccess'] =
    async () => ({
      decision: 'authorized',
      principal: { type: 'service', clientId: 'service-client-id' },
    });
  const dependencies: DeliveryRecoveryDependencies = {
    now: options.now ?? (() => new Date(now)),
    verifyAccess: options.access ?? defaultAccess,
  };
  return {
    handler: createDeliveryRecoveryHandler(dependencies),
    env,
    control,
    send,
  };
}

function scopeWorkItem(): string {
  return canonicalStewardRuntimeScopeWorkItemJson({
    schemaVersion: 1,
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145952003,
      repositoryId: 1187527897,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: 'delivery-id',
      event: 'repository',
      action: 'renamed',
      receivedAt: now,
    },
  });
}

describe('Delivery Recovery Worker', () => {
  it('authorizes before reading the request body', async () => {
    const stub = ledgerStub();
    const deniedAccess: DeliveryRecoveryDependencies['verifyAccess'] =
      async () => ({ decision: 'denied' });
    const current = runtime(stub, {
      access: deniedAccess,
    });
    const request = publicRequest('{not-json');
    const response = await current.handler.fetch(request, current.env);

    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(stub.inspect).not.toHaveBeenCalled();
  });

  it('captures and acknowledges an exact canonical DLQ body durably', async () => {
    const stub = ledgerStub();
    const current = runtime(stub);
    const ack = vi.fn();
    const retry = vi.fn();
    const body = scopeWorkItem();

    await current.handler.queue({
      queue: 'steward-events-dlq',
      messages: [{
        id: 'queue-message-id',
        timestamp: new Date(now),
        body,
        attempts: 4,
        ack,
        retry,
      }],
    }, current.env);

    expect(stub.captureDlq).toHaveBeenCalledWith(expect.objectContaining({
      body,
      eligible: true,
      envelopeKind: 'scope-work-item-v1',
      sourceQueue: 'steward-events-dlq',
      sourceMessageId: 'queue-message-id',
      sourceTimestamp: now,
      attempts: 4,
      capturedAt: now,
    }));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not acknowledge before a durable capture succeeds', async () => {
    const stub = ledgerStub({
      captureDlq: vi.fn(async () => {
        throw new Error('DO unavailable');
      }),
    });
    const current = runtime(stub);
    const ack = vi.fn();
    const retry = vi.fn();

    await current.handler.queue({
      queue: 'steward-events-dlq',
      messages: [{
        id: 'queue-message-id',
        timestamp: new Date(now),
        body: scopeWorkItem(),
        attempts: 4,
        ack,
        retry,
      }],
    }, current.env);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('replays the exact captured bytes and settles only after Queue send', async () => {
    const body = scopeWorkItem();
    const nextReplay = vi.fn()
      .mockResolvedValueOnce({
        status: 'ready',
        commandId: requestId,
        entryId,
        bodyDigest: entryId,
        body,
        envelopeKind: 'scope-work-item-v1',
        replayCount: 1,
        ledgerRevision: nextLedgerRevision,
      })
      .mockResolvedValueOnce({
        status: 'complete',
        commandId: requestId,
        ledgerRevision: nextLedgerRevision,
      });
    const stub = ledgerStub({ nextReplay });
    const current = runtime(stub);
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'replay-dlq',
      expectedLedgerRevision: initialLedgerRevision,
      entryIds: [entryId],
    })), current.env);

    expect(response.status).toBe(200);
    expect(current.send).toHaveBeenCalledWith(body, {
      contentType: 'text',
    });
    expect(stub.recordReplayEnqueued).toHaveBeenCalledTimes(1);
    expect(stub.recordReplayUnknown).not.toHaveBeenCalled();
  });

  it('records an uncertain Queue send and never reports replay success', async () => {
    const body = scopeWorkItem();
    const stub = ledgerStub({
      nextReplay: vi.fn(async () => ({
        status: 'ready',
        commandId: requestId,
        entryId,
        bodyDigest: entryId,
        body,
        envelopeKind: 'scope-work-item-v1',
        replayCount: 1,
        ledgerRevision: nextLedgerRevision,
      })),
    });
    const current = runtime(stub, {
      send: vi.fn(async () => {
        throw new Error('response lost after durable send');
      }),
    });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'replay-dlq',
      expectedLedgerRevision: initialLedgerRevision,
      entryIds: [entryId],
    })), current.env);

    expect(response.status).toBe(503);
    expect(stub.recordReplayUnknown).toHaveBeenCalledTimes(1);
    expect(stub.recordReplayEnqueued).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledTimes(1);
  });

  it('keeps inspection read-only and excludes replay bodies', async () => {
    const stub = ledgerStub({
      inspect: vi.fn(async () => ({
        ...inspection(),
        counts: {
          ...inspection().counts,
          pending: 1,
        },
        entries: [{
          entryId,
          bodyDigest: entryId,
          byteLength: 100,
          envelopeKind: 'scope-work-item-v1',
          deliveryId: 'delivery-id',
          repositoryId: 1187527897,
          pullRequestNumber: null,
          quarantineReason: null,
          state: 'pending',
          cycleCount: 1,
          replayCount: 0,
          firstCapturedAt: now,
          lastCapturedAt: now,
          latestSource: {
            queue: 'steward-events-dlq',
            messageId: 'message-id',
            timestamp: now,
            attempts: 4,
          },
        }],
      })),
    });
    const current = runtime(stub);
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'inspect',
    })), current.env);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain('"body"');
    expect(stub.inspect).toHaveBeenCalledWith(100);
    expect(stub.inspectGitHubScan).toHaveBeenCalledTimes(1);
  });

  it('persists each GitHub page before requesting redelivery', async () => {
    const failedAttempt = {
      id: 41,
      guid: 'delivery-guid',
      deliveredAt: '2026-07-27T00:50:00.000Z',
      redelivery: false,
      status: 'Failed to connect',
      statusCode: 0,
      installationId: 7,
      repositoryId: 9,
      event: 'pull_request',
      action: 'opened',
    };
    const stub = ledgerStub();
    let scanId = '';
    vi.mocked(stub.nextGitHubRedelivery)
      .mockImplementationOnce(async (value: unknown) => {
        scanId = (value as { scanId: string }).scanId;
        return {
          status: 'ready',
          generation: 1,
          scanId,
          intentId: '44444444-4444-4444-8444-444444444444',
          guid: failedAttempt.guid,
          deliveryAttemptId: failedAttempt.id,
          redeliveryCount: 1,
          ledgerRevision: nextLedgerRevision,
        };
      })
      .mockImplementationOnce(async () => ({
        status: 'complete',
        generation: 1,
        scanId,
        ledgerRevision: nextLedgerRevision,
      }));
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const signedBody = await request.clone().text();
      expect(request.headers.get(
        'x-steward-recovery-capability-timestamp',
      )).toBe(now);
      expect(request.headers.get(
        'x-steward-recovery-capability-nonce',
      )).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(request.headers.get(
        'x-steward-recovery-capability-signature',
      )).toBe(await expectedControlSignature(request, signedBody));
      if (new URL(request.url).pathname.endsWith('/page')) {
        const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
          await request.json(),
        );
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
              scanId: parsed.scanId,
              cursor: parsed.cursor,
              attempts: [failedAttempt],
              nextCursor: null,
              controlRevision: revision,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
      expect(stub.recordGitHubScanPage).toHaveBeenCalledTimes(1);
      expect(stub.completeGitHubScan).toHaveBeenCalledTimes(1);
      const parsed =
        parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
          await request.json(),
        );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
            scanId: parsed.scanId,
            intentId: parsed.intentId,
            attemptId: parsed.attemptId,
            guid: parsed.guid,
            controlRevision: revision,
          }),
        ),
        {
          status: 202,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    });
    const current = runtime(stub, { control });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      requestedAt: '2026-07-27T01:01:30.000Z',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(response.status).toBe(200);
    expect(control).toHaveBeenCalledTimes(2);
    expect(stub.recordGitHubRedeliveryAccepted).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubRedeliveryUnknown).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      state: 'complete-with-retention-gap',
      actionRequired: true,
      redeliveriesAccepted: 1,
      coverage: retentionGapCoverage(),
    });
  });

  it('resumes one stable scan with fresh trusted time metadata and the original lease', async () => {
    let clock = new Date(now);
    const beginInputs: Array<{
      scanId: string;
      requestedAt: string;
      scanStartedAt: string;
      leaseExpiresAt: string;
      providerWindowStart: string;
      coverageMode: 'continue' | 'establish';
    }> = [];
    const coverage = retentionGapCoverage();
    const beginGitHubScan = vi.fn(async (value: unknown) => {
      const input = value as typeof beginInputs[number];
      beginInputs.push(input);
      return {
        status: beginInputs.length === 1
          ? 'begun' as const
          : 'resumed' as const,
        generation: 1,
        scanId: input.scanId,
        cursor: null,
        pageCount: 0,
        attemptCount: 0,
        checkpointBefore: null,
        // The ledger owns the active lease. A refreshed public command may
        // carry new trusted timestamps but must resume with this old fence.
        leaseExpiresAt: scanLeaseExpiresAt,
        coverageMode: 'establish' as const,
        coverage,
        ledgerRevision: nextLedgerRevision,
      };
    });
    const stub = ledgerStub({ beginGitHubScan });
    let controlCall = 0;
    const control = vi.fn(async (input: Request | string | URL) => {
      controlCall += 1;
      if (controlCall === 1) {
        return new Response(
          JSON.stringify({ error: 'delivery-recovery-unavailable' }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      const request = input instanceof Request ? input : new Request(input);
      const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
        await request.json(),
      );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
            scanId: parsed.scanId,
            cursor: parsed.cursor,
            attempts: [],
            nextCursor: null,
            controlRevision: revision,
          }),
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    });
    const current = runtime(stub, {
      control,
      now: () => new Date(clock),
    });
    const first = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      requestedAt: now,
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(first.status).toBe(503);
    clock = new Date('2026-07-27T01:03:03.000Z');
    const second = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      requestedAt: '2026-07-27T01:03:03.000Z',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(second.status).toBe(200);
    expect(beginInputs).toHaveLength(2);
    expect(beginInputs[0]).toMatchObject({
      requestedAt: now,
      scanStartedAt: now,
      leaseExpiresAt: scanLeaseExpiresAt,
      providerWindowStart,
    });
    expect(beginInputs[1]).toMatchObject({
      requestedAt: '2026-07-27T01:03:03.000Z',
      scanStartedAt: '2026-07-27T01:03:03.000Z',
      leaseExpiresAt: '2026-07-27T01:13:03.000Z',
      providerWindowStart: '2026-07-24T01:18:03.000Z',
    });
    expect(beginInputs[1]?.scanId).toBe(beginInputs[0]?.scanId);
    expect(stub.recordGitHubScanPage).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: beginInputs[0]?.scanId,
        recordedAt: '2026-07-27T01:03:03.000Z',
        leaseExpiresAt: scanLeaseExpiresAt,
      }),
    );
    expect(control).toHaveBeenCalledTimes(2);
  });

  it('stops at the durable checkpoint instead of rescanning old pages', async () => {
    const checkpoint = '2026-07-27T00:30:00.900Z';
    let scanId = '';
    const recordGitHubScanPage = vi.fn(async (value: unknown) => {
      const input = value as {
        scanId: string;
        nextCursor: string | null;
        attempts: readonly { attemptId: number }[];
        leaseExpiresAt: string;
      };
      scanId = input.scanId;
      expect(input.nextCursor).toBeNull();
      expect(input.attempts.map(({ attemptId }) => attemptId)).toEqual([
        52,
        51,
      ]);
      return {
        status: 'recorded' as const,
        generation: 1,
        scanId,
        pageCount: 1,
        attemptCount: input.attempts.length,
        nextCursor: null,
        leaseExpiresAt: input.leaseExpiresAt,
        ledgerRevision: nextLedgerRevision,
      };
    });
    const stub = ledgerStub({
      beginGitHubScan: vi.fn(async (value: unknown) => {
        const input = value as {
          scanId: string;
          leaseExpiresAt: string;
          coverageMode: 'continue' | 'establish';
          providerWindowStart: string;
        };
        scanId = input.scanId;
        return {
          status: 'begun',
          generation: 1,
          scanId,
          cursor: null,
          pageCount: 0,
          attemptCount: 0,
          checkpointBefore: checkpoint,
          leaseExpiresAt: input.leaseExpiresAt,
          coverageMode: input.coverageMode,
          coverage: retainedCoverage(
            checkpoint,
            input.providerWindowStart,
          ),
          ledgerRevision: nextLedgerRevision,
        };
      }),
      recordGitHubScanPage,
      nextGitHubRedelivery: vi.fn(async () => ({
        status: 'complete',
        generation: 1,
        scanId,
        ledgerRevision: nextLedgerRevision,
      })),
    });
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
        await request.json(),
      );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
            scanId: parsed.scanId,
            cursor: parsed.cursor,
            attempts: [
              {
                id: 52,
                guid: 'new-guid',
                deliveredAt: '2026-07-27T00:31:00.000Z',
                redelivery: false,
                status: 'OK',
                statusCode: 200,
                installationId: null,
                repositoryId: null,
                event: 'ping',
                action: null,
              },
              {
                id: 51,
                guid: 'same-provider-second-guid',
                deliveredAt: '2026-07-27T00:30:00.000Z',
                redelivery: false,
                status: 'OK',
                statusCode: 200,
                installationId: null,
                repositoryId: null,
                event: 'ping',
                action: null,
              },
              {
                id: 50,
                guid: 'old-guid',
                deliveredAt: '2026-07-27T00:29:59.000Z',
                redelivery: false,
                status: 'OK',
                statusCode: 200,
                installationId: null,
                repositoryId: null,
                event: 'ping',
                action: null,
              },
            ],
            nextCursor: 'older-page',
            controlRevision: revision,
          }),
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    });
    const current = runtime(stub, { control });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      expectedControlRevision: revision,
      coverageMode: 'continue',
      takeover: false,
    })), current.env);

    expect(response.status).toBe(200);
    expect(control).toHaveBeenCalledTimes(1);
    expect(recordGitHubScanPage).toHaveBeenCalledTimes(1);
    expect(stub.completeGitHubScan).toHaveBeenCalledTimes(1);
  });

  it('clips establish scans at provider retention and valid scans at their checkpoint', async () => {
    const validCheckpoint = '2026-07-27T00:30:00.900Z';
    const historicalCoverageFrom = '2026-07-24T00:00:00.000Z';
    const scenarios = [
      {
        name: 'missing checkpoint',
        coverageMode: 'establish' as const,
        checkpointBefore: null,
        coverage: retentionGapCoverage(),
        boundary: providerWindowStart,
        older: '2026-07-24T01:17:02.000Z',
      },
      {
        name: 'expired checkpoint',
        coverageMode: 'establish' as const,
        checkpointBefore: '2026-07-24T01:17:02.000Z',
        coverage: {
          status: 'retention-gap' as const,
          coverageFrom: providerWindowStart,
          providerWindowStart,
          gap: {
            reason: 'provider-retention' as const,
            from: '2026-07-24T01:17:02.000Z',
            to: providerWindowStart,
          },
        },
        boundary: providerWindowStart,
        older: '2026-07-24T01:17:02.000Z',
      },
      {
        name: 'valid checkpoint with a historical gap',
        coverageMode: 'continue' as const,
        checkpointBefore: validCheckpoint,
        coverage: {
          status: 'retention-gap' as const,
          coverageFrom: historicalCoverageFrom,
          providerWindowStart,
          gap: {
            reason: 'checkpoint-missing' as const,
            from: null,
            to: historicalCoverageFrom,
          },
        },
        boundary: '2026-07-27T00:30:00.000Z',
        older: '2026-07-27T00:29:59.000Z',
      },
    ];

    for (const scenario of scenarios) {
      let scanId = '';
      const recordGitHubScanPage = vi.fn(async (value: unknown) => {
        const input = value as {
          scanId: string;
          nextCursor: string | null;
          attempts: readonly { attemptId: number }[];
          leaseExpiresAt: string;
        };
        expect(
          input.attempts.map(({ attemptId }) => attemptId),
          scenario.name,
        ).toEqual([302]);
        expect(input.nextCursor, scenario.name).toBeNull();
        return {
          status: 'recorded' as const,
          generation: 1,
          scanId: input.scanId,
          pageCount: 1,
          attemptCount: input.attempts.length,
          nextCursor: input.nextCursor,
          leaseExpiresAt: input.leaseExpiresAt,
          ledgerRevision: nextLedgerRevision,
        };
      });
      const stub = ledgerStub({
        beginGitHubScan: vi.fn(async (value: unknown) => {
          const input = value as {
            scanId: string;
            leaseExpiresAt: string;
          };
          scanId = input.scanId;
          return {
            status: 'begun' as const,
            generation: 1,
            scanId,
            cursor: null,
            pageCount: 0,
            attemptCount: 0,
            checkpointBefore: scenario.checkpointBefore,
            leaseExpiresAt: input.leaseExpiresAt,
            coverageMode: scenario.coverageMode,
            coverage: scenario.coverage,
            ledgerRevision: nextLedgerRevision,
          };
        }),
        recordGitHubScanPage,
        nextGitHubRedelivery: vi.fn(async () => ({
          status: 'complete' as const,
          generation: 1,
          scanId,
          ledgerRevision: nextLedgerRevision,
        })),
      });
      const control = vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request
          ? input
          : new Request(input);
        const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
          await request.json(),
        );
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
              scanId: parsed.scanId,
              cursor: parsed.cursor,
              attempts: [
                githubAttempt(302, scenario.boundary),
                githubAttempt(301, scenario.older),
              ],
              nextCursor: 'older-page',
              controlRevision: revision,
            }),
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        );
      });
      const current = runtime(stub, { control });
      const response = await current.handler.fetch(publicRequest(command({
        operation: 'recover-github',
        expectedControlRevision: revision,
        coverageMode: scenario.coverageMode,
        takeover: false,
      })), current.env);

      expect(response.status, scenario.name).toBe(200);
      expect(control, scenario.name).toHaveBeenCalledTimes(1);
      expect(recordGitHubScanPage, scenario.name).toHaveBeenCalledTimes(1);
      expect(stub.completeGitHubScan, scenario.name).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects an out-of-order raw provider page before boundary filtering', async () => {
    const stub = ledgerStub();
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request
        ? input
        : new Request(input);
      const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
        await request.json(),
      );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
            scanId: parsed.scanId,
            cursor: parsed.cursor,
            attempts: [
              githubAttempt(401, '2026-07-24T01:17:02.000Z'),
              githubAttempt(402, providerWindowStart),
            ],
            nextCursor: 'older-page',
            controlRevision: revision,
          }),
        ),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
        },
      );
    });
    const current = runtime(stub, { control });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'delivery-recovery-unavailable',
    });
    expect(control).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubScanPage).not.toHaveBeenCalled();
    expect(stub.completeGitHubScan).not.toHaveBeenCalled();
    expect(stub.nextGitHubRedelivery).not.toHaveBeenCalled();
  });

  it('retries completion without refetching a durable terminal page', async () => {
    const scanIds: string[] = [];
    let completionCalls = 0;
    const beginGitHubScan = vi.fn(async (value: unknown) => {
      const input = value as {
        scanId: string;
        leaseExpiresAt: string;
        coverageMode: 'continue' | 'establish';
        providerWindowStart: string;
      };
      scanIds.push(input.scanId);
      const resumed = scanIds.length > 1;
      return {
        status: resumed ? 'resumed' as const : 'begun' as const,
        generation: 1,
        scanId: input.scanId,
        cursor: null,
        pageCount: resumed ? 1 : 0,
        attemptCount: 0,
        checkpointBefore: null,
        leaseExpiresAt: input.leaseExpiresAt,
        coverageMode: input.coverageMode,
        coverage: retentionGapCoverage(input.providerWindowStart),
        ledgerRevision: nextLedgerRevision,
      };
    });
    const completeGitHubScan = vi.fn(async (value: unknown) => {
      const input = value as { scanId: string };
      completionCalls += 1;
      if (completionCalls === 1) {
        throw new Error('terminal completion write failed');
      }
      return {
        status: 'completed' as const,
        generation: 1,
        scanId: input.scanId,
        checkpoint: now,
        pageCount: 1,
        attemptCount: 0,
        coverage: retentionGapCoverage(),
        ledgerRevision: nextLedgerRevision,
      };
    });
    const stub = ledgerStub({
      beginGitHubScan,
      completeGitHubScan,
    });
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request
        ? input
        : new Request(input);
      const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
        await request.json(),
      );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
            scanId: parsed.scanId,
            cursor: parsed.cursor,
            attempts: [],
            nextCursor: null,
            controlRevision: revision,
          }),
        ),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
        },
      );
    });
    const current = runtime(stub, { control });
    const body = command({
      operation: 'recover-github',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    });
    const first = await current.handler.fetch(
      publicRequest(body),
      current.env,
    );
    const second = await current.handler.fetch(
      publicRequest(body),
      current.env,
    );

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(scanIds).toHaveLength(2);
    expect(scanIds[1]).toBe(scanIds[0]);
    expect(beginGitHubScan).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubScanPage).toHaveBeenCalledTimes(1);
    expect(completeGitHubScan).toHaveBeenCalledTimes(2);
  });

  it('records an uncertain GitHub POST and does not blindly redeliver', async () => {
    let scanId = '';
    const stub = ledgerStub({
      nextGitHubRedelivery: vi.fn()
        .mockImplementationOnce(async (value: unknown) => {
          scanId = (value as { scanId: string }).scanId;
          return {
            status: 'ready',
            generation: 1,
            scanId,
            intentId: '44444444-4444-4444-8444-444444444444',
            guid: 'delivery-guid',
            deliveryAttemptId: 41,
            redeliveryCount: 1,
            ledgerRevision: nextLedgerRevision,
          };
        }),
    });
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).pathname.endsWith('/page')) {
        const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
          await request.json(),
        );
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
              scanId: parsed.scanId,
              cursor: null,
              attempts: [],
              nextCursor: null,
              controlRevision: revision,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
      throw new Error('Control response lost after GitHub accepted POST');
    });
    const current = runtime(stub, { control });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(response.status).toBe(503);
    expect(control).toHaveBeenCalledTimes(2);
    expect(stub.recordGitHubRedeliveryUnknown).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubRedeliveryAccepted).not.toHaveBeenCalled();
  });

  it('keeps unresolved mutations observable and rejected outcomes action-required', async () => {
    const scenarios = [
      {
        state: 'dispatching' as const,
        expectedStatus: 202,
        expectedState: 'redelivery-awaiting-observation',
      },
      {
        state: 'accepted' as const,
        expectedStatus: 202,
        expectedState: 'redelivery-awaiting-observation',
      },
      {
        state: 'unknown' as const,
        expectedStatus: 202,
        expectedState: 'redelivery-awaiting-observation',
      },
      {
        state: 'rejected' as const,
        expectedStatus: 409,
        expectedState: 'redelivery-action-required',
      },
    ];

    for (const scenario of scenarios) {
      const counts = {
        ...emptyRedeliveryIntents(),
        [scenario.state]: 1,
        total: 1,
      };
      const beginGitHubScan = vi.fn(async (value: unknown) => {
        const input = value as {
          scanId: string;
          leaseExpiresAt: string;
          coverageMode: 'continue' | 'establish';
          providerWindowStart: string;
        };
        return {
          status: 'completed' as const,
          generation: 1,
          scanId: input.scanId,
          cursor: null,
          pageCount: 1,
          attemptCount: 1,
          checkpointBefore: null,
          leaseExpiresAt: input.leaseExpiresAt,
          coverageMode: input.coverageMode,
          coverage: retentionGapCoverage(input.providerWindowStart),
          ledgerRevision: nextLedgerRevision,
        };
      });
      const nextGitHubRedelivery = vi.fn(async (value: unknown) => {
        const input = value as { scanId: string };
        return {
          status: 'unresolved' as const,
          generation: 1,
          scanId: input.scanId,
          counts,
          ledgerRevision: nextLedgerRevision,
        };
      });
      const stub = ledgerStub({
        beginGitHubScan,
        nextGitHubRedelivery,
      });
      const current = runtime(stub);
      const response = await current.handler.fetch(publicRequest(command({
        operation: 'recover-github',
        expectedControlRevision: revision,
        coverageMode: 'establish',
        takeover: false,
      })), current.env);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status, scenario.state).toBe(
        scenario.expectedStatus,
      );
      expect(body, scenario.state).toMatchObject({
        state: scenario.expectedState,
        counts,
      });
      if (scenario.state === 'rejected') {
        expect(body.error).toBe(
          'github-redelivery-reconciliation-required',
        );
      } else {
        expect(body).not.toHaveProperty('error');
      }
      expect(current.control, scenario.state).not.toHaveBeenCalled();
      expect(nextGitHubRedelivery).toHaveBeenCalledTimes(1);
    }
  });

  it('maps ledger domain conflicts to 409 and generic begin failures to 503', async () => {
    const scenarios = [
      {
        error: new DeliveryRecoveryConflictError(
          'active-scan-conflict',
          'another scan owns the lease',
        ),
        expectedStatus: 409,
        expectedBody: {
          error: 'github-delivery-scan-conflict',
          reason: 'active-scan-conflict',
        },
      },
      {
        error: new Error('Durable Object unavailable'),
        expectedStatus: 503,
        expectedBody: {
          error: 'delivery-recovery-unavailable',
        },
      },
    ];

    for (const scenario of scenarios) {
      const stub = ledgerStub({
        beginGitHubScan: vi.fn(async () => {
          throw scenario.error;
        }),
      });
      const current = runtime(stub);
      const response = await current.handler.fetch(publicRequest(command({
        operation: 'recover-github',
        expectedControlRevision: revision,
        coverageMode: 'establish',
        takeover: false,
      })), current.env);

      expect(response.status).toBe(scenario.expectedStatus);
      await expect(response.json()).resolves.toMatchObject(
        scenario.expectedBody,
      );
      expect(current.control).not.toHaveBeenCalled();
    }
  });

  it('returns 503 after accepted-outcome persistence fails and sends one POST only', async () => {
    const intentId = '44444444-4444-4444-8444-444444444444';
    let scanId = '';
    const beginGitHubScan = vi.fn(async (value: unknown) => {
      const input = value as {
        scanId: string;
        leaseExpiresAt: string;
        coverageMode: 'continue' | 'establish';
        providerWindowStart: string;
      };
      scanId = input.scanId;
      return {
        status: 'completed' as const,
        generation: 1,
        scanId,
        cursor: null,
        pageCount: 1,
        attemptCount: 1,
        checkpointBefore: null,
        leaseExpiresAt: input.leaseExpiresAt,
        coverageMode: input.coverageMode,
        coverage: retentionGapCoverage(input.providerWindowStart),
        ledgerRevision: nextLedgerRevision,
      };
    });
    const nextGitHubRedelivery = vi.fn(async () => ({
      status: 'ready' as const,
      generation: 1,
      scanId,
      intentId,
      guid: 'delivery-guid',
      deliveryAttemptId: 41,
      redeliveryCount: 1,
      ledgerRevision: nextLedgerRevision,
    }));
    const recordGitHubRedeliveryAccepted = vi.fn(async () => {
      throw new Error('accepted outcome write failed');
    });
    const stub = ledgerStub({
      beginGitHubScan,
      nextGitHubRedelivery,
      recordGitHubRedeliveryAccepted,
    });
    const control = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe(
        '/v1/delivery-recovery/github/redeliver',
      );
      const parsed =
        parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
          await request.json(),
        );
      return new Response(
        canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(
          buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
            scanId: parsed.scanId,
            intentId: parsed.intentId,
            attemptId: parsed.attemptId,
            guid: parsed.guid,
            controlRevision: revision,
          }),
        ),
        {
          status: 202,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    });
    const current = runtime(stub, { control });
    const response = await current.handler.fetch(publicRequest(command({
      operation: 'recover-github',
      expectedControlRevision: revision,
      coverageMode: 'establish',
      takeover: false,
    })), current.env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'delivery-recovery-unavailable',
    });
    expect(control).toHaveBeenCalledTimes(1);
    expect(nextGitHubRedelivery).toHaveBeenCalledTimes(1);
    expect(recordGitHubRedeliveryAccepted).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubRedeliveryUnknown).not.toHaveBeenCalled();
  });

  it('cancels an in-flight private Control request with the caller', async () => {
    let controlStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      controlStarted = resolve;
    });
    const delegatedSignals: AbortSignal[] = [];
    const control = vi.fn((
      _input: Request | string | URL,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      const delegatedSignal = init?.signal ?? null;
      expect(delegatedSignal).not.toBeNull();
      if (delegatedSignal) delegatedSignals.push(delegatedSignal);
      controlStarted();
      if (delegatedSignal?.aborted) {
        reject(delegatedSignal.reason);
        return;
      }
      delegatedSignal?.addEventListener(
        'abort',
        () => reject(delegatedSignal?.reason),
        { once: true },
      );
    }));
    const stub = ledgerStub();
    const current = runtime(stub, { control });
    const controller = new AbortController();
    const pending = current.handler.fetch(
      publicRequest(command({
        operation: 'recover-github',
        expectedControlRevision: revision,
        coverageMode: 'establish',
        takeover: false,
      }), controller.signal),
      current.env,
    );
    await started;
    controller.abort(new Error('operator disconnected'));
    const response = await pending;

    expect(response.status).toBe(503);
    expect(delegatedSignals).toHaveLength(1);
    expect(delegatedSignals[0]?.aborted).toBe(true);
    expect(control).toHaveBeenCalledTimes(1);
    expect(stub.recordGitHubRedeliveryUnknown).not.toHaveBeenCalled();
  });

  it('persists definite Control outcomes without poisoning them as unknown', async () => {
    const scenarios = [
      {
        name: 'rate limit',
        response: () => new Response(
          JSON.stringify({ error: 'github-rate-limited' }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '12',
            },
          },
        ),
        expectedStatus: 429,
        expectedMethod: 'deferred' as const,
        expectedOutcome: {
          reason: 'rate-limited',
          retryAfter: '2026-07-27T01:02:15.000Z',
        },
      },
      {
        name: 'revision conflict',
        response: () => new Response(
          JSON.stringify({ error: 'control-revision-mismatch' }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
        expectedStatus: 409,
        expectedMethod: 'deferred' as const,
        expectedOutcome: {
          reason: 'control-revision-conflict',
          retryAfter: '2026-07-27T01:03:03.000Z',
        },
      },
      {
        name: 'provider rejection',
        response: () => new Response(
          JSON.stringify({ error: 'github-redelivery-rejected' }),
          {
            status: 422,
            headers: { 'content-type': 'application/json' },
          },
        ),
        expectedStatus: 422,
        expectedMethod: 'rejected' as const,
        expectedOutcome: { reason: 'provider-rejected' },
      },
      {
        name: 'Control unavailable before I/O',
        response: () => new Response(
          JSON.stringify({
            error: 'github-redelivery-control-unavailable',
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        ),
        expectedStatus: 503,
        expectedMethod: 'deferred' as const,
        expectedOutcome: {
          reason: 'control-unavailable',
          retryAfter: '2026-07-27T01:03:03.000Z',
        },
      },
      {
        name: 'Control route unavailable before I/O',
        response: () => new Response('Not Found', { status: 404 }),
        expectedStatus: 503,
        expectedMethod: 'deferred' as const,
        expectedOutcome: {
          reason: 'control-unavailable',
          retryAfter: '2026-07-27T01:03:03.000Z',
        },
      },
      {
        name: 'provider 5xx from an older Control revision',
        response: () => new Response(
          JSON.stringify({
            error: 'github-redelivery-provider-unavailable',
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        ),
        expectedStatus: 503,
        expectedMethod: 'unknown' as const,
        expectedOutcome: {},
      },
    ];

    for (const scenario of scenarios) {
      let scanId = '';
      const stub = ledgerStub({
        nextGitHubRedelivery: vi.fn()
          .mockImplementationOnce(async (value: unknown) => {
            scanId = (value as { scanId: string }).scanId;
            return {
              status: 'ready',
              generation: 1,
              scanId,
              intentId: '44444444-4444-4444-8444-444444444444',
              guid: 'delivery-guid',
              deliveryAttemptId: 41,
              redeliveryCount: 1,
              ledgerRevision: nextLedgerRevision,
            };
          }),
      });
      const control = vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request
          ? input
          : new Request(input);
        if (new URL(request.url).pathname.endsWith('/page')) {
          const parsed = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
            await request.json(),
          );
          return new Response(
            canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
              buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
                scanId: parsed.scanId,
                cursor: null,
                attempts: [],
                nextCursor: null,
                controlRevision: revision,
              }),
            ),
            {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
              },
            },
          );
        }
        return scenario.response();
      });
      const current = runtime(stub, { control });
      const response = await current.handler.fetch(
        publicRequest(command({
          operation: 'recover-github',
          expectedControlRevision: revision,
          coverageMode: 'establish',
          takeover: false,
        })),
        current.env,
      );

      expect(response.status, scenario.name).toBe(
        scenario.expectedStatus,
      );
      if (scenario.expectedMethod === 'deferred') {
        expect(
          stub.recordGitHubRedeliveryDeferred,
          scenario.name,
        ).toHaveBeenCalledWith(expect.objectContaining({
          intentId: '44444444-4444-4444-8444-444444444444',
          ...scenario.expectedOutcome,
        }));
        expect(stub.recordGitHubRedeliveryRejected).not.toHaveBeenCalled();
      } else if (scenario.expectedMethod === 'rejected') {
        expect(
          stub.recordGitHubRedeliveryRejected,
          scenario.name,
        ).toHaveBeenCalledWith(expect.objectContaining({
          intentId: '44444444-4444-4444-8444-444444444444',
          ...scenario.expectedOutcome,
        }));
        expect(stub.recordGitHubRedeliveryDeferred).not.toHaveBeenCalled();
      } else {
        expect(
          stub.recordGitHubRedeliveryUnknown,
          scenario.name,
        ).toHaveBeenCalledWith(expect.objectContaining({
          intentId: '44444444-4444-4444-8444-444444444444',
        }));
        expect(stub.recordGitHubRedeliveryDeferred).not.toHaveBeenCalled();
        expect(stub.recordGitHubRedeliveryRejected).not.toHaveBeenCalled();
      }
      if (scenario.expectedMethod !== 'unknown') {
        expect(stub.recordGitHubRedeliveryUnknown).not.toHaveBeenCalled();
      }
      expect(stub.recordGitHubRedeliveryAccepted).not.toHaveBeenCalled();
    }
  });
});
