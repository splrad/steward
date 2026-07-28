import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeInstallationFanoutPageRequestV1,
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeInstallationIndexBootstrapPageRequestV1,
  buildStewardRuntimeInstallationRepositoryChildV1,
  buildStewardRuntimeRepositoryFanoutPageRequestV3,
  canonicalStewardRuntimeInstallationFanoutPageRequestV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json,
  parseStewardRuntimeInstallationFanoutPageReceiptV1,
  parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  parseStewardRuntimeRepositoryFanoutPageReceiptV3,
} from '../packages/core/src/index.js';
import {
  createControlRuntimeHandler,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const appId = 4_243_096;
const organizationId = 302_208_797;
const installationId = 145_952_003;
const repositoryId = 1_298_587_318;
const installationToken = 'ghs_installation_fanout_token_123456789';
const repositoryToken = 'ghs_repository_child_token_123456789';

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-28T03:00:00.000Z',
  },
  GITHUB_APP_ID: String(appId),
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  STEWARD_ORGANIZATION_ID: organizationId,
  STEWARD_ORGANIZATION_LOGIN: 'splrad',
};

const root = {
  installationId,
  deliveryId: 'installation-wide-delivery',
  scopeWorkItem: {
    schemaVersion: 2,
    operation: 'scope-reconcile',
    target: {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: 'installation-wide-delivery',
      event: 'custom_property',
      action: 'updated',
      ref: null,
      receivedAt: '2026-07-28T03:04:05.678Z',
    },
  },
} as const;

function pageRequest(cursor: string | null = null) {
  return buildStewardRuntimeInstallationFanoutPageRequestV1({
    binding: {
      root,
      generation: 7,
      pass: 1,
      cursor,
    },
  });
}

function installationRequest(cursor: string | null = null) {
  const input = pageRequest(cursor);
  return new Request(
    'https://control.internal/v1/installation-fanout/page',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-steward-internal-protocol': 'installation-fanout-1',
      },
      body: canonicalStewardRuntimeInstallationFanoutPageRequestV1Json(input),
    },
  );
}

async function installationBootstrapRequest(input: {
  readonly pass?: 1 | 2;
  readonly cursor?: string | null;
  readonly stewardCommit?: string;
} = {}) {
  const stewardCommit = input.stewardCommit ?? 'a'.repeat(40);
  const command = buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
    command: {
      schemaVersion: 1,
      operation: 'installation-index-bootstrap',
      requestId: '11111111-2222-4333-8444-555555555555',
      requestedAt: '2026-07-28T03:01:00.000Z',
      installationId,
      expectedControlRevision: {
        stewardCommit,
        workerVersionId: env.CF_VERSION_METADATA.id,
        workerVersionTag: `steward-${stewardCommit}`,
        workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
      },
    },
    accessServiceClientId: 'bootstrap-service-client',
  });
  const request =
    await buildStewardRuntimeInstallationIndexBootstrapPageRequestV1({
      command,
      pass: input.pass ?? 1,
      cursor: input.cursor ?? null,
    });
  return new Request(
    'https://control.internal/v1/installation-index-bootstrap/page',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-steward-internal-protocol': 'installation-index-bootstrap-1',
      },
      body:
        await canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json(
          request,
        ),
    },
  );
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function repository(id: number) {
  return {
    id,
    full_name: `splrad/repository-${id}`,
    owner: {
      id: organizationId,
      login: 'splrad',
      type: 'Organization',
    },
  };
}

interface FakeOptions {
  readonly installationStatus?: number;
  readonly installationAccountId?: number;
  readonly suspendedAt?: string | null;
  readonly repositoryPages?: Readonly<Record<number, unknown>>;
  readonly repositoryListStatus?: number;
  readonly repositoryListHeaders?: Readonly<Record<string, string>>;
  readonly repositoryStatus?: number;
  readonly scopedTokenStatuses?: readonly number[];
  readonly installationTokenStatus?: number;
}

function fakeGitHub(options: FakeOptions = {}) {
  const records: {
    readonly method: string;
    readonly path: string;
    readonly search: string;
    readonly authorization: string | null;
    readonly body: unknown;
  }[] = [];
  let scopedTokenAttempt = 0;
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
      search: url.search,
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
      if (options.installationStatus !== undefined) {
        return jsonResponse(
          { message: 'Not Found' },
          options.installationStatus,
        );
      }
      return jsonResponse({
        id: installationId,
        app_id: appId,
        account: {
          id: options.installationAccountId ?? organizationId,
          login: 'splrad',
          type: 'Organization',
        },
        target_type: 'Organization',
        suspended_at: options.suspendedAt ?? null,
      });
    }
    if (
      method === 'POST'
      && url.pathname
        === `/app/installations/${installationId}/access_tokens`
    ) {
      const scoped = body !== null
        && typeof body === 'object'
        && 'repository_ids' in body;
      const tokenStatus = scoped
        ? options.scopedTokenStatuses?.[scopedTokenAttempt++]
        : options.installationTokenStatus;
      if (tokenStatus !== undefined && tokenStatus !== 201) {
        return jsonResponse({ message: 'token unavailable' }, tokenStatus);
      }
      return jsonResponse({
        token: scoped ? repositoryToken : installationToken,
        repository_selection: 'selected',
        permissions: scoped
          ? { metadata: 'read', pull_requests: 'read' }
          : { metadata: 'read' },
        ...(scoped ? { repositories: [{ id: repositoryId }] } : {}),
      }, 201);
    }
    if (
      method === 'GET'
      && url.pathname === '/installation/repositories'
    ) {
      if (options.repositoryListStatus !== undefined) {
        return jsonResponse(
          { message: 'rate limited' },
          options.repositoryListStatus,
          options.repositoryListHeaders,
        );
      }
      const page = Number(url.searchParams.get('page'));
      return jsonResponse(
        options.repositoryPages?.[page]
          ?? { total_count: 1, repositories: [repository(repositoryId)] },
      );
    }
    if (
      method === 'GET'
      && url.pathname === `/repositories/${repositoryId}`
    ) {
      if (options.repositoryStatus !== undefined) {
        return jsonResponse({ message: 'Not Found' }, options.repositoryStatus);
      }
      return jsonResponse(repository(repositoryId));
    }
    if (method === 'POST' && url.pathname === '/graphql') {
      return jsonResponse({
        data: {
          repository: {
            databaseId: repositoryId,
            nameWithOwner: `splrad/repository-${repositoryId}`,
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
      });
    }
    return jsonResponse({ message: 'unexpected endpoint' }, 500);
  }) as unknown as typeof fetch;
  return { records, fetcher };
}

function handler(github: ReturnType<typeof fakeGitHub>) {
  return createControlRuntimeHandler({
    fetch: github.fetcher,
    appToken: vi.fn(async () => 'test-app-jwt'),
  });
}

async function repositoryV3Request() {
  const child = await buildStewardRuntimeInstallationRepositoryChildV1({
    root,
    installationId,
    repositoryId,
    installationGeneration: 7,
  });
  const input = await buildStewardRuntimeRepositoryFanoutPageRequestV3({
    binding: {
      installationChild: child,
      generation: 3,
      pass: 1,
      cursor: null,
    },
  });
  return {
    child,
    request: new Request(
      'https://control.internal/v3/repository-fanout/page',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-steward-internal-protocol': 'repository-fanout-3',
        },
        body: await canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json(
          input,
        ),
      },
    ),
  };
}

describe('Control installation fan-out page handler', () => {
  it('uses an installation token and returns two strictly bounded pages', async () => {
    const firstIds = Array.from({ length: 100 }, (_, index) => index + 1);
    const github = fakeGitHub({
      repositoryPages: {
        1: {
          total_count: 101,
          repositories: firstIds.map(repository),
        },
        2: {
          total_count: 101,
          repositories: [repository(101)],
        },
      },
    });
    const runtime = handler(github);

    const firstResponse = await runtime.fetch(installationRequest(), env);
    expect(firstResponse.status).toBe(200);
    const first = parseStewardRuntimeInstallationFanoutPageReceiptV1(
      await firstResponse.json(),
    );
    expect(first.page).toEqual({
      totalCount: 101,
      repositoryIds: firstIds,
      hasNextPage: true,
      endCursor: '2',
    });
    expect(first.controlRevision.stewardCommit).toBe('a'.repeat(40));

    const secondResponse = await runtime.fetch(installationRequest('2'), env);
    expect(secondResponse.status).toBe(200);
    expect(parseStewardRuntimeInstallationFanoutPageReceiptV1(
      await secondResponse.json(),
    ).page).toEqual({
      totalCount: 101,
      repositoryIds: [101],
      hasNextPage: false,
      endCursor: null,
    });
    const tokenRequest = github.records.find(
      (entry) =>
        entry.method === 'POST' && entry.path.endsWith('/access_tokens'),
    );
    expect(tokenRequest?.body).toEqual({
      permissions: { metadata: 'read' },
    });
    expect(github.records.find(
      (entry) => entry.path === '/installation/repositories',
    )?.authorization).toBe(`Bearer ${installationToken}`);
  });

  it('authoritatively enumerates live inventory for an installation repository delta', async () => {
    const deltaRoot = {
      installationId,
      deliveryId: 'installation-repositories-removed-live-refresh',
      scopeWorkItem: {
        schemaVersion: 2,
        operation: 'scope-reconcile',
        target: {
          scope: 'repository-set',
          mode: 'refresh',
          installationId,
          repositoryIds: [repositoryId],
          pullRequests: 'all-open',
        },
        cause: {
          kind: 'github-webhook',
          deliveryId: 'installation-repositories-removed-live-refresh',
          event: 'installation_repositories',
          action: 'removed',
          ref: null,
          receivedAt: '2026-07-28T03:04:05.678Z',
        },
      },
    } as const;
    const input = buildStewardRuntimeInstallationFanoutPageRequestV1({
      binding: {
        root: deltaRoot,
        generation: 8,
        pass: 1,
        cursor: null,
      },
    });
    const github = fakeGitHub();
    const response = await handler(github).fetch(new Request(
      'https://control.internal/v1/installation-fanout/page',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-steward-internal-protocol': 'installation-fanout-1',
        },
        body:
          canonicalStewardRuntimeInstallationFanoutPageRequestV1Json(input),
      },
    ), env);
    expect(response.status).toBe(200);
    expect(parseStewardRuntimeInstallationFanoutPageReceiptV1(
      JSON.parse(await response.text()),
    )).toMatchObject({
      binding: { root: deltaRoot },
      installation: { state: 'live', id: installationId },
      page: { repositoryIds: [repositoryId] },
    });
  });

  it.each([
    ['suspended', { suspendedAt: '2026-07-28T03:05:00Z' }],
    ['absent', { installationStatus: 404 }],
  ] as const)('returns an explicit %s terminal fact', async (state, options) => {
    const github = fakeGitHub(options);
    const response = await handler(github).fetch(installationRequest(), env);
    expect(response.status).toBe(200);
    expect(parseStewardRuntimeInstallationFanoutPageReceiptV1(
      await response.json(),
    )).toMatchObject({
      installation: { state, id: installationId },
      page: {
        totalCount: 0,
        repositoryIds: [],
        hasNextPage: false,
        endCursor: null,
      },
    });
    expect(github.records.some(
      (entry) => entry.path.endsWith('/access_tokens'),
    )).toBe(false);
    expect(github.records.some(
      (entry) => entry.path === '/installation/repositories',
    )).toBe(false);
  });

  it('fails closed on identity, rate-limit, malformed page, and revision errors', async () => {
    const identity = fakeGitHub({
      installationAccountId: organizationId + 1,
    });
    expect((await handler(identity).fetch(installationRequest(), env)).status)
      .toBe(403);

    const limited = fakeGitHub({
      repositoryListStatus: 429,
      repositoryListHeaders: { 'retry-after': '37' },
    });
    const limitedResponse =
      await handler(limited).fetch(installationRequest(), env);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('37');

    const malformed = fakeGitHub({
      repositoryPages: {
        1: {
          total_count: 2,
          repositories: [repository(repositoryId)],
        },
      },
    });
    expect((await handler(malformed).fetch(installationRequest(), env)).status)
      .toBe(503);

    const invalidRevisionEnv = {
      ...env,
      CF_VERSION_METADATA: {
        ...env.CF_VERSION_METADATA,
        tag: 'unbound',
      },
    };
    const revision = fakeGitHub();
    expect(
      (await handler(revision).fetch(installationRequest(), invalidRevisionEnv))
        .status,
    ).toBe(503);
    expect(revision.records).toHaveLength(0);
  });
});

describe('Control installation index bootstrap page handler', () => {
  it('uses the independent strict binding and returns live inventory', async () => {
    const github = fakeGitHub({
      repositoryPages: {
        1: {
          total_count: 1,
          repositories: [repository(repositoryId)],
        },
      },
    });
    const response = await handler(github).fetch(
      await installationBootstrapRequest(),
      env,
    );
    expect(response.status).toBe(200);
    const receipt =
      await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
        await response.json(),
      );
    expect(receipt).toMatchObject({
      phase: 'enumerated-index-page',
      installation: { state: 'live', id: installationId },
      page: {
        totalCount: 1,
        repositoryIds: [repositoryId],
        hasNextPage: false,
      },
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: env.CF_VERSION_METADATA.id,
        workerVersionTag: env.CF_VERSION_METADATA.tag,
        workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
      },
    });
    expect(receipt.binding.command).not.toHaveProperty('cause');
  });

  it.each([
    ['suspended', { suspendedAt: '2026-07-28T03:00:00.000Z' }],
    ['absent', { installationStatus: 404 }],
  ] as const)('returns a terminal %s receipt without listing repositories', async (
    expectedState,
    options,
  ) => {
    const github = fakeGitHub(options);
    const response = await handler(github).fetch(
      await installationBootstrapRequest(),
      env,
    );
    expect(response.status).toBe(200);
    const receipt =
      await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
        await response.json(),
      );
    expect(receipt.installation.state).toBe(expectedState);
    expect(receipt.page).toEqual({
      totalCount: 0,
      repositoryIds: [],
      hasNextPage: false,
      endCursor: null,
    });
    expect(github.records.some(
      (entry) => entry.path === '/installation/repositories',
    )).toBe(false);
  });

  it('rejects an expected Control revision mismatch before GitHub access', async () => {
    const github = fakeGitHub();
    const response = await handler(github).fetch(
      await installationBootstrapRequest({
        stewardCommit: 'b'.repeat(40),
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(github.records).toEqual([]);
  });
});

describe('Control repository fan-out v3 installation-child handler', () => {
  it('uses the committed child repository ID without inventing a Scope V2 cause', async () => {
    const { child, request } = await repositoryV3Request();
    const github = fakeGitHub();
    const response = await handler(github).fetch(request, env);
    expect(response.status).toBe(200);
    expect(await parseStewardRuntimeRepositoryFanoutPageReceiptV3(
      await response.json(),
    )).toMatchObject({
      binding: { installationChild: child },
      repository: {
        state: 'live',
        id: repositoryId,
        fullName: `splrad/repository-${repositoryId}`,
      },
      page: {
        totalCount: 2,
        pullRequestNumbers: [130, 131],
        hasNextPage: false,
        endCursor: null,
      },
    });
    expect(github.records.find(
      (entry) => entry.path === `/repositories/${repositoryId}`,
    )?.authorization).toBe(`Bearer ${repositoryToken}`);
  });

  it('rejects a tampered installation child before any GitHub read', async () => {
    const { request } = await repositoryV3Request();
    const value = JSON.parse(await request.text()) as {
      binding: {
        installationChild: { installationId: number };
      };
    };
    value.binding.installationChild.installationId += 1;
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(value),
    });
    const github = fakeGitHub();
    const response = await handler(github).fetch(tampered, env);
    expect(response.status).toBe(400);
    expect(github.records).toHaveLength(0);
  });

  it('proves a removed repository absent only through installation-wide metadata 404', async () => {
    const github = fakeGitHub({
      scopedTokenStatuses: [422],
      repositoryStatus: 404,
    });
    const { request } = await repositoryV3Request();
    const response = await handler(github).fetch(request, env);
    expect(response.status).toBe(200);
    expect(await parseStewardRuntimeRepositoryFanoutPageReceiptV3(
      await response.json(),
    )).toMatchObject({
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
    const tokenBodies = github.records
      .filter((entry) => entry.path.endsWith('/access_tokens'))
      .map((entry) => entry.body);
    expect(tokenBodies).toEqual([
      {
        repository_ids: [repositoryId],
        permissions: { metadata: 'read', pull_requests: 'read' },
      },
      { permissions: { metadata: 'read' } },
    ]);
    expect(github.records.find(
      (entry) => entry.path === `/repositories/${repositoryId}`,
    )?.authorization).toBe(`Bearer ${installationToken}`);
    expect(github.records.some((entry) => entry.path === '/graphql'))
      .toBe(false);
  });

  it('treats a stale removed event as live only after reacquiring the scoped PR token', async () => {
    const github = fakeGitHub({
      scopedTokenStatuses: [422, 201],
    });
    const { request } = await repositoryV3Request();
    const response = await handler(github).fetch(request, env);
    expect(response.status).toBe(200);
    expect(await parseStewardRuntimeRepositoryFanoutPageReceiptV3(
      await response.json(),
    )).toMatchObject({
      repository: { state: 'live', id: repositoryId },
      page: { pullRequestNumbers: [130, 131] },
    });
    expect(
      github.records.filter(
        (entry) => entry.path.endsWith('/access_tokens'),
      ).map((entry) => entry.body),
    ).toEqual([
      {
        repository_ids: [repositoryId],
        permissions: { metadata: 'read', pull_requests: 'read' },
      },
      { permissions: { metadata: 'read' } },
      {
        repository_ids: [repositoryId],
        permissions: { metadata: 'read', pull_requests: 'read' },
      },
    ]);
    expect(github.records.find((entry) => entry.path === '/graphql')
      ?.authorization).toBe(`Bearer ${repositoryToken}`);
  });

  it.each([
    ['installation token 401', {
      scopedTokenStatuses: [422],
      installationTokenStatus: 401,
    }],
    ['installation-scope exact lookup 422', {
      scopedTokenStatuses: [422],
      repositoryStatus: 422,
    }],
    ['scoped token reacquisition 422', {
      scopedTokenStatuses: [422, 422],
    }],
  ] as const)('fails closed when fallback cannot prove scope: %s', async (
    _label,
    options,
  ) => {
    const github = fakeGitHub(options);
    const { request } = await repositoryV3Request();
    const response = await handler(github).fetch(request, env);
    expect(response.status).toBe(503);
    expect(github.records.some((entry) => entry.path === '/graphql'))
      .toBe(false);
  });
});
