import { createAppAuth } from '@octokit/auth-app';
import {
  buildStewardRuntimeDiagnosticsControlReceipt,
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeDiagnosticsControlReceiptJson,
  canonicalStewardRuntimeControlReceiptJson,
  parseStewardRuntimeDiagnosticsControlProbe,
  parseStewardRuntimeControlRequest,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeDiagnosticsSubjectV1,
} from '../../core/src/index.js';
import { GITHUB_CLOUD_REST_API_VERSION } from '../../github/src/index.js';

const reconcilePath = '/v1/reconcile';
const diagnosticsPath = '/v1/runtime-diagnostics';
export const maximumControlRequestBytes = 128 * 1024;
export const maximumGitHubResponseBytes = 128 * 1024;
export const controlGitHubTimeoutMs = 3_000;
const internalProtocolHeader = 'x-steward-internal-protocol';

export interface ControlRuntimeVersionMetadata {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

export interface ControlRuntimeEnv {
  readonly CF_VERSION_METADATA: ControlRuntimeVersionMetadata;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly STEWARD_ORGANIZATION_ID?: string | number;
  readonly STEWARD_ORGANIZATION_LOGIN?: string;
}

export interface ControlRuntimeHandler {
  fetch(request: Request, env: ControlRuntimeEnv): Promise<Response>;
}

export interface ControlRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly appToken: (env: ControlRuntimeEnv) => Promise<string>;
}

class RepositoryScopeError extends Error {
  constructor(
    readonly kind: 'denied' | 'rate-limited' | 'unavailable',
    readonly retryAfter?: string,
  ) {
    super('Repository scope verification failed');
    this.name = 'RepositoryScopeError';
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function contentTypeIsJson(request: Request): boolean {
  const contentType = request.headers.get('content-type');
  return contentType !== null
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumControlRequestBytes)
  ) {
    throw new Error('request-body-too-large');
  }

  if (request.body === null) {
    throw new Error('request-body-empty');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumControlRequestBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('request-body-too-large');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  return JSON.parse(text) as unknown;
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumGitHubResponseBytes)
  ) {
    throw new Error('response-body-too-large');
  }
  if (response.body === null) throw new Error('response-body-empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumGitHubResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response-body-too-large');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(body),
  ) as unknown;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function validInstallationToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 20
    && value.length <= 4_096
    // Supports both the legacy opaque ghs_ token and GitHub's 2026
    // stateless ghs_APPID_JWT format without admitting header whitespace.
    && /^ghs_[A-Za-z0-9._-]+$/.test(value);
}

function expectedOrganization(env: ControlRuntimeEnv): {
  readonly id: number;
  readonly login: string;
} {
  const id = typeof env.STEWARD_ORGANIZATION_ID === 'number'
    ? env.STEWARD_ORGANIZATION_ID
    : Number(env.STEWARD_ORGANIZATION_ID);
  const login = env.STEWARD_ORGANIZATION_LOGIN ?? '';
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)
  ) {
    throw new RepositoryScopeError('unavailable');
  }
  return { id, login };
}

function githubHeaders(token: string, hasBody = false): Headers {
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'cache-control': 'no-store',
    'user-agent': 'splrad-steward-control',
    'x-github-api-version': GITHUB_CLOUD_REST_API_VERSION,
  });
  if (hasBody) headers.set('content-type', 'application/json; charset=utf-8');
  return headers;
}

function classifyGitHubFailure(response: Response): RepositoryScopeError {
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  if (
    response.status === 429
    || (response.status === 403
      && (retryAfter !== undefined
        || response.headers.get('x-ratelimit-remaining') === '0'))
  ) {
    return new RepositoryScopeError('rate-limited', retryAfter);
  }
  // A 404 is the only response that proves the App installation or its
  // repository-scoped token cannot see the requested repository. GitHub can
  // use a bare 403 for secondary rate limits, while 401/422 can describe
  // credential or request-service failures. Preserve those ambiguous cases as
  // unavailable instead of manufacturing an access-denial fact.
  if (response.status === 404) {
    return new RepositoryScopeError('denied');
  }
  return new RepositoryScopeError('unavailable');
}

function boundedSignal(
  parentSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(controlGitHubTimeoutMs);
  return parentSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([parentSignal, timeoutSignal]);
}

async function githubJson(
  dependencies: ControlRuntimeDependencies,
  url: string,
  token: string,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly body?: string;
    readonly expectedStatus?: number;
    readonly parentSignal?: AbortSignal;
  } = {},
): Promise<unknown> {
  let response: Response;
  try {
    const method = options.method ?? 'GET';
    response = await dependencies.fetch(url, {
      method,
      headers: githubHeaders(token, options.body !== undefined),
      ...(options.body === undefined ? {} : { body: options.body }),
      // Cloudflare Workers does not implement redirect:"error". Manual mode
      // keeps 3xx responses observable so classifyGitHubFailure fails closed.
      redirect: 'manual',
      signal: boundedSignal(options.parentSignal),
    });
  } catch {
    throw new RepositoryScopeError('unavailable');
  }
  if (
    options.expectedStatus === undefined
      ? !response.ok
      : response.status !== options.expectedStatus
  ) {
    throw classifyGitHubFailure(response);
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    throw new RepositoryScopeError('unavailable');
  }
  try {
    return await readBoundedResponseJson(response);
  } catch {
    throw new RepositoryScopeError('unavailable');
  }
}

async function createAppToken(env: ControlRuntimeEnv): Promise<string> {
  const result = await createAppAuth({
    appId: env.GITHUB_APP_ID ?? '',
    privateKey: env.GITHUB_APP_PRIVATE_KEY ?? '',
  })({ type: 'app' });
  return result.token;
}

async function createRepositoryInstallationToken(
  dependencies: ControlRuntimeDependencies,
  appToken: string,
  installationId: number,
  repositoryId: number,
  parentSignal?: AbortSignal,
): Promise<string> {
  const result = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    appToken,
    {
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { metadata: 'read' },
      }),
      expectedStatus: 201,
      ...(parentSignal === undefined ? {} : { parentSignal }),
    },
  ));
  const permissions = plainRecord(result?.permissions);
  const repositories = result?.repositories;
  const repository = Array.isArray(repositories) && repositories.length === 1
    ? plainRecord(repositories[0])
    : null;
  const token = result?.token;
  if (
    result === null
    || !validInstallationToken(token)
    || result.repository_selection !== 'selected'
    || permissions === null
    || Reflect.ownKeys(permissions).length !== 1
    || permissions.metadata !== 'read'
    || repository === null
    || positiveSafeInteger(repository.id) !== repositoryId
  ) {
    throw new RepositoryScopeError('unavailable');
  }
  return token;
}

const defaultDependencies: ControlRuntimeDependencies = {
  fetch: (input, init) => fetch(input, init),
  appToken: createAppToken,
};

export async function verifyDiagnosticsRepositoryScope(
  env: ControlRuntimeEnv,
  subject: StewardRuntimeDiagnosticsSubjectV1,
  dependencies: ControlRuntimeDependencies = defaultDependencies,
  parentSignal?: AbortSignal,
): Promise<StewardRuntimeDiagnosticsSubjectV1> {
  const organization = expectedOrganization(env);
  const [owner, repository] = subject.repositoryFullName.split('/') as [string, string];
  if (owner.toLowerCase() !== organization.login.toLowerCase()) {
    throw new RepositoryScopeError('denied');
  }
  const appId = positiveSafeInteger(Number(env.GITHUB_APP_ID));
  if (appId === null || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new RepositoryScopeError('unavailable');
  }

  let appToken: string;
  try {
    appToken = await dependencies.appToken(env);
  } catch {
    throw new RepositoryScopeError('unavailable');
  }
  const installation = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
    appToken,
    parentSignal === undefined ? {} : { parentSignal },
  ));
  const account = plainRecord(installation?.account);
  const installationId = positiveSafeInteger(installation?.id);
  if (
    installation === null
    || account === null
    || installationId === null
    || positiveSafeInteger(installation.app_id) !== appId
    || positiveSafeInteger(account.id) !== organization.id
    || String(account.login ?? '').toLowerCase() !== organization.login.toLowerCase()
    || account.type !== 'Organization'
    || installation.target_type !== 'Organization'
    || installation.suspended_at !== null
  ) {
    throw new RepositoryScopeError('denied');
  }

  let installationToken: string;
  try {
    installationToken = await createRepositoryInstallationToken(
      dependencies,
      appToken,
      installationId,
      subject.repositoryId,
      parentSignal,
    );
  } catch (error) {
    if (error instanceof RepositoryScopeError) throw error;
    throw new RepositoryScopeError('unavailable');
  }
  const resolved = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    installationToken,
    parentSignal === undefined ? {} : { parentSignal },
  ));
  const resolvedOwner = plainRecord(resolved?.owner);
  const canonicalFullName = typeof resolved?.full_name === 'string'
    ? resolved.full_name
    : '';
  if (
    resolved === null
    || resolvedOwner === null
    || positiveSafeInteger(resolved.id) !== subject.repositoryId
    || canonicalFullName.toLowerCase() !== subject.repositoryFullName.toLowerCase()
    || positiveSafeInteger(resolvedOwner.id) !== organization.id
    || String(resolvedOwner.login ?? '').toLowerCase() !== organization.login.toLowerCase()
    || resolvedOwner.type !== 'Organization'
  ) {
    throw new RepositoryScopeError('denied');
  }
  return {
    repositoryId: subject.repositoryId,
    repositoryFullName: canonicalFullName,
  };
}

function controlRevision(
  env: ControlRuntimeEnv,
): StewardRuntimeControlRevisionV1 {
  const tagMatch = /^steward-([0-9a-f]{40})$/.exec(
    env.CF_VERSION_METADATA.tag,
  );
  if (tagMatch === null) {
    throw new Error('control-runtime-version-tag-unbound');
  }
  return {
    stewardCommit: tagMatch[1] ?? '',
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag,
    workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
  };
}

export function createControlRuntimeHandler(
  dependencies: ControlRuntimeDependencies = defaultDependencies,
): ControlRuntimeHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (
        (url.pathname !== reconcilePath && url.pathname !== diagnosticsPath)
        || url.search !== ''
        || request.method !== 'POST'
      ) {
        return new Response('Not Found', { status: 404 });
      }
      if (request.headers.get(internalProtocolHeader) !== '1') {
        return jsonResponse(403, { error: 'internal-protocol-required' });
      }
      if (!contentTypeIsJson(request)) {
        return jsonResponse(415, { error: 'application-json-required' });
      }

      let parsed: unknown;
      try {
        parsed = await readBoundedJson(request);
      } catch (error) {
        const status = error instanceof Error && error.message === 'request-body-too-large'
          ? 413
          : 400;
        return jsonResponse(status, { error: status === 413 ? 'request-too-large' : 'invalid-json' });
      }

      if (url.pathname === diagnosticsPath) {
        let probe;
        try {
          probe = parseStewardRuntimeDiagnosticsControlProbe(parsed);
        } catch {
          return jsonResponse(400, { error: 'invalid-diagnostics-probe' });
        }
        let subject: StewardRuntimeDiagnosticsSubjectV1;
        try {
          subject = await verifyDiagnosticsRepositoryScope(
            env,
            probe.subject,
            dependencies,
            request.signal,
          );
        } catch (error) {
          if (error instanceof RepositoryScopeError) {
            if (error.kind === 'denied') {
              return jsonResponse(403, { error: 'repository-access-denied' });
            }
            if (error.kind === 'rate-limited') {
              const response = jsonResponse(429, { error: 'github-rate-limited' });
              if (error.retryAfter) response.headers.set('retry-after', error.retryAfter);
              return response;
            }
          }
          return jsonResponse(503, { error: 'repository-scope-unavailable' });
        }
        try {
          const receipt = buildStewardRuntimeDiagnosticsControlReceipt({
            nonce: probe.nonce,
            subject,
            environment: probe.environment,
            controlRevision: controlRevision(env),
          });
          return new Response(
            canonicalStewardRuntimeDiagnosticsControlReceiptJson(receipt),
            {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            },
          );
        } catch {
          return jsonResponse(503, { error: 'control-revision-unavailable' });
        }
      }

      let input;
      try {
        input = parseStewardRuntimeControlRequest(parsed);
      } catch {
        return jsonResponse(400, { error: 'invalid-control-request' });
      }

      // The first runtime slice intentionally proves transport and coordination
      // without acknowledging any real governance operation as complete.
      if (
        input.workItem.operation !== 'runtime-probe'
        || input.workItem.cause.kind !== 'internal-probe'
      ) {
        return jsonResponse(501, { error: 'control-operation-not-implemented' });
      }

      try {
        const receipt = buildStewardRuntimeControlReceipt({
          subject: input.workItem.subject,
          deliveryId: input.workItem.cause.deliveryId,
          generation: input.generation,
          controlRevision: controlRevision(env),
        });
        return new Response(canonicalStewardRuntimeControlReceiptJson(receipt), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      } catch {
        return jsonResponse(503, { error: 'control-revision-unavailable' });
      }
    },
  };
}

export default createControlRuntimeHandler();
