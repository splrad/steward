import {
  blockingFailuresMarker,
  classifyPullRequestAuthor,
  cleanupEphemeralCommentMarkers,
  closeStatusMarker,
  copilotFailureModels,
  copilotThreadFindings,
  coreReviewersToRequest,
  decodeBlockingState,
  encodeBlockingState,
  evaluateCopilotGate,
  evaluatePullRequestCleanup,
  evaluateMainAuthorization,
  evaluateMatrix,
  fingerprintForPull,
  formatMentions,
  hashJson,
  isBotLogin,
  mainAuthorizationFailureModel,
  matrixConclusion,
  matrixLiveEvidenceDigest,
  nextBlockingFailuresState,
  normalizeBlockingFailure,
  normalizeGitHubLogin,
  orderedBlockingFailures,
  parseStewardCheckExternalId,
  planMatrixRepairs,
  planCopilotReviewRequest,
  planProxyCompletions,
  selectCurrentHeadReviews,
  stewardCheckExternalId,
  workflowRunId,
  workflowRunMatchesTarget,
  type GovernanceFailureModel,
  type BlockingFailure,
  type CleanupNotification,
  type MatrixCheckRun,
  type MatrixRepairPlan,
  type MatrixWorkflowRun,
} from '../../packages/core/src/index.js';
import {
  type GitHubCheckRun,
  type GitHubCommit,
  type GitHubPullRequestFile,
  type GitHubPullRequestReview,
  type GitHubRepositoryClient,
} from '../../packages/github/src/index.js';
import {
  reconcileClassification,
  reconcileDcoAdvisory,
  type ControlOperationState,
} from '../../packages/control/src/index.js';
import type { StewardActionInputs, StewardOperation } from './contracts.js';
import { parseMatrixMode, parseMatrixScope } from './contracts.js';
import { enabledMatrixConfiguration } from './catalog.js';
import type { StewardControlOperationContext, StewardOperationContext } from './context.js';
import { trustedWorkflowRunContext } from './context.js';

export interface StewardOperationResult {
  operation: StewardOperation;
  state: ControlOperationState;
  summary: string;
  details?: unknown;
}

interface PullFacts {
  commits: GitHubCommit[];
  files: GitHubPullRequestFile[];
  reviews: GitHubPullRequestReview[];
  fingerprint: Awaited<ReturnType<typeof fingerprintForPull>>;
}

const autoApprovalMarker = '<!-- workflow:auto-approval -->';
export const stewardRuntimeIdentity = {
  appId: 4243096,
  clientId: 'Iv23liuSr0qd4WLJdZhH',
  appSlug: 'splrad-steward',
} as const;

export async function executeControlOperation(
  operation: 'classification' | 'dco-advisory',
  context: StewardControlOperationContext,
): Promise<StewardOperationResult> {
  const reconcile = operation === 'classification' ? reconcileClassification : reconcileDcoAdvisory;
  return (await reconcile(context.route, {
    identity: stewardRuntimeIdentity,
    read: context.client,
    installation: context.client,
  })).result;
}

function safeCleanupText(value: unknown): string {
  const normalized = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const bounded = normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
  const escaped = bounded
    .replace(/&/g, '&amp;')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b');
  return escaped.length <= 240 ? escaped : `${escaped.slice(0, 239)}…`;
}

function cleanupIdentity(value: string): string | null {
  const login = normalizeGitHubLogin(value);
  return login && login !== 'unknown' ? login : null;
}

function renderCleanupNotification(
  notification: CleanupNotification,
  handlers: readonly string[],
  configuredBots: readonly string[],
): string {
  const notificationAuthor = cleanupIdentity(notification.author);
  const notificationMerger = cleanupIdentity(notification.mergedBy);
  const author = formatMentions(notificationAuthor ? [notificationAuthor] : [], {
    botLogins: configuredBots,
    emptyText: 'unknown',
  });
  const mergedBy = formatMentions(notificationMerger ? [notificationMerger] : [], {
    botLogins: configuredBots,
    emptyText: 'unknown',
  });
  const recipients = formatMentions(notificationAuthor ? [...handlers, notificationAuthor] : handlers, {
    botLogins: configuredBots,
    emptyText: '核心维护者',
  });
  return [
    closeStatusMarker,
    '## PR 合并成功并关闭',
    '',
    `- PR 链接：#${notification.pullNumber}`,
    `- 标题：${safeCleanupText(notification.title)}`,
    `- 分支流向：${safeCleanupText(notification.sourceRef)} -> ${safeCleanupText(notification.targetRef)}`,
    `- 提交人：${author}`,
    '- 关闭原因：已成功合并',
    `- 合并人：${mergedBy}`,
    `- 合并提交：\`${notification.mergeCommitSha}\``,
    `- 通知对象：${recipients}`,
    '',
    '> 本通知由 SPLRAD Steward 自动维护。',
  ].join('\n');
}

async function cleanupOperation(context: StewardOperationContext): Promise<StewardOperationResult> {
  const comments = await context.client.listIssueComments(context.owner, context.repository, context.pull.number);
  const evaluation = evaluatePullRequestCleanup({
    number: context.pull.number,
    merged: context.pull.merged === true,
    mergeCommitSha: context.pull.mergeCommitSha,
    title: context.pull.title,
    body: context.pull.body,
    authorLogin: context.pull.user?.login,
    headRef: context.pull.head.ref,
    baseRef: context.pull.base.ref,
    mergedBy: context.pull.merged_by?.login,
  }, { botLogins: botLogins(context) });
  const appSlug = context.manifest.manifest.automation.githubApp.slug.toLowerCase();
  const owned = comments.filter((comment) => normalizeAppLogin(comment.user?.login) === appSlug);
  const ephemeral = owned.filter((comment) => cleanupEphemeralCommentMarkers.some(
    (marker) => String(comment.body ?? '').includes(marker),
  ));
  const ephemeralIds = new Set(ephemeral.map((comment) => comment.id));
  const closeComments = owned.filter((comment) => (
    !ephemeralIds.has(comment.id) && String(comment.body ?? '').includes(closeStatusMarker)
  ));
  const deleteIds = new Set(ephemeralIds);
  if (!evaluation.merged) {
    for (const comment of closeComments) deleteIds.add(comment.id);
  } else {
    for (const comment of closeComments.slice(1)) deleteIds.add(comment.id);
  }
  const notificationBody = evaluation.notification
    ? renderCleanupNotification(evaluation.notification, await maintainers(context), botLogins(context))
    : null;
  for (const commentId of deleteIds) {
    await context.client.deleteIssueComment(context.owner, context.repository, commentId);
  }

  let notificationAction: 'none' | 'create' | 'update' | 'unchanged' = 'none';
  if (notificationBody) {
    const existing = closeComments[0];
    if (!existing) {
      await context.client.createIssueComment(context.owner, context.repository, context.pull.number, notificationBody);
      notificationAction = 'create';
    } else if (existing.body !== notificationBody) {
      await context.client.updateIssueComment(context.owner, context.repository, existing.id, notificationBody);
      notificationAction = 'update';
    } else {
      notificationAction = 'unchanged';
    }
  }
  return {
    operation: 'cleanup',
    state: 'passed',
    summary: evaluation.merged
      ? `Merged PR cleanup converged; ${ephemeral.length} temporary comments removed; notification ${notificationAction}`
      : `Closed PR cleanup converged; ${ephemeral.length} temporary comments removed; no merge notification`,
    details: {
      merged: evaluation.merged,
      removedEphemeralComments: ephemeral.length,
      removedCloseComments: [...deleteIds].filter((id) => !ephemeralIds.has(id)).length,
      notificationAction,
    },
  };
}

function mutationClient(context: StewardOperationContext): GitHubRepositoryClient {
  if (!context.mutationClient) throw new Error('This Steward operation requires a separate mutation token');
  return context.mutationClient;
}

function botLogins(context: StewardOperationContext): string[] {
  return [context.manifest.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'];
}

function normalizeAppLogin(value: unknown): string {
  return normalizeGitHubLogin(String(value ?? '').trim().replace(/\[bot\]$/i, '')).toLowerCase();
}

async function maintainers(context: StewardOperationContext): Promise<string[]> {
  const source = context.manifest.manifest.automation.maintainers;
  if (source.source === 'users') return [...source.logins];
  return (await context.client.listTeamMembers(context.owner, source.teamSlug))
    .map((member) => String(member.login ?? '').trim())
    .filter(Boolean);
}

async function pullFacts(context: StewardOperationContext): Promise<PullFacts> {
  const [commits, files, reviews] = await Promise.all([
    context.client.listPullRequestCommits(context.owner, context.repository, context.pull.number),
    context.client.listPullRequestFiles(context.owner, context.repository, context.pull.number),
    context.client.listPullRequestReviews(context.owner, context.repository, context.pull.number),
  ]);
  return {
    commits,
    files,
    reviews,
    fingerprint: await fingerprintForPull({
      pull: context.pull,
      commits,
      files,
      botLogins: botLogins(context),
    }),
  };
}

async function openPullNumbersForHead(context: StewardOperationContext): Promise<number[]> {
  const associated = await context.client.listPullRequestsForCommit(
    context.owner,
    context.repository,
    context.pull.head.sha,
  );
  const expectedHead = context.pull.head.sha.toLowerCase();
  const openNumbers: number[] = [];
  for (const pull of associated) {
    if (pull.state !== 'open') continue;
    const number = Number(pull.number);
    const headSha = String(pull.head?.sha ?? '').toLowerCase();
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(headSha)) {
      throw new Error('Commit-associated open pull request metadata is malformed');
    }
    // GitHub returns every PR associated with the commit, including PRs whose
    // current head has advanced past it. Only exact current-head equality is a
    // commit-level required-Check collision.
    if (headSha === expectedHead) openNumbers.push(number);
  }
  return [...new Set(openNumbers)].sort((left, right) => left - right);
}

async function assertExclusiveOpenPullForHead(context: StewardOperationContext): Promise<void> {
  const openNumbers = await openPullNumbersForHead(context);
  if (openNumbers.length !== 1 || openNumbers[0] !== context.pull.number) {
    throw new Error(
      `Matrix requires an exclusive open pull request for head ${context.pull.head.sha}; observed ${
        openNumbers.length ? openNumbers.join(',') : 'none'}`,
    );
  }
}

function isBotCommit(commit: GitHubCommit, configuredBots: readonly string[]): boolean {
  const logins = [commit.author?.login, commit.committer?.login].map((value) => String(value ?? '').toLowerCase());
  const types = [commit.author?.type, commit.committer?.type].map((value) => String(value ?? '').toLowerCase());
  const names = [commit.commit?.author?.name, commit.commit?.committer?.name].map((value) => String(value ?? '').toLowerCase());
  const emails = [commit.commit?.author?.email, commit.commit?.committer?.email].map((value) => String(value ?? '').toLowerCase());
  return types.includes('bot')
    || logins.some((login) => isBotLogin(login, configuredBots))
    || [...logins, ...names, ...emails].some((value) => value.endsWith('[bot]') || value.includes('[bot]@'))
    || [...logins, ...names].some((value) => value === 'github-actions' || value === 'dependabot');
}

function unidentifiedCommits(commits: readonly GitHubCommit[], configuredBots: readonly string[]): string[] {
  return commits.filter((commit) => (
    !normalizeGitHubLogin(commit.author?.login) && !isBotCommit(commit, configuredBots)
  )).map((commit) => {
    const author = String(commit.commit?.author?.name ?? commit.commit?.author?.email ?? '').trim();
    return author || String(commit.sha ?? '').slice(0, 12) || 'unknown commit author';
  });
}

async function writeCheck(input: {
  context: StewardOperationContext;
  checks: readonly GitHubCheckRun[];
  checkId: string;
  name: string;
  inputDigest: string;
  status: 'queued' | 'in_progress' | 'completed';
  detailsUrl?: string | null;
  checkRunId?: number;
  expectedCurrentExternalId?: string;
  createOnAmbiguousActive?: boolean;
  startNewRunIfCompleted?: boolean;
  reuseCanonicalInProgress?: boolean;
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
  title: string;
  summary: string;
}): Promise<GitHubCheckRun> {
  const externalId = stewardCheckExternalId({
    repositoryId: input.context.repositoryId,
    prNumber: input.context.pull.number,
    headSha: input.context.pull.head.sha,
    checkId: input.checkId,
    configDigest: input.context.manifest.configDigest,
    inputDigest: input.inputDigest,
  });
  const pendingStatuses = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
  const trusted = input.checks.filter((check) => (
    check.name === input.name
    && Number(check.app?.id ?? 0) === stewardRuntimeIdentity.appId
    && String(check.app?.slug ?? '') === input.context.manifest.manifest.automation.githubApp.slug
    && String(check.head_sha ?? '').toLowerCase() === input.context.pull.head.sha.toLowerCase()
  ));
  if (trusted.some((check) => !Number.isSafeInteger(check.id) || check.id < 1)) {
    throw new Error(`Refusing to update ${input.name} with malformed trusted Check IDs`);
  }
  const latestTrusted = [...trusted].sort((left, right) => left.id - right.id).at(-1);
  const canonicalInProgress = input.reuseCanonicalInProgress === true
    ? trusted.filter((check) => {
        if (!pendingStatuses.has(String(check.status ?? ''))
          || String(check.head_sha ?? '').toLowerCase() !== input.context.pull.head.sha.toLowerCase()) return false;
        const identity = parseStewardCheckExternalId(check.external_id);
        return identity?.repositoryId === input.context.repositoryId
          && identity.prNumber === input.context.pull.number
          && identity.headSha === input.context.pull.head.sha.toLowerCase()
          && identity.checkId === input.checkId
          && identity.configDigest === input.context.manifest.configDigest;
      })
    : [];
  if (canonicalInProgress.length > 1 && input.createOnAmbiguousActive !== true) {
    throw new Error(`Refusing to update ambiguous active ${input.name} generations`);
  }
  const forceNewGeneration = canonicalInProgress.length > 1;
  const candidates = trusted
    .filter((check) => check.external_id === externalId || canonicalInProgress.includes(check))
    .sort((left, right) => left.id - right.id);
  const candidate = candidates.at(-1);
  // The transitional adapter uses the highest observed numeric Check Run ID as
  // a conservative generation hint. GitHub does not document this as a durable
  // ordering contract; the production writer still requires a persisted DO
  // generation/lease. Never patch an older observed run behind a higher one.
  const existing = !forceNewGeneration && candidate?.id === latestTrusted?.id ? candidate : undefined;
  const detailsUrl = input.detailsUrl === null ? '' : input.detailsUrl || input.context.detailsUrl;
  const update = {
    name: input.name,
    status: input.status,
    externalId,
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(detailsUrl ? { detailsUrl } : {}),
    title: input.title,
    summary: input.summary,
  };
  let written: GitHubCheckRun;
  let expectedWrittenId: number | undefined;
  if (input.checkRunId !== undefined) {
    if (!Number.isSafeInteger(input.checkRunId) || input.checkRunId < 1) {
      throw new Error(`Refusing to update ${input.name} with an invalid Check Run ID`);
    }
    const observed = input.checks.find((check) => check.id === input.checkRunId);
    if (observed && !trusted.includes(observed)) {
      throw new Error(`Refusing to update ${input.name} after its started generation changed identity`);
    }
    if (latestTrusted && latestTrusted.id > input.checkRunId) {
      throw new Error(`Refusing to update superseded ${input.name} generation ${input.checkRunId}`);
    }
    if (input.expectedCurrentExternalId !== undefined) {
      if (!observed) {
        throw new Error(`Refusing to update ${input.name} without observing its started generation`);
      }
      if (observed.external_id !== input.expectedCurrentExternalId
        || !pendingStatuses.has(String(observed.status ?? ''))
        || observed.conclusion != null) {
        throw new Error(`Refusing to update ${input.name} after its started generation changed identity or state`);
      }
    }
    expectedWrittenId = input.checkRunId;
    written = await input.context.client.updateCheckRun(
      input.context.owner,
      input.context.repository,
      input.checkRunId,
      update,
    );
  } else {
    const startNewRun = input.startNewRunIfCompleted === true
      && input.status !== 'completed'
      && existing?.status === 'completed';
    if (existing && !startNewRun) {
      expectedWrittenId = existing.id;
      written = await input.context.client.updateCheckRun(
        input.context.owner,
        input.context.repository,
        existing.id,
        update,
      );
    } else {
      written = await input.context.client.createCheckRun(input.context.owner, input.context.repository, {
        ...update,
        headSha: input.context.pull.head.sha,
      });
    }
  }
  const responseConclusionMatches = input.conclusion !== undefined
    ? written.conclusion === input.conclusion
    : written.conclusion == null;
  if (!Number.isSafeInteger(written.id) || written.id < 1
    || (expectedWrittenId !== undefined && written.id !== expectedWrittenId)
    || written.name !== input.name
    || String(written.head_sha ?? '').toLowerCase() !== input.context.pull.head.sha.toLowerCase()
    || Number(written.app?.id ?? 0) !== stewardRuntimeIdentity.appId
    || String(written.app?.slug ?? '') !== input.context.manifest.manifest.automation.githubApp.slug
    || written.external_id !== externalId
    || written.status !== input.status
    || !responseConclusionMatches) {
    throw new Error(`${input.name} mutation response did not preserve the requested Check identity and state`);
  }
  return written;
}

function failureTitle(model: GovernanceFailureModel): string {
  const titles: Record<GovernanceFailureModel['presentation'], string> = {
    'main.unidentified-authors': '⚠️ 贡献者信息识别异常',
    'main.missing-contributors': '⚠️ 贡献者信息识别异常',
    'main.approval-required': '🔒 核心开发者审批',
    'main.review-evidence': '⚠️ 审查证据异常',
    'copilot.blocking-comments': '🚫 Copilot 阻断评论',
    'copilot.comment-protocol': '⚠️ Copilot Review 评论格式异常',
    'copilot.request-failed': '⚠️ Copilot Review 请求失败',
    'copilot.passing-conclusion': '⚠️ Copilot Review 状态异常',
  };
  return titles[model.presentation];
}

function failureDetails(model: GovernanceFailureModel): string[] {
  if (model.presentation === 'main.unidentified-authors') {
    return [
      '部分提交作者未关联到可识别的 GitHub 账号。',
      model.reviewRequestState === 'failed'
        ? 'Review Request 自动发送失败，请核对提交作者并检查 Main Authorization Gate 日志。'
        : '已向核心开发者发送 Review Request，请核对提交作者并提交 **Approve**。',
      ...model.items,
    ];
  }
  if (model.presentation === 'main.missing-contributors') {
    return [
      '门禁未识别到当前 PR 的真实贡献者。',
      '请检查 PR contributor metadata 和 commit author 关联，并重新运行门禁。',
    ];
  }
  if (model.presentation === 'main.approval-required') {
    return [
      '当前 PR 尚未获得所需审批。',
      model.reviewRequestState === 'failed'
        ? 'Review Request 自动发送失败，请完成审查并检查 Main Authorization Gate 日志。'
        : '已向可请求的核心开发者发送 Review Request，请完成审查并提交 **Approve**。',
    ];
  }
  if (model.presentation === 'main.review-evidence') {
    return ['GitHub 返回的审查记录缺少可信的提交、审查者或状态信息，请由核心维护者检查 Main Authorization Gate 日志。'];
  }
  if (model.presentation === 'copilot.request-failed') return ['Copilot 审查请求未成功完成，请由核心维护者检查请求 job。'];
  if (model.presentation === 'copilot.passing-conclusion') return ['门禁未识别到 Copilot 的有效通过结论。'];
  return [...model.items];
}

function renderBlockingComment(head: string, failures: readonly BlockingFailure[]): string {
  const ordered = orderedBlockingFailures(failures);
  const sections = ordered.map((failure) => {
    const handlers = formatMentions(failure.handlers);
    const items = failure.details.map((item) => `- ${item}`).join('\n');
    return [
      `\x23\x23\x23 ${failure.title}`,
      handlers ? `处理人：${handlers}` : '处理人：核心维护者',
      items,
    ].filter(Boolean).join('\n');
  });
  const state = {
    head,
    failures: ordered,
  };
  return [
    '\x23\x23 🚧 PR 合并前有待处理事项',
    blockingFailuresMarker,
    '',
    ...sections.flatMap((section) => [section, '']),
    '> 🤖 本评论由 GitHub Actions 自动维护，全部阻断解除后将自动删除。',
    '',
    `<!-- workflow:pr-blocking-failures-state:${encodeBlockingState(state)} -->`,
  ].join('\n').trim();
}

async function syncBlockingComment(
  context: StewardOperationContext,
  sourcePrefix: string,
  models: readonly GovernanceFailureModel[],
): Promise<void> {
  const comments = await context.client.listIssueComments(context.owner, context.repository, context.pull.number);
  const appSlug = context.manifest.manifest.automation.githubApp.slug.toLowerCase();
  const owned = comments.filter((comment) => {
    const login = normalizeAppLogin(comment.user?.login);
    return login === appSlug;
  });
  const legacyMarker = sourcePrefix === 'main-authorization'
    ? '<!-- workflow:main-authorization-gate -->'
    : '<!-- workflow:copilot-review-gate -->';
  const aggregate = owned.find((comment) => String(comment.body ?? '').includes(blockingFailuresMarker));
  const legacy = owned.filter((comment) => String(comment.body ?? '').includes(legacyMarker));
  const existing = aggregate ?? legacy[0];
  const existingState = decodeBlockingState(existing?.body);
  if (aggregate && !existingState) throw new Error('Existing aggregate blocking comment has invalid hidden state');
  const state = nextBlockingFailuresState(existingState, context.pull.head.sha, {
    sourcePrefix,
    failures: models.map((model) => ({
      source: model.source,
      title: failureTitle(model),
      handlers: model.handlers,
      details: failureDetails(model),
    })),
    botLogins: botLogins(context),
  });
  const failures = state.failures.map((failure) => normalizeBlockingFailure(failure, botLogins(context)));
  if (!failures.length) {
    if (existing) await context.client.deleteIssueComment(context.owner, context.repository, existing.id);
    for (const comment of legacy.filter((comment) => comment.id !== existing?.id)) {
      await context.client.deleteIssueComment(context.owner, context.repository, comment.id);
    }
    return;
  }
  const body = renderBlockingComment(context.pull.head.sha, failures);
  if (existing) await context.client.updateIssueComment(context.owner, context.repository, existing.id, body);
  else await context.client.createIssueComment(context.owner, context.repository, context.pull.number, body);
  for (const comment of legacy.filter((comment) => comment.id !== existing?.id)) {
    await context.client.deleteIssueComment(context.owner, context.repository, comment.id);
  }
}

async function requestCopilot(context: StewardOperationContext): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.copilotReview) {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot review is disabled' };
  }
  const author = classifyPullRequestAuthor(context.pull.user);
  const preliminary = planCopilotReviewRequest({
    author,
    headSha: context.pull.head.sha,
    ...(context.pull.requested_reviewers === undefined
      ? {}
      : { requestedReviewers: context.pull.requested_reviewers }),
  });
  if (preliminary.reason === 'copilot-pending') {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot review is already requested' };
  }
  if (preliminary.state === 'observe-native') {
    return {
      operation: 'governance-request-copilot',
      state: 'ignored',
      summary: 'Copilot review for a human author is organization-managed',
    };
  }
  if (preliminary.state === 'action-required') {
    return {
      operation: 'governance-request-copilot',
      state: 'failed',
      summary: 'Pull request author identity is not trustworthy enough to request Copilot',
    };
  }
  const reviews = await context.client.listPullRequestReviews(context.owner, context.repository, context.pull.number);
  const plan = planCopilotReviewRequest({
    author,
    headSha: context.pull.head.sha,
    ...(context.pull.requested_reviewers === undefined
      ? {}
      : { requestedReviewers: context.pull.requested_reviewers }),
    reviews,
  });
  if (plan.reason === 'copilot-pending') {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot review is already pending' };
  }
  if (plan.reason === 'copilot-reviewed-current-head') {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot already reviewed the current head' };
  }
  if (plan.state === 'action-required') {
    return {
      operation: 'governance-request-copilot',
      state: 'failed',
      summary: 'Current-head review evidence is malformed',
    };
  }
  if (plan.state !== 'request') {
    throw new Error(`Unsupported Copilot review request plan ${plan.state}`);
  }
  await mutationClient(context).requestReviewers({
    owner: context.owner,
    repository: context.repository,
    number: context.pull.number,
    reviewers: ['copilot-pull-request-reviewer[bot]'],
  });
  return { operation: 'governance-request-copilot', state: 'passed', summary: 'Copilot review requested' };
}

async function autoApprove(context: StewardOperationContext): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.governance) {
    return { operation: 'governance-auto-approve', state: 'ignored', summary: 'Governance is disabled' };
  }
  const mutations = mutationClient(context);
  const [facts, trusted, actor] = await Promise.all([pullFacts(context), maintainers(context), mutations.getAuthenticatedUser()]);
  const trustedSet = new Set(trusted.map((login) => login.toLowerCase()));
  const author = normalizeGitHubLogin(context.pull.user?.login).toLowerCase();
  const actorLogin = normalizeGitHubLogin(actor.login);
  const currentReviews = selectCurrentHeadReviews(facts.reviews, context.pull.head.sha);
  if (currentReviews.malformed) {
    return {
      operation: 'governance-auto-approve',
      state: 'ignored',
      summary: 'Automatic approval skipped because current-head review evidence is malformed',
    };
  }
  const alreadyApproved = currentReviews.reviews.some((review) => (
    review.state === 'APPROVED' && normalizeGitHubLogin(review.user?.login).toLowerCase() === actorLogin.toLowerCase()
  ));
  if (!actorLogin || actorLogin.toLowerCase() === author || !trustedSet.has(actorLogin.toLowerCase())
    || facts.fingerprint.contributors.some((login) => !trustedSet.has(login))
    || unidentifiedCommits(facts.commits, botLogins(context)).length || alreadyApproved) {
    return { operation: 'governance-auto-approve', state: 'ignored', summary: 'Automatic approval is not applicable' };
  }
  await mutations.createPullRequestReview({
    owner: context.owner,
    repository: context.repository,
    number: context.pull.number,
    commitId: context.pull.head.sha,
    event: 'APPROVE',
    body: `${autoApprovalMarker}\n自动审批：全部真实贡献者均在核心开发者名单中。`,
  });
  return { operation: 'governance-auto-approve', state: 'passed', summary: `Approved as ${actorLogin}` };
}

async function mainGovernance(context: StewardOperationContext): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.governance) {
    await syncBlockingComment(context, 'main-authorization', []);
    return { operation: 'governance-main', state: 'ignored', summary: 'Governance is disabled' };
  }
  const [facts, trusted, checks] = await Promise.all([
    pullFacts(context),
    maintainers(context),
    context.client.listCommitCheckRuns(context.owner, context.repository, context.pull.head.sha),
  ]);
  const currentReviews = selectCurrentHeadReviews(facts.reviews, context.pull.head.sha);
  if (currentReviews.malformed) {
    const summary = 'failed_current_head_review_evidence_malformed';
    await syncBlockingComment(context, 'main-authorization', [{
      source: 'main-authorization',
      presentation: 'main.review-evidence',
      handlers: trusted,
      items: [],
      reviewRequestState: 'not-requested',
    }]);
    await writeCheck({
      context,
      checks,
      checkId: 'main-authorization',
      name: 'Main Authorization Gate',
      inputDigest: facts.fingerprint.value,
      status: 'completed',
      conclusion: 'failure',
      title: '主分支授权门禁无法验证审查证据',
      summary,
    });
    return {
      operation: 'governance-main',
      state: 'failed',
      summary,
      details: { malformedReviewEvidence: true },
    };
  }
  const approved = currentReviews.reviews.filter((review) => review.state === 'APPROVED');
  const trustedSet = new Set(trusted.map((login) => login.toLowerCase()));
  const approvers = approved.map((review) => review.user?.login).filter((login) => trustedSet.has(normalizeGitHubLogin(login).toLowerCase()));
  const manualApprovers = approved.filter((review) => !String(review.body ?? '').includes(autoApprovalMarker))
    .map((review) => review.user?.login).filter((login) => trustedSet.has(normalizeGitHubLogin(login).toLowerCase()));
  const decision = evaluateMainAuthorization({
    contributors: facts.fingerprint.contributors,
    unidentifiedAuthors: unidentifiedCommits(facts.commits, botLogins(context)),
    trustedDevelopers: trusted,
    trustedApprovers: approvers,
    trustedManualApprovers: manualApprovers,
    botLogins: botLogins(context),
  });
  let reviewRequest: { ok: boolean; eligible: string[] } | null = null;
  if (decision.needsReviewRequest) {
    const plan = coreReviewersToRequest({
      trusted,
      author: context.pull.user?.login,
      requested: context.pull.requested_reviewers?.map((reviewer) => reviewer.login) ?? [],
      reviewed: [...currentReviews.reviews, ...currentReviews.pendingReviews]
        .map((review) => review.user?.login),
      botLogins: botLogins(context),
    });
    reviewRequest = { ok: true, eligible: plan.eligible };
    if (plan.missing.length) {
      try {
        await context.client.requestReviewers({
          owner: context.owner, repository: context.repository, number: context.pull.number, reviewers: plan.missing,
        });
      } catch {
        reviewRequest.ok = false;
      }
    }
  }
  const model = mainAuthorizationFailureModel({
    decision,
    coreHandlers: trusted,
    reviewRequest,
    botLogins: botLogins(context),
  });
  await syncBlockingComment(context, 'main-authorization', model ? [model] : []);
  await writeCheck({
    context,
    checks,
    checkId: 'main-authorization',
    name: 'Main Authorization Gate',
    inputDigest: facts.fingerprint.value,
    status: 'completed',
    conclusion: decision.state === 'passed' ? 'success' : 'failure',
    title: decision.state === 'passed' ? '主分支授权门禁已通过' : '主分支授权门禁未通过',
    summary: decision.status,
  });
  return { operation: 'governance-main', state: decision.state, summary: decision.status, details: decision };
}

async function copilotGovernance(
  context: StewardOperationContext,
  inputs: StewardActionInputs,
): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.copilotReview) {
    await syncBlockingComment(context, 'copilot-review', []);
    return { operation: 'governance-copilot', state: 'ignored', summary: 'Copilot review is disabled' };
  }
  const [facts, threads, trusted, checks] = await Promise.all([
    pullFacts(context),
    context.client.listReviewThreads(context.owner, context.repository, context.pull.number),
    maintainers(context),
    context.client.listCommitCheckRuns(context.owner, context.repository, context.pull.head.sha),
  ]);
  const currentReviews = selectCurrentHeadReviews(facts.reviews, context.pull.head.sha);
  const copilotReviews = currentReviews.reviews.filter((review) => (
    normalizeAppLogin(review.user?.login) === 'copilot-pull-request-reviewer'
  ));
  const findings = copilotThreadFindings(threads, {
    fallbackTitle: 'Copilot review comment',
    headSha: context.pull.head.sha,
  });
  if (currentReviews.malformed) {
    findings.unclassified.push({
      title: 'Current-head review evidence is malformed',
      url: '',
    });
  }
  const requestFailed = ['failure', 'cancelled', 'timed_out'].includes(inputs.requestResult?.trim() ?? '');
  const decision = evaluateCopilotGate({ reviews: copilotReviews, findings, requestFailed });
  const models = copilotFailureModels({
    decision,
    coreHandlers: trusted,
    contributorHandlers: facts.fingerprint.contributors,
    botLogins: botLogins(context),
  });
  for (const model of models) {
    const findings = model.source === 'copilot-review:blocking-comments'
      ? decision.blocking
      : model.source === 'copilot-review:comment-protocol' ? decision.unclassified : [];
    if (findings.length) model.items = findings.map((finding) => (
      finding.url ? `${finding.title} — ${finding.url}` : finding.title
    ));
  }
  await syncBlockingComment(context, 'copilot-review', models);
  await writeCheck({
    context,
    checks,
    checkId: 'copilot-review-gate',
    name: 'Copilot Code Review Gate',
    inputDigest: facts.fingerprint.value,
    status: decision.checkStatus,
    ...(decision.checkConclusion ? { conclusion: decision.checkConclusion } : {}),
    title: decision.state === 'passed' ? 'Copilot 审查门禁已通过'
      : decision.state === 'pending' ? '等待 Copilot 代码审查' : 'Copilot 审查门禁未通过',
    summary: decision.failureKind || decision.passingSignal || 'waiting-for-review',
  });
  return { operation: 'governance-copilot', state: decision.state, summary: decision.failureKind || decision.passingSignal, details: decision };
}

function workflowEventSignal(context: StewardOperationContext): 'none' | 'review-state' | 'manual' {
  if (context.eventName === 'repository_dispatch') return 'review-state';
  if (context.eventName === 'workflow_dispatch') return 'manual';
  if (context.eventName === 'workflow_run' && context.event.workflow_run?.name === 'PR Review Signal') return 'review-state';
  return 'none';
}

async function matrixWorkflowRuns(
  context: StewardOperationContext,
  checks: readonly GitHubCheckRun[],
  configuration: ReturnType<typeof enabledMatrixConfiguration>,
): Promise<MatrixWorkflowRun[]> {
  const maximumJobQueries = 30;
  const runs = await context.client.listWorkflowRuns(context.owner, context.repository);
  const matchesPull = (run: MatrixWorkflowRun): boolean => {
    const trusted = trustedWorkflowRunContext(run);
    return run.head_sha?.toLowerCase() === context.pull.head.sha.toLowerCase()
      || Boolean(run.pull_requests?.some((pull) => pull.number === context.pull.number))
      || Boolean(trusted && trusted.prNumber === context.pull.number
        && trusted.headSha === context.pull.head.sha.toLowerCase());
  };
  const matchesCurrentHead = (run: MatrixWorkflowRun): boolean => {
    const trusted = trustedWorkflowRunContext(run);
    return run.head_sha?.toLowerCase() === context.pull.head.sha.toLowerCase()
      || Boolean(trusted && trusted.prNumber === context.pull.number
        && trusted.headSha === context.pull.head.sha.toLowerCase());
  };
  const candidates: MatrixWorkflowRun[] = runs.filter(matchesPull);
  const eventRun = context.eventName === 'workflow_run' ? context.event.workflow_run : undefined;
  if (eventRun?.id && !candidates.some((run) => run.id === eventRun.id)) {
    const trusted = trustedWorkflowRunContext(eventRun);
    if (trusted?.prNumber === context.pull.number && trusted.headSha === context.pull.head.sha.toLowerCase()) {
      candidates.push(eventRun);
    }
  }
  const byId = new Map<number, MatrixWorkflowRun>();
  for (const run of candidates) {
    const runId = Number(run.id ?? 0);
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('GitHub returned an invalid workflow run ID');
    byId.set(runId, run);
  }

  const selected = new Map<number, MatrixWorkflowRun>();
  const select = (run: MatrixWorkflowRun | undefined): void => {
    const runId = Number(run?.id ?? 0);
    if (!run || selected.size >= maximumJobQueries || selected.has(runId)) return;
    selected.set(runId, run);
  };
  const newestFirst = (left: MatrixWorkflowRun, right: MatrixWorkflowRun): number => (
    String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
      || Number(right.id ?? 0) - Number(left.id ?? 0)
  );

  const trustedEventRun = eventRun ? trustedWorkflowRunContext(eventRun) : null;
  select(trustedEventRun?.prNumber === context.pull.number
    && trustedEventRun.headSha === context.pull.head.sha.toLowerCase()
    ? byId.get(Number(eventRun?.id ?? 0))
    : undefined);
  for (const check of [...checks].sort((left, right) => (
    String(right.started_at ?? right.completed_at ?? '').localeCompare(
      String(left.started_at ?? left.completed_at ?? ''),
    ) || Number(right.id ?? 0) - Number(left.id ?? 0)
  ))) {
    select(byId.get(workflowRunId(check)));
  }
  for (const target of configuration.targets) {
    select([...byId.values()]
      .filter((run) => matchesCurrentHead(run) && workflowRunMatchesTarget(run, target))
      .sort(newestFirst)[0]);
  }
  for (const run of [...byId.values()].sort(newestFirst)) select(run);

  return await Promise.all([...selected.values()].map(async (run) => {
    const runId = Number(run.id ?? 0);
    return {
      ...run,
      id: runId,
      jobs: (await context.client.listWorkflowJobs(context.owner, context.repository, runId)).map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        ...(job.conclusion == null ? {} : { conclusion: job.conclusion }),
        ...(job.html_url == null ? {} : { html_url: job.html_url }),
        ...(job.started_at == null ? {} : { started_at: job.started_at }),
        ...(job.completed_at == null ? {} : { completed_at: job.completed_at }),
      })),
    };
  }));
}

async function applyMatrixRepairs(
  context: StewardOperationContext,
  plans: readonly MatrixRepairPlan[],
  checks: readonly GitHubCheckRun[],
  inputDigest: string,
): Promise<void> {
  for (const plan of plans) {
    if (plan.action === 'dispatch-workflow') {
      const dispatch = await context.client.dispatchWorkflow({
        owner: context.owner,
        repository: context.repository,
        workflow: plan.workflowFile,
        ref: plan.ref,
        inputs: {
          pr_number: plan.inputs.prNumber,
          head_sha: plan.inputs.headSha,
          ...(plan.inputs.governanceScope ? { governance_scope: plan.inputs.governanceScope } : {}),
        },
      });
      const dispatchDetails = dispatch.kind === 'identified'
        ? { detailsUrl: dispatch.htmlUrl, runId: dispatch.workflowRunId }
        : null;
      for (const target of plan.targets) {
        await writeCheck({
          context,
          checks,
          checkId: target.id,
          name: target.checkName,
          inputDigest,
          status: 'in_progress',
          detailsUrl: dispatchDetails?.detailsUrl ?? null,
          startNewRunIfCompleted: true,
          title: '等待一次性补跑结果',
          summary: `验证矩阵已触发 ${target.workflowName}${dispatchDetails ? `（run ${dispatchDetails.runId}）` : ''}，后续 workflow_run 事件将更新 ${target.jobName} 状态。`,
        });
      }
    } else if (plan.action === 'rerun-job') {
      await context.client.rerunWorkflowJob(context.owner, context.repository, plan.jobId);
    }
  }
}

async function liveMatrixInputs(
  context: StewardOperationContext,
  configuration: ReturnType<typeof enabledMatrixConfiguration>,
  expectedFingerprint: string,
): Promise<{
  context: StewardOperationContext;
  facts: PullFacts;
  checks: GitHubCheckRun[];
  workflowRuns: MatrixWorkflowRun[];
}> {
  const livePull = await context.client.getPullRequest(
    context.owner,
    context.repository,
    context.pull.number,
  );
  const liveContext: StewardOperationContext = {
    ...context,
    pull: { ...livePull, mergeCommitSha: null },
  };
  const [facts, checks] = await Promise.all([
    pullFacts(liveContext),
    context.client.listCommitCheckRuns(context.owner, context.repository, livePull.head.sha),
    assertExclusiveOpenPullForHead(liveContext),
  ]);
  if (livePull.state.toLowerCase() !== 'open'
    || livePull.number !== context.pull.number
    || livePull.head.sha.toLowerCase() !== context.pull.head.sha.toLowerCase()
    || facts.fingerprint.value !== expectedFingerprint) {
    throw new Error('Pull request governance inputs changed during Matrix convergence; retry from fresh live state');
  }
  const workflowRuns = await matrixWorkflowRuns(liveContext, checks, configuration);
  return { context: liveContext, facts, checks, workflowRuns };
}

async function fullMatrixSnapshot(
  context: StewardOperationContext,
  configuration: ReturnType<typeof enabledMatrixConfiguration>,
  expectedFingerprint: string,
): Promise<{
  inputs: Awaited<ReturnType<typeof liveMatrixInputs>>;
  evaluation: ReturnType<typeof evaluateMatrix>;
  evidence: Awaited<ReturnType<typeof matrixLiveEvidenceDigest>>;
}> {
  const inputs = await liveMatrixInputs(context, configuration, expectedFingerprint);
  const evaluation = evaluateMatrix({
    config: configuration,
    checkRuns: inputs.checks as MatrixCheckRun[],
    scope: 'full',
    pull: inputs.context.pull,
    trust: {
      appId: stewardRuntimeIdentity.appId,
      appSlug: context.manifest.manifest.automation.githubApp.slug,
      repositoryId: context.repositoryId,
      configDigest: context.manifest.configDigest,
      inputDigest: inputs.facts.fingerprint.value,
      workflowRuns: inputs.workflowRuns,
      allowLegacy: true,
    },
  });
  const evidence = await matrixLiveEvidenceDigest({
    repositoryId: context.repositoryId,
    pull: inputs.context.pull,
    configDigest: context.manifest.configDigest,
    pullFingerprintDigest: inputs.facts.fingerprint.value,
    targets: evaluation.targets,
  });
  return { inputs, evaluation, evidence };
}

async function matrixOperation(context: StewardOperationContext, inputs: StewardActionInputs): Promise<StewardOperationResult> {
  const mode = parseMatrixMode(inputs.matrixMode);
  const signal = workflowEventSignal(context);
  const scope = parseMatrixScope(inputs.matrixScope, context.eventName, signal === 'review-state');
  const configuration = enabledMatrixConfiguration(context.manifest.manifest.features);
  let startedGate: GitHubCheckRun | null = null;
  let startedGateExternalId: string | null = null;
  if (mode !== 'observe') {
    let preflightChecks: readonly GitHubCheckRun[] = [];
    let preflightReadFailure: unknown;
    try {
      preflightChecks = await context.client.listCommitCheckRuns(
        context.owner,
        context.repository,
        context.pull.head.sha,
      );
    } catch (error) {
      // A failed read must not allow an older success to remain authoritative.
      // Attempt a blind new generation first, then surface the original read
      // failure with the new pending Gate left in place.
      preflightReadFailure = error;
    }
    const invalidationDigest = await hashJson({
      schema_version: 1,
      kind: 'matrix-gate-invalidation',
      repository_id: context.repositoryId,
      pull_request: context.pull.number,
      head_sha: context.pull.head.sha.toLowerCase(),
      config_digest: context.manifest.configDigest,
      scope,
      signal,
    });
    startedGateExternalId = stewardCheckExternalId({
      repositoryId: context.repositoryId,
      prNumber: context.pull.number,
      headSha: context.pull.head.sha,
      checkId: 'validation-matrix',
      configDigest: context.manifest.configDigest,
      inputDigest: invalidationDigest,
    });
    startedGate = await writeCheck({
      context,
      checks: preflightChecks,
      checkId: 'validation-matrix',
      name: configuration.gateName,
      inputDigest: invalidationDigest,
      status: 'in_progress',
      startNewRunIfCompleted: true,
      reuseCanonicalInProgress: true,
      createOnAmbiguousActive: true,
      title: 'PR 验证矩阵等待完整重算',
      summary: '治理信号已变化；旧 Matrix 成功结论已失效，必须完成一次 full reconcile。',
    });
    if (!Number.isSafeInteger(startedGate.id) || startedGate.id < 1
      || startedGate.name !== configuration.gateName
      || startedGate.external_id !== startedGateExternalId
      || String(startedGate.head_sha ?? '').toLowerCase() !== context.pull.head.sha.toLowerCase()
      || Number(startedGate.app?.id ?? 0) !== stewardRuntimeIdentity.appId
      || String(startedGate.app?.slug ?? '') !== context.manifest.manifest.automation.githubApp.slug
      || startedGate.status !== 'in_progress'
      || startedGate.conclusion != null) {
      throw new Error('Started Matrix Gate response did not preserve the requested generation identity');
    }
    if (preflightReadFailure !== undefined) throw preflightReadFailure;
  }
  const [facts, checks, openPullNumbers] = await Promise.all([
    pullFacts(context),
    context.client.listCommitCheckRuns(context.owner, context.repository, context.pull.head.sha),
    openPullNumbersForHead(context),
  ]);
  if (openPullNumbers.length !== 1 || openPullNumbers[0] !== context.pull.number) {
    if (mode === 'observe') {
      throw new Error(
        `Matrix requires an exclusive open pull request for head ${context.pull.head.sha}; observed ${
          openPullNumbers.length ? openPullNumbers.join(',') : 'none'}`,
      );
    }
    const associationDigest = await hashJson({
      schema_version: 1,
      kind: 'matrix-head-association-failure',
      repository_id: context.repositoryId,
      pull_request: context.pull.number,
      head_sha: context.pull.head.sha.toLowerCase(),
      config_digest: context.manifest.configDigest,
      pull_fingerprint_digest: facts.fingerprint.value,
      associated_open_pull_requests: openPullNumbers,
    });
    await writeCheck({
      context,
      checks,
      checkRunId: startedGate!.id,
      expectedCurrentExternalId: startedGateExternalId!,
      checkId: 'validation-matrix',
      name: configuration.gateName,
      inputDigest: associationDigest,
      status: 'completed',
      conclusion: 'failure',
      title: 'PR 验证矩阵已阻断',
      summary: `当前 head 必须唯一对应一个开放 PR；观察到 ${openPullNumbers.length
        ? openPullNumbers.map((number) => `#${number}`).join(', ')
        : '无可验证开放 PR'}。`,
    });
    return {
      operation: 'matrix',
      state: 'failed',
      summary: 'Matrix head association is not exclusive',
      details: { mode, scope, openPullNumbers, repairs: [], completions: [] },
    };
  }
  const workflowRuns = await matrixWorkflowRuns(context, checks, configuration);
  const trust = {
    appId: stewardRuntimeIdentity.appId,
    appSlug: context.manifest.manifest.automation.githubApp.slug,
    repositoryId: context.repositoryId,
    configDigest: context.manifest.configDigest,
    inputDigest: facts.fingerprint.value,
  };
  const evaluation = evaluateMatrix({
    config: configuration,
    checkRuns: checks as MatrixCheckRun[],
    scope,
    pull: context.pull,
    trust: { ...trust, workflowRuns, allowLegacy: true },
  });
  const completions = planProxyCompletions({
    workflowRuns,
    targets: evaluation.targets,
    checkRuns: checks as MatrixCheckRun[],
    pull: context.pull,
    trust: { ...trust, workflowRuns, allowLegacy: true },
  });
  const repairs = planMatrixRepairs({
    targets: evaluation.targets,
    workflowRuns,
    mode,
    pull: context.pull,
    eventSignal: signal,
  });
  const targetOverrides: Record<string, Partial<{ state: 'passed' | 'pending' | 'failed'; conclusion: string; status: string; url: string }>> = {};
  if (mode !== 'observe') {
    for (const completion of completions) {
      await context.client.updateCheckRun(context.owner, context.repository, completion.checkRunId, {
        name: evaluation.targets.find((target) => target.id === completion.target)?.checkNames[0] ?? completion.target,
        status: 'completed',
        conclusion: completion.conclusion,
        title: completion.conclusion === 'success' ? '一次性补跑已通过' : '一次性补跑未通过',
        summary: completion.sourceUrl || `子 workflow job ${completion.sourceJobId} 已完成。`,
      });
      targetOverrides[completion.target] = {
        state: completion.conclusion === 'success' ? 'passed' : 'failed',
        conclusion: completion.conclusion,
        status: 'completed',
        url: completion.sourceUrl,
      };
    }
    await applyMatrixRepairs(context, repairs, checks, facts.fingerprint.value);
    for (const repair of repairs) {
      if (repair.action === 'dispatch-workflow') {
        for (const target of repair.targets) {
          targetOverrides[target.id] = { state: 'pending', conclusion: '', status: 'in_progress', url: '' };
        }
      } else if (repair.action === 'rerun-job') {
        targetOverrides[repair.target] = { state: 'pending', conclusion: '', status: 'in_progress', url: '' };
      }
    }
  }
  let converged = mode === 'observe' ? evaluation : evaluateMatrix({
    config: configuration,
    checkRuns: checks as MatrixCheckRun[],
    scope,
    pull: context.pull,
    trust: { ...trust, workflowRuns, allowLegacy: true },
    targetOverrides,
  });
  if (mode === 'repair' && converged.state === 'passed') {
    converged = { ...converged, state: 'pending', passed: false };
  }
  if (mode === 'enforce' && scope === 'full') {
    const first = await fullMatrixSnapshot(context, configuration, facts.fingerprint.value);
    const confirmed = await fullMatrixSnapshot(context, configuration, facts.fingerprint.value);
    if (first.evidence.value !== confirmed.evidence.value) {
      throw new Error('Matrix live evidence changed across the final write barrier; retry from fresh live state');
    }
    converged = confirmed.evaluation;
    const conclusion = matrixConclusion(converged);
    await writeCheck({
      context: confirmed.inputs.context,
      checks: confirmed.inputs.checks,
      checkRunId: startedGate!.id,
      expectedCurrentExternalId: startedGateExternalId!,
      checkId: 'validation-matrix',
      name: configuration.gateName,
      inputDigest: confirmed.evidence.value,
      status: conclusion.status,
      startNewRunIfCompleted: conclusion.status === 'in_progress',
      reuseCanonicalInProgress: true,
      ...(conclusion.conclusion ? { conclusion: conclusion.conclusion } : {}),
      title: conclusion.presentation === 'matrix.waiting' ? 'PR 验证矩阵等待中'
        : conclusion.presentation === 'matrix.passed' ? 'PR 验证矩阵已通过' : 'PR 验证矩阵未通过',
      summary: converged.targets.map((target) => `${target.name}: ${target.state}`).join('\n'),
    });
  } else if (mode === 'enforce' && scope === 'gate-only') {
    const live = await liveMatrixInputs(context, configuration, facts.fingerprint.value);
    const gateEvaluation = evaluateMatrix({
      config: configuration,
      checkRuns: live.checks as MatrixCheckRun[],
      scope: 'gate-only',
      pull: live.context.pull,
      trust: {
        ...trust,
        inputDigest: live.facts.fingerprint.value,
        workflowRuns: live.workflowRuns,
        allowLegacy: true,
      },
    });
    const failed = gateEvaluation.blocking.length > 0;
    const gateEvidence = await hashJson({
      schema_version: 1,
      kind: 'matrix-gate-only-evidence',
      repository_id: context.repositoryId,
      pull_request: live.context.pull.number,
      head_sha: live.context.pull.head.sha.toLowerCase(),
      config_digest: context.manifest.configDigest,
      pull_fingerprint_digest: live.facts.fingerprint.value,
      targets: gateEvaluation.targets.map((target) => ({
        id: target.id,
        state: target.state,
        check_id: Number(target.checkRun?.id ?? 0),
        external_id: String(target.checkRun?.external_id ?? ''),
        status: String(target.checkRun?.status ?? ''),
        conclusion: String(target.checkRun?.conclusion ?? ''),
      })),
    });
    await writeCheck({
      context: live.context,
      checks: live.checks,
      checkRunId: startedGate!.id,
      expectedCurrentExternalId: startedGateExternalId!,
      checkId: 'validation-matrix',
      name: configuration.gateName,
      inputDigest: gateEvidence,
      status: failed ? 'completed' : 'in_progress',
      startNewRunIfCompleted: !failed,
      reuseCanonicalInProgress: true,
      ...(failed ? { conclusion: 'failure' as const } : {}),
      title: failed ? 'PR 验证矩阵未通过' : 'PR 验证矩阵等待完整重算',
      summary: `${gateEvaluation.targets.map((target) => `${target.name}: ${target.state}`).join('\n')}\nfull reconcile required`,
    });
    converged = failed
      ? gateEvaluation
      : { ...gateEvaluation, state: 'pending', passed: false };
  }
  return {
    operation: 'matrix',
    state: converged.state,
    summary: `${converged.targets.length} Matrix targets evaluated${mode === 'repair' ? '; full reconcile required' : ''}`,
    details: {
      mode,
      scope,
      evaluation: converged,
      repairs,
      completions,
      ...(mode === 'repair' ? { fullReconcileRequired: true } : {}),
    },
  };
}

export async function executeOperation(
  operation: Exclude<StewardOperation, 'version' | 'automation' | 'classification' | 'dco-advisory' | 'release-adapter' | 'release-preflight' | 'release-status' | 'release-publish' | 'release-finalize'>,
  context: StewardOperationContext,
  inputs: StewardActionInputs,
): Promise<StewardOperationResult> {
  if (operation === 'cleanup') return await cleanupOperation(context);
  if (operation === 'governance-preflight') {
    return {
      operation,
      state: 'passed',
      summary: 'Governance feature configuration loaded',
      details: {
        governance: context.manifest.manifest.features.governance,
        copilotReview: context.manifest.manifest.features.copilotReview,
      },
    };
  }
  if (operation === 'governance-request-copilot') return await requestCopilot(context);
  if (operation === 'governance-auto-approve') return await autoApprove(context);
  if (operation === 'governance-main') return await mainGovernance(context);
  if (operation === 'governance-copilot') return await copilotGovernance(context, inputs);
  return await matrixOperation(context, inputs);
}
