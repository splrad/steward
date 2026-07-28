import {
  verifyCloudflareAccessPrincipal,
  type CloudflareAccessEnvironment,
  type CloudflareAccessPrincipalResult,
} from '../../access-auth/src/index.js';
import {
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeDeliveryRecoveryPageRequestV1,
  buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json,
  canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json,
  deriveStewardRuntimeInstallationIndexBootstrapDigest,
  parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1,
  parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  parseStewardRuntimeDeliveryRecoveryPageReceiptV1,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeInstallationIndexBootstrapCommandV1,
  type StewardRuntimeInstallationIndexBootstrapStatusCommandV1,
  type StewardRuntimeDeliveryRecoveryPageReceiptV1,
} from '../../core/src/index.js';
import { classifyDeadLetterBody } from './capture.js';
import {
  assertFreshDeliveryRecoveryCommand,
  canonicalRecoverGitHubScanIdentityJson,
  maximumDeliveryRecoveryRequestBytes,
  parseDeliveryRecoveryCommand,
  type DeliveryRecoveryCommand,
  type RecoverGitHubDeliveriesCommand,
  type ReplayDeadLetterEntriesCommand,
} from './contracts.js';
import {
  DeliveryRecoveryConflictError,
  deliveryRecoveryLedgerName,
  maximumGitHubDeliveryScanLeaseMs,
  maximumGitHubProviderCoverageWindowMs,
  type DeliveryRecoveryCaptureResult,
  type DeliveryRecoveryInspection,
  type DeliveryRecoveryNextReplayResult,
  type DeliveryRecoveryReplayAuthorizationResult,
  type DeliveryRecoveryReplayOutcomeResult,
  type GitHubDeliveryScanBeginResult,
  type GitHubDeliveryScanCompletionResult,
  type GitHubDeliveryScanInspection,
  type GitHubDeliveryScanPageResult,
  type GitHubNextRedeliveryResult,
  type GitHubRedeliveryOutcomeResult,
} from './ledger-contracts.js';

const recoveryPath = '/v1/recovery';
const internalProtocolHeader = 'x-steward-internal-protocol';
const deliveryRecoveryInternalProtocol = 'delivery-recovery-1';
const expectedDeadLetterQueue = 'steward-events-dlq';
const maximumControlResponseBytes = 128 * 1024;
const maximumGitHubPagesPerInvocation = 5;
const maximumGitHubRedeliveriesPerInvocation = 10;
const recoveryOperationBudgetMs = 25_000;
const recoveryControlCallTimeoutMs = 5_000;
const recoveryCapabilityTimestampHeader =
  'x-steward-recovery-capability-timestamp';
const recoveryCapabilityNonceHeader =
  'x-steward-recovery-capability-nonce';
const recoveryCapabilitySignatureHeader =
  'x-steward-recovery-capability-signature';
const recoveryCapabilityContext = 'steward-recovery-control-v1';
const recoveryControlSecretPattern = /^[\x21-\x7e]{32,512}$/;

export interface DeliveryRecoveryLedgerStub {
  captureDlq(value: unknown): Promise<DeliveryRecoveryCaptureResult>;
  inspect(limit?: number): Promise<DeliveryRecoveryInspection>;
  authorizeReplay(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayAuthorizationResult>;
  nextReplay(
    commandId: unknown,
  ): Promise<DeliveryRecoveryNextReplayResult>;
  recordReplayEnqueued(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult>;
  recordReplayUnknown(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult>;
  beginGitHubScan(value: unknown): Promise<GitHubDeliveryScanBeginResult>;
  recordGitHubScanPage(
    value: unknown,
  ): Promise<GitHubDeliveryScanPageResult>;
  completeGitHubScan(
    value: unknown,
  ): Promise<GitHubDeliveryScanCompletionResult>;
  nextGitHubRedelivery(
    value: unknown,
  ): Promise<GitHubNextRedeliveryResult>;
  recordGitHubRedeliveryAccepted(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryUnknown(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryDeferred(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryRejected(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  inspectGitHubScan(): Promise<GitHubDeliveryScanInspection>;
}

export interface DeliveryRecoveryLedgerNamespace {
  getByName(name: string): DeliveryRecoveryLedgerStub;
}

export interface DeliveryRecoveryControlService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface DeliveryRecoveryCoordinatorService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface DeliveryRecoveryEventQueue {
  send(
    body: string,
    options?: { readonly contentType?: 'text' },
  ): Promise<unknown>;
}

export interface DeliveryRecoveryEnv extends CloudflareAccessEnvironment {
  readonly DELIVERY_RECOVERY_LEDGER: DeliveryRecoveryLedgerNamespace;
  readonly CONTROL: DeliveryRecoveryControlService;
  readonly COORDINATOR?: DeliveryRecoveryCoordinatorService;
  readonly EVENT_QUEUE: DeliveryRecoveryEventQueue;
  readonly RECOVERY_CONTROL_SHARED_SECRET?: string;
}

export interface DeliveryRecoveryQueueMessage {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface DeliveryRecoveryMessageBatch {
  readonly queue: string;
  readonly messages: readonly DeliveryRecoveryQueueMessage[];
}

export interface DeliveryRecoveryDependencies {
  readonly now: () => Date;
  readonly verifyAccess: (
    request: Request,
    env: DeliveryRecoveryEnv,
  ) => Promise<CloudflareAccessPrincipalResult>;
}

export interface DeliveryRecoveryHandler {
  fetch(request: Request, env: DeliveryRecoveryEnv): Promise<Response>;
  queue(
    batch: DeliveryRecoveryMessageBatch,
    env: DeliveryRecoveryEnv,
  ): Promise<void>;
}

class RecoveryRequestError extends Error {
  constructor(readonly code: 'invalid' | 'too-large') {
    super(code);
    this.name = 'RecoveryRequestError';
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

function contentTypeIsJson(request: Request): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    request.headers.get('content-type') ?? '',
  );
}

type RecoveryStreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>;

async function readBoundedChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<RecoveryStreamReadResult> {
  if (signal.aborted) throw new RecoveryRequestError('invalid');
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new RecoveryRequestError('invalid'));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (rejectOnAbort !== undefined) {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null
    && (
      !/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumBytes
    )
  ) {
    throw new RecoveryRequestError('too-large');
  }
  if (request.body === null) throw new RecoveryRequestError('invalid');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await readBoundedChunk(
        reader,
        request.signal,
      );
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        throw new RecoveryRequestError('too-large');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RecoveryRequestError) throw error;
    throw new RecoveryRequestError('invalid');
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
    throw new RecoveryRequestError('invalid');
  }
}

async function readBoundedResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    throw new Error('Control response content type is invalid.');
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && (
      !/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumControlResponseBytes
    )
  ) {
    throw new Error('Control response is too large.');
  }
  if (response.body === null) {
    throw new Error('Control response body is absent.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await readBoundedChunk(reader, signal);
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumControlResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Control response is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown;
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

function ledger(env: DeliveryRecoveryEnv): DeliveryRecoveryLedgerStub {
  return env.DELIVERY_RECOVERY_LEDGER.getByName(
    deliveryRecoveryLedgerName,
  );
}

function canonicalTimestamp(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error('Recovery clock is invalid.');
  }
  return value.toISOString();
}

function floorToProviderSecond(value: Date | string): string {
  const milliseconds = typeof value === 'string'
    ? Date.parse(value)
    : value.getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error('Recovery timestamp is invalid.');
  }
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

function addMilliseconds(value: string, milliseconds: number): string {
  const base = Date.parse(value);
  const result = base + milliseconds;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(result)) {
    throw new Error('Recovery timestamp range is invalid.');
  }
  return new Date(result).toISOString();
}

function githubScanConflictResponse(
  error: unknown,
  requestId: string,
): Response {
  if (!(error instanceof DeliveryRecoveryConflictError)) {
    return jsonResponse(503, {
      error: 'delivery-recovery-unavailable',
      requestId,
    });
  }
  return jsonResponse(409, {
    error: 'github-delivery-scan-conflict',
    reason: error.code,
    requestId,
  });
}

async function scanIdForCommand(
  command: RecoverGitHubDeliveriesCommand,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonicalRecoverGitHubScanIdentityJson(command),
    ),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

async function replayDeadLetters(
  command: ReplayDeadLetterEntriesCommand,
  accessServiceClientId: string,
  env: DeliveryRecoveryEnv,
  dependencies: DeliveryRecoveryDependencies,
): Promise<Response> {
  const stub = ledger(env);
  let authorization: DeliveryRecoveryReplayAuthorizationResult;
  try {
    authorization = await stub.authorizeReplay({
      commandId: command.requestId,
      principal: { accessServiceClientId },
      requestedAt: command.requestedAt,
      entryIds: command.entryIds,
      expectedLedgerRevision: command.expectedLedgerRevision,
    });
  } catch {
    return jsonResponse(409, { error: 'delivery-recovery-conflict' });
  }

  let enqueued = 0;
  while (true) {
    const next = await stub.nextReplay(command.requestId);
    if (next.status === 'complete') {
      return jsonResponse(200, {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        authorization: authorization.status,
        selected: authorization.entryCount,
        enqueued,
        ledgerRevision: next.ledgerRevision,
      });
    }
    if (next.status === 'unresolved') {
      return jsonResponse(409, {
        error: 'delivery-replay-reconciliation-required',
        requestId: command.requestId,
        entries: next.entries,
        ledgerRevision: next.ledgerRevision,
      });
    }
    try {
      await env.EVENT_QUEUE.send(next.body, { contentType: 'text' });
    } catch {
      await stub.recordReplayUnknown({
        commandId: command.requestId,
        entryId: next.entryId,
        recordedAt: canonicalTimestamp(dependencies.now()),
      });
      return jsonResponse(503, {
        error: 'delivery-replay-result-unknown',
        requestId: command.requestId,
        entryId: next.entryId,
      });
    }
    await stub.recordReplayEnqueued({
      commandId: command.requestId,
      entryId: next.entryId,
      recordedAt: canonicalTimestamp(dependencies.now()),
    });
    enqueued += 1;
  }
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

async function controlRequest(
  path: string,
  body: string,
  revision: StewardRuntimeControlRevisionV1,
  env: DeliveryRecoveryEnv,
  now: Date,
  signal: AbortSignal,
): Promise<Request> {
  const secret = String(env.RECOVERY_CONTROL_SHARED_SECRET ?? '');
  if (
    !recoveryControlSecretPattern.test(secret)
    || secret !== secret.trim()
  ) {
    throw new Error('Recovery Control capability is unavailable.');
  }
  const timestamp = canonicalTimestamp(now);
  const nonce = crypto.randomUUID();
  const bodyDigest = await sha256Hex(body);
  const signature = await recoveryControlHmacHex(
    secret,
    recoveryControlCapabilityMessage(
      'POST',
      path,
      bodyDigest,
      timestamp,
      nonce,
      revision,
    ),
  );
  return new Request(`https://control.internal${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [internalProtocolHeader]: deliveryRecoveryInternalProtocol,
      [recoveryCapabilityTimestampHeader]: timestamp,
      [recoveryCapabilityNonceHeader]: nonce,
      [recoveryCapabilitySignatureHeader]: signature,
    },
    body,
    signal,
  });
}

type ControlInvocationResult =
  | {
      readonly status: 'ok';
      readonly response: Response;
      readonly signal: AbortSignal;
    }
  | {
      readonly status: 'rate-limited';
      readonly retryAfter: string | null;
    }
  | { readonly status: 'revision-conflict' }
  | {
      readonly status: 'rejected';
      readonly controlStatus: 400 | 422;
    }
  | {
      readonly status: 'deferred';
      readonly reason: 'control-unavailable';
    }
  | { readonly status: 'capability-denied' }
  | { readonly status: 'unknown' };

async function controlErrorCode(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const value = await readBoundedResponseJson(response, signal);
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype
      && typeof (value as { error?: unknown }).error === 'string'
    ) {
      return (value as { error: string }).error;
    }
  } catch {
    // An unreadable error response cannot prove whether a POST was accepted.
  }
  return null;
}

async function invokeControl(
  env: DeliveryRecoveryEnv,
  request: Request,
  parentSignal: AbortSignal,
): Promise<ControlInvocationResult> {
  let response: Response;
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(recoveryControlCallTimeoutMs),
  ]);
  try {
    response = await env.CONTROL.fetch(request, { signal });
  } catch {
    return { status: 'unknown' };
  }
  if (response.status === 429) {
    return {
      status: 'rate-limited',
      retryAfter: response.headers.get('retry-after'),
    };
  }
  if (response.status === 409) return { status: 'revision-conflict' };
  if (response.status === 400 || response.status === 422) {
    return {
      status: 'rejected',
      controlStatus: response.status,
    };
  }
  if (response.status === 403) return { status: 'capability-denied' };
  if (response.status === 401 || response.status === 404) {
    return {
      status: 'deferred',
      reason: 'control-unavailable',
    };
  }
  if (response.status === 200 || response.status === 202) {
    return { status: 'ok', response, signal };
  }
  if (response.status === 503) {
    const error = await controlErrorCode(response, signal);
    if (
      error === 'github-redelivery-control-unavailable'
      || error === 'control-revision-unavailable'
    ) {
      return {
        status: 'deferred',
        reason: 'control-unavailable',
      };
    }
    if (error === 'github-redelivery-provider-unavailable') {
      // Older Control revisions emitted this code for a provider 5xx. A POST
      // may have taken effect before GitHub returned 5xx, so mixed-version
      // rollouts must conservatively reconcile it as unknown.
      return { status: 'unknown' };
    }
  }
  return { status: 'unknown' };
}

async function invokeRecoveryControl(
  path: string,
  body: string,
  revision: StewardRuntimeControlRevisionV1,
  env: DeliveryRecoveryEnv,
  now: Date,
  parentSignal: AbortSignal,
): Promise<ControlInvocationResult> {
  let request: Request;
  try {
    request = await controlRequest(
      path,
      body,
      revision,
      env,
      now,
      parentSignal,
    );
  } catch {
    // Signing and request construction happen before the service binding can
    // perform I/O, so this outcome is safe to defer rather than mark unknown.
    return { status: 'deferred', reason: 'control-unavailable' };
  }
  return await invokeControl(env, request, parentSignal);
}

function rateLimitedResponse(retryAfter: string | null): Response {
  const response = jsonResponse(429, { error: 'github-rate-limited' });
  if (
    retryAfter !== null
    && /^(?:0|[1-9]\d*)$/.test(retryAfter)
    && Number.isSafeInteger(Number(retryAfter))
  ) {
    response.headers.set('retry-after', retryAfter);
  }
  return response;
}

function deferredRetryAfter(
  now: Date,
  retryAfterSeconds: string | null,
  fallbackSeconds = 60,
): string {
  const parsed = retryAfterSeconds !== null
    && /^(?:0|[1-9]\d*)$/.test(retryAfterSeconds)
    ? Number(retryAfterSeconds)
    : Number.NaN;
  const seconds = Number.isSafeInteger(parsed)
    ? Math.min(Math.max(parsed, 1), 3_600)
    : fallbackSeconds;
  return canonicalTimestamp(new Date(now.getTime() + seconds * 1_000));
}

function attemptsAfterCheckpoint(
  receipt: StewardRuntimeDeliveryRecoveryPageReceiptV1,
  checkpoint: string | null,
): {
  readonly attempts: StewardRuntimeDeliveryRecoveryPageReceiptV1['attempts'];
  readonly nextCursor: string | null;
} {
  if (
    new Set(receipt.attempts.map(({ id }) => id)).size
      !== receipt.attempts.length
  ) {
    throw new Error('GitHub delivery page contains duplicate attempt IDs.');
  }
  for (let index = 1; index < receipt.attempts.length; index += 1) {
    const previous = receipt.attempts[index - 1]!;
    const current = receipt.attempts[index]!;
    if (
      current.deliveredAt > previous.deliveredAt
      || (
        current.deliveredAt === previous.deliveredAt
        && current.id >= previous.id
      )
    ) {
      throw new Error(
        'GitHub delivery attempts are not in strict descending order.',
      );
    }
  }
  if (checkpoint === null) {
    return {
      attempts: receipt.attempts,
      nextCursor: receipt.nextCursor,
    };
  }
  const inclusiveCheckpoint = floorToProviderSecond(checkpoint);
  const attempts = receipt.attempts.filter(
    ({ deliveredAt }) => deliveredAt >= inclusiveCheckpoint,
  );
  const crossedCheckpoint = receipt.attempts.some(
    ({ deliveredAt }) => deliveredAt < inclusiveCheckpoint,
  );
  return {
    attempts,
    nextCursor: crossedCheckpoint ? null : receipt.nextCursor,
  };
}

async function recoverGitHubDeliveries(
  command: RecoverGitHubDeliveriesCommand,
  accessServiceClientId: string,
  env: DeliveryRecoveryEnv,
  dependencies: DeliveryRecoveryDependencies,
  parentSignal: AbortSignal,
): Promise<Response> {
  const operationSignal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(recoveryOperationBudgetMs),
  ]);
  const stub = ledger(env);
  const initial = await stub.inspectGitHubScan();
  const scanId = await scanIdForCommand(command);
  const scanStartedAt = floorToProviderSecond(dependencies.now());
  const leaseExpiresAt = addMilliseconds(
    scanStartedAt,
    maximumGitHubDeliveryScanLeaseMs,
  );
  const providerWindowStart = addMilliseconds(
    scanStartedAt,
    -maximumGitHubProviderCoverageWindowMs,
  );
  let scan: GitHubDeliveryScanBeginResult;
  try {
    scan = await stub.beginGitHubScan({
      commandId: command.requestId,
      scanId,
      principal: { accessServiceClientId },
      requestedAt: command.requestedAt,
      scanStartedAt,
      leaseExpiresAt,
      coverageMode: command.coverageMode,
      providerWindowStart,
      takeover: command.takeover,
      expectedLedgerRevision: initial.ledgerRevision,
    });
  } catch (error) {
    return githubScanConflictResponse(error, command.requestId);
  }
  if (scan.status === 'superseded') {
    return jsonResponse(409, {
      error: 'github-delivery-scan-superseded',
      requestId: command.requestId,
      generation: scan.generation,
      scanId: scan.scanId,
    });
  }
  if (
    scan.status !== 'completed'
    && dependencies.now().getTime() >= Date.parse(scan.leaseExpiresAt)
  ) {
    return jsonResponse(409, {
      error: 'github-delivery-scan-takeover-required',
      requestId: command.requestId,
      generation: scan.generation,
      scanId: scan.scanId,
      leaseExpiresAt: scan.leaseExpiresAt,
    });
  }

  let pagesProcessed = 0;
  let cursor = scan.cursor;
  let scanCompleted = scan.status === 'completed';
  if (!scanCompleted && cursor === null && scan.pageCount > 0) {
    try {
      await stub.completeGitHubScan({
        generation: scan.generation,
        scanId: scan.scanId,
        completedAt: canonicalTimestamp(dependencies.now()),
      });
      scanCompleted = true;
    } catch (error) {
      return githubScanConflictResponse(error, command.requestId);
    }
  }
  if (!scanCompleted) {
    while (pagesProcessed < maximumGitHubPagesPerInvocation) {
      if (operationSignal.aborted) {
        return jsonResponse(202, {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          state: 'scan-continuation-required',
          generation: scan.generation,
          scanId: scan.scanId,
          pagesProcessed,
          cursor,
          leaseExpiresAt: scan.leaseExpiresAt,
          coverage: scan.coverage,
        });
      }
      if (
        dependencies.now().getTime() >= Date.parse(scan.leaseExpiresAt)
      ) {
        return jsonResponse(409, {
          error: 'github-delivery-scan-takeover-required',
          requestId: command.requestId,
          generation: scan.generation,
          scanId: scan.scanId,
          leaseExpiresAt: scan.leaseExpiresAt,
        });
      }
      const pageRequest =
        buildStewardRuntimeDeliveryRecoveryPageRequestV1({
          scanId: scan.scanId,
          cursor,
          expectedControlRevision: command.expectedControlRevision,
        });
      const pageBody =
        canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(
          pageRequest,
        );
      const control = await invokeRecoveryControl(
        '/v1/delivery-recovery/github/page',
        pageBody,
        command.expectedControlRevision,
        env,
        dependencies.now(),
        operationSignal,
      );
      if (control.status === 'rate-limited') {
        return rateLimitedResponse(control.retryAfter);
      }
      if (control.status === 'revision-conflict') {
        return jsonResponse(409, {
          error: 'github-delivery-control-revision-conflict',
        });
      }
      if (control.status === 'rejected') {
        return jsonResponse(422, {
          error: 'github-delivery-scan-rejected',
          controlStatus: control.controlStatus,
        });
      }
      if (control.status === 'capability-denied') {
        return jsonResponse(503, {
          error: 'recovery-control-capability-denied',
        });
      }
      if (control.status === 'deferred') {
        return jsonResponse(503, {
          error: 'github-delivery-scan-unavailable',
        });
      }
      if (control.status === 'unknown') {
        return jsonResponse(503, {
          error: 'github-delivery-scan-unavailable',
        });
      }
      let receipt: StewardRuntimeDeliveryRecoveryPageReceiptV1;
      try {
        receipt = parseStewardRuntimeDeliveryRecoveryPageReceiptV1(
          await readBoundedResponseJson(
            control.response,
            control.signal,
          ),
        );
      } catch {
        return jsonResponse(503, {
          error: 'github-delivery-scan-unavailable',
        });
      }
      if (
        control.response.status !== 200
        || receipt.scanId !== scan.scanId
        || receipt.cursor !== cursor
        || !sameControlRevision(
          receipt.controlRevision,
          command.expectedControlRevision,
        )
      ) {
        return jsonResponse(503, {
          error: 'github-delivery-scan-unavailable',
        });
      }
      const bounded = attemptsAfterCheckpoint(
        receipt,
        scan.checkpointBefore !== null
          && scan.checkpointBefore >= scan.coverage.providerWindowStart
          ? scan.checkpointBefore
          : scan.coverage.providerWindowStart,
      );
      const pageRecordedAt = dependencies.now();
      if (
        pageRecordedAt.getTime() >= Date.parse(scan.leaseExpiresAt)
      ) {
        return jsonResponse(409, {
          error: 'github-delivery-scan-takeover-required',
          requestId: command.requestId,
          generation: scan.generation,
          scanId: scan.scanId,
          leaseExpiresAt: scan.leaseExpiresAt,
        });
      }
      let page: GitHubDeliveryScanPageResult;
      try {
        page = await stub.recordGitHubScanPage({
          generation: scan.generation,
          scanId: scan.scanId,
          cursor,
          nextCursor: bounded.nextCursor,
          attempts: bounded.attempts.map((attempt) => ({
            attemptId: attempt.id,
            guid: attempt.guid,
            deliveredAt: attempt.deliveredAt,
            status: attempt.status,
            redelivery: attempt.redelivery,
          })),
          recordedAt: canonicalTimestamp(pageRecordedAt),
          leaseExpiresAt: scan.leaseExpiresAt,
        });
      } catch (error) {
        return githubScanConflictResponse(error, command.requestId);
      }
      pagesProcessed += 1;
      cursor = page.nextCursor;
      if (cursor === null) {
        try {
          await stub.completeGitHubScan({
            generation: scan.generation,
            scanId: scan.scanId,
            completedAt: canonicalTimestamp(dependencies.now()),
          });
        } catch (error) {
          return githubScanConflictResponse(error, command.requestId);
        }
        scanCompleted = true;
        break;
      }
    }
    if (cursor !== null) {
      return jsonResponse(202, {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        state: 'scan-continuation-required',
        generation: scan.generation,
        scanId: scan.scanId,
        pagesProcessed,
        cursor,
        leaseExpiresAt: scan.leaseExpiresAt,
        coverage: scan.coverage,
      });
    }
  }

  let redeliveriesAccepted = 0;
  while (
    redeliveriesAccepted < maximumGitHubRedeliveriesPerInvocation
  ) {
    if (operationSignal.aborted) {
      const inspection = await stub.inspectGitHubScan();
      return jsonResponse(202, {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        state: 'redelivery-continuation-required',
        generation: scan.generation,
        scanId: scan.scanId,
        pagesProcessed,
        redeliveriesAccepted,
        unresolvedRedeliveryIntents:
          inspection.unresolvedRedeliveryIntents,
        ledgerRevision: inspection.ledgerRevision,
        coverage: scan.coverage,
      });
    }
    const next = await stub.nextGitHubRedelivery({
      generation: scan.generation,
      scanId: scan.scanId,
      preparedAt: canonicalTimestamp(dependencies.now()),
    });
    if (next.status === 'complete') {
      const inspection = await stub.inspectGitHubScan();
      const hasCoverageGap = scan.coverage.status === 'retention-gap';
      return jsonResponse(200, {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        state: hasCoverageGap
          ? 'complete-with-retention-gap'
          : 'complete',
        actionRequired: hasCoverageGap,
        generation: scan.generation,
        scanId: scan.scanId,
        pagesProcessed,
        redeliveriesAccepted,
        unresolvedRedeliveryIntents:
          inspection.unresolvedRedeliveryIntents,
        ledgerRevision: inspection.ledgerRevision,
        coverage: scan.coverage,
      });
    }
    if (next.status === 'deferred') {
      const response = jsonResponse(202, {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        state: 'redelivery-deferred',
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        reason: next.reason,
        retryAfter: next.retryAfter,
      });
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (Date.parse(next.retryAfter) - dependencies.now().getTime())
          / 1_000,
        ),
      );
      response.headers.set('retry-after', String(retryAfterSeconds));
      return response;
    }
    if (next.status === 'unresolved') {
      const actionRequired = next.counts.rejected > 0;
      return jsonResponse(actionRequired ? 409 : 202, {
        schemaVersion: 1,
        operation: command.operation,
        state: actionRequired
          ? 'redelivery-action-required'
          : 'redelivery-awaiting-observation',
        error: actionRequired
          ? 'github-redelivery-reconciliation-required'
          : undefined,
        requestId: command.requestId,
        generation: scan.generation,
        scanId: scan.scanId,
        counts: next.counts,
        ledgerRevision: next.ledgerRevision,
        coverage: scan.coverage,
      });
    }

    const redeliveryRequest =
      buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
        scanId: scan.scanId,
        intentId: next.intentId,
        attemptId: next.deliveryAttemptId,
        guid: next.guid,
        expectedControlRevision: command.expectedControlRevision,
      });
    const redeliveryBody =
      canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(
        redeliveryRequest,
      );
    const control = await invokeRecoveryControl(
      '/v1/delivery-recovery/github/redeliver',
      redeliveryBody,
      command.expectedControlRevision,
      env,
      dependencies.now(),
      operationSignal,
    );
    if (control.status === 'rate-limited') {
      const recordedAt = dependencies.now();
      await stub.recordGitHubRedeliveryDeferred({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(recordedAt),
        reason: 'rate-limited',
        retryAfter: deferredRetryAfter(
          recordedAt,
          control.retryAfter,
        ),
      });
      return rateLimitedResponse(control.retryAfter);
    }
    if (control.status === 'revision-conflict') {
      const recordedAt = dependencies.now();
      await stub.recordGitHubRedeliveryDeferred({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(recordedAt),
        reason: 'control-revision-conflict',
        retryAfter: deferredRetryAfter(recordedAt, null),
      });
      return jsonResponse(409, {
        error: 'github-redelivery-control-revision-conflict',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    if (control.status === 'rejected') {
      await stub.recordGitHubRedeliveryRejected({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(dependencies.now()),
        reason: control.controlStatus === 400
          ? 'invalid-request'
          : 'provider-rejected',
      });
      return jsonResponse(422, {
        error: 'github-redelivery-rejected',
        requestId: command.requestId,
        intentId: next.intentId,
        controlStatus: control.controlStatus,
      });
    }
    if (control.status === 'deferred') {
      const recordedAt = dependencies.now();
      await stub.recordGitHubRedeliveryDeferred({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(recordedAt),
        reason: control.reason,
        retryAfter: deferredRetryAfter(recordedAt, null),
      });
      return jsonResponse(503, {
        error: 'github-redelivery-control-unavailable',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    if (control.status === 'capability-denied') {
      const recordedAt = dependencies.now();
      await stub.recordGitHubRedeliveryDeferred({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(recordedAt),
        reason: 'control-unavailable',
        retryAfter: deferredRetryAfter(recordedAt, null),
      });
      return jsonResponse(503, {
        error: 'recovery-control-capability-denied',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    if (control.status === 'unknown') {
      await stub.recordGitHubRedeliveryUnknown({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(dependencies.now()),
      });
      return jsonResponse(503, {
        error: 'github-redelivery-result-unknown',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    let accepted;
    try {
      accepted = parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
        await readBoundedResponseJson(
          control.response,
          control.signal,
        ),
      );
    } catch {
      await stub.recordGitHubRedeliveryUnknown({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(dependencies.now()),
      });
      return jsonResponse(503, {
        error: 'github-redelivery-result-unknown',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    if (
      control.response.status !== 202
      || accepted.scanId !== scan.scanId
      || accepted.intentId !== next.intentId
      || accepted.attemptId !== next.deliveryAttemptId
      || accepted.guid !== next.guid
      || !sameControlRevision(
        accepted.controlRevision,
        command.expectedControlRevision,
      )
    ) {
      await stub.recordGitHubRedeliveryUnknown({
        generation: scan.generation,
        scanId: scan.scanId,
        intentId: next.intentId,
        recordedAt: canonicalTimestamp(dependencies.now()),
      });
      return jsonResponse(503, {
        error: 'github-redelivery-result-unknown',
        requestId: command.requestId,
        intentId: next.intentId,
      });
    }
    await stub.recordGitHubRedeliveryAccepted({
      generation: scan.generation,
      scanId: scan.scanId,
      intentId: next.intentId,
      recordedAt: canonicalTimestamp(dependencies.now()),
    });
    redeliveriesAccepted += 1;
  }
  const inspection = await stub.inspectGitHubScan();
  return jsonResponse(202, {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    state: 'redelivery-continuation-required',
    generation: scan.generation,
    scanId: scan.scanId,
    pagesProcessed,
    redeliveriesAccepted,
    unresolvedRedeliveryIntents:
      inspection.unresolvedRedeliveryIntents,
    ledgerRevision: inspection.ledgerRevision,
    coverage: scan.coverage,
  });
}

async function enqueueInstallationIndexBootstrap(
  command: StewardRuntimeInstallationIndexBootstrapCommandV1,
  accessServiceClientId: string,
  env: DeliveryRecoveryEnv,
): Promise<Response> {
  const envelope =
    buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
      command,
      accessServiceClientId,
    });
  const commandDigest =
    await deriveStewardRuntimeInstallationIndexBootstrapDigest(envelope);
  try {
    await env.EVENT_QUEUE.send(
      canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
        envelope,
      ),
      { contentType: 'text' },
    );
  } catch {
    return jsonResponse(503, {
      error: 'installation-index-bootstrap-enqueue-unknown',
      requestId: command.requestId,
      commandDigest,
    });
  }
  return jsonResponse(202, {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    commandDigest,
    status: 'enqueued',
  });
}

async function inspectInstallationIndexBootstrap(
  command: StewardRuntimeInstallationIndexBootstrapStatusCommandV1,
  accessServiceClientId: string,
  env: DeliveryRecoveryEnv,
  parentSignal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    if (env.COORDINATOR === undefined) {
      throw new Error('Coordinator binding is unavailable.');
    }
    response = await env.COORDINATOR.fetch(
      'https://coordinator.internal/v1/installation-index-bootstrap/status',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-steward-internal-protocol':
            'installation-index-bootstrap-status-1',
        },
        signal: AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(recoveryControlCallTimeoutMs),
        ]),
        body: JSON.stringify({
          schemaVersion: 1,
          operation: 'installation-index-bootstrap-status',
          bootstrapRequestId: command.bootstrapRequestId,
          installationId: command.installationId,
          expectedBootstrapDigest: command.expectedBootstrapDigest,
          principal: { accessServiceClientId },
        }),
      },
    );
  } catch {
    return jsonResponse(503, {
      error: 'installation-index-bootstrap-status-unavailable',
      requestId: command.requestId,
    });
  }
  if (response.status === 404) {
    return jsonResponse(404, {
      error: 'installation-index-bootstrap-not-found',
      requestId: command.requestId,
    });
  }
  if (response.status === 409) {
    return jsonResponse(409, {
      error: 'installation-index-bootstrap-status-conflict',
      requestId: command.requestId,
    });
  }
  if (!response.ok) {
    return jsonResponse(503, {
      error: 'installation-index-bootstrap-status-unavailable',
      requestId: command.requestId,
    });
  }
  try {
    const receipt =
      parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1(
        await readBoundedResponseJson(response, parentSignal),
      );
    return new Response(
      canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json(
        receipt,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  } catch {
    return jsonResponse(503, {
      error: 'installation-index-bootstrap-status-unavailable',
      requestId: command.requestId,
    });
  }
}

async function handleCommand(
  command: DeliveryRecoveryCommand,
  accessServiceClientId: string,
  env: DeliveryRecoveryEnv,
  dependencies: DeliveryRecoveryDependencies,
  parentSignal: AbortSignal,
): Promise<Response> {
  if (command.operation === 'installation-index-bootstrap') {
    return await enqueueInstallationIndexBootstrap(
      command,
      accessServiceClientId,
      env,
    );
  }
  if (command.operation === 'inspect-installation-index-bootstrap') {
    return await inspectInstallationIndexBootstrap(
      command,
      accessServiceClientId,
      env,
      parentSignal,
    );
  }
  if (command.operation === 'inspect') {
    const stub = ledger(env);
    const [deadLetters, github] = await Promise.all([
      stub.inspect(100),
      stub.inspectGitHubScan(),
    ]);
    return jsonResponse(200, {
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      deadLetters,
      github,
    });
  }
  if (command.operation === 'replay-dlq') {
    return await replayDeadLetters(
      command,
      accessServiceClientId,
      env,
      dependencies,
    );
  }
  return await recoverGitHubDeliveries(
    command,
    accessServiceClientId,
    env,
    dependencies,
    parentSignal,
  );
}

const defaultDependencies: DeliveryRecoveryDependencies = {
  now: () => new Date(),
  verifyAccess: (request, env) =>
    verifyCloudflareAccessPrincipal(request, env),
};

export function createDeliveryRecoveryHandler(
  dependencies: DeliveryRecoveryDependencies = defaultDependencies,
): DeliveryRecoveryHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (
        url.pathname !== recoveryPath
        || url.search !== ''
        || request.method !== 'POST'
      ) {
        return new Response('Not Found', { status: 404 });
      }

      const access = await dependencies.verifyAccess(request, env);
      if (access.decision !== 'authorized') {
        return jsonResponse(
          access.decision === 'denied' ? 403 : 503,
          {
            error: access.decision === 'denied'
              ? 'access-denied'
              : 'delivery-recovery-unavailable',
          },
        );
      }
      if (!contentTypeIsJson(request)) {
        return jsonResponse(415, { error: 'application-json-required' });
      }

      let command: DeliveryRecoveryCommand;
      try {
        command = parseDeliveryRecoveryCommand(
          await readBoundedJson(
            request,
            maximumDeliveryRecoveryRequestBytes,
          ),
        );
        assertFreshDeliveryRecoveryCommand(command, dependencies.now());
      } catch (error) {
        return jsonResponse(
          error instanceof RecoveryRequestError
            && error.code === 'too-large'
            ? 413
            : 400,
          {
            error: error instanceof RecoveryRequestError
              && error.code === 'too-large'
              ? 'request-too-large'
              : 'invalid-delivery-recovery-command',
          },
        );
      }

      try {
        return await handleCommand(
          command,
          access.principal.clientId,
          env,
          dependencies,
          request.signal,
        );
      } catch {
        return jsonResponse(503, {
          error: 'delivery-recovery-unavailable',
        });
      }
    },

    async queue(batch, env) {
      if (batch.queue !== expectedDeadLetterQueue) {
        for (const message of batch.messages) {
          message.retry({ delaySeconds: 60 });
        }
        return;
      }
      const stub = ledger(env);
      for (const message of batch.messages) {
        try {
          const classified = await classifyDeadLetterBody(message.body);
          await stub.captureDlq({
            ...classified,
            sourceQueue: batch.queue,
            sourceMessageId: message.id,
            sourceTimestamp: canonicalTimestamp(message.timestamp),
            attempts: message.attempts,
            capturedAt: canonicalTimestamp(dependencies.now()),
          });
          message.ack();
        } catch {
          message.retry({
            delaySeconds: Math.min(
              900,
              Math.max(15, 2 ** Math.min(9, message.attempts)),
            ),
          });
        }
      }
    },
  };
}

export default createDeliveryRecoveryHandler();
