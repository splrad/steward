import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsControlProbe,
  canonicalStewardRuntimeDiagnosticsControlProbeJson,
} from '../packages/core/src/index.js';
import {
  createControlRuntimeHandler,
  type ControlRuntimeDependencies,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const subject = {
  repositoryId: 1_298_587_318,
  repositoryFullName: 'splrad/steward-sandbox-install-e2e',
} as const;

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-23T16:00:00.000Z',
  },
  GITHUB_APP_ID: '4243096',
  GITHUB_APP_PRIVATE_KEY: 'private-key',
  STEWARD_ORGANIZATION_ID: 302_208_797,
  STEWARD_ORGANIZATION_LOGIN: 'splrad',
};

function probe() {
  return buildStewardRuntimeDiagnosticsControlProbe({
    nonce: 'b'.repeat(64),
    subject,
    environment: 'production',
  });
}

function request(
  body = canonicalStewardRuntimeDiagnosticsControlProbeJson(probe()),
  headers: Record<string, string> = {},
  url = 'https://control.internal/v1/runtime-diagnostics',
  signal?: AbortSignal,
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
      ...headers,
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
}

function dependencies(
  options: {
    readonly installation?: Record<string, unknown>;
    readonly repository?: Record<string, unknown>;
    readonly installationStatus?: number;
    readonly tokenStatus?: number;
    readonly repositoryStatus?: number;
    readonly installationToken?: string;
  } = {},
): ControlRuntimeDependencies & {
  readonly fetchMock: ReturnType<typeof vi.fn>;
  readonly appTokenMock: ReturnType<typeof vi.fn>;
} {
  const installation = options.installation ?? {
    id: 145_952_003,
    app_id: 4_243_096,
    account: {
      id: 302_208_797,
      login: 'splrad',
      type: 'Organization',
    },
    target_type: 'Organization',
    suspended_at: null,
  };
  const repository = options.repository ?? {
    id: subject.repositoryId,
    full_name: 'splrad/steward-sandbox-install-e2e',
    owner: {
      id: 302_208_797,
      login: 'splrad',
      type: 'Organization',
    },
  };
  const installationToken = {
    token: options.installationToken
      ?? 'ghs_1234567890abcdefghijklmnopqrst',
    expires_at: '2026-07-24T03:00:00Z',
    permissions: { metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: subject.repositoryId }],
  };
  const fetchMock = vi.fn(async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    const isInstallation = url.endsWith('/installation');
    const isToken = url.endsWith('/access_tokens');
    return new Response(
      JSON.stringify(isInstallation
        ? installation
        : isToken
          ? installationToken
          : repository),
      {
        status: isInstallation
          ? options.installationStatus ?? 200
          : isToken
            ? options.tokenStatus ?? 201
            : options.repositoryStatus ?? 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  });
  const appTokenMock = vi.fn().mockResolvedValue('app-jwt');
  return {
    fetch: fetchMock as unknown as typeof fetch,
    appToken: appTokenMock,
    fetchMock,
    appTokenMock,
  };
}

describe('private Control runtime diagnostics', () => {
  it('rebinds the target through the live App installation before returning its actual revision', async () => {
    const runtime = dependencies({
      repository: {
        id: subject.repositoryId,
        full_name: 'splrad/Steward-Sandbox-Install-E2E',
        owner: {
          id: 302_208_797,
          login: 'splrad',
          type: 'Organization',
        },
      },
    });
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      transportVersion: 1,
      audience: 'steward-runtime-diagnostics',
      nonce: 'b'.repeat(64),
      subject: {
        repositoryId: subject.repositoryId,
        repositoryFullName: 'splrad/Steward-Sandbox-Install-E2E',
      },
      environment: 'production',
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: env.CF_VERSION_METADATA.id,
        workerVersionTag: env.CF_VERSION_METADATA.tag,
        workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
      },
    });
    expect(runtime.appTokenMock).toHaveBeenCalledWith(env);
    expect(runtime.fetchMock).toHaveBeenCalledTimes(3);
    expect(runtime.fetchMock.mock.calls.every(
      (call) => call[1]?.redirect === 'manual',
    )).toBe(true);
    const firstHeaders = new Headers(runtime.fetchMock.mock.calls[0]?.[1]?.headers);
    const tokenHeaders = new Headers(runtime.fetchMock.mock.calls[1]?.[1]?.headers);
    const repositoryHeaders = new Headers(runtime.fetchMock.mock.calls[2]?.[1]?.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer app-jwt');
    expect(tokenHeaders.get('authorization')).toBe('Bearer app-jwt');
    expect(tokenHeaders.get('content-type')).toBe('application/json; charset=utf-8');
    expect(runtime.fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(runtime.fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      repository_ids: [subject.repositoryId],
      permissions: { metadata: 'read' },
    });
    expect(repositoryHeaders.get('authorization'))
      .toBe('Bearer ghs_1234567890abcdefghijklmnopqrst');
    expect(firstHeaders.get('cloudflare-workers-version-overrides')).toBeNull();
  });

  it.each([
    ['repository ID mismatch', {
      repository: {
        id: subject.repositoryId + 1,
        full_name: subject.repositoryFullName,
        owner: { id: 302_208_797, login: 'splrad', type: 'Organization' },
      },
    }],
    ['installation organization mismatch', {
      installation: {
        id: 145_952_003,
        app_id: 4_243_096,
        account: { id: 302_208_798, login: 'splrad', type: 'Organization' },
        target_type: 'Organization',
        suspended_at: null,
      },
    }],
    ['suspended installation', {
      installation: {
        id: 145_952_003,
        app_id: 4_243_096,
        account: { id: 302_208_797, login: 'splrad', type: 'Organization' },
        target_type: 'Organization',
        suspended_at: '2026-07-24T00:00:00Z',
      },
    }],
  ])('fails closed for %s', async (_description, options) => {
    const response = await createControlRuntimeHandler(
      dependencies(options),
    ).fetch(request(), env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-access-denied',
    });
  });

  it('rejects a different organization before minting any App credential', async () => {
    const runtime = dependencies();
    const foreign = buildStewardRuntimeDiagnosticsControlProbe({
      nonce: 'b'.repeat(64),
      subject: {
        repositoryId: subject.repositoryId,
        repositoryFullName: 'other/steward-sandbox-install-e2e',
      },
      environment: 'production',
    });
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(canonicalStewardRuntimeDiagnosticsControlProbeJson(foreign)),
      env,
    );
    expect(response.status).toBe(403);
    expect(runtime.appTokenMock).not.toHaveBeenCalled();
    expect(runtime.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps GitHub outages unknown instead of converting them to access denial', async () => {
    const response = await createControlRuntimeHandler(
      dependencies({ installationStatus: 503 }),
    ).fetch(request(), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-scope-unavailable',
    });
  });

  it('uses a repository-not-found response as a proven access denial', async () => {
    const response = await createControlRuntimeHandler(
      dependencies({ installationStatus: 404 }),
    ).fetch(request(), env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-access-denied',
    });
  });

  it.each([
    [429, 429, 'github-rate-limited'],
    [500, 503, 'repository-scope-unavailable'],
    [401, 503, 'repository-scope-unavailable'],
    [403, 503, 'repository-scope-unavailable'],
    [422, 503, 'repository-scope-unavailable'],
  ] as const)('keeps installation-token HTTP %i distinct from repository denial', async (
    tokenStatus,
    expectedStatus,
    expectedError,
  ) => {
    const response = await createControlRuntimeHandler(
      dependencies({ tokenStatus }),
    ).fetch(request(), env);
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual({
      error: expectedError,
    });
  });

  it('propagates a bounded rate-limit signal without exposing an upstream body', async () => {
    const runtime = dependencies();
    runtime.fetchMock.mockResolvedValueOnce(new Response('sensitive upstream body', {
      status: 429,
      headers: {
        'content-type': 'text/plain',
        'retry-after': '7',
      },
    }));
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(),
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    await expect(response.json()).resolves.toEqual({
      error: 'github-rate-limited',
    });
  });

  it('treats a bare GitHub 403 as unavailable because it can be a secondary rate limit', async () => {
    const response = await createControlRuntimeHandler(
      dependencies({ installationStatus: 403 }),
    ).fetch(request(), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-scope-unavailable',
    });
  });

  it('preserves an explicit GitHub rate-limit signal', async () => {
    const runtime = dependencies();
    runtime.fetchMock.mockResolvedValueOnce(new Response('{}', {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
      },
    }));
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(),
      env,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'github-rate-limited',
    });
  });

  it('propagates caller cancellation to every bounded GitHub request', async () => {
    const runtime = dependencies();
    const cancellation = new AbortController();
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(undefined, {}, undefined, cancellation.signal),
      env,
    );
    expect(response.status).toBe(200);

    const upstreamSignals = runtime.fetchMock.mock.calls.map(
      (call) => call[1]?.signal,
    );
    expect(upstreamSignals).toHaveLength(3);
    expect(upstreamSignals.every((signal) => signal instanceof AbortSignal))
      .toBe(true);
    expect(upstreamSignals.every((signal) => !signal?.aborted)).toBe(true);
    cancellation.abort();
    expect(upstreamSignals.every((signal) => signal?.aborted)).toBe(true);
  });

  it('accepts GitHub 2026 stateless installation-token characters and preserves the token verbatim', async () => {
    const statelessToken =
      `ghs_4243096_${'a'.repeat(32)}.${'b'.repeat(64)}.${'c'.repeat(86)}`;
    const runtime = dependencies({ installationToken: statelessToken });
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(),
      env,
    );
    expect(response.status).toBe(200);
    const repositoryHeaders = new Headers(
      runtime.fetchMock.mock.calls[2]?.[1]?.headers,
    );
    expect(repositoryHeaders.get('authorization'))
      .toBe(`Bearer ${statelessToken}`);
  });

  it('requires the private marker and strict diagnostics protocol', async () => {
    const runtime = dependencies();
    expect((await createControlRuntimeHandler(runtime).fetch(
      request(undefined, { 'x-steward-internal-protocol': '0' }),
      env,
    )).status).toBe(403);
    const malformed = await createControlRuntimeHandler(runtime).fetch(
      request('{"transportVersion":1}'),
      env,
    );
    expect(malformed.status).toBe(400);
    expect(runtime.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects query variants of the private endpoint', async () => {
    const runtime = dependencies();
    const response = await createControlRuntimeHandler(runtime).fetch(
      request(
        undefined,
        {},
        'https://control.internal/v1/runtime-diagnostics?environment=production',
      ),
      env,
    );
    expect(response.status).toBe(404);
    expect(runtime.fetchMock).not.toHaveBeenCalled();
  });
});
