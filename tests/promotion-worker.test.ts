import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimePromotionAbandonResult,
  RuntimePromotionCommandV1,
  RuntimePromotionBeginResult,
  RuntimePromotionDeployment,
  RuntimePromotionLedgerEntry,
  RuntimePromotionLedgerState,
} from '../packages/promotion/src/contracts.js';
import {
  createRuntimePromotionHandler,
  type RuntimePromotionEnv,
  type RuntimePromotionLedgerStub,
} from '../packages/promotion/src/worker.js';

const now = new Date('2026-07-28T06:00:00.000Z');
const stableVersionId = '10000000-0000-4000-8000-000000000001';
const candidateVersionId = '20000000-0000-4000-8000-000000000002';
const beforeDeploymentId = '30000000-0000-4000-8000-000000000003';
const afterDeploymentId = '40000000-0000-4000-8000-000000000004';
const servicePrincipal = 'promotion-service-token-client';
const writeToken = 'never-return-this-workers-write-token';
const stewardCommit = 'a'.repeat(40);

function canonicalVersions(
  versions: RuntimePromotionDeployment['versions'],
): RuntimePromotionDeployment['versions'] {
  return [...versions].sort(
    (left, right) => left.versionId.localeCompare(right.versionId),
  );
}

function deployment(
  versions: RuntimePromotionDeployment['versions'],
  id = beforeDeploymentId,
): RuntimePromotionDeployment {
  return { id, versions: canonicalVersions(versions) };
}

function command(
  operation: RuntimePromotionCommandV1['operation'],
  candidatePercentage: number,
  overrides: Partial<RuntimePromotionCommandV1> = {},
): RuntimePromotionCommandV1 {
  return {
    schemaVersion: 1,
    commandId: '50000000-0000-4000-8000-000000000005',
    requestedAt: now.toISOString(),
    operation,
    worker: 'steward-control',
    expectedDeploymentId: beforeDeploymentId,
    stableVersionId,
    candidateVersionId,
    stewardCommit,
    candidatePercentage,
    ...overrides,
  };
}

class TestLedger implements RuntimePromotionLedgerStub {
  readonly entries = new Map<string, RuntimePromotionLedgerEntry>();

  async begin(value: {
    command: unknown;
    principal: string;
    before: RuntimePromotionDeployment;
    desired: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionBeginResult> {
    const promotion = value.command as RuntimePromotionCommandV1;
    const existing = this.entries.get(promotion.commandId);
    if (existing !== undefined) {
      return {
        status: existing.state === 'unknown'
          ? 'recover'
          : existing.state === 'dispatching'
            ? 'busy'
            : 'completed',
        entry: existing,
      };
    }
    if ([...this.entries.values()].some(
      (entry) =>
        entry.command.worker === promotion.worker
        && (entry.state === 'dispatching' || entry.state === 'unknown'),
    )) {
      return {
        status: 'busy',
        entry: {
          command: promotion,
          principal: value.principal,
          state: 'rejected',
          before: value.before,
          desired: value.desired,
          after: null,
          updatedAt: value.now,
        },
      };
    }
    const entry: RuntimePromotionLedgerEntry = {
      command: promotion,
      principal: value.principal,
      state: 'dispatching',
      before: value.before,
      desired: value.desired,
      after: null,
      updatedAt: value.now,
    };
    this.entries.set(promotion.commandId, entry);
    return { status: 'begun', entry };
  }

  async settle(value: {
    commandId: string;
    state: Exclude<RuntimePromotionLedgerState, 'dispatching' | 'unknown'>;
    after: RuntimePromotionDeployment | null;
    now: string;
  }): Promise<RuntimePromotionLedgerEntry> {
    return this.#update(value.commandId, value.state, value.after, value.now);
  }

  async markUnknown(value: {
    commandId: string;
    after: RuntimePromotionDeployment | null;
    now: string;
  }): Promise<RuntimePromotionLedgerEntry> {
    return this.#update(value.commandId, 'unknown', value.after, value.now);
  }

  async abandonUnknown(value: {
    commandId: string;
    worker: string;
    principal: string;
    before: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionAbandonResult> {
    const existing = this.entries.get(value.commandId);
    if (
      existing === undefined
      || existing.command.worker !== value.worker
      || existing.principal !== value.principal
      || JSON.stringify(existing.before) !== JSON.stringify(value.before)
    ) {
      throw new Error('promotion resolution evidence mismatch');
    }
    if (existing.state !== 'unknown') {
      return { status: 'completed', entry: existing };
    }
    if (
      Date.parse(value.now) - Date.parse(existing.updatedAt)
      < 60_000
    ) {
      return { status: 'too-early', entry: existing };
    }
    return {
      status: 'abandoned',
      entry: this.#update(
        value.commandId,
        'abandoned',
        value.before,
        value.now,
      ),
    };
  }

  async inspect(commandId: string): Promise<RuntimePromotionLedgerEntry | null> {
    return this.entries.get(commandId) ?? null;
  }

  #update(
    commandId: string,
    state: RuntimePromotionLedgerState,
    after: RuntimePromotionDeployment | null,
    updatedAt: string,
  ): RuntimePromotionLedgerEntry {
    const existing = this.entries.get(commandId);
    if (existing === undefined) throw new Error('missing test ledger entry');
    if (existing.state !== 'dispatching' && existing.state !== 'unknown') {
      return existing;
    }
    const entry = { ...existing, state, after, updatedAt };
    this.entries.set(commandId, entry);
    return entry;
  }
}

type PostBehavior = 'success' | 'response-lost-applied'
  | 'response-lost-unapplied' | 'rejected';

interface TransportOptions {
  readonly before: RuntimePromotionDeployment;
  readonly postBehavior?: PostBehavior;
  readonly versionTag?: string;
  readonly oversizedFirstRead?: boolean;
}

function cloudflareTransport(options: TransportOptions) {
  let active = options.before;
  const requests: Array<{
    readonly url: URL;
    readonly method: string;
    readonly body: unknown;
  }> = [];
  const implementation = vi.fn(async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined
      ? null
      : JSON.parse(String(init.body)) as unknown;
    requests.push({ url, method, body });
    if (
      options.oversizedFirstRead === true
      && requests.length === 1
    ) {
      return new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(256 * 1024 + 1),
        },
      });
    }
    if (url.pathname.endsWith(`/versions/${candidateVersionId}`)) {
      return cloudflareJson({
        success: true,
        result: {
          id: candidateVersionId,
          annotations: {
            'workers/tag': options.versionTag
              ?? `steward-${stewardCommit}`,
          },
        },
      });
    }
    if (method === 'POST') {
      const parsed = body as {
        versions: Array<{ version_id: string; percentage: number }>;
      };
      const applied = {
        id: afterDeploymentId,
        versions: canonicalVersions(parsed.versions.map((version) => ({
          versionId: version.version_id,
          percentage: version.percentage,
        }))),
      };
      if (options.postBehavior === 'rejected') {
        return new Response('rejected', { status: 400 });
      }
      if (options.postBehavior !== 'response-lost-unapplied') {
        active = applied;
      }
      if (
        options.postBehavior === 'response-lost-applied'
        || options.postBehavior === 'response-lost-unapplied'
      ) {
        throw new Error('Cloudflare deployment response lost');
      }
      return cloudflareJson({
        success: true,
        result: { id: afterDeploymentId },
      });
    }
    return cloudflareJson({
      success: true,
      result: {
        deployments: [{
          id: active.id,
          strategy: 'percentage',
          versions: active.versions.map((version) => ({
            version_id: version.versionId,
            percentage: version.percentage,
          })),
        }],
      },
    });
  });
  return {
    implementation,
    requests,
    setActive(value: RuntimePromotionDeployment) {
      active = value;
    },
  };
}

function cloudflareJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function testEnv(ledger: TestLedger): RuntimePromotionEnv {
  return {
    RUNTIME_PROMOTION_LEDGER: {
      idFromName(name) {
        expect(name).toBe('global-v1');
        return name;
      },
      get() {
        return ledger;
      },
    },
    CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
    CLOUDFLARE_WORKERS_WRITE_TOKEN: writeToken,
  };
}

function promotionRequest(value: unknown): Request {
  return new Request('https://promotion.example.test/v1/runtime-promotion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function resolutionRequest(value: unknown): Request {
  return new Request(
    'https://promotion.example.test/v1/runtime-promotion/resolve-unknown',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    },
  );
}

function handler(
  fetchImplementation: typeof fetch,
  authorized = true,
  currentNow: () => Date = () => now,
) {
  return createRuntimePromotionHandler({
    fetch: fetchImplementation,
    now: currentNow,
    verifyAccess: async () => authorized
      ? {
          decision: 'authorized',
          principal: { type: 'service', clientId: servicePrincipal },
        }
      : { decision: 'denied' },
  });
}

describe('protected runtime promotion worker', () => {
  it.each([
    {
      name: 'stage at zero percent',
      promotion: command('stage', 0),
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
      expectedState: 'staged',
      expectedVersions: [
        { versionId: stableVersionId, percentage: 100 },
        { versionId: candidateVersionId, percentage: 0 },
      ],
    },
    {
      name: 'increase a canary gradually',
      promotion: command('promote', 25),
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      expectedState: 'promoted',
      expectedVersions: [
        { versionId: stableVersionId, percentage: 75 },
        { versionId: candidateVersionId, percentage: 25 },
      ],
    },
    {
      name: 'promote the candidate fully while retaining stable at zero',
      promotion: command('promote', 100),
      before: deployment([
        { versionId: stableVersionId, percentage: 10 },
        { versionId: candidateVersionId, percentage: 90 },
      ]),
      expectedState: 'promoted',
      expectedVersions: [
        { versionId: stableVersionId, percentage: 0 },
        { versionId: candidateVersionId, percentage: 100 },
      ],
    },
    {
      name: 'stop a canary at zero percent',
      promotion: command('canary-stop', 0),
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      expectedState: 'canary-stopped',
      expectedVersions: [
        { versionId: stableVersionId, percentage: 100 },
        { versionId: candidateVersionId, percentage: 0 },
      ],
    },
    {
      name: 'roll back to only the stable version',
      promotion: command('rollback', 0),
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      expectedState: 'rolled-back',
      expectedVersions: [
        { versionId: stableVersionId, percentage: 100 },
      ],
    },
  ])('$name with exact IDs and GET-after evidence', async ({
    promotion,
    before,
    expectedState,
    expectedVersions,
  }) => {
    const ledger = new TestLedger();
    const transport = cloudflareTransport({ before });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(promotionRequest(promotion), testEnv(ledger));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(writeToken);
    expect(text).not.toContain(servicePrincipal);
    expect(JSON.parse(text)).toMatchObject({ state: expectedState });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'POST',
      'GET',
    ]);
    expect(transport.requests[1]?.url.pathname.endsWith(
      `/workers/scripts/steward-control/versions/${candidateVersionId}`,
    )).toBe(true);
    const post = transport.requests[3];
    expect(post?.url.pathname.endsWith(
      '/workers/scripts/steward-control/deployments',
    )).toBe(true);
    expect(post?.url.search).toBe('');
    expect(post?.body).toEqual({
      strategy: 'percentage',
      versions: canonicalVersions(expectedVersions).map((version) => ({
        version_id: version.versionId,
        percentage: version.percentage,
      })),
      annotations: {
        'workers/message':
          `SPLRAD Steward protected runtime promotion ${promotion.commandId}`,
      },
    });
    expect(JSON.stringify(post?.body)).not.toMatch(/force|admin|bypass/i);
  });

  it('revalidates the exact deployment after begin when a concurrent command wins the barrier', async () => {
    const ledger = new TestLedger();
    const original = deployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const transport = cloudflareTransport({ before: original });
    let releaseBlockedVersionRead!: () => void;
    const blockedVersionRead = new Promise<void>((resolve) => {
      releaseBlockedVersionRead = resolve;
    });
    let announceBlocked!: () => void;
    const firstVersionReadBlocked = new Promise<void>((resolve) => {
      announceBlocked = resolve;
    });
    let versionReads = 0;
    const concurrentFetch = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/versions/${candidateVersionId}`)) {
        versionReads += 1;
        if (versionReads === 1) {
          announceBlocked();
          await blockedVersionRead;
        }
      }
      return await transport.implementation(input, init);
    }) as typeof fetch;
    const currentHandler = handler(concurrentFetch);
    const delayed = currentHandler.fetch(
      promotionRequest(command('promote', 25, {
        commandId: '51000000-0000-4000-8000-000000000005',
      })),
      testEnv(ledger),
    );
    await firstVersionReadBlocked;
    const winner = await currentHandler.fetch(
      promotionRequest(command('promote', 20, {
        commandId: '52000000-0000-4000-8000-000000000005',
      })),
      testEnv(ledger),
    );
    expect(winner.status).toBe(200);
    releaseBlockedVersionRead();
    const delayedResponse = await delayed;

    expect(delayedResponse.status).toBe(409);
    await expect(delayedResponse.json()).resolves.toMatchObject({
      state: 'superseded',
      after: { id: afterDeploymentId },
    });
    expect(transport.requests.filter(
      (request) => request.method === 'POST',
    )).toHaveLength(1);
  });

  it('verifies candidate tag provenance before mutation and fails closed', async () => {
    const ledger = new TestLedger();
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
      versionTag: `steward-${'c'.repeat(40)}`,
    });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0)),
      testEnv(ledger),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'promotion-version-provenance-mismatch',
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
      'GET',
    ]);
    expect(ledger.entries.size).toBe(0);
  });

  it('builds API paths from the parsed allowlist and rejects arbitrary scripts', async () => {
    const ledger = new TestLedger();
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0, {
        worker: 'steward-recovery',
      })),
      testEnv(ledger),
    );

    expect(response.status).toBe(200);
    expect(transport.requests.every((request) =>
      request.url.pathname.includes(
        '/workers/scripts/steward-recovery/',
      ))).toBe(true);

    for (const worker of ['steward-promotion', 'arbitrary-script']) {
      const rejectedTransport = cloudflareTransport({
        before: deployment([
          { versionId: stableVersionId, percentage: 100 },
        ]),
      });
      const rejected = await handler(
        rejectedTransport.implementation as typeof fetch,
      ).fetch(
        promotionRequest({
          ...command('stage', 0),
          worker,
        }),
        testEnv(new TestLedger()),
      );
      expect(rejected.status).toBe(400);
      expect(rejectedTransport.requests).toEqual([]);
    }
  });

  it('settles same-version promotion as a verified durable no-op', async () => {
    const ledger = new TestLedger();
    const same = command('promote', 50, {
      candidateVersionId: stableVersionId,
    });
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const response = await handler(
      vi.fn(async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/versions/${stableVersionId}`)) {
          return cloudflareJson({
            success: true,
            result: {
              id: stableVersionId,
              annotations: {
                'workers/tag': `steward-${stewardCommit}`,
              },
            },
          });
        }
        return await transport.implementation(input, init);
      }) as typeof fetch,
    ).fetch(promotionRequest(same), testEnv(ledger));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: 'promoted',
      desired: {
        versions: [{ versionId: stableVersionId, percentage: 100 }],
      },
    });
    expect(transport.requests.some(
      (request) => request.method === 'POST',
    )).toBe(false);
  });

  it('settles an already rolled-back stable deployment as a durable no-op', async () => {
    const ledger = new TestLedger();
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('rollback', 0)),
      testEnv(ledger),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: 'rolled-back',
      desired: {
        versions: [{ versionId: stableVersionId, percentage: 100 }],
      },
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
      'GET',
      'GET',
    ]);
  });

  it('uses GET-after to settle a response-lost write that actually applied', async () => {
    const ledger = new TestLedger();
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      postBehavior: 'response-lost-applied',
    });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('promote', 25)),
      testEnv(ledger),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: 'promoted',
      after: { id: afterDeploymentId },
    });
  });

  it('records unknown and retries with GET reconciliation without repeating POST', async () => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25);
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      postBehavior: 'response-lost-unapplied',
    });
    const currentHandler = handler(
      transport.implementation as typeof fetch,
    );
    const first = await currentHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({ state: 'unknown' });

    const staleRetryHandler = handler(
      transport.implementation as typeof fetch,
      true,
      () => new Date(now.getTime() + 10 * 60_000),
    );
    const retry = await staleRetryHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(retry.status).toBe(503);
    await expect(retry.json()).resolves.toMatchObject({ state: 'unknown' });
    expect(transport.requests.filter(
      (request) => request.method === 'POST',
    )).toHaveLength(1);
    expect(transport.requests.at(-1)?.method).toBe('GET');
  });

  it('keeps a fresh dispatch lease active without reading or repeating the write', async () => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25, {
      commandId: '53000000-0000-4000-8000-000000000005',
    });
    const before = deployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const desired = deployment([
      { versionId: stableVersionId, percentage: 75 },
      { versionId: candidateVersionId, percentage: 25 },
    ]);
    await ledger.begin({
      command: promotion,
      principal: servicePrincipal,
      before,
      desired,
      now: new Date(now.getTime() - 1_000).toISOString(),
    });
    const transport = cloudflareTransport({ before });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(promotionRequest(promotion), testEnv(ledger));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'promotion-in-progress',
    });
    expect(transport.requests).toEqual([]);
  });

  it('starts the dispatch lease when durable intent is committed after slow preflight', async () => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25, {
      commandId: '53500000-0000-4000-8000-000000000005',
    });
    const before = deployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const transport = cloudflareTransport({ before });
    let currentNow = now;
    let fetchCount = 0;
    let releaseRevalidation: (() => void) | undefined;
    const revalidationRelease = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let markRevalidationStarted: (() => void) | undefined;
    const revalidationStarted = new Promise<void>((resolve) => {
      markRevalidationStarted = resolve;
    });
    const slowPreflightFetch = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchCount += 1;
      const response = await transport.implementation(input, init);
      if (fetchCount === 2) {
        currentNow = new Date(now.getTime() + 20_000);
      }
      if (fetchCount === 3) {
        markRevalidationStarted?.();
        await revalidationRelease;
      }
      return response;
    }) as typeof fetch;
    const currentHandler = handler(
      slowPreflightFetch,
      true,
      () => currentNow,
    );

    const first = currentHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    await revalidationStarted;
    currentNow = new Date(now.getTime() + 21_000);

    const retry = await currentHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({
      error: 'promotion-in-progress',
    });
    expect(ledger.entries.get(promotion.commandId)).toMatchObject({
      state: 'dispatching',
      updatedAt: new Date(now.getTime() + 20_000).toISOString(),
    });

    releaseRevalidation?.();
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(transport.requests.filter(
      (request) => request.method === 'POST',
    )).toHaveLength(1);
  });

  it.each([
    {
      name: 'settles desired traffic',
      active: deployment([
        { versionId: stableVersionId, percentage: 75 },
        { versionId: candidateVersionId, percentage: 25 },
      ], afterDeploymentId),
      expectedStatus: 200,
      expectedState: 'promoted',
    },
    {
      name: 'settles a changed deployment as superseded',
      active: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ], '54000000-0000-4000-8000-000000000005'),
      expectedStatus: 409,
      expectedState: 'superseded',
    },
  ])('read-only reconciles expired dispatching and $name', async ({
    active,
    expectedStatus,
    expectedState,
  }) => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25, {
      commandId: expectedState === 'promoted'
        ? '55000000-0000-4000-8000-000000000005'
        : '56000000-0000-4000-8000-000000000005',
    });
    const before = deployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const desired = deployment([
      { versionId: stableVersionId, percentage: 75 },
      { versionId: candidateVersionId, percentage: 25 },
    ]);
    await ledger.begin({
      command: promotion,
      principal: servicePrincipal,
      before,
      desired,
      now: new Date(now.getTime() - 20_000).toISOString(),
    });
    const transport = cloudflareTransport({ before: active });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(promotionRequest(promotion), testEnv(ledger));

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      state: expectedState,
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
    ]);
  });

  it('keeps exact-before recovery unknown until explicit quiet resolution, then unblocks rollback', async () => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25, {
      commandId: '57000000-0000-4000-8000-000000000005',
    });
    const before = deployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const desired = deployment([
      { versionId: stableVersionId, percentage: 75 },
      { versionId: candidateVersionId, percentage: 25 },
    ]);
    await ledger.begin({
      command: promotion,
      principal: servicePrincipal,
      before,
      desired,
      now: new Date(now.getTime() - 20_000).toISOString(),
    });
    const transport = cloudflareTransport({ before });
    const expiredHandler = handler(
      transport.implementation as typeof fetch,
    );
    const recovered = await expiredHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(recovered.status).toBe(503);
    await expect(recovered.json()).resolves.toMatchObject({
      state: 'unknown',
    });

    const resolution = {
      schemaVersion: 1,
      requestedAt: new Date(now.getTime() + 60_001).toISOString(),
      operation: 'abandon',
      commandId: promotion.commandId,
      worker: promotion.worker,
      expectedBefore: before,
    };
    const tooEarly = await handler(
      transport.implementation as typeof fetch,
      true,
      () => new Date(now.getTime() + 59_999),
    ).fetch(
      resolutionRequest({
        ...resolution,
        requestedAt: new Date(now.getTime() + 59_999).toISOString(),
      }),
      testEnv(ledger),
    );
    expect(tooEarly.status).toBe(409);
    await expect(tooEarly.json()).resolves.toEqual({
      error: 'promotion-resolution-too-early',
    });

    const resolutionHandler = handler(
      transport.implementation as typeof fetch,
      true,
      () => new Date(now.getTime() + 60_001),
    );
    const abandoned = await resolutionHandler.fetch(
      resolutionRequest(resolution),
      testEnv(ledger),
    );
    expect(abandoned.status).toBe(200);
    await expect(abandoned.json()).resolves.toMatchObject({
      state: 'abandoned',
    });
    const replay = await resolutionHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      state: 'abandoned',
    });

    const rollback = command('rollback', 0, {
      commandId: '58000000-0000-4000-8000-000000000005',
      requestedAt: new Date(now.getTime() + 60_001).toISOString(),
    });
    const rolledBack = await resolutionHandler.fetch(
      promotionRequest(rollback),
      testEnv(ledger),
    );
    expect(rolledBack.status).toBe(200);
    await expect(rolledBack.json()).resolves.toMatchObject({
      state: 'rolled-back',
    });
    expect(transport.requests.filter(
      (request) => request.method === 'POST',
    )).toHaveLength(1);
  });

  it('preserves a rejected terminal failure status on replay', async () => {
    const ledger = new TestLedger();
    const promotion = command('promote', 25, {
      commandId: '59000000-0000-4000-8000-000000000005',
    });
    const transport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 90 },
        { versionId: candidateVersionId, percentage: 10 },
      ]),
      postBehavior: 'rejected',
    });
    const currentHandler = handler(
      transport.implementation as typeof fetch,
    );
    const first = await currentHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(first.status).toBe(502);
    await expect(first.json()).resolves.toMatchObject({ state: 'rejected' });
    const replay = await currentHandler.fetch(
      promotionRequest(promotion),
      testEnv(ledger),
    );
    expect(replay.status).toBe(502);
    await expect(replay.json()).resolves.toMatchObject({ state: 'rejected' });
    expect(transport.requests.filter(
      (request) => request.method === 'POST',
    )).toHaveLength(1);
  });

  it('records an expected-deployment mismatch without reading a version or writing', async () => {
    const ledger = new TestLedger();
    const actual = deployment(
      [{ versionId: stableVersionId, percentage: 100 }],
      '60000000-0000-4000-8000-000000000006',
    );
    const transport = cloudflareTransport({ before: actual });
    const response = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0)),
      testEnv(ledger),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: 'superseded',
      after: { id: actual.id },
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
    ]);
    const replay = await handler(
      transport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0)),
      testEnv(ledger),
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      state: 'superseded',
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      'GET',
    ]);
  });

  it('rejects access, force fields, and oversized Cloudflare evidence before POST', async () => {
    const missingAccess = await createRuntimePromotionHandler().fetch(
      promotionRequest(command('stage', 0)),
      testEnv(new TestLedger()),
    );
    expect(missingAccess.status).toBe(503);
    await expect(missingAccess.json()).resolves.toEqual({
      error: 'promotion-unavailable',
    });

    const deniedTransport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const denied = await handler(
      deniedTransport.implementation as typeof fetch,
      false,
    ).fetch(
      promotionRequest(command('stage', 0)),
      testEnv(new TestLedger()),
    );
    expect(denied.status).toBe(403);
    expect(deniedTransport.requests).toEqual([]);

    const invalidTransport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const invalid = await handler(
      invalidTransport.implementation as typeof fetch,
    ).fetch(
      promotionRequest({ ...command('stage', 0), force: true }),
      testEnv(new TestLedger()),
    );
    expect(invalid.status).toBe(400);
    expect(invalidTransport.requests).toEqual([]);

    const oversizedTransport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
      oversizedFirstRead: true,
    });
    const oversized = await handler(
      oversizedTransport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0)),
      testEnv(new TestLedger()),
    );
    expect(oversized.status).toBe(503);
    expect(oversizedTransport.requests.map(
      (request) => request.method,
    )).toEqual(['GET']);

    const invalidSecretTransport = cloudflareTransport({
      before: deployment([
        { versionId: stableVersionId, percentage: 100 },
      ]),
    });
    const invalidSecretEnv = {
      ...testEnv(new TestLedger()),
      CLOUDFLARE_WORKERS_WRITE_TOKEN: ' non-canonical-token ',
    };
    const invalidSecret = await handler(
      invalidSecretTransport.implementation as typeof fetch,
    ).fetch(
      promotionRequest(command('stage', 0)),
      invalidSecretEnv,
    );
    expect(invalidSecret.status).toBe(503);
    expect(invalidSecretTransport.requests).toEqual([]);
  });
});
