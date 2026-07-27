import { createAppAuth } from '@octokit/auth-app';
import {
  buildStewardRuntimeControlMutationReceiptV2,
  buildStewardRuntimeControlPreparedReceiptV2,
  buildStewardRuntimeControlRecoveryReceiptV2,
  canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json,
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  buildStewardRuntimeDiagnosticsControlReceipt,
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeControlMutationReceiptV2Json,
  canonicalStewardRuntimeControlPreparedReceiptV2Json,
  canonicalStewardRuntimeControlRecoveryReceiptV2Json,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json,
  canonicalStewardRuntimeDiagnosticsControlReceiptJson,
  canonicalStewardRuntimeControlReceiptJson,
  parseStewardRuntimeControlApplyNextRequestV2,
  parseStewardRuntimeDiagnosticsControlProbe,
  parseStewardRuntimeControlPrepareRequestV2,
  parseStewardRuntimeControlRecoverRequestV2,
  parseStewardRuntimeControlRequest,
  parseStewardRuntimeDeliveryRecoveryPageRequestV1,
  parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  parseStewardRuntimeRepositoryFanoutPageRequestV1,
  type StewardRuntimeDeliveryRecoveryPageRequestV1,
  type StewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  type StewardRuntimeControlApplyNextRequestV2,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlMutationResultV2,
  type StewardRuntimeControlPlanBindingV2,
  type StewardRuntimeControlPrepareRequestV2,
  type StewardRuntimeControlRecoveryResultV2,
  type StewardRuntimeControlRecoverRequestV2,
  type StewardRuntimeControlResolvedContextV2,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeDiagnosticsSubjectV1,
  type StewardRuntimeRepositoryFanoutPageRequestV1,
  type StewardRuntimeScopeWorkItemV1,
} from '../../core/src/index.js';
import {
  canonicalControlJson,
  ControlPullRequestHeadMismatchError,
  ControlPullRequestStateMismatchError,
  controlJsonDigest,
  inspectGovernanceCopilotGateMutation,
  inspectGovernanceCopilotReviewMutation,
  inspectGovernanceCopilotReviewRecovery,
  parseCanonicalControlPlanJson,
  planGovernanceCopilotGate,
  recoverGovernanceCopilotGateMutation,
  resolvePullRequestControlContext,
  type ControlPlan,
  type ControlRuntimeIdentity,
  type GovernanceCopilotGateFacts,
} from '../../control/src/index.js';
import {
  GITHUB_CLOUD_REST_API_VERSION,
  GitHubAppWebhookDeliveryControlRevisionMismatchError,
  GitHubApiError,
  GitHubRepositoryClient,
  classifyGitHubAppWebhookDeliveryError,
  createGitHubAppWebhookDeliveriesClient,
  createGitHubRestTransport,
} from '../../github/src/index.js';
import { encodeBase64Utf8 } from '../../manifest/src/encoding.js';

const reconcilePathV1 = '/v1/reconcile';
const reconcilePathV2 = '/v2/reconcile';
const repositoryFanoutPathV1 = '/v1/repository-fanout/page';
const diagnosticsPath = '/v1/runtime-diagnostics';
const deliveryRecoveryPagePath =
  '/v1/delivery-recovery/github/page';
const deliveryRecoveryRedeliveryPath =
  '/v1/delivery-recovery/github/redeliver';
export const maximumControlRequestBytes = 128 * 1024;
export const maximumGitHubResponseBytes = 128 * 1024;
export const controlGitHubTimeoutMs = 3_000;
export const recoveryControlCapabilityFreshnessMs = 60_000;
const internalProtocolHeader = 'x-steward-internal-protocol';
const recoveryCapabilityTimestampHeader =
  'x-steward-recovery-capability-timestamp';
const recoveryCapabilityNonceHeader =
  'x-steward-recovery-capability-nonce';
const recoveryCapabilitySignatureHeader =
  'x-steward-recovery-capability-signature';
const recoveryCapabilityContext = 'steward-recovery-control-v1';
const canonicalCapabilityTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const recoveryCapabilityNoncePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recoveryCapabilitySignaturePattern = /^[0-9a-f]{64}$/;
const recoveryControlSecretPattern = /^[\x21-\x7e]{32,512}$/;

export interface ControlRuntimeVersionMetadata {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

export interface ControlRuntimeEnv {
  readonly CF_VERSION_METADATA: ControlRuntimeVersionMetadata;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly COPILOT_REVIEW_REQUEST_TOKEN?: string;
  readonly RECOVERY_CONTROL_SHARED_SECRET?: string;
  readonly STEWARD_ORGANIZATION_ID?: string | number;
  readonly STEWARD_ORGANIZATION_LOGIN?: string;
}

export interface ControlRuntimeHandler {
  fetch(request: Request, env: ControlRuntimeEnv): Promise<Response>;
}

export interface ControlRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly appToken: (env: ControlRuntimeEnv) => Promise<string>;
  readonly copilotReviewToken?: (env: ControlRuntimeEnv) => string;
}

class RepositoryScopeError extends Error {
  constructor(
    readonly kind:
      | 'absent'
      | 'denied'
      | 'rate-limited'
      | 'unavailable',
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

type StewardRuntimeControlRequestV2 =
  | StewardRuntimeControlPrepareRequestV2
  | StewardRuntimeControlApplyNextRequestV2
  | StewardRuntimeControlRecoverRequestV2;

function decodedCanonicalPlanJsonV2(
  request:
    | StewardRuntimeControlApplyNextRequestV2
    | StewardRuntimeControlRecoverRequestV2,
): string {
  const binary = atob(request.plan.canonicalPlanBase64);
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  return new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
}

async function parseControlRequestV2(
  value: unknown,
): Promise<StewardRuntimeControlRequestV2> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Control v2 request must be a plain object');
  }
  const phase = (value as Record<string, unknown>).phase;
  if (phase === 'prepare') {
    return await parseStewardRuntimeControlPrepareRequestV2(value);
  }
  if (phase === 'apply-next') {
    const parsed = await parseStewardRuntimeControlApplyNextRequestV2(value);
    await parseCanonicalControlPlanJson(decodedCanonicalPlanJsonV2(parsed));
    return parsed;
  }
  if (phase === 'recover') {
    const parsed = await parseStewardRuntimeControlRecoverRequestV2(value);
    await parseCanonicalControlPlanJson(decodedCanonicalPlanJsonV2(parsed));
    return parsed;
  }
  throw new TypeError('Unsupported Control v2 phase');
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
  const body = await readBoundedResponseBytes(response);
  if (body.byteLength === 0) throw new Error('response-body-empty');
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
  // A hidden or explicit 404 is the only response that proves the requested
  // installation/repository is absent from the App-visible scope. Keep that
  // fact distinct from malformed identity responses and policy denial so only
  // repository fan-out may deliberately converge it to a tombstone. GitHub
  // can use a bare 403 for secondary rate limits, while 401/422 can describe
  // credential or request-service failures; preserve those ambiguous cases as
  // unavailable.
  if (response.status === 404) {
    return new RepositoryScopeError('absent');
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
  requestedPermissions: Readonly<Record<string, 'read' | 'write'>>,
  parentSignal?: AbortSignal,
): Promise<string> {
  const permissionsInput = Object.fromEntries(
    Object.entries(requestedPermissions).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
  const result = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    appToken,
    {
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: permissionsInput,
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
  const permissionKeys = permissions === null
    ? []
    : Object.keys(permissions).sort();
  const expectedPermissionKeys = Object.keys(permissionsInput).sort();
  if (
    result === null
    || !validInstallationToken(token)
    || result.repository_selection !== 'selected'
    || permissions === null
    || JSON.stringify(permissionKeys) !== JSON.stringify(expectedPermissionKeys)
    || expectedPermissionKeys.some((key) => permissions[key] !== permissionsInput[key])
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
  copilotReviewToken: (env) => env.COPILOT_REVIEW_REQUEST_TOKEN ?? '',
};

interface GovernanceRepositoryAccess {
  readonly client: GitHubRepositoryClient;
  readonly identity: ControlRuntimeIdentity;
  readonly repositoryFullName: string;
  readonly appToken: string;
  readonly installationId: number;
  readonly repositoryId: number;
}

interface TrustedAppInstallationAccess {
  readonly appId: number;
  readonly appToken: string;
  readonly identity: ControlRuntimeIdentity;
  readonly installationId: number;
  readonly organization: {
    readonly id: number;
    readonly login: string;
  };
}

interface RepositoryFanoutLiveAccess {
  readonly state: 'live';
  readonly client: GitHubRepositoryClient;
  readonly repositoryFullName: string;
  readonly repositoryId: number;
}

interface RepositoryFanoutAbsentAccess {
  readonly state: 'absent';
  readonly repositoryId: number;
}

type RepositoryFanoutAccess =
  | RepositoryFanoutLiveAccess
  | RepositoryFanoutAbsentAccess;

type GitHubInstallationPermissionLevel = 'read' | 'write';
type GitHubInstallationPermissions = Readonly<
  Record<string, GitHubInstallationPermissionLevel>
>;

const governanceContextReadPermissions = {
  contents: 'read',
  metadata: 'read',
  pull_requests: 'read',
} as const satisfies GitHubInstallationPermissions;

const repositoryFanoutReadPermissions = {
  metadata: 'read',
  pull_requests: 'read',
} as const satisfies GitHubInstallationPermissions;

type GovernanceGateResources = 'both' | 'check' | 'comment' | 'none';

function governanceGatePermissions(
  resources: GovernanceGateResources,
  mutationType?: ControlPlan['mutations'][number]['type'],
  needsMembers = false,
): GitHubInstallationPermissions {
  return {
    ...(resources === 'both' || resources === 'check'
      ? {
          checks: mutationType === 'copilot-gate-check.upsert'
            ? 'write' as const
            : 'read' as const,
        }
      : {}),
    ...(resources === 'both' || resources === 'comment'
      ? {
          issues:
            mutationType === 'blocking-comment.upsert'
              || mutationType === 'blocking-comment.delete'
              ? 'write' as const
              : 'read' as const,
        }
      : {}),
    ...(needsMembers ? { members: 'read' as const } : {}),
    metadata: 'read',
    pull_requests: 'read',
  };
}

function governanceGateRecoveryPermissions(
  mutationType: CopilotGateCheckMutation['type'] | BlockingCommentMutation['type'],
): GitHubInstallationPermissions {
  return mutationType === 'copilot-gate-check.upsert'
    ? { checks: 'read', metadata: 'read' }
    : { issues: 'read', metadata: 'read' };
}

const disabledGovernanceGatePermissions = {
  checks: 'read',
  issues: 'read',
  metadata: 'read',
} as const satisfies GitHubInstallationPermissions;

function disabledGovernanceGateMutationPermissions(
  mutationType: CopilotGateCheckMutation['type'] | BlockingCommentMutation['type'],
): GitHubInstallationPermissions {
  return mutationType === 'copilot-gate-check.upsert'
    ? { checks: 'write', metadata: 'read' }
    : { issues: 'write', metadata: 'read' };
}

interface CopilotReviewRequestPort {
  request(
    owner: string,
    repository: string,
    pullRequestNumber: number,
  ): Promise<void>;
}

async function readBoundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumGitHubResponseBytes)
  ) {
    throw new Error('response-body-too-large');
  }
  if (response.body === null) return new Uint8Array();
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
  return body;
}

function boundedGitHubRestFetch(
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cache-control', 'no-store');
    const signals = [
      parentSignal,
      init?.signal ?? undefined,
      AbortSignal.timeout(controlGitHubTimeoutMs),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const response = await dependencies.fetch(input, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    const bodyStreamPresent = response.body !== null;
    const bytes = await readBoundedResponseBytes(response);
    // A network 202 is not a Fetch null-body status, so its zero-byte payload
    // remains a readable empty stream. Preserve an actually missing stream as
    // null: the delivery client treats that malformed mutation result as
    // unknown rather than inventing acceptance evidence.
    return new Response(
      bodyStreamPresent ? Uint8Array.from(bytes).buffer : null,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

function validAppSlug(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(value);
}

function validAppClientId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 255
    && value === value.trim()
    && /^[\x21-\x7e]+$/.test(value);
}

async function resolveTrustedAppInstallation(
  env: ControlRuntimeEnv,
  installationId: number,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
  suspendedInstallationKind: 'denied' | 'unavailable' = 'denied',
): Promise<TrustedAppInstallationAccess> {
  const organization = expectedOrganization(env);
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
  const app = plainRecord(await githubJson(
    dependencies,
    'https://api.github.com/app',
    appToken,
    parentSignal === undefined ? {} : { parentSignal },
  ));
  const identity: ControlRuntimeIdentity = {
    appId,
    clientId: String(app?.client_id ?? ''),
    appSlug: String(app?.slug ?? '').toLowerCase(),
  };
  if (
    app === null
    || positiveSafeInteger(app.id) !== appId
    || !validAppClientId(identity.clientId)
    || !validAppSlug(identity.appSlug)
  ) {
    throw new RepositoryScopeError('unavailable');
  }

  const installation = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/app/installations/${installationId}`,
    appToken,
    parentSignal === undefined ? {} : { parentSignal },
  ));
  const account = plainRecord(installation?.account);
  if (
    installation === null
    || account === null
    || positiveSafeInteger(installation.id) !== installationId
    || positiveSafeInteger(installation.app_id) !== appId
    || positiveSafeInteger(account.id) !== organization.id
    || String(account.login ?? '').toLowerCase()
      !== organization.login.toLowerCase()
    || account.type !== 'Organization'
    || installation.target_type !== 'Organization'
  ) {
    throw new RepositoryScopeError('denied');
  }
  if (installation.suspended_at !== null) {
    // Keep the direct PR path's established denied behavior by default. A
    // repository fan-out, however, must pause and retry because suspension is
    // reversible and therefore cannot prove repository absence.
    throw new RepositoryScopeError(suspendedInstallationKind);
  }

  return {
    appId,
    appToken,
    identity,
    installationId,
    organization,
  };
}

async function resolveGovernanceRepositoryAccess(
  env: ControlRuntimeEnv,
  request:
    | StewardRuntimeControlPrepareRequestV2
    | StewardRuntimeControlApplyNextRequestV2
    | StewardRuntimeControlRecoverRequestV2,
  dependencies: ControlRuntimeDependencies,
  requestedPermissions: GitHubInstallationPermissions =
    governanceContextReadPermissions,
  parentSignal?: AbortSignal,
): Promise<GovernanceRepositoryAccess> {
  const organization = expectedOrganization(env);
  const subject = request.binding.workItem.subject;
  const [queuedOwner] = subject.repositoryFullName.split('/');
  if (queuedOwner?.toLowerCase() !== organization.login.toLowerCase()) {
    throw new RepositoryScopeError('denied');
  }
  const expectedInstallationId = request.binding.workItem.installationId;
  const trusted = await resolveTrustedAppInstallation(
    env,
    expectedInstallationId,
    dependencies,
    parentSignal,
  );

  const installationToken = await createRepositoryInstallationToken(
    dependencies,
    trusted.appToken,
    expectedInstallationId,
    subject.repositoryId,
    requestedPermissions,
    parentSignal,
  );
  const repository = plainRecord(await githubJson(
    dependencies,
    `https://api.github.com/repositories/${subject.repositoryId}`,
    installationToken,
    parentSignal === undefined ? {} : { parentSignal },
  ));
  const owner = plainRecord(repository?.owner);
  const repositoryFullName = String(repository?.full_name ?? '');
  if (
    repository === null
    || owner === null
    || positiveSafeInteger(repository.id) !== subject.repositoryId
    || positiveSafeInteger(owner.id) !== organization.id
    || String(owner.login ?? '').toLowerCase() !== organization.login.toLowerCase()
    || owner.type !== 'Organization'
    || repositoryFullName.split('/').length !== 2
    || repositoryFullName.split('/')[0]?.toLowerCase() !== organization.login.toLowerCase()
  ) {
    throw new RepositoryScopeError('denied');
  }

  return {
    identity: trusted.identity,
    repositoryFullName,
    appToken: trusted.appToken,
    installationId: expectedInstallationId,
    repositoryId: subject.repositoryId,
    client: new GitHubRepositoryClient(createGitHubRestTransport({
      token: installationToken,
      fetch: boundedGitHubRestFetch(dependencies, parentSignal),
      userAgent: 'splrad-steward-control',
    })),
  };
}

async function governanceRepositoryClient(
  access: GovernanceRepositoryAccess,
  dependencies: ControlRuntimeDependencies,
  requestedPermissions: GitHubInstallationPermissions,
  parentSignal?: AbortSignal,
): Promise<GitHubRepositoryClient> {
  const installationToken = await createRepositoryInstallationToken(
    dependencies,
    access.appToken,
    access.installationId,
    access.repositoryId,
    requestedPermissions,
    parentSignal,
  );
  return new GitHubRepositoryClient(createGitHubRestTransport({
    token: installationToken,
    fetch: boundedGitHubRestFetch(dependencies, parentSignal),
    userAgent: 'splrad-steward-control',
  }));
}

async function resolveRepositoryFanoutAccess(
  env: ControlRuntimeEnv,
  scopeWorkItem: StewardRuntimeScopeWorkItemV1,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): Promise<RepositoryFanoutAccess> {
  const subject = scopeWorkItem.target;
  let trusted: TrustedAppInstallationAccess;
  try {
    trusted = await resolveTrustedAppInstallation(
      env,
      subject.installationId,
      dependencies,
      parentSignal,
      'unavailable',
    );
  } catch (error) {
    if (error instanceof RepositoryScopeError && error.kind === 'absent') {
      return { state: 'absent', repositoryId: subject.repositoryId };
    }
    throw error;
  }

  let installationToken: string;
  try {
    installationToken = await createRepositoryInstallationToken(
      dependencies,
      trusted.appToken,
      trusted.installationId,
      subject.repositoryId,
      repositoryFanoutReadPermissions,
      parentSignal,
    );
  } catch (error) {
    if (error instanceof RepositoryScopeError && error.kind === 'absent') {
      return { state: 'absent', repositoryId: subject.repositoryId };
    }
    throw error;
  }

  let repository: Record<string, unknown> | null;
  try {
    repository = plainRecord(await githubJson(
      dependencies,
      `https://api.github.com/repositories/${subject.repositoryId}`,
      installationToken,
      parentSignal === undefined ? {} : { parentSignal },
    ));
  } catch (error) {
    if (error instanceof RepositoryScopeError && error.kind === 'absent') {
      return { state: 'absent', repositoryId: subject.repositoryId };
    }
    throw error;
  }
  const owner = plainRecord(repository?.owner);
  const repositoryFullName = String(repository?.full_name ?? '');
  const repositoryFullNameParts = repositoryFullName.split('/');
  if (
    repository === null
    || owner === null
    || positiveSafeInteger(repository.id) !== subject.repositoryId
    || positiveSafeInteger(owner.id) === null
    || repositoryFullNameParts.length !== 2
    || repositoryFullNameParts.some((part) => part.length === 0)
  ) {
    throw new RepositoryScopeError('denied');
  }
  if (
    positiveSafeInteger(owner.id) !== trusted.organization.id
    || String(owner.login ?? '').toLowerCase()
      !== trusted.organization.login.toLowerCase()
    || owner.type !== 'Organization'
    || repositoryFullNameParts[0]?.toLowerCase()
      !== trusted.organization.login.toLowerCase()
  ) {
    // A repository transfer preserves its immutable database ID. Seeing that
    // exact ID under a different owner proves only that it has left the
    // configured organization scope, so converge this scope to a tombstone.
    return { state: 'absent', repositoryId: subject.repositoryId };
  }

  return {
    state: 'live',
    repositoryId: subject.repositoryId,
    repositoryFullName,
    client: new GitHubRepositoryClient(createGitHubRestTransport({
      token: installationToken,
      fetch: boundedGitHubRestFetch(dependencies, parentSignal),
      userAgent: 'splrad-steward-control',
    })),
  };
}

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
      { metadata: 'read' },
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

function sameControlRevision(
  left: StewardRuntimeControlRevisionV1,
  right: StewardRuntimeControlRevisionV1,
): boolean {
  return left.stewardCommit === right.stewardCommit
    && left.workerVersionId === right.workerVersionId
    && left.workerVersionTag === right.workerVersionTag
    && left.workerVersionCreatedAt === right.workerVersionCreatedAt;
}

function recoveryControlCapabilityMessage(
  method: string,
  path: string,
  bodyDigest: string,
  timestamp: string,
  nonce: string,
  revision: StewardRuntimeControlRevisionV1,
): string {
  return [
    recoveryCapabilityContext,
    method,
    path,
    bodyDigest,
    timestamp,
    nonce,
    revision.stewardCommit,
    revision.workerVersionId,
    revision.workerVersionTag,
    revision.workerVersionCreatedAt,
  ].join('\n');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function recoveryControlHmacHex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  ));
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (
    !recoveryCapabilitySignaturePattern.test(left)
    || !recoveryCapabilitySignaturePattern.test(right)
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 2) {
    difference |= Number.parseInt(left.slice(index, index + 2), 16)
      ^ Number.parseInt(right.slice(index, index + 2), 16);
  }
  return difference === 0;
}

async function verifyRecoveryControlCapability(
  request: Request,
  path: string,
  canonicalBody: string,
  revision: StewardRuntimeControlRevisionV1,
  env: ControlRuntimeEnv,
  now = new Date(),
): Promise<boolean> {
  const secret = String(env.RECOVERY_CONTROL_SHARED_SECRET ?? '');
  const timestamp = request.headers.get(
    recoveryCapabilityTimestampHeader,
  ) ?? '';
  const nonce = request.headers.get(recoveryCapabilityNonceHeader) ?? '';
  const suppliedSignature = request.headers.get(
    recoveryCapabilitySignatureHeader,
  ) ?? '';
  const timestampMs = Date.parse(timestamp);
  const nowMs = now.getTime();
  if (
    !recoveryControlSecretPattern.test(secret)
    || secret !== secret.trim()
    || !canonicalCapabilityTimestampPattern.test(timestamp)
    || !Number.isSafeInteger(timestampMs)
    || new Date(timestampMs).toISOString() !== timestamp
    || !Number.isSafeInteger(nowMs)
    || Math.abs(nowMs - timestampMs) > recoveryControlCapabilityFreshnessMs
    || !recoveryCapabilityNoncePattern.test(nonce)
    || !recoveryCapabilitySignaturePattern.test(suppliedSignature)
  ) {
    return false;
  }
  const bodyDigest = await sha256Hex(canonicalBody);
  const expectedSignature = await recoveryControlHmacHex(
    secret,
    recoveryControlCapabilityMessage(
      request.method,
      path,
      bodyDigest,
      timestamp,
      nonce,
      revision,
    ),
  );
  return constantTimeHexEqual(suppliedSignature, expectedSignature);
}

function canonicalV2Response(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function enumerateRepositoryFanoutPage(
  request: StewardRuntimeRepositoryFanoutPageRequestV1,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const access = await resolveRepositoryFanoutAccess(
    env,
    request.binding.scopeWorkItem,
    dependencies,
    parentSignal,
  );
  const revision = controlRevision(env);
  if (access.state === 'absent') {
    const receipt = buildStewardRuntimeRepositoryFanoutPageReceiptV1({
      binding: request.binding,
      repository: {
        state: 'absent',
        id: access.repositoryId,
        fullName: null,
      },
      page: {
        totalCount: 0,
        pullRequestNumbers: [],
        hasNextPage: false,
        endCursor: null,
      },
      controlRevision: revision,
    });
    return canonicalV2Response(
      canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(receipt),
    );
  }

  const [owner, repository] = access.repositoryFullName.split('/') as [
    string,
    string,
  ];
  let page: Awaited<
    ReturnType<GitHubRepositoryClient['listOpenPullRequestsPage']>
  >;
  try {
    page = await access.client.listOpenPullRequestsPage(
      owner,
      repository,
      request.binding.cursor,
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.rateLimited) {
      throw new RepositoryScopeError(
        'rate-limited',
        error.retryAfterSeconds === undefined
          ? undefined
          : String(error.retryAfterSeconds),
      );
    }
    throw error;
  }
  if (
    page.repositoryId !== access.repositoryId
    || page.repositoryFullName.toLowerCase()
      !== access.repositoryFullName.toLowerCase()
  ) {
    throw new RepositoryScopeError('denied');
  }
  const receipt = buildStewardRuntimeRepositoryFanoutPageReceiptV1({
    binding: request.binding,
    repository: {
      state: 'live',
      id: page.repositoryId,
      fullName: page.repositoryFullName,
    },
    page: {
      totalCount: page.totalCount,
      pullRequestNumbers: page.pullRequestNumbers,
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    },
    controlRevision: revision,
  });
  return canonicalV2Response(
    canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(receipt),
  );
}

function splitRepositoryFullName(fullName: string): {
  readonly owner: string;
  readonly repository: string;
} {
  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra !== undefined) {
    throw new Error('invalid-live-repository-full-name');
  }
  return { owner, repository };
}

function runtimeResolvedContext(
  plan: ControlPlan,
): StewardRuntimeControlResolvedContextV2 {
  return {
    repositoryId: plan.subject.repository.id,
    repositoryFullName: `${plan.subject.repository.owner}/${plan.subject.repository.name}`,
    pullRequestNumber: plan.subject.pullRequest.number,
    headSha: plan.subject.pullRequest.headSha,
    defaultBranch: plan.subject.repository.defaultBranch,
    manifestBlobSha: plan.subject.manifest.blobSha,
    configDigest: plan.subject.manifest.configDigest,
    pullRequestDigest: plan.pullRequestDigest,
  };
}

function runtimeTerminalOutcome(
  plan: ControlPlan,
): StewardRuntimeControlPlanBindingV2['terminalOutcome'] {
  return plan.outcome.state === 'passed' || plan.outcome.state === 'failed'
    ? 'settled'
    : plan.outcome.state === 'pending'
      ? 'pending-external'
      : plan.outcome.state === 'ignored'
        ? 'ignored'
        : 'action-required';
}

async function runtimePlanBinding(
  plan: ControlPlan,
  generation: number,
): Promise<StewardRuntimeControlPlanBindingV2> {
  const canonicalPlan = canonicalControlJson(plan);
  const bytes = new TextEncoder().encode(canonicalPlan);
  const mutations: StewardRuntimeControlMutationBindingV2[] = plan.mutations.map(
    (mutation, ordinal) => ({
      ordinal,
      key: mutation.key,
      mutationType: mutation.type,
      principal: mutation.principal,
      recoveryPolicy: mutation.principal === 'human'
        ? 'live-evidence-or-action-required'
        : 'live-evidence',
      desiredDigest: mutation.desiredDigest,
    }),
  );
  return {
    contractVersion: 1,
    planId: plan.planId,
    planDigest: await controlJsonDigest(plan),
    preparedGeneration: generation,
    terminalOutcome: runtimeTerminalOutcome(plan),
    canonicalPlanByteLength: bytes.byteLength,
    canonicalPlanBase64: encodeBase64Utf8(canonicalPlan),
    mutationCount: mutations.length,
    mutations,
  };
}

function controlRoute(
  request:
    | StewardRuntimeControlPrepareRequestV2
    | StewardRuntimeControlApplyNextRequestV2,
  repositoryFullName: string,
  expectedHeadSha?: string,
) {
  const { owner, repository } = splitRepositoryFullName(repositoryFullName);
  return {
    repository: {
      id: request.binding.workItem.subject.repositoryId,
      owner,
      name: repository,
    },
    pullRequest: {
      number: request.binding.workItem.subject.pullRequestNumber,
      ...(expectedHeadSha === undefined ? {} : { expectedHeadSha }),
    },
    attemptId: `${request.binding.workItem.cause.deliveryId}:${request.binding.generation}`,
  };
}

async function readGovernanceGateFacts(
  context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>,
  client: GitHubRepositoryClient,
  resources: GovernanceGateResources,
) {
  const owner = context.subject.repository.owner;
  const repository = context.subject.repository.name;
  const pullRequestNumber = context.subject.pullRequest.number;
  const headSha = context.subject.pullRequest.headSha;
  const appBotLogin = `${context.subject.platform.appSlug}[bot]`;
  const maintainerConfiguration =
    context.manifest.manifest.automation.maintainers;
  const coreHandlersPromise = maintainerConfiguration.source
    === 'organization-team'
    ? client.listTeamMembers(owner, maintainerConfiguration.teamSlug)
    : Promise.resolve(
        maintainerConfiguration.logins.map((login) => ({ login })),
      );
  const [
    actor,
    reviews,
    threads,
    checks,
    comments,
    commits,
    files,
    coreHandlers,
  ] = await Promise.all([
    client.getUser(appBotLogin),
    client.listPullRequestReviews(owner, repository, pullRequestNumber),
    client.listReviewThreads(owner, repository, pullRequestNumber),
    resources === 'both' || resources === 'check'
      ? client.listCommitCheckRuns(owner, repository, headSha)
      : Promise.resolve([]),
    resources === 'both' || resources === 'comment'
      ? client.listIssueComments(owner, repository, pullRequestNumber)
      : Promise.resolve([]),
    client.listPullRequestCommits(owner, repository, pullRequestNumber),
    client.listPullRequestFiles(owner, repository, pullRequestNumber),
    coreHandlersPromise,
  ]);
  return {
    actor,
    reviews,
    threads,
    checks,
    comments,
    commits,
    files,
    coreHandlers: coreHandlers.map((member) => member.login),
  };
}

async function readGovernanceGateRecoveryFacts(
  plan: ControlPlan,
  mutation: CopilotGateCheckMutation | BlockingCommentMutation,
  client: GitHubRepositoryClient,
) {
  const owner = plan.subject.repository.owner;
  const repository = plan.subject.repository.name;
  const pullRequestNumber = plan.subject.pullRequest.number;
  const actorPromise = client.getUser(
    `${plan.subject.platform.appSlug}[bot]`,
  );
  const checksPromise = mutation.type === 'copilot-gate-check.upsert'
    ? client.listCommitCheckRuns(
        owner,
        repository,
        plan.subject.pullRequest.headSha,
      )
    : Promise.resolve([]);
  const commentsPromise = mutation.type === 'copilot-gate-check.upsert'
    ? Promise.resolve([])
    : client.listIssueComments(owner, repository, pullRequestNumber);
  const [actor, checks, comments] = await Promise.all([
    actorPromise,
    checksPromise,
    commentsPromise,
  ]);
  return { actor, checks, comments };
}

async function readDisabledGovernanceGateFacts(
  context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>,
  client: GitHubRepositoryClient,
) {
  const owner = context.subject.repository.owner;
  const repository = context.subject.repository.name;
  const pullRequestNumber = context.subject.pullRequest.number;
  const [actor, checks, comments] = await Promise.all([
    client.getUser(`${context.subject.platform.appSlug}[bot]`),
    client.listCommitCheckRuns(
      owner,
      repository,
      context.subject.pullRequest.headSha,
    ),
    client.listIssueComments(owner, repository, pullRequestNumber),
  ]);
  return {
    actor,
    checks,
    comments,
    commits: [],
    files: [],
    reviews: [],
    threads: [],
    coreHandlers: [],
  };
}

async function readDisabledGovernanceGateMutationFacts(
  context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>,
  mutation: CopilotGateCheckMutation | BlockingCommentMutation,
  client: GitHubRepositoryClient,
) {
  const owner = context.subject.repository.owner;
  const repository = context.subject.repository.name;
  const pullRequestNumber = context.subject.pullRequest.number;
  const [actor, checks, comments] = await Promise.all([
    client.getUser(`${context.subject.platform.appSlug}[bot]`),
    mutation.type === 'copilot-gate-check.upsert'
      ? client.listCommitCheckRuns(
          owner,
          repository,
          context.subject.pullRequest.headSha,
        )
      : Promise.resolve([]),
    mutation.type === 'copilot-gate-check.upsert'
      ? Promise.resolve([])
      : client.listIssueComments(owner, repository, pullRequestNumber),
  ]);
  return {
    actor,
    checks,
    comments,
    commits: [],
    files: [],
    reviews: [],
    threads: [],
    coreHandlers: [],
  };
}

function governanceFactsNeedMembers(
  context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>,
): boolean {
  return context.manifest.manifest.automation.maintainers.source
    === 'organization-team';
}

function boundedRetryAfter(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fallback;
  return Math.min(900, Number(value));
}

function repositoryScopeRetryAfter(error: unknown, fallback: number): number {
  if (!(error instanceof RepositoryScopeError)
    || error.kind !== 'rate-limited'
    || !/^(?:0|[1-9]\d*)$/.test(error.retryAfter ?? '')) {
    return fallback;
  }
  return boundedRetryAfter(Number(error.retryAfter), fallback);
}

function githubRateLimitRetryAfter(error: unknown): number | null {
  if (error instanceof RepositoryScopeError && error.kind === 'rate-limited') {
    return repositoryScopeRetryAfter(error, 30);
  }
  if (error instanceof GitHubApiError && error.rateLimited) {
    return boundedRetryAfter(error.retryAfterSeconds, 30);
  }
  return null;
}

function validHumanCopilotToken(value: string): boolean {
  return value.length >= 20
    && value.length <= 4_096
    && value === value.trim()
    && /^[\x21-\x7e]+$/.test(value)
    && !value.startsWith('ghs_')
    && value.split('.').length !== 3;
}

function createCopilotReviewRequestPort(
  token: string,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): CopilotReviewRequestPort {
  const client = new GitHubRepositoryClient(createGitHubRestTransport({
    token,
    fetch: boundedGitHubRestFetch(dependencies, parentSignal),
    userAgent: 'splrad-steward-control',
  }));
  return {
    async request(owner, repository, pullRequestNumber) {
      await client.requestReviewers({
        owner,
        repository,
        number: pullRequestNumber,
        reviewers: ['copilot-pull-request-reviewer[bot]'],
      });
    },
  };
}

type CopilotGateCheckMutation = Extract<
  ControlPlan['mutations'][number],
  { type: 'copilot-gate-check.upsert' }
>;
type BlockingCommentMutation = Extract<
  ControlPlan['mutations'][number],
  { type: 'blocking-comment.upsert' | 'blocking-comment.delete' }
>;

function desiredCheckResponseMatches(
  check: Awaited<ReturnType<GitHubRepositoryClient['createCheckRun']>>,
  mutation: CopilotGateCheckMutation,
  plan: ControlPlan,
): boolean {
  const input = mutation.input;
  return Number.isSafeInteger(check.id)
    && check.id > 0
    && (mutation.mode !== 'update' || check.id === mutation.checkRunId)
    && check.head_sha.toLowerCase() === plan.subject.pullRequest.headSha
    && check.name === input.name
    && check.status === input.status
    && (check.conclusion ?? null) === (input.conclusion ?? null)
    && (check.external_id ?? null) === (input.externalId ?? null)
    && check.app?.id === plan.subject.platform.appId
    && String(check.app?.slug ?? '').toLowerCase()
      === plan.subject.platform.appSlug
    && (check.details_url ?? '') === (input.detailsUrl ?? '')
    && check.output?.title === input.title
    && check.output?.summary === input.summary;
}

function desiredCommentResponseMatches(
  comment: Awaited<ReturnType<GitHubRepositoryClient['createIssueComment']>>,
  mutation: Extract<BlockingCommentMutation, {
    type: 'blocking-comment.upsert';
  }>,
  plan: ControlPlan,
): boolean {
  return Number.isSafeInteger(comment.id)
    && comment.id > 0
    && (mutation.mode !== 'update' || comment.id === mutation.commentId)
    && comment.body === mutation.body
    && mutation.body.includes(mutation.resourceMarker)
    && comment.user?.id === mutation.actorId
    && String(comment.user?.login ?? '').toLowerCase()
      === mutation.actorLogin.toLowerCase()
    && String(comment.user?.type ?? '').toLowerCase() === 'bot'
    && comment.performed_via_github_app?.id === plan.subject.platform.appId
    && String(comment.performed_via_github_app?.slug ?? '').toLowerCase()
      === plan.subject.platform.appSlug;
}

function mutationRateLimitResult(
  error: unknown,
): StewardRuntimeControlMutationResultV2 | null {
  return error instanceof GitHubApiError && error.rateLimited
    ? {
        state: 'not-attempted',
        resourceId: null,
        retryAfterSeconds: boundedRetryAfter(error.retryAfterSeconds, 30),
      }
    : null;
}

async function applyCopilotGateInstallationMutation(
  mutation: CopilotGateCheckMutation | BlockingCommentMutation,
  plan: ControlPlan,
  context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>,
  client: GitHubRepositoryClient,
): Promise<StewardRuntimeControlMutationResultV2> {
  const owner = context.subject.repository.owner;
  const repository = context.subject.repository.name;
  const pullRequestNumber = context.subject.pullRequest.number;
  try {
    if (mutation.type === 'copilot-gate-check.upsert') {
      const written = mutation.mode === 'create'
        ? await client.createCheckRun(owner, repository, mutation.input)
        : await client.updateCheckRun(
            owner,
            repository,
            mutation.checkRunId,
            mutation.input,
          );
      if (!desiredCheckResponseMatches(written, mutation, plan)) {
        return {
          state: 'unknown',
          resourceId: null,
          retryAfterSeconds: null,
        };
      }
      return {
        state: 'applied',
        resourceId: written.id,
        retryAfterSeconds: null,
      };
    }

    if (mutation.type === 'blocking-comment.upsert') {
      const written = mutation.mode === 'create'
        ? await client.createIssueComment(
            owner,
            repository,
            pullRequestNumber,
            mutation.body,
          )
        : await client.updateIssueComment(
            owner,
            repository,
            mutation.commentId,
            mutation.body,
          );
      if (!desiredCommentResponseMatches(written, mutation, plan)) {
        return {
          state: 'unknown',
          resourceId: null,
          retryAfterSeconds: null,
        };
      }
      return {
        state: 'applied',
        resourceId: written.id,
        retryAfterSeconds: null,
      };
    }

    let deleteState: 'applied' | 'converged' = 'applied';
    try {
      await client.deleteIssueComment(owner, repository, mutation.commentId);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      deleteState = 'converged';
    }
    let remaining;
    try {
      remaining = await client.getIssueComment(
        owner,
        repository,
        mutation.commentId,
      );
    } catch {
      return {
        state: 'unknown',
        resourceId: null,
        retryAfterSeconds: null,
      };
    }
    if (remaining !== null) {
      return {
        state: 'unknown',
        resourceId: null,
        retryAfterSeconds: null,
      };
    }
    return {
      state: deleteState,
      resourceId: mutation.commentId,
      retryAfterSeconds: null,
    };
  } catch (error) {
    return mutationRateLimitResult(error) ?? {
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    };
  }
}

async function prepareGovernanceV2(
  request: StewardRuntimeControlPrepareRequestV2,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): Promise<Response> {
  let revision: StewardRuntimeControlRevisionV1;
  try {
    revision = controlRevision(env);
  } catch {
    return jsonResponse(503, { error: 'control-revision-unavailable' });
  }
  let access: GovernanceRepositoryAccess;
  try {
    access = await resolveGovernanceRepositoryAccess(
      env,
      request,
      dependencies,
      governanceContextReadPermissions,
      parentSignal,
    );
  } catch (error) {
    if (error instanceof RepositoryScopeError) {
      if (error.kind === 'absent' || error.kind === 'denied') {
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
    const context = await resolvePullRequestControlContext(
      controlRoute(request, access.repositoryFullName),
      access.identity,
      access.client,
    );
    const facts = context.manifest.manifest.features.copilotReview
      ? await readGovernanceGateFacts(
          context,
          await governanceRepositoryClient(
            access,
            dependencies,
            governanceGatePermissions(
              'both',
              undefined,
              governanceFactsNeedMembers(context),
            ),
            parentSignal,
          ),
          'both',
        )
      : await readDisabledGovernanceGateFacts(
          context,
          await governanceRepositoryClient(
            access,
            dependencies,
            disabledGovernanceGatePermissions,
            parentSignal,
          ),
        );
    const decision = await planGovernanceCopilotGate(context, facts);
    const receipt = await buildStewardRuntimeControlPreparedReceiptV2({
      binding: request.binding,
      resolvedContext: runtimeResolvedContext(decision.plan),
      plan: await runtimePlanBinding(decision.plan, request.binding.generation),
      controlRevision: revision,
    });
    return canonicalV2Response(
      await canonicalStewardRuntimeControlPreparedReceiptV2Json(receipt),
    );
  } catch (error) {
    const retryAfter = githubRateLimitRetryAfter(error);
    if (retryAfter !== null) {
      const response = jsonResponse(429, { error: 'github-rate-limited' });
      response.headers.set('retry-after', String(retryAfter));
      return response;
    }
    return jsonResponse(503, { error: 'governance-prepare-unavailable' });
  }
}

async function mutationResponseV2(
  request: StewardRuntimeControlApplyNextRequestV2,
  revision: StewardRuntimeControlRevisionV1,
  result: StewardRuntimeControlMutationResultV2,
): Promise<Response> {
  const receipt = await buildStewardRuntimeControlMutationReceiptV2({
    binding: request.binding,
    resolvedContext: request.resolvedContext,
    planId: request.plan.planId,
    planDigest: request.plan.planDigest,
    mutation: request.mutation,
    result,
    controlRevision: revision,
  });
  return canonicalV2Response(
    await canonicalStewardRuntimeControlMutationReceiptV2Json(receipt),
  );
}

async function applyGovernanceV2(
  request: StewardRuntimeControlApplyNextRequestV2,
  plan: ControlPlan,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): Promise<Response> {
  let revision: StewardRuntimeControlRevisionV1;
  try {
    revision = controlRevision(env);
  } catch {
    return jsonResponse(503, { error: 'control-revision-unavailable' });
  }
  if (!sameControlRevision(revision, request.expectedControlRevision)) {
    return jsonResponse(409, { error: 'control-revision-mismatch' });
  }

  let access: GovernanceRepositoryAccess;
  try {
    access = await resolveGovernanceRepositoryAccess(
      env,
      request,
      dependencies,
      governanceContextReadPermissions,
      parentSignal,
    );
  } catch (error) {
    return await mutationResponseV2(request, revision, {
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: repositoryScopeRetryAfter(error, 30),
    });
  }

  const mutation = plan.mutations[request.mutation.ordinal];
  if (
    mutation === undefined
    || mutation.key !== request.mutation.key
    || mutation.type !== request.mutation.mutationType
  ) {
    return jsonResponse(400, { error: 'invalid-control-request' });
  }

  let context: Awaited<ReturnType<typeof resolvePullRequestControlContext>>;
  try {
    context = await resolvePullRequestControlContext(
      controlRoute(
        request,
        access.repositoryFullName,
        plan.subject.pullRequest.headSha,
      ),
      access.identity,
      access.client,
    );
  } catch (error) {
    if (
      error instanceof ControlPullRequestHeadMismatchError
      || error instanceof ControlPullRequestStateMismatchError
    ) {
      return await mutationResponseV2(request, revision, {
        state: 'stale-plan',
        resourceId: null,
        retryAfterSeconds: null,
      });
    }
    return await mutationResponseV2(request, revision, {
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: githubRateLimitRetryAfter(error) ?? 30,
    });
  }

  if (
    mutation.type === 'copilot-gate-check.upsert'
    || mutation.type === 'blocking-comment.upsert'
    || mutation.type === 'blocking-comment.delete'
  ) {
    let mutationClient: GitHubRepositoryClient;
    let inspection: Awaited<
      ReturnType<typeof inspectGovernanceCopilotGateMutation>
    >;
    try {
      const featureEnabled =
        context.manifest.manifest.features.copilotReview;
      mutationClient = await governanceRepositoryClient(
        access,
        dependencies,
        featureEnabled
          ? governanceGatePermissions(
              mutation.type === 'copilot-gate-check.upsert'
                ? 'check'
                : 'comment',
              mutation.type,
              governanceFactsNeedMembers(context),
            )
          : disabledGovernanceGateMutationPermissions(mutation.type),
        parentSignal,
      );
      const facts: GovernanceCopilotGateFacts = featureEnabled
        ? await readGovernanceGateFacts(
            context,
            mutationClient,
            mutation.type === 'copilot-gate-check.upsert'
              ? 'check'
              : 'comment',
          )
        : await readDisabledGovernanceGateMutationFacts(
            context,
            mutation,
            mutationClient,
          );
      if (mutation.type === 'blocking-comment.delete') {
        facts.targetComment = await mutationClient.getIssueComment(
          context.subject.repository.owner,
          context.subject.repository.name,
          mutation.commentId,
        );
      }
      inspection = await inspectGovernanceCopilotGateMutation(
        plan,
        mutation.key,
        context,
        facts,
      );
    } catch (error) {
      return await mutationResponseV2(request, revision, {
        state: 'not-attempted',
        resourceId: null,
        retryAfterSeconds: githubRateLimitRetryAfter(error) ?? 30,
      });
    }
    if (inspection.state !== 'ready') {
      return await mutationResponseV2(request, revision, {
        state: inspection.state,
        resourceId: inspection.state === 'converged'
          ? inspection.resourceId ?? null
          : null,
        retryAfterSeconds: null,
      });
    }
    const result = await applyCopilotGateInstallationMutation(
      mutation,
      plan,
      context,
      mutationClient,
    );
    return await mutationResponseV2(request, revision, result);
  }

  if (mutation.type !== 'copilot-review.request') {
    return jsonResponse(400, { error: 'invalid-control-request' });
  }

  try {
    const inspection = mutation.evidenceProtocol === 'review-request-v1'
      ? await inspectGovernanceCopilotReviewMutation(
          plan,
          context,
          await access.client.listPullRequestReviews(
            context.subject.repository.owner,
            context.subject.repository.name,
            context.subject.pullRequest.number,
          ),
        )
      : await inspectGovernanceCopilotGateMutation(
          plan,
          mutation.key,
          context,
          await readGovernanceGateFacts(
            context,
            await governanceRepositoryClient(
              access,
              dependencies,
              governanceGatePermissions(
                'none',
                undefined,
                governanceFactsNeedMembers(context),
              ),
              parentSignal,
            ),
            'none',
          ),
        );
    if (inspection.state !== 'ready') {
      return await mutationResponseV2(request, revision, {
        state: inspection.state,
        resourceId: null,
        retryAfterSeconds: null,
      });
    }
  } catch (error) {
    return await mutationResponseV2(request, revision, {
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: githubRateLimitRetryAfter(error) ?? 30,
    });
  }

  const humanToken = (
    dependencies.copilotReviewToken?.(env)
    ?? env.COPILOT_REVIEW_REQUEST_TOKEN
    ?? ''
  );
  if (!validHumanCopilotToken(humanToken)) {
    return await mutationResponseV2(request, revision, {
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: 300,
    });
  }
  const copilotReviewRequest = createCopilotReviewRequestPort(
    humanToken,
    dependencies,
    parentSignal,
  );
  try {
    await copilotReviewRequest.request(
      context.subject.repository.owner,
      context.subject.repository.name,
      context.subject.pullRequest.number,
    );
    return await mutationResponseV2(request, revision, {
      state: 'applied',
      resourceId: null,
      retryAfterSeconds: null,
    });
  } catch (error) {
    if (error instanceof GitHubApiError && error.rateLimited) {
      return await mutationResponseV2(request, revision, {
        state: 'not-attempted',
        resourceId: null,
        retryAfterSeconds: boundedRetryAfter(error.retryAfterSeconds, 30),
      });
    }
    return await mutationResponseV2(request, revision, {
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });
  }
}

async function recoveryResponseV2(
  request: StewardRuntimeControlRecoverRequestV2,
  revision: StewardRuntimeControlRevisionV1,
  result: StewardRuntimeControlRecoveryResultV2,
): Promise<Response> {
  const receipt = await buildStewardRuntimeControlRecoveryReceiptV2({
    binding: request.binding,
    resolvedContext: request.resolvedContext,
    planId: request.plan.planId,
    planDigest: request.plan.planDigest,
    mutation: request.mutation,
    result,
    controlRevision: revision,
  });
  return canonicalV2Response(
    await canonicalStewardRuntimeControlRecoveryReceiptV2Json(receipt),
  );
}

async function recoverGovernanceV2(
  request: StewardRuntimeControlRecoverRequestV2,
  plan: ControlPlan,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal?: AbortSignal,
): Promise<Response> {
  let revision: StewardRuntimeControlRevisionV1;
  try {
    revision = controlRevision(env);
  } catch {
    return jsonResponse(503, { error: 'control-revision-unavailable' });
  }
  if (!sameControlRevision(revision, request.expectedControlRevision)) {
    return jsonResponse(409, { error: 'control-revision-mismatch' });
  }
  let access: GovernanceRepositoryAccess;
  try {
    access = await resolveGovernanceRepositoryAccess(
      env,
      request,
      dependencies,
      governanceContextReadPermissions,
      parentSignal,
    );
  } catch {
    return await recoveryResponseV2(request, revision, {
      state: 'unknown',
      resourceId: null,
    });
  }

  const mutation = plan.mutations[request.mutation.ordinal];
  if (
    mutation === undefined
    || mutation.key !== request.mutation.key
    || mutation.type !== request.mutation.mutationType
  ) {
    return jsonResponse(400, { error: 'invalid-control-request' });
  }

  if (
    mutation.type === 'copilot-gate-check.upsert'
    || mutation.type === 'blocking-comment.upsert'
    || mutation.type === 'blocking-comment.delete'
  ) {
    try {
      const recoveryClient = await governanceRepositoryClient(
        access,
        dependencies,
        governanceGateRecoveryPermissions(mutation.type),
        parentSignal,
      );
      if (mutation.type === 'blocking-comment.delete') {
        const comment = await recoveryClient.getIssueComment(
          plan.subject.repository.owner,
          plan.subject.repository.name,
          mutation.commentId,
        );
        return await recoveryResponseV2(request, revision, comment === null
          ? {
              state: 'converged',
              resourceId: mutation.commentId,
            }
          : {
              state: 'unknown',
              resourceId: null,
            });
      }
      const facts = await readGovernanceGateRecoveryFacts(
        plan,
        mutation,
        recoveryClient,
      );
      const inspection = await recoverGovernanceCopilotGateMutation(
        plan,
        mutation.key,
        facts,
      );
      return await recoveryResponseV2(request, revision, {
        state: inspection.state,
        resourceId: inspection.state === 'converged'
          ? inspection.resourceId ?? null
          : null,
      });
    } catch {
      return await recoveryResponseV2(request, revision, {
        state: 'unknown',
        resourceId: null,
      });
    }
  }

  if (mutation.type !== 'copilot-review.request') {
    return jsonResponse(400, { error: 'invalid-control-request' });
  }
  try {
    const { owner, repository } = splitRepositoryFullName(
      access.repositoryFullName,
    );
    const [pull, reviews] = await Promise.all([
      access.client.getPullRequest(
        owner,
        repository,
        request.binding.workItem.subject.pullRequestNumber,
      ),
      access.client.listPullRequestReviews(
        owner,
        repository,
        request.binding.workItem.subject.pullRequestNumber,
      ),
    ]);
    const inspection = await inspectGovernanceCopilotReviewRecovery(
      plan,
      pull,
      reviews,
    );
    return await recoveryResponseV2(request, revision, {
      state: inspection.state,
      resourceId: null,
    });
  } catch {
    return await recoveryResponseV2(request, revision, {
      state: 'unknown',
      resourceId: null,
    });
  }
}

function canonicalDeliveryRecoveryResponse(
  status: 200 | 202,
  body: string,
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isDefiniteGitHubRedeliveryRejection(status: number): boolean {
  // These responses prove that GitHub rejected the authenticated endpoint or
  // payload. Timeout-like and uncommon 4xx responses remain unknown because
  // a POST side effect cannot be excluded merely from the status class.
  return status === 400
    || status === 401
    || status === 403
    || status === 404
    || status === 422;
}

function deliveryRecoveryFailureResponse(
  error: unknown,
  operation: 'list' | 'redeliver',
): Response {
  if (
    error instanceof GitHubAppWebhookDeliveryControlRevisionMismatchError
  ) {
    return jsonResponse(409, { error: 'control-revision-mismatch' });
  }
  const failure = classifyGitHubAppWebhookDeliveryError(error);
  if (failure?.kind === 'rate-limited') {
    const response = jsonResponse(429, { error: 'github-rate-limited' });
    if (failure.retryAfterSeconds !== null) {
      response.headers.set(
        'retry-after',
        String(failure.retryAfterSeconds),
      );
    }
    return response;
  }
  if (operation === 'redeliver') {
    if (
      failure?.kind === 'unknown'
      && failure.status !== null
      && isDefiniteGitHubRedeliveryRejection(failure.status)
    ) {
      return jsonResponse(422, {
        error: 'github-redelivery-rejected',
        providerStatus: failure.status,
      });
    }
    if (
      failure?.kind === 'unknown'
      && failure.status !== null
      && failure.status >= 500
    ) {
      return jsonResponse(503, {
        // A provider 5xx proves only that GitHub returned an error, not that
        // the POST had no side effect. Reconciliation must establish whether
        // a redelivery was created before any further mutation is attempted.
        error: 'github-redelivery-result-unknown',
        providerStatus: failure.status,
      });
    }
    return jsonResponse(503, {
      error: 'github-redelivery-result-unknown',
    });
  }
  return jsonResponse(503, { error: 'delivery-recovery-unavailable' });
}

async function listGitHubAppDeliveries(
  input: StewardRuntimeDeliveryRecoveryPageRequestV1,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal: AbortSignal,
): Promise<Response> {
  let revision: StewardRuntimeControlRevisionV1;
  try {
    revision = controlRevision(env);
  } catch {
    return jsonResponse(503, { error: 'control-revision-unavailable' });
  }
  if (!sameControlRevision(input.expectedControlRevision, revision)) {
    return jsonResponse(409, { error: 'control-revision-mismatch' });
  }
  let appJwt: string;
  try {
    appJwt = await dependencies.appToken(env);
  } catch {
    return jsonResponse(503, {
      error: 'github-delivery-control-unavailable',
    });
  }
  try {
    const client = createGitHubAppWebhookDeliveriesClient({
      appJwt,
      controlRevision: revision,
      fetch: boundedGitHubRestFetch(dependencies, parentSignal),
      apiVersion: GITHUB_CLOUD_REST_API_VERSION,
    });
    const receipt = await client.listDeliveries(input);
    return canonicalDeliveryRecoveryResponse(
      200,
      canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(receipt),
    );
  } catch (error) {
    return deliveryRecoveryFailureResponse(error, 'list');
  }
}

async function redeliverGitHubAppDelivery(
  input: StewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  env: ControlRuntimeEnv,
  dependencies: ControlRuntimeDependencies,
  parentSignal: AbortSignal,
): Promise<Response> {
  let revision: StewardRuntimeControlRevisionV1;
  try {
    revision = controlRevision(env);
  } catch {
    return jsonResponse(503, { error: 'control-revision-unavailable' });
  }
  if (!sameControlRevision(input.expectedControlRevision, revision)) {
    return jsonResponse(409, { error: 'control-revision-mismatch' });
  }
  let appJwt: string;
  try {
    appJwt = await dependencies.appToken(env);
  } catch {
    return jsonResponse(503, {
      error: 'github-redelivery-control-unavailable',
    });
  }
  let client: ReturnType<typeof createGitHubAppWebhookDeliveriesClient>;
  try {
    client = createGitHubAppWebhookDeliveriesClient({
      appJwt,
      controlRevision: revision,
      fetch: boundedGitHubRestFetch(dependencies, parentSignal),
      apiVersion: GITHUB_CLOUD_REST_API_VERSION,
    });
  } catch {
    return jsonResponse(503, {
      error: 'github-redelivery-control-unavailable',
    });
  }
  try {
    const receipt = await client.requestRedelivery(input);
    return canonicalDeliveryRecoveryResponse(
      202,
      canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(receipt),
    );
  } catch (error) {
    return deliveryRecoveryFailureResponse(error, 'redeliver');
  }
}

export function createControlRuntimeHandler(
  dependencies: ControlRuntimeDependencies = defaultDependencies,
): ControlRuntimeHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (
        (
          url.pathname !== reconcilePathV1
          && url.pathname !== reconcilePathV2
          && url.pathname !== repositoryFanoutPathV1
          && url.pathname !== diagnosticsPath
          && url.pathname !== deliveryRecoveryPagePath
          && url.pathname !== deliveryRecoveryRedeliveryPath
        )
        || url.search !== ''
        || request.method !== 'POST'
      ) {
        return new Response('Not Found', { status: 404 });
      }
      const expectedInternalProtocol = url.pathname === reconcilePathV2
        ? '2'
        : url.pathname === repositoryFanoutPathV1
          ? 'repository-fanout-1'
          : (
              url.pathname === deliveryRecoveryPagePath
              || url.pathname === deliveryRecoveryRedeliveryPath
            )
            ? 'delivery-recovery-1'
          : '1';
      if (request.headers.get(internalProtocolHeader) !== expectedInternalProtocol) {
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

      if (url.pathname === repositoryFanoutPathV1) {
        let input: StewardRuntimeRepositoryFanoutPageRequestV1;
        try {
          input = parseStewardRuntimeRepositoryFanoutPageRequestV1(parsed);
        } catch {
          return jsonResponse(400, { error: 'invalid-repository-fanout-request' });
        }
        try {
          return await enumerateRepositoryFanoutPage(
            input,
            env,
            dependencies,
            request.signal,
          );
        } catch (error) {
          if (error instanceof RepositoryScopeError) {
            if (error.kind === 'absent' || error.kind === 'denied') {
              return jsonResponse(403, { error: 'repository-access-denied' });
            }
            if (error.kind === 'rate-limited') {
              const response = jsonResponse(429, {
                error: 'github-rate-limited',
              });
              if (error.retryAfter) {
                response.headers.set('retry-after', error.retryAfter);
              }
              return response;
            }
          }
          return jsonResponse(503, {
            error: 'repository-fanout-unavailable',
          });
        }
      }

      if (url.pathname === deliveryRecoveryPagePath) {
        let input: StewardRuntimeDeliveryRecoveryPageRequestV1;
        try {
          input = parseStewardRuntimeDeliveryRecoveryPageRequestV1(parsed);
        } catch {
          return jsonResponse(400, {
            error: 'invalid-delivery-recovery-request',
          });
        }
        let authorized = false;
        try {
          authorized = await verifyRecoveryControlCapability(
            request,
            deliveryRecoveryPagePath,
            canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(input),
            input.expectedControlRevision,
            env,
          );
        } catch {
          authorized = false;
        }
        if (!authorized) {
          return jsonResponse(403, {
            error: 'recovery-control-capability-required',
          });
        }
        return await listGitHubAppDeliveries(
          input,
          env,
          dependencies,
          request.signal,
        );
      }

      if (url.pathname === deliveryRecoveryRedeliveryPath) {
        let input: StewardRuntimeDeliveryRecoveryRedeliveryRequestV1;
        try {
          input =
            parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(parsed);
        } catch {
          return jsonResponse(400, {
            error: 'invalid-delivery-recovery-request',
          });
        }
        let authorized = false;
        try {
          authorized = await verifyRecoveryControlCapability(
            request,
            deliveryRecoveryRedeliveryPath,
            canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(
              input,
            ),
            input.expectedControlRevision,
            env,
          );
        } catch {
          authorized = false;
        }
        if (!authorized) {
          return jsonResponse(403, {
            error: 'recovery-control-capability-required',
          });
        }
        return await redeliverGitHubAppDelivery(
          input,
          env,
          dependencies,
          request.signal,
        );
      }

      if (url.pathname === reconcilePathV2) {
        let input: StewardRuntimeControlRequestV2;
        try {
          input = await parseControlRequestV2(parsed);
        } catch {
          return jsonResponse(400, { error: 'invalid-control-request' });
        }

        if (input.binding.objective !== 'governance') {
          return jsonResponse(501, {
            error: 'control-operation-not-implemented',
          });
        }

        try {
          if (input.phase === 'prepare') {
            return await prepareGovernanceV2(
              input,
              env,
              dependencies,
              request.signal,
            );
          }

          const plan = await parseCanonicalControlPlanJson(
            decodedCanonicalPlanJsonV2(input),
          );
          if (plan.objective !== 'governance') {
            return jsonResponse(400, { error: 'invalid-control-request' });
          }
          if (input.phase === 'apply-next') {
            return await applyGovernanceV2(
              input,
              plan,
              env,
              dependencies,
              request.signal,
            );
          }
          return await recoverGovernanceV2(
            input,
            plan,
            env,
            dependencies,
            request.signal,
          );
        } catch {
          return jsonResponse(503, {
            error: 'governance-control-unavailable',
          });
        }
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
            if (error.kind === 'absent' || error.kind === 'denied') {
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
