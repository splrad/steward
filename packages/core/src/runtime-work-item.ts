export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION = 1 as const;

const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const canonicalUtcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const opaqueAsciiPattern = /^[\x21-\x7e]+$/;

export const STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1 = [
  'closed',
  'converted_to_draft',
  'edited',
  'labeled',
  'opened',
  'ready_for_review',
  'reopened',
  'review_request_removed',
  'review_requested',
  'synchronize',
  'unlabeled',
] as const;

export type StewardRuntimePullRequestActionV1 =
  (typeof STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1)[number];

export type StewardRuntimeWorkItemOperationV1 =
  | 'runtime-probe'
  | 'pull-request-reconcile';

export interface StewardRuntimeWorkItemSubjectV1 {
  readonly repositoryId: number;
  /**
   * Diagnostic routing evidence only. Control must bind the numeric repository
   * ID to fresh GitHub metadata before treating the name as authoritative.
   */
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
}

export interface StewardInternalProbeCauseV1 {
  readonly kind: 'internal-probe';
  readonly deliveryId: string;
  readonly receivedAt: string;
}

export interface StewardGitHubWebhookCauseV1 {
  readonly kind: 'github-webhook';
  readonly deliveryId: string;
  readonly event: 'pull_request';
  readonly action: StewardRuntimePullRequestActionV1;
  readonly receivedAt: string;
}

export type StewardRuntimeWorkItemCauseV1 =
  | StewardInternalProbeCauseV1
  | StewardGitHubWebhookCauseV1;

export interface StewardRuntimeWorkItemV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV1;
}

export type BuildStewardRuntimeWorkItemInput =
  Omit<StewardRuntimeWorkItemV1, 'schemaVersion'>;

export class RuntimeWorkItemValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime work item: ${message}`);
    this.name = 'RuntimeWorkItemValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new RuntimeWorkItemValidationError(message);
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

function requirePositiveId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  return value;
}

function requireOpaqueAscii(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field);
  if (
    text.length < 1
    || text.length > maximumLength
    || text !== text.trim()
    || !opaqueAsciiPattern.test(text)
  ) {
    invalid(`${field} must be 1-${maximumLength} canonical visible ASCII characters`);
  }
  return text;
}

function requirePullRequestAction(
  value: unknown,
  field: string,
): StewardRuntimePullRequestActionV1 {
  const text = requireString(value, field);
  if (
    !(STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1 as readonly string[])
      .includes(text)
  ) {
    invalid(`${field} is not supported by pull-request reconcile version 1`);
  }
  return text as StewardRuntimePullRequestActionV1;
}

function requireRepositoryFullName(value: unknown): string {
  const fullName = requireString(value, 'workItem.subject.repositoryFullName');
  const parts = fullName.split('/');
  if (
    fullName !== fullName.trim()
    || parts.length !== 2
    || !githubLoginPattern.test(parts[0] ?? '')
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid(
      'workItem.subject.repositoryFullName must be a canonical GitHub owner/repository name',
    );
  }
  return fullName;
}

function requireCanonicalUtcTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (
    timestamp !== timestamp.trim()
    || !canonicalUtcTimestampPattern.test(timestamp)
    || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp
  ) {
    invalid(`${field} must be a canonical UTC Date.toISOString timestamp`);
  }
  return timestamp;
}

function parseCause(value: unknown): StewardRuntimeWorkItemCauseV1 {
  const cause = plainRecord(value, 'workItem.cause');
  const kind = requireString(cause.kind, 'workItem.cause.kind');
  if (kind === 'internal-probe') {
    requireExactKeys(
      cause,
      ['kind', 'deliveryId', 'receivedAt'],
      'workItem.cause',
    );
    return {
      kind,
      deliveryId: requireOpaqueAscii(
        cause.deliveryId,
        'workItem.cause.deliveryId',
        128,
      ),
      receivedAt: requireCanonicalUtcTimestamp(
        cause.receivedAt,
        'workItem.cause.receivedAt',
      ),
    };
  }
  if (kind === 'github-webhook') {
    requireExactKeys(
      cause,
      ['kind', 'deliveryId', 'event', 'action', 'receivedAt'],
      'workItem.cause',
    );
    return {
      kind,
      deliveryId: requireOpaqueAscii(
        cause.deliveryId,
        'workItem.cause.deliveryId',
        128,
      ),
      event: cause.event === 'pull_request'
        ? cause.event
        : invalid('workItem.cause.event must be pull_request'),
      action: requirePullRequestAction(
        cause.action,
        'workItem.cause.action',
      ),
      receivedAt: requireCanonicalUtcTimestamp(
        cause.receivedAt,
        'workItem.cause.receivedAt',
      ),
    };
  }
  invalid('workItem.cause.kind must be one of: internal-probe, github-webhook');
}

export function parseStewardRuntimeWorkItem(value: unknown): StewardRuntimeWorkItemV1 {
  const workItem = plainRecord(value, 'workItem');
  requireExactKeys(
    workItem,
    ['schemaVersion', 'operation', 'installationId', 'subject', 'cause'],
    'workItem',
  );
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION) {
    invalid('workItem.schemaVersion must be 1');
  }
  if (
    workItem.operation !== 'runtime-probe'
    && workItem.operation !== 'pull-request-reconcile'
  ) {
    invalid('workItem.operation must be one of: runtime-probe, pull-request-reconcile');
  }

  const subject = plainRecord(workItem.subject, 'workItem.subject');
  requireExactKeys(
    subject,
    ['repositoryId', 'repositoryFullName', 'pullRequestNumber'],
    'workItem.subject',
  );

  const operation = workItem.operation;
  const cause = parseCause(workItem.cause);
  if (operation === 'runtime-probe' && cause.kind !== 'internal-probe') {
    invalid('runtime-probe requires an internal-probe cause');
  }
  if (operation === 'pull-request-reconcile' && cause.kind !== 'github-webhook') {
    invalid('pull-request-reconcile requires a GitHub webhook cause');
  }

  return {
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION,
    operation,
    installationId: requirePositiveId(
      workItem.installationId,
      'workItem.installationId',
    ),
    subject: {
      repositoryId: requirePositiveId(
        subject.repositoryId,
        'workItem.subject.repositoryId',
      ),
      repositoryFullName: requireRepositoryFullName(subject.repositoryFullName),
      pullRequestNumber: requirePositiveId(
        subject.pullRequestNumber,
        'workItem.subject.pullRequestNumber',
      ),
    },
    cause,
  };
}

export function buildStewardRuntimeWorkItem(
  value: BuildStewardRuntimeWorkItemInput,
): StewardRuntimeWorkItemV1 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(
    input,
    ['operation', 'installationId', 'subject', 'cause'],
    'builder input',
  );
  return parseStewardRuntimeWorkItem({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION,
    operation: input.operation,
    installationId: input.installationId,
    subject: input.subject,
    cause: input.cause,
  });
}

export function canonicalStewardRuntimeWorkItemJson(value: unknown): string {
  const workItem = parseStewardRuntimeWorkItem(value);
  const cause = workItem.cause.kind === 'internal-probe'
    ? {
        kind: workItem.cause.kind,
        deliveryId: workItem.cause.deliveryId,
        receivedAt: workItem.cause.receivedAt,
      }
    : {
        kind: workItem.cause.kind,
        deliveryId: workItem.cause.deliveryId,
        event: workItem.cause.event,
        action: workItem.cause.action,
        receivedAt: workItem.cause.receivedAt,
      };
  return JSON.stringify({
    schemaVersion: workItem.schemaVersion,
    operation: workItem.operation,
    installationId: workItem.installationId,
    subject: {
      repositoryId: workItem.subject.repositoryId,
      repositoryFullName: workItem.subject.repositoryFullName,
      pullRequestNumber: workItem.subject.pullRequestNumber,
    },
    cause,
  });
}

export function stewardRuntimeWorkItemUtf8ByteSize(value: unknown): number {
  return new TextEncoder().encode(canonicalStewardRuntimeWorkItemJson(value)).byteLength;
}
