import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeInstallationIndexBootstrapPageRequestV1,
  buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json,
  deriveStewardRuntimeInstallationIndexBootstrapDigest,
  deriveStewardRuntimeInstallationRepositoryIndexDigest,
  parseStewardRuntimeInstallationIndexBootstrapCommandV1,
  parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  parseStewardRuntimeInstallationIndexBootstrapStatusCommandV1,
} from '../packages/core/src/index.js';

const revision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: '11111111-2222-4333-8444-555555555555',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-28T04:00:00.000Z',
};

const command = {
  schemaVersion: 1,
  operation: 'installation-index-bootstrap',
  requestId: '11111111-2222-4333-8444-555555555555',
  requestedAt: '2026-07-28T04:01:00.000Z',
  installationId: 145_952_003,
  expectedControlRevision: revision,
} as const;

describe('installation-index-bootstrap-v1 contracts', () => {
  it('keeps the Access-authorized source independent from webhook causality', async () => {
    const parsed = parseStewardRuntimeInstallationIndexBootstrapCommandV1(
      command,
    );
    const envelope =
      buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
        command: parsed,
        accessServiceClientId: 'bootstrap-service-client',
      });

    expect(envelope).not.toHaveProperty('cause');
    expect(envelope).not.toHaveProperty('scopeWorkItem');
    expect(parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(
      JSON.parse(
        canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
          envelope,
        ),
      ),
    )).toEqual(envelope);
    expect(
      await deriveStewardRuntimeInstallationIndexBootstrapDigest(envelope),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds every Control page to the command digest, pass, cursor, and revision', async () => {
    const envelope =
      buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
        command,
        accessServiceClientId: 'bootstrap-service-client',
      });
    const request =
      await buildStewardRuntimeInstallationIndexBootstrapPageRequestV1({
        command: envelope,
        pass: 2,
        cursor: '2',
      });
    const receipt =
      await buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1({
        binding: request.binding,
        installation: { state: 'live', id: command.installationId },
        page: {
          totalCount: 101,
          repositoryIds: [901],
          hasNextPage: false,
          endCursor: null,
        },
        controlRevision: revision,
      });
    const canonical =
      await canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json(
        receipt,
      );

    expect(await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
      JSON.parse(canonical),
    )).toEqual(receipt);
    expect(
      await canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json(
        request,
      ),
    ).toContain(request.binding.commandDigest);
  });

  it('rejects a tampered command digest and unknown fields', async () => {
    const envelope =
      buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
        command,
        accessServiceClientId: 'bootstrap-service-client',
      });
    const request =
      await buildStewardRuntimeInstallationIndexBootstrapPageRequestV1({
        command: envelope,
        pass: 1,
        cursor: null,
      });
    await expect(
      canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json({
        ...request,
        binding: {
          ...request.binding,
          commandDigest: 'b'.repeat(64),
        },
      }),
    ).rejects.toThrow(/digest/i);
    expect(() =>
      parseStewardRuntimeInstallationIndexBootstrapCommandV1({
        ...command,
        cause: { kind: 'github-webhook' },
      })).toThrow(/unknown/i);
  });

  it('parses a fresh, separate status command', () => {
    expect(parseStewardRuntimeInstallationIndexBootstrapStatusCommandV1({
      schemaVersion: 1,
      operation: 'inspect-installation-index-bootstrap',
      requestId: '22222222-3333-4444-8555-666666666666',
      requestedAt: '2026-07-28T04:02:00.000Z',
      bootstrapRequestId: command.requestId,
      installationId: command.installationId,
      expectedBootstrapDigest: 'c'.repeat(64),
    })).toMatchObject({
      operation: 'inspect-installation-index-bootstrap',
      bootstrapRequestId: command.requestId,
    });
  });

  it('derives an order-bound canonical repository index digest', async () => {
    await expect(
      deriveStewardRuntimeInstallationRepositoryIndexDigest([2, 1]),
    ).rejects.toThrow(/ascending/i);
    await expect(
      deriveStewardRuntimeInstallationRepositoryIndexDigest([1, 1]),
    ).rejects.toThrow(/unique/i);
    expect(
      await deriveStewardRuntimeInstallationRepositoryIndexDigest([1, 2]),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
