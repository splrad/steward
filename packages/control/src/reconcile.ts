import { stewardCheckExternalId } from '../../core/src/index.js';
import type {
  CheckRunCreate,
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubPullRequest,
  GitHubRepositoryMetadata,
} from '../../github/src/index.js';
import {
  bindDefaultBranchManifest,
  type DefaultBranchManifestBinding,
  type LoadedManifest,
} from '../../manifest/src/index.js';
import { applyControlPlan, ControlPreconditionError } from './apply.js';
import type {
  ClassificationLease,
  ControlMutationPorts,
  ControlReadPort,
  ControlReconcileResult,
  ControlRuntimeIdentity,
  InstallationMutationPort,
  PullRequestControlContext,
  PullRequestControlRoute,
} from './contracts.js';
import {
  assertPullRequestControlContext,
  planClassification,
  planDcoAdvisory,
} from './operations.js';
import { assertControlSubject, controlJsonDigest } from './plan.js';

export interface ControlPorts extends ControlMutationPorts {
  identity: ControlRuntimeIdentity;
  read: ControlReadPort;
}

export class ControlPullRequestStateMismatchError extends Error {
  constructor(
    readonly pullNumber: number,
    readonly expectedState: 'open',
    readonly actualState: string,
  ) {
    super(`Control requires an open pull request; pull request #${pullNumber} has state ${JSON.stringify(actualState)}`);
    this.name = 'ControlPullRequestStateMismatchError';
  }
}

export class ControlPullRequestHeadMismatchError extends Error {
  constructor(
    readonly pullNumber: number,
    readonly expectedHead: string,
    readonly actualHead: string,
  ) {
    super(
      `Pull request #${pullNumber} head ${JSON.stringify(actualHead)} `
      + `does not match trusted head ${JSON.stringify(expectedHead)}`,
    );
    this.name = 'ControlPullRequestHeadMismatchError';
  }
}

interface BoundPullRequestRoute {
  binding: DefaultBranchManifestBinding<GitHubRepositoryMetadata>;
  pull: GitHubPullRequest;
  route: PullRequestControlRoute;
  identity: ControlRuntimeIdentity;
}

const classificationCheckName = 'PR Classification Gate';
const zeroDigest = '0'.repeat(64);

function installationPort(ports: ControlPorts): InstallationMutationPort {
  if (!ports.installation) throw new Error('Classification reconcile requires an installation mutation adapter');
  return ports.installation;
}

function validatedRuntimeIdentity(identity: ControlRuntimeIdentity): ControlRuntimeIdentity {
  const appSlug = identity.appSlug.trim().toLowerCase();
  const clientId = identity.clientId.trim();
  if (!appSlug || identity.appSlug !== identity.appSlug.trim()
    || !clientId || identity.clientId !== clientId
    || !Number.isSafeInteger(identity.appId) || identity.appId <= 0) {
    throw new Error('Control runtime requires a trusted GitHub App identity');
  }
  return { appId: identity.appId, clientId, appSlug };
}

function validateRoute(route: PullRequestControlRoute): void {
  if (!Number.isSafeInteger(route.repository.id) || route.repository.id <= 0
    || !route.repository.owner.trim() || route.repository.owner !== route.repository.owner.trim()
    || !route.repository.name.trim() || route.repository.name !== route.repository.name.trim()) {
    throw new Error('Control route requires a valid repository identity');
  }
  if (!Number.isSafeInteger(route.pullRequest.number) || route.pullRequest.number <= 0) {
    throw new Error('Control route requires a positive pull request number');
  }
  const expectedHeadInput = route.pullRequest.expectedHeadSha;
  if (expectedHeadInput !== undefined
    && (expectedHeadInput !== expectedHeadInput.trim()
      || !/^[a-f0-9]{40}$/.test(expectedHeadInput.toLowerCase()))) {
    throw new Error('Control route contains an invalid expected pull request head SHA');
  }
  if (!route.attemptId.trim() || route.attemptId !== route.attemptId.trim()) {
    throw new Error('Control route requires a trusted attempt ID without surrounding whitespace');
  }
}

async function bindLivePullRequestRoute(
  route: PullRequestControlRoute,
  identityInput: ControlRuntimeIdentity,
  read: ControlReadPort,
): Promise<BoundPullRequestRoute> {
  validateRoute(route);
  const identity = validatedRuntimeIdentity(identityInput);
  const { owner, name: repository } = route.repository;
  const [binding, pull] = await Promise.all([
    bindDefaultBranchManifest(read, owner, repository),
    read.getPullRequest(owner, repository, route.pullRequest.number),
  ]);
  const metadata = binding.repository;
  if (metadata.id !== route.repository.id
    || metadata.fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
    || !metadata.defaultBranch?.trim()
    || metadata.defaultBranch !== metadata.defaultBranch.trim()) {
    throw new Error('Control could not bind valid live repository metadata');
  }
  if (pull.number !== route.pullRequest.number) {
    throw new Error('GitHub returned a different pull request number');
  }
  if (pull.state !== 'open') {
    throw new ControlPullRequestStateMismatchError(pull.number, 'open', String(pull.state ?? 'unknown'));
  }
  if (pull.base.ref !== metadata.defaultBranch) {
    throw new Error('Pull request does not target the current default branch');
  }
  const liveHead = String(pull.head.sha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(liveHead)) throw new Error('GitHub returned an invalid pull request head SHA');
  const expectedHead = route.pullRequest.expectedHeadSha?.toLowerCase();
  if (expectedHead && liveHead !== expectedHead) {
    throw new ControlPullRequestHeadMismatchError(pull.number, expectedHead, liveHead);
  }
  return { binding, pull, route, identity };
}

function liveControlContext(bound: BoundPullRequestRoute, manifest: LoadedManifest): PullRequestControlContext {
  const { repository, pullRequest } = bound.route;
  const defaultBranch = bound.binding.repository.defaultBranch;
  if (!defaultBranch) throw new Error('GitHub repository has no default branch');
  if (manifest.manifest.automation.githubApp.slug.toLowerCase() !== bound.identity.appSlug
    || manifest.manifest.automation.githubApp.clientId !== bound.identity.clientId) {
    throw new Error('Control live Manifest does not match the trusted runtime GitHub App identity');
  }
  const context: PullRequestControlContext = {
    ...(bound.route.detailsUrl === undefined ? {} : { detailsUrl: bound.route.detailsUrl }),
    subject: {
      repository: {
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        defaultBranch,
      },
      pullRequest: { number: pullRequest.number, headSha: bound.pull.head.sha.toLowerCase() },
      manifest: { blobSha: manifest.source.blobSha, configDigest: manifest.configDigest },
      platform: { ...bound.identity },
    },
    pull: bound.pull,
    manifest,
  };
  assertControlSubject(context.subject);
  assertPullRequestControlContext(context);
  return context;
}

function ownedClassificationChecks(
  checks: readonly GitHubCheckRun[],
  bound: BoundPullRequestRoute,
): GitHubCheckRun[] {
  const headSha = bound.pull.head.sha.toLowerCase();
  const owned = checks.filter((check) => (
    check.name === classificationCheckName
    && check.app?.id === bound.identity.appId
    && String(check.app?.slug ?? '').toLowerCase() === bound.identity.appSlug
  )).sort((left, right) => left.id - right.id);
  if (owned.some((check) => (
    !Number.isSafeInteger(check.id) || check.id <= 0
    || String(check.head_sha ?? '').toLowerCase() !== headSha
  ))) {
    throw new Error('GitHub returned an App-owned Classification Check outside the bound head identity');
  }
  return owned;
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

function validateLeaseWrite(
  check: GitHubCheckRun,
  bound: BoundPullRequestRoute,
  expectedId: number | undefined,
  desired: CheckRunUpdate,
): GitHubCheckRun {
  if (!Number.isSafeInteger(check.id) || check.id <= 0
    || (expectedId !== undefined && check.id !== expectedId)
    || String(check.head_sha ?? '').toLowerCase() !== bound.pull.head.sha.toLowerCase()
    || check.app?.id !== bound.identity.appId
    || String(check.app?.slug ?? '').toLowerCase() !== bound.identity.appSlug
    || !desiredCheckMatches(check, desired)) {
    throw new ControlPreconditionError('Classification lease mutation returned a Check outside its bound identity');
  }
  return check;
}

async function acquireClassificationLease(
  bound: BoundPullRequestRoute,
  ports: ControlPorts,
  allowCreate: boolean,
): Promise<{ lease: ClassificationLease | null; readFailure?: unknown }> {
  const { owner, name: repository } = bound.route.repository;
  const attemptDigest = await controlJsonDigest({ operation: 'classification', attemptId: bound.route.attemptId });
  const externalId = stewardCheckExternalId({
    repositoryId: bound.route.repository.id,
    prNumber: bound.route.pullRequest.number,
    headSha: bound.pull.head.sha,
    checkId: 'pr-class-lease',
    configDigest: zeroDigest,
    inputDigest: attemptDigest,
  });
  const desired: CheckRunUpdate = {
    name: classificationCheckName,
    status: 'in_progress',
    externalId,
    ...(bound.route.detailsUrl ? { detailsUrl: bound.route.detailsUrl } : {}),
    title: 'PR 分类同步已接管',
    summary: 'Steward 已使先前 Classification 结果失效，正在读取默认分支策略与当前 PR 证据。',
  };
  let checks: GitHubCheckRun[];
  try {
    checks = ownedClassificationChecks(
      await ports.read.listCommitCheckRuns(owner, repository, bound.pull.head.sha),
      bound,
    );
  } catch (readFailure) {
    const mutations = installationPort(ports);
    const emergency = validateLeaseWrite(
      await mutations.createCheckRun(owner, repository, {
        ...desired,
        headSha: bound.pull.head.sha,
      } satisfies CheckRunCreate),
      bound,
      undefined,
      desired,
    );
    return {
      lease: {
        contractVersion: 1,
        checkRunId: emergency.id,
        externalId,
        attemptDigest,
        repositoryId: bound.route.repository.id,
        pullNumber: bound.route.pullRequest.number,
        headSha: bound.pull.head.sha.toLowerCase(),
        appId: bound.identity.appId,
        appSlug: bound.identity.appSlug,
      },
      readFailure,
    };
  }
  if (!checks.length && !allowCreate) return { lease: null };
  const mutations = installationPort(ports);
  const latest = checks.at(-1);
  const leased = latest && desiredCheckMatches(latest, desired)
    ? latest
    : validateLeaseWrite(
      await mutations.createCheckRun(owner, repository, {
        ...desired,
        headSha: bound.pull.head.sha,
      } satisfies CheckRunCreate),
      bound,
      undefined,
      desired,
    );

  for (const stale of checks.filter((check) => (
    check.id !== leased.id
    && check.status !== 'completed'
    && check.conclusion == null
  ))) {
    const cancelled: CheckRunUpdate = {
      name: classificationCheckName,
      status: 'completed',
      conclusion: 'cancelled',
      ...(stale.external_id ? { externalId: stale.external_id } : {}),
      ...(stale.details_url ? { detailsUrl: stale.details_url } : {}),
      title: '旧 Classification generation 已失效',
      summary: `Check Run #${leased.id} 已成为当前 Classification lease。`,
    };
    validateLeaseWrite(
      await mutations.updateCheckRun(owner, repository, stale.id, cancelled),
      bound,
      stale.id,
      cancelled,
    );
  }

  const current = ownedClassificationChecks(
    await ports.read.listCommitCheckRuns(owner, repository, bound.pull.head.sha),
    bound,
  ).at(-1);
  if (!current || current.id !== leased.id || !desiredCheckMatches(current, desired)) {
    throw new ControlPreconditionError('Classification lease was superseded before acquisition completed');
  }
  return {
    lease: {
      contractVersion: 1,
      checkRunId: leased.id,
      externalId,
      attemptDigest,
      repositoryId: bound.route.repository.id,
      pullNumber: bound.route.pullRequest.number,
      headSha: bound.pull.head.sha.toLowerCase(),
      appId: bound.identity.appId,
      appSlug: bound.identity.appSlug,
    },
  };
}

async function finalizeClassificationFailure(
  bound: BoundPullRequestRoute,
  ports: ControlPorts,
  lease: ClassificationLease,
  acceptedExternalIds: ReadonlySet<string>,
): Promise<boolean> {
  const { owner, name: repository } = bound.route.repository;
  const owned = ownedClassificationChecks(
    await ports.read.listCommitCheckRuns(owner, repository, bound.pull.head.sha),
    bound,
  );
  const current = owned.at(-1);
  if (!current || current.id !== lease.checkRunId
    || !acceptedExternalIds.has(String(current.external_id ?? ''))) return false;
  if (current.status === 'completed' && current.conclusion === 'success') return true;
  if (current.status === 'completed' && current.conclusion === 'failure') return true;
  if (current.status !== 'in_progress' || current.conclusion != null) return false;
  const desired: CheckRunUpdate = {
    name: classificationCheckName,
    status: 'completed',
    conclusion: 'failure',
    externalId: String(current.external_id),
    ...(bound.route.detailsUrl ? { detailsUrl: bound.route.detailsUrl } : {}),
    title: 'PR 分类同步失败',
    summary: 'Steward 未能把当前默认分支策略与 PR 证据安全收敛；旧成功结果不会继续生效。',
  };
  validateLeaseWrite(
    await installationPort(ports).updateCheckRun(owner, repository, lease.checkRunId, desired),
    bound,
    lease.checkRunId,
    desired,
  );
  return true;
}

function combinedFailure(primary: unknown, reporting: unknown): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const reportingMessage = reporting instanceof Error ? reporting.message : String(reporting);
  return new Error(
    `${primaryMessage}; additionally failed to finalize the Classification lease: ${reportingMessage}`,
    { cause: primary },
  );
}

export async function reconcileClassification(
  route: PullRequestControlRoute,
  ports: ControlPorts,
): Promise<ControlReconcileResult> {
  const bound = await bindLivePullRequestRoute(route, ports.identity, ports.read);
  let lease: ClassificationLease | null = null;
  const acceptedExternalIds = new Set<string>();
  try {
    const initialAcquisition = await acquireClassificationLease(bound, ports, false);
    lease = initialAcquisition.lease;
    if (lease) acceptedExternalIds.add(lease.externalId);
    if ('readFailure' in initialAcquisition) throw initialAcquisition.readFailure;
    const context = liveControlContext(bound, await bound.binding.loadManifest());
    if (!context.manifest.manifest.features.classification) {
      const decision = await planClassification(context, lease ? { commits: [], files: [], lease } : null);
      if (lease) {
        const completion = decision.plan.mutations.find((mutation) => mutation.type === 'check-run.upsert');
        if (completion?.input.externalId) acceptedExternalIds.add(completion.input.externalId);
      }
      return {
        ...decision,
        receipts: await applyControlPlan(decision.plan, context.subject, {
          preconditions: ports.read,
          ...(ports.installation ? { installation: ports.installation } : {}),
        }),
      };
    }
    if (!lease) {
      const enabledAcquisition = await acquireClassificationLease(bound, ports, true);
      lease = enabledAcquisition.lease;
      if (!lease) throw new Error('Classification failed to acquire a Check lease');
      acceptedExternalIds.add(lease.externalId);
      if ('readFailure' in enabledAcquisition) throw enabledAcquisition.readFailure;
    }
    const [commits, files] = await Promise.all([
      ports.read.listPullRequestCommits(
        context.subject.repository.owner,
        context.subject.repository.name,
        context.subject.pullRequest.number,
      ),
      ports.read.listPullRequestFiles(
        context.subject.repository.owner,
        context.subject.repository.name,
        context.subject.pullRequest.number,
      ),
    ]);
    const decision = await planClassification(context, { commits, files, lease });
    for (const mutation of decision.plan.mutations) {
      if (mutation.type === 'check-run.upsert' && mutation.input.externalId) {
        acceptedExternalIds.add(mutation.input.externalId);
      }
    }
    return {
      ...decision,
      receipts: await applyControlPlan(decision.plan, context.subject, {
        preconditions: ports.read,
        ...(ports.installation ? { installation: ports.installation } : {}),
      }),
    };
  } catch (error) {
    if (lease) {
      try {
        await finalizeClassificationFailure(bound, ports, lease, acceptedExternalIds);
      } catch (reportingError) {
        throw combinedFailure(error, reportingError);
      }
    }
    throw error;
  }
}

export async function reconcileDcoAdvisory(
  route: PullRequestControlRoute,
  ports: ControlPorts,
): Promise<ControlReconcileResult> {
  const bound = await bindLivePullRequestRoute(route, ports.identity, ports.read);
  const context = liveControlContext(bound, await bound.binding.loadManifest());
  let snapshot = null;
  if (context.manifest.manifest.features.dcoAdvisory) {
    const [actor, commits, comments] = await Promise.all([
      ports.read.getUser(`${context.subject.platform.appSlug.toLowerCase()}[bot]`),
      ports.read.listPullRequestCommits(
        context.subject.repository.owner,
        context.subject.repository.name,
        context.subject.pullRequest.number,
      ),
      ports.read.listIssueComments(
        context.subject.repository.owner,
        context.subject.repository.name,
        context.subject.pullRequest.number,
      ),
    ]);
    snapshot = { actor, commits, comments };
  }
  const decision = await planDcoAdvisory(context, snapshot);
  return {
    ...decision,
    receipts: await applyControlPlan(decision.plan, context.subject, {
      preconditions: ports.read,
      ...(ports.installation ? { installation: ports.installation } : {}),
    }),
  };
}
