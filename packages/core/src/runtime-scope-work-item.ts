export const STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1 = 1 as const;
export const STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2 = 2 as const;
export const STEWARD_RUNTIME_SCOPE_WORK_ITEM_CURRENT_SCHEMA_VERSION =
  STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2;

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

export const STEWARD_RUNTIME_CUSTOM_PROPERTY_ACTIONS_V2 = [
  'created',
  'updated',
  'deleted',
  'promote_to_enterprise',
] as const;

export const STEWARD_RUNTIME_CUSTOM_PROPERTY_VALUES_ACTIONS_V2 = [
  'updated',
] as const;

export const STEWARD_RUNTIME_MEMBERSHIP_ACTIONS_V2 = [
  'added',
  'removed',
] as const;

export const STEWARD_RUNTIME_TEAM_ACTIONS_V2 = [
  'created',
  'edited',
  'deleted',
  'added_to_repository',
  'removed_from_repository',
] as const;

export const STEWARD_RUNTIME_INSTALLATION_ACTIONS_V2 = [
  'created',
  'deleted',
  'new_permissions_accepted',
  'suspend',
  'unsuspend',
] as const;

export const STEWARD_RUNTIME_INSTALLATION_REPOSITORIES_ACTIONS_V2 = [
  'added',
  'removed',
] as const;

export const STEWARD_RUNTIME_INSTALLATION_TARGET_ACTIONS_V2 = [
  'renamed',
] as const;

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

export interface StewardRuntimeInstallationScopeTargetV2 {
  readonly scope: 'installation';
  readonly mode: 'refresh';
  readonly installationId: number;
  readonly repositories: 'all-live';
  readonly pullRequests: 'all-open';
  readonly accountId?: number;
}

export interface StewardRuntimeRepositoryScopeTargetV2 {
  readonly scope: 'repository';
  readonly mode: 'refresh';
  readonly installationId: number;
  readonly repositoryId: number;
  readonly pullRequests: 'all-open';
}

export interface StewardRuntimeRepositorySetScopeTargetV2 {
  readonly scope: 'repository-set';
  readonly mode: 'refresh';
  readonly installationId: number;
  readonly repositoryIds: readonly number[];
  readonly pullRequests: 'all-open';
}

export type StewardRuntimeScopeTargetV2 =
  | StewardRuntimeInstallationScopeTargetV2
  | StewardRuntimeRepositoryScopeTargetV2
  | StewardRuntimeRepositorySetScopeTargetV2;

interface StewardRuntimeScopeCauseBaseV2 {
  readonly kind: 'github-webhook';
  readonly deliveryId: string;
  readonly receivedAt: string;
}

export type StewardRuntimeScopeCauseV2 =
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'custom_property';
      readonly action: (typeof STEWARD_RUNTIME_CUSTOM_PROPERTY_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'custom_property_values';
      readonly action: (typeof STEWARD_RUNTIME_CUSTOM_PROPERTY_VALUES_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'membership';
      readonly action: (typeof STEWARD_RUNTIME_MEMBERSHIP_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'team';
      readonly action: (typeof STEWARD_RUNTIME_TEAM_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'team_add';
      readonly action: null;
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'repository';
      readonly action: StewardRuntimeRepositoryActionV1;
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'installation';
      readonly action: (typeof STEWARD_RUNTIME_INSTALLATION_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'installation_repositories';
      readonly action:
        (typeof STEWARD_RUNTIME_INSTALLATION_REPOSITORIES_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'installation_target';
      readonly action: (typeof STEWARD_RUNTIME_INSTALLATION_TARGET_ACTIONS_V2)[number];
      readonly ref: null;
    }
  | StewardRuntimeScopeCauseBaseV2 & {
      readonly event: 'push';
      readonly action: null;
      readonly ref: string;
    };

export interface StewardRuntimeScopeWorkItemV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2;
  readonly operation: 'scope-reconcile';
  readonly target: StewardRuntimeScopeTargetV2;
  readonly cause: StewardRuntimeScopeCauseV2;
}

export type StewardRuntimeScopeWorkItem =
  | StewardRuntimeScopeWorkItemV1
  | StewardRuntimeScopeWorkItemV2;

export type BuildStewardRuntimeScopeWorkItemV1Input =
  Omit<StewardRuntimeScopeWorkItemV1, 'schemaVersion'>;

export type BuildStewardRuntimeScopeWorkItemV2Input =
  Omit<StewardRuntimeScopeWorkItemV2, 'schemaVersion'>;

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
const gitRefControlPattern = /[\x00-\x20\x7f]/;

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

function requireSupportedAction<Action extends string>(
  value: unknown,
  field: string,
  supported: readonly Action[],
  event: string,
): Action {
  if (
    typeof value !== 'string'
    || !(supported as readonly string[]).includes(value)
  ) {
    invalid(`${field} is not supported for ${event}`);
  }
  return value as Action;
}

function requireGitRef(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !value.startsWith('refs/')
    || value.length <= 'refs/'.length
    || gitRefControlPattern.test(value)
    || new TextEncoder().encode(value).byteLength > 1_024
  ) {
    invalid(`${field} must be a canonical Git ref of at most 1024 UTF-8 bytes`);
  }
  return value;
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

function parseScopeTargetV2(value: unknown): StewardRuntimeScopeTargetV2 {
  const target = plainRecord(value, 'workItem.target');
  if (target.scope === 'installation') {
    requireExactKeys(
      target,
      'accountId' in target
        ? [
            'scope',
            'mode',
            'installationId',
            'repositories',
            'pullRequests',
            'accountId',
          ]
        : ['scope', 'mode', 'installationId', 'repositories', 'pullRequests'],
      'workItem.target',
    );
    if (target.mode !== 'refresh') {
      invalid('workItem.target.mode must be refresh');
    }
    if (target.repositories !== 'all-live') {
      invalid('workItem.target.repositories must be all-live');
    }
    if (target.pullRequests !== 'all-open') {
      invalid('workItem.target.pullRequests must be all-open');
    }
    return {
      scope: 'installation',
      mode: 'refresh',
      installationId: requirePositiveId(
        target.installationId,
        'workItem.target.installationId',
      ),
      repositories: 'all-live',
      pullRequests: 'all-open',
      ...('accountId' in target
        ? {
            accountId: requirePositiveId(
              target.accountId,
              'workItem.target.accountId',
            ),
          }
        : {}),
    };
  }
  if (target.scope === 'repository') {
    requireExactKeys(
      target,
      ['scope', 'mode', 'installationId', 'repositoryId', 'pullRequests'],
      'workItem.target',
    );
    if (target.mode !== 'refresh') {
      invalid('workItem.target.mode must be refresh');
    }
    if (target.pullRequests !== 'all-open') {
      invalid('workItem.target.pullRequests must be all-open');
    }
    return {
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
    };
  }
  if (target.scope === 'repository-set') {
    requireExactKeys(
      target,
      ['scope', 'mode', 'installationId', 'repositoryIds', 'pullRequests'],
      'workItem.target',
    );
    if (target.mode !== 'refresh') {
      invalid('workItem.target.mode must be refresh');
    }
    if (target.pullRequests !== 'all-open') {
      invalid('workItem.target.pullRequests must be all-open');
    }
    if (!Array.isArray(target.repositoryIds)) {
      invalid('workItem.target.repositoryIds must be an array');
    }
    const repositoryIds = target.repositoryIds.map((repositoryId, index) =>
      requirePositiveId(
        repositoryId,
        `workItem.target.repositoryIds[${index}]`,
      ));
    if (
      repositoryIds.some(
        (repositoryId, index) =>
          index > 0 && repositoryId <= (repositoryIds[index - 1] ?? 0),
      )
    ) {
      invalid('workItem.target.repositoryIds must be unique and ascending');
    }
    return {
      scope: 'repository-set',
      mode: 'refresh',
      installationId: requirePositiveId(
        target.installationId,
        'workItem.target.installationId',
      ),
      repositoryIds,
      pullRequests: 'all-open',
    };
  }
  invalid('workItem.target.scope is not supported in schema version 2');
}

export function parseStewardRuntimeScopeCauseV2(
  value: unknown,
): StewardRuntimeScopeCauseV2 {
  const cause = plainRecord(value, 'workItem.cause');
  requireExactKeys(
    cause,
    ['kind', 'deliveryId', 'event', 'action', 'ref', 'receivedAt'],
    'workItem.cause',
  );
  if (cause.kind !== 'github-webhook') {
    invalid('workItem.cause.kind must be github-webhook');
  }
  const deliveryId = requireOpaqueAscii(
    cause.deliveryId,
    'workItem.cause.deliveryId',
    128,
  );
  const receivedAt = requireCanonicalUtcTimestamp(
    cause.receivedAt,
    'workItem.cause.receivedAt',
  );
  if (cause.event === 'push') {
    if (cause.action !== null) {
      invalid('workItem.cause.action must be null for push');
    }
    return {
      kind: 'github-webhook',
      deliveryId,
      event: 'push',
      action: null,
      ref: requireGitRef(cause.ref, 'workItem.cause.ref'),
      receivedAt,
    };
  }
  if (cause.ref !== null) {
    invalid('workItem.cause.ref must be null unless event is push');
  }
  switch (cause.event) {
    case 'custom_property':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_CUSTOM_PROPERTY_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'custom_property_values':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_CUSTOM_PROPERTY_VALUES_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'membership':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_MEMBERSHIP_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'team':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_TEAM_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'team_add':
      if (cause.action !== null) {
        invalid('workItem.cause.action must be null for team_add');
      }
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: null,
        ref: null,
        receivedAt,
      };
    case 'repository':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireRepositoryAction(
          cause.action,
          'workItem.cause.action',
        ),
        ref: null,
        receivedAt,
      };
    case 'installation':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_INSTALLATION_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'installation_repositories':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_INSTALLATION_REPOSITORIES_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    case 'installation_target':
      return {
        kind: 'github-webhook',
        deliveryId,
        event: cause.event,
        action: requireSupportedAction(
          cause.action,
          'workItem.cause.action',
          STEWARD_RUNTIME_INSTALLATION_TARGET_ACTIONS_V2,
          cause.event,
        ),
        ref: null,
        receivedAt,
      };
    default:
      invalid('workItem.cause.event is not supported in schema version 2');
  }
}

function validateScopeCauseTargetV2(
  cause: StewardRuntimeScopeCauseV2,
  target: StewardRuntimeScopeTargetV2,
): void {
  if (cause.event === 'installation') {
    if (target.scope === 'installation') return;
    if (
      target.scope === 'repository-set'
      && (cause.action === 'suspend' || cause.action === 'deleted')
    ) {
      return;
    }
    invalid(
      cause.action === 'suspend' || cause.action === 'deleted'
        ? 'workItem.target.scope must be installation or repository-set for installation teardown'
        : 'workItem.target.scope must be installation for installation',
    );
  }
  if (
    target.scope === 'repository-set'
    && target.repositoryIds.length === 0
  ) {
    invalid(
      'workItem.target.repositoryIds may be empty only for installation teardown',
    );
  }
  const expectedScope = cause.event === 'custom_property_values'
    || cause.event === 'repository'
    || cause.event === 'team_add'
    || cause.event === 'push'
    || (
      cause.event === 'team'
      && (
        cause.action === 'added_to_repository'
        || cause.action === 'removed_from_repository'
      )
    )
    ? 'repository'
    : cause.event === 'installation_repositories'
      ? 'repository-set'
      : cause.event === 'team' && cause.action === 'edited'
        ? null
        : 'installation';
  if (expectedScope !== null && target.scope !== expectedScope) {
    invalid(`workItem.target.scope must be ${expectedScope} for ${cause.event}`);
  }
  if (
    cause.event === 'team'
    && cause.action === 'edited'
    && target.scope === 'repository-set'
  ) {
    invalid('workItem.target.scope must be installation or repository for team edited');
  }
}

export function parseStewardRuntimeScopeWorkItemV2(
  value: unknown,
): StewardRuntimeScopeWorkItemV2 {
  const workItem = plainRecord(value, 'workItem');
  requireExactKeys(
    workItem,
    ['schemaVersion', 'operation', 'target', 'cause'],
    'workItem',
  );
  if (workItem.schemaVersion !== STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2) {
    invalid('workItem.schemaVersion must be 2');
  }
  if (workItem.operation !== 'scope-reconcile') {
    invalid('workItem.operation must be scope-reconcile');
  }
  const target = parseScopeTargetV2(workItem.target);
  const cause = parseStewardRuntimeScopeCauseV2(workItem.cause);
  validateScopeCauseTargetV2(cause, target);
  return {
    schemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2,
    operation: 'scope-reconcile',
    target,
    cause,
  };
}

export function parseStewardRuntimeScopeWorkItem(
  value: unknown,
): StewardRuntimeScopeWorkItem {
  const workItem = plainRecord(value, 'workItem');
  if (workItem.schemaVersion === STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1) {
    return parseStewardRuntimeScopeWorkItemV1(value);
  }
  if (workItem.schemaVersion === STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2) {
    return parseStewardRuntimeScopeWorkItemV2(value);
  }
  invalid('workItem.schemaVersion must be one of: 1, 2');
}

export function buildStewardRuntimeScopeWorkItemV2(
  value: BuildStewardRuntimeScopeWorkItemV2Input,
): StewardRuntimeScopeWorkItemV2 {
  const input = plainRecord(value, 'builder input');
  requireExactKeys(input, ['operation', 'target', 'cause'], 'builder input');
  return parseStewardRuntimeScopeWorkItemV2({
    schemaVersion: STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V2,
    operation: input.operation,
    target: input.target,
    cause: input.cause,
  });
}

export function canonicalStewardRuntimeScopeWorkItemJson(value: unknown): string {
  const workItem = parseStewardRuntimeScopeWorkItem(value);
  const target = workItem.schemaVersion === STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1
    ? {
        scope: workItem.target.scope,
        mode: workItem.target.mode,
        installationId: workItem.target.installationId,
        repositoryId: workItem.target.repositoryId,
        pullRequests: workItem.target.pullRequests,
      }
    : workItem.target.scope === 'installation'
      ? {
          scope: workItem.target.scope,
          mode: workItem.target.mode,
          installationId: workItem.target.installationId,
          repositories: workItem.target.repositories,
          pullRequests: workItem.target.pullRequests,
          ...(workItem.target.accountId === undefined
            ? {}
            : { accountId: workItem.target.accountId }),
        }
      : workItem.target.scope === 'repository'
        ? {
            scope: workItem.target.scope,
            mode: workItem.target.mode,
            installationId: workItem.target.installationId,
            repositoryId: workItem.target.repositoryId,
            pullRequests: workItem.target.pullRequests,
          }
        : {
            scope: workItem.target.scope,
            mode: workItem.target.mode,
            installationId: workItem.target.installationId,
            repositoryIds: [...workItem.target.repositoryIds],
            pullRequests: workItem.target.pullRequests,
          };
  const cause = workItem.schemaVersion === STEWARD_RUNTIME_SCOPE_WORK_ITEM_SCHEMA_VERSION_V1
    ? {
        kind: workItem.cause.kind,
        deliveryId: workItem.cause.deliveryId,
        event: workItem.cause.event,
        action: workItem.cause.action,
        receivedAt: workItem.cause.receivedAt,
      }
    : {
        kind: workItem.cause.kind,
        deliveryId: workItem.cause.deliveryId,
        event: workItem.cause.event,
        action: workItem.cause.action,
        ref: workItem.cause.ref,
        receivedAt: workItem.cause.receivedAt,
      };
  return JSON.stringify({
    schemaVersion: workItem.schemaVersion,
    operation: workItem.operation,
    target,
    cause,
  });
}
