import {
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from '../../core/src/index.js';

export const deliveryRecoverySchemaVersion = 1 as const;
export const maximumDeliveryRecoveryRequestBytes = 16 * 1024;
export const maximumDeliveryRecoveryReplayEntries = 25;
export const deliveryRecoveryRequestFreshnessMs = 5 * 60_000;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const entryIdPattern = /^[0-9a-f]{64}$/;

interface RecoveryCommandBase {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestedAt: string;
}

export interface InspectDeliveryRecoveryCommand
  extends RecoveryCommandBase {
  readonly operation: 'inspect';
}

export interface ReplayDeadLetterEntriesCommand
  extends RecoveryCommandBase {
  readonly operation: 'replay-dlq';
  readonly expectedLedgerRevision: string;
  readonly entryIds: readonly string[];
}

export interface RecoverGitHubDeliveriesCommand
  extends RecoveryCommandBase {
  readonly operation: 'recover-github';
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
  readonly coverageMode: 'continue' | 'establish';
  readonly takeover: boolean;
}

export type DeliveryRecoveryCommand =
  | InspectDeliveryRecoveryCommand
  | ReplayDeadLetterEntriesCommand
  | RecoverGitHubDeliveriesCommand;

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError('Delivery recovery command must be a plain object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length
    || actual.some(
      (key) => typeof key !== 'string' || !expected.includes(key),
    )
  ) {
    throw new TypeError('Delivery recovery command keys are invalid.');
  }
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) {
    throw new TypeError(`${field} must be a canonical UTC timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function commandBase(
  record: Record<string, unknown>,
): RecoveryCommandBase {
  if (
    record.schemaVersion !== deliveryRecoverySchemaVersion
    || typeof record.requestId !== 'string'
    || !uuidPattern.test(record.requestId)
  ) {
    throw new TypeError('Delivery recovery command identity is invalid.');
  }
  return {
    schemaVersion: deliveryRecoverySchemaVersion,
    requestId: record.requestId,
    requestedAt: canonicalTimestamp(record.requestedAt, 'requestedAt'),
  };
}

export function parseDeliveryRecoveryCommand(
  value: unknown,
): DeliveryRecoveryCommand {
  const record = plainRecord(value);
  const operation = record.operation;
  if (operation === 'inspect') {
    exactKeys(record, [
      'schemaVersion',
      'operation',
      'requestId',
      'requestedAt',
    ]);
    return {
      ...commandBase(record),
      operation,
    };
  }
  if (operation === 'replay-dlq') {
    exactKeys(record, [
      'schemaVersion',
      'operation',
      'requestId',
      'requestedAt',
      'expectedLedgerRevision',
      'entryIds',
    ]);
    if (
      typeof record.expectedLedgerRevision !== 'string'
      || !sha256Pattern.test(record.expectedLedgerRevision)
      || !Array.isArray(record.entryIds)
      || record.entryIds.length === 0
      || record.entryIds.length > maximumDeliveryRecoveryReplayEntries
      || record.entryIds.some(
        (entryId) => typeof entryId !== 'string'
          || !entryIdPattern.test(entryId),
      )
      || new Set(record.entryIds).size !== record.entryIds.length
    ) {
      throw new TypeError('DLQ replay selection is invalid.');
    }
    return {
      ...commandBase(record),
      operation,
      expectedLedgerRevision: record.expectedLedgerRevision,
      entryIds: [...record.entryIds].sort() as string[],
    };
  }
  if (operation === 'recover-github') {
    exactKeys(record, [
      'schemaVersion',
      'operation',
      'requestId',
      'requestedAt',
      'expectedControlRevision',
      'coverageMode',
      'takeover',
    ]);
    if (
      record.coverageMode !== 'continue'
      && record.coverageMode !== 'establish'
    ) {
      throw new TypeError('GitHub recovery coverage mode is invalid.');
    }
    if (typeof record.takeover !== 'boolean') {
      throw new TypeError('GitHub recovery takeover flag is invalid.');
    }
    return {
      ...commandBase(record),
      operation,
      expectedControlRevision: parseStewardRuntimeControlRevision(
        record.expectedControlRevision,
      ),
      coverageMode: record.coverageMode,
      takeover: record.takeover,
    };
  }
  throw new TypeError('Unsupported delivery recovery operation.');
}

export function assertFreshDeliveryRecoveryCommand(
  command: DeliveryRecoveryCommand,
  now: Date,
): void {
  const nowMs = now.getTime();
  const requestedAtMs = Date.parse(command.requestedAt);
  if (
    !Number.isSafeInteger(nowMs)
    || Math.abs(nowMs - requestedAtMs) > deliveryRecoveryRequestFreshnessMs
  ) {
    throw new TypeError('Delivery recovery command is stale.');
  }
}

export function canonicalDeliveryRecoveryCommandJson(
  command: DeliveryRecoveryCommand,
): string {
  const parsed = parseDeliveryRecoveryCommand(command);
  if (parsed.operation === 'inspect') {
    return JSON.stringify({
      schemaVersion: parsed.schemaVersion,
      operation: parsed.operation,
      requestId: parsed.requestId,
      requestedAt: parsed.requestedAt,
    });
  }
  if (parsed.operation === 'replay-dlq') {
    return JSON.stringify({
      schemaVersion: parsed.schemaVersion,
      operation: parsed.operation,
      requestId: parsed.requestId,
      requestedAt: parsed.requestedAt,
      expectedLedgerRevision: parsed.expectedLedgerRevision,
      entryIds: parsed.entryIds,
    });
  }
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    operation: parsed.operation,
    requestId: parsed.requestId,
    requestedAt: parsed.requestedAt,
    expectedControlRevision: parsed.expectedControlRevision,
    coverageMode: parsed.coverageMode,
    takeover: parsed.takeover,
  });
}

export function canonicalRecoverGitHubScanIdentityJson(
  command: RecoverGitHubDeliveriesCommand,
): string {
  const parsed = parseDeliveryRecoveryCommand(command);
  if (parsed.operation !== 'recover-github') {
    throw new TypeError('GitHub recovery scan identity is invalid.');
  }
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    operation: parsed.operation,
    requestId: parsed.requestId,
    expectedControlRevision: {
      stewardCommit: parsed.expectedControlRevision.stewardCommit,
      workerVersionId: parsed.expectedControlRevision.workerVersionId,
      workerVersionTag: parsed.expectedControlRevision.workerVersionTag,
      workerVersionCreatedAt:
        parsed.expectedControlRevision.workerVersionCreatedAt,
    },
    coverageMode: parsed.coverageMode,
    takeover: parsed.takeover,
  });
}
