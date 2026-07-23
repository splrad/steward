import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeWorkItem,
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeWorkItem,
  RuntimeWorkItemValidationError,
  stewardRuntimeWorkItemUtf8ByteSize,
  type StewardRuntimeWorkItemV1,
} from '../packages/core/src/runtime-work-item.js';
import { assertDeliveryId } from '../packages/coordinator/src/contracts.js';

function webhookItem(): StewardRuntimeWorkItemV1 {
  return {
    schemaVersion: 1,
    operation: 'pull-request-reconcile',
    installationId: 145_952_003,
    subject: {
      repositoryId: 1_298_587_318,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber: 6,
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
      event: 'pull_request',
      action: 'synchronize',
      receivedAt: '2026-07-23T16:00:00.123Z',
    },
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(webhookItem()) as unknown as Record<string, unknown>;
}

function expectInvalid(value: unknown): void {
  expect(() => parseStewardRuntimeWorkItem(value))
    .toThrow(RuntimeWorkItemValidationError);
}

describe('runtime work-item wire protocol', () => {
  it('parses and builds the exact version 1 envelope', () => {
    const value = webhookItem();
    expect(parseStewardRuntimeWorkItem(value)).toEqual(value);
    expect(buildStewardRuntimeWorkItem({
      operation: value.operation,
      installationId: value.installationId,
      subject: value.subject,
      cause: value.cause,
    })).toEqual(value);
  });

  it('accepts every exact cause variant', () => {
    const base = webhookItem();
    expect(parseStewardRuntimeWorkItem({
      ...base,
      operation: 'runtime-probe',
      cause: {
        kind: 'internal-probe',
        deliveryId: 'probe:runtime:1',
        receivedAt: '2026-07-23T16:01:00.000Z',
      },
    }).cause).toEqual({
      kind: 'internal-probe',
      deliveryId: 'probe:runtime:1',
      receivedAt: '2026-07-23T16:01:00.000Z',
    });

  });

  it('binds each operation to its permitted cause provenance', () => {
    const base = webhookItem();
    expectInvalid({
      ...base,
      operation: 'runtime-probe',
    });
    expectInvalid({
      ...base,
      cause: {
        kind: 'internal-probe',
        deliveryId: 'probe:runtime:1',
        receivedAt: '2026-07-23T16:01:00.000Z',
      },
    });
  });

  it('writes canonical JSON in protocol order and reports its UTF-8 size', () => {
    const value = webhookItem();
    const canonical =
      '{"schemaVersion":1,"operation":"pull-request-reconcile","installationId":145952003,'
      + '"subject":{"repositoryId":1298587318,"repositoryFullName":"splrad/steward-sandbox-install-e2e",'
      + '"pullRequestNumber":6},"cause":{"kind":"github-webhook",'
      + '"deliveryId":"33f08dc0-7caf-11f1-8d3a-340f601f41b1","event":"pull_request",'
      + '"action":"synchronize","receivedAt":"2026-07-23T16:00:00.123Z"}}';
    expect(canonicalStewardRuntimeWorkItemJson(value)).toBe(canonical);
    expect(stewardRuntimeWorkItemUtf8ByteSize(value))
      .toBe(new TextEncoder().encode(canonical).byteLength);
  });

  it('keeps every accepted delivery ID valid at the Coordinator boundary', () => {
    for (const deliveryId of [
      'delivery-1',
      'probe:runtime:1',
      '!'.repeat(128),
    ]) {
      const value = webhookItem();
      (value.cause as { deliveryId: string }).deliveryId = deliveryId;
      const parsed = parseStewardRuntimeWorkItem(value);
      expect(assertDeliveryId(parsed.cause.deliveryId)).toBe(deliveryId);
    }
  });

  it('does not publish an operator replay shape before replay identity exists', () => {
    const value = webhookItem();
    expectInvalid({
      ...value,
      cause: {
        ...value.cause,
        kind: 'operator-replay',
        replayId: 'operator-replay-1',
        replayedAt: '2026-07-23T16:10:00.000Z',
      },
    });
  });

  it.each([
    null,
    [],
    new Date(),
    Object.create({ schemaVersion: 1 }),
  ])('rejects a non-plain envelope: %s', (value) => {
    expectInvalid(value);
  });

  it('rejects non-plain nested objects', () => {
    const subject = clone();
    subject.subject = Object.assign(Object.create({ inherited: true }), {
      repositoryId: 1,
      repositoryFullName: 'splrad/steward',
      pullRequestNumber: 1,
    });
    expectInvalid(subject);

    const cause = clone();
    cause.cause = Object.assign(Object.create({ inherited: true }), webhookItem().cause);
    expectInvalid(cause);
  });

  it.each([
    ['top-level', (value: Record<string, unknown>) => { value.queue = 'primary'; }],
    ['subject', (value: Record<string, unknown>) => {
      (value.subject as Record<string, unknown>).headSha = 'a'.repeat(40);
    }],
    ['webhook cause', (value: Record<string, unknown>) => {
      (value.cause as Record<string, unknown>).replayId = 'unexpected';
    }],
  ])('rejects unknown %s fields', (_field, mutate) => {
    const value = clone();
    mutate(value);
    expectInvalid(value);
  });

  it('rejects symbol fields at every object boundary', () => {
    for (const field of ['workItem', 'subject', 'cause'] as const) {
      const value = clone();
      const target = field === 'workItem'
        ? value
        : value[field] as Record<PropertyKey, unknown>;
      Object.defineProperty(target, Symbol('hidden'), { value: true, enumerable: true });
      expectInvalid(value);
    }
  });

  it.each([
    0,
    2,
    '1',
    null,
  ])('rejects unsupported schema version %s', (schemaVersion) => {
    expectInvalid({ ...webhookItem(), schemaVersion });
  });

  it.each([
    'classification',
    '',
    ' pull-request-reconcile',
    null,
  ])('rejects unsupported operation %s', (operation) => {
    expectInvalid({ ...webhookItem(), operation });
  });

  it.each([
    ['installationId', (value: Record<string, unknown>, id: unknown) => { value.installationId = id; }],
    ['repositoryId', (value: Record<string, unknown>, id: unknown) => {
      (value.subject as Record<string, unknown>).repositoryId = id;
    }],
    ['pullRequestNumber', (value: Record<string, unknown>, id: unknown) => {
      (value.subject as Record<string, unknown>).pullRequestNumber = id;
    }],
  ])('requires %s to be a positive safe integer', (_field, mutate) => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const value = clone();
      mutate(value, id);
      expectInvalid(value);
    }
  });

  it.each([
    '',
    'splrad',
    'splrad/steward/extra',
    ' splrad/steward',
    'splrad/steward ',
    '-splrad/steward',
    'splrad/steward repository',
    `${'a'.repeat(40)}/steward`,
    `splrad/${'a'.repeat(101)}`,
  ])('rejects non-canonical repository full name %s', (repositoryFullName) => {
    const value = clone();
    (value.subject as Record<string, unknown>).repositoryFullName = repositoryFullName;
    expectInvalid(value);
  });

  it.each([
    '2026-07-23T16:00:00Z',
    '2026-07-23T16:00:00.123+00:00',
    '2026-02-30T16:00:00.123Z',
    ' 2026-07-23T16:00:00.123Z',
    '',
  ])('rejects non-canonical timestamp %s', (receivedAt) => {
    const value = clone();
    (value.cause as Record<string, unknown>).receivedAt = receivedAt;
    expectInvalid(value);
  });

  it.each([
    '',
    ' delivery',
    'delivery ',
    'delivery id',
    `delivery-${'x'.repeat(121)}`,
    'delivery\nid',
  ])('rejects invalid bounded delivery ID %j', (deliveryId) => {
    const value = clone();
    (value.cause as Record<string, unknown>).deliveryId = deliveryId;
    expectInvalid(value);
  });

  it.each([
    ['event', 'PullRequest'],
    ['event', `a${'b'.repeat(64)}`],
    ['event', 'issues'],
    ['event', 'pull_request_review'],
    ['action', 'submitted'],
    ['action', 'synchronize '],
    ['action', ''],
    ['action', 'review-submitted'],
  ])('rejects invalid %s identifier %j', (field, identifier) => {
    const value = clone();
    (value.cause as Record<string, unknown>)[field] = identifier;
    expectInvalid(value);
  });

  it('enforces exact cause fields for each discriminator', () => {
    const missing = clone();
    delete (missing.cause as Record<string, unknown>).action;
    expectInvalid(missing);

    const internalWithWebhookFields = clone();
    (internalWithWebhookFields.cause as Record<string, unknown>).kind = 'internal-probe';
    expectInvalid(internalWithWebhookFields);

    const unknown = clone();
    (unknown.cause as Record<string, unknown>).kind = 'scheduled-retry';
    expectInvalid(unknown);
  });

  it('rejects builder input that attempts to supply the schema version', () => {
    const value = webhookItem();
    expect(() => buildStewardRuntimeWorkItem({
      schemaVersion: 1,
      operation: value.operation,
      installationId: value.installationId,
      subject: value.subject,
      cause: value.cause,
    } as unknown as Parameters<typeof buildStewardRuntimeWorkItem>[0]))
      .toThrow(RuntimeWorkItemValidationError);
  });
});
