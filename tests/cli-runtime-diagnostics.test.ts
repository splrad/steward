import { describe, expect, it, vi } from 'vitest';
import {
  PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
  readRuntimeDiagnostics,
  type RuntimeDiagnosticsProvider,
} from '../packages/cli/src/runtime-diagnostics.js';

const target = {
  repositoryId: 17,
  repositoryFullName: 'splrad/LayerScape',
} as const;
const fallbackObservedAt = '2026-07-23T01:00:00.000Z';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    subject: target,
    observedAt: '2026-07-23T00:59:00.000Z',
    diagnostics: {
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: 'worker-version-1',
        workerDeploymentId: 'worker-deployment-1',
        environment: 'canary',
      },
      queue: 'ready',
      control: 'ready',
      deadLetterQueue: 'clear',
    },
    ...overrides,
  };
}

function provider(result: unknown): RuntimeDiagnosticsProvider {
  return {
    read: vi.fn(async () => result) as RuntimeDiagnosticsProvider['read'],
  };
}

describe('private runtime diagnostics reader', () => {
  it('returns unavailable metadata without calling a provider', async () => {
    await expect(readRuntimeDiagnostics(undefined, target, fallbackObservedAt)).resolves.toEqual({
      status: 'unknown',
      reason: 'runtime-metadata-unavailable',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it.each([
    'runtime-metadata-unavailable',
    'permission-denied',
    'transport-error',
  ] as const)('preserves the provider unknown reason %s', async (reason) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'unknown', reason }),
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason,
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('maps a thrown provider error to transport-error', async () => {
    const failingProvider: RuntimeDiagnosticsProvider = {
      async read() {
        throw new Error('private transport failed');
      },
    };
    await expect(readRuntimeDiagnostics(
      failingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason: 'transport-error',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('strictly parses the response body and injects the local source', async () => {
    const result = await readRuntimeDiagnostics(
      provider({ status: 'response', body: envelope() }),
      target,
      fallbackObservedAt,
    );
    expect(result).toEqual({
      status: 'known',
      envelope: envelope(),
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
    });
    expect(result).not.toHaveProperty('observedAt');
  });

  it.each([
    { repositoryId: 18, repositoryFullName: target.repositoryFullName },
    { repositoryId: target.repositoryId, repositoryFullName: 'splrad/Other' },
  ])('rejects a response bound to another repository: %#', async (subject) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'response', body: envelope({ subject }) }),
      target,
      fallbackObservedAt,
    )).resolves.toEqual({
      status: 'unknown',
      reason: 'repository-identity-mismatch',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('compares GitHub repository full names case-insensitively', async () => {
    await expect(readRuntimeDiagnostics(
      provider({
        status: 'response',
        body: envelope({
          subject: {
            repositoryId: target.repositoryId,
            repositoryFullName: 'SPLRAD/layerscape',
          },
        }),
      }),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
  });

  it('does not let a provider mutate the trusted target identity', async () => {
    const mutableTarget = { ...target };
    const mutatingProvider: RuntimeDiagnosticsProvider = {
      async read(received) {
        expect(Reflect.set(received, 'repositoryId', 999)).toBe(false);
        expect(Reflect.set(received, 'repositoryFullName', 'splrad/Other')).toBe(false);
        return { status: 'response', body: envelope() };
      },
    };
    await expect(readRuntimeDiagnostics(
      mutatingProvider,
      mutableTarget,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
    expect(mutableTarget).toEqual(target);
  });

  it.each([
    null,
    {},
    { status: 'response' },
    { status: 'response', body: envelope(), extra: true },
    { status: 'unknown' },
    { status: 'unknown', reason: 'snapshot-changed' },
    { status: 'unknown', reason: 'permission-denied', extra: true },
  ])('rejects a malformed provider wrapper %#', async (wrapper) => {
    await expect(readRuntimeDiagnostics(
      provider(wrapper),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('fails closed when inspecting a hostile provider wrapper throws', async () => {
    const wrapper = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile wrapper');
      },
    });
    await expect(readRuntimeDiagnostics(
      provider(wrapper),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it.each([
    null,
    {},
    envelope({ schemaVersion: 2 }),
    envelope({ source: 'wire-controlled-source' }),
    envelope({ observedAt: 'not-a-timestamp' }),
    envelope({ subject: { ...target, repositoryId: 0 } }),
  ])('rejects a malformed response body %#', async (body) => {
    await expect(readRuntimeDiagnostics(
      provider({ status: 'response', body }),
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
      observedAt: fallbackObservedAt,
    });
  });

  it('does not cache provider responses between reads', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'response', body: envelope() })
      .mockResolvedValueOnce({
        status: 'unknown',
        reason: 'runtime-metadata-unavailable',
      });
    const changingProvider = { read } as RuntimeDiagnosticsProvider;

    await expect(readRuntimeDiagnostics(
      changingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({ status: 'known' });
    await expect(readRuntimeDiagnostics(
      changingProvider,
      target,
      fallbackObservedAt,
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'runtime-metadata-unavailable',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, target);
    expect(read).toHaveBeenNthCalledWith(2, target);
  });
});
