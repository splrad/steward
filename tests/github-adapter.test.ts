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
    await expect(transport.request({
      method: 'PUT', path: '/repos/splrad/steward/actions/secrets/EXAMPLE',
      body: { encrypted_value: 'ciphertext', key_id: 'key' },
    })).resolves.toBeUndefined();
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
    expect(await client.listReleases('splrad', 'steward')).toHaveLength(101);
    expect(await client.listTeamMembers('splrad', 'maintainers')).toHaveLength(101);
    expect(await client.listIssueComments('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listCommitCheckRuns('splrad', 'steward', 'a'.repeat(40))).toHaveLength(101);
    expect(await client.listWorkflowRuns('splrad', 'steward')).toHaveLength(101);
    const jobs = await client.listWorkflowJobs('splrad', 'steward', 123);
    expect(jobs).toHaveLength(101);
    expect(jobs[0]).toMatchObject({ id: 1 });
    expect(requests).toHaveLength(18);
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

  it('maps Classification label and PR metadata calls without embedding policy', async () => {
    const { transport, requests } = mockTransport((request) => (
      request.path.endsWith('/labels/bug') || request.path.endsWith('/labels')
        ? { name: 'bug', color: 'd73a4a', description: 'Bug fix' }
        : undefined
    ));
    const client = new GitHubRepositoryClient(transport);

    await expect(client.getRepositoryLabel('splrad', 'steward', ' bug ')).resolves.toMatchObject({ name: 'bug' });
    await client.createRepositoryLabel('splrad', 'steward', {
      name: ' bug ', color: '#D73A4A', description: 'Bug fix',
    });
    await client.addIssueLabels('splrad', 'steward', 6, [' bug ', 'docs', 'bug', '']);
    await client.removeIssueLabel('splrad', 'steward', 6, ' area:core ');
    await client.updatePullRequestBody('splrad', 'steward', 6, 'body with hidden metadata');

    expect(requests).toEqual([
      { path: '/repos/splrad/steward/labels/bug' },
      {
        method: 'POST', path: '/repos/splrad/steward/labels',
        body: { name: 'bug', color: 'D73A4A', description: 'Bug fix' },
      },
      {
        method: 'POST', path: '/repos/splrad/steward/issues/6/labels',
        body: { labels: ['bug', 'docs'] },
      },
      { method: 'DELETE', path: '/repos/splrad/steward/issues/6/labels/area%3Acore' },
      {
        method: 'PATCH', path: '/repos/splrad/steward/pulls/6',
        body: { body: 'body with hidden metadata' },
      },
    ]);

    const requestCount = requests.length;
    await expect(client.getRepositoryLabel('splrad', 'steward', ' ')).rejects.toThrow('label name');
    await expect(client.createRepositoryLabel('splrad', 'steward', { name: 'bug', color: 'red' }))
      .rejects.toThrow('hexadecimal color');
    await expect(client.addIssueLabels('splrad', 'steward', 6, [' '])).rejects.toThrow('one issue label');
    await expect(client.removeIssueLabel('splrad', 'steward', 6, '')).rejects.toThrow('label name');
    expect(requests).toHaveLength(requestCount);
  });

  it('maps Automation compare, branch, PR discovery, and PR mutations without embedded policy', async () => {
    const pull = {
      number: 8, state: 'open', title: 'title', body: 'body',
      base: { ref: 'main' }, head: { ref: 'feature/one', sha: 'c'.repeat(40) },
    };
    const { transport, requests } = mockTransport((request) => {
      if (request.path.includes('/git/ref/heads/')) return { ref: 'refs/heads/feature/one', object: { sha: 'c'.repeat(40) } };
      if (request.path.includes('/compare/')) return { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [], files: [] };
      if (request.method === 'POST' || request.method === 'PATCH') return pull;
      return [pull];
    });
    const client = new GitHubRepositoryClient(transport);

    await client.getBranchRef('splrad', 'steward', 'feature/one');
    await client.compareCommits('splrad', 'steward', 'main', 'feature/one');
    await client.listOpenPullRequestsForHead('splrad', 'steward', 'feature/one', 'main');
    await client.createPullRequest({
      owner: 'splrad', repository: 'steward', head: 'feature/one', base: 'main', title: 'title', body: 'body',
    });
    await client.updatePullRequest('splrad', 'steward', 8, { title: 'new title', body: 'new body' });

    expect(requests).toEqual([
      { path: '/repos/splrad/steward/git/ref/heads/feature%2Fone' },
      { path: '/repos/splrad/steward/compare/main...feature%2Fone', query: { page: 1, per_page: 100 } },
      { path: '/repos/splrad/steward/pulls', query: {
        state: 'open', head: 'splrad:feature/one', base: 'main', sort: 'updated', direction: 'desc', per_page: 2,
      } },
      { method: 'POST', path: '/repos/splrad/steward/pulls', body: {
        head: 'feature/one', base: 'main', title: 'title', body: 'body',
      } },
      { method: 'PATCH', path: '/repos/splrad/steward/pulls/8', body: { title: 'new title', body: 'new body' } },
    ]);
  });

  it('maps Release tag, commit, and Release-list reads without branch inference', async () => {
    const { transport, requests } = mockTransport((request) => {
      if (request.path.includes('/git/ref/tags/')) {
        return { ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: 'a'.repeat(40) } };
      }
      if (request.path.endsWith('/releases')) return [{ id: 7, tag_name: 'v1.2.3', draft: false }];
      return { sha: 'a'.repeat(40) };
    });
    const client = new GitHubRepositoryClient(transport);

    await expect(client.getTagRef('splrad', 'steward', 'release/v1.2.3'))
      .resolves.toMatchObject({ ref: 'refs/tags/v1.2.3' });
    await expect(client.getCommit('splrad', 'steward', 'release/v1.2.3'))
      .resolves.toMatchObject({ sha: 'a'.repeat(40) });
    await expect(client.listReleases('splrad', 'steward')).resolves.toEqual([
      { id: 7, tag_name: 'v1.2.3', draft: false },
    ]);
    expect(requests.map((request) => request.path)).toEqual([
      '/repos/splrad/steward/git/ref/tags/release%2Fv1.2.3',
      '/repos/splrad/steward/commits/release%2Fv1.2.3',
      '/repos/splrad/steward/releases',
    ]);
  });

  it('maps the explicit Release transaction mutations without hidden policy', async () => {
    const { transport, requests } = mockTransport((request) => {
      if (request.path.endsWith('/generate-notes')) return { name: 'generated', body: 'notes' };
      if (request.path.endsWith('/git/refs')) return { ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: 'a'.repeat(40) } };
      if (request.method === 'POST' && request.path.endsWith('/releases')) return { id: 7, draft: true };
      if (request.method === 'PATCH') return { id: 7, draft: false };
      return undefined;
    });
    const client = new GitHubRepositoryClient(transport);
    await client.generateReleaseNotes('splrad', 'steward', 'v1.2.3', 'a'.repeat(40));
    await client.createTagRef('splrad', 'steward', 'v1.2.3', 'a'.repeat(40));
    await client.createDraftRelease({ owner: 'splrad', repository: 'steward', tag: 'v1.2.3',
      targetCommitish: 'a'.repeat(40), name: 'Release 1.2.3', body: 'notes' });
    await client.publishRelease('splrad', 'steward', 7);
    await client.deleteRelease('splrad', 'steward', 7);
    await client.deleteTagRef('splrad', 'steward', 'v1.2.3');

    expect(requests).toEqual([
      { method: 'POST', path: '/repos/splrad/steward/releases/generate-notes',
        body: { tag_name: 'v1.2.3', target_commitish: 'a'.repeat(40) } },
      { method: 'POST', path: '/repos/splrad/steward/git/refs',
        body: { ref: 'refs/tags/v1.2.3', sha: 'a'.repeat(40) } },
      { method: 'POST', path: '/repos/splrad/steward/releases', body: {
        tag_name: 'v1.2.3', target_commitish: 'a'.repeat(40), name: 'Release 1.2.3', body: 'notes',
        draft: true, prerelease: false, generate_release_notes: false,
      } },
      { method: 'PATCH', path: '/repos/splrad/steward/releases/7', body: { draft: false } },
      { method: 'DELETE', path: '/repos/splrad/steward/releases/7' },
      { method: 'DELETE', path: '/repos/splrad/steward/git/refs/tags/v1.2.3' },
    ]);
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
    await expect(client.requestReviewers({
      owner: 'splrad', repository: 'steward', number: 6, reviewers: ['   '], teamReviewers: [''],
    }))
      .rejects.toThrow('At least one user or team reviewer');
    await client.requestReviewers({
      owner: 'splrad', repository: 'steward', number: 6,
      teamReviewers: [' maintainers ', 'maintainers'],
    });
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
