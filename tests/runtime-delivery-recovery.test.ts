import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  buildStewardRuntimeDeliveryRecoveryPageReceiptV1,
  buildStewardRuntimeDeliveryRecoveryPageRequestV1,
  buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json,
  canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json,
  canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json,
  digestStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  digestStewardRuntimeDeliveryRecoveryPageReceiptV1,
  digestStewardRuntimeDeliveryRecoveryPageRequestV1,
  digestStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1,
  parseStewardRuntimeDeliveryRecoveryPageReceiptV1,
  parseStewardRuntimeDeliveryRecoveryPageRequestV1,
  parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1,
  STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ATTEMPTS,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';

const revision: StewardRuntimeControlRevisionV1 = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-27T03:00:00.000Z',
};

const scanId = '313bcfe7-a5ba-45d0-aefe-999ddc101c25';
const intentId = 'b77ea4cd-183f-4820-b72c-e59a774ab44e';

function pageRequest() {
  return buildStewardRuntimeDeliveryRecoveryPageRequestV1({
    scanId,
    cursor: 'cursor-page-1==',
    expectedControlRevision: revision,
  });
}

function attempt(id = 57) {
  return {
    id,
    guid: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    deliveredAt: '2026-07-27T03:04:05.678Z',
    redelivery: false,
    status: 'Internal Server Error',
    statusCode: 500,
    installationId: 145_952_003,
    repositoryId: null,
    event: 'pull_request',
    action: 'synchronize',
  };
}

function pageReceipt() {
  return buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
    scanId,
    cursor: pageRequest().cursor,
    attempts: [attempt()],
    nextCursor: 'cursor-page-2==',
    controlRevision: revision,
  });
}

function redeliveryRequest() {
  return buildStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
    scanId,
    intentId,
    attemptId: attempt().id,
    guid: attempt().guid,
    expectedControlRevision: revision,
  });
}

function acceptedReceipt() {
  return buildStewardRuntimeDeliveryRecoveryAcceptedReceiptV1({
    scanId,
    intentId,
    attemptId: attempt().id,
    guid: attempt().guid,
    controlRevision: revision,
  });
}

describe('runtime delivery recovery protocol', () => {
  it('round-trips all four strict v1 envelopes with stable canonical bytes', () => {
    const request = pageRequest();
    const receipt = pageReceipt();
    const redelivery = redeliveryRequest();
    const accepted = acceptedReceipt();

    expect(parseStewardRuntimeDeliveryRecoveryPageRequestV1(request))
      .toEqual(request);
    expect(parseStewardRuntimeDeliveryRecoveryPageReceiptV1(receipt))
      .toEqual(receipt);
    expect(parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(redelivery))
      .toEqual(redelivery);
    expect(parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(accepted))
      .toEqual(accepted);
    expect(canonicalStewardRuntimeDeliveryRecoveryPageRequestV1Json(request))
      .toBe(JSON.stringify(request));
    expect(canonicalStewardRuntimeDeliveryRecoveryPageReceiptV1Json(receipt))
      .toBe(JSON.stringify(receipt));
    expect(
      canonicalStewardRuntimeDeliveryRecoveryRedeliveryRequestV1Json(
        redelivery,
      ),
    ).toBe(JSON.stringify(redelivery));
    expect(
      canonicalStewardRuntimeDeliveryRecoveryAcceptedReceiptV1Json(accepted),
    ).toBe(JSON.stringify(accepted));
  });

  it('derives stable SHA-256 digests bound to each complete envelope', async () => {
    const requestDigest =
      await digestStewardRuntimeDeliveryRecoveryPageRequestV1(pageRequest());
    const receiptDigest =
      await digestStewardRuntimeDeliveryRecoveryPageReceiptV1(pageReceipt());
    const redeliveryDigest =
      await digestStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(
        redeliveryRequest(),
      );
    const acceptedDigest =
      await digestStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(
        acceptedReceipt(),
      );

    for (const digest of [
      requestDigest,
      receiptDigest,
      redeliveryDigest,
      acceptedDigest,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    await expect(
      digestStewardRuntimeDeliveryRecoveryPageRequestV1(pageRequest()),
    ).resolves.toBe(requestDigest);
    await expect(
      digestStewardRuntimeDeliveryRecoveryPageRequestV1({
        ...pageRequest(),
        cursor: 'different',
      }),
    ).resolves.not.toBe(requestDigest);
    await expect(
      digestStewardRuntimeDeliveryRecoveryRedeliveryRequestV1({
        ...redeliveryRequest(),
        intentId: 'b77ea4cd-183f-4820-b72c-e59a774ab44f',
      }),
    ).resolves.not.toBe(redeliveryDigest);
  });

  it('fails closed on unknown keys, non-plain values, and field-name drift', () => {
    expect(() => parseStewardRuntimeDeliveryRecoveryPageRequestV1({
      ...pageRequest(),
      unknown: true,
    })).toThrow('missing or unknown fields');

    const hidden = pageRequest() as unknown as Record<PropertyKey, unknown>;
    hidden[Symbol('hidden')] = true;
    expect(() => parseStewardRuntimeDeliveryRecoveryPageRequestV1(hidden))
      .toThrow('missing or unknown fields');

    expect(() => parseStewardRuntimeDeliveryRecoveryPageRequestV1(
      Object.assign(Object.create({ inherited: true }), pageRequest()),
    )).toThrow('plain object');

    const { expectedControlRevision: ignored, ...wrongRevisionName } =
      pageRequest();
    expect(ignored).toEqual(revision);
    expect(() => parseStewardRuntimeDeliveryRecoveryPageRequestV1({
      ...wrongRevisionName,
      controlRevision: revision,
    })).toThrow('missing or unknown fields');
  });

  it('enforces canonical IDs, cursors, timestamps, and attempt boundaries', () => {
    const invalidRequests: unknown[] = [
      { ...pageRequest(), scanId: scanId.toUpperCase() },
      { ...pageRequest(), cursor: ' cursor' },
      { ...pageRequest(), cursor: 'x'.repeat(1_025) },
      {
        ...pageRequest(),
        expectedControlRevision: {
          ...revision,
          stewardCommit: 'A'.repeat(40),
        },
      },
    ];
    for (const value of invalidRequests) {
      expect(() => parseStewardRuntimeDeliveryRecoveryPageRequestV1(value))
        .toThrow();
    }

    const invalidAttempts = [
      { ...attempt(), id: 0 },
      { ...attempt(), guid: 'x'.repeat(129) },
      { ...attempt(), deliveredAt: '2026-07-27T03:04:05Z' },
      { ...attempt(), redelivery: 0 },
      { ...attempt(), status: ' OK' },
      { ...attempt(), status: 'bad\nstatus' },
      { ...attempt(), statusCode: 1_000 },
      { ...attempt(), installationId: 0 },
      { ...attempt(), repositoryId: -1 },
      { ...attempt(), event: 'pull request' },
      { ...attempt(), action: '' },
    ];
    for (const invalidAttempt of invalidAttempts) {
      expect(() => parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
        ...pageReceipt(),
        attempts: [invalidAttempt],
      })).toThrow();
    }
  });

  it('bounds pages, rejects duplicate attempts, and requires cursor progress', () => {
    expect(() => parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
      ...pageReceipt(),
      attempts: Array.from(
        { length: STEWARD_RUNTIME_DELIVERY_RECOVERY_MAXIMUM_ATTEMPTS + 1 },
        (_, index) => attempt(index + 1),
      ),
    })).toThrow('must not exceed');
    expect(() => parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
      ...pageReceipt(),
      attempts: [attempt(), attempt()],
    })).toThrow('unique attempt IDs');
    expect(() => parseStewardRuntimeDeliveryRecoveryPageReceiptV1({
      ...pageReceipt(),
      nextCursor: pageReceipt().cursor,
    })).toThrow('must advance');

    const terminal = buildStewardRuntimeDeliveryRecoveryPageReceiptV1({
      scanId,
      cursor: null,
      attempts: [{
        ...attempt(),
        installationId: null,
        repositoryId: null,
        action: null,
      }],
      nextCursor: null,
      controlRevision: revision,
    });
    expect(terminal.nextCursor).toBeNull();
    expect(terminal.attempts[0]?.action).toBeNull();
  });

  it('strictly binds redelivery intents and accepted receipts', () => {
    const invalidRedeliveries: unknown[] = [
      { ...redeliveryRequest(), intentId: intentId.toUpperCase() },
      { ...redeliveryRequest(), attemptId: 0 },
      { ...redeliveryRequest(), guid: ' delivery-guid' },
      {
        ...redeliveryRequest(),
        expectedControlRevision: {
          ...revision,
          workerVersionId: 'not-a-uuid',
        },
      },
      { ...acceptedReceipt(), attemptId: Number.MAX_SAFE_INTEGER + 1 },
      { ...acceptedReceipt(), controlRevision: null },
    ];
    for (const value of invalidRedeliveries) {
      expect(() => (
        (value as { phase?: unknown }).phase === 'redeliver-delivery'
          ? parseStewardRuntimeDeliveryRecoveryRedeliveryRequestV1(value)
          : parseStewardRuntimeDeliveryRecoveryAcceptedReceiptV1(value)
      )).toThrow();
    }

    const request = redeliveryRequest();
    const receipt = acceptedReceipt();
    expect({
      scanId: receipt.scanId,
      intentId: receipt.intentId,
      attemptId: receipt.attemptId,
      guid: receipt.guid,
    }).toEqual({
      scanId: request.scanId,
      intentId: request.intentId,
      attemptId: request.attemptId,
      guid: request.guid,
    });
  });
});
