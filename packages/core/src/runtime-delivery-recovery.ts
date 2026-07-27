import {
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';

export const STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION = 1 as const;
export const STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ATTEMPTS = 100;
export const STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_CURSOR_LENGTH = 1_024;
export const STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_TEXT_LENGTH = 128;
export const STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ENVELOPE_BYTES =
  128 * 1_024;

export interface StewardRuntimeGitHubDeliveryAttemptV1 {
  readonly id: number;
  readonly guid: string;
  readonly deliveredAt: string;
  readonly redelivery: boolean;
  readonly status: string;
  readonly statusCode: number;
  readonly installationId: number | null;
  readonly repositoryId: number | null;
  readonly event: string;
  readonly action: string | null;
}

export interface StewardRuntimeDeliveryRecoveryPageRequestV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION;
  readonly phase: 'list-deliveries';
  readonly scanId: string;
  readonly cursor: string | null;
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeDeliveryRecoveryPageReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION;
  readonly phase: 'listed-deliveries';
  readonly scanId: string;
  readonly cursor: string | null;
  readonly attempts: readonly StewardRuntimeGitHubDeliveryAttemptV1[];
  readonly nextCursor: string | null;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeDeliveryRecoveryRedeliveryRequestV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION;
  readonly phase: 'redeliver-delivery';
  readonly scanId: string;
  readonly intentId: string;
  readonly attemptId: number;
  readonly guid: string;
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeDeliveryRecoveryAcceptedReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION;
  readonly phase: 'redelivery-accepted';
  readonly scanId: string;
  readonly intentId: string;
  readonly attemptId: number;
  readonly guid: string;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export type StewardRuntimeDeliveryRecoveryEnvelopeV1 =
  | StewardRuntimeDeliveryRecoveryPageRequestV1
  | StewardRuntimeDeliveryRecoveryPageReceiptV1
  | StewardRuntimeDeliveryRecoveryRedeliveryRequestV1
  | StewardRuntimeDeliveryRecoveryAcceptedReceiptV1;

export class RuntimeDeliveryRecoveryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime delivery recovery protocol: ${message}`);
    this.name = 'RuntimeDeliveryRecoveryValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;
const printableAsciiPattern = /^[\x20-\x7e]+$/;
const canonicalIsoTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function invalid(message: string): never {
  throw new RuntimeDeliveryRecoveryValidationError(message);
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} must be a plain object`);
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
    || actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid(`${field} contains missing or unknown fields`);
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nullablePositiveSafeInteger(
  value: unknown,
  field: string,
): number | null {
  return value === null ? null : positiveSafeInteger(value, field);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    invalid(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    invalid(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function canonicalVisibleAscii(
  value: unknown,
  field: string,
  maximumLength = STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_TEXT_LENGTH,
): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || !visibleAsciiPattern.test(value)
  ) {
    invalid(
      `${field} must be 1-${maximumLength} canonical visible ASCII characters`,
    );
  }
  return value;
}

function canonicalPrintableAscii(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_TEXT_LENGTH
    || value !== value.trim()
    || !printableAsciiPattern.test(value)
  ) {
    invalid(
      `${field} must be 1-`
      + `${STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_TEXT_LENGTH} `
      + 'canonical printable ASCII characters',
    );
  }
  return value;
}

function canonicalCursor(value: unknown, field: string): string | null {
  return value === null
    ? null
    : canonicalVisibleAscii(
        value,
        field,
        STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_CURSOR_LENGTH,
      );
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !canonicalIsoTimestampPattern.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid(`${field} must be a canonical ISO 8601 UTC timestamp`);
  }
  return value;
}

function controlRevision(
  value: unknown,
  field: string,
): StewardRuntimeControlRevisionV1 {
  try {
    return parseStewardRuntimeControlRevision(value);
  } catch {
    invalid(`${field} is invalid`);
  }
}

function attempt(
  value: unknown,
  field: string,
): StewardRuntimeGitHubDeliveryAttemptV1 {
  const record = plainRecord(value, field);
  requireExactKeys(
    record,
    [
      'id',
      'guid',
      'deliveredAt',
      'redelivery',
      'status',
      'statusCode',
      'installationId',
      'repositoryId',
      'event',
      'action',
    ],
    field,
  );
  if (typeof record.redelivery !== 'boolean') {
    invalid(`${field}.redelivery must be a boolean`);
  }
  return {
    id: positiveSafeInteger(record.id, `${field}.id`),
    guid: canonicalVisibleAscii(record.guid, `${field}.guid`),
    deliveredAt: canonicalTimestamp(record.deliveredAt, `${field}.deliveredAt`),
    redelivery: record.redelivery,
    status: canonicalPrintableAscii(record.status, `${field}.status`),
    statusCode: boundedInteger(
      record.statusCode,
      0,
      999,
      `${field}.statusCode`,
    ),
    installationId: nullablePositiveSafeInteger(
      record.installationId,
      `${field}.installationId`,
    ),
    repositoryId: nullablePositiveSafeInteger(
      record.repositoryId,
      `${field}.repositoryId`,
    ),
    event: canonicalVisibleAscii(record.event, `${field}.event`),
    action: record.action === null
      ? null
      : canonicalPrintableAscii(record.action, `${field}.action`),
  };
}

function revisionValue(
  revision: StewardRuntimeControlRevisionV1,
): Record<string, unknown> {
  return {
    stewardCommit: revision.stewardCommit,
    workerVersionId: revision.workerVersionId,
    workerVersionTag: revision.workerVersionTag,
    workerVersionCreatedAt: revision.workerVersionCreatedAt,
  };
}

function attemptValue(
  value: StewardRuntimeGitHubDeliveryAttemptV1,
): Record<string, unknown> {
  return {
    id: value.id,
    guid: value.guid,
    deliveredAt: value.deliveredAt,
    redelivery: value.redelivery,
    status: value.status,
    statusCode: value.statusCode,
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    event: value.event,
    action: value.action,
  };
}

function pageRequestValue(
  value: StewardRuntimeDeliveryRecoveryPageRequestV1,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    scanId: value.scanId,
    cursor: value.cursor,
    expectedControlRevision: revisionValue(value.expectedControlRevision),
  };
}

function pageReceiptValue(
  value: StewardRuntimeDeliveryRecoveryPageReceiptV1,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    scanId: value.scanId,
    cursor: value.cursor,
    attempts: value.attempts.map(attemptValue),
    nextCursor: value.nextCursor,
    controlRevision: revisionValue(value.controlRevision),
  };
}

function redeliveryRequestValue(
  value: StewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    scanId: value.scanId,
    intentId: value.intentId,
    attemptId: value.attemptId,
    guid: value.guid,
    expectedControlRevision: revisionValue(value.expectedControlRevision),
  };
}

function acceptedReceiptValue(
  value: StewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    scanId: value.scanId,
    intentId: value.intentId,
    attemptId: value.attemptId,
    guid: value.guid,
    controlRevision: revisionValue(value.controlRevision),
  };
}

function assertEnvelopeSize(value: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
      > STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ENVELOPE_BYTES
  ) {
    invalid(
      'delivery recovery envelope must not exceed '
      + `${STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ENVELOPE_BYTES} `
      + 'UTF-8 bytes',
    );
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    ),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function parseStewardRuntimeDeliveryRecoveryPageRequestV1(
  value: unknown,
): StewardRuntimeDeliveryRecoveryPageRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(
    request,
    [
      'schemaVersion',
      'phase',
      'scanId',
      'cursor',
      'expectedControlRevision',
    ],
    'request',
  );
  if (
    request.schemaVersion !== STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION
    || request.phase !== 'list-deliveries'
  ) {
    invalid('request must be a delivery recovery page request');
  }
  const parsed: StewardRuntimeDeliveryRecoveryPageRequestV1 = {
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'list-deliveries',
    scanId: canonicalUuid(request.scanId, 'request.scanId'),
    cursor: canonicalCursor(request.cursor, 'request.cursor'),
    expectedControlRevision: controlRevision(
      request.expectedControlRevision,
      'request.expectedControlRevision',
    ),
  };
  assertEnvelopeSize(pageRequestValue(parsed));
  return parsed;
}

export function buildStewardRuntimeDeliveryRecoveryPageRequestV1(
  input: Omit<
    StewardRuntimeDeliveryRecoveryPageRequestV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeDeliveryRecoveryPageRequestV1 {
  const builder = plainRecord(input, 'page request builder input');
  requireExactKeys(
    builder,
    ['scanId', 'cursor', 'expectedControlRevision'],
    'page request builder input',
  );
  return parseStewardRuntimeDeliveryRecoveryPageRequestV1({
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'list-deliveries',
    scanId: builder.scanId,
    cursor: builder.cursor,
    expectedControlRevision: builder.expectedControlRevision,
  });
}

export function canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(
  value: unknown,
): string {
  return JSON.stringify(
    pageRequestValue(
      parseStewardRuntimeDeliveryRecoveryPageRequestV1(value),
    ),
  );
}

export function digestStewardRuntimeDeliveryRecoveryPageRequestV1(
  value: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(value),
  );
}

export function parseStewardRuntimeDeliveryRecoveryPageReceiptV1(
  value: unknown,
): StewardRuntimeDeliveryRecoveryPageReceiptV1 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'scanId',
      'cursor',
      'attempts',
      'nextCursor',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion !== STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION
    || receipt.phase !== 'listed-deliveries'
  ) {
    invalid('receipt must be a delivery recovery page receipt');
  }
  if (!Array.isArray(receipt.attempts)) {
    invalid('receipt.attempts must be an array');
  }
  if (
    receipt.attempts.length
      > STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ATTEMPTS
  ) {
    invalid(
      'receipt.attempts must not exceed '
      + STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ATTEMPTS,
    );
  }
  const attempts = receipt.attempts.map((value, index) =>
    attempt(value, `receipt.attempts[${index}]`));
  if (new Set(attempts.map(({ id }) => id)).size !== attempts.length) {
    invalid('receipt.attempts must have unique attempt IDs');
  }
  const cursor = canonicalCursor(receipt.cursor, 'receipt.cursor');
  const nextCursor = canonicalCursor(
    receipt.nextCursor,
    'receipt.nextCursor',
  );
  if (cursor !== null && nextCursor === cursor) {
    invalid('receipt.nextCursor must advance beyond receipt.cursor');
  }
  const parsed: StewardRuntimeDeliveryRecoveryPageReceiptV1 = {
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'listed-deliveries',
    scanId: canonicalUuid(receipt.scanId, 'receipt.scanId'),
    cursor,
    attempts,
    nextCursor,
    controlRevision: controlRevision(
      receipt.controlRevision,
      'receipt.controlRevision',
    ),
  };
  assertEnvelopeSize(pageReceiptValue(parsed));
  return parsed;
}

export function buildStewardRuntimeDeliveryRecoveryPageReceiptV1(
  input: Omit<
    StewardRuntimeDeliveryRecoveryPageReceiptV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeDeliveryRecoveryPageReceiptV1 {
  const builder = plainRecord(input, 'page receipt builder input');
  requireExactKeys(
    builder,
    [
      'scanId',
      'cursor',
      'attempts',
      'nextCursor',
      'controlRevision',
    ],
    'page receipt builder input',
  );
  return parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'listed-deliveries',
    scanId: builder.scanId,
    cursor: builder.cursor,
    attempts: builder.attempts,
    nextCursor: builder.nextCursor,
    controlRevision: builder.controlRevision,
  });
}

export function canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(
  value: unknown,
): string {
  return JSON.stringify(
    pageReceiptValue(
      parseStewardRuntimeDeliveryRecoveryPageReceiptV1(value),
    ),
  );
}

export function digestStewardRuntimeDeliveryRecoveryPageReceiptV1(
  value: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(value),
  );
}

export function parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
  value: unknown,
): StewardRuntimeDeliveryRecoveryRedeliveryRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(
    request,
    [
      'schemaVersion',
      'phase',
      'scanId',
      'intentId',
      'attemptId',
      'guid',
      'expectedControlRevision',
    ],
    'request',
  );
  if (
    request.schemaVersion !== STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION
    || request.phase !== 'redeliver-delivery'
  ) {
    invalid('request must be a delivery recovery redelivery request');
  }
  const parsed: StewardRuntimeDeliveryRecoveryRedeliveryRequestV1 = {
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'redeliver-delivery',
    scanId: canonicalUuid(request.scanId, 'request.scanId'),
    intentId: canonicalUuid(request.intentId, 'request.intentId'),
    attemptId: positiveSafeInteger(request.attemptId, 'request.attemptId'),
    guid: canonicalVisibleAscii(request.guid, 'request.guid'),
    expectedControlRevision: controlRevision(
      request.expectedControlRevision,
      'request.expectedControlRevision',
    ),
  };
  assertEnvelopeSize(redeliveryRequestValue(parsed));
  return parsed;
}

export function buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
  input: Omit<
    StewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeDeliveryRecoveryRedeliveryRequestV1 {
  const builder = plainRecord(input, 'redelivery request builder input');
  requireExactKeys(
    builder,
    [
      'scanId',
      'intentId',
      'attemptId',
      'guid',
      'expectedControlRevision',
    ],
    'redelivery request builder input',
  );
  return parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'redeliver-delivery',
    scanId: builder.scanId,
    intentId: builder.intentId,
    attemptId: builder.attemptId,
    guid: builder.guid,
    expectedControlRevision: builder.expectedControlRevision,
  });
}

export function canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(
  value: unknown,
): string {
  return JSON.stringify(
    redeliveryRequestValue(
      parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(value),
    ),
  );
}

export function digestStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
  value: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(value),
  );
}

export function parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
  value: unknown,
): StewardRuntimeDeliveryRecoveryAcceptedReceiptV1 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'scanId',
      'intentId',
      'attemptId',
      'guid',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion !== STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION
    || receipt.phase !== 'redelivery-accepted'
  ) {
    invalid('receipt must be a delivery recovery accepted receipt');
  }
  const parsed: StewardRuntimeDeliveryRecoveryAcceptedReceiptV1 = {
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'redelivery-accepted',
    scanId: canonicalUuid(receipt.scanId, 'receipt.scanId'),
    intentId: canonicalUuid(receipt.intentId, 'receipt.intentId'),
    attemptId: positiveSafeInteger(receipt.attemptId, 'receipt.attemptId'),
    guid: canonicalVisibleAscii(receipt.guid, 'receipt.guid'),
    controlRevision: controlRevision(
      receipt.controlRevision,
      'receipt.controlRevision',
    ),
  };
  assertEnvelopeSize(acceptedReceiptValue(parsed));
  return parsed;
}

export function buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
  input: Omit<
    StewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeDeliveryRecoveryAcceptedReceiptV1 {
  const builder = plainRecord(input, 'accepted receipt builder input');
  requireExactKeys(
    builder,
    [
      'scanId',
      'intentId',
      'attemptId',
      'guid',
      'controlRevision',
    ],
    'accepted receipt builder input',
  );
  return parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
    schemaVersion: STEWARD_RUNTIME_DELIVERY_RECOVERY_SCHEMA_VERSION,
    phase: 'redelivery-accepted',
    scanId: builder.scanId,
    intentId: builder.intentId,
    attemptId: builder.attemptId,
    guid: builder.guid,
    controlRevision: builder.controlRevision,
  });
}

export function canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(
  value: unknown,
): string {
  return JSON.stringify(
    acceptedReceiptValue(
      parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(value),
    ),
  );
}

export function digestStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
  value: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(value),
  );
}
