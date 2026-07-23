import {
  bindStewardOrganizationRulesetContract,
  compareStewardOrganizationRules,
  enabledStewardMatrixConfiguration,
  evaluateMatrix,
  fingerprintForPull,
  hashJson,
  matrixConclusion,
  matrixLiveEvidenceDigest,
  parseStewardCheckExternalId,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST,
  STEWARD_ACTIONS_GENERAL_POLICY,
  STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
  STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
  STEWARD_APP_ID,
  STEWARD_APP_OPTIONAL_PERMISSIONS,
  STEWARD_APP_PLANNED_EXPLICIT_EVENTS,
  STEWARD_APP_REQUIRED_PERMISSIONS,
  STEWARD_APP_RUNTIME_READY_EXPLICIT_EVENTS,
  STEWARD_APP_SLUG,
  STEWARD_LEGACY_MONOLITHIC_RULESET_NAMES,
  STEWARD_MAINTAINER_TEAM_SLUG,
  STEWARD_MATRIX_CHECK_NAME,
  STEWARD_ORGANIZATION_PROPERTIES,
  STEWARD_ORGANIZATION_RULESET_CONTRACTS,
  STEWARD_ORGANIZATION_RULESETS,
  stewardOrganizationRulesetApplies,
  stewardOrganizationRuleTypes,
  type StewardOrganizationRulesetContract,
  type MatrixCheckRun,
  type MatrixWorkflowRun,
  type StewardRuntimeDiagnostics,
} from '../../core/src/index.js';
import {
  GitHubApiError,
  GitHubPaginationError,
  GitHubTransportError,
  GitHubOrganizationReadClient,
  GitHubRepositoryClient,
  fetchPullRequestPages,
  type GitHubAppInstallationFacts,
  type GitHubActionsExecutionProtections,
  type GitHubCheckRun,
  type GitHubEffectiveRule,
  type GitHubOrganizationContractSnapshot,
  type GitHubReadEvidence,
  type GitHubReadResult,
  type GitHubRequest,
  type GitHubRulesetDefinition,
  type GitHubSelectedActionsSettings,
  type GitHubTransport,
  type GitHubWorkflowTokenSettings,
} from '../../github/src/index.js';
import {
  loadDefaultBranchManifest,
  type LoadedManifest,
  type StewardManifest,
} from '../../manifest/src/index.js';

const MAX_DIAGNOSTIC_EVIDENCE_AGE_MS = 15 * 60 * 1000;
const MAX_DIAGNOSTIC_CLOCK_SKEW_MS = 30 * 1000;

export type DoctorLevel = 'pass' | 'warning' | 'fail';
export type DoctorFindingState =
  | 'conformant'
  | 'drift'
  | 'not-applicable'
  | 'unknown'
  | 'permission-denied';
export type DoctorStatus = 'ready' | 'action-required' | 'unknown';

export interface DoctorFinding {
  code: string;
  level: DoctorLevel;
  state: DoctorFindingState;
  summary: string;
  remedy?: string;
  source?: string;
  endpoint?: string;
  relatedEndpoints?: readonly string[];
  blockedEndpoint?: string;
  httpStatus?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  observedAt?: string;
  apiVersion?: string;
}

export interface DoctorReport {
  repository: string;
  status: DoctorStatus;
  findings: DoctorFinding[];
  counts: Record<DoctorLevel, number>;
  ok: boolean;
}

export interface DoctorOptions {
  owner: string;
  repository: string;
  pullRequest?: number;
}

export type RuntimeDiagnosticsResult =
  | {
    readonly status: 'known';
    readonly value: StewardRuntimeDiagnostics;
    readonly repositoryId: number;
    readonly owner: string;
    readonly repository: string;
    readonly source: string;
    readonly observedAt: string;
  }
  | {
    readonly status: 'unknown';
    readonly reason: 'runtime-metadata-unavailable' | 'permission-denied' | 'transport-error' | 'snapshot-changed';
    readonly source: string;
    readonly observedAt: string;
  };

export interface RuntimeDiagnosticsReader {
  read(input: {
    readonly repositoryId: number;
    readonly owner: string;
    readonly repository: string;
  }): Promise<RuntimeDiagnosticsResult>;
}

export interface DoctorDependencies {
  readonly repositoryTransport: GitHubTransport;
  readonly organizationTransport?: GitHubTransport;
  readonly organizationRulesetTransport?: GitHubTransport;
  readonly appJwtTransport?: GitHubTransport;
  readonly appUserTransport?: GitHubTransport;
  readonly actionsExecutionProtections?: GitHubReadResult<GitHubActionsExecutionProtections>;
  readonly runtimeDiagnostics?: RuntimeDiagnosticsReader;
  readonly observedAt?: () => string;
}

interface RepositoryPayload {
  id?: number;
  full_name?: string;
  default_branch?: string | null;
  owner?: { login?: string; type?: string } | null;
}

interface PullPayload {
  number?: number;
  state?: string;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  base?: { ref?: string; sha?: string } | null;
  head?: { ref?: string; sha?: string } | null;
}

interface PullCommitPayload {
  sha?: string;
  author?: { login?: string } | null;
}

interface PullFilePayload {
  filename?: string;
  status?: string;
  sha?: string;
  additions?: number;
  deletions?: number;
}

interface RepositoryFilePayload {
  type?: string;
}

interface CommitPayload {
  sha: string;
}

function parseRepository(payload: unknown): RepositoryPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('GitHub repository metadata must be an object');
  }
  return payload as RepositoryPayload;
}

function parseCommit(payload: unknown): CommitPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('GitHub commit metadata must be an object');
  }
  const sha = String((payload as { sha?: unknown }).sha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new TypeError('GitHub commit metadata requires a 40-character SHA');
  return { sha };
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function levelForState(state: DoctorFindingState): DoctorLevel {
  if (state === 'drift') return 'fail';
  if (state === 'unknown' || state === 'permission-denied') return 'warning';
  return 'pass';
}

function finding(
  code: string,
  state: DoctorFindingState,
  summary: string,
  options: {
    remedy?: string;
    source?: string;
    endpoint?: string;
    relatedEndpoints?: readonly string[];
    blockedEndpoint?: string;
    httpStatus?: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
    requestId?: string;
    observedAt?: string;
    apiVersion?: string;
  } = {},
): DoctorFinding {
  return { code, level: levelForState(state), state, summary, ...options };
}

function report(repository: string, findings: DoctorFinding[]): DoctorReport {
  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const item of findings) counts[item.level] += 1;
  const status: DoctorStatus = findings.some((item) => item.state === 'drift')
    ? 'action-required'
    : findings.some((item) => item.state === 'unknown' || item.state === 'permission-denied')
      ? 'unknown'
      : 'ready';
  return { repository, status, findings, counts, ok: status === 'ready' };
}

function schemaPin(manifest: StewardManifest): string {
  const match = String(manifest.$schema ?? '').match(
    /^https:\/\/raw\.githubusercontent\.com\/splrad\/steward\/([a-f0-9]{40})\/schema\/steward\.schema\.json$/i,
  );
  return match?.[1]?.toLowerCase() ?? '';
}

function diagnosticsEvidence(transport: GitHubTransport, endpoint: string, observedAt: string): GitHubReadEvidence {
  return {
    source: 'github-rest', endpoint, observedAt,
    ...(transport.restApiVersion ? { apiVersion: transport.restApiVersion } : {}),
  };
}

function evidenceFields(evidence: GitHubReadEvidence): Pick<DoctorFinding, 'observedAt' | 'apiVersion'> {
  return {
    observedAt: evidence.observedAt,
    ...(evidence.apiVersion ? { apiVersion: evidence.apiVersion } : {}),
  };
}

function diagnosticsError(
  error: GitHubApiError,
  proof: GitHubReadEvidence,
): Extract<GitHubReadResult<never>, { status: 'unknown' }> {
  if (error.rateLimited || error.status === 429) {
    return {
      status: 'unknown', reason: 'rate-limited', evidence: proof, httpStatus: error.status, retryable: true,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      status: 'unknown', reason: 'permission-denied', evidence: proof, httpStatus: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error.status === 404) {
    return {
      status: 'unknown', reason: 'not-found-or-hidden', evidence: proof, httpStatus: 404,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  return {
    status: 'unknown', reason: 'api-error', evidence: proof, httpStatus: error.status,
    ...(error.status >= 500 ? { retryable: true } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

async function diagnosticRequest<T>(
  transport: GitHubTransport,
  request: GitHubRequest,
  observedAt: string,
  parse: (payload: unknown) => T,
): Promise<GitHubReadResult<T>> {
  const proof = diagnosticsEvidence(transport, request.path, observedAt);
  try {
    return { status: 'known', value: parse(await transport.request<unknown>(request)), evidence: proof };
  } catch (error) {
    if (error instanceof GitHubApiError) return diagnosticsError(error, proof);
    if (error instanceof GitHubTransportError) {
      return {
        status: 'unknown', reason: 'api-error', evidence: proof, retryable: error.retryable,
      };
    }
    if (error instanceof TypeError) {
      return { status: 'unknown', reason: 'invalid-response', evidence: proof, retryable: false };
    }
    throw error;
  }
}

async function diagnosticPages<T>(
  transport: GitHubTransport,
  request: GitHubRequest,
  observedAt: string,
  items: (payload: unknown) => readonly T[],
): Promise<GitHubReadResult<readonly T[]>> {
  const proof = diagnosticsEvidence(transport, request.path, observedAt);
  try {
    const value = await fetchPullRequestPages(async (page, pageSize) => items(
      await transport.request<unknown>({
        ...request,
        query: { ...request.query, page, per_page: pageSize },
      }),
    ));
    return { status: 'known', value, evidence: proof };
  } catch (error) {
    if (error instanceof GitHubApiError) return diagnosticsError(error, proof);
    if (error instanceof GitHubTransportError) {
      return {
        status: 'unknown', reason: 'api-error', evidence: proof, retryable: error.retryable,
      };
    }
    if (error instanceof GitHubPaginationError) {
      return { status: 'unknown', reason: 'incomplete-pagination', evidence: proof, retryable: false };
    }
    if (error instanceof TypeError) {
      return { status: 'unknown', reason: 'invalid-response', evidence: proof, retryable: false };
    }
    throw error;
  }
}

function unknownFinding(
  code: string,
  subject: string,
  result: Exclude<GitHubReadResult<unknown>, { status: 'known' } | { status: 'not-configured' }>,
  remedy: string,
): DoctorFinding {
  const state = result.reason === 'permission-denied' ? 'permission-denied' : 'unknown';
  const status = result.httpStatus ? `，HTTP ${result.httpStatus}` : '';
  return finding(code, state, `${subject} 无法确认：${result.reason}${status}。`, {
    remedy,
    source: result.evidence.source,
    endpoint: result.evidence.endpoint,
    ...(result.evidence.relatedEndpoints ? { relatedEndpoints: result.evidence.relatedEndpoints } : {}),
    ...(result.evidence.blockedEndpoint ? { blockedEndpoint: result.evidence.blockedEndpoint } : {}),
    ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...evidenceFields(result.evidence),
  });
}

function duplicateNames(items: readonly { name: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) duplicates.add(item.name);
    seen.add(item.name);
  }
  return [...duplicates].sort();
}

const UNORDERED_SNAPSHOT_ROOT_ARRAYS = new Set([
  'propertySchema',
  'repositoryProperties',
  'organizationRulesets',
  'applicableRulesets',
  'effectiveRules',
  'maintainerTeamMembers',
]);

const UNORDERED_SNAPSHOT_NESTED_ARRAYS = new Set([
  'bypassActors',
  'events',
  'exclude',
  'include',
  'patternsAllowed',
  'property_values',
  'required_status_checks',
  'rules',
]);

function canonicalSnapshotValue(value: unknown, path: readonly string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalSnapshotValue(item, [...path, '[]']));
    const root = path[0] ?? '';
    const key = path.at(-1) ?? '';
    return UNORDERED_SNAPSHOT_ROOT_ARRAYS.has(root) && path.length === 1
      || UNORDERED_SNAPSHOT_NESTED_ARRAYS.has(key)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  if (!value || typeof value !== 'object') return value;
  const input = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(input)
    .filter((key) => key !== 'evidence')
    .sort()
    .map((key) => [key, canonicalSnapshotValue(input[key], [...path, key])]));
}

function organizationSnapshotSignature(snapshot: GitHubOrganizationContractSnapshot): {
  signature: string | null;
  unavailable: readonly string[];
} {
  const facts: readonly [string, GitHubReadResult<unknown>][] = [
    ['propertySchema', snapshot.propertySchema],
    ['repositoryProperties', snapshot.repositoryProperties],
    ['organizationRulesets', snapshot.organizationRulesets],
    ['applicableRulesets', snapshot.applicableRulesets],
    ['effectiveRules', snapshot.effectiveRules],
    ['maintainerTeamAccess', snapshot.maintainerTeamAccess],
    ['maintainerTeamMembers', snapshot.maintainerTeamMembers],
    ['appInstallation', snapshot.appInstallation],
    ['actions.organization', snapshot.actions.organization],
    ['actions.organizationWorkflowToken', snapshot.actions.organizationWorkflowToken],
    ['actions.organizationSelectedActions', snapshot.actions.organizationSelectedActions],
    ['actions.repository', snapshot.actions.repository],
  ];
  const unavailable = facts.filter(([, result]) => result.status !== 'known').map(([name]) => name);
  if (snapshot.appInstallation.status === 'known'
    && snapshot.appInstallation.value.repositoryAccess.status !== 'known') {
    unavailable.push('appInstallation.repositoryAccess');
  }
  if (unavailable.length) return { signature: null, unavailable };
  return {
    signature: JSON.stringify(facts.map(([name, result]) => [
      name,
      result.status === 'known' ? canonicalSnapshotValue(result.value, [name]) : null,
    ])),
    unavailable,
  };
}

function runtimeSnapshotSignature(result: RuntimeDiagnosticsResult): string | null {
  if (result.status !== 'known') return null;
  return JSON.stringify(canonicalSnapshotValue({
    repositoryId: result.repositoryId,
    owner: result.owner.toLowerCase(),
    repository: result.repository.toLowerCase(),
    source: result.source,
    value: result.value,
  }));
}

function sameStrings(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return actual !== null
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function evaluatePropertySchema(
  snapshot: GitHubOrganizationContractSnapshot,
  findings: DoctorFinding[],
): Map<string, string> | null {
  const schema = snapshot.propertySchema;
  if (schema.status === 'not-configured') {
    findings.push(finding('organization.properties.schema', 'drift', '组织 custom property schema 尚未配置。', {
      remedy: '由组织所有者按平台合同创建四个 custom properties；Steward 不创建 schema。',
    }));
    return null;
  }
  if (schema.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.properties.schema',
      '组织 custom property schema',
      schema,
      '使用具备组织 Custom properties read 的所有者诊断身份重试；不要给 Steward App 增加 schema admin。',
    ));
    return null;
  }
  const duplicates = duplicateNames(schema.value);
  const drift: string[] = duplicates.map((name) => `${name}:duplicate`);
  const definitions = new Map(schema.value.map((item) => [item.name, item]));
  for (const expected of STEWARD_ORGANIZATION_PROPERTIES) {
    const actual = definitions.get(expected.name);
    if (!actual) {
      drift.push(`${expected.name}:missing`);
      continue;
    }
    if (actual.sourceType !== 'organization') drift.push(`${expected.name}:source`);
    if (actual.valueType !== expected.valueType) drift.push(`${expected.name}:type`);
    if (!actual.required) drift.push(`${expected.name}:required`);
    if (actual.defaultValue !== expected.defaultValue) drift.push(`${expected.name}:default`);
    if (!sameStrings(actual.allowedValues, expected.allowedValues)) drift.push(`${expected.name}:allowed-values`);
    if (actual.valuesEditableBy !== expected.valuesEditableBy) drift.push(`${expected.name}:editable-by`);
    if (actual.requireExplicitValues !== expected.requireExplicitValues) drift.push(`${expected.name}:explicit-values`);
  }
  findings.push(drift.length
    ? finding('organization.properties.schema', 'drift', `组织 custom property schema 与合同不一致：${drift.join(', ')}。`, {
      remedy: '由组织所有者修正定义、默认值、枚举和 org_actors 可编辑范围；仓库 actor 不得修改治理选择器。',
      source: schema.evidence.source,
      endpoint: schema.evidence.endpoint,
    })
    : finding('organization.properties.schema', 'conformant', '四个组织 custom property 定义与平台合同一致。', {
      source: schema.evidence.source,
      endpoint: schema.evidence.endpoint,
    }));

  const values = snapshot.repositoryProperties;
  if (values.status === 'not-configured') {
    findings.push(finding('repository.properties', 'drift', '仓库 custom property 值尚未配置。', {
      remedy: '由组织所有者在 UI 设置仓库属性值；未建立独立、集中且 owner-bound 的 lifecycle identity 前，不得由 Steward runtime App 修改。',
    }));
    return null;
  }
  if (values.status === 'unknown') {
    findings.push(unknownFinding(
      'repository.properties',
      '仓库 custom property 值',
      values,
      '使用具备仓库 Metadata read 的身份重试。',
    ));
    return null;
  }
  const valueDuplicates = duplicateNames(values.value);
  const valueDrift: string[] = valueDuplicates.map((name) => `${name}:duplicate`);
  const explicit = new Map(values.value.map((item) => [item.name, item.value]));
  const effective = new Map<string, string>();
  for (const expected of STEWARD_ORGANIZATION_PROPERTIES) {
    const configured = explicit.has(expected.name)
      ? explicit.get(expected.name)
      : definitions.get(expected.name)?.defaultValue;
    if (typeof configured !== 'string' || !expected.allowedValues.some((value) => value === configured)) {
      valueDrift.push(`${expected.name}:invalid-or-missing`);
      continue;
    }
    effective.set(expected.name, configured);
  }
  findings.push(valueDrift.length
    ? finding('repository.properties', 'drift', `仓库 custom property 值冲突或非法：${valueDrift.join(', ')}。`, {
      remedy: '修正显式值；未显式设置时仅允许使用已验证 schema 默认值。',
      source: values.evidence.source,
      endpoint: values.evidence.endpoint,
    })
    : finding('repository.properties', 'conformant', [
      '仓库有效属性：',
      ...STEWARD_ORGANIZATION_PROPERTIES.map((item) => `${item.name}=${effective.get(item.name)}`),
      '。',
    ].join(''), {
      source: values.evidence.source,
      endpoint: values.evidence.endpoint,
    }));
  return drift.length || valueDrift.length ? null : effective;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function freshDiagnosticEvidence(evidenceAt: string, evaluatedAt: string): boolean {
  const evidenceTime = Date.parse(evidenceAt);
  const evaluationTime = Date.parse(evaluatedAt);
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(evaluationTime)) return false;
  const age = evaluationTime - evidenceTime;
  return age >= -MAX_DIAGNOSTIC_CLOCK_SKEW_MS && age <= MAX_DIAGNOSTIC_EVIDENCE_AGE_MS;
}

function validRulesetConditions(
  ruleset: GitHubRulesetDefinition,
  repositoryProperty: StewardOrganizationRulesetContract['repositoryProperty'],
): boolean {
  const expectedConditionKeys = repositoryProperty
    ? ['ref_name', 'repository_property']
    : ['ref_name', 'repository_name'];
  if (!exactKeys(ruleset.conditions, expectedConditionKeys)) return false;
  const ref = record(ruleset.conditions.ref_name);
  if (!ref
    || !exactKeys(ref, ['include', 'exclude'])
    || !exactStringArray(ref.include, ['~DEFAULT_BRANCH'])
    || !exactStringArray(ref.exclude, [])) return false;
  if (repositoryProperty) {
    const property = record(ruleset.conditions.repository_property);
    if (!property || !exactKeys(property, ['include', 'exclude'])) return false;
    const include = Array.isArray(property?.include) ? property.include : [];
    const candidate = include.length === 1 ? include[0] : undefined;
    const objectCandidate = record(candidate);
    const semanticMatch = Boolean(objectCandidate
        && (exactKeys(objectCandidate, ['name', 'property_values'])
          || exactKeys(objectCandidate, ['name', 'property_values', 'source']))
        && objectCandidate.name === repositoryProperty[0]
        && exactStringArray(objectCandidate.property_values, [repositoryProperty[1]])
        && (objectCandidate.source === undefined || objectCandidate.source === 'custom'));
    return semanticMatch && exactStringArray(property.exclude, []);
  }
  const repositoryName = record(ruleset.conditions.repository_name);
  return Boolean(repositoryName
    && (exactKeys(repositoryName, ['include', 'exclude'])
      || exactKeys(repositoryName, ['include', 'exclude', 'protected']))
    && exactStringArray(repositoryName.include, ['~ALL'])
    && exactStringArray(repositoryName.exclude, [])
    && (repositoryName.protected === undefined || repositoryName.protected === false));
}

function sameRuleTypes(ruleset: GitHubRulesetDefinition, expected: readonly string[]): boolean {
  const actual = ruleset.rules.map((rule) => rule.type).sort();
  return actual.length === expected.length
    && actual.every((type, index) => type === [...expected].sort()[index]);
}

interface MatrixRequiredCheckObservation {
  readonly context: string | undefined;
  readonly integrationId: number | undefined;
  readonly valid: boolean;
}

function matrixRequiredChecks(
  rule: { readonly type: string; readonly parameters?: Readonly<Record<string, unknown>> },
): MatrixRequiredCheckObservation[] {
  if (rule.type !== 'required_status_checks') return [];
  const checks = rule.parameters?.required_status_checks;
  if (!Array.isArray(checks)) return [{ context: undefined, integrationId: undefined, valid: false }];
  return checks.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { context: undefined, integrationId: undefined, valid: false };
    }
    const item = candidate as Record<string, unknown>;
    const context = typeof item.context === 'string' && item.context.length > 0
      ? item.context
      : undefined;
    const integrationId = Number.isSafeInteger(item.integration_id)
      ? Number(item.integration_id)
      : undefined;
    return {
      context,
      integrationId,
      valid: context !== undefined && integrationId !== undefined,
    };
  });
}

function definitionMatrixChecks(ruleset: GitHubRulesetDefinition): MatrixRequiredCheckObservation[] {
  return ruleset.rules.flatMap(matrixRequiredChecks);
}

function uniqueTeamMembers(snapshot: GitHubOrganizationContractSnapshot): string[] | null {
  if (snapshot.maintainerTeamMembers.status !== 'known') return null;
  return [...new Set(snapshot.maintainerTeamMembers.value
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean))];
}

function rulesetContractForLiveOrganization(
  snapshot: GitHubOrganizationContractSnapshot,
  contract: StewardOrganizationRulesetContract,
): StewardOrganizationRulesetContract | null {
  if (!contract.requiredReviewerTeam) return contract;
  if (snapshot.maintainerTeamAccess.status !== 'known') return null;
  return bindStewardOrganizationRulesetContract(
    contract,
    snapshot.maintainerTeamAccess.value.teamId,
  );
}

function humanReviewBypassState(
  snapshot: GitHubOrganizationContractSnapshot,
  definition: GitHubRulesetDefinition,
): { readonly state: 'conformant' | 'drift' | 'unknown'; readonly reason: string } {
  if (!definition.bypassActorsObserved) {
    return { state: 'unknown', reason: 'bypass_actors-not-observed' };
  }
  const members = uniqueTeamMembers(snapshot);
  if (definition.bypassActors.length === 0) {
    if (members === null) return { state: 'unknown', reason: 'maintainer-members-unavailable' };
    return members.length >= 2
      ? { state: 'conformant', reason: 'two-independent-reviewers' }
      : { state: 'drift', reason: 'zero-bypass-requires-two-reviewers' };
  }
  if (definition.bypassActors.length !== 1) {
    return { state: 'drift', reason: 'multiple-bypass-actors' };
  }
  if (snapshot.maintainerTeamAccess.status !== 'known' || members === null) {
    return { state: 'unknown', reason: 'maintainer-team-identity-unavailable' };
  }
  const actor = definition.bypassActors[0]!;
  const exact = actor.actorType === 'Team'
    && actor.actorId === snapshot.maintainerTeamAccess.value.teamId
    && actor.bypassMode === 'pull_request';
  return exact && members.length >= 1
    ? { state: 'conformant', reason: 'narrow-maintainer-team-pr-only' }
    : { state: 'drift', reason: 'bypass-not-exact-maintainer-team-pr-only' };
}

function evaluateRules(
  snapshot: GitHubOrganizationContractSnapshot,
  properties: Map<string, string> | null,
  organization: string,
  findings: DoctorFinding[],
): void {
  const definitions = snapshot.organizationRulesets;
  let definitionByName: Map<string, GitHubRulesetDefinition> | null = null;
  if (definitions.status === 'not-configured') {
    findings.push(finding('organization.rulesets', 'drift', '组织尚未配置平台 ruleset 定义。', {
      remedy: '由组织所有者拆分配置五个组织 ruleset；Steward 不创建或修改定义。',
    }));
  } else if (definitions.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.rulesets',
      '组织 ruleset 定义',
      definitions,
      '仅在本次诊断中提供临时 Ruleset elevated owner identity；不要扩大常驻组织诊断身份或 Steward App 权限。',
    ));
  } else {
    const monolithic = definitions.value.filter((item) => (
      item.sourceType === 'Organization'
      && STEWARD_LEGACY_MONOLITHIC_RULESET_NAMES.some((name) => (
        name.toLowerCase() === item.name.toLowerCase()
      ))
    ));
    const drift: string[] = monolithic.map((item) => `${item.name}:legacy-monolith`);
    const bypassUnknown: string[] = [];
    const bypassDrift: string[] = [];
    const platformRulesetNames = new Set(
      STEWARD_ORGANIZATION_RULESET_CONTRACTS.map((contract) => contract.name.toLowerCase()),
    );
    for (const definition of definitions.value) {
      if (!platformRulesetNames.has(definition.name.toLowerCase())) continue;
      if (definition.name === STEWARD_ORGANIZATION_RULESETS.humanReview) {
        const state = humanReviewBypassState(snapshot, definition);
        if (state.state === 'unknown') bypassUnknown.push(`${definition.name}#${definition.id}:${state.reason}`);
        if (state.state === 'drift') bypassDrift.push(`${definition.name}#${definition.id}:${state.reason}`);
      } else if (!definition.bypassActorsObserved) {
        bypassUnknown.push(`${definition.name}#${definition.id}:bypass_actors-not-observed`);
      } else if (definition.bypassActors.length) {
        bypassDrift.push(`${definition.name}#${definition.id}:bypass-not-allowed`);
      }
    }
    definitionByName = new Map<string, GitHubRulesetDefinition>();
    for (const contract of STEWARD_ORGANIZATION_RULESET_CONTRACTS) {
      const matches = definitions.value.filter((item) => (
        item.name.toLowerCase() === contract.name.toLowerCase()
      ));
      if (matches.length !== 1) {
        drift.push(`${contract.name}:${matches.length === 0 ? 'missing' : 'duplicate'}`);
        continue;
      }
      const [match] = matches;
      definitionByName.set(contract.name, match!);
      if (match?.name !== contract.name) drift.push(`${contract.name}:canonical-name`);
      if (match?.sourceType !== 'Organization'
        || match.source.toLowerCase() !== organization.toLowerCase()
        || match.target !== 'branch'
        || match.enforcement !== 'active') {
        drift.push(`${contract.name}:source-target-enforcement`);
      }
      if (match && !validRulesetConditions(match, contract.repositoryProperty)) {
        drift.push(`${contract.name}:conditions`);
      }
      if (match && !sameRuleTypes(match, stewardOrganizationRuleTypes(contract))) {
        drift.push(`${contract.name}:rules`);
      }
      if (match?.name === STEWARD_ORGANIZATION_RULESETS.matrix) {
        const checks = definitionMatrixChecks(match);
        if (checks.length !== 1
          || checks[0]?.valid !== true
          || checks[0]?.context !== STEWARD_MATRIX_CHECK_NAME
          || checks[0]?.integrationId !== STEWARD_APP_ID) {
          drift.push(`${contract.name}:required-check-source`);
        }
      }
    }
    findings.push(drift.length
      ? finding('organization.rulesets', 'drift', `组织 ruleset 定义/来源/拆分存在差距：${drift.join(', ')}。`, {
        remedy: '由组织所有者拆分 Base/Human/Code Security/Copilot/Steward Matrix；Steward 只读验证。',
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      })
      : finding('organization.rulesets', 'conformant', '五个组织 ruleset 的来源、targeting 维度、规则类型集合与 Matrix App source 符合当前结构合同。', {
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      }));
    findings.push(bypassDrift.length
      ? finding('organization.rulesets.bypass', 'drift', `以下 ruleset 存在 bypass actor：${bypassDrift.join(', ')}。`, {
        remedy: '由组织所有者删除平台及遗留规则中的广泛 bypass actor，并重新回读每个 detail。',
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      })
      : bypassUnknown.length
        ? finding('organization.rulesets.bypass', 'unknown', `以下 ruleset 的 bypass 尚不能判为符合：${bypassUnknown.join(', ')}。`, {
        remedy: '补齐完整 detail、maintainers Team 数字 ID 与成员读取；Human Review 只接受无 bypass 且至少两名 reviewer，或唯一 maintainers Team/pull_request 窄 bypass。',
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      })
      : finding('organization.rulesets.bypass', 'conformant', '平台 ruleset 的 bypass 符合合同：仅 Human Review 可使用唯一 maintainers Team/pull_request 窄绕过，其余均为空。', {
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      }));
    const parameterDrift: string[] = [];
    const parameterUnknown: string[] = [];
    for (const contract of STEWARD_ORGANIZATION_RULESET_CONTRACTS) {
      const definition = definitionByName.get(contract.name);
      if (!definition) {
        parameterDrift.push(`${contract.name}:definition-unavailable`);
        continue;
      }
      const liveContract = rulesetContractForLiveOrganization(snapshot, contract);
      if (!liveContract) {
        parameterUnknown.push(`${contract.name}:maintainer-Team-ID-unavailable`);
        continue;
      }
      const comparison = compareStewardOrganizationRules(liveContract, definition.rules);
      if (comparison.state === 'drift') parameterDrift.push(`${contract.name}:${comparison.reason}`);
      if (comparison.state === 'unknown') parameterUnknown.push(`${contract.name}:${comparison.reason}`);
    }
    findings.push(parameterDrift.length
      ? finding('organization.rulesets.parameters', 'drift', `Ruleset 参数与冻结合同不一致：${parameterDrift.join(', ')}。`, {
        remedy: '由组织所有者按冻结 fixture 精确修正参数；不得把“更严格”或 server 默认值机械视为等价。',
        source: definitions.evidence.source,
        endpoint: definitions.evidence.endpoint,
        ...evidenceFields(definitions.evidence),
        ...(definitions.evidence.relatedEndpoints
          ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
          : {}),
      })
      : parameterUnknown.length
        ? finding('organization.rulesets.parameters', 'unknown', `Ruleset 参数响应含缺失、malformed 或未支持语义：${parameterUnknown.join(', ')}。`, {
          remedy: '用 organization owner 身份重新读取 detail；未知字段必须先审查官方语义，不能静默接受。',
          source: definitions.evidence.source,
          endpoint: definitions.evidence.endpoint,
          ...evidenceFields(definitions.evidence),
          ...(definitions.evidence.relatedEndpoints
            ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
            : {}),
        })
        : finding('organization.rulesets.parameters', 'conformant', '五个组织 Ruleset 的规则参数均与冻结 fixture 语义等价。', {
          source: definitions.evidence.source,
          endpoint: definitions.evidence.endpoint,
          ...evidenceFields(definitions.evidence),
          ...(definitions.evidence.relatedEndpoints
            ? { relatedEndpoints: definitions.evidence.relatedEndpoints }
            : {}),
        }));
  }

  const applicable = snapshot.applicableRulesets;
  if (applicable.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.rulesets.repository-copies',
      '仓库 applicable ruleset summaries',
      applicable,
      '使用具备仓库 Metadata read 的身份重试，以独立排除平台保留名的仓库级副本。',
    ));
  } else if (applicable.status === 'known') {
    const reservedNames = new Set([
      ...STEWARD_ORGANIZATION_RULESET_CONTRACTS.map((contract) => contract.name.toLowerCase()),
      ...STEWARD_LEGACY_MONOLITHIC_RULESET_NAMES.map((name) => name.toLowerCase()),
    ]);
    const reservedCopies = applicable.value.filter((item) => (
      reservedNames.has(item.name.toLowerCase())
      && (item.sourceType !== 'Organization' || item.source.toLowerCase() !== organization.toLowerCase())
    ));
    findings.push(reservedCopies.length
      ? finding('organization.rulesets.repository-copies', 'drift', `发现平台保留名的非组织副本：${reservedCopies.map((item) => `${item.name}#${item.id}:${item.sourceType}`).join(', ')}。`, {
        remedy: '删除遗留平台副本或把无关自定义 ruleset 改为不占用平台保留名；无关自定义名称不受限制。',
        source: applicable.evidence.source,
        endpoint: applicable.evidence.endpoint,
      })
      : finding('organization.rulesets.repository-copies', 'conformant', '未发现平台保留名或遗留名的非组织 ruleset 副本；无关自定义 ruleset 保留。', {
        source: applicable.evidence.source,
        endpoint: applicable.evidence.endpoint,
      }));
  } else {
    findings.push(finding('organization.rulesets.repository-copies', 'conformant', '仓库未返回 applicable ruleset，因此未观察到平台保留名副本。', {
      source: applicable.evidence.source,
      endpoint: applicable.evidence.endpoint,
    }));
  }
  if (!properties || !definitionByName) {
    findings.push(finding('organization.rulesets.targeting', 'unknown', '仓库属性或组织 ruleset 定义未确认，无法验证 inherited/applicable targeting。', {
      remedy: '先恢复两类事实读取，再按属性核对实际命中的 ruleset ID。',
    }));
  } else if (applicable.status === 'not-configured') {
    findings.push(finding('organization.rulesets.targeting', 'drift', '仓库没有命中任何 inherited/applicable ruleset。', {
      remedy: '由组织所有者修正 repository property targeting。',
    }));
  } else if (applicable.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.rulesets.targeting',
      '仓库 inherited/applicable ruleset summaries',
      applicable,
      '使用具备仓库 Metadata read 的身份重试。',
    ));
  } else {
    const targetingDrift = STEWARD_ORGANIZATION_RULESET_CONTRACTS.flatMap((contract) => {
      const definition = definitionByName!.get(contract.name);
      if (!definition) return [`${contract.name}:definition-unavailable`];
      const expected = stewardOrganizationRulesetApplies(contract, properties);
      const summaries = applicable.value.filter((item) => item.id === definition.id);
      const observed = summaries.length === 1
        && summaries[0]?.name === definition.name
        && summaries[0]?.sourceType === 'Organization'
        && summaries[0]?.source.toLowerCase() === organization.toLowerCase()
        && summaries[0]?.enforcement === 'active';
      if (expected) return observed ? [] : [`${contract.name}:missing-or-conflicting-summary`];
      return summaries.length === 0 ? [] : [`${contract.name}:over-targeted`];
    });
    findings.push(targetingDrift.length
      ? finding('organization.rulesets.targeting', 'drift', `仓库 property targeting 与 applicable IDs 不一致：${targetingDrift.join(', ')}。`, {
        remedy: '由组织所有者修正组织 ruleset repository_property 条件。',
        source: applicable.evidence.source,
        endpoint: applicable.evidence.endpoint,
      })
      : finding('organization.rulesets.targeting', 'conformant', '仓库命中的平台组织 ruleset 与四个有效属性精确一致，且没有平台保留名的仓库级副本。', {
        source: applicable.evidence.source,
        endpoint: applicable.evidence.endpoint,
      }));
  }

  const effective = snapshot.effectiveRules;
  if (effective.status === 'not-configured') {
    findings.push(finding('organization.rules.effective', 'drift', '默认分支没有已确认的 effective rules。', {
      remedy: '由组织所有者修复规则 targeting 后重新读取 effective branch rules。',
    }));
    findings.push(finding('organization.rules.matrix-source', 'unknown', '没有 effective rules 证据，无法独立排除非组织来源的 Matrix context。', {
      remedy: '恢复默认分支 effective rules 读取后重试。',
    }));
    return;
  }
  if (effective.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.rules.effective',
      '默认分支 effective rules',
      effective,
      '使用具备仓库 Metadata read 的身份重试；不要在本地模拟规则聚合。',
    ));
    findings.push(finding('organization.rules.matrix-source', 'unknown', 'effective rules 无法读取，不能独立排除非组织来源的 Matrix context。', {
      remedy: '恢复默认分支 effective rules 读取后重试。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));
    return;
  }
  const organizationRules = effective.value.filter((rule) => (
    rule.rulesetSourceType === 'Organization'
    && rule.rulesetSource.toLowerCase() === organization.toLowerCase()
  ));
  const nonOrganizationMatrixChecks = effective.value
    .filter((rule) => rule.rulesetSourceType !== 'Organization'
      || rule.rulesetSource.toLowerCase() !== organization.toLowerCase())
    .flatMap(matrixRequiredChecks)
    .filter((check) => check.context === STEWARD_MATRIX_CHECK_NAME);
  findings.push(nonOrganizationMatrixChecks.length
    ? finding('organization.rules.matrix-source', 'drift', `effective rules 中发现 ${nonOrganizationMatrixChecks.length} 个非平台组织来源的 Matrix context。`, {
      remedy: '删除仓库级/外部来源的同名 Matrix required check，只保留平台组织 ruleset。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    })
    : finding('organization.rules.matrix-source', 'conformant', 'effective rules 未发现非平台组织来源的 Matrix context。', {
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));
  if (!properties || !definitionByName) {
    findings.push(finding('organization.rules.effective', 'unknown', '属性或组织定义未确认，无法把 effective rules 绑定到精确 ruleset ID。', {
      remedy: '先恢复 properties 与 organization ruleset detail 读取。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));
    findings.push(finding('organization.rules.matrix', 'unknown', '无法确认 Steward Matrix ruleset ID 与 effective App Check 的绑定关系。', {
      remedy: '先恢复组织定义读取。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));
    return;
  }
  const effectiveDrift: string[] = [];
  const effectiveUnknown: string[] = [];
  for (const contract of STEWARD_ORGANIZATION_RULESET_CONTRACTS) {
    const definition = definitionByName!.get(contract.name);
    if (!definition) {
      effectiveDrift.push(`${contract.name}:definition-unavailable`);
      continue;
    }
    const rules = organizationRules.filter((rule) => rule.rulesetId === definition.id);
    const shouldApply = stewardOrganizationRulesetApplies(contract, properties);
    if (!shouldApply) {
      if (rules.length) effectiveDrift.push(`${contract.name}:unexpected-effective`);
      continue;
    }
    const liveContract = rulesetContractForLiveOrganization(snapshot, contract);
    if (!liveContract) {
      effectiveUnknown.push(`${contract.name}:maintainer-Team-ID-unavailable`);
      continue;
    }
    const comparison = compareStewardOrganizationRules(liveContract, rules);
    if (comparison.state === 'drift') effectiveDrift.push(`${contract.name}:${comparison.reason}`);
    if (comparison.state === 'unknown') effectiveUnknown.push(`${contract.name}:${comparison.reason}`);
  }
  findings.push(effectiveDrift.length === 0
    ? effectiveUnknown.length
      ? finding('organization.rules.effective', 'unknown', `默认分支 effective rule 含无法安全解释的参数：${effectiveUnknown.join(', ')}。`, {
        remedy: '重新读取 effective branch rules；未知字段必须先审查语义，不能静默接受。',
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      })
      : finding('organization.rules.effective', 'conformant', `默认分支已按精确 ruleset ID 与参数回读 ${organizationRules.length} 条组织 effective rule。`, {
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      })
    : finding('organization.rules.effective', 'drift', `默认分支 effective rules 与定义/属性不一致：${effectiveDrift.join(', ')}。`, {
      remedy: '由组织所有者修正 Base Safety targeting；不得创建仓库级副本。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));

  const matrixRulesetId = definitionByName.get(STEWARD_ORGANIZATION_RULESETS.matrix)?.id;
  const matrixRules = effective.value.filter((rule) => rule.rulesetId === matrixRulesetId);
  const matrixChecks = matrixRules
    .flatMap(matrixRequiredChecks);
  const foreignMatrixChecks = effective.value
    .filter((rule) => rule.rulesetId !== matrixRulesetId)
    .flatMap(matrixRequiredChecks)
    .filter((check) => check.context === STEWARD_MATRIX_CHECK_NAME);
  const active = properties?.get('steward_state') === 'active';
  if (!properties) {
    findings.push(finding('organization.rules.matrix', 'unknown', '仓库 steward_state 未确认，无法判断 Matrix ruleset 是否应生效。', {
      remedy: '先修复并读取 custom properties，再核对 effective Matrix rule。',
      source: effective.evidence.source,
      endpoint: effective.evidence.endpoint,
    }));
  } else if (active) {
    const trusted = matrixChecks.length === 1
      && matrixChecks[0]?.valid === true
      && matrixChecks[0]?.context === STEWARD_MATRIX_CHECK_NAME
      && matrixChecks[0]?.integrationId === STEWARD_APP_ID
      && foreignMatrixChecks.length === 0;
    findings.push(trusted
      ? finding('organization.rules.matrix', 'conformant', `${STEWARD_MATRIX_CHECK_NAME} 已按 App ${STEWARD_APP_ID} 来源生效。`, {
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      })
      : finding('organization.rules.matrix', 'drift', `active 仓库未按 App ${STEWARD_APP_ID} 来源要求 ${STEWARD_MATRIX_CHECK_NAME}。`, {
        remedy: '由组织所有者修正 Steward Matrix ruleset 的 property targeting 与 required-check source。',
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      }));
  } else {
    findings.push(matrixRules.length === 0 && foreignMatrixChecks.length === 0
      ? finding('organization.rules.matrix', 'not-applicable', `steward_state=${properties.get('steward_state')}，Matrix rule 按合同不应生效。`, {
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      })
      : finding('organization.rules.matrix', 'drift', `非 active 仓库却已命中 ${STEWARD_MATRIX_CHECK_NAME}。`, {
        remedy: '由组织所有者把 Steward Matrix targeting 限定为 steward_state=active。',
        source: effective.evidence.source,
        endpoint: effective.evidence.endpoint,
      }));
  }
}

function evaluateTeam(
  snapshot: GitHubOrganizationContractSnapshot,
  manifest: StewardManifest | undefined,
  properties: Map<string, string> | null,
  findings: DoctorFinding[],
): void {
  if (manifest) {
    const maintainers = manifest.automation.maintainers;
    findings.push(maintainers.source === 'organization-team' && maintainers.teamSlug === STEWARD_MAINTAINER_TEAM_SLUG
      ? finding('manifest.maintainers', 'conformant', `Manifest 使用组织 Team ${STEWARD_MAINTAINER_TEAM_SLUG}。`)
      : finding('manifest.maintainers', 'drift', `Manifest 维护者来源不是 organization-team/${STEWARD_MAINTAINER_TEAM_SLUG}。`, {
        remedy: '在 v1→v2 连续迁移中切换为组织 Team；不要复制用户列表。',
      }));
  }
  const access = snapshot.maintainerTeamAccess;
  if (access.status === 'not-configured') {
    findings.push(finding('organization.team-role', 'drift', `Team ${STEWARD_MAINTAINER_TEAM_SLUG} 未获得目标仓库访问权。`, {
      remedy: '由组织所有者授予 Maintain；不要在 Manifest 中硬编码个人身份。',
    }));
  } else if (access.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.team-role',
      `Team ${STEWARD_MAINTAINER_TEAM_SLUG} 的仓库角色`,
      access,
      '使用具备 Members read 与仓库 Metadata read 的所有者诊断身份重试。',
    ));
  } else {
    const sufficient = access.value.roleName === 'maintain'
      && access.value.permissions.maintain
      && !access.value.permissions.admin;
    findings.push(sufficient
      ? finding('organization.team-role', 'conformant', `Team ${STEWARD_MAINTAINER_TEAM_SLUG} 的仓库角色为 ${access.value.roleName}。`, {
        source: access.evidence.source,
        endpoint: access.evidence.endpoint,
      })
      : finding('organization.team-role', 'drift', `Team ${STEWARD_MAINTAINER_TEAM_SLUG} 的仓库角色 ${access.value.roleName} 不等于平台合同要求的 Maintain。`, {
        remedy: '由组织所有者精确授予 Maintain；不要以 Admin 过度授权或自动 approval PAT 补偿。',
        source: access.evidence.source,
        endpoint: access.evidence.endpoint,
      }));
  }

  const members = snapshot.maintainerTeamMembers;
  if (!properties) {
    findings.push(finding('organization.team-reviewers', 'unknown', 'governance_tier 未确认，无法判断是否需要双 reviewer。', {
      remedy: '先恢复 custom property 读取，再验证 Team active members。',
    }));
  } else if (properties.get('governance_tier') !== 'reviewed') {
    findings.push(finding('organization.team-reviewers', 'not-applicable', `governance_tier=${properties.get('governance_tier')}，不启用双 reviewer 合同。`));
  } else if (members.status === 'not-configured') {
    findings.push(finding('organization.team-reviewers', 'drift', `Team ${STEWARD_MAINTAINER_TEAM_SLUG} 没有可用 active member。`, {
      remedy: '至少配置两名独立合格 reviewer 后才启用 governance_tier=reviewed。',
    }));
  } else if (members.status === 'unknown') {
    findings.push(unknownFinding(
      'organization.team-reviewers',
      `Team ${STEWARD_MAINTAINER_TEAM_SLUG} active members`,
      members,
      '使用具备 Members read 的组织所有者诊断身份重试。',
    ));
  } else {
    const uniqueMembers = new Set(members.value.map((login) => login.trim().toLowerCase()).filter(Boolean));
    const humanDefinition = snapshot.organizationRulesets.status === 'known'
      ? snapshot.organizationRulesets.value.find((item) => item.name === STEWARD_ORGANIZATION_RULESETS.humanReview)
      : undefined;
    const narrowBypass = humanDefinition?.bypassActors.length === 1
      && humanReviewBypassState(snapshot, humanDefinition).state === 'conformant';
    const sufficient = uniqueMembers.size >= 2 || uniqueMembers.size >= 1 && narrowBypass;
    findings.push(sufficient
      ? finding('organization.team-reviewers', 'conformant', narrowBypass
        ? `reviewed tier 已观察到 ${uniqueMembers.size} 个 Team member，并由唯一 maintainers Team/pull_request 窄 bypass 避免单人死锁。`
        : `reviewed tier 已观察到 ${uniqueMembers.size} 个不同 Team member login；真人独立性由组织成员治理保证。`, {
        source: members.evidence.source,
        endpoint: members.evidence.endpoint,
      })
      : finding('organization.team-reviewers', 'drift', `reviewed tier 只有 ${uniqueMembers.size} 个不同 Team member login，会形成审核死锁。`, {
        remedy: '至少配置两个合格真人 reviewer；单 reviewer 仅可配合唯一 maintainers Team/pull_request 窄 bypass，或保持 governance_tier=solo。',
        source: members.evidence.source,
        endpoint: members.evidence.endpoint,
      }));
  }
}

function permissionSatisfies(actual: string | undefined, required: 'read' | 'write'): boolean {
  return actual === required;
}

function evaluateApp(
  snapshot: GitHubOrganizationContractSnapshot,
  manifest: StewardManifest | undefined,
  organization: string,
  findings: DoctorFinding[],
): void {
  if (manifest) {
    findings.push(manifest.automation.githubApp.slug === STEWARD_APP_SLUG
      ? finding('manifest.app-identity', 'conformant', `Manifest App slug 为 ${STEWARD_APP_SLUG}。`)
      : finding('manifest.app-identity', 'drift', `Manifest App slug ${manifest.automation.githubApp.slug} 不是平台 App ${STEWARD_APP_SLUG}。`, {
        remedy: '当前 v1 修正 App identity；目标 v2 将移除 consumer App identity。',
      }));
  }
  const installation = snapshot.appInstallation;
  if (installation.status === 'not-configured') {
    findings.push(finding('app.installation', 'drift', `平台 App ${STEWARD_APP_SLUG} 尚未安装到目标仓库。`, {
      remedy: '由 installation owner 将仓库加入 App scope 并重新批准权限/事件。',
    }));
    return;
  }
  if (installation.status === 'unknown') {
    findings.push(unknownFinding(
      'app.installation',
      '平台 App installation',
      installation,
      '优先使用 App JWT 读取仓库 installation；selected scope 可用 App user token 作只读复核。',
    ));
    return;
  }
  const app = installation.value;
  const identity = app.appId === STEWARD_APP_ID
    && app.appSlug === STEWARD_APP_SLUG
    && app.accountLogin?.toLowerCase() === organization.toLowerCase();
  if (manifest) {
    const manifestClientId = manifest.automation.githubApp.clientId;
    const clientIdState: DoctorFindingState = app.clientId === undefined
      ? 'unknown'
      : app.clientId === manifestClientId ? 'conformant' : 'drift';
    findings.push(finding(
      'manifest.app-client-id',
      clientIdState,
      app.clientId === undefined
        ? 'installation 响应未提供 client ID，无法与 Manifest v1 identity 交叉验证。'
        : app.clientId === manifestClientId
          ? 'Manifest v1 client ID 与 installation 一致。'
          : 'Manifest v1 client ID 与 installation 不一致。',
      {
        ...(clientIdState === 'conformant' ? {} : { remedy: '修正 v1 Manifest identity；v2 再按计划移除 consumer App identity。' }),
        source: installation.evidence.source,
        endpoint: installation.evidence.endpoint,
        ...evidenceFields(installation.evidence),
      },
    ));
  }
  let scopeState: DoctorFindingState = 'conformant';
  let scopeSummary = app.repositorySelection === 'all' ? 'all repositories' : 'selected repository 已确认';
  if (app.repositoryAccess.status === 'not-configured') {
    scopeState = 'drift';
    scopeSummary = 'selected scope 未包含目标仓库';
  } else if (app.repositoryAccess.status === 'unknown') {
    scopeState = app.repositoryAccess.reason === 'permission-denied' ? 'permission-denied' : 'unknown';
    scopeSummary = `selected scope 无法确认：${app.repositoryAccess.reason}`;
  } else if (!app.repositoryAccess.value) {
    scopeState = 'drift';
    scopeSummary = 'selected scope 未包含目标仓库';
  }
  const installationDrift = !identity || Boolean(app.suspendedAt) || scopeState === 'drift';
  const installationUnknown = scopeState === 'unknown' || scopeState === 'permission-denied';
  const scopeEvidence = app.repositorySelection === 'selected'
    ? app.repositoryAccess.evidence
    : installation.evidence;
  const scopeRelatedEndpoints = scopeEvidence.endpoint === installation.evidence.endpoint
    ? scopeEvidence.relatedEndpoints
    : [installation.evidence.endpoint, ...(scopeEvidence.relatedEndpoints ?? [])];
  const scopeFailure = app.repositoryAccess.status === 'unknown'
    ? {
      ...(app.repositoryAccess.httpStatus !== undefined
        ? { httpStatus: app.repositoryAccess.httpStatus }
        : {}),
      ...(app.repositoryAccess.retryable !== undefined
        ? { retryable: app.repositoryAccess.retryable }
        : {}),
      ...(app.repositoryAccess.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: app.repositoryAccess.retryAfterSeconds }
        : {}),
      ...(app.repositoryAccess.requestId ? { requestId: app.repositoryAccess.requestId } : {}),
      ...(app.repositoryAccess.evidence.blockedEndpoint
        ? { blockedEndpoint: app.repositoryAccess.evidence.blockedEndpoint }
        : {}),
    }
    : {};
  findings.push(finding(
    'app.installation',
    installationDrift ? 'drift' : installationUnknown ? scopeState : 'conformant',
    `installation ${app.installationId}：App ${app.appId}/${app.appSlug}，scope=${scopeSummary}，suspended=${app.suspendedAt ? 'yes' : 'no'}。`,
    {
      ...(installationDrift || installationUnknown
        ? { remedy: '由 installation owner 修正 App identity/scope/suspension 后重新读取。' }
        : {}),
      source: scopeEvidence.source,
      endpoint: scopeEvidence.endpoint,
      ...evidenceFields(scopeEvidence),
      ...(scopeRelatedEndpoints ? { relatedEndpoints: scopeRelatedEndpoints } : {}),
      ...scopeFailure,
    },
  ));

  const missingPermissions = Object.entries(STEWARD_APP_REQUIRED_PERMISSIONS)
    .filter(([name, required]) => !permissionSatisfies(app.permissions[name], required))
    .map(([name, required]) => `${name}:${required}`);
  const allowedPermissions = new Set([
    ...Object.keys(STEWARD_APP_REQUIRED_PERMISSIONS),
    ...Object.keys(STEWARD_APP_OPTIONAL_PERMISSIONS),
  ]);
  const unexpectedPermissions = Object.entries(app.permissions)
    .filter(([name, permission]) => permission !== 'none' && !allowedPermissions.has(name))
    .map(([name, permission]) => `${name}:${permission}`)
    .sort();
  const invalidOptionalPermissions = Object.entries(STEWARD_APP_OPTIONAL_PERMISSIONS)
    .filter(([name, required]) => app.permissions[name] !== undefined
      && app.permissions[name] !== 'none'
      && !permissionSatisfies(app.permissions[name], required))
    .map(([name, required]) => `${name}:${required}`);
  const permissionDrift = [...missingPermissions, ...invalidOptionalPermissions, ...unexpectedPermissions];
  findings.push(permissionDrift.length
    ? finding('app.permissions', 'drift', `App installation 权限偏离平台合同：${permissionDrift.join(', ')}。`, {
      remedy: '由 App owner 更新注册权限并由 installation owner 重新批准；runtime App 仅读组织 properties 且不写 repository properties，普通治理不要求 Workflows write。',
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
    })
    : finding('app.permissions', 'conformant', 'App installation 权限覆盖平台最大授权合同。', {
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
  }));
  const events = new Set(app.events);
  const runtimeReadyEvents = new Set<string>(STEWARD_APP_RUNTIME_READY_EXPLICIT_EVENTS);
  const plannedEvents = new Set<string>(STEWARD_APP_PLANNED_EXPLICIT_EVENTS);
  const missingEvents = STEWARD_APP_RUNTIME_READY_EXPLICIT_EVENTS.filter((event) => !events.has(event));
  const unexpectedEvents = [...events]
    .filter((event) => !runtimeReadyEvents.has(event) && !plannedEvents.has(event))
    .sort();
  const eventDrift = [
    ...missingEvents.map((event) => `${event}:missing`),
    ...unexpectedEvents.map((event) => `${event}:unexpected`),
  ];
  findings.push(eventDrift.length
    ? finding('app.events', 'drift', `App 显式订阅事件偏离合同：${eventDrift.join(', ')}。`, {
      remedy: '当前只修复已有 review handler 所需事件；未来事件必须等 Ingress/Queue/Control fan-out 与乱序夹具就绪后再订阅。',
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
    })
    : finding('app.events', 'conformant', '当前已实现的 review handler 所需显式事件已订阅，且没有平台合同外事件。', {
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
    }));
  const subscribedPlannedEvents = STEWARD_APP_PLANNED_EXPLICIT_EVENTS.filter((event) => events.has(event));
  findings.push(subscribedPlannedEvents.length
    ? finding('app.events.planned', 'unknown', `已观察到 ${subscribedPlannedEvents.length} 个未来显式事件订阅；旧 Relay/Control 尚不能证明会持久化与 fan-out：${subscribedPlannedEvents.join(', ')}。`, {
      remedy: '不要继续扩展 live App；先完成 public Ingress→Queue/DLQ→private Control handler、重复/乱序夹具和 canary，再整体回读注册。',
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
    })
    : finding('app.events.planned', 'not-applicable', '未来 property/Team/repository/scope 事件尚未订阅；这在 handler 与 fan-out 就绪前是预期状态。', {
      source: installation.evidence.source,
      endpoint: installation.evidence.endpoint,
      ...evidenceFields(installation.evidence),
    }));
}

function evaluateWorkflowToken(
  code: string,
  subject: string,
  result: GitHubReadResult<GitHubWorkflowTokenSettings>,
  findings: DoctorFinding[],
): void {
  if (result.status === 'not-configured') {
    findings.push(finding(code, 'drift', `${subject} 未配置。`, { remedy: '由组织所有者配置只读默认 token 并禁止 Actions 批准 PR。' }));
  } else if (result.status === 'unknown') {
    findings.push(unknownFinding(code, subject, result, '使用具备对应 Administration read 的所有者诊断身份重试。'));
  } else {
    const valid = result.value.defaultWorkflowPermissions === 'read'
      && !result.value.canApprovePullRequestReviews;
    findings.push(valid
      ? finding(code, 'conformant', `${subject} 为 read，且禁止 Actions 批准 PR。`, {
        source: result.evidence.source,
        endpoint: result.evidence.endpoint,
        ...evidenceFields(result.evidence),
      })
      : finding(code, 'drift', `${subject} 为 ${result.value.defaultWorkflowPermissions}，canApprove=${result.value.canApprovePullRequestReviews}。`, {
        remedy: '由组织所有者改为 read 并关闭 Actions 创建/批准 PR。',
        source: result.evidence.source,
        endpoint: result.evidence.endpoint,
        ...evidenceFields(result.evidence),
      }));
  }
}

function evaluateSelectedActions(
  code: string,
  subject: string,
  result: GitHubReadResult<GitHubSelectedActionsSettings | null>,
  findings: DoctorFinding[],
): void {
  if (result.status === 'not-configured') {
    findings.push(finding(code, 'drift', `${subject} 未配置。`, { remedy: '先完成 uses inventory，再由组织所有者配置审计 allowlist。' }));
  } else if (result.status === 'unknown') {
    findings.push(unknownFinding(code, subject, result, '使用具备对应 Administration read 的所有者诊断身份重试。'));
  } else if (result.value === null) {
    findings.push(finding(code, 'drift', `${subject} 不适用，因为 allowed_actions 尚未设为 selected。`, {
      remedy: '先完成 uses inventory，再将 allowed_actions 收敛为 selected。',
      source: result.evidence.source,
      endpoint: result.evidence.endpoint,
      ...evidenceFields(result.evidence),
    }));
  } else {
    const actualPatterns = [...result.value.patternsAllowed].sort();
    const expectedPatterns = [...STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.patternsAllowed].sort();
    const exactPatterns = actualPatterns.length === expectedPatterns.length
      && actualPatterns.every((pattern, index) => pattern === expectedPatterns[index]);
    const exact = result.value.githubOwnedAllowed
      === STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.githubOwnedAllowed
      && result.value.verifiedAllowed
      === STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.verifiedAllowed
      && exactPatterns;
    findings.push(!exact
      ? finding(code, 'drift', `${subject} 偏离冻结合同：githubOwned=${result.value.githubOwnedAllowed}，verified=${result.value.verifiedAllowed}，patterns=${actualPatterns.join(', ') || 'none'}。`, {
        remedy: `由组织所有者设为 githubOwned=${STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.githubOwnedAllowed}、verified=${STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.verifiedAllowed}、patterns=${expectedPatterns.join(', ')}。`,
        source: result.evidence.source,
        endpoint: result.evidence.endpoint,
        ...evidenceFields(result.evidence),
      })
      : finding(code, 'conformant', `${subject} 与冻结 inventory 派生的精确 allowlist 一致。`, {
        source: result.evidence.source,
        endpoint: result.evidence.endpoint,
        ...evidenceFields(result.evidence),
      }));
  }
}

async function evaluateActions(
  snapshot: GitHubOrganizationContractSnapshot,
  manifest: StewardManifest | undefined,
  properties: Map<string, string> | null,
  identity: { readonly organization: string; readonly repositoryId: number; readonly repositoryFullName: string },
  evaluatedAt: string,
  findings: DoctorFinding[],
): Promise<void> {
  const organization = snapshot.actions.organization;
  if (organization.status === 'not-configured') {
    findings.push(finding('actions.organization', 'drift', '组织 Actions General 未配置。', {
      remedy: '由组织所有者统一配置 enabled repositories、selected allowlist 与 full-SHA enforcement。',
    }));
  } else if (organization.status === 'unknown') {
    findings.push(unknownFinding('actions.organization', '组织 Actions General', organization,
      '使用具备 Organization Administration read 的所有者诊断身份重试；不要扩大 Steward App 权限。'));
  } else {
    const ready = organization.value.enabledRepositories
      === STEWARD_ACTIONS_GENERAL_POLICY.enabledRepositories
      && organization.value.allowedActions === STEWARD_ACTIONS_GENERAL_POLICY.allowedActions
      && organization.value.shaPinningRequired
      === STEWARD_ACTIONS_GENERAL_POLICY.shaPinningRequired;
    findings.push(ready
      ? finding('actions.organization', 'conformant', '组织 Actions 已统一覆盖全部仓库，并启用 selected allowlist 与 full-SHA enforcement。', {
        source: organization.evidence.source,
        endpoint: organization.evidence.endpoint,
        ...evidenceFields(organization.evidence),
      })
      : finding('actions.organization', 'drift', '组织 Actions 未达到 all repositories + selected + full-SHA 合同。', {
        remedy: '完成 uses inventory 与升级测试后，由组织所有者统一收紧；Steward 不写该设置。',
        source: organization.evidence.source,
        endpoint: organization.evidence.endpoint,
        ...evidenceFields(organization.evidence),
      }));
  }

  const repository = snapshot.actions.repository;
  const ciProfile = properties?.get('ci_profile');
  const requiresRepositoryActions = manifest?.features.release === true || ciProfile === 'codeql';
  const repositoryRequirementKnown = Boolean(manifest && properties);
  if (repository.status === 'unknown') {
    findings.push(unknownFinding('actions.repository', '仓库 Actions 可用性', repository,
      '使用具备仓库 Administration read 的诊断身份重试；仓库不得复制组织 allowlist 或 full-SHA 策略。'));
  } else if (repository.status === 'not-configured') {
    findings.push(finding('actions.repository', requiresRepositoryActions ? 'drift' : repositoryRequirementKnown ? 'not-applicable' : 'unknown',
      requiresRepositoryActions
        ? `仓库需要 ${manifest?.features.release ? 'Release' : 'CodeQL'} Actions consumer，但 Actions 未配置或不可用。`
        : repositoryRequirementKnown ? 'Release 未启用且 ci_profile=none，本仓库不需要本地 Actions consumer。' : 'Manifest 或 ci_profile 未确认，无法判断仓库是否需要 Actions。', {
        remedy: '仅在 Release 或 ci_profile=codeql 需要本地 consumer 时启用仓库 Actions；策略由组织统一继承。',
      }));
  } else if (repository.value.enabled) {
    findings.push(finding('actions.repository', 'conformant', '仓库 Actions 未被局部禁用；allowlist、full-SHA 与默认 token 由组织策略统一约束。', {
      source: repository.evidence.source,
      endpoint: repository.evidence.endpoint,
      ...evidenceFields(repository.evidence),
    }));
  } else if (requiresRepositoryActions) {
    findings.push(finding('actions.repository', 'drift', `仓库需要 ${manifest?.features.release ? 'Release' : 'CodeQL'} Actions consumer，但仓库 Actions 被局部禁用。`, {
      remedy: '启用仓库 Actions；具体 allowlist、full-SHA 与 token 权限继续由组织统一治理。',
      source: repository.evidence.source,
      endpoint: repository.evidence.endpoint,
      ...evidenceFields(repository.evidence),
    }));
  } else if (!repositoryRequirementKnown) {
    findings.push(finding('actions.repository', 'unknown', '仓库 Actions 已禁用，但 Manifest 或 ci_profile 未确认，无法判断是否影响本地 consumer。', {
      remedy: '先恢复 Manifest 与 custom property 读取，再判断是否需要启用仓库 Actions。',
      source: repository.evidence.source,
      endpoint: repository.evidence.endpoint,
      ...evidenceFields(repository.evidence),
    }));
  } else {
    findings.push(finding('actions.repository', 'not-applicable', 'Release 未启用且 ci_profile=none；仓库 Actions 可保持禁用。', {
      source: repository.evidence.source,
      endpoint: repository.evidence.endpoint,
      ...evidenceFields(repository.evidence),
    }));
  }
  evaluateWorkflowToken(
    'actions.organization-token',
    '组织默认 GITHUB_TOKEN',
    snapshot.actions.organizationWorkflowToken,
    findings,
  );
  evaluateSelectedActions(
    'actions.organization-allowlist',
    '组织 selected Actions allowlist',
    snapshot.actions.organizationSelectedActions,
    findings,
  );
  const preview = snapshot.actions.executionProtections;
  if (preview.status === 'not-configured') {
    findings.push(finding('actions.execution-protections', 'drift', 'Actions workflow execution protections 未配置。', {
      remedy: '由组织所有者先在 Evaluate 模式验证，再切换 Active。',
      source: preview.evidence.source,
      endpoint: preview.evidence.endpoint,
      ...evidenceFields(preview.evidence),
    }));
  } else if (preview.status === 'unknown') {
    findings.push(unknownFinding(
      'actions.execution-protections',
      'Actions workflow execution protections（public preview）',
      preview,
      '由组织所有者在 GitHub UI 以 Evaluate→Active 方式验证；稳定公开 API 出现前不得声称“0 条”或“已配置”。',
    ));
  } else {
    const attestation = preview.value;
    const propertyDigest = properties
      ? await hashJson(STEWARD_ORGANIZATION_PROPERTIES.map((property) => [
        property.name,
        properties.get(property.name) ?? null,
      ]))
      : null;
    const wellFormed = attestation.schemaVersion === 1
      && typeof attestation.organization === 'string' && Boolean(attestation.organization.trim())
      && Number.isSafeInteger(attestation.repositoryId) && attestation.repositoryId > 0
      && typeof attestation.repositoryFullName === 'string'
      && /^[^/]+\/[^/]+$/.test(attestation.repositoryFullName)
      && typeof attestation.propertyDigest === 'string'
      && /^[a-f0-9]{64}$/.test(attestation.propertyDigest)
      && typeof attestation.contractVersion === 'string'
      && Boolean(attestation.contractVersion.trim())
      && typeof attestation.contractDigest === 'string'
      && /^[a-f0-9]{64}$/.test(attestation.contractDigest)
      && typeof attestation.inventoryVersion === 'string'
      && Boolean(attestation.inventoryVersion.trim())
      && typeof attestation.inventoryDigest === 'string'
      && /^[a-f0-9]{64}$/.test(attestation.inventoryDigest)
      && typeof attestation.policyDigest === 'string'
      && /^[a-f0-9]{64}$/.test(attestation.policyDigest)
      && Number.isSafeInteger(attestation.policyCount) && attestation.policyCount >= 0
      && typeof attestation.issuedAt === 'string' && Boolean(attestation.issuedAt.trim())
      && typeof attestation.observedAt === 'string' && Boolean(attestation.observedAt.trim())
      && typeof attestation.expiresAt === 'string' && Boolean(attestation.expiresAt.trim())
      && typeof attestation.nonce === 'string' && Boolean(attestation.nonce.trim())
      && typeof attestation.attestor?.login === 'string'
      && Boolean(attestation.attestor.login.trim())
      && Number.isSafeInteger(attestation.attestor?.id) && attestation.attestor.id > 0
      && attestation.verification?.method === 'github-ssh-signing-key'
      && Number.isSafeInteger(attestation.verification?.signingKeyId)
      && attestation.verification.signingKeyId > 0
      && attestation.verification?.signingKeyAlgorithm === 'ssh-ed25519'
      && attestation.verification?.organizationMembership?.state === 'active'
      && attestation.verification?.organizationMembership?.role === 'admin'
      && typeof attestation.verification?.authenticatedPrincipal?.login === 'string'
      && attestation.verification.authenticatedPrincipal.login.toLowerCase()
      === attestation.attestor.login.toLowerCase()
      && attestation.verification?.authenticatedPrincipal?.id === attestation.attestor.id
      && preview.evidence.source === 'github-ui-attestation'
      && preview.evidence.observedAt === attestation.observedAt;
    if (!wellFormed) {
      findings.push(finding('actions.execution-protections', 'unknown', 'Actions execution protections owner attestation 未通过可信输入结构或 owner 验证合同。', {
        remedy: '通过 --actions-attestation 提供 SSHSIG envelope，并用同一 active organization owner 的诊断 token 验证当前 GitHub signing key。',
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      }));
      return;
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const observedAt = Date.parse(attestation.observedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const fresh = Number.isFinite(issuedAt)
      && Number.isFinite(observedAt)
      && Number.isFinite(expiresAt)
      && Number.isFinite(evaluatedAtMs)
      && observedAt <= issuedAt
      && issuedAt <= expiresAt
      && evaluatedAtMs >= issuedAt - MAX_DIAGNOSTIC_CLOCK_SKEW_MS
      && evaluatedAtMs <= expiresAt
      && freshDiagnosticEvidence(attestation.observedAt, evaluatedAt);
    if (!fresh) {
      findings.push(finding('actions.execution-protections', 'unknown', 'Actions workflow execution protections 的 owner-signed attestation 已过期、来自未来或时间顺序非法。', {
        remedy: '由组织所有者重新观察 UI 并提供 observedAt≤issuedAt≤expiresAt、观察时间不超过 15 分钟的 fresh SSHSIG envelope。',
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      }));
      return;
    }
    if (propertyDigest === null) {
      findings.push(finding('actions.execution-protections', 'unknown', '四个 repository property 未确认，无法验证 Actions attestation 是否绑定当前治理状态。', {
        remedy: '先恢复 property live read，再重新生成 owner attestation。',
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      }));
      return;
    }
    const bound = attestation.organization.toLowerCase() === identity.organization.toLowerCase()
      && attestation.repositoryId === identity.repositoryId
      && attestation.repositoryFullName.toLowerCase() === identity.repositoryFullName.toLowerCase()
      && attestation.propertyDigest === propertyDigest
      && attestation.contractVersion === STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.contractVersion
      && attestation.contractDigest === STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST
      && attestation.inventoryVersion === STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.inventoryVersion
      && attestation.inventoryDigest === STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST
      && attestation.policyDigest === STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST;
    if (!bound) {
      findings.push(finding('actions.execution-protections', 'drift', '已验证的 Actions execution protections attestation 未绑定本次组织、仓库、当前属性、inventory 或冻结合同。', {
        remedy: '由 organization owner 按当前目标、properties、inventory 和 policy 重新观察并签名；不要复用旧证明。',
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      }));
      return;
    }
    const exactModeAndCount = attestation.mode
      === STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.requiredMode
      && attestation.policyCount
      === STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.expectedPolicyCount;
    findings.push(!exactModeAndCount
      ? finding('actions.execution-protections', 'drift', `已验证的 Actions execution protections 为 ${attestation.mode}/${attestation.policyCount} 条；合同要求 ${STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.requiredMode}/${STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.expectedPolicyCount} 条。`, {
        remedy: '完成 Evaluate 证据后由组织所有者切换 Active；preview 策略仍不得成为唯一信任边界。',
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      })
      : finding('actions.execution-protections', 'conformant', `active organization owner 的 GitHub SSH signing key 已验证；fresh attestation 精确绑定 ${identity.repositoryFullName}、当前 properties、${attestation.inventoryVersion} 与 Active/${attestation.policyCount} 条策略。`, {
        source: preview.evidence.source,
        endpoint: preview.evidence.endpoint,
        ...evidenceFields(preview.evidence),
      }));
  }
}

async function runtimeResult(
  reader: RuntimeDiagnosticsReader | undefined,
  input: { repositoryId: number; owner: string; repository: string },
  observedAt: string,
): Promise<RuntimeDiagnosticsResult> {
  if (!reader) {
    return {
      status: 'unknown',
      reason: 'runtime-metadata-unavailable',
      source: 'runtime-adapter',
      observedAt,
    };
  }
  try {
    return await reader.read(input);
  } catch {
    return { status: 'unknown', reason: 'transport-error', source: 'runtime-adapter', observedAt };
  }
}

function evaluateRuntime(
  result: RuntimeDiagnosticsResult,
  properties: Map<string, string> | null,
  expected: { readonly repositoryId: number; readonly owner: string; readonly repository: string },
  evaluatedAt: string,
  findings: DoctorFinding[],
): void {
  if (result.status === 'unknown') {
    findings.push(finding(
      'runtime.control-revision',
      result.reason === 'permission-denied' ? 'permission-denied' : 'unknown',
      `中央 runtime/controlRevision 无法确认：${result.reason}。`,
      {
        remedy: '接入经认证的 private Control runtime diagnostics；不得从仓库 SHA、Manifest digest 或 Check 猜测。',
        source: result.source,
        observedAt: result.observedAt,
      },
    ));
    findings.push(finding('runtime.central-components', 'unknown', '中央 runtime 不可读，无法确认 Queue、Control 与 DLQ 当前状态。', {
      remedy: '接入经认证的 private Control runtime diagnostics，并按目标 repository identity 返回 fresh 状态。',
      source: result.source,
      observedAt: result.observedAt,
    }));
    return;
  }
  const bound = result.repositoryId === expected.repositoryId
    && result.owner.toLowerCase() === expected.owner.toLowerCase()
    && result.repository.toLowerCase() === expected.repository.toLowerCase();
  if (!bound) {
    findings.push(finding('runtime.control-revision', 'unknown', '中央 runtime diagnostics 未绑定到本次目标 repository identity。', {
      remedy: 'private Control 响应必须回显并签定 repository ID、owner、repository，doctor 只接受精确匹配。',
      source: result.source,
      observedAt: result.observedAt,
    }));
    findings.push(finding('runtime.central-components', 'unknown', 'runtime repository identity 不匹配，不能复用其 Queue、Control 或 DLQ 状态。', {
      remedy: '按目标 repository identity 重新读取 fresh runtime diagnostics。',
      source: result.source,
      observedAt: result.observedAt,
    }));
    return;
  }
  if (!freshDiagnosticEvidence(result.observedAt, evaluatedAt)) {
    findings.push(finding('runtime.control-revision', 'unknown', '中央 runtime diagnostics 已过期、来自未来或时间戳非法。', {
      remedy: '从 private Control 获取不超过 15 分钟的 fresh runtime diagnostics 后重试。',
      source: result.source,
      observedAt: result.observedAt,
    }));
    findings.push(finding('runtime.central-components', 'unknown', '缺少 fresh runtime 证据，无法确认 Queue、Control 与 DLQ 当前状态。', {
      remedy: '从 private Control 获取 fresh runtime diagnostics；不得沿用历史健康快照。',
      source: result.source,
      observedAt: result.observedAt,
    }));
    return;
  }
  const revision = result.value.controlRevision;
  const valid = /^[a-f0-9]{40}$/.test(revision.stewardCommit)
    && Boolean(revision.workerVersionId.trim())
    && Boolean(revision.workerDeploymentId.trim());
  const ring = properties?.get('steward_ring');
  const expectedEnvironment = ring === 'canary' || ring === 'production' ? ring : undefined;
  const revisionState: DoctorFindingState = !valid
    ? 'drift'
    : !expectedEnvironment ? 'unknown'
      : revision.environment === expectedEnvironment ? 'conformant' : 'drift';
  findings.push(revisionState === 'conformant'
    ? finding('runtime.control-revision', 'conformant', [
      `${revision.environment} runtime：Steward ${revision.stewardCommit.slice(0, 12)}…，`,
      `Worker version=${revision.workerVersionId}，deployment=${revision.workerDeploymentId}。`,
    ].join(''), { source: result.source, observedAt: result.observedAt })
    : finding('runtime.control-revision', revisionState, !valid
      ? 'runtime 返回的 controlRevision 不完整或不可信。'
      : !expectedEnvironment
        ? `runtime 环境为 ${revision.environment}，但 steward_ring 无法确认。`
        : `steward_ring=${expectedEnvironment}，实际 runtime 环境为 ${revision.environment}。`, {
      remedy: '发布端必须提供完整不可变 revision，并让仓库 ring 精确路由到 canary 或 production。',
      source: result.source,
      observedAt: result.observedAt,
    }));
  const componentsReady = result.value.queue === 'ready'
    && result.value.control === 'ready'
    && result.value.deadLetterQueue === 'clear';
  findings.push(componentsReady
    ? finding('runtime.central-components', 'conformant', `Queue=${result.value.queue}，Control=${result.value.control}，DLQ=${result.value.deadLetterQueue}。`, {
      source: result.source,
      observedAt: result.observedAt,
    })
    : finding('runtime.central-components', 'drift', `Queue=${result.value.queue}，Control=${result.value.control}，DLQ=${result.value.deadLetterQueue}。`, {
      remedy: '修复中央 Queue/Control/DLQ 后再进入 canary 或 active property transition。',
      source: result.source,
      observedAt: result.observedAt,
    }));
}

function parsePull(payload: unknown): PullPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('GitHub pull request must be an object');
  return payload as PullPayload;
}

function pullItems(payload: unknown): PullPayload[] {
  if (!Array.isArray(payload)) throw new TypeError('GitHub pull request list must be an array');
  return payload.map((candidate, index) => {
    const pull = parsePull(candidate);
    if (pull.state !== 'open'
      || !Number.isSafeInteger(pull.number) || Number(pull.number) < 1
      || typeof pull.base?.ref !== 'string' || !pull.base.ref
      || typeof pull.head?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(pull.head.sha)) {
      throw new TypeError(`GitHub open pull request[${index}] is malformed`);
    }
    return pull;
  });
}

function associatedPullItems(payload: unknown): PullPayload[] {
  if (!Array.isArray(payload)) throw new TypeError('GitHub commit-associated pull request list must be an array');
  return payload.map((candidate, index) => {
    const pull = parsePull(candidate);
    if (pull.state !== 'open' && pull.state !== 'closed') {
      throw new TypeError(`GitHub commit-associated pull request[${index}] has an invalid state`);
    }
    if (pull.state === 'open') {
      const headSha = pull.head?.sha;
      if (!Number.isSafeInteger(pull.number) || Number(pull.number) < 1
        || typeof headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(headSha)) {
        throw new TypeError(`GitHub commit-associated open pull request[${index}] is malformed`);
      }
    }
    return pull;
  });
}

function exactOpenPullNumbersForHead(items: readonly PullPayload[], headSha: string): number[] {
  return [...new Set(items
    .filter((pull) => pull.state === 'open'
      && String(pull.head?.sha ?? '').toLowerCase() === headSha)
    .map((pull) => Number(pull.number)))].sort((left, right) => left - right);
}

function commitItems(payload: unknown): PullCommitPayload[] {
  if (!Array.isArray(payload)) throw new TypeError('GitHub pull request commits must be an array');
  return payload.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`GitHub pull request commit[${index}] must be an object`);
    }
    const item = candidate as PullCommitPayload;
    if (!/^[a-f0-9]{40}$/i.test(String(item.sha ?? ''))
      || item.author !== undefined && item.author !== null
        && (typeof item.author !== 'object' || Array.isArray(item.author)
          || item.author.login !== undefined && typeof item.author.login !== 'string')) {
      throw new TypeError(`GitHub pull request commit[${index}] is malformed`);
    }
    return item;
  });
}

function fileItems(payload: unknown): PullFilePayload[] {
  if (!Array.isArray(payload)) throw new TypeError('GitHub pull request files must be an array');
  return payload.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`GitHub pull request file[${index}] must be an object`);
    }
    const item = candidate as PullFilePayload;
    if (typeof item.filename !== 'string' || !item.filename
      || typeof item.status !== 'string' || !item.status
      || typeof item.sha !== 'string' || !item.sha
      || !Number.isSafeInteger(item.additions) || Number(item.additions) < 0
      || !Number.isSafeInteger(item.deletions) || Number(item.deletions) < 0) {
      throw new TypeError(`GitHub pull request file[${index}] is malformed`);
    }
    return item;
  });
}

function workflowRunItems(payload: unknown): MatrixWorkflowRun[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('GitHub workflow runs response must be an object');
  }
  const items = (payload as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(items)) throw new TypeError('GitHub workflow runs response.workflow_runs must be an array');
  return items.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !Number.isSafeInteger((candidate as MatrixWorkflowRun).id)
      || Number((candidate as MatrixWorkflowRun).id) < 1) {
      throw new TypeError(`GitHub workflow run[${index}] is malformed`);
    }
    return candidate as MatrixWorkflowRun;
  });
}

function completeFingerprintPull(pull: PullPayload): boolean {
  return Number.isSafeInteger(pull.number) && Number(pull.number) > 0
    && pull.state === 'open'
    && typeof pull.title === 'string'
    && (typeof pull.body === 'string' || pull.body === null)
    && typeof pull.user?.login === 'string' && Boolean(pull.user.login.trim())
    && typeof pull.base?.ref === 'string' && Boolean(pull.base.ref)
    && /^[a-f0-9]{40}$/i.test(String(pull.base.sha ?? ''))
    && typeof pull.head?.ref === 'string' && Boolean(pull.head.ref)
    && /^[a-f0-9]{40}$/i.test(String(pull.head.sha ?? ''));
}

function checkItems(payload: unknown): GitHubCheckRun[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('GitHub check-runs response must be an object');
  const items = (payload as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(items)) throw new TypeError('GitHub check-runs response.check_runs must be an array');
  const pendingStatuses = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
  const terminalConclusions = new Set([
    'action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'startup_failure', 'timed_out',
  ]);
  return items.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`GitHub check run[${index}] must be an object`);
    }
    const check = candidate as GitHubCheckRun;
    const status = String(check.status ?? '');
    const conclusion = check.conclusion == null ? '' : String(check.conclusion);
    if (typeof check.name !== 'string' || !check.name
      || typeof check.head_sha !== 'string' || !/^[a-f0-9]{40}$/i.test(check.head_sha)
      || (!pendingStatuses.has(status) && status !== 'completed')
      || (pendingStatuses.has(status) && conclusion)
      || (status === 'completed' && !terminalConclusions.has(conclusion))) {
      throw new TypeError(`GitHub check run[${index}] has invalid identity or state`);
    }
    return check;
  });
}

function expectedAppMatrixChecks(items: readonly GitHubCheckRun[]): GitHubCheckRun[] {
  return items.filter((check) => check.name === STEWARD_MATRIX_CHECK_NAME
    && check.app?.id === STEWARD_APP_ID
    && String(check.app?.slug ?? '').toLowerCase() === STEWARD_APP_SLUG);
}

function invalidExpectedAppMatrixChecks(items: readonly GitHubCheckRun[]): GitHubCheckRun[] {
  return expectedAppMatrixChecks(items).filter((check) => (
    typeof check.id !== 'number' || !Number.isSafeInteger(check.id) || check.id <= 0
  ));
}

function trustedAppMatrixChecks(items: readonly GitHubCheckRun[]): GitHubCheckRun[] {
  return expectedAppMatrixChecks(items)
    .filter((check) => typeof check.id === 'number' && Number.isSafeInteger(check.id) && check.id > 0)
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
}

function activeMatrixGeneration(check: GitHubCheckRun): boolean {
  return ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(String(check.status ?? ''));
}

function matrixGateContentIdentity(check: GitHubCheckRun | undefined): string {
  if (!check) return '';
  return JSON.stringify({
    id: check.id,
    headSha: check.head_sha,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion ?? null,
    externalId: check.external_id ?? null,
    detailsUrl: check.details_url ?? null,
    htmlUrl: check.html_url ?? null,
    startedAt: check.started_at ?? null,
    completedAt: check.completed_at ?? null,
    app: check.app ? { id: check.app.id ?? null, slug: check.app.slug ?? null } : null,
    output: check.output ? {
      title: check.output.title ?? null,
      summary: check.output.summary ?? null,
      text: check.output.text ?? null,
    } : null,
  });
}

function asMatrixChecks(items: readonly GitHubCheckRun[]): MatrixCheckRun[] {
  return items.map((check) => ({
    id: check.id,
    name: check.name,
    head_sha: check.head_sha,
    status: check.status,
    ...(check.conclusion == null ? {} : { conclusion: check.conclusion }),
    ...(check.external_id == null ? {} : { external_id: check.external_id }),
    ...(check.details_url == null ? {} : { details_url: check.details_url }),
    ...(check.html_url == null ? {} : { html_url: check.html_url }),
    ...(check.started_at == null ? {} : { started_at: check.started_at }),
    ...(check.app == null ? {} : { app: check.app }),
  }));
}

async function evaluateCurrentHeadCheck(
  transport: GitHubTransport,
  options: DoctorOptions,
  repositoryId: number,
  defaultBranch: string,
  loaded: LoadedManifest,
  path: string,
  observedAt: string,
  findings: DoctorFinding[],
): Promise<void> {
  const pulls = options.pullRequest
    ? await diagnosticRequest(
      transport,
      { path: `${path}/pulls/${segment(options.pullRequest)}` },
      observedAt,
      parsePull,
    )
    : await diagnosticPages(
      transport,
      { path: `${path}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc' } },
      observedAt,
      pullItems,
    );
  if (pulls.status === 'not-configured') {
    findings.push(finding('checks.current-head', 'drift', '指定 PR 不存在。', { remedy: '传入可读且开放的 PR 编号。' }));
    return;
  }
  if (pulls.status === 'unknown') {
    findings.push(unknownFinding('checks.current-head', '开放 PR/current-head', pulls, '使用具备 Pull requests read 的身份重试。'));
    return;
  }
  const candidates = (Array.isArray(pulls.value) ? pulls.value : [pulls.value])
    .filter((pull) => options.pullRequest !== undefined || pull.base?.ref === defaultBranch);
  const checkedGenerations = new Map<number, {
    readonly headSha: string;
    readonly gateContentIdentity: string;
    readonly activeGenerationSetIdentity: string;
    readonly pullFingerprintDigest: string;
    readonly liveEvidenceDigest: string;
  }>();
  if (candidates.length === 0) {
    findings.push(finding('checks.current-head', 'not-applicable', '当前没有以默认分支为 base 的开放 PR；未执行 current-head App Check 验证。'));
    if (options.pullRequest !== undefined) return;
  }
  for (const pull of candidates) {
    const number = Number(pull.number ?? 0);
    const headSha = String(pull.head?.sha ?? '').toLowerCase();
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(headSha)
      || pull.state !== 'open' || pull.base?.ref !== defaultBranch) {
      findings.push(finding('checks.current-head', 'drift', 'PR 不是开放的默认分支 PR，或缺少可信 current head。', {
        remedy: '指定开放且以默认分支为 base 的 PR。',
        source: pulls.evidence.source,
        endpoint: pulls.evidence.endpoint,
      }));
      continue;
    }
    const associatedPulls = await diagnosticPages(
      transport,
      { path: `${path}/commits/${segment(headSha)}/pulls` },
      observedAt,
      associatedPullItems,
    );
    if (associatedPulls.status === 'unknown') {
      findings.push(unknownFinding(
        'checks.head-exclusivity',
        `PR #${number} current head 的开放 PR 关联`,
        associatedPulls,
        '恢复 commit-associated Pull requests 的分页读取后重跑 doctor。',
      ));
      continue;
    }
    if (associatedPulls.status === 'not-configured') {
      findings.push(finding('checks.head-exclusivity', 'unknown', `PR #${number} current head 的开放 PR 关联不可用。`, {
        remedy: '恢复 commit-associated Pull requests 的分页读取后重跑 doctor。',
        source: associatedPulls.evidence.source,
        endpoint: associatedPulls.evidence.endpoint,
      }));
      continue;
    }
    const exactHeadPullNumbers = exactOpenPullNumbersForHead(associatedPulls.value, headSha);
    if (!exactHeadPullNumbers.includes(number)) {
      findings.push(finding('checks.head-exclusivity', 'unknown', `PR #${number} 未出现在 current head 的开放 PR 关联中。`, {
        remedy: '等待 PR/commit 关联稳定后重跑 doctor；不得仅依据 --pr 指定值判定当前 head。',
        source: associatedPulls.evidence.source,
        endpoint: associatedPulls.evidence.endpoint,
        ...evidenceFields(associatedPulls.evidence),
      }));
      continue;
    }
    if (exactHeadPullNumbers.length !== 1) {
      findings.push(finding('checks.head-exclusivity', 'drift', `PR #${number} 的 current head 同时对应多个开放 PR：${exactHeadPullNumbers.map((item) => `#${item}`).join('、')}。`, {
        remedy: '保证同一 head SHA 只对应一个开放 PR，再重新生成 Matrix Gate。',
        source: associatedPulls.evidence.source,
        endpoint: associatedPulls.evidence.endpoint,
        ...evidenceFields(associatedPulls.evidence),
      }));
      continue;
    }
    const checks = await diagnosticPages(
      transport,
      { path: `${path}/commits/${segment(headSha)}/check-runs`, query: { filter: 'all' } },
      observedAt,
      checkItems,
    );
    const refreshedPull = await diagnosticRequest(
      transport,
      { path: `${path}/pulls/${segment(number)}` },
      observedAt,
      parsePull,
    );
    if (refreshedPull.status === 'unknown') {
      findings.push(unknownFinding(
        'checks.current-head',
        `PR #${number} 的稳定 current-head 复核`,
        refreshedPull,
        'PR 可能在诊断期间发生变化；重新读取 PR 后重跑 doctor。',
      ));
      continue;
    }
    if (refreshedPull.status === 'not-configured') {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 在稳定性复核时已不可见或不存在。`, {
        remedy: '等待 PR 状态稳定后重跑 doctor。',
        source: refreshedPull.evidence.source,
        endpoint: refreshedPull.evidence.endpoint,
      }));
      continue;
    }
    const refreshedHeadSha = String(refreshedPull.value.head?.sha ?? '').toLowerCase();
    if (refreshedPull.value.number !== number
      || refreshedPull.value.state !== pull.state
      || refreshedPull.value.base?.ref !== pull.base?.ref
      || refreshedHeadSha !== headSha) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 在 Check 读取期间发生 state/base/head 变化，不能把旧快照判为 current。`, {
        remedy: '等待 PR 状态稳定后重跑 doctor。',
        source: refreshedPull.evidence.source,
        endpoint: refreshedPull.evidence.endpoint,
      }));
      continue;
    }
    const [commits, files, workflowRuns] = await Promise.all([
      diagnosticPages(
        transport,
        { path: `${path}/pulls/${segment(number)}/commits` },
        observedAt,
        commitItems,
      ),
      diagnosticPages(
        transport,
        { path: `${path}/pulls/${segment(number)}/files` },
        observedAt,
        fileItems,
      ),
      diagnosticPages(
        transport,
        { path: `${path}/actions/runs` },
        observedAt,
        workflowRunItems,
      ),
    ]);
    const unavailableFacts = [
      ['commits', commits],
      ['files', files],
      ['workflow-runs', workflowRuns],
    ] as const;
    const unavailable = unavailableFacts.find(([, result]) => result.status !== 'known');
    if (unavailable) {
      const [subject, result] = unavailable;
      if (result.status === 'unknown') {
        findings.push(unknownFinding(
          'checks.current-head',
          `PR #${number} Matrix live ${subject}`,
          result,
          '恢复完整分页的 live Matrix 输入读取后重跑 doctor。',
        ));
      } else {
        findings.push(finding('checks.current-head', 'unknown', `PR #${number} Matrix live ${subject} 当前不可读取。`, {
          remedy: '恢复 live Matrix 输入读取后重跑 doctor。',
        }));
      }
      continue;
    }
    if (commits.status !== 'known' || files.status !== 'known' || workflowRuns.status !== 'known') continue;
    const postFactsPull = await diagnosticRequest(
      transport,
      { path: `${path}/pulls/${segment(number)}` },
      observedAt,
      parsePull,
    );
    if (postFactsPull.status !== 'known') {
      findings.push(postFactsPull.status === 'unknown'
        ? unknownFinding(
          'checks.current-head',
          `PR #${number} Matrix 输入后的 PR 复核`,
          postFactsPull,
          'PR live inputs 可能在读取期间变化；等待稳定后重跑 doctor。',
        )
        : finding('checks.current-head', 'unknown', `PR #${number} 在 Matrix 输入复核时已不可见。`));
      continue;
    }
    if (!completeFingerprintPull(refreshedPull.value) || !completeFingerprintPull(postFactsPull.value)) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 缺少计算 Matrix live inputDigest 所需的 title/body/author/base/head 完整字段。`, {
        remedy: '拒绝不完整 PR payload，并使用具备 Pull requests read 的身份重新读取。',
      }));
      continue;
    }
    if (postFactsPull.value.number !== number
      || postFactsPull.value.state !== refreshedPull.value.state
      || postFactsPull.value.base?.ref !== refreshedPull.value.base?.ref
      || String(postFactsPull.value.head?.sha ?? '').toLowerCase() !== headSha) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} identity/state 在 Matrix live inputs 读取期间发生变化。`, {
        remedy: '等待 PR 稳定后重跑 doctor。',
      }));
      continue;
    }
    const [refreshedFingerprint, postFactsFingerprint] = await Promise.all([
      fingerprintForPull({
        pull: refreshedPull.value,
        commits: commits.value,
        files: files.value,
        botLogins: [loaded.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
      }),
      fingerprintForPull({
        pull: postFactsPull.value,
        commits: commits.value,
        files: files.value,
        botLogins: [loaded.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
      }),
    ]);
    if (refreshedFingerprint.value !== postFactsFingerprint.value) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的 Matrix live inputs 在 commits/files 分页期间发生变化。`, {
        remedy: '等待 PR title/body/base/head 稳定后重跑 doctor。',
      }));
      continue;
    }
    if (checks.status === 'not-configured') {
      findings.push(finding('checks.current-head', 'drift', `PR #${number} current head 缺少 Check 证据。`, {
        remedy: '由 private Control 在 current head 创建 App Check。',
      }));
      continue;
    }
    if (checks.status === 'unknown') {
      findings.push(unknownFinding('checks.current-head', `PR #${number} current-head Check runs`, checks, '使用具备 Checks read 的身份重试。'));
      continue;
    }
    const checkPath = `${path}/commits/${segment(headSha)}/check-runs`;
    const refreshedChecks = await diagnosticPages(
      transport,
      { path: checkPath, query: { filter: 'all' } },
      observedAt,
      checkItems,
    );
    if (refreshedChecks.status === 'not-configured') {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的 Check 列表在稳定性复核时消失。`, {
        remedy: '等待 Check generation 稳定后重跑 doctor。',
      }));
      continue;
    }
    if (refreshedChecks.status === 'unknown') {
      findings.push(unknownFinding(
        'checks.current-head',
        `PR #${number} 的稳定 Matrix generation 复核`,
        refreshedChecks,
        '恢复 Checks read 后重跑 doctor；不得使用未复核的旧 generation。',
      ));
      continue;
    }
    const finalPull = await diagnosticRequest(
      transport,
      { path: `${path}/pulls/${segment(number)}` },
      observedAt,
      parsePull,
    );
    if (finalPull.status === 'unknown') {
      findings.push(unknownFinding(
        'checks.current-head',
        `PR #${number} 的最终 current-head 复核`,
        finalPull,
        '第二次 Check 列表之后无法复核 PR；不得把旧 head 证据判为 current。',
      ));
      continue;
    }
    if (finalPull.status === 'not-configured') {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 在最终 current-head 复核时已不可见或不存在。`, {
        remedy: '等待 PR 状态稳定后重跑 doctor。',
        source: finalPull.evidence.source,
        endpoint: finalPull.evidence.endpoint,
        ...evidenceFields(finalPull.evidence),
      }));
      continue;
    }
    const finalHeadSha = String(finalPull.value.head?.sha ?? '').toLowerCase();
    if (finalPull.value.number !== number
      || finalPull.value.state !== pull.state
      || finalPull.value.base?.ref !== pull.base?.ref
      || finalHeadSha !== headSha) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 在最终 Check 稳定性窗口内发生 state/base/head 变化。`, {
        remedy: '等待 PR 状态稳定后重跑 doctor；不得使用旧 head Check。',
        source: finalPull.evidence.source,
        endpoint: finalPull.evidence.endpoint,
        ...evidenceFields(finalPull.evidence),
      }));
      continue;
    }
    if (!completeFingerprintPull(finalPull.value)) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的最终 Matrix live-input 复核缺少完整字段。`, {
        remedy: '拒绝不完整 PR payload 并重新读取。',
      }));
      continue;
    }
    const finalFingerprint = await fingerprintForPull({
      pull: finalPull.value,
      commits: commits.value,
      files: files.value,
      botLogins: [loaded.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
    });
    if (finalFingerprint.value !== refreshedFingerprint.value) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的 title/body/base/head 在 Matrix Check 稳定性窗口内发生变化。`, {
        remedy: '等待 PR live inputs 稳定后重跑 doctor。',
      }));
      continue;
    }
    const [barrierChecks, barrierWorkflowRuns, barrierAssociatedPulls] = await Promise.all([
      diagnosticPages(
        transport,
        { path: `${path}/commits/${segment(headSha)}/check-runs`, query: { filter: 'all' } },
        observedAt,
        checkItems,
      ),
      diagnosticPages(
        transport,
        { path: `${path}/actions/runs` },
        observedAt,
        workflowRunItems,
      ),
      diagnosticPages(
        transport,
        { path: `${path}/commits/${segment(headSha)}/pulls` },
        observedAt,
        associatedPullItems,
      ),
    ]);
    if (barrierAssociatedPulls.status !== 'known') {
      findings.push(barrierAssociatedPulls.status === 'unknown'
        ? unknownFinding(
          'checks.head-exclusivity',
          `PR #${number} current head 的终局开放 PR 关联`,
          barrierAssociatedPulls,
          '恢复 commit-associated Pull requests 的完整分页读取后重跑 doctor。',
        )
        : finding('checks.head-exclusivity', 'unknown', `PR #${number} current head 的终局开放 PR 关联不可用。`));
      continue;
    }
    const barrierExactHeadPullNumbers = exactOpenPullNumbersForHead(barrierAssociatedPulls.value, headSha);
    if (!barrierExactHeadPullNumbers.includes(number)) {
      findings.push(finding('checks.head-exclusivity', 'unknown', `PR #${number} 在终局屏障中不再属于 current head 的开放 PR 关联。`, {
        remedy: '等待 PR/commit 关联稳定后重跑 doctor。',
        source: barrierAssociatedPulls.evidence.source,
        endpoint: barrierAssociatedPulls.evidence.endpoint,
        ...evidenceFields(barrierAssociatedPulls.evidence),
      }));
      continue;
    }
    if (barrierExactHeadPullNumbers.length !== 1) {
      findings.push(finding('checks.head-exclusivity', 'drift', `PR #${number} 的 current head 在终局屏障中同时对应多个开放 PR：${barrierExactHeadPullNumbers.map((item) => `#${item}`).join('、')}。`, {
        remedy: '保证同一 head SHA 只对应一个开放 PR，再重新生成 Matrix Gate。',
        source: barrierAssociatedPulls.evidence.source,
        endpoint: barrierAssociatedPulls.evidence.endpoint,
        ...evidenceFields(barrierAssociatedPulls.evidence),
      }));
      continue;
    }
    findings.push(finding('checks.head-exclusivity', 'conformant', `PR #${number} 在终局屏障中仍是 current head 唯一对应的开放 PR。`, {
      source: barrierAssociatedPulls.evidence.source,
      endpoint: barrierAssociatedPulls.evidence.endpoint,
      ...evidenceFields(barrierAssociatedPulls.evidence),
    }));
    if (barrierChecks.status !== 'known' || barrierWorkflowRuns.status !== 'known') {
      const missing = barrierChecks.status !== 'known' ? barrierChecks : barrierWorkflowRuns;
      findings.push(missing.status === 'unknown'
        ? unknownFinding(
          'checks.current-head',
          `PR #${number} Matrix 终局证据屏障`,
          missing,
          '恢复 Checks/workflow runs 完整分页后重跑 doctor。',
        )
        : finding('checks.current-head', 'unknown', `PR #${number} Matrix 终局证据屏障不可读。`));
      continue;
    }
    const sameName = barrierChecks.value.filter((check) => check.name === STEWARD_MATRIX_CHECK_NAME);
    const foreign = sameName.filter((check) => (
      check.app?.id !== STEWARD_APP_ID
      || String(check.app?.slug ?? '').toLowerCase() !== STEWARD_APP_SLUG
    ));
    if (foreign.length) {
      findings.push(finding('checks.current-head.foreign-collision', 'not-applicable', `PR #${number} 观察到 ${foreign.length} 个外部 App 的同名 Matrix Check；已按 App ID/slug 隔离并忽略。`, {
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
    }
    const invalidTrustedIds = [
      ...invalidExpectedAppMatrixChecks(checks.value),
      ...invalidExpectedAppMatrixChecks(refreshedChecks.value),
      ...invalidExpectedAppMatrixChecks(barrierChecks.value),
    ];
    if (invalidTrustedIds.length) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 观察到 ${invalidTrustedIds.length} 条缺少正安全整数 ID 的 Steward Matrix Check，无法确定最新 generation。`, {
        remedy: '拒绝 malformed Check payload 并重新读取；不得把缺失、字符串、NaN 或非正数 ID 当作稳定 generation。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
      continue;
    }
    const initialTrustedGates = trustedAppMatrixChecks(checks.value);
    const refreshedTrustedGates = trustedAppMatrixChecks(refreshedChecks.value);
    const trustedGates = trustedAppMatrixChecks(barrierChecks.value);
    const initialGate = initialTrustedGates[0];
    const refreshedGate = refreshedTrustedGates[0];
    const gate = trustedGates[0];
    if (Number(initialGate?.id ?? 0) !== Number(refreshedGate?.id ?? 0)
      || Number(refreshedGate?.id ?? 0) !== Number(gate?.id ?? 0)
      || matrixGateContentIdentity(initialGate) !== matrixGateContentIdentity(refreshedGate)
      || matrixGateContentIdentity(refreshedGate) !== matrixGateContentIdentity(gate)) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的最新可信 Matrix generation 或 Gate 内容在诊断期间发生变化。`, {
        remedy: '等待 App Check generation 与 Gate 内容稳定后重跑 doctor；不得按相同 Check ID 猜测内容未变。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
      continue;
    }
    if (!gate) {
      findings.push(finding('checks.current-head', 'drift', `PR #${number} current head 缺少 ${STEWARD_MATRIX_CHECK_NAME}。`, {
        remedy: '由 private Control 运行完整 Matrix；不要用 Actions job 或同名 status 冒充。',
        source: refreshedChecks.evidence.source,
        endpoint: refreshedChecks.evidence.endpoint,
        ...evidenceFields(refreshedChecks.evidence),
      }));
      continue;
    }
    const supersededActive = trustedGates.slice(1).filter(activeMatrixGeneration);
    if (supersededActive.length) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 存在 ${supersededActive.length} 个非最新但仍 active 的 Steward Matrix generation。`, {
        remedy: '不得用更新的 success 忽略旧 pending generation；由唯一 head writer/DO 收敛并清理后重跑 doctor。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
      continue;
    }
    const matrixPull = {
      number,
      state: 'open',
      base: {
        ref: String(finalPull.value.base?.ref ?? ''),
        sha: String(finalPull.value.base?.sha ?? '').toLowerCase(),
      },
      head: {
        ref: String(finalPull.value.head?.ref ?? ''),
        sha: headSha,
      },
    };
    const evaluateLiveMatrix = (
      checkRuns: readonly GitHubCheckRun[],
      liveWorkflowRuns: readonly MatrixWorkflowRun[],
    ) => evaluateMatrix({
      config: enabledStewardMatrixConfiguration(loaded.manifest.features),
      checkRuns: asMatrixChecks(checkRuns),
      scope: 'full',
      pull: matrixPull,
      trust: {
        appId: STEWARD_APP_ID,
        appSlug: STEWARD_APP_SLUG,
        repositoryId,
        configDigest: loaded.configDigest,
        inputDigest: finalFingerprint.value,
        workflowRuns: liveWorkflowRuns,
        allowLegacy: true,
      },
    });
    const [initialMatrixEvaluation, refreshedMatrixEvaluation, matrixEvaluation] = [
      evaluateLiveMatrix(checks.value, workflowRuns.value),
      evaluateLiveMatrix(refreshedChecks.value, workflowRuns.value),
      evaluateLiveMatrix(barrierChecks.value, barrierWorkflowRuns.value),
    ];
    const invalidTargets = [...new Set([
      ...initialMatrixEvaluation.targets,
      ...refreshedMatrixEvaluation.targets,
      ...matrixEvaluation.targets,
    ].filter((target) => target.state === 'invalid').map((target) => target.id))];
    if (invalidTargets.length) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的可信 Matrix child Check 含非法或重复 generation 证据：${invalidTargets.join('、')}。`, {
        remedy: '拒绝畸形Check ID、重复ID或矛盾status/conclusion；恢复稳定的完整Check快照后重跑doctor，不得回退旧success。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
      continue;
    }
    const [initialLiveEvidence, refreshedLiveEvidence, liveEvidence] = await Promise.all([
      matrixLiveEvidenceDigest({
        repositoryId,
        pull: matrixPull,
        configDigest: loaded.configDigest,
        pullFingerprintDigest: finalFingerprint.value,
        targets: initialMatrixEvaluation.targets,
      }),
      matrixLiveEvidenceDigest({
        repositoryId,
        pull: matrixPull,
        configDigest: loaded.configDigest,
        pullFingerprintDigest: finalFingerprint.value,
        targets: refreshedMatrixEvaluation.targets,
      }),
      matrixLiveEvidenceDigest({
        repositoryId,
        pull: matrixPull,
        configDigest: loaded.configDigest,
        pullFingerprintDigest: finalFingerprint.value,
        targets: matrixEvaluation.targets,
      }),
    ]);
    if (initialLiveEvidence.value !== refreshedLiveEvidence.value
      || refreshedLiveEvidence.value !== liveEvidence.value) {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 的 Matrix child projection 在诊断期间发生变化。`, {
        remedy: '等待完整 child Check/workflow evidence 稳定后重跑 doctor；不得按相同子 Check ID 猜测内容未变。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
      continue;
    }
    checkedGenerations.set(number, {
      headSha,
      gateContentIdentity: matrixGateContentIdentity(gate),
      activeGenerationSetIdentity: JSON.stringify(
        trustedGates.filter(activeMatrixGeneration).map(matrixGateContentIdentity).sort(),
      ),
      pullFingerprintDigest: finalFingerprint.value,
      liveEvidenceDigest: liveEvidence.value,
    });
    const expectedConclusion = matrixConclusion(matrixEvaluation);
    const identity = parseStewardCheckExternalId(gate.external_id);
    const trustedIdentity = gate.app?.id === STEWARD_APP_ID
      && String(gate.app?.slug ?? '').toLowerCase() === STEWARD_APP_SLUG
      && String(gate.head_sha ?? '').toLowerCase() === headSha
      && identity?.repositoryId === repositoryId
      && identity.prNumber === number
      && identity.headSha === headSha
      && identity.checkId === 'validation-matrix'
      && identity.configDigest === loaded.configDigest
      && identity.inputDigest === liveEvidence.value;
    const conclusionMatchesLiveEvidence = gate.status === expectedConclusion.status
      && (expectedConclusion.conclusion
        ? gate.conclusion === expectedConclusion.conclusion
        : gate.conclusion == null);
    if (!trustedIdentity) {
      findings.push(finding('checks.current-head', 'drift', `PR #${number} 最新同名 Matrix Check 不是可信 current-head 证据。`, {
        remedy: '拒绝旧 generation、错误 App/config 或未绑定 fresh child-Check 投影的 inputDigest，并由 private Control 重新收敛当前 head。',
        source: refreshedChecks.evidence.source,
        endpoint: refreshedChecks.evidence.endpoint,
        ...evidenceFields(refreshedChecks.evidence),
      }));
    } else if (!conclusionMatchesLiveEvidence) {
      findings.push(finding('checks.current-head', 'drift', `PR #${number} Matrix Gate 的 status/conclusion 与当前完整目标投影不一致。`, {
        remedy: '只允许 full-scope Matrix writer 按 fresh 子 Check 证据更新终局 Gate；gate-only 事件不得覆盖。',
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
    } else if (gate.status !== 'completed') {
      findings.push(finding('checks.current-head', 'unknown', `PR #${number} 最新可信 Matrix generation 尚未完成（${gate.status}）。`, {
        remedy: '等待该 generation 完成；不得回退采用旧 generation。',
        source: refreshedChecks.evidence.source,
        endpoint: refreshedChecks.evidence.endpoint,
        ...evidenceFields(refreshedChecks.evidence),
      }));
    } else if (gate.conclusion !== 'success') {
      findings.push(finding('checks.current-head', 'drift', `PR #${number} 最新可信 Matrix generation 已完成但结论为 ${gate.conclusion}。`, {
        remedy: '修复当前 head 的验证失败并由 private Control 生成新的可信 Matrix generation。',
        source: refreshedChecks.evidence.source,
        endpoint: refreshedChecks.evidence.endpoint,
        ...evidenceFields(refreshedChecks.evidence),
      }));
    } else {
      findings.push(finding('checks.current-head', 'conformant', `PR #${number} Matrix Check 已绑定 App/current-head/config、fresh PR fingerprint 与完整 child-Check 投影，结论为 success。`, {
        source: barrierChecks.evidence.source,
        endpoint: barrierChecks.evidence.endpoint,
        ...evidenceFields(barrierChecks.evidence),
      }));
    }
  }
  if (options.pullRequest === undefined) {
    const finalPulls = await diagnosticPages(
      transport,
      { path: `${path}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc' } },
      observedAt,
      pullItems,
    );
    if (finalPulls.status === 'unknown') {
      findings.push(unknownFinding(
        'checks.open-pr-inventory',
        '最终开放 PR 集合',
        finalPulls,
        '分页诊断期间的 PR 集合可能已变化；恢复读取并完整重跑 doctor。',
      ));
    } else if (finalPulls.status === 'not-configured') {
      findings.push(finding('checks.open-pr-inventory', 'unknown', '最终开放 PR 集合已不可读，无法证明分页快照稳定。'));
    } else {
      const identitySet = (items: readonly PullPayload[]) => items
        .filter((pull) => pull.state === 'open' && pull.base?.ref === defaultBranch)
        .map((pull) => `${Number(pull.number ?? 0)}:${String(pull.head?.sha ?? '').toLowerCase()}`)
        .sort();
      const initial = identitySet(Array.isArray(pulls.value) ? pulls.value : [pulls.value]);
      const final = identitySet(finalPulls.value);
      const stable = initial.length === final.length
        && initial.every((identity, index) => identity === final[index]);
      findings.push(stable
        ? finding('checks.open-pr-inventory', 'conformant', `开放默认分支 PR 集合在诊断窗口内保持稳定（${final.length} 个）。`, {
          source: finalPulls.evidence.source,
          endpoint: finalPulls.evidence.endpoint,
          ...evidenceFields(finalPulls.evidence),
        })
        : finding('checks.open-pr-inventory', 'unknown', '开放默认分支 PR 集合在诊断窗口内发生变化，可能存在未检查或已失效的 head。', {
          remedy: '等待 PR 集合稳定后重跑 doctor。',
          source: finalPulls.evidence.source,
          endpoint: finalPulls.evidence.endpoint,
          ...evidenceFields(finalPulls.evidence),
        }));
      if (stable) {
        let generationsStable = true;
        let generationFailure = '';
        for (const pull of finalPulls.value.filter((item) => item.state === 'open' && item.base?.ref === defaultBranch)) {
          const number = Number(pull.number ?? 0);
          const headSha = String(pull.head?.sha ?? '').toLowerCase();
          const expected = checkedGenerations.get(number);
          if (!expected) {
            generationsStable = false;
            generationFailure = `PR #${number} 未形成可用于终局屏障的 Matrix 基线`;
            break;
          }
          const [barrierPull, barrierChecks, barrierCommits, barrierFiles, barrierWorkflowRuns] = await Promise.all([
            diagnosticRequest(
              transport,
              { path: `${path}/pulls/${segment(number)}` },
              observedAt,
              parsePull,
            ),
            diagnosticPages(
              transport,
              { path: `${path}/commits/${segment(headSha)}/check-runs`, query: { filter: 'all' } },
              observedAt,
              checkItems,
            ),
            diagnosticPages(
              transport,
              { path: `${path}/pulls/${segment(number)}/commits` },
              observedAt,
              commitItems,
            ),
            diagnosticPages(
              transport,
              { path: `${path}/pulls/${segment(number)}/files` },
              observedAt,
              fileItems,
            ),
            diagnosticPages(
              transport,
              { path: `${path}/actions/runs` },
              observedAt,
              workflowRunItems,
            ),
          ]);
          if (barrierPull.status !== 'known'
            || barrierChecks.status !== 'known'
            || barrierCommits.status !== 'known'
            || barrierFiles.status !== 'known'
            || barrierWorkflowRuns.status !== 'known') {
            generationsStable = false;
            generationFailure = `PR #${number} 的终局 Matrix live evidence 不可证明`;
            break;
          }
          if (invalidExpectedAppMatrixChecks(barrierChecks.value).length) {
            generationsStable = false;
            generationFailure = `PR #${number} 的终局 Check 列表含非法 Steward Check ID`;
            break;
          }
          if (!completeFingerprintPull(barrierPull.value)
            || barrierPull.value.number !== number
            || barrierPull.value.state !== 'open'
            || barrierPull.value.base?.ref !== defaultBranch
            || String(barrierPull.value.head?.sha ?? '').toLowerCase() !== headSha) {
            generationsStable = false;
            generationFailure = `PR #${number} 的终局 PR fingerprint inputs 不完整或已变化`;
            break;
          }
          const barrierFingerprint = await fingerprintForPull({
            pull: barrierPull.value,
            commits: barrierCommits.value,
            files: barrierFiles.value,
            botLogins: [loaded.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
          });
          const barrierMatrixPull = {
            number,
            state: 'open',
            base: {
              ref: String(barrierPull.value.base?.ref ?? ''),
              sha: String(barrierPull.value.base?.sha ?? '').toLowerCase(),
            },
            head: {
              ref: String(barrierPull.value.head?.ref ?? ''),
              sha: headSha,
            },
          };
          const barrierMatrixEvaluation = evaluateMatrix({
            config: enabledStewardMatrixConfiguration(loaded.manifest.features),
            checkRuns: asMatrixChecks(barrierChecks.value),
            scope: 'full',
            pull: barrierMatrixPull,
            trust: {
              appId: STEWARD_APP_ID,
              appSlug: STEWARD_APP_SLUG,
              repositoryId,
              configDigest: loaded.configDigest,
              inputDigest: barrierFingerprint.value,
              workflowRuns: barrierWorkflowRuns.value,
              allowLegacy: true,
            },
          });
          const barrierLiveEvidence = await matrixLiveEvidenceDigest({
            repositoryId,
            pull: barrierMatrixPull,
            configDigest: loaded.configDigest,
            pullFingerprintDigest: barrierFingerprint.value,
            targets: barrierMatrixEvaluation.targets,
          });
          const barrierGate = trustedAppMatrixChecks(barrierChecks.value)[0];
          const barrierActiveGenerationSetIdentity = JSON.stringify(
            trustedAppMatrixChecks(barrierChecks.value)
              .filter(activeMatrixGeneration)
              .map(matrixGateContentIdentity)
              .sort(),
          );
          if (expected.headSha !== headSha
            || expected.gateContentIdentity !== matrixGateContentIdentity(barrierGate)
            || expected.activeGenerationSetIdentity !== barrierActiveGenerationSetIdentity
            || expected.pullFingerprintDigest !== barrierFingerprint.value
            || expected.liveEvidenceDigest !== barrierLiveEvidence.value) {
            generationsStable = false;
            generationFailure = `PR #${number} 的最新 Matrix generation 已变化：Gate 内容、active generation set、PR fingerprint 或 child projection 不再相同`;
            break;
          }
        }
        const barrierPulls = await diagnosticPages(
          transport,
          { path: `${path}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc' } },
          observedAt,
          pullItems,
        );
        const barrierInventory = barrierPulls.status === 'known' ? identitySet(barrierPulls.value) : null;
        const inventoryStillStable = barrierInventory !== null
          && final.length === barrierInventory.length
          && final.every((identity, index) => identity === barrierInventory[index]);
        findings.push(generationsStable && inventoryStillStable
          ? finding('checks.open-pr-generations', 'conformant', '全部开放默认分支 PR 的 head、Gate 内容、active generation set、PR fingerprint 与 Matrix child projection 在终局屏障内保持稳定。', {
            source: barrierPulls.evidence.source,
            endpoint: barrierPulls.evidence.endpoint,
            ...evidenceFields(barrierPulls.evidence),
          })
          : finding('checks.open-pr-generations', 'unknown', generationFailure || '开放 PR inventory 在终局 Matrix 复核期间发生变化或不可读。', {
            remedy: '等待全部开放 PR、Gate 内容、active generation set 与 live child projection 稳定后重跑 doctor；不得仅凭 Check ID 采用较早快照。',
            ...(barrierPulls.status === 'known' ? {
              source: barrierPulls.evidence.source,
              endpoint: barrierPulls.evidence.endpoint,
              ...evidenceFields(barrierPulls.evidence),
            } : {}),
          }));
      }
    }
  }
}

async function evaluateReleaseAdapter(
  transport: GitHubTransport,
  manifest: StewardManifest,
  path: string,
  manifestRef: string,
  observedAt: string,
  findings: DoctorFinding[],
): Promise<void> {
  if (!manifest.features.release || !manifest.release) return;
  const candidate = manifest.release.adapterCommand.find((argument) => /[\\/]/.test(argument));
  if (!candidate) {
    findings.push(finding('release.adapter', 'drift', 'Release adapter argv 未包含可核对的仓库相对路径。', {
      remedy: '为可选 Executor 配置明确的 repository-relative adapter 路径。',
    }));
    return;
  }
  const normalized = candidate.replaceAll('\\', '/');
  const adapterPath = `${path}/contents/${normalized.split('/').map(segment).join('/')}`;
  const adapter = await diagnosticRequest(
    transport,
    { path: adapterPath, query: { ref: manifestRef } },
    observedAt,
    (payload) => payload as RepositoryFilePayload,
  );
  if (adapter.status === 'unknown') {
    findings.push(unknownFinding('release.adapter', `Release adapter ${candidate}`, adapter, '使用具备 Contents read 的身份重试。'));
  } else if (adapter.status === 'not-configured' || adapter.value.type !== 'file') {
    findings.push(finding('release.adapter', 'drift', `Release adapter ${candidate} 不存在或不是普通文件。`, {
      remedy: '修复 adapterCommand 或提交 adapter；不要求 Steward release caller。',
    }));
  } else {
    findings.push(finding('release.adapter', 'conformant', `Release adapter ${candidate} 存在；执行合同由可信 Executor 验证。`, {
      source: adapter.evidence.source,
      endpoint: adapter.evidence.endpoint,
    }));
  }
}

export async function runDoctor(
  dependencies: DoctorDependencies,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const transport = dependencies.repositoryTransport;
  const path = repositoryPath(options.owner, options.repository);
  const findings: DoctorFinding[] = [];
  const clock = dependencies.observedAt ?? (() => new Date().toISOString());
  const observedAt = clock();
  const repositoryResult = await diagnosticRequest(transport, { path }, observedAt, parseRepository);
  if (repositoryResult.status === 'unknown') {
    findings.push(unknownFinding(
      'repository.metadata',
      '仓库元数据',
      repositoryResult,
      '使用可读取目标仓库 Metadata 的诊断身份重试。',
    ));
    return report(`${options.owner}/${options.repository}`, findings);
  }
  if (repositoryResult.status === 'not-configured') {
    findings.push(finding('repository.metadata', 'drift', '目标仓库不存在。'));
    return report(`${options.owner}/${options.repository}`, findings);
  }
  const repository = repositoryResult.value;
  const repositoryId = Number(repository.id ?? 0);
  const fullName = String(repository.full_name ?? '');
  const defaultBranch = String(repository.default_branch ?? '');
  const ownerLogin = String(repository.owner?.login ?? '');
  const ownerType = String(repository.owner?.type ?? '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !fullName || !defaultBranch
    || !ownerLogin || ownerLogin.toLowerCase() !== options.owner.toLowerCase()
    || fullName.toLowerCase() !== `${options.owner}/${options.repository}`.toLowerCase()) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  findings.push(finding('repository.default-branch', 'conformant', `默认分支为 ${defaultBranch}。`, {
    source: 'github-rest', endpoint: path,
  }));
  if (ownerType.toLowerCase() !== 'organization') {
    findings.push(finding('repository.organization', 'drift', `仓库 owner 类型为 ${ownerType || 'unknown'}，不是 Organization。`, {
      remedy: 'Steward 平台 consumer 必须位于已配置组织控制面的 Organization。',
      source: 'github-rest', endpoint: path,
    }));
  } else {
    findings.push(finding('repository.organization', 'conformant', `仓库属于 Organization ${ownerLogin}。`, {
      source: 'github-rest', endpoint: path,
    }));
  }

  const defaultBranchHeadPath = `${path}/commits/${segment(defaultBranch)}`;
  const defaultBranchHead = await diagnosticRequest(
    transport,
    { path: defaultBranchHeadPath },
    observedAt,
    parseCommit,
  );
  const defaultBranchHeadSha = defaultBranchHead.status === 'known' ? defaultBranchHead.value.sha : undefined;
  if (defaultBranchHead.status === 'unknown') {
    findings.push(unknownFinding(
      'repository.default-branch-head',
      '默认分支不可变提交',
      defaultBranchHead,
      '使用可读取 Commit metadata 的身份重试；不能仅凭可变分支名读取 Manifest。',
    ));
  } else if (defaultBranchHead.status === 'not-configured') {
    findings.push(finding('repository.default-branch-head', 'unknown', '默认分支当前无法解析为不可变提交。', {
      remedy: '等待默认分支创建或切换完成后重跑 doctor。',
      source: defaultBranchHead.evidence.source,
      endpoint: defaultBranchHead.evidence.endpoint,
    }));
  } else {
    findings.push(finding('repository.default-branch-head', 'conformant', `默认分支起始提交为 ${defaultBranchHead.value.sha.slice(0, 12)}…。`, {
      source: defaultBranchHead.evidence.source,
      endpoint: defaultBranchHead.evidence.endpoint,
    }));
  }

  let loaded: LoadedManifest | undefined;
  if (!defaultBranchHeadSha) {
    findings.push(finding('manifest.valid', 'unknown', '默认分支提交未确认，未读取 Manifest。', {
      remedy: '先绑定默认分支不可变 commit SHA，再从该 SHA 读取 Manifest。',
    }));
  } else {
    try {
      const repositoryClient = new GitHubRepositoryClient(transport);
      loaded = await loadDefaultBranchManifest({
        async getRepository(requestedOwner, requestedRepository) {
          if (requestedOwner.toLowerCase() !== options.owner.toLowerCase()
            || requestedRepository.toLowerCase() !== options.repository.toLowerCase()) {
            throw new Error('Manifest loader requested an unexpected repository');
          }
          return { defaultBranch: defaultBranchHeadSha };
        },
        async getFile(requestedOwner, requestedRepository, filePath, ref) {
          return await repositoryClient.getFile(requestedOwner, requestedRepository, filePath, ref);
        },
      }, options.owner, options.repository);
      findings.push(finding('manifest.valid', 'conformant', `默认分支提交 ${defaultBranchHeadSha.slice(0, 12)}… 的 Manifest schemaVersion=${loaded.manifest.schemaVersion}，config=${loaded.configDigest.slice(0, 12)}…。`));
    } catch (error) {
      const endpoint = `${path}/contents/.github/steward.json`;
      const proof = diagnosticsEvidence(transport, endpoint, observedAt);
      if (error instanceof GitHubApiError) {
        const failure = diagnosticsError(error, proof);
        findings.push(unknownFinding(
          'manifest.valid',
          '默认分支 Manifest',
          failure,
          '使用已证明具备 Contents read 的诊断身份重试；隐藏式 404 不等于文件缺失。',
        ));
      } else if (error instanceof GitHubTransportError) {
        findings.push(unknownFinding(
          'manifest.valid',
          '默认分支 Manifest',
          { status: 'unknown', reason: 'api-error', evidence: proof, retryable: error.retryable },
          '恢复 GitHub 传输后重试。',
        ));
      } else {
        findings.push(finding('manifest.valid', 'drift', `默认分支 Manifest 已读取但无法验证：${error instanceof Error ? error.message : String(error)}`, {
          remedy: '修复 .github/steward.json 并确保它符合当前 Steward Schema。',
          source: proof.source,
          endpoint: proof.endpoint,
        }));
      }
    }
  }
  if (loaded) {
    const pin = schemaPin(loaded.manifest);
    findings.push(pin
      ? finding('manifest.schema-pin', 'conformant', `Schema 固定到完整 Steward SHA ${pin.slice(0, 12)}…。`)
      : finding('manifest.schema-pin', 'drift', 'Manifest $schema 未固定到 splrad/steward 的完整 40 位 SHA。', {
        remedy: '使用固定提交的 raw.githubusercontent.com Schema URL。',
      }));
  }

  const organization = ownerLogin;
  const organizationReader = new GitHubOrganizationReadClient({
    repositoryTransport: transport,
    ...(dependencies.organizationTransport
      ? { organizationTransport: dependencies.organizationTransport }
      : {}),
    ...(dependencies.organizationRulesetTransport
      ? { organizationRulesetTransport: dependencies.organizationRulesetTransport }
      : {}),
    ...(dependencies.appJwtTransport ? { appJwtTransport: dependencies.appJwtTransport } : {}),
    ...(dependencies.appUserTransport ? { appUserTransport: dependencies.appUserTransport } : {}),
    ...(dependencies.actionsExecutionProtections
      ? { actionsExecutionProtections: dependencies.actionsExecutionProtections }
      : {}),
    observedAt: clock,
  });
  const organizationInput = {
    organization,
    owner: options.owner,
    repository: options.repository,
    repositoryId,
    defaultBranch,
    maintainerTeamSlug: STEWARD_MAINTAINER_TEAM_SLUG,
    appId: STEWARD_APP_ID,
    appSlug: STEWARD_APP_SLUG,
    organizationRulesetNames: [
      ...STEWARD_ORGANIZATION_RULESET_CONTRACTS.map((contract) => contract.name),
      ...STEWARD_LEGACY_MONOLITHIC_RULESET_NAMES,
    ],
    ...(loaded ? { appClientId: loaded.manifest.automation.githubApp.clientId } : {}),
  } as const;
  const [snapshot, runtime] = await Promise.all([
    organizationReader.inspect(organizationInput),
    runtimeResult(dependencies.runtimeDiagnostics, {
      repositoryId,
      owner: options.owner,
      repository: options.repository,
    }, observedAt),
  ]);

  const properties = evaluatePropertySchema(snapshot, findings);
  evaluateRules(snapshot, properties, organization, findings);
  evaluateTeam(snapshot, loaded?.manifest, properties, findings);
  evaluateApp(snapshot, loaded?.manifest, organization, findings);
  if (loaded) {
    await evaluateReleaseAdapter(
      transport,
      loaded.manifest,
      path,
      loaded.source.ref,
      observedAt,
      findings,
    );
  }
  if (loaded) {
    await evaluateCurrentHeadCheck(
      transport,
      options,
      repositoryId,
      defaultBranch,
      loaded,
      path,
      observedAt,
      findings,
    );
  } else {
    findings.push(finding('checks.current-head', 'unknown', 'Manifest config digest 未确认，无法验证 current-head Check external_id。', {
      remedy: '先恢复 Manifest 读取和验证。',
    }));
  }
  const refreshedRuntime = await runtimeResult(dependencies.runtimeDiagnostics, {
    repositoryId,
    owner: options.owner,
    repository: options.repository,
  }, clock());
  const initialRuntimeSignature = runtimeSnapshotSignature(runtime);
  const refreshedRuntimeSignature = runtimeSnapshotSignature(refreshedRuntime);
  const runtimeStable = initialRuntimeSignature !== null
    && refreshedRuntimeSignature !== null
    && initialRuntimeSignature === refreshedRuntimeSignature;
  findings.push(runtimeStable
    ? finding('runtime.snapshot-stability', 'conformant', '中央 runtime identity、revision、Queue、Control 与 DLQ 的起止快照一致。', {
      source: refreshedRuntime.source,
      observedAt: refreshedRuntime.observedAt,
    })
    : finding('runtime.snapshot-stability', 'unknown', '中央 runtime 事实无法完成双读一致性证明，或在诊断期间发生变化。', {
      remedy: '恢复经认证的 runtime diagnostics 并等待 revision/components 稳定后完整重跑 doctor。',
      source: refreshedRuntime.source,
      observedAt: refreshedRuntime.observedAt,
    }));
  const runtimeForEvaluation: RuntimeDiagnosticsResult = runtimeStable
    ? refreshedRuntime
    : {
      status: 'unknown',
      reason: 'snapshot-changed',
      source: refreshedRuntime.source,
      observedAt: refreshedRuntime.observedAt,
    };
  const stableRepository = await diagnosticRequest(transport, { path }, observedAt, parseRepository);
  if (stableRepository.status === 'unknown') {
    findings.push(unknownFinding(
      'repository.stability',
      '诊断结束时的仓库元数据',
      stableRepository,
      '仓库可能在诊断期间发生变化；恢复 Metadata 读取并重跑 doctor。',
    ));
  } else if (stableRepository.status === 'not-configured') {
    findings.push(finding('repository.stability', 'unknown', '诊断结束时仓库已不可见或不存在，本次跨端点快照不可作为一致证据。', {
      remedy: '确认仓库转移/重命名状态后重跑 doctor。',
      source: stableRepository.evidence.source,
      endpoint: stableRepository.evidence.endpoint,
    }));
  } else {
    const stable = stableRepository.value;
    const unchanged = Number(stable.id ?? 0) === repositoryId
      && String(stable.full_name ?? '').toLowerCase() === fullName.toLowerCase()
      && String(stable.default_branch ?? '') === defaultBranch
      && String(stable.owner?.login ?? '').toLowerCase() === ownerLogin.toLowerCase();
    findings.push(unchanged
      ? finding('repository.stability', 'conformant', '诊断开始与结束时的仓库 ID、名称、owner 和默认分支保持一致。', {
        source: stableRepository.evidence.source,
        endpoint: stableRepository.evidence.endpoint,
      })
      : finding('repository.stability', 'unknown', '仓库 ID、名称、owner 或默认分支在诊断期间发生变化，本次跨端点快照不可作为一致证据。', {
        remedy: '等待仓库转移/重命名/默认分支切换完成后重跑 doctor。',
        source: stableRepository.evidence.source,
        endpoint: stableRepository.evidence.endpoint,
      }));
  }
  const stableDefaultBranchHead = await diagnosticRequest(
    transport,
    { path: defaultBranchHeadPath },
    observedAt,
    parseCommit,
  );
  if (!defaultBranchHeadSha) {
    findings.push(finding('repository.default-branch-head-stability', 'unknown', '缺少起始默认分支 commit SHA，无法证明诊断窗口内 head 稳定。', {
      remedy: '恢复默认分支 commit 读取后完整重跑 doctor。',
    }));
  } else if (stableDefaultBranchHead.status === 'unknown') {
    findings.push(unknownFinding(
      'repository.default-branch-head-stability',
      '诊断结束时的默认分支提交',
      stableDefaultBranchHead,
      '恢复 Commit metadata 读取并重跑 doctor。',
    ));
  } else if (stableDefaultBranchHead.status === 'not-configured') {
    findings.push(finding('repository.default-branch-head-stability', 'unknown', '诊断结束时默认分支已不可解析。', {
      remedy: '等待默认分支状态稳定后重跑 doctor。',
      source: stableDefaultBranchHead.evidence.source,
      endpoint: stableDefaultBranchHead.evidence.endpoint,
    }));
  } else {
    findings.push(stableDefaultBranchHead.value.sha === defaultBranchHeadSha
      ? finding('repository.default-branch-head-stability', 'conformant', '诊断开始与结束时默认分支 commit SHA 保持一致。', {
        source: stableDefaultBranchHead.evidence.source,
        endpoint: stableDefaultBranchHead.evidence.endpoint,
      })
      : finding('repository.default-branch-head-stability', 'unknown', `默认分支在诊断期间从 ${defaultBranchHeadSha.slice(0, 12)}… 移动到 ${stableDefaultBranchHead.value.sha.slice(0, 12)}…。`, {
        remedy: '等待默认分支稳定后重跑 doctor；本次跨端点快照不得用于 ready 判定。',
        source: stableDefaultBranchHead.evidence.source,
        endpoint: stableDefaultBranchHead.evidence.endpoint,
      }));
  }
  const refreshedSnapshot = await organizationReader.inspect(organizationInput);
  const initialOrganizationProof = organizationSnapshotSignature(snapshot);
  const refreshedOrganizationProof = organizationSnapshotSignature(refreshedSnapshot);
  if (!initialOrganizationProof.signature || !refreshedOrganizationProof.signature) {
    const unavailable = [...new Set([
      ...initialOrganizationProof.unavailable,
      ...refreshedOrganizationProof.unavailable,
    ])].sort();
    findings.push(finding('organization.snapshot-stability', 'unknown', `关键组织事实无法完成双读一致性证明：${unavailable.join(', ') || 'unknown'}。`, {
      remedy: '恢复所有者诊断身份的只读事实后完整重跑 doctor；不得把多个时间点的局部事实拼成 ready。',
    }));
  } else {
    findings.push(initialOrganizationProof.signature === refreshedOrganizationProof.signature
      ? finding('organization.snapshot-stability', 'conformant', '属性、Ruleset、Team、App installation 与 Actions 关键事实的起止快照一致。')
      : finding('organization.snapshot-stability', 'unknown', '关键组织事实在诊断期间发生变化，本次跨端点快照不能作为一致性证明。', {
        remedy: '等待组织配置推广稳定后重跑 doctor。',
      }));
  }
  const evaluatedAt = clock();
  await evaluateActions(refreshedSnapshot, loaded?.manifest, properties, {
    organization,
    repositoryId,
    repositoryFullName: fullName,
  }, evaluatedAt, findings);
  evaluateRuntime(runtimeForEvaluation, properties, { repositoryId, owner: options.owner, repository: options.repository }, evaluatedAt, findings);
  return report(fullName, findings);
}
