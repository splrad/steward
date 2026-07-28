import {
  buildStewardRuntimeWorkItemV2,
  canonicalStewardRuntimeWorkItemJson,
  STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
  STEWARD_RUNTIME_PULL_REQUEST_REVIEW_ACTIONS_V2,
  STEWARD_RUNTIME_PULL_REQUEST_REVIEW_COMMENT_ACTIONS_V2,
  STEWARD_RUNTIME_PULL_REQUEST_REVIEW_THREAD_ACTIONS_V2,
  type StewardGitHubWebhookEventActionV2,
  type StewardRuntimePullRequestActionV1,
  type StewardRuntimePullRequestReviewActionV2,
  type StewardRuntimePullRequestReviewCommentActionV2,
  type StewardRuntimePullRequestReviewThreadActionV2,
} from '../../core/src/runtime-work-item.js';
import {
  buildStewardRuntimeScopeWorkItemV1,
  buildStewardRuntimeScopeWorkItemV2,
  canonicalStewardRuntimeScopeWorkItemJson,
  STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1,
  type StewardRuntimeRepositoryActionV1,
  type StewardRuntimeScopeCauseV2,
  type StewardRuntimeScopeTargetV2,
} from '../../core/src/runtime-scope-work-item.js';
import {
  classifyRepositoryWebhookCausality,
  classifyRepositoryScopedWebhookCausality,
} from '../../core/src/webhook-causality.js';
import {
  MAX_LARGE_WEBHOOK_BODY_BYTES,
  MAX_STREAMED_REPOSITORY_IDS,
  STREAMING_WEBHOOK_EVENTS,
  StreamedBroadWebhookProcessor,
  type StreamedBroadWebhookResult,
} from './large-webhook.js';

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export { MAX_LARGE_WEBHOOK_BODY_BYTES } from './large-webhook.js';
export const MAX_INGRESS_RESPONSE_MS = 9_000;
// Cloudflare measures a Queue KB as 1000 bytes and counts roughly 100 bytes of
// internal metadata against the 128 KB limit. Keep an explicit safety margin.
export const MAX_QUEUE_MESSAGE_BYTES = 127_000;
export const MAX_INSTALLATION_REPOSITORY_SET_IDS =
  MAX_STREAMED_REPOSITORY_IDS;

export const SUPPORTED_PULL_REQUEST_ACTIONS:
ReadonlySet<StewardRuntimePullRequestActionV1> = new Set([
  ...STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
]);

export const SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS:
ReadonlySet<StewardRuntimePullRequestReviewActionV2> = new Set([
  ...STEWARD_RUNTIME_PULL_REQUEST_REVIEW_ACTIONS_V2,
]);

export const SUPPORTED_PULL_REQUEST_REVIEW_COMMENT_ACTIONS:
ReadonlySet<StewardRuntimePullRequestReviewCommentActionV2> = new Set([
  ...STEWARD_RUNTIME_PULL_REQUEST_REVIEW_COMMENT_ACTIONS_V2,
]);

export const SUPPORTED_PULL_REQUEST_REVIEW_THREAD_ACTIONS:
ReadonlySet<StewardRuntimePullRequestReviewThreadActionV2> = new Set([
  ...STEWARD_RUNTIME_PULL_REQUEST_REVIEW_THREAD_ACTIONS_V2,
]);

export const SUPPORTED_REPOSITORY_ACTIONS:
ReadonlySet<StewardRuntimeRepositoryActionV1> = new Set([
  ...STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1,
]);

const supportedGitHubWebhookEvents: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'custom_property',
  'custom_property_values',
  'membership',
  'repository',
  'team',
  'team_add',
  'push',
  'installation',
  'installation_repositories',
  'installation_target',
]);

export interface Queue<Body> {
  send(body: Body, options?: { readonly contentType?: 'text' }): Promise<unknown>;
}

export interface Env {
  EVENT_QUEUE: Queue<string>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET_PREVIOUS?: string;
}

export interface IngressDependencies {
  readonly clock: () => Date;
  readonly deadlineSignal?: () => AbortSignal;
  readonly verifySignature?: typeof verifyGitHubWebhookSignature;
}

type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const contentTypePattern =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i;
const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const eventActionPattern = /^[a-z][a-z0-9_]{0,63}$/;
const signaturePattern = /^sha256=([0-9a-f]{64})$/;

const defaultDependencies: IngressDependencies = {
  clock: () => new Date(),
};

class BodyTooLargeError extends Error {}
class IngressDeadlineError extends Error {}

function response(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function supportedPullRequestAction(
  value: string,
): value is StewardRuntimePullRequestActionV1 {
  return (SUPPORTED_PULL_REQUEST_ACTIONS as ReadonlySet<string>).has(value);
}

function supportedGitHubWebhookEventAction(
  event: string,
  action: string,
): StewardGitHubWebhookEventActionV2 | null {
  if (event === 'pull_request' && supportedPullRequestAction(action)) {
    return { event, action };
  }
  if (
    event === 'pull_request_review'
    && (SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS as ReadonlySet<string>).has(action)
  ) {
    return {
      event,
      action: action as StewardRuntimePullRequestReviewActionV2,
    };
  }
  if (
    event === 'pull_request_review_comment'
    && (SUPPORTED_PULL_REQUEST_REVIEW_COMMENT_ACTIONS as ReadonlySet<string>)
      .has(action)
  ) {
    return {
      event,
      action: action as StewardRuntimePullRequestReviewCommentActionV2,
    };
  }
  if (
    event === 'pull_request_review_thread'
    && (SUPPORTED_PULL_REQUEST_REVIEW_THREAD_ACTIONS as ReadonlySet<string>)
      .has(action)
  ) {
    return {
      event,
      action: action as StewardRuntimePullRequestReviewThreadActionV2,
    };
  }
  return null;
}

function contentLengthResponse(request: Request, event: string): Response | null {
  const contentLength = request.headers.get('content-length');
  if (contentLength === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
    return response(400, 'Invalid Content-Length');
  }
  const maximumBytes = STREAMING_WEBHOOK_EVENTS.has(event)
    ? MAX_LARGE_WEBHOOK_BODY_BYTES
    : MAX_WEBHOOK_BODY_BYTES;
  if (BigInt(contentLength) > BigInt(maximumBytes)) {
    return response(413, 'Webhook body too large');
  }
  return null;
}

function rejectAtDeadline(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectDeadline = () => {
      reject(new IngressDeadlineError());
    };
    if (signal.aborted) {
      rejectDeadline();
      return;
    }
    signal.addEventListener('abort', rejectDeadline, { once: true });
  });
}

async function readBodyWithLimit(
  request: Request,
  deadlineSignal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const cancelAtDeadline = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (deadlineSignal.aborted) {
    cancelAtDeadline();
  } else {
    deadlineSignal.addEventListener('abort', cancelAtDeadline, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size decision is already final.
        }
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    deadlineSignal.removeEventListener('abort', cancelAtDeadline);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

type BroadWebhookBody =
  | {
      readonly mode: 'buffered';
      readonly rawBody: Uint8Array<ArrayBuffer>;
    }
  | ({
      readonly mode: 'streamed';
    } & StreamedBroadWebhookResult);

async function readBroadBodyWithLimit(
  request: Request,
  event: string,
  signature: string,
  currentSecret: string,
  previousSecret: string | undefined,
  deadlineSignal: AbortSignal,
): Promise<BroadWebhookBody> {
  if (request.body === null) {
    return {
      mode: 'buffered',
      rawBody: new Uint8Array(),
    };
  }

  const reader = request.body.getReader();
  const cancelAtDeadline = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (deadlineSignal.aborted) {
    cancelAtDeadline();
  } else {
    deadlineSignal.addEventListener('abort', cancelAtDeadline, { once: true });
  }

  const bufferedChunks: Uint8Array[] = [];
  let processor: StreamedBroadWebhookProcessor | undefined;
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_LARGE_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The provider-limit decision is already final.
        }
        throw new BodyTooLargeError();
      }

      if (processor !== undefined) {
        processor.write(value);
        continue;
      }
      if (byteLength <= MAX_WEBHOOK_BODY_BYTES) {
        bufferedChunks.push(value);
        continue;
      }

      processor = new StreamedBroadWebhookProcessor(
        event,
        currentSecret,
        previousSecret,
      );
      for (const buffered of bufferedChunks) processor.write(buffered);
      bufferedChunks.length = 0;
      processor.write(value);
    }
  } finally {
    deadlineSignal.removeEventListener('abort', cancelAtDeadline);
  }

  if (processor !== undefined) {
    return {
      mode: 'streamed',
      ...processor.finish(signature),
    };
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of bufferedChunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    mode: 'buffered',
    rawBody: body,
  };
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function verifyWithSecret(
  rawBody: Uint8Array<ArrayBuffer>,
  expectedDigest: Uint8Array<ArrayBuffer>,
  secret: string | undefined,
): Promise<boolean> {
  if (secret === undefined || secret.length === 0) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, expectedDigest, rawBody);
}

export async function verifyGitHubWebhookSignature(
  rawBody: Uint8Array<ArrayBuffer>,
  signature: string,
  currentSecret: string,
  previousSecret?: string,
): Promise<boolean> {
  const match = signaturePattern.exec(signature);
  if (match === null) return false;
  const expectedDigest = hexBytes(match[1] ?? '');
  const results = await Promise.all([
    verifyWithSecret(rawBody, expectedDigest, currentSecret),
    verifyWithSecret(rawBody, expectedDigest, previousSecret),
  ]);
  return results.some(Boolean);
}

function extractWorkItem(
  payload: unknown,
  deliveryId: string,
  cause: StewardGitHubWebhookEventActionV2,
  receivedAt: string,
) {
  const root = record(payload);
  const installation = record(root?.installation);
  const repository = record(root?.repository);
  const pullRequest = record(root?.pull_request);
  const installationId = positiveSafeInteger(installation?.id);
  const repositoryId = positiveSafeInteger(repository?.id);
  const pullRequestNumber = positiveSafeInteger(pullRequest?.number);
  const repositoryFullName = repository?.full_name;
  if (
    root === null
    || root.action !== cause.action
    || installationId === null
    || repositoryId === null
    || pullRequestNumber === null
    || typeof repositoryFullName !== 'string'
  ) {
    return null;
  }

  try {
    return buildStewardRuntimeWorkItemV2({
      operation: 'pull-request-reconcile',
      installationId,
      subject: {
        repositoryId,
        repositoryFullName,
        pullRequestNumber,
      },
      cause: {
        kind: 'github-webhook',
        deliveryId,
        ...cause,
        receivedAt,
      },
    });
  } catch {
    return null;
  }
}

function extractRepositoryScopeWorkItem(
  payload: unknown,
  deliveryId: string,
  event: string,
  action: string,
  receivedAt: string,
) {
  const decision = classifyRepositoryWebhookCausality({
    event,
    action,
    payload,
  });
  if (decision.disposition !== 'reconcile') return decision;
  if (
    decision.target.scope !== 'repository'
    || decision.target.mode !== 'refresh'
    || decision.target.pullRequests !== 'all-open'
    || !SUPPORTED_REPOSITORY_ACTIONS.has(
      action as StewardRuntimeRepositoryActionV1,
    )
  ) {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'causality.target',
    };
  }
  try {
    return {
      disposition: 'enqueue' as const,
      workItem: buildStewardRuntimeScopeWorkItemV1({
        operation: 'scope-reconcile',
        target: decision.target,
        cause: {
          kind: 'github-webhook',
          deliveryId,
          event: 'repository',
          action: action as StewardRuntimeRepositoryActionV1,
          receivedAt,
        },
      }),
    };
  } catch {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'scope-work-item',
    };
  }
}

function extractRepositoryScopeWorkItemV2(
  payload: unknown,
  deliveryId: string,
  event: string,
  action: string | null,
  receivedAt: string,
) {
  const decision = classifyRepositoryScopedWebhookCausality({
    event,
    action,
    payload,
  });
  if (decision.disposition !== 'reconcile') return decision;
  if (
    decision.target.scope !== 'repository'
    || decision.target.mode !== 'refresh'
    || decision.target.pullRequests !== 'all-open'
  ) {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'causality.target',
    };
  }
  const ref = event === 'push' ? record(payload)?.ref : null;
  try {
    return {
      disposition: 'enqueue' as const,
      workItem: buildStewardRuntimeScopeWorkItemV2({
        operation: 'scope-reconcile',
        target: decision.target,
        cause: {
          kind: 'github-webhook',
          deliveryId,
          event,
          action,
          ref,
          receivedAt,
        } as StewardRuntimeScopeCauseV2,
      }),
    };
  } catch {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'scope-work-item',
    };
  }
}

function repositoryIds(value: unknown): readonly number[] | null {
  if (
    !Array.isArray(value)
    || value.length > MAX_INSTALLATION_REPOSITORY_SET_IDS
  ) {
    return null;
  }
  const ids: number[] = [];
  for (const repositoryValue of value) {
    const repositoryId = positiveSafeInteger(record(repositoryValue)?.id);
    if (repositoryId === null) return null;
    ids.push(repositoryId);
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

function extractInstallationScopeWorkItemV2(
  payload: unknown,
  deliveryId: string,
  event: string,
  action: string,
  receivedAt: string,
) {
  const root = record(payload);
  const installation = record(root?.installation);
  const installationId = positiveSafeInteger(installation?.id);
  if (
    root === null
    || root.action !== action
    || installationId === null
  ) {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'installation.id',
    };
  }

  let target: StewardRuntimeScopeTargetV2;
  if (event === 'custom_property') {
    const definition = record(root.definition);
    if (
      typeof definition?.property_name !== 'string'
      || definition.property_name.length < 1
    ) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'definition.property_name',
      };
    }
    target = {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    };
  } else if (event === 'membership') {
    const teamId = positiveSafeInteger(record(root.team)?.id);
    const member = record(root.member);
    if (
      root.scope !== 'team'
      || teamId === null
      || !('member' in root)
      || (root.member !== null && positiveSafeInteger(member?.id) === null)
    ) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'membership',
      };
    }
    target = {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    };
  } else if (event === 'team') {
    if (positiveSafeInteger(record(root.team)?.id) === null) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'team.id',
      };
    }
    target = {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    };
  } else if (event === 'installation') {
    const teardown = action === 'suspend' || action === 'deleted';
    if (teardown && 'repositories' in root) {
      const snapshot = repositoryIds(root.repositories);
      if (
        snapshot === null
        || snapshot.length > MAX_INSTALLATION_REPOSITORY_SET_IDS
      ) {
        return {
          disposition: 'quarantine' as const,
          reason: 'malformed-payload' as const,
          field: 'installation.repositories',
        };
      }
      target = {
        scope: 'repository-set',
        mode: 'refresh',
        installationId,
        repositoryIds: snapshot,
        pullRequests: 'all-open',
      };
    } else {
      target = {
        scope: 'installation',
        mode: 'refresh',
        installationId,
        repositories: 'all-live',
        pullRequests: 'all-open',
      };
    }
  } else if (event === 'installation_repositories') {
    const added = repositoryIds(root.repositories_added);
    const removed = repositoryIds(root.repositories_removed);
    if (added === null || removed === null) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'installation_repositories.delta',
      };
    }
    const selected = action === 'added' ? added : removed;
    const opposite = action === 'added' ? removed : added;
    if (
      selected.length < 1
      || selected.length > MAX_INSTALLATION_REPOSITORY_SET_IDS
      || opposite.length !== 0
    ) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'installation_repositories.delta',
      };
    }
    target = {
      scope: 'repository-set',
      mode: 'refresh',
      installationId,
      repositoryIds: selected,
      pullRequests: 'all-open',
    };
  } else if (event === 'installation_target') {
    const accountId = positiveSafeInteger(record(root.account)?.id);
    const installationAccountId =
      positiveSafeInteger(record(installation?.account)?.id);
    if (
      root.target_type !== 'Organization'
      || accountId === null
      || installationAccountId !== accountId
      || record(root.changes) === null
    ) {
      return {
        disposition: 'quarantine' as const,
        reason: 'malformed-payload' as const,
        field: 'installation_target',
      };
    }
    target = {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
      accountId,
    };
  } else {
    return {
      disposition: 'ignore' as const,
      reason: 'unsupported-event' as const,
    };
  }

  try {
    return {
      disposition: 'enqueue' as const,
      workItem: buildStewardRuntimeScopeWorkItemV2({
        operation: 'scope-reconcile',
        target,
        cause: {
          kind: 'github-webhook',
          deliveryId,
          event,
          action,
          ref: null,
          receivedAt,
        } as StewardRuntimeScopeCauseV2,
      }),
    };
  } catch {
    return {
      disposition: 'quarantine' as const,
      reason: 'malformed-payload' as const,
      field: 'scope-work-item',
    };
  }
}

export async function handleIngressRequest(
  request: Request,
  env: Env,
  dependencies: IngressDependencies = defaultDependencies,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/github/webhook') {
    return response(404, 'Not found');
  }
  if (request.method !== 'POST') return response(405, 'Method not allowed');
  if (!contentTypePattern.test(request.headers.get('content-type') ?? '')) {
    return response(415, 'Content-Type must be application/json');
  }

  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const deliveryId = request.headers.get('x-github-delivery') ?? '';
  const event = request.headers.get('x-github-event') ?? '';
  const declaredLengthFailure = contentLengthResponse(request, event);
  if (declaredLengthFailure !== null) return declaredLengthFailure;
  if (!signaturePattern.test(signature)) return response(401, 'Invalid signature');
  if (!deliveryIdPattern.test(deliveryId)) return response(400, 'Invalid delivery ID');
  if (!eventActionPattern.test(event)) return response(400, 'Invalid event');
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return response(503, 'Webhook verification unavailable');
  }

  const deadlineSignal = dependencies.deadlineSignal?.()
    ?? AbortSignal.timeout(MAX_INGRESS_RESPONSE_MS);
  const deadlineFailure = rejectAtDeadline(deadlineSignal);

  let body: BroadWebhookBody;
  try {
    body = await Promise.race([
      STREAMING_WEBHOOK_EVENTS.has(event)
        ? readBroadBodyWithLimit(
            request,
            event,
            signature,
            env.GITHUB_WEBHOOK_SECRET,
            env.GITHUB_WEBHOOK_SECRET_PREVIOUS,
            deadlineSignal,
          )
        : readBodyWithLimit(request, deadlineSignal).then((rawBody) => ({
            mode: 'buffered' as const,
            rawBody,
          })),
      deadlineFailure,
    ]);
  } catch (error) {
    if (error instanceof IngressDeadlineError) {
      return response(503, 'Ingress deadline exceeded');
    }
    return error instanceof BodyTooLargeError
      ? response(413, 'Webhook body too large')
      : response(400, 'Unable to read webhook body');
  }

  let payload: unknown;
  if (body.mode === 'streamed') {
    if (!body.signatureValid) return response(401, 'Invalid signature');
    if (!body.jsonValid) return response(400, 'Invalid JSON');
    if (!body.capacityValid) {
      return response(413, 'Webhook JSON exceeds streaming limits');
    }
    if (!body.projectionValid) {
      return response(422, 'Invalid streaming webhook payload');
    }
    payload = body.payload;
  } else {
    let signatureValid: boolean;
    try {
      signatureValid = await Promise.race([
        (dependencies.verifySignature ?? verifyGitHubWebhookSignature)(
          body.rawBody,
          signature,
          env.GITHUB_WEBHOOK_SECRET,
          env.GITHUB_WEBHOOK_SECRET_PREVIOUS,
        ),
        deadlineFailure,
      ]);
    } catch (error) {
      return error instanceof IngressDeadlineError
        ? response(503, 'Ingress deadline exceeded')
        : response(503, 'Webhook verification unavailable');
    }
    if (!signatureValid) return response(401, 'Invalid signature');
    if (!supportedGitHubWebhookEvents.has(event)) {
      return response(202, 'Ignored event');
    }
    try {
      payload = JSON.parse(utf8Decoder.decode(body.rawBody));
    } catch {
      return response(400, 'Invalid JSON');
    }
  }

  const actionValue = record(payload)?.action;
  const actionless = event === 'push' || event === 'team_add';
  const action = actionless ? null : actionValue;
  if (
    !actionless
    && (typeof action !== 'string' || !eventActionPattern.test(action))
  ) {
    return response(422, 'Invalid webhook action');
  }
  if (event === 'repository') {
    const extracted = extractRepositoryScopeWorkItem(
      payload,
      deliveryId,
      event,
      action as string,
      dependencies.clock().toISOString(),
    );
    if (extracted.disposition === 'ignore') {
      return response(202, 'Ignored event');
    }
    if (extracted.disposition !== 'enqueue') {
      return response(422, 'Invalid repository webhook payload');
    }
    const canonicalText = canonicalStewardRuntimeScopeWorkItemJson(
      extracted.workItem,
    );
    if (encoder.encode(canonicalText).byteLength >= MAX_QUEUE_MESSAGE_BYTES) {
      return response(413, 'Queue message too large');
    }
    try {
      await Promise.race([
        env.EVENT_QUEUE.send(canonicalText, { contentType: 'text' }),
        deadlineFailure,
      ]);
    } catch (error) {
      return error instanceof IngressDeadlineError
        ? response(503, 'Ingress deadline exceeded')
        : response(503, 'Event queue unavailable');
    }
    return response(202, 'Accepted');
  }
  const teamRepositoryScoped = event === 'team'
    && (
      action === 'added_to_repository'
      || action === 'removed_from_repository'
      || (
        action === 'edited'
        && record(record(record(payload)?.changes)?.repository)?.permissions
          !== undefined
      )
    );
  if (
    event === 'custom_property_values'
    || event === 'team_add'
    || event === 'push'
    || teamRepositoryScoped
  ) {
    const extracted = extractRepositoryScopeWorkItemV2(
      payload,
      deliveryId,
      event,
      action as string | null,
      dependencies.clock().toISOString(),
    );
    if (extracted.disposition === 'ignore') {
      return response(202, 'Ignored event');
    }
    if (extracted.disposition !== 'enqueue') {
      return response(422, 'Invalid repository-scoped webhook payload');
    }
    const canonicalText = canonicalStewardRuntimeScopeWorkItemJson(
      extracted.workItem,
    );
    if (encoder.encode(canonicalText).byteLength >= MAX_QUEUE_MESSAGE_BYTES) {
      return response(413, 'Queue message too large');
    }
    try {
      await Promise.race([
        env.EVENT_QUEUE.send(canonicalText, { contentType: 'text' }),
        deadlineFailure,
      ]);
    } catch (error) {
      return error instanceof IngressDeadlineError
        ? response(503, 'Ingress deadline exceeded')
        : response(503, 'Event queue unavailable');
    }
    return response(202, 'Accepted');
  }
  if (
    event === 'custom_property'
    || event === 'membership'
    || event === 'team'
    || event === 'installation'
    || event === 'installation_repositories'
    || event === 'installation_target'
  ) {
    const extracted = extractInstallationScopeWorkItemV2(
      payload,
      deliveryId,
      event,
      action as string,
      dependencies.clock().toISOString(),
    );
    if (extracted.disposition === 'ignore') {
      return response(202, 'Ignored event');
    }
    if (extracted.disposition !== 'enqueue') {
      return response(422, 'Invalid installation-scoped webhook payload');
    }
    const canonicalText = canonicalStewardRuntimeScopeWorkItemJson(
      extracted.workItem,
    );
    if (encoder.encode(canonicalText).byteLength >= MAX_QUEUE_MESSAGE_BYTES) {
      return response(413, 'Queue message too large');
    }
    try {
      await Promise.race([
        env.EVENT_QUEUE.send(canonicalText, { contentType: 'text' }),
        deadlineFailure,
      ]);
    } catch (error) {
      return error instanceof IngressDeadlineError
        ? response(503, 'Ingress deadline exceeded')
        : response(503, 'Event queue unavailable');
    }
    return response(202, 'Accepted');
  }
  const supportedCause = supportedGitHubWebhookEventAction(
    event,
    action as string,
  );
  if (supportedCause === null) {
    return response(202, 'Ignored event or action');
  }

  const workItem = extractWorkItem(
    payload,
    deliveryId,
    supportedCause,
    dependencies.clock().toISOString(),
  );
  if (workItem === null) return response(422, 'Invalid webhook payload');

  const canonicalText = canonicalStewardRuntimeWorkItemJson(workItem);
  if (encoder.encode(canonicalText).byteLength >= MAX_QUEUE_MESSAGE_BYTES) {
    return response(413, 'Queue message too large');
  }

  try {
    await Promise.race([
      env.EVENT_QUEUE.send(canonicalText, { contentType: 'text' }),
      deadlineFailure,
    ]);
  } catch (error) {
    return error instanceof IngressDeadlineError
      ? response(503, 'Ingress deadline exceeded')
      : response(503, 'Event queue unavailable');
  }
  return response(202, 'Accepted');
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleIngressRequest(request, env);
  },
};
