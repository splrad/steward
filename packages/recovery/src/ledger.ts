import { DurableObject } from 'cloudflare:workers';
import {
  assertDeliveryRecoveryCommandId,
  assertDeliveryRecoveryInspectLimit,
  assertDeliveryRecoveryLedgerName,
  canonicalGitHubDeliveryScanCommandJson,
  canonicalGitHubDeliveryScanPageJson,
  canonicalReplayAuthorizationCommandJson,
  DeliveryRecoveryConflictError,
  deliveryRecoveryLedgerSchemaVersion,
  maximumDeliveryRecoveryCaptureAuditRows,
  maximumDeliveryRecoveryReplayCount,
  maximumGitHubDeliveryScanAttempts,
  maximumGitHubDeliveryScanLeaseMs,
  maximumGitHubDeliveryScanPages,
  maximumGitHubRedeliveriesPerGuid,
  maximumGitHubUnresolvedRedeliveryInspectionEntries,
  parseDeliveryRecoveryCaptureInput,
  parseDeliveryRecoveryReplayAuthorizationCommand,
  parseDeliveryRecoveryReplayOutcomeInput,
  parseGitHubDeliveryScanCommand,
  parseGitHubDeliveryScanCompletionInput,
  parseGitHubDeliveryScanPageInput,
  parseGitHubNextRedeliveryInput,
  parseGitHubRedeliveryDeferredInput,
  parseGitHubRedeliveryOutcomeInput,
  parseGitHubRedeliveryRejectedInput,
  type DeliveryRecoveryCaptureResult,
  type DeliveryRecoveryCaptureInput,
  type DeliveryRecoveryEntryState,
  type DeliveryRecoveryInspection,
  type DeliveryRecoveryNextReplayResult,
  type DeliveryRecoveryReplayAuthorizationResult,
  type DeliveryRecoveryReplayOutcomeResult,
  type GitHubDeliveryScanBeginResult,
  type GitHubDeliveryScanCompletionResult,
  type GitHubDeliveryScanInspection,
  type GitHubDeliveryScanPageInput,
  type GitHubDeliveryScanPageResult,
  type GitHubDeliveryCoverage,
  type GitHubDeliveryScanCommand,
  type GitHubNextRedeliveryResult,
  type GitHubRedeliveryOutcomeResult,
  type GitHubRedeliveryUnresolvedCounts,
  type GitHubUnresolvedRedeliveryState,
} from './ledger-contracts.js';

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

interface DeliveryRecoveryDurableObjectState {
  readonly id: {
    readonly name?: string;
  };
  readonly storage: {
    readonly sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
  };
}

interface SchemaVersionRow {
  version: number;
}

interface SqliteSchemaRow {
  name: string;
  sql: string | null;
}

interface SqliteTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteCheckRow {
  quick_check: string;
}

interface CountRow {
  count: number;
}

interface LedgerStateRow {
  revision: string;
  github_generation: number;
  github_checkpoint: string | null;
  github_coverage_status: string | null;
  github_coverage_from: string | null;
  github_provider_window_start: string | null;
  github_gap_reason: string | null;
  github_gap_from: string | null;
  github_gap_to: string | null;
  active_generation: number | null;
  active_command_id: string | null;
  active_scan_id: string | null;
  active_scan_started_at: string | null;
  active_cursor: string | null;
  active_page_count: number;
  active_attempt_count: number;
  terminal_page_seen: number;
  active_lease_expires_at: string | null;
  active_coverage_mode: string | null;
  active_coverage_from: string | null;
  active_provider_window_start: string | null;
  active_gap_reason: string | null;
  active_gap_from: string | null;
  active_gap_to: string | null;
  active_last_delivered_at: string | null;
  active_last_attempt_id: number | null;
}

interface EntryRow {
  entry_id: string;
  body_digest: string;
  body: string;
  byte_length: number;
  eligible: number;
  envelope_kind: string;
  delivery_id: string | null;
  repository_id: number | null;
  pull_request_number: number | null;
  quarantine_reason: string | null;
  state: string;
  cycle_count: number;
  replay_count: number;
  first_captured_at: string;
  last_captured_at: string;
  active_command_id: string | null;
}

interface ReplayCommandRow {
  command_json: string;
}

interface ReplayItemRow {
  command_id: string;
  entry_id: string;
  state: string;
}

interface ReplayUnresolvedRow {
  entry_id: string;
  entry_state: string;
  replay_count: number;
}

interface ReplayCandidateRow extends EntryRow {
  command_item_state: string;
}

interface EntrySummaryRow {
  entry_id: string;
  body_digest: string;
  byte_length: number;
  envelope_kind: string;
  delivery_id: string | null;
  repository_id: number | null;
  pull_request_number: number | null;
  quarantine_reason: string | null;
  state: string;
  cycle_count: number;
  replay_count: number;
  first_captured_at: string;
  last_captured_at: string;
  source_queue: string;
  source_message_id: string;
  source_timestamp: string;
  source_attempts: number;
}

interface GitHubScanRow {
  generation: number;
  scan_id: string;
  command_id: string;
  command_json: string;
  principal: string;
  state: string;
  scan_started_at: string;
  lease_expires_at: string;
  checkpoint_before: string | null;
  coverage_mode: string;
  takeover: number;
  provider_window_start: string;
  coverage_status: string;
  coverage_from: string;
  gap_reason: string | null;
  gap_from: string | null;
  gap_to: string | null;
  last_delivered_at: string | null;
  last_attempt_id: number | null;
  page_count: number;
  attempt_count: number;
  completed_at: string | null;
  superseded_at: string | null;
  superseded_by_generation: number | null;
}

interface GitHubPageRow {
  receipt_json: string;
}

interface GitHubAttemptRow {
  attempt_id: number;
  guid: string;
  delivered_at: string;
  status: string;
  redelivery: number;
}

interface GitHubIntentRow {
  intent_id: string;
  generation: number;
  guid: string;
  selected_attempt_id: number;
  selected_delivered_at: string;
  redelivery_count: number;
  state: string;
  prepared_at: string;
  dispatch_started_at: string | null;
  settled_at: string | null;
  outcome_reason: string | null;
  retry_after: string | null;
}

interface GitHubCandidateRow {
  attempt_id: number;
  guid: string;
  delivered_at: string;
  redelivery_count: number;
}

const cursorStartKey = '';
const legacyDeliveryRecoveryLedgerSchemaVersion = 1;
const deliveryRecoveryEntryColumns = [
  ['entry_id', 'TEXT', 0, 1],
  ['body_digest', 'TEXT', 1, 0],
  ['body', 'TEXT', 1, 0],
  ['byte_length', 'INTEGER', 1, 0],
  ['eligible', 'INTEGER', 1, 0],
  ['envelope_kind', 'TEXT', 1, 0],
  ['delivery_id', 'TEXT', 0, 0],
  ['repository_id', 'INTEGER', 0, 0],
  ['pull_request_number', 'INTEGER', 0, 0],
  ['quarantine_reason', 'TEXT', 0, 0],
  ['state', 'TEXT', 1, 0],
  ['cycle_count', 'INTEGER', 1, 0],
  ['replay_count', 'INTEGER', 1, 0],
  ['first_captured_at', 'TEXT', 1, 0],
  ['last_captured_at', 'TEXT', 1, 0],
  ['active_command_id', 'TEXT', 0, 0],
] as const;
const deliveryRecoveryEnvelopeKindsV2 = [
  'scope-work-item-v1',
  'scope-work-item-v2',
  'installation-repository-child-v1',
  'installation-index-bootstrap-v1',
  'work-item-v1',
  'work-item-v2',
  'work-item-v3',
  'work-item-v4',
  'work-item-v5',
  'quarantined',
] as const;

function createDeliveryRecoveryEntriesTable(
  sql: SqlStorage,
  table:
    | 'delivery_recovery_entries'
    | 'delivery_recovery_entries_v2',
  ifNotExists: boolean,
): void {
  const existenceClause = ifNotExists ? 'IF NOT EXISTS ' : '';
  sql.exec(`
    CREATE TABLE ${existenceClause}${table} (
      entry_id TEXT PRIMARY KEY,
      body_digest TEXT NOT NULL,
      body TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      envelope_kind TEXT NOT NULL CHECK (
        envelope_kind IN (
          'scope-work-item-v1',
          'scope-work-item-v2',
          'installation-repository-child-v1',
          'installation-index-bootstrap-v1',
          'work-item-v1',
          'work-item-v2',
          'work-item-v3',
          'work-item-v4',
          'work-item-v5',
          'quarantined'
        )
      ),
      delivery_id TEXT,
      repository_id INTEGER,
      pull_request_number INTEGER,
      quarantine_reason TEXT,
      state TEXT NOT NULL CHECK (
        state IN (
          'pending',
          'enqueued',
          'unknown',
          'action-required',
          'quarantined'
        )
      ),
      cycle_count INTEGER NOT NULL,
      replay_count INTEGER NOT NULL,
      first_captured_at TEXT NOT NULL,
      last_captured_at TEXT NOT NULL,
      active_command_id TEXT
    )
  `);
}

/**
 * Global recovery state only. Queue sends and GitHub calls are deliberately
 * performed by the caller after an intent has committed here.
 */
export class DeliveryRecoveryLedger extends DurableObject {
  readonly #ctx: DeliveryRecoveryDurableObjectState;

  constructor(ctx: DeliveryRecoveryDurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;
    const objectName = ctx.id.name;
    if (objectName === undefined) {
      throw new TypeError(
        'DeliveryRecoveryLedger must be addressed with idFromName().',
      );
    }
    assertDeliveryRecoveryLedgerName(objectName);
    this.#initializeSchema();
  }

  async captureDlq(value: unknown): Promise<DeliveryRecoveryCaptureResult> {
    const input = parseDeliveryRecoveryCaptureInput(value);
    const bodyBytes = new TextEncoder().encode(input.body);
    if (bodyBytes.byteLength !== input.byteLength) {
      throw new TypeError('DLQ capture.byteLength does not match body UTF-8.');
    }
    const digest = await sha256Hex(bodyBytes);
    if (
      digest !== input.bodyDigest
      || input.entryId !== input.bodyDigest
    ) {
      throw new TypeError(
        'DLQ capture entryId and bodyDigest must equal SHA-256(body UTF-8).',
      );
    }

    return this.#ctx.storage.transactionSync(() => {
      const existing = this.#loadEntry(input.entryId);
      const repeatedSource = this.#captureSourceWasSeen(
        input.entryId,
        input.sourceQueue,
        input.sourceMessageId,
      );
      if (existing === undefined) {
        const state: DeliveryRecoveryEntryState = input.eligible
          ? 'pending'
          : 'quarantined';
        this.#ctx.storage.sql.exec(
          `INSERT INTO delivery_recovery_entries (
             entry_id,
             body_digest,
             body,
             byte_length,
             eligible,
             envelope_kind,
             delivery_id,
             repository_id,
             pull_request_number,
             quarantine_reason,
             state,
             cycle_count,
             replay_count,
             first_captured_at,
             last_captured_at,
             active_command_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)`,
          input.entryId,
          input.bodyDigest,
          input.body,
          input.byteLength,
          input.eligible ? 1 : 0,
          input.envelopeKind,
          input.deliveryId,
          input.repositoryId,
          input.pullRequestNumber,
          input.quarantineReason,
          state,
          input.capturedAt,
          input.capturedAt,
        );
        this.#appendCaptureAudit(input);
        const revision = this.#rotateRevision();
        return {
          status: input.eligible ? 'captured' : 'quarantined',
          entryId: input.entryId,
          state,
          cycleCount: 0,
          replayCount: 0,
          ledgerRevision: revision,
        };
      }

      this.#assertSameCapture(existing, input);
      this.#appendCaptureAudit(input);
      let state = toEntryState(existing.state);
      let cycleCount = existing.cycle_count;
      let status: DeliveryRecoveryCaptureResult['status'] = 'duplicate';

      if (
        input.eligible
        && !repeatedSource
        && (state === 'enqueued' || state === 'unknown')
      ) {
        cycleCount = nextBoundedInteger(cycleCount, 'DLQ cycle count');
        state =
          cycleCount >= maximumDeliveryRecoveryReplayCount
          || existing.replay_count >= maximumDeliveryRecoveryReplayCount
            ? 'action-required'
            : 'pending';
        if (existing.active_command_id !== null) {
          this.#supersedeReplayItem(
            existing.active_command_id,
            input.entryId,
            input.capturedAt,
          );
        }
        this.#ctx.storage.sql.exec(
          `UPDATE delivery_recovery_entries
           SET state = ?,
               cycle_count = ?,
               last_captured_at = ?,
               active_command_id = NULL
           WHERE entry_id = ?`,
          state,
          cycleCount,
          input.capturedAt,
          input.entryId,
        );
        status = 'captured';
      } else {
        this.#ctx.storage.sql.exec(
          `UPDATE delivery_recovery_entries
           SET last_captured_at = ?
           WHERE entry_id = ?`,
          input.capturedAt,
          input.entryId,
        );
      }

      const revision = this.#rotateRevision();
      return {
        status,
        entryId: input.entryId,
        state,
        cycleCount,
        replayCount: existing.replay_count,
        ledgerRevision: revision,
      };
    });
  }

  async inspect(limit = 100): Promise<DeliveryRecoveryInspection> {
    const boundedLimit = assertDeliveryRecoveryInspectLimit(limit);
    return this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      const counts = this.#entryCounts();
      const rows = this.#ctx.storage.sql
        .exec<EntrySummaryRow>(
          `SELECT
             entry.entry_id,
             entry.body_digest,
             entry.byte_length,
             entry.envelope_kind,
             entry.delivery_id,
             entry.repository_id,
             entry.pull_request_number,
             entry.quarantine_reason,
             entry.state,
             entry.cycle_count,
             entry.replay_count,
             entry.first_captured_at,
             entry.last_captured_at,
             audit.source_queue,
             audit.source_message_id,
             audit.source_timestamp,
             audit.attempts AS source_attempts
           FROM delivery_recovery_entries AS entry
           JOIN delivery_recovery_capture_audit AS audit
             ON audit.audit_id = (
               SELECT MAX(latest.audit_id)
               FROM delivery_recovery_capture_audit AS latest
               WHERE latest.entry_id = entry.entry_id
             )
           ORDER BY
             CASE entry.state
               WHEN 'action-required' THEN 0
               WHEN 'unknown' THEN 1
               WHEN 'pending' THEN 2
               WHEN 'quarantined' THEN 3
               ELSE 4
             END,
             entry.last_captured_at DESC,
             entry.entry_id
           LIMIT ?`,
          boundedLimit + 1,
        )
        .toArray();
      const truncated = rows.length > boundedLimit;
      return {
        schemaVersion: deliveryRecoveryLedgerSchemaVersion,
        ledgerRevision: state.revision,
        counts,
        entries: rows.slice(0, boundedLimit).map((row) => ({
          entryId: row.entry_id,
          bodyDigest: row.body_digest,
          byteLength: nonNegativeInteger(row.byte_length, 'byte_length'),
          envelopeKind: toEnvelopeKind(row.envelope_kind),
          deliveryId: row.delivery_id,
          repositoryId: nullablePositiveInteger(
            row.repository_id,
            'repository_id',
          ),
          pullRequestNumber: nullablePositiveInteger(
            row.pull_request_number,
            'pull_request_number',
          ),
          quarantineReason: row.quarantine_reason,
          state: toEntryState(row.state),
          cycleCount: nonNegativeInteger(
            row.cycle_count,
            'cycle_count',
          ),
          replayCount: nonNegativeInteger(
            row.replay_count,
            'replay_count',
          ),
          firstCapturedAt: row.first_captured_at,
          lastCapturedAt: row.last_captured_at,
          latestSource: {
            queue: row.source_queue,
            messageId: row.source_message_id,
            timestamp: row.source_timestamp,
            attempts: positiveInteger(
              row.source_attempts,
              'source_attempts',
            ),
          },
        })),
        truncated,
      };
    });
  }

  async authorizeReplay(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayAuthorizationResult> {
    const command = parseDeliveryRecoveryReplayAuthorizationCommand(value);
    const commandJson = canonicalReplayAuthorizationCommandJson(command);
    return this.#ctx.storage.transactionSync(() => {
      const existing = this.#ctx.storage.sql
        .exec<ReplayCommandRow>(
          `SELECT command_json
           FROM delivery_recovery_replay_commands
           WHERE command_id = ?`,
          command.commandId,
        )
        .toArray()[0];
      if (existing !== undefined) {
        if (existing.command_json !== commandJson) {
          throw new DeliveryRecoveryConflictError(
            'command-binding-conflict',
            'Replay commandId is already bound to a different command.',
          );
        }
        return {
          status: 'duplicate',
          commandId: command.commandId,
          entryCount: command.entryIds.length,
          ledgerRevision: this.#loadState().revision,
        };
      }

      const state = this.#loadState();
      if (state.revision !== command.expectedLedgerRevision) {
        throw new DeliveryRecoveryConflictError(
          'ledger-revision-conflict',
          'Replay command expectedLedgerRevision is stale.',
        );
      }
      const entries = command.entryIds.map((entryId) => {
        const entry = this.#loadEntry(entryId);
        if (
          entry === undefined
          || entry.eligible !== 1
          || (
            entry.state !== 'pending'
            && entry.state !== 'unknown'
          )
          || entry.replay_count >= maximumDeliveryRecoveryReplayCount
        ) {
          throw new DeliveryRecoveryConflictError(
            'replay-state-conflict',
            `DLQ entry ${entryId} is not eligible for replay.`,
          );
        }
        return entry;
      });

      this.#ctx.storage.sql.exec(
        `INSERT INTO delivery_recovery_replay_commands (
           command_id,
           principal,
           requested_at,
           command_json
         ) VALUES (?, ?, ?, ?)`,
        command.commandId,
        command.principal.accessServiceClientId,
        command.requestedAt,
        commandJson,
      );
      entries.forEach((entry, ordinal) => {
        if (entry.active_command_id !== null) {
          this.#supersedeReplayItem(
            entry.active_command_id,
            entry.entry_id,
            command.requestedAt,
          );
        }
        this.#ctx.storage.sql.exec(
          `INSERT INTO delivery_recovery_replay_items (
             command_id,
             ordinal,
             entry_id,
             state,
             started_at,
             settled_at
           ) VALUES (?, ?, ?, 'authorized', NULL, NULL)`,
          command.commandId,
          ordinal,
          entry.entry_id,
        );
        this.#ctx.storage.sql.exec(
          `UPDATE delivery_recovery_entries
           SET active_command_id = ?
           WHERE entry_id = ?`,
          command.commandId,
          entry.entry_id,
        );
      });
      const revision = this.#rotateRevision();
      return {
        status: 'authorized',
        commandId: command.commandId,
        entryCount: entries.length,
        ledgerRevision: revision,
      };
    });
  }

  async nextReplay(
    commandIdValue: unknown,
  ): Promise<DeliveryRecoveryNextReplayResult> {
    const commandId = assertDeliveryRecoveryCommandId(commandIdValue);
    return this.#ctx.storage.transactionSync(() => {
      this.#requireReplayCommand(commandId);
      const sending = this.#loadReplayCandidate(commandId, 'sending');
      if (sending !== undefined) {
        return this.#readyReplayResult(
          commandId,
          sending,
          this.#loadState().revision,
        );
      }
      const unresolved = this.#ctx.storage.sql
        .exec<ReplayUnresolvedRow>(
          `SELECT
             item.entry_id,
             entry.state AS entry_state,
             entry.replay_count
           FROM delivery_recovery_replay_items AS item
           JOIN delivery_recovery_entries AS entry
             ON entry.entry_id = item.entry_id
           WHERE item.command_id = ? AND item.state = 'unknown'
           ORDER BY item.ordinal`,
          commandId,
        )
        .toArray();
      if (unresolved.length > 0) {
        return {
          status: 'unresolved',
          commandId,
          entries: unresolved.map((row) => {
            const state = toEntryState(row.entry_state);
            if (state !== 'unknown' && state !== 'action-required') {
              throw new Error(
                'Unknown replay intent has an invalid entry state.',
              );
            }
            return {
              entryId: row.entry_id,
              state,
              replayCount: nonNegativeInteger(
                row.replay_count,
                'replay_count',
              ),
            };
          }),
          ledgerRevision: this.#loadState().revision,
        };
      }
      const candidate = this.#loadReplayCandidate(commandId, 'authorized');
      if (candidate === undefined) {
        return {
          status: 'complete',
          commandId,
          ledgerRevision: this.#loadState().revision,
        };
      }
      if (
        candidate.active_command_id !== commandId
        || candidate.eligible !== 1
        || (
          candidate.state !== 'pending'
          && candidate.state !== 'unknown'
        )
        || candidate.replay_count >= maximumDeliveryRecoveryReplayCount
      ) {
        throw new DeliveryRecoveryConflictError(
          'replay-state-conflict',
          'Authorized replay entry no longer satisfies its durable fence.',
        );
      }
      const replayCount = nextBoundedInteger(
        candidate.replay_count,
        'DLQ replay count',
      );
      const startedAt = new Date().toISOString();
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_replay_items
         SET state = 'sending',
             started_at = ?
         WHERE command_id = ? AND entry_id = ?`,
        startedAt,
        commandId,
        candidate.entry_id,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_entries
         SET state = 'pending',
             replay_count = ?
         WHERE entry_id = ?`,
        replayCount,
        candidate.entry_id,
      );
      const revision = this.#rotateRevision();
      return this.#readyReplayResult(
        commandId,
        { ...candidate, replay_count: replayCount },
        revision,
      );
    });
  }

  async recordReplayEnqueued(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult> {
    return this.#recordReplayOutcome(value, 'enqueued');
  }

  async recordReplayUnknown(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult> {
    return this.#recordReplayOutcome(value, 'unknown');
  }

  async beginGitHubScan(
    value: unknown,
  ): Promise<GitHubDeliveryScanBeginResult> {
    const command = parseGitHubDeliveryScanCommand(value);
    const commandJson = canonicalGitHubDeliveryScanCommandJson(command);
    return this.#ctx.storage.transactionSync(() => {
      const knownByCommand = this.#ctx.storage.sql
        .exec<GitHubScanRow>(
          `SELECT *
           FROM delivery_recovery_github_scans
           WHERE command_id = ? OR scan_id = ?
           ORDER BY generation
           LIMIT 1`,
          command.commandId,
          command.scanId,
        )
        .toArray()[0];
      if (knownByCommand !== undefined) {
        if (knownByCommand.command_json !== commandJson) {
          throw new DeliveryRecoveryConflictError(
            'scan-binding-conflict',
            'GitHub scan commandId or scanId is already bound differently.',
          );
        }
        const state = this.#loadState();
        return {
          status: knownByCommand.state === 'completed'
            ? 'completed'
            : knownByCommand.state === 'superseded'
              ? 'superseded'
              : 'resumed',
          generation: knownByCommand.generation,
          scanId: knownByCommand.scan_id,
          cursor: knownByCommand.state === 'active'
            ? state.active_cursor
            : null,
          pageCount: knownByCommand.page_count,
          attemptCount: knownByCommand.attempt_count,
          checkpointBefore: knownByCommand.checkpoint_before,
          leaseExpiresAt: knownByCommand.lease_expires_at,
          coverageMode: toCoverageMode(knownByCommand.coverage_mode),
          coverage: coverageFromScan(knownByCommand),
          ledgerRevision: state.revision,
        };
      }

      const state = this.#loadState();
      if (state.revision !== command.expectedLedgerRevision) {
        throw new DeliveryRecoveryConflictError(
          'ledger-revision-conflict',
          'GitHub scan expectedLedgerRevision is stale.',
        );
      }
      if (
        state.github_checkpoint !== null
        && command.scanStartedAt < state.github_checkpoint
      ) {
        throw new DeliveryRecoveryConflictError(
          'coverage-establishment-required',
          'GitHub scanStartedAt precedes the durable checkpoint.',
        );
      }
      const activeScan = state.active_generation === null
        ? undefined
        : this.#requireGitHubScan(
            state.active_generation,
            requireStoredText(state.active_scan_id, 'active_scan_id'),
          );
      if (activeScan !== undefined) {
        const expired =
          command.scanStartedAt >= activeScan.lease_expires_at;
        if (!expired) {
          throw new DeliveryRecoveryConflictError(
            'active-scan-conflict',
            'A different GitHub delivery scan still owns a live lease.',
          );
        }
        if (!command.takeover) {
          throw new DeliveryRecoveryConflictError(
            'scan-takeover-required',
            'Expired GitHub scan takeover must be explicit.',
          );
        }
      } else if (command.takeover) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub scan takeover was requested without an active scan.',
        );
      }
      const coverage = deriveGitHubCoverage(state, command);
      const generation = nextBoundedInteger(
        state.github_generation,
        'GitHub scan generation',
      );
      if (activeScan !== undefined) {
        this.#ctx.storage.sql.exec(
          `UPDATE delivery_recovery_github_scans
           SET state = 'superseded',
               superseded_at = ?,
               superseded_by_generation = ?
           WHERE generation = ?`,
          command.scanStartedAt,
          generation,
          activeScan.generation,
        );
      }
      this.#ctx.storage.sql.exec(
        `INSERT INTO delivery_recovery_github_scans (
           generation,
           scan_id,
           command_id,
           command_json,
           principal,
           requested_at,
           state,
           scan_started_at,
           lease_expires_at,
           checkpoint_before,
           coverage_mode,
           takeover,
           provider_window_start,
           coverage_status,
           coverage_from,
           gap_reason,
           gap_from,
           gap_to,
           last_delivered_at,
           last_attempt_id,
           page_count,
           attempt_count,
           completed_at,
           superseded_at,
           superseded_by_generation
         ) VALUES (
           ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           NULL, NULL, 0, 0, NULL, NULL, NULL
         )`,
        generation,
        command.scanId,
        command.commandId,
        commandJson,
        command.principal.accessServiceClientId,
        command.requestedAt,
        command.scanStartedAt,
        command.leaseExpiresAt,
        state.github_checkpoint,
        command.coverageMode,
        command.takeover ? 1 : 0,
        command.providerWindowStart,
        coverage.status,
        coverage.coverageFrom,
        coverage.gap?.reason ?? null,
        coverage.gap?.from ?? null,
        coverage.gap?.to ?? null,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_state
         SET github_generation = ?,
             active_generation = ?,
             active_command_id = ?,
             active_scan_id = ?,
             active_scan_started_at = ?,
             active_cursor = NULL,
             active_page_count = 0,
             active_attempt_count = 0,
             terminal_page_seen = 0,
             active_lease_expires_at = ?,
             active_coverage_mode = ?,
             active_coverage_from = ?,
             active_provider_window_start = ?,
             active_gap_reason = ?,
             active_gap_from = ?,
             active_gap_to = ?,
             active_last_delivered_at = NULL,
             active_last_attempt_id = NULL
         WHERE singleton = 1`,
        generation,
        generation,
        command.commandId,
        command.scanId,
        command.scanStartedAt,
        command.leaseExpiresAt,
        command.coverageMode,
        coverage.coverageFrom,
        command.providerWindowStart,
        coverage.gap?.reason ?? null,
        coverage.gap?.from ?? null,
        coverage.gap?.to ?? null,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'begun',
        generation,
        scanId: command.scanId,
        cursor: null,
        pageCount: 0,
        attemptCount: 0,
        checkpointBefore: state.github_checkpoint,
        leaseExpiresAt: command.leaseExpiresAt,
        coverageMode: command.coverageMode,
        coverage,
        ledgerRevision: revision,
      };
    });
  }

  async recordGitHubScanPage(
    value: unknown,
  ): Promise<GitHubDeliveryScanPageResult> {
    const page = parseGitHubDeliveryScanPageInput(value);
    const receiptJson = canonicalGitHubDeliveryScanPageJson(page);
    return this.#ctx.storage.transactionSync(() => {
      const scan = this.#requireGitHubScan(page.generation, page.scanId);
      const cursorKey = page.cursor ?? cursorStartKey;
      const knownPage = this.#ctx.storage.sql
        .exec<GitHubPageRow>(
          `SELECT receipt_json
           FROM delivery_recovery_github_pages
           WHERE generation = ? AND cursor_key = ?`,
          page.generation,
          cursorKey,
        )
        .toArray()[0];
      if (knownPage !== undefined) {
        if (knownPage.receipt_json !== receiptJson) {
          throw new DeliveryRecoveryConflictError(
            'page-binding-conflict',
            'GitHub delivery page cursor is bound to another receipt.',
          );
        }
        return {
          status: 'duplicate',
          generation: page.generation,
          scanId: page.scanId,
          pageCount: scan.page_count,
          attemptCount: scan.attempt_count,
          nextCursor: page.nextCursor,
          leaseExpiresAt: scan.lease_expires_at,
          ledgerRevision: this.#loadState().revision,
        };
      }

      const state = this.#loadState();
      if (
        scan.state !== 'active'
        || state.active_generation !== page.generation
        || state.active_scan_id !== page.scanId
        || state.terminal_page_seen === 1
        || state.active_cursor !== page.cursor
      ) {
        throw new DeliveryRecoveryConflictError(
          'page-binding-conflict',
          'GitHub delivery page does not match the active cursor fence.',
        );
      }
      const activeLeaseExpiresAt = requireStoredText(
        state.active_lease_expires_at,
        'active_lease_expires_at',
      );
      if (page.recordedAt > activeLeaseExpiresAt) {
        throw new DeliveryRecoveryConflictError(
          'scan-lease-expired',
          'GitHub delivery page arrived after its scan lease expired.',
        );
      }
      if (page.leaseExpiresAt < activeLeaseExpiresAt) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub delivery page cannot shorten the active scan lease.',
        );
      }
      if (
        Date.parse(page.leaseExpiresAt)
        > Date.parse(scan.scan_started_at)
          + maximumGitHubDeliveryScanLeaseMs
      ) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub delivery page cannot extend beyond the scan absolute '
          + 'lease deadline.',
        );
      }
      const firstAttempt = page.attempts[0];
      if (
        firstAttempt !== undefined
        && state.active_last_delivered_at !== null
        && isGitHubAttemptNewerThanBoundary(
          firstAttempt,
          state.active_last_delivered_at,
          requireStoredPositiveInteger(
            state.active_last_attempt_id,
            'active_last_attempt_id',
          ),
        )
      ) {
        throw new DeliveryRecoveryConflictError(
          'page-order-conflict',
          'GitHub delivery page advanced newer than the prior page boundary.',
        );
      }
      const pageCount = nextBoundedInteger(
        state.active_page_count,
        'GitHub scan page count',
      );
      if (pageCount > maximumGitHubDeliveryScanPages) {
        throw new DeliveryRecoveryConflictError(
          'page-binding-conflict',
          'GitHub delivery scan exceeded its page limit.',
        );
      }
      if (
        page.nextCursor !== null
        && this.#githubCursorWasVisited(page.generation, page.nextCursor)
      ) {
        throw new DeliveryRecoveryConflictError(
          'page-order-conflict',
          'GitHub delivery scan cursor cycle detected.',
        );
      }

      let newlyRecordedAttempts = 0;
      for (const attempt of page.attempts) {
        const existingAttempt = this.#ctx.storage.sql
          .exec<GitHubAttemptRow>(
            `SELECT *
             FROM delivery_recovery_github_attempts
             WHERE generation = ? AND attempt_id = ?`,
            page.generation,
            attempt.attemptId,
          )
          .toArray()[0];
        if (existingAttempt !== undefined) {
          if (!sameGitHubAttempt(existingAttempt, attempt)) {
            throw new DeliveryRecoveryConflictError(
              'page-binding-conflict',
              `GitHub delivery attempt ${attempt.attemptId} conflicts `
              + 'with its persisted value.',
            );
          }
          continue;
        }
        newlyRecordedAttempts += 1;
        this.#ctx.storage.sql.exec(
          `INSERT INTO delivery_recovery_github_attempts (
             generation,
             attempt_id,
             guid,
             delivered_at,
             status,
             redelivery
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          page.generation,
          attempt.attemptId,
          attempt.guid,
          attempt.deliveredAt,
          attempt.status,
          attempt.redelivery ? 1 : 0,
        );
        this.#reconcileGitHubRedeliveryIntent(
          page.generation,
          attempt,
          page.recordedAt,
        );
      }
      const attemptCount =
        state.active_attempt_count + newlyRecordedAttempts;
      if (
        !Number.isSafeInteger(attemptCount)
        || attemptCount > maximumGitHubDeliveryScanAttempts
      ) {
        throw new DeliveryRecoveryConflictError(
          'page-binding-conflict',
          'GitHub delivery scan exceeded its attempt limit.',
        );
      }
      const lastAttempt = page.attempts.at(-1);
      const lastDeliveredAt =
        lastAttempt?.deliveredAt ?? state.active_last_delivered_at;
      const lastAttemptId =
        lastAttempt?.attemptId ?? state.active_last_attempt_id;
      this.#ctx.storage.sql.exec(
        `INSERT INTO delivery_recovery_github_pages (
           generation,
           cursor_key,
           page_ordinal,
           receipt_json,
           next_cursor,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        page.generation,
        cursorKey,
        pageCount,
        receiptJson,
        page.nextCursor,
        page.recordedAt,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_github_scans
         SET page_count = ?,
             attempt_count = ?,
             lease_expires_at = ?,
             last_delivered_at = ?,
             last_attempt_id = ?
         WHERE generation = ?`,
        pageCount,
        attemptCount,
        page.leaseExpiresAt,
        lastDeliveredAt,
        lastAttemptId,
        page.generation,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_state
         SET active_cursor = ?,
             active_page_count = ?,
             active_attempt_count = ?,
             terminal_page_seen = ?,
             active_lease_expires_at = ?,
             active_last_delivered_at = ?,
             active_last_attempt_id = ?
         WHERE singleton = 1`,
        page.nextCursor,
        pageCount,
        attemptCount,
        page.nextCursor === null ? 1 : 0,
        page.leaseExpiresAt,
        lastDeliveredAt,
        lastAttemptId,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'recorded',
        generation: page.generation,
        scanId: page.scanId,
        pageCount,
        attemptCount,
        nextCursor: page.nextCursor,
        leaseExpiresAt: page.leaseExpiresAt,
        ledgerRevision: revision,
      };
    });
  }

  async completeGitHubScan(
    value: unknown,
  ): Promise<GitHubDeliveryScanCompletionResult> {
    const completion = parseGitHubDeliveryScanCompletionInput(value);
    return this.#ctx.storage.transactionSync(() => {
      const scan = this.#requireGitHubScan(
        completion.generation,
        completion.scanId,
      );
      const state = this.#loadState();
      if (scan.state === 'completed') {
        const checkpoint = floorProviderTimestamp(scan.scan_started_at);
        return {
          status: 'duplicate',
          generation: scan.generation,
          scanId: scan.scan_id,
          checkpoint,
          pageCount: scan.page_count,
          attemptCount: scan.attempt_count,
          coverage: coverageFromScan(scan),
          ledgerRevision: state.revision,
        };
      }
      if (
        state.active_generation !== completion.generation
        || state.active_scan_id !== completion.scanId
        || state.terminal_page_seen !== 1
      ) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub scan cannot complete before its terminal page is durable.',
        );
      }
      if (
        completion.completedAt
        > requireStoredText(
          state.active_lease_expires_at,
          'active_lease_expires_at',
        )
      ) {
        throw new DeliveryRecoveryConflictError(
          'scan-lease-expired',
          'GitHub scan lease expired before completion.',
        );
      }
      if (completion.completedAt < scan.scan_started_at) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub scan completedAt precedes scanStartedAt.',
        );
      }
      const coverage = coverageFromScan(scan);
      // GitHub's delivery timestamps are second-granular. Persisting the
      // trusted boundary with sub-second precision could skip an attempt from
      // the same provider second on the next scan.
      const checkpoint = floorProviderTimestamp(scan.scan_started_at);
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_github_scans
         SET state = 'completed', completed_at = ?
         WHERE generation = ?`,
        completion.completedAt,
        completion.generation,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_state
         SET github_checkpoint = ?,
             github_coverage_status = ?,
             github_coverage_from = ?,
             github_provider_window_start = ?,
             github_gap_reason = ?,
             github_gap_from = ?,
             github_gap_to = ?,
             active_generation = NULL,
             active_command_id = NULL,
             active_scan_id = NULL,
             active_scan_started_at = NULL,
             active_cursor = NULL,
             active_page_count = 0,
             active_attempt_count = 0,
             terminal_page_seen = 0,
             active_lease_expires_at = NULL,
             active_coverage_mode = NULL,
             active_coverage_from = NULL,
             active_provider_window_start = NULL,
             active_gap_reason = NULL,
             active_gap_from = NULL,
             active_gap_to = NULL,
             active_last_delivered_at = NULL,
             active_last_attempt_id = NULL
         WHERE singleton = 1`,
        checkpoint,
        coverage.status,
        coverage.coverageFrom,
        coverage.providerWindowStart,
        coverage.gap?.reason ?? null,
        coverage.gap?.from ?? null,
        coverage.gap?.to ?? null,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'completed',
        generation: scan.generation,
        scanId: scan.scan_id,
        checkpoint,
        pageCount: scan.page_count,
        attemptCount: scan.attempt_count,
        coverage,
        ledgerRevision: revision,
      };
    });
  }

  async nextGitHubRedelivery(
    value: unknown,
  ): Promise<GitHubNextRedeliveryResult> {
    const input = parseGitHubNextRedeliveryInput(value);
    return this.#ctx.storage.transactionSync(() => {
      const scan = this.#requireGitHubScan(
        input.generation,
        input.scanId,
      );
      if (scan.state !== 'completed') {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub redelivery selection requires a completed scan.',
        );
      }
      const prepared = this.#ctx.storage.sql
        .exec<GitHubIntentRow>(
          `SELECT *
           FROM delivery_recovery_github_redelivery_intents
           WHERE generation = ? AND state IN ('prepared', 'deferred')
           ORDER BY prepared_at, intent_id
           LIMIT 1`,
          input.generation,
        )
        .toArray()[0];
      if (prepared !== undefined) {
        if (
          prepared.state === 'deferred'
          && prepared.retry_after !== null
          && input.preparedAt < prepared.retry_after
        ) {
          const reason = toDeferredReason(prepared.outcome_reason);
          return {
            status: 'deferred',
            generation: input.generation,
            scanId: input.scanId,
            intentId: prepared.intent_id,
            reason,
            retryAfter: prepared.retry_after,
            ledgerRevision: this.#loadState().revision,
          };
        }
        this.#ctx.storage.sql.exec(
          `UPDATE delivery_recovery_github_redelivery_intents
           SET state = 'dispatching',
               dispatch_started_at = ?,
               settled_at = NULL,
               outcome_reason = NULL,
               retry_after = NULL
           WHERE intent_id = ?`,
          input.preparedAt,
          prepared.intent_id,
        );
        const revision = this.#rotateRevision();
        const dispatching = {
          ...prepared,
          state: 'dispatching',
          dispatch_started_at: input.preparedAt,
          outcome_reason: null,
          retry_after: null,
        };
        return this.#readyGitHubRedelivery(
          input.scanId,
          dispatching,
          revision,
        );
      }

      const candidate = this.#ctx.storage.sql
        .exec<GitHubCandidateRow>(
          `SELECT
             attempt.attempt_id,
             attempt.guid,
             attempt.delivered_at,
             (
               SELECT COUNT(*)
               FROM delivery_recovery_github_redelivery_intents AS counted
               WHERE counted.guid = attempt.guid
                  AND (
                    counted.state IN (
                      'prepared',
                      'dispatching',
                      'accepted',
                      'unknown',
                      'rejected'
                    )
                    OR (
                      counted.state = 'reconciled'
                      AND (
                        counted.outcome_reason IS NULL
                        OR counted.outcome_reason IN (
                          'invalid-request',
                          'provider-rejected'
                        )
                      )
                    )
                 )
             ) AS redelivery_count
           FROM delivery_recovery_github_attempts AS attempt
           WHERE attempt.generation = ?
             AND attempt.status <> 'OK'
             AND NOT EXISTS (
               SELECT 1
               FROM delivery_recovery_github_attempts AS successful
               WHERE successful.guid = attempt.guid
                 AND successful.status = 'OK'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM delivery_recovery_github_attempts AS newer
               WHERE newer.generation = attempt.generation
                 AND newer.guid = attempt.guid
                 AND (
                   newer.delivered_at > attempt.delivered_at
                   OR (
                     newer.delivered_at = attempt.delivered_at
                     AND newer.attempt_id > attempt.attempt_id
                   )
                 )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM delivery_recovery_github_redelivery_intents AS same_scan
               WHERE same_scan.generation = attempt.generation
                 AND same_scan.guid = attempt.guid
             )
             AND NOT EXISTS (
               SELECT 1
               FROM delivery_recovery_github_redelivery_intents AS unresolved
               WHERE unresolved.guid = attempt.guid
                  AND (
                    unresolved.state IN (
                      'prepared',
                      'dispatching',
                      'accepted',
                      'unknown',
                      'rejected'
                    )
                   OR (
                     unresolved.generation = attempt.generation
                     AND unresolved.state = 'deferred'
                   )
                 )
             )
             AND (
               SELECT COUNT(*)
               FROM delivery_recovery_github_redelivery_intents AS bounded
               WHERE bounded.guid = attempt.guid
                  AND (
                    bounded.state IN (
                      'prepared',
                      'dispatching',
                      'accepted',
                      'unknown',
                      'rejected'
                    )
                    OR (
                      bounded.state = 'reconciled'
                      AND (
                        bounded.outcome_reason IS NULL
                        OR bounded.outcome_reason IN (
                          'invalid-request',
                          'provider-rejected'
                        )
                      )
                    )
                 )
             ) < ?
           ORDER BY attempt.delivered_at, attempt.attempt_id
           LIMIT 1`,
          input.generation,
          maximumGitHubRedeliveriesPerGuid,
        )
        .toArray()[0];
      if (candidate === undefined) {
        const counts = this.#githubRedeliveryUnresolvedCounts(
          input.generation,
          true,
        );
        if (counts.total > 0) {
          return {
            status: 'unresolved',
            generation: input.generation,
            scanId: input.scanId,
            counts,
            ledgerRevision: this.#loadState().revision,
          };
        }
        return {
          status: 'complete',
          generation: input.generation,
          scanId: input.scanId,
          ledgerRevision: this.#loadState().revision,
        };
      }

      const intentId = crypto.randomUUID();
      const redeliveryCount = nextBoundedInteger(
        candidate.redelivery_count,
        'GitHub GUID redelivery count',
      );
      this.#ctx.storage.sql.exec(
        `INSERT INTO delivery_recovery_github_redelivery_intents (
           intent_id,
           generation,
           guid,
           selected_attempt_id,
           selected_delivered_at,
           redelivery_count,
           state,
           prepared_at,
           dispatch_started_at,
           settled_at,
           observed_attempt_id,
           outcome_reason,
           retry_after
         ) VALUES (
           ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, NULL, NULL, NULL, NULL
         )`,
        intentId,
        input.generation,
        candidate.guid,
        candidate.attempt_id,
        candidate.delivered_at,
        redeliveryCount,
        input.preparedAt,
        input.preparedAt,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'ready',
        generation: input.generation,
        scanId: input.scanId,
        intentId,
        guid: candidate.guid,
        deliveryAttemptId: candidate.attempt_id,
        redeliveryCount,
        ledgerRevision: revision,
      };
    });
  }

  async recordGitHubRedeliveryAccepted(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult> {
    return this.#recordGitHubRedeliveryOutcome(value, 'accepted');
  }

  async recordGitHubRedeliveryUnknown(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult> {
    return this.#recordGitHubRedeliveryOutcome(value, 'unknown');
  }

  async recordGitHubRedeliveryDeferred(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult> {
    const input = parseGitHubRedeliveryDeferredInput(value);
    return this.#recordGitHubRedeliveryDefinitiveOutcome(
      input,
      'deferred',
      input.reason,
      input.retryAfter,
    );
  }

  async recordGitHubRedeliveryRejected(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult> {
    const input = parseGitHubRedeliveryRejectedInput(value);
    return this.#recordGitHubRedeliveryDefinitiveOutcome(
      input,
      'rejected',
      input.reason,
      null,
    );
  }

  async inspectGitHubScan(): Promise<GitHubDeliveryScanInspection> {
    return this.#ctx.storage.transactionSync(() => {
      const state = this.#loadState();
      const redeliveryIntents =
        this.#githubRedeliveryUnresolvedCounts();
      const unresolvedRedeliveries =
        this.#githubUnresolvedRedeliveries();
      return {
        generation: nonNegativeInteger(
          state.github_generation,
          'github_generation',
        ),
        checkpoint: state.github_checkpoint,
        coverage: coverageFromLedgerState(state),
        active: state.active_generation === null
          ? null
          : {
              commandId: requireStoredText(
                state.active_command_id,
                'active_command_id',
              ),
              scanId: requireStoredText(
                state.active_scan_id,
                'active_scan_id',
              ),
              scanStartedAt: requireStoredText(
                state.active_scan_started_at,
                'active_scan_started_at',
              ),
              cursor: state.active_cursor,
              pageCount: nonNegativeInteger(
                state.active_page_count,
                'active_page_count',
              ),
              attemptCount: nonNegativeInteger(
                state.active_attempt_count,
                'active_attempt_count',
              ),
              terminalPageSeen: booleanInteger(
                state.terminal_page_seen,
                'terminal_page_seen',
              ),
              leaseExpiresAt: requireStoredText(
                state.active_lease_expires_at,
                'active_lease_expires_at',
              ),
              coverageMode: toCoverageMode(
                requireStoredText(
                  state.active_coverage_mode,
                  'active_coverage_mode',
                ),
              ),
              coverage: coverageFromActiveLedgerState(state),
            },
        redeliveryIntents,
        unresolvedRedeliveryIntents: redeliveryIntents.total,
        unresolvedRedeliveries,
        ledgerRevision: state.revision,
      };
    });
  }

  #recordReplayOutcome(
    value: unknown,
    outcome: 'enqueued' | 'unknown',
  ): Promise<DeliveryRecoveryReplayOutcomeResult> {
    const input = parseDeliveryRecoveryReplayOutcomeInput(value);
    const result = this.#ctx.storage.transactionSync(() => {
      this.#requireReplayCommand(input.commandId);
      const item = this.#ctx.storage.sql
        .exec<ReplayItemRow>(
          `SELECT command_id, entry_id, state
           FROM delivery_recovery_replay_items
           WHERE command_id = ? AND entry_id = ?`,
          input.commandId,
          input.entryId,
        )
        .toArray()[0];
      if (item === undefined) {
        throw new DeliveryRecoveryConflictError(
          'entry-binding-conflict',
          'Replay outcome does not name an authorized entry.',
        );
      }
      const entry = this.#loadEntry(input.entryId);
      if (entry === undefined) {
        throw new Error('Authorized replay entry is missing.');
      }
      if (item.state === outcome) {
        return {
          status: 'duplicate',
          commandId: input.commandId,
          entryId: input.entryId,
          state: toEntryState(entry.state),
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      const canResolveUnknown =
        outcome === 'enqueued' && item.state === 'unknown';
      if (
        (item.state !== 'sending' && !canResolveUnknown)
        || entry.active_command_id !== input.commandId
      ) {
        return {
          status: 'stale',
          commandId: input.commandId,
          entryId: input.entryId,
          state: toEntryState(entry.state),
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      const entryState: DeliveryRecoveryEntryState =
        outcome === 'unknown'
        && entry.replay_count >= maximumDeliveryRecoveryReplayCount
          ? 'action-required'
          : outcome;
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_replay_items
         SET state = ?, settled_at = ?
         WHERE command_id = ? AND entry_id = ?`,
        outcome,
        input.recordedAt,
        input.commandId,
        input.entryId,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_entries
         SET state = ?, active_command_id = NULL
         WHERE entry_id = ?`,
        entryState,
        input.entryId,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'recorded',
        commandId: input.commandId,
        entryId: input.entryId,
        state: entryState,
        ledgerRevision: revision,
      } as const;
    });
    return Promise.resolve(result);
  }

  #recordGitHubRedeliveryOutcome(
    value: unknown,
    outcome: 'accepted' | 'unknown',
  ): Promise<GitHubRedeliveryOutcomeResult> {
    const input = parseGitHubRedeliveryOutcomeInput(value);
    const result = this.#ctx.storage.transactionSync(() => {
      const scan = this.#requireGitHubScan(
        input.generation,
        input.scanId,
      );
      if (scan.state !== 'completed') {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub redelivery outcome requires a completed scan.',
        );
      }
      const intent = this.#ctx.storage.sql
        .exec<GitHubIntentRow>(
          `SELECT *
           FROM delivery_recovery_github_redelivery_intents
           WHERE intent_id = ?`,
          input.intentId,
        )
        .toArray()[0];
      if (
        intent === undefined
        || intent.generation !== input.generation
      ) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub redelivery intent does not match the scan.',
        );
      }
      if (intent.state === outcome) {
        return {
          status: 'duplicate',
          generation: input.generation,
          scanId: input.scanId,
          intentId: input.intentId,
          state: outcome,
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      const canResolveUnknown =
        outcome === 'accepted' && intent.state === 'unknown';
      if (
        intent.state !== 'dispatching'
        && !canResolveUnknown
      ) {
        return {
          status: 'stale',
          generation: input.generation,
          scanId: input.scanId,
          intentId: input.intentId,
          state: outcome,
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_github_redelivery_intents
         SET state = ?,
             settled_at = ?,
             outcome_reason = NULL,
             retry_after = NULL
         WHERE intent_id = ?`,
        outcome,
        input.recordedAt,
        input.intentId,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'recorded',
        generation: input.generation,
        scanId: input.scanId,
        intentId: input.intentId,
        state: outcome,
        ledgerRevision: revision,
      } as const;
    });
    return Promise.resolve(result);
  }

  #recordGitHubRedeliveryDefinitiveOutcome(
    input: {
      readonly generation: number;
      readonly scanId: string;
      readonly intentId: string;
      readonly recordedAt: string;
    },
    outcome: 'deferred' | 'rejected',
    reason: string,
    retryAfter: string | null,
  ): Promise<GitHubRedeliveryOutcomeResult> {
    const result = this.#ctx.storage.transactionSync(() => {
      const scan = this.#requireGitHubScan(
        input.generation,
        input.scanId,
      );
      if (scan.state !== 'completed') {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub redelivery outcome requires a completed scan.',
        );
      }
      const intent = this.#ctx.storage.sql
        .exec<GitHubIntentRow>(
          `SELECT *
           FROM delivery_recovery_github_redelivery_intents
           WHERE intent_id = ?`,
          input.intentId,
        )
        .toArray()[0];
      if (
        intent === undefined
        || intent.generation !== input.generation
      ) {
        throw new DeliveryRecoveryConflictError(
          'scan-binding-conflict',
          'GitHub redelivery intent does not match the scan.',
        );
      }
      if (intent.state === outcome) {
        if (
          intent.outcome_reason !== reason
          || intent.retry_after !== retryAfter
        ) {
          throw new DeliveryRecoveryConflictError(
            'command-binding-conflict',
            'GitHub redelivery outcome is already bound differently.',
          );
        }
        return {
          status: 'duplicate',
          generation: input.generation,
          scanId: input.scanId,
          intentId: input.intentId,
          state: outcome,
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      if (
        intent.state !== 'dispatching'
      ) {
        return {
          status: 'stale',
          generation: input.generation,
          scanId: input.scanId,
          intentId: input.intentId,
          state: outcome,
          ledgerRevision: this.#loadState().revision,
        } as const;
      }
      this.#ctx.storage.sql.exec(
        `UPDATE delivery_recovery_github_redelivery_intents
         SET state = ?,
             settled_at = ?,
             outcome_reason = ?,
             retry_after = ?
         WHERE intent_id = ?`,
        outcome,
        input.recordedAt,
        reason,
        retryAfter,
        input.intentId,
      );
      const revision = this.#rotateRevision();
      return {
        status: 'recorded',
        generation: input.generation,
        scanId: input.scanId,
        intentId: input.intentId,
        state: outcome,
        ledgerRevision: revision,
      } as const;
    });
    return Promise.resolve(result);
  }

  #readyReplayResult(
    commandId: string,
    candidate: ReplayCandidateRow,
    ledgerRevision: string,
  ): DeliveryRecoveryNextReplayResult {
    const envelopeKind = toEnvelopeKind(candidate.envelope_kind);
    if (envelopeKind === 'quarantined') {
      throw new Error('A quarantined body reached the replay dispatcher.');
    }
    return {
      status: 'ready',
      commandId,
      entryId: candidate.entry_id,
      bodyDigest: candidate.body_digest,
      body: candidate.body,
      envelopeKind,
      replayCount: nonNegativeInteger(
        candidate.replay_count,
        'replay_count',
      ),
      ledgerRevision,
    };
  }

  #readyGitHubRedelivery(
    scanId: string,
    intent: GitHubIntentRow,
    ledgerRevision: string,
  ): GitHubNextRedeliveryResult {
    return {
      status: 'ready',
      generation: intent.generation,
      scanId,
      intentId: intent.intent_id,
      guid: intent.guid,
      deliveryAttemptId: intent.selected_attempt_id,
      redeliveryCount: positiveInteger(
        intent.redelivery_count,
        'redelivery_count',
      ),
      ledgerRevision,
    };
  }

  #loadEntry(entryId: string): EntryRow | undefined {
    return this.#ctx.storage.sql
      .exec<EntryRow>(
        `SELECT *
         FROM delivery_recovery_entries
         WHERE entry_id = ?`,
        entryId,
      )
      .toArray()[0];
  }

  #loadState(): LedgerStateRow {
    const state = this.#ctx.storage.sql
      .exec<LedgerStateRow>(
        `SELECT *
         FROM delivery_recovery_state
         WHERE singleton = 1`,
      )
      .one();
    assertStoredRevision(state.revision);
    nonNegativeInteger(state.github_generation, 'github_generation');
    nonNegativeInteger(state.active_page_count, 'active_page_count');
    nonNegativeInteger(state.active_attempt_count, 'active_attempt_count');
    booleanInteger(state.terminal_page_seen, 'terminal_page_seen');
    return state;
  }

  #requireReplayCommand(commandId: string): void {
    const count = this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM delivery_recovery_replay_commands
         WHERE command_id = ?`,
        commandId,
      )
      .one().count;
    if (count !== 1) {
      throw new DeliveryRecoveryConflictError(
        'command-binding-conflict',
        'Replay command is not authorized.',
      );
    }
  }

  #loadReplayCandidate(
    commandId: string,
    state: 'authorized' | 'sending',
  ): ReplayCandidateRow | undefined {
    return this.#ctx.storage.sql
      .exec<ReplayCandidateRow>(
        `SELECT
           entry.*,
           item.state AS command_item_state
         FROM delivery_recovery_replay_items AS item
         JOIN delivery_recovery_entries AS entry
           ON entry.entry_id = item.entry_id
         WHERE item.command_id = ? AND item.state = ?
         ORDER BY item.ordinal
         LIMIT 1`,
        commandId,
        state,
      )
      .toArray()[0];
  }

  #captureSourceWasSeen(
    entryId: string,
    sourceQueue: string,
    sourceMessageId: string,
  ): boolean {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM delivery_recovery_capture_audit
         WHERE entry_id = ?
           AND source_queue = ?
           AND source_message_id = ?`,
        entryId,
        sourceQueue,
        sourceMessageId,
      )
      .one().count > 0;
  }

  #appendCaptureAudit(input: DeliveryRecoveryCaptureInput): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO delivery_recovery_capture_audit (
         entry_id,
         source_queue,
         source_message_id,
         source_timestamp,
         attempts,
         captured_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      input.entryId,
      input.sourceQueue,
      input.sourceMessageId,
      input.sourceTimestamp,
      input.attempts,
      input.capturedAt,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM delivery_recovery_capture_audit
       WHERE entry_id = ?
         AND audit_id NOT IN (
           SELECT audit_id
           FROM delivery_recovery_capture_audit
           WHERE entry_id = ?
           ORDER BY audit_id DESC
           LIMIT ?
         )`,
      input.entryId,
      input.entryId,
      maximumDeliveryRecoveryCaptureAuditRows,
    );
  }

  #assertSameCapture(
    entry: EntryRow,
    input: DeliveryRecoveryCaptureInput,
  ): void {
    if (
      entry.body_digest !== input.bodyDigest
      || entry.body !== input.body
      || entry.byte_length !== input.byteLength
      || entry.eligible !== (input.eligible ? 1 : 0)
      || entry.envelope_kind !== input.envelopeKind
      || entry.delivery_id !== input.deliveryId
      || entry.repository_id !== input.repositoryId
      || entry.pull_request_number !== input.pullRequestNumber
      || entry.quarantine_reason !== input.quarantineReason
    ) {
      throw new DeliveryRecoveryConflictError(
        'entry-binding-conflict',
        'DLQ entryId is already bound to different body metadata.',
      );
    }
  }

  #supersedeReplayItem(
    commandId: string,
    entryId: string,
    settledAt: string,
  ): void {
    this.#ctx.storage.sql.exec(
      `UPDATE delivery_recovery_replay_items
       SET state = 'superseded', settled_at = ?
       WHERE command_id = ?
         AND entry_id = ?
         AND state IN ('authorized', 'sending', 'unknown')`,
      settledAt,
      commandId,
      entryId,
    );
  }

  #entryCounts(): DeliveryRecoveryInspection['counts'] {
    const count = (state: DeliveryRecoveryEntryState): number =>
      nonNegativeInteger(
        this.#ctx.storage.sql
          .exec<CountRow>(
            `SELECT COUNT(*) AS count
             FROM delivery_recovery_entries
             WHERE state = ?`,
            state,
          )
          .one().count,
        `${state}_count`,
      );
    return {
      pending: count('pending'),
      enqueued: count('enqueued'),
      unknown: count('unknown'),
      actionRequired: count('action-required'),
      quarantined: count('quarantined'),
    };
  }

  #githubRedeliveryUnresolvedCounts(
    generation?: number,
    includeRelatedHistorical = false,
  ): GitHubRedeliveryUnresolvedCounts {
    const count = (
      intentState:
        | 'prepared'
        | 'dispatching'
        | 'deferred'
        | 'accepted'
        | 'unknown'
        | 'rejected',
    ): number => {
      const row = generation === undefined
        ? this.#ctx.storage.sql
            .exec<CountRow>(
              `SELECT COUNT(*) AS count
               FROM delivery_recovery_github_redelivery_intents
               WHERE state = ?`,
              intentState,
            )
            .one()
        : includeRelatedHistorical
          ? this.#ctx.storage.sql
            .exec<CountRow>(
              `SELECT COUNT(*) AS count
               FROM delivery_recovery_github_redelivery_intents AS intent
               WHERE intent.state = ?
                 AND (
                   intent.generation = ?
                    OR (
                      intent.generation < ?
                      AND intent.state IN (
                        'prepared',
                        'dispatching',
                        'accepted',
                        'unknown',
                        'rejected'
                      )
                     AND EXISTS (
                       SELECT 1
                       FROM delivery_recovery_github_attempts AS current
                       WHERE current.generation = ?
                         AND current.guid = intent.guid
                         AND current.status <> 'OK'
                     )
                     AND NOT EXISTS (
                       SELECT 1
                       FROM delivery_recovery_github_attempts AS successful
                       WHERE successful.guid = intent.guid
                         AND successful.status = 'OK'
                     )
                   )
                 )`,
              intentState,
              generation,
              generation,
              generation,
            )
            .one()
          : this.#ctx.storage.sql
            .exec<CountRow>(
              `SELECT COUNT(*) AS count
               FROM delivery_recovery_github_redelivery_intents
               WHERE state = ? AND generation = ?`,
              intentState,
              generation,
            )
            .one();
      return nonNegativeInteger(
        row.count,
        `github_${intentState}_intent_count`,
      );
    };
    const result = {
      prepared: count('prepared'),
      dispatching: count('dispatching'),
      deferred: count('deferred'),
      accepted: count('accepted'),
      unknown: count('unknown'),
      rejected: count('rejected'),
    };
    return {
      ...result,
      total:
        result.prepared
        + result.dispatching
        + result.deferred
        + result.accepted
        + result.unknown
        + result.rejected,
    };
  }

  #githubUnresolvedRedeliveries():
    GitHubDeliveryScanInspection['unresolvedRedeliveries'] {
    const rows = this.#ctx.storage.sql
      .exec<GitHubIntentRow>(
        `SELECT *
         FROM delivery_recovery_github_redelivery_intents
         WHERE state IN (
           'prepared',
           'dispatching',
           'deferred',
           'rejected',
           'accepted',
           'unknown'
         )
         ORDER BY
           CASE state
             WHEN 'unknown' THEN 0
             WHEN 'dispatching' THEN 1
             WHEN 'rejected' THEN 2
             WHEN 'accepted' THEN 3
             WHEN 'deferred' THEN 4
             WHEN 'prepared' THEN 5
             ELSE 6
           END,
           prepared_at,
           generation,
           intent_id
         LIMIT ?`,
        maximumGitHubUnresolvedRedeliveryInspectionEntries + 1,
      )
      .toArray();
    const truncated =
      rows.length > maximumGitHubUnresolvedRedeliveryInspectionEntries;
    return {
      entries: rows
        .slice(0, maximumGitHubUnresolvedRedeliveryInspectionEntries)
        .map((row) => ({
          intentId: requireStoredText(row.intent_id, 'intent_id'),
          generation: positiveInteger(row.generation, 'generation'),
          guid: requireStoredText(row.guid, 'guid'),
          selectedAttemptId: positiveInteger(
            row.selected_attempt_id,
            'selected_attempt_id',
          ),
          selectedDeliveredAt: requireStoredText(
            row.selected_delivered_at,
            'selected_delivered_at',
          ),
          redeliveryCount: positiveInteger(
            row.redelivery_count,
            'redelivery_count',
          ),
          state: toGitHubUnresolvedRedeliveryState(row.state),
          preparedAt: requireStoredText(row.prepared_at, 'prepared_at'),
          dispatchStartedAt: row.dispatch_started_at,
          settledAt: row.settled_at,
          outcomeReason: row.outcome_reason,
          retryAfter: row.retry_after,
        })),
      truncated,
    };
  }

  #requireGitHubScan(
    generation: number,
    scanId: string,
  ): GitHubScanRow {
    const scan = this.#ctx.storage.sql
      .exec<GitHubScanRow>(
        `SELECT *
         FROM delivery_recovery_github_scans
         WHERE generation = ? AND scan_id = ?`,
        generation,
        scanId,
      )
      .toArray()[0];
    if (scan === undefined) {
      throw new DeliveryRecoveryConflictError(
        'scan-binding-conflict',
        'GitHub delivery scan does not exist.',
      );
    }
    return scan;
  }

  #githubCursorWasVisited(generation: number, cursor: string): boolean {
    return this.#ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM delivery_recovery_github_pages
         WHERE generation = ? AND cursor_key = ?`,
        generation,
        cursor,
      )
      .one().count > 0;
  }

  #reconcileGitHubRedeliveryIntent(
    generation: number,
    attempt: GitHubDeliveryScanPageInput['attempts'][number],
    settledAt: string,
  ): void {
    // A deferred outcome proves that GitHub did not accept the mutation. A
    // later explicit scan may safely supersede that plan, even when it sees
    // the same provider attempt rather than a newly-created attempt.
    this.#ctx.storage.sql.exec(
      `UPDATE delivery_recovery_github_redelivery_intents
       SET state = 'reconciled',
           settled_at = ?,
           observed_attempt_id = ?
       WHERE guid = ?
         AND generation < ?
         AND state = 'deferred'`,
      settledAt,
      attempt.attemptId,
      attempt.guid,
      generation,
    );
    // Possible sends remain fenced until a strictly newer provider attempt is
    // observed. A rejected send follows the same cross-generation rule, but a
    // further failed attempt cannot clear its action-required fence after the
    // per-GUID dispatch budget is exhausted. An exact OK always reconciles it.
    this.#ctx.storage.sql.exec(
      `UPDATE delivery_recovery_github_redelivery_intents
       SET state = 'reconciled',
           settled_at = ?,
           observed_attempt_id = ?
       WHERE guid = ?
         AND state IN ('dispatching', 'accepted', 'unknown', 'rejected')
         AND (
           state <> 'rejected'
           OR ? = 'OK'
           OR redelivery_count < ?
         )
          AND (
            selected_delivered_at < ?
           OR (
             selected_delivered_at = ?
             AND selected_attempt_id < ?
           )
         )`,
      settledAt,
      attempt.attemptId,
      attempt.guid,
      attempt.status,
      maximumGitHubRedeliveriesPerGuid,
      attempt.deliveredAt,
      attempt.deliveredAt,
      attempt.attemptId,
    );
  }

  #rotateRevision(): string {
    const revision = randomRevision();
    this.#ctx.storage.sql.exec(
      `UPDATE delivery_recovery_state
       SET revision = ?
       WHERE singleton = 1`,
      revision,
    );
    return revision;
  }

  #assertSqliteHealth(sql: SqlStorage): void {
    const checks = sql
      .exec<SqliteCheckRow>('PRAGMA quick_check')
      .toArray();
    if (
      checks.length !== 1
      || checks[0]?.quick_check !== 'ok'
    ) {
      throw new Error('Delivery recovery SQLite quick_check failed.');
    }
    if (
      sql.exec<Record<string, SqlValue>>('PRAGMA foreign_key_check')
        .toArray().length !== 0
    ) {
      throw new Error('Delivery recovery SQLite foreign key check failed.');
    }
  }

  #assertEntryTableColumns(sql: SqlStorage): void {
    const columns = sql
      .exec<SqliteTableInfoRow>(
        'PRAGMA table_info(delivery_recovery_entries)',
      )
      .toArray();
    if (columns.length !== deliveryRecoveryEntryColumns.length) {
      throw new Error(
        'Delivery recovery entries table has an unsupported column layout.',
      );
    }
    for (const [index, expected] of
      deliveryRecoveryEntryColumns.entries()) {
      const column = columns[index];
      if (
        column === undefined
        || column.cid !== index
        || column.name !== expected[0]
        || column.type.toUpperCase() !== expected[1]
        || column.notnull !== expected[2]
        || column.pk !== expected[3]
        || column.dflt_value !== null
      ) {
        throw new Error(
          'Delivery recovery entries table has an unsupported column layout.',
        );
      }
    }
  }

  #assertEntryTableIndex(sql: SqlStorage): void {
    const indexes = sql
      .exec<SqliteSchemaRow>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'index'
           AND tbl_name = 'delivery_recovery_entries'
           AND sql IS NOT NULL
         ORDER BY name`,
      )
      .toArray();
    if (
      indexes.length !== 1
      || indexes[0]?.name !== 'delivery_recovery_entries_state'
      || indexes[0].sql === null
      || !indexes[0].sql.includes(
        '(state, last_captured_at, entry_id)',
      )
    ) {
      throw new Error(
        'Delivery recovery entries table has unsupported indexes.',
      );
    }
  }

  #assertEntryTableV2(sql: SqlStorage): void {
    this.#assertEntryTableColumns(sql);
    this.#assertEntryTableIndex(sql);
    const table = sql
      .exec<SqliteSchemaRow>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'table'
           AND name = 'delivery_recovery_entries'`,
      )
      .toArray()[0];
    if (table?.sql === null || table?.sql === undefined) {
      throw new Error('Delivery recovery entries table is missing.');
    }
    for (const kind of deliveryRecoveryEnvelopeKindsV2) {
      if (!table.sql.includes(`'${kind}'`)) {
        throw new Error(
          'Delivery recovery entries table has an unsupported envelope check.',
        );
      }
    }
    for (const requiredConstraint of [
      'CHECK (eligible IN (0, 1))',
      "'pending'",
      "'enqueued'",
      "'unknown'",
      "'action-required'",
    ]) {
      if (!table.sql.includes(requiredConstraint)) {
        throw new Error(
          'Delivery recovery entries table has unsupported constraints.',
        );
      }
    }
  }

  #migrateSchemaV1ToV2(sql: SqlStorage): void {
    this.#assertSqliteHealth(sql);
    this.#assertEntryTableColumns(sql);
    this.#assertEntryTableIndex(sql);
    const staging = sql
      .exec<SqliteSchemaRow>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE name = 'delivery_recovery_entries_v2'`,
      )
      .toArray();
    if (staging.length !== 0) {
      throw new Error(
        'Delivery recovery v2 migration staging table already exists.',
      );
    }
    const referencingTables = sql
      .exec<SqliteSchemaRow>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'table'
           AND sql IS NOT NULL
           AND instr(lower(sql), 'references delivery_recovery_entries') > 0`,
      )
      .toArray();
    if (referencingTables.length !== 0) {
      throw new Error(
        'Delivery recovery v1 schema has unsupported foreign keys.',
      );
    }
    const beforeCount = sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM delivery_recovery_entries',
      )
      .one().count;

    createDeliveryRecoveryEntriesTable(
      sql,
      'delivery_recovery_entries_v2',
      false,
    );
    sql.exec(`
      INSERT INTO delivery_recovery_entries_v2 (
        entry_id,
        body_digest,
        body,
        byte_length,
        eligible,
        envelope_kind,
        delivery_id,
        repository_id,
        pull_request_number,
        quarantine_reason,
        state,
        cycle_count,
        replay_count,
        first_captured_at,
        last_captured_at,
        active_command_id
      )
      SELECT
        entry_id,
        body_digest,
        body,
        byte_length,
        eligible,
        envelope_kind,
        delivery_id,
        repository_id,
        pull_request_number,
        quarantine_reason,
        state,
        cycle_count,
        replay_count,
        first_captured_at,
        last_captured_at,
        active_command_id
      FROM delivery_recovery_entries
    `);
    const copiedCount = sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM delivery_recovery_entries_v2',
      )
      .one().count;
    if (copiedCount !== beforeCount) {
      throw new Error(
        'Delivery recovery v2 migration did not preserve every entry.',
      );
    }
    sql.exec('DROP TABLE delivery_recovery_entries');
    sql.exec(
      `ALTER TABLE delivery_recovery_entries_v2
       RENAME TO delivery_recovery_entries`,
    );
    sql.exec(`
      CREATE INDEX delivery_recovery_entries_state
      ON delivery_recovery_entries (state, last_captured_at, entry_id)
    `);
    sql.exec(
      `UPDATE delivery_recovery_schema
       SET version = ?
       WHERE singleton = 1 AND version = ?`,
      deliveryRecoveryLedgerSchemaVersion,
      legacyDeliveryRecoveryLedgerSchemaVersion,
    );
    const migratedVersion = sql
      .exec<SchemaVersionRow>(
        `SELECT version
         FROM delivery_recovery_schema
         WHERE singleton = 1`,
      )
      .one().version;
    if (migratedVersion !== deliveryRecoveryLedgerSchemaVersion) {
      throw new Error(
        'Delivery recovery v2 migration did not advance schema version.',
      );
    }
    this.#assertEntryTableV2(sql);
    const afterCount = sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM delivery_recovery_entries',
      )
      .one().count;
    if (afterCount !== beforeCount) {
      throw new Error(
        'Delivery recovery v2 migration did not preserve every entry.',
      );
    }
    this.#assertSqliteHealth(sql);
  }

  #initializeSchema(): void {
    this.#ctx.storage.transactionSync(() => {
      const sql = this.#ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);
      const version = sql
        .exec<SchemaVersionRow>(
          `SELECT version
           FROM delivery_recovery_schema
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (version?.version === legacyDeliveryRecoveryLedgerSchemaVersion) {
        this.#migrateSchemaV1ToV2(sql);
      } else if (
        version !== undefined
        && version.version !== deliveryRecoveryLedgerSchemaVersion
      ) {
        throw new Error(
          `Unsupported delivery recovery schema version ${version.version}.`,
        );
      } else if (version !== undefined) {
        this.#assertEntryTableV2(sql);
      }

      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision TEXT NOT NULL,
          github_generation INTEGER NOT NULL,
          github_checkpoint TEXT,
          github_coverage_status TEXT CHECK (
            github_coverage_status IN ('retained-window', 'retention-gap')
          ),
          github_coverage_from TEXT,
          github_provider_window_start TEXT,
          github_gap_reason TEXT CHECK (
            github_gap_reason IN ('checkpoint-missing', 'provider-retention')
          ),
          github_gap_from TEXT,
          github_gap_to TEXT,
          active_generation INTEGER,
          active_command_id TEXT,
          active_scan_id TEXT,
          active_scan_started_at TEXT,
          active_cursor TEXT,
          active_page_count INTEGER NOT NULL,
          active_attempt_count INTEGER NOT NULL,
          terminal_page_seen INTEGER NOT NULL
            CHECK (terminal_page_seen IN (0, 1)),
          active_lease_expires_at TEXT,
          active_coverage_mode TEXT CHECK (
            active_coverage_mode IN ('continue', 'establish')
          ),
          active_coverage_from TEXT,
          active_provider_window_start TEXT,
          active_gap_reason TEXT CHECK (
            active_gap_reason IN ('checkpoint-missing', 'provider-retention')
          ),
          active_gap_from TEXT,
          active_gap_to TEXT,
          active_last_delivered_at TEXT,
          active_last_attempt_id INTEGER
        )
      `);
      createDeliveryRecoveryEntriesTable(
        sql,
        'delivery_recovery_entries',
        true,
      );
      sql.exec(`
        CREATE INDEX IF NOT EXISTS delivery_recovery_entries_state
        ON delivery_recovery_entries (state, last_captured_at, entry_id)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_capture_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id TEXT NOT NULL,
          source_queue TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          source_timestamp TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          captured_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS delivery_recovery_capture_entry
        ON delivery_recovery_capture_audit (entry_id, audit_id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS delivery_recovery_capture_source
        ON delivery_recovery_capture_audit (
          entry_id,
          source_queue,
          source_message_id
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_replay_commands (
          command_id TEXT PRIMARY KEY,
          principal TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          command_json TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_replay_items (
          command_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          entry_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN (
              'authorized',
              'sending',
              'enqueued',
              'unknown',
              'superseded'
            )
          ),
          started_at TEXT,
          settled_at TEXT,
          PRIMARY KEY (command_id, entry_id),
          UNIQUE (command_id, ordinal)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS delivery_recovery_replay_items_state
        ON delivery_recovery_replay_items (command_id, state, ordinal)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_github_scans (
          generation INTEGER PRIMARY KEY,
          scan_id TEXT NOT NULL UNIQUE,
          command_id TEXT NOT NULL UNIQUE,
          command_json TEXT NOT NULL,
          principal TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('active', 'completed', 'superseded')
          ),
          scan_started_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          checkpoint_before TEXT,
          coverage_mode TEXT NOT NULL CHECK (
            coverage_mode IN ('continue', 'establish')
          ),
          takeover INTEGER NOT NULL CHECK (takeover IN (0, 1)),
          provider_window_start TEXT NOT NULL,
          coverage_status TEXT NOT NULL CHECK (
            coverage_status IN ('retained-window', 'retention-gap')
          ),
          coverage_from TEXT NOT NULL,
          gap_reason TEXT CHECK (
            gap_reason IN ('checkpoint-missing', 'provider-retention')
          ),
          gap_from TEXT,
          gap_to TEXT,
          last_delivered_at TEXT,
          last_attempt_id INTEGER,
          page_count INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          completed_at TEXT,
          superseded_at TEXT,
          superseded_by_generation INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_github_pages (
          generation INTEGER NOT NULL,
          cursor_key TEXT NOT NULL,
          page_ordinal INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          next_cursor TEXT,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY (generation, cursor_key),
          UNIQUE (generation, page_ordinal)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS delivery_recovery_github_attempts (
          generation INTEGER NOT NULL,
          attempt_id INTEGER NOT NULL,
          guid TEXT NOT NULL,
          delivered_at TEXT NOT NULL,
          status TEXT NOT NULL,
          redelivery INTEGER NOT NULL CHECK (redelivery IN (0, 1)),
          PRIMARY KEY (generation, attempt_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS delivery_recovery_github_attempts_guid
        ON delivery_recovery_github_attempts (
          generation,
          guid,
          delivered_at,
          attempt_id
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS
          delivery_recovery_github_attempts_guid_status
        ON delivery_recovery_github_attempts (
          guid,
          status,
          generation,
          attempt_id
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS
          delivery_recovery_github_redelivery_intents (
            intent_id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL,
            guid TEXT NOT NULL,
            selected_attempt_id INTEGER NOT NULL,
            selected_delivered_at TEXT NOT NULL,
            redelivery_count INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN (
                'prepared',
                'dispatching',
                'deferred',
                'rejected',
                'accepted',
                'unknown',
                'reconciled'
              )
            ),
            prepared_at TEXT NOT NULL,
            dispatch_started_at TEXT,
            settled_at TEXT,
            observed_attempt_id INTEGER,
            outcome_reason TEXT,
            retry_after TEXT,
            UNIQUE (generation, guid)
          )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS
          delivery_recovery_github_redelivery_guid
        ON delivery_recovery_github_redelivery_intents (guid, state)
      `);

      if (version === undefined) {
        sql.exec(
          `INSERT INTO delivery_recovery_schema (singleton, version)
           VALUES (1, ?)`,
          deliveryRecoveryLedgerSchemaVersion,
        );
      }
      this.#assertEntryTableV2(sql);
      this.#assertSqliteHealth(sql);
      const state = sql
        .exec<LedgerStateRow>(
          `SELECT *
           FROM delivery_recovery_state
           WHERE singleton = 1`,
        )
        .toArray()[0];
      if (state === undefined) {
        sql.exec(
          `INSERT INTO delivery_recovery_state (
             singleton,
             revision,
             github_generation,
             github_checkpoint,
             github_coverage_status,
             github_coverage_from,
             github_provider_window_start,
             github_gap_reason,
             github_gap_from,
             github_gap_to,
             active_generation,
             active_command_id,
             active_scan_id,
             active_scan_started_at,
             active_cursor,
             active_page_count,
             active_attempt_count,
             terminal_page_seen,
             active_lease_expires_at,
             active_coverage_mode,
             active_coverage_from,
             active_provider_window_start,
             active_gap_reason,
             active_gap_from,
             active_gap_to,
             active_last_delivered_at,
             active_last_attempt_id
           ) VALUES (
             1, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL
           )`,
          randomRevision(),
        );
      } else {
        this.#loadState();
      }
    });
  }
}

function sameGitHubAttempt(
  stored: GitHubAttemptRow,
  received: GitHubDeliveryScanPageInput['attempts'][number],
): boolean {
  return (
    stored.attempt_id === received.attemptId
    && stored.guid === received.guid
    && stored.delivered_at === received.deliveredAt
    && stored.status === received.status
    && stored.redelivery === (received.redelivery ? 1 : 0)
  );
}

function toEntryState(value: string): DeliveryRecoveryEntryState {
  if (
    value !== 'pending'
    && value !== 'enqueued'
    && value !== 'unknown'
    && value !== 'action-required'
    && value !== 'quarantined'
  ) {
    throw new Error(`Unsupported delivery recovery entry state ${value}.`);
  }
  return value;
}

function toEnvelopeKind(
  value: string,
):
  | 'scope-work-item-v1'
  | 'scope-work-item-v2'
  | 'installation-repository-child-v1'
  | 'installation-index-bootstrap-v1'
  | 'work-item-v1'
  | 'work-item-v2'
  | 'work-item-v3'
  | 'work-item-v4'
  | 'work-item-v5'
  | 'quarantined' {
  if (
    value !== 'scope-work-item-v1'
    && value !== 'scope-work-item-v2'
    && value !== 'installation-repository-child-v1'
    && value !== 'installation-index-bootstrap-v1'
    && value !== 'work-item-v1'
    && value !== 'work-item-v2'
    && value !== 'work-item-v3'
    && value !== 'work-item-v4'
    && value !== 'work-item-v5'
    && value !== 'quarantined'
  ) {
    throw new Error(`Unsupported captured envelope kind ${value}.`);
  }
  return value;
}

function randomRevision(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let revision = '';
  for (const byte of bytes) {
    revision += byte.toString(16).padStart(2, '0');
  }
  return revision;
}

async function sha256Hex(
  bytes: Uint8Array<ArrayBufferLike>,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
  );
  let value = '';
  for (const byte of digest) {
    value += byte.toString(16).padStart(2, '0');
  }
  return value;
}

function assertStoredRevision(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Persisted delivery recovery revision is invalid.');
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function nullablePositiveInteger(
  value: number | null,
  field: string,
): number | null {
  return value === null ? null : positiveInteger(value, field);
}

function booleanInteger(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`${field} must be stored as 0 or 1.`);
  }
  return value === 1;
}

function nextBoundedInteger(value: number, field: string): number {
  const current = nonNegativeInteger(value, field);
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`${field} is exhausted.`);
  }
  return next;
}

function requireStoredText(
  value: string | null,
  field: string,
): string {
  if (value === null) {
    throw new Error(`Persisted ${field} is absent.`);
  }
  return value;
}

function requireStoredPositiveInteger(
  value: number | null,
  field: string,
): number {
  if (value === null) {
    throw new Error(`Persisted ${field} is absent.`);
  }
  return positiveInteger(value, field);
}

function toCoverageMode(value: string): 'continue' | 'establish' {
  if (value !== 'continue' && value !== 'establish') {
    throw new Error(`Unsupported GitHub coverage mode ${value}.`);
  }
  return value;
}

function floorProviderTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Persisted GitHub timestamp is invalid.');
  }
  return new Date(Math.floor(parsed / 1_000) * 1_000).toISOString();
}

function toDeferredReason(
  value: string | null,
):
  | 'control-revision-conflict'
  | 'control-unavailable'
  | 'rate-limited' {
  if (
    value !== 'control-revision-conflict'
    && value !== 'control-unavailable'
    && value !== 'rate-limited'
  ) {
    throw new Error('Persisted GitHub deferral reason is invalid.');
  }
  return value;
}

function toGitHubUnresolvedRedeliveryState(
  value: string,
): GitHubUnresolvedRedeliveryState {
  if (
    value !== 'prepared'
    && value !== 'dispatching'
    && value !== 'deferred'
    && value !== 'rejected'
    && value !== 'accepted'
    && value !== 'unknown'
  ) {
    throw new Error(
      `Unsupported unresolved GitHub redelivery state ${value}.`,
    );
  }
  return value;
}

function deriveGitHubCoverage(
  state: LedgerStateRow,
  command: GitHubDeliveryScanCommand,
): GitHubDeliveryCoverage {
  const checkpoint = state.github_checkpoint;
  if (
    checkpoint === null
    || checkpoint < command.providerWindowStart
  ) {
    if (command.coverageMode !== 'establish') {
      throw new DeliveryRecoveryConflictError(
        'coverage-establishment-required',
        checkpoint === null
          ? 'Initial GitHub coverage requires explicit establishment.'
          : 'GitHub checkpoint fell outside the provider retention window.',
      );
    }
    return {
      status: 'retention-gap',
      coverageFrom: command.providerWindowStart,
      providerWindowStart: command.providerWindowStart,
      gap: {
        reason: checkpoint === null
          ? 'checkpoint-missing'
          : 'provider-retention',
        from: checkpoint,
        to: command.providerWindowStart,
      },
    };
  }

  const priorCoverage = coverageFromLedgerState(state);
  if (priorCoverage?.status === 'retention-gap') {
    return {
      status: 'retention-gap',
      coverageFrom: priorCoverage.coverageFrom,
      providerWindowStart: command.providerWindowStart,
      gap: { ...priorCoverage.gap },
    };
  }

  return {
    status: 'retained-window',
    coverageFrom: checkpoint,
    providerWindowStart: command.providerWindowStart,
    gap: null,
  };
}

function coverageFromScan(scan: GitHubScanRow): GitHubDeliveryCoverage {
  if (scan.coverage_status === 'retained-window') {
    if (
      scan.gap_reason !== null
      || scan.gap_from !== null
      || scan.gap_to !== null
    ) {
      throw new Error('Retained GitHub scan persisted unexpected gap data.');
    }
    return {
      status: 'retained-window',
      coverageFrom: scan.coverage_from,
      providerWindowStart: scan.provider_window_start,
      gap: null,
    };
  }
  if (
    scan.coverage_status !== 'retention-gap'
    || (
      scan.gap_reason !== 'checkpoint-missing'
      && scan.gap_reason !== 'provider-retention'
    )
    || scan.gap_to === null
  ) {
    throw new Error('Persisted GitHub scan coverage is invalid.');
  }
  return {
    status: 'retention-gap',
    coverageFrom: scan.coverage_from,
    providerWindowStart: scan.provider_window_start,
    gap: {
      reason: scan.gap_reason,
      from: scan.gap_from,
      to: scan.gap_to,
    },
  };
}

function coverageFromLedgerState(
  state: LedgerStateRow,
): GitHubDeliveryCoverage | null {
  if (state.github_coverage_status === null) {
    if (
      state.github_coverage_from !== null
      || state.github_provider_window_start !== null
      || state.github_gap_reason !== null
      || state.github_gap_from !== null
      || state.github_gap_to !== null
    ) {
      throw new Error('Empty GitHub coverage persisted partial data.');
    }
    return null;
  }
  const coverageFrom = requireStoredText(
    state.github_coverage_from,
    'github_coverage_from',
  );
  const providerWindowStart = requireStoredText(
    state.github_provider_window_start,
    'github_provider_window_start',
  );
  if (state.github_coverage_status === 'retained-window') {
    if (
      state.github_gap_reason !== null
      || state.github_gap_from !== null
      || state.github_gap_to !== null
    ) {
      throw new Error('Retained GitHub coverage persisted unexpected gap.');
    }
    return {
      status: 'retained-window',
      coverageFrom,
      providerWindowStart,
      gap: null,
    };
  }
  if (
    state.github_coverage_status !== 'retention-gap'
    || (
      state.github_gap_reason !== 'checkpoint-missing'
      && state.github_gap_reason !== 'provider-retention'
    )
    || state.github_gap_to === null
  ) {
    throw new Error('Persisted GitHub coverage is invalid.');
  }
  return {
    status: 'retention-gap',
    coverageFrom,
    providerWindowStart,
    gap: {
      reason: state.github_gap_reason,
      from: state.github_gap_from,
      to: state.github_gap_to,
    },
  };
}

function coverageFromActiveLedgerState(
  state: LedgerStateRow,
): GitHubDeliveryCoverage {
  const coverageFrom = requireStoredText(
    state.active_coverage_from,
    'active_coverage_from',
  );
  const providerWindowStart = requireStoredText(
    state.active_provider_window_start,
    'active_provider_window_start',
  );
  if (state.active_gap_reason === null) {
    if (state.active_gap_from !== null || state.active_gap_to !== null) {
      throw new Error('Active retained coverage persisted unexpected gap.');
    }
    return {
      status: 'retained-window',
      coverageFrom,
      providerWindowStart,
      gap: null,
    };
  }
  if (
    (
      state.active_gap_reason !== 'checkpoint-missing'
      && state.active_gap_reason !== 'provider-retention'
    )
    || state.active_gap_to === null
  ) {
    throw new Error('Active GitHub coverage gap is invalid.');
  }
  return {
    status: 'retention-gap',
    coverageFrom,
    providerWindowStart,
    gap: {
      reason: state.active_gap_reason,
      from: state.active_gap_from,
      to: state.active_gap_to,
    },
  };
}

function isGitHubAttemptNewerThanBoundary(
  attempt: GitHubDeliveryScanPageInput['attempts'][number],
  deliveredAt: string,
  attemptId: number,
): boolean {
  return (
    attempt.deliveredAt > deliveredAt
    || (
      attempt.deliveredAt === deliveredAt
      && attempt.attemptId > attemptId
    )
  );
}
