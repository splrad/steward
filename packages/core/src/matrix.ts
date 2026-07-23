import { hashJson } from './fingerprint.js';

export type MatrixEvidenceState = 'passed' | 'pending' | 'failed' | 'missing' | 'recoverable' | 'invalid';
export type MatrixMode = 'observe' | 'repair' | 'enforce';
export type MatrixScope = 'full' | 'gate-only';

export interface MatrixTargetConfiguration {
  id: string;
  name: string;
  checkNames: string[];
  workflowName: string;
  workflowFile: string;
  legacyWorkflowFiles?: string[];
  jobName: string;
  group: 'full' | 'gate';
  acceptableConclusions: string[];
  trustedEvents?: string[];
  baseBranches?: string[];
  required?: boolean;
  repairable: boolean;
  fingerprintBound?: boolean;
  customCheck?: boolean;
}

export interface MatrixConfiguration {
  gateName: string;
  targets: MatrixTargetConfiguration[];
}

export const STEWARD_MATRIX_CONFIGURATION: MatrixConfiguration = {
  gateName: 'PR Validation Matrix Gate',
  targets: [
    {
      id: 'pr-classification', name: 'PR Classification Gate', checkNames: ['PR Classification Gate'],
      workflowName: 'PR Classification', workflowFile: 'pr-classification.yml', jobName: 'Classify Pull Request',
      group: 'full', acceptableConclusions: ['success'], repairable: true, fingerprintBound: true, customCheck: true,
    },
    {
      id: 'dco-signoff', name: 'DCO Sign-off Advisory', checkNames: ['DCO Sign-off Advisory'],
      workflowName: 'DCO Sign-off Advisory', workflowFile: 'dco-advisory.yml', legacyWorkflowFiles: ['dco-check.yml'],
      jobName: 'DCO Sign-off Advisory', group: 'full', acceptableConclusions: ['success'], required: false,
      repairable: true,
    },
    {
      id: 'main-authorization', name: 'PR Governance / Main Authorization Gate', checkNames: ['Main Authorization Gate'],
      workflowName: 'PR Governance', workflowFile: 'pr-governance.yml', jobName: 'Main Authorization Gate',
      group: 'gate', acceptableConclusions: ['success'], repairable: true, fingerprintBound: true, customCheck: true,
    },
    {
      id: 'copilot-review-gate', name: 'Copilot Code Review Gate', checkNames: ['Copilot Code Review Gate'],
      workflowName: 'PR Governance', workflowFile: 'pr-governance.yml', jobName: 'Update Copilot Review Check',
      group: 'gate', acceptableConclusions: ['success'], repairable: true, customCheck: true,
    },
  ],
};

export interface StewardMatrixFeatureConfiguration {
  readonly classification: boolean;
  readonly dcoAdvisory: boolean;
  readonly governance: boolean;
  readonly copilotReview: boolean;
}

const targetFeatures: Readonly<Record<string, keyof StewardMatrixFeatureConfiguration>> = {
  'pr-classification': 'classification',
  'dco-signoff': 'dcoAdvisory',
  'main-authorization': 'governance',
  'copilot-review-gate': 'copilotReview',
};

export function enabledStewardMatrixConfiguration(
  features: StewardMatrixFeatureConfiguration,
): MatrixConfiguration {
  return {
    gateName: STEWARD_MATRIX_CONFIGURATION.gateName,
    targets: STEWARD_MATRIX_CONFIGURATION.targets.filter((target) => {
      const feature = targetFeatures[target.id];
      if (!feature) throw new Error(`Matrix target ${target.id} has no feature mapping`);
      return features[feature] === true;
    }),
  };
}

export interface MatrixCheckRun {
  id?: number;
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  external_id?: string;
  details_url?: string;
  html_url?: string;
  started_at?: string;
  created_at?: string;
  app?: { id?: number; slug?: string } | null;
}

export interface MatrixWorkflowRun {
  id?: number;
  name?: string;
  display_title?: string;
  path?: string;
  event?: string;
  head_sha?: string;
  created_at?: string;
  html_url?: string;
  pull_requests?: { number?: number }[];
  jobs?: MatrixCheckRun[];
}

export interface MatrixPull {
  number: number;
  state?: string;
  base: { ref: string; sha?: string };
  head: { ref?: string; sha: string };
}

export interface MatrixIdentityInput {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  checkId: string;
  configDigest: string;
  inputDigest: string;
}

export interface MatrixTargetResult extends MatrixTargetConfiguration {
  checkRun: MatrixCheckRun | null;
  state: MatrixEvidenceState;
  conclusion: string;
  status: string;
  url: string;
  required: boolean;
}

export interface MatrixLiveEvidenceProjection {
  repository_id: number;
  pull_request: {
    number: number;
    state: string;
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
  };
  config_digest: string;
  scope: 'full';
  pull_fingerprint_digest: string;
  targets: {
    id: string;
    state: MatrixEvidenceState;
    required: boolean;
    check: {
      id: number;
      name: string;
      head_sha: string;
      app: { id: number; slug: string };
      external_id: string;
      status: string;
      conclusion: string;
    } | null;
  }[];
}

export interface MatrixLiveEvidence {
  projection: MatrixLiveEvidenceProjection;
  value: string;
}

export interface MatrixEvaluation {
  state: 'passed' | 'pending' | 'failed';
  targets: MatrixTargetResult[];
  pending: MatrixTargetResult[];
  blocking: MatrixTargetResult[];
  passed: boolean;
}

export interface MatrixTrustContext {
  appId: number;
  appSlug: string;
  repositoryId: number;
  configDigest: string;
  inputDigest: string;
  workflowRuns?: readonly MatrixWorkflowRun[];
  allowLegacy?: boolean;
}

export interface MatrixRepairTarget {
  id: string;
  name: string;
  checkName: string;
  workflowName: string;
  jobName: string;
  customCheck: boolean;
  acceptableConclusions: string[];
}

export type MatrixRepairPlan =
  | {
    target: string;
    targets: MatrixRepairTarget[];
    action: 'dispatch-workflow';
    workflowFile: string;
    ref: string;
    inputs: { prNumber: string; headSha: string; governanceScope?: 'all' | 'main-authorization' | 'copilot-review' };
    reason: 'missing' | 'copilot-review-refresh' | 'copilot-state-refresh' | 'review-state-refresh';
  }
  | { target: string; action: 'rerun-job'; jobId: number; reason: MatrixEvidenceState }
  | { target: string; action: 'manual'; reason: 'workflow-job-not-found' };

export interface MatrixProxyCompletionPlan {
  target: string;
  action: 'complete-proxy-check';
  checkRunId: number;
  conclusion: 'success' | 'failure';
  sourceJobId: number;
  sourceUrl: string;
}

const pendingCheckStatuses = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

function latestCheck(checks: readonly MatrixCheckRun[]): MatrixCheckRun | undefined {
  return checks
    .filter((check) => Number.isSafeInteger(check.id) && Number(check.id) > 0)
    .reduce<MatrixCheckRun | undefined>((latest, candidate) => (
      !latest || Number(candidate.id) > Number(latest.id) ? candidate : latest
    ), undefined);
}

function validCheckRunId(run: MatrixCheckRun): boolean {
  return Number.isSafeInteger(run.id) && Number(run.id) > 0;
}

function invalidGenerationCheck(checks: readonly MatrixCheckRun[]): MatrixCheckRun | undefined {
  const seen = new Set<number>();
  for (const check of checks) {
    if (!validCheckRunId(check)) return check;
    const id = Number(check.id);
    if (seen.has(id)) return check;
    seen.add(id);
  }
  return undefined;
}

export function stewardCheckExternalId(input: MatrixIdentityInput): string {
  return [
    'splrad-steward:v1',
    `repo:${input.repositoryId}`,
    `pr:${input.prNumber}`,
    `head:${input.headSha}`,
    `check:${input.checkId}`,
    `config:${input.configDigest}`,
    `input:${input.inputDigest}`,
  ].join(':');
}

export function parseStewardCheckExternalId(value: unknown): MatrixIdentityInput | null {
  const match = String(value ?? '').match(
    /^splrad-steward:v1:repo:(\d+):pr:(\d+):head:([a-f0-9]{40}):check:([a-z0-9-]+):config:([a-f0-9]{64}):input:([a-f0-9]{64})$/i,
  );
  if (!match) return null;
  return {
    repositoryId: Number(match[1]),
    prNumber: Number(match[2]),
    headSha: String(match[3]).toLowerCase(),
    checkId: String(match[4]).toLowerCase(),
    configDigest: String(match[5]).toLowerCase(),
    inputDigest: String(match[6]).toLowerCase(),
  };
}

/**
 * Projects the exact trusted child-Check snapshot used by the full Matrix gate.
 * Callers must pass target results produced by a full-scope evaluateMatrix call
 * with a trust context. The final Matrix Check is excluded to avoid a digest cycle.
 */
export function projectMatrixLiveEvidence(input: {
  repositoryId: number;
  pull: MatrixPull;
  configDigest: string;
  pullFingerprintDigest: string;
  targets: readonly MatrixTargetResult[];
}): MatrixLiveEvidenceProjection {
  const targets = input.targets
    .filter((target) => (
      target.id !== 'validation-matrix'
      && parseStewardCheckExternalId(target.checkRun?.external_id)?.checkId !== 'validation-matrix'
    ))
    .map((target) => ({
      id: target.id,
      state: target.state,
      required: target.required,
      check: target.checkRun ? {
        id: Number(target.checkRun.id ?? 0),
        name: String(target.checkRun.name ?? ''),
        head_sha: String(target.checkRun.head_sha ?? '').toLowerCase(),
        app: {
          id: Number(target.checkRun.app?.id ?? 0),
          slug: String(target.checkRun.app?.slug ?? '').toLowerCase(),
        },
        external_id: String(target.checkRun.external_id ?? ''),
        status: String(target.checkRun.status ?? ''),
        conclusion: String(target.checkRun.conclusion ?? ''),
      } : null,
    }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    repository_id: input.repositoryId,
    pull_request: {
      number: input.pull.number,
      state: String(input.pull.state ?? '').toLowerCase(),
      base: {
        ref: String(input.pull.base.ref ?? ''),
        sha: String(input.pull.base.sha ?? '').toLowerCase(),
      },
      head: {
        ref: String(input.pull.head.ref ?? ''),
        sha: String(input.pull.head.sha ?? '').toLowerCase(),
      },
    },
    config_digest: input.configDigest.toLowerCase(),
    scope: 'full',
    pull_fingerprint_digest: input.pullFingerprintDigest.toLowerCase(),
    targets,
  };
}

export async function matrixLiveEvidenceDigest(input: {
  repositoryId: number;
  pull: MatrixPull;
  configDigest: string;
  pullFingerprintDigest: string;
  targets: readonly MatrixTargetResult[];
}): Promise<MatrixLiveEvidence> {
  const projection = projectMatrixLiveEvidence(input);
  return { projection, value: await hashJson(projection) };
}

export function legacyProxyExternalId(
  target: Pick<MatrixTargetConfiguration, 'id'>,
  pull: Pick<MatrixPull, 'number' | 'head'>,
  inputDigest: string,
): string {
  return `matrix-proxy:${target.id}:pr:${pull.number}:head:${pull.head.sha}:fingerprint:${inputDigest}`;
}

function legacyDirectExternalId(
  target: MatrixTargetConfiguration,
  pull: MatrixPull,
  inputDigest: string,
): string | null {
  if (target.id === 'pr-classification') return `classification:pr:${pull.number}:fingerprint:${inputDigest}`;
  if (target.id === 'copilot-review-gate') return `pr-${pull.number}-${pull.head.sha}`;
  return null;
}

function workflowRunPath(run: MatrixWorkflowRun | undefined): string {
  return String(run?.path ?? '').split('@')[0]?.replace(/\\/g, '/').toLowerCase() ?? '';
}

export function workflowRunMatchesTarget(run: MatrixWorkflowRun | undefined, target: MatrixTargetConfiguration): boolean {
  const trustedEvents = target.trustedEvents ?? ['pull_request_target', 'workflow_dispatch'];
  const trustedPaths = [target.workflowFile, ...(target.legacyWorkflowFiles ?? [])]
    .map((file) => `.github/workflows/${file.toLowerCase()}`);
  return trustedPaths.includes(workflowRunPath(run))
    && trustedEvents.includes(String(run?.event ?? ''));
}

function workflowRunPullRequestNumber(run: MatrixWorkflowRun | undefined): number {
  return Number(run?.pull_requests?.[0]?.number ?? 0);
}

function parseRunTitle(run: MatrixWorkflowRun | undefined): { prNumber: number; headSha: string } | null {
  const match = String(run?.display_title ?? run?.name ?? '').match(/\x23(\d+)\s*\/\s*([a-f0-9]{40})(?:\s*\/|$)/i);
  return match ? { prNumber: Number(match[1]), headSha: String(match[2]).toLowerCase() } : null;
}

function legacyWorkflowRunMatchesPull(run: MatrixWorkflowRun | undefined, pull: MatrixPull): boolean {
  const parsed = parseRunTitle(run);
  const prNumber = workflowRunPullRequestNumber(run) || parsed?.prNumber || 0;
  const headSha = parsed?.headSha || String(run?.head_sha ?? '').toLowerCase();
  return prNumber === pull.number && headSha === pull.head.sha.toLowerCase();
}

export function workflowRunId(check: { details_url?: string | null }): number {
  const runId = Number(String(check.details_url ?? '')
    .match(/\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:\?.*)?$/)?.[1] ?? 0);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : 0;
}

export function isTrustedMatrixCheck(input: {
  run: MatrixCheckRun;
  target: MatrixTargetConfiguration;
  pull: MatrixPull;
  trust: MatrixTrustContext;
}): boolean {
  const { run, target, pull, trust } = input;
  if (!pull.number || !pull.head.sha) return false;
  if (String(run.head_sha ?? '').toLowerCase() !== pull.head.sha.toLowerCase()) return false;
  if (run.app?.id === trust.appId && String(run.app?.slug ?? '') === trust.appSlug) {
    const identity = parseStewardCheckExternalId(run.external_id);
    if (target.id === 'pr-classification'
      && identity?.checkId === 'pr-class-lease'
      && identity.repositoryId === trust.repositoryId
      && identity.prNumber === pull.number
      && identity.headSha === pull.head.sha.toLowerCase()
      && identity.configDigest === '0'.repeat(64)) return true;
    const expected = stewardCheckExternalId({
      repositoryId: trust.repositoryId,
      prNumber: pull.number,
      headSha: pull.head.sha,
      checkId: target.id,
      configDigest: trust.configDigest,
      inputDigest: trust.inputDigest,
    });
    if (run.external_id === expected) return true;
    if (trust.allowLegacy === false) return false;
    const legacyDirectId = legacyDirectExternalId(target, pull, trust.inputDigest);
    return run.external_id === legacyProxyExternalId(target, pull, trust.inputDigest)
      || (legacyDirectId !== null && run.external_id === legacyDirectId);
  }
  if (String(run.app?.slug ?? '') !== 'github-actions' || target.customCheck) return false;
  if (trust.allowLegacy === false) return false;
  const evidence = trust.workflowRuns?.find((candidate) => candidate.id === workflowRunId(run));
  return workflowRunMatchesTarget(evidence, target) && legacyWorkflowRunMatchesPull(evidence, pull);
}

export function matrixCheckState(
  run: MatrixCheckRun | null | undefined,
  target: Pick<MatrixTargetConfiguration, 'acceptableConclusions'>,
): MatrixEvidenceState {
  if (!run) return 'missing';
  if (!validCheckRunId(run)) return 'invalid';
  const status = String(run.status ?? '');
  const conclusion = String(run.conclusion ?? '');
  if (pendingCheckStatuses.has(status)) return conclusion ? 'invalid' : 'pending';
  if (status !== 'completed' || !conclusion) return 'invalid';
  if ((target.acceptableConclusions.length ? target.acceptableConclusions : ['success']).includes(conclusion)) return 'passed';
  if (['cancelled', 'timed_out', 'skipped', 'action_required', 'stale', 'startup_failure'].includes(conclusion)) return 'recoverable';
  return 'failed';
}

function targetApplies(target: MatrixTargetConfiguration, scope: MatrixScope, pull: MatrixPull): boolean {
  if (target.baseBranches?.length && !target.baseBranches.includes(pull.base.ref)) return false;
  if (scope === 'gate-only') return target.group === 'gate';
  return target.group === 'full' || target.group === 'gate';
}

function classificationLeaseMatchesTarget(
  target: MatrixTargetResult | MatrixTargetConfiguration,
  run: MatrixCheckRun,
  pull: MatrixPull,
): boolean {
  const identity = parseStewardCheckExternalId(run.external_id);
  return target.id === 'pr-classification'
    && identity?.checkId === 'pr-class-lease'
    && identity.prNumber === pull.number
    && identity.headSha === pull.head.sha.toLowerCase();
}

function proxyMatchesTarget(target: MatrixTargetResult | MatrixTargetConfiguration, run: MatrixCheckRun, pull: MatrixPull): boolean {
  const externalId = String(run.external_id ?? '');
  const identity = parseStewardCheckExternalId(externalId);
  return identity
    ? identity.checkId === target.id
      && identity.prNumber === pull.number
      && identity.headSha === pull.head.sha.toLowerCase()
    : externalId.startsWith(`matrix-proxy:${target.id}:pr:${pull.number}:head:${pull.head.sha}:fingerprint:`);
}

export function evaluateMatrix(input: {
  config: MatrixConfiguration;
  checkRuns: readonly MatrixCheckRun[];
  scope: MatrixScope;
  pull: MatrixPull;
  targetOverrides?: Readonly<Record<string, Partial<Pick<MatrixTargetResult, 'state' | 'conclusion' | 'status' | 'url'>>>>;
  trust?: MatrixTrustContext;
}): MatrixEvaluation {
  const targets = input.config.targets.filter((target) => targetApplies(target, input.scope, input.pull)).map((target) => {
    const matches = input.checkRuns.filter((run) => {
      if (!target.checkNames.includes(String(run.name ?? ''))) return false;
      const externalId = String(run.external_id ?? '');
      if ((parseStewardCheckExternalId(externalId) || externalId.startsWith('matrix-proxy:'))
        && !proxyMatchesTarget(target, run, input.pull)
        && !classificationLeaseMatchesTarget(target, run, input.pull)) return false;
      return !input.trust || isTrustedMatrixCheck({ run, target, pull: input.pull, trust: input.trust });
    });
    const active = matches.filter((run) => (
      proxyMatchesTarget(target, run, input.pull)
      && pendingCheckStatuses.has(String(run.status ?? ''))
    ));
    const invalidCheck = invalidGenerationCheck(matches);
    const checkRun = invalidCheck ?? (target.id === 'pr-classification'
      ? latestCheck(matches)
      : latestCheck(active.length ? active : matches)) ?? null;
    const leaseBarrier = Boolean(checkRun && classificationLeaseMatchesTarget(target, checkRun, input.pull));
    const override = invalidCheck ? undefined : input.targetOverrides?.[target.id];
    return {
      ...target,
      checkRun,
      state: invalidCheck ? 'invalid' : override?.state ?? (leaseBarrier
        ? pendingCheckStatuses.has(String(checkRun?.status ?? '')) ? 'pending' : 'failed'
        : matrixCheckState(checkRun, target)),
      conclusion: override?.conclusion ?? String(checkRun?.conclusion ?? ''),
      status: override?.status ?? String(checkRun?.status ?? ''),
      url: override?.url ?? String(checkRun?.html_url ?? checkRun?.details_url ?? ''),
      required: target.required !== false,
    } satisfies MatrixTargetResult;
  });
  const blocking = targets.filter((target) => target.required && ['missing', 'recoverable', 'failed'].includes(target.state));
  const pending = targets.filter((target) => target.required && ['pending', 'invalid'].includes(target.state));
  return {
    state: pending.length ? 'pending' : blocking.length ? 'failed' : 'passed',
    targets,
    pending,
    blocking,
    passed: !pending.length && !blocking.length,
  };
}

export function matrixConclusion(matrix: MatrixEvaluation): {
  state: MatrixEvaluation['state'];
  status: 'completed' | 'in_progress';
  conclusion?: 'success' | 'failure';
  presentation: 'matrix.waiting' | 'matrix.passed' | 'matrix.failed';
} {
  if (matrix.state === 'pending') return { state: 'pending', status: 'in_progress', presentation: 'matrix.waiting' };
  if (matrix.state === 'passed') {
    return { state: 'passed', status: 'completed', conclusion: 'success', presentation: 'matrix.passed' };
  }
  return { state: 'failed', status: 'completed', conclusion: 'failure', presentation: 'matrix.failed' };
}

function activeProxy(target: MatrixTargetResult, pull: MatrixPull): boolean {
  return pendingCheckStatuses.has(String(target.checkRun?.status ?? ''))
    && Boolean(target.checkRun)
    && proxyMatchesTarget(target, target.checkRun!, pull);
}

function workflowJobMatches(candidateName: unknown, targetName: string): boolean {
  const candidate = String(candidateName ?? '');
  if (candidate === targetName) return true;
  const suffix = ` / ${targetName}`;
  if (!candidate.endsWith(suffix)) return false;
  const callerJob = candidate.slice(0, -suffix.length);
  return callerJob.length > 0
    && callerJob === callerJob.trim()
    && !callerJob.includes('/')
    && !/[\r\n]/.test(callerJob);
}

function latestWorkflowJob(
  runs: readonly MatrixWorkflowRun[],
  target: MatrixTargetConfiguration,
  pull: MatrixPull,
): { run: MatrixWorkflowRun; job: MatrixCheckRun } | null {
  const matchingRuns = runs.filter((run) => (
    workflowRunMatchesTarget(run, target) && legacyWorkflowRunMatchesPull(run, pull)
  )).sort((left, right) => (
    String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
      || Number(right.id ?? 0) - Number(left.id ?? 0)
  ));
  const run = matchingRuns[0];
  const job = run?.jobs?.find((candidate) => workflowJobMatches(candidate.name, target.jobName));
  return run && job ? { run, job } : null;
}

function workflowJobForProxy(
  runs: readonly MatrixWorkflowRun[],
  target: MatrixTargetConfiguration,
  pull: MatrixPull,
  proxy: MatrixCheckRun,
): { run: MatrixWorkflowRun; job: MatrixCheckRun } | null {
  const recordedRunId = workflowRunId(proxy);
  if (!recordedRunId) return latestWorkflowJob(runs, target, pull);
  const run = runs.find((candidate) => Number(candidate.id ?? 0) === recordedRunId);
  if (!run || !workflowRunMatchesTarget(run, target) || !legacyWorkflowRunMatchesPull(run, pull)) return null;
  const job = run.jobs?.find((candidate) => workflowJobMatches(candidate.name, target.jobName));
  return job ? { run, job } : null;
}

export function planMatrixRepairs(input: {
  targets: readonly MatrixTargetResult[];
  workflowRuns: readonly MatrixWorkflowRun[];
  mode: MatrixMode;
  pull: MatrixPull;
  eventSignal?: 'none' | 'copilot-review' | 'review-state' | 'manual';
}): MatrixRepairPlan[] {
  if (!['repair', 'enforce'].includes(input.mode)) return [];
  const eventSignal = input.eventSignal ?? 'none';
  const dispatches = new Map<string, Extract<MatrixRepairPlan, { action: 'dispatch-workflow' }>>();
  const remaining: MatrixRepairPlan[] = [];
  for (const target of input.targets) {
    if (!target.repairable || activeProxy(target, input.pull)) continue;
    const refreshPendingCopilot = target.id === 'copilot-review-gate'
      && target.state === 'pending' && eventSignal === 'copilot-review';
    const refreshFailedCopilot = target.id === 'copilot-review-gate'
      && target.state === 'failed' && eventSignal === 'manual';
    const refreshReviewState = target.workflowFile === 'pr-governance.yml'
      && ['main-authorization', 'main-gate', 'copilot-review-gate'].includes(target.id)
      && eventSignal === 'review-state';
    if (!['missing', 'recoverable'].includes(target.state)
      && !refreshPendingCopilot && !refreshFailedCopilot && !refreshReviewState) continue;
    if (target.checkRun && pendingCheckStatuses.has(String(target.checkRun.status ?? ''))
      && !refreshPendingCopilot && !refreshReviewState) continue;
    if (target.state === 'missing' || refreshPendingCopilot || refreshFailedCopilot || refreshReviewState) {
      let plan = dispatches.get(target.workflowFile);
      if (!plan) {
        plan = {
          target: target.id,
          targets: [],
          action: 'dispatch-workflow',
          workflowFile: target.workflowFile,
          ref: input.pull.base.ref,
          inputs: { prNumber: String(input.pull.number), headSha: input.pull.head.sha },
          reason: refreshPendingCopilot
            ? 'copilot-review-refresh'
            : refreshFailedCopilot ? 'copilot-state-refresh' : refreshReviewState ? 'review-state-refresh' : 'missing',
        };
        dispatches.set(target.workflowFile, plan);
      }
      plan.targets.push({
        id: target.id,
        name: target.name,
        checkName: target.checkNames[0] ?? target.name,
        workflowName: target.workflowName,
        jobName: target.jobName,
        customCheck: Boolean(target.customCheck),
        acceptableConclusions: target.acceptableConclusions.length ? target.acceptableConclusions : ['success'],
      });
      continue;
    }
    const evidence = latestWorkflowJob(input.workflowRuns, target, input.pull);
    remaining.push(evidence?.job.id
      ? { target: target.id, action: 'rerun-job', jobId: evidence.job.id, reason: target.state }
      : { target: target.id, action: 'manual', reason: 'workflow-job-not-found' });
  }
  for (const plan of dispatches.values()) {
    if (plan.workflowFile !== 'pr-governance.yml') continue;
    const ids = new Set(plan.targets.map((target) => target.id));
    plan.inputs.governanceScope = ids.size === 1 && ids.has('copilot-review-gate')
      ? 'copilot-review'
      : ids.size === 1 && (ids.has('main-authorization') || ids.has('main-gate'))
        ? 'main-authorization'
        : 'all';
  }
  return [...dispatches.values(), ...remaining];
}

export function planProxyCompletions(input: {
  workflowRuns: readonly MatrixWorkflowRun[];
  targets: readonly MatrixTargetResult[];
  checkRuns: readonly MatrixCheckRun[];
  pull: MatrixPull;
  trust: MatrixTrustContext;
}): MatrixProxyCompletionPlan[] {
  const plans: MatrixProxyCompletionPlan[] = [];
  for (const target of input.targets) {
    if (!activeProxy(target, input.pull)
      || !target.checkRun
      || !isTrustedMatrixCheck({ run: target.checkRun, target, pull: input.pull, trust: input.trust })) continue;
    const proxyExternalId = String(target.checkRun.external_id ?? '');
    const activeIdenticalProxies = input.checkRuns.filter((run) => (
      target.checkNames.includes(String(run.name ?? ''))
      && run.external_id === proxyExternalId
      && pendingCheckStatuses.has(String(run.status ?? ''))
      && proxyMatchesTarget(target, run, input.pull)
      && isTrustedMatrixCheck({ run, target, pull: input.pull, trust: input.trust })
    ));
    for (const proxy of activeIdenticalProxies) {
      const evidence = workflowJobForProxy(input.workflowRuns, target, input.pull, proxy);
      const sourceJobId = evidence?.job.id;
      const sourceConclusion = evidence?.job.conclusion;
      if (!sourceJobId || evidence?.job.status !== 'completed' || !sourceConclusion) continue;
      const job = evidence.job;
      plans.push({
        target: target.id,
        action: 'complete-proxy-check',
        checkRunId: Number(proxy.id),
        conclusion: (target.acceptableConclusions.length ? target.acceptableConclusions : ['success'])
          .includes(sourceConclusion) ? 'success' : 'failure',
        sourceJobId,
        sourceUrl: String(job.html_url ?? job.details_url ?? evidence.run.html_url ?? ''),
      });
    }
  }
  const uniquePlans = new Map<number, MatrixProxyCompletionPlan>();
  for (const plan of plans) {
    if (plan.checkRunId > 0 && !uniquePlans.has(plan.checkRunId)) uniquePlans.set(plan.checkRunId, plan);
  }
  return [...uniquePlans.values()];
}

const dispatchActions: Readonly<Record<string, readonly string[]>> = {
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request_review_comment: ['created', 'edited', 'deleted'],
  pull_request_review_thread: ['resolved', 'unresolved'],
};

export function validateReviewDispatch(input: {
  repository: { id: number; fullName: string; defaultBranch: string };
  payload: {
    repositoryId: number;
    repositoryFullName: string;
    prNumber: number;
    headSha: string;
    sourceEvent: string;
    action: string;
    deliveryId: string;
  };
  pull: MatrixPull & { state: string };
}): { state: 'passed' | 'failed' | 'ignored'; signal: 'review-state' | 'none'; reason: string } {
  const allowed = dispatchActions[input.payload.sourceEvent]?.includes(input.payload.action) ?? false;
  if (!allowed) return { state: 'ignored', signal: 'none', reason: 'unsupported-review-signal' };
  if (!input.payload.deliveryId) return { state: 'failed', signal: 'none', reason: 'missing-delivery-id' };
  if (input.repository.id !== input.payload.repositoryId) {
    return { state: 'failed', signal: 'none', reason: 'repository-id-mismatch' };
  }
  if (input.repository.fullName.toLowerCase() !== input.payload.repositoryFullName.toLowerCase()) {
    return { state: 'failed', signal: 'none', reason: 'repository-name-mismatch' };
  }
  if (input.pull.number !== input.payload.prNumber) return { state: 'ignored', signal: 'none', reason: 'pr-mismatch' };
  if (input.pull.state !== 'open') return { state: 'ignored', signal: 'none', reason: 'pr-not-open' };
  if (input.pull.base.ref !== input.repository.defaultBranch) return { state: 'ignored', signal: 'none', reason: 'base-mismatch' };
  if (input.pull.head.sha.toLowerCase() !== input.payload.headSha.toLowerCase()) {
    return { state: 'ignored', signal: 'none', reason: 'stale-head' };
  }
  return { state: 'passed', signal: 'review-state', reason: 'trusted-review-signal' };
}
