import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeControlReceiptJson,
  canonicalStewardRuntimeWorkItemJson,
  type StewardRuntimeWorkItemV1,
} from '../packages/core/src/index.js';
import {
  coordinatorControlTimeoutMs,
  coordinatorLeaseDurationMs,
  coordinatorMaximumImmediateFollowups,
  createCoordinatorHandler,
  processCoordinatorMessage,
  type CoordinatorEnv,
  type CoordinatorQueueMessage,
  type PullRequestCoordinatorStub,
} from '../packages/coordinator/src/worker.js';

function workItem(
  deliveryId: string,
  repositoryId = 1_298_587_318,
): StewardRuntimeWorkItemV1 {
  return {
    schemaVersion: 1,
    operation: 'runtime-probe',
    installationId: 145_952_003,
    subject: {
      repositoryId,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber: 6,
    },
    cause: {
      kind: 'internal-probe',
      deliveryId,
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  };
}

function message(body: unknown, attempts = 1): CoordinatorQueueMessage & {
  ack: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<(options?: { readonly delaySeconds?: number }) => void>>;
} {
  const ack = vi.fn<() => void>();
  const retry = vi.fn<(options?: { readonly delaySeconds?: number }) => void>();
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack,
    retry,
  };
}

const stableVersion = '3d4755c9-3fb1-49ba-95c7-6797c16a0847';

function receipt(
  item: StewardRuntimeWorkItemV1,
  generation: number,
  version = stableVersion,
) {
  return buildStewardRuntimeControlReceipt({
    subject: item.subject,
    deliveryId: item.cause.deliveryId,
    generation,
    controlRevision: {
      stewardCommit: 'a'.repeat(40),
      workerVersionId: version,
      workerVersionTag: `steward-${'a'.repeat(40)}`,
      workerVersionCreatedAt: '2026-07-23T16:00:00.000Z',
    },
  });
}

function environment(
  stubs: Readonly<Record<number, PullRequestCoordinatorStub>>,
  control?: CoordinatorEnv['CONTROL'],
  variables: Partial<CoordinatorEnv> = {},
): CoordinatorEnv {
  return {
    PR_COORDINATOR: {
      getByName(name) {
        const repositoryId = Number(name.split(':')[1]);
        const stub = stubs[repositoryId];
        if (stub === undefined) throw new Error('missing coordinator stub');
        return stub;
      },
    },
    CONTROL: control ?? {
      async fetch(_input, init) {
        const parsed = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            receipt(parsed.workItem, parsed.generation),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
    EVENT_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    ...variables,
  };
}

function stub(
  claimResult: Awaited<ReturnType<PullRequestCoordinatorStub['claim']>>,
  completeResult: Awaited<ReturnType<PullRequestCoordinatorStub['complete']>> = {
    status: 'completed',
    generation: 1,
  },
): PullRequestCoordinatorStub & {
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn().mockResolvedValue(claimResult),
    complete: vi.fn().mockResolvedValue(completeResult),
    fail: vi.fn().mockResolvedValue({ status: 'followup', generation: 1 }),
  };
}

describe('Coordinator Queue consumer', () => {
  it('acks a completed duplicate without invoking Control', async () => {
    const item = workItem('delivery-duplicate');
    const coordinator = stub({ status: 'duplicate' });
    const control = { fetch: vi.fn() };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(control.fetch).not.toHaveBeenCalled();
  });

  it('retains a busy root as a delayed per-message retry', async () => {
    const item = workItem('delivery-busy');
    const coordinator = stub({
      status: 'busy',
      expiresAt: Date.now() + 30_000,
      generation: 3,
    });
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }),
    );

    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it('acks coalesced burst work after PR-level dirty state is durable', async () => {
    const item = workItem('delivery-coalesced');
    const coordinator = stub({
      status: 'coalesced',
      expiresAt: Date.now() + 30_000,
      generation: 3,
    });
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }),
    );

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('immediately reconciles one durable follow-up generation', async () => {
    const item = workItem('delivery-followup');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    coordinator.claim
      .mockResolvedValueOnce({
        status: 'claimed',
        generation: 1,
        leaseToken: 'opaque-lease-token-1',
        expiresAt: Date.now() + 120_000,
      })
      .mockResolvedValueOnce({
        status: 'claimed',
        generation: 2,
        leaseToken: 'opaque-lease-token-2',
        expiresAt: Date.now() + 120_000,
      });
    coordinator.complete
      .mockResolvedValueOnce({ status: 'followup', generation: 1 })
      .mockResolvedValueOnce({ status: 'completed', generation: 2 });
    const control = { fetch: vi.fn(environment({}).CONTROL.fetch) };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(control.fetch).toHaveBeenCalledTimes(2);
    expect(coordinator.claim).toHaveBeenCalledTimes(2);
    expect(coordinator.complete).toHaveBeenNthCalledWith(
      2,
      2,
      'opaque-lease-token-2',
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('bounds continuous immediate follow-ups and persists a fresh root wakeup', async () => {
    const item = workItem('delivery-continuous-followup');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    let generation = 0;
    coordinator.claim.mockImplementation(async () => {
      generation += 1;
      return {
        status: 'claimed',
        generation,
        leaseToken: `opaque-lease-token-${generation}`,
        expiresAt: Date.now() + 120_000,
      };
    });
    coordinator.complete.mockImplementation(async (completedGeneration) => ({
      status: 'followup',
      generation: completedGeneration,
    }));
    const control = { fetch: vi.fn(environment({}).CONTROL.fetch) };
    const wakeupQueue = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment(
        { [item.subject.repositoryId]: coordinator },
        control,
        { EVENT_QUEUE: wakeupQueue },
      ),
    );

    expect(control.fetch).toHaveBeenCalledTimes(
      coordinatorMaximumImmediateFollowups + 1,
    );
    expect(wakeupQueue.send).toHaveBeenCalledWith(
      canonicalStewardRuntimeWorkItemJson(item),
      { contentType: 'text' },
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('retains the root retry when a follow-up wakeup cannot be persisted', async () => {
    const item = workItem('delivery-wakeup-failed');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    let generation = 0;
    coordinator.claim.mockImplementation(async () => {
      generation += 1;
      return {
        status: 'claimed',
        generation,
        leaseToken: `opaque-lease-token-${generation}`,
        expiresAt: Date.now() + 120_000,
      };
    });
    coordinator.complete.mockImplementation(async (completedGeneration) => ({
      status: 'followup',
      generation: completedGeneration,
    }));
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));
    const wakeupQueue = {
      send: vi.fn().mockRejectedValue(new Error('Queue unavailable')),
    };

    await processCoordinatorMessage(
      queued,
      environment(
        { [item.subject.repositoryId]: coordinator },
        undefined,
        { EVENT_QUEUE: wakeupQueue },
      ),
    );

    expect(wakeupQueue.send).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });

  it('calls private Control outside the claim and acknowledges only after fenced completion', async () => {
    const item = workItem('delivery-success');
    const trace: string[] = [];
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    coordinator.claim.mockImplementation(async () => {
      trace.push('claim');
      return {
        status: 'claimed',
        generation: 1,
        leaseToken: 'opaque-lease-token-1',
        expiresAt: Date.now() + 120_000,
      };
    });
    coordinator.complete.mockImplementation(async () => {
      trace.push('complete');
      return { status: 'completed', generation: 1 };
    });
    const control = {
      async fetch(_input: Request | string | URL, init?: RequestInit) {
        trace.push('control');
        const parsed = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            receipt(parsed.workItem, parsed.generation),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(trace).toEqual(['claim', 'control', 'complete']);
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(coordinator.complete).toHaveBeenCalledWith(1, 'opaque-lease-token-1');
  });

  it('fails the lease and retries only the affected message on Control failure', async () => {
    const first = workItem('delivery-first');
    const second = workItem('delivery-second', 1_298_587_319);
    const firstCoordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    const secondCoordinator = stub({ status: 'duplicate' });
    const firstMessage = message(canonicalStewardRuntimeWorkItemJson(first));
    const secondMessage = message(canonicalStewardRuntimeWorkItemJson(second));
    const control = {
      fetch: vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })),
    };

    await createCoordinatorHandler().queue(
      { queue: 'steward-events', messages: [firstMessage, secondMessage] },
      environment({
        [first.subject.repositoryId]: firstCoordinator,
        [second.subject.repositoryId]: secondCoordinator,
      }, control),
    );

    expect(firstMessage.retry).toHaveBeenCalledOnce();
    expect(firstMessage.ack).not.toHaveBeenCalled();
    expect(firstCoordinator.fail).toHaveBeenCalledWith(
      1,
      'opaque-lease-token-1',
      'dependency-unavailable',
    );
    expect(secondMessage.ack).toHaveBeenCalledOnce();
    expect(secondMessage.retry).not.toHaveBeenCalled();
  });

  it('retries a malformed message without retrying an acknowledged sibling', async () => {
    const valid = workItem('delivery-valid');
    const validMessage = message(canonicalStewardRuntimeWorkItemJson(valid));
    const malformedMessage = message('{"schemaVersion":1}');

    await createCoordinatorHandler().queue(
      { queue: 'steward-events', messages: [validMessage, malformedMessage] },
      environment({
        [valid.subject.repositoryId]: stub({ status: 'duplicate' }),
      }),
    );

    expect(validMessage.ack).toHaveBeenCalledOnce();
    expect(validMessage.retry).not.toHaveBeenCalled();
    expect(malformedMessage.retry).toHaveBeenCalledOnce();
    expect(malformedMessage.ack).not.toHaveBeenCalled();
  });

  it('pins only owner-configured repositories and verifies the actual candidate version', async () => {
    const item = workItem('delivery-candidate');
    const version = 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d';
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItemV1;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            receipt(parsed.workItem, parsed.generation, version),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment(
        { [item.subject.repositoryId]: coordinator },
        control,
        {
          CONTROL_CANDIDATE_REPOSITORY_IDS: String(item.subject.repositoryId),
          CONTROL_CANDIDATE_VERSION_ID: version,
        },
      ),
    );

    expect(queued.ack).toHaveBeenCalledOnce();
    const headers = new Headers(control.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('cloudflare-workers-version-overrides'))
      .toBe(`steward-control="${version}"`);
  });

  it('fails closed when Cloudflare silently falls back from an invalid override', async () => {
    const item = workItem('delivery-fallback');
    const expected = 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d';
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment(
        { [item.subject.repositoryId]: coordinator },
        undefined,
        {
          CONTROL_CANDIDATE_REPOSITORY_IDS: String(item.subject.repositoryId),
          CONTROL_CANDIDATE_VERSION_ID: expected,
        },
      ),
    );

    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(coordinator.fail).toHaveBeenCalledWith(
      1,
      'opaque-lease-token-1',
      'control-error',
    );
  });

  it('rejects a successful Control response with a non-JSON media type', async () => {
    const item = workItem('delivery-wrong-media-type');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));
    const control = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          canonicalStewardRuntimeControlReceiptJson(receipt(item, 1)),
          { status: 200, headers: { 'content-type': 'text/plain' } },
        ),
      ),
    };

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(coordinator.fail).toHaveBeenCalledWith(
      1,
      'opaque-lease-token-1',
      'control-error',
    );
  });

  it('passes a platform deadline shorter than the coordinator lease to Control', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(
      (milliseconds) => {
        expect(milliseconds).toBe(coordinatorControlTimeoutMs);
        return AbortSignal.abort('control-invocation-deadline');
      },
    );
    const item = workItem('delivery-control-timeout');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-lease-token-1',
      expiresAt: Date.now() + 120_000,
    });
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));
    const control = {
      fetch: vi.fn((_input: Request | string | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new Error('aborted'));
        }
        return Promise.reject(new Error('missing deadline signal'));
      }),
    };

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(timeout).toHaveBeenCalledOnce();
    expect(coordinatorControlTimeoutMs).toBeLessThan(coordinatorLeaseDurationMs);
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(coordinator.fail).toHaveBeenCalledWith(
      1,
      'opaque-lease-token-1',
      'dependency-unavailable',
    );
  });

  it('does not expose an HTTP route', async () => {
    const response = await createCoordinatorHandler().fetch(
      new Request('https://coordinator.internal/health'),
      environment({}),
    );
    expect(response.status).toBe(404);
  });
});
