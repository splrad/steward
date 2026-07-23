import { describe, expect, it, vi } from 'vitest';
import { loadDefaultBranchManifest, type StewardManifest } from '../packages/manifest/src/index.js';
import {
  GitHubApiError,
  GITHUB_CLOUD_REST_API_VERSION,
  GITHUB_ENTERPRISE_REST_API_VERSION,
  GitHubRepositoryClient,
  GitHubTransportError,
  createGitHubRestTransport,
  defaultGitHubRestApiVersion,
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
      restApiVersion: GITHUB_CLOUD_REST_API_VERSION,
      restApiBaseUrl: 'https://api.github.com/',
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
    expect(transport.restApiBaseUrl).toBe('https://api.github.com/');

    await expect(transport.request({ path: '/repos/splrad/steward', query: { page: 2 } }))
      .resolves.toEqual({ id: 42 });
    expect(capturedUrl).toBe('https://api.github.com/repos/splrad/steward?page=2');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-token');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(GITHUB_CLOUD_REST_API_VERSION).toBe('2026-03-10');
    expect(headers.get('x-github-api-version')).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(capturedInit?.redirect).toBe('manual');

    await transport.request({
      path: '/orgs/splrad/teams/maintainers/repos/splrad/steward',
      accept: 'application/vnd.github.v3.repository+json',
    });
    expect(new Headers(capturedInit?.headers).get('accept')).toBe('application/vnd.github.v3.repository+json');
    await expect(transport.request({ path: 'https://example.test/steal' })).rejects.toThrow('root-relative');
    await expect(transport.request({ path: '//example.test/steal' })).rejects.toThrow('root-relative');
  });

  it('selects Cloud and GHES REST versions without conflating their capabilities', async () => {
    expect(defaultGitHubRestApiVersion('https://api.github.com/')).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://api.example.ghe.com/')).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://github.example/api/v3/')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://example.ghe.com/')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://uploads.example.ghe.com/')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://api.first.second.ghe.com/')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);
    expect(defaultGitHubRestApiVersion('https://api.example.ghe.com.evil.test/')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);

    let headers = new Headers();
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response('{}');
    }) as unknown as typeof fetch;
    const transport = createGitHubRestTransport({
      token: 'token', baseUrl: 'https://github.example/api/v3/', fetch: fetcher,
    });
    await transport.request({ path: '/repos/splrad/steward' });
    expect(transport.restApiVersion).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);
    expect(headers.get('x-github-api-version')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);

    const upgraded = createGitHubRestTransport({
      token: 'token', baseUrl: 'https://github.example/api/v3/',
      apiVersion: GITHUB_CLOUD_REST_API_VERSION, fetch: fetcher,
    });
    await upgraded.request({ path: '/repos/splrad/steward' });
    expect(upgraded.restApiVersion).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(headers.get('x-github-api-version')).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(() => createGitHubRestTransport({
      token: 'token', baseUrl: 'https://github.example/api/v3/', apiVersion: '2026-99-99', fetch: fetcher,
    })).toThrow('valid YYYY-MM-DD date');
    expect(() => createGitHubRestTransport({
      token: 'token', baseUrl: 'https://api.github.com/proxy/', fetch: fetcher,
    })).toThrow('official HTTPS origin and root path');
    expect(() => createGitHubRestTransport({
      token: 'token', baseUrl: 'https://api.example.ghe.com:444/', fetch: fetcher,
    })).toThrow('official HTTPS origin and root path');
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

  it('follows bounded same-origin GET redirects without changing the authentication boundary', async () => {
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(input));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
      if (requestedUrls.length === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: '/repos/splrad/steward' },
        });
      }
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = createGitHubRestTransport({ token: 'secret-token', fetch: fetcher });

    await expect(transport.request({ path: '/repos/splrad/renamed-steward' }))
      .resolves.toEqual({ id: 42 });
    expect(requestedUrls).toEqual([
      'https://api.github.com/repos/splrad/renamed-steward',
      'https://api.github.com/repos/splrad/steward',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-origin and non-GET redirects before forwarding credentials or request bodies', async () => {
    const crossOriginFetcher = vi.fn(async () => new Response(null, {
      status: 301,
      headers: { location: 'https://example.test/repos/splrad/steward' },
    })) as unknown as typeof fetch;
    const crossOrigin = createGitHubRestTransport({ token: 'secret-token', fetch: crossOriginFetcher });
    const crossOriginError = await crossOrigin.request({ path: '/repos/splrad/steward' })
      .catch((reason: unknown) => reason);
    expect(crossOriginError).toBeInstanceOf(GitHubTransportError);
    expect(crossOriginError).toMatchObject({
      method: 'GET', path: '/repos/splrad/steward', reason: 'redirect', retryable: false,
    });
    expect(crossOriginFetcher).toHaveBeenCalledTimes(1);

    const mutationFetcher = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: '/repos/splrad/steward/issues' },
    })) as unknown as typeof fetch;
    const mutation = createGitHubRestTransport({ token: 'secret-token', fetch: mutationFetcher });
    const mutationError = await mutation.request({
      method: 'POST', path: '/repos/splrad/steward/issues', body: { title: 'example' },
    }).catch((reason: unknown) => reason);
    expect(mutationError).toBeInstanceOf(GitHubTransportError);
    expect(mutationError).toMatchObject({
      method: 'POST', path: '/repos/splrad/steward/issues', reason: 'redirect', retryable: false,
    });
    expect(mutationFetcher).toHaveBeenCalledTimes(1);
  });

  it('classifies 403 and 429 rate limits without inventing a missing Retry-After value', async () => {
    const responses = [
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-github-request-id': 'RATE-403',
        },
      }),
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
        status: 429,
        headers: {
          'retry-after': '12',
          'x-github-request-id': 'RATE-429',
        },
      }),
    ];
    const transport = createGitHubRestTransport({
      token: 'token',
      fetch: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });

    const primary = await transport.request({ path: '/rate-limited-primary' })
      .catch((reason: unknown) => reason);
    expect(primary).toBeInstanceOf(GitHubApiError);
    if (!(primary instanceof GitHubApiError)) throw new TypeError('expected a GitHubApiError');
    expect(primary).toMatchObject({ status: 403, rateLimited: true, requestId: 'RATE-403' });
    expect(primary.retryAfterSeconds).toBeUndefined();

    const secondary = await transport.request({ path: '/rate-limited-secondary' })
      .catch((reason: unknown) => reason);
    expect(secondary).toBeInstanceOf(GitHubApiError);
    expect(secondary).toMatchObject({
      status: 429, rateLimited: true, retryAfterSeconds: 12, requestId: 'RATE-429',
    });
  });

  it('returns typed transport failures for network errors and invalid successful JSON', async () => {
    const network = createGitHubRestTransport({
      token: 'token',
      fetch: vi.fn(async () => { throw new TypeError('connection reset'); }) as unknown as typeof fetch,
    });
    const networkError = await network.request({ path: '/repos/splrad/steward' })
      .catch((reason: unknown) => reason);
    expect(networkError).toBeInstanceOf(GitHubTransportError);
    expect(networkError).toMatchObject({
      method: 'GET', path: '/repos/splrad/steward', reason: 'network', retryable: true,
    });

    const invalidJson = createGitHubRestTransport({
      token: 'token',
      fetch: vi.fn(async () => new Response('{invalid', { status: 200 })) as unknown as typeof fetch,
    });
    const invalidJsonError = await invalidJson.request({ path: '/repos/splrad/steward' })
      .catch((reason: unknown) => reason);
    expect(invalidJsonError).toBeInstanceOf(GitHubTransportError);
    expect(invalidJsonError).toMatchObject({
      method: 'GET', path: '/repos/splrad/steward', reason: 'invalid-response', retryable: false,
    });
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
  it('resolves a durable App bot identity through the installation-token-compatible user endpoint', async () => {
    const { transport, requests } = mockTransport(() => ({
      id: 99,
      login: 'splrad-steward[bot]',
      type: 'Bot',
    }));
    const client = new GitHubRepositoryClient(transport);

    await expect(client.getUser('splrad-steward[bot]')).resolves.toEqual({
      id: 99,
      login: 'splrad-steward[bot]',
      type: 'Bot',
    });
    expect(requests).toEqual([{ path: '/users/splrad-steward%5Bbot%5D' }]);
    await expect(client.getUser(' ')).rejects.toThrow('requires a login');
  });

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
    expect(await client.listPullRequestsForCommit('splrad', 'steward', 'a'.repeat(40))).toHaveLength(101);
    expect(await client.listReleases('splrad', 'steward')).toHaveLength(101);
    expect(await client.listTeamMembers('splrad', 'maintainers')).toHaveLength(101);
    expect(await client.listIssueComments('splrad', 'steward', 6)).toHaveLength(101);
    expect(await client.listCommitCheckRuns('splrad', 'steward', 'a'.repeat(40))).toHaveLength(101);
    expect(await client.listWorkflowRuns('splrad', 'steward')).toHaveLength(101);
    const jobs = await client.listWorkflowJobs('splrad', 'steward', 123);
    expect(jobs).toHaveLength(101);
    expect(jobs[0]).toMatchObject({ id: 1 });
    expect(requests).toHaveLength(20);
    expect(requests.every((request) => request.query?.per_page === 100)).toBe(true);
    expect(requests.filter((request) => request.path.endsWith('/check-runs'))
      .every((request) => request.query?.filter === 'all')).toBe(true);
    await expect(client.listPullRequestsForCommit('splrad', 'steward', 'not-a-sha'))
      .rejects.toThrow('40 hexadecimal characters');
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

  it('keeps REST pull data separate and loads merged state atomically from GraphQL', async () => {
    const mergeCommitSha = 'a'.repeat(40);
    const rest = mockTransport(() => ({
      number: 6,
      state: 'closed',
      merged: true,
      merge_commit_sha: 'b'.repeat(40),
      base: { ref: 'main' },
      head: { sha: 'c'.repeat(40) },
    }));
    const graphql = mockTransport(() => ({
      data: { repository: { pullRequest: { state: 'MERGED', merged: true, mergeCommit: { oid: mergeCommitSha } } } },
    }));
    const client = new GitHubRepositoryClient(rest.transport, graphql.transport);

    const pull = await client.getPullRequest('splrad', 'steward', 6);
    expect(pull).toMatchObject({ number: 6, state: 'closed' });
    expect(pull).not.toHaveProperty('merge_commit_sha');
    expect(pull).not.toHaveProperty('mergeCommitSha');
    await expect(client.getPullRequestMergeState('splrad', 'steward', 6)).resolves.toEqual({
      merged: true,
      mergeCommitSha,
    });
    expect(graphql.requests).toHaveLength(1);
    expect(graphql.requests[0]).toMatchObject({
      method: 'POST',
      path: '/graphql',
      body: {
        variables: { owner: 'splrad', repository: 'steward', number: 6 },
      },
    });
    const query = String((graphql.requests[0]?.body as { query?: string }).query);
    expect(query).toContain('merged');
    expect(query).toContain('state');
    expect(query).toContain('mergeCommit { oid }');
  });

  it('does not query GraphQL during ordinary REST reads and fails closed on invalid merge data', async () => {
    const openRest = mockTransport(() => ({
      number: 6,
      state: 'open',
      merged: false,
      base: { ref: 'main' },
      head: { sha: 'c'.repeat(40) },
    }));
    const unusedGraphql = mockTransport(() => {
      throw new Error('GraphQL must not be called');
    });
    await expect(new GitHubRepositoryClient(openRest.transport, unusedGraphql.transport)
      .getPullRequest('splrad', 'steward', 6)).resolves.toMatchObject({ state: 'open' });
    expect(unusedGraphql.requests).toHaveLength(0);

    const unmerged = mockTransport(() => ({
      data: { repository: { pullRequest: { state: 'CLOSED', merged: false, mergeCommit: null } } },
    }));
    await expect(new GitHubRepositoryClient(openRest.transport, unmerged.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).resolves.toEqual({
      merged: false, mergeCommitSha: null,
    });

    const mergedRest = mockTransport(() => ({
      number: 6,
      state: 'closed',
      merged: true,
      base: { ref: 'main' },
      head: { sha: 'c'.repeat(40) },
    }));
    const graphqlError = mockTransport(() => ({ errors: [{ message: 'denied' }] }));
    await expect(new GitHubRepositoryClient(mergedRest.transport, graphqlError.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).rejects.toThrow('denied');

    const missingCommit = mockTransport(() => ({
      data: { repository: { pullRequest: { state: 'MERGED', merged: true, mergeCommit: null } } },
    }));
    await expect(new GitHubRepositoryClient(mergedRest.transport, missingCommit.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).rejects.toThrow('valid merge commit');

    const missingPull = mockTransport(() => ({ data: { repository: { pullRequest: null } } }));
    await expect(new GitHubRepositoryClient(mergedRest.transport, missingPull.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).rejects.toThrow('no pull request merge state');

    const inconsistent = mockTransport(() => ({
      data: { repository: { pullRequest: { state: 'CLOSED', merged: false, mergeCommit: { oid: 'a'.repeat(40) } } } },
    }));
    await expect(new GitHubRepositoryClient(mergedRest.transport, inconsistent.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).rejects.toThrow('inconsistent pull request merge state');

    const reopened = mockTransport(() => ({
      data: { repository: { pullRequest: { state: 'OPEN', merged: false, mergeCommit: null } } },
    }));
    await expect(new GitHubRepositoryClient(mergedRest.transport, reopened.transport)
      .getPullRequestMergeState('splrad', 'steward', 6)).rejects.toThrow('inconsistent pull request state');
  });

  it('rejects legacy or malformed workflow dispatch responses', async () => {
    const input = {
      owner: 'splrad', repository: 'steward', workflow: 'pr-governance.yml', ref: 'main', inputs: { pr_number: '6' },
    };
    for (const payload of [
      undefined,
      { workflow_run_id: 0, run_url: 'https://api.github.com/run/0', html_url: 'https://github.com/run/0' },
      { workflow_run_id: '1', run_url: 'https://api.github.com/run/1', html_url: 'https://github.com/run/1' },
      { workflow_run_id: 1, run_url: 'not-a-url', html_url: 'https://github.com/run/1' },
      { workflow_run_id: 1, run_url: 'https://api.github.com/run/1' },
      {
        workflow_run_id: 1,
        run_url: 'https://api.github.com/repos/splrad/other/actions/runs/1',
        html_url: 'https://github.com/splrad/steward/actions/runs/1',
      },
      {
        workflow_run_id: 1,
        run_url: 'https://evil.example/repos/splrad/steward/actions/runs/1',
        html_url: 'https://github.com/splrad/steward/actions/runs/1',
      },
      {
        workflow_run_id: 1,
        run_url: 'https://api.github.com/repos/splrad/steward/actions/runs/1',
        html_url: 'https://evil.example/splrad/steward/actions/runs/1',
      },
    ]) {
      const client = new GitHubRepositoryClient(mockTransport(() => payload).transport);
      await expect(client.dispatchWorkflow(input)).rejects.toThrow('invalid workflow dispatch response');
    }
  });

  it('binds 2026 workflow dispatch URLs to the configured GHES endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      workflow_run_id: 44,
      run_url: 'https://github.example/api/v3/repos/splrad/steward/actions/runs/44',
      html_url: 'https://github.example/splrad/steward/actions/runs/44',
    }))) as unknown as typeof fetch;
    const transport = createGitHubRestTransport({
      token: 'token', baseUrl: 'https://github.example/api/v3/',
      apiVersion: GITHUB_CLOUD_REST_API_VERSION, fetch: fetcher,
    });

    await expect(new GitHubRepositoryClient(transport).dispatchWorkflow({
      owner: 'splrad', repository: 'steward', workflow: 'pr-governance.yml', ref: 'main', inputs: {},
    })).resolves.toEqual({
      kind: 'identified', workflowRunId: 44,
      runUrl: 'https://github.example/api/v3/repos/splrad/steward/actions/runs/44',
      htmlUrl: 'https://github.example/splrad/steward/actions/runs/44',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('binds GHEC workflow dispatch URLs to the same tenant without retrying', async () => {
    const responses = [
      {
        workflow_run_id: 45,
        run_url: 'https://api.acme.ghe.com/repos/splrad/steward/actions/runs/45',
        html_url: 'https://acme.ghe.com/splrad/steward/actions/runs/45',
      },
      {
        workflow_run_id: 46,
        run_url: 'https://api.other.ghe.com/repos/splrad/steward/actions/runs/46',
        html_url: 'https://other.ghe.com/splrad/steward/actions/runs/46',
      },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()))) as unknown as typeof fetch;
    const client = new GitHubRepositoryClient(createGitHubRestTransport({
      token: 'token', baseUrl: 'https://api.acme.ghe.com/', fetch: fetcher,
    }));
    const input = {
      owner: 'splrad', repository: 'steward', workflow: 'pr-governance.yml', ref: 'main', inputs: {},
    };

    await expect(client.dispatchWorkflow(input)).resolves.toMatchObject({
      kind: 'identified', workflowRunId: 45,
    });
    await expect(client.dispatchWorkflow(input)).rejects.toThrow('invalid workflow dispatch response');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves the accepted legacy dispatch outcome for GHES without retrying a successful 204', async () => {
    const transport = mockTransport(() => undefined).transport;
    Object.defineProperty(transport, 'restApiVersion', { value: GITHUB_ENTERPRISE_REST_API_VERSION });
    const client = new GitHubRepositoryClient(transport);
    await expect(client.dispatchWorkflow({
      owner: 'splrad', repository: 'steward', workflow: 'pr-governance.yml', ref: 'main', inputs: { pr_number: '6' },
    })).resolves.toEqual({ kind: 'accepted' });
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

  it('maps generic label and pull-request body calls without embedding policy', async () => {
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
    await client.updatePullRequestBody('splrad', 'steward', 6, 'consumer-owned body update');

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
        body: { body: 'consumer-owned body update' },
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
    const { transport, requests } = mockTransport((request) => {
      if (request.path.includes('/check-runs')) return { id: 1, name: 'Gate', status: 'in_progress' };
      if (request.path.endsWith('/dispatches')) {
        return {
          workflow_run_id: 123,
          run_url: 'https://api.github.com/repos/splrad/steward/actions/runs/123',
          html_url: 'https://github.com/splrad/steward/actions/runs/123',
        };
      }
      return undefined;
    });
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
      externalId: 'final-evidence',
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
    const dispatched = await client.dispatchWorkflow({
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
    expect(requests[1]?.body).toMatchObject({
      name: 'Gate', status: 'completed', conclusion: 'success', external_id: 'final-evidence',
      output: { title: 'Waiting', summary: 'Awaiting evidence.' },
    });
    expect(requests[1]?.body).not.toHaveProperty('head_sha');
    expect(requests[7]).toMatchObject({
      path: '/repos/splrad/steward/actions/workflows/pr-governance.yml/dispatches',
      body: { ref: 'main', inputs: { pr_number: '6' } },
    });
    expect(dispatched).toEqual({
      kind: 'identified',
      workflowRunId: 123,
      runUrl: 'https://api.github.com/repos/splrad/steward/actions/runs/123',
      htmlUrl: 'https://github.com/splrad/steward/actions/runs/123',
    });
    expect(requests[7]?.body).not.toHaveProperty('return_run_details');
    expect(requests[5]?.body).toEqual({ team_reviewers: ['maintainers'] });
  });
});
