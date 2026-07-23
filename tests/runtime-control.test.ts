import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeControlReceipt,
  buildStewardRuntimeControlRequest,
  canonicalStewardRuntimeControlReceiptJson,
  canonicalStewardRuntimeControlRequestJson,
  parseStewardRuntimeControlReceipt,
  parseStewardRuntimeControlRequest,
  RuntimeControlProtocolValidationError,
  type StewardRuntimeControlReceiptV1,
  type StewardRuntimeControlRequestV1,
} from '../packages/core/src/runtime-control.js';

function request(): StewardRuntimeControlRequestV1 {
  return {
    schemaVersion: 1,
    generation: 7,
    workItem: {
      schemaVersion: 1,
      operation: 'runtime-probe',
      installationId: 145_952_003,
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      cause: {
        kind: 'internal-probe',
        deliveryId: 'probe:runtime:1',
        receivedAt: '2026-07-23T16:00:00.000Z',
      },
    },
  };
}

function receipt(): StewardRuntimeControlReceiptV1 {
  const value = request();
  return {
    schemaVersion: 1,
    state: 'converged',
    subject: value.workItem.subject,
    deliveryId: value.workItem.cause.deliveryId,
    generation: value.generation,
    controlRevision: {
      stewardCommit: 'a'.repeat(40),
      workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
      workerVersionTag: `steward-${'a'.repeat(40)}`,
      workerVersionCreatedAt: '2026-07-23T16:00:00.000Z',
    },
  };
}

describe('runtime Control transport protocol', () => {
  it('builds, parses, and canonicalizes the exact request', () => {
    const value = request();
    expect(parseStewardRuntimeControlRequest(value)).toEqual(value);
    expect(buildStewardRuntimeControlRequest({
      workItem: value.workItem,
      generation: value.generation,
    })).toEqual(value);
    expect(JSON.parse(canonicalStewardRuntimeControlRequestJson(value))).toEqual(value);
  });

  it('builds, parses, and canonicalizes the exact converged receipt', () => {
    const value = receipt();
    expect(parseStewardRuntimeControlReceipt(value)).toEqual(value);
    expect(buildStewardRuntimeControlReceipt({
      subject: value.subject,
      deliveryId: value.deliveryId,
      generation: value.generation,
      controlRevision: value.controlRevision,
    })).toEqual(value);
    expect(JSON.parse(canonicalStewardRuntimeControlReceiptJson(value))).toEqual(value);
  });

  it.each([
    null,
    [],
    new Date(),
    Object.create({ schemaVersion: 1 }),
  ])('rejects a non-plain request: %s', (value) => {
    expect(() => parseStewardRuntimeControlRequest(value))
      .toThrow(RuntimeControlProtocolValidationError);
  });

  it('rejects extra and symbol fields on both envelopes', () => {
    expect(() => parseStewardRuntimeControlRequest({
      ...request(),
      route: 'candidate',
    })).toThrow(RuntimeControlProtocolValidationError);

    const value = structuredClone(receipt()) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(value, Symbol('hidden'), { value: true, enumerable: true });
    expect(() => parseStewardRuntimeControlReceipt(value))
      .toThrow(RuntimeControlProtocolValidationError);
  });

  it.each([0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid generation %s',
    (generation) => {
      expect(() => parseStewardRuntimeControlRequest({
        ...request(),
        generation,
      })).toThrow(RuntimeControlProtocolValidationError);
    },
  );

  it('rejects a receipt that can be mistaken for a successful but unbound result', () => {
    const value = receipt();
    for (const mutation of [
      { ...value, state: 'accepted' },
      { ...value, deliveryId: '' },
      { ...value, generation: 0 },
      {
        ...value,
        subject: { ...value.subject, repositoryId: value.subject.repositoryId + 1 },
        extra: true,
      },
      {
        ...value,
        controlRevision: {
          ...value.controlRevision,
          stewardCommit: 'A'.repeat(40),
        },
      },
      {
        ...value,
        controlRevision: {
          ...value.controlRevision,
          workerVersionTag: `steward-${'b'.repeat(40)}`,
        },
      },
      {
        ...value,
        controlRevision: {
        ...value.controlRevision,
          workerVersionCreatedAt: '',
        },
      },
    ]) {
      expect(() => parseStewardRuntimeControlReceipt(mutation))
        .toThrow(RuntimeControlProtocolValidationError);
    }
  });
});
