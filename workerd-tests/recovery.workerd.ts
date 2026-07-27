import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  buildStewardRuntimeDeliveryRecoveryPageReceiptV1,
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  buildStewardRuntimeScopeWorkItemV1,
  canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeWorkItemJson,
  deriveStewardRuntimeFanoutDeliveryId,
  parseStewardRuntimeDeliveryRecoveryPageRequestV1,
  parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  parseStewardRuntimeRepositoryFanoutPageRequestV1,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeWorkItemV1,
} from '../packages/core/src/index.js';
import {
  PullRequestCoordinator,
  RepositoryFanoutCoordinator,
  pullRequestCoordinatorName,
  repositoryFanoutCoordinatorName,
  type CoordinatorEnv,
} from '../packages/coordinator/src/index.js';
import coordinatorWorker from '../packages/coordinator/src/worker.js';
import {
  deliveryRecoveryLedgerName,
  type DeliveryRecoveryInspection,
} from '../packages/recovery/src/ledger-contracts.js';
import { DeliveryRecoveryLedger } from '../packages/recovery/src/ledger.js';
import {
  createDeliveryRecoveryHandler,
  type DeliveryRecoveryEnv,
  type DeliveryRecoveryEventQueue,
} from '../packages/recovery/src/worker.js';

interface RecoveryWorkerdEnv {
  DELIVERY_RECOVERY_LEDGER:
    DurableObjectNamespace<DeliveryRecoveryLedger>;
  PR_COORDINATOR: DurableObjectNamespace<PullRequestCoordinator>;
  REPOSITORY_FANOUT_COORDINATOR:
    DurableObjectNamespace<RepositoryFanoutCoordinator>;
}

const workerdEnv = env as unknown as RecoveryWorkerdEnv;
const recoveryNow = new Date('2026-07-27T08:00:00.000Z');
const accessAssertion = 'workerd-recovery-access-assertion';
const accessClientId = 'steward-recovery-workerd-client';
const recoveryControlSharedSecret =
  'workerd-recovery-control-shared-secret-0001';
const controlRevision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
} as const;

function recoveryHandler(
  now: () => Date = () => recoveryNow,
) {
  return createDeliveryRecoveryHandler({
    now,
    verifyAccess: async (request) => (
      request.headers.get('cf-access-jwt-assertion') === accessAssertion
        ? {
            decision: 'authorized',
            principal: {
              type: 'service',
              clientId: accessClientId,
            },
          } as const
        : { decision: 'denied' } as const
    ),
  });
}

function recoveryEnv(
  eventQueue: DeliveryRecoveryEventQueue,
  control: DeliveryRecoveryEnv['CONTROL']['fetch'] = async () =>
    new Response('Not Found', { status: 404 }),
): DeliveryRecoveryEnv {
  return {
    DELIVERY_RECOVERY_LEDGER:
      workerdEnv.DELIVERY_RECOVERY_LEDGER as unknown as
        DeliveryRecoveryEnv['DELIVERY_RECOVERY_LEDGER'],
    CONTROL: { fetch: control },
    EVENT_QUEUE: eventQueue,
    RECOVERY_CONTROL_SHARED_SECRET: recoveryControlSharedSecret,
  };
}

function recoveryRequest(
  body: Record<string, unknown>,
  authenticated = true,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authenticated) {
    headers.set('cf-access-jwt-assertion', accessAssertion);
  }
  return new Request('https://recovery.example.test/v1/recovery', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function recoveryControlHmacHex(message: string): Promise<string> {
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

async function signedRecoveryControlRequest(
  input: Request | string | URL,
): Promise<{ readonly path: string; readonly body: unknown }> {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  const bodyText = await request.text();
  const timestamp = request.headers.get(
    'x-steward-recovery-capability-timestamp',
  );
  const nonce = request.headers.get(
    'x-steward-recovery-capability-nonce',
  );
  const signature = request.headers.get(
    'x-steward-recovery-capability-signature',
  );
  expect(request.method).toBe('POST');
  expect(request.headers.get('x-steward-internal-protocol')).toBe(
    'delivery-recovery-1',
  );
  expect(timestamp).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  expect(nonce).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const expected = await recoveryControlHmacHex([
    'steward-recovery-control-v1',
    request.method,
    url.pathname,
    await sha256Hex(bodyText),
    timestamp,
    nonce,
    controlRevision.stewardCommit,
    controlRevision.workerVersionId,
    controlRevision.workerVersionTag,
    controlRevision.workerVersionCreatedAt,
  ].join('\n'));
  expect(signature).toBe(expected);
  return {
    path: url.pathname,
    body: JSON.parse(bodyText) as unknown,
  };
}

function ledger() {
  return workerdEnv.DELIVERY_RECOVERY_LEDGER.getByName(
    deliveryRecoveryLedgerName,
  );
}

async function queueResult(
  queue: string,
  id: string,
  body: string,
  attempts: number,
  processor: (
    batch: ReturnType<typeof createMessageBatch>,
  ) => Promise<void>,
) {
  const batch = createMessageBatch(queue, [{
    id,
    timestamp: recoveryNow,
    attempts,
    body,
  }]);
  await processor(batch);
  return await getQueueResult(batch, createExecutionContext());
}

describe('Delivery Recovery in workerd', () => {
  it('recovers retry-exhausted repository fan-out without assuming Queue send confirmation', async () => {
    const repositoryId = 1_298_587_611;
    const repositoryFullName = 'splrad/recovery-workerd';
    const pullRequestNumber = 41;
    const scopeWorkItem = buildStewardRuntimeScopeWorkItemV1({
      operation: 'scope-reconcile',
      target: {
        scope: 'repository',
        mode: 'refresh',
        installationId: 145_952_003,
        repositoryId,
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: 'recovery-workerd-root',
        event: 'repository',
        action: 'edited',
        receivedAt: '2026-07-27T07:55:00.000Z',
      },
    });
    const canonicalScopeBody =
      canonicalStewardRuntimeScopeWorkItemJson(scopeWorkItem);
    const failedControl = vi.fn(async () =>
      new Response('unavailable', {
        status: 503,
        headers: { 'retry-after': '5' },
      }));
    const failedCoordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR:
        workerdEnv.PR_COORDINATOR as unknown as
          CoordinatorEnv['PR_COORDINATOR'],
      REPOSITORY_FANOUT_COORDINATOR:
        workerdEnv.REPOSITORY_FANOUT_COORDINATOR as unknown as
          CoordinatorEnv['REPOSITORY_FANOUT_COORDINATOR'],
      CONTROL: { fetch: failedControl },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
        sendBatch: vi.fn().mockResolvedValue(undefined),
      },
    };

    // The production consumer has max_retries=3: the original attempt plus
    // three retries are the four executions before Cloudflare routes to DLQ.
    for (let attempts = 1; attempts <= 4; attempts += 1) {
      const result = await queueResult(
        'steward-events',
        'retry-exhausted-scope',
        canonicalScopeBody,
        attempts,
        (batch) => coordinatorWorker.queue(
          batch,
          failedCoordinatorEnv,
        ),
      );
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages).toEqual([
        { msgId: 'retry-exhausted-scope' },
      ]);
    }
    expect(failedControl).toHaveBeenCalledTimes(4);

    const repositoryStub =
      workerdEnv.REPOSITORY_FANOUT_COORDINATOR.getByName(
        repositoryFanoutCoordinatorName(repositoryId),
      );
    expect(await repositoryStub.snapshot()).toMatchObject({
      completedDeliveryCount: 0,
      pendingDeliveryCount: 1,
      dirty: false,
    });

    const handler = recoveryHandler();
    const responseLostBodies: string[] = [];
    const responseLostQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn(async (body, options) => {
        expect(options).toEqual({ contentType: 'text' });
        responseLostBodies.push(body);
        throw new Error('queue-confirmation-response-lost');
      }),
    };
    const dlqResult = await queueResult(
      'steward-events-dlq',
      'retry-exhausted-scope',
      canonicalScopeBody,
      4,
      (batch) => handler.queue(
        batch,
        recoveryEnv(responseLostQueue),
      ),
    );
    expect(dlqResult.explicitAcks).toEqual(['retry-exhausted-scope']);
    expect(dlqResult.retryMessages).toEqual([]);

    const captured = await ledger().inspect(100);
    expect(captured.counts).toMatchObject({ pending: 1, unknown: 0 });
    const entry = captured.entries.find(
      (candidate) => candidate.deliveryId
        === scopeWorkItem.cause.deliveryId,
    );
    expect(entry).toMatchObject({
      bodyDigest: entry?.entryId,
      envelopeKind: 'scope-work-item-v1',
      state: 'pending',
      replayCount: 0,
      latestSource: {
        queue: 'steward-events-dlq',
        messageId: 'retry-exhausted-scope',
        attempts: 4,
      },
    });
    if (entry === undefined) throw new Error('DLQ entry was not captured.');

    const firstReplay = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'replay-dlq',
        requestId: '10000000-0000-4000-8000-000000000001',
        requestedAt: recoveryNow.toISOString(),
        expectedLedgerRevision: captured.ledgerRevision,
        entryIds: [entry.entryId],
      }),
      recoveryEnv(responseLostQueue),
    );
    expect(firstReplay.status).toBe(503);
    expect(await firstReplay.json()).toMatchObject({
      error: 'delivery-replay-result-unknown',
      entryId: entry.entryId,
    });
    expect(responseLostBodies).toEqual([canonicalScopeBody]);

    const unknown = await ledger().inspect(100);
    expect(unknown.counts).toMatchObject({ pending: 0, unknown: 1 });
    expect(unknown.entries.find(
      (candidate) => candidate.entryId === entry.entryId,
    )).toMatchObject({
      state: 'unknown',
      replayCount: 1,
    });

    const wakeupBodies: string[] = [];
    const derivedBatches: {
      readonly body: string;
      readonly contentType?: 'text';
    }[][] = [];
    const pageRequests: {
      readonly pass: 1 | 2;
      readonly cursor: string | null;
    }[] = [];
    const successfulControl = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        const request =
          parseStewardRuntimeRepositoryFanoutPageRequestV1(
            JSON.parse(String(init?.body)),
          );
        pageRequests.push({
          pass: request.binding.pass,
          cursor: request.binding.cursor,
        });
        return new Response(
          canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(
            buildStewardRuntimeRepositoryFanoutPageReceiptV1({
              binding: request.binding,
              repository: {
                state: 'live',
                id: repositoryId,
                fullName: repositoryFullName,
              },
              page: {
                totalCount: 1,
                pullRequestNumbers: [pullRequestNumber],
                hasNextPage: false,
                endCursor: null,
              },
              controlRevision,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const successfulCoordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR:
        workerdEnv.PR_COORDINATOR as unknown as
          CoordinatorEnv['PR_COORDINATOR'],
      REPOSITORY_FANOUT_COORDINATOR:
        workerdEnv.REPOSITORY_FANOUT_COORDINATOR as unknown as
          CoordinatorEnv['REPOSITORY_FANOUT_COORDINATOR'],
      CONTROL: { fetch: successfulControl },
      EVENT_QUEUE: {
        send: vi.fn(async (body: string) => {
          wakeupBodies.push(body);
        }),
        sendBatch: vi.fn(async (
          messages: readonly {
            readonly body: string;
            readonly contentType?: 'text';
          }[],
        ) => {
          derivedBatches.push(
            messages.map((message) => ({ ...message })),
          );
        }),
      },
    };

    let nextBody: string | undefined = responseLostBodies.shift();
    let invocation = 0;
    while (nextBody !== undefined) {
      const result = await queueResult(
        'steward-events',
        `accepted-after-response-loss-${invocation}`,
        nextBody,
        1,
        (batch) => coordinatorWorker.queue(
          batch,
          successfulCoordinatorEnv,
        ),
      );
      expect(result.explicitAcks).toEqual([
        `accepted-after-response-loss-${invocation}`,
      ]);
      expect(result.retryMessages).toEqual([]);
      invocation += 1;
      if (invocation > 6) {
        throw new Error('Recovered repository fan-out did not converge.');
      }
      nextBody = wakeupBodies.shift();
    }

    expect(pageRequests).toEqual([
      { pass: 1, cursor: null },
      { pass: 2, cursor: null },
    ]);
    expect(derivedBatches).toHaveLength(1);
    expect(derivedBatches[0]).toHaveLength(1);
    const derivedBody = derivedBatches[0]![0]!.body;
    const derivedWorkItem = parseStewardRuntimeWorkItem(
      JSON.parse(derivedBody),
    );
    expect(derivedWorkItem.cause.deliveryId).toBe(
      await deriveStewardRuntimeFanoutDeliveryId(
        scopeWorkItem,
        1,
        pullRequestNumber,
      ),
    );
    expect(await repositoryStub.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      pendingDeliveryCount: 0,
      dirty: false,
      targetCount: 1,
      confirmedTargetCount: 1,
    });

    const secondAcceptedBodies: string[] = [];
    const confirmedQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn(async (body, options) => {
        expect(options).toEqual({ contentType: 'text' });
        secondAcceptedBodies.push(body);
      }),
    };
    const beforeSecondReplay = await ledger().inspect(100);
    const secondReplay = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'replay-dlq',
        requestId: '10000000-0000-4000-8000-000000000002',
        requestedAt: recoveryNow.toISOString(),
        expectedLedgerRevision: beforeSecondReplay.ledgerRevision,
        entryIds: [entry.entryId],
      }),
      recoveryEnv(confirmedQueue),
    );
    expect(secondReplay.status).toBe(200);
    expect(secondAcceptedBodies).toEqual([canonicalScopeBody]);

    const callsBeforeDuplicate = successfulControl.mock.calls.length;
    const batchesBeforeDuplicate = derivedBatches.length;
    const duplicateResult = await queueResult(
      'steward-events',
      'second-explicit-replay',
      secondAcceptedBodies[0]!,
      1,
      (batch) => coordinatorWorker.queue(
        batch,
        successfulCoordinatorEnv,
      ),
    );
    expect(duplicateResult.explicitAcks).toEqual([
      'second-explicit-replay',
    ]);
    expect(duplicateResult.retryMessages).toEqual([]);
    expect(successfulControl).toHaveBeenCalledTimes(callsBeforeDuplicate);
    expect(derivedBatches).toHaveLength(batchesBeforeDuplicate);

    const pullRequestStub = workerdEnv.PR_COORDINATOR.getByName(
      pullRequestCoordinatorName(repositoryId, pullRequestNumber),
    );
    const firstChildClaim = await pullRequestStub.claim(
      derivedWorkItem.cause.deliveryId,
      60_000,
    );
    expect(firstChildClaim.status).toBe('claimed');
    if (firstChildClaim.status !== 'claimed') {
      throw new Error('Expected the derived child to be claimed.');
    }
    expect(await pullRequestStub.complete(
      firstChildClaim.generation,
      firstChildClaim.leaseToken,
    )).toMatchObject({ status: 'completed' });
    expect(await pullRequestStub.claim(
      derivedWorkItem.cause.deliveryId,
      60_000,
    )).toEqual({ status: 'duplicate' });

    const settled = await ledger().inspect(100);
    expect(settled.entries.find(
      (candidate) => candidate.entryId === entry.entryId,
    )).toMatchObject({
      state: 'enqueued',
      replayCount: 2,
    });
  });

  it('fails closed for the wrong source queue and quarantined bodies', async () => {
    const handler = recoveryHandler();
    const eventQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const invalidBody = '{"operation":"scope-reconcile"}';

    const wrongQueue = await queueResult(
      'not-steward-events-dlq',
      'wrong-queue',
      invalidBody,
      1,
      (batch) => handler.queue(batch, recoveryEnv(eventQueue)),
    );
    expect(wrongQueue.explicitAcks).toEqual([]);
    expect(wrongQueue.retryMessages).toEqual([{ msgId: 'wrong-queue' }]);

    const quarantined = await queueResult(
      'steward-events-dlq',
      'quarantined-envelope',
      invalidBody,
      4,
      (batch) => handler.queue(batch, recoveryEnv(eventQueue)),
    );
    expect(quarantined.explicitAcks).toEqual(['quarantined-envelope']);
    expect(quarantined.retryMessages).toEqual([]);

    const inspection: DeliveryRecoveryInspection =
      await ledger().inspect(100);
    const entry = inspection.entries.find(
      (candidate) => candidate.quarantineReason
        === 'unsupported-queue-envelope',
    );
    expect(entry).toMatchObject({
      state: 'quarantined',
      envelopeKind: 'quarantined',
      replayCount: 0,
    });
    if (entry === undefined) throw new Error('Quarantine entry missing.');

    const command = {
      schemaVersion: 1,
      operation: 'replay-dlq',
      requestId: '20000000-0000-4000-8000-000000000001',
      requestedAt: recoveryNow.toISOString(),
      expectedLedgerRevision: inspection.ledgerRevision,
      entryIds: [entry.entryId],
    };
    const unauthenticated = await handler.fetch(
      recoveryRequest(command, false),
      recoveryEnv(eventQueue),
    );
    expect(unauthenticated.status).toBe(403);
    expect(eventQueue.send).not.toHaveBeenCalled();

    // The durable entry itself is the fail-closed fence: quarantined bodies
    // never become replay candidates even when an authenticated operator
    // supplies their exact entry ID.
    await expect(
      runInDurableObject(ledger(), (instance) =>
        instance.authorizeReplay({
          commandId: command.requestId,
          principal: { accessServiceClientId: accessClientId },
          requestedAt: command.requestedAt,
          entryIds: command.entryIds,
          expectedLedgerRevision: command.expectedLedgerRevision,
        })),
    ).rejects.toThrow('is not eligible for replay');
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it('replays a canonical pull-request WorkItem byte-for-byte into PR deduplication', async () => {
    const handler = recoveryHandler();
    const workItem: StewardRuntimeWorkItemV1 = {
      schemaVersion: 1,
      operation: 'runtime-probe',
      installationId: 145_952_003,
      subject: {
        repositoryId: 1_298_587_612,
        repositoryFullName: 'splrad/recovery-work-item-workerd',
        pullRequestNumber: 42,
      },
      cause: {
        kind: 'internal-probe',
        deliveryId: 'recovery-workerd-direct-work-item',
        receivedAt: '2026-07-27T07:56:00.000Z',
      },
    };
    const canonicalBody = canonicalStewardRuntimeWorkItemJson(workItem);
    const acceptedBodies: string[] = [];
    const eventQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn(async (body) => {
        acceptedBodies.push(body);
      }),
    };

    const dlqResult = await queueResult(
      'steward-events-dlq',
      'direct-work-item-dlq',
      canonicalBody,
      4,
      (batch) => handler.queue(batch, recoveryEnv(eventQueue)),
    );
    expect(dlqResult.explicitAcks).toEqual(['direct-work-item-dlq']);
    const inspection = await ledger().inspect(100);
    const entry = inspection.entries.find(
      (candidate) => candidate.deliveryId
        === workItem.cause.deliveryId,
    );
    expect(entry).toMatchObject({
      envelopeKind: 'work-item-v1',
      state: 'pending',
    });
    if (entry === undefined) throw new Error('WorkItem capture missing.');

    const replay = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'replay-dlq',
        requestId: '30000000-0000-4000-8000-000000000001',
        requestedAt: recoveryNow.toISOString(),
        expectedLedgerRevision: inspection.ledgerRevision,
        entryIds: [entry.entryId],
      }),
      recoveryEnv(eventQueue),
    );
    expect(replay.status).toBe(200);
    expect(acceptedBodies).toEqual([canonicalBody]);

    const pullRequestStub = workerdEnv.PR_COORDINATOR.getByName(
      pullRequestCoordinatorName(
        workItem.subject.repositoryId,
        workItem.subject.pullRequestNumber,
      ),
    );
    const claim = await pullRequestStub.claim(
      workItem.cause.deliveryId,
      60_000,
    );
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected direct WorkItem to be claimed.');
    }
    expect(await pullRequestStub.complete(
      claim.generation,
      claim.leaseToken,
    )).toMatchObject({ status: 'completed' });
    expect(await pullRequestStub.claim(
      workItem.cause.deliveryId,
      60_000,
    )).toEqual({ status: 'duplicate' });
  });

  it('continues a six-page GitHub scan and reconciles an accepted redelivery', async () => {
    const suppressedGuid = 'historically-successful-guid';
    const redeliveredGuid = 'failed-guid-to-redeliver';
    const attempt = (
      id: number,
      guid: string,
      deliveredAt: string,
      status: string,
      redelivery = false,
    ) => ({
      id,
      guid,
      deliveredAt,
      redelivery,
      status,
      statusCode: status === 'OK' ? 200 : 0,
      installationId: 145_952_003,
      repositoryId: 1_298_587_700,
      event: 'pull_request',
      action: 'synchronize',
    });
    const initialPages = [
      {
        cursor: null,
        nextCursor: 'page-2',
        attempts: [
          attempt(
            600,
            suppressedGuid,
            '2026-07-27T07:59:50.000Z',
            'failed to connect to host',
          ),
        ],
      },
      {
        cursor: 'page-2',
        nextCursor: 'page-3',
        attempts: [
          attempt(
            590,
            suppressedGuid,
            '2026-07-27T07:59:40.000Z',
            'OK',
          ),
        ],
      },
      {
        cursor: 'page-3',
        nextCursor: 'page-4',
        attempts: [
          attempt(
            580,
            redeliveredGuid,
            '2026-07-27T07:59:30.000Z',
            'invalid HTTP response',
          ),
        ],
      },
      {
        cursor: 'page-4',
        nextCursor: 'page-5',
        attempts: [
          attempt(
            570,
            redeliveredGuid,
            '2026-07-27T07:59:20.000Z',
            'Failure',
          ),
        ],
      },
      {
        cursor: 'page-5',
        nextCursor: 'page-6',
        attempts: [
          attempt(
            560,
            'healthy-guid-1',
            '2026-07-27T07:59:10.000Z',
            'OK',
          ),
        ],
      },
      {
        cursor: 'page-6',
        nextCursor: null,
        attempts: [
          attempt(
            550,
            'healthy-guid-2',
            '2026-07-27T07:59:00.000Z',
            'OK',
          ),
        ],
      },
    ] as const;
    let phase: 'initial' | 'reconcile' = 'initial';
    let pageCalls = 0;
    let redeliveryPosts = 0;
    const scanIds: string[] = [];
    const redeliveryRequests: Array<{
      attemptId: number;
      guid: string;
    }> = [];
    const control = vi.fn(async (input: Request | string | URL) => {
      const signed = await signedRecoveryControlRequest(input);
      if (signed.path.endsWith('/page')) {
        pageCalls += 1;
        const request = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
          signed.body,
        );
        scanIds.push(request.scanId);
        const page = phase === 'initial'
          ? initialPages.find(
              (candidate) => candidate.cursor === request.cursor,
            )
          : request.cursor === null
            ? {
                cursor: null,
                nextCursor: null,
                attempts: [
                  attempt(
                    700,
                    redeliveredGuid,
                    '2026-07-27T08:01:00.000Z',
                    'OK',
                    true,
                  ),
                ],
              }
            : undefined;
        if (page === undefined) {
          throw new Error(`Unexpected GitHub page cursor ${request.cursor}.`);
        }
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
              scanId: request.scanId,
              cursor: request.cursor,
              attempts: page.attempts,
              nextCursor: page.nextCursor,
              controlRevision,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (signed.path.endsWith('/redeliver')) {
        redeliveryPosts += 1;
        const request =
          parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
            signed.body,
          );
        redeliveryRequests.push({
          attemptId: request.attemptId,
          guid: request.guid,
        });
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
              scanId: request.scanId,
              intentId: request.intentId,
              attemptId: request.attemptId,
              guid: request.guid,
              controlRevision,
            }),
          ),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    let clock = new Date(recoveryNow);
    const handler = recoveryHandler(() => new Date(clock));
    const eventQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const currentEnv = recoveryEnv(eventQueue, control);
    const requestId = '40000000-0000-4000-8000-000000000001';
    const first = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'recover-github',
        requestId,
        requestedAt: clock.toISOString(),
        expectedControlRevision: controlRevision,
        coverageMode: 'establish',
        takeover: false,
      }),
      currentEnv,
    );
    const firstBody = await first.json() as {
      scanId: string;
      cursor: string;
      leaseExpiresAt: string;
      state: string;
    };

    expect(first.status).toBe(202);
    expect(firstBody).toMatchObject({
      state: 'scan-continuation-required',
      cursor: 'page-6',
      leaseExpiresAt: '2026-07-27T08:10:00.000Z',
    });
    expect(pageCalls).toBe(5);
    expect(redeliveryPosts).toBe(0);
    const active = await ledger().inspectGitHubScan();
    expect(active.active).toMatchObject({
      scanId: firstBody.scanId,
      cursor: 'page-6',
      pageCount: 5,
      leaseExpiresAt: firstBody.leaseExpiresAt,
      coverageMode: 'establish',
    });

    clock = new Date('2026-07-27T08:01:00.000Z');
    const second = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'recover-github',
        requestId,
        requestedAt: clock.toISOString(),
        expectedControlRevision: controlRevision,
        coverageMode: 'establish',
        takeover: false,
      }),
      currentEnv,
    );
    const secondBody = await second.json() as {
      scanId: string;
      state: string;
      counts: Record<string, number>;
    };

    expect(second.status).toBe(202);
    expect(secondBody).toMatchObject({
      scanId: firstBody.scanId,
      state: 'redelivery-awaiting-observation',
      counts: { accepted: 1, total: 1 },
    });
    expect(pageCalls).toBe(6);
    expect(new Set(scanIds.slice(0, 6))).toEqual(
      new Set([firstBody.scanId]),
    );
    expect(redeliveryPosts).toBe(1);
    expect(redeliveryRequests).toEqual([{
      attemptId: 580,
      guid: redeliveredGuid,
    }]);
    const accepted = await ledger().inspectGitHubScan();
    expect(accepted.active).toBeNull();
    expect(accepted.redeliveryIntents).toMatchObject({
      accepted: 1,
      unknown: 0,
      total: 1,
    });
    expect(accepted.unresolvedRedeliveries.entries).toEqual([
      expect.objectContaining({
        guid: redeliveredGuid,
        selectedAttemptId: 580,
        state: 'accepted',
      }),
    ]);

    phase = 'reconcile';
    clock = new Date('2026-07-27T08:02:00.000Z');
    const reconciled = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'recover-github',
        requestId: '40000000-0000-4000-8000-000000000002',
        requestedAt: clock.toISOString(),
        expectedControlRevision: controlRevision,
        coverageMode: 'continue',
        takeover: false,
      }),
      currentEnv,
    );

    expect(reconciled.status).toBe(200);
    expect(redeliveryPosts).toBe(1);
    expect(pageCalls).toBe(7);
    const settled = await ledger().inspectGitHubScan();
    expect(settled.redeliveryIntents).toMatchObject({
      accepted: 0,
      unknown: 0,
      total: 0,
    });
    expect(settled.unresolvedRedeliveries.entries).toEqual([]);
  });

  it('never repeats a response-lost redelivery POST and reconciles it from a fresh scan', async () => {
    const guid = 'response-lost-redelivery-guid';
    let phase: 'initial' | 'reconcile' = 'initial';
    let pageCalls = 0;
    let redeliveryPosts = 0;
    const control = vi.fn(async (input: Request | string | URL) => {
      const signed = await signedRecoveryControlRequest(input);
      if (signed.path.endsWith('/page')) {
        pageCalls += 1;
        const request = parseStewardRuntimeDeliveryRecoveryPageRequestV1(
          signed.body,
        );
        const deliveredAt = phase === 'initial'
          ? '2026-07-27T08:03:00.000Z'
          : '2026-07-27T08:05:00.000Z';
        return new Response(
          canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
            buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
              scanId: request.scanId,
              cursor: request.cursor,
              attempts: [{
                id: phase === 'initial' ? 800 : 810,
                guid,
                deliveredAt,
                redelivery: phase === 'reconcile',
                status: phase === 'initial'
                  ? 'failed to connect to host'
                  : 'OK',
                statusCode: phase === 'initial' ? 0 : 200,
                installationId: 145_952_003,
                repositoryId: 1_298_587_701,
                event: 'pull_request',
                action: 'synchronize',
              }],
              nextCursor: null,
              controlRevision,
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (signed.path.endsWith('/redeliver')) {
        redeliveryPosts += 1;
        const request =
          parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
            signed.body,
          );
        expect(request).toMatchObject({
          attemptId: 800,
          guid,
        });
        throw new Error('GitHub accepted POST but Control response was lost');
      }
      return new Response('Not Found', { status: 404 });
    });
    let clock = new Date('2026-07-27T08:04:00.000Z');
    const handler = recoveryHandler(() => new Date(clock));
    const eventQueue: DeliveryRecoveryEventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const currentEnv = recoveryEnv(eventQueue, control);
    const command = {
      schemaVersion: 1,
      operation: 'recover-github',
      requestId: '50000000-0000-4000-8000-000000000001',
      requestedAt: clock.toISOString(),
      expectedControlRevision: controlRevision,
      coverageMode: 'establish',
      takeover: false,
    };
    const first = await handler.fetch(
      recoveryRequest(command),
      currentEnv,
    );

    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({
      error: 'github-redelivery-result-unknown',
    });
    expect(pageCalls).toBe(1);
    expect(redeliveryPosts).toBe(1);
    const unknown = await ledger().inspectGitHubScan();
    expect(unknown.redeliveryIntents).toMatchObject({
      dispatching: 0,
      accepted: 0,
      unknown: 1,
      total: 1,
    });
    expect(unknown.unresolvedRedeliveries.entries).toEqual([
      expect.objectContaining({
        guid,
        selectedAttemptId: 800,
        state: 'unknown',
      }),
    ]);

    const duplicate = await handler.fetch(
      recoveryRequest(command),
      currentEnv,
    );

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      state: 'redelivery-awaiting-observation',
      counts: { unknown: 1, total: 1 },
    });
    expect(pageCalls).toBe(1);
    expect(redeliveryPosts).toBe(1);

    phase = 'reconcile';
    clock = new Date('2026-07-27T08:06:00.000Z');
    const reconciled = await handler.fetch(
      recoveryRequest({
        schemaVersion: 1,
        operation: 'recover-github',
        requestId: '50000000-0000-4000-8000-000000000002',
        requestedAt: clock.toISOString(),
        expectedControlRevision: controlRevision,
        coverageMode: 'continue',
        takeover: false,
      }),
      currentEnv,
    );

    expect(reconciled.status).toBe(200);
    expect(pageCalls).toBe(2);
    expect(redeliveryPosts).toBe(1);
    const settled = await ledger().inspectGitHubScan();
    expect(settled.redeliveryIntents).toMatchObject({
      dispatching: 0,
      accepted: 0,
      unknown: 0,
      total: 0,
    });
    expect(settled.unresolvedRedeliveries.entries).toEqual([]);
  });
});
