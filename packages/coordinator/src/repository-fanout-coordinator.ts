import { DurableObject } from 'cloudflare:workers';
import {
  STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PAGES,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptAnyJson,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  parseStewardRuntimeRepositoryFanoutPageReceiptAny,
  type StewardRuntimeRepositoryFanoutPageReceiptAny,
} from '../../core/src/runtime-repository-fanout.js';
import {
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  parseStewardRuntimeInstallationRepositoryChildV1,
  type StewardRuntimeInstallationRepositoryChildV1,
} from '../../core/src/runtime-installation-fanout.js';
import {
  canonicalStewardRuntimeScopeWorkItemJson,
  parseStewardRuntimeScopeWorkItem,
} from '../../core/src/runtime-scope-work-item.js';
import {
  assertRepositoryFanoutDispatchBatchSize,
  assertRepositoryFanoutFailureCode,
  assertRepositoryFanoutGeneration,
  assertRepositoryFanoutLeaseDurationMs,
  assertRepositoryFanoutLeaseToken,
  parseRepositoryFanoutCoordinatorName,
  parseRepositoryFanoutQueueConfirmations,
  repositoryFanoutCompletedDeliveryRetentionLimit,
  repositoryFanoutCompletedDeliveryRetentionMs,
  repositoryFanoutMaximumDriftRestarts,
  repositoryFanoutPendingDeliveryRetentionLimit,
  repositoryFanoutSchemaVersion,
  type RepositoryFanoutClaimResult,
  type RepositoryFanoutCompleteResult,
  type RepositoryFanoutFailResult,
  type RepositoryFanoutFailureCode,
  type RepositoryFanoutNextDispatchBatchResult,
  type RepositoryFanoutPhase,
  type RepositoryFanoutRecordPageResult,
  type RepositoryFanoutRecordQueueConfirmedResult,
  type RepositoryFanoutReleaseForContinuationResult,
  type RepositoryFanoutSnapshot,
  type RepositoryFanoutInput,
  type RepositoryFanoutScopeWorkItem,
} from './repository-fanout-contracts.js';

type SqlValue = ArrayBuffer | string | number | null;

interface SqlCursor<T extends object> {
  one(): T;
  toArray(): T[];
}

interface SqlStorage {
  exec<T extends object>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<T>;
}

interface RepositoryFanoutDurableObjectState {
  readonly id: {
    readonly name?: string;
  };
  readonly storage: {
    readonly sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
    setAlarm(scheduledTime: number): Promise<void>;
  };
}

interface SchemaVersionRow {
  version: number;
}

interface CountRow {
  count: number;
}

interface FanoutStateRow {
  completed_target_count: number;
  current_cursor: string | null;
  current_pass: number | null;
  dirty: number;
  failure_code: string | null;
  generation: number;
  lease_duration_ms: number | null;
  lease_expires_at: number | null;
  lease_token: string | null;
  page_count: number;
  phase: string;
  repository_id: string;
  restart_count: number;
  selected_delivery_id: string | null;
  selected_scope_json: string | null;
  target_count: number;
}

interface DeliveryRow {
  accepted_at: number;
  completed_at: number | null;
  covered_generation: number | null;
  delivery_id: string;
  scope_json: string;
  status: string;
}

interface PageRow {
  receipt_json: string;
}

interface PassRow {
  complete: number;
  control_revision_json: string;
  page_count: number;
  repository_full_name: string | null;
  repository_state: string;
  total_count: number;
}

interface TargetRow {
  delivery_id: string;
  pull_number: number;
  state: string;
}

interface CoordinatorMutation<T> {
  readonly alarmAt: number | null;
  readonly result: T;
}

interface MutableFanoutState {
  completedTargetCount: number;
  currentCursor: string | null;
  currentPass: 1 | 2 | null;
  dirty: boolean;
  failureCode: RepositoryFanoutFailureCode | null;
  generation: number;
  leaseDurationMs: number | null;
  leaseExpiresAt: number | null;
  leaseToken: string | null;
  pageCount: number;
  phase: RepositoryFanoutPhase;
  repositoryId: string;
  restartCount: number;
  selectedDeliveryId: string | null;
  selectedScopeJson: string | null;
  targetCount: number;
}

const cursorStartKey = '';

/**
 * Repository-scoped durable state only. The Queue consumer and private Control
 * page reader deliberately live outside this object, so no GitHub or Queue
 * network call can occur while its SQLite transaction is held.
 */
export class RepositoryFanoutCoordinator extends DurableObject {
  readonly #ctx: RepositoryFanoutDurableObjectState;
  readonly #repositoryId: string;

  constructor(ctx: RepositoryFanoutDurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;
    const objectName = ctx.id.name;
    if (objectName === undefined) {
      throw new TypeError(
        'RepositoryFanoutCoordinator must be addressed with idFromName().',
      );
    }
    this.#repositoryId =
      parseRepositoryFanoutCoordinatorName(objectName).repositoryId;
    this.#initializeSchema();
  }

  async claim(
    scopeItemValue: unknown,
    leaseDurationMs: number,
  ): Promise<RepositoryFanoutClaimResult> {
    const scopeItem = await parseRepositoryFanoutInput(scopeItemValue);
    const scopeJson = await canonicalRepositoryFanoutInputJson(scopeItem);
    const deliveryId = repositoryFanoutInputDeliveryId(scopeItem);
    const duration = assertRepositoryFanoutLeaseDurationMs(leaseDurationMs);
    if (String(repositoryFanoutInputRepositoryId(scopeItem)) !== this.#repositoryId) {
      throw new TypeError(
        'Repository fan-out input does not match the Durable Object.',
      );
    }

    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.#pruneCompletedDeliveries(now);
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      const known = this.#loadDelivery(deliveryId);
      if (known !== undefined && known.scope_json !== scopeJson) {
        throw new TypeError(
          'A delivery ID cannot identify different repository fan-out work.',
        );
      }

      if (known?.status === 'completed' && state.phase !== 'followup') {
        this.#writeState(state);
        return {
          alarmAt: this.#alarmAt(state),
          result: { status: 'duplicate' } as const,
        };
      }

      if (state.leaseToken !== null) {
        if (known === undefined) {
          this.#appendPendingDelivery(
            state,
            deliveryId,
            scopeJson,
            now,
          );
          state.dirty = true;
        }
        this.#writeState(state);
        return {
          alarmAt: this.#alarmAt(state),
          result: {
            status: state.selectedDeliveryId === deliveryId
              ? 'busy'
              : 'coalesced',
            generation: state.generation,
            expiresAt: requireLeaseExpiry(state),
          } as const,
        };
      }

      if (known === undefined && state.phase !== 'followup') {
        this.#appendPendingDelivery(state, deliveryId, scopeJson, now);
      } else if (
        known === undefined
        && state.phase === 'followup'
      ) {
        this.#appendPendingDelivery(state, deliveryId, scopeJson, now);
        state.dirty = true;
      }

      if (
        state.phase === 'enumerating'
        || state.phase === 'dispatch'
      ) {
        const selected = this.#selectedScopeItem(state);
        this.#grantLease(state, duration, now);
        state.failureCode = null;
        this.#writeState(state);
        return {
          alarmAt: this.#alarmAt(state),
          result: {
            status: 'claimed',
            generation: state.generation,
            leaseToken: requireLeaseToken(state),
            expiresAt: requireLeaseExpiry(state),
            resumed: true,
            selectedScopeItem: selected,
            phase: state.phase,
            pass: state.currentPass,
            cursor: state.currentCursor,
          } as const,
        };
      }

      if (
        state.phase === 'followup'
        && this.#pendingDeliveryCount() === 0
      ) {
        // A completed root is allowed to wake durable level-triggered follow-up
        // state after a lost completion response.
        if (known?.status === 'completed') {
          this.#ctx.storage.sql.exec(
            `UPDATE repository_fanout_deliveries
             SET scope_json = ?,
                 status = 'pending',
                 accepted_at = ?,
                 completed_at = NULL,
                 covered_generation = NULL
             WHERE delivery_id = ?`,
            scopeJson,
            now,
            deliveryId,
          );
        } else {
          this.#appendPendingDelivery(state, deliveryId, scopeJson, now);
        }
      }
      const selected = this.#oldestPendingDelivery();
      if (selected === undefined) {
        throw new Error('Repository fan-out has no pending delivery to claim.');
      }
      const generation = nextGeneration(state.generation);
      this.#clearScanState();
      this.#ctx.storage.sql.exec(
        `UPDATE repository_fanout_deliveries
         SET covered_generation = ?
         WHERE status = 'pending' AND delivery_id = ?`,
        generation,
        selected.delivery_id,
      );
      state.generation = generation;
      state.phase = 'enumerating';
      state.dirty = false;
      state.failureCode = null;
      state.selectedDeliveryId = selected.delivery_id;
      state.selectedScopeJson = selected.scope_json;
      state.currentPass = 1;
      state.currentCursor = null;
      state.pageCount = 0;
      state.restartCount = 0;
      state.targetCount = 0;
      state.completedTargetCount = 0;
      this.#grantLease(state, duration, now);
      this.#writeState(state);
      return {
        alarmAt: this.#alarmAt(state),
        result: {
          status: 'claimed',
          generation,
          leaseToken: requireLeaseToken(state),
          expiresAt: requireLeaseExpiry(state),
          resumed: false,
          selectedScopeItem: parseStoredRepositoryFanoutInput(
            selected.scope_json,
          ),
          phase: 'enumerating',
          pass: 1,
          cursor: null,
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    if (mutation.result.status === 'claimed') {
      return {
        ...mutation.result,
        selectedScopeItem: await parseRepositoryFanoutInput(
          mutation.result.selectedScopeItem,
        ),
      };
    }
    return mutation.result;
  }

  async recordPage(
    generationValue: number,
    leaseTokenValue: string,
    receiptValue: unknown,
  ): Promise<RepositoryFanoutRecordPageResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const receipt = await parseStewardRuntimeRepositoryFanoutPageReceiptAny(
      receiptValue,
    );
    const receiptJson =
      await canonicalStewardRuntimeRepositoryFanoutPageReceiptAnyJson(receipt);
    const input = receipt.schemaVersion === 3
      ? receipt.binding.installationChild
      : receipt.binding.scopeWorkItem;
    const scopeJson = await canonicalRepositoryFanoutInputJson(input);
    const targetDeliveries = await Promise.all(
      receipt.page.pullRequestNumbers.map(async (pullRequestNumber) => ({
        pullRequestNumber,
        deliveryId: await (
          receipt.schemaVersion === 1
            ? deriveStewardRuntimeFanoutDeliveryId
            : receipt.schemaVersion === 2
              ? deriveStewardRuntimeFanoutDeliveryIdV2
              : deriveStewardRuntimeFanoutDeliveryIdV3
        )(
          input,
          generation,
          pullRequestNumber,
        ),
      })),
    );

    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutRecordPageResult>(state);
      }
      if (
        state.selectedScopeJson === null
        || receipt.binding.generation !== generation
        || scopeJson !== state.selectedScopeJson
      ) {
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordPageResult>(
          state,
          { status: 'conflict' },
        );
      }

      const cursorKey = receipt.binding.cursor ?? cursorStartKey;
      const existing = this.#ctx.storage.sql
        .exec<PageRow>(
          `SELECT receipt_json
           FROM repository_fanout_pages
           WHERE generation = ?
             AND restart_count = ?
             AND scan_pass = ?
             AND cursor_key = ?`,
          generation,
          state.restartCount,
          receipt.binding.pass,
          cursorKey,
        )
        .toArray()[0];
      if (existing !== undefined) {
        this.#renewLease(state, now);
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordPageResult>(
          state,
          existing.receipt_json === receiptJson
            ? {
                status: 'duplicate',
                generation,
                pass: receipt.binding.pass,
                hasNextPage: receipt.page.hasNextPage,
              }
            : { status: 'conflict' },
        );
      }
      if (
        state.phase !== 'enumerating'
        || state.currentPass === null
        || receipt.binding.pass !== state.currentPass
        || receipt.binding.cursor !== state.currentCursor
      ) {
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordPageResult>(
          state,
          { status: 'conflict' },
        );
      }

      const pass = this.#loadPass(
        generation,
        state.restartCount,
        state.currentPass,
      );
      const revisionJson = canonicalControlRevisionJson(receipt);
      if (
        pass !== undefined
        && (
          pass.total_count !== receipt.page.totalCount
          || pass.repository_state !== receipt.repository.state
          || pass.repository_full_name !== receipt.repository.fullName
          || pass.control_revision_json !== revisionJson
        )
      ) {
        return this.#restartEnumeration(
          state,
          now,
          'pagination-drift',
        );
      }
      if (pass === undefined) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO repository_fanout_passes (
             generation,
             restart_count,
             scan_pass,
             total_count,
             repository_state,
             repository_full_name,
             control_revision_json,
             page_count,
             complete
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
          generation,
          state.restartCount,
          state.currentPass,
          receipt.page.totalCount,
          receipt.repository.state,
          receipt.repository.fullName,
          revisionJson,
        );
      }

      const nextPageCount = state.pageCount + 1;
      if (
        nextPageCount > STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PAGES
        || (
          nextPageCount === STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PAGES
          && receipt.page.hasNextPage
        )
      ) {
        return this.#abortEnumeration(
          state,
          'pagination-limit',
        );
      }
      if (
        receipt.page.endCursor !== null
        && this.#cursorWasVisited(
          generation,
          state.restartCount,
          state.currentPass,
          receipt.page.endCursor,
        )
      ) {
        return this.#restartEnumeration(
          state,
          now,
          'pagination-conflict',
        );
      }

      this.#ctx.storage.sql.exec(
        `INSERT INTO repository_fanout_pages (
           generation,
           restart_count,
           scan_pass,
           cursor_key,
           page_ordinal,
           receipt_json,
           next_cursor,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        generation,
        state.restartCount,
        state.currentPass,
        cursorKey,
        nextPageCount,
        receiptJson,
        receipt.page.endCursor,
        now,
      );
      for (const target of targetDeliveries) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO repository_fanout_members (
             generation,
             restart_count,
             scan_pass,
             pull_number
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(generation, restart_count, scan_pass, pull_number)
           DO NOTHING`,
          generation,
          state.restartCount,
          state.currentPass,
          target.pullRequestNumber,
        );
        this.#ctx.storage.sql.exec(
          `INSERT INTO repository_fanout_targets (
             generation,
             pull_number,
             delivery_id,
             state,
             discovered_at,
             confirmed_at
           ) VALUES (?, ?, ?, 'pending', ?, NULL)
           ON CONFLICT(generation, pull_number) DO NOTHING`,
          generation,
          target.pullRequestNumber,
          target.deliveryId,
          now,
        );
      }
      this.#ctx.storage.sql.exec(
        `UPDATE repository_fanout_passes
         SET page_count = ?
         WHERE generation = ?
           AND restart_count = ?
           AND scan_pass = ?`,
        nextPageCount,
        generation,
        state.restartCount,
        state.currentPass,
      );
      state.pageCount = nextPageCount;
      this.#renewLease(state, now);

      if (receipt.page.hasNextPage) {
        state.currentCursor = receipt.page.endCursor;
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordPageResult>(
          state,
          {
            status: 'accepted',
            generation,
            pass: state.currentPass,
            hasNextPage: true,
          },
        );
      }

      const memberCount = this.#memberCount(
        generation,
        state.restartCount,
        state.currentPass,
      );
      if (memberCount !== receipt.page.totalCount) {
        return this.#restartEnumeration(
          state,
          now,
          'pagination-drift',
        );
      }
      this.#ctx.storage.sql.exec(
        `UPDATE repository_fanout_passes
         SET complete = 1
         WHERE generation = ?
           AND restart_count = ?
           AND scan_pass = ?`,
        generation,
        state.restartCount,
        state.currentPass,
      );
      if (state.currentPass === 1) {
        state.currentPass = 2;
        state.currentCursor = null;
        state.pageCount = 0;
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordPageResult>(
          state,
          {
            status: 'pass-complete',
            generation,
            nextPass: 2,
          },
        );
      }

      if (!this.#passesMatch(generation, state.restartCount)) {
        return this.#restartEnumeration(
          state,
          now,
          'pagination-drift',
        );
      }
      const targetCount = this.#targetCount(generation);
      state.phase = 'dispatch';
      state.currentPass = null;
      state.currentCursor = null;
      state.pageCount = 0;
      state.targetCount = targetCount;
      state.completedTargetCount = 0;
      state.failureCode = null;
      this.#writeState(state);
      return resultMutation<RepositoryFanoutRecordPageResult>(
        state,
        {
          status: 'dispatch-ready',
          generation,
          targetCount,
        },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async nextDispatchBatch(
    generationValue: number,
    leaseTokenValue: string,
    limitValue = 100,
  ): Promise<RepositoryFanoutNextDispatchBatchResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const limit = assertRepositoryFanoutDispatchBatchSize(limitValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutNextDispatchBatchResult>(state);
      }
      if (state.phase !== 'dispatch') {
        this.#writeState(state);
        return resultMutation<RepositoryFanoutNextDispatchBatchResult>(
          state,
          { status: 'not-ready' },
        );
      }
      const targets = this.#ctx.storage.sql
        .exec<TargetRow>(
          `SELECT pull_number, delivery_id, state
           FROM repository_fanout_targets
           WHERE generation = ? AND state = 'pending'
           ORDER BY pull_number
           LIMIT ?`,
          generation,
          limit,
        )
        .toArray();
      const pendingCount = this.#pendingTargetCount(generation);
      const confirmedPass = this.#loadPass(
        generation,
        state.restartCount,
        2,
      );
      if (confirmedPass === undefined || confirmedPass.complete !== 1) {
        throw new Error(
          'Dispatch phase is missing its confirmed repository fan-out pass.',
        );
      }
      this.#renewLease(state, now);
      this.#writeState(state);
      return resultMutation<RepositoryFanoutNextDispatchBatchResult>(
        state,
        {
          status: 'batch',
          generation,
          repositoryFullName: confirmedPass.repository_full_name,
          targets: targets.map((target) => ({
            pullRequestNumber: target.pull_number,
            deliveryId: target.delivery_id,
          })),
          remaining: Math.max(0, pendingCount - targets.length),
        },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordQueueConfirmed(
    generationValue: number,
    leaseTokenValue: string,
    confirmationsValue: unknown,
  ): Promise<RepositoryFanoutRecordQueueConfirmedResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const confirmations =
      parseRepositoryFanoutQueueConfirmations(confirmationsValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutRecordQueueConfirmedResult>(state);
      }
      if (state.phase !== 'dispatch') {
        this.#writeState(state);
        return resultMutation<RepositoryFanoutRecordQueueConfirmedResult>(
          state,
          { status: 'conflict' },
        );
      }

      let newlyConfirmed = 0;
      for (const confirmation of confirmations.confirmations) {
        const target = this.#ctx.storage.sql
          .exec<TargetRow>(
            `SELECT pull_number, delivery_id, state
             FROM repository_fanout_targets
             WHERE generation = ? AND pull_number = ?`,
            generation,
            confirmation.pullRequestNumber,
          )
          .toArray()[0];
        if (
          target === undefined
          || target.delivery_id !== confirmation.deliveryId
          || (target.state !== 'pending' && target.state !== 'confirmed')
        ) {
          this.#writeState(state);
          return resultMutation<RepositoryFanoutRecordQueueConfirmedResult>(
            state,
            { status: 'conflict' },
          );
        }
        if (target.state === 'pending') newlyConfirmed += 1;
      }
      for (const confirmation of confirmations.confirmations) {
        this.#ctx.storage.sql.exec(
          `UPDATE repository_fanout_targets
           SET state = 'confirmed',
               confirmed_at = COALESCE(confirmed_at, ?)
           WHERE generation = ?
             AND pull_number = ?
             AND delivery_id = ?`,
          now,
          generation,
          confirmation.pullRequestNumber,
          confirmation.deliveryId,
        );
      }
      const remaining = this.#pendingTargetCount(generation);
      state.completedTargetCount = state.targetCount - remaining;
      this.#renewLease(state, now);
      this.#writeState(state);
      return resultMutation<RepositoryFanoutRecordQueueConfirmedResult>(
        state,
        {
          status: 'recorded',
          generation,
          newlyConfirmed,
          remaining,
        },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async complete(
    generationValue: number,
    leaseTokenValue: string,
  ): Promise<RepositoryFanoutCompleteResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutCompleteResult>(state);
      }
      if (
        state.phase !== 'dispatch'
        || this.#pendingTargetCount(generation) !== 0
      ) {
        this.#writeState(state);
        return resultMutation<RepositoryFanoutCompleteResult>(
          state,
          { status: 'not-ready' },
        );
      }

      this.#ctx.storage.sql.exec(
        `UPDATE repository_fanout_deliveries
         SET status = 'completed',
             completed_at = ?,
             covered_generation = NULL
         WHERE status = 'pending'
           AND covered_generation = ?
           AND delivery_id = ?`,
        now,
        generation,
        requireSelectedDeliveryId(state),
      );
      const pendingDeliveryCount = this.#pendingDeliveryCount();
      const needsFollowup = state.dirty || pendingDeliveryCount > 0;
      state.phase = needsFollowup ? 'followup' : 'idle';
      state.dirty = needsFollowup;
      state.failureCode = null;
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      state.selectedDeliveryId = null;
      state.selectedScopeJson = null;
      state.currentPass = null;
      state.currentCursor = null;
      state.pageCount = 0;
      state.completedTargetCount = state.targetCount;
      this.#writeState(state);
      this.#pruneCompletedDeliveries(now);
      this.#clearScanState();
      return resultMutation<RepositoryFanoutCompleteResult>(
        state,
        {
          status: needsFollowup ? 'followup' : 'completed',
          generation,
        },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async fail(
    generationValue: number,
    leaseTokenValue: string,
    failureCodeValue: RepositoryFanoutFailureCode,
  ): Promise<RepositoryFanoutFailResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const failureCode = assertRepositoryFanoutFailureCode(failureCodeValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutFailResult>(state);
      }
      state.failureCode = failureCode;
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      this.#writeState(state);
      return resultMutation<RepositoryFanoutFailResult>(
        state,
        { status: 'resumable', generation },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async releaseForContinuation(
    generationValue: number,
    leaseTokenValue: string,
  ): Promise<RepositoryFanoutReleaseForContinuationResult> {
    const generation = assertRepositoryFanoutGeneration(generationValue);
    const leaseToken = assertRepositoryFanoutLeaseToken(leaseTokenValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<RepositoryFanoutReleaseForContinuationResult>(
          state,
        );
      }
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      this.#writeState(state);
      return resultMutation<RepositoryFanoutReleaseForContinuationResult>(
        state,
        { status: 'released', generation },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async alarm(): Promise<void> {
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      this.#writeState(state);
      return { alarmAt: this.#alarmAt(state), result: undefined };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
  }

  async snapshot(): Promise<RepositoryFanoutSnapshot> {
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      this.#writeState(state);
      const active = state.phase === 'enumerating' || state.phase === 'dispatch';
      const targetCount = active
        ? this.#targetCount(state.generation)
        : state.targetCount;
      const confirmedTargetCount = active
        ? targetCount - this.#pendingTargetCount(state.generation)
        : state.completedTargetCount;
      return resultMutation<RepositoryFanoutSnapshot>(
        state,
        {
          schemaVersion: repositoryFanoutSchemaVersion,
          repositoryId: state.repositoryId,
          generation: state.generation,
          phase: state.phase,
          dirty: state.dirty,
          lease: state.leaseToken === null
            ? null
            : {
                generation: state.generation,
                expiresAt: requireLeaseExpiry(state),
              },
          pass: state.currentPass,
          cursorPresent: state.currentCursor !== null,
          pageCount: state.pageCount,
          restartCount: state.restartCount,
          pendingDeliveryCount: this.#pendingDeliveryCount(),
          completedDeliveryCount: this.#completedDeliveryCount(),
          targetCount,
          confirmedTargetCount,
          failureCode: state.failureCode,
        },
      );
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  #initializeSchema(): void {
    this.#ctx.storage.transactionSync(() => {
      const sql = this.#ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);
      const version = sql
        .exec<SchemaVersionRow>(
          `SELECT version
           FROM repository_fanout_schema
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (
        version !== undefined
        && version.version !== repositoryFanoutSchemaVersion
      ) {
        throw new Error(
          `Unsupported repository fan-out schema version ${version.version}.`,
        );
      }
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          repository_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          phase TEXT NOT NULL
            CHECK (phase IN ('idle', 'enumerating', 'dispatch', 'followup')),
          dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
          selected_delivery_id TEXT,
          selected_scope_json TEXT,
          current_pass INTEGER CHECK (current_pass IN (1, 2)),
          current_cursor TEXT,
          page_count INTEGER NOT NULL,
          restart_count INTEGER NOT NULL,
          lease_token TEXT,
          lease_expires_at INTEGER,
          lease_duration_ms INTEGER,
          failure_code TEXT,
          target_count INTEGER NOT NULL,
          completed_target_count INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_deliveries (
          delivery_id TEXT PRIMARY KEY,
          scope_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          accepted_at INTEGER NOT NULL,
          completed_at INTEGER,
          covered_generation INTEGER
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS repository_fanout_deliveries_status
        ON repository_fanout_deliveries (status, completed_at, accepted_at)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_passes (
          generation INTEGER NOT NULL,
          restart_count INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          total_count INTEGER NOT NULL,
          repository_state TEXT NOT NULL
            CHECK (repository_state IN ('live', 'absent')),
          repository_full_name TEXT,
          control_revision_json TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          PRIMARY KEY (generation, restart_count, scan_pass)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_pages (
          generation INTEGER NOT NULL,
          restart_count INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          cursor_key TEXT NOT NULL,
          page_ordinal INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          next_cursor TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (
            generation,
            restart_count,
            scan_pass,
            cursor_key
          ),
          UNIQUE (generation, restart_count, scan_pass, page_ordinal)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_members (
          generation INTEGER NOT NULL,
          restart_count INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          pull_number INTEGER NOT NULL,
          PRIMARY KEY (
            generation,
            restart_count,
            scan_pass,
            pull_number
          )
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repository_fanout_targets (
          generation INTEGER NOT NULL,
          pull_number INTEGER NOT NULL,
          delivery_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed')),
          discovered_at INTEGER NOT NULL,
          confirmed_at INTEGER,
          PRIMARY KEY (generation, pull_number),
          UNIQUE (delivery_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS repository_fanout_targets_pending
        ON repository_fanout_targets (generation, state, pull_number)
      `);
      if (version === undefined) {
        sql.exec(
          `INSERT INTO repository_fanout_schema (singleton, version)
           VALUES (1, ?)`,
          repositoryFanoutSchemaVersion,
        );
      }
      const existing = sql
        .exec<FanoutStateRow>(
          `SELECT *
           FROM repository_fanout_state
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (existing === undefined) {
        this.#writeState({
          completedTargetCount: 0,
          currentCursor: null,
          currentPass: null,
          dirty: false,
          failureCode: null,
          generation: 0,
          leaseDurationMs: null,
          leaseExpiresAt: null,
          leaseToken: null,
          pageCount: 0,
          phase: 'idle',
          repositoryId: this.#repositoryId,
          restartCount: 0,
          selectedDeliveryId: null,
          selectedScopeJson: null,
          targetCount: 0,
        });
      } else if (existing.repository_id !== this.#repositoryId) {
        throw new Error(
          'Durable Object name does not match persisted repository subject.',
        );
      } else {
        const state = toMutableState(existing);
        this.#expireLeaseIfNeeded(state, Date.now());
        this.#writeState(state);
      }
    });
  }

  #loadState(): MutableFanoutState {
    const row = this.#ctx.storage.sql
      .exec<FanoutStateRow>(
        `SELECT *
         FROM repository_fanout_state
         WHERE singleton = 1`,
      )
      .one();
    return toMutableState(row);
  }

  #writeState(state: MutableFanoutState): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO repository_fanout_state (
         singleton,
         repository_id,
         generation,
         phase,
         dirty,
         selected_delivery_id,
         selected_scope_json,
         current_pass,
         current_cursor,
         page_count,
         restart_count,
         lease_token,
         lease_expires_at,
         lease_duration_ms,
         failure_code,
         target_count,
         completed_target_count
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         repository_id = excluded.repository_id,
         generation = excluded.generation,
         phase = excluded.phase,
         dirty = excluded.dirty,
         selected_delivery_id = excluded.selected_delivery_id,
         selected_scope_json = excluded.selected_scope_json,
         current_pass = excluded.current_pass,
         current_cursor = excluded.current_cursor,
         page_count = excluded.page_count,
         restart_count = excluded.restart_count,
         lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at,
         lease_duration_ms = excluded.lease_duration_ms,
         failure_code = excluded.failure_code,
         target_count = excluded.target_count,
         completed_target_count = excluded.completed_target_count`,
      state.repositoryId,
      state.generation,
      state.phase,
      state.dirty ? 1 : 0,
      state.selectedDeliveryId,
      state.selectedScopeJson,
      state.currentPass,
      state.currentCursor,
      state.pageCount,
      state.restartCount,
      state.leaseToken,
      state.leaseExpiresAt,
      state.leaseDurationMs,
      state.failureCode,
      state.targetCount,
      state.completedTargetCount,
    );
  }

  #loadDelivery(deliveryId: string): DeliveryRow | undefined {
    return this.#ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT *
         FROM repository_fanout_deliveries
         WHERE delivery_id = ?`,
        deliveryId,
      )
      .toArray()[0];
  }

  #oldestPendingDelivery(): DeliveryRow | undefined {
    return this.#ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT *
         FROM repository_fanout_deliveries
         WHERE status = 'pending'
         ORDER BY accepted_at, delivery_id
         LIMIT 1`,
      )
      .toArray()[0];
  }

  #appendPendingDelivery(
    state: MutableFanoutState,
    deliveryId: string,
    scopeJson: string,
    now: number,
  ): void {
    if (
      this.#pendingDeliveryCount()
      >= repositoryFanoutPendingDeliveryRetentionLimit
    ) {
      const evictable = this.#ctx.storage.sql
        .exec<{ delivery_id: string }>(
          `SELECT delivery_id
           FROM repository_fanout_deliveries
           WHERE status = 'pending'
             AND delivery_id <> COALESCE(?, '')
           ORDER BY accepted_at, delivery_id
           LIMIT 1`,
          state.selectedDeliveryId,
        )
        .toArray()[0];
      if (evictable === undefined) {
        throw new Error(
          'Repository fan-out pending delivery retention is exhausted.',
        );
      }
      this.#ctx.storage.sql.exec(
        `DELETE FROM repository_fanout_deliveries
         WHERE delivery_id = ?`,
        evictable.delivery_id,
      );
      state.dirty = true;
    }
    this.#ctx.storage.sql.exec(
      `INSERT INTO repository_fanout_deliveries (
         delivery_id,
         scope_json,
         status,
         accepted_at,
         completed_at,
         covered_generation
       ) VALUES (?, ?, 'pending', ?, NULL, NULL)`,
      deliveryId,
      scopeJson,
      now,
    );
  }

  #pruneCompletedDeliveries(now: number): void {
    const cutoff = Math.max(
      0,
      now - repositoryFanoutCompletedDeliveryRetentionMs,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM repository_fanout_deliveries
       WHERE status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at < ?`,
      cutoff,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM repository_fanout_deliveries
       WHERE delivery_id IN (
         SELECT delivery_id
         FROM repository_fanout_deliveries
         WHERE status = 'completed'
         ORDER BY completed_at DESC, delivery_id DESC
         LIMIT -1 OFFSET ?
       )`,
      repositoryFanoutCompletedDeliveryRetentionLimit,
    );
  }

  #pendingDeliveryCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_deliveries
         WHERE status = 'pending'`,
      )
      .one().count;
  }

  #completedDeliveryCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_deliveries
         WHERE status = 'completed'`,
      )
      .one().count;
  }

  #loadPass(
    generation: number,
    restartCount: number,
    scanPass: 1 | 2,
  ): PassRow | undefined {
    return this.#ctx.storage.sql
      .exec<PassRow>(
        `SELECT
           total_count,
           repository_state,
           repository_full_name,
           control_revision_json,
           page_count,
           complete
         FROM repository_fanout_passes
         WHERE generation = ?
           AND restart_count = ?
           AND scan_pass = ?`,
        generation,
        restartCount,
        scanPass,
      )
      .toArray()[0];
  }

  #cursorWasVisited(
    generation: number,
    restartCount: number,
    scanPass: 1 | 2,
    cursor: string,
  ): boolean {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_pages
         WHERE generation = ?
           AND restart_count = ?
           AND scan_pass = ?
           AND cursor_key = ?`,
        generation,
        restartCount,
        scanPass,
        cursor,
      )
      .one().count > 0;
  }

  #memberCount(
    generation: number,
    restartCount: number,
    scanPass: 1 | 2,
  ): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_members
         WHERE generation = ?
           AND restart_count = ?
           AND scan_pass = ?`,
        generation,
        restartCount,
        scanPass,
      )
      .one().count;
  }

  #targetCount(generation: number): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_targets
         WHERE generation = ?`,
        generation,
      )
      .one().count;
  }

  #pendingTargetCount(generation: number): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM repository_fanout_targets
         WHERE generation = ? AND state = 'pending'`,
        generation,
      )
      .one().count;
  }

  #passesMatch(generation: number, restartCount: number): boolean {
    const first = this.#loadPass(generation, restartCount, 1);
    const second = this.#loadPass(generation, restartCount, 2);
    if (
      first === undefined
      || second === undefined
      || first.complete !== 1
      || second.complete !== 1
      || first.total_count !== second.total_count
      || first.repository_state !== second.repository_state
      || first.repository_full_name !== second.repository_full_name
      || first.control_revision_json !== second.control_revision_json
    ) {
      return false;
    }
    const firstOnly = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT pull_number
           FROM repository_fanout_members
           WHERE generation = ?
             AND restart_count = ?
             AND scan_pass = 1
           EXCEPT
           SELECT pull_number
           FROM repository_fanout_members
           WHERE generation = ?
             AND restart_count = ?
             AND scan_pass = 2
         )`,
        generation,
        restartCount,
        generation,
        restartCount,
      )
      .one().count;
    if (firstOnly !== 0) return false;
    const secondOnly = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT pull_number
           FROM repository_fanout_members
           WHERE generation = ?
             AND restart_count = ?
             AND scan_pass = 2
           EXCEPT
           SELECT pull_number
           FROM repository_fanout_members
           WHERE generation = ?
             AND restart_count = ?
             AND scan_pass = 1
         )`,
        generation,
        restartCount,
        generation,
        restartCount,
      )
      .one().count;
    return secondOnly === 0;
  }

  #restartEnumeration(
    state: MutableFanoutState,
    now: number,
    reason: 'pagination-conflict' | 'pagination-drift',
  ): CoordinatorMutation<RepositoryFanoutRecordPageResult> {
    if (state.restartCount >= repositoryFanoutMaximumDriftRestarts) {
      return this.#abortEnumeration(state, reason);
    }
    state.restartCount += 1;
    state.currentPass = 1;
    state.currentCursor = null;
    state.pageCount = 0;
    state.failureCode = reason;
    state.targetCount = 0;
    state.completedTargetCount = 0;
    this.#deleteGenerationScan(state.generation);
    this.#renewLease(state, now);
    this.#writeState(state);
    return resultMutation<RepositoryFanoutRecordPageResult>(
      state,
      {
        status: 'restarted',
        generation: state.generation,
        restartCount: state.restartCount,
        reason,
      },
    );
  }

  #abortEnumeration(
    state: MutableFanoutState,
    reason:
      | 'pagination-conflict'
      | 'pagination-drift'
      | 'pagination-limit',
  ): CoordinatorMutation<RepositoryFanoutRecordPageResult> {
    this.#ctx.storage.sql.exec(
      `UPDATE repository_fanout_deliveries
       SET covered_generation = NULL
       WHERE status = 'pending' AND covered_generation = ?`,
      state.generation,
    );
    this.#deleteGenerationScan(state.generation);
    state.phase = 'followup';
    state.dirty = true;
    state.failureCode = reason;
    state.leaseToken = null;
    state.leaseExpiresAt = null;
    state.leaseDurationMs = null;
    state.selectedDeliveryId = null;
    state.selectedScopeJson = null;
    state.currentPass = null;
    state.currentCursor = null;
    state.pageCount = 0;
    state.targetCount = 0;
    state.completedTargetCount = 0;
    this.#writeState(state);
    return resultMutation<RepositoryFanoutRecordPageResult>(
      state,
      {
        status: 'drift-limit',
        generation: state.generation,
        reason,
      },
    );
  }

  #clearScanState(): void {
    this.#ctx.storage.sql.exec('DELETE FROM repository_fanout_targets');
    this.#ctx.storage.sql.exec('DELETE FROM repository_fanout_members');
    this.#ctx.storage.sql.exec('DELETE FROM repository_fanout_pages');
    this.#ctx.storage.sql.exec('DELETE FROM repository_fanout_passes');
  }

  #deleteGenerationScan(generation: number): void {
    this.#ctx.storage.sql.exec(
      'DELETE FROM repository_fanout_targets WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM repository_fanout_members WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM repository_fanout_pages WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM repository_fanout_passes WHERE generation = ?',
      generation,
    );
  }

  #selectedScopeItem(
    state: MutableFanoutState,
  ): RepositoryFanoutInput {
    if (state.selectedScopeJson === null) {
      throw new Error('Active repository fan-out is missing its scope item.');
    }
    return parseStoredRepositoryFanoutInput(state.selectedScopeJson);
  }

  #grantLease(
    state: MutableFanoutState,
    duration: number,
    now: number,
  ): void {
    state.leaseDurationMs = duration;
    state.leaseToken = crypto.randomUUID();
    state.leaseExpiresAt = addDuration(now, duration);
  }

  #renewLease(state: MutableFanoutState, now: number): void {
    if (
      state.leaseToken === null
      || state.leaseDurationMs === null
    ) {
      throw new Error('Cannot renew an absent repository fan-out lease.');
    }
    state.leaseExpiresAt = addDuration(now, state.leaseDurationMs);
  }

  #matchesLease(
    state: MutableFanoutState,
    generation: number,
    leaseToken: string,
  ): boolean {
    return (
      state.generation === generation
      && state.leaseToken === leaseToken
      && state.leaseExpiresAt !== null
    );
  }

  #expireLeaseIfNeeded(state: MutableFanoutState, now: number): boolean {
    if (
      state.leaseToken === null
      || state.leaseExpiresAt === null
      || state.leaseExpiresAt > now
    ) {
      return false;
    }
    state.leaseToken = null;
    state.leaseExpiresAt = null;
    state.leaseDurationMs = null;
    state.failureCode = 'lease-expired';
    return true;
  }

  #alarmAt(state: MutableFanoutState): number | null {
    return state.leaseToken === null ? null : state.leaseExpiresAt;
  }

  async #scheduleAlarm(alarmAt: number | null): Promise<void> {
    if (alarmAt !== null) {
      await this.#ctx.storage.setAlarm(alarmAt);
    }
  }
}

function toMutableState(row: FanoutStateRow): MutableFanoutState {
  return {
    completedTargetCount: nonNegativeInteger(
      row.completed_target_count,
      'completed_target_count',
    ),
    currentCursor: row.current_cursor,
    currentPass: nullablePass(row.current_pass),
    dirty: booleanInteger(row.dirty, 'dirty'),
    failureCode: nullableFailureCode(row.failure_code),
    generation: nonNegativeInteger(row.generation, 'generation'),
    leaseDurationMs: nullableNonNegativeInteger(
      row.lease_duration_ms,
      'lease_duration_ms',
    ),
    leaseExpiresAt: nullableNonNegativeInteger(
      row.lease_expires_at,
      'lease_expires_at',
    ),
    leaseToken: row.lease_token,
    pageCount: nonNegativeInteger(row.page_count, 'page_count'),
    phase: fanoutPhase(row.phase),
    repositoryId: row.repository_id,
    restartCount: nonNegativeInteger(row.restart_count, 'restart_count'),
    selectedDeliveryId: row.selected_delivery_id,
    selectedScopeJson: row.selected_scope_json,
    targetCount: nonNegativeInteger(row.target_count, 'target_count'),
  };
}

function fanoutPhase(value: string): RepositoryFanoutPhase {
  if (
    value !== 'idle'
    && value !== 'enumerating'
    && value !== 'dispatch'
    && value !== 'followup'
  ) {
    throw new Error(`Unsupported repository fan-out phase ${value}.`);
  }
  return value;
}

function nullablePass(value: number | null): 1 | 2 | null {
  if (value === null) return null;
  if (value !== 1 && value !== 2) {
    throw new Error(`Unsupported repository fan-out pass ${value}.`);
  }
  return value;
}

function nullableFailureCode(
  value: string | null,
): RepositoryFanoutFailureCode | null {
  if (value === null) return null;
  return assertRepositoryFanoutFailureCode(
    value as RepositoryFanoutFailureCode,
  );
}

function booleanInteger(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`${field} must be stored as 0 or 1.`);
  }
  return value === 1;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableNonNegativeInteger(
  value: number | null,
  field: string,
): number | null {
  return value === null ? null : nonNegativeInteger(value, field);
}

async function parseRepositoryFanoutInput(
  value: unknown,
): Promise<RepositoryFanoutInput> {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).operation
      === 'installation-repository-fanout'
  ) {
    return await parseStewardRuntimeInstallationRepositoryChildV1(value);
  }
  const scopeItem = parseStewardRuntimeScopeWorkItem(value);
  if (scopeItem.target.scope !== 'repository') {
    throw new TypeError(
      'RepositoryFanoutCoordinator only accepts repository scope work items '
      + 'or installation repository children.',
    );
  }
  return scopeItem as RepositoryFanoutScopeWorkItem;
}

async function canonicalRepositoryFanoutInputJson(
  value: RepositoryFanoutInput,
): Promise<string> {
  return value.operation === 'installation-repository-fanout'
    ? await canonicalStewardRuntimeInstallationRepositoryChildV1Json(value)
    : canonicalStewardRuntimeScopeWorkItemJson(value);
}

function repositoryFanoutInputDeliveryId(
  value: RepositoryFanoutInput,
): string {
  return value.operation === 'installation-repository-fanout'
    ? value.deliveryId
    : value.cause.deliveryId;
}

function repositoryFanoutInputRepositoryId(
  value: RepositoryFanoutInput,
): number {
  return value.operation === 'installation-repository-fanout'
    ? value.repositoryId
    : value.target.repositoryId;
}

function parseStoredRepositoryFanoutInput(
  value: string,
): RepositoryFanoutInput {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).operation
        === 'installation-repository-fanout'
    ) {
      const child = parsed as Partial<StewardRuntimeInstallationRepositoryChildV1>;
      if (
        child.schemaVersion !== 1
        || !Number.isSafeInteger(child.repositoryId)
        || Number(child.repositoryId) <= 0
        || typeof child.deliveryId !== 'string'
        || !/^installation-fanout-v1:[0-9a-f]{64}:[1-9]\d*:[1-9]\d*$/
          .test(child.deliveryId)
      ) {
        throw new Error('stored installation child is invalid');
      }
      return parsed as StewardRuntimeInstallationRepositoryChildV1;
    }
    const scopeItem = parseStewardRuntimeScopeWorkItem(parsed);
    if (scopeItem.target.scope !== 'repository') {
      throw new Error('scope target is not repository');
    }
    return scopeItem as RepositoryFanoutScopeWorkItem;
  } catch {
    throw new Error('Persisted repository fan-out input is invalid.');
  }
}

function canonicalControlRevisionJson(
  receipt: StewardRuntimeRepositoryFanoutPageReceiptAny,
): string {
  return JSON.stringify({
    stewardCommit: receipt.controlRevision.stewardCommit,
    workerVersionId: receipt.controlRevision.workerVersionId,
    workerVersionTag: receipt.controlRevision.workerVersionTag,
    workerVersionCreatedAt: receipt.controlRevision.workerVersionCreatedAt,
  });
}

function requireLeaseToken(state: MutableFanoutState): string {
  if (state.leaseToken === null) {
    throw new Error('Repository fan-out lease token is absent.');
  }
  return state.leaseToken;
}

function requireSelectedDeliveryId(state: MutableFanoutState): string {
  if (state.selectedDeliveryId === null) {
    throw new Error('Active repository fan-out has no selected delivery.');
  }
  return state.selectedDeliveryId;
}

function requireLeaseExpiry(state: MutableFanoutState): number {
  if (state.leaseExpiresAt === null) {
    throw new Error('Repository fan-out lease expiry is absent.');
  }
  return state.leaseExpiresAt;
}

function nextGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('Repository fan-out generation is invalid.');
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error('Repository fan-out generation is exhausted.');
  }
  return next;
}

function addDuration(now: number, duration: number): number {
  const expiresAt = now + duration;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Repository fan-out lease expiry is out of range.');
  }
  return expiresAt;
}

function resultMutation<T>(
  state: MutableFanoutState,
  result: T,
): CoordinatorMutation<T> {
  return {
    alarmAt: state.leaseToken === null ? null : state.leaseExpiresAt,
    result,
  };
}

function staleMutation<T extends { readonly status: string }>(
  state: MutableFanoutState,
): CoordinatorMutation<T> {
  return resultMutation(
    state,
    { status: 'stale' } as T,
  );
}
