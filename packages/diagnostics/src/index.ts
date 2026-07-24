import {
  createRemoteJWKSet,
  customFetch,
  importJWK,
  jwksCache,
  jwtVerify,
  type JWK,
  type JWKSCacheInput,
} from 'jose';
import {
  buildStewardRuntimeDiagnosticsControlProbe,
  buildStewardRuntimeDiagnosticsEnvelope,
  buildStewardRuntimeDiagnosticsTransportResponse,
  canonicalStewardRuntimeDiagnosticsControlProbeJson,
  canonicalStewardRuntimeDiagnosticsTransportResponseJson,
  parseStewardRuntimeDiagnosticsControlReceipt,
  parseStewardRuntimeDiagnosticsTransportRequest,
  type StewardRuntimeDiagnosticsControlReceiptV1,
} from '../../core/src/index.js';

const diagnosticsPath = '/v1/runtime-diagnostics';
const internalProtocolHeader = 'x-steward-internal-protocol';
const accessAssertionHeader = 'cf-access-jwt-assertion';
const controlWorkerName = 'steward-control';
const expectedQueueName = 'steward-events';
const expectedDeadLetterQueueName = 'steward-events-dlq';
const expectedConsumerScript = 'steward-coordinator';
const expectedEventQueueProducers = [
  'worker:steward-coordinator',
  'worker:steward-ingress',
] as const;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;
const queueIdPattern = /^[0-9a-f]{32}$/;
const accessTeamDomainPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const accessJwksCaches = new WeakMap<
  typeof fetch,
  Map<string, JWKSCacheInput>
>();

export const maximumDiagnosticsRequestBytes = 8 * 1024;
export const maximumDiagnosticsUpstreamResponseBytes = 256 * 1024;
export const diagnosticsOverallTimeoutMs = 25_000;
export const diagnosticsCloudflareTimeoutMs = 5_000;
export const diagnosticsControlTimeoutMs = 10_000;

export type DiagnosticsAccessDecision =
  | 'authorized'
  | 'denied'
  | 'unavailable';

export interface DiagnosticsControlService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface DiagnosticsEnv {
  readonly CONTROL: DiagnosticsControlService;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_POLICY_AUD?: string;
  readonly ACCESS_EXPECTED_CLIENT_ID?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_WORKERS_READ_TOKEN?: string;
  readonly CLOUDFLARE_QUEUES_READ_TOKEN?: string;
  readonly EVENT_QUEUE_ID?: string;
  readonly DEAD_LETTER_QUEUE_ID?: string;
}

export interface DiagnosticsDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly verifyAccess: (
    request: Request,
    env: DiagnosticsEnv,
    signal: AbortSignal,
  ) => Promise<DiagnosticsAccessDecision>;
}

export interface DiagnosticsHandler {
  fetch(request: Request, env: DiagnosticsEnv): Promise<Response>;
}

interface DeploymentSnapshot {
  readonly id: string;
  readonly versions: readonly {
    readonly versionId: string;
    readonly percentage: number;
  }[];
}

interface QueueConfiguration {
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  readonly deliveryDelay: number;
  readonly retentionSeconds: number;
  readonly producers: readonly QueueProducer[];
}

interface QueueProducer {
  readonly type: string;
  readonly scriptName: string | null;
}

interface QueueConsumer {
  readonly type: string;
  readonly scriptName: string;
  readonly deadLetterQueue: string;
  readonly batchSize: number;
  readonly maxWaitTimeMs: number;
  readonly maxRetries: number;
  readonly retryDelay: number;
}

interface QueueMetrics {
  readonly backlogCount: number;
  readonly backlogBytes: number;
  readonly oldestMessageTimestampMs: number;
}

class DiagnosticsUnavailableError extends Error {
  constructor() {
    super('Runtime diagnostics are unavailable');
    this.name = 'DiagnosticsUnavailableError';
  }
}

class AccessJwksUnavailableError extends Error {
  constructor() {
    super('Cloudflare Access JWKS are unavailable');
    this.name = 'AccessJwksUnavailableError';
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function unavailableResponse(status = 503): Response {
  return jsonResponse(status, {
    error: status === 403 ? 'access-denied' : 'runtime-diagnostics-unavailable',
  });
}

function contentTypeIsJson(headers: Headers): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    headers.get('content-type') ?? '',
  );
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

function nonNegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function boundedSignal(
  parent: AbortSignal,
  timeoutMs: number,
  additional?: AbortSignal | null,
): AbortSignal {
  const signals = [parent, AbortSignal.timeout(timeoutMs)];
  if (additional !== undefined && additional !== null) {
    signals.push(additional);
  }
  return AbortSignal.any(signals);
}

async function readBoundedStreamJson(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumBytes)
  ) {
    throw new DiagnosticsUnavailableError();
  }
  if (body === null) throw new DiagnosticsUnavailableError();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DiagnosticsUnavailableError();
    }
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new DiagnosticsUnavailableError());
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await Promise.race([reader.read(), aborted]);
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new DiagnosticsUnavailableError();
    } finally {
      if (rejectOnAbort !== undefined) {
        signal.removeEventListener('abort', rejectOnAbort);
      }
    }
    const { done, value } = chunk;
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DiagnosticsUnavailableError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new DiagnosticsUnavailableError();
  }
}

async function readRequestJson(
  request: Request,
  signal: AbortSignal,
): Promise<unknown> {
  return await readBoundedStreamJson(
    request.body,
    request.headers.get('content-length'),
    maximumDiagnosticsRequestBytes,
    signal,
  );
}

async function readResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  return await readBoundedStreamJson(
    response.body,
    response.headers.get('content-length'),
    maximumDiagnosticsUpstreamResponseBytes,
    signal,
  );
}

function accessConfiguration(env: DiagnosticsEnv): {
  readonly teamDomain: string;
  readonly audience: string;
  readonly clientId: string;
} {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? '').toLowerCase();
  const audience = String(env.ACCESS_POLICY_AUD ?? '');
  const clientId = String(env.ACCESS_EXPECTED_CLIENT_ID ?? '');
  if (
    !accessTeamDomainPattern.test(teamDomain)
    || !/^[A-Za-z0-9_-]{20,128}$/.test(audience)
    || !/^[\x21-\x7e]{1,256}$/.test(clientId)
    || clientId !== clientId.trim()
  ) {
    throw new DiagnosticsUnavailableError();
  }
  return { teamDomain, audience, clientId };
}

function accessJwksCache(
  fetchImplementation: typeof fetch,
  teamDomain: string,
): JWKSCacheInput {
  let byTeamDomain = accessJwksCaches.get(fetchImplementation);
  if (byTeamDomain === undefined) {
    byTeamDomain = new Map();
    accessJwksCaches.set(fetchImplementation, byTeamDomain);
  }
  let cache = byTeamDomain.get(teamDomain);
  if (cache === undefined) {
    cache = {};
    byTeamDomain.set(teamDomain, cache);
  }
  return cache;
}

export async function verifyCloudflareAccessRequest(
  request: Request,
  env: DiagnosticsEnv,
  fetchImplementation: typeof fetch = fetch,
  parentSignal: AbortSignal = request.signal,
): Promise<DiagnosticsAccessDecision> {
  let config: ReturnType<typeof accessConfiguration>;
  try {
    config = accessConfiguration(env);
  } catch {
    return 'unavailable';
  }

  const assertion = request.headers.get(accessAssertionHeader);
  if (assertion === null || assertion.length < 32 || assertion.length > 16_384) {
    return 'denied';
  }

  try {
    const jwks = createRemoteJWKSet(
      new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
      {
        timeoutDuration: diagnosticsCloudflareTimeoutMs,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        // Recreate the resolver so its custom fetch keeps this request's
        // cancellation signal, while the jose-managed JWKS bytes and refresh
        // timestamp persist safely across requests in the same isolate.
        [jwksCache]: accessJwksCache(
          fetchImplementation,
          config.teamDomain,
        ),
        [customFetch]: async (url, options) => {
          try {
            const jwksSignal = boundedSignal(
              parentSignal,
              diagnosticsCloudflareTimeoutMs,
              options.signal,
            );
            const response = await fetchImplementation(url, {
              ...options,
              // Cloudflare Workers implements "follow" and "manual", but not
              // the browser-only "error" mode. Keep redirects observable and
              // reject every 3xx through the response.ok check below.
              redirect: 'manual',
              signal: jwksSignal,
            });
            if (!response.ok) throw new AccessJwksUnavailableError();
            if (!contentTypeIsJson(response.headers)) {
              throw new AccessJwksUnavailableError();
            }
            const jwksPayload = plainRecord(await readBoundedStreamJson(
              response.clone().body,
              response.headers.get('content-length'),
              maximumDiagnosticsUpstreamResponseBytes,
              jwksSignal,
            ));
            const keys = Array.isArray(jwksPayload?.keys)
              ? jwksPayload.keys.map((candidate) => plainRecord(candidate))
              : [];
            if (
              jwksPayload === null
              || keys.length === 0
              || !keys.every((key) =>
                key !== null
                  && key.kty === 'RSA'
                  && key.alg === 'RS256'
                  && key.use === 'sig'
                  && typeof key.kid === 'string'
                  && /^[A-Za-z0-9_-]{1,256}$/.test(key.kid)
                  && typeof key.n === 'string'
                  && /^[A-Za-z0-9_-]{32,2048}$/.test(key.n)
                  && typeof key.e === 'string'
                  && /^[A-Za-z0-9_-]{1,16}$/.test(key.e))
              || new Set(keys.map((key) => key?.kid)).size !== keys.length
            ) {
              throw new AccessJwksUnavailableError();
            }
            await Promise.all(keys.map(
              (key) => importJWK(key as JWK, 'RS256'),
            ));
            return response;
          } catch (error) {
            if (error instanceof AccessJwksUnavailableError) throw error;
            throw new AccessJwksUnavailableError();
          }
        },
      },
    );
    const verified = await jwtVerify(assertion, jwks, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['iat', 'exp', 'iss', 'aud'],
    });
    return verified.protectedHeader.alg === 'RS256'
      && verified.payload.type === 'app'
      && verified.payload.sub === ''
      && verified.payload.common_name === config.clientId
      && Number.isSafeInteger(verified.payload.iat)
      ? 'authorized'
      : 'denied';
  } catch (error) {
    return error instanceof AccessJwksUnavailableError
      ? 'unavailable'
      : 'denied';
  }
}

const defaultDependencies: DiagnosticsDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  verifyAccess: (request, env, signal) =>
    verifyCloudflareAccessRequest(request, env, fetch, signal),
};

function cloudflareConfiguration(env: DiagnosticsEnv): {
  readonly accountId: string;
  readonly workersToken: string;
  readonly queuesToken: string;
  readonly eventQueueId: string;
  readonly deadLetterQueueId: string;
} {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? '');
  const workersToken = String(env.CLOUDFLARE_WORKERS_READ_TOKEN ?? '');
  const queuesToken = String(env.CLOUDFLARE_QUEUES_READ_TOKEN ?? '');
  const eventQueueId = String(env.EVENT_QUEUE_ID ?? '');
  const deadLetterQueueId = String(env.DEAD_LETTER_QUEUE_ID ?? '');
  if (
    !accountIdPattern.test(accountId)
    || !queueIdPattern.test(eventQueueId)
    || !queueIdPattern.test(deadLetterQueueId)
    || eventQueueId === deadLetterQueueId
    || !workersToken
    || !queuesToken
    || workersToken === queuesToken
  ) {
    throw new DiagnosticsUnavailableError();
  }
  return {
    accountId,
    workersToken,
    queuesToken,
    eventQueueId,
    deadLetterQueueId,
  };
}

async function cloudflareApiResult(
  dependencies: DiagnosticsDependencies,
  path: string,
  token: string,
  parentSignal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  const operationSignal = boundedSignal(
    parentSignal,
    diagnosticsCloudflareTimeoutMs,
  );
  try {
    response = await dependencies.fetch(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'cache-control': 'no-store',
          'user-agent': 'splrad-steward-diagnostics',
        },
        // Keep redirects observable; response.ok below fails every 3xx closed.
        redirect: 'manual',
        signal: operationSignal,
      },
    );
  } catch {
    throw new DiagnosticsUnavailableError();
  }
  if (!response.ok || !contentTypeIsJson(response.headers)) {
    throw new DiagnosticsUnavailableError();
  }
  const payload = plainRecord(await readResponseJson(
    response,
    operationSignal,
  ));
  if (payload === null || payload.success !== true || !('result' in payload)) {
    throw new DiagnosticsUnavailableError();
  }
  return payload.result;
}

async function readActiveDeployment(
  dependencies: DiagnosticsDependencies,
  config: ReturnType<typeof cloudflareConfiguration>,
  parentSignal: AbortSignal,
): Promise<DeploymentSnapshot> {
  const result = plainRecord(await cloudflareApiResult(
    dependencies,
    `/accounts/${config.accountId}/workers/scripts/${controlWorkerName}/deployments`,
    config.workersToken,
    parentSignal,
  ));
  const deployments = result?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new DiagnosticsUnavailableError();
  }
  // Cloudflare guarantees the first list entry is the latest deployment
  // actively serving traffic. Historical entries are not part of this proof.
  const active = plainRecord(deployments[0]);
  const versions = active?.versions;
  if (
    active === null
    || !uuidPattern.test(String(active.id ?? ''))
    || active.strategy !== 'percentage'
    || !Array.isArray(versions)
    || versions.length < 1
    || versions.length > 2
  ) {
    throw new DiagnosticsUnavailableError();
  }
  const parsed = versions.map((candidate) => {
    const item = plainRecord(candidate);
    const percentage = item?.percentage;
    const versionId = String(item?.version_id ?? '');
    if (
      item === null
      || !uuidPattern.test(versionId)
      || typeof percentage !== 'number'
      || !Number.isFinite(percentage)
      || percentage < 0
      || percentage > 100
    ) {
      throw new DiagnosticsUnavailableError();
    }
    return { versionId, percentage };
  }).sort((left, right) => left.versionId.localeCompare(right.versionId));
  if (
    new Set(parsed.map((item) => item.versionId)).size !== parsed.length
    || Math.abs(parsed.reduce((sum, item) => sum + item.percentage, 0) - 100)
      > 0.001
  ) {
    throw new DiagnosticsUnavailableError();
  }
  return { id: String(active.id), versions: parsed };
}

function productionVersionId(
  deployment: DeploymentSnapshot,
): string | null {
  const productionVersions = deployment.versions.filter(
    (version) => version.percentage === 100,
  );
  return productionVersions.length === 1
      && deployment.versions.every(
        (version) =>
          version.percentage === 0 || version.percentage === 100,
      )
    ? productionVersions[0]?.versionId ?? null
    : null;
}

function sameDeployment(
  left: DeploymentSnapshot,
  right: DeploymentSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readQueueConfiguration(
  dependencies: DiagnosticsDependencies,
  config: ReturnType<typeof cloudflareConfiguration>,
  queueId: string,
  parentSignal: AbortSignal,
): Promise<QueueConfiguration> {
  const result = plainRecord(await cloudflareApiResult(
    dependencies,
    `/accounts/${config.accountId}/queues/${queueId}`,
    config.queuesToken,
    parentSignal,
  ));
  const settings = plainRecord(result?.settings);
  const producers = result?.producers;
  const deliveryPaused = settings?.delivery_paused;
  if (
    result === null
    || settings === null
    || !Array.isArray(producers)
    || String(result.queue_id ?? '') !== queueId
    || typeof result.queue_name !== 'string'
    || (
      deliveryPaused !== undefined
      && typeof deliveryPaused !== 'boolean'
    )
  ) {
    throw new DiagnosticsUnavailableError();
  }
  const deliveryDelay = nonNegativeSafeInteger(settings.delivery_delay);
  const retentionSeconds = nonNegativeSafeInteger(
    settings.message_retention_period,
  );
  if (deliveryDelay === null || retentionSeconds === null) {
    throw new DiagnosticsUnavailableError();
  }
  const parsedProducers = producers.map((candidate) => {
    const producer = plainRecord(candidate);
    if (
      producer === null
      || typeof producer.type !== 'string'
      || (
        producer.script !== undefined
        && typeof producer.script !== 'string'
      )
    ) {
      throw new DiagnosticsUnavailableError();
    }
    return {
      type: producer.type,
      scriptName: producer.script ?? null,
    };
  });
  return {
    id: queueId,
    name: result.queue_name,
    // Cloudflare live responses may omit this optional field when not paused.
    paused: deliveryPaused === undefined ? false : deliveryPaused,
    deliveryDelay,
    retentionSeconds,
    producers: parsedProducers,
  };
}

async function readQueueConsumers(
  dependencies: DiagnosticsDependencies,
  config: ReturnType<typeof cloudflareConfiguration>,
  queueId: string,
  parentSignal: AbortSignal,
): Promise<readonly QueueConsumer[]> {
  const result = await cloudflareApiResult(
    dependencies,
    `/accounts/${config.accountId}/queues/${queueId}/consumers`,
    config.queuesToken,
    parentSignal,
  );
  if (!Array.isArray(result)) throw new DiagnosticsUnavailableError();
  return result.map((candidate) => {
    const item = plainRecord(candidate);
    const settings = plainRecord(item?.settings);
    const liveScriptName = item?.script;
    const documentedScriptName = item?.script_name;
    const scriptName = typeof liveScriptName === 'string'
      ? liveScriptName
      : typeof documentedScriptName === 'string'
        ? documentedScriptName
        : null;
    if (
      item === null
      || settings === null
      || typeof item.type !== 'string'
      || (
        liveScriptName !== undefined
        && typeof liveScriptName !== 'string'
      )
      || (
        documentedScriptName !== undefined
        && typeof documentedScriptName !== 'string'
      )
      || scriptName === null
      || (
        typeof liveScriptName === 'string'
        && typeof documentedScriptName === 'string'
        && liveScriptName !== documentedScriptName
      )
      || typeof item.dead_letter_queue !== 'string'
    ) {
      throw new DiagnosticsUnavailableError();
    }
    const batchSize = nonNegativeSafeInteger(settings.batch_size);
    const maxWaitTimeMs = nonNegativeSafeInteger(settings.max_wait_time_ms);
    const maxRetries = nonNegativeSafeInteger(settings.max_retries);
    const retryDelay = nonNegativeSafeInteger(settings.retry_delay);
    if (
      batchSize === null
      || maxWaitTimeMs === null
      || maxRetries === null
      || retryDelay === null
    ) {
      throw new DiagnosticsUnavailableError();
    }
    return {
      type: item.type,
      scriptName,
      deadLetterQueue: item.dead_letter_queue,
      batchSize,
      maxWaitTimeMs,
      maxRetries,
      retryDelay,
    };
  });
}

async function readQueueMetrics(
  dependencies: DiagnosticsDependencies,
  config: ReturnType<typeof cloudflareConfiguration>,
  queueId: string,
  parentSignal: AbortSignal,
): Promise<QueueMetrics> {
  const result = plainRecord(await cloudflareApiResult(
    dependencies,
    `/accounts/${config.accountId}/queues/${queueId}/metrics`,
    config.queuesToken,
    parentSignal,
  ));
  const backlogCount = nonNegativeSafeInteger(result?.backlog_count);
  const backlogBytes = nonNegativeSafeInteger(result?.backlog_bytes);
  const oldestMessageTimestampMs = nonNegativeSafeInteger(
    result?.oldest_message_timestamp_ms,
  );
  if (
    result === null
    || backlogCount === null
    || backlogBytes === null
    || oldestMessageTimestampMs === null
  ) {
    throw new DiagnosticsUnavailableError();
  }
  return { backlogCount, backlogBytes, oldestMessageTimestampMs };
}

function eventQueueReady(
  queue: QueueConfiguration,
  consumers: readonly QueueConsumer[],
): boolean {
  const producerKeys = queue.producers
    .map((producer) => `${producer.type}:${producer.scriptName ?? ''}`)
    .sort();
  if (
    queue.name !== expectedQueueName
    || queue.paused
    || queue.deliveryDelay !== 0
    || queue.retentionSeconds < 86_400
    // Coordinator is intentionally a second producer for deferred wakeups.
    || JSON.stringify(producerKeys)
      !== JSON.stringify(expectedEventQueueProducers)
    || consumers.length !== 1
  ) {
    return false;
  }
  const [consumer] = consumers;
  return consumer?.type === 'worker'
    && consumer.scriptName === expectedConsumerScript
    && consumer.deadLetterQueue === expectedDeadLetterQueueName
    && consumer.batchSize === 10
    && consumer.maxWaitTimeMs === 1_000
    && consumer.maxRetries === 3
    && consumer.retryDelay === 5;
}

function deadLetterQueueAvailable(
  queue: QueueConfiguration,
  consumers: readonly QueueConsumer[],
): boolean {
  return queue.name === expectedDeadLetterQueueName
    && !queue.paused
    && queue.deliveryDelay === 0
    && queue.retentionSeconds >= 86_400
    && queue.producers.length === 0
    && consumers.length === 0;
}

async function invokeControl(
  request: ReturnType<typeof parseStewardRuntimeDiagnosticsTransportRequest>,
  env: DiagnosticsEnv,
  parentSignal: AbortSignal,
): Promise<StewardRuntimeDiagnosticsControlReceiptV1> {
  const probe = buildStewardRuntimeDiagnosticsControlProbe({
    nonce: request.nonce,
    subject: request.subject,
    environment: 'production',
  });
  let response: Response;
  const operationSignal = boundedSignal(
    parentSignal,
    diagnosticsControlTimeoutMs,
  );
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v1/runtime-diagnostics',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [internalProtocolHeader]: '1',
          'cloudflare-workers-version-key':
            `steward-repository-${request.subject.repositoryId}`,
        },
        body: canonicalStewardRuntimeDiagnosticsControlProbeJson(probe),
        signal: operationSignal,
      },
    );
  } catch {
    throw new DiagnosticsUnavailableError();
  }
  if (response.status === 403) {
    throw new RepositoryAccessDeniedError();
  }
  if (!response.ok || !contentTypeIsJson(response.headers)) {
    throw new DiagnosticsUnavailableError();
  }
  let receipt: StewardRuntimeDiagnosticsControlReceiptV1;
  try {
    receipt = parseStewardRuntimeDiagnosticsControlReceipt(
      await readResponseJson(response, operationSignal),
    );
  } catch {
    throw new DiagnosticsUnavailableError();
  }
  if (
    receipt.nonce !== request.nonce
    || receipt.environment !== 'production'
    || receipt.subject.repositoryId !== request.subject.repositoryId
    || receipt.subject.repositoryFullName.toLowerCase()
      !== request.subject.repositoryFullName.toLowerCase()
  ) {
    throw new DiagnosticsUnavailableError();
  }
  return receipt;
}

class RepositoryAccessDeniedError extends Error {
  constructor() {
    super('Repository access denied');
    this.name = 'RepositoryAccessDeniedError';
  }
}

export function createDiagnosticsHandler(
  dependencies: DiagnosticsDependencies = defaultDependencies,
): DiagnosticsHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (
        url.pathname !== diagnosticsPath
        || url.search !== ''
        || request.method !== 'POST'
      ) {
        return new Response('Not Found', { status: 404 });
      }
      const overallSignal = boundedSignal(
        request.signal,
        diagnosticsOverallTimeoutMs,
      );
      let accessDecision: DiagnosticsAccessDecision;
      try {
        accessDecision = await dependencies.verifyAccess(
          request,
          env,
          overallSignal,
        );
      } catch {
        accessDecision = 'unavailable';
      }
      if (accessDecision !== 'authorized') {
        return unavailableResponse(
          accessDecision === 'denied' ? 403 : 503,
        );
      }
      if (!contentTypeIsJson(request.headers)) {
        return jsonResponse(415, { error: 'application-json-required' });
      }

      let input;
      try {
        input = parseStewardRuntimeDiagnosticsTransportRequest(
          await readRequestJson(request, overallSignal),
        );
      } catch {
        return overallSignal.aborted
          ? unavailableResponse()
          : jsonResponse(400, { error: 'invalid-diagnostics-request' });
      }

      try {
        const config = cloudflareConfiguration(env);
        const deploymentBefore = await readActiveDeployment(
          dependencies,
          config,
          overallSignal,
        );
        const productionVersionBefore = productionVersionId(deploymentBefore);
        if (productionVersionBefore === null) {
          throw new DiagnosticsUnavailableError();
        }
        const control = await invokeControl(input, env, overallSignal);
        const [
          eventQueue,
          eventConsumers,
          deadLetterQueue,
          deadLetterConsumers,
          deadLetterMetrics,
        ] = await Promise.all([
          readQueueConfiguration(
            dependencies,
            config,
            config.eventQueueId,
            overallSignal,
          ),
          readQueueConsumers(
            dependencies,
            config,
            config.eventQueueId,
            overallSignal,
          ),
          readQueueConfiguration(
            dependencies,
            config,
            config.deadLetterQueueId,
            overallSignal,
          ).catch(() => null),
          readQueueConsumers(
            dependencies,
            config,
            config.deadLetterQueueId,
            overallSignal,
          ).catch(() => null),
          readQueueMetrics(
            dependencies,
            config,
            config.deadLetterQueueId,
            overallSignal,
          ).catch(() => null),
        ]);

        // Keep the deployment re-read as the final external-fact barrier.
        // A version transition during any Queue/DLQ read must invalidate the
        // whole observation rather than emit an already-stale Control receipt.
        const deploymentAfter = await readActiveDeployment(
          dependencies,
          config,
          overallSignal,
        );
        const productionVersionAfter = productionVersionId(deploymentAfter);
        if (
          !sameDeployment(deploymentBefore, deploymentAfter)
          || productionVersionAfter === null
          || productionVersionAfter !== productionVersionBefore
          || control.controlRevision.workerVersionId !== productionVersionAfter
        ) {
          throw new DiagnosticsUnavailableError();
        }

        const dlqAvailable = deadLetterQueue !== null
          && deadLetterConsumers !== null
          && deadLetterMetrics !== null
          && deadLetterQueueAvailable(
            deadLetterQueue,
            deadLetterConsumers,
          );
        const envelope = buildStewardRuntimeDiagnosticsEnvelope({
          subject: control.subject,
          observedAt: dependencies.now().toISOString(),
          diagnostics: {
            controlRevision: {
              stewardCommit: control.controlRevision.stewardCommit,
              workerVersionId: control.controlRevision.workerVersionId,
              workerDeploymentId: deploymentAfter.id,
              environment: control.environment,
            },
            queue: eventQueueReady(
              eventQueue,
              eventConsumers,
            ) ? 'ready' : 'degraded',
            control: 'ready',
            deadLetterQueue: !dlqAvailable
              ? 'unavailable'
              : deadLetterMetrics.backlogCount === 0
                  && deadLetterMetrics.backlogBytes === 0
                  && deadLetterMetrics.oldestMessageTimestampMs === 0
                ? 'clear'
                : 'pending',
          },
        });
        const response = buildStewardRuntimeDiagnosticsTransportResponse({
          nonce: input.nonce,
          envelope,
        });
        return new Response(
          canonicalStewardRuntimeDiagnosticsTransportResponseJson(response),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          },
        );
      } catch (error) {
        return error instanceof RepositoryAccessDeniedError
          ? unavailableResponse(403)
          : unavailableResponse();
      }
    },
  };
}

export default createDiagnosticsHandler();
