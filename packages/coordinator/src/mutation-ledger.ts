import {
  canonicalStewardRuntimeControlPreparedReceiptV2Json,
  parseStewardRuntimeControlMutationReceiptV2,
  parseStewardRuntimeControlPreparedReceiptV2,
  parseStewardRuntimeControlRecoveryReceiptV2,
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES,
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlMutationReceiptV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlPrincipalV2,
  type StewardRuntimeControlRecoveryPolicyV2,
  type StewardRuntimeControlRecoveryReceiptV2,
  type StewardRuntimeControlResolvedContextV2,
  type StewardRuntimeControlTerminalOutcomeV2,
} from '../../core/src/runtime-control-v2.js';
import {
  canonicalStewardRuntimeWorkItemJson,
  type StewardRuntimeWorkItemOperationV1,
} from '../../core/src/runtime-work-item.js';
import type {
  StewardRuntimeControlRevisionV1,
} from '../../core/src/runtime-control.js';

export const coordinatorMutationSchemaVersion = 1 as const;
export const coordinatorMutationPlanRetentionLimit = 128;
export const coordinatorHumanMutationFenceLimit = 128;
export const coordinatorMutationPlanRetentionMs = 7 * 24 * 60 * 60 * 1_000;
export const coordinatorMaximumMutationIntents =
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS;
export const coordinatorMaximumCanonicalPlanBytes =
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES;

const digestPattern = /^[0-9a-f]{64}$/;
const opaqueAsciiPattern = /^[\x21-\x7e]{1,128}$/;

export type CoordinatorMutationPlanState =
  | 'prepared'
  | 'applying'
  | 'recovering'
  | 'settled'
  | 'pending-external'
  | 'ignored'
  | 'action-required'
  | 'unknown'
  | 'abandoned'
  | 'superseded';

export type CoordinatorMutationIntentState =
  | 'planned'
  | 'applying'
  | 'settled'
  | 'unknown'
  | 'action-required'
  | 'cancelled';

export type CoordinatorMutationCancellationReason =
  | 'blocked-by-action-required'
  | 'superseded-by-replan'
  | 'not-attempted'
  | 'stale-plan';

export type CoordinatorMutationResultState = 'applied' | 'converged';
export type CoordinatorMutationReceiptSource = 'apply' | 'recovery';
export type CoordinatorMutationTerminalOutcome =
  StewardRuntimeControlTerminalOutcomeV2;
export type CoordinatorMutationRecoveryOutcome =
  'converged'
  | 'action-required'
  | 'unknown';

export interface CoordinatorPreparedMutationPlanV1 {
  readonly receipt: StewardRuntimeControlPreparedReceiptV2;
  readonly receiptJson: string;
  readonly workItemJson: string;
  readonly workItemDigest: string;
}

export interface CoordinatorMutationIntentRecord {
  cancelReason: CoordinatorMutationCancellationReason | null;
  desiredDigest: string;
  dispatchCount: number;
  key: string;
  mutationType: string;
  ordinal: number;
  principal: StewardRuntimeControlPrincipalV2;
  recoveryPolicy: StewardRuntimeControlRecoveryPolicyV2;
  startedAt: number | null;
  state: CoordinatorMutationIntentState;
}

export interface CoordinatorMutationReceiptRecord {
  desiredDigest: string;
  key: string;
  ordinal: number;
  recordedAt: number;
  resourceId: number | null;
  result: CoordinatorMutationResultState;
  source: CoordinatorMutationReceiptSource;
}

export interface CoordinatorHumanMutationFenceRecord {
  createdAt: number;
  desiredDigest: string;
  headSha: string;
  key: string;
  mutationType: string;
  sourceGeneration: number;
  sourcePlanDigest: string;
  sourcePlanId: string;
}

export interface CoordinatorMutationPlanStoredState {
  canonicalPlanBase64: string;
  canonicalPlanByteLength: number;
  controlRevision: StewardRuntimeControlRevisionV1;
  createdAt: number;
  deliveryId: string;
  generation: number;
  installationId: number;
  intents: CoordinatorMutationIntentRecord[];
  objective: string;
  operation: StewardRuntimeWorkItemOperationV1;
  planDigest: string;
  planId: string;
  preparedReceiptJson: string;
  receipts: CoordinatorMutationReceiptRecord[];
  recoveryGeneration: number | null;
  resolvedContext: StewardRuntimeControlResolvedContextV2;
  state: CoordinatorMutationPlanState;
  terminalAt: number | null;
  terminalOutcome: CoordinatorMutationTerminalOutcome;
  updatedAt: number;
  workItemDigest: string;
  workItemJson: string;
}

export type CoordinatorBeginMutationResult =
  | {
      status: 'ready';
      generation: number;
      planId: string;
      planDigest: string;
      preparedReceipt: StewardRuntimeControlPreparedReceiptV2;
      intent: CoordinatorMutationIntentRecord;
    }
  | {
      status: 'already-started' | 'recovery-required' | 'terminal' | 'none';
    }
  | {
      status: 'human-mutation-fenced';
      headSha: string;
      mutationType: string;
      sourceGeneration: number;
    }
  | {
      status: 'human-mutation-fence-capacity';
      limit: number;
    };

export type CoordinatorBeginRecoveryResult =
  | {
      status: 'ready';
      planGeneration: number;
      planId: string;
      planDigest: string;
      preparedReceipt: StewardRuntimeControlPreparedReceiptV2;
      intent: CoordinatorMutationIntentRecord;
    }
  | {
      status: 'none';
    };

export type CoordinatorPersistPreparedPlanResult =
  | {
      status: 'persisted' | 'duplicate';
      generation: number;
      planId: string;
      planDigest: string;
    }
  | {
      status: 'conflict';
      generation: number;
      persistedPlanId: string;
      persistedPlanDigest: string;
    }
  | {
      status: 'recovery-required';
      planGeneration: number;
    }
  | {
      status: 'stale';
    };

export type CoordinatorFencedBeginMutationResult =
  | CoordinatorBeginMutationResult
  | {
      status: 'stale';
    };

export type CoordinatorFencedBeginRecoveryResult =
  | CoordinatorBeginRecoveryResult
  | {
      status: 'stale';
    };

export type CoordinatorRecordMutationResult =
  | {
      status: 'recorded' | 'duplicate';
    }
  | {
      status: 'stale';
    };

export type CoordinatorNonAttemptedFollowupResult =
  | {
      status: 'followup';
      generation: number;
      mutationResult: 'not-attempted';
      retryAfterSeconds: number;
    }
  | {
      status: 'followup';
      generation: number;
      mutationResult: 'stale-plan';
      retryAfterSeconds: null;
    }
  | {
      status: 'stale';
    };

export type CoordinatorRecoveryDisposition =
  | 'complete'
  | 'followup'
  | 'retry';

export interface CoordinatorMutationIntentCounts {
  readonly total: number;
  readonly planned: number;
  readonly applying: number;
  readonly settled: number;
  readonly unknown: number;
  readonly actionRequired: number;
  readonly cancelled: number;
}

export interface CoordinatorMutationLedgerSnapshot {
  readonly schemaVersion: typeof coordinatorMutationSchemaVersion;
  readonly planCount: number;
  readonly humanMutationFenceCount: number;
  readonly unresolvedUnknownCount: number;
  readonly latest: {
    readonly generation: number;
    readonly planId: string;
    readonly planDigest: string;
    readonly objective: string;
    readonly state: CoordinatorMutationPlanState;
    readonly intentCounts: CoordinatorMutationIntentCounts;
    readonly controlVersionId: string;
  } | null;
}

export function coordinatorMutationIntentCounts(
  intents: readonly CoordinatorMutationIntentRecord[],
): CoordinatorMutationIntentCounts {
  const counts: CoordinatorMutationIntentCounts = {
    total: intents.length,
    planned: 0,
    applying: 0,
    settled: 0,
    unknown: 0,
    actionRequired: 0,
    cancelled: 0,
  };
  const mutable = counts as {
    -readonly [Key in keyof CoordinatorMutationIntentCounts]:
      CoordinatorMutationIntentCounts[Key];
  };
  for (const intent of intents) {
    if (intent.state === 'action-required') {
      mutable.actionRequired += 1;
    } else {
      mutable[intent.state] += 1;
    }
  }
  return counts;
}

export async function parseCoordinatorPreparedMutationPlan(
  value: unknown,
): Promise<CoordinatorPreparedMutationPlanV1> {
  const receipt = await parseStewardRuntimeControlPreparedReceiptV2(value);
  const receiptJson =
    await canonicalStewardRuntimeControlPreparedReceiptV2Json(receipt);
  const workItemJson = canonicalStewardRuntimeWorkItemJson(
    receipt.binding.workItem,
  );
  return {
    receipt,
    receiptJson,
    workItemJson,
    workItemDigest: await sha256Text(workItemJson),
  };
}

export async function parseCoordinatorMutationResult(
  value: unknown,
): Promise<StewardRuntimeControlMutationReceiptV2> {
  const receipt = await parseStewardRuntimeControlMutationReceiptV2(value);
  if (
    receipt.result.state !== 'applied'
    && receipt.result.state !== 'converged'
  ) {
    throw new TypeError(
      'A successful mutation result must be applied or converged.',
    );
  }
  return receipt;
}

export async function parseCoordinatorNonAttemptedMutationResult(
  value: unknown,
): Promise<StewardRuntimeControlMutationReceiptV2> {
  const receipt = await parseStewardRuntimeControlMutationReceiptV2(value);
  if (
    receipt.result.state !== 'not-attempted'
    && receipt.result.state !== 'stale-plan'
  ) {
    throw new TypeError(
      'A non-attempted mutation result must be not-attempted or stale-plan.',
    );
  }
  return receipt;
}

export async function parseCoordinatorMutationRecoveryResult(
  value: unknown,
): Promise<StewardRuntimeControlRecoveryReceiptV2> {
  return parseStewardRuntimeControlRecoveryReceiptV2(value);
}

export function createCoordinatorMutationPlanState(
  prepared: CoordinatorPreparedMutationPlanV1,
  generation: number,
  now: number,
): CoordinatorMutationPlanStoredState {
  const normalizedGeneration = requirePositiveSafeInteger(
    generation,
    'generation',
  );
  const timestamp = requireTimestamp(now, 'now');
  const { receipt } = prepared;
  if (
    receipt.binding.generation !== normalizedGeneration
    || receipt.plan.preparedGeneration !== normalizedGeneration
  ) {
    throw new Error('Prepared plan does not bind the current generation.');
  }
  return {
    canonicalPlanBase64: receipt.plan.canonicalPlanBase64,
    canonicalPlanByteLength: receipt.plan.canonicalPlanByteLength,
    controlRevision: { ...receipt.controlRevision },
    createdAt: timestamp,
    deliveryId: receipt.binding.workItem.cause.deliveryId,
    generation: normalizedGeneration,
    installationId: receipt.binding.workItem.installationId,
    intents: receipt.plan.mutations.map((intent) => ({
      cancelReason: null,
      desiredDigest: intent.desiredDigest,
      dispatchCount: 0,
      key: intent.key,
      mutationType: intent.mutationType,
      ordinal: intent.ordinal,
      principal: intent.principal,
      recoveryPolicy: intent.recoveryPolicy,
      startedAt: null,
      state: 'planned',
    })),
    objective: receipt.binding.objective,
    operation: receipt.binding.workItem.operation,
    planDigest: receipt.plan.planDigest,
    planId: receipt.plan.planId,
    preparedReceiptJson: prepared.receiptJson,
    receipts: [],
    recoveryGeneration: null,
    resolvedContext: { ...receipt.resolvedContext },
    state: 'prepared',
    terminalAt: null,
    terminalOutcome: receipt.plan.terminalOutcome,
    updatedAt: timestamp,
    workItemDigest: prepared.workItemDigest,
    workItemJson: prepared.workItemJson,
  };
}

export class CoordinatorMutationPlanStateMachine {
  readonly #state: CoordinatorMutationPlanStoredState;

  constructor(state: CoordinatorMutationPlanStoredState) {
    this.#state = cloneAndValidateStoredPlan(state);
  }

  nextPlannedMutation(): CoordinatorMutationIntentRecord | null {
    if (this.#state.state !== 'prepared') {
      return null;
    }
    const intent = this.#state.intents.find(
      (candidate) => candidate.state === 'planned',
    );
    return intent === undefined ? null : { ...intent };
  }

  beginNextMutation(now: number): CoordinatorBeginMutationResult {
    const timestamp = requireTimestamp(now, 'now');
    if (isTerminalPlanState(this.#state.state)) {
      return { status: 'terminal' };
    }
    if (
      this.#state.state === 'unknown'
      || this.#state.state === 'recovering'
    ) {
      return { status: 'recovery-required' };
    }
    if (this.#state.intents.some((intent) => intent.state === 'applying')) {
      return { status: 'already-started' };
    }
    const intent = this.#state.intents.find(
      (candidate) => candidate.state === 'planned',
    );
    if (intent === undefined) {
      return { status: 'none' };
    }
    if (
      this.#state.intents
        .slice(0, intent.ordinal)
        .some((candidate) => candidate.state !== 'settled')
    ) {
      throw new Error('Mutation intents cannot be dispatched out of order.');
    }
    if (intent.dispatchCount !== 0) {
      throw new Error('A planned mutation intent was already dispatched.');
    }

    intent.dispatchCount = 1;
    intent.startedAt = timestamp;
    intent.state = 'applying';
    this.#state.state = 'applying';
    this.#state.updatedAt = timestamp;
    return {
      status: 'ready',
      generation: this.#state.generation,
      planId: this.#state.planId,
      planDigest: this.#state.planDigest,
      preparedReceipt: this.#preparedReceipt(),
      intent: { ...intent },
    };
  }

  recordMutationResult(
    receipt: StewardRuntimeControlMutationReceiptV2,
    now: number,
  ): 'recorded' | 'duplicate' {
    const timestamp = requireTimestamp(now, 'now');
    const intent = this.#requireMutationReceiptBinding(
      receipt,
      this.#state.generation,
    );
    const existing = this.#state.receipts.find(
      (candidate) => candidate.ordinal === intent.ordinal,
    );
    if (existing !== undefined) {
      if (
        intent.state === 'settled'
        && existing.key === intent.key
        && existing.desiredDigest === intent.desiredDigest
        && existing.result === receipt.result.state
        && existing.resourceId === receipt.result.resourceId
      ) {
        return 'duplicate';
      }
      throw new Error('Mutation result conflicts with a persisted receipt.');
    }
    if (this.#state.state !== 'applying' || intent.state !== 'applying') {
      throw new Error('Mutation result does not bind the applying intent.');
    }
    if (
      receipt.result.state !== 'applied'
      && receipt.result.state !== 'converged'
    ) {
      throw new Error('Mutation result is not a successful receipt.');
    }

    intent.state = 'settled';
    this.#state.receipts.push({
      desiredDigest: intent.desiredDigest,
      key: intent.key,
      ordinal: intent.ordinal,
      recordedAt: timestamp,
      resourceId: receipt.result.resourceId,
      result: receipt.result.state,
      source: 'apply',
    });
    this.#state.state = 'prepared';
    this.#state.updatedAt = timestamp;
    return 'recorded';
  }

  recordNonAttempted(
    receipt: StewardRuntimeControlMutationReceiptV2,
    now: number,
  ): void {
    const timestamp = requireTimestamp(now, 'now');
    const intent = this.#requireMutationReceiptBinding(
      receipt,
      this.#state.generation,
    );
    if (this.#state.state !== 'applying' || intent.state !== 'applying') {
      throw new Error('Non-attempted result does not bind the applying intent.');
    }
    if (
      receipt.result.state !== 'not-attempted'
      && receipt.result.state !== 'stale-plan'
    ) {
      throw new Error('Mutation result does not prove a non-attempt.');
    }

    intent.state = 'cancelled';
    intent.cancelReason = receipt.result.state;
    this.#cancelPlanned('superseded-by-replan');
    this.#state.state = this.#state.receipts.length === 0
      ? 'abandoned'
      : 'superseded';
    this.#state.recoveryGeneration = null;
    this.#state.terminalAt = timestamp;
    this.#state.updatedAt = timestamp;
  }

  recordUnknown(
    mutation: StewardRuntimeControlMutationBindingV2,
    now: number,
  ): void {
    const timestamp = requireTimestamp(now, 'now');
    const intent = this.#requireBoundIntent(mutation);
    if (intent.state === 'unknown' && this.#state.state === 'unknown') {
      return;
    }
    if (intent.state !== 'applying') {
      throw new Error('Only an applying mutation can become unknown.');
    }
    intent.state = 'unknown';
    this.#state.state = 'unknown';
    this.#state.recoveryGeneration = null;
    this.#state.terminalAt = null;
    this.#state.updatedAt = timestamp;
  }

  markLeaseLost(now: number): void {
    const timestamp = requireTimestamp(now, 'now');
    const applying = this.#state.intents.find(
      (intent) => intent.state === 'applying',
    );
    if (applying !== undefined) {
      applying.state = 'unknown';
      this.#state.state = 'unknown';
      this.#state.recoveryGeneration = null;
      this.#state.terminalAt = null;
      this.#state.updatedAt = timestamp;
      return;
    }
    if (this.#state.state === 'recovering') {
      this.#state.state = 'unknown';
      this.#state.recoveryGeneration = null;
      this.#state.terminalAt = null;
      this.#state.updatedAt = timestamp;
      return;
    }
    if (this.#state.state === 'prepared') {
      const noSideEffects = this.#state.receipts.length === 0
        && this.#state.intents.every(
          (intent) =>
            intent.state === 'planned'
            && intent.dispatchCount === 0,
        );
      if (noSideEffects) {
        this.#state.state = 'abandoned';
      } else {
        this.#cancelPlanned('superseded-by-replan');
        this.#state.state = 'superseded';
      }
      this.#state.recoveryGeneration = null;
      this.#state.terminalAt = timestamp;
      this.#state.updatedAt = timestamp;
    }
  }

  beginRecovery(
    recoveryGeneration: number,
    now: number,
  ): CoordinatorBeginRecoveryResult {
    const generation = requirePositiveSafeInteger(
      recoveryGeneration,
      'recoveryGeneration',
    );
    const timestamp = requireTimestamp(now, 'now');
    if (this.#state.state === 'recovering') {
      if (this.#state.recoveryGeneration !== generation) {
        throw new Error('Recovery plan is fenced by another generation.');
      }
      const intent = this.#state.intents.find(
        (candidate) => candidate.state === 'unknown',
      );
      if (intent === undefined) {
        throw new Error('Recovering plan does not contain an unknown mutation.');
      }
      return {
        status: 'ready',
        planGeneration: this.#state.generation,
        planId: this.#state.planId,
        planDigest: this.#state.planDigest,
        preparedReceipt: this.#preparedReceipt(),
        intent: { ...intent },
      };
    }
    if (this.#state.state !== 'unknown') {
      return { status: 'none' };
    }
    if (generation <= this.#state.generation) {
      throw new Error('Recovery generation must supersede the unknown plan.');
    }
    const intent = this.#state.intents.find(
      (candidate) => candidate.state === 'unknown',
    );
    if (intent === undefined) {
      throw new Error('Unknown plan does not contain an unknown mutation.');
    }

    this.#state.state = 'recovering';
    this.#state.recoveryGeneration = generation;
    this.#state.updatedAt = timestamp;
    return {
      status: 'ready',
      planGeneration: this.#state.generation,
      planId: this.#state.planId,
      planDigest: this.#state.planDigest,
      preparedReceipt: this.#preparedReceipt(),
      intent: { ...intent },
    };
  }

  recordRecoveryResult(
    recoveryGeneration: number,
    recoveryDeliveryId: string,
    receipt: StewardRuntimeControlRecoveryReceiptV2,
    now: number,
  ): CoordinatorRecoveryDisposition {
    const generation = requirePositiveSafeInteger(
      recoveryGeneration,
      'recoveryGeneration',
    );
    const timestamp = requireTimestamp(now, 'now');
    if (
      this.#state.state !== 'recovering'
      || this.#state.recoveryGeneration !== generation
    ) {
      throw new Error('Recovery result does not bind the active recovery.');
    }
    const intent = this.#requireRecoveryReceiptBinding(
      receipt,
      generation,
      requireOpaqueAscii(recoveryDeliveryId, 'recoveryDeliveryId'),
    );

    if (receipt.result.state === 'unknown') {
      this.#state.state = 'unknown';
      this.#state.recoveryGeneration = null;
      this.#state.updatedAt = timestamp;
      return 'retry';
    }

    if (receipt.result.state === 'action-required') {
      intent.state = 'action-required';
      this.#cancelPlanned('blocked-by-action-required');
      this.#state.state = 'action-required';
      this.#state.recoveryGeneration = null;
      this.#state.terminalAt = timestamp;
      this.#state.updatedAt = timestamp;
      return 'complete';
    }

    intent.state = 'settled';
    this.#state.receipts.push({
      desiredDigest: intent.desiredDigest,
      key: intent.key,
      ordinal: intent.ordinal,
      recordedAt: timestamp,
      resourceId: receipt.result.resourceId,
      result: 'converged',
      source: 'recovery',
    });
    this.#state.recoveryGeneration = null;
    this.#state.updatedAt = timestamp;

    if (this.#state.intents.some((candidate) => candidate.state === 'planned')) {
      this.#cancelPlanned('superseded-by-replan');
      this.#state.state = 'superseded';
      this.#state.terminalAt = timestamp;
      return 'followup';
    }

    this.#state.state = 'prepared';
    this.#completeDeclaredOutcome(timestamp);
    return 'complete';
  }

  complete(now: number): void {
    this.#completeDeclaredOutcome(requireTimestamp(now, 'now'));
  }

  hasUnresolvedUnknown(): boolean {
    return this.#state.intents.some((intent) => intent.state === 'unknown');
  }

  exportState(): CoordinatorMutationPlanStoredState {
    return cloneStoredPlan(this.#state);
  }

  #completeDeclaredOutcome(now: number): void {
    if (this.#state.state !== 'prepared') {
      throw new Error('Only a prepared mutation plan can be completed.');
    }
    if (this.#state.terminalOutcome === 'ignored') {
      if (this.#state.intents.length !== 0) {
        throw new Error('Ignored mutation plan must contain zero intents.');
      }
    } else if (
      this.#state.intents.some((intent) => intent.state !== 'settled')
    ) {
      throw new Error(
        `${this.#state.terminalOutcome} mutation plan requires all intents to settle.`,
      );
    }
    this.#state.state = this.#state.terminalOutcome;
    this.#state.recoveryGeneration = null;
    this.#state.terminalAt = now;
    this.#state.updatedAt = now;
  }

  #cancelPlanned(reason: CoordinatorMutationCancellationReason): void {
    for (const intent of this.#state.intents) {
      if (intent.state === 'planned') {
        intent.state = 'cancelled';
        intent.cancelReason = reason;
      }
    }
  }

  #preparedReceipt(): StewardRuntimeControlPreparedReceiptV2 {
    return JSON.parse(
      this.#state.preparedReceiptJson,
    ) as StewardRuntimeControlPreparedReceiptV2;
  }

  #requireBoundIntent(
    mutation: StewardRuntimeControlMutationBindingV2,
  ): CoordinatorMutationIntentRecord {
    const intent = this.#state.intents[mutation.ordinal];
    if (
      intent === undefined
      || intent.ordinal !== mutation.ordinal
      || intent.key !== mutation.key
      || intent.mutationType !== mutation.mutationType
      || intent.principal !== mutation.principal
      || intent.recoveryPolicy !== mutation.recoveryPolicy
      || intent.desiredDigest !== mutation.desiredDigest
    ) {
      throw new Error('Mutation does not bind the persisted intent.');
    }
    return intent;
  }

  #requireMutationReceiptBinding(
    receipt: StewardRuntimeControlMutationReceiptV2,
    generation: number,
  ): CoordinatorMutationIntentRecord {
    if (
      receipt.binding.generation !== generation
      || canonicalStewardRuntimeWorkItemJson(receipt.binding.workItem)
        !== this.#state.workItemJson
      || receipt.binding.objective !== this.#state.objective
      || receipt.planId !== this.#state.planId
      || receipt.planDigest !== this.#state.planDigest
      || !sameResolvedContext(
        receipt.resolvedContext,
        this.#state.resolvedContext,
      )
      || !sameControlRevision(
        receipt.controlRevision,
        this.#state.controlRevision,
      )
    ) {
      throw new Error('Mutation receipt does not bind the persisted plan.');
    }
    return this.#requireBoundIntent(receipt.mutation);
  }

  #requireRecoveryReceiptBinding(
    receipt: StewardRuntimeControlRecoveryReceiptV2,
    recoveryGeneration: number,
    recoveryDeliveryId: string,
  ): CoordinatorMutationIntentRecord {
    if (
      receipt.binding.generation !== recoveryGeneration
      || receipt.binding.workItem.cause.deliveryId !== recoveryDeliveryId
      || receipt.binding.workItem.operation !== this.#state.operation
      || receipt.binding.workItem.subject.repositoryId
        !== this.#state.resolvedContext.repositoryId
      || receipt.binding.workItem.subject.pullRequestNumber
        !== this.#state.resolvedContext.pullRequestNumber
      || receipt.binding.objective !== this.#state.objective
      || receipt.planId !== this.#state.planId
      || receipt.planDigest !== this.#state.planDigest
      || !sameResolvedContext(
        receipt.resolvedContext,
        this.#state.resolvedContext,
      )
      || !sameControlRevision(
        receipt.controlRevision,
        this.#state.controlRevision,
      )
    ) {
      throw new Error('Recovery receipt does not bind the persisted plan.');
    }
    const intent = this.#requireBoundIntent(receipt.mutation);
    if (intent.state !== 'unknown') {
      throw new Error('Recovery receipt does not bind an unknown intent.');
    }
    return intent;
  }
}

function cloneAndValidateStoredPlan(
  state: CoordinatorMutationPlanStoredState,
): CoordinatorMutationPlanStoredState {
  const clone = cloneStoredPlan(state);
  requirePositiveSafeInteger(clone.generation, 'storedPlan.generation');
  requirePositiveSafeInteger(
    clone.installationId,
    'storedPlan.installationId',
  );
  requireOpaqueAscii(clone.deliveryId, 'storedPlan.deliveryId');
  requireDigest(clone.workItemDigest, 'storedPlan.workItemDigest');
  requireDigest(clone.planId, 'storedPlan.planId');
  requireDigest(clone.planDigest, 'storedPlan.planDigest');
  requireTimestamp(clone.createdAt, 'storedPlan.createdAt');
  requireTimestamp(clone.updatedAt, 'storedPlan.updatedAt');
  if (clone.updatedAt < clone.createdAt) {
    throw new TypeError('Stored mutation plan timestamps are inconsistent.');
  }
  if (
    clone.canonicalPlanByteLength < 1
    || clone.canonicalPlanByteLength > coordinatorMaximumCanonicalPlanBytes
  ) {
    throw new TypeError('Stored canonical plan byte length is invalid.');
  }
  if (
    clone.intents.length > coordinatorMaximumMutationIntents
    || clone.intents.some((intent, ordinal) => intent.ordinal !== ordinal)
  ) {
    throw new TypeError('Stored mutation intent ordering is invalid.');
  }
  if (
    clone.terminalOutcome === 'ignored'
    && clone.intents.length !== 0
  ) {
    throw new TypeError('Stored ignored plan must contain zero intents.');
  }

  const keys = new Set<string>();
  for (const intent of clone.intents) {
    requireOpaqueAscii(intent.key, 'storedIntent.key');
    requireDigest(intent.desiredDigest, 'storedIntent.desiredDigest');
    requireTimestampOrNull(intent.startedAt, 'storedIntent.startedAt');
    if (keys.has(intent.key)) {
      throw new TypeError('Stored mutation intent keys must be unique.');
    }
    keys.add(intent.key);
    if (
      intent.dispatchCount !== 0
      && intent.dispatchCount !== 1
    ) {
      throw new TypeError('Stored mutation dispatch count is invalid.');
    }
    const cancelledAfterProvenNonAttempt =
      intent.state === 'cancelled'
      && (
        intent.cancelReason === 'not-attempted'
        || intent.cancelReason === 'stale-plan'
      );
    const requiresNoDispatchEvidence =
      intent.state === 'planned'
      || (
        intent.state === 'cancelled'
        && !cancelledAfterProvenNonAttempt
      );
    if (
      requiresNoDispatchEvidence
        ? intent.dispatchCount !== 0 || intent.startedAt !== null
        : intent.dispatchCount !== 1 || intent.startedAt === null
    ) {
      throw new TypeError('Stored mutation dispatch evidence is inconsistent.');
    }
    if (
      (intent.state === 'cancelled') !== (intent.cancelReason !== null)
    ) {
      throw new TypeError('Stored mutation cancellation is inconsistent.');
    }
    if (
      intent.cancelReason !== null
      && intent.cancelReason !== 'blocked-by-action-required'
      && intent.cancelReason !== 'superseded-by-replan'
      && intent.cancelReason !== 'not-attempted'
      && intent.cancelReason !== 'stale-plan'
    ) {
      throw new TypeError('Stored mutation cancellation reason is invalid.');
    }
    if (
      (
        intent.principal === 'installation'
        && intent.recoveryPolicy !== 'live-evidence'
      )
      || (
        intent.principal === 'human'
        && intent.recoveryPolicy !== 'live-evidence-or-action-required'
      )
      || (
        intent.principal !== 'installation'
        && intent.principal !== 'human'
      )
    ) {
      throw new TypeError(
        'Stored mutation principal and recovery policy are inconsistent.',
      );
    }
  }

  const receiptOrdinals = new Set<number>();
  for (const receipt of clone.receipts) {
    const intent = clone.intents[receipt.ordinal];
    if (
      intent === undefined
      || intent.state !== 'settled'
      || intent.key !== receipt.key
      || intent.desiredDigest !== receipt.desiredDigest
      || receiptOrdinals.has(receipt.ordinal)
    ) {
      throw new TypeError('Stored mutation receipt binding is invalid.');
    }
    receiptOrdinals.add(receipt.ordinal);
    requireTimestamp(receipt.recordedAt, 'storedReceipt.recordedAt');
    if (
      receipt.result !== 'applied'
      && receipt.result !== 'converged'
    ) {
      throw new TypeError('Stored mutation receipt result is invalid.');
    }
  }
  for (const intent of clone.intents) {
    if (
      (intent.state === 'settled')
        !== receiptOrdinals.has(intent.ordinal)
    ) {
      throw new TypeError('Stored mutation receipt coverage is inconsistent.');
    }
  }

  if (
    (clone.state === 'recovering')
      !== (clone.recoveryGeneration !== null)
  ) {
    throw new TypeError('Stored mutation recovery binding is inconsistent.');
  }
  if (
    clone.recoveryGeneration !== null
    && clone.recoveryGeneration <= clone.generation
  ) {
    throw new TypeError('Stored recovery generation is not newer.');
  }
  if (
    isTerminalPlanState(clone.state)
      !== (clone.terminalAt !== null)
  ) {
    throw new TypeError('Stored mutation terminal timestamp is inconsistent.');
  }
  if (clone.terminalAt !== null) {
    requireTimestamp(clone.terminalAt, 'storedPlan.terminalAt');
  }
  validatePlanShape(clone);
  return clone;
}

function validatePlanShape(state: CoordinatorMutationPlanStoredState): void {
  const applying = state.intents.filter(
    (intent) => intent.state === 'applying',
  );
  const unknown = state.intents.filter(
    (intent) => intent.state === 'unknown',
  );
  if (
    (state.state === 'applying' ? applying.length !== 1 : applying.length !== 0)
    || (
      state.state === 'unknown' || state.state === 'recovering'
        ? unknown.length !== 1
        : unknown.length !== 0
    )
  ) {
    throw new TypeError('Stored mutation plan active state is inconsistent.');
  }
  if (
    state.state === 'prepared'
    && !matchesIntentSequence(state.intents, ['settled', 'planned'])
  ) {
    throw new TypeError('Stored prepared mutation order is inconsistent.');
  }
  if (
    state.state === 'applying'
    && !matchesIntentSequence(
      state.intents,
      ['settled', 'applying', 'planned'],
    )
  ) {
    throw new TypeError('Stored applying mutation order is inconsistent.');
  }
  if (
    (state.state === 'unknown' || state.state === 'recovering')
    && !matchesIntentSequence(
      state.intents,
      ['settled', 'unknown', 'planned'],
    )
  ) {
    throw new TypeError('Stored unknown mutation order is inconsistent.');
  }
  if (
    state.state === 'abandoned'
    && (
      state.receipts.length !== 0
      || !abandonedIntentShape(state.intents)
    )
  ) {
    throw new TypeError('Stored abandoned plan contains side-effect evidence.');
  }
  if (
    (state.state === 'settled' || state.state === 'pending-external')
    && state.intents.some((intent) => intent.state !== 'settled')
  ) {
    throw new TypeError('Stored terminal plan skipped an unsettled intent.');
  }
  if (state.state === 'ignored' && state.intents.length !== 0) {
    throw new TypeError('Stored ignored plan contains intents.');
  }
  if (state.state === 'action-required') {
    const blocker = state.intents.findIndex(
      (intent) => intent.state === 'action-required',
    );
    const zeroIntent = state.intents.length === 0;
    const allSettled = state.intents.every(
      (intent) => intent.state === 'settled',
    );
    const blockedShape = blocker >= 0
      && state.intents.every((intent, index) =>
        index < blocker
          ? intent.state === 'settled'
          : index === blocker
            ? intent.state === 'action-required'
            : intent.state === 'cancelled'
              && intent.cancelReason === 'blocked-by-action-required'
      );
    if (!zeroIntent && !allSettled && !blockedShape) {
      throw new TypeError('Stored action-required plan evidence is invalid.');
    }
  }
  if (
    state.state === 'superseded'
    && !supersededIntentShape(state.intents)
  ) {
    throw new TypeError('Stored superseded plan evidence is invalid.');
  }
}

function abandonedIntentShape(
  intents: readonly CoordinatorMutationIntentRecord[],
): boolean {
  if (intents.every((intent) => intent.state === 'planned')) {
    return true;
  }
  const proofIndex = intents.findIndex(
    (intent) =>
      intent.state === 'cancelled'
      && (
        intent.cancelReason === 'not-attempted'
        || intent.cancelReason === 'stale-plan'
      ),
  );
  return proofIndex === 0
    && intents.every((intent, index) =>
      index === proofIndex
        ? true
        : intent.state === 'cancelled'
          && intent.cancelReason === 'superseded-by-replan'
    );
}

function supersededIntentShape(
  intents: readonly CoordinatorMutationIntentRecord[],
): boolean {
  const firstCancelled = intents.findIndex(
    (intent) => intent.state === 'cancelled',
  );
  if (firstCancelled < 0) {
    return intents.every((intent) => intent.state === 'settled');
  }
  return intents.every((intent, index) => {
    if (index < firstCancelled) {
      return intent.state === 'settled';
    }
    if (intent.state !== 'cancelled') {
      return false;
    }
    if (index === firstCancelled) {
      return (
        intent.cancelReason === 'superseded-by-replan'
        || intent.cancelReason === 'not-attempted'
        || intent.cancelReason === 'stale-plan'
      );
    }
    return intent.cancelReason === 'superseded-by-replan';
  });
}

function matchesIntentSequence(
  intents: readonly CoordinatorMutationIntentRecord[],
  states: readonly CoordinatorMutationIntentState[],
): boolean {
  let stateIndex = 0;
  for (const intent of intents) {
    while (
      stateIndex < states.length
      && intent.state !== states[stateIndex]
    ) {
      stateIndex += 1;
    }
    if (stateIndex >= states.length) {
      return false;
    }
  }
  return true;
}

function cloneStoredPlan(
  state: CoordinatorMutationPlanStoredState,
): CoordinatorMutationPlanStoredState {
  return {
    ...state,
    controlRevision: { ...state.controlRevision },
    intents: state.intents.map((intent) => ({ ...intent })),
    receipts: state.receipts.map((receipt) => ({ ...receipt })),
    resolvedContext: { ...state.resolvedContext },
  };
}

function isTerminalPlanState(state: CoordinatorMutationPlanState): boolean {
  return (
    state === 'settled'
    || state === 'pending-external'
    || state === 'ignored'
    || state === 'action-required'
    || state === 'abandoned'
    || state === 'superseded'
  );
}

function sameResolvedContext(
  left: StewardRuntimeControlResolvedContextV2,
  right: StewardRuntimeControlResolvedContextV2,
): boolean {
  return (
    left.repositoryId === right.repositoryId
    && left.repositoryFullName === right.repositoryFullName
    && left.pullRequestNumber === right.pullRequestNumber
    && left.headSha === right.headSha
    && left.defaultBranch === right.defaultBranch
    && left.manifestBlobSha === right.manifestBlobSha
    && left.configDigest === right.configDigest
    && left.pullRequestDigest === right.pullRequestDigest
  );
}

function sameControlRevision(
  left: StewardRuntimeControlRevisionV1,
  right: StewardRuntimeControlRevisionV1,
): boolean {
  return (
    left.stewardCommit === right.stewardCommit
    && left.workerVersionId === right.workerVersionId
    && left.workerVersionTag === right.workerVersionTag
    && left.workerVersionCreatedAt === right.workerVersionCreatedAt
  );
}

async function sha256Text(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requireTimestampOrNull(
  value: number | null,
  field: string,
): number | null {
  return value === null ? null : requireTimestamp(value, field);
}

function requireDigest(value: string, field: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-character digest.`);
  }
  return value;
}

function requireOpaqueAscii(value: string, field: string): string {
  if (typeof value !== 'string' || !opaqueAsciiPattern.test(value)) {
    throw new TypeError(
      `${field} must contain 1-128 visible ASCII characters.`,
    );
  }
  return value;
}
