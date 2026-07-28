import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeInstallationRepositoryChildV1,
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  buildStewardRuntimeRepositoryFanoutPageReceiptV2,
  buildStewardRuntimeScopeWorkItemV1,
  buildStewardRuntimeScopeWorkItemV2,
  buildStewardRuntimeWorkItemV3,
  buildStewardRuntimeWorkItemV5,
  buildStewardRuntimeControlMutationReceiptV2,
  buildStewardRuntimeControlPreparedReceiptV2,
  buildStewardRuntimeControlRecoveryReceiptV2,
  buildStewardRuntimeControlReceipt,
  canonicalControlJson,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeControlMutationReceiptV2Json,
  canonicalStewardRuntimeControlPreparedReceiptV2Json,
  canonicalStewardRuntimeControlRecoveryReceiptV2Json,
  canonicalStewardRuntimeControlReceiptJson,
  canonicalStewardRuntimeWorkItemJson,
  controlJsonDigest,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  parseStewardRuntimeRepositoryFanoutPageRequestV1,
  parseStewardRuntimeRepositoryFanoutPageRequestV2,
  parseStewardRuntimeControlApplyNextRequestV2,
  parseStewardRuntimeControlPrepareRequestV2,
  parseStewardRuntimeControlRecoverRequestV2,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeInstallationFanoutRootV1,
  type StewardRuntimeScopeWorkItemV1,
  type StewardRuntimeScopeWorkItemV2,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlRevisionV1,
  type StewardGitHubWebhookEventActionV2,
  type StewardRuntimeWorkItem,
  type StewardRuntimeWorkItemV1,
  type StewardRuntimeWorkItemV2,
  type StewardRuntimeWorkItemV3,
  type StewardRuntimeWorkItemV4,
  type StewardRuntimeWorkItemV5,
} from '../packages/core/src/index.js';
import {
  coordinatorControlTimeoutMs,
  coordinatorLeaseDurationMs,
  coordinatorMaximumImmediateFollowups,
  createCoordinatorHandler,
  processCoordinatorMessage,
  type CoordinatorEnv,
  type CoordinatorQueueMessage,
  type InstallationFanoutCoordinatorStub,
  type PullRequestCoordinatorStub,
  type RepositoryFanoutCoordinatorStub,
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

function reviewWorkItem(
  deliveryId: string,
  cause: StewardGitHubWebhookEventActionV2 = {
    event: 'pull_request_review',
    action: 'submitted',
  },
): StewardRuntimeWorkItemV2 {
  const base = workItem(deliveryId);
  return {
    ...base,
    schemaVersion: 2,
    operation: 'pull-request-reconcile',
    cause: {
      kind: 'github-webhook',
      deliveryId,
      ...cause,
      receivedAt: base.cause.receivedAt,
    },
  };
}

function repositoryScopeWorkItem(
  deliveryId = 'repository-delivery-1',
): StewardRuntimeScopeWorkItemV1 {
  return buildStewardRuntimeScopeWorkItemV1({
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryId: 1_298_587_318,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId,
      event: 'repository',
      action: 'renamed',
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  });
}

function repositoryScopeWorkItemV2(
  deliveryId = 'push-delivery-1',
): StewardRuntimeScopeWorkItemV2 & {
  readonly target: {
    readonly scope: 'repository';
    readonly mode: 'refresh';
    readonly installationId: number;
    readonly repositoryId: number;
    readonly pullRequests: 'all-open';
  };
} {
  return buildStewardRuntimeScopeWorkItemV2({
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryId: 1_298_587_318,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId,
      event: 'push',
      action: null,
      ref: 'refs/heads/main',
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  }) as ReturnType<typeof repositoryScopeWorkItemV2>;
}

function installationRepositorySetRoot(
  deliveryId: string,
  repositoryIds: readonly number[],
): StewardRuntimeInstallationFanoutRootV1 {
  const scopeWorkItem = buildStewardRuntimeScopeWorkItemV2({
    operation: 'scope-reconcile',
    target: {
      scope: 'repository-set',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryIds,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId,
      event: 'installation_repositories',
      action: 'removed',
      ref: null,
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  });
  if (scopeWorkItem.target.scope !== 'repository-set') {
    throw new Error('Installation fixture must use repository-set scope');
  }
  return {
    installationId: scopeWorkItem.target.installationId,
    deliveryId: scopeWorkItem.cause.deliveryId,
    scopeWorkItem: {
      ...scopeWorkItem,
      target: scopeWorkItem.target,
    },
  };
}

async function installationFanoutWorkItemV5(
  repositoryFanoutGeneration = 9,
): Promise<StewardRuntimeWorkItemV5> {
  const root = installationRepositorySetRoot(
    'installation-fanout-v5-direct',
    [1_298_587_318],
  );
  if (root.scopeWorkItem.target.scope !== 'repository-set') {
    throw new Error('V5 fixture must use repository-set scope');
  }
  const installationChild =
    await buildStewardRuntimeInstallationRepositoryChildV1({
      root,
      installationId: root.installationId,
      repositoryId: root.scopeWorkItem.target.repositoryIds[0]!,
      installationGeneration: 4,
    });
  const pullRequestNumber = 6;
  return buildStewardRuntimeWorkItemV5({
    operation: 'pull-request-reconcile',
    installationId: installationChild.installationId,
    subject: {
      repositoryId: installationChild.repositoryId,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber,
    },
    cause: {
      kind: 'scope-fanout-3',
      deliveryId: await deriveStewardRuntimeFanoutDeliveryIdV3(
        installationChild,
        repositoryFanoutGeneration,
        pullRequestNumber,
      ),
      rootDeliveryId: installationChild.rootDeliveryId,
      installationChild,
      repositoryFanoutGeneration,
      event: installationChild.cause.event,
      action: installationChild.cause.action,
      ref: installationChild.cause.ref,
      receivedAt: installationChild.cause.receivedAt,
    },
  });
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
const v2Revision: StewardRuntimeControlRevisionV1 = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: stableVersion,
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-23T16:00:00.000Z',
};

function receipt(
  item: StewardRuntimeWorkItem,
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

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + 0x8000),
    );
  }
  return btoa(binary);
}

async function preparedV2(
  item:
    | StewardRuntimeWorkItemV2
    | StewardRuntimeWorkItemV3
    | StewardRuntimeWorkItemV4
    | StewardRuntimeWorkItemV5,
  generation: number,
  withMutation = false,
  revision = v2Revision,
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const context = {
    repositoryId: item.subject.repositoryId,
    repositoryFullName: item.subject.repositoryFullName,
    pullRequestNumber: item.subject.pullRequestNumber,
    headSha: 'b'.repeat(40),
    defaultBranch: 'main',
    manifestBlobSha: 'c'.repeat(40),
    configDigest: 'd'.repeat(64),
    pullRequestDigest: 'e'.repeat(64),
  };
  const repositoryParts = context.repositoryFullName.split('/');
  if (
    repositoryParts.length !== 2
    || repositoryParts.some((part) => part.length === 0)
  ) {
    throw new Error('Test work item repositoryFullName must be OWNER/REPOSITORY.');
  }
  const [owner, name] = repositoryParts as [string, string];
  const intent = {
    type: 'copilot-review.request',
    key: 'copilot-review:request',
    principal: 'human',
    evidenceProtocol: 'review-request-v1',
    observedEvidenceDigest: 'f'.repeat(64),
  } as const;
  const mutation: StewardRuntimeControlMutationBindingV2 | undefined =
    withMutation
      ? {
          ordinal: 0,
          key: intent.key,
          mutationType: intent.type,
          principal: intent.principal,
          recoveryPolicy: 'live-evidence-or-action-required',
          desiredDigest: await controlJsonDigest(intent),
        }
      : undefined;
  const planWithoutId = {
    contractVersion: 1,
    snapshotDigest: '9'.repeat(64),
    pullRequestDigest: context.pullRequestDigest,
    objective: 'governance',
    subject: {
      repository: {
        id: context.repositoryId,
        owner,
        name,
        defaultBranch: context.defaultBranch,
      },
      pullRequest: {
        number: context.pullRequestNumber,
        headSha: context.headSha,
      },
      manifest: {
        blobSha: context.manifestBlobSha,
        configDigest: context.configDigest,
      },
      platform: {
        appId: 4_243_096,
        clientId: 'Iv23liSteward',
        appSlug: 'splrad-steward',
      },
    },
    outcome: withMutation
      ? { state: 'pending', summary: 'Copilot review remains pending.' }
      : { state: 'ignored', summary: 'No governance mutation is required.' },
    mutations: mutation === undefined
      ? []
      : [{
          ...intent,
          desiredDigest: mutation.desiredDigest,
          preconditions: {
            repositoryId: context.repositoryId,
            defaultBranch: context.defaultBranch,
            pullNumber: context.pullRequestNumber,
            headSha: context.headSha,
            manifestBlobSha: context.manifestBlobSha,
            configDigest: context.configDigest,
            pullRequestDigest: context.pullRequestDigest,
          },
        }],
  };
  const planId = await controlJsonDigest(planWithoutId);
  const plan = { ...planWithoutId, planId };
  const canonicalPlan = canonicalControlJson(plan);
  return await buildStewardRuntimeControlPreparedReceiptV2({
    binding: { workItem: item, generation, objective: 'governance' },
    resolvedContext: context,
    plan: {
      contractVersion: 1,
      planId,
      planDigest: await controlJsonDigest(plan),
      preparedGeneration: generation,
      terminalOutcome: withMutation ? 'pending-external' : 'ignored',
      canonicalPlanByteLength: new TextEncoder().encode(canonicalPlan).byteLength,
      canonicalPlanBase64: utf8Base64(canonicalPlan),
      mutationCount: mutation === undefined ? 0 : 1,
      mutations: mutation === undefined ? [] : [mutation],
    },
    controlRevision: revision,
  });
}

async function mutationReceiptV2(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  result: {
    readonly state:
      | 'applied'
      | 'converged'
      | 'not-attempted'
      | 'stale-plan'
      | 'unknown';
    readonly resourceId: number | null;
    readonly retryAfterSeconds: number | null;
  } = {
    state: 'applied',
    resourceId: 9_876,
    retryAfterSeconds: null,
  },
) {
  return await buildStewardRuntimeControlMutationReceiptV2({
    binding: prepared.binding,
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[0]!,
    result,
    controlRevision: prepared.controlRevision,
  });
}

async function recoveryReceiptV2(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  workItem: StewardRuntimeWorkItemV2,
  generation: number,
  state: 'converged' | 'action-required' | 'unknown' = 'converged',
) {
  return await buildStewardRuntimeControlRecoveryReceiptV2({
    binding: {
      workItem,
      generation,
      objective: 'governance',
    },
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[0]!,
    result: {
      state,
      resourceId: state === 'converged' ? 9_876 : null,
    },
    controlRevision: prepared.controlRevision,
  });
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
    REPOSITORY_FANOUT_COORDINATOR: {
      getByName() {
        throw new Error('missing repository fan-out coordinator stub');
      },
    },
    INSTALLATION_FANOUT_COORDINATOR: {
      getByName() {
        throw new Error('missing installation fan-out coordinator stub');
      },
    },
    CONTROL: control ?? {
      async fetch(_input, init) {
        const parsed = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItem;
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
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    ...variables,
  } as CoordinatorEnv;
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
    persistPreparedPlan: vi.fn().mockResolvedValue({
      status: 'persisted',
      generation: 1,
      planId: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
    }),
    beginNextMutation: vi.fn().mockResolvedValue({ status: 'none' }),
    recordHumanMutationActionRequiredAndComplete:
      vi.fn().mockResolvedValue({
        status: 'completed',
        generation: 1,
      }),
    recordMutationResult: vi.fn().mockResolvedValue({ status: 'recorded' }),
    recordNonAttemptedAndFollowup: vi.fn().mockResolvedValue({
      status: 'followup',
      generation: 1,
      mutationResult: 'not-attempted',
      retryAfterSeconds: 30,
    }),
    recordUnknownAndFail: vi.fn().mockResolvedValue({
      status: 'followup',
      generation: 1,
    }),
    beginRecovery: vi.fn().mockResolvedValue({ status: 'none' }),
    recordRecoveryResultAndComplete: vi.fn().mockResolvedValue({
      status: 'completed',
      generation: 1,
    }),
    completeMutationPlan: vi.fn().mockResolvedValue({
      status: 'completed',
      generation: 1,
    }),
  };
}

function repositoryFanoutStub(
  claimResult: Awaited<
    ReturnType<RepositoryFanoutCoordinatorStub['claim']>
  >,
): RepositoryFanoutCoordinatorStub & {
  claim: ReturnType<typeof vi.fn>;
  recordPage: ReturnType<typeof vi.fn>;
  nextDispatchBatch: ReturnType<typeof vi.fn>;
  recordQueueConfirmed: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  releaseForContinuation: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn().mockResolvedValue(claimResult),
    recordPage: vi.fn().mockResolvedValue({
      status: 'accepted',
      generation: 1,
      pass: 1,
      hasNextPage: true,
    }),
    nextDispatchBatch: vi.fn().mockResolvedValue({
      status: 'batch',
      generation: 1,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      targets: [],
      remaining: 0,
    }),
    recordQueueConfirmed: vi.fn().mockResolvedValue({
      status: 'recorded',
      generation: 1,
      newlyConfirmed: 0,
      remaining: 0,
    }),
    complete: vi.fn().mockResolvedValue({
      status: 'completed',
      generation: 1,
    }),
    fail: vi.fn().mockResolvedValue({
      status: 'resumable',
      generation: 1,
    }),
    releaseForContinuation: vi.fn().mockResolvedValue({
      status: 'released',
      generation: 1,
    }),
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
      sendBatch: vi.fn().mockResolvedValue(undefined),
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
      sendBatch: vi.fn().mockResolvedValue(undefined),
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
          workItem: StewardRuntimeWorkItem;
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

  it.each([
    { event: 'pull_request_review', action: 'submitted' },
    { event: 'pull_request_review_comment', action: 'edited' },
    { event: 'pull_request_review_thread', action: 'resolved' },
  ] satisfies readonly StewardGitHubWebhookEventActionV2[])(
    'passes a canonical $event:$action trigger through the same per-PR Coordinator',
    async (cause) => {
      const item = reviewWorkItem(`delivery-${cause.event}`, cause);
      const coordinator = stub({
        status: 'claimed',
        generation: 1,
        leaseToken: 'opaque-review-event-lease-token',
        expiresAt: Date.now() + 120_000,
      });
      const control = {
        fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
          const request = await parseStewardRuntimeControlPrepareRequestV2(
            JSON.parse(String(init?.body)),
          );
          return jsonResponse(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              await preparedV2(item, request.binding.generation),
            ),
          );
        }),
      };
      const queued = message(canonicalStewardRuntimeWorkItemJson(item));

      await processCoordinatorMessage(
        queued,
        environment({ [item.subject.repositoryId]: coordinator }, control),
      );

      expect(control.fetch).toHaveBeenCalledOnce();
      const request = await parseStewardRuntimeControlPrepareRequestV2(
        JSON.parse(String(control.fetch.mock.calls[0]?.[1]?.body)),
      );
      expect(request.binding).toEqual({
        workItem: item,
        generation: 1,
        objective: 'governance',
      });
      expect(
        new Headers(control.fetch.mock.calls[0]?.[1]?.headers)
          .get('x-steward-internal-protocol'),
      ).toBe('2');
      expect(coordinator.claim).toHaveBeenCalledWith(
        item.cause.deliveryId,
        coordinatorLeaseDurationMs,
      );
      expect(coordinator.beginRecovery).toHaveBeenCalledWith(
        1,
        'opaque-review-event-lease-token',
        coordinatorLeaseDurationMs,
      );
      expect(coordinator.persistPreparedPlan).toHaveBeenCalledOnce();
      expect(coordinator.completeMutationPlan).toHaveBeenCalledWith(
        1,
        'opaque-review-event-lease-token',
      );
      expect(queued.ack).toHaveBeenCalledOnce();
      expect(queued.retry).not.toHaveBeenCalled();
    },
  );

  it('persists a v2 plan before dispatch and records the exact mutation receipt', async () => {
    const item = reviewWorkItem('delivery-v2-applied');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-v2-applied-lease',
      expiresAt: Date.now() + 120_000,
    });
    let prepared: StewardRuntimeControlPreparedReceiptV2 | undefined;
    let beginCount = 0;
    vi.mocked(coordinator.persistPreparedPlan).mockImplementation(
      async (_generation, _leaseToken, _leaseDuration, value) => {
        prepared = value;
        return {
          status: 'persisted',
          generation: 1,
          planId: value.plan.planId,
          planDigest: value.plan.planDigest,
        };
      },
    );
    vi.mocked(coordinator.beginNextMutation).mockImplementation(async () => {
      if (prepared === undefined) throw new Error('plan was not persisted');
      if (beginCount++ > 0) return { status: 'none' };
      return {
        status: 'ready',
        generation: 1,
        planId: prepared.plan.planId,
        planDigest: prepared.plan.planDigest,
        preparedReceipt: prepared,
        intent: {
          ...prepared.plan.mutations[0]!,
          cancelReason: null,
          state: 'applying',
          dispatchCount: 1,
          startedAt: 1,
        },
      };
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body)) as { phase?: unknown };
        if (raw.phase === 'prepare') {
          const request = await parseStewardRuntimeControlPrepareRequestV2(raw);
          return jsonResponse(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              await preparedV2(item, request.binding.generation, true),
            ),
          );
        }
        const request = await parseStewardRuntimeControlApplyNextRequestV2(raw);
        expect(prepared).toBeDefined();
        expect(request.mutation).toEqual(prepared!.plan.mutations[0]);
        return jsonResponse(
          await canonicalStewardRuntimeControlMutationReceiptV2Json(
            await mutationReceiptV2(prepared!),
          ),
        );
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(control.fetch).toHaveBeenCalledTimes(2);
    expect(coordinator.persistPreparedPlan).toHaveBeenCalledBefore(
      vi.mocked(coordinator.beginNextMutation),
    );
    expect(coordinator.recordMutationResult).toHaveBeenCalledOnce();
    expect(coordinator.recordUnknownAndFail).not.toHaveBeenCalled();
    expect(coordinator.completeMutationPlan).toHaveBeenCalledWith(
      1,
      'opaque-v2-applied-lease',
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('records an applying mutation as unknown when the Control response is uncertain', async () => {
    const item = reviewWorkItem('delivery-v2-unknown');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-v2-unknown-lease',
      expiresAt: Date.now() + 120_000,
    });
    let prepared: StewardRuntimeControlPreparedReceiptV2 | undefined;
    vi.mocked(coordinator.persistPreparedPlan).mockImplementation(
      async (_generation, _leaseToken, _leaseDuration, value) => {
        prepared = value;
        return {
          status: 'persisted',
          generation: 1,
          planId: value.plan.planId,
          planDigest: value.plan.planDigest,
        };
      },
    );
    vi.mocked(coordinator.beginNextMutation).mockImplementation(async () => {
      if (prepared === undefined) throw new Error('plan was not persisted');
      return {
        status: 'ready',
        generation: 1,
        planId: prepared.plan.planId,
        planDigest: prepared.plan.planDigest,
        preparedReceipt: prepared,
        intent: {
          ...prepared.plan.mutations[0]!,
          cancelReason: null,
          state: 'applying',
          dispatchCount: 1,
          startedAt: 1,
        },
      };
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body)) as { phase?: unknown };
        if (raw.phase === 'prepare') {
          const request = await parseStewardRuntimeControlPrepareRequestV2(raw);
          return jsonResponse(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              await preparedV2(item, request.binding.generation, true),
            ),
          );
        }
        throw new Error('response lost after dispatch');
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(control.fetch).toHaveBeenCalledTimes(2);
    expect(coordinator.recordUnknownAndFail).toHaveBeenCalledWith(
      1,
      'opaque-v2-unknown-lease',
      prepared!.plan.mutations[0],
    );
    expect(coordinator.recordMutationResult).not.toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
  });

  it('uses a Control not-attempted receipt as a bounded delayed follow-up', async () => {
    const item = reviewWorkItem('delivery-v2-rate-limit');
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-v2-rate-limit-lease',
      expiresAt: Date.now() + 120_000,
    });
    let prepared: StewardRuntimeControlPreparedReceiptV2 | undefined;
    vi.mocked(coordinator.persistPreparedPlan).mockImplementation(
      async (_generation, _leaseToken, _leaseDuration, value) => {
        prepared = value;
        return {
          status: 'persisted',
          generation: 1,
          planId: value.plan.planId,
          planDigest: value.plan.planDigest,
        };
      },
    );
    vi.mocked(coordinator.beginNextMutation).mockImplementation(async () => {
      if (prepared === undefined) throw new Error('plan was not persisted');
      return {
        status: 'ready',
        generation: 1,
        planId: prepared.plan.planId,
        planDigest: prepared.plan.planDigest,
        preparedReceipt: prepared,
        intent: {
          ...prepared.plan.mutations[0]!,
          cancelReason: null,
          state: 'applying',
          dispatchCount: 1,
          startedAt: 1,
        },
      };
    });
    vi.mocked(coordinator.recordNonAttemptedAndFollowup).mockResolvedValue({
      status: 'followup',
      generation: 1,
      mutationResult: 'not-attempted',
      retryAfterSeconds: 47,
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body)) as { phase?: unknown };
        if (raw.phase === 'prepare') {
          const request = await parseStewardRuntimeControlPrepareRequestV2(raw);
          return jsonResponse(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              await preparedV2(item, request.binding.generation, true),
            ),
          );
        }
        return jsonResponse(
          await canonicalStewardRuntimeControlMutationReceiptV2Json(
            await mutationReceiptV2(prepared!, {
              state: 'not-attempted',
              resourceId: null,
              retryAfterSeconds: 47,
            }),
          ),
        );
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item), 3);

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(coordinator.recordNonAttemptedAndFollowup).toHaveBeenCalledOnce();
    expect(coordinator.recordUnknownAndFail).not.toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 47 });
  });

  it('recovers the oldest unknown mutation under its exact prepared Control revision', async () => {
    const oldItem = reviewWorkItem('delivery-v2-recovery-old');
    const item = reviewWorkItem('delivery-v2-recovery-current');
    const prepared = await preparedV2(oldItem, 1, true);
    const coordinator = stub({
      status: 'claimed',
      generation: 2,
      leaseToken: 'opaque-v2-recovery-lease',
      expiresAt: Date.now() + 120_000,
    });
    vi.mocked(coordinator.claim)
      .mockResolvedValueOnce({
        status: 'claimed',
        generation: 2,
        leaseToken: 'opaque-v2-recovery-lease',
        expiresAt: Date.now() + 120_000,
      })
      .mockResolvedValueOnce({
        status: 'claimed',
        generation: 3,
        leaseToken: 'opaque-v2-fresh-lease',
        expiresAt: Date.now() + 120_000,
      });
    vi.mocked(coordinator.beginRecovery)
      .mockResolvedValueOnce({
        status: 'ready',
        planGeneration: 1,
        planId: prepared.plan.planId,
        planDigest: prepared.plan.planDigest,
        preparedReceipt: prepared,
        intent: {
          ...prepared.plan.mutations[0]!,
          cancelReason: null,
          state: 'unknown',
          dispatchCount: 1,
          startedAt: 1,
        },
      })
      .mockResolvedValueOnce({ status: 'none' });
    vi.mocked(coordinator.recordRecoveryResultAndComplete).mockResolvedValue({
      status: 'followup',
      generation: 2,
    });
    vi.mocked(coordinator.persistPreparedPlan).mockImplementation(
      async (generation, _leaseToken, _leaseDuration, value) => ({
        status: 'persisted',
        generation,
        planId: value.plan.planId,
        planDigest: value.plan.planDigest,
      }),
    );
    vi.mocked(coordinator.completeMutationPlan).mockResolvedValue({
      status: 'completed',
      generation: 3,
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body)) as { phase?: unknown };
        if (raw.phase === 'prepare') {
          const request = await parseStewardRuntimeControlPrepareRequestV2(raw);
          expect(request.binding.generation).toBe(3);
          return jsonResponse(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              await preparedV2(item, request.binding.generation, false),
            ),
          );
        }
        const request = await parseStewardRuntimeControlRecoverRequestV2(raw);
        expect(request.binding).toEqual({
          workItem: item,
          generation: 2,
          objective: 'governance',
        });
        expect(request.expectedControlRevision).toEqual(
          prepared.controlRevision,
        );
        return jsonResponse(
          await canonicalStewardRuntimeControlRecoveryReceiptV2Json(
            await recoveryReceiptV2(prepared, item, 2),
          ),
        );
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(control.fetch).toHaveBeenCalledTimes(2);
    const headers = new Headers(control.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('cloudflare-workers-version-overrides'))
      .toBe(`steward-control="${prepared.controlRevision.workerVersionId}"`);
    expect(coordinator.recordRecoveryResultAndComplete).toHaveBeenCalledWith(
      2,
      'opaque-v2-recovery-lease',
      1,
      expect.objectContaining({
        phase: 'recovery-result',
        result: expect.objectContaining({ state: 'converged' }),
      }),
    );
    expect(coordinator.persistPreparedPlan).toHaveBeenCalledWith(
      3,
      'opaque-v2-fresh-lease',
      coordinatorLeaseDurationMs,
      expect.objectContaining({
        binding: expect.objectContaining({ generation: 3 }),
        plan: expect.objectContaining({ mutationCount: 0 }),
      }),
    );
    expect(coordinator.beginNextMutation).toHaveBeenCalledWith(
      3,
      'opaque-v2-fresh-lease',
      coordinatorLeaseDurationMs,
    );
    expect(coordinator.completeMutationPlan).toHaveBeenCalledWith(
      3,
      'opaque-v2-fresh-lease',
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 'human-mutation-fenced' as const,
      headSha: 'b'.repeat(40),
      mutationType: 'copilot-review.request',
      sourceGeneration: 1,
    },
    {
      status: 'human-mutation-fence-capacity' as const,
      limit: 128,
    },
  ])('completes a prepared human mutation as action-required for $status', async (
    blocked,
  ) => {
    const item = reviewWorkItem(`delivery-v2-${blocked.status}`);
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-v2-human-fence-lease',
      expiresAt: Date.now() + 120_000,
    });
    vi.mocked(coordinator.beginNextMutation).mockResolvedValue(blocked);
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const request = await parseStewardRuntimeControlPrepareRequestV2(
          JSON.parse(String(init?.body)),
        );
        return jsonResponse(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await preparedV2(item, request.binding.generation, true),
          ),
        );
      }),
    };
    const queued = message(canonicalStewardRuntimeWorkItemJson(item));

    await processCoordinatorMessage(
      queued,
      environment({ [item.subject.repositoryId]: coordinator }, control),
    );

    expect(
      coordinator.recordHumanMutationActionRequiredAndComplete,
    ).toHaveBeenCalledWith(1, 'opaque-v2-human-fence-lease');
    expect(coordinator.fail).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('fails before persistence when a v2 candidate override silently falls back', async () => {
    const item = reviewWorkItem('delivery-v2-candidate-fallback');
    const candidateVersion = 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d';
    const coordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'opaque-v2-candidate-lease',
      expiresAt: Date.now() + 120_000,
    });
    const control = {
      fetch: vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
        const request = await parseStewardRuntimeControlPrepareRequestV2(
          JSON.parse(String(init?.body)),
        );
        const headers = new Headers(init?.headers);
        expect(headers.get('cloudflare-workers-version-overrides'))
          .toBe(`steward-control="${candidateVersion}"`);
        return jsonResponse(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await preparedV2(
              item,
              request.binding.generation,
              false,
              v2Revision,
            ),
          ),
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
          CONTROL_CANDIDATE_VERSION_ID: candidateVersion,
        },
      ),
    );

    expect(coordinator.persistPreparedPlan).not.toHaveBeenCalled();
    expect(coordinator.fail).toHaveBeenCalledWith(
      1,
      'opaque-v2-candidate-lease',
      'control-error',
    );
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
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
          workItem: StewardRuntimeWorkItem;
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

  it('enumerates exactly one repository page before durable release and self-wakeup', async () => {
    const scopeItem = repositoryScopeWorkItem('repository-page-delivery');
    const fanout = repositoryFanoutStub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'fanout-page-lease-token',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    const receiptValue = buildStewardRuntimeRepositoryFanoutPageReceiptV1({
      binding: {
        scopeWorkItem: scopeItem,
        generation: 1,
        pass: 1,
        cursor: null,
      },
      repository: {
        state: 'live',
        id: scopeItem.target.repositoryId,
        fullName: 'splrad/steward-sandbox-install-e2e',
      },
      page: {
        totalCount: 2,
        pullRequestNumbers: [6],
        hasNextPage: true,
        endCursor: 'cursor-after-pr-6',
      },
      controlRevision: v2Revision,
    });
    const control = {
      fetch: vi.fn(async (
        _input: Request | string | URL,
        init?: RequestInit,
      ) => {
        const request = parseStewardRuntimeRepositoryFanoutPageRequestV1(
          JSON.parse(String(init?.body)) as unknown,
        );
        expect(request.binding).toEqual({
          scopeWorkItem: scopeItem,
          generation: 1,
          pass: 1,
          cursor: null,
        });
        return jsonResponse(
          canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(
            receiptValue,
          ),
        );
      }),
    };
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );

    await processCoordinatorMessage(
      queued,
      environment({}, control, {
        REPOSITORY_FANOUT_COORDINATOR: {
          getByName: vi.fn().mockReturnValue(fanout),
        },
        EVENT_QUEUE: eventQueue,
      }),
    );

    expect(control.fetch).toHaveBeenCalledOnce();
    expect(fanout.recordPage).toHaveBeenCalledWith(
      1,
      'fanout-page-lease-token',
      receiptValue,
    );
    expect(fanout.releaseForContinuation).toHaveBeenCalledWith(
      1,
      'fanout-page-lease-token',
    );
    expect(eventQueue.send).toHaveBeenCalledWith(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
      { contentType: 'text' },
    );
    expect(eventQueue.sendBatch).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('uses repository-fanout-v2 for a scope-v2 page and preserves its cause', async () => {
    const scopeItem = repositoryScopeWorkItemV2();
    const fanout = repositoryFanoutStub({
      status: 'claimed',
      generation: 2,
      leaseToken: 'fanout-v2-page-lease-token',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    const receiptValue = buildStewardRuntimeRepositoryFanoutPageReceiptV2({
      binding: {
        scopeWorkItem: scopeItem,
        generation: 2,
        pass: 1,
        cursor: null,
      },
      repository: {
        state: 'live',
        id: scopeItem.target.repositoryId,
        fullName: 'splrad/steward-sandbox-install-e2e',
      },
      page: {
        totalCount: 1,
        pullRequestNumbers: [6],
        hasNextPage: false,
        endCursor: null,
      },
      controlRevision: v2Revision,
    });
    const control = {
      fetch: vi.fn(async (
        input: Request | string | URL,
        init?: RequestInit,
      ) => {
        expect(String(input)).toBe(
          'https://control.internal/v2/repository-fanout/page',
        );
        expect(new Headers(init?.headers).get('x-steward-internal-protocol'))
          .toBe('repository-fanout-2');
        expect(parseStewardRuntimeRepositoryFanoutPageRequestV2(
          JSON.parse(String(init?.body)) as unknown,
        ).binding.scopeWorkItem).toEqual(scopeItem);
        return jsonResponse(
          canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json(
            receiptValue,
          ),
        );
      }),
    };
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );

    await processCoordinatorMessage(
      queued,
      environment({}, control, {
        REPOSITORY_FANOUT_COORDINATOR: {
          getByName: vi.fn().mockReturnValue(fanout),
        },
        EVENT_QUEUE: eventQueue,
      }),
    );

    expect(fanout.recordPage).toHaveBeenCalledWith(
      2,
      'fanout-v2-page-lease-token',
      receiptValue,
    );
    expect(eventQueue.send).toHaveBeenCalledWith(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
      { contentType: 'text' },
    );
    expect(queued.ack).toHaveBeenCalledOnce();
  });

  it('dispatches canonical v3 children before durable confirmation, release, and wakeup', async () => {
    const scopeItem = repositoryScopeWorkItem(
      'repository-dispatch-delivery',
    );
    const generation = 7;
    const pullRequestNumbers = [6, 11] as const;
    const targets = await Promise.all(
      pullRequestNumbers.map(async (pullRequestNumber) => ({
        pullRequestNumber,
        deliveryId: await deriveStewardRuntimeFanoutDeliveryId(
          scopeItem,
          generation,
          pullRequestNumber,
        ),
      })),
    );
    const fanout = repositoryFanoutStub({
      status: 'claimed',
      generation,
      leaseToken: 'fanout-dispatch-lease-token',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'dispatch',
      pass: null,
      cursor: null,
    });
    fanout.nextDispatchBatch.mockResolvedValue({
      status: 'batch',
      generation,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      targets,
      remaining: 0,
    });
    fanout.recordQueueConfirmed.mockResolvedValue({
      status: 'recorded',
      generation,
      newlyConfirmed: targets.length,
      remaining: 0,
    });
    fanout.releaseForContinuation.mockResolvedValue({
      status: 'released',
      generation,
    });
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );

    await processCoordinatorMessage(
      queued,
      environment({}, undefined, {
        REPOSITORY_FANOUT_COORDINATOR: {
          getByName: vi.fn().mockReturnValue(fanout),
        },
        EVENT_QUEUE: eventQueue,
      }),
    );

    expect(eventQueue.sendBatch).toHaveBeenCalledOnce();
    const dispatched = eventQueue.sendBatch.mock.calls[0]![0];
    expect(dispatched).toHaveLength(targets.length);
    for (const [index, queuedChild] of dispatched.entries()) {
      const target = targets[index]!;
      const child = parseStewardRuntimeWorkItem(
        JSON.parse(queuedChild.body) as unknown,
      );
      expect(child.schemaVersion).toBe(3);
      expect(child.operation).toBe('pull-request-reconcile');
      expect(child.subject).toEqual({
        repositoryId: scopeItem.target.repositoryId,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: target.pullRequestNumber,
      });
      expect(child.cause).toEqual({
        kind: 'scope-fanout',
        deliveryId: target.deliveryId,
        rootDeliveryId: scopeItem.cause.deliveryId,
        scopeSchemaVersion: scopeItem.schemaVersion,
        fanoutGeneration: generation,
        event: scopeItem.cause.event,
        action: scopeItem.cause.action,
        receivedAt: scopeItem.cause.receivedAt,
      });
      expect(queuedChild.body).toBe(
        canonicalStewardRuntimeWorkItemJson(child),
      );
      expect(target.deliveryId).toBe(
        await deriveStewardRuntimeFanoutDeliveryId(
          scopeItem,
          generation,
          target.pullRequestNumber,
        ),
      );
    }
    expect(fanout.recordQueueConfirmed).toHaveBeenCalledWith(
      generation,
      'fanout-dispatch-lease-token',
      { confirmations: targets },
    );
    expect(
      eventQueue.sendBatch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fanout.recordQueueConfirmed.mock.invocationCallOrder[0]!,
    );
    expect(
      fanout.recordQueueConfirmed.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fanout.releaseForContinuation.mock.invocationCallOrder[0]!,
    );
    expect(eventQueue.send).toHaveBeenCalledWith(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
      { contentType: 'text' },
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('dispatches a ref-bound canonical v4 child from scope-v2', async () => {
    const scopeItem = repositoryScopeWorkItemV2('push-dispatch-delivery');
    const generation = 8;
    const deliveryId = await deriveStewardRuntimeFanoutDeliveryIdV2(
      scopeItem,
      generation,
      6,
    );
    const fanout = repositoryFanoutStub({
      status: 'claimed',
      generation,
      leaseToken: 'fanout-v2-dispatch-lease-token',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'dispatch',
      pass: null,
      cursor: null,
    });
    fanout.nextDispatchBatch.mockResolvedValue({
      status: 'batch',
      generation,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      targets: [{ pullRequestNumber: 6, deliveryId }],
      remaining: 0,
    });
    fanout.recordQueueConfirmed.mockResolvedValue({
      status: 'recorded',
      generation,
      newlyConfirmed: 1,
      remaining: 0,
    });
    fanout.releaseForContinuation.mockResolvedValue({
      status: 'released',
      generation,
    });
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );

    await processCoordinatorMessage(
      queued,
      environment({}, undefined, {
        REPOSITORY_FANOUT_COORDINATOR: {
          getByName: vi.fn().mockReturnValue(fanout),
        },
        EVENT_QUEUE: eventQueue,
      }),
    );

    const dispatched = eventQueue.sendBatch.mock.calls[0]![0];
    const child = parseStewardRuntimeWorkItem(
      JSON.parse(dispatched[0]!.body) as unknown,
    );
    expect(child).toMatchObject({
      schemaVersion: 4,
      cause: {
        kind: 'scope-fanout-2',
        deliveryId,
        rootDeliveryId: scopeItem.cause.deliveryId,
        scopeSchemaVersion: 2,
        fanoutGeneration: generation,
        event: 'push',
        action: null,
        ref: 'refs/heads/main',
      },
    });
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('routes a derived v3 child through Control v2 and rejects a tampered child before invocation', async () => {
    const scopeItem = repositoryScopeWorkItem(
      'repository-v3-direct-delivery',
    );
    const fanoutGeneration = 7;
    const pullRequestNumber = 6;
    const deliveryId = await deriveStewardRuntimeFanoutDeliveryId(
      scopeItem,
      fanoutGeneration,
      pullRequestNumber,
    );
    const child = buildStewardRuntimeWorkItemV3({
      operation: 'pull-request-reconcile',
      installationId: scopeItem.target.installationId,
      subject: {
        repositoryId: scopeItem.target.repositoryId,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber,
      },
      cause: {
        kind: 'scope-fanout',
        deliveryId,
        rootDeliveryId: scopeItem.cause.deliveryId,
        scopeSchemaVersion: scopeItem.schemaVersion,
        fanoutGeneration,
        event: scopeItem.cause.event,
        action: scopeItem.cause.action,
        receivedAt: scopeItem.cause.receivedAt,
      },
    });
    const validCoordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'v3-direct-valid-lease-token',
      expiresAt: Date.now() + 120_000,
    });
    const validControl = {
      fetch: vi.fn(async (
        _input: Request | string | URL,
        init?: RequestInit,
      ) => {
        const request = await parseStewardRuntimeControlPrepareRequestV2(
          JSON.parse(String(init?.body)) as unknown,
        );
        expect(request.binding).toEqual({
          workItem: child,
          generation: 1,
          objective: 'governance',
        });
        return jsonResponse(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await preparedV2(child, request.binding.generation),
          ),
        );
      }),
    };
    const validMessage = message(
      canonicalStewardRuntimeWorkItemJson(child),
    );

    await processCoordinatorMessage(
      validMessage,
      environment(
        { [child.subject.repositoryId]: validCoordinator },
        validControl,
      ),
    );

    expect(validControl.fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(validControl.fetch.mock.calls[0]?.[1]?.headers)
        .get('x-steward-internal-protocol'),
    ).toBe('2');
    expect(validCoordinator.persistPreparedPlan).toHaveBeenCalledOnce();
    expect(validCoordinator.completeMutationPlan).toHaveBeenCalledWith(
      1,
      'v3-direct-valid-lease-token',
    );
    expect(validCoordinator.complete).not.toHaveBeenCalled();
    expect(validMessage.ack).toHaveBeenCalledOnce();
    expect(validMessage.retry).not.toHaveBeenCalled();

    const tamperedChild = {
      ...child,
      cause: {
        ...child.cause,
        deliveryId: `fanout-v1:${'0'.repeat(64)}`,
      },
    };
    const tamperedCoordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'v3-direct-tampered-lease-token',
      expiresAt: Date.now() + 120_000,
    });
    const tamperedControl = { fetch: vi.fn() };
    const tamperedMessage = message(
      canonicalStewardRuntimeWorkItemJson(tamperedChild),
    );

    await processCoordinatorMessage(
      tamperedMessage,
      environment(
        { [child.subject.repositoryId]: tamperedCoordinator },
        tamperedControl,
      ),
    );

    expect(tamperedControl.fetch).not.toHaveBeenCalled();
    expect(tamperedCoordinator.persistPreparedPlan).not.toHaveBeenCalled();
    expect(tamperedCoordinator.completeMutationPlan).not.toHaveBeenCalled();
    expect(tamperedCoordinator.fail).toHaveBeenCalledWith(
      1,
      'v3-direct-tampered-lease-token',
      'runtime-error',
    );
    expect(tamperedMessage.ack).not.toHaveBeenCalled();
    expect(tamperedMessage.retry).toHaveBeenCalledOnce();
  });

  it('routes a two-level V5 child through Control and rejects a tampered commitment before invocation', async () => {
    const child = await installationFanoutWorkItemV5();
    const validCoordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'v5-direct-valid-lease-token',
      expiresAt: Date.now() + 120_000,
    });
    const validControl = {
      fetch: vi.fn(async (
        _input: Request | string | URL,
        init?: RequestInit,
      ) => {
        const request = await parseStewardRuntimeControlPrepareRequestV2(
          JSON.parse(String(init?.body)) as unknown,
        );
        expect(request.binding).toEqual({
          workItem: child,
          generation: 1,
          objective: 'governance',
        });
        return jsonResponse(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await preparedV2(child, request.binding.generation),
          ),
        );
      }),
    };
    const validMessage = message(
      canonicalStewardRuntimeWorkItemJson(child),
    );

    await processCoordinatorMessage(
      validMessage,
      environment(
        { [child.subject.repositoryId]: validCoordinator },
        validControl,
      ),
    );

    expect(validControl.fetch).toHaveBeenCalledOnce();
    expect(validCoordinator.persistPreparedPlan).toHaveBeenCalledOnce();
    expect(validCoordinator.completeMutationPlan).toHaveBeenCalledWith(
      1,
      'v5-direct-valid-lease-token',
    );
    expect(validMessage.ack).toHaveBeenCalledOnce();
    expect(validMessage.retry).not.toHaveBeenCalled();

    if (child.cause.kind !== 'scope-fanout-3') {
      throw new Error('V5 fixture must use scope-fanout-3');
    }
    const tamperedChild = {
      ...child,
      cause: {
        ...child.cause,
        installationChild: {
          ...child.cause.installationChild,
          rootTargetDigest: '0'.repeat(64),
        },
      },
    };
    const tamperedCoordinator = stub({
      status: 'claimed',
      generation: 1,
      leaseToken: 'v5-direct-tampered-lease-token',
      expiresAt: Date.now() + 120_000,
    });
    const tamperedControl = { fetch: vi.fn() };
    const tamperedMessage = message(
      canonicalStewardRuntimeWorkItemJson(tamperedChild),
    );

    await processCoordinatorMessage(
      tamperedMessage,
      environment(
        { [child.subject.repositoryId]: tamperedCoordinator },
        tamperedControl,
      ),
    );

    expect(tamperedControl.fetch).not.toHaveBeenCalled();
    expect(tamperedCoordinator.persistPreparedPlan).not.toHaveBeenCalled();
    expect(tamperedCoordinator.completeMutationPlan).not.toHaveBeenCalled();
    expect(tamperedCoordinator.fail).toHaveBeenCalledWith(
      1,
      'v5-direct-tampered-lease-token',
      'runtime-error',
    );
    expect(tamperedMessage.ack).not.toHaveBeenCalled();
    expect(tamperedMessage.retry).toHaveBeenCalledOnce();
  });

  it('replays deterministic child IDs after a partially observed sendBatch failure', async () => {
    const scopeItem = repositoryScopeWorkItem(
      'repository-queue-replay-delivery',
    );
    const generation = 9;
    const targets = await Promise.all([6, 11].map(
      async (pullRequestNumber) => ({
        pullRequestNumber,
        deliveryId: await deriveStewardRuntimeFanoutDeliveryId(
          scopeItem,
          generation,
          pullRequestNumber,
        ),
      }),
    ));
    const firstClaim = {
      status: 'claimed' as const,
      generation,
      leaseToken: 'fanout-replay-lease-token-a',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'dispatch' as const,
      pass: null,
      cursor: null,
    };
    const fanout = repositoryFanoutStub(firstClaim);
    fanout.claim
      .mockResolvedValueOnce(firstClaim)
      .mockResolvedValueOnce({
        ...firstClaim,
        leaseToken: 'fanout-replay-lease-token-b',
        resumed: true,
      });
    fanout.nextDispatchBatch.mockResolvedValue({
      status: 'batch',
      generation,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      targets,
      remaining: 0,
    });
    fanout.recordQueueConfirmed.mockResolvedValue({
      status: 'recorded',
      generation,
      newlyConfirmed: targets.length,
      remaining: 0,
    });
    fanout.releaseForContinuation.mockResolvedValue({
      status: 'released',
      generation,
    });
    const attemptedBatches: string[][] = [];
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn()
        .mockImplementationOnce(async (
          queuedChildren: readonly { readonly body: string }[],
        ) => {
          attemptedBatches.push(queuedChildren.map((child) => child.body));
          // Model a response loss after the provider may have persisted a
          // prefix. The retry must safely reproduce the same identifiers.
          throw new Error('sendBatch response lost after partial acceptance');
        })
        .mockImplementationOnce(async (
          queuedChildren: readonly { readonly body: string }[],
        ) => {
          attemptedBatches.push(queuedChildren.map((child) => child.body));
        }),
    };
    const firstMessage = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );
    const secondMessage = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
      2,
    );
    const env = environment({}, undefined, {
      REPOSITORY_FANOUT_COORDINATOR: {
        getByName: vi.fn().mockReturnValue(fanout),
      },
      EVENT_QUEUE: eventQueue,
    });

    await processCoordinatorMessage(firstMessage, env);

    expect(fanout.fail).toHaveBeenCalledWith(
      generation,
      'fanout-replay-lease-token-a',
      'queue-error',
    );
    expect(fanout.recordQueueConfirmed).not.toHaveBeenCalled();
    expect(firstMessage.ack).not.toHaveBeenCalled();
    expect(firstMessage.retry).toHaveBeenCalledOnce();

    await processCoordinatorMessage(secondMessage, env);

    expect(attemptedBatches).toHaveLength(2);
    expect(attemptedBatches[1]).toEqual(attemptedBatches[0]);
    expect(
      attemptedBatches[1]!.map((body) =>
        parseStewardRuntimeWorkItem(
          JSON.parse(body) as unknown,
        ).cause.deliveryId),
    ).toEqual(targets.map((target) => target.deliveryId));
    expect(fanout.recordQueueConfirmed).toHaveBeenCalledWith(
      generation,
      'fanout-replay-lease-token-b',
      { confirmations: targets },
    );
    expect(secondMessage.ack).toHaveBeenCalledOnce();
    expect(secondMessage.retry).not.toHaveBeenCalled();
  });

  it('completes a zero-target repository generation without Control or Queue dispatch', async () => {
    const scopeItem = repositoryScopeWorkItem(
      'repository-zero-target-delivery',
    );
    const generation = 3;
    const fanout = repositoryFanoutStub({
      status: 'claimed',
      generation,
      leaseToken: 'fanout-zero-target-lease',
      expiresAt: Date.now() + 120_000,
      resumed: false,
      selectedScopeItem: scopeItem,
      phase: 'dispatch',
      pass: null,
      cursor: null,
    });
    fanout.nextDispatchBatch.mockResolvedValue({
      status: 'batch',
      generation,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      targets: [],
      remaining: 0,
    });
    fanout.complete.mockResolvedValue({
      status: 'completed',
      generation,
    });
    const control = { fetch: vi.fn() };
    const eventQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    const queued = message(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItem),
    );

    await processCoordinatorMessage(
      queued,
      environment({}, control, {
        REPOSITORY_FANOUT_COORDINATOR: {
          getByName: vi.fn().mockReturnValue(fanout),
        },
        EVENT_QUEUE: eventQueue,
      }),
    );

    expect(fanout.complete).toHaveBeenCalledWith(
      generation,
      'fanout-zero-target-lease',
    );
    expect(control.fetch).not.toHaveBeenCalled();
    expect(eventQueue.send).not.toHaveBeenCalled();
    expect(eventQueue.sendBatch).not.toHaveBeenCalled();
    expect(fanout.recordQueueConfirmed).not.toHaveBeenCalled();
    expect(fanout.releaseForContinuation).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('does not expose an HTTP route', async () => {
    const response = await createCoordinatorHandler().fetch(
      new Request('https://coordinator.internal/health'),
      environment({}),
    );
    expect(response.status).toBe(404);
  });
});
