import {
  buildStewardRuntimeControlRequest,
  canonicalStewardRuntimeControlRequestJson,
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeControlReceipt,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeControlReceiptV1,
  type StewardRuntimeWorkItemV1,
} from '../../core/src/index.js';
import {
  pullRequestCoordinatorName,
  type CoordinatorClaimResult,
  type CoordinatorCompleteResult,
  type CoordinatorFailResult,
  type CoordinatorFailureCode,
} from './contracts.js';

export const coordinatorLeaseDurationMs = 120_000;
export const coordinatorControlTimeoutMs = 90_000;
export const coordinatorMaximumImmediateFollowups = 8;
export const coordinatorMaximumControlResponseBytes = 128_000;
export const controlWorkerName = 'steward-control';

const versionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PullRequestCoordinatorStub {
  claim(deliveryId: string, leaseDurationMs: number): Promise<CoordinatorClaimResult>;
  complete(generation: number, leaseToken: string): Promise<CoordinatorCompleteResult>;
  fail(
    generation: number,
    leaseToken: string,
    failureCode: CoordinatorFailureCode,
  ): Promise<CoordinatorFailResult>;
}

export interface PullRequestCoordinatorNamespace {
  getByName(name: string): PullRequestCoordinatorStub;
}

export interface ControlService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface CoordinatorWakeupQueue {
  send(
    body: string,
    options?: { readonly contentType?: 'text' },
  ): Promise<unknown>;
}

export interface CoordinatorEnv {
  readonly PR_COORDINATOR: PullRequestCoordinatorNamespace;
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

function selectedControlVersion(
  workItem: StewardRuntimeWorkItemV1,
  env: CoordinatorEnv,
): string | undefined {
  const repositoryIds = candidateRepositoryIds(
    env.CONTROL_CANDIDATE_REPOSITORY_IDS,
  );
  if (!repositoryIds.has(workItem.subject.repositoryId)) return undefined;
  const versionId = env.CONTROL_CANDIDATE_VERSION_ID;
  if (versionId === undefined || !versionIdPattern.test(versionId)) {
    throw new Error('candidate-version-invalid');
  }
  return versionId;
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
  workItem: StewardRuntimeWorkItemV1,
  generation: number,
): boolean {
  return receipt.deliveryId === workItem.cause.deliveryId
    && receipt.generation === generation
    && receipt.subject.repositoryId === workItem.subject.repositoryId
    && receipt.subject.repositoryFullName === workItem.subject.repositoryFullName
    && receipt.subject.pullRequestNumber === workItem.subject.pullRequestNumber;
}

async function invokeControl(
  workItem: StewardRuntimeWorkItemV1,
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

function parseQueueWorkItem(body: unknown): StewardRuntimeWorkItemV1 {
  if (typeof body !== 'string') throw new Error('queue-body-not-text');
  return parseStewardRuntimeWorkItem(JSON.parse(body) as unknown);
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

export async function processCoordinatorMessage(
  message: CoordinatorQueueMessage,
  env: CoordinatorEnv,
): Promise<void> {
  let workItem: StewardRuntimeWorkItemV1;
  try {
    workItem = parseQueueWorkItem(message.body);
  } catch {
    message.retry({ delaySeconds: boundedRetryDelaySeconds(message.attempts) });
    return;
  }

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
    try {
      await invokeControl(
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

    let completion: CoordinatorCompleteResult;
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
