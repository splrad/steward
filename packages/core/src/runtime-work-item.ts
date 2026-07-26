export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1 = 1 as const;
export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2 = 2 as const;
export const STEWARD_RUNTIME_WORK_ITEM_CURRENT_SCHEMA_VERSION =
  STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2;

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

export const STEWARD_RUNTIME_PULL_REQUEST_REVIEW_ACTIONS_V2 = [
  'dismissed',
  'edited',
  'submitted',
] as const;

export type StewardRuntimePullRequestReviewActionV2 =
  (typeof STEWARD_RUNTIME_PULL_REQUEST_REVIEW_ACTIONS_V2)[number];

export const STEWARD_RUNTIME_PULL_REQUEST_REVIEW_COMMENT_ACTIONS_V2 = [
  'created',
  'deleted',
  'edited',
] as const;

export type StewardRuntimePullRequestReviewCommentActionV2 =
  (typeof STEWARD_RUNTIME_PULL_REQUEST_REVIEW_COMMENT_ACTIONS_V2)[number];

export const STEWARD_RUNTIME_PULL_REQUEST_REVIEW_THREAD_ACTIONS_V2 = [
  'resolved',
  'unresolved',
] as const;

export type StewardRuntimePullRequestReviewThreadActionV2 =
  (typeof STEWARD_RUNTIME_PULL_REQUEST_REVIEW_THREAD_ACTIONS_V2)[number];

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

interface StewardGitHubWebhookCauseBase {
  readonly kind: 'github-webhook';
  readonly deliveryId: string;
  readonly receivedAt: string;
}

export type StewardGitHubWebhookCauseV1 =
  StewardGitHubWebhookCauseBase & {
    readonly event: 'pull_request';
    readonly action: StewardRuntimePullRequestActionV1;
  };

export type StewardGitHubWebhookCauseV2 =
  | StewardGitHubWebhookCauseBase & {
      readonly event: 'pull_request';
      readonly action: StewardRuntimePullRequestActionV1;
    }
  | StewardGitHubWebhookCauseBase & {
      readonly event: 'pull_request_review';
      readonly action: StewardRuntimePullRequestReviewActionV2;
    }
  | StewardGitHubWebhookCauseBase & {
      readonly event: 'pull_request_review_comment';
      readonly action: StewardRuntimePullRequestReviewCommentActionV2;
    }
  | StewardGitHubWebhookCauseBase & {
      readonly event: 'pull_request_review_thread';
      readonly action: StewardRuntimePullRequestReviewThreadActionV2;
    };

type GitHubWebhookEventAction<Cause> =
  Cause extends StewardGitHubWebhookCauseV2
    ? Pick<Cause, 'event' | 'action'>
    : never;

export type StewardGitHubWebhookEventActionV2 =
  GitHubWebhookEventAction<StewardGitHubWebhookCauseV2>;

export type StewardRuntimeWorkItemCauseV1 =
  | StewardInternalProbeCauseV1
  | StewardGitHubWebhookCauseV1;

export type StewardRuntimeWorkItemCauseV2 =
  | StewardInternalProbeCauseV1
  | StewardGitHubWebhookCauseV2;

export interface StewardRuntimeWorkItemV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV1;
}

export interface StewardRuntimeWorkItemV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV2;
}

export type StewardRuntimeWorkItem =
  | StewardRuntimeWorkItemV1
  | StewardRuntimeWorkItemV2;

export type BuildStewardRuntimeWorkItemInput =
  Omit<StewardRuntimeWorkItemV1, 'schemaVersion'>;

export type BuildStewardRuntimeWorkItemV2Input =
  Omit<StewardRuntimeWorkItemV2, 'schemaVersion'>;

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

function requireSupportedAction<Action extends string>(
  value: unknown,
  field: string,
  supported: readonly Action[],
  event: string,
): Action {
  const text = requireString(value, field);
  if (!(supported as readonly string[]).includes(text)) {
    invalid(`${field} is not supported for ${event}`);
  }
  return text as Action;
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

function parseCause(
  value: unknown,
  schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1,
): StewardRuntimeWorkItemCauseV1;
function parseCause(
  value: unknown,
  schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2,
): StewardRuntimeWorkItemCauseV2;
function parseCause(
  value: unknown,
  schemaVersion: 1 | 2,
): StewardRuntimeWorkItemCauseV1 | StewardRuntimeWorkItemCauseV2 {
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
    const deliveryId = requireOpaqueAscii(
      cause.deliveryId,
      'workItem.cause.deliveryId',
      128,
    );
    const receivedAt = requireCanonicalUtcTimestamp(
      cause.receivedAt,
      'workItem.cause.receivedAt',
    );
    if (schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1) {
      if (cause.event !== 'pull_request') {
        invalid('workItem.cause.event must be pull_request in schema version 1');
      }
      return {
        kind,
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
          cause.event,
        ),
        receivedAt,
      };
    }
    switch (cause.event) {
      case 'pull_request':
        return {
          kind,
          deliveryId,
          event: cause.event,
          action: requireSupportedAction(
            cause.action,
            'workItem.cause.action',
            STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
            cause.event,
          ),
          receivedAt,
        };
      case 'pull_request_review':
        return {
          kind,
          deliveryId,
          event: cause.event,
          action: requireSupportedAction(
            cause.action,
            'workItem.cause.action',
            STEWARD_RUNTIME_PULL_REQUEST_REVIEW_ACTIONS_V2,
            cause.event,
          ),
          receivedAt,
        };
      case 'pull_request_review_comment':
        return {
          kind,
          deliveryId,
          event: cause.event,
          action: requireSupportedAction(
            cause.action,
            'workItem.cause.action',
            STEWARD_RUNTIME_PULL_REQUEST_REVIEW_COMMENT_ACTIONS_V2,
            cause.event,
          ),
          receivedAt,
        };
      case 'pull_request_review_thread':
        return {
          kind,
          deliveryId,
          event: cause.event,
          action: requireSupportedAction(
            cause.action,
            'workItem.cause.action',
            STEWARD_RUNTIME_PULL_REQUEST_REVIEW_THREAD_ACTIONS_V2,
            cause.event,
          ),
          receivedAt,
        };
      default:
        invalid(
          'workItem.cause.event must be one of: pull_request, '
          + 'pull_request_review, pull_request_review_comment, '
          + 'pull_request_review_thread',
        );
    }
  }
  invalid('workItem.cause.kind must be one of: internal-probe, github-webhook');
}

function validateOperationCause(
  operation: StewardRuntimeWorkItemOperationV1,
  cause: StewardRuntimeWorkItemCauseV1 | StewardRuntimeWorkItemCauseV2,
): void {
  if (operation === 'runtime-probe' && cause.kind !== 'internal-probe') {
    invalid('runtime-probe requires an internal-probe cause');
  }
  if (operation === 'pull-request-reconcile' && cause.kind !== 'github-webhook') {
    invalid('pull-request-reconcile requires a GitHub webhook cause');
  }
}

export function parseStewardRuntimeWorkItem(
  value: unknown,
): StewardRuntimeWorkItem {
  const workItem = plainRecord(value, 'workItem');
  requireExactKeys(
    workItem,
    ['schemaVersion', 'operation', 'installationId', 'subject', 'cause'],
    'workItem',
  );
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

  const operation: StewardRuntimeWorkItemOperationV1 = workItem.operation;
  const common = {
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
  };

  if (workItem.schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1) {
    const cause = parseCause(
      workItem.cause,
      STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1,
    );
    validateOperationCause(operation, cause);
    return {
      schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1,
      ...common,
      cause,
    };
  }
  if (workItem.schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2) {
    const cause = parseCause(
      workItem.cause,
      STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2,
    );
    validateOperationCause(operation, cause);
    return {
      schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2,
      ...common,
      cause,
    };
  }
  invalid('workItem.schemaVersion must be one of: 1, 2');
}

export function parseStewardRuntimeWorkItemV1(
  value: unknown,
): StewardRuntimeWorkItemV1 {
  const workItem = parseStewardRuntimeWorkItem(value);
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1) {
    invalid('workItem.schemaVersion must be 1');
  }
  return workItem;
}

export function parseStewardRuntimeWorkItemV2(
  value: unknown,
): StewardRuntimeWorkItemV2 {
  const workItem = parseStewardRuntimeWorkItem(value);
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2) {
    invalid('workItem.schemaVersion must be 2');
  }
  return workItem;
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
  return parseStewardRuntimeWorkItemV1({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1,
    operation: input.operation,
    installationId: input.installationId,
    subject: input.subject,
    cause: input.cause,
  });
}

export function buildStewardRuntimeWorkItemV2(
  value: BuildStewardRuntimeWorkItemV2Input,
): StewardRuntimeWorkItemV2 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(
    input,
    ['operation', 'installationId', 'subject', 'cause'],
    'builder input',
  );
  return parseStewardRuntimeWorkItemV2({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2,
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
