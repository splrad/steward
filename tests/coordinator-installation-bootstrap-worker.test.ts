import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json,
  parseStewardRuntimeInstallationIndexBootstrapPageRequestV1,
} from '../packages/core/src/index.js';
import {
  createCoordinatorHandler,
  processCoordinatorMessage,
  type CoordinatorEnv,
  type CoordinatorQueueMessage,
  type InstallationFanoutCoordinatorStub,
} from '../packages/coordinator/src/worker.js';

const installationId = 145_952_003;
const revision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: '11111111-2222-4333-8444-555555555555',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-28T04:00:00.000Z',
};
const command =
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
    command: {
      schemaVersion: 1,
      operation: 'installation-index-bootstrap',
      requestId: '11111111-2222-4333-8444-555555555555',
      requestedAt: '2026-07-28T04:01:00.000Z',
      installationId,
      expectedControlRevision: revision,
    },
    accessServiceClientId: 'bootstrap-service-client',
  });

function queueMessage(body = canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
  command,
)) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      id: 'bootstrap-message',
      timestamp: new Date('2026-07-28T04:01:00.000Z'),
      body,
      attempts: 1,
      ack,
      retry,
    } satisfies CoordinatorQueueMessage,
    ack,
    retry,
  };
}

function envWithStub(
  stub: InstallationFanoutCoordinatorStub,
  controlFetch: CoordinatorEnv['CONTROL']['fetch'],
) {
  const send = vi.fn(async () => undefined);
  const sendBatch = vi.fn(async () => undefined);
  const env = {
    INSTALLATION_FANOUT_COORDINATOR: {
      getByName: vi.fn(() => stub),
    },
    REPOSITORY_FANOUT_COORDINATOR: {
      getByName: vi.fn(() => {
        throw new Error('unexpected repository fan-out');
      }),
    },
    PR_COORDINATOR: {
      getByName: vi.fn(() => {
        throw new Error('unexpected PR fan-out');
      }),
    },
    CONTROL: { fetch: controlFetch },
    EVENT_QUEUE: { send, sendBatch },
  } as unknown as CoordinatorEnv;
  return { env, send, sendBatch };
}

describe('Coordinator installation index bootstrap queue path', () => {
  it('enumerates one page, persists it, and emits only a bootstrap continuation', async () => {
    const leaseToken = 'bootstrap-lease-token-0001';
    const stub = {
      claimIndexBootstrap: vi.fn(async () => ({
        status: 'claimed',
        leaseToken,
        expiresAt: Date.now() + 60_000,
        resumed: false,
        command,
        commandDigest: 'd'.repeat(64),
        phase: 'enumerating',
        pass: 1,
        cursor: null,
      })),
      recordIndexBootstrapPage: vi.fn(async () => ({
        status: 'pass-complete',
        nextPass: 2,
      })),
      releaseIndexBootstrap: vi.fn(async () => ({ status: 'released' })),
      failIndexBootstrap: vi.fn(),
    } as unknown as InstallationFanoutCoordinatorStub;
    const controlFetch = vi.fn(async (
      _input: Request | string | URL,
      init?: RequestInit,
    ) => {
      const request =
        await parseStewardRuntimeInstallationIndexBootstrapPageRequestV1(
          JSON.parse(String(init?.body)),
        );
      expect(request.binding).toMatchObject({
        pass: 1,
        cursor: null,
        command,
      });
      const receipt =
        await buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1({
          binding: request.binding,
          installation: { state: 'live', id: installationId },
          page: {
            totalCount: 2,
            repositoryIds: [101, 202],
            hasNextPage: false,
            endCursor: null,
          },
          controlRevision: revision,
        });
      return new Response(
        await canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json(
          receipt,
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    });
    const { env, send, sendBatch } = envWithStub(stub, controlFetch);
    const { message, ack, retry } = queueMessage();

    await processCoordinatorMessage(message, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(command),
      { contentType: 'text' },
    );
    expect(sendBatch).not.toHaveBeenCalled();
    expect(stub.recordIndexBootstrapPage).toHaveBeenCalledOnce();
  });

  it('finalizes without Control calls or child Queue messages', async () => {
    const leaseToken = 'bootstrap-lease-token-0002';
    const stub = {
      claimIndexBootstrap: vi.fn(async () => ({
        status: 'claimed',
        leaseToken,
        expiresAt: Date.now() + 60_000,
        resumed: true,
        command,
        commandDigest: 'd'.repeat(64),
        phase: 'finalizing',
        pass: null,
        cursor: null,
      })),
      finalizeIndexBootstrap: vi.fn(async () => ({
        status: 'completed',
        receipt: {
          schemaVersion: 1,
          operation: 'installation-index-bootstrap-status',
          requestId: command.requestId,
          commandDigest: 'd'.repeat(64),
          installationId,
          status: 'completed',
          lastKnownIndexKnown: true,
          repositoryCount: 2,
          indexDigest: 'e'.repeat(64),
          controlRevision: revision,
          failureCode: null,
          updatedAt: '2026-07-28T04:02:00.000Z',
        },
      })),
    } as unknown as InstallationFanoutCoordinatorStub;
    const controlFetch = vi.fn(async () => {
      throw new Error('Control must not run while finalizing.');
    });
    const { env, send, sendBatch } = envWithStub(stub, controlFetch);
    const { message, ack, retry } = queueMessage();

    await processCoordinatorMessage(message, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(controlFetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('exposes private status only for the bound request, digest, and principal', async () => {
    const inspectIndexBootstrap = vi.fn(async (
      requestId: string,
      digest: string,
      principal: string,
    ) => {
      expect({ requestId, digest, principal }).toEqual({
        requestId: command.requestId,
        digest: 'd'.repeat(64),
        principal: command.principal.accessServiceClientId,
      });
      return {
        schemaVersion: 1,
        operation: 'installation-index-bootstrap-status',
        requestId,
        commandDigest: digest,
        installationId,
        status: 'completed',
        lastKnownIndexKnown: true,
        repositoryCount: 2,
        indexDigest: 'e'.repeat(64),
        controlRevision: revision,
        failureCode: null,
        updatedAt: '2026-07-28T04:02:00.000Z',
      } as const;
    });
    const stub = (
      { inspectIndexBootstrap } as unknown
    ) as InstallationFanoutCoordinatorStub;
    const { env } = envWithStub(stub, vi.fn());
    const response = await createCoordinatorHandler().fetch(
      new Request(
        'https://coordinator.internal/v1/installation-index-bootstrap/status',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-steward-internal-protocol':
              'installation-index-bootstrap-status-1',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            operation: 'installation-index-bootstrap-status',
            bootstrapRequestId: command.requestId,
            installationId,
            expectedBootstrapDigest: 'd'.repeat(64),
            principal: command.principal,
          }),
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'completed',
      lastKnownIndexKnown: true,
    });
    expect(inspectIndexBootstrap).toHaveBeenCalledOnce();
  });
});
