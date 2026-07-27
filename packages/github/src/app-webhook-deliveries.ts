import {
  buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  parseStewardRuntimeControlRevision,
  parseStewardRuntimeDeliveryRecoveryPageReceiptV1,
  parseStewardRuntimeDeliveryRecoveryPageRequestV1,
  parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_CURSOR_LENGTH,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  type StewardRuntimeDeliveryRecoveryPageReceiptV1,
} from '../../core/src/index.js';
import { resolveGitHubRestApiVersion } from './api-version.js';
import {
  GitHubApiError,
  GitHubTransportError,
  type GitHubHttpMethod,
} from './transport.js';

const githubApiOrigin = 'https://api.github.com';
const deliveriesPath = '/app/hook/deliveries';
export const GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES =
  512 * 1_024;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;
const providerTimestampPattern =
  /^(\d{4})-((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))T((?:[01]\d|2[0-3])):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?Z$/;
const linkParameterNamePattern =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const linkTokenValuePattern =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z:\/?@()[\]]+$/;

type UnknownRecord = Record<string, unknown>;

export interface GitHubAppWebhookDeliveriesClientOptions {
  readonly appJwt: string;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
  readonly fetch: typeof globalThis.fetch;
  readonly apiVersion?: string;
  readonly userAgent?: string;
  readonly signal?: AbortSignal;
}

export interface GitHubAppWebhookDeliveriesClient {
  listDeliveries(
    request: unknown,
  ): Promise<StewardRuntimeDeliveryRecoveryPageReceiptV1>;
  requestRedelivery(
    request: unknown,
  ): Promise<StewardRuntimeDeliveryRecoveryAcceptedReceiptV1>;
}

export type GitHubAppWebhookDeliveryFailure =
  | {
      readonly kind: 'rate-limited';
      readonly retryable: true;
      readonly retryAfterSeconds: number | null;
      readonly requestId: string | null;
    }
  | {
      readonly kind: 'unknown';
      readonly retryable: boolean;
      readonly status: number | null;
      readonly requestId: string | null;
    };

export class GitHubAppWebhookDeliveryControlRevisionMismatchError
  extends Error {
  constructor() {
    super(
      'GitHub App webhook delivery request expected a different '
      + 'Steward Control revision',
    );
    this.name = 'GitHubAppWebhookDeliveryControlRevisionMismatchError';
  }
}

function plainRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as UnknownRecord
    : null;
}

function sameRevision(
  left: StewardRuntimeControlRevisionV1,
  right: StewardRuntimeControlRevisionV1,
): boolean {
  return left.stewardCommit === right.stewardCommit
    && left.workerVersionId === right.workerVersionId
    && left.workerVersionTag === right.workerVersionTag
    && left.workerVersionCreatedAt === right.workerVersionCreatedAt;
}

function assertExpectedRevision(
  expected: StewardRuntimeControlRevisionV1,
  actual: StewardRuntimeControlRevisionV1,
): void {
  if (!sameRevision(expected, actual)) {
    throw new GitHubAppWebhookDeliveryControlRevisionMismatchError();
  }
}

function invalidResponse(method: GitHubHttpMethod): never {
  throw new GitHubTransportError({
    method,
    path: deliveriesPath,
    reason: 'invalid-response',
    retryable: false,
  });
}

function networkFailure(method: GitHubHttpMethod): never {
  throw new GitHubTransportError({
    method,
    path: deliveriesPath,
    reason: 'network',
    // A failed POST can have reached GitHub; its result is unknown and must
    // be reconciled from live delivery evidence before another mutation.
    retryable: method === 'GET',
  });
}

async function boundedResponseText(
  response: Response,
  method: GitHubHttpMethod,
  signal: AbortSignal | undefined,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      invalidResponse(method);
    }
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength
        > GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES
    ) {
      invalidResponse(method);
    }
  }
  if (response.body === null) invalidResponse(method);

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    invalidResponse(method);
  }
  function cancelReader(reason?: unknown): void {
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // A locked or already-failed body is already being rejected.
    }
  }
  const aborted = Symbol('aborted');
  let abortHandler: (() => void) | undefined;
  let abortPromise: Promise<typeof aborted> | undefined;
  if (signal) {
    if (signal.aborted) {
      cancelReader(signal.reason);
      networkFailure(method);
    }
    abortPromise = new Promise((resolve) => {
      abortHandler = () => resolve(aborted);
      signal.addEventListener('abort', abortHandler, { once: true });
    });
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      let result:
        | Awaited<ReturnType<typeof reader.read>>
        | typeof aborted;
      try {
        result = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
      } catch {
        networkFailure(method);
      }
      if (result === aborted) {
        cancelReader(signal?.reason);
        networkFailure(method);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) invalidResponse(method);
      length += result.value.byteLength;
      if (
        length > GITHUB_APP_WEBHOOK_DELIVERIES_MAXIMUM_RESPONSE_BYTES
      ) {
        cancelReader();
        invalidResponse(method);
      }
      chunks.push(result.value);
    }
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending read owns the lock until cancellation settles.
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalidResponse(method);
  }
}

function canonicalProviderTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = providerTimestampPattern.exec(value);
  if (!match) return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}T`
    + `${match[4]}:${match[5]}:${match[6]}.`
    + `${(match[7] ?? '').padEnd(3, '0')}Z`;
  return Number.isNaN(Date.parse(canonical))
    || new Date(canonical).toISOString() !== canonical
    ? null
    : canonical;
}

function providerAttempt(value: unknown): Record<string, unknown> | null {
  const record = plainRecord(value);
  if (!record) return null;
  const required = [
    'id',
    'guid',
    'delivered_at',
    'redelivery',
    'status',
    'status_code',
    'installation_id',
    'repository_id',
    'event',
    'action',
  ];
  if (required.some((field) => !Object.hasOwn(record, field))) return null;
  const deliveredAt = canonicalProviderTimestamp(record.delivered_at);
  if (!deliveredAt) return null;
  return {
    id: record.id,
    guid: record.guid,
    deliveredAt,
    redelivery: record.redelivery,
    status: record.status,
    statusCode: record.status_code,
    installationId: record.installation_id,
    repositoryId: record.repository_id,
    event: record.event,
    action: record.action,
  };
}

function splitOutsideQuotes(value: string, separator: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angle = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === '<') {
      if (angle) return null;
      angle = true;
      continue;
    }
    if (!quoted && character === '>') {
      if (!angle) return null;
      angle = false;
      continue;
    }
    if (!quoted && !angle && character === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped || angle) return null;
  parts.push(value.slice(start));
  return parts;
}

function linkParameterValue(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && trimmed.startsWith('"')
    && trimmed.endsWith('"')
  ) {
    let result = '';
    for (let index = 1; index < trimmed.length - 1; index += 1) {
      const character = trimmed[index]!;
      if (character === '\\') {
        index += 1;
        const escaped = trimmed[index];
        if (escaped === undefined) return null;
        result += escaped;
      } else if (character === '"') {
        return null;
      } else {
        result += character;
      }
    }
    return result;
  }
  return linkTokenValuePattern.test(trimmed) ? trimmed : null;
}

function linkTargetAndRelations(
  value: string,
): { target: string; relations: readonly string[] } | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('<')) return null;
  const close = trimmed.indexOf('>');
  if (close <= 1) return null;
  const target = trimmed.slice(1, close);
  const remainder = trimmed.slice(close + 1);
  if (!remainder.trim().startsWith(';')) return null;
  const rawParameters = splitOutsideQuotes(remainder, ';');
  if (!rawParameters || rawParameters[0]?.trim() !== '') return null;
  const parameters = new Map<string, string>();
  for (const rawParameter of rawParameters.slice(1)) {
    const parameter = rawParameter.trim();
    const equals = parameter.indexOf('=');
    if (equals <= 0) return null;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const rawValue = parameter.slice(equals + 1);
    const parsedValue = linkParameterValue(rawValue);
    if (
      !linkParameterNamePattern.test(name)
      || parsedValue === null
      || parameters.has(name)
    ) {
      return null;
    }
    parameters.set(name, parsedValue);
  }
  const relationValue = parameters.get('rel');
  if (!relationValue) return null;
  const relations = relationValue
    .split(/\s+/u)
    .filter(Boolean)
    .map((relation) => relation.toLowerCase());
  if (
    relations.length === 0
    || new Set(relations).size !== relations.length
  ) {
    return null;
  }
  return { target, relations };
}

function nextCursorFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== githubApiOrigin
    || url.username
    || url.password
    || url.port
    || url.pathname !== deliveriesPath
    || url.hash
  ) {
    return null;
  }
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2
    || entries.filter(([name]) => name === 'per_page').length !== 1
    || entries.filter(([name]) => name === 'cursor').length !== 1
    || entries.some(([name]) => name !== 'per_page' && name !== 'cursor')
    || url.searchParams.get('per_page') !== '100'
  ) {
    return null;
  }
  const cursor = url.searchParams.get('cursor');
  if (
    cursor === null
    || cursor.length < 1
    || cursor.length > STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_CURSOR_LENGTH
    || cursor !== cursor.trim()
    || !visibleAsciiPattern.test(cursor)
  ) {
    return null;
  }
  return cursor;
}

function nextCursor(link: string | null): string | null {
  if (link === null || link.trim() === '') return null;
  const values = splitOutsideQuotes(link, ',');
  if (!values || values.some((value) => value.trim() === '')) {
    invalidResponse('GET');
  }
  let next: string | null = null;
  for (const value of values) {
    const parsed = linkTargetAndRelations(value);
    if (!parsed) invalidResponse('GET');
    if (!parsed.relations.includes('next')) continue;
    if (next !== null) invalidResponse('GET');
    next = nextCursorFromUrl(parsed.target);
    if (next === null) invalidResponse('GET');
  }
  return next;
}

async function responseMessage(
  response: Response,
  method: GitHubHttpMethod,
  signal: AbortSignal | undefined,
): Promise<string> {
  const text = await boundedResponseText(response, method, signal);
  try {
    const payload = JSON.parse(text) as { message?: unknown };
    const message = String(payload?.message ?? '').trim();
    if (message) return message;
  } catch {
    // Status text is the bounded fallback for non-JSON GitHub errors.
  }
  return response.statusText || 'request failed';
}

async function apiError(
  response: Response,
  method: GitHubHttpMethod,
  signal: AbortSignal | undefined,
): Promise<never> {
  const message = await responseMessage(response, method, signal);
  const retryAfterHeader = response.headers.get('retry-after')?.trim();
  const retryAfter = retryAfterHeader === undefined
    ? undefined
    : Number(retryAfterHeader);
  const rateLimited = response.status === 429
    || (response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0'
      || response.headers.has('retry-after')
      || /rate limit/i.test(message)
    ));
  throw new GitHubApiError({
    status: response.status,
    method,
    path: deliveriesPath,
    message,
    rateLimited,
    ...(retryAfter !== undefined
      && Number.isFinite(retryAfter)
      && retryAfter >= 0
      ? { retryAfterSeconds: retryAfter }
      : {}),
    ...(response.headers.get('x-github-request-id')
      ? { requestId: response.headers.get('x-github-request-id')! }
      : {}),
  });
}

async function fetchResponse(
  fetcher: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  method: GitHubHttpMethod,
): Promise<Response> {
  if (init.signal?.aborted) networkFailure(method);
  try {
    const response = await fetcher(url, init);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new GitHubTransportError({
        method,
        path: deliveriesPath,
        reason: 'redirect',
        retryable: false,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof GitHubTransportError) throw error;
    networkFailure(method);
  }
}

export function classifyGitHubAppWebhookDeliveryError(
  error: unknown,
): GitHubAppWebhookDeliveryFailure | null {
  if (error instanceof GitHubApiError) {
    if (error.rateLimited) {
      return {
        kind: 'rate-limited',
        retryable: true,
        retryAfterSeconds: error.retryAfterSeconds ?? null,
        requestId: error.requestId ?? null,
      };
    }
    return {
      kind: 'unknown',
      retryable: error.method === 'GET' && error.status >= 500,
      status: error.status,
      requestId: error.requestId ?? null,
    };
  }
  if (error instanceof GitHubTransportError) {
    return {
      kind: 'unknown',
      retryable: error.retryable,
      status: null,
      requestId: null,
    };
  }
  return null;
}

export function createGitHubAppWebhookDeliveriesClient(
  options: GitHubAppWebhookDeliveriesClientOptions,
): GitHubAppWebhookDeliveriesClient {
  const appJwt = options.appJwt.trim();
  if (!appJwt) throw new Error('GitHub App JWT is required');
  if (typeof options.fetch !== 'function') {
    throw new Error('An explicit GitHub App webhook deliveries fetch is required');
  }
  const controlRevision = parseStewardRuntimeControlRevision(
    options.controlRevision,
  );
  const apiVersion = resolveGitHubRestApiVersion(
    `${githubApiOrigin}/`,
    options.apiVersion,
  );
  const userAgent = options.userAgent?.trim() || 'splrad-steward';
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${appJwt}`,
    'user-agent': userAgent,
    'x-github-api-version': apiVersion,
  });

  return {
    async listDeliveries(
      value: unknown,
    ): Promise<StewardRuntimeDeliveryRecoveryPageReceiptV1> {
      const request =
        parseStewardRuntimeDeliveryRecoveryPageRequestV1(value);
      assertExpectedRevision(
        request.expectedControlRevision,
        controlRevision,
      );
      const url = new URL(deliveriesPath, githubApiOrigin);
      url.searchParams.set('per_page', '100');
      if (request.cursor !== null) {
        url.searchParams.set('cursor', request.cursor);
      }
      const response = await fetchResponse(
        options.fetch,
        url,
        {
          method: 'GET',
          headers,
          redirect: 'manual',
          ...(options.signal ? { signal: options.signal } : {}),
        },
        'GET',
      );
      if (!response.ok) await apiError(response, 'GET', options.signal);
      if (response.status !== 200) invalidResponse('GET');
      let text: string;
      try {
        text = await boundedResponseText(response, 'GET', options.signal);
      } catch (error) {
        if (error instanceof GitHubTransportError) throw error;
        networkFailure('GET');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        invalidResponse('GET');
      }
      if (!Array.isArray(payload)) invalidResponse('GET');
      const attempts = payload.map(providerAttempt);
      if (attempts.some((attempt) => attempt === null)) {
        invalidResponse('GET');
      }
      try {
        return parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
          scanId: request.scanId,
          cursor: request.cursor,
          attempts,
          nextCursor: nextCursor(response.headers.get('link')),
          controlRevision,
          schemaVersion: 1,
          phase: 'listed-deliveries',
        });
      } catch {
        invalidResponse('GET');
      }
    },

    async requestRedelivery(
      value: unknown,
    ): Promise<StewardRuntimeDeliveryRecoveryAcceptedReceiptV1> {
      const request =
        parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(value);
      assertExpectedRevision(
        request.expectedControlRevision,
        controlRevision,
      );
      const path = `${deliveriesPath}/${request.attemptId}/attempts`;
      const url = new URL(path, githubApiOrigin);
      const response = await fetchResponse(
        options.fetch,
        url,
        {
          method: 'POST',
          headers,
          redirect: 'manual',
          ...(options.signal ? { signal: options.signal } : {}),
        },
        'POST',
      );
      if (!response.ok) await apiError(response, 'POST', options.signal);
      if (response.status !== 202) invalidResponse('POST');
      let text: string;
      try {
        text = await boundedResponseText(response, 'POST', options.signal);
      } catch (error) {
        if (error instanceof GitHubTransportError) throw error;
        networkFailure('POST');
      }
      if (text.length !== 0) invalidResponse('POST');
      return buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
        scanId: request.scanId,
        intentId: request.intentId,
        attemptId: request.attemptId,
        guid: request.guid,
        controlRevision,
      });
    },
  };
}
