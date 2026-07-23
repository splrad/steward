import {
  STEWARD_ACTIONS_EXECUTION_POLICIES,
  STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
  STEWARD_ACTIONS_SOURCE_INVENTORY,
  STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
} from './actions-inventory.js';

export const STEWARD_APP_ID = 4243096 as const;
export const STEWARD_APP_SLUG = 'splrad-steward' as const;
export const STEWARD_MAINTAINER_TEAM_SLUG = 'maintainers' as const;
export const STEWARD_MATRIX_CHECK_NAME = 'PR Validation Matrix Gate' as const;

export interface StewardOrganizationPropertyContract {
  readonly name: string;
  readonly valueType: 'single_select';
  readonly required: true;
  readonly defaultValue: string;
  readonly allowedValues: readonly string[];
  readonly valuesEditableBy: 'org_actors';
  readonly requireExplicitValues: false;
}

export const STEWARD_ORGANIZATION_PROPERTIES = [
  {
    name: 'steward_state',
    valueType: 'single_select',
    required: true,
    defaultValue: 'unmanaged',
    allowedValues: ['unmanaged', 'bootstrapping', 'active', 'paused'],
    valuesEditableBy: 'org_actors',
    requireExplicitValues: false,
  },
  {
    name: 'steward_ring',
    valueType: 'single_select',
    required: true,
    defaultValue: 'production',
    allowedValues: ['canary', 'production'],
    valuesEditableBy: 'org_actors',
    requireExplicitValues: false,
  },
  {
    name: 'governance_tier',
    valueType: 'single_select',
    required: true,
    defaultValue: 'solo',
    allowedValues: ['solo', 'reviewed'],
    valuesEditableBy: 'org_actors',
    requireExplicitValues: false,
  },
  {
    name: 'ci_profile',
    valueType: 'single_select',
    required: true,
    defaultValue: 'none',
    allowedValues: ['none', 'codeql'],
    valuesEditableBy: 'org_actors',
    requireExplicitValues: false,
  },
] as const satisfies readonly StewardOrganizationPropertyContract[];

export const STEWARD_ORGANIZATION_RULESETS = {
  baseSafety: 'Base Safety',
  humanReview: 'Human Review',
  codeSecurity: 'Code Security',
  copilotReview: 'Copilot Review',
  matrix: 'Steward Matrix',
} as const;

export interface StewardOrganizationRulesetContract {
  readonly name: typeof STEWARD_ORGANIZATION_RULESETS[keyof typeof STEWARD_ORGANIZATION_RULESETS];
  readonly rules: readonly StewardOrganizationRuleContract[];
  readonly repositoryProperty?: readonly [name: string, value: string];
  /** Dynamic organization identity that must be resolved before parameter comparison. */
  readonly requiredReviewerTeam?: typeof STEWARD_MAINTAINER_TEAM_SLUG;
}

export interface StewardOrganizationRuleContract {
  readonly type: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

const basePullRequestParameters = {
  required_approving_review_count: 0,
  dismiss_stale_reviews_on_push: false,
  required_reviewers: [],
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_review_thread_resolution: true,
  allowed_merge_methods: ['squash'],
} as const;

const reviewedPullRequestParameters = {
  ...basePullRequestParameters,
  required_approving_review_count: 1,
  dismiss_stale_reviews_on_push: true,
  require_last_push_approval: true,
} as const;

export const STEWARD_ORGANIZATION_RULESET_CONTRACTS: readonly StewardOrganizationRulesetContract[] = [
  {
    name: STEWARD_ORGANIZATION_RULESETS.baseSafety,
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: basePullRequestParameters },
    ],
  },
  {
    name: STEWARD_ORGANIZATION_RULESETS.humanReview,
    rules: [{ type: 'pull_request', parameters: reviewedPullRequestParameters }],
    repositoryProperty: ['governance_tier', 'reviewed'],
    requiredReviewerTeam: STEWARD_MAINTAINER_TEAM_SLUG,
  },
  {
    name: STEWARD_ORGANIZATION_RULESETS.codeSecurity,
    rules: [
      { type: 'code_quality', parameters: { severity: 'errors' } },
      {
        type: 'code_scanning',
        parameters: {
          code_scanning_tools: [{
            tool: 'CodeQL',
            alerts_threshold: 'errors',
            security_alerts_threshold: 'high_or_higher',
          }],
        },
      },
    ],
    repositoryProperty: ['ci_profile', 'codeql'],
  },
  {
    name: STEWARD_ORGANIZATION_RULESETS.copilotReview,
    rules: [{
      type: 'copilot_code_review',
      parameters: { review_on_push: true, review_draft_pull_requests: true },
    }],
  },
  {
    name: STEWARD_ORGANIZATION_RULESETS.matrix,
    rules: [{
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [{
          context: STEWARD_MATRIX_CHECK_NAME,
          integration_id: STEWARD_APP_ID,
        }],
      },
    }],
    repositoryProperty: ['steward_state', 'active'],
  },
] as const;

export function stewardOrganizationRuleTypes(contract: StewardOrganizationRulesetContract): readonly string[] {
  return contract.rules.map((rule) => rule.type);
}

export type StewardRuleContractComparison =
  | { readonly state: 'conformant' }
  | { readonly state: 'drift'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string };

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function exactObjectKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function sortedJson(values: readonly unknown[]): readonly unknown[] {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function malformed(reason: string): StewardRuleContractComparison {
  return { state: 'unknown', reason };
}

function mismatch(reason: string): StewardRuleContractComparison {
  return { state: 'drift', reason };
}

function normalizePullRequestParameters(
  value: JsonObject,
): { readonly state: 'known'; readonly value: JsonObject } | StewardRuleContractComparison {
  const keys = [
    'required_approving_review_count',
    'dismiss_stale_reviews_on_push',
    'required_reviewers',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_review_thread_resolution',
    'allowed_merge_methods',
    'dismissal_restriction',
  ] as const;
  if (!exactObjectKeys(value, keys)) return malformed('pull_request contains unsupported parameters');
  const required = [
    'required_approving_review_count',
    'dismiss_stale_reviews_on_push',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_review_thread_resolution',
    'allowed_merge_methods',
  ] as const;
  if (required.some((key) => value[key] === undefined)) return malformed('pull_request is missing required parameters');
  if (!Number.isSafeInteger(value.required_approving_review_count)
    || typeof value.dismiss_stale_reviews_on_push !== 'boolean'
    || typeof value.require_code_owner_review !== 'boolean'
    || typeof value.require_last_push_approval !== 'boolean'
    || typeof value.required_review_thread_resolution !== 'boolean'
    || !Array.isArray(value.allowed_merge_methods)
    || value.allowed_merge_methods.some((method) => typeof method !== 'string')) {
    return malformed('pull_request parameter types are invalid');
  }
  const mergeMethods = [...new Set(value.allowed_merge_methods)].sort();
  if (mergeMethods.length !== value.allowed_merge_methods.length) {
    return malformed('pull_request allowed_merge_methods contains duplicates');
  }
  const reviewerCandidates = value.required_reviewers ?? [];
  if (!Array.isArray(reviewerCandidates)) {
    return malformed('pull_request required_reviewers is invalid');
  }
  const reviewers: JsonObject[] = [];
  for (const candidate of reviewerCandidates) {
    const requiredReviewer = object(candidate);
    if (!requiredReviewer
      || !exactObjectKeys(requiredReviewer, ['file_patterns', 'minimum_approvals', 'reviewer'])
      || !Array.isArray(requiredReviewer.file_patterns)
      || requiredReviewer.file_patterns.length === 0
      || requiredReviewer.file_patterns.some((pattern) => typeof pattern !== 'string' || !pattern)
      || !Number.isSafeInteger(requiredReviewer.minimum_approvals)
      || Number(requiredReviewer.minimum_approvals) < 0
      || Number(requiredReviewer.minimum_approvals) > 10) {
      return malformed('pull_request required_reviewers item is invalid');
    }
    const reviewer = object(requiredReviewer.reviewer);
    if (!reviewer
      || !exactObjectKeys(reviewer, ['id', 'type'])
      || !Number.isSafeInteger(reviewer.id)
      || Number(reviewer.id) < 1
      || reviewer.type !== 'Team') {
      return malformed('pull_request required reviewer Team identity is invalid');
    }
    const patterns = requiredReviewer.file_patterns as readonly string[];
    if (new Set(patterns).size !== patterns.length) {
      return malformed('pull_request required reviewer file_patterns contains duplicates');
    }
    reviewers.push({
      file_patterns: [...patterns],
      minimum_approvals: Number(requiredReviewer.minimum_approvals),
      reviewer: { id: Number(reviewer.id), type: reviewer.type },
    });
  }
  const normalizedReviewers = sortedJson(reviewers);
  if (new Set(normalizedReviewers.map((reviewer) => JSON.stringify(reviewer))).size
    !== normalizedReviewers.length) {
    return malformed('pull_request required_reviewers contains duplicates');
  }
  const dismissal = value.dismissal_restriction;
  if (dismissal !== undefined) {
    const item = object(dismissal);
    if (!item || !exactObjectKeys(item, ['enabled', 'allowed_actors'])
      || typeof item.enabled !== 'boolean'
      || !Array.isArray(item.allowed_actors)
      || item.allowed_actors.some((actor) => !object(actor))) {
      return malformed('pull_request dismissal_restriction is invalid');
    }
    if (item.enabled || item.allowed_actors.length) {
      return mismatch('pull_request dismissal restriction is enabled');
    }
  }
  return {
    state: 'known',
    value: {
      required_approving_review_count: value.required_approving_review_count,
      dismiss_stale_reviews_on_push: value.dismiss_stale_reviews_on_push,
      required_reviewers: normalizedReviewers,
      require_code_owner_review: value.require_code_owner_review,
      require_last_push_approval: value.require_last_push_approval,
      required_review_thread_resolution: value.required_review_thread_resolution,
      allowed_merge_methods: mergeMethods,
    },
  };
}

function normalizeRuleParameters(
  type: string,
  value: Readonly<Record<string, unknown>> | undefined,
): { readonly state: 'known'; readonly value: unknown } | StewardRuleContractComparison {
  if (type === 'deletion' || type === 'non_fast_forward') {
    if (value === undefined || Object.keys(value).length === 0) return { state: 'known', value: null };
    return malformed(`${type} contains unsupported parameters`);
  }
  if (value === undefined) return malformed(`${type} is missing parameters`);
  if (type === 'pull_request') return normalizePullRequestParameters(value);
  if (type === 'code_quality') {
    if (!exactObjectKeys(value, ['severity']) || typeof value.severity !== 'string') {
      return malformed('code_quality parameters are invalid');
    }
    return { state: 'known', value: { severity: value.severity } };
  }
  if (type === 'code_scanning') {
    if (!exactObjectKeys(value, ['code_scanning_tools']) || !Array.isArray(value.code_scanning_tools)) {
      return malformed('code_scanning parameters are invalid');
    }
    const tools: JsonObject[] = [];
    for (const candidate of value.code_scanning_tools) {
      const tool = object(candidate);
      if (!tool || !exactObjectKeys(tool, ['tool', 'alerts_threshold', 'security_alerts_threshold'])
        || typeof tool.tool !== 'string'
        || typeof tool.alerts_threshold !== 'string'
        || typeof tool.security_alerts_threshold !== 'string') {
        return malformed('code_scanning tool parameters are invalid');
      }
      tools.push({
        tool: tool.tool,
        alerts_threshold: tool.alerts_threshold,
        security_alerts_threshold: tool.security_alerts_threshold,
      });
    }
    const normalized = sortedJson(tools);
    if (new Set(normalized.map((item) => JSON.stringify(item))).size !== normalized.length) {
      return malformed('code_scanning_tools contains duplicates');
    }
    return { state: 'known', value: { code_scanning_tools: normalized } };
  }
  if (type === 'copilot_code_review') {
    if (!exactObjectKeys(value, ['review_on_push', 'review_draft_pull_requests'])
      || typeof value.review_on_push !== 'boolean'
      || typeof value.review_draft_pull_requests !== 'boolean') {
      return malformed('copilot_code_review parameters are invalid');
    }
    return {
      state: 'known',
      value: {
        review_on_push: value.review_on_push,
        review_draft_pull_requests: value.review_draft_pull_requests,
      },
    };
  }
  if (type === 'required_status_checks') {
    if (!exactObjectKeys(value, [
      'strict_required_status_checks_policy',
      'do_not_enforce_on_create',
      'required_status_checks',
    ])
      || typeof value.strict_required_status_checks_policy !== 'boolean'
      || typeof value.do_not_enforce_on_create !== 'boolean'
      || !Array.isArray(value.required_status_checks)) {
      return malformed('required_status_checks parameters are invalid');
    }
    const checks: JsonObject[] = [];
    for (const candidate of value.required_status_checks) {
      const check = object(candidate);
      if (!check || !exactObjectKeys(check, ['context', 'integration_id'])
        || typeof check.context !== 'string' || !check.context
        || !Number.isSafeInteger(check.integration_id) || Number(check.integration_id) < 1) {
        return malformed('required_status_checks item is invalid');
      }
      checks.push({ context: check.context, integration_id: Number(check.integration_id) });
    }
    const normalized = sortedJson(checks);
    if (new Set(normalized.map((item) => JSON.stringify(item))).size !== normalized.length) {
      return malformed('required_status_checks contains duplicates');
    }
    return {
      state: 'known',
      value: {
        strict_required_status_checks_policy: value.strict_required_status_checks_policy,
        do_not_enforce_on_create: value.do_not_enforce_on_create,
        required_status_checks: normalized,
      },
    };
  }
  return malformed(`unsupported rule type ${type}`);
}

export function compareStewardOrganizationRules(
  contract: StewardOrganizationRulesetContract,
  actual: readonly { readonly type: string; readonly parameters?: Readonly<Record<string, unknown>> }[],
): StewardRuleContractComparison {
  if (contract.requiredReviewerTeam) {
    throw new Error(`Steward ruleset contract ${contract.name} must be bound to its live reviewer Team ID`);
  }
  const expectedTypes = [...stewardOrganizationRuleTypes(contract)].sort();
  const actualTypes = actual.map((rule) => rule.type).sort();
  if (new Set(actualTypes).size !== actualTypes.length) return mismatch('duplicate rule type');
  if (actualTypes.length !== expectedTypes.length
    || actualTypes.some((type, index) => type !== expectedTypes[index])) {
    return mismatch('rule type set differs');
  }
  for (const expected of contract.rules) {
    const observed = actual.find((rule) => rule.type === expected.type)!;
    const [expectedParameters, actualParameters] = [
      normalizeRuleParameters(expected.type, expected.parameters),
      normalizeRuleParameters(observed.type, observed.parameters),
    ];
    if (expectedParameters.state !== 'known') {
      throw new Error(`Invalid built-in Steward rule contract: ${
        expectedParameters.state === 'conformant' ? 'unexpected comparison state' : expectedParameters.reason
      }`);
    }
    if (actualParameters.state !== 'known') return actualParameters;
    if (JSON.stringify(expectedParameters.value) !== JSON.stringify(actualParameters.value)) {
      return mismatch(`${expected.type} parameters differ`);
    }
  }
  return { state: 'conformant' };
}

/**
 * Resolves the only organization-specific value in the frozen ruleset contract.
 * The numeric Team ID is read live because slugs can be recreated and must never
 * be used as an authorization identity.
 */
export function bindStewardOrganizationRulesetContract(
  contract: StewardOrganizationRulesetContract,
  maintainerTeamId: number,
): StewardOrganizationRulesetContract {
  if (!contract.requiredReviewerTeam) return contract;
  if (!Number.isSafeInteger(maintainerTeamId) || maintainerTeamId < 1) {
    throw new Error('Maintainer Team ID must be a positive safe integer');
  }
  const { requiredReviewerTeam: _requiredReviewerTeam, ...bound } = contract;
  return {
    ...bound,
    rules: contract.rules.map((rule) => rule.type === 'pull_request'
      ? {
          ...rule,
          parameters: {
            ...rule.parameters,
            required_reviewers: [{
              file_patterns: ['**'],
              minimum_approvals: 1,
              reviewer: { id: maintainerTeamId, type: 'Team' },
            }],
          },
        }
      : rule),
  };
}

export function stewardOrganizationRulesetApplies(
  contract: StewardOrganizationRulesetContract,
  properties: ReadonlyMap<string, string>,
): boolean {
  return !contract.repositoryProperty
    || properties.get(contract.repositoryProperty[0]) === contract.repositoryProperty[1];
}

export const STEWARD_LEGACY_MONOLITHIC_RULESET_NAMES = [
  'Default Branch Protection',
  'SPLRAD Steward',
] as const;

export const STEWARD_APP_REQUIRED_PERMISSIONS = {
  actions: 'write',
  checks: 'write',
  contents: 'write',
  issues: 'write',
  members: 'read',
  merge_queues: 'write',
  metadata: 'read',
  organization_custom_properties: 'read',
  pull_requests: 'write',
  statuses: 'write',
} as const satisfies Readonly<Record<string, 'read' | 'write'>>;

// GitHub delivers these events automatically for every installation or as a
// consequence of the corresponding permission. They are not expected in the
// installation `events` subscription array.
export const STEWARD_APP_IMPLICIT_EVENTS = [
  'check_run',
  'check_suite',
  'installation',
  'installation_repositories',
  // GitHub treats this as a global App event and omits it from the
  // installation `events` array, just like the installation lifecycle.
  'installation_target',
] as const;

export const STEWARD_APP_RUNTIME_READY_EXPLICIT_EVENTS = [
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
] as const;

export const STEWARD_APP_PLANNED_EXPLICIT_EVENTS = [
  'custom_property',
  'custom_property_values',
  'issue_comment',
  'membership',
  'merge_group',
  'pull_request',
  'push',
  'repository',
  'status',
  'team',
  'team_add',
  'workflow_job',
  'workflow_run',
] as const;

export const STEWARD_APP_REQUIRED_EXPLICIT_EVENTS = [
  ...STEWARD_APP_RUNTIME_READY_EXPLICIT_EVENTS,
  ...STEWARD_APP_PLANNED_EXPLICIT_EVENTS,
] as const;

export const STEWARD_APP_REQUIRED_EVENTS = [
  ...STEWARD_APP_IMPLICIT_EVENTS,
  ...STEWARD_APP_REQUIRED_EXPLICIT_EVENTS,
] as const;

export const STEWARD_APP_OPTIONAL_PERMISSIONS = {
  workflows: 'write',
} as const satisfies Readonly<Record<string, 'write'>>;

// GitHub exposes workflow execution protections only through an owner UI in
// public preview. This digest binds an owner attestation to the exact frozen
// inventory and semantic policy without pretending that a private UI payload
// is a stable API contract.
export const STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT = {
  schemaVersion: 2,
  contractVersion: 's66-v2',
  scope: 'organization-all-repositories',
  requiredMode: 'active',
  expectedPolicyCount: STEWARD_ACTIONS_EXECUTION_POLICIES.length,
  policyInventoryStatus: 'frozen',
  inventoryVersion: STEWARD_ACTIONS_SOURCE_INVENTORY.inventoryVersion,
  inventoryDigest: STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
  policyDigest: STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
} as const;

export const STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST =
  '7213a49408ef1b59bea102da57bf5773dc99f2587a70afa57eae78835ba93481' as const;
