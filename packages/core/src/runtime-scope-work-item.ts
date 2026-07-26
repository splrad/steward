export const STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1 = 1 as const;

export const STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1 = [
  'archived',
  'created',
  'deleted',
  'edited',
  'privatized',
  'publicized',
  'renamed',
  'transferred',
  'unarchived',
] as const;

export type StewardRuntimeRepositoryActionV1 =
  (typeof STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1)[number];

export interface StewardRuntimeRepositoryScopeTargetV1 {
  readonly scope: 'repository';
  readonly mode: 'refresh';
  readonly installationId: number;
  readonly repositoryId: number;
  readonly pullRequests: 'all-open';
}

export interface StewardRuntimeRepositoryScopeCauseV1 {
  readonly kind: 'github-webhook';
  readonly deliveryId: string;
  readonly event: 'repository';
  readonly action: StewardRuntimeRepositoryActionV1;
  readonly receivedAt: string;
}

export interface StewardRuntimeScopeWorkItemV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1;
  readonly operation: 'scope-reconcile';
  readonly target: StewardRuntimeRepositoryScopeTargetV1;
  readonly cause: StewardRuntimeRepositoryScopeCauseV1;
}

export type BuildStewardRuntimeScopeWorkItemV1Input =
  Omit<StewardRuntimeScopeWorkItemV1, 'schemaVersion'>;

export class RuntimeScopeWorkItemValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime scope work item: ${message}`);
    this.name = 'RuntimeScopeWorkItemValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

const canonicalUtcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const opaqueAsciiPattern = /^[\x21-\x7e]+$/;

function invalid(message: string): never {
  throw new RuntimeScopeWorkItemValidationError(message);
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

function requireOpaqueAscii(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || !opaqueAsciiPattern.test(value)
  ) {
    invalid(`${field} must be 1-${maximumLength} canonical visible ASCII characters`);
  }
  return value;
}

function requireCanonicalUtcTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !canonicalUtcTimestampPattern.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid(`${field} must be a canonical UTC Date.toISOString timestamp`);
  }
  return value;
}

function requireRepositoryAction(value: unknown, field: string): StewardRuntimeRepositoryActionV1 {
  if (
    typeof value !== 'string'
    || !(STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1 as readonly string[]).includes(value)
  ) {
    invalid(`${field} is not supported for repository`);
  }
  return value as StewardRuntimeRepositoryActionV1;
}

export function parseStewardRuntimeScopeWorkItemV1(
  value: unknown,
): StewardRuntimeScopeWorkItemV1 {
  const workItem = plainRecord(value, 'workItem');
  requireExactKeys(
    workItem,
    ['schemaVersion', 'operation', 'target', 'cause'],
    'workItem',
  );
  if (workItem.schemaVersion !== STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1) {
    invalid('workItem.schemaVersion must be 1');
  }
  if (workItem.operation !== 'scope-reconcile') {
    invalid('workItem.operation must be scope-reconcile');
  }

  const target = plainRecord(workItem.target, 'workItem.target');
  requireExactKeys(
    target,
    ['scope', 'mode', 'installationId', 'repositoryId', 'pullRequests'],
    'workItem.target',
  );
  if (target.scope !== 'repository') {
    invalid('workItem.target.scope must be repository');
  }
  if (target.mode !== 'refresh') {
    invalid('workItem.target.mode must be refresh');
  }
  if (target.pullRequests !== 'all-open') {
    invalid('workItem.target.pullRequests must be all-open');
  }

  const cause = plainRecord(workItem.cause, 'workItem.cause');
  requireExactKeys(
    cause,
    ['kind', 'deliveryId', 'event', 'action', 'receivedAt'],
    'workItem.cause',
  );
  if (cause.kind !== 'github-webhook') {
    invalid('workItem.cause.kind must be github-webhook');
  }
  if (cause.event !== 'repository') {
    invalid('workItem.cause.event must be repository');
  }

  return {
    schemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1,
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: requirePositiveId(
        target.installationId,
        'workItem.target.installationId',
      ),
      repositoryId: requirePositiveId(
        target.repositoryId,
        'workItem.target.repositoryId',
      ),
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: requireOpaqueAscii(
        cause.deliveryId,
        'workItem.cause.deliveryId',
        128,
      ),
      event: 'repository',
      action: requireRepositoryAction(cause.action, 'workItem.cause.action'),
      receivedAt: requireCanonicalUtcTimestamp(
        cause.receivedAt,
        'workItem.cause.receivedAt',
      ),
    },
  };
}

export function buildStewardRuntimeScopeWorkItemV1(
  value: BuildStewardRuntimeScopeWorkItemV1Input,
): StewardRuntimeScopeWorkItemV1 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(input, ['operation', 'target', 'cause'], 'builder input');
  return parseStewardRuntimeScopeWorkItemV1({
    schemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1,
    operation: input.operation,
    target: input.target,
    cause: input.cause,
  });
}

export function canonicalStewardRuntimeScopeWorkItemJson(value: unknown): string {
  const workItem = parseStewardRuntimeScopeWorkItemV1(value);
  return JSON.stringify({
    schemaVersion: workItem.schemaVersion,
    operation: workItem.operation,
    target: {
      scope: workItem.target.scope,
      mode: workItem.target.mode,
      installationId: workItem.target.installationId,
      repositoryId: workItem.target.repositoryId,
      pullRequests: workItem.target.pullRequests,
    },
    cause: {
      kind: workItem.cause.kind,
      deliveryId: workItem.cause.deliveryId,
      event: workItem.cause.event,
      action: workItem.cause.action,
      receivedAt: workItem.cause.receivedAt,
    },
  });
}
