import { describe, expect, it, vi } from 'vitest';
import { handleRequest, verifySignature, type Env } from '../src/index.js';

const secret = "It's a Secret to Everybody";
const headSha = 'a'.repeat(40);

class MemoryCoordinatorNamespace {
  values = new Map<string, { state: 'claimed' | 'dispatched'; updatedAt: number }>();
  failures = new Set<string>();

  getByName(name: string) {
    return {
      fetch: async (input: RequestInfo | URL) => {
        const action = new URL(String(input)).pathname;
        if (this.failures.has(action)) throw new Error(`Coordinator ${action} unavailable`);
        if (action === '/claim') {
          const existing = this.values.get(name);
          if (existing?.state === 'dispatched') return new Response('Duplicate delivery');
          if (existing?.state === 'claimed' && Date.now() - existing.updatedAt < 60_000) {
            return new Response('Delivery is already processing', { status: 409 });
          }
          this.values.set(name, { state: 'claimed', updatedAt: Date.now() });
          return new Response('Claimed', { status: 201 });
        }
        if (action === '/complete') {
          this.values.set(name, { state: 'dispatched', updatedAt: Date.now() });
          return new Response('Completed');
        }
        if (action === '/release') {
          this.values.delete(name);
          return new Response('Released');
        }
        return new Response('Not found', { status: 404 });
      },
    };
  }
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'resolved',
    installation: { id: 7 },
    repository: { id: 42, full_name: 'splrad/steward-sandbox', default_branch: 'main' },
    pull_request: {
      number: 7,
      state: 'open',
      base: { ref: 'main' },
      head: { sha: headSha },
    },
    thread: { node_id: 'PRRT_kwDOExample' },
    ...overrides,
  };
}

function manifest(webhookRelay = true, schemaVersion: number = 1) {
  return {
    schemaVersion,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: false,
      dcoAdvisory: false,
      governance: false,
      copilotReview: false,
      release: false,
      webhookRelay,
    },
  };
}

function manifestFile(value: unknown = manifest()): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return Response.json({
    type: 'file',
    encoding: 'base64',
    content: btoa(binary),
  });
}

function githubApi(manifestResponse: Response = manifestFile(), dispatchStatus = 204) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'POST'
      ? new Response(null, { status: dispatchStatus })
      : manifestResponse.clone()
  ));
}

function dispatchCall(githubFetch: ReturnType<typeof githubApi>) {
  return githubFetch.mock.calls.find(([, init]) => init?.method === 'POST');
}

async function requestFor(event: string, body: string, delivery = 'delivery-1', signed = true) {
  return new Request('https://relay.example.test', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': signed ? await signature(body) : 'sha256=invalid',
    },
    body,
  });
}

function environment(coordinator = new MemoryCoordinatorNamespace()): Env {
  return {
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'private-key',
    DELIVERY_COORDINATOR: coordinator as unknown as DurableObjectNamespace,
  };
}

describe('signature verification', () => {
  it('matches the official GitHub HMAC test vector', async () => {
    const bytes = new TextEncoder().encode('Hello, World!');
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await verifySignature(
      body,
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      secret,
    )).toBe(true);
  });

  it('rejects missing and invalid signatures', async () => {
    const bytes = new TextEncoder().encode('{}');
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await verifySignature(body, '', secret)).toBe(false);
    expect(await verifySignature(body, 'sha256=invalid', secret)).toBe(false);
  });
});

describe('webhook relay', () => {
  it('answers signed ping without creating a token', async () => {
    const body = '{}';
    const installationToken = vi.fn();
    const result = await handleRequest(await requestFor('ping', body), environment(), {
      fetch: vi.fn(),
      installationToken,
    });
    expect(result.status).toBe(200);
    expect(installationToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    const body = JSON.stringify(payload());
    const result = await handleRequest(await requestFor('pull_request_review_thread', body, 'bad', false), environment());
    expect(result.status).toBe(401);
  });

  it.each([
    ['event', 'issues', payload()],
    ['action', 'pull_request_review_thread', payload({ action: 'submitted' })],
    ['review action', 'pull_request_review', payload({ action: 'created' })],
    ['comment action', 'pull_request_review_comment', payload({ action: 'submitted' })],
    ['repository name', 'pull_request_review_thread', payload({ repository: { id: 42, full_name: 'invalid name' } })],
    ['base', 'pull_request_review_thread', payload({ pull_request: { number: 7, state: 'open', base: { ref: 'dev' }, head: { sha: headSha } } })],
    ['closed PR', 'pull_request_review_thread', payload({ pull_request: { number: 7, state: 'closed', base: { ref: 'main' }, head: { sha: headSha } } })],
  ])('ignores a non-target %s', async (_name, event, value) => {
    const body = JSON.stringify(value);
    const installationToken = vi.fn();
    const result = await handleRequest(await requestFor(event, body), environment(), {
      fetch: vi.fn(),
      installationToken,
    });
    expect(result.status).toBe(202);
    expect(installationToken).not.toHaveBeenCalled();
  });

  it.each([
    ['thread', 'pull_request_review_thread', payload(), {
      thread_node_id: 'PRRT_kwDOExample', review_id: 0, comment_id: 0,
    }],
    ['review', 'pull_request_review', payload({
      action: 'submitted',
      thread: undefined,
      review: { id: 501 },
    }), {
      thread_node_id: '', review_id: 501, comment_id: 0,
    }],
    ['review comment', 'pull_request_review_comment', payload({
      action: 'created',
      thread: undefined,
      comment: { id: 601, pull_request_review_id: 501 },
    }), {
      thread_node_id: '', review_id: 501, comment_id: 601,
    }],
  ])('dispatches a %s signal once with the fixed payload', async (_name, event, value, identifiers) => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(value);
    const githubFetch = githubApi();
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };
    const delivery = `${event}-delivery`;
    const first = await handleRequest(await requestFor(event, body, delivery), environment(coordinator), dependencies);
    const second = await handleRequest(await requestFor(event, body, delivery), environment(coordinator), dependencies);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(githubFetch).toHaveBeenCalledTimes(2);
    expect(dependencies.installationToken).toHaveBeenCalledTimes(1);
    expect(dependencies.installationToken).toHaveBeenCalledWith(
      expect.anything(), 7, 42, { contents: 'write' },
    );
    const [input, init] = dispatchCall(githubFetch) ?? [];
    expect(String(input)).toBe('https://api.github.com/repos/splrad/steward-sandbox/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({
      event_type: 'pr-review-state-changed',
      client_payload: {
        repository_id: 42,
        pr_number: 7,
        head_sha: headSha,
        source_event: event,
        action: String(value.action),
        delivery_id: delivery,
        ...identifiers,
      },
    });
  });

  it.each([
    ['repository rename', payload({
      repository: { id: 42, full_name: 'splrad/renamed-sandbox', default_branch: 'main' },
    })],
    ['non-main default branch', payload({
      repository: { id: 42, full_name: 'splrad/steward-sandbox', default_branch: 'trunk' },
      pull_request: { number: 7, state: 'open', base: { ref: 'trunk' }, head: { sha: headSha } },
    })],
  ])('accepts %s from signed repository metadata', async (_name, value) => {
    const body = JSON.stringify(value);
    const githubFetch = githubApi();
    const result = await handleRequest(await requestFor('pull_request_review_thread', body), environment(), {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    });
    expect(result.status).toBe(202);
    expect(dispatchCall(githubFetch)).toBeDefined();
  });

  it('routes two repositories independently without a target repository setting', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const githubFetch = githubApi();
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };
    const first = payload();
    const second = payload({
      repository: { id: 84, full_name: 'splrad/another-repository', default_branch: 'main' },
      pull_request: { number: 8, state: 'open', base: { ref: 'main' }, head: { sha: 'b'.repeat(40) } },
    });

    expect((await handleRequest(
      await requestFor('pull_request_review', JSON.stringify({ ...first, action: 'submitted' }), 'first'),
      environment(coordinator),
      dependencies,
    )).status).toBe(202);
    expect((await handleRequest(
      await requestFor('pull_request_review', JSON.stringify({ ...second, action: 'submitted' }), 'second'),
      environment(coordinator),
      dependencies,
    )).status).toBe(202);

    const dispatchUrls = githubFetch.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([input]) => String(input));
    expect(dispatchUrls).toEqual([
      'https://api.github.com/repos/splrad/steward-sandbox/dispatches',
      'https://api.github.com/repos/splrad/another-repository/dispatches',
    ]);
    expect(dependencies.installationToken).toHaveBeenNthCalledWith(1, expect.anything(), 7, 42, { contents: 'write' });
    expect(dependencies.installationToken).toHaveBeenNthCalledWith(2, expect.anything(), 7, 84, { contents: 'write' });
  });

  it.each([
    ['missing manifest', new Response(null, { status: 404 }), 202, 'Ignored: Steward manifest not found'],
    ['disabled feature', manifestFile(manifest(false)), 202, 'Ignored: Steward relay disabled'],
    ['unknown schema version', manifestFile(manifest(true, 2)), 422, 'Invalid Steward manifest'],
    ['invalid manifest response', Response.json({ type: 'dir' }), 422, 'Invalid Steward manifest'],
  ])('does not dispatch for %s', async (_name, manifestResponse, status, message) => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const githubFetch = githubApi(manifestResponse);
    const result = await handleRequest(await requestFor('pull_request_review_thread', body), environment(coordinator), {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    });
    expect(result.status).toBe(status);
    expect(await result.text()).toBe(message);
    expect(dispatchCall(githubFetch)).toBeUndefined();
    expect(coordinator.values.has('42:delivery-1')).toBe(false);
  });

  it('releases an ignored delivery so a later Manifest opt-in can dispatch it', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(manifestFile(manifest(false)))
      .mockResolvedValueOnce(manifestFile())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };

    const ignored = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    const dispatched = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );

    expect(ignored.status).toBe(202);
    expect(dispatched.status).toBe(202);
    expect(await dispatched.text()).toBe('Dispatched');
    expect(dispatchCall(githubFetch as ReturnType<typeof githubApi>)).toBeDefined();
  });

  it('releases the claim when App installation token creation fails', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const result = await handleRequest(await requestFor('pull_request_review_thread', body), environment(coordinator), {
      fetch: vi.fn(),
      installationToken: vi.fn().mockRejectedValue(new Error('not installed')),
    });
    expect(result.status).toBe(502);
    expect(coordinator.values.has('42:delivery-1')).toBe(false);
  });

  it('returns a controlled retry response when the delivery claim is unavailable', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    coordinator.failures.add('/claim');
    const githubFetch = githubApi();
    const result = await handleRequest(
      await requestFor('pull_request_review_thread', JSON.stringify(payload())),
      environment(coordinator),
      {
        fetch: githubFetch as typeof fetch,
        installationToken: vi.fn().mockResolvedValue('installation-token'),
      },
    );

    expect(result.status).toBe(503);
    expect(await result.text()).toBe('Delivery coordinator unavailable');
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('preserves the original failure when releasing a claim is unavailable', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    coordinator.failures.add('/release');
    const result = await handleRequest(
      await requestFor('pull_request_review_thread', JSON.stringify(payload())),
      environment(coordinator),
      {
        fetch: vi.fn(),
        installationToken: vi.fn().mockRejectedValue(new Error('not installed')),
      },
    );

    expect(result.status).toBe(502);
    expect(await result.text()).toBe('GitHub installation token creation failed');
    expect(coordinator.values.get('42:delivery-1')?.state).toBe('claimed');
  });

  it('serializes concurrent retries before dispatch', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    let completeDispatch!: (response: Response) => void;
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(manifestFile())
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        completeDispatch = resolve;
      }));
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };

    const firstPromise = handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    await vi.waitFor(() => expect(dispatchCall(githubFetch as ReturnType<typeof githubApi>)).toBeDefined());
    const second = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    completeDispatch(new Response(null, { status: 204 }));
    const first = await firstPromise;

    expect(first.status).toBe(202);
    expect(second.status).toBe(503);
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate a failed GitHub dispatch', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const result = await handleRequest(await requestFor('pull_request_review_thread', body), environment(coordinator), {
      fetch: githubApi(manifestFile(), 500) as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    });
    expect(result.status).toBe(502);
    expect(coordinator.values.has('42:delivery-1')).toBe(false);
  });

  it('acknowledges a successful dispatch when completion state cannot be persisted', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    coordinator.failures.add('/complete');
    const githubFetch = githubApi();
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };
    const body = JSON.stringify(payload());

    const dispatched = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    const immediateRetry = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );

    expect(dispatched.status).toBe(202);
    expect(await dispatched.text()).toBe('Dispatched; completion state unavailable');
    expect(immediateRetry.status).toBe(503);
    expect(dispatchCall(githubFetch as ReturnType<typeof githubApi>)).toBeDefined();
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when the dispatch outcome is unknown', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(manifestFile())
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(manifestFile())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };

    const first = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    const second = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );

    expect(first.status).toBe(502);
    expect(second.status).toBe(202);
    expect(githubFetch).toHaveBeenCalledTimes(4);
    expect(coordinator.values.get('42:delivery-1')?.state).toBe('dispatched');
  });

  it('retries an abandoned claim after its lease expires', async () => {
    const coordinator = new MemoryCoordinatorNamespace();
    const body = JSON.stringify(payload());
    const githubFetch = githubApi();
    const dependencies = {
      fetch: githubFetch as typeof fetch,
      installationToken: vi.fn().mockResolvedValue('installation-token'),
    };
    coordinator.values.set('42:delivery-1', { state: 'claimed', updatedAt: Date.now() });

    const processing = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );
    coordinator.values.set('42:delivery-1', { state: 'claimed', updatedAt: 0 });
    const retried = await handleRequest(
      await requestFor('pull_request_review_thread', body),
      environment(coordinator),
      dependencies,
    );

    expect(processing.status).toBe(503);
    expect(retried.status).toBe(202);
    expect(dispatchCall(githubFetch)).toBeDefined();
    expect(coordinator.values.get('42:delivery-1')?.state).toBe('dispatched');
  });
});
