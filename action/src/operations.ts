import {
  blockingFailuresMarker,
  copilotFailureModels,
  copilotThreadFindings,
  coreReviewersToRequest,
  decodeBlockingState,
  encodeBlockingState,
  evaluateCopilotGate,
  evaluateClassification,
  evaluateDcoAdvisory,
  evaluateMainAuthorization,
  evaluateMatrix,
  fingerprintForPull,
  formatMentions,
  isBotLogin,
  mainAuthorizationFailureModel,
  matrixConclusion,
  nextBlockingFailuresState,
  normalizeBlockingFailure,
  normalizeGitHubLogin,
  planMatrixRepairs,
  planProxyCompletions,
  stewardCheckExternalId,
  upsertClassificationMetadata,
  workflowRunId,
  workflowRunMatchesTarget,
  type GovernanceFailureModel,
  type BlockingFailure,
  type DcoEvaluation,
  type DcoIssue,
  type MatrixCheckRun,
  type MatrixRepairPlan,
  type MatrixWorkflowRun,
} from '../../packages/core/src/index.js';
import {
  GitHubApiError,
  type GitHubCheckRun,
  type GitHubCommit,
  type GitHubPullRequestFile,
  type GitHubPullRequestReview,
  type GitHubRepositoryClient,
} from '../../packages/github/src/index.js';
import type { PublicLabelConfiguration } from '../../packages/manifest/src/index.js';
import type { StewardActionInputs, StewardOperation } from './contracts.js';
import { parseMatrixMode, parseMatrixScope } from './contracts.js';
import { enabledMatrixConfiguration } from './catalog.js';
import type { StewardOperationContext } from './context.js';
import { trustedWorkflowRunContext } from './context.js';

export interface StewardOperationResult {
  operation: StewardOperation;
  state: 'passed' | 'pending' | 'failed' | 'ignored';
  summary: string;
  details?: unknown;
}

interface PullFacts {
  commits: GitHubCommit[];
  files: GitHubPullRequestFile[];
  reviews: GitHubPullRequestReview[];
  fingerprint: ReturnType<typeof fingerprintForPull>;
}

const autoApprovalMarker = '<!-- workflow:auto-approval -->';
const legacyDcoMarker = '<!-- workflow:dco-signoff-advisory -->';
const maxDcoIssues = 20;

async function ensureRepositoryLabel(
  context: StewardOperationContext,
  label: PublicLabelConfiguration,
): Promise<void> {
  try {
    await context.client.getRepositoryLabel(context.owner, context.repository, label.name);
    return;
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
  }

  try {
    await context.client.createRepositoryLabel(context.owner, context.repository, label);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
    await context.client.getRepositoryLabel(context.owner, context.repository, label.name);
  }
}

async function classificationOperation(context: StewardOperationContext): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.classification) {
    return {
      operation: 'classification',
      state: 'ignored',
      summary: 'Classification feature is disabled',
    };
  }
  const classification = context.manifest.manifest.classification;
  if (!classification) throw new Error('Classification feature requires default-branch Manifest configuration');

  const [commits, files, checks] = await Promise.all([
    context.client.listPullRequestCommits(context.owner, context.repository, context.pull.number),
    context.client.listPullRequestFiles(context.owner, context.repository, context.pull.number),
    context.client.listCommitCheckRuns(context.owner, context.repository, context.pull.head.sha),
  ]);
  if (typeof context.pull.title !== 'string' || !context.pull.title.trim()) {
    throw new Error('GitHub returned a pull request without a valid title');
  }
  if (commits.some((commit) => !/^[a-f0-9]{40}$/i.test(String(commit.sha ?? '')))) {
    throw new Error('GitHub returned a pull request commit without a valid SHA');
  }
  const filenames = files.map((file) => String(file.filename ?? '').trim());
  if (filenames.some((filename) => !filename)) {
    throw new Error('GitHub returned a pull request file without a valid filename');
  }
  const currentLabels = (context.pull.labels ?? []).map((label) => String(label.name ?? '').trim());
  if (currentLabels.some((label) => !label)) {
    throw new Error('GitHub returned a pull request label without a valid name');
  }
  const fingerprint = fingerprintForPull({ pull: context.pull, commits, files, botLogins: botLogins(context) });
  const evaluation = evaluateClassification({
    title: context.pull.title,
    baseRef: context.pull.base.ref,
    ...(context.pull.body === undefined ? {} : { body: context.pull.body }),
    ...(context.pull.head.ref === undefined ? {} : { headRef: context.pull.head.ref }),
    ...(context.pull.user == null ? {} : { author: context.pull.user }),
    files: filenames,
    currentLabels,
  }, classification);

  for (const label of evaluation.mutationPlan.ensureLabels) await ensureRepositoryLabel(context, label);
  if (evaluation.mutationPlan.addLabels.length) {
    await context.client.addIssueLabels(
      context.owner,
      context.repository,
      context.pull.number,
      evaluation.mutationPlan.addLabels,
    );
  }
  const labelsToRemove = [...new Map([
    ...evaluation.mutationPlan.removePublicLabels,
    ...evaluation.mutationPlan.removeInternalLabels,
  ].map((label) => [label.toLowerCase(), label])).values()];
  for (const label of labelsToRemove) {
    await context.client.removeIssueLabel(context.owner, context.repository, context.pull.number, label);
  }

  const body = upsertClassificationMetadata(context.pull.body, evaluation.presentation);
  if (body !== (context.pull.body ?? '')) {
    await context.client.updatePullRequestBody(context.owner, context.repository, context.pull.number, body);
  }
  await writeCheck({
    context,
    checks,
    checkId: 'pr-classification',
    name: 'PR Classification Gate',
    inputDigest: fingerprint.value,
    status: 'completed',
    conclusion: 'success',
    title: 'PR 分类已更新',
    summary: '标题、正文、提交、贡献者和文件输入均与当前分类结果一致。',
  });
  return {
    operation: 'classification',
    state: 'passed',
    summary: 'PR classification converged',
    details: { evaluation, fingerprint: fingerprint.value },
  };
}

function safeDcoText(value: unknown): string {
  const sanitized = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
  return sanitized.length <= 240 ? sanitized : `${sanitized.slice(0, 239)}…`;
}

function dcoIssueReason(issue: DcoIssue): string {
  if (issue.reason === 'missing') {
    return `缺少 Signed-off-by；建议添加 \`Signed-off-by: ${safeDcoText(issue.authorName) || 'Name'} <${safeDcoText(issue.authorEmail) || 'email@example.com'}>\``;
  }
  if (issue.reason === 'invalid-format') return 'Signed-off-by 格式无效；应使用 `Signed-off-by: Name <email>`';
  const signed = issue.signedEmails.map(safeDcoText).join(', ') || 'none';
  const truncated = issue.signedEmailsTruncated ? `（另有 ${issue.signedEmailsTruncated} 个未展开）` : '';
  return `Signed-off-by 邮箱与 commit author email 不一致；author email 为 \`${safeDcoText(issue.authorEmail) || 'unknown'}\`，当前签名邮箱为 \`${signed}\`${truncated}`;
}

function presentDcoIssue(issue: DcoIssue): DcoIssue {
  return {
    ...issue,
    subject: safeDcoText(issue.subject),
    authorName: safeDcoText(issue.authorName),
    authorEmail: safeDcoText(issue.authorEmail),
    signedEmails: issue.signedEmails.map(safeDcoText),
  };
}

function dcoSummary(evaluation: DcoEvaluation): string {
  const lines = [
    `DCO Sign-off Advisory：${evaluation.total} commits，${evaluation.passed} passed，${evaluation.skipped} skipped bots，${evaluation.issues.length} advisory issues。`,
  ];
  for (const issue of evaluation.issues.slice(0, maxDcoIssues)) {
    lines.push(`- \`${issue.sha.slice(0, 7)}\` ${safeDcoText(issue.subject) || '(empty commit message)'}: ${dcoIssueReason(issue)}`);
  }
  if (evaluation.issues.length > maxDcoIssues) {
    lines.push(`- 另有 ${evaluation.issues.length - maxDcoIssues} 项未展开；请查看 operation-result。`);
  }
  return lines.join('\n');
}

async function dcoAdvisoryOperation(context: StewardOperationContext): Promise<StewardOperationResult> {
  if (!context.manifest.manifest.features.dcoAdvisory) {
    return { operation: 'dco-advisory', state: 'ignored', summary: 'DCO Advisory feature is disabled' };
  }
  const [commits, comments] = await Promise.all([
    context.client.listPullRequestCommits(context.owner, context.repository, context.pull.number),
    context.client.listIssueComments(context.owner, context.repository, context.pull.number),
  ]);
  if (!commits.length) throw new Error('GitHub returned no commits for an open pull request');
  const evaluation = evaluateDcoAdvisory(commits.map((commit) => {
    const sha = String(commit.sha ?? '').toLowerCase();
    const message = commit.commit?.message;
    if (!/^[a-f0-9]{40}$/.test(sha) || typeof message !== 'string') {
      throw new Error('GitHub returned a pull request commit without a valid SHA or message');
    }
    return {
      sha,
      message,
      author: {
        login: commit.author?.login,
        type: commit.author?.type,
        name: commit.commit?.author?.name,
        email: commit.commit?.author?.email,
      },
      committer: {
        login: commit.committer?.login,
        type: commit.committer?.type,
        name: commit.commit?.committer?.name,
        email: commit.commit?.committer?.email,
      },
    };
  }), { botLogins: botLogins(context) });

  const appSlug = context.manifest.manifest.automation.githubApp.slug.toLowerCase();
  const legacy = comments.filter((comment) => (
    normalizeAppLogin(comment.user?.login) === appSlug
    && String(comment.body ?? '').includes(legacyDcoMarker)
  ));
  for (const comment of legacy) {
    await context.client.deleteIssueComment(context.owner, context.repository, comment.id);
  }
  return {
    operation: 'dco-advisory',
    state: 'passed',
    summary: dcoSummary(evaluation),
    details: {
      evaluation: { ...evaluation, issues: evaluation.issues.slice(0, maxDcoIssues).map(presentDcoIssue) },
      issuesTruncated: Math.max(0, evaluation.issues.length - maxDcoIssues),
      legacyCommentsDeleted: legacy.length,
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
    fingerprint: fingerprintForPull({ pull: context.pull, commits, files, botLogins: botLogins(context) }),
  };
}

function currentReviews(context: StewardOperationContext, reviews: readonly GitHubPullRequestReview[]): GitHubPullRequestReview[] {
  const latest = new Map<string, GitHubPullRequestReview>();
  for (const review of reviews) {
    if (review.commit_id?.toLowerCase() !== context.pull.head.sha.toLowerCase()) continue;
    const login = String(review.user?.login ?? '').trim().toLowerCase();
    if (!login) continue;
    const previous = latest.get(login);
    const timestamp = String(review.submitted_at ?? '').localeCompare(String(previous?.submitted_at ?? ''));
    if (!previous || timestamp > 0 || (timestamp === 0 && Number(review.id ?? 0) > Number(previous.id ?? 0))) {
      latest.set(login, review);
    }
  }
  return [...latest.values()];
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
  startNewRunIfCompleted?: boolean;
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
  const existing = input.checks
    .filter((check) => (
      check.name === input.name
      && check.external_id === externalId
      && String(check.app?.slug ?? '') === input.context.manifest.manifest.automation.githubApp.slug
    ))
    .sort((left, right) => left.id - right.id)
    .at(-1);
  const update = {
    name: input.name,
    status: input.status,
    externalId,
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(input.context.detailsUrl ? { detailsUrl: input.context.detailsUrl } : {}),
    title: input.title,
    summary: input.summary,
  };
  const startNewRun = input.startNewRunIfCompleted === true
    && input.status !== 'completed'
    && existing?.status === 'completed';
  return existing && !startNewRun
    ? await input.context.client.updateCheckRun(input.context.owner, input.context.repository, existing.id, update)
    : await input.context.client.createCheckRun(input.context.owner, input.context.repository, {
      ...update,
      headSha: input.context.pull.head.sha,
    });
}

function failureTitle(model: GovernanceFailureModel): string {
  const titles: Record<GovernanceFailureModel['presentation'], string> = {
    'main.unidentified-authors': '⚠️ 贡献者信息识别异常',
    'main.missing-contributors': '⚠️ 贡献者信息识别异常',
    'main.approval-required': '🔒 核心开发者审批',
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
  if (model.presentation === 'copilot.request-failed') return ['Copilot 审查请求未成功完成，请由核心维护者检查请求 job。'];
  if (model.presentation === 'copilot.passing-conclusion') return ['门禁未识别到 Copilot 的有效通过结论。'];
  return [...model.items];
}

function renderBlockingComment(head: string, failures: readonly BlockingFailure[]): string {
  const sections = failures.map((failure) => {
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
    failures,
  };
  return [
    '\x23\x23 🚧 PR 合并前有待处理事项',
    blockingFailuresMarker,
    '',
    ...sections.flatMap((section) => [section, '']),
    '> 🤖 本评论由 GitHub Actions 自动维护，全部阻断解除后将自动删除。',
    '',
    `<!-- workflow:pr-blocking-failures-state:${encodeBlockingState({ ...state, failures: [...failures] })} -->`,
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
  const reviewer = 'copilot-pull-request-reviewer';
  const alreadyRequested = (context.pull.requested_reviewers ?? []).some((candidate) => (
    normalizeAppLogin(candidate.login) === reviewer
  ));
  if (alreadyRequested) {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot review is already requested' };
  }
  const reviews = await context.client.listPullRequestReviews(context.owner, context.repository, context.pull.number);
  const alreadyReviewed = currentReviews(context, reviews).some((review) => (
    normalizeAppLogin(review.user?.login) === reviewer && review.state !== 'DISMISSED'
  ));
  if (alreadyReviewed) {
    return { operation: 'governance-request-copilot', state: 'ignored', summary: 'Copilot already reviewed the current head' };
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
  const alreadyApproved = currentReviews(context, facts.reviews).some((review) => (
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
  const approved = currentReviews(context, facts.reviews).filter((review) => review.state === 'APPROVED');
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
      reviewed: facts.reviews.map((review) => review.user?.login),
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
  const copilotReviews = currentReviews(context, facts.reviews).filter((review) => (
    normalizeAppLogin(review.user?.login) === 'copilot-pull-request-reviewer'
  ));
  const findings = copilotThreadFindings(threads, { fallbackTitle: 'Copilot review comment' });
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
      await context.client.dispatchWorkflow({
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
      for (const target of plan.targets) {
        await writeCheck({
          context,
          checks,
          checkId: target.id,
          name: target.checkName,
          inputDigest,
          status: 'in_progress',
          title: '等待一次性补跑结果',
          summary: `验证矩阵已触发 ${target.workflowName}，后续 workflow_run 事件将更新 ${target.jobName} 状态。`,
        });
      }
    } else if (plan.action === 'rerun-job') {
      await context.client.rerunWorkflowJob(context.owner, context.repository, plan.jobId);
    }
  }
}

async function matrixOperation(context: StewardOperationContext, inputs: StewardActionInputs): Promise<StewardOperationResult> {
  const mode = parseMatrixMode(inputs.matrixMode);
  const signal = workflowEventSignal(context);
  const scope = parseMatrixScope(inputs.matrixScope, context.eventName, signal === 'review-state');
  const configuration = enabledMatrixConfiguration(context.manifest.manifest.features);
  const [facts, checks] = await Promise.all([
    pullFacts(context),
    context.client.listCommitCheckRuns(context.owner, context.repository, context.pull.head.sha),
  ]);
  const workflowRuns = await matrixWorkflowRuns(context, checks, configuration);
  const trust = {
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
  const eventRunId = Number(context.event.workflow_run?.id ?? 0);
  const eventRun = workflowRuns.find((run) => run.id === eventRunId);
  const completions = eventRun ? planProxyCompletions({
    workflowRun: eventRun,
    targets: evaluation.targets,
    pull: context.pull,
    trust: { ...trust, workflowRuns, allowLegacy: true },
  }) : [];
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
  const converged = mode === 'observe' ? evaluation : evaluateMatrix({
    config: configuration,
    checkRuns: checks as MatrixCheckRun[],
    scope,
    pull: context.pull,
    trust: { ...trust, workflowRuns, allowLegacy: true },
    targetOverrides,
  });
  if (mode === 'enforce') {
    const conclusion = matrixConclusion(converged);
    await writeCheck({
      context,
      checks,
      checkId: 'validation-matrix',
      name: configuration.gateName,
      inputDigest: facts.fingerprint.value,
      status: conclusion.status,
      startNewRunIfCompleted: conclusion.status === 'in_progress',
      ...(conclusion.conclusion ? { conclusion: conclusion.conclusion } : {}),
      title: conclusion.presentation === 'matrix.waiting' ? 'PR 验证矩阵等待中'
        : conclusion.presentation === 'matrix.passed' ? 'PR 验证矩阵已通过' : 'PR 验证矩阵未通过',
      summary: converged.targets.map((target) => `${target.name}: ${target.state}`).join('\n'),
    });
  }
  return {
    operation: 'matrix',
    state: converged.state,
    summary: `${converged.targets.length} Matrix targets evaluated`,
    details: { mode, scope, evaluation: converged, repairs, completions },
  };
}

export async function executeOperation(
  operation: Exclude<StewardOperation, 'version' | 'release-adapter' | 'release-preflight' | 'release-status' | 'release-publish' | 'release-finalize'>,
  context: StewardOperationContext,
  inputs: StewardActionInputs,
): Promise<StewardOperationResult> {
  if (operation === 'classification') return await classificationOperation(context);
  if (operation === 'dco-advisory') return await dcoAdvisoryOperation(context);
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
