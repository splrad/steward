import {
  buildStewardRuntimeControlApplyNextRequestV2,
  buildStewardRuntimeControlPrepareRequestV2,
  buildStewardRuntimeControlRecoverRequestV2,
  canonicalStewardRuntimeControlApplyNextRequestV2Json,
  canonicalStewardRuntimeControlPrepareRequestV2Json,
  canonicalStewardRuntimeControlRecoverRequestV2Json,
  canonicalStewardRuntimeWorkItemJson,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlMutationReceiptV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlRecoveryReceiptV2,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeWorkItemV2,
  type StewardRuntimeWorkItemV3,
} from '../../core/src/index.js';
import type {
  CoordinatorClaimResult,
  CoordinatorCompleteResult,
  CoordinatorFailResult,
  CoordinatorFailureCode,
} from './contracts.js';
import type {
  CoordinatorFencedBeginMutationResult,
  CoordinatorFencedBeginRecoveryResult,
  CoordinatorNonAttemptedFollowupResult,
  CoordinatorPersistPreparedPlanResult,
  CoordinatorRecordMutationResult,
} from './mutation-ledger.js';

export type ClaimedCoordinatorGeneration = Extract<
  CoordinatorClaimResult,
  { status: 'claimed' }
>;

export type StewardRuntimeGovernanceWorkItem =
  | StewardRuntimeWorkItemV2
  | StewardRuntimeWorkItemV3;

export interface PullRequestCoordinatorV2Stub {
  fail(
    generation: number,
    leaseToken: string,
    failureCode: CoordinatorFailureCode,
  ): Promise<CoordinatorFailResult>;
  persistPreparedPlan(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
    value: StewardRuntimeControlPreparedReceiptV2,
  ): Promise<CoordinatorPersistPreparedPlanResult>;
  beginNextMutation(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorFencedBeginMutationResult>;
  recordHumanMutationActionRequiredAndComplete(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult>;
  recordMutationResult(
    generation: number,
    leaseToken: string,
    value: StewardRuntimeControlMutationReceiptV2,
  ): Promise<CoordinatorRecordMutationResult>;
  recordNonAttemptedAndFollowup(
    generation: number,
    leaseToken: string,
    value: StewardRuntimeControlMutationReceiptV2,
  ): Promise<CoordinatorNonAttemptedFollowupResult>;
  recordUnknownAndFail(
    generation: number,
    leaseToken: string,
    mutationBinding: StewardRuntimeControlMutationBindingV2,
  ): Promise<CoordinatorFailResult>;
  beginRecovery(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorFencedBeginRecoveryResult>;
  recordRecoveryResultAndComplete(
    generation: number,
    leaseToken: string,
    planGeneration: number,
    value: StewardRuntimeControlRecoveryReceiptV2,
  ): Promise<CoordinatorCompleteResult | CoordinatorFailResult>;
  completeMutationPlan(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult>;
}

export class CoordinatorV2InvocationError extends Error {
  constructor(
    readonly failureCode: CoordinatorFailureCode,
    readonly retryDelaySeconds: number,
  ) {
    super('Private Control v2 invocation failed');
    this.name = 'CoordinatorV2InvocationError';
  }
}

export interface CoordinatorV2RunnerPorts {
  readonly leaseDurationMs: number;
  retryDelaySeconds(attempts: number): number;
  selectedControlVersion(): string | undefined;
  invokePrepare(
    body: string,
    expectedVersion: string | undefined,
  ): Promise<StewardRuntimeControlPreparedReceiptV2>;
  invokeMutation(
    body: string,
    expectedVersion: string,
  ): Promise<StewardRuntimeControlMutationReceiptV2>;
  invokeRecovery(
    body: string,
    expectedVersion: string,
  ): Promise<StewardRuntimeControlRecoveryReceiptV2>;
}

export type V2GenerationResult =
  | {
      readonly status: 'completion';
      readonly completion: CoordinatorCompleteResult;
    }
  | {
      readonly status: 'retry';
      readonly delaySeconds: number;
    };

function sameControlRevision(
  left: StewardRuntimeControlRevisionV1,
  right: StewardRuntimeControlRevisionV1,
): boolean {
  return left.stewardCommit === right.stewardCommit
    && left.workerVersionId === right.workerVersionId
    && left.workerVersionTag === right.workerVersionTag
    && left.workerVersionCreatedAt === right.workerVersionCreatedAt;
}

function mutationBinding(
  value: Extract<
    CoordinatorFencedBeginMutationResult,
    { status: 'ready' }
  >['intent']
  | Extract<
    CoordinatorFencedBeginRecoveryResult,
    { status: 'ready' }
  >['intent'],
): StewardRuntimeControlMutationBindingV2 {
  return {
    ordinal: value.ordinal,
    key: value.key,
    mutationType: value.mutationType,
    principal: value.principal,
    recoveryPolicy: value.recoveryPolicy,
    desiredDigest: value.desiredDigest,
  };
}

type StewardRuntimeControlReceiptV2 =
  | StewardRuntimeControlPreparedReceiptV2
  | StewardRuntimeControlMutationReceiptV2
  | StewardRuntimeControlRecoveryReceiptV2;

function v2ReceiptMatchesBinding(
  receipt: StewardRuntimeControlReceiptV2,
  workItem: StewardRuntimeGovernanceWorkItem,
  generation: number,
  expectedRevision?: StewardRuntimeControlRevisionV1,
): boolean {
  return receipt.binding.generation === generation
    && receipt.binding.objective === 'governance'
    && canonicalStewardRuntimeWorkItemJson(receipt.binding.workItem)
      === canonicalStewardRuntimeWorkItemJson(workItem)
    && (
      expectedRevision === undefined
      || sameControlRevision(receipt.controlRevision, expectedRevision)
    );
}

function sameMutationBinding(
  left: StewardRuntimeControlMutationBindingV2,
  right: StewardRuntimeControlMutationBindingV2,
): boolean {
  return left.ordinal === right.ordinal
    && left.key === right.key
    && left.mutationType === right.mutationType
    && left.principal === right.principal
    && left.recoveryPolicy === right.recoveryPolicy
    && left.desiredDigest === right.desiredDigest;
}

function receiptMatchesPersistedPlan(
  receipt:
    | StewardRuntimeControlMutationReceiptV2
    | StewardRuntimeControlRecoveryReceiptV2,
  prepared: StewardRuntimeControlPreparedReceiptV2,
  mutation: StewardRuntimeControlMutationBindingV2,
): boolean {
  return receipt.planId === prepared.plan.planId
    && receipt.planDigest === prepared.plan.planDigest
    && sameMutationBinding(receipt.mutation, mutation)
    && receipt.resolvedContext.repositoryId
      === prepared.resolvedContext.repositoryId
    && receipt.resolvedContext.repositoryFullName
      === prepared.resolvedContext.repositoryFullName
    && receipt.resolvedContext.pullRequestNumber
      === prepared.resolvedContext.pullRequestNumber
    && receipt.resolvedContext.headSha === prepared.resolvedContext.headSha
    && receipt.resolvedContext.defaultBranch
      === prepared.resolvedContext.defaultBranch
    && receipt.resolvedContext.manifestBlobSha
      === prepared.resolvedContext.manifestBlobSha
    && receipt.resolvedContext.configDigest
      === prepared.resolvedContext.configDigest
    && receipt.resolvedContext.pullRequestDigest
      === prepared.resolvedContext.pullRequestDigest;
}

async function failClaimAndRetry(
  coordinator: PullRequestCoordinatorV2Stub,
  claim: ClaimedCoordinatorGeneration,
  attempts: number,
  ports: CoordinatorV2RunnerPorts,
  failureCode: CoordinatorFailureCode = 'runtime-error',
  retryDelaySeconds = ports.retryDelaySeconds(attempts),
): Promise<V2GenerationResult> {
  try {
    await coordinator.fail(
      claim.generation,
      claim.leaseToken,
      failureCode,
    );
  } catch {
    // Queue redelivery plus lease expiry remain authoritative.
  }
  return { status: 'retry', delaySeconds: retryDelaySeconds };
}

async function markUnknownAndRetry(
  coordinator: PullRequestCoordinatorV2Stub,
  claim: ClaimedCoordinatorGeneration,
  mutation: StewardRuntimeControlMutationBindingV2,
  attempts: number,
  ports: CoordinatorV2RunnerPorts,
  retryDelaySeconds = ports.retryDelaySeconds(attempts),
): Promise<V2GenerationResult> {
  try {
    await coordinator.recordUnknownAndFail(
      claim.generation,
      claim.leaseToken,
      mutation,
    );
  } catch {
    // A stale fence is audited to unknown by the Durable Object before a
    // later generation can prepare or dispatch another mutation.
  }
  return { status: 'retry', delaySeconds: retryDelaySeconds };
}

type V2RecoveryAttempt =
  | { readonly status: 'none' }
  | V2GenerationResult;

async function recoverUnknownV2(
  coordinator: PullRequestCoordinatorV2Stub,
  claim: ClaimedCoordinatorGeneration,
  workItem: StewardRuntimeGovernanceWorkItem,
  attempts: number,
  ports: CoordinatorV2RunnerPorts,
): Promise<V2RecoveryAttempt> {
  let recovery: CoordinatorFencedBeginRecoveryResult;
  try {
    recovery = await coordinator.beginRecovery(
      claim.generation,
      claim.leaseToken,
      ports.leaseDurationMs,
    );
  } catch {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
    );
  }
  if (recovery.status === 'stale') {
    return {
      status: 'retry',
      delaySeconds: ports.retryDelaySeconds(attempts),
    };
  }
  if (recovery.status === 'none') return { status: 'none' };

  const prepared = recovery.preparedReceipt;
  const mutation = mutationBinding(recovery.intent);
  let body: string;
  try {
    body = await canonicalStewardRuntimeControlRecoverRequestV2Json(
      await buildStewardRuntimeControlRecoverRequestV2({
        binding: {
          workItem,
          generation: claim.generation,
          objective: 'governance',
        },
        expectedControlRevision: prepared.controlRevision,
        resolvedContext: prepared.resolvedContext,
        plan: prepared.plan,
        mutation,
      }),
    );
  } catch {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
    );
  }

  let receipt: StewardRuntimeControlRecoveryReceiptV2;
  try {
    receipt = await ports.invokeRecovery(
      body,
      prepared.controlRevision.workerVersionId,
    );
  } catch (error) {
    const failure = error instanceof CoordinatorV2InvocationError
      ? error
      : new CoordinatorV2InvocationError(
          'runtime-error',
          ports.retryDelaySeconds(attempts),
        );
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
      failure.failureCode,
      failure.retryDelaySeconds,
    );
  }

  if (
    !v2ReceiptMatchesBinding(
      receipt,
      workItem,
      claim.generation,
      prepared.controlRevision,
    )
    || !receiptMatchesPersistedPlan(receipt, prepared, mutation)
  ) {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
      'control-error',
    );
  }

  let completion: CoordinatorCompleteResult | CoordinatorFailResult;
  try {
    completion = await coordinator.recordRecoveryResultAndComplete(
      claim.generation,
      claim.leaseToken,
      recovery.planGeneration,
      receipt,
    );
  } catch {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
    );
  }
  if (completion.status === 'stale') {
    return {
      status: 'retry',
      delaySeconds: ports.retryDelaySeconds(attempts),
    };
  }
  if (receipt.result.state === 'unknown') {
    return {
      status: 'retry',
      delaySeconds: ports.retryDelaySeconds(attempts),
    };
  }
  return { status: 'completion', completion };
}

export async function runControlV2Generation(
  coordinator: PullRequestCoordinatorV2Stub,
  claim: ClaimedCoordinatorGeneration,
  workItem: StewardRuntimeGovernanceWorkItem,
  attempts: number,
  ports: CoordinatorV2RunnerPorts,
): Promise<V2GenerationResult> {
  const recovery = await recoverUnknownV2(
    coordinator,
    claim,
    workItem,
    attempts,
    ports,
  );
  if (recovery.status !== 'none') return recovery;

  let expectedVersion: string | undefined;
  let prepareBody: string;
  try {
    expectedVersion = ports.selectedControlVersion();
    prepareBody = await canonicalStewardRuntimeControlPrepareRequestV2Json(
      await buildStewardRuntimeControlPrepareRequestV2({
        binding: {
          workItem,
          generation: claim.generation,
          objective: 'governance',
        },
      }),
    );
  } catch {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
    );
  }

  let prepared: StewardRuntimeControlPreparedReceiptV2;
  try {
    prepared = await ports.invokePrepare(prepareBody, expectedVersion);
  } catch (error) {
    const failure = error instanceof CoordinatorV2InvocationError
      ? error
      : new CoordinatorV2InvocationError(
          'runtime-error',
          ports.retryDelaySeconds(attempts),
        );
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
      failure.failureCode,
      failure.retryDelaySeconds,
    );
  }
  if (!v2ReceiptMatchesBinding(prepared, workItem, claim.generation)) {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
      'control-error',
    );
  }

  let persistence: CoordinatorPersistPreparedPlanResult;
  try {
    persistence = await coordinator.persistPreparedPlan(
      claim.generation,
      claim.leaseToken,
      ports.leaseDurationMs,
      prepared,
    );
  } catch {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
    );
  }
  if (persistence.status === 'stale') {
    return {
      status: 'retry',
      delaySeconds: ports.retryDelaySeconds(attempts),
    };
  }
  if (persistence.status === 'conflict') {
    return await failClaimAndRetry(
      coordinator,
      claim,
      attempts,
      ports,
      'control-error',
    );
  }
  if (persistence.status === 'recovery-required') {
    const racedRecovery = await recoverUnknownV2(
      coordinator,
      claim,
      workItem,
      attempts,
      ports,
    );
    return racedRecovery.status === 'none'
      ? await failClaimAndRetry(
          coordinator,
          claim,
          attempts,
          ports,
        )
      : racedRecovery;
  }

  for (
    let dispatched = 0;
    dispatched <= prepared.plan.mutationCount;
    dispatched += 1
  ) {
    let next: CoordinatorFencedBeginMutationResult;
    try {
      next = await coordinator.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        ports.leaseDurationMs,
      );
    } catch {
      return await failClaimAndRetry(
        coordinator,
        claim,
        attempts,
        ports,
      );
    }
    if (next.status === 'stale') {
      return {
        status: 'retry',
        delaySeconds: ports.retryDelaySeconds(attempts),
      };
    }
    if (next.status === 'none') {
      let completion: CoordinatorCompleteResult;
      try {
        completion = await coordinator.completeMutationPlan(
          claim.generation,
          claim.leaseToken,
        );
      } catch {
        return await failClaimAndRetry(
          coordinator,
          claim,
          attempts,
          ports,
        );
      }
      return completion.status === 'stale'
        ? {
            status: 'retry',
            delaySeconds: ports.retryDelaySeconds(attempts),
          }
        : { status: 'completion', completion };
    }
    if (
      next.status === 'human-mutation-fenced'
      || next.status === 'human-mutation-fence-capacity'
    ) {
      let completion: CoordinatorCompleteResult;
      try {
        completion =
          await coordinator.recordHumanMutationActionRequiredAndComplete(
            claim.generation,
            claim.leaseToken,
          );
      } catch {
        return await failClaimAndRetry(
          coordinator,
          claim,
          attempts,
          ports,
        );
      }
      return completion.status === 'stale'
        ? {
            status: 'retry',
            delaySeconds: ports.retryDelaySeconds(attempts),
          }
        : { status: 'completion', completion };
    }
    if (next.status !== 'ready') {
      return await failClaimAndRetry(
        coordinator,
        claim,
        attempts,
        ports,
      );
    }

    const mutation = mutationBinding(next.intent);
    let body: string;
    try {
      body = await canonicalStewardRuntimeControlApplyNextRequestV2Json(
        await buildStewardRuntimeControlApplyNextRequestV2({
          binding: prepared.binding,
          expectedControlRevision: prepared.controlRevision,
          resolvedContext: prepared.resolvedContext,
          plan: prepared.plan,
          mutation,
        }),
      );
    } catch {
      return await markUnknownAndRetry(
        coordinator,
        claim,
        mutation,
        attempts,
        ports,
      );
    }

    let receipt: StewardRuntimeControlMutationReceiptV2;
    try {
      receipt = await ports.invokeMutation(
        body,
        prepared.controlRevision.workerVersionId,
      );
    } catch (error) {
      const delay = error instanceof CoordinatorV2InvocationError
        ? error.retryDelaySeconds
        : ports.retryDelaySeconds(attempts);
      return await markUnknownAndRetry(
        coordinator,
        claim,
        mutation,
        attempts,
        ports,
        delay,
      );
    }

    if (
      !v2ReceiptMatchesBinding(
        receipt,
        workItem,
        claim.generation,
        prepared.controlRevision,
      )
      || !receiptMatchesPersistedPlan(receipt, prepared, mutation)
    ) {
      return await markUnknownAndRetry(
        coordinator,
        claim,
        mutation,
        attempts,
        ports,
      );
    }

    if (
      receipt.result.state === 'applied'
      || receipt.result.state === 'converged'
    ) {
      let recorded: CoordinatorRecordMutationResult;
      try {
        recorded = await coordinator.recordMutationResult(
          claim.generation,
          claim.leaseToken,
          receipt,
        );
      } catch {
        return await markUnknownAndRetry(
          coordinator,
          claim,
          mutation,
          attempts,
          ports,
        );
      }
      if (recorded.status === 'stale') {
        return await markUnknownAndRetry(
          coordinator,
          claim,
          mutation,
          attempts,
          ports,
        );
      }
      continue;
    }

    if (
      receipt.result.state === 'not-attempted'
      || receipt.result.state === 'stale-plan'
    ) {
      let followup: CoordinatorNonAttemptedFollowupResult;
      try {
        followup = await coordinator.recordNonAttemptedAndFollowup(
          claim.generation,
          claim.leaseToken,
          receipt,
        );
      } catch {
        return await markUnknownAndRetry(
          coordinator,
          claim,
          mutation,
          attempts,
          ports,
        );
      }
      if (followup.status === 'stale') {
        return {
          status: 'retry',
          delaySeconds: ports.retryDelaySeconds(attempts),
        };
      }
      if (receipt.result.state === 'not-attempted') {
        return followup.mutationResult === 'not-attempted'
          ? {
              status: 'retry',
              delaySeconds: followup.retryAfterSeconds,
            }
          : {
              status: 'retry',
              delaySeconds: ports.retryDelaySeconds(attempts),
            };
      }
      return {
        status: 'completion',
        completion: {
          status: 'followup',
          generation: followup.generation,
        },
      };
    }

    return await markUnknownAndRetry(
      coordinator,
      claim,
      mutation,
      attempts,
      ports,
    );
  }

  return await failClaimAndRetry(
    coordinator,
    claim,
    attempts,
    ports,
  );
}
