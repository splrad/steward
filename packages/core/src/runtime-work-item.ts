import {
  STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1,
  STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1,
  STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2,
  parseStewardRuntimeScopeCauseV2,
  type StewardRuntimeRepositoryActionV1,
  type StewardRuntimeScopeCauseV2,
} from './runtime-scope-work-item.js';
import {
  STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION,
  buildStewardRuntimeInstallationFanoutDeliveryId,
  type StewardRuntimeInstallationRepositoryChildV1,
} from './runtime-installation-fanout.js';

export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V1 = 1 as const;
export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V2 = 2 as const;
export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3 = 3 as const;
export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4 = 4 as const;
export const STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5 = 5 as const;
export const STEWARD_RUNTIME_WORK_ITEM_CURRENT_SCHEMA_VERSION =
  STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5;

const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const canonicalUtcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const opaqueAsciiPattern = /^[\x21-\x7e]+$/;
const fanoutDeliveryIdPattern = /^fanout-v1:[0-9a-f]{64}$/;
const fanoutDeliveryIdV2Pattern = /^fanout-v2:[0-9a-f]{64}$/;
const fanoutDeliveryIdV3Pattern = /^fanout-v3:[0-9a-f]{64}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

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

export interface StewardScopeFanoutCauseV3 {
  readonly kind: 'scope-fanout';
  readonly deliveryId: string;
  readonly rootDeliveryId: string;
  readonly scopeSchemaVersion: typeof STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1;
  readonly fanoutGeneration: number;
  readonly event: 'repository';
  readonly action: StewardRuntimeRepositoryActionV1;
  readonly receivedAt: string;
}

export interface StewardScopeFanoutCauseV4 {
  readonly kind: 'scope-fanout-2';
  readonly deliveryId: string;
  readonly rootDeliveryId: string;
  readonly scopeSchemaVersion: typeof STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2;
  readonly fanoutGeneration: number;
  readonly event: StewardRuntimeScopeCauseV2['event'];
  readonly action: StewardRuntimeScopeCauseV2['action'];
  readonly ref: StewardRuntimeScopeCauseV2['ref'];
  readonly receivedAt: string;
}

export interface StewardScopeFanoutCauseV5 {
  readonly kind: 'scope-fanout-3';
  readonly deliveryId: string;
  readonly rootDeliveryId: string;
  readonly installationChild: StewardRuntimeInstallationRepositoryChildV1;
  readonly repositoryFanoutGeneration: number;
  readonly event: StewardRuntimeScopeCauseV2['event'];
  readonly action: StewardRuntimeScopeCauseV2['action'];
  readonly ref: StewardRuntimeScopeCauseV2['ref'];
  readonly receivedAt: string;
}

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

export type StewardRuntimeWorkItemCauseV3 =
  | StewardRuntimeWorkItemCauseV2
  | StewardScopeFanoutCauseV3;

export type StewardRuntimeWorkItemCauseV4 =
  | StewardRuntimeWorkItemCauseV2
  | StewardScopeFanoutCauseV4;

export type StewardRuntimeWorkItemCauseV5 =
  | StewardRuntimeWorkItemCauseV2
  | StewardScopeFanoutCauseV5;

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

export interface StewardRuntimeWorkItemV3 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV3;
}

export interface StewardRuntimeWorkItemV4 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV4;
}

export interface StewardRuntimeWorkItemV5 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5;
  readonly operation: StewardRuntimeWorkItemOperationV1;
  readonly installationId: number;
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly cause: StewardRuntimeWorkItemCauseV5;
}

export type StewardRuntimeWorkItem =
  | StewardRuntimeWorkItemV1
  | StewardRuntimeWorkItemV2
  | StewardRuntimeWorkItemV3
  | StewardRuntimeWorkItemV4
  | StewardRuntimeWorkItemV5;

export type BuildStewardRuntimeWorkItemInput =
  Omit<StewardRuntimeWorkItemV1, 'schemaVersion'>;

export type BuildStewardRuntimeWorkItemV2Input =
  Omit<StewardRuntimeWorkItemV2, 'schemaVersion'>;

export type BuildStewardRuntimeWorkItemV3Input =
  Omit<StewardRuntimeWorkItemV3, 'schemaVersion'>;

export type BuildStewardRuntimeWorkItemV4Input =
  Omit<StewardRuntimeWorkItemV4, 'schemaVersion'>;

export type BuildStewardRuntimeWorkItemV5Input =
  Omit<StewardRuntimeWorkItemV5, 'schemaVersion'>;

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

function requireFanoutDeliveryId(value: unknown): string {
  const deliveryId = requireString(value, 'workItem.cause.deliveryId');
  if (!fanoutDeliveryIdPattern.test(deliveryId)) {
    invalid(
      'workItem.cause.deliveryId must use fanout-v1 followed by a 64-character lowercase hex digest',
    );
  }
  return deliveryId;
}

function requireFanoutDeliveryIdV2(value: unknown): string {
  const deliveryId = requireString(value, 'workItem.cause.deliveryId');
  if (!fanoutDeliveryIdV2Pattern.test(deliveryId)) {
    invalid(
      'workItem.cause.deliveryId must use fanout-v2 followed by a 64-character lowercase hex digest',
    );
  }
  return deliveryId;
}

function requireFanoutDeliveryIdV3(value: unknown): string {
  const deliveryId = requireString(value, 'workItem.cause.deliveryId');
  if (!fanoutDeliveryIdV3Pattern.test(deliveryId)) {
    invalid(
      'workItem.cause.deliveryId must use fanout-v3 followed by a 64-character lowercase hex digest',
    );
  }
  return deliveryId;
}

function parseInstallationRepositoryChildCommitmentV1(
  value: unknown,
): StewardRuntimeInstallationRepositoryChildV1 {
  const child = plainRecord(value, 'workItem.cause.installationChild');
  requireExactKeys(
    child,
    [
      'schemaVersion',
      'operation',
      'rootDigest',
      'rootTargetDigest',
      'rootDeliveryId',
      'rootTargetScope',
      'installationId',
      'repositoryId',
      'installationGeneration',
      'cause',
      'deliveryId',
    ],
    'workItem.cause.installationChild',
  );
  if (
    child.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION
    || child.operation !== 'installation-repository-fanout'
  ) {
    invalid('workItem.cause.installationChild is not a version 1 installation child');
  }
  const rootDigest = requireString(
    child.rootDigest,
    'workItem.cause.installationChild.rootDigest',
  );
  if (!sha256Pattern.test(rootDigest)) {
    invalid(
      'workItem.cause.installationChild.rootDigest must be a lowercase SHA-256 digest',
    );
  }
  const rootTargetDigest = requireString(
    child.rootTargetDigest,
    'workItem.cause.installationChild.rootTargetDigest',
  );
  if (!sha256Pattern.test(rootTargetDigest)) {
    invalid(
      'workItem.cause.installationChild.rootTargetDigest must be a lowercase SHA-256 digest',
    );
  }
  const rootDeliveryId = requireOpaqueAscii(
    child.rootDeliveryId,
    'workItem.cause.installationChild.rootDeliveryId',
    128,
  );
  if (
    child.rootTargetScope !== 'installation'
    && child.rootTargetScope !== 'repository-set'
  ) {
    invalid(
      'workItem.cause.installationChild.rootTargetScope must be installation or repository-set',
    );
  }
  const installationId = requirePositiveId(
    child.installationId,
    'workItem.cause.installationChild.installationId',
  );
  const repositoryId = requirePositiveId(
    child.repositoryId,
    'workItem.cause.installationChild.repositoryId',
  );
  const installationGeneration = requirePositiveId(
    child.installationGeneration,
    'workItem.cause.installationChild.installationGeneration',
  );
  let cause: StewardRuntimeScopeCauseV2;
  try {
    cause = parseStewardRuntimeScopeCauseV2(child.cause);
  } catch {
    invalid(
      'workItem.cause.installationChild.cause must be a valid scope schema version 2 cause',
    );
  }
  if (cause.deliveryId !== rootDeliveryId) {
    invalid(
      'workItem.cause.installationChild.rootDeliveryId must match its cause delivery ID',
    );
  }
  const installationRootCause =
    cause.event === 'custom_property'
    || cause.event === 'membership'
    || cause.event === 'installation'
    || cause.event === 'installation_target'
    || (
      cause.event === 'team'
      && (
        cause.action === 'created'
        || cause.action === 'edited'
        || cause.action === 'deleted'
      )
    );
  const repositorySetRootCause =
    cause.event === 'installation_repositories'
    || (
      cause.event === 'installation'
      && (cause.action === 'suspend' || cause.action === 'deleted')
    );
  if (
    (
      child.rootTargetScope === 'installation'
      && !installationRootCause
    )
    || (
      child.rootTargetScope === 'repository-set'
      && !repositorySetRootCause
    )
  ) {
    invalid(
      'workItem.cause.installationChild cause is incompatible with its root target scope',
    );
  }
  const deliveryId = requireOpaqueAscii(
    child.deliveryId,
    'workItem.cause.installationChild.deliveryId',
    128,
  );
  if (
    deliveryId !== buildStewardRuntimeInstallationFanoutDeliveryId(
      rootDigest,
      installationGeneration,
      repositoryId,
    )
  ) {
    invalid(
      'workItem.cause.installationChild.deliveryId is not derivable from its commitment',
    );
  }
  return {
    schemaVersion:
      STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION,
    operation: 'installation-repository-fanout',
    rootDigest,
    rootTargetDigest,
    rootDeliveryId,
    rootTargetScope: child.rootTargetScope,
    installationId,
    repositoryId,
    installationGeneration,
    cause,
    deliveryId,
  };
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
  schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3,
): StewardRuntimeWorkItemCauseV3;
function parseCause(
  value: unknown,
  schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4,
): StewardRuntimeWorkItemCauseV4;
function parseCause(
  value: unknown,
  schemaVersion: typeof STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5,
): StewardRuntimeWorkItemCauseV5;
function parseCause(
  value: unknown,
  schemaVersion: 1 | 2 | 3 | 4 | 5,
):
  | StewardRuntimeWorkItemCauseV1
  | StewardRuntimeWorkItemCauseV2
  | StewardRuntimeWorkItemCauseV3
  | StewardRuntimeWorkItemCauseV4
  | StewardRuntimeWorkItemCauseV5 {
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
  if (
    kind === 'scope-fanout'
    && schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3
  ) {
    requireExactKeys(
      cause,
      [
        'kind',
        'deliveryId',
        'rootDeliveryId',
        'scopeSchemaVersion',
        'fanoutGeneration',
        'event',
        'action',
        'receivedAt',
      ],
      'workItem.cause',
    );
    if (
      cause.scopeSchemaVersion
      !== STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1
    ) {
      invalid('workItem.cause.scopeSchemaVersion must be 1');
    }
    if (cause.event !== 'repository') {
      invalid('workItem.cause.event must be repository for scope-fanout');
    }
    return {
      kind,
      deliveryId: requireFanoutDeliveryId(cause.deliveryId),
      rootDeliveryId: requireOpaqueAscii(
        cause.rootDeliveryId,
        'workItem.cause.rootDeliveryId',
        128,
      ),
      scopeSchemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1,
      fanoutGeneration: requirePositiveId(
        cause.fanoutGeneration,
        'workItem.cause.fanoutGeneration',
      ),
      event: cause.event,
      action: requireSupportedAction(
        cause.action,
        'workItem.cause.action',
        STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1,
        cause.event,
      ),
      receivedAt: requireCanonicalUtcTimestamp(
        cause.receivedAt,
        'workItem.cause.receivedAt',
      ),
    };
  }
  if (
    kind === 'scope-fanout-2'
    && schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4
  ) {
    requireExactKeys(
      cause,
      [
        'kind',
        'deliveryId',
        'rootDeliveryId',
        'scopeSchemaVersion',
        'fanoutGeneration',
        'event',
        'action',
        'ref',
        'receivedAt',
      ],
      'workItem.cause',
    );
    if (
      cause.scopeSchemaVersion
      !== STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2
    ) {
      invalid('workItem.cause.scopeSchemaVersion must be 2');
    }
    const rootDeliveryId = requireOpaqueAscii(
      cause.rootDeliveryId,
      'workItem.cause.rootDeliveryId',
      128,
    );
    let scopeCause: StewardRuntimeScopeCauseV2;
    try {
      scopeCause = parseStewardRuntimeScopeCauseV2({
        kind: 'github-webhook',
        deliveryId: rootDeliveryId,
        event: cause.event,
        action: cause.action,
        ref: cause.ref,
        receivedAt: cause.receivedAt,
      });
    } catch {
      invalid('workItem.cause is not a valid scope schema version 2 cause');
    }
    return {
      kind,
      deliveryId: requireFanoutDeliveryIdV2(cause.deliveryId),
      rootDeliveryId,
      scopeSchemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2,
      fanoutGeneration: requirePositiveId(
        cause.fanoutGeneration,
        'workItem.cause.fanoutGeneration',
      ),
      event: scopeCause.event,
      action: scopeCause.action,
      ref: scopeCause.ref,
      receivedAt: scopeCause.receivedAt,
    };
  }
  if (
    kind === 'scope-fanout-3'
    && schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5
  ) {
    requireExactKeys(
      cause,
      [
        'kind',
        'deliveryId',
        'rootDeliveryId',
        'installationChild',
        'repositoryFanoutGeneration',
        'event',
        'action',
        'ref',
        'receivedAt',
      ],
      'workItem.cause',
    );
    const installationChild =
      parseInstallationRepositoryChildCommitmentV1(
        cause.installationChild,
      );
    const rootDeliveryId = requireOpaqueAscii(
      cause.rootDeliveryId,
      'workItem.cause.rootDeliveryId',
      128,
    );
    if (rootDeliveryId !== installationChild.rootDeliveryId) {
      invalid(
        'workItem.cause.rootDeliveryId must match the installation child root delivery ID',
      );
    }
    let scopeCause: StewardRuntimeScopeCauseV2;
    try {
      scopeCause = parseStewardRuntimeScopeCauseV2({
        kind: 'github-webhook',
        deliveryId: rootDeliveryId,
        event: cause.event,
        action: cause.action,
        ref: cause.ref,
        receivedAt: cause.receivedAt,
      });
    } catch {
      invalid('workItem.cause is not a valid scope schema version 2 cause');
    }
    if (
      scopeCause.event !== installationChild.cause.event
      || scopeCause.action !== installationChild.cause.action
      || scopeCause.ref !== installationChild.cause.ref
      || scopeCause.receivedAt !== installationChild.cause.receivedAt
    ) {
      invalid(
        'workItem.cause webhook evidence must match the installation child commitment',
      );
    }
    return {
      kind,
      deliveryId: requireFanoutDeliveryIdV3(cause.deliveryId),
      rootDeliveryId,
      installationChild,
      repositoryFanoutGeneration: requirePositiveId(
        cause.repositoryFanoutGeneration,
        'workItem.cause.repositoryFanoutGeneration',
      ),
      event: scopeCause.event,
      action: scopeCause.action,
      ref: scopeCause.ref,
      receivedAt: scopeCause.receivedAt,
    };
  }
  invalid(
    schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3
      ? 'workItem.cause.kind must be one of: internal-probe, github-webhook, scope-fanout'
      : schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4
        ? 'workItem.cause.kind must be one of: internal-probe, github-webhook, scope-fanout-2'
        : schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5
          ? 'workItem.cause.kind must be one of: internal-probe, github-webhook, scope-fanout-3'
          : 'workItem.cause.kind must be one of: internal-probe, github-webhook',
  );
}

function validateOperationCause(
  operation: StewardRuntimeWorkItemOperationV1,
  cause:
    | StewardRuntimeWorkItemCauseV1
    | StewardRuntimeWorkItemCauseV2
    | StewardRuntimeWorkItemCauseV3
    | StewardRuntimeWorkItemCauseV4
    | StewardRuntimeWorkItemCauseV5,
): void {
  if (operation === 'runtime-probe' && cause.kind !== 'internal-probe') {
    invalid('runtime-probe requires an internal-probe cause');
  }
  if (
    operation === 'pull-request-reconcile'
    && cause.kind !== 'github-webhook'
    && cause.kind !== 'scope-fanout'
    && cause.kind !== 'scope-fanout-2'
    && cause.kind !== 'scope-fanout-3'
  ) {
    invalid('pull-request-reconcile requires a GitHub webhook or scope-fanout cause');
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
  if (workItem.schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3) {
    const cause = parseCause(
      workItem.cause,
      STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3,
    );
    validateOperationCause(operation, cause);
    return {
      schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3,
      ...common,
      cause,
    };
  }
  if (workItem.schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4) {
    const cause = parseCause(
      workItem.cause,
      STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4,
    );
    validateOperationCause(operation, cause);
    return {
      schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4,
      ...common,
      cause,
    };
  }
  if (workItem.schemaVersion === STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5) {
    const cause = parseCause(
      workItem.cause,
      STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5,
    );
    validateOperationCause(operation, cause);
    if (
      cause.kind === 'scope-fanout-3'
      && (
        common.installationId !== cause.installationChild.installationId
        || common.subject.repositoryId
          !== cause.installationChild.repositoryId
      )
    ) {
      invalid(
        'workItem installation and repository IDs must match the installation child',
      );
    }
    return {
      schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5,
      ...common,
      cause,
    };
  }
  invalid('workItem.schemaVersion must be one of: 1, 2, 3, 4, 5');
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

export function parseStewardRuntimeWorkItemV3(
  value: unknown,
): StewardRuntimeWorkItemV3 {
  const workItem = parseStewardRuntimeWorkItem(value);
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3) {
    invalid('workItem.schemaVersion must be 3');
  }
  return workItem;
}

export function parseStewardRuntimeWorkItemV4(
  value: unknown,
): StewardRuntimeWorkItemV4 {
  const workItem = parseStewardRuntimeWorkItem(value);
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4) {
    invalid('workItem.schemaVersion must be 4');
  }
  return workItem;
}

export function parseStewardRuntimeWorkItemV5(
  value: unknown,
): StewardRuntimeWorkItemV5 {
  const workItem = parseStewardRuntimeWorkItem(value);
  if (workItem.schemaVersion !== STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5) {
    invalid('workItem.schemaVersion must be 5');
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

export function buildStewardRuntimeWorkItemV3(
  value: BuildStewardRuntimeWorkItemV3Input,
): StewardRuntimeWorkItemV3 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(
    input,
    ['operation', 'installationId', 'subject', 'cause'],
    'builder input',
  );
  return parseStewardRuntimeWorkItemV3({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V3,
    operation: input.operation,
    installationId: input.installationId,
    subject: input.subject,
    cause: input.cause,
  });
}

export function buildStewardRuntimeWorkItemV4(
  value: BuildStewardRuntimeWorkItemV4Input,
): StewardRuntimeWorkItemV4 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(
    input,
    ['operation', 'installationId', 'subject', 'cause'],
    'builder input',
  );
  return parseStewardRuntimeWorkItemV4({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V4,
    operation: input.operation,
    installationId: input.installationId,
    subject: input.subject,
    cause: input.cause,
  });
}

export function buildStewardRuntimeWorkItemV5(
  value: BuildStewardRuntimeWorkItemV5Input,
): StewardRuntimeWorkItemV5 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(
    input,
    ['operation', 'installationId', 'subject', 'cause'],
    'builder input',
  );
  return parseStewardRuntimeWorkItemV5({
    schemaVersion: STEWARD_RUNTIME_WORK_ITEM_SCHEMA_VERSION_V5,
    operation: input.operation,
    installationId: input.installationId,
    subject: input.subject,
    cause: input.cause,
  });
}

function installationRepositoryChildCommitmentValue(
  child: StewardRuntimeInstallationRepositoryChildV1,
): Record<string, unknown> {
  return {
    schemaVersion: child.schemaVersion,
    operation: child.operation,
    rootDigest: child.rootDigest,
    rootTargetDigest: child.rootTargetDigest,
    rootDeliveryId: child.rootDeliveryId,
    rootTargetScope: child.rootTargetScope,
    installationId: child.installationId,
    repositoryId: child.repositoryId,
    installationGeneration: child.installationGeneration,
    cause: {
      kind: child.cause.kind,
      deliveryId: child.cause.deliveryId,
      event: child.cause.event,
      action: child.cause.action,
      ref: child.cause.ref,
      receivedAt: child.cause.receivedAt,
    },
    deliveryId: child.deliveryId,
  };
}

export function canonicalStewardRuntimeWorkItemJson(value: unknown): string {
  const workItem = parseStewardRuntimeWorkItem(value);
  const cause = workItem.cause.kind === 'internal-probe'
    ? {
        kind: workItem.cause.kind,
        deliveryId: workItem.cause.deliveryId,
        receivedAt: workItem.cause.receivedAt,
      }
    : workItem.cause.kind === 'github-webhook'
      ? {
          kind: workItem.cause.kind,
          deliveryId: workItem.cause.deliveryId,
          event: workItem.cause.event,
          action: workItem.cause.action,
          receivedAt: workItem.cause.receivedAt,
        }
      : workItem.cause.kind === 'scope-fanout'
        ? {
          kind: workItem.cause.kind,
          deliveryId: workItem.cause.deliveryId,
          rootDeliveryId: workItem.cause.rootDeliveryId,
          scopeSchemaVersion: workItem.cause.scopeSchemaVersion,
          fanoutGeneration: workItem.cause.fanoutGeneration,
          event: workItem.cause.event,
          action: workItem.cause.action,
          receivedAt: workItem.cause.receivedAt,
        }
        : workItem.cause.kind === 'scope-fanout-2'
          ? {
            kind: workItem.cause.kind,
            deliveryId: workItem.cause.deliveryId,
            rootDeliveryId: workItem.cause.rootDeliveryId,
            scopeSchemaVersion: workItem.cause.scopeSchemaVersion,
            fanoutGeneration: workItem.cause.fanoutGeneration,
            event: workItem.cause.event,
            action: workItem.cause.action,
            ref: workItem.cause.ref,
            receivedAt: workItem.cause.receivedAt,
          }
          : {
              kind: workItem.cause.kind,
              deliveryId: workItem.cause.deliveryId,
              rootDeliveryId: workItem.cause.rootDeliveryId,
              installationChild: installationRepositoryChildCommitmentValue(
                workItem.cause.installationChild,
              ),
              repositoryFanoutGeneration:
                workItem.cause.repositoryFanoutGeneration,
              event: workItem.cause.event,
              action: workItem.cause.action,
              ref: workItem.cause.ref,
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
