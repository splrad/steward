import { describe, expect, it } from 'vitest';
import {
  assertFreshDeliveryRecoveryCommand,
  canonicalDeliveryRecoveryCommandJson,
  canonicalRecoverGitHubScanIdentityJson,
  parseDeliveryRecoveryCommand,
} from '../packages/recovery/src/contracts.js';

const requestId = '98a95cc4-2f19-4fc8-a6f2-11e1774bb741';
const requestedAt = '2026-07-27T12:00:00.000Z';
const revision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-27T11:59:00.000Z',
};

describe('delivery recovery operator command protocol', () => {
  it('parses and canonicalizes the exact inspect command', () => {
    const command = {
      schemaVersion: 1,
      operation: 'inspect',
      requestId,
      requestedAt,
    } as const;
    expect(parseDeliveryRecoveryCommand(command)).toEqual(command);
    expect(canonicalDeliveryRecoveryCommandJson(command)).toBe(
      `{"schemaVersion":1,"operation":"inspect","requestId":"${requestId}",`
      + `"requestedAt":"${requestedAt}"}`,
    );
  });

  it('sorts an explicit replay selection and rejects broad or duplicate replay', () => {
    const second = 'b'.repeat(64);
    const first = 'a'.repeat(64);
    const parsed = parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      operation: 'replay-dlq',
      requestId,
      requestedAt,
      expectedLedgerRevision: 'c'.repeat(64),
      entryIds: [second, first],
    });
    expect(parsed.operation).toBe('replay-dlq');
    if (parsed.operation !== 'replay-dlq') throw new Error('Unexpected command.');
    expect(parsed.entryIds).toEqual([first, second]);
    expect(() => parseDeliveryRecoveryCommand({
      ...parsed,
      entryIds: [first, first],
    })).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      ...parsed,
      entryIds: [],
    })).toThrow();
  });

  it('binds GitHub recovery to an exact immutable Control revision', () => {
    const command = {
      schemaVersion: 1,
      operation: 'recover-github',
      requestId,
      requestedAt,
      expectedControlRevision: revision,
      coverageMode: 'continue',
      takeover: false,
    } as const;
    expect(parseDeliveryRecoveryCommand(command)).toEqual(command);
    expect(() => parseDeliveryRecoveryCommand({
      ...command,
      expectedControlRevision: {
        ...revision,
        stewardCommit: revision.stewardCommit.toUpperCase(),
      },
    })).toThrow();
  });

  it('keeps scan identity stable across fresh timestamps and binds recovery mode', () => {
    const command = {
      schemaVersion: 1,
      operation: 'recover-github',
      requestId,
      requestedAt,
      expectedControlRevision: revision,
      coverageMode: 'continue',
      takeover: false,
    } as const;
    const refreshed = {
      ...command,
      requestedAt: '2026-07-27T12:04:00.000Z',
    } as const;
    const identity = canonicalRecoverGitHubScanIdentityJson(command);

    expect(canonicalRecoverGitHubScanIdentityJson(refreshed)).toBe(identity);
    expect(identity).toBe(
      `{"schemaVersion":1,"operation":"recover-github",`
      + `"requestId":"${requestId}","expectedControlRevision":`
      + `{"stewardCommit":"${revision.stewardCommit}",`
      + `"workerVersionId":"${revision.workerVersionId}",`
      + `"workerVersionTag":"${revision.workerVersionTag}",`
      + `"workerVersionCreatedAt":"${revision.workerVersionCreatedAt}"},`
      + '"coverageMode":"continue","takeover":false}',
    );
    expect(canonicalDeliveryRecoveryCommandJson(refreshed)).toContain(
      '"requestedAt":"2026-07-27T12:04:00.000Z"',
    );
    expect(canonicalDeliveryRecoveryCommandJson(refreshed)).not.toBe(
      canonicalDeliveryRecoveryCommandJson(command),
    );
    expect(canonicalRecoverGitHubScanIdentityJson({
      ...command,
      coverageMode: 'establish',
    })).not.toBe(identity);
    expect(canonicalRecoverGitHubScanIdentityJson({
      ...command,
      takeover: true,
    })).not.toBe(identity);
  });

  it('requires exact GitHub coverage and takeover fields', () => {
    const command = {
      schemaVersion: 1,
      operation: 'recover-github',
      requestId,
      requestedAt,
      expectedControlRevision: revision,
      coverageMode: 'continue',
      takeover: false,
    } as const;
    const { coverageMode: _coverageMode, ...withoutCoverageMode } = command;
    const { takeover: _takeover, ...withoutTakeover } = command;

    expect(() => parseDeliveryRecoveryCommand(withoutCoverageMode)).toThrow();
    expect(() => parseDeliveryRecoveryCommand(withoutTakeover)).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      ...command,
      coverageMode: 'resume',
    })).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      ...command,
      takeover: 0,
    })).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      ...command,
      force: true,
    })).toThrow();
  });

  it('rejects extra fields, noncanonical timestamps, stale commands, and malformed IDs', () => {
    expect(() => parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      operation: 'inspect',
      requestId,
      requestedAt,
      replayAll: true,
    })).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      operation: 'inspect',
      requestId: 'not-a-command-id',
      requestedAt,
    })).toThrow();
    expect(() => parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      operation: 'inspect',
      requestId,
      requestedAt: '2026-07-27T12:00:00Z',
    })).toThrow();
    const parsed = parseDeliveryRecoveryCommand({
      schemaVersion: 1,
      operation: 'inspect',
      requestId,
      requestedAt,
    });
    expect(() => assertFreshDeliveryRecoveryCommand(
      parsed,
      new Date('2026-07-27T12:05:00.001Z'),
    )).toThrow();
    expect(() => assertFreshDeliveryRecoveryCommand(
      parsed,
      new Date('2026-07-27T12:04:59.999Z'),
    )).not.toThrow();
  });
});
