import { describe, expect, it, vi } from 'vitest';
import { loadDefaultBranchManifest, type StewardManifest } from '../packages/manifest/src/index.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  createGitHubRestTransport,
  type GitHubRequest,
  type GitHubTransport,
} from '../packages/github/src/index.js';

function minimalManifest(): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: false,
      dcoAdvisory: false,
      governance: false,
      copilotReview: false,
      release: false,
      webhookRelay: false,
    },
  };
}

function mockTransport(handler: (request: GitHubRequest) => unknown | Promise<unknown>): {
  transport: GitHubTransport;
  requests: GitHubRequest[];
} {
  const requests: GitHubRequest[] = [];
  return {
    requests,
    transport: {
      async request<T>(request: GitHubRequest): Promise<T> {
        requests.push(request);
        return await handler(request) as T;
      },
    },
  };
}

describe('GitHub REST transport', () => {
  it('sends authenticated, versioned requests only to the configured API origin', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = createGitHubRestTransport({ token: 'secret-token', fetch: fetcher });

    await expect(transport.request({ path: '/repos/splrad/steward', query: { page: 2 } }))
      .resolves.toEqual({ id: 42 });
    expect(capturedUrl).toBe('https://api.github.com/repos/splrad/steward?page=2');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-token');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(capturedInit?.redirect).toBe('error');
    await expect(transport.request({ path: 'https://example.test/steal' })).rejects.toThrow('root-relative');
    await expect(transport.request({ path: '//example.test/steal' })).rejects.toThrow('root-relative');
  });

  it('rejects ambiguous raw paths before URL or proxy normalization', async () => {
    const fetcher = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const transport = createGitHubRestTransport({
      token: 'token',
      baseUrl: 'https://github.example/api/v3/',
      fetch: fetcher,
    });

    for (const path of [
      '/repos/../admin',
      '/repos/%2e%2e/admin',
      '/repos/%2e%2e%2fadmin',
      '/repos/admin%2f..%2fsecret',
      '/repos//admin',
      '/repos\\admin',
      '/repos/%5cadmin',
      '/repos/%',
      '/repos?per_page=100',
      '/repos#fragment',
    ]) {
      await expect(transport.request({ path })).rejects.toThrow('GitHub API request path');
    }
    expect(fetcher).not.toHaveBeenCalled();

    await expect(transport.request({ path: '/repos/splrad/steward', query: { per_page: 100 } }))
      .resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://github.example/api/v3/repos/splrad/steward?per_page=100'),
      expect.any(Object),
    );

    await expect(transport.request({
      path: '/repos/splrad/steward/commits/feature%2Fsafe/check-runs',
    })).resolves.toEqual({});
    expect(fetcher).toHaveBeenLastCalledWith(
      new URL('https://github.example/api/v3/repos/splrad/steward/commits/feature%2Fsafe/check-runs'),
      expect.any(Object),
    );
  });

  it('returns bounded error metadata without exposing the token', async () => {
    const transport = createGitHubRestTransport({
      token: 'never-print-this',
      fetch: vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        statusText: 'Not Found',
      })) as unknown as typeof fetch,
    });
    const error = await transport.request({ path: '/repos/missing/repository' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 404, method: 'GET', path: '/repos/missing/repository' });
    expect(String(error)).toContain('Not Found');
    expect(String(error)).not.toContain('never-print-this');
  });

  it('accepts successful GitHub mutations with an empty response body', async () => {
    const transport = createGitHubRestTransport({
      token: 'token',
      fetch: vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
    });
    await expect(transport.request({ method: 'POST', path: '/repos/splrad/steward/actions/jobs/1/rerun' }))
      .resolves.toBeUndefined();
  });
});

describe('GitHub repository adapter', () => {
  it('implements the trusted default-branch Manifest loader boundary', async () => {
    const manifest = minimalManifest();
    const { transport, requests } = mockTransport((request) => {
      if (request.path === '/repos/splrad/steward-sandbox') {
        return { id: 77, full_name: 'splrad/steward-sandbox', default_branch: 'main' };
      }
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
        sha: 'blob-sha',
      };
    });
    const client = new GitHubRepositoryClient(transport);

    const loaded = await loadDefaultBranchManifest(client, 'splrad', 'steward-sandbox');
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.source).toEqual({ path: '.github/steward.json', ref: 'main', blobSha: 'blob-sha' });
    expect(requests).toEqual([
      { path: '/repos/splrad/steward-sandbox' },
      {
        path: '/repos/splrad/steward-sandbox/contents/.github/steward.json',
        query: { ref: 'main' },
      },
    ]);

    const invalid = new GitHubRepositoryClient(mockTransport(() => ({ default_branch: 'main' })).transport);
    await expect(invalid.getRepository('splrad', 'steward')).rejects.toThrow('invalid repository metadata');
    for (const path of ['', '/.github/steward.json', '.github//steward.json', '.github/../steward.json', '.github\\steward.json']) {
      await expect(client.getFile('splrad', 'steward', path, 'main')).rejects.toThrow('repository content path');
    }
  });

  it('uses bounded pagination for PR, Check, workflow, job, and comment reads', async () => {
    const { transport, requests } = mockTransport((request) => {
      const page = Number(request.query?.page ?? 1);
      const items = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }];
      if (request.path.endsWith('/check-runs')) return { check_runs: items };
      if (request.path.endsWith('/actions/runs')) return { workflow_runs: items };
      if (request.path.endsWith('/jobs')) return { jobs: items };
      return items;
    });
    const client = new GitHubRepositoryClient(transport);

    expect(await client.listPullRequestCommits('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listPullRequestReviews('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listPullRequestFiles('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listTeamMembers('splrad', 'maintainers')).toHaveLength(101);
    expect(await client.listIssueComments('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listCommitCheckRuns('splrad', 'steward', 'a'.repeat(40))).toHaveLength(101);
    expect(await client.listWorkflowRuns('splrad', 'steward')).toHaveLength(101);
    const jobs = await client.listWorkflowJobs('splrad', 'steward', 123);
    expect(jobs).toHaveLength(101);
    expect(jobs[0]).toMatchObject({ id: 1 });
    expect(requests).toHaveLength(16);
    expect(requests.every((request) => request.query?.per_page === 100)).toBe(true);
  });

  it('paginates review threads and fails closed on GraphQL errors', async () => {
    const { transport, requests } = mockTransport((request) => {
      const cursor = (request.body as { variables?: { cursor?: string | null } }).variables?.cursor;
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: cursor ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'next' },
                nodes: [{ id: cursor ? 'thread-2' : 'thread-1', isResolved: false, isOutdated: false, comments: { nodes: [] } }],
              },
            },
          },
        },
      };
    });
    const client = new GitHubRepositoryClient(transport);
    expect((await client.listReviewThreads('splrad', 'steward', 6)).map((thread) => thread.id))
      .toEqual(['thread-1', 'thread-2']);
    expect(requests).toHaveLength(2);

    const failing = new GitHubRepositoryClient(mockTransport(() => ({ errors: [{ message: 'denied' }] })).transport);
    await expect(failing.listReviewThreads('splrad', 'steward', 6)).rejects.toThrow('denied');

    const truncated = new GitHubRepositoryClient(mockTransport(() => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: 'thread', isResolved: false, isOutdated: false,
                comments: { pageInfo: { hasNextPage: true }, nodes: [] },
              }],
            },
          },
        },
      },
    })).transport);
    await expect(truncated.listReviewThreads('splrad', 'steward', 6)).rejects.toThrow('100-comment limit');
  });

  it('uses a separately confined GraphQL transport for GitHub Enterprise Server', async () => {
    const restFetcher = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const graphqlFetcher = vi.fn(async () => new Response(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    }))) as unknown as typeof fetch;
    const client = new GitHubRepositoryClient(
      createGitHubRestTransport({
        token: 'token', baseUrl: 'https://github.example/api/v3/', fetch: restFetcher,
      }),
      createGitHubRestTransport({
        token: 'token', baseUrl: 'https://github.example/api/', fetch: graphqlFetcher,
      }),
    );

    await expect(client.listReviewThreads('splrad', 'steward', 7)).resolves.toEqual([]);
    expect(restFetcher).not.toHaveBeenCalled();
    expect(graphqlFetcher).toHaveBeenCalledWith(
      new URL('https://github.example/api/graphql'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('distinguishes omitted Check output from explicitly empty fields', async () => {
    const { transport, requests } = mockTransport(() => ({ id: 1, name: 'Gate', status: 'in_progress' }));
    const client = new GitHubRepositoryClient(transport);

    await client.updateCheckRun('splrad', 'steward', 1, {
      name: 'Gate', status: 'in_progress', title: '', summary: '',
    });
    await client.updateCheckRun('splrad', 'steward', 1, {
      name: 'Gate', status: 'in_progress',
    });

    expect(requests[0]?.body).toMatchObject({ output: { title: '', summary: '' } });
    expect(requests[1]?.body).not.toHaveProperty('output');
  });

  it('maps one explicit adapter call to one GitHub mutation', async () => {
    const { transport, requests } = mockTransport((request) => (
      request.path.includes('/check-runs') ? { id: 1, name: 'Gate', status: 'in_progress' } : undefined
    ));
    const client = new GitHubRepositoryClient(transport);
    const check = {
      name: 'Gate',
      headSha: 'a'.repeat(40),
      status: 'in_progress' as const,
      externalId: 'identity',
      title: 'Waiting',
      summary: 'Awaiting evidence.',
    };

    await client.createCheckRun('splrad', 'steward', check);
    await client.updateCheckRun('splrad', 'steward', 1, {
      name: check.name,
      status: 'completed',
      conclusion: 'success',
      externalId: check.externalId,
      title: check.title,
      summary: check.summary,
    });
    await client.createIssueComment('splrad', 'steward', 6, 'body');
    await client.updateIssueComment('splrad', 'steward', 2, 'updated');
    await client.deleteIssueComment('splrad', 'steward', 2);
    await expect(client.requestReviewers({ owner: 'splrad', repository: 'steward', number: 6 }))
      .rejects.toThrow('At least one user or team reviewer');
    await client.requestReviewers({ owner: 'splrad', repository: 'steward', number: 6, teamReviewers: ['maintainers'] });
    await client.createPullRequestReview({
      owner: 'splrad', repository: 'steward', number: 6, commitId: 'a'.repeat(40), event: 'APPROVE', body: 'approved',
    });
    await client.dispatchWorkflow({
      owner: 'splrad', repository: 'steward', workflow: 'pr-governance.yml', ref: 'main', inputs: { pr_number: '6' },
    });
    await client.rerunWorkflowJob('splrad', 'steward', 9);
    await client.approveWorkflowRun('splrad', 'steward', 10);

    expect(requests).toHaveLength(10);
    expect(requests.map((request) => request.method)).toEqual([
      'POST', 'PATCH', 'POST', 'PATCH', 'DELETE', 'POST', 'POST', 'POST', 'POST', 'POST',
    ]);
    expect(requests[0]?.body).toMatchObject({
      name: 'Gate', head_sha: 'a'.repeat(40), external_id: 'identity', output: { title: 'Waiting' },
    });
    expect(requests[1]?.body).not.toHaveProperty('head_sha');
    expect(requests[7]).toMatchObject({
      path: '/repos/splrad/steward/actions/workflows/pr-governance.yml/dispatches',
      body: { ref: 'main', inputs: { pr_number: '6' } },
    });
    expect(requests[5]?.body).toEqual({ team_reviewers: ['maintainers'] });
  });
});
