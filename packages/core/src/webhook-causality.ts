export interface StewardWebhookCausalityContract {
  readonly propertyNames: readonly string[];
  readonly maintainerTeamId: number;
  readonly maintainerTeamSlug: string;
}

export interface TrustedWebhookCausalityInput {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
}

export type WebhookCausalityLiveRead =
  | 'installation'
  | 'installation-repositories'
  | 'organization-property-schema'
  | 'repository'
  | 'repository-property-values'
  | 'maintainer-team'
  | 'maintainer-team-members'
  | 'maintainer-team-repository-access'
  | 'open-pull-requests'
  | 'pull-request-governance-inputs';

export type WebhookCausalityCause =
  | 'organization-property-schema-changed'
  | 'repository-property-values-changed'
  | 'maintainer-team-membership-changed'
  | 'maintainer-team-definition-changed'
  | 'maintainer-team-repository-access-changed'
  | 'repository-lifecycle-changed'
  | 'repository-deleted'
  | 'installation-lifecycle-changed'
  | 'installation-suspended'
  | 'installation-deleted'
  | 'installation-repositories-added'
  | 'installation-repositories-removed'
  | 'installation-target-renamed';

export type WebhookCausalityTarget =
  | {
      readonly scope: 'installation';
      /** Live suspension or absence must converge the durable index; it is not a retry-only error. */
      readonly mode: 'refresh';
      readonly installationId: number;
      readonly repositories: 'all-live';
      readonly pullRequests: 'all-open';
      readonly accountId?: number;
    }
  | {
      readonly scope: 'repository';
      /** A live 404 means tombstone this stable repository ID, including for stale/out-of-order events. */
      readonly mode: 'refresh';
      readonly installationId: number;
      readonly repositoryId: number;
      readonly pullRequests: 'all-open';
    }
  | {
      readonly scope: 'repository-set';
      /** Each ID is re-read independently; a missing repository is tombstoned. */
      readonly mode: 'refresh';
      readonly installationId: number;
      readonly repositoryIds: readonly number[];
      readonly pullRequests: 'all-open';
    };

export interface WebhookCausalityReconcileDecision {
  readonly disposition: 'reconcile';
  readonly cause: WebhookCausalityCause;
  readonly target: WebhookCausalityTarget;
  readonly liveReads: readonly WebhookCausalityLiveRead[];
}

export interface WebhookCausalityIgnoreDecision {
  readonly disposition: 'ignore';
  readonly reason:
    | 'unsupported-event'
    | 'unrelated-property'
    | 'unrelated-team'
    | 'out-of-scope-installation-target';
}

export interface WebhookCausalityQuarantineDecision {
  readonly disposition: 'quarantine';
  readonly reason: 'malformed-payload' | 'action-mismatch' | 'unsupported-action';
  readonly field: string;
}

export type WebhookCausalityDecision =
  | WebhookCausalityReconcileDecision
  | WebhookCausalityIgnoreDecision
  | WebhookCausalityQuarantineDecision;

type JsonRecord = Record<string, unknown>;

const installationRefreshReads = [
  'installation',
  'installation-repositories',
  'organization-property-schema',
  'repository',
  'repository-property-values',
  'maintainer-team',
  'maintainer-team-members',
  'maintainer-team-repository-access',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

const repositoryRefreshReads = [
  'installation',
  'repository',
  'organization-property-schema',
  'repository-property-values',
  'maintainer-team',
  'maintainer-team-members',
  'maintainer-team-repository-access',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

const propertySchemaReads = [
  'installation',
  'installation-repositories',
  'organization-property-schema',
  'repository',
  'repository-property-values',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

const propertyValueReads = [
  'installation',
  'repository',
  'organization-property-schema',
  'repository-property-values',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

const teamInstallationReads = [
  'installation',
  'installation-repositories',
  'repository',
  'maintainer-team',
  'maintainer-team-members',
  'maintainer-team-repository-access',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

const teamRepositoryReads = [
  'installation',
  'repository',
  'maintainer-team',
  'maintainer-team-members',
  'maintainer-team-repository-access',
  'open-pull-requests',
  'pull-request-governance-inputs',
] as const satisfies readonly WebhookCausalityLiveRead[];

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function quarantine(
  reason: WebhookCausalityQuarantineDecision['reason'],
  field: string,
): WebhookCausalityQuarantineDecision {
  return { disposition: 'quarantine', reason, field };
}

function ignore(reason: WebhookCausalityIgnoreDecision['reason']): WebhookCausalityIgnoreDecision {
  return { disposition: 'ignore', reason };
}

function reconcile(
  cause: WebhookCausalityCause,
  target: WebhookCausalityTarget,
  liveReads: readonly WebhookCausalityLiveRead[],
): WebhookCausalityReconcileDecision {
  return { disposition: 'reconcile', cause, target, liveReads };
}

function checkedPayload(
  input: TrustedWebhookCausalityInput,
  actionless = false,
): { readonly ok: true; readonly payload: JsonRecord }
  | { readonly ok: false; readonly decision: WebhookCausalityQuarantineDecision } {
  const payload = record(input.payload);
  if (!payload) {
    return { ok: false, decision: quarantine('malformed-payload', 'payload') };
  }

  if (actionless) {
    if (input.action !== null) {
      return { ok: false, decision: quarantine('action-mismatch', 'action') };
    }
    if ('action' in payload && payload.action !== null && payload.action !== undefined) {
      return { ok: false, decision: quarantine('action-mismatch', 'payload.action') };
    }
    return { ok: true, payload };
  }

  if (typeof input.action !== 'string' || payload.action !== input.action) {
    return { ok: false, decision: quarantine('action-mismatch', 'payload.action') };
  }
  return { ok: true, payload };
}

function installationId(payload: JsonRecord): number | null {
  return positiveId(record(payload.installation)?.id);
}

function repositoryId(payload: JsonRecord): number | null {
  return positiveId(record(payload.repository)?.id);
}

function teamId(payload: JsonRecord): number | null {
  return positiveId(record(payload.team)?.id);
}

function installationTarget(installation: number, accountId?: number): WebhookCausalityTarget {
  return {
    scope: 'installation',
    mode: 'refresh',
    installationId: installation,
    repositories: 'all-live',
    pullRequests: 'all-open',
    ...(accountId === undefined ? {} : { accountId }),
  };
}

function repositoryTarget(installation: number, repository: number): WebhookCausalityTarget {
  return {
    scope: 'repository',
    mode: 'refresh',
    installationId: installation,
    repositoryId: repository,
    pullRequests: 'all-open',
  };
}

function readRepositoryIds(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const item of value) {
    const id = positiveId(record(item)?.id);
    if (id === null) return null;
    ids.push(id);
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

function classifyCustomProperty(
  input: TrustedWebhookCausalityInput,
  propertyNames: ReadonlySet<string>,
): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (!['created', 'updated', 'deleted', 'promote_to_enterprise'].includes(input.action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  const definition = record(payload.definition);
  const currentName = definition?.property_name;
  if (typeof currentName !== 'string' || currentName.length === 0) {
    return quarantine('malformed-payload', 'definition.property_name');
  }

  // GitHub's documented custom_property.updated payload has no prior-name or
  // field-delta contract. The definition may therefore already contain a
  // post-rename name; every valid update must reread the live schema.
  if (input.action !== 'updated' && !propertyNames.has(currentName)) {
    return ignore('unrelated-property');
  }
  return reconcile(
    'organization-property-schema-changed',
    installationTarget(installation),
    propertySchemaReads,
  );
}

function classifyCustomPropertyValues(
  input: TrustedWebhookCausalityInput,
): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (input.action !== 'updated') return quarantine('unsupported-action', 'action');

  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  const repository = repositoryId(payload);
  if (repository === null) return quarantine('malformed-payload', 'repository.id');
  return reconcile(
    'repository-property-values-changed',
    repositoryTarget(installation, repository),
    propertyValueReads,
  );
}

function classifyMembership(
  input: TrustedWebhookCausalityInput,
  maintainerTeamId: number,
): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (!['added', 'removed'].includes(input.action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const observedTeamId = teamId(payload);
  if (observedTeamId === null) return quarantine('malformed-payload', 'team.id');
  if (observedTeamId !== maintainerTeamId) return ignore('unrelated-team');
  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  if (payload.scope !== 'team') return quarantine('malformed-payload', 'scope');
  if (!('member' in payload)) return quarantine('malformed-payload', 'member');
  if (payload.member !== null && positiveId(record(payload.member)?.id) === null) {
    return quarantine('malformed-payload', 'member.id');
  }

  return reconcile(
    'maintainer-team-membership-changed',
    installationTarget(installation),
    teamInstallationReads,
  );
}

function classifyTeam(
  input: TrustedWebhookCausalityInput,
  maintainerTeamId: number,
  maintainerTeamSlug: string,
  actionless = false,
): WebhookCausalityDecision {
  const checked = checkedPayload(input, actionless);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  const action = actionless ? 'added_to_repository' : input.action;
  if (!['created', 'edited', 'deleted', 'added_to_repository', 'removed_from_repository']
    .includes(action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const observedTeamId = teamId(payload);
  if (observedTeamId === null) return quarantine('malformed-payload', 'team.id');
  const observedTeamSlug = record(payload.team)?.slug;
  const recreatedMaintainer = action === 'created'
    && typeof observedTeamSlug === 'string'
    && observedTeamSlug.toLowerCase() === maintainerTeamSlug.toLowerCase();
  if (observedTeamId !== maintainerTeamId && !recreatedMaintainer) return ignore('unrelated-team');
  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');

  if (action === 'added_to_repository' || action === 'removed_from_repository') {
    const repository = repositoryId(payload);
    if (repository === null) return quarantine('malformed-payload', 'repository.id');
    return reconcile(
      'maintainer-team-repository-access-changed',
      repositoryTarget(installation, repository),
      teamRepositoryReads,
    );
  }

  if (action === 'edited' && record(record(record(payload.changes)?.repository)?.permissions)) {
    const repository = repositoryId(payload);
    if (repository === null) return quarantine('malformed-payload', 'repository.id');
    return reconcile(
      'maintainer-team-repository-access-changed',
      repositoryTarget(installation, repository),
      teamRepositoryReads,
    );
  }

  return reconcile(
    'maintainer-team-definition-changed',
    installationTarget(installation),
    teamInstallationReads,
  );
}

function classifyRepository(input: TrustedWebhookCausalityInput): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  const refreshActions = [
    'archived', 'created', 'edited', 'privatized', 'publicized', 'renamed', 'transferred', 'unarchived',
  ];
  if (input.action !== 'deleted' && !refreshActions.includes(input.action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  const repository = repositoryId(payload);
  if (repository === null) return quarantine('malformed-payload', 'repository.id');

  if (input.action === 'deleted') {
    return reconcile(
      'repository-deleted',
      repositoryTarget(installation, repository),
      repositoryRefreshReads,
    );
  }
  return reconcile(
    'repository-lifecycle-changed',
    repositoryTarget(installation, repository),
    repositoryRefreshReads,
  );
}

function classifyInstallation(input: TrustedWebhookCausalityInput): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (!['created', 'deleted', 'new_permissions_accepted', 'suspend', 'unsuspend']
    .includes(input.action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  if (input.action === 'deleted' || input.action === 'suspend') {
    return reconcile(
      input.action === 'deleted' ? 'installation-deleted' : 'installation-suspended',
      installationTarget(installation),
      installationRefreshReads,
    );
  }
  return reconcile(
    'installation-lifecycle-changed',
    installationTarget(installation),
    installationRefreshReads,
  );
}

function classifyInstallationRepositories(
  input: TrustedWebhookCausalityInput,
): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (!['added', 'removed'].includes(input.action ?? '')) {
    return quarantine('unsupported-action', 'action');
  }

  const installation = installationId(payload);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  const added = readRepositoryIds(payload.repositories_added);
  if (!added) return quarantine('malformed-payload', 'repositories_added');
  const removed = readRepositoryIds(payload.repositories_removed);
  if (!removed) return quarantine('malformed-payload', 'repositories_removed');
  const repositoryIds = input.action === 'added' ? added : removed;
  const oppositeIds = input.action === 'added' ? removed : added;
  if (repositoryIds.length === 0 || oppositeIds.length !== 0) {
    return quarantine('malformed-payload', 'installation_repositories.delta');
  }

  return reconcile(
    input.action === 'added'
      ? 'installation-repositories-added'
      : 'installation-repositories-removed',
    {
      scope: 'repository-set',
      mode: 'refresh',
      installationId: installation,
      repositoryIds,
      pullRequests: 'all-open',
    },
    input.action === 'added' ? repositoryRefreshReads : installationRefreshReads,
  );
}

function classifyInstallationTarget(input: TrustedWebhookCausalityInput): WebhookCausalityDecision {
  const checked = checkedPayload(input);
  if (!checked.ok) return checked.decision;
  const { payload } = checked;
  if (input.action !== 'renamed') return quarantine('unsupported-action', 'action');

  const installationRecord = record(payload.installation);
  const installation = positiveId(installationRecord?.id);
  if (installation === null) return quarantine('malformed-payload', 'installation.id');
  if (payload.target_type !== 'Organization') return ignore('out-of-scope-installation-target');
  const accountId = positiveId(record(payload.account)?.id);
  if (accountId === null) return quarantine('malformed-payload', 'account.id');
  const installationAccountId = positiveId(record(installationRecord?.account)?.id);
  if (installationAccountId === null || installationAccountId !== accountId) {
    return quarantine('malformed-payload', 'installation.account.id');
  }
  if (!record(payload.changes)) return quarantine('malformed-payload', 'changes');

  return reconcile(
    'installation-target-renamed',
    installationTarget(installation, accountId),
    installationRefreshReads,
  );
}

function validatedContract(contract: StewardWebhookCausalityContract): ReadonlySet<string> {
  if (!Number.isSafeInteger(contract.maintainerTeamId) || contract.maintainerTeamId <= 0) {
    throw new TypeError('maintainerTeamId must be a positive safe integer');
  }
  if (typeof contract.maintainerTeamSlug !== 'string' || !contract.maintainerTeamSlug.trim()) {
    throw new TypeError('maintainerTeamSlug must be a non-empty string');
  }
  const names = new Set<string>();
  for (const name of contract.propertyNames) {
    if (typeof name !== 'string' || name.length === 0 || names.has(name)) {
      throw new TypeError('propertyNames must contain unique non-empty strings');
    }
    names.add(name);
  }
  if (names.size === 0) throw new TypeError('propertyNames must not be empty');
  return names;
}

/**
 * Converts a signature-verified GitHub delivery into a bounded convergence
 * instruction. Payload names are only change hints; routing uses numeric IDs
 * and every refresh target is resolved again from live GitHub state.
 */
export function classifyWebhookCausality(
  input: TrustedWebhookCausalityInput,
  contract: StewardWebhookCausalityContract,
): WebhookCausalityDecision {
  const propertyNames = validatedContract(contract);
  switch (input.event) {
    case 'custom_property':
      return classifyCustomProperty(input, propertyNames);
    case 'custom_property_values':
      return classifyCustomPropertyValues(input);
    case 'membership':
      return classifyMembership(input, contract.maintainerTeamId);
    case 'team':
      return classifyTeam(input, contract.maintainerTeamId, contract.maintainerTeamSlug);
    case 'team_add':
      return classifyTeam(input, contract.maintainerTeamId, contract.maintainerTeamSlug, true);
    case 'repository':
      return classifyRepository(input);
    case 'installation':
      return classifyInstallation(input);
    case 'installation_repositories':
      return classifyInstallationRepositories(input);
    case 'installation_target':
      return classifyInstallationTarget(input);
    default:
      return ignore('unsupported-event');
  }
}
