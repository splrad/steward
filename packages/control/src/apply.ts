import { GitHubApiError } from '../../github/src/index.js';
import type {
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequest,
} from '../../github/src/index.js';
import { loadDefaultBranchManifestContext } from '../../manifest/src/index.js';
import type {
  ControlMutation,
  ControlMutationPorts,
  ControlMutationReceipt,
  ControlPlan,
  ControlPlanSubject,
  ControlPreconditionReadPort,
  InstallationMutationPort,
} from './contracts.js';
import {
  assertControlPlanSubject,
  canonicalControlJson,
  controlJsonDigest,
  verifyControlPlan,
} from './plan.js';
import { controlLabelNames, controlPullRequestInput } from './snapshot.js';

export class ControlPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPreconditionError';
  }
}

export class ControlApplyError extends Error {
  constructor(
    readonly planId: string,
    readonly mutationKey: string,
    readonly failedDesiredDigest: string,
    readonly completed: readonly ControlMutationReceipt[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `Control mutation ${mutationKey} failed`, { cause });
    this.name = 'ControlApplyError';
  }

  readonly outcome = 'unknown' as const;
}

function installationPort(ports: ControlMutationPorts): InstallationMutationPort {
  if (!ports.installation) throw new Error('Control plan requires an installation mutation adapter');
  return ports.installation;
}

function preconditionPort(ports: ControlMutationPorts): ControlPreconditionReadPort {
  if (!ports.preconditions) throw new Error('Control plan requires a precondition read adapter');
  return ports.preconditions;
}

function preflightMutationPorts(plan: ControlPlan, ports: ControlMutationPorts): void {
  for (const mutation of plan.mutations) {
    if (mutation.principal !== 'installation') {
      throw new Error(`Control plan principal ${mutation.principal} has no mutation adapter`);
    }
  }
  if (plan.mutations.length) {
    installationPort(ports);
    preconditionPort(ports);
  }
}

async function readLivePullSubject(
  plan: ControlPlan,
  port: ControlPreconditionReadPort,
): Promise<GitHubPullRequest> {
  const live = await port.getPullRequest(
    plan.subject.repository.owner,
    plan.subject.repository.name,
    plan.subject.pullRequest.number,
  );
  if (live.number !== plan.subject.pullRequest.number
    || live.state !== 'open'
    || live.base.ref !== plan.subject.repository.defaultBranch
    || live.head.sha.toLowerCase() !== plan.subject.pullRequest.headSha
    || await controlJsonDigest(controlPullRequestInput(live)) !== plan.pullRequestDigest) {
    throw new ControlPreconditionError('Live pull request no longer matches the Control plan subject');
  }
  return live;
}

async function assertLiveControlSubject(
  plan: ControlPlan,
  port: ControlPreconditionReadPort,
): Promise<GitHubPullRequest> {
  const { owner, name: repository } = plan.subject.repository;
  const [pull, loaded] = await Promise.all([
    readLivePullSubject(plan, port),
    loadDefaultBranchManifestContext(port, owner, repository),
  ]);
  const { repository: metadata, manifest } = loaded;
  const defaultBranch = metadata.defaultBranch;
  if (metadata.id !== plan.subject.repository.id
    || metadata.fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
    || !defaultBranch
    || defaultBranch !== plan.subject.repository.defaultBranch) {
    throw new ControlPreconditionError('Live repository no longer matches the Control plan subject');
  }
  if (manifest.source.ref !== plan.subject.repository.defaultBranch
    || manifest.source.blobSha !== plan.subject.manifest.blobSha
    || manifest.configDigest !== plan.subject.manifest.configDigest
    || manifest.manifest.automation.githubApp.clientId !== plan.subject.platform.clientId
    || manifest.manifest.automation.githubApp.slug.toLowerCase() !== plan.subject.platform.appSlug) {
    throw new ControlPreconditionError('Live Manifest no longer matches the Control plan subject');
  }
  return pull;
}

async function assertObservedLabels(
  mutation: Extract<ControlMutation, { type: 'issue-labels.add' | 'issue-label.remove' | 'check-run.upsert' }>,
  live: GitHubPullRequest,
): Promise<void> {
  if (await controlJsonDigest(controlLabelNames(live)) !== mutation.observedLabelsDigest) {
    throw new ControlPreconditionError(`Control mutation ${mutation.key} observed changed pull request labels`);
  }
}

async function assertExpectedCheckState(
  mutation: Extract<ControlMutation, { type: 'check-run.upsert' }>,
  live: GitHubPullRequest,
): Promise<void> {
  await assertObservedLabels(mutation, live);
}

async function issueCommentAlreadyDeletedOrObserved(
  plan: ControlPlan,
  mutation: Extract<ControlMutation, { type: 'issue-comment.delete' }>,
  port: ControlPreconditionReadPort,
  observedComments?: readonly GitHubIssueComment[],
): Promise<boolean> {
  const comments = observedComments ?? await port.listIssueComments(
    plan.subject.repository.owner,
    plan.subject.repository.name,
    plan.subject.pullRequest.number,
  );
  const live = comments.find((comment) => comment.id === mutation.commentId);
  if (!live) return true;
  const expectedSlug = mutation.expectedOwnerLogin.replace(/\[bot\]$/i, '').toLowerCase();
  if (live.user?.id !== mutation.expectedOwnerId
    || String(live.user.login ?? '').toLowerCase() !== mutation.expectedOwnerLogin
    || String(live.user.type ?? '').toLowerCase() !== 'bot'
    || (live.performed_via_github_app != null
      && (String(live.performed_via_github_app.slug ?? '').toLowerCase() !== expectedSlug
        || (live.performed_via_github_app.id !== undefined
          && live.performed_via_github_app.id !== plan.subject.platform.appId)))
    || await controlJsonDigest(String(live.body ?? '')) !== mutation.observedBodyDigest) {
    throw new ControlPreconditionError(`Control mutation ${mutation.key} observed a changed issue comment`);
  }
  return false;
}

async function assertResourcePreconditions(
  plan: ControlPlan,
  port: ControlPreconditionReadPort,
): Promise<void> {
  const firstLabelMutation = plan.mutations.find((mutation) => (
    mutation.type === 'issue-labels.add'
    || mutation.type === 'issue-label.remove'
    || mutation.type === 'check-run.upsert'
  ));
  if (firstLabelMutation) {
    const live = await readLivePullSubject(plan, port);
    if (firstLabelMutation.type === 'check-run.upsert') {
      await assertExpectedCheckState(firstLabelMutation, live);
    } else {
      await assertObservedLabels(firstLabelMutation, live);
    }
  }
  const commentMutations = plan.mutations.filter((mutation): mutation is Extract<ControlMutation, {
    type: 'issue-comment.delete';
  }> => mutation.type === 'issue-comment.delete');
  const comments = commentMutations.length ? await port.listIssueComments(
    plan.subject.repository.owner,
    plan.subject.repository.name,
    plan.subject.pullRequest.number,
  ) : [];
  for (const mutation of plan.mutations) {
    if (mutation.type === 'issue-comment.delete') {
      await issueCommentAlreadyDeletedOrObserved(plan, mutation, port, comments);
    }
  }
}

function receipt(
  plan: ControlPlan,
  mutation: ControlMutation,
  state: ControlMutationReceipt['state'],
  resourceId?: number,
): ControlMutationReceipt {
  return {
    planId: plan.planId,
    key: mutation.key,
    desiredDigest: mutation.desiredDigest,
    state,
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

function desiredCheckMatches(existing: GitHubCheckRun, desired: CheckRunUpdate): boolean {
  return existing.name === desired.name
    && existing.status === desired.status
    && (existing.external_id ?? null) === (desired.externalId ?? null)
    && (existing.conclusion ?? null) === (desired.conclusion ?? null)
    && (desired.detailsUrl === undefined || (existing.details_url ?? '') === desired.detailsUrl)
    && existing.output?.title === desired.title
    && existing.output?.summary === desired.summary;
}

function validatedWrittenCheck(
  plan: ControlPlan,
  mutation: Extract<ControlMutation, { type: 'check-run.upsert' }>,
  check: GitHubCheckRun,
  expectedId?: number,
): GitHubCheckRun {
  if (!Number.isSafeInteger(check.id) || check.id <= 0
    || (expectedId !== undefined && check.id !== expectedId)
    || String(check.head_sha ?? '').toLowerCase() !== plan.subject.pullRequest.headSha
    || !desiredCheckMatches(check, mutation.input)
    || check.app?.id !== plan.subject.platform.appId
    || String(check.app?.slug ?? '').toLowerCase() !== plan.subject.platform.appSlug) {
    throw new ControlPreconditionError(
      `Control mutation ${mutation.key} received a Check Run outside its bound identity`,
    );
  }
  return check;
}

async function currentOwnedChecks(
  plan: ControlPlan,
  mutation: Extract<ControlMutation, { type: 'check-run.upsert' }>,
  port: ControlPreconditionReadPort,
): Promise<GitHubCheckRun[]> {
  const checks = await port.listCommitCheckRuns(
    plan.subject.repository.owner,
    plan.subject.repository.name,
    plan.subject.pullRequest.headSha,
  );
  return checks.filter((check) => (
    check.name === mutation.input.name
    && check.app?.id === plan.subject.platform.appId
    && String(check.app?.slug ?? '').toLowerCase() === plan.subject.platform.appSlug
  )).sort((left, right) => left.id - right.id);
}

async function assertActiveClassificationLease(
  plan: ControlPlan,
  port: ControlPreconditionReadPort,
): Promise<void> {
  if (plan.objective !== 'classification') return;
  const start = plan.mutations[0];
  if (start?.type !== 'check-run.upsert'
    || start.key !== 'check-run:pr-classification:start'
    || start.mode !== 'update'
    || !start.input.externalId) return;
  const owned = await currentOwnedChecks(plan, start, port);
  const current = owned.at(-1);
  if (!current
    || current.id !== start.checkRunId
    || current.status !== 'in_progress'
    || current.conclusion != null
    || current.external_id !== start.input.externalId) {
    throw new ControlPreconditionError('Classification lease was superseded before a derived mutation');
  }
}

async function applyInstallationMutation(
  plan: ControlPlan,
  mutation: ControlMutation,
  port: InstallationMutationPort,
  preconditions: ControlPreconditionReadPort,
): Promise<ControlMutationReceipt> {
  const { owner, name: repository } = plan.subject.repository;
  const pullNumber = plan.subject.pullRequest.number;
  if (mutation.type === 'repository-label.ensure') {
    try {
      await port.getRepositoryLabel(owner, repository, mutation.label.name);
      return receipt(plan, mutation, 'converged');
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
    try {
      await port.createRepositoryLabel(owner, repository, mutation.label);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      await port.getRepositoryLabel(owner, repository, mutation.label.name);
      return receipt(plan, mutation, 'converged');
    }
    return receipt(plan, mutation, 'applied');
  }
  if (mutation.type === 'issue-labels.add') {
    await port.addIssueLabels(owner, repository, pullNumber, mutation.labels);
    return receipt(plan, mutation, 'applied');
  }
  if (mutation.type === 'issue-label.remove') {
    await port.removeIssueLabel(owner, repository, pullNumber, mutation.label);
    return receipt(plan, mutation, 'applied');
  }
  if (mutation.type === 'check-run.upsert') {
    const ownedChecks = await currentOwnedChecks(plan, mutation, preconditions);
    if (ownedChecks.some((check) => (
      !Number.isSafeInteger(check.id)
      || check.id <= 0
      || !/^[a-f0-9]{40}$/i.test(String(check.head_sha ?? ''))
      || String(check.head_sha).toLowerCase() !== plan.subject.pullRequest.headSha
    ))) {
      throw new ControlPreconditionError(
        `Control mutation ${mutation.key} observed a Check Run outside the bound head identity`,
      );
    }
    if (mutation.mode === 'update') {
      if (!Number.isSafeInteger(mutation.checkRunId) || Number(mutation.checkRunId) <= 0) {
        throw new Error(`Control mutation ${mutation.key} requires a Check Run ID`);
      }
      const current = ownedChecks.find((check) => check.id === mutation.checkRunId);
      if (!current) {
        throw new ControlPreconditionError(`Control mutation ${mutation.key} no longer owns its Check Run`);
      }
      if (ownedChecks.at(-1)?.id !== mutation.checkRunId) {
        throw new ControlPreconditionError(`Control mutation ${mutation.key} observed a newer Check Run generation`);
      }
      if (desiredCheckMatches(current, mutation.input)) {
        return receipt(plan, mutation, 'converged', current.id);
      }
      if (current.status !== 'in_progress'
        || current.conclusion != null
        || current.external_id !== mutation.observedCheckExternalId) {
        throw new ControlPreconditionError(`Control mutation ${mutation.key} lost its Classification lease`);
      }
      const check = validatedWrittenCheck(
        plan,
        mutation,
        await port.updateCheckRun(owner, repository, mutation.checkRunId, mutation.input),
        mutation.checkRunId,
      );
      return receipt(plan, mutation, 'applied', check.id);
    }
    if (mutation.input.headSha !== plan.subject.pullRequest.headSha) {
      throw new Error(`Control mutation ${mutation.key} requires the bound pull request head SHA`);
    }
    const current = ownedChecks.at(-1);
    if (current) {
      const { headSha: _headSha, ...update } = mutation.input;
      if (desiredCheckMatches(current, update)) return receipt(plan, mutation, 'converged', current.id);
      const converged = validatedWrittenCheck(
        plan,
        mutation,
        await port.updateCheckRun(owner, repository, current.id, update),
        current.id,
      );
      return receipt(plan, mutation, 'applied', converged.id);
    }
    const check = validatedWrittenCheck(
      plan,
      mutation,
      await port.createCheckRun(owner, repository, mutation.input),
    );
    return receipt(plan, mutation, 'applied', check.id);
  }
  if (mutation.type === 'issue-comment.delete') {
    if (await issueCommentAlreadyDeletedOrObserved(plan, mutation, preconditions)) {
      return receipt(plan, mutation, 'converged', mutation.commentId);
    }
    try {
      await port.deleteIssueComment(owner, repository, mutation.commentId);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        if (await issueCommentAlreadyDeletedOrObserved(plan, mutation, preconditions)) {
          return receipt(plan, mutation, 'converged', mutation.commentId);
        }
      }
      throw error;
    }
    return receipt(plan, mutation, 'applied', mutation.commentId);
  }
  throw new Error(`Unsupported Control mutation ${String((mutation as { type?: unknown }).type)}`);
}

export async function applyControlPlan(
  plan: ControlPlan,
  currentSubject: ControlPlanSubject,
  ports: ControlMutationPorts,
): Promise<ControlMutationReceipt[]> {
  const executionPlan = JSON.parse(canonicalControlJson(plan)) as ControlPlan;
  await verifyControlPlan(executionPlan);
  assertControlPlanSubject(executionPlan, currentSubject);
  preflightMutationPorts(executionPlan, ports);
  if (!executionPlan.mutations.length) return [];
  const preconditions = preconditionPort(ports);
  await assertLiveControlSubject(executionPlan, preconditions);
  await assertResourcePreconditions(executionPlan, preconditions);
  const completed: ControlMutationReceipt[] = [];
  for (const [index, mutation] of executionPlan.mutations.entries()) {
    try {
      if (executionPlan.objective === 'classification'
        && index > 0
        && mutation.key !== 'check-run:pr-classification:complete') {
        await assertActiveClassificationLease(executionPlan, preconditions);
      }
      if (mutation.type !== 'repository-label.ensure') {
        // Repository/default-branch Manifest identity was bound immediately before this loop. Re-read mutable
        // PR and resource state per intent; repeating the same Manifest read would amplify API work without CAS.
        const live = await readLivePullSubject(executionPlan, preconditions);
        if (mutation.type === 'issue-labels.add'
          || mutation.type === 'issue-label.remove') {
          await assertObservedLabels(mutation, live);
        } else if (mutation.type === 'check-run.upsert') {
          await assertExpectedCheckState(mutation, live);
        }
      }
      completed.push(await applyInstallationMutation(
        executionPlan,
        mutation,
        installationPort(ports),
        preconditions,
      ));
    } catch (error) {
      throw new ControlApplyError(executionPlan.planId, mutation.key, mutation.desiredDigest, completed, error);
    }
  }
  return completed;
}
