export type MatrixEvidenceState = 'passed' | 'pending' | 'failed' | 'missing' | 'recoverable';
export type MatrixMode = 'observe' | 'repair' | 'enforce';
export type MatrixScope = 'full' | 'gate-only';

export interface MatrixTargetConfiguration {
  id: string;
  name: string;
  checkNames: string[];
  workflowName: string;
  workflowFile: string;
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

export interface MatrixCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  external_id?: string;
  details_url?: string;
  html_url?: string;
  started_at?: string;
  created_at?: string;
  app?: { slug?: string } | null;
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
  base: { ref: string };
  head: { sha: string };
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

export interface MatrixEvaluation {
  state: 'passed' | 'pending' | 'failed';
  targets: MatrixTargetResult[];
  pending: MatrixTargetResult[];
  blocking: MatrixTargetResult[];
  passed: boolean;
}

export interface MatrixTrustContext {
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

function compareTimestamp(left: MatrixCheckRun, right: MatrixCheckRun): number {
  return String(left.started_at ?? left.created_at ?? '').localeCompare(String(right.started_at ?? right.created_at ?? ''));
}

function latestCheck(checks: readonly MatrixCheckRun[]): MatrixCheckRun | undefined {
  return [...checks].sort(compareTimestamp).at(-1);
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

function workflowRunMatchesTarget(run: MatrixWorkflowRun | undefined, target: MatrixTargetConfiguration): boolean {
  const trustedEvents = target.trustedEvents ?? ['pull_request_target', 'workflow_dispatch'];
  return workflowRunPath(run) === `.github/workflows/${target.workflowFile.toLowerCase()}`
    && trustedEvents.includes(String(run?.event ?? ''));
}

function workflowRunPullRequestNumber(run: MatrixWorkflowRun | undefined): number {
  return Number(run?.pull_requests?.[0]?.number ?? 0);
}

function parseRunTitle(run: MatrixWorkflowRun | undefined): { prNumber: number; headSha: string } | null {
  const match = String(run?.name ?? run?.display_title ?? '').match(/\x23(\d+)\s*\/\s*([a-f0-9]{40})(?:\s*\/|$)/i);
  return match ? { prNumber: Number(match[1]), headSha: String(match[2]).toLowerCase() } : null;
}

function legacyWorkflowRunMatchesPull(run: MatrixWorkflowRun | undefined, pull: MatrixPull): boolean {
  const parsed = parseRunTitle(run);
  const prNumber = workflowRunPullRequestNumber(run) || parsed?.prNumber || 0;
  const headSha = parsed?.headSha || String(run?.head_sha ?? '').toLowerCase();
  return prNumber === pull.number && headSha === pull.head.sha.toLowerCase();
}

function workflowRunId(check: MatrixCheckRun): number {
  return Number(String(check.details_url ?? '').match(/\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:\?.*)?$/)?.[1] ?? 0);
}

export function isTrustedMatrixCheck(input: {
  run: MatrixCheckRun;
  target: MatrixTargetConfiguration;
  pull: MatrixPull;
  trust: MatrixTrustContext;
}): boolean {
  const { run, target, pull, trust } = input;
  if (!pull.number || !pull.head.sha) return false;
  if (String(run.app?.slug ?? '') === trust.appSlug) {
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
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(String(run.status ?? ''))) return 'pending';
  const conclusion = String(run.conclusion ?? '');
  if ((target.acceptableConclusions.length ? target.acceptableConclusions : ['success']).includes(conclusion)) return 'passed';
  if (['cancelled', 'timed_out', 'skipped', 'action_required', 'stale'].includes(conclusion)) return 'recoverable';
  return 'failed';
}

function targetApplies(target: MatrixTargetConfiguration, scope: MatrixScope, pull: MatrixPull): boolean {
  if (target.baseBranches?.length && !target.baseBranches.includes(pull.base.ref)) return false;
  if (scope === 'gate-only') return target.group === 'gate';
  return target.group === 'full' || target.group === 'gate';
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
        && !proxyMatchesTarget(target, run, input.pull)) return false;
      return !input.trust || isTrustedMatrixCheck({ run, target, pull: input.pull, trust: input.trust });
    });
    const active = matches.filter((run) => (
      proxyMatchesTarget(target, run, input.pull)
      && ['queued', 'in_progress'].includes(String(run.status ?? ''))
    ));
    const checkRun = latestCheck(active.length ? active : matches) ?? null;
    const override = input.targetOverrides?.[target.id];
    return {
      ...target,
      checkRun,
      state: override?.state ?? matrixCheckState(checkRun, target),
      conclusion: override?.conclusion ?? String(checkRun?.conclusion ?? ''),
      status: override?.status ?? String(checkRun?.status ?? ''),
      url: override?.url ?? String(checkRun?.html_url ?? checkRun?.details_url ?? ''),
      required: target.required !== false,
    } satisfies MatrixTargetResult;
  });
  const blocking = targets.filter((target) => target.required && ['missing', 'recoverable', 'failed'].includes(target.state));
  const pending = targets.filter((target) => target.required && target.state === 'pending');
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
  return ['queued', 'in_progress'].includes(String(target.checkRun?.status ?? ''))
    && Boolean(target.checkRun)
    && proxyMatchesTarget(target, target.checkRun!, pull);
}

function latestWorkflowJob(
  runs: readonly MatrixWorkflowRun[],
  target: MatrixTargetConfiguration,
  pull: MatrixPull,
): MatrixCheckRun | null {
  const matchingRuns = runs.filter((run) => (
    workflowRunMatchesTarget(run, target) && legacyWorkflowRunMatchesPull(run, pull)
  )).sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))).reverse();
  for (const run of matchingRuns) {
    const job = run.jobs?.find((candidate) => candidate.name === target.jobName);
    if (job) return job;
  }
  return null;
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
    if (!target.required || !target.repairable || activeProxy(target, input.pull)) continue;
    const refreshPendingCopilot = target.id === 'copilot-review-gate'
      && target.state === 'pending' && eventSignal === 'copilot-review';
    const refreshFailedCopilot = target.id === 'copilot-review-gate'
      && target.state === 'failed' && eventSignal === 'manual';
    const refreshReviewState = target.workflowFile === 'pr-governance.yml'
      && ['main-authorization', 'main-gate', 'copilot-review-gate'].includes(target.id)
      && eventSignal === 'review-state';
    if (!['missing', 'recoverable'].includes(target.state)
      && !refreshPendingCopilot && !refreshFailedCopilot && !refreshReviewState) continue;
    if (target.checkRun && ['queued', 'in_progress'].includes(String(target.checkRun.status ?? ''))
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
    const job = latestWorkflowJob(input.workflowRuns, target, input.pull);
    remaining.push(job?.id
      ? { target: target.id, action: 'rerun-job', jobId: job.id, reason: target.state }
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
  workflowRun: MatrixWorkflowRun;
  targets: readonly MatrixTargetResult[];
  pull: MatrixPull;
  trust: MatrixTrustContext;
}): MatrixProxyCompletionPlan[] {
  const plans: MatrixProxyCompletionPlan[] = [];
  for (const target of input.targets) {
    if (!activeProxy(target, input.pull)
      || !target.checkRun
      || !isTrustedMatrixCheck({ run: target.checkRun, target, pull: input.pull, trust: input.trust })
      || !workflowRunMatchesTarget(input.workflowRun, target)
      || !legacyWorkflowRunMatchesPull(input.workflowRun, input.pull)) continue;
    const job = input.workflowRun.jobs?.find((candidate) => candidate.name === target.jobName);
    if (!job?.id || job.status !== 'completed' || !job.conclusion) continue;
    plans.push({
      target: target.id,
      action: 'complete-proxy-check',
      checkRunId: Number(target.checkRun?.id),
      conclusion: (target.acceptableConclusions.length ? target.acceptableConclusions : ['success'])
        .includes(job.conclusion) ? 'success' : 'failure',
      sourceJobId: job.id,
      sourceUrl: String(job.html_url ?? job.details_url ?? input.workflowRun.html_url ?? ''),
    });
  }
  return plans.filter((plan) => plan.checkRunId > 0);
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
