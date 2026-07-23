import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsEnvelope,
  canonicalStewardRuntimeDiagnosticsJson,
  canonicalStewardRuntimeDiagnosticsSnapshotJson,
  parseStewardRuntimeDiagnosticsEnvelope,
  RuntimeDiagnosticsValidationError,
  type StewardRuntimeDiagnosticsEnvelopeV1,
} from '../packages/core/src/runtime-diagnostics.js';

function envelope(): StewardRuntimeDiagnosticsEnvelopeV1 {
  return {
    schemaVersion: 1,
    subject: {
      repositoryId: 123456,
      repositoryFullName: 'splrad/steward-sandbox',
    },
    observedAt: '2026-07-23T10:11:12.345Z',
    diagnostics: {
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: 'version/2026.07.23+candidate',
        workerDeploymentId: 'deployment:019f4f4f-40ad-7471-b40c-9838f254503c',
        environment: 'candidate',
      },
      queue: 'ready',
      control: 'ready',
      deadLetterQueue: 'clear',
    },
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(envelope()) as unknown as Record<string, unknown>;
}

function expectInvalid(value: unknown): void {
  expect(() => parseStewardRuntimeDiagnosticsEnvelope(value))
    .toThrow(RuntimeDiagnosticsValidationError);
}

describe('runtime diagnostics wire protocol', () => {
  it('parses and builds the exact version 1 envelope', () => {
    const value = envelope();
    expect(parseStewardRuntimeDiagnosticsEnvelope(value)).toEqual(value);
    expect(buildStewardRuntimeDiagnosticsEnvelope({
      subject: value.subject,
      observedAt: value.observedAt,
      diagnostics: value.diagnostics,
    })).toEqual(value);
  });

  it('treats printable ASCII worker identifiers as opaque values', () => {
    const base = envelope();
    const value = {
      ...base,
      diagnostics: {
        ...base.diagnostics,
        controlRevision: {
          ...base.diagnostics.controlRevision,
          workerVersionId: 'worker version #1 / "candidate"',
          workerDeploymentId: String.raw`deploy\segment`,
        },
      },
    };
    expect(parseStewardRuntimeDiagnosticsEnvelope(value)).toEqual(value);
  });

  it('writes stable canonical JSON in protocol order', () => {
    const value = envelope();
    expect(canonicalStewardRuntimeDiagnosticsJson(value)).toBe(
      `{"schemaVersion":1,"subject":{"repositoryId":123456,"repositoryFullName":"splrad/steward-sandbox"},"observedAt":"2026-07-23T10:11:12.345Z","diagnostics":{"controlRevision":{"stewardCommit":"${'a'.repeat(40)}","workerVersionId":"version/2026.07.23+candidate","workerDeploymentId":"deployment:019f4f4f-40ad-7471-b40c-9838f254503c","environment":"candidate"},"queue":"ready","control":"ready","deadLetterQueue":"clear"}}`,
    );
  });

  it('excludes only observedAt from the canonical snapshot', () => {
    const first = envelope();
    const second = {
      ...first,
      observedAt: '2026-07-23T10:12:00.000Z',
    };
    expect(canonicalStewardRuntimeDiagnosticsSnapshotJson(first)).toBe(
      canonicalStewardRuntimeDiagnosticsSnapshotJson(second),
    );
    expect(canonicalStewardRuntimeDiagnosticsJson(first)).not.toBe(
      canonicalStewardRuntimeDiagnosticsJson(second),
    );
    expect(canonicalStewardRuntimeDiagnosticsSnapshotJson(first))
      .not.toContain('observedAt');
  });

  it.each([
    null,
    [],
    new Date(),
    Object.create({ schemaVersion: 1 }),
  ])('rejects a non-plain envelope: %s', (value) => {
    expectInvalid(value);
  });

  it.each([
    ['envelope', (value: Record<string, unknown>) => { value.source = 'private-control'; }],
    ['envelope', (value: Record<string, unknown>) => { value.status = 'known'; }],
    ['envelope', (value: Record<string, unknown>) => { value.secret = 'do-not-accept'; }],
    ['subject', (value: Record<string, unknown>) => {
      (value.subject as Record<string, unknown>).owner = 'splrad';
    }],
    ['diagnostics', (value: Record<string, unknown>) => {
      (value.diagnostics as Record<string, unknown>).health = 'ready';
    }],
    ['control revision', (value: Record<string, unknown>) => {
      ((value.diagnostics as Record<string, unknown>).controlRevision as Record<string, unknown>)
        .deployedAt = '2026-07-23T10:00:00.000Z';
    }],
  ])('rejects unknown %s fields', (_subject, mutate) => {
    const value = clone();
    mutate(value);
    expectInvalid(value);
  });

  it.each([
    ['schemaVersion', (value: Record<string, unknown>) => { delete value.schemaVersion; }],
    ['subject.repositoryId', (value: Record<string, unknown>) => {
      delete (value.subject as Record<string, unknown>).repositoryId;
    }],
    ['diagnostics.controlRevision', (value: Record<string, unknown>) => {
      delete (value.diagnostics as Record<string, unknown>).controlRevision;
    }],
    ['controlRevision.workerVersionId', (value: Record<string, unknown>) => {
      delete ((value.diagnostics as Record<string, unknown>).controlRevision as Record<string, unknown>)
        .workerVersionId;
    }],
  ])('rejects missing %s', (_subject, mutate) => {
    const value = clone();
    mutate(value);
    expectInvalid(value);
  });

  it('rejects symbol keys instead of silently ignoring them', () => {
    const value = clone();
    value[Symbol('source') as unknown as string] = 'private-control';
    expectInvalid(value);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123'])(
    'rejects invalid repository ID %s',
    (repositoryId) => {
      const value = clone();
      (value.subject as Record<string, unknown>).repositoryId = repositoryId;
      expectInvalid(value);
    },
  );

  it.each([
    'splrad',
    '/steward',
    'splrad/',
    'spl_rad/steward',
    'splrad/steward/repository',
    'splrad/steward repository',
  ])('rejects non-canonical repository full name %s', (repositoryFullName) => {
    const value = clone();
    (value.subject as Record<string, unknown>).repositoryFullName = repositoryFullName;
    expectInvalid(value);
  });

  it.each([
    '2026-07-23T10:11:12Z',
    '2026-07-23T10:11:12.345+00:00',
    '2026-07-23T10:11:12.3456Z',
    '2026-02-29T10:11:12.345Z',
    '2026-13-23T10:11:12.345Z',
    'not-a-timestamp',
  ])('rejects observedAt that is not canonical Date.toISOString output: %s', (observedAt) => {
    const value = clone();
    value.observedAt = observedAt;
    expectInvalid(value);
  });

  it.each([
    'A'.repeat(40),
    'a'.repeat(39),
    'g'.repeat(40),
    ` ${'a'.repeat(40)}`,
  ])('rejects invalid steward commit %s', (stewardCommit) => {
    const value = clone();
    ((value.diagnostics as Record<string, unknown>).controlRevision as Record<string, unknown>)
      .stewardCommit = stewardCommit;
    expectInvalid(value);
  });

  it.each([
    '',
    ' ',
    ' leading',
    'trailing ',
    'has\nnewline',
    'has\ttab',
    'é',
    'a'.repeat(129),
  ])('rejects non-opaque worker identifiers %s', (identifier) => {
    for (const field of ['workerVersionId', 'workerDeploymentId']) {
      const value = clone();
      ((value.diagnostics as Record<string, unknown>).controlRevision as Record<string, unknown>)[field]
        = identifier;
      expectInvalid(value);
    }
  });

  it.each([
    ['environment', 'staging'],
    ['queue', 'pending'],
    ['control', 'unknown'],
    ['deadLetterQueue', 'ready'],
  ])('rejects unsupported %s enum value', (field, enumValue) => {
    const value = clone();
    const diagnostics = value.diagnostics as Record<string, unknown>;
    if (field === 'environment') {
      (diagnostics.controlRevision as Record<string, unknown>).environment = enumValue;
    } else {
      diagnostics[field] = enumValue;
    }
    expectInvalid(value);
  });

  it('rejects extra builder input instead of stripping it', () => {
    const value = envelope();
    expect(() => buildStewardRuntimeDiagnosticsEnvelope({
      subject: value.subject,
      observedAt: value.observedAt,
      diagnostics: value.diagnostics,
      source: 'private-control',
    } as never)).toThrow(RuntimeDiagnosticsValidationError);
  });
});
