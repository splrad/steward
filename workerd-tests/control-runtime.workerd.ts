import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsControlProbe,
  buildStewardRuntimeControlRequest,
  buildStewardRuntimeWorkItem,
  canonicalStewardRuntimeDiagnosticsControlProbeJson,
  canonicalStewardRuntimeControlRequestJson,
  parseStewardRuntimeDiagnosticsControlReceipt,
  parseStewardRuntimeControlReceipt,
} from '../packages/core/src/index.js';
import {
  controlRuntimeCanonicalRepositoryFullName,
  controlRuntimeDiagnosticsSubject,
  controlRuntimeVersionMetadata,
} from './control-runtime-fixture.js';

interface ControlRuntimeExport {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

const controlRuntime = (
  exports as unknown as { default: ControlRuntimeExport }
).default;

function controlRequest(
  operation: 'runtime-probe' | 'pull-request-reconcile',
): Request {
  const workItem = operation === 'runtime-probe'
    ? buildStewardRuntimeWorkItem({
        operation,
        installationId: 145_952_003,
        subject: {
          repositoryId: 1_298_587_318,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber: 6,
        },
        cause: {
          kind: 'internal-probe',
          deliveryId: 'control-workerd-runtime-probe',
          receivedAt: '2026-07-23T18:00:00.000Z',
        },
      })
    : buildStewardRuntimeWorkItem({
        operation,
        installationId: 145_952_003,
        subject: {
          repositoryId: 1_298_587_318,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber: 6,
        },
        cause: {
          kind: 'github-webhook',
          deliveryId: 'control-workerd-pull-request',
          event: 'pull_request',
          action: 'opened',
          receivedAt: '2026-07-23T18:00:01.000Z',
        },
      });

  return new Request('https://control.internal/v1/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
    },
    body: canonicalStewardRuntimeControlRequestJson(
      buildStewardRuntimeControlRequest({
        workItem,
        generation: 7,
      }),
    ),
  });
}

function diagnosticsRequest(
  repositoryFullName: string =
    controlRuntimeDiagnosticsSubject.repositoryFullName,
): Request {
  return new Request('https://control.internal/v1/runtime-diagnostics', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
    },
    body: canonicalStewardRuntimeDiagnosticsControlProbeJson(
      buildStewardRuntimeDiagnosticsControlProbe({
        nonce: 'b'.repeat(64),
        subject: {
          repositoryId: controlRuntimeDiagnosticsSubject.repositoryId,
          repositoryFullName,
        },
        environment: 'production',
      }),
    ),
  });
}

describe('Control runtime in workerd', () => {
  it('authenticates the live repository scope through the GitHub App three-step chain', async () => {
    const response = await controlRuntime.fetch(diagnosticsRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const receipt = parseStewardRuntimeDiagnosticsControlReceipt(
      JSON.parse(await response.text()) as unknown,
    );
    expect(receipt).toEqual({
      transportVersion: 1,
      audience: 'steward-runtime-diagnostics',
      nonce: 'b'.repeat(64),
      subject: {
        repositoryId: controlRuntimeDiagnosticsSubject.repositoryId,
        repositoryFullName: controlRuntimeCanonicalRepositoryFullName,
      },
      environment: 'production',
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: controlRuntimeVersionMetadata.id,
        workerVersionTag: controlRuntimeVersionMetadata.tag,
        workerVersionCreatedAt: controlRuntimeVersionMetadata.timestamp,
      },
    });
  });

  it('rejects a foreign organization before any outbound GitHub request', async () => {
    const response = await controlRuntime.fetch(
      diagnosticsRequest('other/steward-sandbox-install-e2e'),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-access-denied',
    });
  });

  it('binds the runtime-probe receipt to the Worker version-metadata binding', async () => {
    const response = await controlRuntime.fetch(
      controlRequest('runtime-probe'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const receipt = parseStewardRuntimeControlReceipt(
      JSON.parse(await response.text()) as unknown,
    );
    expect(receipt).toEqual({
      schemaVersion: 1,
      state: 'converged',
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      deliveryId: 'control-workerd-runtime-probe',
      generation: 7,
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: controlRuntimeVersionMetadata.id,
        workerVersionTag: controlRuntimeVersionMetadata.tag,
        workerVersionCreatedAt: controlRuntimeVersionMetadata.timestamp,
      },
    });
  });

  it('keeps real pull-request reconciliation fail-closed', async () => {
    const response = await controlRuntime.fetch(
      controlRequest('pull-request-reconcile'),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'control-operation-not-implemented',
    });
  });
});
