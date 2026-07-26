import {
  buildStewardRuntimeRepositoryFanoutPageRequestV1,
  buildStewardRuntimeControlRequest,
  buildStewardRuntimeWorkItemV3,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeControlRequestJson,
  canonicalStewardRuntimeWorkItemJson,
  deriveStewardRuntimeFanoutDeliveryId,
  parseStewardRuntimeRepositoryFanoutPageReceiptV1,
  parseStewardRuntimeScopeWorkItemV1,
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
  type StewardRuntimeScopeWorkItemV1,
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
} from './repository-fanout-contracts.js';
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
  protocol: '1' | '2' | 'repository-fanout-1',
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
  expectedVersion: string | undefined,
  env: CoordinatorEnv,
  attempts: number,
): Promise<StewardRuntimeRepositoryFanoutPageReceiptV1> {
  const fallbackDelay = boundedRetryDelaySeconds(attempts);
  let headers: Headers;
  try {
    headers = controlHeaders('repository-fanout-1', expectedVersion);
  } catch {
    throw new RepositoryFanoutInvocationError(
      'runtime-error',
      fallbackDelay,
    );
  }

  let response: Response;
  try {
    response = await env.CONTROL.fetch(
      'https://control.internal/v1/repository-fanout/page',
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

  let receipt: StewardRuntimeRepositoryFanoutPageReceiptV1;
  try {
    receipt = parseStewardRuntimeRepositoryFanoutPageReceiptV1(
      await readBoundedResponseJson(response),
    );
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

type CoordinatorQueueEnvelope =
  | StewardRuntimeScopeWorkItemV1
  | StewardRuntimeWorkItem;

function parseQueueEnvelope(body: unknown): CoordinatorQueueEnvelope {
  if (typeof body !== 'string') throw new Error('queue-body-not-text');
  const value = JSON.parse(body) as unknown;
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).operation === 'scope-reconcile'
  ) {
    return parseStewardRuntimeScopeWorkItemV1(value);
  }
  return parseStewardRuntimeWorkItem(value);
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
      canonicalStewardRuntimeScopeWorkItemJson(claim.selectedScopeItem),
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
  scopeWorkItem: StewardRuntimeScopeWorkItemV1,
  env: CoordinatorEnv,
): Promise<void> {
  let coordinator: RepositoryFanoutCoordinatorStub;
  let claim: RepositoryFanoutClaimResult;
  try {
    coordinator = env.REPOSITORY_FANOUT_COORDINATOR.getByName(
      repositoryFanoutCoordinatorName(
        scopeWorkItem.target.repositoryId,
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
      expectedVersion = selectedControlVersionForRepositoryId(
        claim.selectedScopeItem.target.repositoryId,
        env,
      );
      requestBody =
        canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json(
          buildStewardRuntimeRepositoryFanoutPageRequestV1({
            binding: {
              scopeWorkItem: claim.selectedScopeItem,
              generation: claim.generation,
              pass: claim.pass,
              cursor: claim.cursor,
            },
          }),
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

    let receipt: StewardRuntimeRepositoryFanoutPageReceiptV1;
    try {
      receipt = await invokeRepositoryFanoutPage(
        requestBody,
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
          canonicalStewardRuntimeScopeWorkItemJson(
            claim.selectedScopeItem,
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
  try {
    queuedMessages = await Promise.all(batch.targets.map(async (target) => {
      const derivedDeliveryId = await deriveStewardRuntimeFanoutDeliveryId(
        claim.selectedScopeItem,
        claim.generation,
        target.pullRequestNumber,
      );
      if (derivedDeliveryId !== target.deliveryId) {
        throw new Error('repository-fanout-target-delivery-id-mismatch');
      }
      return {
        body: canonicalStewardRuntimeWorkItemJson(
          buildStewardRuntimeWorkItemV3({
            operation: 'pull-request-reconcile',
            installationId:
              claim.selectedScopeItem.target.installationId,
            subject: {
              repositoryId:
                claim.selectedScopeItem.target.repositoryId,
              repositoryFullName,
              pullRequestNumber: target.pullRequestNumber,
            },
            cause: {
              kind: 'scope-fanout',
              deliveryId: target.deliveryId,
              rootDeliveryId:
                claim.selectedScopeItem.cause.deliveryId,
              scopeSchemaVersion:
                claim.selectedScopeItem.schemaVersion,
              fanoutGeneration: claim.generation,
              event: claim.selectedScopeItem.cause.event,
              action: claim.selectedScopeItem.cause.action,
              receivedAt: claim.selectedScopeItem.cause.receivedAt,
            },
          }),
        ),
        contentType: 'text' as const,
      };
    }));
    const messageByteLengths = queuedMessages.map(
      (queued) => new TextEncoder().encode(queued.body).byteLength,
    );
    const byteLength = messageByteLengths.reduce(
      (total, length) => total + length,
      0,
    );
    if (
      messageByteLengths.some(
        (length) => length >= coordinatorMaximumQueueMessageBytes,
      )
      || byteLength > coordinatorMaximumQueueBatchBytes
    ) {
      throw new Error('repository-fanout-queue-batch-too-large');
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
        confirmations: batch.targets.map((target) => ({
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
    || confirmation.remaining !== batch.remaining
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

export async function processCoordinatorMessage(
  message: CoordinatorQueueMessage,
  env: CoordinatorEnv,
): Promise<void> {
  let envelope: CoordinatorQueueEnvelope;
  try {
    envelope = parseQueueEnvelope(message.body);
  } catch {
    message.retry({ delaySeconds: boundedRetryDelaySeconds(message.attempts) });
    return;
  }
  if (envelope.operation === 'scope-reconcile') {
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
    if (workItem.schemaVersion === 2 || workItem.schemaVersion === 3) {
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
    async fetch() {
      return new Response('Not Found', { status: 404 });
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
