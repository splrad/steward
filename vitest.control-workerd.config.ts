process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';

import {
  generateKeyPairSync,
  verify as verifySignature,
} from 'node:crypto';
import {
  controlRuntimeAppId,
  controlRuntimeCanonicalRepositoryFullName,
  controlRuntimeDiagnosticsSubject,
  controlRuntimeInstallationId,
  controlRuntimeInstallationToken,
  controlRuntimeOrganization,
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
      ? contentType !== 'application/json; charset=utf-8'
      : contentType !== null
  ) {
    throw new Error('Unexpected GitHub Content-Type header');
  }
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
  const installationPath =
    `/repos/${controlRuntimeOrganization.login}`
    + `/${controlRuntimeDiagnosticsSubject.repositoryFullName.split('/')[1]}`
    + '/installation';
  const tokenPath =
    `/app/installations/${controlRuntimeInstallationId}/access_tokens`;
  const repositoryPath =
    `/repos/${controlRuntimeOrganization.login}`
    + `/${controlRuntimeDiagnosticsSubject.repositoryFullName.split('/')[1]}`;

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
    const body = JSON.parse(await request.text()) as unknown;
    if (
      JSON.stringify(body) !== JSON.stringify({
        repository_ids: [controlRuntimeDiagnosticsSubject.repositoryId],
        permissions: { metadata: 'read' },
      })
    ) {
      throw new Error('Unexpected GitHub installation-token request body');
    }
    return jsonResponse({
      token: controlRuntimeInstallationToken,
      expires_at: '2026-07-24T03:00:00Z',
      permissions: { metadata: 'read' },
      repository_selection: 'selected',
      repositories: [{ id: controlRuntimeDiagnosticsSubject.repositoryId }],
    }, 201);
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
  },
});
