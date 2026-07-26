import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeScopeWorkItemV1,
  canonicalStewardRuntimeScopeWorkItemJson,
  parseStewardRuntimeScopeWorkItemV1,
  RuntimeScopeWorkItemValidationError,
  STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1,
  type StewardRuntimeScopeWorkItemV1,
} from '../packages/core/src/runtime-scope-work-item.js';

function scopeItem(): StewardRuntimeScopeWorkItemV1 {
  return {
    schemaVersion: 1,
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryId: 1_298_587_318,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event: 'repository',
      action: 'renamed',
      receivedAt: '2026-07-27T00:00:00.123Z',
    },
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(scopeItem()) as unknown as Record<string, unknown>;
}

function expectInvalid(value: unknown): void {
  expect(() => parseStewardRuntimeScopeWorkItemV1(value))
    .toThrow(RuntimeScopeWorkItemValidationError);
}

describe('runtime repository scope work-item v1 wire protocol', () => {
  it('parses, builds, and canonicalizes the exact envelope', () => {
    const value = scopeItem();
    expect(parseStewardRuntimeScopeWorkItemV1(value)).toEqual(value);
    expect(buildStewardRuntimeScopeWorkItemV1({
      operation: value.operation,
      target: value.target,
      cause: value.cause,
    })).toEqual(value);
    expect(canonicalStewardRuntimeScopeWorkItemJson(value)).toBe(
      '{"schemaVersion":1,"operation":"scope-reconcile",'
      + '"target":{"scope":"repository","mode":"refresh","installationId":145952003,'
      + '"repositoryId":1298587318,"pullRequests":"all-open"},'
      + '"cause":{"kind":"github-webhook",'
      + '"deliveryId":"72d3162e-cc78-11e3-81ab-4c9367dc0958",'
      + '"event":"repository","action":"renamed",'
      + '"receivedAt":"2026-07-27T00:00:00.123Z"}}',
    );
  });

  it.each([...STEWARD_RUNTIME_REPOSITORY_ACTIONS_V1])(
    'accepts the exact repository action %s',
    (action) => {
      const value = structuredClone(scopeItem()) as unknown as Record<string, unknown>;
      (value.cause as Record<string, unknown>).action = action;
      expect(parseStewardRuntimeScopeWorkItemV1(value).cause.action).toBe(action);
    },
  );

  it.each([
    ['top-level', (value: Record<string, unknown>) => { value.liveReads = []; }],
    ['target', (value: Record<string, unknown>) => {
      (value.target as Record<string, unknown>).repositoryFullName = 'untrusted/name';
    }],
    ['cause', (value: Record<string, unknown>) => {
      (value.cause as Record<string, unknown>).changes = {};
    }],
  ])('rejects unknown %s fields', (_field, mutate) => {
    const value = clone();
    mutate(value);
    expectInvalid(value);
  });

  it.each(['workItem', 'target', 'cause'] as const)(
    'rejects symbol fields on %s',
    (field) => {
      const value = clone();
      const target = field === 'workItem'
        ? value
        : value[field] as Record<PropertyKey, unknown>;
      Object.defineProperty(target, Symbol('hidden'), { value: true, enumerable: true });
      expectInvalid(value);
    },
  );

  it('rejects non-plain objects at every boundary', () => {
    expectInvalid([]);

    const target = clone();
    target.target = Object.assign(Object.create({ inherited: true }), scopeItem().target);
    expectInvalid(target);

    const cause = clone();
    cause.cause = Object.assign(Object.create({ inherited: true }), scopeItem().cause);
    expectInvalid(cause);
  });

  it.each([
    ['schemaVersion', 2],
    ['operation', 'pull-request-reconcile'],
  ])('rejects invalid top-level %s', (field, value) => {
    expectInvalid({ ...scopeItem(), [field]: value });
  });

  it.each([
    ['scope', 'installation'],
    ['mode', 'scan'],
    ['pullRequests', 'all'],
  ])('rejects invalid target %s', (field, received) => {
    const value = clone();
    (value.target as Record<string, unknown>)[field] = received;
    expectInvalid(value);
  });

  it.each(['installationId', 'repositoryId'])(
    'requires target %s to be a positive safe integer',
    (field) => {
      for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
        const value = clone();
        (value.target as Record<string, unknown>)[field] = id;
        expectInvalid(value);
      }
    },
  );

  it.each([
    ['kind', 'scope-fanout'],
    ['event', 'push'],
    ['action', 'future_action'],
  ])('rejects invalid cause %s', (field, received) => {
    const value = clone();
    (value.cause as Record<string, unknown>)[field] = received;
    expectInvalid(value);
  });

  it.each([
    '',
    ' delivery',
    'delivery ',
    'delivery id',
    `delivery-${'x'.repeat(120)}`,
    'delivery\nid',
  ])('rejects invalid delivery ID %j', (deliveryId) => {
    const value = clone();
    (value.cause as Record<string, unknown>).deliveryId = deliveryId;
    expectInvalid(value);
  });

  it.each([
    '2026-07-27T00:00:00Z',
    '2026-07-27T00:00:00.123+00:00',
    '2026-02-30T00:00:00.123Z',
    ' 2026-07-27T00:00:00.123Z',
  ])('rejects non-canonical timestamp %s', (receivedAt) => {
    const value = clone();
    (value.cause as Record<string, unknown>).receivedAt = receivedAt;
    expectInvalid(value);
  });

  it('rejects builder input that supplies schemaVersion', () => {
    const value = scopeItem();
    expect(() => buildStewardRuntimeScopeWorkItemV1({
      schemaVersion: 1,
      operation: value.operation,
      target: value.target,
      cause: value.cause,
    } as unknown as Parameters<typeof buildStewardRuntimeScopeWorkItemV1>[0]))
      .toThrow(RuntimeScopeWorkItemValidationError);
  });
});
