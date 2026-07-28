import { describe, expect, it, vi } from 'vitest';
import {
  parseStewardRuntimeScopeWorkItemV2,
} from '../packages/core/src/index.js';
import {
  handleIngressRequest,
  MAX_LARGE_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
  type Env,
  type Queue,
} from '../packages/ingress/src/index.js';
import {
  MAX_STREAMED_JSON_DEPTH,
  MAX_STREAMED_JSON_STRING_BYTES,
  StreamedBroadWebhookProcessor,
} from '../packages/ingress/src/large-webhook.js';

const currentSecret = 'large-current-secret';
const previousSecret = 'large-previous-secret';
const receivedAt = '2026-07-28T08:09:10.111Z';
const installationId = 145_952_003;
const repositoryId = 1_298_587_318;

async function signature(body: string, secret = currentSecret): Promise<string> {
  return signatureBytes(new TextEncoder().encode(body), secret);
}

async function signatureBytes(
  body: Uint8Array<ArrayBuffer>,
  secret = currentSecret,
): Promise<string> {
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
    body,
  );
  return `sha256=${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function webhookRequest(
  event: string,
  body: string,
  options: {
    readonly contentLength?: string;
    readonly secret?: string;
    readonly signature?: string;
  } = {},
): Promise<Request> {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-delivery': `${event}-large-delivery`,
    'x-github-event': event,
    'x-hub-signature-256': options.signature
      ?? await signature(body, options.secret),
  });
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  return new Request('https://ingress.example/github/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

function environment() {
  const send = vi.fn<Queue<string>['send']>(async () => undefined);
  const env: Env = {
    EVENT_QUEUE: { send },
    GITHUB_WEBHOOK_SECRET: currentSecret,
    GITHUB_WEBHOOK_SECRET_PREVIOUS: previousSecret,
  };
  return { env, send };
}

const dependencies = {
  clock: () => new Date(receivedAt),
};

function largeDefaultBranchPush(): string {
  const commits = Array.from({ length: 2_048 }, (_, index) => ({
    id: index.toString(16).padStart(40, '0'),
    message: `commit-${index}-${'x'.repeat(560)}`,
  }));
  const body = JSON.stringify({
    installation: { id: installationId },
    repository: {
      id: repositoryId,
      default_branch: 'main',
    },
    ref: 'refs/heads/main',
    commits,
  });
  expect(new TextEncoder().encode(body).byteLength)
    .toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);
  expect(new TextEncoder().encode(body).byteLength)
    .toBeLessThan(MAX_LARGE_WEBHOOK_BODY_BYTES);
  return body;
}

function boundedLargeNoise(): readonly string[] {
  return Array.from(
    { length: 2_048 },
    (_, index) => `noise-${index}-${'x'.repeat(560)}`,
  );
}

describe('Ingress large broad-webhook streaming boundary', () => {
  it('preserves only bounded installation repository snapshot IDs for teardown routing', async () => {
    const body = JSON.stringify({
      action: 'deleted',
      installation: { id: installationId, untrusted: 'drop-me' },
      repositories: [
        { id: 30, full_name: 'untrusted/thirty' },
        { id: 10, full_name: 'untrusted/ten' },
      ],
      ignored_noise: boundedLargeNoise(),
    });
    const processor = new StreamedBroadWebhookProcessor(
      'installation',
      currentSecret,
      previousSecret,
    );
    const bytes = new TextEncoder().encode(body);
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      processor.write(bytes.subarray(offset, offset + 64 * 1024));
    }
    const result = processor.finish(await signature(body));
    expect(result).toMatchObject({
      jsonValid: true,
      projectionValid: true,
      signatureValid: true,
      payload: {
        action: 'deleted',
        installation: { id: installationId },
        repositories: [{ id: 30 }, { id: 10 }],
      },
    });
    expect(JSON.stringify(result.payload)).not.toContain('untrusted');
    expect(JSON.stringify(result.payload)).not.toContain('ignored_noise');
  });

  it('fails closed when an installation teardown snapshot exceeds 5,000 IDs', async () => {
    const body = JSON.stringify({
      action: 'suspend',
      installation: { id: installationId },
      repositories: Array.from(
        { length: 5_001 },
        (_, index) => ({ id: index + 1 }),
      ),
    });
    const processor = new StreamedBroadWebhookProcessor(
      'installation',
      currentSecret,
    );
    processor.write(new TextEncoder().encode(body));
    const result = processor.finish(await signature(body));
    expect(result.jsonValid).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.projectionValid).toBe(false);
  });

  it.each(['suspend', 'deleted'] as const)(
    'routes a >1 MiB installation.%s snapshot as a bounded repository set',
    async (action) => {
      const body = JSON.stringify({
        action,
        installation: { id: installationId },
        repositories: [{ id: 30 }, { id: 10 }, { id: 30 }],
        ignored_noise: boundedLargeNoise(),
      });
      const queue = environment();
      const response = await handleIngressRequest(
        await webhookRequest('installation', body),
        queue.env,
        dependencies,
      );
      expect(response.status).toBe(202);
      const workItem = parseStewardRuntimeScopeWorkItemV2(
        JSON.parse(String(queue.send.mock.calls[0]?.[0])),
      );
      expect(workItem.target).toEqual({
        scope: 'repository-set',
        mode: 'refresh',
        installationId,
        repositoryIds: [10, 30],
        pullRequests: 'all-open',
      });
    },
  );

  it('distinguishes an explicit empty teardown snapshot from a missing snapshot', async () => {
    for (const [payload, expectedScope] of [
      [{
        action: 'suspend',
        installation: { id: installationId },
        repositories: [],
      }, 'repository-set'],
      [{
        action: 'suspend',
        installation: { id: installationId },
      }, 'installation'],
    ] as const) {
      const body = JSON.stringify({
        ...payload,
        ignored_noise: boundedLargeNoise(),
      });
      const queue = environment();
      const response = await handleIngressRequest(
        await webhookRequest('installation', body),
        queue.env,
        dependencies,
      );
      expect(response.status).toBe(202);
      const workItem = parseStewardRuntimeScopeWorkItemV2(
        JSON.parse(String(queue.send.mock.calls[0]?.[0])),
      );
      expect(workItem.target.scope).toBe(expectedScope);
      if (expectedScope === 'repository-set') {
        expect(workItem.target).toMatchObject({ repositoryIds: [] });
      }
    }
  });

  it('ignores an oversized repositories field for non-teardown installation actions', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: installationId },
      repositories: Array.from(
        { length: 5_001 },
        (_, index) => ({ id: index + 1 }),
      ),
      ignored_noise: boundedLargeNoise(),
    });
    const queue = environment();
    const response = await handleIngressRequest(
      await webhookRequest('installation', body),
      queue.env,
      dependencies,
    );
    expect(response.status).toBe(202);
    const workItem = parseStewardRuntimeScopeWorkItemV2(
      JSON.parse(String(queue.send.mock.calls[0]?.[0])),
    );
    expect(workItem.target.scope).toBe('installation');
  });

  it('rejects an invalid intermediate scalar on both sides of the streaming threshold', async () => {
    const malformed = {
      action: 'added',
      installation: { id: installationId },
      scope: 'team',
      team: { id: 999 },
      member: 'malformed-member',
    };
    for (const payload of [
      malformed,
      {
        ...malformed,
        ignored_noise: boundedLargeNoise(),
      },
    ]) {
      const body = JSON.stringify(payload);
      const queue = environment();
      const response = await handleIngressRequest(
        await webhookRequest('membership', body),
        queue.env,
        dependencies,
      );
      expect(response.status).toBe(422);
      expect(queue.send).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['custom_property', {
      action: 'updated',
      installation: { id: installationId },
      definition: { property_name: 'steward_ring' },
    }],
    ['custom_property_values', {
      action: 'updated',
      installation: { id: installationId },
      repository: { id: repositoryId },
    }],
    ['membership', {
      action: 'added',
      installation: { id: installationId },
      scope: 'team',
      team: { id: 999 },
      member: { id: 42 },
    }],
    ['team', {
      action: 'edited',
      installation: { id: installationId },
      repository: { id: repositoryId },
      team: { id: 999 },
      changes: {
        repository: {
          permissions: { from: { pull: true } },
        },
      },
    }],
    ['team_add', {
      installation: { id: installationId },
      repository: { id: repositoryId },
      team: { id: 999 },
    }],
    ['installation', {
      action: 'suspend',
      installation: { id: installationId },
    }],
    ['installation_repositories', {
      action: 'removed',
      installation: { id: installationId },
      repositories_added: [],
      repositories_removed: [{ id: repositoryId }],
    }],
    ['installation_target', {
      action: 'renamed',
      target_type: 'Organization',
      account: { id: 302_208_797 },
      installation: {
        id: installationId,
        account: { id: 302_208_797 },
      },
      changes: { login: { from: 'old-name' } },
    }],
  ] as const)(
    'selectively projects a >1 MiB %s payload without retaining ignored data',
    async (event, payload) => {
      const body = JSON.stringify({
        ...payload,
        ignored_noise: boundedLargeNoise(),
      });
      const queue = environment();
      const result = await handleIngressRequest(
        await webhookRequest(event, body),
        queue.env,
        dependencies,
      );
      expect(result.status).toBe(202);
      expect(queue.send).toHaveBeenCalledOnce();
      const canonical = String(queue.send.mock.calls[0]?.[0]);
      expect(canonical).not.toContain('ignored_noise');
      expect(new TextEncoder().encode(canonical).byteLength).toBeLessThan(2_048);
    },
  );

  it('accepts a no-Content-Length 2,048-commit default-branch push and enqueues only bounded Scope V2', async () => {
    const body = largeDefaultBranchPush();
    const request = await webhookRequest('push', body);
    expect(request.headers.get('content-length')).toBeNull();
    const queue = environment();

    const result = await handleIngressRequest(
      request,
      queue.env,
      dependencies,
    );

    expect(result.status).toBe(202);
    expect(queue.send).toHaveBeenCalledOnce();
    const canonical = String(queue.send.mock.calls[0]?.[0]);
    expect(new TextEncoder().encode(canonical).byteLength).toBeLessThan(1_024);
    expect(canonical).not.toContain('commits');
    expect(canonical).not.toContain('commit-2047');
    expect(parseStewardRuntimeScopeWorkItemV2(JSON.parse(canonical)))
      .toMatchObject({
        schemaVersion: 2,
        target: {
          scope: 'repository',
          installationId,
          repositoryId,
        },
        cause: {
          event: 'push',
          action: null,
          ref: 'refs/heads/main',
          receivedAt,
        },
      });
  });

  it('uses incremental HMAC with the previous rotation secret', async () => {
    const body = largeDefaultBranchPush();
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('push', body, { secret: previousSecret }),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(202);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it('rejects an invalid large-body signature before enqueueing', async () => {
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('push', largeDefaultBranchPush(), {
        signature: `sha256=${'0'.repeat(64)}`,
      }),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(401);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('authenticates the complete body and then rejects invalid streamed JSON', async () => {
    const invalidBody = largeDefaultBranchPush().slice(0, -1);
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('push', invalidBody),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(400);
    expect(await result.text()).toBe('Invalid JSON');
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('rejects streamed trailing commas and multiple top-level values', async () => {
    const validBody = largeDefaultBranchPush();
    for (const invalidBody of [
      `${validBody.slice(0, -1)},}`,
      `${validBody}{}`,
    ]) {
      const queue = environment();
      const result = await handleIngressRequest(
        await webhookRequest('push', invalidBody),
        queue.env,
        dependencies,
      );
      expect(result.status).toBe(400);
      expect(await result.text()).toBe('Invalid JSON');
      expect(queue.send).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed UTF-8 across the large streaming path', async () => {
    const prefix = new TextEncoder().encode(
      `{"installation":{"id":${installationId}},`
      + `"repository":{"id":${repositoryId}},`
      + '"ref":"refs/heads/main",'
      + `"ignored_noise":${JSON.stringify(boundedLargeNoise())},`
      + '"bad":"',
    );
    const suffix = new TextEncoder().encode('"}');
    const body = new Uint8Array(prefix.byteLength + 3 + suffix.byteLength);
    body.set(prefix);
    body.set([0xe2, 0x28, 0xa1], prefix.byteLength);
    body.set(suffix, prefix.byteLength + 3);
    const request = new Request('https://ingress.example/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'push-invalid-utf8',
        'x-github-event': 'push',
        'x-hub-signature-256': await signatureBytes(body),
      },
      body,
    });
    const queue = environment();
    const response = await handleIngressRequest(
      request,
      queue.env,
      dependencies,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid JSON');
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fails closed on an oversized single JSON token without retaining it', async () => {
    const body = JSON.stringify({
      installation: { id: installationId },
      repository: { id: repositoryId },
      ref: 'refs/heads/main',
      ignored_noise: 'x'.repeat(
        Math.max(
          MAX_WEBHOOK_BODY_BYTES + 1,
          MAX_STREAMED_JSON_STRING_BYTES + 1,
        ),
      ),
    });
    const queue = environment();
    const response = await handleIngressRequest(
      await webhookRequest('push', body),
      queue.env,
      dependencies,
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(
      'Webhook JSON exceeds streaming limits',
    );
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fails closed before deeply nested JSON can grow an unbounded path stack', async () => {
    const depth = MAX_STREAMED_JSON_DEPTH + 1;
    const body = `{"installation":{"id":${installationId}},`
      + `"repository":{"id":${repositoryId}},`
      + '"ref":"refs/heads/main",'
      + `"ignored_noise":${JSON.stringify(boundedLargeNoise())},`
      + `"deep":${'['.repeat(depth)}0${']'.repeat(depth)}}`;
    const queue = environment();
    const response = await handleIngressRequest(
      await webhookRequest('push', body),
      queue.env,
      dependencies,
    );
    expect(response.status).toBe(413);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fails closed on a streamed selected-path array overflow', async () => {
    const body = JSON.stringify({
      action: 'added',
      installation: { id: installationId },
      repositories_added: Array.from(
        { length: 5_001 },
        (_, index) => ({ id: index + 1 }),
      ),
      repositories_removed: [],
      ignored_noise: boundedLargeNoise(),
    });
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('installation_repositories', body),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(422);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it.each([
    ['installation', {
      action: 'suspend',
      installation: { id: installationId },
      repositories: Array.from(
        { length: 5_001 },
        () => ({ id: repositoryId }),
      ),
    }],
    ['installation_repositories', {
      action: 'added',
      installation: { id: installationId },
      repositories_added: Array.from(
        { length: 5_001 },
        () => ({ id: repositoryId }),
      ),
      repositories_removed: [],
    }],
  ] as const)(
    'rejects duplicate-heavy over-cap %s arrays on both sides of 1 MiB',
    async (event, payload) => {
      for (const candidate of [
        payload,
        {
          ...payload,
          ignored_noise: boundedLargeNoise(),
        },
      ]) {
        const queue = environment();
        const response = await handleIngressRequest(
          await webhookRequest(event, JSON.stringify(candidate)),
          queue.env,
          dependencies,
        );
        expect(response.status).toBe(422);
        expect(queue.send).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects a declared provider-oversized broad payload before reading it', async () => {
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('push', '{}', {
        contentLength: String(MAX_LARGE_WEBHOOK_BODY_BYTES + 1),
      }),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(413);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('enforces the 25 MiB streamed limit without Content-Length', async () => {
    const chunkSize = 64 * 1024;
    let emitted = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const remaining = MAX_LARGE_WEBHOOK_BODY_BYTES + 1 - emitted;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, remaining);
        emitted += size;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://ingress.example/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'push-provider-oversize',
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const queue = environment();

    const result = await handleIngressRequest(
      request,
      queue.env,
      dependencies,
    );

    expect(result.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('cancels a stalled large-body reader at the shared deadline', async () => {
    let pullCount = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(
            new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1).fill(0x20),
          );
          return;
        }
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://ingress.example/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'push-stalled-stream',
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const deadline = new AbortController();
    const queue = environment();
    const resultPromise = handleIngressRequest(request, queue.env, {
      clock: () => new Date(receivedAt),
      deadlineSignal: () => deadline.signal,
    });
    await vi.waitFor(() => {
      expect(pullCount).toBeGreaterThan(1);
    });
    deadline.abort('large-ingress-deadline');

    const result = await resultPromise;
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('Ingress deadline exceeded');
    await vi.waitFor(() => {
      expect(cancelled).toBe(true);
    });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('keeps non-broad events at the original 1 MiB hard cap', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: installationId },
      repository: { id: repositoryId, full_name: 'splrad/example' },
      pull_request: { number: 1 },
      ignored_noise: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES),
    });
    const queue = environment();
    const result = await handleIngressRequest(
      await webhookRequest('pull_request', body),
      queue.env,
      dependencies,
    );
    expect(result.status).toBe(413);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
