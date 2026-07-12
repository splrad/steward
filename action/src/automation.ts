import {
  automationCreatedNoticeMarker,
  automationSummaryStartMarker,
  evaluatePullRequestAutomation,
  isBotLogin,
  normalizeGitHubLogin,
} from '../../packages/core/src/index.js';
import { loadDefaultBranchManifest } from '../../packages/manifest/src/index.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  createGitHubRestTransport,
  type GitHubIssueComment,
  type GitHubPullRequest,
} from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import { graphqlApiBase, readEvent, type StewardRuntimeEnvironment } from './context.js';

export interface AutomationOperationResult {
  state: 'passed' | 'ignored';
  summary: string;
  details: Record<string, unknown>;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function normalizeAppLogin(value: unknown): string {
  return normalizeGitHubLogin(String(value ?? '').trim().replace(/\[bot\]$/i, '')).toLowerCase();
}

function decodeTemplate(file: { type?: string; encoding?: string; content?: string }): string {
  if (file.type !== 'file' || file.encoding !== 'base64' || file.content === undefined) {
    throw new Error('GitHub returned an invalid pull request template response');
  }
  const compact = file.content.replaceAll(/\s/g, '');
  if (!compact) return '';
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('GitHub returned invalid base64 pull request template content');
  }
  return Buffer.from(compact, 'base64').toString('utf8');
}

async function optionalPullRequestTemplate(
  client: GitHubRepositoryClient,
  owner: string,
  repository: string,
  defaultBranch: string,
): Promise<string> {
  try {
    return decodeTemplate(await client.getFile(
      owner, repository, '.github/pull_request_template.md', defaultBranch,
    ));
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return '';
    throw error;
  }
}

function validateExistingPull(
  pull: GitHubPullRequest,
  sourceBranch: string,
  defaultBranch: string,
  headSha: string,
): void {
  if (!positiveInteger(pull.number) || pull.state !== 'open' || pull.base.ref !== defaultBranch
    || pull.head.ref !== sourceBranch || pull.head.sha.toLowerCase() !== headSha) {
    throw new Error('Automation found an open pull request that does not match trusted branch evidence');
  }
}

async function maintainers(
  client: GitHubRepositoryClient,
  owner: string,
  source: { source: 'users'; logins: string[] } | { source: 'organization-team'; teamSlug: string },
): Promise<string[]> {
  if (source.source === 'users') return [...source.logins];
  return (await client.listTeamMembers(owner, source.teamSlug))
    .map((member) => String(member.login ?? '').trim())
    .filter(Boolean);
}

function ownedNoticeComments(
  comments: readonly GitHubIssueComment[],
  appSlug: string,
): GitHubIssueComment[] {
  return comments.filter((comment) => (
    normalizeAppLogin(comment.user?.login) === appSlug
    && String(comment.body ?? '').includes(automationCreatedNoticeMarker)
  ));
}

export async function automatePullRequest(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
}): Promise<AutomationOperationResult> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('automation requires an explicit GitHub token');
  const eventPath = input.inputs.eventPath?.trim() || input.environment.GITHUB_EVENT_PATH?.trim() || '';
  const event = await readEvent(eventPath);
  if (input.environment.GITHUB_EVENT_NAME !== 'push') throw new Error('Automation only accepts a push event');
  const fullName = String(event.repository?.full_name ?? '').trim();
  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra) throw new Error('Automation push event has an invalid repository full name');
  const repositoryId = positiveInteger(event.repository?.id);
  if (!repositoryId) throw new Error('Automation push event has an invalid repository ID');
  const sourceBranch = String(input.inputs.sourceBranch ?? '').trim();
  if (!sourceBranch || event.ref !== `refs/heads/${sourceBranch}`) {
    throw new Error('Automation source branch does not match the trusted push ref');
  }
  const headSha = String(input.inputs.headSha ?? '').trim().toLowerCase();
  const eventHead = String(event.after ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha) || eventHead !== headSha) {
    throw new Error('Automation head SHA does not match the trusted push event');
  }
  const actor = String(event.sender?.login ?? '').trim();
  if (!normalizeGitHubLogin(actor) && !/^[A-Za-z0-9-]{1,39}\[bot\]$/i.test(actor)) {
    throw new Error('Automation push event has an invalid sender login');
  }

  const restApiUrl = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const transportOptions = input.fetch ? { fetch: input.fetch } : {};
  const client = new GitHubRepositoryClient(
    createGitHubRestTransport({ token, baseUrl: restApiUrl, ...transportOptions }),
    createGitHubRestTransport({ token, baseUrl: graphqlApiBase(restApiUrl), ...transportOptions }),
  );
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== repositoryId || metadata.fullName.toLowerCase() !== fullName.toLowerCase()
    || !metadata.defaultBranch
    || (event.repository?.default_branch !== undefined && event.repository.default_branch !== metadata.defaultBranch)) {
    throw new Error('Automation event repository does not match current repository metadata');
  }
  const manifest = await loadDefaultBranchManifest(client, owner, repository);
  if (manifest.source.ref !== metadata.defaultBranch) throw new Error('Automation default branch changed while loading Manifest');
  if (!manifest.manifest.features.prAutomation) {
    return { state: 'ignored', summary: 'PR Automation is disabled by the default-branch Manifest', details: {} };
  }
  const botLogins = [manifest.manifest.automation.githubApp.slug, 'copilot-pull-request-reviewer[bot]'];
  if (event.deleted === true) {
    return { state: 'ignored', summary: 'Deleted branch push ignored', details: { sourceBranch } };
  }
  if (sourceBranch === metadata.defaultBranch || isBotLogin(actor, botLogins)) {
    return {
      state: 'ignored',
      summary: sourceBranch === metadata.defaultBranch ? 'Default branch push ignored' : 'Bot actor push ignored',
      details: { sourceBranch, actor },
    };
  }

  const [branchRef, comparison, openPulls] = await Promise.all([
    client.getBranchRef(owner, repository, sourceBranch),
    client.compareCommits(owner, repository, metadata.defaultBranch, sourceBranch),
    client.listOpenPullRequestsForHead(owner, repository, sourceBranch, metadata.defaultBranch),
  ]);
  if (branchRef.ref !== `refs/heads/${sourceBranch}` || branchRef.object?.type !== 'commit'
    || String(branchRef.object.sha ?? '').toLowerCase() !== headSha) {
    throw new Error('Automation live branch ref does not match the trusted push head');
  }
  if (openPulls.length > 1) throw new Error('Automation found multiple matching open pull requests');
  const existing = openPulls[0];
  if (existing) validateExistingPull(existing, sourceBranch, metadata.defaultBranch, headSha);

  const preliminary = evaluatePullRequestAutomation({
    sourceBranch,
    targetBranch: metadata.defaultBranch,
    headSha,
    actor,
    compareStatus: String(comparison.status ?? ''),
    aheadBy: Number(comparison.ahead_by ?? 0),
    totalCommits: Number(comparison.total_commits ?? 0),
    commits: (comparison.commits ?? []).map((commit) => ({ sha: commit.sha, message: commit.commit?.message })),
    files: comparison.files ?? [],
    botLogins,
  });
  if (preliminary.state === 'ignored') {
    return { state: 'ignored', summary: `PR Automation ignored: ${preliminary.reason}`, details: { sourceBranch } };
  }

  const [templateBody, resolvedMaintainers, comments] = await Promise.all([
    optionalPullRequestTemplate(client, owner, repository, metadata.defaultBranch),
    maintainers(client, owner, manifest.manifest.automation.maintainers),
    existing ? client.listIssueComments(owner, repository, existing.number) : Promise.resolve([]),
  ]);
  const evaluation = evaluatePullRequestAutomation({
    sourceBranch,
    targetBranch: metadata.defaultBranch,
    headSha,
    actor,
    compareStatus: String(comparison.status ?? ''),
    aheadBy: Number(comparison.ahead_by ?? 0),
    totalCommits: Number(comparison.total_commits ?? 0),
    commits: (comparison.commits ?? []).map((commit) => ({
      sha: commit.sha,
      message: commit.commit?.message,
      authorLogin: commit.author?.login,
      authorName: commit.commit?.author?.name,
      authorEmail: commit.commit?.author?.email,
    })),
    files: comparison.files ?? [],
    existingBody: existing?.body,
    templateBody,
    maintainers: resolvedMaintainers,
    botLogins,
  });
  if (evaluation.state !== 'planned') throw new Error('Automation plan changed after evidence enrichment');

  const wasManaged = String(existing?.body ?? '').includes(automationSummaryStartMarker);
  let pull = existing;
  let pullAction: 'create' | 'update' | 'unchanged' | 'concurrent-create' = 'unchanged';
  if (pull) {
    if (pull.title !== evaluation.title || pull.body !== evaluation.body) {
      pull = await client.updatePullRequest(owner, repository, pull.number, {
        title: evaluation.title, body: evaluation.body,
      });
      pullAction = 'update';
    }
  } else {
    try {
      pull = await client.createPullRequest({
        owner, repository, head: sourceBranch, base: metadata.defaultBranch,
        title: evaluation.title, body: evaluation.body,
      });
      pullAction = 'create';
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      const raced = await client.listOpenPullRequestsForHead(owner, repository, sourceBranch, metadata.defaultBranch);
      if (raced.length !== 1) throw new Error('Automation concurrent PR creation could not be reconciled');
      validateExistingPull(raced[0]!, sourceBranch, metadata.defaultBranch, headSha);
      pull = await client.updatePullRequest(owner, repository, raced[0]!.number, {
        title: evaluation.title, body: evaluation.body,
      });
      pullAction = 'concurrent-create';
    }
  }
  const pullNumber = positiveInteger(pull?.number);
  if (!pullNumber) throw new Error('Automation PR mutation returned an invalid pull request number');

  const appSlug = manifest.manifest.automation.githubApp.slug.toLowerCase();
  const notices = ownedNoticeComments(comments, appSlug);
  const noticeBody = evaluation.noticeBody.replace('__PR_NUMBER__', `#${pullNumber}`);
  let noticeAction: 'none' | 'create' | 'update' | 'unchanged' = 'none';
  const existingNotice = notices[0];
  const mayCreateNotice = pullAction === 'create' || wasManaged;
  if (existingNotice) {
    if (existingNotice.body !== noticeBody) {
      await client.updateIssueComment(owner, repository, existingNotice.id, noticeBody);
      noticeAction = 'update';
    } else {
      noticeAction = 'unchanged';
    }
  } else if (mayCreateNotice) {
    await client.createIssueComment(owner, repository, pullNumber, noticeBody);
    noticeAction = 'create';
  }
  for (const duplicate of notices.slice(1)) {
    await client.deleteIssueComment(owner, repository, duplicate.id);
  }

  return {
    state: 'passed',
    summary: `PR #${pullNumber} automation converged; pull ${pullAction}; notice ${noticeAction}`,
    details: {
      pullNumber,
      pullAction,
      noticeAction,
      changedFiles: evaluation.changedFiles,
      commits: evaluation.commits,
      contributors: evaluation.contributors,
    },
  };
}
