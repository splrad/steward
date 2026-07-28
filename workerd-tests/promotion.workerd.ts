import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimePromotionCommandV1,
  RuntimePromotionDeployment,
} from '../packages/promotion/src/contracts.js';
import type { RuntimePromotionLedger } from '../packages/promotion/src/ledger.js';
import {
  createRuntimePromotionHandler,
  type RuntimePromotionEnv,
} from '../packages/promotion/src/worker.js';

interface PromotionWorkerdEnv {
  readonly RUNTIME_PROMOTION_LEDGER:
    DurableObjectNamespace<RuntimePromotionLedger>;
}

const workerdEnv = env as unknown as PromotionWorkerdEnv;
const now = new Date('2026-07-28T06:00:00.000Z');
const stableVersionId = '10000000-0000-4000-8000-000000000001';
const candidateVersionId = '20000000-0000-4000-8000-000000000002';
const beforeDeploymentId = '30000000-0000-4000-8000-000000000003';
const afterDeploymentId = '40000000-0000-4000-8000-000000000004';
const commandId = '50000000-0000-4000-8000-000000000005';
const stewardCommit = 'a'.repeat(40);

function cloudflareJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function canonicalVersions(
  versions: RuntimePromotionDeployment['versions'],
): RuntimePromotionDeployment['versions'] {
  return [...versions].sort(
    (left, right) => left.versionId.localeCompare(right.versionId),
  );
}

function runtimeDeployment(
  versions: RuntimePromotionDeployment['versions'],
  id = beforeDeploymentId,
): RuntimePromotionDeployment {
  return { id, versions: canonicalVersions(versions) };
}

function runtimeCommand(
  commandIdValue: string,
  worker: RuntimePromotionCommandV1['worker'],
  operation: RuntimePromotionCommandV1['operation'] = 'promote',
  percentage = operation === 'promote' ? 25 : 0,
  requestedAt = now.toISOString(),
): RuntimePromotionCommandV1 {
  return {
    schemaVersion: 1,
    commandId: commandIdValue,
    requestedAt,
    operation,
    worker,
    expectedDeploymentId: beforeDeploymentId,
    stableVersionId,
    candidateVersionId,
    stewardCommit,
    candidatePercentage: percentage,
  };
}

function runtimeEnv(): RuntimePromotionEnv {
  return {
    RUNTIME_PROMOTION_LEDGER:
      workerdEnv.RUNTIME_PROMOTION_LEDGER as unknown as
        RuntimePromotionEnv['RUNTIME_PROMOTION_LEDGER'],
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_WORKERS_WRITE_TOKEN:
      'workerd-workers-write-token-0001',
  };
}

function promotionRequest(value: unknown, resolve = false): Request {
  return new Request(
    `https://promotion.example.test/v1/runtime-promotion${
      resolve ? '/resolve-unknown' : ''
    }`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    },
  );
}

describe('Runtime Promotion in workerd', () => {
  it('persists intent in a real SQLite Durable Object and settles from GET-after', async () => {
    let active = {
      id: beforeDeploymentId,
      strategy: 'percentage',
      versions: [
        { version_id: stableVersionId, percentage: 90 },
        { version_id: candidateVersionId, percentage: 10 },
      ],
    };
    const cloudflareFetch = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      expect(url.search).toBe('');
      if (url.pathname.endsWith(`/versions/${candidateVersionId}`)) {
        expect(init?.method).toBe('GET');
        return cloudflareJson({
          success: true,
          result: {
            id: candidateVersionId,
            annotations: {
              'workers/tag': `steward-${stewardCommit}`,
            },
          },
        });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('force');
        expect(body).not.toHaveProperty('admin');
        expect(body).not.toHaveProperty('bypass');
        expect(body).toMatchObject({
          annotations: {
            'workers/message':
              `SPLRAD Steward protected runtime promotion ${commandId}`,
          },
        });
        active = {
          id: afterDeploymentId,
          strategy: 'percentage',
          versions: [
            { version_id: stableVersionId, percentage: 75 },
            { version_id: candidateVersionId, percentage: 25 },
          ],
        };
        return cloudflareJson({
          success: true,
          result: { id: afterDeploymentId },
        });
      }
      expect(init?.method).toBe('GET');
      return cloudflareJson({
        success: true,
        result: { deployments: [active] },
      });
    });
    const handler = createRuntimePromotionHandler({
      fetch: cloudflareFetch as typeof fetch,
      now: () => now,
      verifyAccess: async () => ({
        decision: 'authorized',
        principal: {
          type: 'service',
          clientId: 'promotion-workerd-service-token',
        },
      }),
    });
    const promotionEnv: RuntimePromotionEnv = {
      RUNTIME_PROMOTION_LEDGER:
        workerdEnv.RUNTIME_PROMOTION_LEDGER as unknown as
          RuntimePromotionEnv['RUNTIME_PROMOTION_LEDGER'],
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_WORKERS_WRITE_TOKEN:
        'workerd-workers-write-token-0001',
    };
    const response = await handler.fetch(
      new Request('https://promotion.example.test/v1/runtime-promotion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId,
          requestedAt: now.toISOString(),
          operation: 'promote',
          worker: 'steward-control',
          expectedDeploymentId: beforeDeploymentId,
          stableVersionId,
          candidateVersionId,
          stewardCommit,
          candidatePercentage: 25,
        }),
      }),
      promotionEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      commandId,
      state: 'promoted',
      after: {
        id: afterDeploymentId,
      },
    });
    expect(cloudflareFetch).toHaveBeenCalledTimes(5);

    const ledger = workerdEnv.RUNTIME_PROMOTION_LEDGER.getByName('global-v1');
    await expect(ledger.inspect(commandId)).resolves.toMatchObject({
      state: 'promoted',
      principal: 'promotion-workerd-service-token',
      before: { id: beforeDeploymentId },
      desired: {
        versions: expect.arrayContaining([
          { versionId: candidateVersionId, percentage: 25 },
        ]),
      },
      after: { id: afterDeploymentId },
    });
  });

  it('read-only reconciles crashed dispatches and explicitly resolves exact-before unknown state', async () => {
    const ledger = workerdEnv.RUNTIME_PROMOTION_LEDGER.getByName('global-v1');
    const principal = 'promotion-workerd-recovery-token';
    const before = runtimeDeployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    const desired = runtimeDeployment([
      { versionId: stableVersionId, percentage: 75 },
      { versionId: candidateVersionId, percentage: 25 },
    ]);
    const authorized = async () => ({
      decision: 'authorized' as const,
      principal: { type: 'service' as const, clientId: principal },
    });
    const handlerFor = (
      active: RuntimePromotionDeployment,
      currentNow = now,
    ) => {
      const cloudflareFetch = vi.fn(async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        expect(init?.method).toBe('GET');
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
        cloudflareFetch,
        handler: createRuntimePromotionHandler({
          fetch: cloudflareFetch as typeof fetch,
          now: () => currentNow,
          verifyAccess: authorized,
        }),
      };
    };

    const desiredCommand = runtimeCommand(
      '61000000-0000-4000-8000-000000000006',
      'steward-recovery',
    );
    await ledger.begin({
      command: desiredCommand,
      principal,
      before,
      desired,
      now: new Date(now.getTime() - 20_000).toISOString(),
    });
    const desiredRecovery = handlerFor(runtimeDeployment(
      desired.versions,
      '62000000-0000-4000-8000-000000000006',
    ));
    const desiredResponse = await desiredRecovery.handler.fetch(
      promotionRequest(desiredCommand),
      runtimeEnv(),
    );
    expect(desiredResponse.status).toBe(200);
    await expect(desiredResponse.json()).resolves.toMatchObject({
      state: 'promoted',
    });
    expect(desiredRecovery.cloudflareFetch).toHaveBeenCalledTimes(1);

    const changedCommand = runtimeCommand(
      '63000000-0000-4000-8000-000000000006',
      'steward-ingress',
    );
    await ledger.begin({
      command: changedCommand,
      principal,
      before,
      desired,
      now: new Date(now.getTime() - 20_000).toISOString(),
    });
    const changedRecovery = handlerFor(runtimeDeployment(
      [{ versionId: stableVersionId, percentage: 100 }],
      '64000000-0000-4000-8000-000000000006',
    ));
    const changedResponse = await changedRecovery.handler.fetch(
      promotionRequest(changedCommand),
      runtimeEnv(),
    );
    expect(changedResponse.status).toBe(409);
    await expect(changedResponse.json()).resolves.toMatchObject({
      state: 'superseded',
    });
    expect(changedRecovery.cloudflareFetch).toHaveBeenCalledTimes(1);

    const exactCommand = runtimeCommand(
      '65000000-0000-4000-8000-000000000006',
      'steward-coordinator',
    );
    await ledger.begin({
      command: exactCommand,
      principal,
      before,
      desired,
      now: new Date(now.getTime() - 20_000).toISOString(),
    });
    const exactRecovery = handlerFor(before);
    const exactResponse = await exactRecovery.handler.fetch(
      promotionRequest(exactCommand),
      runtimeEnv(),
    );
    expect(exactResponse.status).toBe(503);
    await expect(exactResponse.json()).resolves.toMatchObject({
      state: 'unknown',
    });
    expect(exactRecovery.cloudflareFetch).toHaveBeenCalledTimes(1);

    const resolvedAt = new Date(now.getTime() + 60_001);
    const resolutionHandler = handlerFor(before, resolvedAt);
    const resolved = await resolutionHandler.handler.fetch(
      promotionRequest({
        schemaVersion: 1,
        requestedAt: resolvedAt.toISOString(),
        operation: 'abandon',
        commandId: exactCommand.commandId,
        worker: exactCommand.worker,
        expectedBefore: before,
      }, true),
      runtimeEnv(),
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      state: 'abandoned',
    });

    let active = before;
    let postCount = 0;
    const rollbackFetch = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/versions/${candidateVersionId}`)) {
        return cloudflareJson({
          success: true,
          result: {
            id: candidateVersionId,
            annotations: {
              'workers/tag': `steward-${stewardCommit}`,
            },
          },
        });
      }
      if (init?.method === 'POST') {
        postCount += 1;
        active = runtimeDeployment(
          [{ versionId: stableVersionId, percentage: 100 }],
          '66000000-0000-4000-8000-000000000006',
        );
        return cloudflareJson({ success: true, result: { id: active.id } });
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
    const rollbackHandler = createRuntimePromotionHandler({
      fetch: rollbackFetch as typeof fetch,
      now: () => resolvedAt,
      verifyAccess: authorized,
    });
    const rollback = runtimeCommand(
      '67000000-0000-4000-8000-000000000006',
      'steward-coordinator',
      'rollback',
      0,
      resolvedAt.toISOString(),
    );
    const rollbackResponse = await rollbackHandler.fetch(
      promotionRequest(rollback),
      runtimeEnv(),
    );
    expect(rollbackResponse.status).toBe(200);
    await expect(rollbackResponse.json()).resolves.toMatchObject({
      state: 'rolled-back',
    });
    expect(postCount).toBe(1);
  });

  it('uses the real SQLite ledger barrier to reject a delayed stale command without a second POST', async () => {
    let active = runtimeDeployment([
      { versionId: stableVersionId, percentage: 90 },
      { versionId: candidateVersionId, percentage: 10 },
    ]);
    let versionReads = 0;
    let postCount = 0;
    let releaseDelayed!: () => void;
    const delayedVersionRead = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    let announceDelayed!: () => void;
    const delayedAnnounced = new Promise<void>((resolve) => {
      announceDelayed = resolve;
    });
    const cloudflareFetch = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/versions/${candidateVersionId}`)) {
        versionReads += 1;
        if (versionReads === 1) {
          announceDelayed();
          await delayedVersionRead;
        }
        return cloudflareJson({
          success: true,
          result: {
            id: candidateVersionId,
            annotations: {
              'workers/tag': `steward-${stewardCommit}`,
            },
          },
        });
      }
      if (init?.method === 'POST') {
        postCount += 1;
        const body = JSON.parse(String(init.body)) as {
          versions: Array<{ version_id: string; percentage: number }>;
        };
        active = runtimeDeployment(
          body.versions.map((version) => ({
            versionId: version.version_id,
            percentage: version.percentage,
          })),
          '68000000-0000-4000-8000-000000000006',
        );
        return cloudflareJson({ success: true, result: { id: active.id } });
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
    const principal = 'promotion-workerd-concurrency-token';
    const handler = createRuntimePromotionHandler({
      fetch: cloudflareFetch as typeof fetch,
      now: () => now,
      verifyAccess: async () => ({
        decision: 'authorized',
        principal: { type: 'service', clientId: principal },
      }),
    });
    const delayed = runtimeCommand(
      '69000000-0000-4000-8000-000000000006',
      'steward-diagnostics',
      'promote',
      25,
    );
    const winner = runtimeCommand(
      '70000000-0000-4000-8000-000000000006',
      'steward-diagnostics',
      'promote',
      20,
    );
    const delayedResponsePromise = handler.fetch(
      promotionRequest(delayed),
      runtimeEnv(),
    );
    await delayedAnnounced;
    const winnerResponse = await handler.fetch(
      promotionRequest(winner),
      runtimeEnv(),
    );
    expect(winnerResponse.status).toBe(200);
    releaseDelayed();
    const delayedResponse = await delayedResponsePromise;
    expect(delayedResponse.status).toBe(409);
    await expect(delayedResponse.json()).resolves.toMatchObject({
      state: 'superseded',
    });
    expect(postCount).toBe(1);
  });
});
