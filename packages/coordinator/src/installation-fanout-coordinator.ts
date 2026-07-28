import { DurableObject } from 'cloudflare:workers';
import {
  STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES,
  buildStewardRuntimeInstallationFanoutDeliveryId,
  canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json,
  canonicalStewardRuntimeInstallationFanoutRootV1Json,
  deriveStewardRuntimeInstallationFanoutRootDigest,
  parseStewardRuntimeInstallationFanoutPageReceiptV1,
  parseStewardRuntimeInstallationFanoutRootV1,
  type StewardRuntimeInstallationFanoutPageReceiptV1,
  type StewardRuntimeInstallationFanoutRootV1,
  type StewardRuntimeInstallationFanoutStateV1,
} from '../../core/src/runtime-installation-fanout.js';
import {
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json,
  deriveStewardRuntimeInstallationIndexBootstrapDigest,
  deriveStewardRuntimeInstallationRepositoryIndexDigest,
  parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1,
  type StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  type StewardRuntimeInstallationIndexBootstrapStatusReceiptV1,
} from '../../core/src/runtime-installation-index-bootstrap.js';
import {
  assertInstallationFanoutDispatchBatchSize,
  assertInstallationFanoutFailureCode,
  assertInstallationFanoutGeneration,
  assertInstallationFanoutLeaseDurationMs,
  assertInstallationFanoutLeaseToken,
  installationFanoutCompletedDeliveryRetentionLimit,
  installationFanoutCompletedDeliveryRetentionMs,
  installationFanoutPendingDeliveryRetentionLimit,
  installationFanoutSchemaVersion,
  parseInstallationFanoutCoordinatorName,
  parseInstallationFanoutQueueConfirmations,
  type InstallationFanoutClaimResult,
  type InstallationFanoutCompleteResult,
  type InstallationFanoutFailResult,
  type InstallationFanoutFailureCode,
  type InstallationFanoutNextDispatchBatchResult,
  type InstallationFanoutPhase,
  type InstallationFanoutRecordPageResult,
  type InstallationFanoutRecordQueueConfirmedResult,
  type InstallationFanoutReleaseForContinuationResult,
  type InstallationFanoutSnapshot,
  type InstallationFanoutTargetSource,
  type InstallationIndexBootstrapClaimResult,
  type InstallationIndexBootstrapFailResult,
  type InstallationIndexBootstrapFailureCode,
  type InstallationIndexBootstrapFinalizeResult,
  type InstallationIndexBootstrapRecordPageResult,
  type InstallationIndexBootstrapReleaseResult,
} from './installation-fanout-contracts.js';

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

interface InstallationFanoutDurableObjectState {
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
  installation_id: string;
  installation_state: string | null;
  lease_duration_ms: number | null;
  lease_expires_at: number | null;
  lease_token: string | null;
  page_count: number;
  phase: string;
  selected_delivery_id: string | null;
  selected_root_digest: string | null;
  selected_root_json: string | null;
  target_count: number;
  target_source: string | null;
}

interface DeliveryRow {
  accepted_at: number;
  completed_at: number | null;
  covered_generation: number | null;
  delivery_id: string;
  root_digest: string;
  root_json: string;
  status: string;
}

interface PageRow {
  receipt_json: string;
}

interface PassRow {
  complete: number;
  control_revision_json: string;
  installation_state: string;
  page_count: number;
  total_count: number;
}

interface TargetRow {
  delivery_id: string;
  repository_id: string;
  state: string;
}

interface LastKnownMetaRow {
  control_revision_json: string | null;
  known: number;
  repository_count: number;
  updated_at: number | null;
}

interface RepositoryIdRow {
  repository_id: string;
}

interface BootstrapCommandRow {
  request_id: string;
  command_json: string;
  command_digest: string;
  principal_client_id: string;
  status: string;
  accepted_at: number;
  updated_at: number;
  completed_at: number | null;
  failure_code: string | null;
  repository_count: number;
  index_digest: string | null;
  control_revision_json: string | null;
}

interface BootstrapStateRow {
  current_request_id: string | null;
  command_digest: string | null;
  phase: string;
  current_pass: number | null;
  current_cursor: string | null;
  page_count: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  lease_duration_ms: number | null;
}

interface BootstrapPassRow {
  total_count: number;
  control_revision_json: string;
  page_count: number;
  complete: number;
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
  failureCode: InstallationFanoutFailureCode | null;
  generation: number;
  installationId: string;
  installationState: StewardRuntimeInstallationFanoutStateV1 | null;
  leaseDurationMs: number | null;
  leaseExpiresAt: number | null;
  leaseToken: string | null;
  pageCount: number;
  phase: InstallationFanoutPhase;
  selectedDeliveryId: string | null;
  selectedRootDigest: string | null;
  selectedRootJson: string | null;
  targetCount: number;
  targetSource: InstallationFanoutTargetSource | null;
}

const cursorStartKey = '';
const rootDigestPattern = /^[0-9a-f]{64}$/;

/**
 * Installation-scoped durable state only. GitHub enumeration and Queue sends
 * remain outside this object so no network call occurs while SQLite is locked.
 */
export class InstallationFanoutCoordinator extends DurableObject {
  readonly #ctx: InstallationFanoutDurableObjectState;
  readonly #installationId: string;

  constructor(ctx: InstallationFanoutDurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;
    const objectName = ctx.id.name;
    if (objectName === undefined) {
      throw new TypeError(
        'InstallationFanoutCoordinator must be addressed with idFromName().',
      );
    }
    this.#installationId =
      parseInstallationFanoutCoordinatorName(objectName).installationId;
    this.#initializeSchema();
  }

  async claimIndexBootstrap(
    commandValue: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationIndexBootstrapClaimResult> {
    const command =
      parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(commandValue);
    const commandJson =
      canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(command);
    const commandDigest =
      await deriveStewardRuntimeInstallationIndexBootstrapDigest(command);
    const duration =
      assertInstallationFanoutLeaseDurationMs(leaseDurationMs);
    if (String(command.installationId) !== this.#installationId) {
      throw new TypeError(
        'Installation index bootstrap does not match the Durable Object.',
      );
    }

    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      const existing = this.#loadBootstrapCommand(command.requestId);
      if (
        existing !== undefined
        && (
          existing.command_json !== commandJson
          || existing.command_digest !== commandDigest
          || existing.principal_client_id
            !== command.principal.accessServiceClientId
        )
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'conflict' } as const,
        };
      }
      if (
        existing !== undefined
        && (existing.status === 'completed' || existing.status === 'failed')
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'duplicate',
            receipt: this.#bootstrapStatusReceipt(existing),
          } as const,
        };
      }
      if (
        bootstrap.current_request_id !== null
        && bootstrap.current_request_id !== command.requestId
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'busy',
            expiresAt: bootstrap.lease_expires_at,
          } as const,
        };
      }
      if (bootstrap.lease_token !== null) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'busy',
            expiresAt: bootstrap.lease_expires_at,
          } as const,
        };
      }

      const fanout = this.#loadState();
      this.#expireLeaseIfNeeded(fanout, now);
      if (
        fanout.phase !== 'idle'
        || this.#pendingDeliveryCount() > 0
      ) {
        this.#writeState(fanout);
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#alarmAt(fanout),
          result: {
            status: 'busy',
            expiresAt: fanout.leaseExpiresAt,
          } as const,
        };
      }
      this.#writeState(fanout);

      if (existing === undefined) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_index_bootstrap_commands (
             request_id,
             command_json,
             command_digest,
             principal_client_id,
             status,
             accepted_at,
             updated_at,
             completed_at,
             failure_code,
             repository_count,
             index_digest,
             control_revision_json
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 0, NULL, NULL)`,
          command.requestId,
          commandJson,
          commandDigest,
          command.principal.accessServiceClientId,
          now,
          now,
        );
      }
      if (bootstrap.current_request_id === null) {
        bootstrap.current_request_id = command.requestId;
        bootstrap.command_digest = commandDigest;
        bootstrap.phase = 'enumerating';
        bootstrap.current_pass = 1;
        bootstrap.current_cursor = null;
        bootstrap.page_count = 0;
      }
      if (
        bootstrap.command_digest !== commandDigest
        || bootstrap.current_request_id !== command.requestId
      ) {
        throw new Error('Persisted bootstrap identity is inconsistent.');
      }
      bootstrap.lease_token = crypto.randomUUID();
      bootstrap.lease_duration_ms = duration;
      bootstrap.lease_expires_at = now + duration;
      this.#ctx.storage.sql.exec(
        `UPDATE installation_index_bootstrap_commands
         SET status = 'running', updated_at = ?
         WHERE request_id = ? AND status IN ('pending', 'running')`,
        now,
        command.requestId,
      );
      this.#writeBootstrapState(bootstrap);
      return {
        alarmAt: this.#bootstrapAlarmAt(bootstrap),
        result: {
          status: 'claimed',
          leaseToken: bootstrap.lease_token,
          expiresAt: bootstrap.lease_expires_at,
          resumed: existing !== undefined,
          command,
          commandDigest,
          phase: bootstrap.phase as 'enumerating' | 'finalizing',
          pass: bootstrap.phase === 'enumerating'
            ? bootstrap.current_pass as 1 | 2
            : null,
          cursor: bootstrap.current_cursor,
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordIndexBootstrapPage(
    leaseTokenValue: string,
    receiptValue: unknown,
  ): Promise<InstallationIndexBootstrapRecordPageResult> {
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const receipt =
      await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
        receiptValue,
      );
    const receiptJson =
      await canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json(
        receipt,
      );
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      if (
        bootstrap.lease_token !== leaseToken
        || bootstrap.current_request_id === null
        || bootstrap.command_digest === null
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'stale' } as const,
        };
      }
      if (
        receipt.binding.command.requestId !== bootstrap.current_request_id
        || receipt.binding.commandDigest !== bootstrap.command_digest
        || receipt.binding.command.installationId
          !== Number(this.#installationId)
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'conflict' } as const,
        };
      }
      const command = this.#loadBootstrapCommand(
        bootstrap.current_request_id,
      );
      if (
        command === undefined
        || command.command_json
          !== canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
            receipt.binding.command,
          )
      ) {
        throw new Error('Persisted bootstrap command is inconsistent.');
      }
      if (
        receipt.installation.state !== 'live'
      ) {
        const failureCode = receipt.installation.state === 'suspended'
          ? 'installation-suspended'
          : 'installation-absent';
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          failureCode,
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'failed',
            receipt: result,
          } as const,
        };
      }
      if (
        canonicalControlRevisionJsonFromRevision(receipt.controlRevision)
          !== canonicalControlRevisionJsonFromRevision(
            receipt.binding.command.expectedControlRevision,
          )
      ) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'control-revision-conflict',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'failed',
            receipt: result,
          } as const,
        };
      }
      if (
        bootstrap.phase !== 'enumerating'
        || bootstrap.current_pass === null
        || receipt.binding.pass !== bootstrap.current_pass
        || receipt.binding.cursor !== bootstrap.current_cursor
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'conflict' } as const,
        };
      }

      const cursorKey = receipt.binding.cursor ?? cursorStartKey;
      const existingPage = this.#ctx.storage.sql.exec<PageRow>(
        `SELECT receipt_json
         FROM installation_index_bootstrap_pages
         WHERE request_id = ? AND scan_pass = ? AND cursor_key = ?`,
        command.request_id,
        receipt.binding.pass,
        cursorKey,
      ).toArray()[0];
      if (existingPage !== undefined) {
        this.#renewBootstrapLease(bootstrap, now);
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: existingPage.receipt_json === receiptJson
              ? {
                status: 'duplicate',
                pass: receipt.binding.pass,
                hasNextPage: receipt.page.hasNextPage,
              } as const
            : { status: 'conflict' } as const,
        };
      }

      const pass = this.#loadBootstrapPass(
        command.request_id,
        bootstrap.current_pass,
      );
      const revisionJson = canonicalControlRevisionJsonFromRevision(
        receipt.controlRevision,
      );
      if (
        pass !== undefined
        && (
          pass.total_count !== receipt.page.totalCount
          || pass.control_revision_json !== revisionJson
        )
      ) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'pagination-drift',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'failed', receipt: result } as const,
        };
      }
      if (pass === undefined) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_index_bootstrap_passes (
             request_id, scan_pass, total_count, control_revision_json,
             page_count, complete
           ) VALUES (?, ?, ?, ?, 0, 0)`,
          command.request_id,
          bootstrap.current_pass,
          receipt.page.totalCount,
          revisionJson,
        );
      }
      const nextPageCount = bootstrap.page_count + 1;
      if (
        nextPageCount > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES
        || (
          nextPageCount === STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES
          && receipt.page.hasNextPage
        )
      ) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'pagination-limit',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'failed', receipt: result } as const,
        };
      }
      if (
        receipt.page.endCursor !== null
        && this.#bootstrapCursorWasVisited(
          command.request_id,
          bootstrap.current_pass,
          receipt.page.endCursor,
        )
      ) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'pagination-conflict',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'failed', receipt: result } as const,
        };
      }
      this.#ctx.storage.sql.exec(
        `INSERT INTO installation_index_bootstrap_pages (
           request_id, scan_pass, cursor_key, page_ordinal, receipt_json,
           next_cursor, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        command.request_id,
        bootstrap.current_pass,
        cursorKey,
        nextPageCount,
        receiptJson,
        receipt.page.endCursor,
        now,
      );
      for (const repositoryId of receipt.page.repositoryIds) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_index_bootstrap_members (
             request_id, scan_pass, repository_id
           ) VALUES (?, ?, ?)
           ON CONFLICT(request_id, scan_pass, repository_id) DO NOTHING`,
          command.request_id,
          bootstrap.current_pass,
          String(repositoryId),
        );
      }
      this.#ctx.storage.sql.exec(
        `UPDATE installation_index_bootstrap_passes
         SET page_count = ?
         WHERE request_id = ? AND scan_pass = ?`,
        nextPageCount,
        command.request_id,
        bootstrap.current_pass,
      );
      bootstrap.page_count = nextPageCount;
      this.#renewBootstrapLease(bootstrap, now);
      if (receipt.page.hasNextPage) {
        bootstrap.current_cursor = receipt.page.endCursor;
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'accepted',
            pass: bootstrap.current_pass,
            hasNextPage: true,
          } as const,
        };
      }
      if (
        this.#bootstrapMemberCount(
          command.request_id,
          bootstrap.current_pass,
        ) !== receipt.page.totalCount
      ) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'pagination-drift',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'failed', receipt: result } as const,
        };
      }
      this.#ctx.storage.sql.exec(
        `UPDATE installation_index_bootstrap_passes
         SET complete = 1
         WHERE request_id = ? AND scan_pass = ?`,
        command.request_id,
        bootstrap.current_pass,
      );
      if (bootstrap.current_pass === 1) {
        bootstrap.current_pass = 2;
        bootstrap.current_cursor = null;
        bootstrap.page_count = 0;
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'pass-complete', nextPass: 2 } as const,
        };
      }
      if (!this.#bootstrapPassesMatch(command.request_id)) {
        const result = this.#failBootstrapInTransaction(
          bootstrap,
          command,
          'pagination-drift',
          now,
        );
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'failed', receipt: result } as const,
        };
      }
      bootstrap.phase = 'finalizing';
      bootstrap.current_pass = null;
      bootstrap.current_cursor = null;
      bootstrap.page_count = 0;
      this.#writeBootstrapState(bootstrap);
      return {
        alarmAt: this.#bootstrapAlarmAt(bootstrap),
        result: {
          status: 'accepted',
          pass: 2,
          hasNextPage: false,
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async finalizeIndexBootstrap(
    leaseTokenValue: string,
  ): Promise<InstallationIndexBootstrapFinalizeResult> {
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const identity = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      if (
        bootstrap.lease_token !== leaseToken
        || bootstrap.current_request_id === null
        || bootstrap.command_digest === null
      ) {
        this.#writeBootstrapState(bootstrap);
        return null;
      }
      if (bootstrap.phase !== 'finalizing') {
        this.#writeBootstrapState(bootstrap);
        return { notReady: true } as const;
      }
      this.#renewBootstrapLease(bootstrap, now);
      this.#writeBootstrapState(bootstrap);
      return {
        requestId: bootstrap.current_request_id,
        commandDigest: bootstrap.command_digest,
      };
    });
    if (identity === null) return { status: 'stale' };
    if ('notReady' in identity) return { status: 'not-ready' };
    const repositoryIds = this.#ctx.storage.sql.exec<RepositoryIdRow>(
      `SELECT repository_id
       FROM installation_index_bootstrap_members
       WHERE request_id = ? AND scan_pass = 2
       ORDER BY CAST(repository_id AS INTEGER)`,
      identity.requestId,
    ).toArray().map((row) => Number(row.repository_id));
    const indexDigest =
      await deriveStewardRuntimeInstallationRepositoryIndexDigest(
        repositoryIds,
      );
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      if (
        bootstrap.lease_token !== leaseToken
        || bootstrap.current_request_id !== identity.requestId
        || bootstrap.command_digest !== identity.commandDigest
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'stale' } as const,
        };
      }
      if (
        bootstrap.phase !== 'finalizing'
        || !this.#bootstrapPassesMatch(identity.requestId)
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'not-ready' } as const,
        };
      }
      const command = this.#loadBootstrapCommand(identity.requestId);
      const pass = this.#loadBootstrapPass(identity.requestId, 2);
      if (command === undefined || pass === undefined || pass.complete !== 1) {
        throw new Error('Persisted bootstrap finalization is inconsistent.');
      }
      const rows = this.#ctx.storage.sql.exec<RepositoryIdRow>(
        `SELECT repository_id
         FROM installation_index_bootstrap_members
         WHERE request_id = ? AND scan_pass = 2
         ORDER BY CAST(repository_id AS INTEGER)`,
        identity.requestId,
      ).toArray();
      if (
        rows.length !== repositoryIds.length
        || rows.some(
          (row, index) => Number(row.repository_id) !== repositoryIds[index],
        )
      ) {
        throw new Error('Bootstrap repository index changed during finalize.');
      }
      this.#ctx.storage.sql.exec(
        'DELETE FROM installation_fanout_last_known_repositories',
      );
      for (const repositoryId of repositoryIds) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_fanout_last_known_repositories (
             repository_id, observed_generation, observed_at
           ) VALUES (?, 0, ?)`,
          String(repositoryId),
          now,
        );
      }
      this.#ctx.storage.sql.exec(
        `UPDATE installation_fanout_last_known_meta
         SET known = 1,
             repository_count = ?,
             control_revision_json = ?,
             updated_at = ?
         WHERE singleton = 1`,
        repositoryIds.length,
        pass.control_revision_json,
        now,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE installation_index_bootstrap_commands
         SET status = 'completed',
             updated_at = ?,
             completed_at = ?,
             failure_code = NULL,
             repository_count = ?,
             index_digest = ?,
             control_revision_json = ?
         WHERE request_id = ? AND command_digest = ?`,
        now,
        now,
        repositoryIds.length,
        indexDigest,
        pass.control_revision_json,
        identity.requestId,
        identity.commandDigest,
      );
      const completed = this.#loadBootstrapCommand(identity.requestId);
      if (completed === undefined) {
        throw new Error('Completed bootstrap command is absent.');
      }
      this.#clearBootstrapActive(bootstrap);
      this.#writeBootstrapState(bootstrap);
      return {
        alarmAt: this.#bootstrapAlarmAt(bootstrap),
        result: {
          status: 'completed',
          receipt: this.#bootstrapStatusReceipt(completed),
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async releaseIndexBootstrap(
    leaseTokenValue: string,
  ): Promise<InstallationIndexBootstrapReleaseResult> {
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, Date.now());
      if (bootstrap.lease_token !== leaseToken) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'stale' } as const,
        };
      }
      bootstrap.lease_token = null;
      bootstrap.lease_expires_at = null;
      bootstrap.lease_duration_ms = null;
      this.#writeBootstrapState(bootstrap);
      return {
        alarmAt: this.#bootstrapAlarmAt(bootstrap),
        result: { status: 'released' } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async failIndexBootstrap(
    leaseTokenValue: string,
    failureCode: InstallationIndexBootstrapFailureCode,
  ): Promise<InstallationIndexBootstrapFailResult> {
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    if (
      failureCode !== 'control-revision-conflict'
      && failureCode !== 'installation-absent'
      && failureCode !== 'installation-suspended'
      && failureCode !== 'pagination-conflict'
      && failureCode !== 'pagination-drift'
      && failureCode !== 'pagination-limit'
      && failureCode !== 'runtime-error'
    ) {
      throw new TypeError('Bootstrap failure code is invalid.');
    }
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      if (
        bootstrap.lease_token !== leaseToken
        || bootstrap.current_request_id === null
      ) {
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: { status: 'stale' } as const,
        };
      }
      const command = this.#loadBootstrapCommand(
        bootstrap.current_request_id,
      );
      if (command === undefined) {
        throw new Error('Persisted bootstrap command is absent.');
      }
      const receipt = this.#failBootstrapInTransaction(
        bootstrap,
        command,
        failureCode,
        now,
      );
      return {
        alarmAt: this.#bootstrapAlarmAt(bootstrap),
        result: { status: 'failed', receipt } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async inspectIndexBootstrap(
    requestIdValue: string,
    commandDigestValue: string,
    principalClientIdValue: string,
  ): Promise<StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 | null> {
    if (
      typeof requestIdValue !== 'string'
      || typeof commandDigestValue !== 'string'
      || typeof principalClientIdValue !== 'string'
    ) {
      throw new TypeError('Bootstrap inspection identity is invalid.');
    }
    const command = this.#loadBootstrapCommand(requestIdValue);
    if (command === undefined) return null;
    if (
      command.command_digest !== commandDigestValue
      || command.principal_client_id !== principalClientIdValue
    ) {
      throw new TypeError('Bootstrap inspection identity conflicts.');
    }
    return this.#bootstrapStatusReceipt(command);
  }

  async claim(
    rootValue: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationFanoutClaimResult> {
    const root = parseStewardRuntimeInstallationFanoutRootV1(rootValue);
    const rootJson = canonicalStewardRuntimeInstallationFanoutRootV1Json(root);
    const rootDigest =
      await deriveStewardRuntimeInstallationFanoutRootDigest(root);
    const duration =
      assertInstallationFanoutLeaseDurationMs(leaseDurationMs);
    if (String(root.installationId) !== this.#installationId) {
      throw new TypeError(
        'Installation fan-out root does not match the Durable Object.',
      );
    }

    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.#pruneCompletedDeliveries(now);
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      const bootstrap = this.#loadBootstrapState();
      this.#expireBootstrapLease(bootstrap, now);
      if (bootstrap.current_request_id !== null) {
        this.#writeState(state);
        this.#writeBootstrapState(bootstrap);
        return {
          alarmAt: this.#bootstrapAlarmAt(bootstrap),
          result: {
            status: 'busy',
            generation: state.generation,
            expiresAt: bootstrap.lease_expires_at ?? now + 1_000,
          } as const,
        };
      }
      const known = this.#loadDelivery(root.deliveryId);
      if (
        known !== undefined
        && (known.root_json !== rootJson || known.root_digest !== rootDigest)
      ) {
        throw new TypeError(
          'A root delivery ID cannot identify different installation work.',
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
            root.deliveryId,
            rootJson,
            rootDigest,
            now,
          );
          state.dirty = true;
        }
        this.#writeState(state);
        return {
          alarmAt: this.#alarmAt(state),
          result: {
            status: state.selectedDeliveryId === root.deliveryId
              ? 'busy'
              : 'coalesced',
            generation: state.generation,
            expiresAt: requireLeaseExpiry(state),
          } as const,
        };
      }

      if (known === undefined) {
        this.#appendPendingDelivery(
          root.deliveryId,
          rootJson,
          rootDigest,
          now,
        );
        if (state.phase === 'followup') state.dirty = true;
      }

      if (state.phase === 'enumerating' || state.phase === 'dispatch') {
        const selected = this.#selectedRoot(state);
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
            selectedRoot: selected,
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
        if (known?.status === 'completed') {
          this.#ctx.storage.sql.exec(
            `UPDATE installation_fanout_deliveries
             SET root_json = ?,
                 root_digest = ?,
                 status = 'pending',
                 accepted_at = ?,
                 completed_at = NULL,
                 covered_generation = NULL
             WHERE delivery_id = ?`,
            rootJson,
            rootDigest,
            now,
            root.deliveryId,
          );
        } else {
          this.#appendPendingDelivery(
            root.deliveryId,
            rootJson,
            rootDigest,
            now,
          );
        }
      }

      const selected = this.#oldestPendingDelivery();
      if (selected === undefined) {
        throw new Error('Installation fan-out has no pending root to claim.');
      }
      const selectedRoot = parseStoredRoot(selected.root_json);
      const generation = nextGeneration(state.generation);
      this.#clearScanState();
      this.#ctx.storage.sql.exec(
        `UPDATE installation_fanout_deliveries
          SET covered_generation = ?
          WHERE status = 'pending' AND delivery_id = ?`,
        generation,
        selected.delivery_id,
      );
      state.generation = generation;
      state.dirty = false;
      state.failureCode = null;
      state.selectedDeliveryId = selected.delivery_id;
      state.selectedRootJson = selected.root_json;
      state.selectedRootDigest = selected.root_digest;
      state.installationState = null;
      state.completedTargetCount = 0;
      const installationRepositoryDelta =
        selectedRoot.scopeWorkItem.target.scope === 'repository-set'
        && selectedRoot.scopeWorkItem.cause.event
          === 'installation_repositories';
      if (
        selectedRoot.scopeWorkItem.target.scope === 'repository-set'
        && !installationRepositoryDelta
      ) {
        this.#mergeTeardownSnapshotIntoLastKnownIndex(
          selectedRoot,
          generation,
          now,
        );
        this.#createTargetsFromExplicitRepositoryIds(
          selectedRoot.scopeWorkItem.target.repositoryIds,
          generation,
          selected.root_digest,
          now,
        );
        state.phase = 'dispatch';
        state.currentPass = null;
        state.currentCursor = null;
        state.pageCount = 0;
        state.targetSource = 'explicit';
        state.targetCount = this.#targetCount(generation);
      } else {
        state.phase = 'enumerating';
        state.currentPass = 1;
        state.currentCursor = null;
        state.pageCount = 0;
        state.targetSource = null;
        state.targetCount = 0;
      }
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
          selectedRoot,
          phase: state.phase,
          pass: state.currentPass,
          cursor: null,
        } as const,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async recordPage(
    generationValue: number,
    leaseTokenValue: string,
    receiptValue: unknown,
  ): Promise<InstallationFanoutRecordPageResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const receipt = parseStewardRuntimeInstallationFanoutPageReceiptV1(
      receiptValue,
    );
    const receiptJson =
      canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json(receipt);
    const rootJson = canonicalStewardRuntimeInstallationFanoutRootV1Json(
      receipt.binding.root,
    );
    const rootDigest =
      await deriveStewardRuntimeInstallationFanoutRootDigest(
        receipt.binding.root,
      );

    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutRecordPageResult>(state);
      }
      if (
        state.selectedRootJson === null
        || state.selectedRootDigest === null
        || receipt.binding.generation !== generation
        || rootJson !== state.selectedRootJson
        || rootDigest !== state.selectedRootDigest
      ) {
        this.#writeState(state);
        return resultMutation<InstallationFanoutRecordPageResult>(
          state,
          { status: 'conflict' },
        );
      }

      const cursorKey = receipt.binding.cursor ?? cursorStartKey;
      const existing = this.#ctx.storage.sql
        .exec<PageRow>(
          `SELECT receipt_json
           FROM installation_fanout_pages
           WHERE generation = ?
             AND scan_pass = ?
             AND cursor_key = ?`,
          generation,
          receipt.binding.pass,
          cursorKey,
        )
        .toArray()[0];
      if (existing !== undefined) {
        this.#renewLease(state, now);
        this.#writeState(state);
        return resultMutation<InstallationFanoutRecordPageResult>(
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
        return resultMutation<InstallationFanoutRecordPageResult>(
          state,
          { status: 'conflict' },
        );
      }

      const pass = this.#loadPass(generation, state.currentPass);
      const revisionJson = canonicalControlRevisionJson(receipt);
      if (
        pass !== undefined
        && (
          pass.total_count !== receipt.page.totalCount
          || pass.installation_state !== receipt.installation.state
          || pass.control_revision_json !== revisionJson
        )
      ) {
        return this.#abortEnumeration(state, 'pagination-drift');
      }
      if (pass === undefined) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_fanout_passes (
             generation,
             scan_pass,
             total_count,
             installation_state,
             control_revision_json,
             page_count,
             complete
           ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
          generation,
          state.currentPass,
          receipt.page.totalCount,
          receipt.installation.state,
          revisionJson,
        );
      }

      const nextPageCount = state.pageCount + 1;
      if (
        nextPageCount > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES
        || (
          nextPageCount === STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES
          && receipt.page.hasNextPage
        )
      ) {
        return this.#abortEnumeration(state, 'pagination-limit');
      }
      if (
        receipt.page.endCursor !== null
        && this.#cursorWasVisited(
          generation,
          state.currentPass,
          receipt.page.endCursor,
        )
      ) {
        return this.#abortEnumeration(state, 'pagination-conflict');
      }

      this.#ctx.storage.sql.exec(
        `INSERT INTO installation_fanout_pages (
           generation,
           scan_pass,
           cursor_key,
           page_ordinal,
           receipt_json,
           next_cursor,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        generation,
        state.currentPass,
        cursorKey,
        nextPageCount,
        receiptJson,
        receipt.page.endCursor,
        now,
      );
      for (const repositoryId of receipt.page.repositoryIds) {
        this.#ctx.storage.sql.exec(
          `INSERT INTO installation_fanout_members (
             generation,
             scan_pass,
             repository_id
           ) VALUES (?, ?, ?)
           ON CONFLICT(generation, scan_pass, repository_id) DO NOTHING`,
          generation,
          state.currentPass,
          String(repositoryId),
        );
      }
      this.#ctx.storage.sql.exec(
        `UPDATE installation_fanout_passes
         SET page_count = ?
         WHERE generation = ? AND scan_pass = ?`,
        nextPageCount,
        generation,
        state.currentPass,
      );
      state.pageCount = nextPageCount;
      this.#renewLease(state, now);

      if (receipt.page.hasNextPage) {
        state.currentCursor = receipt.page.endCursor;
        this.#writeState(state);
        return resultMutation<InstallationFanoutRecordPageResult>(
          state,
          {
            status: 'accepted',
            generation,
            pass: state.currentPass,
            hasNextPage: true,
          },
        );
      }

      if (
        this.#memberCount(generation, state.currentPass)
        !== receipt.page.totalCount
      ) {
        return this.#abortEnumeration(state, 'pagination-drift');
      }
      this.#ctx.storage.sql.exec(
        `UPDATE installation_fanout_passes
         SET complete = 1
         WHERE generation = ? AND scan_pass = ?`,
        generation,
        state.currentPass,
      );
      if (state.currentPass === 1) {
        state.currentPass = 2;
        state.currentCursor = null;
        state.pageCount = 0;
        this.#writeState(state);
        return resultMutation<InstallationFanoutRecordPageResult>(
          state,
          {
            status: 'pass-complete',
            generation,
            nextPass: 2,
          },
        );
      }

      const confirmedPass = this.#matchingPass(generation);
      if (confirmedPass === undefined) {
        return this.#abortEnumeration(state, 'pagination-drift');
      }
      const selectedRootDigest = requireSelectedRootDigest(state);
      const selectedRoot = receipt.binding.root;
      const installationRepositoryDelta =
        selectedRoot.scopeWorkItem.target.scope === 'repository-set'
        && selectedRoot.scopeWorkItem.cause.event
          === 'installation_repositories';
      let targetSource: InstallationFanoutTargetSource;
      if (confirmedPass.installation_state === 'live') {
        this.#replaceLastKnownIndex(generation, revisionJson, now);
        if (installationRepositoryDelta) {
          this.#createTargetsFromExplicitRepositoryIds(
            selectedRoot.scopeWorkItem.target.repositoryIds,
            generation,
            selectedRootDigest,
            now,
          );
          targetSource = 'explicit';
        } else {
          this.#createTargetsFromMembers(
            generation,
            selectedRootDigest,
            now,
          );
          targetSource = 'live';
        }
      } else {
        if (installationRepositoryDelta) {
          this.#markLastKnownIndexUnknown(now);
          this.#createTargetsFromExplicitRepositoryIds(
            selectedRoot.scopeWorkItem.target.repositoryIds,
            generation,
            selectedRootDigest,
            now,
          );
          targetSource = 'explicit';
        } else if (!this.#lastKnownIndex().known) {
          return this.#abortEnumeration(
            state,
            'last-known-index-unavailable',
          );
        } else {
          this.#createTargetsFromLastKnown(
            generation,
            selectedRootDigest,
            now,
          );
          targetSource = 'last-known';
        }
      }

      const targetCount = this.#targetCount(generation);
      state.phase = 'dispatch';
      state.currentPass = null;
      state.currentCursor = null;
      state.pageCount = 0;
      state.installationState = installationState(
        confirmedPass.installation_state,
      );
      state.targetSource = targetSource;
      state.targetCount = targetCount;
      state.completedTargetCount = 0;
      state.failureCode = null;
      this.#writeState(state);
      return resultMutation<InstallationFanoutRecordPageResult>(
        state,
        {
          status: 'dispatch-ready',
          generation,
          installationState: installationState(
            confirmedPass.installation_state,
          ),
          targetSource,
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
  ): Promise<InstallationFanoutNextDispatchBatchResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const limit = assertInstallationFanoutDispatchBatchSize(limitValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutNextDispatchBatchResult>(state);
      }
      if (
        state.phase !== 'dispatch'
        || state.targetSource === null
        || (
          state.targetSource === 'explicit'
            ? false
            : state.installationState === null
        )
      ) {
        this.#writeState(state);
        return resultMutation<InstallationFanoutNextDispatchBatchResult>(
          state,
          { status: 'not-ready' },
        );
      }
      const targets = this.#ctx.storage.sql
        .exec<TargetRow>(
          `SELECT repository_id, delivery_id, state
           FROM installation_fanout_targets
           WHERE generation = ? AND state = 'pending'
           ORDER BY CAST(repository_id AS INTEGER)
           LIMIT ?`,
          generation,
          limit,
        )
        .toArray();
      const pendingCount = this.#pendingTargetCount(generation);
      this.#renewLease(state, now);
      this.#writeState(state);
      return resultMutation<InstallationFanoutNextDispatchBatchResult>(
        state,
        {
          status: 'batch',
          generation,
          installationState: state.installationState,
          targetSource: state.targetSource,
          targets: targets.map((target) => ({
            repositoryId: storedPositiveId(
              target.repository_id,
              'target repository ID',
            ),
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
  ): Promise<InstallationFanoutRecordQueueConfirmedResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const confirmations =
      parseInstallationFanoutQueueConfirmations(confirmationsValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutRecordQueueConfirmedResult>(
          state,
        );
      }
      if (state.phase !== 'dispatch') {
        this.#writeState(state);
        return resultMutation<InstallationFanoutRecordQueueConfirmedResult>(
          state,
          { status: 'conflict' },
        );
      }

      let newlyConfirmed = 0;
      for (const confirmation of confirmations.confirmations) {
        const target = this.#ctx.storage.sql
          .exec<TargetRow>(
            `SELECT repository_id, delivery_id, state
             FROM installation_fanout_targets
             WHERE generation = ? AND repository_id = ?`,
            generation,
            String(confirmation.repositoryId),
          )
          .toArray()[0];
        if (
          target === undefined
          || target.delivery_id !== confirmation.deliveryId
          || (target.state !== 'pending' && target.state !== 'confirmed')
        ) {
          this.#writeState(state);
          return resultMutation<InstallationFanoutRecordQueueConfirmedResult>(
            state,
            { status: 'conflict' },
          );
        }
        if (target.state === 'pending') newlyConfirmed += 1;
      }
      for (const confirmation of confirmations.confirmations) {
        this.#ctx.storage.sql.exec(
          `UPDATE installation_fanout_targets
           SET state = 'confirmed',
               confirmed_at = COALESCE(confirmed_at, ?)
           WHERE generation = ?
             AND repository_id = ?
             AND delivery_id = ?`,
          now,
          generation,
          String(confirmation.repositoryId),
          confirmation.deliveryId,
        );
      }
      const remaining = this.#pendingTargetCount(generation);
      state.completedTargetCount = state.targetCount - remaining;
      this.#renewLease(state, now);
      this.#writeState(state);
      return resultMutation<InstallationFanoutRecordQueueConfirmedResult>(
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
  ): Promise<InstallationFanoutCompleteResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const now = Date.now();
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, now);
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutCompleteResult>(state);
      }
      if (
        state.phase !== 'dispatch'
        || this.#pendingTargetCount(generation) !== 0
      ) {
        this.#writeState(state);
        return resultMutation<InstallationFanoutCompleteResult>(
          state,
          { status: 'not-ready' },
        );
      }

      this.#ctx.storage.sql.exec(
        `UPDATE installation_fanout_deliveries
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
      const needsFollowup =
        state.dirty || this.#pendingDeliveryCount() > 0;
      state.phase = needsFollowup ? 'followup' : 'idle';
      state.dirty = needsFollowup;
      state.failureCode = null;
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      state.selectedDeliveryId = null;
      state.selectedRootJson = null;
      state.selectedRootDigest = null;
      state.currentPass = null;
      state.currentCursor = null;
      state.pageCount = 0;
      state.completedTargetCount = state.targetCount;
      this.#writeState(state);
      this.#pruneCompletedDeliveries(now);
      this.#clearScanState();
      return resultMutation<InstallationFanoutCompleteResult>(
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
    failureCodeValue: InstallationFanoutFailureCode,
  ): Promise<InstallationFanoutFailResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const failureCode =
      assertInstallationFanoutFailureCode(failureCodeValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutFailResult>(state);
      }
      state.failureCode = failureCode;
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      this.#writeState(state);
      return resultMutation<InstallationFanoutFailResult>(
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
  ): Promise<InstallationFanoutReleaseForContinuationResult> {
    const generation =
      assertInstallationFanoutGeneration(generationValue);
    const leaseToken =
      assertInstallationFanoutLeaseToken(leaseTokenValue);
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      if (!this.#matchesLease(state, generation, leaseToken)) {
        this.#writeState(state);
        return staleMutation<InstallationFanoutReleaseForContinuationResult>(
          state,
        );
      }
      state.leaseToken = null;
      state.leaseExpiresAt = null;
      state.leaseDurationMs = null;
      this.#writeState(state);
      return resultMutation<InstallationFanoutReleaseForContinuationResult>(
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
      const bootstrap = this.#loadBootstrapState();
      this.#expireLeaseIfNeeded(state, now);
      this.#expireBootstrapLease(bootstrap, now);
      this.#writeState(state);
      this.#writeBootstrapState(bootstrap);
      return {
        alarmAt: minimumAlarm(
          this.#alarmAt(state),
          this.#bootstrapAlarmAt(bootstrap),
        ),
        result: undefined,
      };
    });
    await this.#scheduleAlarm(mutation.alarmAt);
  }

  async snapshot(): Promise<InstallationFanoutSnapshot> {
    const mutation = this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      this.#expireLeaseIfNeeded(state, Date.now());
      this.#writeState(state);
      const active =
        state.phase === 'enumerating' || state.phase === 'dispatch';
      const targetCount = active
        ? this.#targetCount(state.generation)
        : state.targetCount;
      const confirmedTargetCount = active
        ? targetCount - this.#pendingTargetCount(state.generation)
        : state.completedTargetCount;
      const lastKnown = this.#lastKnownIndex();
      const selectedRoot = state.selectedRootJson === null
        ? null
        : parseStoredRoot(state.selectedRootJson);
      return resultMutation<InstallationFanoutSnapshot>(
        state,
        {
          schemaVersion: installationFanoutSchemaVersion,
          installationId: state.installationId,
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
          pendingDeliveryCount: this.#pendingDeliveryCount(),
          completedDeliveryCount: this.#completedDeliveryCount(),
          selectedRootDigest: state.selectedRootDigest,
          selectedRootDeliveryId: selectedRoot?.deliveryId ?? null,
          selectedRootTargetScope:
            selectedRoot?.scopeWorkItem.target.scope ?? null,
          installationState: state.installationState,
          targetSource: state.targetSource,
          targetCount,
          confirmedTargetCount,
          lastKnownIndexKnown: lastKnown.known,
          lastKnownRepositoryCount: lastKnown.repositoryCount,
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
        CREATE TABLE IF NOT EXISTS installation_fanout_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);
      const version = sql
        .exec<SchemaVersionRow>(
          `SELECT version
           FROM installation_fanout_schema
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (
        version !== undefined
        && version.version !== installationFanoutSchemaVersion
      ) {
        throw new Error(
          `Unsupported installation fan-out schema version `
          + `${version.version}.`,
        );
      }
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          installation_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          phase TEXT NOT NULL
            CHECK (phase IN ('idle', 'enumerating', 'dispatch', 'followup')),
          dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
          selected_delivery_id TEXT,
          selected_root_json TEXT,
          selected_root_digest TEXT,
          current_pass INTEGER CHECK (current_pass IN (1, 2)),
          current_cursor TEXT,
          page_count INTEGER NOT NULL,
          lease_token TEXT,
          lease_expires_at INTEGER,
          lease_duration_ms INTEGER,
          failure_code TEXT,
          installation_state TEXT
            CHECK (installation_state IN ('live', 'suspended', 'absent')),
          target_source TEXT CHECK (
            target_source IN ('live', 'last-known', 'explicit')
          ),
          target_count INTEGER NOT NULL,
          completed_target_count INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_deliveries (
          delivery_id TEXT PRIMARY KEY,
          root_json TEXT NOT NULL,
          root_digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          accepted_at INTEGER NOT NULL,
          completed_at INTEGER,
          covered_generation INTEGER
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS installation_fanout_deliveries_status
        ON installation_fanout_deliveries (
          status,
          completed_at,
          accepted_at
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_passes (
          generation INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          total_count INTEGER NOT NULL,
          installation_state TEXT NOT NULL
            CHECK (installation_state IN ('live', 'suspended', 'absent')),
          control_revision_json TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          PRIMARY KEY (generation, scan_pass)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_pages (
          generation INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          cursor_key TEXT NOT NULL,
          page_ordinal INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          next_cursor TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (generation, scan_pass, cursor_key),
          UNIQUE (generation, scan_pass, page_ordinal)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_members (
          generation INTEGER NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          repository_id TEXT NOT NULL,
          PRIMARY KEY (generation, scan_pass, repository_id)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_targets (
          generation INTEGER NOT NULL,
          repository_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed')),
          discovered_at INTEGER NOT NULL,
          confirmed_at INTEGER,
          PRIMARY KEY (generation, repository_id),
          UNIQUE (delivery_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS installation_fanout_targets_pending
        ON installation_fanout_targets (generation, state, repository_id)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_last_known_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          known INTEGER NOT NULL CHECK (known IN (0, 1)),
          repository_count INTEGER NOT NULL,
          control_revision_json TEXT,
          updated_at INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_fanout_last_known_repositories (
          repository_id TEXT PRIMARY KEY,
          observed_generation INTEGER NOT NULL,
          observed_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_index_bootstrap_commands (
          request_id TEXT PRIMARY KEY,
          command_json TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          principal_client_id TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          accepted_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          failure_code TEXT,
          repository_count INTEGER NOT NULL,
          index_digest TEXT,
          control_revision_json TEXT
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_index_bootstrap_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          current_request_id TEXT,
          command_digest TEXT,
          phase TEXT NOT NULL
            CHECK (phase IN ('idle', 'enumerating', 'finalizing')),
          current_pass INTEGER CHECK (current_pass IN (1, 2)),
          current_cursor TEXT,
          page_count INTEGER NOT NULL,
          lease_token TEXT,
          lease_expires_at INTEGER,
          lease_duration_ms INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_index_bootstrap_passes (
          request_id TEXT NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          total_count INTEGER NOT NULL,
          control_revision_json TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          PRIMARY KEY (request_id, scan_pass)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_index_bootstrap_pages (
          request_id TEXT NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          cursor_key TEXT NOT NULL,
          page_ordinal INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          next_cursor TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (request_id, scan_pass, cursor_key),
          UNIQUE (request_id, scan_pass, page_ordinal)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS installation_index_bootstrap_members (
          request_id TEXT NOT NULL,
          scan_pass INTEGER NOT NULL CHECK (scan_pass IN (1, 2)),
          repository_id TEXT NOT NULL,
          PRIMARY KEY (request_id, scan_pass, repository_id)
        )
      `);
      if (version === undefined) {
        sql.exec(
          `INSERT INTO installation_fanout_schema (singleton, version)
           VALUES (1, ?)`,
          installationFanoutSchemaVersion,
        );
      }
      const meta = sql
        .exec<LastKnownMetaRow>(
          `SELECT known, repository_count, control_revision_json, updated_at
           FROM installation_fanout_last_known_meta
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (meta === undefined) {
        sql.exec(
          `INSERT INTO installation_fanout_last_known_meta (
             singleton,
             known,
             repository_count,
             control_revision_json,
             updated_at
           ) VALUES (1, 0, 0, NULL, NULL)`,
        );
      }
      const bootstrapState = sql.exec<BootstrapStateRow>(
        `SELECT *
         FROM installation_index_bootstrap_state
         WHERE singleton = 1`,
      ).toArray()[0];
      if (bootstrapState === undefined) {
        sql.exec(
          `INSERT INTO installation_index_bootstrap_state (
             singleton,
             current_request_id,
             command_digest,
             phase,
             current_pass,
             current_cursor,
             page_count,
             lease_token,
             lease_expires_at,
             lease_duration_ms
           ) VALUES (1, NULL, NULL, 'idle', NULL, NULL, 0, NULL, NULL, NULL)`,
        );
      } else {
        this.#expireBootstrapLease(bootstrapState, Date.now());
        this.#writeBootstrapState(bootstrapState);
      }
      const existing = sql
        .exec<FanoutStateRow>(
          `SELECT *
           FROM installation_fanout_state
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
          installationId: this.#installationId,
          installationState: null,
          leaseDurationMs: null,
          leaseExpiresAt: null,
          leaseToken: null,
          pageCount: 0,
          phase: 'idle',
          selectedDeliveryId: null,
          selectedRootDigest: null,
          selectedRootJson: null,
          targetCount: 0,
          targetSource: null,
        });
      } else if (existing.installation_id !== this.#installationId) {
        throw new Error(
          'Durable Object name does not match persisted installation.',
        );
      } else {
        const state = toMutableState(existing);
        this.#expireLeaseIfNeeded(state, Date.now());
        this.#writeState(state);
      }
    });
  }

  #loadBootstrapState(): BootstrapStateRow {
    const state = this.#ctx.storage.sql.exec<BootstrapStateRow>(
      `SELECT *
       FROM installation_index_bootstrap_state
       WHERE singleton = 1`,
    ).one();
    if (
      (state.phase !== 'idle'
        && state.phase !== 'enumerating'
        && state.phase !== 'finalizing')
      || !Number.isSafeInteger(state.page_count)
      || state.page_count < 0
      || (
        state.phase === 'idle'
        && (
          state.current_request_id !== null
          || state.command_digest !== null
          || state.current_pass !== null
          || state.current_cursor !== null
        )
      )
      || (
        state.phase === 'enumerating'
        && (
          state.current_request_id === null
          || state.command_digest === null
          || (state.current_pass !== 1 && state.current_pass !== 2)
        )
      )
      || (
        state.phase === 'finalizing'
        && (
          state.current_request_id === null
          || state.command_digest === null
          || state.current_pass !== null
          || state.current_cursor !== null
        )
      )
      || (
        state.lease_token === null
          ? (
              state.lease_expires_at !== null
              || state.lease_duration_ms !== null
            )
          : (
              state.lease_expires_at === null
              || state.lease_duration_ms === null
              || !Number.isSafeInteger(state.lease_expires_at)
              || !Number.isSafeInteger(state.lease_duration_ms)
              || state.lease_duration_ms <= 0
            )
      )
    ) {
      throw new Error('Persisted installation index bootstrap state is invalid.');
    }
    return state;
  }

  #writeBootstrapState(state: BootstrapStateRow): void {
    this.#ctx.storage.sql.exec(
      `UPDATE installation_index_bootstrap_state
       SET current_request_id = ?,
           command_digest = ?,
           phase = ?,
           current_pass = ?,
           current_cursor = ?,
           page_count = ?,
           lease_token = ?,
           lease_expires_at = ?,
           lease_duration_ms = ?
       WHERE singleton = 1`,
      state.current_request_id,
      state.command_digest,
      state.phase,
      state.current_pass,
      state.current_cursor,
      state.page_count,
      state.lease_token,
      state.lease_expires_at,
      state.lease_duration_ms,
    );
  }

  #loadBootstrapCommand(requestId: string): BootstrapCommandRow | undefined {
    return this.#ctx.storage.sql.exec<BootstrapCommandRow>(
      `SELECT *
       FROM installation_index_bootstrap_commands
       WHERE request_id = ?`,
      requestId,
    ).toArray()[0];
  }

  #loadBootstrapPass(
    requestId: string,
    pass: 1 | 2,
  ): BootstrapPassRow | undefined {
    return this.#ctx.storage.sql.exec<BootstrapPassRow>(
      `SELECT total_count, control_revision_json, page_count, complete
       FROM installation_index_bootstrap_passes
       WHERE request_id = ? AND scan_pass = ?`,
      requestId,
      pass,
    ).toArray()[0];
  }

  #bootstrapMemberCount(requestId: string, pass: 1 | 2): number {
    return this.#ctx.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count
       FROM installation_index_bootstrap_members
       WHERE request_id = ? AND scan_pass = ?`,
      requestId,
      pass,
    ).one().count;
  }

  #bootstrapCursorWasVisited(
    requestId: string,
    pass: 1 | 2,
    cursor: string,
  ): boolean {
    return this.#ctx.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count
       FROM installation_index_bootstrap_pages
       WHERE request_id = ? AND scan_pass = ? AND cursor_key = ?`,
      requestId,
      pass,
      cursor,
    ).one().count !== 0;
  }

  #bootstrapPassesMatch(requestId: string): boolean {
    const first = this.#loadBootstrapPass(requestId, 1);
    const second = this.#loadBootstrapPass(requestId, 2);
    if (
      first === undefined
      || second === undefined
      || first.complete !== 1
      || second.complete !== 1
      || first.total_count !== second.total_count
      || first.control_revision_json !== second.control_revision_json
      || this.#bootstrapMemberCount(requestId, 1) !== first.total_count
      || this.#bootstrapMemberCount(requestId, 2) !== second.total_count
    ) {
      return false;
    }
    const firstOnly = this.#ctx.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM (
         SELECT repository_id
         FROM installation_index_bootstrap_members
         WHERE request_id = ? AND scan_pass = 1
         EXCEPT
         SELECT repository_id
         FROM installation_index_bootstrap_members
         WHERE request_id = ? AND scan_pass = 2
       )`,
      requestId,
      requestId,
    ).one().count;
    const secondOnly = this.#ctx.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM (
         SELECT repository_id
         FROM installation_index_bootstrap_members
         WHERE request_id = ? AND scan_pass = 2
         EXCEPT
         SELECT repository_id
         FROM installation_index_bootstrap_members
         WHERE request_id = ? AND scan_pass = 1
       )`,
      requestId,
      requestId,
    ).one().count;
    return firstOnly === 0 && secondOnly === 0;
  }

  #expireBootstrapLease(state: BootstrapStateRow, now: number): void {
    if (
      state.lease_token !== null
      && state.lease_expires_at !== null
      && state.lease_expires_at <= now
    ) {
      state.lease_token = null;
      state.lease_expires_at = null;
      state.lease_duration_ms = null;
    }
  }

  #renewBootstrapLease(state: BootstrapStateRow, now: number): void {
    if (state.lease_token === null || state.lease_duration_ms === null) {
      throw new Error('Bootstrap lease cannot be renewed.');
    }
    state.lease_expires_at = addDuration(now, state.lease_duration_ms);
  }

  #bootstrapAlarmAt(state: BootstrapStateRow): number | null {
    return state.lease_token === null ? null : state.lease_expires_at;
  }

  #clearBootstrapActive(state: BootstrapStateRow): void {
    state.current_request_id = null;
    state.command_digest = null;
    state.phase = 'idle';
    state.current_pass = null;
    state.current_cursor = null;
    state.page_count = 0;
    state.lease_token = null;
    state.lease_expires_at = null;
    state.lease_duration_ms = null;
  }

  #bootstrapStatusReceipt(
    row: BootstrapCommandRow,
  ): StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 {
    const value = {
      schemaVersion: 1,
      operation: 'installation-index-bootstrap-status',
      requestId: row.request_id,
      commandDigest: row.command_digest,
      installationId: Number(this.#installationId),
      status: row.status,
      lastKnownIndexKnown: row.status === 'completed',
      repositoryCount: row.status === 'completed' ? row.repository_count : 0,
      indexDigest: row.status === 'completed' ? row.index_digest : null,
      controlRevision: row.status === 'completed'
        ? JSON.parse(row.control_revision_json ?? 'null') as unknown
        : null,
      failureCode: row.status === 'failed' ? row.failure_code : null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    const receipt =
      parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1(value);
    canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json(
      receipt,
    );
    return receipt;
  }

  #failBootstrapInTransaction(
    state: BootstrapStateRow,
    command: BootstrapCommandRow,
    failureCode: InstallationIndexBootstrapFailureCode,
    now: number,
  ): StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 {
    this.#ctx.storage.sql.exec(
      `UPDATE installation_index_bootstrap_commands
       SET status = 'failed',
           updated_at = ?,
           completed_at = ?,
           failure_code = ?,
           repository_count = 0,
           index_digest = NULL,
           control_revision_json = NULL
       WHERE request_id = ? AND command_digest = ?`,
      now,
      now,
      failureCode,
      command.request_id,
      command.command_digest,
    );
    const failed = this.#loadBootstrapCommand(command.request_id);
    if (failed === undefined) {
      throw new Error('Failed bootstrap command is absent.');
    }
    this.#clearBootstrapActive(state);
    this.#writeBootstrapState(state);
    return this.#bootstrapStatusReceipt(failed);
  }

  #loadState(): MutableFanoutState {
    return toMutableState(
      this.#ctx.storage.sql
        .exec<FanoutStateRow>(
          `SELECT *
           FROM installation_fanout_state
           WHERE singleton = 1`,
        )
        .one(),
    );
  }

  #writeState(state: MutableFanoutState): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO installation_fanout_state (
         singleton,
         installation_id,
         generation,
         phase,
         dirty,
         selected_delivery_id,
         selected_root_json,
         selected_root_digest,
         current_pass,
         current_cursor,
         page_count,
         lease_token,
         lease_expires_at,
         lease_duration_ms,
         failure_code,
         installation_state,
         target_source,
         target_count,
         completed_target_count
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         installation_id = excluded.installation_id,
         generation = excluded.generation,
         phase = excluded.phase,
         dirty = excluded.dirty,
         selected_delivery_id = excluded.selected_delivery_id,
         selected_root_json = excluded.selected_root_json,
         selected_root_digest = excluded.selected_root_digest,
         current_pass = excluded.current_pass,
         current_cursor = excluded.current_cursor,
         page_count = excluded.page_count,
         lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at,
         lease_duration_ms = excluded.lease_duration_ms,
         failure_code = excluded.failure_code,
         installation_state = excluded.installation_state,
         target_source = excluded.target_source,
         target_count = excluded.target_count,
         completed_target_count = excluded.completed_target_count`,
      state.installationId,
      state.generation,
      state.phase,
      state.dirty ? 1 : 0,
      state.selectedDeliveryId,
      state.selectedRootJson,
      state.selectedRootDigest,
      state.currentPass,
      state.currentCursor,
      state.pageCount,
      state.leaseToken,
      state.leaseExpiresAt,
      state.leaseDurationMs,
      state.failureCode,
      state.installationState,
      state.targetSource,
      state.targetCount,
      state.completedTargetCount,
    );
  }

  #loadDelivery(deliveryId: string): DeliveryRow | undefined {
    return this.#ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT *
         FROM installation_fanout_deliveries
         WHERE delivery_id = ?`,
        deliveryId,
      )
      .toArray()[0];
  }

  #oldestPendingDelivery(): DeliveryRow | undefined {
    return this.#ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT *
         FROM installation_fanout_deliveries
         WHERE status = 'pending'
         ORDER BY accepted_at, delivery_id
         LIMIT 1`,
      )
      .toArray()[0];
  }

  #appendPendingDelivery(
    deliveryId: string,
    rootJson: string,
    rootDigest: string,
    now: number,
  ): void {
    if (
      this.#pendingDeliveryCount()
      >= installationFanoutPendingDeliveryRetentionLimit
    ) {
      throw new Error(
        'Installation fan-out pending delivery retention is exhausted.',
      );
    }
    this.#ctx.storage.sql.exec(
      `INSERT INTO installation_fanout_deliveries (
         delivery_id,
         root_json,
         root_digest,
         status,
         accepted_at,
         completed_at,
         covered_generation
       ) VALUES (?, ?, ?, 'pending', ?, NULL, NULL)`,
      deliveryId,
      rootJson,
      rootDigest,
      now,
    );
  }

  #pruneCompletedDeliveries(now: number): void {
    const cutoff = Math.max(
      0,
      now - installationFanoutCompletedDeliveryRetentionMs,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM installation_fanout_deliveries
       WHERE status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at < ?`,
      cutoff,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM installation_fanout_deliveries
       WHERE delivery_id IN (
         SELECT delivery_id
         FROM installation_fanout_deliveries
         WHERE status = 'completed'
         ORDER BY completed_at DESC, delivery_id DESC
         LIMIT -1 OFFSET ?
       )`,
      installationFanoutCompletedDeliveryRetentionLimit,
    );
  }

  #pendingDeliveryCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_deliveries
         WHERE status = 'pending'`,
      )
      .one().count;
  }

  #completedDeliveryCount(): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_deliveries
         WHERE status = 'completed'`,
      )
      .one().count;
  }

  #loadPass(
    generation: number,
    scanPass: 1 | 2,
  ): PassRow | undefined {
    return this.#ctx.storage.sql
      .exec<PassRow>(
        `SELECT
           total_count,
           installation_state,
           control_revision_json,
           page_count,
           complete
         FROM installation_fanout_passes
         WHERE generation = ? AND scan_pass = ?`,
        generation,
        scanPass,
      )
      .toArray()[0];
  }

  #cursorWasVisited(
    generation: number,
    scanPass: 1 | 2,
    cursor: string,
  ): boolean {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_pages
         WHERE generation = ?
           AND scan_pass = ?
           AND cursor_key = ?`,
        generation,
        scanPass,
        cursor,
      )
      .one().count > 0;
  }

  #memberCount(generation: number, scanPass: 1 | 2): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_members
         WHERE generation = ? AND scan_pass = ?`,
        generation,
        scanPass,
      )
      .one().count;
  }

  #matchingPass(generation: number): PassRow | undefined {
    const first = this.#loadPass(generation, 1);
    const second = this.#loadPass(generation, 2);
    if (
      first === undefined
      || second === undefined
      || first.complete !== 1
      || second.complete !== 1
      || first.total_count !== second.total_count
      || first.installation_state !== second.installation_state
      || first.control_revision_json !== second.control_revision_json
    ) {
      return undefined;
    }
    const firstOnly = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT repository_id
           FROM installation_fanout_members
           WHERE generation = ? AND scan_pass = 1
           EXCEPT
           SELECT repository_id
           FROM installation_fanout_members
           WHERE generation = ? AND scan_pass = 2
         )`,
        generation,
        generation,
      )
      .one().count;
    if (firstOnly !== 0) return undefined;
    const secondOnly = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT repository_id
           FROM installation_fanout_members
           WHERE generation = ? AND scan_pass = 2
           EXCEPT
           SELECT repository_id
           FROM installation_fanout_members
           WHERE generation = ? AND scan_pass = 1
         )`,
        generation,
        generation,
      )
      .one().count;
    return secondOnly === 0 ? second : undefined;
  }

  #replaceLastKnownIndex(
    generation: number,
    controlRevisionJson: string,
    now: number,
  ): void {
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_last_known_repositories',
    );
    const repositories = this.#ctx.storage.sql
      .exec<RepositoryIdRow>(
        `SELECT repository_id
         FROM installation_fanout_members
         WHERE generation = ? AND scan_pass = 2
         ORDER BY CAST(repository_id AS INTEGER)`,
        generation,
      )
      .toArray();
    for (const repository of repositories) {
      this.#ctx.storage.sql.exec(
        `INSERT INTO installation_fanout_last_known_repositories (
           repository_id,
           observed_generation,
           observed_at
         ) VALUES (?, ?, ?)`,
        repository.repository_id,
        generation,
        now,
      );
    }
    this.#ctx.storage.sql.exec(
      `UPDATE installation_fanout_last_known_meta
       SET known = 1,
           repository_count = ?,
           control_revision_json = ?,
           updated_at = ?
       WHERE singleton = 1`,
      repositories.length,
      controlRevisionJson,
      now,
    );
  }

  #mergeTeardownSnapshotIntoLastKnownIndex(
    root: StewardRuntimeInstallationFanoutRootV1,
    generation: number,
    now: number,
  ): void {
    const target = root.scopeWorkItem.target;
    if (target.scope !== 'repository-set') {
      throw new Error('Explicit installation root must target a repository set.');
    }
    const cause = root.scopeWorkItem.cause;
    if (
      cause.event !== 'installation'
      || (cause.action !== 'suspend' && cause.action !== 'deleted')
    ) {
      throw new Error('Explicit installation root must be a teardown snapshot.');
    }
    const existing = this.#lastKnownIndex();
    if (!existing.known) {
      this.#ctx.storage.sql.exec(
        'DELETE FROM installation_fanout_last_known_repositories',
      );
    }
    for (const repositoryId of target.repositoryIds) {
      this.#ctx.storage.sql.exec(
        `INSERT INTO installation_fanout_last_known_repositories (
           repository_id,
           observed_generation,
           observed_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(repository_id) DO UPDATE SET
           observed_generation = excluded.observed_generation,
           observed_at = excluded.observed_at`,
        String(repositoryId),
        generation,
        now,
      );
    }
    const repositoryCount = this.#ctx.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count
       FROM installation_fanout_last_known_repositories`,
    ).one().count;
    if (!existing.known) {
      this.#writeWebhookObservedLastKnownMeta(repositoryCount, now);
      return;
    }
    // Webhook teardown snapshots have no stable ordering token. A delayed
    // suspend/deleted delivery must therefore never shrink a newer index
    // established by live Control enumeration. Union is intentionally
    // conservative: a later live two-pass scan may replace the exact set. If
    // the union expands, its mixed provenance can no longer retain an exact
    // Control revision.
    this.#ctx.storage.sql.exec(
      `UPDATE installation_fanout_last_known_meta
       SET repository_count = ?,
           control_revision_json = CASE
             WHEN ? = 1 THEN NULL
             ELSE control_revision_json
           END,
           updated_at = ?
       WHERE singleton = 1`,
      repositoryCount,
      repositoryCount === existing.repositoryCount ? 0 : 1,
      now,
    );
  }

  #writeWebhookObservedLastKnownMeta(
    repositoryCount: number,
    now: number,
  ): void {
    this.#ctx.storage.sql.exec(
      `UPDATE installation_fanout_last_known_meta
       SET known = 1,
           repository_count = ?,
           control_revision_json = NULL,
           updated_at = ?
       WHERE singleton = 1`,
      repositoryCount,
      now,
    );
  }

  #markLastKnownIndexUnknown(now: number): void {
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_last_known_repositories',
    );
    this.#ctx.storage.sql.exec(
      `UPDATE installation_fanout_last_known_meta
       SET known = 0,
           repository_count = 0,
           control_revision_json = NULL,
           updated_at = ?
       WHERE singleton = 1`,
      now,
    );
  }

  #lastKnownIndex(): {
    readonly known: boolean;
    readonly repositoryCount: number;
  } {
    const meta = this.#ctx.storage.sql
      .exec<LastKnownMetaRow>(
        `SELECT known, repository_count, control_revision_json, updated_at
         FROM installation_fanout_last_known_meta
         WHERE singleton = 1`,
      )
      .one();
    const known = booleanInteger(meta.known, 'last-known index flag');
    const repositoryCount = nonNegativeInteger(
      meta.repository_count,
      'last-known repository count',
    );
    const actualCount = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_last_known_repositories`,
      )
      .one().count;
    if (
      (known && actualCount !== repositoryCount)
      || (!known && (repositoryCount !== 0 || actualCount !== 0))
    ) {
      throw new Error('Installation last-known repository index is corrupt.');
    }
    return { known, repositoryCount };
  }

  #createTargetsFromMembers(
    generation: number,
    rootDigest: string,
    now: number,
  ): void {
    const repositories = this.#ctx.storage.sql
      .exec<RepositoryIdRow>(
        `SELECT repository_id
         FROM installation_fanout_members
         WHERE generation = ? AND scan_pass = 2
         ORDER BY CAST(repository_id AS INTEGER)`,
        generation,
      )
      .toArray();
    this.#insertTargets(repositories, generation, rootDigest, now);
  }

  #createTargetsFromLastKnown(
    generation: number,
    rootDigest: string,
    now: number,
  ): void {
    const repositories = this.#ctx.storage.sql
      .exec<RepositoryIdRow>(
        `SELECT repository_id
         FROM installation_fanout_last_known_repositories
         ORDER BY CAST(repository_id AS INTEGER)`,
      )
      .toArray();
    this.#insertTargets(repositories, generation, rootDigest, now);
  }

  #createTargetsFromExplicitRepositoryIds(
    repositoryIds: readonly number[],
    generation: number,
    rootDigest: string,
    now: number,
  ): void {
    this.#insertTargets(
      repositoryIds.map((repositoryId) => ({
        repository_id: String(repositoryId),
      })),
      generation,
      rootDigest,
      now,
    );
  }

  #insertTargets(
    repositories: readonly RepositoryIdRow[],
    generation: number,
    rootDigest: string,
    now: number,
  ): void {
    for (const repository of repositories) {
      const repositoryId = storedPositiveId(
        repository.repository_id,
        'repository ID',
      );
      this.#ctx.storage.sql.exec(
        `INSERT INTO installation_fanout_targets (
           generation,
           repository_id,
           delivery_id,
           state,
           discovered_at,
           confirmed_at
         ) VALUES (?, ?, ?, 'pending', ?, NULL)`,
        generation,
        repository.repository_id,
        buildStewardRuntimeInstallationFanoutDeliveryId(
          rootDigest,
          generation,
          repositoryId,
        ),
        now,
      );
    }
  }

  #targetCount(generation: number): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_targets
         WHERE generation = ?`,
        generation,
      )
      .one().count;
  }

  #pendingTargetCount(generation: number): number {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM installation_fanout_targets
         WHERE generation = ? AND state = 'pending'`,
        generation,
      )
      .one().count;
  }

  #abortEnumeration(
    state: MutableFanoutState,
    reason:
      | 'last-known-index-unavailable'
      | 'pagination-conflict'
      | 'pagination-drift'
      | 'pagination-limit',
  ): CoordinatorMutation<InstallationFanoutRecordPageResult> {
    this.#ctx.storage.sql.exec(
      `UPDATE installation_fanout_deliveries
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
    state.selectedRootJson = null;
    state.selectedRootDigest = null;
    state.currentPass = null;
    state.currentCursor = null;
    state.pageCount = 0;
    state.installationState = null;
    state.targetSource = null;
    state.targetCount = 0;
    state.completedTargetCount = 0;
    this.#writeState(state);
    return resultMutation<InstallationFanoutRecordPageResult>(
      state,
      {
        status: 'failed-closed',
        generation: state.generation,
        reason,
      },
    );
  }

  #clearScanState(): void {
    this.#ctx.storage.sql.exec('DELETE FROM installation_fanout_targets');
    this.#ctx.storage.sql.exec('DELETE FROM installation_fanout_members');
    this.#ctx.storage.sql.exec('DELETE FROM installation_fanout_pages');
    this.#ctx.storage.sql.exec('DELETE FROM installation_fanout_passes');
  }

  #deleteGenerationScan(generation: number): void {
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_targets WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_members WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_pages WHERE generation = ?',
      generation,
    );
    this.#ctx.storage.sql.exec(
      'DELETE FROM installation_fanout_passes WHERE generation = ?',
      generation,
    );
  }

  #selectedRoot(state: MutableFanoutState): StewardRuntimeInstallationFanoutRootV1 {
    if (state.selectedRootJson === null) {
      throw new Error('Active installation fan-out is missing its root.');
    }
    return parseStoredRoot(state.selectedRootJson);
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
    if (state.leaseToken === null || state.leaseDurationMs === null) {
      throw new Error('Cannot renew an absent installation fan-out lease.');
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
      'completed target count',
    ),
    currentCursor: row.current_cursor,
    currentPass: nullablePass(row.current_pass),
    dirty: booleanInteger(row.dirty, 'dirty'),
    failureCode: row.failure_code === null
      ? null
      : assertInstallationFanoutFailureCode(
          row.failure_code as InstallationFanoutFailureCode,
        ),
    generation: nonNegativeInteger(row.generation, 'generation'),
    installationId: row.installation_id,
    installationState: row.installation_state === null
      ? null
      : installationState(row.installation_state),
    leaseDurationMs: nullableNonNegativeInteger(
      row.lease_duration_ms,
      'lease duration',
    ),
    leaseExpiresAt: nullableNonNegativeInteger(
      row.lease_expires_at,
      'lease expiry',
    ),
    leaseToken: row.lease_token,
    pageCount: nonNegativeInteger(row.page_count, 'page count'),
    phase: fanoutPhase(row.phase),
    selectedDeliveryId: row.selected_delivery_id,
    selectedRootDigest: row.selected_root_digest === null
      ? null
      : storedRootDigest(row.selected_root_digest),
    selectedRootJson: row.selected_root_json,
    targetCount: nonNegativeInteger(row.target_count, 'target count'),
    targetSource: row.target_source === null
      ? null
      : targetSource(row.target_source),
  };
}

function fanoutPhase(value: string): InstallationFanoutPhase {
  if (
    value !== 'idle'
    && value !== 'enumerating'
    && value !== 'dispatch'
    && value !== 'followup'
  ) {
    throw new Error(`Unsupported installation fan-out phase ${value}.`);
  }
  return value;
}

function nullablePass(value: number | null): 1 | 2 | null {
  if (value === null) return null;
  if (value !== 1 && value !== 2) {
    throw new Error(`Unsupported installation fan-out pass ${value}.`);
  }
  return value;
}

function installationState(
  value: string,
): StewardRuntimeInstallationFanoutStateV1 {
  if (value !== 'live' && value !== 'suspended' && value !== 'absent') {
    throw new Error(`Unsupported installation state ${value}.`);
  }
  return value;
}

function targetSource(value: string): InstallationFanoutTargetSource {
  if (
    value !== 'live'
    && value !== 'last-known'
    && value !== 'explicit'
  ) {
    throw new Error(`Unsupported installation target source ${value}.`);
  }
  return value;
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

function storedPositiveId(value: string, field: string): number {
  if (
    !/^[1-9]\d*$/.test(value)
    || !Number.isSafeInteger(Number(value))
    || String(Number(value)) !== value
  ) {
    throw new Error(`${field} is not a canonical positive identifier.`);
  }
  return Number(value);
}

function storedRootDigest(value: string): string {
  if (!rootDigestPattern.test(value)) {
    throw new Error('Stored installation fan-out root digest is invalid.');
  }
  return value;
}

function parseStoredRoot(value: string): StewardRuntimeInstallationFanoutRootV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Stored installation fan-out root JSON is invalid.');
  }
  return parseStewardRuntimeInstallationFanoutRootV1(parsed);
}

function canonicalControlRevisionJson(
  receipt: StewardRuntimeInstallationFanoutPageReceiptV1,
): string {
  return canonicalControlRevisionJsonFromRevision(receipt.controlRevision);
}

function canonicalControlRevisionJsonFromRevision(
  revision: StewardRuntimeInstallationFanoutPageReceiptV1['controlRevision'],
): string {
  return JSON.stringify({
    stewardCommit: revision.stewardCommit,
    workerVersionId: revision.workerVersionId,
    workerVersionTag: revision.workerVersionTag,
    workerVersionCreatedAt: revision.workerVersionCreatedAt,
  });
}

function minimumAlarm(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function requireSelectedRootDigest(state: MutableFanoutState): string {
  if (state.selectedRootDigest === null) {
    throw new Error('Active installation fan-out has no root digest.');
  }
  return state.selectedRootDigest;
}

function requireSelectedDeliveryId(state: MutableFanoutState): string {
  if (state.selectedDeliveryId === null) {
    throw new Error('Active installation fan-out has no selected delivery.');
  }
  return state.selectedDeliveryId;
}

function requireLeaseToken(state: MutableFanoutState): string {
  if (state.leaseToken === null) {
    throw new Error('Active installation fan-out has no lease token.');
  }
  return state.leaseToken;
}

function requireLeaseExpiry(state: MutableFanoutState): number {
  if (state.leaseExpiresAt === null) {
    throw new Error('Active installation fan-out has no lease expiry.');
  }
  return state.leaseExpiresAt;
}

function nextGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('Stored installation fan-out generation is invalid.');
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error('Installation fan-out generation is exhausted.');
  }
  return next;
}

function addDuration(now: number, duration: number): number {
  const expiresAt = now + duration;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Installation fan-out lease expiry is out of range.');
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
    { status: 'stale' } as unknown as T,
  );
}
