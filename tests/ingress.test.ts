import { describe, expect, it, vi } from 'vitest';
import {
  handleIngressRequest,
  MAX_INGRESS_RESPONSE_MS,
  MAX_WEBHOOK_BODY_BYTES,
  SUPPORTED_PULL_REQUEST_ACTIONS,
  verifyGitHubWebhookSignature,
  type Env,
  type Queue,
} from '../packages/ingress/src/index.js';

const currentSecret = "It's a Secret to Everybody";
const previousSecret = 'the previous webhook secret';
const fixedTime = new Date('2026-07-23T18:00:00.123Z');
const deliveryId = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

async function signature(body: string, secret = currentSecret): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

function payload(action = 'opened', overrides: Record<string, unknown> = {}) {
  return {
    action,
    installation: { id: 145_952_003 },
    repository: {
      id: 1_298_587_318,
      full_name: 'splrad/steward-sandbox-install-e2e',
    },
    pull_request: { number: 6 },
    ...overrides,
  };
}

function queue(rejection?: Error) {
  const send = rejection === undefined
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(rejection);
  return {
    binding: { send } as Queue<string>,
    send,
  };
}

function environment(
  eventQueue: Queue<string>,
  options: {
    readonly current?: string;
    readonly previous?: string;
  } = {},
): Env {
  return {
    EVENT_QUEUE: eventQueue,
    GITHUB_WEBHOOK_SECRET: options.current ?? currentSecret,
    ...(options.previous === undefined
      ? {}
      : { GITHUB_WEBHOOK_SECRET_PREVIOUS: options.previous }),
  };
}

async function webhookRequest(
  body: string,
  options: {
    readonly actionSecret?: string;
    readonly contentLength?: string;
    readonly contentType?: string;
    readonly delivery?: string;
    readonly event?: string;
    readonly extraHeaders?: Readonly<Record<string, string>>;
    readonly method?: string;
    readonly path?: string;
    readonly signed?: boolean;
  } = {},
): Promise<Request> {
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json',
    'x-github-delivery': options.delivery ?? deliveryId,
    'x-github-event': options.event ?? 'pull_request',
    'x-hub-signature-256': options.signed === false
      ? `sha256=${'0'.repeat(64)}`
      : await signature(body, options.actionSecret),
    ...options.extraHeaders,
  });
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  return new Request(`https://ingress.example.test${options.path ?? '/github/webhook'}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.method === 'GET' ? {} : { body }),
  });
}

const dependencies = {
  clock: () => fixedTime,
};

describe('Ingress GitHub HMAC verification', () => {
  it('matches the official GitHub HMAC-SHA256 test vector', async () => {
    expect(await verifyGitHubWebhookSignature(
      new TextEncoder().encode('Hello, World!'),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      currentSecret,
    )).toBe(true);
  });

  it('accepts current and previous rotation secrets but no unrelated secret', async () => {
    const body = JSON.stringify(payload());
    const rawBody = new TextEncoder().encode(body);
    expect(await verifyGitHubWebhookSignature(
      rawBody,
      await signature(body),
      currentSecret,
      previousSecret,
    )).toBe(true);
    expect(await verifyGitHubWebhookSignature(
      rawBody,
      await signature(body, previousSecret),
      currentSecret,
      previousSecret,
    )).toBe(true);
    expect(await verifyGitHubWebhookSignature(
      rawBody,
      await signature(body, 'unrelated'),
      currentSecret,
      previousSecret,
    )).toBe(false);
  });

  it.each([
    '',
    'sha1=757107ea0eb2509fc211221cce984b8a37570b6d7',
    'sha256=INVALID',
    `sha256=${'A'.repeat(64)}`,
    `sha256=${'0'.repeat(63)}`,
  ])('rejects a non-canonical signature header %j', async (value) => {
    expect(await verifyGitHubWebhookSignature(
      new TextEncoder().encode('{}'),
      value,
      currentSecret,
      previousSecret,
    )).toBe(false);
  });

  it('returns 503 when the shared deadline aborts stalled HMAC verification', async () => {
    const deadline = new AbortController();
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload())),
      environment(eventQueue.binding),
      {
        clock: () => fixedTime,
        deadlineSignal: () => deadline.signal,
        verifySignature: () => {
          deadline.abort('ingress-test-deadline');
          return new Promise<never>(() => undefined);
        },
      },
    );

    expect(result.status).toBe(503);
    expect(await result.text()).toBe('Ingress deadline exceeded');
    expect(eventQueue.send).not.toHaveBeenCalled();
  });
});

describe('public Ingress request boundary', () => {
  it('only exposes POST /github/webhook', async () => {
    const eventQueue = queue();
    const body = JSON.stringify(payload());
    expect((await handleIngressRequest(
      await webhookRequest(body, { path: '/other' }),
      environment(eventQueue.binding),
      dependencies,
    )).status).toBe(404);
    expect((await handleIngressRequest(
      await webhookRequest(body, { method: 'GET' }),
      environment(eventQueue.binding),
      dependencies,
    )).status).toBe(405);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it('accepts application/json with an optional UTF-8 charset only', async () => {
    const acceptedQueue = queue();
    const body = JSON.stringify(payload());
    const accepted = await handleIngressRequest(
      await webhookRequest(body, {
        contentType: 'Application/JSON; charset="utf-8"',
      }),
      environment(acceptedQueue.binding),
      dependencies,
    );
    expect(accepted.status).toBe(202);
    expect(acceptedQueue.send).toHaveBeenCalledOnce();

    for (const contentType of [
      'text/plain',
      'application/json; charset=iso-8859-1',
      'application/json; profile=github',
    ]) {
      const rejectedQueue = queue();
      const rejected = await handleIngressRequest(
        await webhookRequest(body, { contentType }),
        environment(rejectedQueue.binding),
        dependencies,
      );
      expect(rejected.status).toBe(415);
      expect(rejectedQueue.send).not.toHaveBeenCalled();
    }
  });

  it('rejects an obviously excessive Content-Length before reading or enqueueing', async () => {
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest('{}', {
        contentLength: String(MAX_WEBHOOK_BODY_BYTES + 1),
      }),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(413);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it('enforces the streamed byte limit despite a falsely small Content-Length', async () => {
    const eventQueue = queue();
    const oversizedBody = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    const result = await handleIngressRequest(
      await webhookRequest(oversizedBody, { contentLength: '1' }),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(413);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it.each([
    ['delivery', { delivery: 'bad delivery' }, 400],
    ['delivery length', { delivery: `d${'x'.repeat(128)}` }, 400],
    ['event', { event: 'Pull_Request' }, 400],
    ['signature', { signed: false }, 401],
  ] as const)('strictly rejects an invalid %s header', async (_label, options, status) => {
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload()), options),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(status);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it('accepts a request signed by the previous rotation secret', async () => {
    const eventQueue = queue();
    const body = JSON.stringify(payload());
    const result = await handleIngressRequest(
      await webhookRequest(body, { actionSecret: previousSecret }),
      environment(eventQueue.binding, { previous: previousSecret }),
      dependencies,
    );
    expect(result.status).toBe(202);
    expect(eventQueue.send).toHaveBeenCalledOnce();
  });
});

describe('Ingress payload extraction and durable enqueue', () => {
  it('rejects malformed JSON before enqueueing', async () => {
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest('{'),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(400);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it.each([
    ['installation.id', {
      installation: { id: '145952003' },
    }],
    ['repository.id', {
      repository: {
        id: '1298587318',
        full_name: 'splrad/steward-sandbox-install-e2e',
      },
    }],
    ['pull_request.number', {
      pull_request: { number: '6' },
    }],
  ])('rejects a numeric string in %s', async (_field, overrides) => {
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload('opened', overrides))),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(422);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it.each([
    ['issues', 'opened'],
    ['pull_request', 'assigned'],
  ])('ignores unsupported event/action %s:%s after verification', async (event, action) => {
    const eventQueue = queue();
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload(action)), { event }),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(202);
    expect(eventQueue.send).not.toHaveBeenCalled();
  });

  it.each([...SUPPORTED_PULL_REQUEST_ACTIONS])(
    'accepts the explicit pull_request action %s',
    async (action) => {
      const eventQueue = queue();
      const result = await handleIngressRequest(
        await webhookRequest(JSON.stringify(payload(action))),
        environment(eventQueue.binding),
        dependencies,
      );
      expect(result.status).toBe(202);
      expect(eventQueue.send).toHaveBeenCalledOnce();
    },
  );

  it('returns 503 when the durable Queue write rejects', async () => {
    const eventQueue = queue(new Error('queue unavailable'));
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload())),
      environment(eventQueue.binding),
      dependencies,
    );
    expect(result.status).toBe(503);
    expect(eventQueue.send).toHaveBeenCalledOnce();
  });

  it('returns 503 when the nine-second deadline aborts a hung Queue write', async () => {
    expect(MAX_INGRESS_RESPONSE_MS).toBe(9_000);
    const deadline = new AbortController();
    const send = vi.fn<Queue<string>['send']>(() => {
      deadline.abort('ingress-test-deadline');
      return new Promise<never>(() => undefined);
    });
    const result = await handleIngressRequest(
      await webhookRequest(JSON.stringify(payload())),
      environment({ send }),
      {
        clock: () => fixedTime,
        deadlineSignal: () => deadline.signal,
      },
    );

    expect(result.status).toBe(503);
    expect(await result.text()).toBe('Ingress deadline exceeded');
    expect(send).toHaveBeenCalledOnce();
  });

  it('awaits Queue persistence and sends only the canonical public work-item', async () => {
    let completeSend!: () => void;
    const send = vi.fn<Queue<string>['send']>(() => new Promise<void>((resolve) => {
      completeSend = resolve;
    }));
    const body = JSON.stringify({
      ...payload(),
      cause: {
        kind: 'operator-replay',
        replayId: 'publicly-supplied-replay',
      },
      internalProbe: true,
      workerVersion: 'publicly-supplied-candidate',
    });
    const request = await webhookRequest(body, {
      extraHeaders: {
        'cloudflare-workers-version-overrides': 'publicly-supplied-candidate',
      },
    });

    const resultPromise = handleIngressRequest(
      request,
      environment({ send }),
      dependencies,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    completeSend();
    const result = await resultPromise;
    expect(result.status).toBe(202);
    expect(send).toHaveBeenCalledWith(expect.any(String), { contentType: 'text' });
    const canonical = String(send.mock.calls[0]?.[0]);
    expect(JSON.parse(canonical)).toEqual({
      schemaVersion: 1,
      operation: 'pull-request-reconcile',
      installationId: 145_952_003,
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      cause: {
        kind: 'github-webhook',
        deliveryId,
        event: 'pull_request',
        action: 'opened',
        receivedAt: fixedTime.toISOString(),
      },
    });
    expect(canonical).not.toContain('operator-replay');
    expect(canonical).not.toContain('internal-probe');
    expect(canonical).not.toContain('publicly-supplied-candidate');
  });
});
