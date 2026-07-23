import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsEnvelope,
  enabledStewardMatrixConfiguration,
  evaluateMatrix,
  fingerprintForPull,
  matrixLiveEvidenceDigest,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST,
  STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
  STEWARD_ACTIONS_GENERAL_POLICY,
  STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
  STEWARD_APP_REQUIRED_EXPLICIT_EVENTS,
  STEWARD_APP_REQUIRED_PERMISSIONS,
  stewardCheckExternalId,
} from '../packages/core/src/index.js';
import {
  runDoctor,
  type DoctorDependencies,
} from '../packages/cli/src/doctor.js';
import type { RuntimeDiagnosticsProvider } from '../packages/cli/src/runtime-diagnostics.js';
import { main, parseArguments } from '../packages/cli/src/main.js';
import {
  GitHubApiError,
  type GitHubActionsExecutionProtections,
  type GitHubRequest,
  type GitHubTransport,
} from '../packages/github/src/index.js';
import { manifestDigest, type ClassificationConfiguration, type StewardManifest } from '../packages/manifest/src/index.js';

const sha = 'a'.repeat(40);
const defaultBranchSha = 'f'.repeat(40);
const observedAt = '2026-07-23T00:00:00.000Z';
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function pullPayload(
  number = 3,
  headSha = sha,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    state: 'open',
    title: `feat: test Matrix live evidence ${number}`,
    body: 'Stable pull request body.',
    user: { login: 'human-author' },
    base: { ref: 'main', sha: defaultBranchSha },
    head: { ref: `feature/test-${number}`, sha: headSha },
    ...overrides,
  };
}

function manifest(adapterCommand: string[] = ['node', '.github/steward/release.mjs']): StewardManifest {
  return {
    $schema: `https://raw.githubusercontent.com/splrad/steward/${sha}/schema/steward.schema.json`,
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: true,
      classification: true,
      dcoAdvisory: true,
      governance: true,
      copilotReview: true,
      release: true,
      webhookRelay: false,
    },
    release: { triggerPaths: ['release/version.json'], runner: 'ubuntu-latest', adapterCommand },
    classification,
  };
}

function propertySchema(): unknown[] {
  return [
    ['steward_state', 'unmanaged', ['unmanaged', 'bootstrapping', 'active', 'paused']],
    ['steward_ring', 'production', ['canary', 'production']],
    ['governance_tier', 'solo', ['solo', 'reviewed']],
    ['ci_profile', 'none', ['none', 'codeql']],
  ].map(([name, defaultValue, allowedValues]) => ({
    property_name: name,
    source_type: 'organization',
    value_type: 'single_select',
    required: true,
    default_value: defaultValue,
    allowed_values: allowedValues,
    values_editable_by: 'org_actors',
    require_explicit_values: false,
  }));
}

function repositoryProperties(state: string): unknown[] {
  return [
    { property_name: 'steward_state', value: state },
    { property_name: 'steward_ring', value: 'canary' },
    { property_name: 'governance_tier', value: 'solo' },
    { property_name: 'ci_profile', value: 'none' },
  ];
}

function rulesets(state: string): Array<Record<string, unknown>> {
  const basePullRequest = {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    required_reviewers: [],
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: true,
    allowed_merge_methods: ['squash'],
  };
  const result: Array<Record<string, unknown>> = [
    {
      id: 10,
      name: 'Base Safety',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_name: { include: ['~ALL'], exclude: [] },
      },
      bypass_actors: [],
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: basePullRequest },
      ],
    },
    {
      id: 13,
      name: 'Human Review',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_property: {
          include: [{ name: 'governance_tier', property_values: ['reviewed'], source: 'custom' }],
          exclude: [],
        },
      },
      bypass_actors: [],
      rules: [{
        type: 'pull_request',
        parameters: {
          ...basePullRequest,
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          required_reviewers: [{
            file_patterns: ['**'],
            minimum_approvals: 1,
            reviewer: { id: 5, type: 'Team' },
          }],
          require_last_push_approval: true,
        },
      }],
    },
    {
      id: 14,
      name: 'Code Security',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_property: {
          include: [{ name: 'ci_profile', property_values: ['codeql'], source: 'custom' }],
          exclude: [],
        },
      },
      bypass_actors: [],
      rules: [
        {
          type: 'code_scanning',
          parameters: {
            code_scanning_tools: [{
              tool: 'CodeQL', alerts_threshold: 'errors', security_alerts_threshold: 'high_or_higher',
            }],
          },
        },
        { type: 'code_quality', parameters: { severity: 'errors' } },
      ],
    },
    {
      id: 11,
      name: 'Copilot Review',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_name: { include: ['~ALL'], exclude: [] },
      },
      bypass_actors: [],
      rules: [{
        type: 'copilot_code_review',
        parameters: { review_on_push: true, review_draft_pull_requests: true },
      }],
    },
  ];
  result.push({
      id: 12,
      name: 'Steward Matrix',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_property: {
          include: [{ name: 'steward_state', property_values: ['active'], source: 'custom' }],
          exclude: [],
        },
      },
      bypass_actors: [],
      rules: [{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: true,
          required_status_checks: [{ context: 'PR Validation Matrix Gate', integration_id: 4243096 }],
        },
      }],
  });
  return result;
}

function rulesetSummary(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    source_type: item.source_type,
    source: item.source,
    enforcement: item.enforcement,
  };
}

function applicableRulesetSummaries(state: string): Record<string, unknown>[] {
  return rulesets(state)
    .filter((item) => item.name === 'Base Safety' || item.name === 'Copilot Review'
      || (state === 'active' && item.name === 'Steward Matrix'))
    .map(rulesetSummary);
}

function effectiveRules(state: string): Array<Record<string, unknown>> {
  const definitions = rulesets(state);
  const rule = (ruleset: string, type: string): Record<string, unknown> => {
    const definition = definitions.find((item) => item.name === ruleset)!;
    const observed = (definition.rules as Array<Record<string, unknown>>).find((item) => item.type === type)!;
    return {
      ...observed,
      ruleset_id: definition.id,
      ruleset_source_type: 'Organization',
      ruleset_source: 'splrad',
    };
  };
  const result: Array<Record<string, unknown>> = [
    rule('Base Safety', 'deletion'),
    rule('Base Safety', 'non_fast_forward'),
    rule('Base Safety', 'pull_request'),
    rule('Copilot Review', 'copilot_code_review'),
  ];
  if (state === 'active') {
    result.push(rule('Steward Matrix', 'required_status_checks'));
  }
  return result;
}

function actionsExecutionAttestation(
  overrides: Partial<GitHubActionsExecutionProtections> = {},
): GitHubActionsExecutionProtections {
  return {
    schemaVersion: 1,
    organization: 'splrad',
    repositoryId: 7,
    repositoryFullName: 'splrad/example',
    propertyDigest: '4d2a9cc3d6fda6383a276918b06ba3481c6c4894ed4e1ea9ad3a0a0eb2f5b56b',
    contractVersion: STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.contractVersion,
    contractDigest: STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST,
    inventoryVersion: STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.inventoryVersion,
    inventoryDigest: STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
    policyDigest: STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
    mode: 'active',
    policyCount: STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT.expectedPolicyCount,
    issuedAt: observedAt,
    observedAt,
    expiresAt: '2026-07-23T00:15:00.000Z',
    nonce: '019f4f4f-40ad-7471-b40c-9838f254503c',
    attestor: {
      login: 'organization-owner',
      id: 42,
    },
    verification: {
      method: 'github-ssh-signing-key',
      signingKeyId: 9,
      signingKeyAlgorithm: 'ssh-ed25519',
      authenticatedPrincipal: {
        login: 'organization-owner',
        id: 42,
      },
      organizationMembership: {
        state: 'active',
        role: 'admin',
      },
    },
    ...overrides,
  };
}

function appInstallation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    app_id: 4243096,
    app_slug: 'splrad-steward',
    client_id: 'Iv23liuSr0qd4WLJdZhH',
    account: { login: 'splrad' },
    repository_selection: 'selected',
    suspended_at: null,
    permissions: { ...STEWARD_APP_REQUIRED_PERMISSIONS },
    events: [...STEWARD_APP_REQUIRED_EXPLICIT_EVENTS],
    ...overrides,
  };
}

function runtimeEnvelope(options: {
  repositoryId?: number;
  repositoryFullName?: string;
  observedAt?: string;
  workerDeploymentId?: string;
  environment?: 'candidate' | 'canary' | 'production';
  queue?: 'ready' | 'degraded';
  control?: 'ready' | 'degraded';
  deadLetterQueue?: 'clear' | 'pending' | 'unavailable';
} = {}) {
  return buildStewardRuntimeDiagnosticsEnvelope({
    subject: {
      repositoryId: options.repositoryId ?? 7,
      repositoryFullName: options.repositoryFullName ?? 'splrad/example',
    },
    observedAt: options.observedAt ?? observedAt,
    diagnostics: {
      controlRevision: {
        stewardCommit: 'b'.repeat(40),
        workerVersionId: 'worker-version-1',
        workerDeploymentId: options.workerDeploymentId ?? 'deployment-1',
        environment: options.environment ?? 'canary',
      },
      queue: options.queue ?? 'ready',
      control: options.control ?? 'ready',
      deadLetterQueue: options.deadLetterQueue ?? 'clear',
    },
  });
}

function knownRuntime(): RuntimeDiagnosticsProvider {
  return {
    async read() {
      return {
        status: 'response' as const,
        body: runtimeEnvelope(),
      };
    },
  };
}

interface Setup {
  dependencies: DoctorDependencies;
  repositoryRequests: GitHubRequest[];
  organizationRequests: GitHubRequest[];
  organizationRulesetRequests: GitHubRequest[];
  appRequests: GitHubRequest[];
}

function response(overrides: Record<string, unknown>, request: GitHubRequest, fallback: () => unknown): unknown {
  if (Object.hasOwn(overrides, request.path)) {
    const result = overrides[request.path];
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? (result as (request: GitHubRequest) => unknown)(request) : result;
  }
  return fallback();
}

function transport(requests: GitHubRequest[], handler: (request: GitHubRequest) => unknown): GitHubTransport {
  return {
    restApiVersion: '2026-03-10',
    async request<T>(request: GitHubRequest): Promise<T> {
      requests.push(structuredClone(request));
      return handler(request) as T;
    },
  };
}

async function setup(options: {
  state?: string;
  configuredManifest?: StewardManifest;
  repositoryOverrides?: Record<string, unknown>;
  organizationOverrides?: Record<string, unknown>;
  appOverrides?: Record<string, unknown>;
  runtimeDiagnostics?: RuntimeDiagnosticsProvider;
  actionsExecutionProtections?: DoctorDependencies['actionsExecutionProtections'];
  extraCheckRuns?: readonly Record<string, unknown>[];
  checkRunsForRead?: (
    checks: readonly Record<string, unknown>[],
    readNumber: number,
  ) => readonly Record<string, unknown>[];
  observedAt?: () => string;
} = {}): Promise<Setup> {
  const state = options.state ?? 'active';
  const configuredManifest = options.configuredManifest ?? manifest();
  const configDigest = await manifestDigest(configuredManifest);
  const defaultPull = pullPayload() as {
    number: number;
    state: string;
    title: string;
    body: string;
    user: { login: string };
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
  };
  const defaultCommits = [{ sha, author: { login: 'human-author' } }];
  const defaultFiles = [{
    filename: 'src/example.ts', status: 'modified', sha: 'blob-sha', additions: 2, deletions: 1,
  }];
  const pullFingerprint = await fingerprintForPull({
    pull: defaultPull,
    commits: defaultCommits,
    files: defaultFiles,
    botLogins: [configuredManifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
  });
  const childCheck = (id: number, name: string, checkId: string) => ({
    id,
    head_sha: sha,
    name,
    status: 'completed',
    conclusion: 'success',
    app: { id: 4243096, slug: 'splrad-steward' },
    external_id: stewardCheckExternalId({
      repositoryId: 7,
      prNumber: 3,
      headSha: sha,
      checkId,
      configDigest,
      inputDigest: pullFingerprint.value,
    }),
  });
  const childChecks = [
    childCheck(21, 'PR Classification Gate', 'pr-classification'),
    childCheck(22, 'Main Authorization Gate', 'main-authorization'),
    childCheck(23, 'Copilot Code Review Gate', 'copilot-review-gate'),
  ];
  const matrixPull = {
    number: 3,
    state: 'open',
    base: defaultPull.base,
    head: defaultPull.head,
  } as const;
  const matrixEvaluation = evaluateMatrix({
    config: enabledStewardMatrixConfiguration(configuredManifest.features),
    checkRuns: childChecks,
    scope: 'full',
    pull: matrixPull,
    trust: {
      appId: 4243096,
      appSlug: 'splrad-steward',
      repositoryId: 7,
      configDigest,
      inputDigest: pullFingerprint.value,
      workflowRuns: [],
      allowLegacy: true,
    },
  });
  const matrixEvidence = await matrixLiveEvidenceDigest({
    repositoryId: 7,
    pull: matrixPull,
    configDigest,
    pullFingerprintDigest: pullFingerprint.value,
    targets: matrixEvaluation.targets,
  });
  const matrixCheck = {
    id: 31,
    head_sha: sha,
    name: 'PR Validation Matrix Gate',
    status: 'completed',
    conclusion: 'success',
    app: { id: 4243096, slug: 'splrad-steward' },
    external_id: stewardCheckExternalId({
      repositoryId: 7,
      prNumber: 3,
      headSha: sha,
      checkId: 'validation-matrix',
      configDigest,
      inputDigest: matrixEvidence.value,
    }),
  };
  const repositoryRulesets = rulesets(state);
  const repositoryRequests: GitHubRequest[] = [];
  const organizationRequests: GitHubRequest[] = [];
  const organizationRulesetRequests: GitHubRequest[] = [];
  const appRequests: GitHubRequest[] = [];
  let checkRunReads = 0;
  const repositoryOverrides = options.repositoryOverrides ?? {};
  const organizationOverrides = options.organizationOverrides ?? {};
  const appOverrides = options.appOverrides ?? {};
  const repositoryTransport = transport(repositoryRequests, (request) => response(repositoryOverrides, request, () => {
    if (request.path === '/repos/splrad/example') {
      return { id: 7, full_name: 'splrad/example', default_branch: 'main', owner: { login: 'splrad', type: 'Organization' } };
    }
    if (request.path === '/repos/splrad/example/commits/main') return { sha: defaultBranchSha };
    if (request.path === '/repos/splrad/example/contents/.github/steward.json') {
      return {
        type: 'file', encoding: 'base64',
        content: Buffer.from(JSON.stringify(configuredManifest)).toString('base64'), sha: 'blob',
      };
    }
    if (request.path === '/repos/splrad/example/properties/values') return repositoryProperties(state);
    if (request.path === '/repos/splrad/example/actions/permissions') return {
      enabled: true, allowed_actions: 'all', sha_pinning_required: false,
    };
    if (request.path === '/repos/splrad/example/rulesets') {
      return applicableRulesetSummaries(state);
    }
    if (request.path === '/repos/splrad/example/rules/branches/main') return effectiveRules(state);
    if (request.path === '/repos/splrad/example/pulls') return [defaultPull];
    if (request.path === '/repos/splrad/example/pulls/3') return defaultPull;
    const associatedCommitSha = request.path.match(/^\/repos\/splrad\/example\/commits\/([a-f0-9]{40})\/pulls$/)?.[1];
    if (associatedCommitSha) {
      const configuredPullList = repositoryOverrides['/repos/splrad/example/pulls'];
      const candidates: unknown[] = Array.isArray(configuredPullList)
        ? [...configuredPullList]
        : [defaultPull];
      for (const [overridePath, value] of Object.entries(repositoryOverrides)) {
        if (/^\/repos\/splrad\/example\/pulls\/\d+$/.test(overridePath)
          && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error)) {
          candidates.push(value);
        }
      }
      const unique = new Map<number, Record<string, unknown>>();
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const pull = candidate as { number?: unknown; state?: unknown; head?: { sha?: unknown } };
        const number = Number(pull.number ?? 0);
        if (Number.isSafeInteger(number) && number > 0 && pull.state === 'open'
          && String(pull.head?.sha ?? '').toLowerCase() === associatedCommitSha) {
          unique.set(number, candidate as Record<string, unknown>);
        }
      }
      return [...unique.values()];
    }
    if (/^\/repos\/splrad\/example\/pulls\/\d+\/commits$/.test(request.path)) return defaultCommits;
    if (/^\/repos\/splrad\/example\/pulls\/\d+\/files$/.test(request.path)) return defaultFiles;
    if (request.path === '/repos/splrad/example/actions/runs') return { workflow_runs: [] };
    if (request.path === `/repos/splrad/example/commits/${sha}/check-runs`) {
      checkRunReads += 1;
      const checks = [...childChecks, ...(options.extraCheckRuns ?? []), matrixCheck];
      return { check_runs: options.checkRunsForRead?.(checks, checkRunReads) ?? checks };
    }
    const adapter = configuredManifest.release?.adapterCommand.find((argument) => /[\\/]/.test(argument));
    if (adapter && request.path === `/repos/splrad/example/contents/${adapter.replaceAll('\\', '/')}`) return { type: 'file' };
    throw new Error(`Unexpected repository request: ${request.path}`);
  }));
  const organizationTransport = transport(organizationRequests, (request) => response(organizationOverrides, request, () => {
    if (request.path === '/orgs/splrad/properties/schema') return propertySchema();
    if (request.path === '/orgs/splrad/teams/maintainers') return { id: 5, slug: 'maintainers' };
    if (request.path === '/orgs/splrad/teams/maintainers/members') return [
      { login: 'maintainer-one' }, { login: 'maintainer-two' },
    ];
    if (request.path === '/repos/splrad/example') return { id: 7, full_name: 'splrad/example' };
    if (request.path === '/orgs/splrad/teams/maintainers/repos/splrad/example') return {
      role_name: 'maintain',
      permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
    };
    if (request.path === '/orgs/splrad/actions/permissions') return {
      enabled_repositories: 'all', allowed_actions: 'selected', sha_pinning_required: true,
    };
    if (request.path === '/orgs/splrad/actions/permissions/workflow') return {
      default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
    };
    if (request.path === '/orgs/splrad/actions/permissions/selected-actions') return {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: [...STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.patternsAllowed],
    };
    throw new Error(`Unexpected organization request: ${request.path}`);
  }));
  const organizationRulesetTransport = transport(
    organizationRulesetRequests,
    (request) => response(organizationOverrides, request, () => {
      if (request.path === '/orgs/splrad/rulesets') return repositoryRulesets.map(rulesetSummary);
      const organizationRulesetId = Number(request.path.match(/^\/orgs\/splrad\/rulesets\/(\d+)$/)?.[1] ?? 0);
      if (organizationRulesetId) return repositoryRulesets.find((item) => item.id === organizationRulesetId);
      throw new Error(`Unexpected organization Ruleset request: ${request.path}`);
    }),
  );
  const appTransport = transport(appRequests, (request) => response(appOverrides, request, () => {
    if (request.path === '/repos/splrad/example/installation') return appInstallation();
    throw new Error(`Unexpected App request: ${request.path}`);
  }));
  return {
    dependencies: {
      repositoryTransport,
      organizationTransport,
      organizationRulesetTransport,
      appJwtTransport: appTransport,
      appUserTransport: appTransport,
      runtimeDiagnostics: options.runtimeDiagnostics ?? knownRuntime(),
      ...(options.actionsExecutionProtections
        ? { actionsExecutionProtections: options.actionsExecutionProtections }
        : {}),
      observedAt: options.observedAt ?? (() => observedAt),
    },
    repositoryRequests,
    organizationRequests,
    organizationRulesetRequests,
    appRequests,
  };
}

describe('doctor CLI contract', () => {
  it('accepts only the explicit read-only doctor surface', () => {
    expect(parseArguments(['doctor', '--repo', 'splrad/example', '--pr', '3', '--json']))
      .toEqual({ command: 'doctor', repository: 'splrad/example', pullRequest: 3, json: true });
    expect(parseArguments([
      'doctor',
      '--repo',
      'splrad/example',
      '--actions-attestation',
      'actions.json',
    ])).toEqual({
      command: 'doctor',
      repository: 'splrad/example',
      actionsAttestation: 'actions.json',
      json: false,
    });
    expect(() => parseArguments(['activate', '--repo', 'splrad/example'])).toThrow('Usage');
    expect(() => parseArguments(['doctor', '--repo', 'invalid'])).toThrow('OWNER/REPOSITORY');
    expect(() => parseArguments(['doctor', '--repo', 'splrad/example', '--pr', '0'])).toThrow('positive integer');
  });

  it('validates the target organization contract without requiring legacy callers or consumer credentials', async () => {
    const current = await setup();
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });

    expect(report.counts.fail).toBe(0);
    expect(report.status).toBe('unknown');
    expect(report.ok).toBe(false);
    expect(report.findings.find((item) => item.code === 'actions.execution-protections'))
      .toMatchObject({ state: 'unknown', level: 'warning' });
    expect(report.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'conformant' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'conformant', observedAt, apiVersion: '2026-03-10' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.parameters'))
      .toMatchObject({ state: 'conformant' });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'conformant' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'conformant' });
    expect(report.findings.find((item) => item.code === 'app.events'))
      .toMatchObject({ state: 'conformant' });
    const allRequests = [...current.repositoryRequests, ...current.organizationRequests, ...current.appRequests];
    expect(allRequests.every((request) => !request.method || request.method === 'GET')).toBe(true);
    expect(allRequests.some((request) => /actions\/(secrets|variables)$/.test(request.path))).toBe(false);
    expect(allRequests.some((request) => request.path.includes('/contents/.github/workflows/'))).toBe(false);
    expect(current.repositoryRequests.some((request) => request.path.endsWith('/actions/permissions/workflow'))).toBe(false);
    expect(current.repositoryRequests.some((request) => request.path.endsWith('/actions/permissions/selected-actions'))).toBe(false);
  });

  it('compares organization snapshots semantically instead of treating order or evidence timestamps as drift', async () => {
    let schemaReads = 0;
    let clockReads = 0;
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/properties/schema': () => {
          schemaReads += 1;
          const value = propertySchema();
          return schemaReads === 1 ? value : [...value].reverse();
        },
      },
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation(),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt,
        },
      },
      observedAt: () => new Date(Date.parse(observedAt) + (clockReads++ * 1_000)).toISOString(),
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(schemaReads).toBe(2);
    expect(report.findings.find((item) => item.code === 'organization.snapshot-stability'))
      .toMatchObject({ state: 'conformant' });
  });

  it('does not erase an ordered custom-property contract change while canonicalizing snapshots', async () => {
    let schemaReads = 0;
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/properties/schema': () => {
          schemaReads += 1;
          const value = propertySchema() as Array<Record<string, unknown>>;
          if (schemaReads === 1) return value;
          return value.map((property) => property.property_name === 'steward_state'
            ? { ...property, allowed_values: [...(property.allowed_values as unknown[])].reverse() }
            : property);
        },
      },
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation(),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt,
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'organization.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
  });

  it('accepts the documented default custom source when repository_property.source is omitted', async () => {
    const definitions = rulesets('active').map((definition) => {
      const property = (definition.conditions as Record<string, unknown>).repository_property as
        | { include: Array<Record<string, unknown>>; exclude: unknown[] }
        | undefined;
      if (!property) return definition;
      const include = property.include.map(({ source: _source, ...candidate }) => candidate);
      return {
        ...definition,
        conditions: {
          ...(definition.conditions as Record<string, unknown>),
          repository_property: { ...property, include },
        },
      };
    });
    const overrides = Object.fromEntries(definitions.map((definition) => [
      `/orgs/splrad/rulesets/${definition.id}`,
      definition,
    ]));
    const current = await setup({ organizationOverrides: overrides });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'conformant' });
  });

  it('keeps permission-denied distinct from a known empty property schema', async () => {
    const path = '/orgs/splrad/properties/schema';
    const denied = await setup({
      organizationOverrides: {
        [path]: new GitHubApiError({ status: 403, method: 'GET', path, message: 'Forbidden' }),
      },
    });
    const deniedReport = await runDoctor(denied.dependencies, { owner: 'splrad', repository: 'example' });
    expect(deniedReport.findings.find((item) => item.code === 'organization.properties.schema'))
      .toMatchObject({
        state: 'permission-denied', httpStatus: 403, observedAt, apiVersion: '2026-03-10',
      });
    expect(deniedReport.status).toBe('unknown');

    const empty = await setup({ organizationOverrides: { [path]: [] } });
    const emptyReport = await runDoctor(empty.dependencies, { owner: 'splrad', repository: 'example' });
    expect(emptyReport.findings.find((item) => item.code === 'organization.properties.schema'))
      .toMatchObject({ state: 'drift', level: 'fail' });
    expect(emptyReport.status).toBe('action-required');
  });

  it('requires Matrix only for active repositories and detects over-targeting', async () => {
    const paused = await setup({ state: 'paused' });
    const pausedReport = await runDoctor(paused.dependencies, { owner: 'splrad', repository: 'example' });
    expect(pausedReport.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'not-applicable' });

    const matrixRule = effectiveRules('active').at(-1)!;
    const overTargeted = await setup({
      state: 'paused',
      repositoryOverrides: { '/repos/splrad/example/rules/branches/main': [...effectiveRules('paused'), matrixRule] },
    });
    const overTargetedReport = await runDoctor(overTargeted.dependencies, { owner: 'splrad', repository: 'example' });
    expect(overTargetedReport.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'drift' });
  });

  it('reports Team role, App permission, and event drift independently', async () => {
    const teamPath = '/orgs/splrad/teams/maintainers/repos/splrad/example';
    const installationPath = '/repos/splrad/example/installation';
    const permissions = { ...STEWARD_APP_REQUIRED_PERMISSIONS } as Record<string, string>;
    delete permissions.merge_queues;
    permissions.administration = 'write';
    const current = await setup({
      organizationOverrides: {
        [teamPath]: {
          role_name: 'write',
          permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        },
      },
      appOverrides: {
        [installationPath]: appInstallation({
          permissions,
          events: [...STEWARD_APP_REQUIRED_EXPLICIT_EVENTS.filter((event) => event !== 'merge_group'), 'fork'],
        }),
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.team-role'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'app.permissions')?.summary).toContain('merge_queues:write');
    expect(report.findings.find((item) => item.code === 'app.permissions')?.summary).toContain('administration:write');
    expect(report.findings.find((item) => item.code === 'app.events')?.summary).toContain('fork:unexpected');
    expect(report.findings.find((item) => item.code === 'app.events.planned'))
      .toMatchObject({ state: 'unknown' });
  });

  it('does not impose Steward bypass policy on unrelated organization rulesets', async () => {
    const unrelated = {
      id: 99,
      name: 'Project Emergency Access',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'splrad',
      conditions: {
        ref_name: { include: ['refs/heads/release/*'], exclude: [] },
        repository_name: { include: ['LayerScape'], exclude: [] },
      },
      bypass_actors: [{ actor_id: 1234, actor_type: 'Team', bypass_mode: 'pull_request' }],
      rules: [{ type: 'deletion' }],
    };
    const definitions = rulesets('active');
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets': [...definitions.map(rulesetSummary), rulesetSummary(unrelated)],
        '/orgs/splrad/rulesets/99': unrelated,
      },
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.bypass'))
      .toMatchObject({ state: 'conformant' });
  });

  it('requires the exact Maintain Team role and rejects Admin over-privilege', async () => {
    const teamPath = '/orgs/splrad/teams/maintainers/repos/splrad/example';
    const maintain = await setup();
    const maintainReport = await runDoctor(maintain.dependencies, { owner: 'splrad', repository: 'example' });
    expect(maintainReport.findings.find((item) => item.code === 'organization.team-role'))
      .toMatchObject({ state: 'conformant' });

    const admin = await setup({
      organizationOverrides: {
        [teamPath]: {
          role_name: 'admin',
          permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
        },
      },
    });
    const adminReport = await runDoctor(admin.dependencies, { owner: 'splrad', repository: 'example' });
    expect(adminReport.findings.find((item) => item.code === 'organization.team-role'))
      .toMatchObject({ state: 'drift' });
  });

  it('rejects elevation of a required read App permission to write', async () => {
    const installationPath = '/repos/splrad/example/installation';
    const current = await setup({
      appOverrides: {
        [installationPath]: appInstallation({
          permissions: { ...STEWARD_APP_REQUIRED_PERMISSIONS, members: 'write' },
        }),
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'app.permissions'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'app.permissions')?.summary)
      .toContain('members:read');
  });

  it('requires two independent Team members before reviewed governance can be healthy', async () => {
    const valuesPath = '/repos/splrad/example/properties/values';
    const membersPath = '/orgs/splrad/teams/maintainers/members';
    const current = await setup({
      repositoryOverrides: {
        [valuesPath]: [
          { property_name: 'steward_state', value: 'active' },
          { property_name: 'steward_ring', value: 'canary' },
          { property_name: 'governance_tier', value: 'reviewed' },
          { property_name: 'ci_profile', value: 'none' },
        ],
      },
      organizationOverrides: { [membersPath]: [{ login: 'only-reviewer' }] },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.team-reviewers'))
      .toMatchObject({ state: 'drift' });
  });

  it('rejects verified-creator and unbounded Actions allowlists', async () => {
    const selected = { github_owned_allowed: true, verified_allowed: true, patterns_allowed: ['*/*'] };
    const current = await setup({
      organizationOverrides: { '/orgs/splrad/actions/permissions/selected-actions': selected },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'actions.organization-allowlist'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'actions.repository-allowlist')).toBeUndefined();
  });

  it('treats organization Actions as policy authority and repository Actions only as consumer availability', async () => {
    const disabledPath = '/repos/splrad/example/actions/permissions';
    const releaseConsumer = await setup({
      repositoryOverrides: {
        [disabledPath]: { enabled: false, allowed_actions: 'all', sha_pinning_required: false },
      },
    });
    const releaseReport = await runDoctor(releaseConsumer.dependencies, { owner: 'splrad', repository: 'example' });
    expect(releaseReport.findings.find((item) => item.code === 'actions.repository'))
      .toMatchObject({ state: 'drift' });

    const noReleaseManifest = structuredClone(manifest());
    noReleaseManifest.features.release = false;
    delete noReleaseManifest.release;
    const noReleaseConsumer = await setup({
      configuredManifest: noReleaseManifest,
      repositoryOverrides: {
        [disabledPath]: { enabled: false, allowed_actions: 'all', sha_pinning_required: false },
      },
    });
    const noReleaseReport = await runDoctor(noReleaseConsumer.dependencies, { owner: 'splrad', repository: 'example' });
    expect(noReleaseReport.findings.find((item) => item.code === 'actions.repository'))
      .toMatchObject({ state: 'not-applicable' });

    const codeqlProperties = repositoryProperties('active').map((item) => (
      (item as { property_name?: string }).property_name === 'ci_profile'
        ? { property_name: 'ci_profile', value: 'codeql' }
        : item
    ));
    const codeqlConsumer = await setup({
      configuredManifest: noReleaseManifest,
      repositoryOverrides: {
        [disabledPath]: { enabled: false, allowed_actions: 'all', sha_pinning_required: false },
        '/repos/splrad/example/properties/values': codeqlProperties,
      },
    });
    const codeqlReport = await runDoctor(codeqlConsumer.dependencies, { owner: 'splrad', repository: 'example' });
    expect(codeqlReport.findings.find((item) => item.code === 'actions.repository'))
      .toMatchObject({ state: 'drift' });

    const propertiesPath = '/repos/splrad/example/properties/values';
    const unknownProperties = await setup({
      configuredManifest: noReleaseManifest,
      repositoryOverrides: {
        [disabledPath]: { enabled: false, allowed_actions: 'all', sha_pinning_required: false },
        [propertiesPath]: new GitHubApiError({
          status: 403, method: 'GET', path: propertiesPath, message: 'Forbidden',
        }),
      },
    });
    const unknownReport = await runDoctor(unknownProperties.dependencies, { owner: 'splrad', repository: 'example' });
    expect(unknownReport.findings.find((item) => item.code === 'actions.repository'))
      .toMatchObject({ state: 'unknown', observedAt, apiVersion: '2026-03-10' });
    expect(noReleaseConsumer.repositoryRequests.some((request) => request.path.endsWith('/actions/permissions/workflow')))
      .toBe(false);
    expect(noReleaseConsumer.repositoryRequests.some((request) => request.path.endsWith('/actions/permissions/selected-actions')))
      .toBe(false);
  });

  it('allows unrelated custom rulesets but rejects platform-reserved repository copies independently', async () => {
    const custom = {
      id: 700,
      name: 'Custom Release Guard',
      source_type: 'Repository',
      source: 'splrad/example',
      enforcement: 'active',
    };
    const unrelated = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/rulesets': [...applicableRulesetSummaries('active'), custom],
      },
    });
    const unrelatedReport = await runDoctor(unrelated.dependencies, { owner: 'splrad', repository: 'example' });
    expect(unrelatedReport.findings.find((item) => item.code === 'organization.rulesets.repository-copies'))
      .toMatchObject({ state: 'conformant' });
    expect(unrelatedReport.findings.find((item) => item.code === 'organization.rulesets.targeting'))
      .toMatchObject({ state: 'conformant' });

    const legacyCopy = { ...custom, id: 701, name: 'SPLRAD Steward' };
    const legacy = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/rulesets': [...applicableRulesetSummaries('active'), legacyCopy],
      },
    });
    const legacyReport = await runDoctor(legacy.dependencies, { owner: 'splrad', repository: 'example' });
    expect(legacyReport.findings.find((item) => item.code === 'organization.rulesets.repository-copies'))
      .toMatchObject({ state: 'drift' });
  });

  it('audits bypass actors across duplicate ruleset definitions before rejecting uniqueness', async () => {
    const duplicate = {
      ...rulesets('active').find((item) => item.name === 'Base Safety')!,
      id: 110,
      bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    };
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets': [...rulesets('active'), duplicate].map(rulesetSummary),
        '/orgs/splrad/rulesets/110': duplicate,
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.bypass'))
      .toMatchObject({ state: 'drift' });
  });

  it('accepts the exact Human Review Team bypass while rejecting Base and Matrix bypass actors', async () => {
    const human = rulesets('active').find((item) => item.name === 'Human Review')!;
    const humanReview = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets/13': {
          ...human,
          bypass_actors: [{ actor_id: 5, actor_type: 'Team', bypass_mode: 'pull_request' }],
        },
      },
    });
    const humanReport = await runDoctor(humanReview.dependencies, { owner: 'splrad', repository: 'example' });
    expect(humanReport.findings.find((item) => item.code === 'organization.rulesets.bypass'))
      .toMatchObject({ state: 'conformant', observedAt, apiVersion: '2026-03-10' });

    const wrongTeam = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets/13': {
          ...human,
          bypass_actors: [{ actor_id: 500, actor_type: 'Team', bypass_mode: 'pull_request' }],
        },
      },
    });
    const wrongTeamReport = await runDoctor(wrongTeam.dependencies, { owner: 'splrad', repository: 'example' });
    expect(wrongTeamReport.findings.find((item) => item.code === 'organization.rulesets.bypass'))
      .toMatchObject({ state: 'drift' });

    for (const definition of rulesets('active').filter((item) => (
      item.name === 'Base Safety' || item.name === 'Steward Matrix'
    ))) {
      const current = await setup({
        organizationOverrides: {
          [`/orgs/splrad/rulesets/${String(definition.id)}`]: {
            ...definition,
            bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
          },
        },
      });
      const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
      expect(report.findings.find((item) => item.code === 'organization.rulesets.bypass'))
        .toMatchObject({ state: 'drift' });
      expect(report.findings.find((item) => item.code === 'organization.rulesets.bypass')?.summary)
        .toContain(String(definition.name));
    }
  });

  it('requires Human Review approvals from the live maintainers Team ID', async () => {
    const human = rulesets('active').find((item) => item.name === 'Human Review')!;
    const rules = structuredClone(human.rules) as Array<{
      type: string;
      parameters: { required_reviewers: Array<{ reviewer: { id: number; type: string } }> };
    }>;
    rules[0]!.parameters.required_reviewers[0]!.reviewer.id = 500;
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets/13': { ...human, rules },
      },
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.parameters'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.parameters')?.summary)
      .toContain('Human Review');
  });

  it('rejects case-only collisions with canonical organization ruleset names', async () => {
    const collision = {
      ...rulesets('active').find((item) => item.name === 'Base Safety')!,
      id: 110,
      name: 'base safety',
    };
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets': [...rulesets('active'), collision].map(rulesetSummary),
        '/orgs/splrad/rulesets/110': collision,
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets')?.summary)
      .toContain('Base Safety:duplicate');
  });

  it('rejects extra targeting dimensions and protected-only repository conditions', async () => {
    const base = rulesets('active').find((item) => item.name === 'Base Safety')!;
    const current = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets/10': {
          ...base,
          conditions: {
            ...base.conditions as Record<string, unknown>,
            repository_name: { include: ['~ALL'], exclude: [], protected: true },
          },
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets')?.summary)
      .toContain('Base Safety:conditions');
  });

  it('binds ruleset targeting, bypass visibility, and effective rules to organization definition IDs', async () => {
    const definitions = rulesets('active');
    const badMatrix = {
      ...definitions.find((item) => item.name === 'Steward Matrix')!,
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    };
    const current = await setup({
      organizationOverrides: { '/orgs/splrad/rulesets/12': badMatrix },
      repositoryOverrides: {
        '/repos/splrad/example/rules/branches/main': effectiveRules('active').map((rule) => (
          rule.type === 'required_status_checks' ? { ...rule, ruleset_id: 999 } : rule
        )),
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets')?.summary)
      .toMatch(/Steward Matrix:(conditions|bypass)/);
    expect(report.findings.find((item) => item.code === 'organization.rulesets.bypass'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rules.effective'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'drift' });
  });

  it('rejects extra or any-source Matrix checks in both definitions and effective rules', async () => {
    const definitions = rulesets('active');
    const matrix = definitions.find((item) => item.name === 'Steward Matrix')!;
    const correct = { context: 'PR Validation Matrix Gate', integration_id: 4243096 };
    const anySource = { context: 'Project CI' };
    const definitionDrift = await setup({
      organizationOverrides: {
        '/orgs/splrad/rulesets/12': {
          ...matrix,
          rules: [{
            type: 'required_status_checks',
            parameters: { required_status_checks: [correct, anySource] },
          }],
        },
      },
    });
    const definitionReport = await runDoctor(
      definitionDrift.dependencies,
      { owner: 'splrad', repository: 'example' },
    );
    expect(definitionReport.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'drift' });

    const effectiveDrift = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/rules/branches/main': effectiveRules('active').map((rule) => (
          rule.ruleset_id === 12
            ? { ...rule, parameters: { required_status_checks: [correct, anySource] } }
            : rule
        )),
      },
    });
    const effectiveReport = await runDoctor(
      effectiveDrift.dependencies,
      { owner: 'splrad', repository: 'example' },
    );
    expect(effectiveReport.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'drift' });

    const foreignAnySource = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/rules/branches/main': [
          ...effectiveRules('active'),
          {
            type: 'required_status_checks',
            ruleset_id: 999,
            ruleset_source_type: 'Organization',
            ruleset_source: 'splrad',
            parameters: { required_status_checks: [{ context: 'PR Validation Matrix Gate' }] },
          },
        ],
      },
    });
    const foreignReport = await runDoctor(
      foreignAnySource.dependencies,
      { owner: 'splrad', repository: 'example' },
    );
    expect(foreignReport.findings.find((item) => item.code === 'organization.rules.matrix'))
      .toMatchObject({ state: 'drift' });
  });

  it('routes organization diagnostics through an identity separate from repository reads', async () => {
    const current = await setup();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitCode = await main(
        ['doctor', '--repo', 'splrad/example', '--pr', '3', '--json'],
        { GH_TOKEN: 'repository-token' },
        {
          templateDirectory: '.',
          transport: current.dependencies.repositoryTransport,
          organizationTransport: current.dependencies.organizationTransport!,
          organizationRulesetTransport: current.dependencies.organizationRulesetTransport!,
          appJwtTransport: current.dependencies.appJwtTransport!,
          runtimeDiagnostics: current.dependencies.runtimeDiagnostics!,
        },
      );
      expect(exitCode).toBe(2);
      expect(current.organizationRulesetRequests.some(
        (request) => request.path === '/orgs/splrad/rulesets',
      )).toBe(true);
      expect(current.organizationRequests.some((request) => request.path === '/orgs/splrad/rulesets'))
        .toBe(false);
      expect(current.repositoryRequests.some((request) => request.path === '/orgs/splrad/rulesets')).toBe(false);
      expect(current.repositoryRequests.some((request) => request.path.includes('/contents/.github/steward.json'))).toBe(true);
      expect(current.organizationRequests.some((request) => request.path.includes('/contents/.github/steward.json'))).toBe(false);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('keeps repo-only and resident-only Doctor reports useful without credential fallback', async () => {
    const repositoryOnly = await setup();
    const repositoryOnlyReport = await runDoctor({
      repositoryTransport: repositoryOnly.dependencies.repositoryTransport,
      appJwtTransport: repositoryOnly.dependencies.appJwtTransport!,
      runtimeDiagnostics: repositoryOnly.dependencies.runtimeDiagnostics!,
      observedAt: repositoryOnly.dependencies.observedAt!,
    }, { owner: 'splrad', repository: 'example' });

    expect(repositoryOnlyReport.status).toBe('unknown');
    expect(repositoryOnlyReport.findings.find((item) => item.code === 'organization.properties.schema'))
      .toMatchObject({ state: 'unknown' });
    expect(repositoryOnlyReport.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'unknown' });
    expect(repositoryOnly.repositoryRequests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
    expect(repositoryOnly.organizationRequests).toEqual([]);
    expect(repositoryOnly.organizationRulesetRequests).toEqual([]);

    const residentOnly = await setup();
    const residentOnlyReport = await runDoctor({
      repositoryTransport: residentOnly.dependencies.repositoryTransport,
      organizationTransport: residentOnly.dependencies.organizationTransport!,
      appJwtTransport: residentOnly.dependencies.appJwtTransport!,
      runtimeDiagnostics: residentOnly.dependencies.runtimeDiagnostics!,
      observedAt: residentOnly.dependencies.observedAt!,
    }, { owner: 'splrad', repository: 'example' });

    expect(residentOnlyReport.findings.find((item) => item.code === 'organization.properties.schema'))
      .toMatchObject({ state: 'conformant' });
    expect(residentOnlyReport.findings.find((item) => item.code === 'organization.rulesets'))
      .toMatchObject({ state: 'unknown' });
    expect(residentOnly.organizationRequests.some((request) => request.path.includes('/rulesets'))).toBe(false);
    expect(residentOnly.repositoryRequests.some((request) => request.path.startsWith('/orgs/'))).toBe(false);
    expect(residentOnly.organizationRulesetRequests).toEqual([]);
  });

  it('rejects reused Doctor credentials before sending any network request', async () => {
    const cases = [
      {
        env: { GH_TOKEN: 'shared-token', STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN: 'shared-token' },
        expected: 'STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN',
      },
      {
        env: { GITHUB_TOKEN: 'shared-token', STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN: 'shared-token' },
        expected: 'STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN',
      },
      {
        env: { GH_TOKEN: 'shared-token', STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN: 'shared-token' },
        expected: 'STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN',
      },
      {
        env: { GITHUB_TOKEN: 'shared-token', STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN: 'shared-token' },
        expected: 'STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN',
      },
      {
        env: {
          GH_TOKEN: 'repository-token',
          STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN: 'organization-token',
          STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN: 'organization-token',
        },
        expected: 'STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN',
      },
    ] as const;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const testCase of cases) {
        const current = await setup();
        stdout.mockClear();
        stderr.mockClear();
        const exitCode = await main(
          ['doctor', '--repo', 'splrad/example', '--json'],
          testCase.env,
          {
            templateDirectory: '.',
            transport: current.dependencies.repositoryTransport,
            appJwtTransport: current.dependencies.appJwtTransport!,
            runtimeDiagnostics: current.dependencies.runtimeDiagnostics!,
          },
        );
        expect(exitCode).toBe(2);
        const error = stderr.mock.calls.flat().join('');
        expect(error).toContain(testCase.expected);
        expect(error).not.toContain('shared-token');
        expect(error).not.toContain('repository-token');
        expect(error).not.toContain('organization-token');
        expect(current.repositoryRequests).toEqual([]);
        expect(current.organizationRequests).toEqual([]);
        expect(current.organizationRulesetRequests).toEqual([]);
        expect(current.appRequests).toEqual([]);
      }
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('does not verify an Actions attestation through repository or elevated identities', async () => {
    const current = await setup();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitCode = await main(
        [
          'doctor',
          '--repo',
          'splrad/example',
          '--actions-attestation',
          'this-file-must-not-be-read.json',
        ],
        {
          GH_TOKEN: 'repository-token',
          STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN: 'ruleset-token',
        },
        {
          templateDirectory: '.',
          transport: current.dependencies.repositoryTransport,
          organizationRulesetTransport: current.dependencies.organizationRulesetTransport!,
          appJwtTransport: current.dependencies.appJwtTransport!,
          runtimeDiagnostics: current.dependencies.runtimeDiagnostics!,
        },
      );

      expect(exitCode).toBe(2);
      expect(stderr.mock.calls.flat().join(''))
        .toContain('STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN');
      expect(stderr.mock.calls.flat().join('')).not.toContain('ENOENT');
      expect(current.repositoryRequests).toEqual([]);
      expect(current.organizationRequests).toEqual([]);
      expect(current.organizationRulesetRequests).toEqual([]);
      expect(current.appRequests).toEqual([]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('reports drift when --pr points at a head shared by multiple open pull requests', async () => {
    const associatedPath = `/repos/splrad/example/commits/${sha}/pulls`;
    const current = await setup({
      repositoryOverrides: {
        [associatedPath]: [pullPayload(3), pullPayload(4)],
      },
    });

    const report = await runDoctor(
      current.dependencies,
      { owner: 'splrad', repository: 'example', pullRequest: 3 },
    );

    expect(report.findings.find((item) => item.code === 'checks.head-exclusivity'))
      .toMatchObject({ state: 'drift', endpoint: associatedPath });
    expect(report.findings.find((item) => item.code === 'checks.head-exclusivity')?.summary)
      .toContain('#3、#4');
    expect(current.repositoryRequests.some((request) => request.path.endsWith('/check-runs'))).toBe(false);
  });

  it('ignores an associated pull request whose head has advanced to another commit', async () => {
    const associatedPath = `/repos/splrad/example/commits/${sha}/pulls`;
    const current = await setup({
      repositoryOverrides: {
        [associatedPath]: [pullPayload(3), pullPayload(4, 'd'.repeat(40))],
      },
    });

    const report = await runDoctor(
      current.dependencies,
      { owner: 'splrad', repository: 'example', pullRequest: 3 },
    );

    expect(report.findings.find((item) => item.code === 'checks.head-exclusivity'))
      .toMatchObject({ state: 'conformant', endpoint: associatedPath });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'conformant' });
  });

  it('rejects a head association that becomes non-exclusive at the final evidence barrier', async () => {
    const associatedPath = `/repos/splrad/example/commits/${sha}/pulls`;
    let reads = 0;
    const current = await setup({
      repositoryOverrides: {
        [associatedPath]: () => {
          reads += 1;
          return reads === 1 ? [pullPayload(3)] : [pullPayload(3), pullPayload(4)];
        },
      },
    });

    const report = await runDoctor(
      current.dependencies,
      { owner: 'splrad', repository: 'example', pullRequest: 3 },
    );

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(report.findings.filter((item) => item.code === 'checks.head-exclusivity'))
      .toEqual([expect.objectContaining({ state: 'drift', endpoint: associatedPath })]);
    expect(report.findings.find((item) => item.code === 'checks.head-exclusivity')?.summary)
      .toContain('终局屏障');
  });

  it('keeps head exclusivity unknown when the current pull is missing or an open association is malformed', async () => {
    const associatedPath = `/repos/splrad/example/commits/${sha}/pulls`;
    const missing = await setup({ repositoryOverrides: { [associatedPath]: [] } });
    const missingReport = await runDoctor(
      missing.dependencies,
      { owner: 'splrad', repository: 'example', pullRequest: 3 },
    );
    expect(missingReport.findings.find((item) => item.code === 'checks.head-exclusivity'))
      .toMatchObject({ state: 'unknown', endpoint: associatedPath });
    expect(missingReport.findings.find((item) => item.code === 'checks.head-exclusivity')?.summary)
      .toContain('未出现');

    const malformed = await setup({
      repositoryOverrides: {
        [associatedPath]: [{ number: '3', state: 'open', head: { sha } }],
      },
    });
    const malformedReport = await runDoctor(
      malformed.dependencies,
      { owner: 'splrad', repository: 'example', pullRequest: 3 },
    );
    expect(malformedReport.findings.find((item) => item.code === 'checks.head-exclusivity'))
      .toMatchObject({ state: 'unknown', endpoint: associatedPath });
    expect(malformedReport.findings.find((item) => item.code === 'checks.head-exclusivity')?.summary)
      .toContain('invalid-response');
  });

  it('does not treat a malformed open-PR inventory as an empty applicable set', async () => {
    const current = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/pulls': [{
          number: 3,
          state: 'open',
          base: {},
          head: { sha },
        }],
      },
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });

    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('invalid-response');
    expect(report.findings.some((item) => item.code === 'checks.current-head'
      && item.state === 'not-applicable')).toBe(false);
  });

  it('does not turn an unreadable Check API into a missing Check finding', async () => {
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      repositoryOverrides: {
        [path]: new GitHubApiError({ status: 403, method: 'GET', path, message: 'Forbidden' }),
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'permission-denied', httpStatus: 403 });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary).not.toContain('缺少');
  });

  it('isolates foreign same-name Checks and rejects a stale Matrix evidence digest', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const valid = {
      id: 40,
      head_sha: sha,
      name: 'PR Validation Matrix Gate',
      status: 'completed',
      conclusion: 'success',
      app: { id: 4243096, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({
        repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix',
        configDigest: digest, inputDigest: 'c'.repeat(64),
      }),
    };
    const staleOrForgedLatest = { ...valid, id: 41, app: { id: 1, slug: 'other-app' } };
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      configuredManifest,
      repositoryOverrides: { [path]: { check_runs: [valid, staleOrForgedLatest] } },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'checks.current-head.foreign-collision'))
      .toMatchObject({ state: 'not-applicable' });
  });

  it('does not fall back to an older child success when a trusted child generation ID is malformed', async () => {
    const configuredManifest = manifest();
    const configDigest = await manifestDigest(configuredManifest);
    const pull = pullPayload() as {
      title: string;
      body: string;
      user: { login: string };
      base: { ref: string; sha: string };
      head: { ref: string; sha: string };
    };
    const fingerprint = await fingerprintForPull({
      pull,
      commits: [{ sha, author: { login: 'human-author' } }],
      files: [{ filename: 'src/example.ts', status: 'modified', sha: 'blob-sha', additions: 2, deletions: 1 }],
      botLogins: [configuredManifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
    });
    const current = await setup({
      configuredManifest,
      extraCheckRuns: [{
        head_sha: sha,
        name: 'Main Authorization Gate',
        status: 'completed',
        conclusion: 'success',
        app: { id: 4243096, slug: 'splrad-steward' },
        external_id: stewardCheckExternalId({
          repositoryId: 7,
          prNumber: 3,
          headSha: sha,
          checkId: 'main-authorization',
          configDigest,
          inputDigest: fingerprint.value,
        }),
      }],
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });

    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('非法或重复 generation');
  });

  it('treats a Check with a contradictory status and success conclusion as an invalid response', async () => {
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      checkRunsForRead: (checks) => checks.map((check) => (
        check.name === 'Main Authorization Gate'
          ? { ...check, status: 'mystery', conclusion: 'success' }
          : check
      )),
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });

    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown', endpoint: path });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('invalid-response');
  });

  it('rejects a Steward Matrix payload whose expected-App Check ID is not a positive safe integer', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      configuredManifest,
      repositoryOverrides: { [path]: { check_runs: [{
        id: '52',
        head_sha: sha,
        name: 'PR Validation Matrix Gate',
        status: 'completed',
        conclusion: 'success',
        app: { id: 4243096, slug: 'splrad-steward' },
        external_id: stewardCheckExternalId({
          repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix',
          configDigest: digest, inputDigest: 'c'.repeat(64),
        }),
      }] } },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('正安全整数 ID');
  });

  it('requires the latest trusted Matrix generation to be completed and successful', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const check = (status: string, conclusion: string | null) => ({ check_runs: [{
      id: 50,
      head_sha: sha,
      name: 'PR Validation Matrix Gate',
      status,
      conclusion,
      app: { id: 4243096, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({
        repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix',
        configDigest: digest, inputDigest: 'c'.repeat(64),
      }),
    }] });
    const pending = await setup({ configuredManifest, repositoryOverrides: { [path]: check('in_progress', null) } });
    const pendingReport = await runDoctor(pending.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(pendingReport.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'drift' });

    const failed = await setup({ configuredManifest, repositoryOverrides: { [path]: check('completed', 'failure') } });
    const failedReport = await runDoctor(failed.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(failedReport.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'drift' });
  });

  it('does not treat a newer success as healthy while an older trusted Matrix generation is still active', async () => {
    const current = await setup({
      extraCheckRuns: [{
        id: 30,
        head_sha: sha,
        name: 'PR Validation Matrix Gate',
        status: 'in_progress',
        conclusion: null,
        app: { id: 4243096, slug: 'splrad-steward' },
        external_id: stewardCheckExternalId({
          repositoryId: 7,
          prNumber: 3,
          headSha: sha,
          checkId: 'validation-matrix',
          configDigest: 'a'.repeat(64),
          inputDigest: 'b'.repeat(64),
        }),
      }],
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });

    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('非最新但仍 active');
  });

  it('checks every open default-branch PR when --pr is omitted', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const sha2 = 'd'.repeat(40);
    const makeCheck = (prNumber: number, headSha: string, id: number) => ({ check_runs: [{
      id,
      head_sha: headSha,
      name: 'PR Validation Matrix Gate',
      status: 'completed',
      conclusion: 'success',
      app: { id: 4243096, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({
        repositoryId: 7, prNumber, headSha, checkId: 'validation-matrix',
        configDigest: digest, inputDigest: 'c'.repeat(64),
      }),
    }] });
    const current = await setup({
      configuredManifest,
      repositoryOverrides: {
        '/repos/splrad/example/pulls': [
          { number: 3, state: 'open', base: { ref: 'main' }, head: { sha } },
          { number: 4, state: 'open', base: { ref: 'main' }, head: { sha: sha2 } },
          { number: 5, state: 'open', base: { ref: 'release' }, head: { sha: 'e'.repeat(40) } },
        ],
        [`/repos/splrad/example/commits/${sha}/check-runs`]: makeCheck(3, sha, 60),
        [`/repos/splrad/example/commits/${sha2}/check-runs`]: makeCheck(4, sha2, 61),
        '/repos/splrad/example/pulls/4': { number: 4, state: 'open', base: { ref: 'main' }, head: { sha: sha2 } },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    const checkFindings = report.findings.filter((item) => item.code === 'checks.current-head');
    expect(checkFindings).toHaveLength(2);
    expect(checkFindings.some((item) => item.state === 'drift')).toBe(true);
    expect(checkFindings.some((item) => item.state === 'unknown')).toBe(true);
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations')?.summary)
      .toContain('未形成可用于终局屏障的 Matrix 基线');
  });

  it('revalidates every open PR latest Matrix ID after the sequential multi-PR scan', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const sha2 = 'd'.repeat(40);
    let firstPrCheckReads = 0;
    const makeCheck = (prNumber: number, headSha: string, id: number) => ({ check_runs: [{
      id,
      head_sha: headSha,
      name: 'PR Validation Matrix Gate',
      status: 'completed',
      conclusion: 'success',
      app: { id: 4243096, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({
        repositoryId: 7, prNumber, headSha, checkId: 'validation-matrix',
        configDigest: digest, inputDigest: 'c'.repeat(64),
      }),
    }] });
    const current = await setup({
      configuredManifest,
      repositoryOverrides: {
        '/repos/splrad/example/pulls': [
          { number: 3, state: 'open', base: { ref: 'main' }, head: { sha } },
          { number: 4, state: 'open', base: { ref: 'main' }, head: { sha: sha2 } },
        ],
        [`/repos/splrad/example/commits/${sha}/check-runs`]: () => {
          firstPrCheckReads += 1;
          return makeCheck(3, sha, firstPrCheckReads <= 3 ? 80 : 82);
        },
        [`/repos/splrad/example/commits/${sha2}/check-runs`]: makeCheck(4, sha2, 81),
        '/repos/splrad/example/pulls/4': { number: 4, state: 'open', base: { ref: 'main' }, head: { sha: sha2 } },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(firstPrCheckReads).toBeGreaterThanOrEqual(3);
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations')?.summary)
      .toContain('最新 Matrix generation 已变化');
  });

  it('rejects an in-place final Gate content change even when its Check ID is unchanged', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    let checkReads = 0;
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      configuredManifest,
      repositoryOverrides: {
        [path]: () => {
          checkReads += 1;
          return { check_runs: [{
            id: 90,
            head_sha: sha,
            name: 'PR Validation Matrix Gate',
            status: 'completed',
            conclusion: checkReads <= 3 ? 'success' : 'failure',
            app: { id: 4243096, slug: 'splrad-steward' },
            external_id: stewardCheckExternalId({
              repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix',
              configDigest: digest, inputDigest: 'c'.repeat(64),
            }),
          }] };
        },
      },
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });

    expect(checkReads).toBeGreaterThanOrEqual(4);
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations')?.summary)
      .toContain('Gate 内容');
  });

  it('rejects a changed active Matrix generation set even when the latest Gate is unchanged', async () => {
    const configuredManifest = manifest();
    const configDigest = await manifestDigest(configuredManifest);
    const olderGate = {
      id: 30,
      head_sha: sha,
      name: 'PR Validation Matrix Gate',
      status: 'completed',
      conclusion: 'success',
      app: { id: 4243096, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({
        repositoryId: 7,
        prNumber: 3,
        headSha: sha,
        checkId: 'validation-matrix',
        configDigest,
        inputDigest: 'a'.repeat(64),
      }),
    };
    const current = await setup({
      configuredManifest,
      extraCheckRuns: [olderGate],
      checkRunsForRead: (checks, readNumber) => checks.map((check) => (
        readNumber >= 4 && check.id === olderGate.id
          ? { ...check, status: 'in_progress', conclusion: null }
          : check
      )),
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });

    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations')?.summary)
      .toContain('active generation set');
  });

  it('rejects an in-place child projection change even when child and Gate Check IDs are unchanged', async () => {
    const configuredManifest = manifest();
    const configDigest = await manifestDigest(configuredManifest);
    const pull = pullPayload() as {
      title: string;
      body: string;
      user: { login: string };
      base: { ref: string; sha: string };
      head: { ref: string; sha: string };
    };
    const pullFingerprint = await fingerprintForPull({
      pull,
      commits: [{ sha, author: { login: 'human-author' } }],
      files: [{ filename: 'src/example.ts', status: 'modified', sha: 'blob-sha', additions: 2, deletions: 1 }],
      botLogins: [configuredManifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'],
    });
    const identity = (checkId: string, inputDigest: string) => stewardCheckExternalId({
      repositoryId: 7,
      prNumber: 3,
      headSha: sha,
      checkId,
      configDigest,
      inputDigest,
    });
    let checkReads = 0;
    const path = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      configuredManifest,
      repositoryOverrides: {
        [path]: () => {
          checkReads += 1;
          return { check_runs: [
            {
              id: 91,
              head_sha: sha,
              name: 'PR Classification Gate',
              status: 'completed',
              conclusion: checkReads <= 3 ? 'success' : 'failure',
              app: { id: 4243096, slug: 'splrad-steward' },
              external_id: identity('pr-classification', pullFingerprint.value),
            },
            {
              id: 92,
              head_sha: sha,
              name: 'PR Validation Matrix Gate',
              status: 'completed',
              conclusion: 'failure',
              app: { id: 4243096, slug: 'splrad-steward' },
              external_id: identity('validation-matrix', 'c'.repeat(64)),
            },
          ] };
        },
      },
    });

    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });

    expect(checkReads).toBeGreaterThanOrEqual(4);
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.open-pr-generations')?.summary)
      .toContain('child projection');
  });

  it('re-reads each PR after Check lookup and rejects a head that changed during diagnosis', async () => {
    let pullReads = 0;
    const changedSha = 'd'.repeat(40);
    const current = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/pulls/3': () => {
          pullReads += 1;
          return {
            number: 3,
            state: 'open',
            base: { ref: 'main' },
            head: { sha: pullReads < 2 ? sha : changedSha },
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(pullReads).toBeGreaterThanOrEqual(2);
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('发生 state/base/head 变化');
  });

  it('rejects a Matrix digest snapshot when title/body inputs change during pagination', async () => {
    let pullReads = 0;
    const current = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/pulls/3': () => {
          pullReads += 1;
          return pullPayload(3, sha, pullReads >= 3 ? { title: 'feat: changed while reading facts' } : {});
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('live inputs');
  });

  it('rejects malformed paginated file evidence instead of hashing missing fields as zero', async () => {
    const current = await setup({
      repositoryOverrides: {
        '/repos/splrad/example/pulls/3/files': [{ filename: 'src/example.ts', status: 'modified' }],
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'checks.current-head')?.summary)
      .toContain('invalid-response');
  });

  it('leaves no long PR/Check scan after the terminal repository and organization stability barrier', async () => {
    const configuredManifest = manifest();
    const digest = await manifestDigest(configuredManifest);
    const trace: string[] = [];
    const checkPath = `/repos/splrad/example/commits/${sha}/check-runs`;
    const current = await setup({
      configuredManifest,
      repositoryOverrides: {
        '/repos/splrad/example': () => {
          trace.push('repository');
          return { id: 7, full_name: 'splrad/example', default_branch: 'main', owner: { login: 'splrad', type: 'Organization' } };
        },
        '/repos/splrad/example/commits/main': () => {
          trace.push('default-head');
          return { sha: defaultBranchSha };
        },
        [checkPath]: () => {
          trace.push('checks');
          return { check_runs: [{
            id: 71,
            head_sha: sha,
            name: 'PR Validation Matrix Gate',
            status: 'completed',
            conclusion: 'success',
            app: { id: 4243096, slug: 'splrad-steward' },
            external_id: stewardCheckExternalId({
              repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix',
              configDigest: digest, inputDigest: 'c'.repeat(64),
            }),
          }] };
        },
      },
      organizationOverrides: {
        '/orgs/splrad/properties/schema': () => {
          trace.push('organization');
          return propertySchema();
        },
      },
      runtimeDiagnostics: {
        async read() {
          trace.push('runtime');
          return { status: 'response' as const, body: runtimeEnvelope() };
        },
      },
    });
    await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(trace.lastIndexOf('checks')).toBeLessThan(trace.lastIndexOf('repository'));
    expect(trace.lastIndexOf('checks')).toBeLessThan(trace.lastIndexOf('default-head'));
    expect(trace.lastIndexOf('checks')).toBeLessThan(trace.lastIndexOf('organization'));
    expect(trace.lastIndexOf('checks')).toBeLessThan(trace.lastIndexOf('runtime'));
    expect(trace.filter((entry) => entry === 'runtime')).toHaveLength(2);
  });

  it('binds Manifest and release adapter reads to the starting SHA when default-branch head moves', async () => {
    let headReads = 0;
    const movedHeadSha = 'e'.repeat(40);
    const headPath = '/repos/splrad/example/commits/main';
    const current = await setup({
      repositoryOverrides: {
        [headPath]: () => {
          headReads += 1;
          return { sha: headReads === 1 ? defaultBranchSha : movedHeadSha };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(headReads).toBe(2);
    expect(report.findings.find((item) => item.code === 'repository.default-branch-head-stability'))
      .toMatchObject({ state: 'unknown' });
    const manifestRequest = current.repositoryRequests.find((request) => (
      request.path === '/repos/splrad/example/contents/.github/steward.json'
    ));
    const adapterRequest = current.repositoryRequests.find((request) => (
      request.path === '/repos/splrad/example/contents/.github/steward/release.mjs'
    ));
    expect(manifestRequest?.query).toMatchObject({ ref: defaultBranchSha });
    expect(adapterRequest?.query).toMatchObject({ ref: defaultBranchSha });
  });

  it('binds Manifest to the first default branch and rejects repository metadata races', async () => {
    let repositoryReads = 0;
    const current = await setup({
      repositoryOverrides: {
        '/repos/splrad/example': () => {
          repositoryReads += 1;
          return {
            id: 7,
            full_name: 'splrad/example',
            default_branch: repositoryReads === 1 ? 'main' : 'release',
            owner: { login: 'splrad', type: 'Organization' },
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(repositoryReads).toBe(2);
    expect(current.repositoryRequests.find((request) => request.path.endsWith('/contents/.github/steward.json'))?.query)
      .toMatchObject({ ref: defaultBranchSha });
    expect(report.findings.find((item) => item.code === 'repository.stability'))
      .toMatchObject({ state: 'unknown' });
  });

  it('keeps hidden or forbidden Manifest reads unknown and continues organization diagnostics', async () => {
    const path = '/repos/splrad/example/contents/.github/steward.json';
    const current = await setup({
      repositoryOverrides: {
        [path]: new GitHubApiError({ status: 404, method: 'GET', path, message: 'Not Found' }),
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'manifest.valid'))
      .toMatchObject({ state: 'unknown', httpStatus: 404 });
    expect(report.findings.find((item) => item.code === 'organization.properties.schema')).toBeDefined();
    expect(report.findings.find((item) => item.code === 'checks.current-head'))
      .toMatchObject({ state: 'unknown' });
  });

  it('cross-checks the v1 Manifest client ID against the observed installation', async () => {
    const path = '/repos/splrad/example/installation';
    const current = await setup({ appOverrides: { [path]: appInstallation({ client_id: 'different-client-id' }) } });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'manifest.app-client-id'))
      .toMatchObject({ state: 'drift' });
  });

  it('rejects an installation attached to a different account even when App ID and slug match', async () => {
    const path = '/repos/splrad/example/installation';
    const current = await setup({
      appOverrides: { [path]: appInstallation({ account: { login: 'other-organization' } }) },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'app.installation'))
      .toMatchObject({ state: 'drift' });
  });

  it('reports selected-scope failures from the actual nested repository inventory endpoint', async () => {
    const installationPath = '/repos/splrad/example/installation';
    const selectedPath = '/user/installations/9/repositories';
    const current = await setup({
      appOverrides: {
        [installationPath]: new GitHubApiError({
          status: 403, method: 'GET', path: installationPath, message: 'Forbidden', requestId: 'REQ-INSTALL',
        }),
        [selectedPath]: new GitHubApiError({
          status: 403, method: 'GET', path: selectedPath, message: 'Forbidden', requestId: 'REQ-SCOPE',
        }),
      },
      organizationOverrides: {
        '/orgs/splrad/installations': { installations: [appInstallation()] },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'app.installation'))
      .toMatchObject({ state: 'permission-denied', endpoint: selectedPath, httpStatus: 403, requestId: 'REQ-SCOPE' });
  });

  it('normalizes a Windows-style release adapter without requiring a release caller', async () => {
    const configuredManifest = manifest(['pwsh', '.github\\steward\\release.ps1']);
    const current = await setup({ configuredManifest });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'release.adapter'))
      .toMatchObject({ state: 'conformant' });
    expect(current.repositoryRequests.map((request) => request.path))
      .toContain('/repos/splrad/example/contents/.github/steward/release.ps1');
  });

  it('reports missing runtime diagnostics as unknown instead of guessing a revision', async () => {
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          return {
            status: 'unknown' as const,
            reason: 'runtime-metadata-unavailable' as const,
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision')?.summary)
      .not.toContain(sha.slice(0, 12));
  });

  it('keeps permission-denied on both runtime findings', async () => {
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          return {
            status: 'unknown' as const,
            reason: 'permission-denied' as const,
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'permission-denied' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'permission-denied' });
  });

  it('accepts the same runtime facts with different fresh observation times', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return {
            status: 'response' as const,
            body: runtimeEnvelope({
              observedAt: reads === 1
                ? '2026-07-22T23:59:59.000Z'
                : observedAt,
            }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(reads).toBe(2);
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'conformant', observedAt });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'conformant' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'conformant' });
  });

  it('rejects a fresh terminal observation that predates the initial observation', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return {
            status: 'response' as const,
            body: runtimeEnvelope({
              observedAt: reads === 1
                ? '2026-07-22T23:59:59.000Z'
                : '2026-07-22T23:59:58.000Z',
            }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision')?.summary)
      .toContain('snapshot-changed');
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it('re-reads runtime diagnostics at the terminal barrier and rejects a changed revision', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return {
            status: 'response' as const,
            body: runtimeEnvelope({
              workerDeploymentId: reads === 1 ? 'deployment-1' : 'deployment-2',
            }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(reads).toBe(2);
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it.each([
    { description: 'repository ID differs', repositoryId: 8, repositoryFullName: 'splrad/example' },
    { description: 'repository full name differs', repositoryId: 7, repositoryFullName: 'splrad/other' },
  ])('rejects known runtime diagnostics when $description', async ({ repositoryId, repositoryFullName }) => {
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          return {
            status: 'response' as const,
            body: runtimeEnvelope({ repositoryId, repositoryFullName }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown', observedAt });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'unknown', observedAt });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown', observedAt });
  });

  it('rejects a runtime routed to the wrong ring and any pending DLQ', async () => {
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          return {
            status: 'response' as const,
            body: runtimeEnvelope({
              environment: 'production',
              deadLetterQueue: 'pending',
            }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'drift' });
  });

  it('rejects stale runtime and UI attestations instead of reusing historical health', async () => {
    const staleAt = '2026-07-22T23:44:59.999Z';
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          return {
            status: 'response' as const,
            body: runtimeEnvelope({ observedAt: staleAt }),
          };
        },
      },
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation(),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt: staleAt,
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'actions.execution-protections'))
      .toMatchObject({ state: 'unknown' });
  });

  it('rejects the whole runtime result when an initial stale snapshot becomes fresh', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return {
            status: 'response' as const,
            body: runtimeEnvelope({
              observedAt: reads === 1 ? '2026-07-22T23:44:59.999Z' : observedAt,
            }),
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it('preserves the terminal unknown reason when known runtime becomes unavailable', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return reads === 1
            ? { status: 'response' as const, body: runtimeEnvelope() }
            : { status: 'unknown' as const, reason: 'transport-error' as const };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision')?.summary)
      .toContain('transport-error');
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it('reports snapshot-changed when unknown runtime becomes known during the run', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return reads === 1
            ? { status: 'unknown' as const, reason: 'runtime-metadata-unavailable' as const }
            : { status: 'response' as const, body: runtimeEnvelope() };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision')?.summary)
      .toContain('snapshot-changed');
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it('fails closed on malformed runtime responses without throwing', async () => {
    let reads = 0;
    const current = await setup({
      runtimeDiagnostics: {
        async read() {
          reads += 1;
          return {
            status: 'response' as const,
            body: { schemaVersion: 1 },
          };
        },
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(reads).toBe(2);
    expect(report.findings.find((item) => item.code === 'runtime.snapshot-stability'))
      .toMatchObject({ state: 'unknown' });
    expect(report.findings.find((item) => item.code === 'runtime.control-revision')?.summary)
      .toContain('invalid-response');
    expect(report.findings.find((item) => item.code === 'runtime.central-components'))
      .toMatchObject({ state: 'unknown' });
  });

  it('accepts only fresh, owner-verified execution-protection attestations bound to the frozen inventory', async () => {
    const bound = await setup({
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation(),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt,
        },
      },
    });
    const boundReport = await runDoctor(bound.dependencies, { owner: 'splrad', repository: 'example' });
    expect(boundReport.findings.find((item) => item.code === 'actions.execution-protections'))
      .toMatchObject({ state: 'conformant' });
    expect(boundReport.findings.find((item) => item.code === 'actions.execution-protections')?.summary)
      .toContain('GitHub SSH signing key 已验证');

    const wrongTarget = await setup({
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation({ repositoryId: 8 }),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt,
        },
      },
    });
    const wrongTargetReport = await runDoctor(wrongTarget.dependencies, { owner: 'splrad', repository: 'example' });
    expect(wrongTargetReport.findings.find((item) => item.code === 'actions.execution-protections'))
      .toMatchObject({ state: 'drift' });
    expect(wrongTargetReport.findings.find((item) => item.code === 'actions.execution-protections')?.summary)
      .toContain('未绑定');

    const evaluate = await setup({
      actionsExecutionProtections: {
        status: 'known',
        value: actionsExecutionAttestation({ mode: 'evaluate' }),
        evidence: {
          source: 'github-ui-attestation',
          endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
          observedAt,
        },
      },
    });
    const evaluateReport = await runDoctor(evaluate.dependencies, { owner: 'splrad', repository: 'example' });
    expect(evaluateReport.findings.find((item) => item.code === 'actions.execution-protections'))
      .toMatchObject({ state: 'drift' });
  });

  it('keeps repository-copy and non-organization Matrix evidence actionable when definitions are unreadable', async () => {
    const rulesetPath = '/orgs/splrad/rulesets';
    const legacyCopy = {
      id: 701,
      name: 'SPLRAD Steward',
      source_type: 'Repository',
      source: 'splrad/example',
      enforcement: 'active',
    };
    const repositoryMatrix = {
      type: 'required_status_checks',
      ruleset_id: 701,
      ruleset_source_type: 'Repository',
      ruleset_source: 'splrad/example',
      parameters: { required_status_checks: [{ context: 'PR Validation Matrix Gate' }] },
    };
    const current = await setup({
      organizationOverrides: {
        [rulesetPath]: new GitHubApiError({ status: 403, method: 'GET', path: rulesetPath, message: 'Forbidden' }),
      },
      repositoryOverrides: {
        '/repos/splrad/example/rulesets': [...applicableRulesetSummaries('active'), legacyCopy],
        '/repos/splrad/example/rules/branches/main': [...effectiveRules('active'), repositoryMatrix],
      },
    });
    const report = await runDoctor(current.dependencies, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'organization.rulesets.repository-copies'))
      .toMatchObject({ state: 'drift' });
    expect(report.findings.find((item) => item.code === 'organization.rules.matrix-source'))
      .toMatchObject({ state: 'drift' });
  });
});
