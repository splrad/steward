import type {
  CapturedEnvelopeKind,
  ClassifiedDeadLetterBody,
} from './capture.js';

export const deliveryRecoveryLedgerSchemaVersion = 2 as const;
export const deliveryRecoveryLedgerName = 'global-v1';
export const maximumDeliveryRecoveryBodyBytes = 127_000;
export const maximumDeliveryRecoveryCaptureAuditRows = 16;
export const maximumDeliveryRecoveryInspectionEntries = 100;
export const maximumDeliveryRecoveryReplayEntries = 25;
export const maximumDeliveryRecoveryReplayCount = 3;
export const maximumGitHubDeliveryScanPages = 100;
export const maximumGitHubDeliveryScanAttempts = 10_000;
export const maximumGitHubDeliveryPageAttempts = 100;
export const maximumGitHubRedeliveriesPerGuid = 3;
export const maximumGitHubDeliveryStatusLength = 128;
export const maximumGitHubUnresolvedRedeliveryInspectionEntries = 100;
export const maximumGitHubDeliveryScanLeaseMs = 10 * 60 * 1_000;
export const githubProviderRetentionWindowMs = 72 * 60 * 60 * 1_000;
export const githubProviderCoverageSafetyMarginMs = 15 * 60 * 1_000;
export const maximumGitHubProviderCoverageWindowMs =
  githubProviderRetentionWindowMs - githubProviderCoverageSafetyMarginMs;

export const deliveryRecoveryConflictCodes = [
  'active-scan-conflict',
  'command-binding-conflict',
  'coverage-establishment-required',
  'entry-binding-conflict',
  'ledger-revision-conflict',
  'page-binding-conflict',
  'page-order-conflict',
  'replay-state-conflict',
  'scan-binding-conflict',
  'scan-lease-expired',
  'scan-takeover-required',
] as const;

export type DeliveryRecoveryConflictCode =
  (typeof deliveryRecoveryConflictCodes)[number];

export class DeliveryRecoveryConflictError extends Error {
  readonly code: DeliveryRecoveryConflictCode;

  constructor(code: DeliveryRecoveryConflictCode, message: string) {
    super(message);
    this.name = 'DeliveryRecoveryConflictError';
    this.code = code;
  }
}

export type DeliveryRecoveryEntryState =
  | 'pending'
  | 'enqueued'
  | 'unknown'
  | 'action-required'
  | 'quarantined';

export interface DeliveryRecoveryCaptureInput
  extends ClassifiedDeadLetterBody {
  readonly sourceQueue: string;
  readonly sourceMessageId: string;
  readonly sourceTimestamp: string;
  readonly attempts: number;
  readonly capturedAt: string;
}

export interface DeliveryRecoveryCaptureResult {
  readonly status: 'captured' | 'quarantined' | 'duplicate';
  readonly entryId: string;
  readonly state: DeliveryRecoveryEntryState;
  readonly cycleCount: number;
  readonly replayCount: number;
  readonly ledgerRevision: string;
}

export interface DeliveryRecoveryPrincipal {
  readonly accessServiceClientId: string;
}

export interface DeliveryRecoveryReplayAuthorizationCommand {
  readonly commandId: string;
  readonly principal: DeliveryRecoveryPrincipal;
  readonly requestedAt: string;
  readonly entryIds: readonly string[];
  readonly expectedLedgerRevision: string;
}

export interface DeliveryRecoveryReplayAuthorizationResult {
  readonly status: 'authorized' | 'duplicate';
  readonly commandId: string;
  readonly entryCount: number;
  readonly ledgerRevision: string;
}

export interface DeliveryRecoveryReplayReady {
  readonly status: 'ready';
  readonly commandId: string;
  readonly entryId: string;
  readonly bodyDigest: string;
  readonly body: string;
  readonly envelopeKind: Exclude<CapturedEnvelopeKind, 'quarantined'>;
  readonly replayCount: number;
  readonly ledgerRevision: string;
}

export interface DeliveryRecoveryReplayComplete {
  readonly status: 'complete';
  readonly commandId: string;
  readonly ledgerRevision: string;
}

export interface DeliveryRecoveryReplayUnresolved {
  readonly status: 'unresolved';
  readonly commandId: string;
  readonly entries: readonly {
    readonly entryId: string;
    readonly state: 'unknown' | 'action-required';
    readonly replayCount: number;
  }[];
  readonly ledgerRevision: string;
}

export type DeliveryRecoveryNextReplayResult =
  | DeliveryRecoveryReplayReady
  | DeliveryRecoveryReplayUnresolved
  | DeliveryRecoveryReplayComplete;

export interface DeliveryRecoveryReplayOutcomeInput {
  readonly commandId: string;
  readonly entryId: string;
  readonly recordedAt: string;
}

export interface DeliveryRecoveryReplayOutcomeResult {
  readonly status: 'recorded' | 'duplicate' | 'stale';
  readonly commandId: string;
  readonly entryId: string;
  readonly state: DeliveryRecoveryEntryState;
  readonly ledgerRevision: string;
}

export interface DeliveryRecoveryEntrySummary {
  readonly entryId: string;
  readonly bodyDigest: string;
  readonly byteLength: number;
  readonly envelopeKind: CapturedEnvelopeKind;
  readonly deliveryId: string | null;
  readonly repositoryId: number | null;
  readonly pullRequestNumber: number | null;
  readonly quarantineReason: string | null;
  readonly state: DeliveryRecoveryEntryState;
  readonly cycleCount: number;
  readonly replayCount: number;
  readonly firstCapturedAt: string;
  readonly lastCapturedAt: string;
  readonly latestSource: {
    readonly queue: string;
    readonly messageId: string;
    readonly timestamp: string;
    readonly attempts: number;
  };
}

export interface DeliveryRecoveryInspection {
  readonly schemaVersion: typeof deliveryRecoveryLedgerSchemaVersion;
  readonly ledgerRevision: string;
  readonly counts: {
    readonly pending: number;
    readonly enqueued: number;
    readonly unknown: number;
    readonly actionRequired: number;
    readonly quarantined: number;
  };
  readonly entries: readonly DeliveryRecoveryEntrySummary[];
  readonly truncated: boolean;
}

export interface GitHubDeliveryScanCommand {
  readonly commandId: string;
  readonly scanId: string;
  readonly principal: DeliveryRecoveryPrincipal;
  readonly requestedAt: string;
  readonly scanStartedAt: string;
  readonly leaseExpiresAt: string;
  readonly coverageMode: 'continue' | 'establish';
  readonly providerWindowStart: string;
  readonly takeover: boolean;
  readonly expectedLedgerRevision: string;
}

export type GitHubDeliveryCoverage =
  | {
      readonly status: 'retained-window';
      readonly coverageFrom: string;
      readonly providerWindowStart: string;
      readonly gap: null;
    }
  | {
      readonly status: 'retention-gap';
      readonly coverageFrom: string;
      readonly providerWindowStart: string;
      readonly gap: {
        readonly reason: 'checkpoint-missing' | 'provider-retention';
        readonly from: string | null;
        readonly to: string;
      };
    };

export interface GitHubDeliveryScanBeginResult {
  readonly status: 'begun' | 'resumed' | 'completed' | 'superseded';
  readonly generation: number;
  readonly scanId: string;
  readonly cursor: string | null;
  readonly pageCount: number;
  readonly attemptCount: number;
  readonly checkpointBefore: string | null;
  readonly leaseExpiresAt: string;
  readonly coverageMode: 'continue' | 'establish';
  readonly coverage: GitHubDeliveryCoverage;
  readonly ledgerRevision: string;
}

export interface GitHubDeliveryAttempt {
  readonly attemptId: number;
  readonly guid: string;
  readonly deliveredAt: string;
  readonly status: string;
  readonly redelivery: boolean;
}

export interface GitHubDeliveryScanPageInput {
  readonly generation: number;
  readonly scanId: string;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly attempts: readonly GitHubDeliveryAttempt[];
  readonly recordedAt: string;
  readonly leaseExpiresAt: string;
}

export interface GitHubDeliveryScanPageResult {
  readonly status: 'recorded' | 'duplicate';
  readonly generation: number;
  readonly scanId: string;
  readonly pageCount: number;
  readonly attemptCount: number;
  readonly nextCursor: string | null;
  readonly leaseExpiresAt: string;
  readonly ledgerRevision: string;
}

export interface GitHubDeliveryScanCompletionInput {
  readonly generation: number;
  readonly scanId: string;
  readonly completedAt: string;
}

export interface GitHubDeliveryScanCompletionResult {
  readonly status: 'completed' | 'duplicate';
  readonly generation: number;
  readonly scanId: string;
  readonly checkpoint: string;
  readonly pageCount: number;
  readonly attemptCount: number;
  readonly coverage: GitHubDeliveryCoverage;
  readonly ledgerRevision: string;
}

export interface GitHubNextRedeliveryInput {
  readonly generation: number;
  readonly scanId: string;
  readonly preparedAt: string;
}

export interface GitHubRedeliveryReady {
  readonly status: 'ready';
  readonly generation: number;
  readonly scanId: string;
  readonly intentId: string;
  readonly guid: string;
  readonly deliveryAttemptId: number;
  readonly redeliveryCount: number;
  readonly ledgerRevision: string;
}

export interface GitHubRedeliveryComplete {
  readonly status: 'complete';
  readonly generation: number;
  readonly scanId: string;
  readonly ledgerRevision: string;
}

export interface GitHubRedeliveryDeferred {
  readonly status: 'deferred';
  readonly generation: number;
  readonly scanId: string;
  readonly intentId: string;
  readonly reason: GitHubRedeliveryDeferredReason;
  readonly retryAfter: string;
  readonly ledgerRevision: string;
}

export interface GitHubRedeliveryUnresolved {
  readonly status: 'unresolved';
  readonly generation: number;
  readonly scanId: string;
  readonly counts: GitHubRedeliveryUnresolvedCounts;
  readonly ledgerRevision: string;
}

export type GitHubNextRedeliveryResult =
  | GitHubRedeliveryReady
  | GitHubRedeliveryDeferred
  | GitHubRedeliveryUnresolved
  | GitHubRedeliveryComplete;

export interface GitHubRedeliveryOutcomeInput {
  readonly generation: number;
  readonly scanId: string;
  readonly intentId: string;
  readonly recordedAt: string;
}

export interface GitHubRedeliveryOutcomeResult {
  readonly status: 'recorded' | 'duplicate' | 'stale';
  readonly generation: number;
  readonly scanId: string;
  readonly intentId: string;
  readonly state: 'accepted' | 'deferred' | 'rejected' | 'unknown';
  readonly ledgerRevision: string;
}

export type GitHubRedeliveryDeferredReason =
  | 'control-revision-conflict'
  | 'control-unavailable'
  | 'rate-limited';

export type GitHubRedeliveryRejectedReason =
  | 'invalid-request'
  | 'provider-rejected';

export interface GitHubRedeliveryDeferredInput
  extends GitHubRedeliveryOutcomeInput {
  readonly reason: GitHubRedeliveryDeferredReason;
  readonly retryAfter: string;
}

export interface GitHubRedeliveryRejectedInput
  extends GitHubRedeliveryOutcomeInput {
  readonly reason: GitHubRedeliveryRejectedReason;
}

export interface GitHubRedeliveryUnresolvedCounts {
  readonly prepared: number;
  readonly dispatching: number;
  readonly deferred: number;
  readonly accepted: number;
  readonly unknown: number;
  readonly rejected: number;
  readonly total: number;
}

export type GitHubUnresolvedRedeliveryState =
  | 'prepared'
  | 'dispatching'
  | 'deferred'
  | 'rejected'
  | 'accepted'
  | 'unknown';

export interface GitHubUnresolvedRedeliveryInspectionEntry {
  readonly intentId: string;
  readonly generation: number;
  readonly guid: string;
  readonly selectedAttemptId: number;
  readonly selectedDeliveredAt: string;
  readonly redeliveryCount: number;
  readonly state: GitHubUnresolvedRedeliveryState;
  readonly preparedAt: string;
  readonly dispatchStartedAt: string | null;
  readonly settledAt: string | null;
  readonly outcomeReason: string | null;
  readonly retryAfter: string | null;
}

export interface GitHubDeliveryScanInspection {
  readonly generation: number;
  readonly checkpoint: string | null;
  readonly coverage: GitHubDeliveryCoverage | null;
  readonly active: {
    readonly commandId: string;
    readonly scanId: string;
    readonly scanStartedAt: string;
    readonly cursor: string | null;
    readonly pageCount: number;
    readonly attemptCount: number;
    readonly terminalPageSeen: boolean;
    readonly leaseExpiresAt: string;
    readonly coverageMode: 'continue' | 'establish';
    readonly coverage: GitHubDeliveryCoverage;
  } | null;
  readonly redeliveryIntents: GitHubRedeliveryUnresolvedCounts;
  readonly unresolvedRedeliveryIntents: number;
  readonly unresolvedRedeliveries: {
    readonly entries:
      readonly GitHubUnresolvedRedeliveryInspectionEntry[];
    readonly truncated: boolean;
  };
  readonly ledgerRevision: string;
}

type UnknownRecord = Record<string, unknown>;

const canonicalTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;
const printableAsciiPattern = /^[\x20-\x7e]+$/;
const quarantineReasonPattern = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export function assertDeliveryRecoveryLedgerName(value: string): string {
  if (value !== deliveryRecoveryLedgerName) {
    throw new TypeError(
      `DeliveryRecoveryLedger must use idFromName('${deliveryRecoveryLedgerName}').`,
    );
  }
  return value;
}

export function parseDeliveryRecoveryCaptureInput(
  value: unknown,
): DeliveryRecoveryCaptureInput {
  const record = plainRecord(value, 'DLQ capture');
  requireExactKeys(record, [
    'entryId',
    'bodyDigest',
    'body',
    'byteLength',
    'eligible',
    'envelopeKind',
    'deliveryId',
    'repositoryId',
    'pullRequestNumber',
    'quarantineReason',
    'sourceQueue',
    'sourceMessageId',
    'sourceTimestamp',
    'attempts',
    'capturedAt',
  ], 'DLQ capture');

  const body = requireString(record.body, 'DLQ capture.body');
  const byteLength = requireNonNegativeInteger(
    record.byteLength,
    'DLQ capture.byteLength',
  );
  if (byteLength > maximumDeliveryRecoveryBodyBytes) {
    throw new TypeError(
      `DLQ capture.byteLength must not exceed `
      + `${maximumDeliveryRecoveryBodyBytes}.`,
    );
  }
  const entryId = requireSha256(record.entryId, 'DLQ capture.entryId');
  const bodyDigest = requireSha256(
    record.bodyDigest,
    'DLQ capture.bodyDigest',
  );
  const source = {
    sourceQueue: requireVisibleAscii(
      record.sourceQueue,
      'DLQ capture.sourceQueue',
      128,
    ),
    sourceMessageId: requireVisibleAscii(
      record.sourceMessageId,
      'DLQ capture.sourceMessageId',
      128,
    ),
    sourceTimestamp: requireCanonicalTimestamp(
      record.sourceTimestamp,
      'DLQ capture.sourceTimestamp',
    ),
    attempts: requirePositiveInteger(
      record.attempts,
      'DLQ capture.attempts',
    ),
    capturedAt: requireCanonicalTimestamp(
      record.capturedAt,
      'DLQ capture.capturedAt',
    ),
  };

  if (record.eligible === true) {
    const envelopeKind = requireEligibleEnvelopeKind(record.envelopeKind);
    const deliveryId = envelopeKind === 'installation-index-bootstrap-v1'
      ? requireNull(record.deliveryId, 'DLQ capture.deliveryId')
      : requireVisibleAscii(
          record.deliveryId,
          'DLQ capture.deliveryId',
          128,
        );
    const repositoryId =
      (
        envelopeKind === 'scope-work-item-v2'
        || envelopeKind === 'installation-index-bootstrap-v1'
      )
      && record.repositoryId === null
        ? null
        : requirePositiveInteger(
            record.repositoryId,
            'DLQ capture.repositoryId',
          );
    const pullRequestNumber =
      envelopeKind === 'scope-work-item-v1'
        || envelopeKind === 'scope-work-item-v2'
        || envelopeKind === 'installation-repository-child-v1'
        || envelopeKind === 'installation-index-bootstrap-v1'
        ? requireNull(
          record.pullRequestNumber,
          'DLQ capture.pullRequestNumber',
        )
        : requirePositiveInteger(
          record.pullRequestNumber,
          'DLQ capture.pullRequestNumber',
        );
    requireNull(
      record.quarantineReason,
      'DLQ capture.quarantineReason',
    );
    return {
      entryId,
      bodyDigest,
      body,
      byteLength,
      eligible: true,
      envelopeKind,
      deliveryId,
      repositoryId,
      pullRequestNumber,
      quarantineReason: null,
      ...source,
    };
  }

  if (record.eligible !== false || record.envelopeKind !== 'quarantined') {
    throw new TypeError(
      'A quarantined DLQ capture must set eligible=false and '
      + 'envelopeKind=quarantined.',
    );
  }
  requireNull(record.deliveryId, 'DLQ capture.deliveryId');
  requireNull(record.repositoryId, 'DLQ capture.repositoryId');
  requireNull(record.pullRequestNumber, 'DLQ capture.pullRequestNumber');
  const quarantineReason = requireString(
    record.quarantineReason,
    'DLQ capture.quarantineReason',
  );
  if (!quarantineReasonPattern.test(quarantineReason)) {
    throw new TypeError(
      'DLQ capture.quarantineReason must be a bounded lowercase reason code.',
    );
  }
  return {
    entryId,
    bodyDigest,
    body,
    byteLength,
    eligible: false,
    envelopeKind: 'quarantined',
    deliveryId: null,
    repositoryId: null,
    pullRequestNumber: null,
    quarantineReason,
    ...source,
  };
}

export function parseDeliveryRecoveryReplayAuthorizationCommand(
  value: unknown,
): DeliveryRecoveryReplayAuthorizationCommand {
  const record = plainRecord(value, 'replay authorization');
  requireExactKeys(record, [
    'commandId',
    'principal',
    'requestedAt',
    'entryIds',
    'expectedLedgerRevision',
  ], 'replay authorization');
  const principal = parseDeliveryRecoveryPrincipal(record.principal);
  if (
    !Array.isArray(record.entryIds)
    || record.entryIds.length < 1
    || record.entryIds.length > maximumDeliveryRecoveryReplayEntries
  ) {
    throw new TypeError(
      `replay authorization.entryIds must contain 1-`
      + `${maximumDeliveryRecoveryReplayEntries} entries.`,
    );
  }
  const entryIds = record.entryIds.map(
    (entryId, index) => requireSha256(
      entryId,
      `replay authorization.entryIds[${index}]`,
    ),
  );
  if (new Set(entryIds).size !== entryIds.length) {
    throw new TypeError('replay authorization.entryIds must be unique.');
  }
  return {
    commandId: requireUuid(
      record.commandId,
      'replay authorization.commandId',
    ),
    principal,
    requestedAt: requireCanonicalTimestamp(
      record.requestedAt,
      'replay authorization.requestedAt',
    ),
    entryIds: [...entryIds].sort(),
    expectedLedgerRevision: requireSha256(
      record.expectedLedgerRevision,
      'replay authorization.expectedLedgerRevision',
    ),
  };
}

export function parseDeliveryRecoveryReplayOutcomeInput(
  value: unknown,
): DeliveryRecoveryReplayOutcomeInput {
  const record = plainRecord(value, 'replay outcome');
  requireExactKeys(
    record,
    ['commandId', 'entryId', 'recordedAt'],
    'replay outcome',
  );
  return {
    commandId: requireUuid(record.commandId, 'replay outcome.commandId'),
    entryId: requireSha256(record.entryId, 'replay outcome.entryId'),
    recordedAt: requireCanonicalTimestamp(
      record.recordedAt,
      'replay outcome.recordedAt',
    ),
  };
}

export function parseGitHubDeliveryScanCommand(
  value: unknown,
): GitHubDeliveryScanCommand {
  const record = plainRecord(value, 'GitHub delivery scan command');
  requireExactKeys(record, [
    'commandId',
    'scanId',
    'principal',
    'requestedAt',
    'scanStartedAt',
    'leaseExpiresAt',
    'coverageMode',
    'providerWindowStart',
    'takeover',
    'expectedLedgerRevision',
  ], 'GitHub delivery scan command');
  if (
    record.coverageMode !== 'continue'
    && record.coverageMode !== 'establish'
  ) {
    throw new TypeError(
      'GitHub delivery scan command.coverageMode must be '
      + 'continue or establish.',
    );
  }
  if (typeof record.takeover !== 'boolean') {
    throw new TypeError(
      'GitHub delivery scan command.takeover must be a boolean.',
    );
  }
  const scanStartedAt = requireCanonicalTimestamp(
    record.scanStartedAt,
    'GitHub delivery scan command.scanStartedAt',
  );
  const leaseExpiresAt = requireCanonicalTimestamp(
    record.leaseExpiresAt,
    'GitHub delivery scan command.leaseExpiresAt',
  );
  assertLeaseWindow(scanStartedAt, leaseExpiresAt, 'GitHub scan lease');
  const providerWindowStart = requireCanonicalTimestamp(
    record.providerWindowStart,
    'GitHub delivery scan command.providerWindowStart',
  );
  if (providerWindowStart > scanStartedAt) {
    throw new TypeError(
      'GitHub delivery scan providerWindowStart must not follow '
      + 'scanStartedAt.',
    );
  }
  if (
    Date.parse(scanStartedAt) - Date.parse(providerWindowStart)
      > maximumGitHubProviderCoverageWindowMs
  ) {
    throw new TypeError(
      'GitHub delivery scan provider window must reserve the bounded '
      + 'operation safety margin.',
    );
  }
  return {
    commandId: requireUuid(
      record.commandId,
      'GitHub delivery scan command.commandId',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub delivery scan command.scanId',
    ),
    principal: parseDeliveryRecoveryPrincipal(record.principal),
    requestedAt: requireCanonicalTimestamp(
      record.requestedAt,
      'GitHub delivery scan command.requestedAt',
    ),
    scanStartedAt,
    leaseExpiresAt,
    coverageMode: record.coverageMode,
    providerWindowStart,
    takeover: record.takeover,
    expectedLedgerRevision: requireSha256(
      record.expectedLedgerRevision,
      'GitHub delivery scan command.expectedLedgerRevision',
    ),
  };
}

export function parseGitHubDeliveryScanPageInput(
  value: unknown,
): GitHubDeliveryScanPageInput {
  const record = plainRecord(value, 'GitHub delivery scan page');
  requireExactKeys(record, [
    'generation',
    'scanId',
    'cursor',
    'nextCursor',
    'attempts',
    'recordedAt',
    'leaseExpiresAt',
  ], 'GitHub delivery scan page');
  if (
    !Array.isArray(record.attempts)
    || record.attempts.length > maximumGitHubDeliveryPageAttempts
  ) {
    throw new TypeError(
      `GitHub delivery scan page.attempts must contain at most `
      + `${maximumGitHubDeliveryPageAttempts} entries.`,
    );
  }
  const attempts = record.attempts.map(
    (attempt, index) => parseGitHubDeliveryAttempt(
      attempt,
      `GitHub delivery scan page.attempts[${index}]`,
    ),
  );
  const identities = attempts.map((attempt) => attempt.attemptId);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(
      'GitHub delivery scan page contains duplicate attempt IDs.',
    );
  }
  assertDescendingGitHubAttemptOrder(attempts);
  const recordedAt = requireCanonicalTimestamp(
    record.recordedAt,
    'GitHub delivery scan page.recordedAt',
  );
  const leaseExpiresAt = requireCanonicalTimestamp(
    record.leaseExpiresAt,
    'GitHub delivery scan page.leaseExpiresAt',
  );
  assertLeaseWindow(
    recordedAt,
    leaseExpiresAt,
    'GitHub delivery scan page lease',
  );
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub delivery scan page.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub delivery scan page.scanId',
    ),
    cursor: requireNullableCursor(
      record.cursor,
      'GitHub delivery scan page.cursor',
    ),
    nextCursor: requireNullableCursor(
      record.nextCursor,
      'GitHub delivery scan page.nextCursor',
    ),
    attempts,
    recordedAt,
    leaseExpiresAt,
  };
}

export function parseGitHubDeliveryScanCompletionInput(
  value: unknown,
): GitHubDeliveryScanCompletionInput {
  const record = plainRecord(value, 'GitHub delivery scan completion');
  requireExactKeys(
    record,
    ['generation', 'scanId', 'completedAt'],
    'GitHub delivery scan completion',
  );
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub delivery scan completion.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub delivery scan completion.scanId',
    ),
    completedAt: requireCanonicalTimestamp(
      record.completedAt,
      'GitHub delivery scan completion.completedAt',
    ),
  };
}

export function parseGitHubNextRedeliveryInput(
  value: unknown,
): GitHubNextRedeliveryInput {
  const record = plainRecord(value, 'GitHub next redelivery');
  requireExactKeys(
    record,
    ['generation', 'scanId', 'preparedAt'],
    'GitHub next redelivery',
  );
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub next redelivery.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub next redelivery.scanId',
    ),
    preparedAt: requireCanonicalTimestamp(
      record.preparedAt,
      'GitHub next redelivery.preparedAt',
    ),
  };
}

export function parseGitHubRedeliveryOutcomeInput(
  value: unknown,
): GitHubRedeliveryOutcomeInput {
  const record = plainRecord(value, 'GitHub redelivery outcome');
  requireExactKeys(record, [
    'generation',
    'scanId',
    'intentId',
    'recordedAt',
  ], 'GitHub redelivery outcome');
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub redelivery outcome.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub redelivery outcome.scanId',
    ),
    intentId: requireUuid(
      record.intentId,
      'GitHub redelivery outcome.intentId',
    ),
    recordedAt: requireCanonicalTimestamp(
      record.recordedAt,
      'GitHub redelivery outcome.recordedAt',
    ),
  };
}

export function parseGitHubRedeliveryDeferredInput(
  value: unknown,
): GitHubRedeliveryDeferredInput {
  const record = plainRecord(value, 'GitHub redelivery deferred outcome');
  requireExactKeys(record, [
    'generation',
    'scanId',
    'intentId',
    'recordedAt',
    'reason',
    'retryAfter',
  ], 'GitHub redelivery deferred outcome');
  if (
    record.reason !== 'control-revision-conflict'
    && record.reason !== 'control-unavailable'
    && record.reason !== 'rate-limited'
  ) {
    throw new TypeError(
      'GitHub redelivery deferred reason is unsupported.',
    );
  }
  const recordedAt = requireCanonicalTimestamp(
    record.recordedAt,
    'GitHub redelivery deferred outcome.recordedAt',
  );
  const retryAfter = requireCanonicalTimestamp(
    record.retryAfter,
    'GitHub redelivery deferred outcome.retryAfter',
  );
  if (retryAfter <= recordedAt) {
    throw new TypeError(
      'GitHub redelivery deferred retryAfter must follow recordedAt.',
    );
  }
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub redelivery deferred outcome.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub redelivery deferred outcome.scanId',
    ),
    intentId: requireUuid(
      record.intentId,
      'GitHub redelivery deferred outcome.intentId',
    ),
    recordedAt,
    reason: record.reason,
    retryAfter,
  };
}

export function parseGitHubRedeliveryRejectedInput(
  value: unknown,
): GitHubRedeliveryRejectedInput {
  const record = plainRecord(value, 'GitHub redelivery rejected outcome');
  requireExactKeys(record, [
    'generation',
    'scanId',
    'intentId',
    'recordedAt',
    'reason',
  ], 'GitHub redelivery rejected outcome');
  if (
    record.reason !== 'invalid-request'
    && record.reason !== 'provider-rejected'
  ) {
    throw new TypeError(
      'GitHub redelivery rejected reason is unsupported.',
    );
  }
  return {
    generation: requirePositiveInteger(
      record.generation,
      'GitHub redelivery rejected outcome.generation',
    ),
    scanId: requireUuid(
      record.scanId,
      'GitHub redelivery rejected outcome.scanId',
    ),
    intentId: requireUuid(
      record.intentId,
      'GitHub redelivery rejected outcome.intentId',
    ),
    recordedAt: requireCanonicalTimestamp(
      record.recordedAt,
      'GitHub redelivery rejected outcome.recordedAt',
    ),
    reason: record.reason,
  };
}

export function assertDeliveryRecoveryCommandId(
  value: unknown,
  field = 'commandId',
): string {
  return requireUuid(value, field);
}

export function assertDeliveryRecoveryInspectLimit(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > maximumDeliveryRecoveryInspectionEntries
  ) {
    throw new TypeError(
      `inspection limit must be an integer between 1 and `
      + `${maximumDeliveryRecoveryInspectionEntries}.`,
    );
  }
  return value;
}

export function canonicalReplayAuthorizationCommandJson(
  command: DeliveryRecoveryReplayAuthorizationCommand,
): string {
  return JSON.stringify({
    commandId: command.commandId,
    principal: {
      accessServiceClientId: command.principal.accessServiceClientId,
    },
    requestedAt: command.requestedAt,
    entryIds: command.entryIds,
    expectedLedgerRevision: command.expectedLedgerRevision,
  });
}

export function canonicalGitHubDeliveryScanCommandJson(
  command: GitHubDeliveryScanCommand,
): string {
  // Times, the provider-window observation, and expectedLedgerRevision are
  // trusted execution metadata / a first-create CAS precondition. They are
  // not durable command identity: the same public requestId may refresh all
  // of them while resuming one active scan.
  return JSON.stringify({
    commandId: command.commandId,
    scanId: command.scanId,
    principal: {
      accessServiceClientId: command.principal.accessServiceClientId,
    },
    coverageMode: command.coverageMode,
    takeover: command.takeover,
  });
}

export function canonicalGitHubDeliveryScanPageJson(
  page: GitHubDeliveryScanPageInput,
): string {
  // recordedAt and leaseExpiresAt are local observation metadata, not part of
  // the remote page identity. A response-lost retry may observe it later.
  return JSON.stringify({
    generation: page.generation,
    scanId: page.scanId,
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    attempts: page.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      guid: attempt.guid,
      deliveredAt: attempt.deliveredAt,
      status: attempt.status,
      redelivery: attempt.redelivery,
    })),
  });
}

function parseDeliveryRecoveryPrincipal(
  value: unknown,
): DeliveryRecoveryPrincipal {
  const record = plainRecord(value, 'recovery principal');
  requireExactKeys(
    record,
    ['accessServiceClientId'],
    'recovery principal',
  );
  return {
    accessServiceClientId: requireVisibleAscii(
      record.accessServiceClientId,
      'recovery principal.accessServiceClientId',
      128,
    ),
  };
}

function parseGitHubDeliveryAttempt(
  value: unknown,
  field: string,
): GitHubDeliveryAttempt {
  const record = plainRecord(value, field);
  requireExactKeys(
    record,
    ['attemptId', 'guid', 'deliveredAt', 'status', 'redelivery'],
    field,
  );
  if (typeof record.redelivery !== 'boolean') {
    throw new TypeError(`${field}.redelivery must be a boolean.`);
  }
  return {
    attemptId: requirePositiveInteger(
      record.attemptId,
      `${field}.attemptId`,
    ),
    guid: requireVisibleAscii(record.guid, `${field}.guid`, 128),
    deliveredAt: requireCanonicalTimestamp(
      record.deliveredAt,
      `${field}.deliveredAt`,
    ),
    status: requirePrintableAscii(
      record.status,
      `${field}.status`,
      maximumGitHubDeliveryStatusLength,
    ),
    redelivery: record.redelivery,
  };
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  return value as UnknownRecord;
}

function requireExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  field: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length
    || actual.some(
      (key) => typeof key !== 'string' || !expected.includes(key),
    )
  ) {
    throw new TypeError(`${field} contains missing or unknown fields.`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }
  return value;
}

function requireVisibleAscii(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field);
  if (
    text.length < 1
    || text.length > maximumLength
    || text !== text.trim()
    || !visibleAsciiPattern.test(text)
  ) {
    throw new TypeError(
      `${field} must contain 1-${maximumLength} visible ASCII characters.`,
    );
  }
  return text;
}

function requirePrintableAscii(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field);
  if (
    text.length < 1
    || text.length > maximumLength
    || text !== text.trim()
    || !printableAsciiPattern.test(text)
  ) {
    throw new TypeError(
      `${field} must contain 1-${maximumLength} printable ASCII characters.`,
    );
  }
  return text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!uuidPattern.test(text)) {
    throw new TypeError(`${field} must be a canonical lowercase UUID.`);
  }
  return text;
}

function requireSha256(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!sha256Pattern.test(text)) {
    throw new TypeError(
      `${field} must be a 64-character lowercase SHA-256 digest.`,
    );
  }
  return text;
}

function requireCanonicalTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (
    !canonicalTimestampPattern.test(text)
    || Number.isNaN(Date.parse(text))
    || new Date(text).toISOString() !== text
  ) {
    throw new TypeError(
      `${field} must be a canonical UTC Date.toISOString timestamp.`,
    );
  }
  return text;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function requireNull(value: unknown, field: string): null {
  if (value !== null) {
    throw new TypeError(`${field} must be null.`);
  }
  return null;
}

function requireEligibleEnvelopeKind(
  value: unknown,
): Exclude<CapturedEnvelopeKind, 'quarantined'> {
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
  ) {
    throw new TypeError(
      'DLQ capture.envelopeKind is not an eligible canonical envelope.',
    );
  }
  return value;
}

function requireNullableCursor(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireVisibleAscii(value, field, 1_024);
}

function assertLeaseWindow(
  startsAt: string,
  expiresAt: string,
  field: string,
): void {
  const duration = Date.parse(expiresAt) - Date.parse(startsAt);
  if (
    !Number.isSafeInteger(duration)
    || duration <= 0
    || duration > maximumGitHubDeliveryScanLeaseMs
  ) {
    throw new TypeError(
      `${field} must be positive and at most `
      + `${maximumGitHubDeliveryScanLeaseMs} milliseconds.`,
    );
  }
}

function assertDescendingGitHubAttemptOrder(
  attempts: readonly GitHubDeliveryAttempt[],
): void {
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1];
    const current = attempts[index];
    if (previous === undefined || current === undefined) {
      throw new Error('GitHub delivery attempt ordering is incomplete.');
    }
    if (
      current.deliveredAt > previous.deliveredAt
      || (
        current.deliveredAt === previous.deliveredAt
        && current.attemptId > previous.attemptId
      )
    ) {
      throw new DeliveryRecoveryConflictError(
        'page-order-conflict',
        'GitHub delivery scan attempts must be ordered by '
        + '(deliveredAt DESC, attemptId DESC).',
      );
    }
  }
}
