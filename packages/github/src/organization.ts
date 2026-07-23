import { fetchPullRequestPages, GitHubPaginationError } from './pagination.js';
import {
  GitHubApiError,
  GitHubTransportError,
  type GitHubRequest,
  type GitHubTransport,
} from './transport.js';

export interface GitHubReadEvidence {
  readonly source: 'github-rest' | 'github-ui-attestation' | 'github-documentation';
  readonly endpoint: string;
  readonly observedAt: string;
  readonly apiVersion?: string;
  readonly relatedEndpoints?: readonly string[];
  readonly blockedEndpoint?: string;
}

export type GitHubUnknownReason =
  | 'permission-denied'
  | 'rate-limited'
  | 'not-found-or-hidden'
  | 'api-error'
  | 'dependency-unavailable'
  | 'conflicting-observations'
  | 'invalid-response'
  | 'incomplete-pagination'
  | 'unsupported';

export type GitHubReadResult<T> =
  | { readonly status: 'known'; readonly value: T; readonly evidence: GitHubReadEvidence }
  | { readonly status: 'not-configured'; readonly evidence: GitHubReadEvidence }
  | {
    readonly status: 'unknown';
    readonly reason: GitHubUnknownReason;
    readonly evidence: GitHubReadEvidence;
    readonly httpStatus?: number;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number;
    readonly requestId?: string;
  };

export type GitHubPropertyValue = string | readonly string[] | null;

export interface GitHubOrganizationPropertyDefinition {
  readonly name: string;
  readonly sourceType: 'organization' | 'enterprise';
  readonly valueType: 'string' | 'single_select' | 'multi_select' | 'true_false' | 'url';
  readonly required: boolean;
  readonly defaultValue: GitHubPropertyValue;
  readonly allowedValues: readonly string[] | null;
  readonly valuesEditableBy: 'org_actors' | 'org_and_repo_actors' | null;
  readonly requireExplicitValues: boolean;
}

export interface GitHubRepositoryPropertyValue {
  readonly name: string;
  readonly value: GitHubPropertyValue;
}

export interface GitHubRulesetRule {
  readonly type: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface GitHubRulesetBypassActor {
  readonly actorId: number | null;
  readonly actorType: string;
  readonly bypassMode: string;
}

export interface GitHubRulesetDefinition {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly sourceType: 'Repository' | 'Organization' | 'Enterprise';
  readonly source: string;
  readonly conditions: Readonly<Record<string, unknown>>;
  readonly rules: readonly GitHubRulesetRule[];
  readonly bypassActorsObserved: boolean;
  readonly bypassActors: readonly GitHubRulesetBypassActor[];
}

export interface GitHubRulesetSummary {
  readonly id: number;
  readonly name: string;
  readonly sourceType: 'Repository' | 'Organization' | 'Enterprise';
  readonly source: string;
  readonly enforcement: string;
}

export interface GitHubEffectiveRule extends GitHubRulesetRule {
  readonly rulesetId: number;
  readonly rulesetSourceType: 'Repository' | 'Organization' | 'Enterprise';
  readonly rulesetSource: string;
}

export interface GitHubTeamRepositoryAccess {
  readonly teamId: number;
  readonly teamSlug: string;
  readonly roleName: string;
  readonly permissions: {
    readonly admin: boolean;
    readonly maintain: boolean;
    readonly push: boolean;
    readonly triage: boolean;
    readonly pull: boolean;
  };
}

export interface GitHubAppInstallationFacts {
  readonly installationId: number;
  readonly appId: number;
  readonly appSlug: string;
  readonly clientId?: string;
  readonly accountLogin?: string;
  readonly repositorySelection: 'all' | 'selected';
  readonly repositoryAccess: GitHubReadResult<boolean>;
  readonly suspendedAt: string | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly events: readonly string[];
}

export interface GitHubActionsSettings {
  readonly enabled?: boolean;
  readonly enabledRepositories?: 'all' | 'none' | 'selected';
  readonly allowedActions: 'all' | 'local_only' | 'selected';
  readonly shaPinningRequired: boolean;
}

export interface GitHubWorkflowTokenSettings {
  readonly defaultWorkflowPermissions: 'read' | 'write';
  readonly canApprovePullRequestReviews: boolean;
}

export interface GitHubSelectedActionsSettings {
  readonly githubOwnedAllowed: boolean;
  readonly verifiedAllowed: boolean;
  readonly patternsAllowed: readonly string[];
}

export interface GitHubActionsContractFacts {
  readonly organization: GitHubReadResult<GitHubActionsSettings>;
  readonly organizationWorkflowToken: GitHubReadResult<GitHubWorkflowTokenSettings>;
  readonly organizationSelectedActions: GitHubReadResult<GitHubSelectedActionsSettings | null>;
  readonly repository: GitHubReadResult<GitHubActionsSettings>;
  readonly executionProtections: GitHubReadResult<GitHubActionsExecutionProtections>;
}

export interface GitHubActionsExecutionProtections {
  readonly schemaVersion: 1;
  readonly organization: string;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly propertyDigest: string;
  readonly contractVersion: string;
  readonly contractDigest: string;
  readonly inventoryVersion: string;
  readonly inventoryDigest: string;
  readonly policyDigest: string;
  readonly mode: 'evaluate' | 'active';
  readonly policyCount: number;
  readonly issuedAt: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly attestor: {
    readonly login: string;
    readonly id: number;
  };
  readonly verification: {
    readonly method: 'github-ssh-signing-key';
    readonly signingKeyId: number;
    readonly signingKeyAlgorithm: 'ssh-ed25519';
    readonly authenticatedPrincipal: {
      readonly login: string;
      readonly id: number;
    };
    readonly organizationMembership: {
      readonly state: 'active';
      readonly role: 'admin';
    };
  };
}

export interface GitHubOrganizationContractSnapshot {
  readonly propertySchema: GitHubReadResult<readonly GitHubOrganizationPropertyDefinition[]>;
  readonly repositoryProperties: GitHubReadResult<readonly GitHubRepositoryPropertyValue[]>;
  readonly organizationRulesets: GitHubReadResult<readonly GitHubRulesetDefinition[]>;
  readonly applicableRulesets: GitHubReadResult<readonly GitHubRulesetSummary[]>;
  readonly effectiveRules: GitHubReadResult<readonly GitHubEffectiveRule[]>;
  readonly maintainerTeamAccess: GitHubReadResult<GitHubTeamRepositoryAccess>;
  readonly maintainerTeamMembers: GitHubReadResult<readonly string[]>;
  readonly appInstallation: GitHubReadResult<GitHubAppInstallationFacts>;
  readonly actions: GitHubActionsContractFacts;
}

export interface GitHubOrganizationReadClientOptions {
  readonly repositoryTransport: GitHubTransport;
  readonly organizationTransport?: GitHubTransport;
  readonly appJwtTransport?: GitHubTransport;
  readonly appUserTransport?: GitHubTransport;
  readonly actionsExecutionProtections?: GitHubReadResult<GitHubActionsExecutionProtections>;
  readonly observedAt?: () => string;
}

export interface GitHubOrganizationContractInput {
  readonly organization: string;
  readonly owner: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly defaultBranch: string;
  readonly maintainerTeamSlug: string;
  readonly appId: number;
  readonly appSlug: string;
  readonly appClientId?: string;
  readonly organizationRulesetNames?: readonly string[];
}

type JsonObject = Record<string, unknown>;

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${name} must be a positive integer`);
  return Number(value);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean {
  return value === undefined ? false : boolean(value, name);
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function stringArray(value: unknown, name: string): string[] {
  return array(value, name).map((item, index) => string(item, `${name}[${index}]`));
}

function propertyValue(value: unknown, name: string): GitHubPropertyValue {
  if (value === null || typeof value === 'string') return value;
  return stringArray(value, name);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  const candidate = string(value, name);
  if (!values.includes(candidate as T)) throw new TypeError(`${name} has unsupported value ${candidate}`);
  return candidate as T;
}

function evidence(transport: GitHubTransport, endpoint: string, observedAt: string): GitHubReadEvidence {
  return {
    source: 'github-rest', endpoint, observedAt,
    ...(transport.restApiVersion ? { apiVersion: transport.restApiVersion } : {}),
  };
}

function known<T>(value: T, proof: GitHubReadEvidence): GitHubReadResult<T> {
  return { status: 'known', value, evidence: proof };
}

function notConfigured(proof: GitHubReadEvidence): GitHubReadResult<never> {
  return { status: 'not-configured', evidence: proof };
}

function unknown(
  reason: GitHubUnknownReason,
  proof: GitHubReadEvidence,
  options: {
    httpStatus?: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
    requestId?: string;
  } = {},
): GitHubReadResult<never> {
  return { status: 'unknown', reason, evidence: proof, ...options };
}

function apiFailure(error: GitHubApiError, proof: GitHubReadEvidence): GitHubReadResult<never> {
  if (error.rateLimited || error.status === 429) {
    return unknown('rate-limited', proof, {
      httpStatus: error.status,
      retryable: true,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
  }
  if (error.status === 401 || error.status === 403) {
    return unknown('permission-denied', proof, {
      httpStatus: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
  }
  if (error.status === 404) return unknown('not-found-or-hidden', proof, {
    httpStatus: 404,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  });
  return unknown('api-error', proof, {
    httpStatus: error.status,
    ...(error.status >= 500 ? { retryable: true } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
  });
}

function transportFailure(error: GitHubTransportError, proof: GitHubReadEvidence): GitHubReadResult<never> {
  return unknown('api-error', proof, { retryable: error.retryable });
}

async function readRequest<T>(
  transport: GitHubTransport,
  request: GitHubRequest,
  observedAt: string,
  parse: (payload: unknown) => T,
): Promise<GitHubReadResult<T>> {
  const proof = evidence(transport, request.path, observedAt);
  let payload: unknown;
  try {
    payload = await transport.request<unknown>(request);
  } catch (error) {
    if (error instanceof GitHubApiError) return apiFailure(error, proof);
    if (error instanceof GitHubTransportError) return transportFailure(error, proof);
    throw error;
  }
  try {
    return known(parse(payload), proof);
  } catch (error) {
    if (error instanceof TypeError) return unknown('invalid-response', proof, { retryable: false });
    throw error;
  }
}

async function readArrayPages<T>(
  transport: GitHubTransport,
  request: GitHubRequest,
  observedAt: string,
  pageItems: (payload: unknown) => unknown[],
  parseItem: (payload: unknown, index: number) => T,
): Promise<GitHubReadResult<readonly T[]>> {
  const proof = evidence(transport, request.path, observedAt);
  try {
    const payloads = await fetchPullRequestPages(async (page, pageSize) => pageItems(
      await transport.request<unknown>({
        ...request,
        query: { ...request.query, page, per_page: pageSize },
      }),
    ));
    return known(payloads.map(parseItem), proof);
  } catch (error) {
    if (error instanceof GitHubApiError) return apiFailure(error, proof);
    if (error instanceof GitHubTransportError) return transportFailure(error, proof);
    if (error instanceof GitHubPaginationError) {
      return unknown('incomplete-pagination', proof, { retryable: false });
    }
    if (error instanceof TypeError) return unknown('invalid-response', proof, { retryable: false });
    throw error;
  }
}

function parsePropertyDefinition(value: unknown, index: number): GitHubOrganizationPropertyDefinition {
  const item = object(value, `property schema[${index}]`);
  const allowed = item.allowed_values === undefined || item.allowed_values === null
    ? null
    : stringArray(item.allowed_values, `property schema[${index}].allowed_values`);
  const editable = item.values_editable_by === undefined || item.values_editable_by === null
    ? null
    : enumValue(item.values_editable_by, ['org_actors', 'org_and_repo_actors'] as const,
      `property schema[${index}].values_editable_by`);
  return {
    name: string(item.property_name, `property schema[${index}].property_name`),
    sourceType: enumValue(item.source_type, ['organization', 'enterprise'] as const,
      `property schema[${index}].source_type`),
    valueType: enumValue(item.value_type, ['string', 'single_select', 'multi_select', 'true_false', 'url'] as const,
      `property schema[${index}].value_type`),
    required: optionalBoolean(item.required, `property schema[${index}].required`),
    defaultValue: item.default_value === undefined
      ? null
      : propertyValue(item.default_value, `property schema[${index}].default_value`),
    allowedValues: allowed,
    valuesEditableBy: editable,
    requireExplicitValues: optionalBoolean(
      item.require_explicit_values,
      `property schema[${index}].require_explicit_values`,
    ),
  };
}

function parseRepositoryProperty(value: unknown, index: number): GitHubRepositoryPropertyValue {
  const item = object(value, `repository properties[${index}]`);
  return {
    name: string(item.property_name, `repository properties[${index}].property_name`),
    value: propertyValue(item.value, `repository properties[${index}].value`),
  };
}

function parseRule(value: unknown, name: string): GitHubRulesetRule {
  const item = object(value, name);
  const parameters = item.parameters === undefined ? undefined : object(item.parameters, `${name}.parameters`);
  return {
    type: string(item.type, `${name}.type`),
    ...(parameters ? { parameters } : {}),
  };
}

function parseRuleset(value: unknown, index: number): GitHubRulesetDefinition {
  const item = object(value, `ruleset[${index}]`);
  const bypassActorsObserved = Array.isArray(item.bypass_actors);
  const bypassActors = bypassActorsObserved
    ? array(item.bypass_actors, `ruleset[${index}].bypass_actors`).map((actor, actorIndex) => {
      const parsed = object(actor, `ruleset[${index}].bypass_actors[${actorIndex}]`);
      const actorType = string(parsed.actor_type, `ruleset[${index}].bypass_actors[${actorIndex}].actor_type`);
      const actorId = parsed.actor_id === null || parsed.actor_id === undefined ? null
        : integer(parsed.actor_id, `ruleset[${index}].bypass_actors[${actorIndex}].actor_id`);
      if (actorId === null && actorType !== 'OrganizationAdmin' && actorType !== 'DeployKey') {
        throw new TypeError(`ruleset[${index}].bypass_actors[${actorIndex}].actor_id is required for ${actorType}`);
      }
      return {
        actorId,
        actorType,
        bypassMode: string(parsed.bypass_mode, `ruleset[${index}].bypass_actors[${actorIndex}].bypass_mode`),
      };
    })
    : [];
  return {
    id: integer(item.id, `ruleset[${index}].id`),
    name: string(item.name, `ruleset[${index}].name`),
    target: string(item.target, `ruleset[${index}].target`),
    enforcement: string(item.enforcement, `ruleset[${index}].enforcement`),
    sourceType: enumValue(item.source_type, ['Repository', 'Organization', 'Enterprise'] as const,
      `ruleset[${index}].source_type`),
    source: string(item.source, `ruleset[${index}].source`),
    conditions: object(item.conditions, `ruleset[${index}].conditions`),
    rules: array(item.rules, `ruleset[${index}].rules`)
      .map((rule, ruleIndex) => parseRule(rule, `ruleset[${index}].rules[${ruleIndex}]`)),
    bypassActorsObserved,
    bypassActors,
  };
}

function parseRulesetSummary(value: unknown, index: number): GitHubRulesetSummary {
  const item = object(value, `ruleset summary[${index}]`);
  return {
    id: integer(item.id, `ruleset summary[${index}].id`),
    name: string(item.name, `ruleset summary[${index}].name`),
    sourceType: enumValue(item.source_type, ['Repository', 'Organization', 'Enterprise'] as const,
      `ruleset summary[${index}].source_type`),
    source: string(item.source, `ruleset summary[${index}].source`),
    enforcement: string(item.enforcement, `ruleset summary[${index}].enforcement`),
  };
}

function parseEffectiveRule(value: unknown, index: number): GitHubEffectiveRule {
  const item = object(value, `effective rule[${index}]`);
  return {
    ...parseRule(item, `effective rule[${index}]`),
    rulesetId: integer(item.ruleset_id, `effective rule[${index}].ruleset_id`),
    rulesetSourceType: enumValue(item.ruleset_source_type, ['Repository', 'Organization', 'Enterprise'] as const,
      `effective rule[${index}].ruleset_source_type`),
    rulesetSource: string(item.ruleset_source, `effective rule[${index}].ruleset_source`),
  };
}

function parsePermissions(value: unknown, name: string): Record<string, string> {
  const source = object(value, name);
  const result: Record<string, string> = {};
  for (const [key, permission] of Object.entries(source)) result[key] = string(permission, `${name}.${key}`);
  return result;
}

function parseInstallation(
  value: unknown,
  repositoryAccess: GitHubReadResult<boolean>,
): GitHubAppInstallationFacts {
  const item = object(value, 'GitHub App installation');
  const clientId = optionalString(item.client_id, 'GitHub App installation.client_id');
  const accountLogin = item.account
    ? optionalString(object(item.account, 'GitHub App installation.account').login,
      'GitHub App installation.account.login')
    : undefined;
  return {
    installationId: integer(item.id, 'GitHub App installation.id'),
    appId: integer(item.app_id, 'GitHub App installation.app_id'),
    appSlug: string(item.app_slug, 'GitHub App installation.app_slug'),
    ...(clientId ? { clientId } : {}),
    ...(accountLogin ? { accountLogin } : {}),
    repositorySelection: enumValue(item.repository_selection, ['all', 'selected'] as const,
      'GitHub App installation.repository_selection'),
    repositoryAccess,
    suspendedAt: nullableString(item.suspended_at, 'GitHub App installation.suspended_at'),
    permissions: parsePermissions(item.permissions, 'GitHub App installation.permissions'),
    events: stringArray(item.events, 'GitHub App installation.events'),
  };
}

function parseActionsSettings(value: unknown, scope: 'organization' | 'repository'): GitHubActionsSettings {
  const item = object(value, `${scope} Actions settings`);
  const enabled = item.enabled === undefined ? undefined : boolean(item.enabled, `${scope} Actions settings.enabled`);
  const enabledRepositories = item.enabled_repositories === undefined
    ? undefined
    : enumValue(item.enabled_repositories, ['all', 'none', 'selected'] as const,
      `${scope} Actions settings.enabled_repositories`);
  if (scope === 'organization' && enabledRepositories === undefined) {
    throw new TypeError('organization Actions settings.enabled_repositories is required');
  }
  if (scope === 'repository' && enabled === undefined) {
    throw new TypeError('repository Actions settings.enabled is required');
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(enabledRepositories === undefined ? {} : { enabledRepositories }),
    allowedActions: enumValue(item.allowed_actions, ['all', 'local_only', 'selected'] as const,
      `${scope} Actions settings.allowed_actions`),
    shaPinningRequired: optionalBoolean(item.sha_pinning_required,
      `${scope} Actions settings.sha_pinning_required`),
  };
}

function parseWorkflowTokenSettings(value: unknown, scope: string): GitHubWorkflowTokenSettings {
  const item = object(value, `${scope} workflow token settings`);
  return {
    defaultWorkflowPermissions: enumValue(item.default_workflow_permissions, ['read', 'write'] as const,
      `${scope} workflow token settings.default_workflow_permissions`),
    canApprovePullRequestReviews: boolean(item.can_approve_pull_request_reviews,
      `${scope} workflow token settings.can_approve_pull_request_reviews`),
  };
}

function parseSelectedActionsSettings(value: unknown, scope: string): GitHubSelectedActionsSettings {
  const item = object(value, `${scope} selected Actions settings`);
  return {
    githubOwnedAllowed: boolean(item.github_owned_allowed, `${scope} selected Actions settings.github_owned_allowed`),
    verifiedAllowed: boolean(item.verified_allowed, `${scope} selected Actions settings.verified_allowed`),
    patternsAllowed: stringArray(item.patterns_allowed ?? [], `${scope} selected Actions settings.patterns_allowed`),
  };
}

function dependencyUnknown<T>(result: GitHubReadResult<unknown>, endpoint: string): GitHubReadResult<T> {
  if (result.status === 'unknown') {
    return {
      ...result,
      evidence: { ...result.evidence, blockedEndpoint: endpoint },
    };
  }
  return unknown('dependency-unavailable', { ...result.evidence, blockedEndpoint: endpoint }, {
    ...(result.status === 'not-configured' ? {} : { retryable: false }),
  });
}

function installationMatches(
  installation: JsonObject,
  input: Pick<GitHubOrganizationContractInput, 'organization' | 'appId' | 'appSlug'>,
): boolean {
  const appId = Number(installation.app_id ?? 0);
  const slug = String(installation.app_slug ?? '').toLowerCase();
  const account = installation.account ? object(installation.account, 'installation.account') : {};
  return appId === input.appId
    && slug === input.appSlug.toLowerCase()
    && String(account.login ?? '').toLowerCase() === input.organization.toLowerCase();
}

export class GitHubOrganizationReadClient {
  private readonly repositoryTransport: GitHubTransport;
  private readonly organizationTransport: GitHubTransport;
  private readonly appJwtTransport: GitHubTransport | undefined;
  private readonly appUserTransport: GitHubTransport | undefined;
  private readonly actionsExecutionProtections: GitHubReadResult<GitHubActionsExecutionProtections> | undefined;
  private readonly now: () => string;

  constructor(options: GitHubOrganizationReadClientOptions) {
    this.repositoryTransport = options.repositoryTransport;
    this.organizationTransport = options.organizationTransport ?? options.repositoryTransport;
    this.appJwtTransport = options.appJwtTransport;
    this.appUserTransport = options.appUserTransport;
    this.actionsExecutionProtections = options.actionsExecutionProtections;
    this.now = options.observedAt ?? (() => new Date().toISOString());
  }

  async getOrganizationPropertySchema(
    organization: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<readonly GitHubOrganizationPropertyDefinition[]>> {
    const path = `/orgs/${segment(organization)}/properties/schema`;
    return await readRequest(
      this.organizationTransport,
      { path },
      observedAt,
      (payload) => array(payload, 'organization property schema').map(parsePropertyDefinition),
    );
  }

  async getRepositoryPropertyValues(
    owner: string,
    repository: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<readonly GitHubRepositoryPropertyValue[]>> {
    const path = `${repositoryPath(owner, repository)}/properties/values`;
    return await readRequest(this.repositoryTransport, { path }, observedAt,
      (payload) => array(payload, 'repository property values').map(parseRepositoryProperty));
  }

  async listOrganizationRulesets(
    organization: string,
    observedAt = this.now(),
    names?: readonly string[],
  ): Promise<GitHubReadResult<readonly GitHubRulesetDefinition[]>> {
    const path = `/orgs/${segment(organization)}/rulesets`;
    const summaries = await readArrayPages(
      this.organizationTransport,
      { path },
      observedAt,
      (payload) => array(payload, 'organization rulesets'),
      parseRulesetSummary,
    );
    if (summaries.status !== 'known') return summaries;
    const acceptedNames = names
      ? new Set(names.map((name) => name.toLowerCase()))
      : undefined;
    const selectedSummaries = acceptedNames
      ? summaries.value.filter((summary) => acceptedNames.has(summary.name.toLowerCase()))
      : summaries.value;
    const definitions: GitHubRulesetDefinition[] = [];
    const detailEndpoints: string[] = [];
    for (const summary of selectedSummaries) {
      const detailPath = `${path}/${segment(summary.id)}`;
      const detail = await readRequest(
        this.organizationTransport,
        { path: detailPath },
        observedAt,
        (payload) => parseRuleset(payload, definitions.length),
      );
      if (detail.status !== 'known') return detail;
      definitions.push(detail.value);
      detailEndpoints.push(detailPath);
    }
    return known(definitions, { ...summaries.evidence, relatedEndpoints: detailEndpoints });
  }

  async listApplicableRulesets(
    owner: string,
    repository: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<readonly GitHubRulesetSummary[]>> {
    const path = `${repositoryPath(owner, repository)}/rulesets`;
    return await readArrayPages(
      this.repositoryTransport,
      { path, query: { includes_parents: true } },
      observedAt,
      (payload) => array(payload, 'repository rulesets'),
      parseRulesetSummary,
    );
  }

  async listEffectiveBranchRules(
    owner: string,
    repository: string,
    branch: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<readonly GitHubEffectiveRule[]>> {
    return await readArrayPages(
      this.repositoryTransport,
      { path: `${repositoryPath(owner, repository)}/rules/branches/${segment(branch)}` },
      observedAt,
      (payload) => array(payload, 'effective branch rules'),
      parseEffectiveRule,
    );
  }

  async getTeamRepositoryAccess(
    organization: string,
    teamSlug: string,
    owner: string,
    repository: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubTeamRepositoryAccess>> {
    const teamPath = `/orgs/${segment(organization)}/teams/${segment(teamSlug)}`;
    const team = await readRequest(this.organizationTransport, { path: teamPath }, observedAt,
      (payload) => {
        const item = object(payload, 'team');
        const teamId = integer(item.id, 'team.id');
        const observedSlug = string(item.slug, 'team.slug');
        if (observedSlug.toLowerCase() !== teamSlug.toLowerCase()) {
          throw new TypeError(`team.slug must equal ${teamSlug}`);
        }
        return { item, teamId };
      });
    const accessPath = `${teamPath}/repos/${segment(owner)}/${segment(repository)}`;
    if (team.status !== 'known') return dependencyUnknown(team, accessPath);
    const repositoryProof = await readRequest(
      this.organizationTransport,
      { path: repositoryPath(owner, repository) },
      observedAt,
      (payload) => {
        const item = object(payload, 'team repository visibility proof');
        const fullName = string(item.full_name, 'team repository visibility proof.full_name');
        if (fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase()) {
          throw new TypeError(`team repository visibility proof.full_name must equal ${owner}/${repository}`);
        }
        return item;
      },
    );
    if (repositoryProof.status !== 'known') return dependencyUnknown(repositoryProof, accessPath);
    const access = await readRequest(
      this.organizationTransport,
      { path: accessPath, accept: 'application/vnd.github.v3.repository+json' },
      observedAt,
      (payload): GitHubTeamRepositoryAccess => {
        const item = object(payload, 'team repository access');
        const permissions = object(item.permissions, 'team repository access.permissions');
        return {
          teamId: team.value.teamId,
          teamSlug,
          roleName: string(item.role_name, 'team repository access.role_name'),
          permissions: {
            admin: optionalBoolean(permissions.admin, 'team repository access.permissions.admin'),
            maintain: optionalBoolean(permissions.maintain, 'team repository access.permissions.maintain'),
            push: optionalBoolean(permissions.push, 'team repository access.permissions.push'),
            triage: optionalBoolean(permissions.triage, 'team repository access.permissions.triage'),
            pull: optionalBoolean(permissions.pull, 'team repository access.permissions.pull'),
          },
        };
      },
    );
    if (access.status === 'unknown' && access.reason === 'not-found-or-hidden') {
      return notConfigured(access.evidence);
    }
    return access;
  }

  async listTeamMembers(
    organization: string,
    teamSlug: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<readonly string[]>> {
    const path = `/orgs/${segment(organization)}/teams/${segment(teamSlug)}/members`;
    return await readArrayPages(
      this.organizationTransport,
      { path, query: { role: 'all' } },
      observedAt,
      (payload) => array(payload, 'team members'),
      (payload, index) => string(object(payload, `team member[${index}]`).login, `team member[${index}].login`),
    );
  }

  private async listAccountInstallations(
    path: string,
    transport: GitHubTransport,
    observedAt: string,
  ): Promise<GitHubReadResult<readonly JsonObject[]>> {
    return await readArrayPages(
      transport,
      { path },
      observedAt,
      (payload) => array(object(payload, 'installations response').installations ?? [], 'installations'),
      (payload, index) => object(payload, `installation[${index}]`),
    );
  }

  private async selectedRepositoryAccess(
    installationId: number,
    input: GitHubOrganizationContractInput,
    observedAt: string,
  ): Promise<GitHubReadResult<boolean>> {
    const path = `/user/installations/${segment(installationId)}/repositories`;
    if (!this.appUserTransport) {
      return unknown('dependency-unavailable', { source: 'github-rest', endpoint: path, observedAt });
    }
    const repositories = await readArrayPages(
      this.appUserTransport,
      { path },
      observedAt,
      (payload) => array(object(payload, 'installation repositories response').repositories ?? [],
        'installation repositories'),
      (payload, index) => object(payload, `installation repository[${index}]`),
    );
    if (repositories.status !== 'known') return repositories;
    const selected = repositories.value.some((repository) => (
      Number(repository.id ?? 0) === input.repositoryId
      && String(repository.full_name ?? '').toLowerCase() === `${input.owner}/${input.repository}`.toLowerCase()
    ));
    return selected
      ? known(true, repositories.evidence)
      : unknown('not-found-or-hidden', repositories.evidence);
  }

  async getAppInstallation(
    input: GitHubOrganizationContractInput,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubAppInstallationFacts>> {
    const repositoryInstallationPath = `${repositoryPath(input.owner, input.repository)}/installation`;
    const direct: GitHubReadResult<GitHubAppInstallationFacts> = this.appJwtTransport
      ? await readRequest(
        this.appJwtTransport,
        { path: repositoryInstallationPath },
        observedAt,
        (payload) => parseInstallation(
          payload,
          known(true, evidence(this.appJwtTransport!, repositoryInstallationPath, observedAt)),
        ),
      )
      : unknown('dependency-unavailable', {
        source: 'github-rest', endpoint: repositoryInstallationPath, observedAt,
      });
    if (direct.status === 'known') return direct;
    if (direct.status === 'unknown' && direct.reason === 'invalid-response') return direct;

    const organizationInstallations = await this.listAccountInstallations(
      `/orgs/${segment(input.organization)}/installations`,
      this.organizationTransport,
      observedAt,
    );
    let installations: Extract<GitHubReadResult<readonly JsonObject[]>, { status: 'known' }>;
    let authoritativeAbsence: boolean;
    if (organizationInstallations.status === 'known') {
      installations = organizationInstallations;
      authoritativeAbsence = true;
    } else {
      if (!this.appUserTransport) return direct;
      const userInstallations = await this.listAccountInstallations(
        '/user/installations',
        this.appUserTransport,
        observedAt,
      );
      if (userInstallations.status !== 'known') return direct;
      installations = userInstallations;
      authoritativeAbsence = false;
    }

    try {
      const matches = installations.value.filter((candidate) => installationMatches(candidate, input));
      if (matches.length === 0) return authoritativeAbsence ? notConfigured(installations.evidence) : direct;
      if (matches.length > 1) return unknown('conflicting-observations', installations.evidence);
      const selected = matches[0]!;
      const selection = enumValue(selected.repository_selection, ['all', 'selected'] as const,
        'GitHub App installation.repository_selection');
      const scope = selection === 'all'
        ? known(true, installations.evidence)
        : await this.selectedRepositoryAccess(integer(selected.id, 'GitHub App installation.id'), input, observedAt);
      return known(parseInstallation(selected, scope), installations.evidence);
    } catch (error) {
      if (error instanceof TypeError) {
        return unknown('invalid-response', installations.evidence, { retryable: false });
      }
      throw error;
    }
  }

  async getOrganizationActionsSettings(
    organization: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubActionsSettings>> {
    const path = `/orgs/${segment(organization)}/actions/permissions`;
    return await readRequest(this.organizationTransport, { path }, observedAt,
      (payload) => parseActionsSettings(payload, 'organization'));
  }

  async getOrganizationWorkflowTokenSettings(
    organization: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubWorkflowTokenSettings>> {
    const path = `/orgs/${segment(organization)}/actions/permissions/workflow`;
    return await readRequest(this.organizationTransport, { path }, observedAt,
      (payload) => parseWorkflowTokenSettings(payload, 'organization'));
  }

  async getOrganizationSelectedActions(
    organization: string,
    settings: GitHubReadResult<GitHubActionsSettings>,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubSelectedActionsSettings | null>> {
    const path = `/orgs/${segment(organization)}/actions/permissions/selected-actions`;
    if (settings.status !== 'known') return dependencyUnknown(settings, path);
    if (settings.value.allowedActions !== 'selected') {
      return known(null, settings.evidence);
    }
    return await readRequest(this.organizationTransport, { path }, observedAt,
      (payload) => parseSelectedActionsSettings(payload, 'organization'));
  }

  async getRepositoryActionsSettings(
    owner: string,
    repository: string,
    observedAt = this.now(),
  ): Promise<GitHubReadResult<GitHubActionsSettings>> {
    const path = `${repositoryPath(owner, repository)}/actions/permissions`;
    return await readRequest(this.repositoryTransport, { path }, observedAt,
      (payload) => parseActionsSettings(payload, 'repository'));
  }

  async inspect(input: GitHubOrganizationContractInput): Promise<GitHubOrganizationContractSnapshot> {
    const observedAt = this.now();
    const [
      propertySchema,
      repositoryProperties,
      organizationRulesets,
      applicableRulesets,
      effectiveRules,
      maintainerTeamAccess,
      maintainerTeamMembers,
      appInstallation,
      organizationActions,
      organizationWorkflowToken,
      repositoryActions,
    ] = await Promise.all([
      this.getOrganizationPropertySchema(input.organization, observedAt),
      this.getRepositoryPropertyValues(input.owner, input.repository, observedAt),
      this.listOrganizationRulesets(input.organization, observedAt, input.organizationRulesetNames),
      this.listApplicableRulesets(input.owner, input.repository, observedAt),
      this.listEffectiveBranchRules(input.owner, input.repository, input.defaultBranch, observedAt),
      this.getTeamRepositoryAccess(
        input.organization,
        input.maintainerTeamSlug,
        input.owner,
        input.repository,
        observedAt,
      ),
      this.listTeamMembers(input.organization, input.maintainerTeamSlug, observedAt),
      this.getAppInstallation(input, observedAt),
      this.getOrganizationActionsSettings(input.organization, observedAt),
      this.getOrganizationWorkflowTokenSettings(input.organization, observedAt),
      this.getRepositoryActionsSettings(input.owner, input.repository, observedAt),
    ]);
    const organizationSelectedActions = await this.getOrganizationSelectedActions(
      input.organization,
      organizationActions,
      observedAt,
    );
    return {
      propertySchema,
      repositoryProperties,
      organizationRulesets,
      applicableRulesets,
      effectiveRules,
      maintainerTeamAccess,
      maintainerTeamMembers,
      appInstallation,
      actions: {
        organization: organizationActions,
        organizationWorkflowToken,
        organizationSelectedActions,
        repository: repositoryActions,
        executionProtections: this.actionsExecutionProtections ?? unknown('unsupported', {
          source: 'github-documentation',
          endpoint: 'https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections',
          observedAt,
        }),
      },
    };
  }
}
