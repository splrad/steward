import { describe, expect, it } from 'vitest';
import {
  canonicalStewardRuntimeControlRequestJson,
  buildStewardRuntimeControlRequest,
} from '../packages/core/src/runtime-control.js';
import {
  createControlRuntimeHandler,
  maximumControlRequestBytes,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-23T16:00:00.000Z',
  },
};

function controlRequest(operation: 'runtime-probe' | 'pull-request-reconcile' = 'runtime-probe') {
  const internal = operation === 'runtime-probe';
  return buildStewardRuntimeControlRequest({
    generation: 7,
    workItem: {
      schemaVersion: 1,
      operation,
      installationId: 145_952_003,
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      cause: internal
        ? {
            kind: 'internal-probe',
            deliveryId: 'probe:runtime:1',
            receivedAt: '2026-07-23T16:00:00.000Z',
          }
        : {
            kind: 'github-webhook',
            deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
            event: 'pull_request',
            action: 'synchronize',
            receivedAt: '2026-07-23T16:00:00.000Z',
          },
    },
  });
}

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://control.internal/v1/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
      ...headers,
    },
    body,
  });
}

describe('private Control runtime foundation', () => {
  it('returns an exact revision-bound receipt for an internal runtime probe', async () => {
    const input = controlRequest();
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(input)),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      state: 'converged',
      subject: input.workItem.subject,
      deliveryId: input.workItem.cause.deliveryId,
      generation: input.generation,
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: env.CF_VERSION_METADATA.id,
        workerVersionTag: env.CF_VERSION_METADATA.tag,
        workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
      },
    });
  });

  it('fails closed instead of acknowledging a real pull-request operation', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(controlRequest('pull-request-reconcile'))),
      env,
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'control-operation-not-implemented',
    });
  });

  it('requires the private protocol marker and exact JSON transport', async () => {
    const body = canonicalStewardRuntimeControlRequestJson(controlRequest());
    expect((await createControlRuntimeHandler().fetch(
      request(body, { 'x-steward-internal-protocol': '0' }),
      env,
    )).status).toBe(403);
    expect((await createControlRuntimeHandler().fetch(
      request(body, { 'content-type': 'text/plain' }),
      env,
    )).status).toBe(415);
  });

  it('rejects malformed requests without exposing validation details', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request('{"schemaVersion":1}'),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-control-request' });
  });

  it('streams and rejects an oversized request body before parsing it', async () => {
    const oversized = `"${'x'.repeat(maximumControlRequestBytes)}"`;
    const response = await createControlRuntimeHandler().fetch(
      request(oversized),
      env,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'request-too-large',
    });
  });

  it('fails closed when immutable revision bindings are absent or invalid', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(controlRequest())),
      {
        ...env,
        CF_VERSION_METADATA: {
          ...env.CF_VERSION_METADATA,
          tag: 'unbound',
        },
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'control-revision-unavailable',
    });
  });

  it('has no public health, diagnostics, or catch-all route', async () => {
    const response = await createControlRuntimeHandler().fetch(
      new Request('https://control.internal/health'),
      env,
    );
    expect(response.status).toBe(404);
  });
});
