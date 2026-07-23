import {
  createExecutionContext,
  createMessageBatch,
  evictDurableObject,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeControlReceiptJson,
  canonicalStewardRuntimeWorkItemJson,
  type StewardRuntimeWorkItemV1,
} from '../packages/core/src/index.js';
import {
  pullRequestCoordinatorName,
  PullRequestCoordinator,
  type CoordinatorEnv,
} from '../packages/coordinator/src/index.js';
import coordinatorWorker from '../packages/coordinator/src/worker.js';

interface WorkerdEnv {
  PR_COORDINATOR: DurableObjectNamespace<PullRequestCoordinator>;
}

const workerdEnv = env as unknown as WorkerdEnv;

function coordinator(
  repositoryId = 1_298_587_318,
  pullRequestNumber = 6,
): DurableObjectStub<PullRequestCoordinator> {
  return workerdEnv.PR_COORDINATOR.getByName(
    pullRequestCoordinatorName(repositoryId, pullRequestNumber),
  );
}

function workItem(
  deliveryId: string,
  repositoryId = 1_298_587_318,
  pullRequestNumber = 6,
): StewardRuntimeWorkItemV1 {
  return {
    schemaVersion: 1,
    operation: 'runtime-probe',
    installationId: 145_952_003,
    subject: {
      repositoryId,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber,
    },
    cause: {
      kind: 'internal-probe',
      deliveryId,
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  };
}

describe('PullRequestCoordinator in workerd', () => {
  it('persists SQLite-backed completion state across an object eviction', async () => {
    const stub = coordinator(1_298_587_318, 101);
    const claim = await stub.claim('delivery-persisted', 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the initial delivery to be claimed.');
    }

    expect(await stub.complete(claim.generation, claim.leaseToken)).toEqual({
      generation: 1,
      status: 'completed',
    });
    expect(await stub.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      generation: 1,
      pendingDeliveryCount: 0,
      phase: 'idle',
      subject: {
        pullNumber: 101,
        repositoryId: '1298587318',
      },
    });

    const schemaVersion = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql
        .exec<{ version: number }>(
          'SELECT version FROM coordinator_schema WHERE singleton = 1',
        )
        .one().version,
    );
    expect(schemaVersion).toBe(1);

    await evictDurableObject(stub);

    expect(await stub.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      generation: 1,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
    expect(await stub.claim('delivery-persisted', 60_000)).toEqual({
      status: 'duplicate',
    });
  });

  it('expires an alarm and fences the stale generation after reclaim', async () => {
    const stub = coordinator(1_298_587_318, 102);
    const first = await stub.claim('delivery-alarm', 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the first generation to be claimed.');
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE coordinator_state SET lease_expires_at = 0 WHERE singleton = 1',
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.snapshot()).toMatchObject({
      dirty: true,
      failureCode: 'lease-expired',
      generation: 1,
      lease: null,
      phase: 'followup',
    });

    const second = await stub.claim('delivery-alarm', 60_000);
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') {
      throw new Error('Expected the expired delivery to be reclaimed.');
    }
    expect(second.generation).toBe(2);

    expect(
      await stub.complete(first.generation, first.leaseToken),
    ).toEqual({ status: 'stale' });
    expect(
      await stub.complete(second.generation, second.leaseToken),
    ).toEqual({ generation: 2, status: 'completed' });
  });

  it('reports independent per-message acknowledgements and retries', async () => {
    const valid = workItem('delivery-queue-workerd', 1_298_587_319);
    const messages = [
      {
        id: 'queue-valid',
        timestamp: new Date('2026-07-23T18:00:00.000Z'),
        attempts: 1,
        body: canonicalStewardRuntimeWorkItemJson(valid),
      },
      {
        id: 'queue-malformed',
        timestamp: new Date('2026-07-23T18:00:01.000Z'),
        attempts: 1,
        body: '{"schemaVersion":1}',
      },
    ];
    const batch = createMessageBatch('steward-events', messages);
    const ctx = createExecutionContext();
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            buildStewardRuntimeControlReceipt({
              subject: request.workItem.subject,
              deliveryId: request.workItem.cause.deliveryId,
              generation: request.generation,
              controlRevision: {
                stewardCommit: 'a'.repeat(40),
                workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
                workerVersionTag: `steward-${'a'.repeat(40)}`,
                workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
              },
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };

    await coordinatorWorker.queue(batch, coordinatorEnv);

    const result = await getQueueResult(batch, ctx);
    expect(result.outcome).toBe('ok');
    expect(result.ackAll).toBe(false);
    expect(result.retryBatch.retry).toBe(false);
    expect(result.explicitAcks).toEqual(['queue-valid']);
    expect(result.retryMessages).toEqual([{ msgId: 'queue-malformed' }]);
    expect(controlFetch).toHaveBeenCalledOnce();
  });

  it('coalesces more than the persisted delivery window without false DLQ retries', async () => {
    const repositoryId = 1_298_587_320;
    const pullRequestNumber = 106;
    const stub = coordinator(repositoryId, pullRequestNumber);
    let releaseFirstControl!: () => void;
    const firstControlGate = new Promise<void>((resolve) => {
      releaseFirstControl = resolve;
    });
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        if (controlFetch.mock.calls.length === 1) {
          await firstControlGate;
        }
        const request = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            buildStewardRuntimeControlReceipt({
              subject: request.workItem.subject,
              deliveryId: request.workItem.cause.deliveryId,
              generation: request.generation,
              controlRevision: {
                stewardCommit: 'a'.repeat(40),
                workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
                workerVersionTag: `steward-${'a'.repeat(40)}`,
                workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
              },
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };
    const messages = Array.from({ length: 140 }, (_unused, index) => {
      const item = {
        ...workItem(`delivery-burst-${index}`, repositoryId),
        subject: {
          repositoryId,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber,
        },
      };
      return {
        id: `queue-burst-${index}`,
        timestamp: new Date('2026-07-23T18:00:00.000Z'),
        attempts: 1,
        body: canonicalStewardRuntimeWorkItemJson(item),
      };
    });
    const batches = Array.from({ length: 14 }, (_unused, index) =>
      createMessageBatch(
        'steward-events',
        messages.slice(index * 10, index * 10 + 10),
      ));
    const contexts = batches.map(() => createExecutionContext());

    const processing = Promise.all(
      batches.map((batch) => coordinatorWorker.queue(batch, coordinatorEnv)),
    );

    await vi.waitFor(async () => {
      expect(await stub.snapshot()).toMatchObject({
        dirty: true,
        pendingDeliveryCount: 128,
        phase: 'leased',
      });
    });
    releaseFirstControl();
    await processing;

    const results = await Promise.all(
      batches.map((batch, index) => {
        const context = contexts[index];
        if (context === undefined) {
          throw new Error('Missing execution context for Queue batch.');
        }
        return getQueueResult(batch, context);
      }),
    );
    let acknowledged = 0;
    for (const result of results) {
      expect(result.retryMessages).toEqual([]);
      acknowledged += result.explicitAcks.length;
    }
    expect(acknowledged).toBe(140);
    expect(controlFetch).toHaveBeenCalledTimes(2);
    expect(await stub.snapshot()).toMatchObject({
      dirty: false,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });

  it('chains durable wakeups across more work than one Queue retry budget', async () => {
    const repositoryId = 1_298_587_321;
    const pullRequestNumber = 107;
    const stub = coordinator(repositoryId, pullRequestNumber);
    const root = workItem(
      'delivery-paced-root',
      repositoryId,
      pullRequestNumber,
    );
    const wakeupBodies: string[] = [];
    let controlCalls = 0;
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        controlCalls += 1;
        if (controlCalls <= 40) {
          await expect(
            stub.claim(`delivery-paced-${controlCalls}`, 120_000),
          ).resolves.toMatchObject({ status: 'coalesced' });
        }
        const request = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            buildStewardRuntimeControlReceipt({
              subject: request.workItem.subject,
              deliveryId: request.workItem.cause.deliveryId,
              generation: request.generation,
              controlRevision: {
                stewardCommit: 'a'.repeat(40),
                workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
                workerVersionTag: `steward-${'a'.repeat(40)}`,
                workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
              },
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const wakeupSend = vi.fn(async (body: string) => {
      wakeupBodies.push(body);
    });
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: { send: wakeupSend },
    };

    let nextBody: string | undefined =
      canonicalStewardRuntimeWorkItemJson(root);
    let processedRoots = 0;
    while (nextBody !== undefined) {
      const batch = createMessageBatch('steward-events', [
        {
          id: `queue-paced-root-${processedRoots}`,
          timestamp: new Date('2026-07-23T18:00:00.000Z'),
          attempts: 1,
          body: nextBody,
        },
      ]);
      const context = createExecutionContext();
      await coordinatorWorker.queue(batch, coordinatorEnv);
      const result = await getQueueResult(batch, context);
      expect(result.explicitAcks).toHaveLength(1);
      expect(result.retryMessages).toEqual([]);
      processedRoots += 1;
      if (processedRoots > 10) {
        throw new Error('Coordinator wakeup chain did not converge.');
      }
      nextBody = wakeupBodies.shift();
    }

    expect(controlCalls).toBe(41);
    expect(wakeupSend).toHaveBeenCalledTimes(4);
    expect(processedRoots).toBe(5);
    expect(await stub.snapshot()).toMatchObject({
      dirty: false,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });
});
