process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';

import {
  generateKeyPairSync,
  verify as verifySignature,
} from 'node:crypto';
import {
  controlRuntimeAppId,
  controlRuntimeAppClientId,
  controlRuntimeAppSlug,
  controlRuntimeCanonicalRepositoryFullName,
  controlRuntimeDefaultBranch,
  controlRuntimeDiagnosticsSubject,
  controlRuntimeInstallationId,
  controlRuntimeInstallationToken,
  controlRuntimeManifestBlobSha,
  controlRuntimeOrganization,
  controlRuntimePullRequestHeadSha,
  controlRuntimeVersionMetadata,
} from './workerd-tests/control-runtime-fixture.js';

const { cloudflareTest } = await import(
  '@cloudflare/vitest-pool-workers'
);
const { defineConfig } = await import('vitest/config');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

const governancePrepareToken =
  `${controlRuntimeInstallationToken}-governance-prepare`;
const governanceCheckWriteToken =
  `${controlRuntimeInstallationToken}-governance-check-write`;
const governanceCheckRecoveryToken =
  `${controlRuntimeInstallationToken}-governance-check-recovery`;
const governanceCheckRunId = 7_001;

let governanceGateCheck: Record<string, unknown> | null = null;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function parseBase64UrlJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  ) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GitHub App JWT segment must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function assertGitHubHeaders(
  request: Request,
  expectedAuthorization: string,
  hasBody: boolean,
  expectedBodyContentType = 'application/json; charset=utf-8',
): void {
  if (request.headers.get('accept') !== 'application/vnd.github+json') {
    throw new Error('Unexpected GitHub Accept header');
  }
  if (request.headers.get('authorization') !== expectedAuthorization) {
    throw new Error('Unexpected GitHub Authorization header');
  }
  if (request.headers.get('cache-control') !== 'no-store') {
    throw new Error('Unexpected GitHub Cache-Control header');
  }
  if (request.headers.get('user-agent') !== 'splrad-steward-control') {
    throw new Error('Unexpected GitHub User-Agent header');
  }
  if (request.headers.get('x-github-api-version') !== '2026-03-10') {
    throw new Error('Unexpected GitHub REST API version');
  }
  const contentType = request.headers.get('content-type');
  if (
    hasBody
      ? contentType !== expectedBodyContentType
      : contentType !== null
  ) {
    throw new Error('Unexpected GitHub Content-Type header');
  }
}

function assertOneOfInstallationTokens(
  request: Request,
  tokens: readonly string[],
  hasBody: boolean,
  expectedBodyContentType?: string,
): string {
  const authorization = request.headers.get('authorization') ?? '';
  const token = tokens.find((candidate) => (
    authorization === `Bearer ${candidate}`
  ));
  if (token === undefined) {
    throw new Error('Unexpected GitHub installation-token authorization');
  }
  assertGitHubHeaders(
    request,
    authorization,
    hasBody,
    expectedBodyContentType,
  );
  return token;
}

function assertAppAuthorization(request: Request): void {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    throw new Error('Missing GitHub App bearer token');
  }
  const token = authorization.slice('Bearer '.length);
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('GitHub App token is not a JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [
    string,
    string,
    string,
  ];
  const header = parseBase64UrlJson(encodedHeader);
  const payload = parseBase64UrlJson(encodedPayload);
  if (
    header.alg !== 'RS256'
    || header.typ !== 'JWT'
    || String(payload.iss) !== String(controlRuntimeAppId)
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > 660
  ) {
    throw new Error('Unexpected GitHub App JWT claims');
  }
  if (!verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  )) {
    throw new Error('Invalid GitHub App JWT signature');
  }
}

async function githubOutboundService(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const appPath = '/app';
  const installationPath =
    `/repos/${controlRuntimeOrganization.login}`
    + `/${controlRuntimeDiagnosticsSubject.repositoryFullName.split('/')[1]}`
    + '/installation';
  const installationByIdPath =
    `/app/installations/${controlRuntimeInstallationId}`;
  const tokenPath =
    `/app/installations/${controlRuntimeInstallationId}/access_tokens`;
  const repositoryPath =
    `/repos/${controlRuntimeOrganization.login}`
    + `/${controlRuntimeDiagnosticsSubject.repositoryFullName.split('/')[1]}`;
  const governanceRepositoryPath =
    `/repos/${controlRuntimeCanonicalRepositoryFullName}`;
  const governancePullRequestPath =
    `${governanceRepositoryPath}/pulls/6`;
  const governanceManifestPath =
    `${governanceRepositoryPath}/contents/.github/steward.json`;
  const governanceReviewsPath =
    `${governancePullRequestPath}/reviews`;

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === appPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected GitHub App method');
    }
    assertAppAuthorization(request);
    assertGitHubHeaders(
      request,
      request.headers.get('authorization') ?? '',
      false,
    );
    return jsonResponse({
      id: controlRuntimeAppId,
      client_id: controlRuntimeAppClientId,
      slug: controlRuntimeAppSlug,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === installationByIdPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected GitHub installation-by-ID method');
    }
    assertAppAuthorization(request);
    assertGitHubHeaders(
      request,
      request.headers.get('authorization') ?? '',
      false,
    );
    return jsonResponse({
      id: controlRuntimeInstallationId,
      app_id: controlRuntimeAppId,
      account: {
        id: controlRuntimeOrganization.id,
        login: controlRuntimeOrganization.login,
        type: 'Organization',
      },
      target_type: 'Organization',
      suspended_at: null,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === installationPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected GitHub installation method');
    }
    assertAppAuthorization(request);
    assertGitHubHeaders(
      request,
      request.headers.get('authorization') ?? '',
      false,
    );
    return jsonResponse({
      id: controlRuntimeInstallationId,
      app_id: controlRuntimeAppId,
      account: {
        id: controlRuntimeOrganization.id,
        login: controlRuntimeOrganization.login,
        type: 'Organization',
      },
      target_type: 'Organization',
      suspended_at: null,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === tokenPath
    && url.search === ''
  ) {
    if (request.method !== 'POST') {
      throw new Error('Unexpected GitHub installation-token method');
    }
    assertAppAuthorization(request);
    assertGitHubHeaders(
      request,
      request.headers.get('authorization') ?? '',
      true,
    );
    const body = JSON.parse(await request.text()) as {
      repository_ids?: unknown;
      permissions?: unknown;
    };
    const diagnosticPermissions = { metadata: 'read' };
    const governancePermissions = {
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
    };
    const governancePreparePermissions = {
      checks: 'read',
      issues: 'read',
      members: 'read',
      metadata: 'read',
      pull_requests: 'read',
    };
    const governanceCheckWritePermissions = {
      checks: 'write',
      members: 'read',
      metadata: 'read',
      pull_requests: 'read',
    };
    const governanceCheckRecoveryPermissions = {
      checks: 'read',
      metadata: 'read',
    };
    const permissions = JSON.stringify(body.permissions);
    const installationToken = new Map<string, string>([
      [JSON.stringify(diagnosticPermissions), controlRuntimeInstallationToken],
      [JSON.stringify(governancePermissions), controlRuntimeInstallationToken],
      [JSON.stringify(governancePreparePermissions), governancePrepareToken],
      [
        JSON.stringify(governanceCheckWritePermissions),
        governanceCheckWriteToken,
      ],
      [
        JSON.stringify(governanceCheckRecoveryPermissions),
        governanceCheckRecoveryToken,
      ],
    ]).get(permissions);
    if (
      JSON.stringify(body.repository_ids)
        !== JSON.stringify([controlRuntimeDiagnosticsSubject.repositoryId])
      || installationToken === undefined
    ) {
      throw new Error('Unexpected GitHub installation-token request body');
    }
    return jsonResponse({
      token: installationToken,
      expires_at: '2026-07-24T03:00:00Z',
      permissions: body.permissions,
      repository_selection: 'selected',
      repositories: [{ id: controlRuntimeDiagnosticsSubject.repositoryId }],
    }, 201);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname
      === `/repositories/${controlRuntimeDiagnosticsSubject.repositoryId}`
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected GitHub repository-by-ID method');
    }
    assertGitHubHeaders(
      request,
      `Bearer ${controlRuntimeInstallationToken}`,
      false,
    );
    return jsonResponse({
      id: controlRuntimeDiagnosticsSubject.repositoryId,
      full_name: controlRuntimeCanonicalRepositoryFullName,
      default_branch: controlRuntimeDefaultBranch,
      owner: {
        id: controlRuntimeOrganization.id,
        login: controlRuntimeOrganization.login,
        type: 'Organization',
      },
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === repositoryPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected GitHub repository method');
    }
    assertGitHubHeaders(
      request,
      `Bearer ${controlRuntimeInstallationToken}`,
      false,
    );
    return jsonResponse({
      id: controlRuntimeDiagnosticsSubject.repositoryId,
      full_name: controlRuntimeCanonicalRepositoryFullName,
      owner: {
        id: controlRuntimeOrganization.id,
        login: controlRuntimeOrganization.login,
        type: 'Organization',
      },
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === governanceRepositoryPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance repository method');
    }
    assertGitHubHeaders(
      request,
      `Bearer ${controlRuntimeInstallationToken}`,
      false,
    );
    return jsonResponse({
      id: controlRuntimeDiagnosticsSubject.repositoryId,
      full_name: controlRuntimeCanonicalRepositoryFullName,
      default_branch: controlRuntimeDefaultBranch,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === governancePullRequestPath
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance pull-request method');
    }
    assertGitHubHeaders(
      request,
      `Bearer ${controlRuntimeInstallationToken}`,
      false,
    );
    return jsonResponse({
      number: 6,
      state: 'open',
      title: 'chore: update dependency',
      body: '',
      user: {
        login: 'dependabot[bot]',
        type: 'Bot',
      },
      labels: [],
      base: {
        ref: controlRuntimeDefaultBranch,
        sha: 'd'.repeat(40),
      },
      head: {
        ref: 'dependabot/npm/example-1.0.0',
        sha: controlRuntimePullRequestHeadSha,
      },
      requested_reviewers: [],
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === governanceManifestPath
    && url.searchParams.get('ref') === controlRuntimeDefaultBranch
    && [...url.searchParams.keys()].length === 1
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance Manifest method');
    }
    assertGitHubHeaders(
      request,
      `Bearer ${controlRuntimeInstallationToken}`,
      false,
    );
    const manifest = {
      schemaVersion: 1,
      automation: {
        githubApp: {
          clientId: controlRuntimeAppClientId,
          slug: controlRuntimeAppSlug,
        },
        maintainers: {
          source: 'organization-team',
          teamSlug: 'maintainers',
        },
        language: 'zh-CN',
      },
      features: {
        prAutomation: false,
        classification: false,
        dcoAdvisory: false,
        governance: true,
        copilotReview: true,
        release: false,
        webhookRelay: false,
      },
    };
    return jsonResponse({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      sha: controlRuntimeManifestBlobSha,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === governanceReviewsPath
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 2
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance reviews method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken, governanceCheckWriteToken],
      false,
    );
    return jsonResponse([], 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === '/users/splrad-steward%5Bbot%5D'
    && url.search === ''
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance App bot method');
    }
    assertOneOfInstallationTokens(
      request,
      [
        governancePrepareToken,
        governanceCheckWriteToken,
        governanceCheckRecoveryToken,
      ],
      false,
    );
    return jsonResponse({
      id: 9_001,
      login: 'splrad-steward[bot]',
      type: 'Bot',
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === '/graphql'
    && url.search === ''
  ) {
    if (request.method !== 'POST') {
      throw new Error('Unexpected Governance GraphQL method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken, governanceCheckWriteToken],
      true,
      'application/json',
    );
    return jsonResponse({
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
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname
      === `${governanceRepositoryPath}/commits/${controlRuntimePullRequestHeadSha}/check-runs`
    && url.searchParams.get('filter') === 'all'
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 3
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance Checks method');
    }
    const authorization = request.headers.get('authorization');
    assertOneOfInstallationTokens(
      request,
      [
        governancePrepareToken,
        governanceCheckWriteToken,
        governanceCheckRecoveryToken,
      ],
      false,
    );
    // Every prepare starts an independent fixture scenario. Apply and
    // recovery retain state within that scenario, while shuffle/retry cannot
    // leak the prior test's Check into a new prepare.
    if (authorization === `Bearer ${governancePrepareToken}`) {
      governanceGateCheck = null;
    }
    const checkRuns = governanceGateCheck === null
      ? []
      : [governanceGateCheck];
    return jsonResponse({
      total_count: checkRuns.length,
      check_runs: checkRuns,
    }, 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === `${governanceRepositoryPath}/check-runs`
    && url.search === ''
  ) {
    if (request.method !== 'POST') {
      throw new Error('Unexpected Governance Check mutation method');
    }
    assertOneOfInstallationTokens(
      request,
      [governanceCheckWriteToken],
      true,
      'application/json',
    );
    if (governanceGateCheck !== null) {
      throw new Error('Governance Gate Check was written more than once');
    }
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const output = body.output as Record<string, unknown> | undefined;
    if (
      body.head_sha !== controlRuntimePullRequestHeadSha
      || body.name !== 'Copilot Code Review Gate'
      || body.status !== 'in_progress'
      || 'conclusion' in body
      || typeof body.external_id !== 'string'
      || body.external_id.length === 0
      || body.external_id.length > 255
      || output?.title !== '等待 Copilot 代码审查'
      || output.summary !== 'waiting-for-review'
    ) {
      throw new Error('Unexpected Governance Gate Check request body');
    }
    governanceGateCheck = {
      id: governanceCheckRunId,
      head_sha: body.head_sha,
      name: body.name,
      status: body.status,
      conclusion: null,
      external_id: body.external_id,
      details_url: body.details_url ?? null,
      app: {
        id: controlRuntimeAppId,
        slug: controlRuntimeAppSlug,
      },
      output,
    };
    return jsonResponse(governanceGateCheck, 201);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === `${governanceRepositoryPath}/issues/6/comments`
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 2
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance comments method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken],
      false,
    );
    return jsonResponse([], 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === `${governancePullRequestPath}/commits`
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 2
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance commits method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken, governanceCheckWriteToken],
      false,
    );
    return jsonResponse([{
      sha: controlRuntimePullRequestHeadSha,
      author: { login: 'dependabot[bot]', type: 'Bot' },
    }], 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === `${governancePullRequestPath}/files`
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 2
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance files method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken, governanceCheckWriteToken],
      false,
    );
    return jsonResponse([{
      filename: 'package-lock.json',
      status: 'modified',
      sha: 'f'.repeat(40),
      additions: 1,
      deletions: 1,
    }], 200);
  }

  if (
    url.origin === 'https://api.github.com'
    && url.pathname === '/orgs/splrad/teams/maintainers/members'
    && url.searchParams.get('role') === 'all'
    && url.searchParams.get('page') === '1'
    && url.searchParams.get('per_page') === '100'
    && [...url.searchParams.keys()].length === 3
  ) {
    if (request.method !== 'GET') {
      throw new Error('Unexpected Governance maintainers method');
    }
    assertOneOfInstallationTokens(
      request,
      [governancePrepareToken, governanceCheckWriteToken],
      false,
    );
    return jsonResponse([{ login: 'axiomoth' }], 200);
  }

  throw new Error(
    `Unexpected outbound request: ${request.method} ${request.url}`,
  );
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './tests/workerd/control-runtime.wrangler.jsonc',
      },
      miniflare: {
        // Miniflare's local versionMetadata plugin generates an empty tag and
        // does not accept fixture values. Supply the production binding's
        // exact JSON shape so the strict steward-<commit> contract is testable.
        bindings: {
          CF_VERSION_METADATA: controlRuntimeVersionMetadata,
          GITHUB_APP_ID: String(controlRuntimeAppId),
          GITHUB_APP_PRIVATE_KEY: privateKey,
          STEWARD_ORGANIZATION_ID: String(controlRuntimeOrganization.id),
          STEWARD_ORGANIZATION_LOGIN: controlRuntimeOrganization.login,
        },
        outboundService: githubOutboundService,
      },
    }),
  ],
  test: {
    include: ['workerd-tests/control-runtime.workerd.ts'],
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            'ajv',
            'ajv/dist/2020',
            'ajv/dist/2020.js',
            'ajv-formats',
          ],
        },
      },
    },
  },
});
