import {
  buildStewardRuntimeRepositoryFanoutPageRequestV1,
  buildStewardRuntimeRepositoryFanoutPageRequestV2,
  buildStewardRuntimeRepositoryFanoutPageRequestV3,
  buildStewardRuntimeInstallationFanoutPageRequestV1,
  buildStewardRuntimeInstallationIndexBootstrapPageRequestV1,
  buildStewardRuntimeInstallationRepositoryChildV1,
  buildStewardRuntimeControlRequest,
  buildStewardRuntimeWorkItemV3,
  buildStewardRuntimeWorkItemV4,
  buildStewardRuntimeWorkItemV5,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV2Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json,
  canonicalStewardRuntimeInstallationFanoutPageRequestV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json,
  canonicalStewardRuntimeInstallationFanoutRootV1Json,
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeControlRequestJson,
  canonicalStewardRuntimeWorkItemJson,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  parseStewardRuntimeRepositoryFanoutPageReceiptV1,
  parseStewardRuntimeRepositoryFanoutPageReceiptV2,
  parseStewardRuntimeRepositoryFanoutPageReceiptV3,
  parseStewardRuntimeInstallationFanoutPageReceiptV1,
  parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  parseStewardRuntimeInstallationFanoutRootV1,
  parseStewardRuntimeInstallationRepositoryChildV1,
  parseStewardRuntimeScopeWorkItem,
  parseStewardRuntimeControlMutationReceiptV2,
  parseStewardRuntimeControlPreparedReceiptV2,
  parseStewardRuntimeControlRecoveryReceiptV2,
  parseStewardRuntimeControlReceipt,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeControlMutationReceiptV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlRecoveryReceiptV2,
  type StewardRuntimeControlReceiptV1,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeRepositoryFanoutPageReceiptV1,
  type StewardRuntimeRepositoryFanoutPageReceiptV2,
  type StewardRuntimeRepositoryFanoutPageReceiptV3,
  type StewardRuntimeInstallationFanoutPageReceiptV1,
  type StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  type StewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  type StewardRuntimeInstallationFanoutRootV1,
  type StewardRuntimeInstallationRepositoryChildV1,
  type StewardRuntimeScopeWorkItemV2,
  type StewardRuntimeWorkItem,
} from '../../core/src/index.js';
import {
  pullRequestCoordinatorName,
  type CoordinatorClaimResult,
  type CoordinatorCompleteResult,
  type CoordinatorFailResult,
  type CoordinatorFailureCode,
} from './contracts.js';
import {
  repositoryFanoutCoordinatorName,
  repositoryFanoutMaximumDispatchBatchSize,
  type RepositoryFanoutClaimResult,
  type RepositoryFanoutCompleteResult,
  type RepositoryFanoutFailResult,
  type RepositoryFanoutFailureCode,
  type RepositoryFanoutNextDispatchBatchResult,
  type RepositoryFanoutRecordPageResult,
  type RepositoryFanoutRecordQueueConfirmedResult,
  type RepositoryFanoutReleaseForContinuationResult,
  type RepositoryFanoutScopeWorkItem,
  type RepositoryFanoutInput,
} from './repository-fanout-contracts.js';
import {
  installationFanoutCoordinatorName,
  installationFanoutMaximumDispatchBatchSize,
  type InstallationFanoutClaimResult,
  type InstallationFanoutCompleteResult,
  type InstallationFanoutFailResult,
  type InstallationFanoutFailureCode,
  type InstallationFanoutNextDispatchBatchResult,
  type InstallationFanoutRecordPageResult,
  type InstallationFanoutRecordQueueConfirmedResult,
  type InstallationFanoutReleaseForContinuationResult,
  type InstallationIndexBootstrapClaimResult,
  type InstallationIndexBootstrapFailResult,
  type InstallationIndexBootstrapFinalizeResult,
  type InstallationIndexBootstrapRecordPageResult,
  type InstallationIndexBootstrapReleaseResult,
} from './installation-fanout-contracts.js';
import {
  CoordinatorV2InvocationError,
  runControlV2Generation,
  type PullRequestCoordinatorV2Stub,
} from './v2-runner.js';

export const coordinatorLeaseDurationMs = 120_000;
export const coordinatorControlTimeoutMs = 90_000;
export const coordinatorMaximumImmediateFollowups = 8;
export const coordinatorMaximumControlResponseBytes = 128_000;
export const coordinatorMaximumQueueMessageBytes = 127_000;
// Cloudflare's 256 KB batch ceiling also includes per-message metadata.
// Reserve more than the documented ~100 bytes for every 100-message batch.
export const coordinatorMaximumQueueBatchBytes = 240_000;
export const controlWorkerName = 'steward-control';
const installationIndexBootstrapStatusPath =
  '/v1/installation-index-bootstrap/status';
const installationIndexBootstrapStatusProtocol =
  'installation-index-bootstrap-status-1';

const versionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PullRequestCoordinatorStub
  extends PullRequestCoordinatorV2Stub {
  claim(deliveryId: string, leaseDurationMs: number): Promise<CoordinatorClaimResult>;
  complete(generation: number, leaseToken: string): Promise<CoordinatorCompleteResult>;
}

export interface PullRequestCoordinatorNamespace {
  getByName(name: string): PullRequestCoordinatorStub;
}

export interface RepositoryFanoutCoordinatorStub {
  claim(
    scopeWorkItem: unknown,
    leaseDurationMs: number,
  ): Promise<RepositoryFanoutClaimResult>;
  recordPage(
    generation: number,
    leaseToken: string,
    receipt: unknown,
  ): Promise<RepositoryFanoutRecordPageResult>;
  nextDispatchBatch(
    generation: number,
    leaseToken: string,
    limit?: number,
  ): Promise<RepositoryFanoutNextDispatchBatchResult>;
  recordQueueConfirmed(
    generation: number,
    leaseToken: string,
    confirmations: unknown,
  ): Promise<RepositoryFanoutRecordQueueConfirmedResult>;
  complete(
    generation: number,
    leaseToken: string,
  ): Promise<RepositoryFanoutCompleteResult>;
  fail(
    generation: number,
    leaseToken: string,
    failureCode: RepositoryFanoutFailureCode,
  ): Promise<RepositoryFanoutFailResult>;
  releaseForContinuation(
    generation: number,
    leaseToken: string,
  ): Promise<RepositoryFanoutReleaseForContinuationResult>;
}

export interface RepositoryFanoutCoordinatorNamespace {
  getByName(name: string): RepositoryFanoutCoordinatorStub;
}

export interface InstallationFanoutCoordinatorStub {
  claimIndexBootstrap(
    command: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationIndexBootstrapClaimResult>;
  recordIndexBootstrapPage(
    leaseToken: string,
    receipt: unknown,
  ): Promise<InstallationIndexBootstrapRecordPageResult>;
  finalizeIndexBootstrap(
    leaseToken: string,
  ): Promise<InstallationIndexBootstrapFinalizeResult>;
  releaseIndexBootstrap(
    leaseToken: string,
  ): Promise<InstallationIndexBootstrapReleaseResult>;
  failIndexBootstrap(
    leaseToken: string,
    failureCode:
      | 'control-revision-conflict'
      | 'runtime-error',
  ): Promise<InstallationIndexBootstrapFailResult>;
  inspectIndexBootstrap(
    requestId: string,
    commandDigest: string,
    principalClientId: string,
  ): Promise<
    import('../../core/src/index.js')
      .StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 | null
  >;
  claim(
    root: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationFanoutClaimResult>;
  recordPage(
    generation: number,
    leaseToken: string,
    receipt: unknown,
  ): Promise<InstallationFanoutRecordPageResult>;
  nextDispatchBatch(
    generation: number,
    leaseToken: string,
    limit?: number,
  ): Promise<InstallationFanoutNextDispatchBatchResult>;
  recordQueueConfirmed(
    generation: number,
    leaseToken: string,
    confirmations: unknown,
  ): Promise<InstallationFanoutRecordQueueConfirmedResult>;
  complete(
    generation: number,
    leaseToken: string,
  ): Promise<InstallationFanoutCompleteResult>;
  fail(
    generation: number,
    leaseToken: string,
    failureCode: InstallationFanoutFailureCode,
  ): Promise<InstallationFanoutFailResult>;
  releaseForContinuation(
    generation: number,
    leaseToken: string,
  ): Promise<InstallationFanoutReleaseForContinuationResult>;
}

export interface InstallationFanoutCoordinatorNamespace {
  getByName(name: string): InstallationFanoutCoordinatorStub;
}

export interface ControlService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface CoordinatorWakeupQueue {
  send(
    body: string,
    options?: { readonly contentType?: 'text' },
  ): Promise<unknown>;
  sendBatch(
    messages: readonly {
      readonly body: string;
      readonly contentType?: 'text';
    }[],
  ): Promise<unknown>;
}

export interface CoordinatorEnv {
  readonly PR_COORDINATOR: PullRequestCoordinatorNamespace;
  readonly REPOSITORY_FANOUT_COORDINATOR:
    RepositoryFanoutCoordinatorNamespace;
  readonly INSTALLATION_FANOUT_COORDINATOR:
    InstallationFanoutCoordinatorNamespace;
  readonly CONTROL: ControlService;
  readonly EVENT_QUEUE: CoordinatorWakeupQueue;
  readonly CONTROL_CANDIDATE_REPOSITORY_IDS?: string;
  readonly CONTROL_CANDIDATE_VERSION_ID?: string;
}

export interface CoordinatorQueueMessage {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface CoordinatorMessageBatch {
  readonly queue: string;
  readonly messages: readonly CoordinatorQueueMessage[];
}

export interface CoordinatorHandler {
  fetch(request: Request, env: CoordinatorEnv): Promise<Response>;
  queue(batch: CoordinatorMessageBatch, env: CoordinatorEnv): Promise<void>;
}

class ControlInvocationError extends Error {
  constructor(
    readonly failureCode: CoordinatorFailureCode,
    readonly retryDelaySeconds: number,
  ) {
    super('Private Control invocation failed');
    this.name = 'ControlInvocationError';
  }
}

class RepositoryFanoutInvocationError extends Error {
  constructor(
    readonly failureCode: RepositoryFanoutFailureCode,
    readonly retryDelaySeconds: number,
  ) {
    super('Private repository fan-out Control invocation failed');
    this.name = 'RepositoryFanoutInvocationError';
  }
}

class InstallationFanoutInvocationError extends Error {
  constructor(
    readonly failureCode: InstallationFanoutFailureCode,
    readonly retryDelaySeconds: number,
  ) {
    super('Private installation fan-out Control invocation failed');
    this.name = 'InstallationFanoutInvocationError';
  }
}

function boundedRetryDelaySeconds(attempts: number): number {
  const normalized = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(60, 2 ** Math.min(6, normalized - 1));
}

function leaseRetryDelaySeconds(expiresAt: number): number {
  if (!Number.isSafeInteger(expiresAt)) return 1;
  return Math.max(1, Math.min(900, Math.ceil((expiresAt - Date.now()) / 1_000)));
}

function candidateRepositoryIds(raw: string | undefined): ReadonlySet<number> {
  if (raw === undefined || raw === '') return new Set();
  if (raw !== raw.trim()) throw new Error('candidate-repository-ids-invalid');
  const ids = raw.split(',');
  if (ids.length > 1_000 || ids.some((value) => !/^[1-9]\d*$/.test(value))) {
    throw new Error('candidate-repository-ids-invalid');
  }
  const parsed = ids.map(Number);
  if (parsed.some((value) => !Number.isSafeInteger(value))) {
    throw new Error('candidate-repository-ids-invalid');
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('candidate-repository-ids-invalid');
  }
  return new Set(parsed);
}

function selectedControlVersionForRepositoryId(
  repositoryId: number,
  env: CoordinatorEnv,
): string | undefined {
  const repositoryIds = candidateRepositoryIds(
    env.CONTROL_CANDIDATE_REPOSITORY_IDS,
  );
  if (!repositoryIds.has(repositoryId)) return undefined;
  const versionId = env.CONTROL_CANDIDATE_VERSION_ID;
  if (versionId === undefined || !versionIdPattern.test(versionId)) {
    throw new Error('candidate-version-invalid');
  }
  return versionId;
}

function selectedControlVersion(
  workItem: StewardRuntimeWorkItem,
  env: CoordinatorEnv,
): string | undefined {
  return selectedControlVersionForRepositoryId(
    workItem.subject.repositoryId,
    env,
  );
}

function parseRetryAfter(response: Response, fallback: number): number {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^(?:0|[1-9]\d*)$/.test(raw)) return fallback;
  return Math.max(0, Math.min(900, Number(raw)));
}

function responseContentTypeIsJson(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType !== null
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function parseInstallationIndexBootstrapStatusRequest(value: unknown): {
  readonly bootstrapRequestId: string;
  readonly installationId: number;
  readonly expectedBootstrapDigest: string;
  readonly principalClientId: string;
} {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError('Bootstrap status request must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'schemaVersion',
    'operation',
    'bootstrapRequestId',
    'installationId',
    'expectedBootstrapDigest',
    'principal',
  ];
  if (
    Reflect.ownKeys(record).length !== expected.length
    || Reflect.ownKeys(record).some(
      (key) => typeof key !== 'string' || !expected.includes(key),
    )
    || record.schemaVersion !== 1
    || record.operation !== 'installation-index-bootstrap-status'
    || typeof record.bootstrapRequestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(record.bootstrapRequestId)
    || !Number.isSafeInteger(record.installationId)
    || Number(record.installationId) <= 0
    || typeof record.expectedBootstrapDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.expectedBootstrapDigest)
  ) {
    throw new TypeError('Bootstrap status request is invalid.');
  }
  const principal = record.principal;
  if (
    principal === null
    || typeof principal !== 'object'
    || Array.isArray(principal)
    || Reflect.ownKeys(principal).length !== 1
    || !Object.prototype.hasOwnProperty.call(
      principal,
      'accessServiceClientId',
    )
  ) {
    throw new TypeError('Bootstrap status principal is invalid.');
  }
  const principalClientId =
    (principal as Record<string, unknown>).accessServiceClientId;
  if (
    typeof principalClientId !== 'string'
    || principalClientId.length < 1
    || principalClientId.length > 256
    || principalClientId !== principalClientId.trim()
    || !/^[\x21-\x7e]+$/.test(principalClientId)
  ) {
    throw new TypeError('Bootstrap status principal is invalid.');
  }
  return {
    bootstrapRequestId: record.bootstrapRequestId,
    installationId: Number(record.installationId),
    expectedBootstrapDigest: record.expectedBootstrapDigest,
    principalClientId,
  };
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('control-response-empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > coordinatorMaximumControlResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('control-response-too-large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
}

function receiptMatchesRequest(
  receipt: StewardRuntimeControlReceiptV1,
  workItem: StewardRuntimeWorkItem,
  generation: number,
): boolean {
  return receipt.deliveryId === workItem.cause.deliveryId
    && receipt.generation === generation
    && receipt.subject.repositoryId === workItem.subject.repositoryId
    && receipt.subject.repositoryFullName === workItem.subject.repositoryFullName
    && receipt.subject.pullRequestNumber === workItem.subject.pullRequestNumber;
}

async function invokeControlV1(
  workItem: StewardRuntimeWorkItem,
  generation: number,
  env: CoordinatorEnv,
  attempts: number,
): Promise<StewardRuntimeControlReceiptV1> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let expectedVersion: string | undefined;
  try {
    expectedVersion = selectedControlVersion(workItem, env);
  } catch {
    throw new ControlInvocationError('runtime-error', fallbackDelay);
  }

  const headers = new Headers({
    'content-type': 'application/json',
    'x-steward-internal-protocol': '1',
  });
  if (expectedVersion !== undefined) {
    headers.set(
      'cloudflare-workers-version-overrides',
      `${controlWorkerName}="${expectedVersion}"`,
    );
  }

  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v1/reconcile',
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(coordinatorControlTimeoutMs),
        body: canonicalStewardRuntimeControlRequestJson(
          buildStewardRuntimeControlRequest({ workItem, generation }),
        ),
      },
    );
  } catch {
    throw new ControlInvocationError('dependency-unavailable', fallbackDelay);
  }

  if (!response.ok) {
    const delay = response.status === 429
      ? parseRetryAfter(response, fallbackDelay)
      : fallbackDelay;
    throw new ControlInvocationError(
      response.status === 429
        ? 'rate-limited'
        : response.status >= 500
          ? 'dependency-unavailable'
          : 'control-error',
      delay,
    );
  }
  if (!responseContentTypeIsJson(response)) {
    throw new ControlInvocationError('control-error', fallbackDelay);
  }

  let receipt: StewardRuntimeControlReceiptV1;
  try {
    receipt = parseStewardRuntimeControlReceipt(
      await readBoundedResponseJson(response),
    );
  } catch {
    throw new ControlInvocationError('control-error', fallbackDelay);
  }
  if (!receiptMatchesRequest(receipt, workItem, generation)) {
    throw new ControlInvocationError('control-error', fallbackDelay);
  }
  if (
    expectedVersion !== undefined
    && receipt.controlRevision.workerVersionId !== expectedVersion
  ) {
    // Invalid overrides silently fall back to percentage routing. The receipt
    // is therefore the authority, and a mismatch must never be acknowledged.
    throw new ControlInvocationError('control-error', fallbackDelay);
  }
  return receipt;
}

function controlHeaders(
  protocol:
    | '1'
    | '2'
    | 'installation-fanout-1'
    | 'installation-index-bootstrap-1'
    | 'repository-fanout-1'
    | 'repository-fanout-2'
    | 'repository-fanout-3',
  expectedVersion: string | undefined,
): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-steward-internal-protocol': protocol,
  });
  if (expectedVersion !== undefined) {
    if (!versionIdPattern.test(expectedVersion)) {
      throw new Error('control-version-invalid');
    }
    headers.set(
      'cloudflare-workers-version-overrides',
      `${controlWorkerName}="${expectedVersion}"`,
    );
  }
  return headers;
}

async function invokeControlV2<
  Receipt extends {
    readonly controlRevision: StewardRuntimeControlRevisionV1;
  },
>(
  body: string,
  parseReceipt: (value: unknown) => Promise<Receipt>,
  expectedVersion: string | undefined,
  env: CoordinatorEnv,
  attempts: number,
): Promise<Receipt> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let headers: Headers;
  try {
    headers = controlHeaders('2', expectedVersion);
  } catch {
    throw new CoordinatorV2InvocationError('runtime-error', fallbackDelay);
  }

  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v2/reconcile',
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(coordinatorControlTimeoutMs),
        body,
      },
    );
  } catch {
    throw new CoordinatorV2InvocationError(
      'dependency-unavailable',
      fallbackDelay,
    );
  }

  if (!response.ok) {
    const delay = response.status === 429
      ? parseRetryAfter(response, fallbackDelay)
      : fallbackDelay;
    throw new CoordinatorV2InvocationError(
      response.status === 429
        ? 'rate-limited'
        : response.status >= 500
          ? 'dependency-unavailable'
          : 'control-error',
      delay,
    );
  }
  if (!responseContentTypeIsJson(response)) {
    throw new CoordinatorV2InvocationError('control-error', fallbackDelay);
  }

  let receipt: Receipt;
  try {
    receipt = await parseReceipt(await readBoundedResponseJson(response));
  } catch {
    throw new CoordinatorV2InvocationError('control-error', fallbackDelay);
  }
  if (
    expectedVersion !== undefined
    && receipt.controlRevision.workerVersionId !== expectedVersion
  ) {
    throw new CoordinatorV2InvocationError('control-error', fallbackDelay);
  }
  return receipt;
}

async function invokeRepositoryFanoutPage(
  body: string,
  schemaVersion: 1 | 2 | 3,
  expectedVersion: string | undefined,
  env: CoordinatorEnv,
  attempts: number,
): Promise<
  | StewardRuntimeRepositoryFanoutPageReceiptV1
  | StewardRuntimeRepositoryFanoutPageReceiptV2
  | StewardRuntimeRepositoryFanoutPageReceiptV3
> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let headers: Headers;
  try {
    headers = controlHeaders(
      schemaVersion === 1
        ? 'repository-fanout-1'
        : schemaVersion === 2
          ? 'repository-fanout-2'
          : 'repository-fanout-3',
      expectedVersion,
    );
  } catch {
    throw new RepositoryFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }

  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      schemaVersion === 1
        ? 'https://control.internal/v1/repository-fanout/page'
        : schemaVersion === 2
          ? 'https://control.internal/v2/repository-fanout/page'
          : 'https://control.internal/v3/repository-fanout/page',
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(coordinatorControlTimeoutMs),
        body,
      },
    );
  } catch {
    throw new RepositoryFanoutInvocationError(
      'dependency-unavailable',
      fallbackDelay,
    );
  }
  if (!response.ok) {
    throw new RepositoryFanoutInvocationError(
      response.status >= 500 || response.status === 429
        ? 'dependency-unavailable'
        : 'runtime-error',
      response.status === 429
        ? parseRetryAfter(response, fallbackDelay)
        : fallbackDelay,
    );
  }
  if (!responseContentTypeIsJson(response)) {
    throw new RepositoryFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }

  let receipt:
    | StewardRuntimeRepositoryFanoutPageReceiptV1
    | StewardRuntimeRepositoryFanoutPageReceiptV2
    | StewardRuntimeRepositoryFanoutPageReceiptV3;
  try {
    const value = await readBoundedResponseJson(response);
    receipt = schemaVersion === 1
      ? parseStewardRuntimeRepositoryFanoutPageReceiptV1(value)
      : schemaVersion === 2
        ? parseStewardRuntimeRepositoryFanoutPageReceiptV2(value)
        : await parseStewardRuntimeRepositoryFanoutPageReceiptV3(value);
  } catch {
    throw new RepositoryFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }
  if (
    expectedVersion !== undefined
    && receipt.controlRevision.workerVersionId !== expectedVersion
  ) {
    throw new RepositoryFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }
  return receipt;
}

async function invokeInstallationFanoutPage(
  body: string,
  env: CoordinatorEnv,
  attempts: number,
): Promise<StewardRuntimeInstallationFanoutPageReceiptV1> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v1/installation-fanout/page',
      {
        method: 'POST',
        headers: controlHeaders('installation-fanout-1', undefined),
        signal: AbortSignal.timeout(coordinatorControlTimeoutMs),
        body,
      },
    );
  } catch {
    throw new InstallationFanoutInvocationError(
      'dependency-unavailable',
      fallbackDelay,
    );
  }
  if (!response.ok) {
    throw new InstallationFanoutInvocationError(
      response.status >= 500 || response.status === 429
        ? 'dependency-unavailable'
        : 'runtime-error',
      response.status === 429
        ? parseRetryAfter(response, fallbackDelay)
        : fallbackDelay,
    );
  }
  if (!responseContentTypeIsJson(response)) {
    throw new InstallationFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }
  try {
    return parseStewardRuntimeInstallationFanoutPageReceiptV1(
      await readBoundedResponseJson(response),
    );
  } catch {
    throw new InstallationFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }
}

class InstallationIndexBootstrapInvocationError extends Error {
  constructor(
    readonly kind: 'revision-conflict' | 'retryable' | 'invalid',
    readonly retryDelaySeconds: number,
  ) {
    super('Private installation index bootstrap Control invocation failed');
    this.name = 'InstallationIndexBootstrapInvocationError';
  }
}

async function invokeInstallationIndexBootstrapPage(
  body: string,
  env: CoordinatorEnv,
  attempts: number,
): Promise<StewardRuntimeInstallationIndexBootstrapPageReceiptV1> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v1/installation-index-bootstrap/page',
      {
        method: 'POST',
        headers: controlHeaders(
          'installation-index-bootstrap-1',
          undefined,
        ),
        signal: AbortSignal.timeout(coordinatorControlTimeoutMs),
        body,
      },
    );
  } catch {
    throw new InstallationIndexBootstrapInvocationError(
      'retryable',
      fallbackDelay,
    );
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new InstallationIndexBootstrapInvocationError(
        'revision-conflict',
        fallbackDelay,
      );
    }
    throw new InstallationIndexBootstrapInvocationError(
      response.status >= 500 || response.status === 429
        ? 'retryable'
        : 'invalid',
      response.status === 429
        ? parseRetryAfter(response, fallbackDelay)
        : fallbackDelay,
    );
  }
  if (!responseContentTypeIsJson(response)) {
    throw new InstallationIndexBootstrapInvocationError(
      'invalid',
      fallbackDelay,
    );
  }
  try {
    return await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
      await readBoundedResponseJson(response),
    );
  } catch {
    throw new InstallationIndexBootstrapInvocationError(
      'invalid',
      fallbackDelay,
    );
  }
}

type CoordinatorQueueEnvelope =
  | RepositoryFanoutInput
  | StewardRuntimeInstallationIndexBootstrapEnvelopeV1
  | StewardRuntimeInstallationFanoutRootV1
  | StewardRuntimeWorkItem;

async function parseQueueEnvelope(
  body: unknown,
): Promise<CoordinatorQueueEnvelope> {
  if (typeof body !== 'string') throw new Error('queue-body-not-text');
  const value = JSON.parse(body) as unknown;
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).operation
      === 'installation-index-bootstrap'
  ) {
    return parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(value);
  }
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).operation
      === 'installation-repository-fanout'
  ) {
    return await parseStewardRuntimeInstallationRepositoryChildV1(value);
  }
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).operation === 'scope-reconcile'
  ) {
    const scopeWorkItem = parseStewardRuntimeScopeWorkItem(value);
    if (scopeWorkItem.target.scope === 'repository') {
      return scopeWorkItem as RepositoryFanoutScopeWorkItem;
    }
    return parseStewardRuntimeInstallationFanoutRootV1({
      installationId: scopeWorkItem.target.installationId,
      deliveryId: scopeWorkItem.cause.deliveryId,
      scopeWorkItem,
    });
  }
  return parseStewardRuntimeWorkItem(value);
}

function isInstallationIndexBootstrap(
  value: CoordinatorQueueEnvelope,
): value is StewardRuntimeInstallationIndexBootstrapEnvelopeV1 {
  return 'operation' in value
    && value.operation === 'installation-index-bootstrap';
}

function isInstallationFanoutRoot(
  value: CoordinatorQueueEnvelope,
): value is StewardRuntimeInstallationFanoutRootV1 {
  return 'scopeWorkItem' in value;
}

function repositoryFanoutInputRepositoryId(
  value: RepositoryFanoutInput,
): number {
  return value.operation === 'installation-repository-fanout'
    ? value.repositoryId
    : value.target.repositoryId;
}

function repositoryFanoutInputSchemaVersion(
  value: RepositoryFanoutInput,
): 1 | 2 | 3 {
  return value.operation === 'installation-repository-fanout'
    ? 3
    : value.schemaVersion;
}

async function canonicalRepositoryFanoutInputJson(
  value: RepositoryFanoutInput,
): Promise<string> {
  return value.operation === 'installation-repository-fanout'
    ? await canonicalStewardRuntimeInstallationRepositoryChildV1Json(value)
    : canonicalStewardRuntimeScopeWorkItemJson(value);
}

async function recordFailure(
  coordinator: PullRequestCoordinatorStub,
  claim: Extract<CoordinatorClaimResult, { status: 'claimed' }>,
  error: ControlInvocationError,
): Promise<void> {
  try {
    await coordinator.fail(
      claim.generation,
      claim.leaseToken,
      error.failureCode,
    );
  } catch {
    // The Queue redelivery and lease expiry remain the recovery authority.
  }
}

async function recordRepositoryFanoutFailure(
  coordinator: RepositoryFanoutCoordinatorStub,
  claim: Extract<RepositoryFanoutClaimResult, { status: 'claimed' }>,
  failureCode: RepositoryFanoutFailureCode,
): Promise<void> {
  try {
    await coordinator.fail(
      claim.generation,
      claim.leaseToken,
      failureCode,
    );
  } catch {
    // Queue redelivery and the lease alarm remain the recovery authority.
  }
}

async function releaseAndWakeRepositoryFanout(
  coordinator: RepositoryFanoutCoordinatorStub,
  claim: Extract<RepositoryFanoutClaimResult, { status: 'claimed' }>,
  message: CoordinatorQueueMessage,
  env: CoordinatorEnv,
): Promise<void> {
  let released: RepositoryFanoutReleaseForContinuationResult;
  try {
    released = await coordinator.releaseForContinuation(
      claim.generation,
      claim.leaseToken,
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (released.status !== 'released') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  try {
    await env.EVENT_QUEUE.send(
      await canonicalRepositoryFanoutInputJson(claim.selectedScopeItem),
      { contentType: 'text' },
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  message.ack();
}

async function recordInstallationFanoutFailure(
  coordinator: InstallationFanoutCoordinatorStub,
  claim: Extract<InstallationFanoutClaimResult, { status: 'claimed' }>,
  failureCode: InstallationFanoutFailureCode,
): Promise<void> {
  try {
    await coordinator.fail(
      claim.generation,
      claim.leaseToken,
      failureCode,
    );
  } catch {
    // Queue redelivery and the lease alarm remain the recovery authority.
  }
}

async function releaseAndWakeInstallationFanout(
  coordinator: InstallationFanoutCoordinatorStub,
  claim: Extract<InstallationFanoutClaimResult, { status: 'claimed' }>,
  message: CoordinatorQueueMessage,
  env: CoordinatorEnv,
): Promise<void> {
  let released: InstallationFanoutReleaseForContinuationResult;
  try {
    released = await coordinator.releaseForContinuation(
      claim.generation,
      claim.leaseToken,
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (released.status !== 'released') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  try {
    await env.EVENT_QUEUE.send(
      canonicalStewardRuntimeScopeWorkItemJson(
        claim.selectedRoot.scopeWorkItem,
      ),
      { contentType: 'text' },
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  message.ack();
}

async function processRepositoryFanoutMessage(
  message: CoordinatorQueueMessage,
  scopeWorkItem: RepositoryFanoutInput,
  env: CoordinatorEnv,
): Promise<void> {
  let coordinator: RepositoryFanoutCoordinatorStub;
  let claim: RepositoryFanoutClaimResult;
  try {
    coordinator = env.REPOSITORY_FANOUT_COORDINATOR.getByName(
      repositoryFanoutCoordinatorName(
        repositoryFanoutInputRepositoryId(scopeWorkItem),
      ),
    );
    claim = await coordinator.claim(
      scopeWorkItem,
      coordinatorLeaseDurationMs,
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (claim.status === 'duplicate' || claim.status === 'coalesced') {
    message.ack();
    return;
  }
  if (claim.status === 'busy') {
    message.retry({
      delaySeconds: leaseRetryDelaySeconds(claim.expiresAt),
    });
    return;
  }
  if (claim.status !== 'claimed') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (claim.phase === 'enumerating') {
    if (claim.pass === null) {
      await recordRepositoryFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }

    let expectedVersion: string | undefined;
    let requestBody: string;
    try {
      const selected = claim.selectedScopeItem;
      expectedVersion = selectedControlVersionForRepositoryId(
        repositoryFanoutInputRepositoryId(selected),
        env,
      );
      if (selected.operation === 'installation-repository-fanout') {
        requestBody =
          await canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json(
            await buildStewardRuntimeRepositoryFanoutPageRequestV3({
              binding: {
                installationChild: selected,
                generation: claim.generation,
                pass: claim.pass,
                cursor: claim.cursor,
              },
            }),
          );
      } else if (selected.schemaVersion === 1) {
        requestBody = canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json(
          buildStewardRuntimeRepositoryFanoutPageRequestV1({
            binding: {
              scopeWorkItem: selected,
              generation: claim.generation,
              pass: claim.pass,
              cursor: claim.cursor,
            },
          }),
        );
      } else {
        requestBody = canonicalStewardRuntimeRepositoryFanoutPageRequestV2Json(
          buildStewardRuntimeRepositoryFanoutPageRequestV2({
            binding: {
              scopeWorkItem: selected,
              generation: claim.generation,
              pass: claim.pass,
              cursor: claim.cursor,
            },
          }),
        );
      }
    } catch {
      await recordRepositoryFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }

    let receipt:
      | StewardRuntimeRepositoryFanoutPageReceiptV1
      | StewardRuntimeRepositoryFanoutPageReceiptV2
      | StewardRuntimeRepositoryFanoutPageReceiptV3;
    try {
      receipt = await invokeRepositoryFanoutPage(
        requestBody,
        repositoryFanoutInputSchemaVersion(claim.selectedScopeItem),
        expectedVersion,
        env,
        message.attempts,
      );
    } catch (error) {
      const failure = error instanceof RepositoryFanoutInvocationError
        ? error
        : new RepositoryFanoutInvocationError(
            'runtime-error',
            boundedRetryDelaySeconds(message.attempts),
          );
      await recordRepositoryFanoutFailure(
        coordinator,
        claim,
        failure.failureCode,
      );
      message.retry({ delaySeconds: failure.retryDelaySeconds });
      return;
    }

    let recorded: RepositoryFanoutRecordPageResult;
    try {
      recorded = await coordinator.recordPage(
        claim.generation,
        claim.leaseToken,
        receipt,
      );
    } catch {
      await recordRepositoryFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (recorded.status === 'drift-limit') {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (recorded.status === 'conflict' || recorded.status === 'stale') {
      await recordRepositoryFanoutFailure(
        coordinator,
        claim,
        recorded.status === 'conflict'
          ? 'pagination-conflict'
          : 'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    await releaseAndWakeRepositoryFanout(
      coordinator,
      claim,
      message,
      env,
    );
    return;
  }

  if (claim.pass !== null || claim.cursor !== null) {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  let batch: RepositoryFanoutNextDispatchBatchResult;
  try {
    batch = await coordinator.nextDispatchBatch(
      claim.generation,
      claim.leaseToken,
      repositoryFanoutMaximumDispatchBatchSize,
    );
  } catch {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (batch.status !== 'batch') {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (batch.targets.length === 0) {
    let completion: RepositoryFanoutCompleteResult;
    try {
      completion = await coordinator.complete(
        claim.generation,
        claim.leaseToken,
      );
    } catch {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (completion.status === 'completed') {
      message.ack();
      return;
    }
    if (completion.status === 'followup') {
      try {
        await env.EVENT_QUEUE.send(
          await canonicalRepositoryFanoutInputJson(claim.selectedScopeItem),
          { contentType: 'text' },
        );
      } catch {
        message.retry({
          delaySeconds: boundedRetryDelaySeconds(message.attempts),
        });
        return;
      }
      message.ack();
      return;
    }
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (batch.repositoryFullName === null) {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  const repositoryFullName = batch.repositoryFullName;

  let queuedMessages: {
    readonly body: string;
    readonly contentType: 'text';
  }[];
  let queuedTargets: readonly {
    readonly pullRequestNumber: number;
    readonly deliveryId: string;
  }[];
  try {
    const messages: {
      readonly body: string;
      readonly contentType: 'text';
    }[] = [];
    const targets: {
      readonly pullRequestNumber: number;
      readonly deliveryId: string;
    }[] = [];
    let batchByteLength = 0;
    for (const target of batch.targets) {
      const selected = claim.selectedScopeItem;
      const derivedDeliveryId = selected.operation
        === 'installation-repository-fanout'
        ? await deriveStewardRuntimeFanoutDeliveryIdV3(
            selected,
            claim.generation,
            target.pullRequestNumber,
          )
        : selected.schemaVersion === 1
          ? await deriveStewardRuntimeFanoutDeliveryId(
              selected,
              claim.generation,
              target.pullRequestNumber,
            )
          : await deriveStewardRuntimeFanoutDeliveryIdV2(
              selected,
              claim.generation,
              target.pullRequestNumber,
            );
      if (derivedDeliveryId !== target.deliveryId) {
        throw new Error('repository-fanout-target-delivery-id-mismatch');
      }
      const childWorkItem = selected.operation
        === 'installation-repository-fanout'
        ? buildStewardRuntimeWorkItemV5({
            operation: 'pull-request-reconcile',
            installationId: selected.installationId,
            subject: {
              repositoryId: selected.repositoryId,
              repositoryFullName,
              pullRequestNumber: target.pullRequestNumber,
            },
            cause: {
              kind: 'scope-fanout-3',
              deliveryId: target.deliveryId,
              rootDeliveryId: selected.rootDeliveryId,
              installationChild: selected,
              repositoryFanoutGeneration: claim.generation,
              event: selected.cause.event,
              action: selected.cause.action,
              ref: selected.cause.ref,
              receivedAt: selected.cause.receivedAt,
            },
          })
        : selected.schemaVersion === 1
        ? buildStewardRuntimeWorkItemV3({
            operation: 'pull-request-reconcile',
            installationId:
              selected.target.installationId,
            subject: {
              repositoryId:
                selected.target.repositoryId,
              repositoryFullName,
              pullRequestNumber: target.pullRequestNumber,
            },
            cause: {
              kind: 'scope-fanout',
              deliveryId: target.deliveryId,
              rootDeliveryId:
                selected.cause.deliveryId,
              scopeSchemaVersion:
                selected.schemaVersion,
              fanoutGeneration: claim.generation,
              event: selected.cause.event,
              action: selected.cause.action,
              receivedAt: selected.cause.receivedAt,
            },
          })
        : buildStewardRuntimeWorkItemV4({
            operation: 'pull-request-reconcile',
            installationId:
              selected.target.installationId,
            subject: {
              repositoryId:
                selected.target.repositoryId,
              repositoryFullName,
              pullRequestNumber: target.pullRequestNumber,
            },
            cause: {
              kind: 'scope-fanout-2',
              deliveryId: target.deliveryId,
              rootDeliveryId:
                selected.cause.deliveryId,
              scopeSchemaVersion:
                selected.schemaVersion,
              fanoutGeneration: claim.generation,
              event: selected.cause.event,
              action: selected.cause.action,
              ref: selected.cause.ref,
              receivedAt: selected.cause.receivedAt,
            },
          });
      const queued = {
        body: canonicalStewardRuntimeWorkItemJson(
          childWorkItem,
        ),
        contentType: 'text' as const,
      };
      const byteLength = new TextEncoder().encode(queued.body).byteLength;
      if (byteLength >= coordinatorMaximumQueueMessageBytes) {
        throw new Error('repository-fanout-queue-message-too-large');
      }
      if (
        messages.length > 0
        && batchByteLength + byteLength > coordinatorMaximumQueueBatchBytes
      ) {
        break;
      }
      messages.push(queued);
      targets.push(target);
      batchByteLength += byteLength;
    }
    if (messages.length === 0) {
      throw new Error('repository-fanout-queue-batch-empty');
    }
    queuedMessages = messages;
    queuedTargets = targets;
  } catch {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  try {
    await env.EVENT_QUEUE.sendBatch(queuedMessages);
  } catch {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'queue-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  let confirmation: RepositoryFanoutRecordQueueConfirmedResult;
  try {
    confirmation = await coordinator.recordQueueConfirmed(
      claim.generation,
      claim.leaseToken,
      {
        confirmations: queuedTargets.map((target) => ({
          pullRequestNumber: target.pullRequestNumber,
          deliveryId: target.deliveryId,
        })),
      },
    );
  } catch {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (
    confirmation.status !== 'recorded'
    || confirmation.remaining
      !== batch.remaining + batch.targets.length - queuedTargets.length
  ) {
    await recordRepositoryFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  await releaseAndWakeRepositoryFanout(
    coordinator,
    claim,
    message,
    env,
  );
}

async function processInstallationFanoutMessage(
  message: CoordinatorQueueMessage,
  root: StewardRuntimeInstallationFanoutRootV1,
  env: CoordinatorEnv,
): Promise<void> {
  let coordinator: InstallationFanoutCoordinatorStub;
  let claim: InstallationFanoutClaimResult;
  try {
    coordinator = env.INSTALLATION_FANOUT_COORDINATOR.getByName(
      installationFanoutCoordinatorName(root.installationId),
    );
    claim = await coordinator.claim(root, coordinatorLeaseDurationMs);
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (claim.status === 'duplicate' || claim.status === 'coalesced') {
    message.ack();
    return;
  }
  if (claim.status === 'busy') {
    message.retry({
      delaySeconds: leaseRetryDelaySeconds(claim.expiresAt),
    });
    return;
  }
  if (claim.status !== 'claimed') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (claim.phase === 'enumerating') {
    const installationRepositoryDelta =
      claim.selectedRoot.scopeWorkItem.target.scope === 'repository-set'
      && claim.selectedRoot.scopeWorkItem.cause.event
        === 'installation_repositories';
    if (
      claim.pass === null
      || (
        claim.selectedRoot.scopeWorkItem.target.scope !== 'installation'
        && !installationRepositoryDelta
      )
    ) {
      await recordInstallationFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    let requestBody: string;
    try {
      requestBody =
        canonicalStewardRuntimeInstallationFanoutPageRequestV1Json(
          buildStewardRuntimeInstallationFanoutPageRequestV1({
            binding: {
              root: claim.selectedRoot,
              generation: claim.generation,
              pass: claim.pass,
              cursor: claim.cursor,
            },
          }),
        );
    } catch {
      await recordInstallationFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }

    let receipt: StewardRuntimeInstallationFanoutPageReceiptV1;
    try {
      receipt = await invokeInstallationFanoutPage(
        requestBody,
        env,
        message.attempts,
      );
    } catch (error) {
      const failure = error instanceof InstallationFanoutInvocationError
        ? error
        : new InstallationFanoutInvocationError(
            'runtime-error',
            boundedRetryDelaySeconds(message.attempts),
          );
      await recordInstallationFanoutFailure(
        coordinator,
        claim,
        failure.failureCode,
      );
      message.retry({ delaySeconds: failure.retryDelaySeconds });
      return;
    }

    let recorded: InstallationFanoutRecordPageResult;
    try {
      recorded = await coordinator.recordPage(
        claim.generation,
        claim.leaseToken,
        receipt,
      );
    } catch {
      await recordInstallationFanoutFailure(
        coordinator,
        claim,
        'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (recorded.status === 'failed-closed') {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (recorded.status === 'conflict' || recorded.status === 'stale') {
      await recordInstallationFanoutFailure(
        coordinator,
        claim,
        recorded.status === 'conflict'
          ? 'pagination-conflict'
          : 'runtime-error',
      );
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    await releaseAndWakeInstallationFanout(
      coordinator,
      claim,
      message,
      env,
    );
    return;
  }

  if (claim.pass !== null || claim.cursor !== null) {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  let batch: InstallationFanoutNextDispatchBatchResult;
  try {
    batch = await coordinator.nextDispatchBatch(
      claim.generation,
      claim.leaseToken,
      installationFanoutMaximumDispatchBatchSize,
    );
  } catch {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (batch.status !== 'batch') {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  if (batch.targets.length === 0) {
    let completion: InstallationFanoutCompleteResult;
    try {
      completion = await coordinator.complete(
        claim.generation,
        claim.leaseToken,
      );
    } catch {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (completion.status === 'completed') {
      message.ack();
      return;
    }
    if (completion.status === 'followup') {
      try {
        await env.EVENT_QUEUE.send(
          canonicalStewardRuntimeScopeWorkItemJson(
            claim.selectedRoot.scopeWorkItem,
          ),
          { contentType: 'text' },
        );
      } catch {
        message.retry({
          delaySeconds: boundedRetryDelaySeconds(message.attempts),
        });
        return;
      }
      message.ack();
      return;
    }
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  let queuedMessages: {
    readonly body: string;
    readonly contentType: 'text';
  }[];
  let queuedTargets: readonly {
    readonly repositoryId: number;
    readonly deliveryId: string;
  }[];
  try {
    const messages: {
      readonly body: string;
      readonly contentType: 'text';
    }[] = [];
    const targets: {
      readonly repositoryId: number;
      readonly deliveryId: string;
    }[] = [];
    let batchByteLength = 0;
    for (const target of batch.targets) {
      const child = await buildStewardRuntimeInstallationRepositoryChildV1({
        root: claim.selectedRoot,
        installationId: claim.selectedRoot.installationId,
        repositoryId: target.repositoryId,
        installationGeneration: claim.generation,
      });
      if (child.deliveryId !== target.deliveryId) {
        throw new Error('installation-fanout-target-delivery-id-mismatch');
      }
      const queued = {
        body:
          await canonicalStewardRuntimeInstallationRepositoryChildV1Json(
            child,
          ),
        contentType: 'text' as const,
      };
      const byteLength = new TextEncoder().encode(queued.body).byteLength;
      if (byteLength >= coordinatorMaximumQueueMessageBytes) {
        throw new Error('installation-fanout-queue-message-too-large');
      }
      if (
        messages.length > 0
        && batchByteLength + byteLength > coordinatorMaximumQueueBatchBytes
      ) {
        break;
      }
      messages.push(queued);
      targets.push(target);
      batchByteLength += byteLength;
    }
    if (messages.length === 0) {
      throw new Error('installation-fanout-queue-batch-empty');
    }
    queuedMessages = messages;
    queuedTargets = targets;
  } catch {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  try {
    await env.EVENT_QUEUE.sendBatch(queuedMessages);
  } catch {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'queue-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  let confirmation: InstallationFanoutRecordQueueConfirmedResult;
  try {
    confirmation = await coordinator.recordQueueConfirmed(
      claim.generation,
      claim.leaseToken,
      {
        confirmations: queuedTargets.map((target) => ({
          repositoryId: target.repositoryId,
          deliveryId: target.deliveryId,
        })),
      },
    );
  } catch {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (
    confirmation.status !== 'recorded'
    || confirmation.remaining
      !== batch.remaining + batch.targets.length - queuedTargets.length
  ) {
    await recordInstallationFanoutFailure(
      coordinator,
      claim,
      'runtime-error',
    );
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  await releaseAndWakeInstallationFanout(
    coordinator,
    claim,
    message,
    env,
  );
}

async function processInstallationIndexBootstrapMessage(
  message: CoordinatorQueueMessage,
  command: StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  env: CoordinatorEnv,
): Promise<void> {
  let coordinator: InstallationFanoutCoordinatorStub;
  let claim: InstallationIndexBootstrapClaimResult;
  try {
    coordinator = env.INSTALLATION_FANOUT_COORDINATOR.getByName(
      installationFanoutCoordinatorName(command.installationId),
    );
    claim = await coordinator.claimIndexBootstrap(
      command,
      coordinatorLeaseDurationMs,
    );
  } catch {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (claim.status === 'duplicate' || claim.status === 'conflict') {
    message.ack();
    return;
  }
  if (claim.status === 'busy') {
    message.retry({
      delaySeconds: claim.expiresAt === null
        ? boundedRetryDelaySeconds(message.attempts)
        : leaseRetryDelaySeconds(claim.expiresAt),
    });
    return;
  }

  if (claim.phase === 'finalizing') {
    let finalized: InstallationIndexBootstrapFinalizeResult;
    try {
      finalized = await coordinator.finalizeIndexBootstrap(claim.leaseToken);
    } catch {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (finalized.status === 'completed') {
      message.ack();
      return;
    }
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  if (claim.pass === null) {
    await coordinator.failIndexBootstrap(
      claim.leaseToken,
      'runtime-error',
    ).catch(() => undefined);
    message.ack();
    return;
  }

  let body: string;
  try {
    body =
      await canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json(
        await buildStewardRuntimeInstallationIndexBootstrapPageRequestV1({
          command: claim.command,
          pass: claim.pass,
          cursor: claim.cursor,
        }),
      );
  } catch {
    await coordinator.failIndexBootstrap(
      claim.leaseToken,
      'runtime-error',
    ).catch(() => undefined);
    message.ack();
    return;
  }

  let receipt: StewardRuntimeInstallationIndexBootstrapPageReceiptV1;
  try {
    receipt = await invokeInstallationIndexBootstrapPage(
      body,
      env,
      message.attempts,
    );
  } catch (error) {
    const failure = error instanceof InstallationIndexBootstrapInvocationError
      ? error
      : new InstallationIndexBootstrapInvocationError(
          'invalid',
          boundedRetryDelaySeconds(message.attempts),
        );
    if (failure.kind === 'retryable') {
      await coordinator.releaseIndexBootstrap(claim.leaseToken)
        .catch(() => undefined);
      message.retry({ delaySeconds: failure.retryDelaySeconds });
      return;
    }
    await coordinator.failIndexBootstrap(
      claim.leaseToken,
      failure.kind === 'revision-conflict'
        ? 'control-revision-conflict'
        : 'runtime-error',
    ).catch(() => undefined);
    message.ack();
    return;
  }

  let recorded: InstallationIndexBootstrapRecordPageResult;
  try {
    recorded = await coordinator.recordIndexBootstrapPage(
      claim.leaseToken,
      receipt,
    );
  } catch {
    await coordinator.failIndexBootstrap(
      claim.leaseToken,
      'runtime-error',
    ).catch(() => undefined);
    message.ack();
    return;
  }
  if (recorded.status === 'failed' || recorded.status === 'completed') {
    message.ack();
    return;
  }
  if (recorded.status === 'conflict') {
    await coordinator.failIndexBootstrap(
      claim.leaseToken,
      'runtime-error',
    ).catch(() => undefined);
    message.ack();
    return;
  }
  if (recorded.status === 'stale') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }

  const released = await coordinator.releaseIndexBootstrap(
    claim.leaseToken,
  ).catch(() => ({ status: 'stale' as const }));
  if (released.status !== 'released') {
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
    return;
  }
  try {
    await env.EVENT_QUEUE.send(
      canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
        claim.command,
      ),
      { contentType: 'text' },
    );
    message.ack();
  } catch {
    // The current Queue message remains a valid wakeup because the durable
    // lease was released before the uncertain continuation send.
    message.retry({
      delaySeconds: boundedRetryDelaySeconds(message.attempts),
    });
  }
}

export async function processCoordinatorMessage(
  message: CoordinatorQueueMessage,
  env: CoordinatorEnv,
): Promise<void> {
  let envelope: CoordinatorQueueEnvelope;
  try {
    envelope = await parseQueueEnvelope(message.body);
  } catch {
    message.retry({ delaySeconds: boundedRetryDelaySeconds(message.attempts) });
    return;
  }
  if (isInstallationIndexBootstrap(envelope)) {
    await processInstallationIndexBootstrapMessage(message, envelope, env);
    return;
  }
  if (isInstallationFanoutRoot(envelope)) {
    await processInstallationFanoutMessage(message, envelope, env);
    return;
  }
  if (
    envelope.operation === 'scope-reconcile'
    || envelope.operation === 'installation-repository-fanout'
  ) {
    await processRepositoryFanoutMessage(message, envelope, env);
    return;
  }
  const workItem = envelope;

  let coordinator: PullRequestCoordinatorStub;
  let claim: CoordinatorClaimResult;
  try {
    coordinator = env.PR_COORDINATOR.getByName(
      pullRequestCoordinatorName(
        workItem.subject.repositoryId,
        workItem.subject.pullRequestNumber,
      ),
    );
    claim = await coordinator.claim(
      workItem.cause.deliveryId,
      coordinatorLeaseDurationMs,
    );
  } catch {
    message.retry({ delaySeconds: boundedRetryDelaySeconds(message.attempts) });
    return;
  }

  if (claim.status === 'duplicate') {
    message.ack();
    return;
  }
  if (claim.status === 'coalesced') {
    // Dirty/follow-up state is now durable at PR scope. The active root
    // immediately reconciles a later generation, so retaining every burst
    // message would only manufacture Queue retries and false DLQ poison.
    message.ack();
    return;
  }
  if (claim.status === 'busy') {
    message.retry({ delaySeconds: leaseRetryDelaySeconds(claim.expiresAt) });
    return;
  }
  if (claim.status !== 'claimed') {
    message.retry({ delaySeconds: boundedRetryDelaySeconds(message.attempts) });
    return;
  }

  let activeClaim = claim;
  for (
    let immediateFollowups = 0;
    immediateFollowups <= coordinatorMaximumImmediateFollowups;
    immediateFollowups += 1
  ) {
    let completion: CoordinatorCompleteResult;
    if (
      workItem.schemaVersion === 2
      || workItem.schemaVersion === 3
      || workItem.schemaVersion === 4
      || workItem.schemaVersion === 5
    ) {
      const result = await runControlV2Generation(
        coordinator,
        activeClaim,
        workItem,
        message.attempts,
        {
          leaseDurationMs: coordinatorLeaseDurationMs,
          retryDelaySeconds: boundedRetryDelaySeconds,
          selectedControlVersion: () =>
            selectedControlVersion(workItem, env),
          invokePrepare: async (body, expectedVersion) =>
            await invokeControlV2<StewardRuntimeControlPreparedReceiptV2>(
              body,
              parseStewardRuntimeControlPreparedReceiptV2,
              expectedVersion,
              env,
              message.attempts,
            ),
          invokeMutation: async (body, expectedVersion) =>
            await invokeControlV2<StewardRuntimeControlMutationReceiptV2>(
              body,
              parseStewardRuntimeControlMutationReceiptV2,
              expectedVersion,
              env,
              message.attempts,
            ),
          invokeRecovery: async (body, expectedVersion) =>
            await invokeControlV2<StewardRuntimeControlRecoveryReceiptV2>(
              body,
              parseStewardRuntimeControlRecoveryReceiptV2,
              expectedVersion,
              env,
              message.attempts,
            ),
        },
      );
      if (result.status === 'retry') {
        message.retry({ delaySeconds: result.delaySeconds });
        return;
      }
      completion = result.completion;
    } else {
      try {
        await invokeControlV1(
          workItem,
          activeClaim.generation,
          env,
          message.attempts,
        );
      } catch (error) {
        const failure = error instanceof ControlInvocationError
          ? error
          : new ControlInvocationError(
              'runtime-error',
              boundedRetryDelaySeconds(message.attempts),
            );
        await recordFailure(coordinator, activeClaim, failure);
        message.retry({ delaySeconds: failure.retryDelaySeconds });
        return;
      }

      try {
        completion = await coordinator.complete(
          activeClaim.generation,
          activeClaim.leaseToken,
        );
      } catch {
        message.retry({
          delaySeconds: boundedRetryDelaySeconds(message.attempts),
        });
        return;
      }
    }
    if (completion.status === 'stale') {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (completion.status === 'completed') {
      message.ack();
      return;
    }
    if (immediateFollowups === coordinatorMaximumImmediateFollowups) {
      // Do not spend one root message's finite retry budget on an arbitrarily
      // long stream of PR changes. Persist a fresh Queue wakeup first; reuse
      // the root delivery identity because the DO explicitly allows a
      // completed root to claim durable follow-up state.
      try {
        await env.EVENT_QUEUE.send(
          canonicalStewardRuntimeWorkItemJson(workItem),
          { contentType: 'text' },
        );
      } catch {
        message.retry({
          delaySeconds: boundedRetryDelaySeconds(message.attempts),
        });
        return;
      }
      message.ack();
      return;
    }

    let followupClaim: CoordinatorClaimResult;
    try {
      followupClaim = await coordinator.claim(
        workItem.cause.deliveryId,
        coordinatorLeaseDurationMs,
      );
    } catch {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    if (followupClaim.status === 'duplicate') {
      message.ack();
      return;
    }
    if (followupClaim.status === 'coalesced') {
      message.ack();
      return;
    }
    if (followupClaim.status === 'busy') {
      message.retry({
        delaySeconds: leaseRetryDelaySeconds(followupClaim.expiresAt),
      });
      return;
    }
    if (followupClaim.status !== 'claimed') {
      message.retry({
        delaySeconds: boundedRetryDelaySeconds(message.attempts),
      });
      return;
    }
    activeClaim = followupClaim;
  }
}

export function createCoordinatorHandler(): CoordinatorHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (
        request.method !== 'POST'
        || url.pathname !== installationIndexBootstrapStatusPath
        || url.search !== ''
      ) {
        return new Response('Not Found', { status: 404 });
      }
      if (
        request.headers.get('x-steward-internal-protocol')
          !== installationIndexBootstrapStatusProtocol
      ) {
        return jsonResponse(403, { error: 'internal-protocol-required' });
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers.get('content-type') ?? '',
      )) {
        return jsonResponse(415, { error: 'application-json-required' });
      }
      let input: ReturnType<
        typeof parseInstallationIndexBootstrapStatusRequest
      >;
      try {
        const declared = request.headers.get('content-length');
        if (
          declared !== null
          && (
            !/^(?:0|[1-9]\d*)$/.test(declared)
            || Number(declared) > 16 * 1024
          )
        ) {
          return jsonResponse(413, { error: 'request-too-large' });
        }
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > 16 * 1024) {
          return jsonResponse(413, { error: 'request-too-large' });
        }
        input = parseInstallationIndexBootstrapStatusRequest(
          JSON.parse(text) as unknown,
        );
      } catch {
        return jsonResponse(400, { error: 'invalid-bootstrap-status-request' });
      }
      let stub: InstallationFanoutCoordinatorStub;
      try {
        stub = env.INSTALLATION_FANOUT_COORDINATOR.getByName(
          installationFanoutCoordinatorName(input.installationId),
        );
        const receipt = await stub.inspectIndexBootstrap(
          input.bootstrapRequestId,
          input.expectedBootstrapDigest,
          input.principalClientId,
        );
        if (receipt === null) {
          return jsonResponse(404, { error: 'bootstrap-not-found' });
        }
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
        return jsonResponse(409, { error: 'bootstrap-status-conflict' });
      }
    },
    async queue(batch, env) {
      await Promise.all(
        batch.messages.map(async (message) => {
          try {
            await processCoordinatorMessage(message, env);
          } catch {
            message.retry({
              delaySeconds: boundedRetryDelaySeconds(message.attempts),
            });
          }
        }),
      );
    },
  };
}

export default createCoordinatorHandler();
