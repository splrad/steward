import {
  buildStewardRuntimeWorkItem,
  canonicalStewardRuntimeWorkItemJson,
  STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
  type StewardRuntimePullRequestActionV1,
} from '../../core/src/runtime-work-item.js';

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const MAX_INGRESS_RESPONSE_MS = 9_000;
// Cloudflare measures a Queue KB as 1000 bytes and counts roughly 100 bytes of
// internal metadata against the 128 KB limit. Keep an explicit safety margin.
export const MAX_QUEUE_MESSAGE_BYTES = 127_000;

export const SUPPORTED_PULL_REQUEST_ACTIONS:
ReadonlySet<StewardRuntimePullRequestActionV1> = new Set([
  ...STEWARD_RUNTIME_PULL_REQUEST_ACTIONS_V1,
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

function contentLengthResponse(request: Request): Response | null {
  const contentLength = request.headers.get('content-length');
  if (contentLength === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
    return response(400, 'Invalid Content-Length');
  }
  if (BigInt(contentLength) > BigInt(MAX_WEBHOOK_BODY_BYTES)) {
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
  action: StewardRuntimePullRequestActionV1,
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
    || root.action !== action
    || installationId === null
    || repositoryId === null
    || pullRequestNumber === null
    || typeof repositoryFullName !== 'string'
  ) {
    return null;
  }

  try {
    return buildStewardRuntimeWorkItem({
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
        event: 'pull_request',
        action,
        receivedAt,
      },
    });
  } catch {
    return null;
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

  const declaredLengthFailure = contentLengthResponse(request);
  if (declaredLengthFailure !== null) return declaredLengthFailure;

  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const deliveryId = request.headers.get('x-github-delivery') ?? '';
  const event = request.headers.get('x-github-event') ?? '';
  if (!signaturePattern.test(signature)) return response(401, 'Invalid signature');
  if (!deliveryIdPattern.test(deliveryId)) return response(400, 'Invalid delivery ID');
  if (!eventActionPattern.test(event)) return response(400, 'Invalid event');
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return response(503, 'Webhook verification unavailable');
  }

  const deadlineSignal = dependencies.deadlineSignal?.()
    ?? AbortSignal.timeout(MAX_INGRESS_RESPONSE_MS);
  const deadlineFailure = rejectAtDeadline(deadlineSignal);

  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await Promise.race([
      readBodyWithLimit(request, deadlineSignal),
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

  let signatureValid: boolean;
  try {
    signatureValid = await Promise.race([
      (dependencies.verifySignature ?? verifyGitHubWebhookSignature)(
        rawBody,
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
  if (!signatureValid) {
    return response(401, 'Invalid signature');
  }
  if (event !== 'pull_request') return response(202, 'Ignored event');

  let payload: unknown;
  try {
    payload = JSON.parse(utf8Decoder.decode(rawBody));
  } catch {
    return response(400, 'Invalid JSON');
  }

  const action = record(payload)?.action;
  if (typeof action !== 'string' || !eventActionPattern.test(action)) {
    return response(422, 'Invalid pull request action');
  }
  if (!supportedPullRequestAction(action)) {
    return response(202, 'Ignored pull request action');
  }

  const workItem = extractWorkItem(
    payload,
    deliveryId,
    action,
    dependencies.clock().toISOString(),
  );
  if (workItem === null) return response(422, 'Invalid pull request payload');

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
