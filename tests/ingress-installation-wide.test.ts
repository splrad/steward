import { describe, expect, it, vi } from 'vitest';
import {
  parseStewardRuntimeScopeWorkItemV2,
} from '../packages/core/src/index.js';
import {
  handleIngressRequest,
  MAX_INSTALLATION_REPOSITORY_SET_IDS,
  type Env,
} from '../packages/ingress/src/index.js';

const installationId = 145_952_003;
const accountId = 302_208_797;
const receivedAt = '2026-07-28T03:04:05.678Z';

function webhookRequest(
  event: string,
  payload: unknown,
  deliveryId = `${event}-delivery`,
): Request {
  return new Request('https://ingress.example/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
    },
    body: JSON.stringify(payload),
  });
}

function testEnv() {
  const messages: string[] = [];
  const send = vi.fn(async (body: string) => {
    messages.push(body);
  });
  const env: Env = {
    EVENT_QUEUE: { send },
    GITHUB_WEBHOOK_SECRET: 'test-secret',
  };
  return { env, messages, send };
}

const acceptedDependencies = {
  clock: () => new Date(receivedAt),
  verifySignature: vi.fn(async () => true),
};

describe('Ingress installation-wide ScopeWorkItem V2 routing', () => {
  it.each([
    ['custom_property', 'updated', {
      action: 'updated',
      installation: { id: installationId },
      definition: { property_name: 'future-property' },
    }],
    ['membership', 'added', {
      action: 'added',
      installation: { id: installationId },
      scope: 'team',
      team: { id: 999_999 },
      member: { id: 42 },
    }],
    ['team', 'created', {
      action: 'created',
      installation: { id: installationId },
      team: { id: 999_999, slug: 'untrusted-team' },
    }],
    ['team', 'edited', {
      action: 'edited',
      installation: { id: installationId },
      team: { id: 999_999, slug: 'untrusted-team' },
      changes: { name: { from: 'old-name' } },
    }],
    ['installation', 'suspend', {
      action: 'suspend',
      installation: { id: installationId },
    }],
  ] as const)(
    'conservatively over-routes structurally valid %s.%s',
    async (event, action, payload) => {
      const queue = testEnv();
      const response = await handleIngressRequest(
        webhookRequest(event, payload),
        queue.env,
        acceptedDependencies,
      );
      expect(response.status).toBe(202);
      expect(queue.messages).toHaveLength(1);
      const workItem = parseStewardRuntimeScopeWorkItemV2(
        JSON.parse(queue.messages[0] ?? ''),
      );
      expect(workItem).toMatchObject({
        target: {
          scope: 'installation',
          installationId,
          repositories: 'all-live',
          pullRequests: 'all-open',
        },
        cause: {
          deliveryId: `${event}-delivery`,
          event,
          action,
          ref: null,
          receivedAt,
        },
      });
    },
  );

  it('routes installation_repositories as an explicit bounded repository set', async () => {
    const queue = testEnv();
    const response = await handleIngressRequest(
      webhookRequest('installation_repositories', {
        action: 'removed',
        installation: { id: installationId },
        repositories_added: [],
        repositories_removed: [{ id: 30 }, { id: 10 }, { id: 30 }],
      }),
      queue.env,
      acceptedDependencies,
    );
    expect(response.status).toBe(202);
    const workItem = parseStewardRuntimeScopeWorkItemV2(
      JSON.parse(queue.messages[0] ?? ''),
    );
    expect(workItem.target).toEqual({
      scope: 'repository-set',
      mode: 'refresh',
      installationId,
      repositoryIds: [10, 30],
      pullRequests: 'all-open',
    });
    expect(workItem.cause).toMatchObject({
      event: 'installation_repositories',
      action: 'removed',
    });
  });

  it('preserves installation_target account identity for live Control validation', async () => {
    const queue = testEnv();
    const response = await handleIngressRequest(
      webhookRequest('installation_target', {
        action: 'renamed',
        target_type: 'Organization',
        account: { id: accountId },
        installation: {
          id: installationId,
          account: { id: accountId },
        },
        changes: { login: { from: 'old-name' } },
      }),
      queue.env,
      acceptedDependencies,
    );
    expect(response.status).toBe(202);
    const workItem = parseStewardRuntimeScopeWorkItemV2(
      JSON.parse(queue.messages[0] ?? ''),
    );
    expect(workItem.target).toMatchObject({
      scope: 'installation',
      installationId,
      accountId,
    });
    expect(workItem.cause.event).toBe('installation_target');
  });

  it('keeps team repository access repository-scoped without trusting team identity', async () => {
    const queue = testEnv();
    const response = await handleIngressRequest(
      webhookRequest('team', {
        action: 'added_to_repository',
        installation: { id: installationId },
        team: { id: 999_999, slug: 'untrusted-team' },
        repository: { id: 1_298_587_318 },
      }),
      queue.env,
      acceptedDependencies,
    );
    expect(response.status).toBe(202);
    const workItem = parseStewardRuntimeScopeWorkItemV2(
      JSON.parse(queue.messages[0] ?? ''),
    );
    expect(workItem.target).toMatchObject({
      scope: 'repository',
      installationId,
      repositoryId: 1_298_587_318,
    });
  });

  it('fails closed instead of truncating an oversized repository delta', async () => {
    const queue = testEnv();
    const repositories = Array.from(
      { length: MAX_INSTALLATION_REPOSITORY_SET_IDS + 1 },
      (_, index) => ({ id: index + 1 }),
    );
    const response = await handleIngressRequest(
      webhookRequest('installation_repositories', {
        action: 'added',
        installation: { id: installationId },
        repositories_added: repositories,
        repositories_removed: [],
      }),
      queue.env,
      acceptedDependencies,
    );
    expect(response.status).toBe(422);
    expect(queue.messages).toHaveLength(0);
  });

  it('keeps HMAC verification ahead of JSON parsing and routing', async () => {
    const queue = testEnv();
    const verifySignature = vi.fn(async () => false);
    const request = new Request('https://ingress.example/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'custom_property',
        'x-github-delivery': 'hmac-first-delivery',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      body: '{not-json',
    });
    const response = await handleIngressRequest(request, queue.env, {
      clock: () => new Date(receivedAt),
      verifySignature,
    });
    expect(response.status).toBe(401);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(queue.messages).toHaveLength(0);
  });
});
