import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeRepositoryFanoutPageRequestV1,
  buildStewardRuntimeScopeWorkItemV1,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json,
  parseStewardRuntimeRepositoryFanoutPageReceiptV1,
} from '../packages/core/src/index.js';
import {
  createControlRuntimeHandler,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const appId = 4_243_096;
const organizationId = 302_208_797;
const installationId = 145_952_003;
const repositoryId = 1_298_587_318;
const repositoryFullName = 'splrad/LayerScape';
const installationToken = 'ghs_repository_fanout_token_123456789';

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-27T03:00:00.000Z',
  },
  GITHUB_APP_ID: String(appId),
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  STEWARD_ORGANIZATION_ID: organizationId,
  STEWARD_ORGANIZATION_LOGIN: 'splrad',
};

const scopeWorkItem = buildStewardRuntimeScopeWorkItemV1({
  operation: 'scope-reconcile',
  target: {
    scope: 'repository',
    mode: 'refresh',
    installationId,
    repositoryId,
    pullRequests: 'all-open',
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    event: 'repository',
    action: 'renamed',
    receivedAt: '2026-07-27T03:04:05.678Z',
  },
});

function pageRequest(cursor: string | null = null) {
  return buildStewardRuntimeRepositoryFanoutPageRequestV1({
    binding: {
      scopeWorkItem,
      generation: 7,
      pass: 1,
      cursor,
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function request(input = pageRequest(), protocol = 'repository-fanout-1') {
  return new Request(
    'https://control.internal/v1/repository-fanout/page',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-steward-internal-protocol': protocol,
      },
      body: canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json(input),
    },
  );
}

interface FakeOptions {
  readonly installationAccountId?: number;
  readonly installationSuspendedAt?: string;
  readonly repositoryStatus?: number;
  readonly repositoryFullName?: string;
  readonly repositoryOwner?: {
    readonly id: number;
    readonly login: string;
    readonly type: 'Organization' | 'User';
  };
  readonly tokenPermissions?: Record<string, string>;
  readonly tokenRepositoryId?: number;
  readonly graphql?: unknown;
  readonly graphqlStatus?: number;
  readonly graphqlHeaders?: Readonly<Record<string, string>>;
}

function fakeGitHub(options: FakeOptions = {}) {
  const records: {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly body: unknown;
  }[] = [];
  const fetcher = vi.fn(async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as unknown
      : null;
    records.push({
      method,
      path: url.pathname,
      authorization: headers.get('authorization'),
      body,
    });
    if (method === 'GET' && url.pathname === '/app') {
      return jsonResponse({
        id: appId,
        client_id: 'Iv23liuSr0qd4WLJdZhH',
        slug: 'splrad-steward',
      });
    }
    if (
      method === 'GET'
      && url.pathname === `/app/installations/${installationId}`
    ) {
      return jsonResponse({
        id: installationId,
        app_id: appId,
        account: {
          id: options.installationAccountId ?? organizationId,
          login: 'splrad',
          type: 'Organization',
        },
        target_type: 'Organization',
        suspended_at: options.installationSuspendedAt ?? null,
      });
    }
    if (
      method === 'POST'
      && url.pathname
        === `/app/installations/${installationId}/access_tokens`
    ) {
      return jsonResponse({
        token: installationToken,
        repository_selection: 'selected',
        permissions: options.tokenPermissions ?? {
          metadata: 'read',
          pull_requests: 'read',
        },
        repositories: [{
          id: options.tokenRepositoryId ?? repositoryId,
        }],
      }, 201);
    }
    if (method === 'GET' && url.pathname === `/repositories/${repositoryId}`) {
      if (options.repositoryStatus) {
        return jsonResponse({ message: 'Not Found' }, options.repositoryStatus);
      }
      return jsonResponse({
        id: repositoryId,
        full_name: options.repositoryFullName ?? repositoryFullName,
        owner: options.repositoryOwner ?? {
          id: organizationId,
          login: 'splrad',
          type: 'Organization',
        },
      });
    }
    if (method === 'POST' && url.pathname === '/graphql') {
      return new Response(
        JSON.stringify(options.graphql ?? {
          data: {
            repository: {
              databaseId: repositoryId,
              nameWithOwner: repositoryFullName,
              pullRequests: {
                totalCount: 2,
                pageInfo: {
                  hasNextPage: false,
                  endCursor: 'terminal-ignored',
                },
                nodes: [
                  { number: 130, state: 'OPEN' },
                  { number: 131, state: 'OPEN' },
                ],
              },
            },
          },
        }),
        {
          status: options.graphqlStatus ?? 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...options.graphqlHeaders,
          },
        },
      );
    }
    return jsonResponse({ message: 'unexpected endpoint' }, 500);
  }) as unknown as typeof fetch;
  return { records, fetcher };
}

describe('Control repository fan-out page handler', () => {
  it('uses an exact repository-scoped read token and returns a bound live page', async () => {
    const github = fakeGitHub();
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });

    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(200);
    const receipt = parseStewardRuntimeRepositoryFanoutPageReceiptV1(
      await response.json(),
    );
    expect(receipt).toMatchObject({
      binding: pageRequest().binding,
      repository: {
        state: 'live',
        id: repositoryId,
        fullName: repositoryFullName,
      },
      page: {
        totalCount: 2,
        pullRequestNumbers: [130, 131],
        hasNextPage: false,
        endCursor: null,
      },
    });

    const tokenRequest = github.records.find(
      (record) => record.path.endsWith('/access_tokens'),
    );
    expect(tokenRequest?.body).toEqual({
      repository_ids: [repositoryId],
      permissions: {
        metadata: 'read',
        pull_requests: 'read',
      },
    });
    expect(github.records.find((record) => record.path === '/graphql')?.authorization)
      .toBe(`Bearer ${installationToken}`);
  });

  it('binds and forwards only the opaque cursor selected by the coordinator', async () => {
    const github = fakeGitHub({
      graphql: {
        data: {
          repository: {
            databaseId: repositoryId,
            nameWithOwner: repositoryFullName,
            pullRequests: {
              totalCount: 101,
              pageInfo: { hasNextPage: true, endCursor: 'next-page==' },
              nodes: [{ number: 131, state: 'OPEN' }],
            },
          },
        },
      },
    });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });
    const response = await handler.fetch(request(pageRequest('current-page==')), env);
    expect(response.status).toBe(200);
    const graphql = github.records.find((record) => record.path === '/graphql');
    expect(graphql?.body).toMatchObject({
      variables: {
        owner: 'splrad',
        repository: 'LayerScape',
        cursor: 'current-page==',
      },
    });
  });

  it('converges an explicit repository 404 to an empty tombstone page', async () => {
    const github = fakeGitHub({ repositoryStatus: 404 });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repository: { state: 'absent', id: repositoryId, fullName: null },
      page: {
        totalCount: 0,
        pullRequestNumbers: [],
        hasNextPage: false,
        endCursor: null,
      },
    });
    expect(github.records.some((record) => record.path === '/graphql')).toBe(false);
  });

  it('keeps a suspended installation retryable instead of manufacturing a tombstone', async () => {
    const github = fakeGitHub({
      installationSuspendedAt: '2026-07-27T03:05:00Z',
    });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });

    const response = await handler.fetch(request(), env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-fanout-unavailable',
    });
    expect(
      github.records.some((record) =>
        record.path.endsWith('/access_tokens')),
    ).toBe(false);
    expect(
      github.records.some((record) => record.path === '/graphql'),
    ).toBe(false);
  });

  it('converges the same repository ID under a new owner to an organization-scope tombstone', async () => {
    const github = fakeGitHub({
      repositoryFullName: 'axiomoth/LayerScape',
      repositoryOwner: {
        id: organizationId + 1,
        login: 'axiomoth',
        type: 'User',
      },
    });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });

    const response = await handler.fetch(request(), env);

    expect(response.status).toBe(200);
    const receipt = parseStewardRuntimeRepositoryFanoutPageReceiptV1(
      await response.json(),
    );
    expect(receipt).toMatchObject({
      repository: {
        state: 'absent',
        id: repositoryId,
        fullName: null,
      },
      page: {
        totalCount: 0,
        pullRequestNumbers: [],
        hasNextPage: false,
        endCursor: null,
      },
    });
    expect(
      github.records.some((record) => record.path === '/graphql'),
    ).toBe(false);
  });

  it('does not fold an installation identity mismatch into repository absence', async () => {
    const github = fakeGitHub({
      installationAccountId: organizationId + 1,
    });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });

    const response = await handler.fetch(request(), env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-access-denied',
    });
    expect(
      github.records.some((record) =>
        record.path.endsWith('/access_tokens')),
    ).toBe(false);
    expect(
      github.records.some((record) => record.path === '/graphql'),
    ).toBe(false);
  });

  it('preserves a GraphQL rate-limit retry interval for the Coordinator', async () => {
    const github = fakeGitHub({
      graphql: { message: 'secondary rate limit exceeded' },
      graphqlStatus: 429,
      graphqlHeaders: { 'retry-after': '37' },
    });
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken: vi.fn(async () => 'test-app-jwt'),
    });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    await expect(response.json()).resolves.toEqual({
      error: 'github-rate-limited',
    });
  });

  it('fails closed on token permission expansion or repository substitution', async () => {
    for (const options of [
      {
        tokenPermissions: {
          contents: 'read',
          metadata: 'read',
          pull_requests: 'read',
        },
      },
      { tokenRepositoryId: repositoryId + 1 },
    ]) {
      const github = fakeGitHub(options);
      const handler = createControlRuntimeHandler({
        fetch: github.fetcher,
        appToken: vi.fn(async () => 'test-app-jwt'),
      });
      const response = await handler.fetch(request(), env);
      expect(response.status).toBe(503);
      expect(github.records.some((record) => record.path === '/graphql')).toBe(false);
    }
  });

  it('rejects an invalid protocol or envelope before any App or GitHub access', async () => {
    const github = fakeGitHub();
    const appToken = vi.fn(async () => 'test-app-jwt');
    const handler = createControlRuntimeHandler({
      fetch: github.fetcher,
      appToken,
    });
    expect((await handler.fetch(request(pageRequest(), '2'), env)).status).toBe(403);

    const malformed = new Request(
      'https://control.internal/v1/repository-fanout/page',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-steward-internal-protocol': 'repository-fanout-1',
        },
        body: JSON.stringify({ ...pageRequest(), unknown: true }),
      },
    );
    expect((await handler.fetch(malformed, env)).status).toBe(400);
    expect(appToken).not.toHaveBeenCalled();
    expect(github.records).toHaveLength(0);
  });
});
