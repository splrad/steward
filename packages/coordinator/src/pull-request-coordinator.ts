import { DurableObject } from 'cloudflare:workers';
import {
  coordinatorSchemaVersion,
  parsePullRequestCoordinatorName,
  type CoordinatorAlarmResult,
  type CoordinatorClaimResult,
  type CoordinatorCompleteResult,
  type CoordinatorFailResult,
  type CoordinatorFailureCode,
  type CoordinatorRenewResult,
  type PullRequestCoordinatorSnapshot,
  type PullRequestCoordinatorSubject,
} from './contracts.js';
import {
  createPullRequestCoordinatorState,
  PullRequestCoordinatorStateMachine,
  type CoordinatorDeliveryRecord,
  type PullRequestCoordinatorStoredState,
} from './state.js';
import {
  coordinatorMutationIntentCounts,
  coordinatorHumanMutationFenceLimit,
  coordinatorMutationPlanRetentionLimit,
  coordinatorMutationPlanRetentionMs,
  coordinatorMutationSchemaVersion,
  CoordinatorMutationPlanStateMachine,
  createCoordinatorMutationPlanState,
  parseCoordinatorMutationRecoveryResult,
  parseCoordinatorMutationResult,
  parseCoordinatorNonAttemptedMutationResult,
  parseCoordinatorPreparedMutationPlan,
  type CoordinatorFencedBeginMutationResult,
  type CoordinatorFencedBeginRecoveryResult,
  type CoordinatorHumanMutationFenceRecord,
  type CoordinatorMutationIntentRecord,
  type CoordinatorMutationLedgerSnapshot,
  type CoordinatorMutationPlanStoredState,
  type CoordinatorMutationReceiptRecord,
  type CoordinatorNonAttemptedFollowupResult,
  type CoordinatorPersistPreparedPlanResult,
  type CoordinatorRecordMutationResult,
} from './mutation-ledger.js';
import type {
  StewardRuntimeControlMutationBindingV2,
  StewardRuntimeControlMutationReceiptV2,
  StewardRuntimeControlPreparedReceiptV2,
  StewardRuntimeControlRecoveryReceiptV2,
} from '../../core/src/runtime-control-v2.js';

interface CoordinatorStateRow {
  dirty: number;
  failure_code: string | null;
  generation: number;
  lease_delivery_id: string | null;
  lease_expires_at: number | null;
  lease_generation: number | null;
  lease_kind: string | null;
  lease_token: string | null;
  phase: string;
  pull_number: number;
  repository_id: string;
}

interface CoordinatorDeliveryRow {
  accepted_at: number;
  completed_at: number | null;
  covered_generation: number | null;
  delivery_id: string;
  status: string;
}

interface SchemaVersionRow {
  version: number;
}

interface GenerationRow {
  generation: number;
}

interface CountRow {
  count: number;
}

interface CoordinatorMutationPlanRow {
  canonical_plan_base64: string;
  canonical_plan_byte_length: number;
  config_digest: string;
  control_steward_commit: string;
  control_worker_version_created_at: string;
  control_worker_version_id: string;
  control_worker_version_tag: string;
  created_at: number;
  default_branch: string;
  delivery_id: string;
  generation: number;
  head_sha: string;
  installation_id: number;
  manifest_blob_sha: string;
  objective: string;
  operation: string;
  plan_digest: string;
  plan_id: string;
  prepared_receipt_json: string;
  pull_number: number;
  pull_request_digest: string;
  recovery_generation: number | null;
  repository_full_name: string;
  repository_id: string;
  state: string;
  terminal_at: number | null;
  terminal_outcome: string;
  updated_at: number;
  work_item_digest: string;
  work_item_json: string;
}

interface CoordinatorMutationIntentRow {
  cancel_reason: string | null;
  desired_digest: string;
  dispatch_count: number;
  intent_key: string;
  mutation_type: string;
  ordinal: number;
  principal: string;
  recovery_policy: string;
  started_at: number | null;
  state: string;
}

interface CoordinatorMutationReceiptRow {
  desired_digest: string;
  intent_key: string;
  ordinal: number;
  recorded_at: number;
  resource_id: number | null;
  result: string;
  source: string;
}

interface CoordinatorHumanMutationFenceRow {
  created_at: number;
  desired_digest: string;
  head_sha: string;
  intent_key: string;
  mutation_type: string;
  source_generation: number;
  source_plan_digest: string;
  source_plan_id: string;
}

interface CoordinatorMutation<T> {
  alarmAt: number | null;
  result: T;
}

type CoordinatorSqlValue = ArrayBuffer | string | number | null;

interface CoordinatorSqlCursor<T extends object> {
  one(): T;
  toArray(): T[];
}

interface CoordinatorSqlStorage {
  exec<T extends object>(
    query: string,
    ...bindings: CoordinatorSqlValue[]
  ): CoordinatorSqlCursor<T>;
}

interface CoordinatorDurableObjectState {
  id: {
    readonly name?: string;
  };
  storage: {
    readonly sql: CoordinatorSqlStorage;
    setAlarm(scheduledTime: number): Promise<void>;
    transactionSync<T>(closure: () => T): T;
  };
}

function requireRetryAfterSeconds(
  receipt: StewardRuntimeControlMutationReceiptV2,
): number {
  if (
    receipt.result.state !== 'not-attempted'
    || receipt.result.retryAfterSeconds === null
  ) {
    throw new Error(
      'Parsed not-attempted result is missing retryAfterSeconds.',
    );
  }
  return receipt.result.retryAfterSeconds;
}

export class PullRequestCoordinator extends DurableObject {
  readonly #ctx: CoordinatorDurableObjectState;
  readonly #subject: PullRequestCoordinatorSubject;

  constructor(ctx: CoordinatorDurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;

    const objectName = ctx.id.name;
    if (objectName === undefined) {
      throw new TypeError(
        'PullRequestCoordinator must be addressed with idFromName().',
      );
    }

    this.#subject = parsePullRequestCoordinatorName(objectName);
    this.#initializeSchema();
  }

  async claim(
    deliveryId: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorClaimResult> {
    const mutation = this.#mutate((machine, now) =>
      machine.claim(
        deliveryId,
        leaseDurationMs,
        now,
        crypto.randomUUID(),
      ),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async renew(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorRenewResult> {
    const mutation = this.#mutate((machine, now) =>
      machine.renew(generation, leaseToken, leaseDurationMs, now),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async complete(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult> {
    const mutation = this.#mutate((machine, now) =>
      machine.complete(generation, leaseToken, now),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async fail(
    generation: number,
    leaseToken: string,
    failureCode: CoordinatorFailureCode,
  ): Promise<CoordinatorFailResult> {
    const mutation = this.#mutate((machine, now) =>
      machine.fail(generation, leaseToken, failureCode, now),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async persistPreparedPlan(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
    value: StewardRuntimeControlPreparedReceiptV2,
  ): Promise<CoordinatorPersistPreparedPlanResult> {
    const preparedPlan = await parseCoordinatorPreparedMutationPlan(value);
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const renewal = machine.renew(
        generation,
        leaseToken,
        leaseDurationMs,
        now,
      );
      if (renewal.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      const unresolved = this.#oldestUnresolvedMutationGenerationBefore(
        generation,
      );
      if (unresolved !== null) {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: {
            status: 'recovery-required',
            planGeneration: unresolved,
          } as const,
        };
      }
      this.#assertPreparedPlanSubject(
        preparedPlan,
        machine.exportState(),
        generation,
      );

      const existing = this.#loadMutationPlan(generation);
      if (existing !== null) {
        const duplicate =
          existing.planId === preparedPlan.receipt.plan.planId
          && existing.planDigest === preparedPlan.receipt.plan.planDigest
          && existing.preparedReceiptJson === preparedPlan.receiptJson
          && existing.workItemDigest === preparedPlan.workItemDigest;
        if (!duplicate) {
          this.#writeState(machine.exportState());
          return {
            alarmAt: machine.alarmAt(),
            result: {
              status: 'conflict',
              generation,
              persistedPlanId: existing.planId,
              persistedPlanDigest: existing.planDigest,
            } as const,
          };
        }
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: {
            status: 'duplicate',
            generation,
            planId: existing.planId,
            planDigest: existing.planDigest,
          } as const,
        };
      }

      this.#pruneMutationPlans(now);
      const plan = createCoordinatorMutationPlanState(
        preparedPlan,
        generation,
        now,
      );
      this.#writeMutationPlan(plan);
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result: {
          status: 'persisted',
          generation,
          planId: plan.planId,
          planDigest: plan.planDigest,
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async beginNextMutation(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorFencedBeginMutationResult> {
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const renewal = machine.renew(
        generation,
        leaseToken,
        leaseDurationMs,
        now,
      );
      if (renewal.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      if (
        this.#oldestUnresolvedMutationGenerationBefore(generation) !== null
      ) {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'recovery-required' } as const,
        };
      }
      const plan = this.#requireMutationPlan(generation);
      const nextIntent = plan.nextPlannedMutation();
      if (nextIntent?.principal === 'human') {
        const planState = plan.exportState();
        const existingFence = this.#loadHumanMutationFence(
          planState.resolvedContext.headSha,
          nextIntent.mutationType,
        );
        if (existingFence !== null) {
          this.#writeState(machine.exportState());
          return {
            alarmAt: machine.alarmAt(),
            result: {
              status: 'human-mutation-fenced',
              headSha: existingFence.headSha,
              mutationType: existingFence.mutationType,
              sourceGeneration: existingFence.sourceGeneration,
            } as const,
          };
        }
        if (
          this.#humanMutationFenceCount()
          >= coordinatorHumanMutationFenceLimit
        ) {
          this.#writeState(machine.exportState());
          return {
            alarmAt: machine.alarmAt(),
            result: {
              status: 'human-mutation-fence-capacity',
              limit: coordinatorHumanMutationFenceLimit,
            } as const,
          };
        }
        this.#writeHumanMutationFence(
          this.#humanMutationFence(planState, nextIntent, now),
        );
      }
      const result = plan.beginNextMutation(now);
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordHumanMutationActionRequiredAndComplete(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult> {
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const fence = machine.fence(generation, leaseToken, now);
      if (fence.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      const plan = this.#requireMutationPlan(generation);
      plan.recordHumanMutationActionRequired(now);
      const completion = machine.complete(generation, leaseToken, now);
      if (completion.status === 'stale') {
        throw new Error(
          'Human mutation action-required fence changed inside one Durable Object transaction.',
        );
      }
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result: completion,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordMutationResult(
    generation: number,
    leaseToken: string,
    value: StewardRuntimeControlMutationReceiptV2,
  ): Promise<CoordinatorRecordMutationResult> {
    const result = await parseCoordinatorMutationResult(value);
    const now = Date.now();
    return this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const fence = machine.fence(generation, leaseToken, now);
      if (fence.status === 'stale') {
        this.#writeState(machine.exportState());
        return { status: 'stale' };
      }
      const plan = this.#requireMutationPlan(generation);
      const status = plan.recordMutationResult(result, now);
      const planState = plan.exportState();
      if (
        status === 'recorded'
        && result.mutation.principal === 'human'
        && result.result.state === 'converged'
      ) {
        this.#deleteHumanMutationFence(
          planState,
          result.mutation,
        );
      }
      this.#writeMutationPlan(planState);
      this.#writeState(machine.exportState());
      return { status };
    });
  }

  async recordNonAttemptedAndFollowup(
    generation: number,
    leaseToken: string,
    value: StewardRuntimeControlMutationReceiptV2,
  ): Promise<CoordinatorNonAttemptedFollowupResult> {
    const result = await parseCoordinatorNonAttemptedMutationResult(value);
    const followupResult: Exclude<
      CoordinatorNonAttemptedFollowupResult,
      { status: 'stale' }
    > = result.result.state === 'not-attempted'
      ? {
          status: 'followup',
          generation,
          mutationResult: 'not-attempted',
          retryAfterSeconds: requireRetryAfterSeconds(result),
        }
      : {
          status: 'followup',
          generation,
          mutationResult: 'stale-plan',
          retryAfterSeconds: null,
        };
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const fence = machine.fence(generation, leaseToken, now);
      if (fence.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      const plan = this.#requireMutationPlan(generation);
      plan.recordNonAttempted(result, now);
      const planState = plan.exportState();
      if (result.mutation.principal === 'human') {
        this.#deleteHumanMutationFence(
          planState,
          result.mutation,
        );
      }
      const completion = machine.completeForFollowup(
        generation,
        leaseToken,
        now,
      );
      if (completion.status === 'stale') {
        throw new Error(
          'Mutation fence changed inside one Durable Object transaction.',
        );
      }
      this.#writeMutationPlan(planState);
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result: {
          ...followupResult,
          generation: completion.generation,
        },
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordUnknownAndFail(
    generation: number,
    leaseToken: string,
    mutationBinding: StewardRuntimeControlMutationBindingV2,
  ): Promise<CoordinatorFailResult> {
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const fence = machine.fence(generation, leaseToken, now);
      if (fence.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      const plan = this.#requireMutationPlan(generation);
      plan.recordUnknown(mutationBinding, now);
      const failure = machine.fail(
        generation,
        leaseToken,
        'control-error',
        now,
      );
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result: failure,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async beginRecovery(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorFencedBeginRecoveryResult> {
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const renewal = machine.renew(
        generation,
        leaseToken,
        leaseDurationMs,
        now,
      );
      if (renewal.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'stale' } as const,
        };
      }
      const plan = this.#oldestUnresolvedMutationPlanBefore(generation);
      if (plan === null) {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: { status: 'none' } as const,
        };
      }
      const result = plan.beginRecovery(generation, now);
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordRecoveryResultAndComplete(
    generation: number,
    leaseToken: string,
    planGeneration: number,
    value: StewardRuntimeControlRecoveryReceiptV2,
  ): Promise<CoordinatorCompleteResult | CoordinatorFailResult> {
    const result = await parseCoordinatorMutationRecoveryResult(value);
    const now = Date.now();
    return this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const fence = machine.fence(generation, leaseToken, now);
      if (fence.status === 'stale') {
        this.#writeState(machine.exportState());
        return { status: 'stale' };
      }
      const plan = this.#requireMutationPlan(planGeneration);
      const currentLease = machine.exportState().lease;
      if (currentLease === null) {
        throw new Error('Recovery fence is missing its active lease.');
      }
      const disposition = plan.recordRecoveryResult(
        generation,
        currentLease.deliveryId,
        result,
        now,
      );
      const completion = disposition === 'retry'
        ? machine.fail(
            generation,
            leaseToken,
            'dependency-unavailable',
            now,
          )
        : machine.completeForFollowup(generation, leaseToken, now);
      if (completion.status === 'stale') {
        throw new Error(
          'Recovery fence changed inside one Durable Object transaction.',
        );
      }
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return completion;
    });
  }

  async completeMutationPlan(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult> {
    const now = Date.now();
    const mutation = this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const machine = this.#loadMachine();
      const plan = this.#requireMutationPlan(generation);
      const completion = machine.complete(generation, leaseToken, now);
      if (completion.status === 'stale') {
        this.#writeState(machine.exportState());
        return {
          alarmAt: machine.alarmAt(),
          result: completion,
        };
      }
      plan.complete(now);
      this.#writeMutationPlan(plan.exportState());
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result: completion,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  snapshot(): PullRequestCoordinatorSnapshot {
    return this.#ctx.storage.transactionSync(() =>
      this.#loadMachine().snapshot(),
    );
  }

  mutationLedgerSnapshot(): CoordinatorMutationLedgerSnapshot {
    const now = Date.now();
    return this.#ctx.storage.transactionSync(() => {
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
      const sql = this.#ctx.storage.sql;
      const planCount = this.#mutationPlanCount();
      const humanMutationFenceCount = this.#humanMutationFenceCount();
      const unresolvedUnknownCount = sql
        .exec<CountRow>(`
          SELECT COUNT(DISTINCT plans.generation) AS count
          FROM coordinator_mutation_plans AS plans
          LEFT JOIN coordinator_mutation_intents AS intents
            ON intents.generation = plans.generation
          WHERE plans.state IN ('unknown', 'recovering')
             OR intents.state = 'unknown'
        `)
        .one().count;
      const latestGeneration = sql
        .exec<GenerationRow>(`
          SELECT generation
          FROM coordinator_mutation_plans
          ORDER BY generation DESC
          LIMIT 1
        `)
        .toArray()[0];
      if (latestGeneration === undefined) {
        return {
          schemaVersion: coordinatorMutationSchemaVersion,
          planCount,
          humanMutationFenceCount,
          unresolvedUnknownCount,
          latest: null,
        };
      }
      const latest = this.#requireMutationPlan(
        latestGeneration.generation,
      ).exportState();
      return {
        schemaVersion: coordinatorMutationSchemaVersion,
        planCount,
        humanMutationFenceCount,
        unresolvedUnknownCount,
        latest: {
          generation: latest.generation,
          planId: latest.planId,
          planDigest: latest.planDigest,
          objective: latest.objective,
          state: latest.state,
          intentCounts: coordinatorMutationIntentCounts(latest.intents),
          controlVersionId: latest.controlRevision.workerVersionId,
        },
      };
    });
  }

  async alarm(): Promise<void> {
    const mutation = this.#mutate<CoordinatorAlarmResult>((machine, now) =>
      machine.alarm(now),
    );

    // An early or superseded alarm is harmless. If a renewed lease is still
    // active, restore its current deadline. No network I/O occurs here.
    await this.#scheduleAlarm(mutation.alarmAt);
  }

  #initializeSchema(): void {
    this.#ctx.storage.transactionSync(() => {
      const sql = this.#ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);

      const versionRow = sql
        .exec<SchemaVersionRow>(
          'SELECT version FROM coordinator_schema WHERE singleton = 1',
        )
        .toArray()[0];

      if (
        versionRow !== undefined &&
        versionRow.version !== coordinatorSchemaVersion
      ) {
        throw new Error(
          `Unsupported coordinator schema version ${versionRow.version}.`,
        );
      }

      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          repository_id TEXT NOT NULL,
          pull_number INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('idle', 'leased', 'followup')),
          dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
          lease_delivery_id TEXT,
          lease_generation INTEGER,
          lease_kind TEXT CHECK (lease_kind IN ('delivery', 'followup')),
          lease_token TEXT,
          lease_expires_at INTEGER,
          failure_code TEXT
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_deliveries (
          delivery_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          accepted_at INTEGER NOT NULL,
          completed_at INTEGER,
          covered_generation INTEGER
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS coordinator_deliveries_completed
        ON coordinator_deliveries (status, completed_at)
      `);

      if (versionRow === undefined) {
        sql.exec(
          'INSERT INTO coordinator_schema (singleton, version) VALUES (1, ?)',
          coordinatorSchemaVersion,
        );
      }

      const existing = sql
        .exec<CoordinatorStateRow>(
          'SELECT * FROM coordinator_state WHERE singleton = 1',
        )
        .toArray()[0];

      if (existing === undefined) {
        const initial = createPullRequestCoordinatorState(this.#subject);
        this.#writeState(initial);
      } else if (
        existing.repository_id !== this.#subject.repositoryId
        || existing.pull_number !== this.#subject.pullNumber
      ) {
        throw new Error(
          'Durable Object name does not match its persisted PR subject.',
        );
      }

      this.#initializeMutationSchema();
      const now = Date.now();
      this.#expireBaseLeaseIfNeeded(now);
      this.#auditStaleMutationPlans(now);
    });
  }

  #initializeMutationSchema(): void {
    const sql = this.#ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_mutation_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      )
    `);
    const versionRow = sql
      .exec<SchemaVersionRow>(
        'SELECT version FROM coordinator_mutation_schema WHERE singleton = 1',
      )
      .toArray()[0];
    if (
      versionRow !== undefined
      && versionRow.version !== coordinatorMutationSchemaVersion
    ) {
      throw new Error(
        `Unsupported coordinator mutation schema version ${versionRow.version}.`,
      );
    }

    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_mutation_plans (
        generation INTEGER PRIMARY KEY CHECK (generation > 0),
        installation_id INTEGER NOT NULL CHECK (installation_id > 0),
        delivery_id TEXT NOT NULL,
        work_item_json TEXT NOT NULL,
        work_item_digest TEXT NOT NULL,
        prepared_receipt_json TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        operation TEXT NOT NULL,
        objective TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        pull_number INTEGER NOT NULL CHECK (pull_number > 0),
        head_sha TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        manifest_blob_sha TEXT NOT NULL,
        config_digest TEXT NOT NULL,
        pull_request_digest TEXT NOT NULL,
        terminal_outcome TEXT NOT NULL CHECK (
          terminal_outcome IN (
            'settled',
            'pending-external',
            'ignored',
            'action-required'
          )
        ),
        canonical_plan_byte_length INTEGER NOT NULL CHECK (
          canonical_plan_byte_length BETWEEN 1 AND 65536
        ),
        canonical_plan_base64 TEXT NOT NULL,
        control_steward_commit TEXT NOT NULL,
        control_worker_version_id TEXT NOT NULL,
        control_worker_version_tag TEXT NOT NULL,
        control_worker_version_created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared',
            'applying',
            'recovering',
            'settled',
            'pending-external',
            'ignored',
            'action-required',
            'unknown',
            'abandoned',
            'superseded'
          )
        ),
        recovery_generation INTEGER,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        terminal_at INTEGER
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_mutation_intents (
        generation INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        intent_key TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        principal TEXT NOT NULL CHECK (
          principal IN ('installation', 'human')
        ),
        desired_digest TEXT NOT NULL,
        recovery_policy TEXT NOT NULL CHECK (
          (
            principal = 'installation'
            AND recovery_policy = 'live-evidence'
          )
          OR (
            principal = 'human'
            AND recovery_policy = 'live-evidence-or-action-required'
          )
        ),
        state TEXT NOT NULL CHECK (
          state IN (
            'planned',
            'applying',
            'settled',
            'unknown',
            'action-required',
            'cancelled'
          )
        ),
        cancel_reason TEXT CHECK (
          cancel_reason IS NULL OR cancel_reason IN (
            'blocked-by-action-required',
            'superseded-by-replan',
            'not-attempted',
            'stale-plan'
          )
        ),
        dispatch_count INTEGER NOT NULL CHECK (dispatch_count IN (0, 1)),
        started_at INTEGER,
        PRIMARY KEY (generation, ordinal),
        UNIQUE (generation, intent_key)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_mutation_receipts (
        generation INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        intent_key TEXT NOT NULL,
        desired_digest TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('applied', 'converged')),
        source TEXT NOT NULL CHECK (source IN ('apply', 'recovery')),
        resource_id INTEGER,
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
        PRIMARY KEY (generation, ordinal)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_human_mutation_fences (
        head_sha TEXT NOT NULL CHECK (
          length(head_sha) = 40
          AND head_sha NOT GLOB '*[^0-9a-f]*'
        ),
        mutation_type TEXT NOT NULL CHECK (
          length(mutation_type) BETWEEN 1 AND 64
        ),
        source_generation INTEGER NOT NULL CHECK (source_generation > 0),
        source_plan_id TEXT NOT NULL CHECK (
          length(source_plan_id) = 64
          AND source_plan_id NOT GLOB '*[^0-9a-f]*'
        ),
        source_plan_digest TEXT NOT NULL CHECK (
          length(source_plan_digest) = 64
          AND source_plan_digest NOT GLOB '*[^0-9a-f]*'
        ),
        intent_key TEXT NOT NULL CHECK (
          length(intent_key) BETWEEN 1 AND 128
        ),
        desired_digest TEXT NOT NULL CHECK (
          length(desired_digest) = 64
          AND desired_digest NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (head_sha, mutation_type)
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS coordinator_mutation_plans_terminal
      ON coordinator_mutation_plans (terminal_at, generation)
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS coordinator_mutation_plans_recovery
      ON coordinator_mutation_plans (state, recovery_generation, generation)
    `);

    if (versionRow === undefined) {
      sql.exec(
        `INSERT INTO coordinator_mutation_schema (singleton, version)
         VALUES (1, ?)`,
        coordinatorMutationSchemaVersion,
      );
    }
  }

  #mutate<T>(
    operation: (
      machine: PullRequestCoordinatorStateMachine,
      now: number,
    ) => T,
  ): CoordinatorMutation<T> {
    return this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const machine = this.#loadMachine();
      const result = operation(machine, now);
      this.#writeState(machine.exportState());
      this.#auditStaleMutationPlans(now);
      return {
        alarmAt: machine.alarmAt(),
        result,
      };
    });
  }

  #expireBaseLeaseIfNeeded(now: number): void {
    const machine = this.#loadMachine();
    if (machine.alarm(now).status === 'expired') {
      this.#writeState(machine.exportState());
    }
  }

  #auditStaleMutationPlans(now: number): void {
    const base = this.#loadMachine().exportState();
    const rows = this.#ctx.storage.sql
      .exec<GenerationRow>(`
        SELECT generation
        FROM coordinator_mutation_plans
        WHERE state IN ('prepared', 'applying', 'recovering')
        ORDER BY generation
      `)
      .toArray();

    for (const row of rows) {
      const plan = this.#requireMutationPlan(row.generation);
      const state = plan.exportState();
      const expectedGeneration = state.state === 'recovering'
        ? state.recoveryGeneration
        : state.generation;
      const leaseIsActive =
        expectedGeneration !== null
        && base.phase === 'leased'
        && base.lease !== null
        && base.lease.generation === expectedGeneration
        && base.lease.expiresAt > now;
      if (!leaseIsActive) {
        plan.markLeaseLost(now);
        this.#writeMutationPlan(plan.exportState());
      }
    }
  }

  #assertPreparedPlanSubject(
    prepared: Awaited<
      ReturnType<typeof parseCoordinatorPreparedMutationPlan>
    >,
    base: PullRequestCoordinatorStoredState,
    generation: number,
  ): void {
    const receipt = prepared.receipt;
    if (
      String(receipt.resolvedContext.repositoryId)
        !== this.#subject.repositoryId
      || receipt.resolvedContext.pullRequestNumber
        !== this.#subject.pullNumber
      || receipt.binding.workItem.subject.repositoryId
        !== receipt.resolvedContext.repositoryId
      || receipt.binding.workItem.subject.pullRequestNumber
        !== receipt.resolvedContext.pullRequestNumber
      || receipt.binding.generation !== generation
      || receipt.plan.preparedGeneration !== generation
      || base.phase !== 'leased'
      || base.lease === null
      || base.lease.generation !== generation
      || base.lease.deliveryId
        !== receipt.binding.workItem.cause.deliveryId
    ) {
      throw new Error(
        'Prepared mutation plan does not bind the active coordinator lease.',
      );
    }
  }

  #loadMutationPlan(
    generation: number,
  ): CoordinatorMutationPlanStoredState | null {
    const row = this.#ctx.storage.sql
      .exec<CoordinatorMutationPlanRow>(
        `SELECT * FROM coordinator_mutation_plans WHERE generation = ?`,
        generation,
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    const intents = this.#ctx.storage.sql
      .exec<CoordinatorMutationIntentRow>(
        `SELECT *
         FROM coordinator_mutation_intents
         WHERE generation = ?
         ORDER BY ordinal`,
        generation,
      )
      .toArray();
    const receipts = this.#ctx.storage.sql
      .exec<CoordinatorMutationReceiptRow>(
        `SELECT *
         FROM coordinator_mutation_receipts
         WHERE generation = ?
         ORDER BY ordinal`,
        generation,
      )
      .toArray();

    return {
      canonicalPlanBase64: row.canonical_plan_base64,
      canonicalPlanByteLength: row.canonical_plan_byte_length,
      controlRevision: {
        stewardCommit: row.control_steward_commit,
        workerVersionCreatedAt: row.control_worker_version_created_at,
        workerVersionId: row.control_worker_version_id,
        workerVersionTag: row.control_worker_version_tag,
      },
      createdAt: row.created_at,
      deliveryId: row.delivery_id,
      generation: row.generation,
      installationId: row.installation_id,
      intents: intents.map((intent) => ({
        cancelReason:
          intent.cancel_reason as CoordinatorMutationIntentRecord['cancelReason'],
        desiredDigest: intent.desired_digest,
        dispatchCount: intent.dispatch_count,
        key: intent.intent_key,
        mutationType: intent.mutation_type,
        ordinal: intent.ordinal,
        principal:
          intent.principal as CoordinatorMutationIntentRecord['principal'],
        recoveryPolicy:
          intent.recovery_policy as CoordinatorMutationIntentRecord['recoveryPolicy'],
        startedAt: intent.started_at,
        state: intent.state as CoordinatorMutationIntentRecord['state'],
      })),
      objective: row.objective,
      operation:
        row.operation as CoordinatorMutationPlanStoredState['operation'],
      planDigest: row.plan_digest,
      planId: row.plan_id,
      preparedReceiptJson: row.prepared_receipt_json,
      receipts: receipts.map((receipt) => ({
        desiredDigest: receipt.desired_digest,
        key: receipt.intent_key,
        ordinal: receipt.ordinal,
        recordedAt: receipt.recorded_at,
        resourceId: receipt.resource_id,
        result:
          receipt.result as CoordinatorMutationReceiptRecord['result'],
        source:
          receipt.source as CoordinatorMutationReceiptRecord['source'],
      })),
      recoveryGeneration: row.recovery_generation,
      resolvedContext: {
        configDigest: row.config_digest,
        defaultBranch: row.default_branch,
        headSha: row.head_sha,
        manifestBlobSha: row.manifest_blob_sha,
        pullRequestDigest: row.pull_request_digest,
        pullRequestNumber: row.pull_number,
        repositoryFullName: row.repository_full_name,
        repositoryId: Number(row.repository_id),
      },
      state: row.state as CoordinatorMutationPlanStoredState['state'],
      terminalAt: row.terminal_at,
      terminalOutcome:
        row.terminal_outcome as CoordinatorMutationPlanStoredState['terminalOutcome'],
      updatedAt: row.updated_at,
      workItemDigest: row.work_item_digest,
      workItemJson: row.work_item_json,
    };
  }

  #requireMutationPlan(
    generation: number,
  ): CoordinatorMutationPlanStateMachine {
    const state = this.#loadMutationPlan(generation);
    if (state === null) {
      throw new Error(
        `Coordinator mutation plan generation ${generation} was not found.`,
      );
    }
    return new CoordinatorMutationPlanStateMachine(state);
  }

  #writeMutationPlan(state: CoordinatorMutationPlanStoredState): void {
    const sql = this.#ctx.storage.sql;
    const context = state.resolvedContext;
    const revision = state.controlRevision;
    sql.exec(
      `
        INSERT INTO coordinator_mutation_plans (
          generation,
          installation_id,
          delivery_id,
          work_item_json,
          work_item_digest,
          prepared_receipt_json,
          plan_id,
          plan_digest,
          operation,
          objective,
          repository_id,
          repository_full_name,
          pull_number,
          head_sha,
          default_branch,
          manifest_blob_sha,
          config_digest,
          pull_request_digest,
          terminal_outcome,
          canonical_plan_byte_length,
          canonical_plan_base64,
          control_steward_commit,
          control_worker_version_id,
          control_worker_version_tag,
          control_worker_version_created_at,
          state,
          recovery_generation,
          created_at,
          updated_at,
          terminal_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(generation) DO UPDATE SET
          installation_id = excluded.installation_id,
          delivery_id = excluded.delivery_id,
          work_item_json = excluded.work_item_json,
          work_item_digest = excluded.work_item_digest,
          prepared_receipt_json = excluded.prepared_receipt_json,
          plan_id = excluded.plan_id,
          plan_digest = excluded.plan_digest,
          operation = excluded.operation,
          objective = excluded.objective,
          repository_id = excluded.repository_id,
          repository_full_name = excluded.repository_full_name,
          pull_number = excluded.pull_number,
          head_sha = excluded.head_sha,
          default_branch = excluded.default_branch,
          manifest_blob_sha = excluded.manifest_blob_sha,
          config_digest = excluded.config_digest,
          pull_request_digest = excluded.pull_request_digest,
          terminal_outcome = excluded.terminal_outcome,
          canonical_plan_byte_length = excluded.canonical_plan_byte_length,
          canonical_plan_base64 = excluded.canonical_plan_base64,
          control_steward_commit = excluded.control_steward_commit,
          control_worker_version_id = excluded.control_worker_version_id,
          control_worker_version_tag = excluded.control_worker_version_tag,
          control_worker_version_created_at =
            excluded.control_worker_version_created_at,
          state = excluded.state,
          recovery_generation = excluded.recovery_generation,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          terminal_at = excluded.terminal_at
      `,
      state.generation,
      state.installationId,
      state.deliveryId,
      state.workItemJson,
      state.workItemDigest,
      state.preparedReceiptJson,
      state.planId,
      state.planDigest,
      state.operation,
      state.objective,
      String(context.repositoryId),
      context.repositoryFullName,
      context.pullRequestNumber,
      context.headSha,
      context.defaultBranch,
      context.manifestBlobSha,
      context.configDigest,
      context.pullRequestDigest,
      state.terminalOutcome,
      state.canonicalPlanByteLength,
      state.canonicalPlanBase64,
      revision.stewardCommit,
      revision.workerVersionId,
      revision.workerVersionTag,
      revision.workerVersionCreatedAt,
      state.state,
      state.recoveryGeneration,
      state.createdAt,
      state.updatedAt,
      state.terminalAt,
    );

    sql.exec(
      'DELETE FROM coordinator_mutation_receipts WHERE generation = ?',
      state.generation,
    );
    sql.exec(
      'DELETE FROM coordinator_mutation_intents WHERE generation = ?',
      state.generation,
    );
    for (const intent of state.intents) {
      sql.exec(
        `
          INSERT INTO coordinator_mutation_intents (
            generation,
            ordinal,
            intent_key,
            mutation_type,
            principal,
            desired_digest,
            recovery_policy,
            state,
            cancel_reason,
            dispatch_count,
            started_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        state.generation,
        intent.ordinal,
        intent.key,
        intent.mutationType,
        intent.principal,
        intent.desiredDigest,
        intent.recoveryPolicy,
        intent.state,
        intent.cancelReason,
        intent.dispatchCount,
        intent.startedAt,
      );
    }
    for (const receipt of state.receipts) {
      sql.exec(
        `
          INSERT INTO coordinator_mutation_receipts (
            generation,
            ordinal,
            intent_key,
            desired_digest,
            result,
            source,
            resource_id,
            recorded_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        state.generation,
        receipt.ordinal,
        receipt.key,
        receipt.desiredDigest,
        receipt.result,
        receipt.source,
        receipt.resourceId,
        receipt.recordedAt,
      );
    }
  }

  #deleteMutationPlan(generation: number): void {
    const sql = this.#ctx.storage.sql;
    sql.exec(
      'DELETE FROM coordinator_mutation_receipts WHERE generation = ?',
      generation,
    );
    sql.exec(
      'DELETE FROM coordinator_mutation_intents WHERE generation = ?',
      generation,
    );
    sql.exec(
      'DELETE FROM coordinator_mutation_plans WHERE generation = ?',
      generation,
    );
  }

  #pruneMutationPlans(now: number): void {
    const terminalStates = `
      'settled',
      'pending-external',
      'ignored',
      'action-required',
      'abandoned',
      'superseded'
    `;
    const cutoff = Math.max(0, now - coordinatorMutationPlanRetentionMs);
    const expired = this.#ctx.storage.sql
      .exec<GenerationRow>(`
        SELECT plans.generation
        FROM coordinator_mutation_plans AS plans
        WHERE plans.state IN (${terminalStates})
          AND plans.terminal_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM coordinator_mutation_intents AS intents
            WHERE intents.generation = plans.generation
              AND intents.state = 'unknown'
          )
        ORDER BY plans.terminal_at, plans.generation
      `, cutoff)
      .toArray();
    for (const row of expired) {
      this.#deleteMutationPlan(row.generation);
    }

    let count = this.#mutationPlanCount();
    if (count < coordinatorMutationPlanRetentionLimit) {
      return;
    }
    const candidates = this.#ctx.storage.sql
      .exec<GenerationRow>(`
        SELECT plans.generation
        FROM coordinator_mutation_plans AS plans
        WHERE plans.state IN (${terminalStates})
          AND NOT EXISTS (
            SELECT 1
            FROM coordinator_mutation_intents AS intents
            WHERE intents.generation = plans.generation
              AND intents.state = 'unknown'
          )
        ORDER BY plans.terminal_at, plans.generation
      `)
      .toArray();
    for (const row of candidates) {
      if (count < coordinatorMutationPlanRetentionLimit) {
        break;
      }
      this.#deleteMutationPlan(row.generation);
      count -= 1;
    }
    if (count >= coordinatorMutationPlanRetentionLimit) {
      throw new Error(
        'Coordinator mutation ledger capacity is reserved by unresolved plans.',
      );
    }
  }

  #mutationPlanCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM coordinator_mutation_plans',
      )
      .one().count;
  }

  #humanMutationFence(
    plan: CoordinatorMutationPlanStoredState,
    intent: CoordinatorMutationIntentRecord,
    now: number,
  ): CoordinatorHumanMutationFenceRecord {
    if (intent.principal !== 'human') {
      throw new Error('Only a human mutation can reserve a human fence.');
    }
    return {
      createdAt: now,
      desiredDigest: intent.desiredDigest,
      headSha: plan.resolvedContext.headSha,
      key: intent.key,
      mutationType: intent.mutationType,
      sourceGeneration: plan.generation,
      sourcePlanDigest: plan.planDigest,
      sourcePlanId: plan.planId,
    };
  }

  #humanMutationFenceCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM coordinator_human_mutation_fences',
      )
      .one().count;
  }

  #loadHumanMutationFence(
    headSha: string,
    mutationType: string,
  ): CoordinatorHumanMutationFenceRecord | null {
    const row = this.#ctx.storage.sql
      .exec<CoordinatorHumanMutationFenceRow>(
        `SELECT *
         FROM coordinator_human_mutation_fences
         WHERE head_sha = ? AND mutation_type = ?`,
        headSha,
        mutationType,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : {
          createdAt: row.created_at,
          desiredDigest: row.desired_digest,
          headSha: row.head_sha,
          key: row.intent_key,
          mutationType: row.mutation_type,
          sourceGeneration: row.source_generation,
          sourcePlanDigest: row.source_plan_digest,
          sourcePlanId: row.source_plan_id,
        };
  }

  #writeHumanMutationFence(
    fence: CoordinatorHumanMutationFenceRecord,
  ): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO coordinator_human_mutation_fences (
         head_sha,
         mutation_type,
         source_generation,
         source_plan_id,
         source_plan_digest,
         intent_key,
         desired_digest,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fence.headSha,
      fence.mutationType,
      fence.sourceGeneration,
      fence.sourcePlanId,
      fence.sourcePlanDigest,
      fence.key,
      fence.desiredDigest,
      fence.createdAt,
    );
  }

  #deleteHumanMutationFence(
    plan: CoordinatorMutationPlanStoredState,
    mutation: StewardRuntimeControlMutationBindingV2,
  ): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM coordinator_human_mutation_fences
       WHERE head_sha = ?
         AND mutation_type = ?
         AND source_generation = ?
         AND source_plan_id = ?
         AND source_plan_digest = ?
         AND intent_key = ?
         AND desired_digest = ?`,
      plan.resolvedContext.headSha,
      mutation.mutationType,
      plan.generation,
      plan.planId,
      plan.planDigest,
      mutation.key,
      mutation.desiredDigest,
    );
  }

  #oldestUnresolvedMutationGenerationBefore(
    currentGeneration: number,
  ): number | null {
    const row = this.#ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT generation
         FROM coordinator_mutation_plans
         WHERE state IN ('unknown', 'recovering') AND generation < ?
         ORDER BY generation
         LIMIT 1`,
        currentGeneration,
      )
      .toArray()[0];
    return row?.generation ?? null;
  }

  #oldestUnresolvedMutationPlanBefore(
    currentGeneration: number,
  ): CoordinatorMutationPlanStateMachine | null {
    const generation = this.#oldestUnresolvedMutationGenerationBefore(
      currentGeneration,
    );
    return generation === null
      ? null
      : this.#requireMutationPlan(generation);
  }

  #loadMachine(): PullRequestCoordinatorStateMachine {
    const sql = this.#ctx.storage.sql;
    const stateRow = sql
      .exec<CoordinatorStateRow>(
        'SELECT * FROM coordinator_state WHERE singleton = 1',
      )
      .one();
    const deliveryRows = sql
      .exec<CoordinatorDeliveryRow>(`
        SELECT
          delivery_id,
          status,
          accepted_at,
          completed_at,
          covered_generation
        FROM coordinator_deliveries
        ORDER BY accepted_at, delivery_id
      `)
      .toArray();

    const lease =
      stateRow.lease_delivery_id === null
        ? null
        : {
            deliveryId: stateRow.lease_delivery_id,
            expiresAt: requireNumber(
              stateRow.lease_expires_at,
              'lease_expires_at',
            ),
            generation: requireNumber(
              stateRow.lease_generation,
              'lease_generation',
            ),
            kind: toLeaseKind(
              requireString(stateRow.lease_kind, 'lease_kind'),
            ),
            token: requireString(stateRow.lease_token, 'lease_token'),
          };

    return new PullRequestCoordinatorStateMachine({
      deliveries: deliveryRows.map(toDeliveryRecord),
      dirty: stateRow.dirty === 1,
      failureCode: toFailureCode(stateRow.failure_code),
      generation: stateRow.generation,
      lease,
      phase: toPhase(stateRow.phase),
      subject: {
        pullNumber: stateRow.pull_number,
        repositoryId: stateRow.repository_id,
      },
    });
  }

  #writeState(state: PullRequestCoordinatorStoredState): void {
    const sql = this.#ctx.storage.sql;
    sql.exec(
      `
        INSERT INTO coordinator_state (
          singleton,
          repository_id,
          pull_number,
          generation,
          phase,
          dirty,
          lease_delivery_id,
          lease_generation,
          lease_kind,
          lease_token,
          lease_expires_at,
          failure_code
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          repository_id = excluded.repository_id,
          pull_number = excluded.pull_number,
          generation = excluded.generation,
          phase = excluded.phase,
          dirty = excluded.dirty,
          lease_delivery_id = excluded.lease_delivery_id,
          lease_generation = excluded.lease_generation,
          lease_kind = excluded.lease_kind,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          failure_code = excluded.failure_code
      `,
      state.subject.repositoryId,
      state.subject.pullNumber,
      state.generation,
      state.phase,
      state.dirty ? 1 : 0,
      state.lease?.deliveryId ?? null,
      state.lease?.generation ?? null,
      state.lease?.kind ?? null,
      state.lease?.token ?? null,
      state.lease?.expiresAt ?? null,
      state.failureCode,
    );

    sql.exec('DELETE FROM coordinator_deliveries');
    for (const delivery of state.deliveries) {
      sql.exec(
        `
          INSERT INTO coordinator_deliveries (
            delivery_id,
            status,
            accepted_at,
            completed_at,
            covered_generation
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        delivery.deliveryId,
        delivery.status,
        delivery.acceptedAt,
        delivery.completedAt,
        delivery.coveredGeneration,
      );
    }
  }

  async #scheduleAlarm(alarmAt: number | null): Promise<void> {
    if (alarmAt !== null) {
      await this.#ctx.storage.setAlarm(alarmAt);
    }
  }
}

function toDeliveryRecord(
  row: CoordinatorDeliveryRow,
): CoordinatorDeliveryRecord {
  if (row.status !== 'pending' && row.status !== 'completed') {
    throw new Error(`Unsupported delivery state ${row.status}.`);
  }

  return {
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    coveredGeneration: row.covered_generation,
    deliveryId: row.delivery_id,
    status: row.status,
  };
}

function toPhase(
  value: string,
): PullRequestCoordinatorStoredState['phase'] {
  if (value !== 'idle' && value !== 'leased' && value !== 'followup') {
    throw new Error(`Unsupported coordinator phase ${value}.`);
  }
  return value;
}

function toLeaseKind(value: string): 'delivery' | 'followup' {
  if (value !== 'delivery' && value !== 'followup') {
    throw new Error(`Unsupported coordinator lease kind ${value}.`);
  }
  return value;
}

function toFailureCode(
  value: string | null,
): CoordinatorFailureCode | null {
  if (value === null) {
    return null;
  }
  if (
    value === 'control-error' ||
    value === 'dependency-unavailable' ||
    value === 'lease-expired' ||
    value === 'rate-limited' ||
    value === 'runtime-error'
  ) {
    return value;
  }
  throw new Error(`Unsupported coordinator failure code ${value}.`);
}

function requireNumber(value: number | null, name: string): number {
  if (value === null) {
    throw new Error(`Coordinator state is missing ${name}.`);
  }
  return value;
}

function requireString(value: string | null, name: string): string {
  if (value === null) {
    throw new Error(`Coordinator state is missing ${name}.`);
  }
  return value;
}
