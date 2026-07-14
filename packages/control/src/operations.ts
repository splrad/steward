import {
  classificationInputBody,
  evaluateClassification,
  evaluateDcoAdvisory,
  fingerprintForPull,
  parseStewardCheckExternalId,
  stewardCheckExternalId,
  type DcoEvaluation,
  type DcoIssue,
} from '../../core/src/index.js';
import type {
  CheckRunUpdate,
  GitHubCommit,
  GitHubIssueComment,
  GitHubPullRequestFile,
} from '../../github/src/index.js';
import { verifyLoadedManifest } from '../../manifest/src/index.js';
import {
  type ControlDecision,
  type ClassificationLease,
  type ControlMutationIntent,
  type ControlOperationResult,
  type PullRequestControlContext,
} from './contracts.js';
import { controlJsonDigest, finalizeControlPlan } from './plan.js';
import { controlLabelNames } from './snapshot.js';

export interface ClassificationSnapshot {
  commits: GitHubCommit[];
  files: GitHubPullRequestFile[];
  lease: ClassificationLease;
}

export interface DcoSnapshot {
  actor: { id?: number; login: string; type?: string };
  commits: GitHubCommit[];
  comments: GitHubIssueComment[];
}

const installationPrincipal = 'installation' as const;
const legacyDcoMarker = '<!-- workflow:dco-signoff-advisory -->';
const maxDcoIssues = 20;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFoldedText(left: string, right: string): number {
  return compareText(left.toLowerCase(), right.toLowerCase()) || compareText(left, right);
}

function controlBotLogins(context: PullRequestControlContext): string[] {
  return [context.subject.platform.appSlug, 'copilot-pull-request-reviewer[bot]'];
}

export function assertControlManifestContext(context: PullRequestControlContext): void {
  if (context.manifest.source.ref !== context.subject.repository.defaultBranch) {
    throw new Error('Control Manifest source does not match the bound default branch');
  }
  if (context.manifest.source.blobSha !== context.subject.manifest.blobSha
    || context.manifest.configDigest.toLowerCase() !== context.subject.manifest.configDigest.toLowerCase()) {
    throw new Error('Control Manifest evidence does not match its subject');
  }
  if (context.manifest.manifest.automation.githubApp.slug.toLowerCase()
    !== context.subject.platform.appSlug.toLowerCase()) {
    throw new Error('Control GitHub App identity does not match its Manifest');
  }
  if (context.manifest.manifest.automation.githubApp.clientId !== context.subject.platform.clientId) {
    throw new Error('Control GitHub App client ID does not match its Manifest');
  }
}

export function assertPullRequestControlContext(context: PullRequestControlContext): void {
  if (context.pull.number !== context.subject.pullRequest.number) {
    throw new Error('Control pull request number does not match its subject');
  }
  if (context.pull.head.sha.toLowerCase() !== context.subject.pullRequest.headSha.toLowerCase()) {
    throw new Error('Control pull request head does not match its subject');
  }
  if (context.pull.state !== 'open') throw new Error('Control operation requires an open pull request');
  if (context.pull.base.ref !== context.subject.repository.defaultBranch) {
    throw new Error('Control pull request does not target the bound default branch');
  }
  assertControlManifestContext(context);
}

function classificationCommit(commit: GitHubCommit): GitHubCommit {
  const sha = String(commit.sha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('GitHub returned a pull request commit without a valid SHA');
  }
  const login = String(commit.author?.login ?? '').trim();
  return { sha, ...(login ? { author: { login } } : {}) };
}

function classificationFile(file: GitHubPullRequestFile): GitHubPullRequestFile {
  const filename = String(file.filename ?? '').trim();
  if (!filename) throw new Error('GitHub returned a pull request file without a valid filename');
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    filename,
    status: String(file.status ?? ''),
    sha: String(file.sha ?? ''),
    additions: count(file.additions),
    deletions: count(file.deletions),
  };
}

function ignoredResult(operation: ControlOperationResult['operation'], summary: string): ControlOperationResult {
  return { operation, state: 'ignored', summary };
}

function assertClassificationLease(context: PullRequestControlContext, lease: ClassificationLease): void {
  const identity = parseStewardCheckExternalId(lease.externalId);
  if (!identity
    || lease.contractVersion !== 1
    || !Number.isSafeInteger(lease.checkRunId) || lease.checkRunId <= 0
    || !/^[a-f0-9]{64}$/i.test(lease.attemptDigest)
    || !lease.externalId.trim() || lease.externalId !== lease.externalId.trim()
    || lease.repositoryId !== context.subject.repository.id
    || lease.pullNumber !== context.subject.pullRequest.number
    || lease.headSha.toLowerCase() !== context.subject.pullRequest.headSha.toLowerCase()
    || lease.appId !== context.subject.platform.appId
    || lease.appSlug.toLowerCase() !== context.subject.platform.appSlug.toLowerCase()
    || identity.repositoryId !== lease.repositoryId
    || identity.prNumber !== lease.pullNumber
    || identity.headSha !== lease.headSha.toLowerCase()
    || identity.checkId !== 'pr-class-lease'
    || identity.configDigest !== '0'.repeat(64)
    || identity.inputDigest !== lease.attemptDigest.toLowerCase()) {
    throw new Error('Classification planning requires a lease bound to the live Control subject');
  }
}

function classificationCheckSummary(evaluation: ReturnType<typeof evaluateClassification>): string {
  const list = (values: readonly string[]): string => values.length ? values.join(', ') : 'none';
  return [
    `Kind: ${evaluation.presentation.kind || 'none'}`,
    `Areas: ${list(evaluation.presentation.areas)}`,
    `Visible labels: ${list(evaluation.presentation.visibleLabels)}`,
    `Release labels: ${list(evaluation.presentation.releaseLabels)}`,
  ].join('\n');
}

export async function planClassification(
  context: PullRequestControlContext,
  snapshot: ClassificationSnapshot | null,
): Promise<ControlDecision> {
  context = { ...context, manifest: await verifyLoadedManifest(context.manifest) };
  assertPullRequestControlContext(context);
  const currentLabels = (context.pull.labels ?? []).map((label) => String(label.name ?? '').trim());
  if (currentLabels.some((label) => !label)) {
    throw new Error('GitHub returned a pull request label without a valid name');
  }
  currentLabels.sort(compareFoldedText);
  const currentLabelsDigest = await controlJsonDigest(controlLabelNames(context.pull));
  if (!context.manifest.manifest.features.classification) {
    const result = ignoredResult('classification', 'Classification feature is disabled');
    const mutations: ControlMutationIntent[] = [];
    if (snapshot) {
      assertClassificationLease(context, snapshot.lease);
      const externalId = stewardCheckExternalId({
        repositoryId: context.subject.repository.id,
        prNumber: context.subject.pullRequest.number,
        headSha: context.subject.pullRequest.headSha,
        checkId: 'pr-class-off',
        configDigest: context.subject.manifest.configDigest,
        inputDigest: snapshot.lease.attemptDigest,
      });
      mutations.push({
        type: 'check-run.upsert',
        key: 'check-run:pr-classification:complete',
        principal: installationPrincipal,
        mode: 'update',
        checkRunId: snapshot.lease.checkRunId,
        input: {
          name: 'PR Classification Gate',
          status: 'completed',
          conclusion: 'success',
          externalId,
          ...(context.detailsUrl ? { detailsUrl: context.detailsUrl } : {}),
          title: 'PR 分类已停用',
          summary: '默认分支 Manifest 已停用 Classification；未执行分类派生写入。',
        },
        observedLabelsDigest: currentLabelsDigest,
        observedCheckExternalId: snapshot.lease.externalId,
      });
    }
    return {
      result,
      plan: await finalizeControlPlan({
        objective: 'classification',
        subject: context.subject,
        pullRequest: context.pull,
        snapshot: {
          featureEnabled: false,
          lease: snapshot?.lease ?? null,
        },
        outcome: { state: result.state, summary: result.summary },
        mutations,
      }),
    };
  }
  if (!snapshot) throw new Error('Classification planning requires a live snapshot');
  assertClassificationLease(context, snapshot.lease);
  const classification = context.manifest.manifest.classification;
  if (!classification) throw new Error('Classification feature requires default-branch Manifest configuration');
  if (typeof context.pull.title !== 'string' || !context.pull.title.trim()) {
    throw new Error('GitHub returned a pull request without a valid title');
  }

  const commits = snapshot.commits.map(classificationCommit)
    .sort((left, right) => compareText(String(left.sha), String(right.sha)));
  const files = snapshot.files.map(classificationFile)
    .sort((left, right) => compareText(String(left.filename), String(right.filename)));
  const contributorBody = classificationInputBody(context.pull.body);
  const fingerprint = await fingerprintForPull({
    pull: { ...context.pull, body: contributorBody },
    commits,
    files,
    botLogins: controlBotLogins(context),
  });
  const evaluation = evaluateClassification({
    title: context.pull.title,
    baseRef: context.pull.base.ref,
    body: contributorBody,
    ...(context.pull.head.ref === undefined ? {} : { headRef: context.pull.head.ref }),
    ...(context.pull.user == null ? {} : { author: context.pull.user }),
    files: files.map((file) => String(file.filename)),
    currentLabels,
  }, classification);
  const stateMutations: ControlMutationIntent[] = [];
  const expectedLabels = new Set(controlLabelNames(context.pull));
  const labelsDigest = async (): Promise<string> => await controlJsonDigest([...expectedLabels].sort(compareText));
  const initialLabelsDigest = await labelsDigest();

  for (const label of evaluation.mutationPlan.ensureLabels) {
    stateMutations.push({
      type: 'repository-label.ensure',
      key: `repository-label:${label.name.toLowerCase()}`,
      principal: installationPrincipal,
      label,
    });
  }
  if (evaluation.mutationPlan.addLabels.length) {
    stateMutations.push({
      type: 'issue-labels.add',
      key: 'issue-labels:classification',
      principal: installationPrincipal,
      labels: [...evaluation.mutationPlan.addLabels],
      observedLabelsDigest: await labelsDigest(),
    });
    for (const label of evaluation.mutationPlan.addLabels) expectedLabels.add(label.trim().toLowerCase());
  }
  const labelsToRemove = [...new Map([
    ...evaluation.mutationPlan.removePublicLabels,
    ...evaluation.mutationPlan.removeInternalLabels,
  ].map((label) => [label.toLowerCase(), label])).values()].sort(compareFoldedText);
  for (const label of labelsToRemove) {
    stateMutations.push({
      type: 'issue-label.remove',
      key: `issue-label:${label.toLowerCase()}`,
      principal: installationPrincipal,
      label,
      observedLabelsDigest: await labelsDigest(),
    });
    expectedLabels.delete(label.trim().toLowerCase());
  }

  const externalId = stewardCheckExternalId({
    repositoryId: context.subject.repository.id,
    prNumber: context.subject.pullRequest.number,
    headSha: context.subject.pullRequest.headSha,
    checkId: 'pr-classification',
    configDigest: context.subject.manifest.configDigest,
    inputDigest: fingerprint.value,
  });
  const checkUpdate: CheckRunUpdate = {
    name: 'PR Classification Gate',
    status: 'completed',
    externalId,
    conclusion: 'success',
    ...(context.detailsUrl ? { detailsUrl: context.detailsUrl } : {}),
    title: 'PR 分类已更新',
    summary: classificationCheckSummary(evaluation),
  };
  const mutations: ControlMutationIntent[] = [{
    type: 'check-run.upsert',
    key: 'check-run:pr-classification:start',
    principal: installationPrincipal,
    mode: 'update',
    checkRunId: snapshot.lease.checkRunId,
    input: {
      name: checkUpdate.name,
      status: 'in_progress',
      externalId: snapshot.lease.externalId,
      ...(context.detailsUrl ? { detailsUrl: context.detailsUrl } : {}),
      title: 'PR 分类同步中',
      summary: 'Steward 正在使分类标签与当前输入收敛。',
    } satisfies CheckRunUpdate,
    observedLabelsDigest: initialLabelsDigest,
    observedCheckExternalId: snapshot.lease.externalId,
  }, ...stateMutations, {
    type: 'check-run.upsert',
    key: 'check-run:pr-classification:complete',
    principal: installationPrincipal,
    mode: 'update',
    checkRunId: snapshot.lease.checkRunId,
    input: checkUpdate,
    observedLabelsDigest: await labelsDigest(),
    observedCheckExternalId: snapshot.lease.externalId,
  }];

  const result: ControlOperationResult = {
    operation: 'classification',
    state: 'passed',
    summary: 'PR classification converged',
    details: { evaluation, fingerprint: fingerprint.value },
  };
  return {
    result,
    plan: await finalizeControlPlan({
      objective: 'classification',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: {
        featureEnabled: true,
        lease: snapshot.lease,
        pull: {
          title: context.pull.title,
          body: contributorBody,
          authorLogin: context.pull.user?.login ?? null,
          authorType: context.pull.user?.type ?? null,
          baseRef: context.pull.base.ref,
          baseSha: context.pull.base.sha ?? null,
          headRef: context.pull.head.ref ?? null,
          headSha: context.pull.head.sha,
          labels: currentLabels,
        },
        commits,
        files,
      },
      outcome: { state: result.state, summary: result.summary },
      mutations,
    }),
  };
}

function boundedDcoText(value: unknown): string {
  const normalized = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function safeDcoMarkdown(value: unknown, shieldMentions: boolean): string {
  const escaped = boundedDcoText(value)
    .replace(/&/g, '&amp;')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, shieldMentions ? '@\u200b' : '@');
  return boundedDcoText(escaped);
}

function dcoIssueReason(issue: DcoIssue): string {
  if (issue.reason === 'missing') {
    return `缺少 Signed-off-by；建议添加 \`Signed-off-by: ${safeDcoMarkdown(issue.authorName, false) || 'Name'} <${safeDcoMarkdown(issue.authorEmail, false) || 'email@example.com'}>\``;
  }
  if (issue.reason === 'invalid-format') return 'Signed-off-by 格式无效；应使用 `Signed-off-by: Name <email>`';
  const signed = issue.signedEmails.map((value) => safeDcoMarkdown(value, false)).join(', ') || 'none';
  const truncated = issue.signedEmailsTruncated ? `（另有 ${issue.signedEmailsTruncated} 个未展开）` : '';
  return `Signed-off-by 邮箱与 commit author email 不一致；author email 为 \`${safeDcoMarkdown(issue.authorEmail, false) || 'unknown'}\`，当前签名邮箱为 \`${signed}\`${truncated}`;
}

function presentDcoIssue(issue: DcoIssue): DcoIssue {
  return {
    ...issue,
    subject: safeDcoMarkdown(issue.subject, true),
    authorName: safeDcoMarkdown(issue.authorName, true),
    authorEmail: boundedDcoText(issue.authorEmail),
    signedEmails: issue.signedEmails.map(boundedDcoText),
  };
}

function dcoSummary(evaluation: DcoEvaluation): string {
  const lines = [
    `DCO Sign-off Advisory：${evaluation.total} commits，${evaluation.passed} passed，${evaluation.skipped} skipped bots，${evaluation.issues.length} advisory issues。`,
  ];
  for (const issue of evaluation.issues.slice(0, maxDcoIssues)) {
    lines.push(`- \`${issue.sha.slice(0, 7)}\` ${safeDcoMarkdown(issue.subject, true) || '(empty commit message)'}: ${dcoIssueReason(issue)}`);
  }
  if (evaluation.issues.length > maxDcoIssues) {
    lines.push(`- 另有 ${evaluation.issues.length - maxDcoIssues} 项未展开；请查看 operation-result。`);
  }
  return lines.join('\n');
}

function normalizedDcoCommit(commit: GitHubCommit): Parameters<typeof evaluateDcoAdvisory>[0][number] {
  const sha = String(commit.sha ?? '').toLowerCase();
  const message = commit.commit?.message;
  if (!/^[a-f0-9]{40}$/.test(sha) || typeof message !== 'string') {
    throw new Error('GitHub returned a pull request commit without a valid SHA or message');
  }
  return {
    sha,
    message,
    author: {
      login: String(commit.author?.login ?? ''),
      type: String(commit.author?.type ?? ''),
      name: String(commit.commit?.author?.name ?? ''),
      email: String(commit.commit?.author?.email ?? ''),
    },
    committer: {
      login: String(commit.committer?.login ?? ''),
      type: String(commit.committer?.type ?? ''),
      name: String(commit.commit?.committer?.name ?? ''),
      email: String(commit.commit?.committer?.email ?? ''),
    },
  };
}

export async function planDcoAdvisory(
  context: PullRequestControlContext,
  snapshot: DcoSnapshot | null,
): Promise<ControlDecision> {
  context = { ...context, manifest: await verifyLoadedManifest(context.manifest) };
  assertPullRequestControlContext(context);
  if (!context.manifest.manifest.features.dcoAdvisory) {
    const result = ignoredResult('dco-advisory', 'DCO Advisory feature is disabled');
    return {
      result,
      plan: await finalizeControlPlan({
        objective: 'dco-advisory',
        subject: context.subject,
        pullRequest: context.pull,
        snapshot: { featureEnabled: false },
        outcome: { state: result.state, summary: result.summary },
        mutations: [],
      }),
    };
  }
  if (!snapshot) throw new Error('DCO Advisory planning requires a live snapshot');
  if (!snapshot.commits.length) throw new Error('GitHub returned no commits for an open pull request');
  const commits = snapshot.commits.map(normalizedDcoCommit);
  const evaluation = evaluateDcoAdvisory(commits, { botLogins: controlBotLogins(context) });
  const appSlug = context.subject.platform.appSlug.toLowerCase();
  const actorId = Number(snapshot.actor.id ?? 0);
  const actorLogin = String(snapshot.actor.login ?? '').trim().toLowerCase();
  const expectedActorLogin = `${appSlug}[bot]`;
  if (!Number.isSafeInteger(actorId) || actorId <= 0
    || actorLogin !== expectedActorLogin
    || String(snapshot.actor.type ?? '').toLowerCase() !== 'bot') {
    throw new Error('DCO Advisory requires the bound GitHub App bot identity');
  }
  const legacy = snapshot.comments.filter((comment) => (
    comment.user?.id === actorId
    && String(comment.user.login ?? '').trim().toLowerCase() === expectedActorLogin
    && String(comment.user.type ?? '').toLowerCase() === 'bot'
    && String(comment.body ?? '').includes(legacyDcoMarker)
  )).sort((left, right) => left.id - right.id);
  if (legacy.some((comment) => (
    comment.performed_via_github_app != null
    && (String(comment.performed_via_github_app.slug ?? '').toLowerCase() !== appSlug
      || (comment.performed_via_github_app.id !== undefined
        && comment.performed_via_github_app.id !== context.subject.platform.appId))
  ))) {
    throw new Error('GitHub returned inconsistent App provenance for a legacy DCO comment');
  }
  if (legacy.some((comment) => !Number.isSafeInteger(comment.id) || comment.id <= 0)) {
    throw new Error('GitHub returned an App-owned legacy comment without a valid ID');
  }
  const mutations: ControlMutationIntent[] = [];
  for (const comment of legacy) {
    const body = String(comment.body ?? '');
    mutations.push({
      type: 'issue-comment.delete',
      key: `issue-comment:dco-legacy:${comment.id}`,
      principal: installationPrincipal,
      commentId: comment.id,
      expectedOwnerId: actorId,
      expectedOwnerLogin: expectedActorLogin,
      observedBodyDigest: await controlJsonDigest(body),
    });
  }
  const summary = dcoSummary(evaluation);
  const result: ControlOperationResult = {
    operation: 'dco-advisory',
    state: 'passed',
    summary,
    details: {
      evaluation: { ...evaluation, issues: evaluation.issues.slice(0, maxDcoIssues).map(presentDcoIssue) },
      issuesTruncated: Math.max(0, evaluation.issues.length - maxDcoIssues),
      legacyCommentsDeleted: legacy.length,
    },
  };
  return {
    result,
    plan: await finalizeControlPlan({
      objective: 'dco-advisory',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: {
        featureEnabled: true,
        actor: { id: actorId, login: actorLogin, type: 'bot' },
        commits,
        legacyComments: legacy.map((comment) => ({
          id: comment.id,
          ownerId: comment.user?.id,
          ownerLogin: String(comment.user?.login ?? '').toLowerCase(),
          body: String(comment.body ?? ''),
        })),
      },
      outcome: { state: result.state, summary: result.summary },
      mutations,
    }),
  };
}
