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
  body?: string | null;
  user?: { login?: string } | null;
  base: { ref: string; repo?: { default_branch?: string } | null };
  head: { sha: string; ref?: string };
  requested_reviewers?: { login?: string }[];
  requested_teams?: { slug?: string }[];
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

  async listPullRequestCommits(owner: string, repository: string, number: number): Promise<unknown[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<unknown[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/commits`,
      query: { page, per_page: perPage },
    }));
  }

  async listPullRequestReviews(owner: string, repository: string, number: number): Promise<unknown[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<unknown[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/reviews`,
      query: { page, per_page: perPage },
    }));
  }

  async listPullRequestFiles(owner: string, repository: string, number: number): Promise<unknown[]> {
    return await fetchPullRequestPages((page, perPage) => this.transport.request<unknown[]>({
      path: `${repositoryPath(owner, repository)}/pulls/${segment(number)}/files`,
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

  async requestReviewers(input: {
    owner: string;
    repository: string;
    number: number;
    reviewers?: string[];
    teamReviewers?: string[];
  }): Promise<void> {
    const reviewers = input.reviewers?.filter(Boolean) ?? [];
    const teamReviewers = input.teamReviewers?.filter(Boolean) ?? [];
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
