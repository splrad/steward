import type { ManifestRepositoryClient, RepositoryFile, RepositoryMetadata } from '../../manifest/src/index.js';
import { fetchPullRequestPages, maxPullRequestPages } from './pagination.js';
import type { GitHubTransport } from './transport.js';

export interface GitHubRepositoryMetadata extends RepositoryMetadata {
  id: number;
  fullName: string;
}

export interface GitHubPullRequest {
  number: number;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  title?: string;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  labels?: { name?: string }[];
  base: { ref: string; sha?: string; repo?: { default_branch?: string } | null };
  head: { sha: string; ref?: string };
  requested_reviewers?: { login?: string }[];
  requested_teams?: { slug?: string }[];
}

export interface GitHubRepositoryLabel {
  name: string;
  color: string;
  description?: string | null;
}

export interface GitHubCommit {
  sha?: string;
  author?: { login?: string; type?: string } | null;
  committer?: { login?: string; type?: string } | null;
  commit?: {
    author?: { name?: string; email?: string } | null;
    committer?: { name?: string; email?: string } | null;
  };
}

export interface GitHubPullRequestReview {
  id?: number;
  state?: string;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  user?: { login?: string } | null;
}

export interface GitHubPullRequestFile {
  filename?: string;
  status?: string;
  sha?: string;
  additions?: number;
  deletions?: number;
}

export interface GitHubRelease {
  id: number;
  tag_name?: string;
  draft?: boolean;
  html_url?: string;
  upload_url?: string;
}

export interface GitHubReleaseNotes { name?: string; body?: string }
export interface GitHubReleaseAsset {
  id?: number; name?: string; state?: string; size?: number; digest?: string | null;
}

export interface GitHubGitRef {
  ref?: string;
  object?: { type?: string; sha?: string };
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  external_id?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string } | null;
}

export interface GitHubWorkflowRun {
  id: number;
  name?: string;
  display_title?: string;
  path?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  created_at?: string;
  html_url?: string;
  pull_requests?: { number?: number }[];
}

export interface GitHubWorkflowJob {
  id: number;
  run_id?: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GitHubIssueComment {
  id: number;
  body?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

export interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string | null;
  line?: number | null;
  comments: {
    pageInfo?: { hasNextPage?: boolean };
    nodes: {
      id: string;
      body?: string;
      url?: string;
      author?: { login?: string } | null;
      pullRequestReview?: { author?: { login?: string } | null } | null;
    }[];
  };
}

export interface CheckRunUpdate {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  externalId?: string;
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
  detailsUrl?: string;
  title?: string;
  summary?: string;
}

export interface CheckRunCreate extends CheckRunUpdate {
  headSha: string;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function contentPath(path: string): string {
  const parts = path.split('/');
  if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('\\')
    || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('GitHub repository content path must be a relative path without empty, dot, or backslash segments');
  }
  return parts.map(segment).join('/');
}

function uniqueNonEmptyNames(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function checkMutationBody(input: CheckRunUpdate): Record<string, unknown> {
  return {
    name: input.name,
    status: input.status,
    ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
    ...(input.title === undefined && input.summary === undefined ? {} : {
      output: { title: input.title ?? input.name, summary: input.summary ?? '' },
    }),
  };
}

const reviewThreadsQuery = `
query($owner: String!, $repository: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repository) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              id body url
              author { login }
              pullRequestReview { author { login } }
            }
          }
        }
      }
    }
  }
}`;

export class GitHubRepositoryClient implements ManifestRepositoryClient {
  constructor(
    private readonly transport: GitHubTransport,
    private readonly graphqlTransport: GitHubTransport = transport,
  ) {}

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const payload = await this.transport.request<{ login?: string }>({ path: '/user' });
    const login = String(payload.login ?? '').trim();
    if (!login) throw new Error('GitHub returned an invalid authenticated user');
    return { login };
  }

  async getRepository(owner: string, repository: string): Promise<GitHubRepositoryMetadata> {
    const payload = await this.transport.request<{
      id?: number;
      full_name?: string;
      default_branch?: string | null;
    }>({ path: repositoryPath(owner, repository) });
    const id = Number(payload.id ?? 0);
    const fullName = String(payload.full_name ?? '');
    if (!Number.isSafeInteger(id) || id < 1 || !fullName) {
      throw new Error('GitHub returned invalid repository metadata');
    }
    return {
      id,
      fullName,
      defaultBranch: payload.default_branch ?? null,
    };
  }

  async getFile(owner: string, repository: string, path: string, ref: string): Promise<RepositoryFile> {
    return await this.transport.request<RepositoryFile>({
      path: `${repositoryPath(owner, repository)}/contents/${contentPath(path)}`,
      query: { ref },
    });
  }

  async getPullRequest(owner: string, repository: string, number: number): Promise<GitHubPullRequest> {
    return await this.transport.request<GitHubPullRequest>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}`,
    });
  }

  async getCommit(owner: string, repository: string, ref: string): Promise<GitHubCommit> {
    return await this.transport.request<GitHubCommit>({
      path: `${repositoryPath(owner, repository)}/commits/${segment(ref)}`,
    });
  }

  async getTagRef(owner: string, repository: string, tag: string): Promise<GitHubGitRef> {
    return await this.transport.request<GitHubGitRef>({
      path: `${repositoryPath(owner, repository)}/git/ref/tags/${segment(tag)}`,
    });
  }

  async createTagRef(owner: string, repository: string, tag: string, sha: string): Promise<GitHubGitRef> {
    return await this.transport.request<GitHubGitRef>({
      method: 'POST', path: `${repositoryPath(owner, repository)}/git/refs`,
      body: { ref: `refs/tags/${tag}`, sha },
    });
  }

  async deleteTagRef(owner: string, repository: string, tag: string): Promise<void> {
    await this.transport.request<void>({
      method: 'DELETE', path: `${repositoryPath(owner, repository)}/git/refs/tags/${segment(tag)}`,
    });
  }

  async generateReleaseNotes(owner: string, repository: string, tag: string, targetCommitish: string): Promise<GitHubReleaseNotes> {
    return await this.transport.request<GitHubReleaseNotes>({
      method: 'POST', path: `${repositoryPath(owner, repository)}/releases/generate-notes`,
      body: { tag_name: tag, target_commitish: targetCommitish },
    });
  }

  async createDraftRelease(input: {
    owner: string; repository: string; tag: string; targetCommitish: string; name: string; body: string;
  }): Promise<GitHubRelease> {
    return await this.transport.request<GitHubRelease>({
      method: 'POST', path: `${repositoryPath(input.owner, input.repository)}/releases`,
      body: {
        tag_name: input.tag, target_commitish: input.targetCommitish, name: input.name,
        body: input.body, draft: true, prerelease: false, generate_release_notes: false,
      },
    });
  }

  async publishRelease(owner: string, repository: string, releaseId: number): Promise<GitHubRelease> {
    return await this.transport.request<GitHubRelease>({
      method: 'PATCH', path: `${repositoryPath(owner, repository)}/releases/${segment(releaseId)}`,
      body: { draft: false },
    });
  }

  async getRelease(owner: string, repository: string, releaseId: number): Promise<GitHubRelease> {
    return await this.transport.request<GitHubRelease>({
      path: `${repositoryPath(owner, repository)}/releases/${segment(releaseId)}`,
    });
  }

  async deleteRelease(owner: string, repository: string, releaseId: number): Promise<void> {
    await this.transport.request<void>({
      method: 'DELETE', path: `${repositoryPath(owner, repository)}/releases/${segment(releaseId)}`,
    });
  }

  async getRepositoryLabel(owner: string, repository: string, name: string): Promise<GitHubRepositoryLabel> {
    const label = name.trim();
    if (!label) throw new Error('Repository label name is required');
    return await this.transport.request<GitHubRepositoryLabel>({
      path: `${repositoryPath(owner, repository)}/labels/${segment(label)}`,
    });
  }

  async listPullRequestCommits(owner: string, repository: string, number: number): Promise<GitHubCommit[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<GitHubCommit[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/commits`,
      query: { page, per_page: perPage },
    }));
  }

  async listPullRequestReviews(owner: string, repository: string, number: number): Promise<GitHubPullRequestReview[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<GitHubPullRequestReview[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/reviews`,
      query: { page, per_page: perPage },
    }));
  }

  async listPullRequestFiles(owner: string, repository: string, number: number): Promise<GitHubPullRequestFile[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<GitHubPullRequestFile[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/files`,
      query: { page, per_page: perPage },
    }));
  }

  async listReleases(owner: string, repository: string): Promise<GitHubRelease[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<GitHubRelease[]>({
      path: `${repositoryPath(owner, repository)}/releases`,
      query: { page, per_page: perPage },
    }));
  }

  async listTeamMembers(organization: string, teamSlug: string): Promise<{ login?: string }[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<{ login?: string }[]>({
      path: `/orgs/${segment(organization)}/teams/${segment(teamSlug)}/members`,
      query: { role: 'all', page, per_page: perPage },
    }));
  }

  async listIssueComments(owner: string, repository: string, number: number): Promise<GitHubIssueComment[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<GitHubIssueComment[]>({
      path: `${repositoryPath(owner, repository)}/issues/${segment(number)}/comments`,
      query: { page, per_page: perPage },
    }));
  }

  async listCommitCheckRuns(owner: string, repository: string, ref: string): Promise<GitHubCheckRun[]> {
    return await fetchPullRequestPages(async (page, perPage) => {
      const payload = await this.transport.request<{ check_runs?: GitHubCheckRun[] }>({
        path: `${repositoryPath(owner, repository)}/commits/${segment(ref)}/check-runs`,
        query: { page, per_page: perPage },
      });
      return payload.check_runs ?? [];
    });
  }

  async listWorkflowRuns(owner: string, repository: string): Promise<GitHubWorkflowRun[]> {
    return await fetchPullRequestPages(async (page, perPage) => {
      const payload = await this.transport.request<{ workflow_runs?: GitHubWorkflowRun[] }>({
        path: `${repositoryPath(owner, repository)}/actions/runs`,
        query: { page, per_page: perPage },
      });
      return payload.workflow_runs ?? [];
    });
  }

  async listWorkflowJobs(owner: string, repository: string, runId: number): Promise<GitHubWorkflowJob[]> {
    return await fetchPullRequestPages(async (page, perPage) => {
      const payload = await this.transport.request<{ jobs?: GitHubWorkflowJob[] }>({
        path: `${repositoryPath(owner, repository)}/actions/runs/${segment(runId)}/jobs`,
        query: { page, per_page: perPage },
      });
      return payload.jobs ?? [];
    });
  }

  async listReviewThreads(owner: string, repository: string, number: number): Promise<GitHubReviewThread[]> {
    const threads: GitHubReviewThread[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= maxPullRequestPages; page += 1) {
      const payload: {
        data?: { repository?: { pullRequest?: { reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: GitHubReviewThread[];
        } | null } | null } | null };
        errors?: { message?: string }[];
      } = await this.graphqlTransport.request({
        method: 'POST',
        path: '/graphql',
        body: { query: reviewThreadsQuery, variables: { owner, repository, number, cursor } },
      });
      if (payload.errors?.length) {
        throw new Error(`GitHub GraphQL review threads failed: ${String(payload.errors[0]?.message ?? 'unknown error')}`);
      }
      const connection = payload.data?.repository?.pullRequest?.reviewThreads;
      if (!connection) throw new Error('GitHub GraphQL returned no pull request review threads');
      const nodes = connection.nodes ?? [];
      if (nodes.some((thread) => thread.comments.pageInfo?.hasNextPage)) {
        throw new Error('GitHub GraphQL review thread comments exceeded the 100-comment limit');
      }
      threads.push(...nodes);
      if (!connection.pageInfo?.hasNextPage) return threads;
      cursor = connection.pageInfo.endCursor ?? null;
      if (!cursor) throw new Error('GitHub GraphQL review threads omitted the next cursor');
    }
    throw new Error(`GitHub GraphQL review threads exceeded the ${maxPullRequestPages}-page limit`);
  }

  async createCheckRun(owner: string, repository: string, input: CheckRunCreate): Promise<GitHubCheckRun> {
    return await this.transport.request<GitHubCheckRun>({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/check-runs`,
      body: { ...checkMutationBody(input), head_sha: input.headSha },
    });
  }

  async updateCheckRun(
    owner: string,
    repository: string,
    checkRunId: number,
    input: CheckRunUpdate,
  ): Promise<GitHubCheckRun> {
    return await this.transport.request<GitHubCheckRun>({
      method: 'PATCH',
      path: `${repositoryPath(owner, repository)}/check-runs/${segment(checkRunId)}`,
      body: checkMutationBody(input),
    });
  }

  async createIssueComment(owner: string, repository: string, number: number, body: string): Promise<GitHubIssueComment> {
    return await this.transport.request<GitHubIssueComment>({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/issues/${segment(number)}/comments`,
      body: { body },
    });
  }

  async updateIssueComment(owner: string, repository: string, commentId: number, body: string): Promise<GitHubIssueComment> {
    return await this.transport.request<GitHubIssueComment>({
      method: 'PATCH',
      path: `${repositoryPath(owner, repository)}/issues/comments/${segment(commentId)}`,
      body: { body },
    });
  }

  async deleteIssueComment(owner: string, repository: string, commentId: number): Promise<void> {
    await this.transport.request<void>({
      method: 'DELETE',
      path: `${repositoryPath(owner, repository)}/issues/comments/${segment(commentId)}`,
    });
  }

  async createRepositoryLabel(
    owner: string,
    repository: string,
    input: { name: string; color: string; description?: string },
  ): Promise<GitHubRepositoryLabel> {
    const name = input.name.trim();
    const color = input.color.trim().replace(/^#/, '');
    if (!name || !/^[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Repository label requires a name and a six-character hexadecimal color');
    }
    return await this.transport.request<GitHubRepositoryLabel>({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/labels`,
      body: { name, color, ...(input.description === undefined ? {} : { description: input.description }) },
    });
  }

  async addIssueLabels(owner: string, repository: string, number: number, labels: readonly string[]): Promise<void> {
    const names = uniqueNonEmptyNames(labels);
    if (!names.length) throw new Error('At least one issue label is required');
    await this.transport.request({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/issues/${segment(number)}/labels`,
      body: { labels: names },
    });
  }

  async removeIssueLabel(owner: string, repository: string, number: number, label: string): Promise<void> {
    const name = label.trim();
    if (!name) throw new Error('Issue label name is required');
    await this.transport.request<void>({
      method: 'DELETE',
      path: `${repositoryPath(owner, repository)}/issues/${segment(number)}/labels/${segment(name)}`,
    });
  }

  async updatePullRequestBody(owner: string, repository: string, number: number, body: string): Promise<void> {
    await this.transport.request({
      method: 'PATCH',
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}`,
      body: { body },
    });
  }

  async requestReviewers(input: {
    owner: string;
    repository: string;
    number: number;
    reviewers?: string[];
    teamReviewers?: string[];
  }): Promise<void> {
    const reviewers = uniqueNonEmptyNames(input.reviewers);
    const teamReviewers = uniqueNonEmptyNames(input.teamReviewers);
    if (!reviewers.length && !teamReviewers.length) {
      throw new Error('At least one user or team reviewer is required');
    }
    await this.transport.request({
      method: 'POST',
      path: `${repositoryPath(input.owner, input.repository)}/pulls/${segment(input.number)}/requested_reviewers`,
      body: {
        ...(reviewers.length ? { reviewers } : {}),
        ...(teamReviewers.length ? { team_reviewers: teamReviewers } : {}),
      },
    });
  }

  async createPullRequestReview(input: {
    owner: string;
    repository: string;
    number: number;
    commitId: string;
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
  }): Promise<void> {
    await this.transport.request({
      method: 'POST',
      path: `${repositoryPath(input.owner, input.repository)}/pulls/${segment(input.number)}/reviews`,
      body: { commit_id: input.commitId, event: input.event, body: input.body },
    });
  }

  async dispatchWorkflow(input: {
    owner: string;
    repository: string;
    workflow: string;
    ref: string;
    inputs: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.transport.request<void>({
      method: 'POST',
      path: `${repositoryPath(input.owner, input.repository)}/actions/workflows/${segment(input.workflow)}/dispatches`,
      body: { ref: input.ref, inputs: input.inputs },
    });
  }

  async rerunWorkflowJob(owner: string, repository: string, jobId: number): Promise<void> {
    await this.transport.request<void>({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/actions/jobs/${segment(jobId)}/rerun`,
    });
  }

  async approveWorkflowRun(owner: string, repository: string, runId: number): Promise<void> {
    await this.transport.request<void>({
      method: 'POST',
      path: `${repositoryPath(owner, repository)}/actions/runs/${segment(runId)}/approve`,
    });
  }
}
