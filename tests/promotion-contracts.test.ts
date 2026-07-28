import { describe, expect, it } from 'vitest';
import {
  assertFreshRuntimePromotionCommand,
  assertFreshRuntimePromotionResolution,
  desiredRuntimePromotionDeployment,
  parseRuntimePromotionCommand,
  parseRuntimePromotionUnknownResolution,
  runtimePromotionWorkers,
  sameRuntimePromotionTraffic,
} from '../packages/promotion/src/contracts.js';

const now = new Date('2026-07-28T06:00:00.000Z');
const stableVersionId = '10000000-0000-4000-8000-000000000001';
const candidateVersionId = '20000000-0000-4000-8000-000000000002';

function command(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    commandId: '30000000-0000-4000-8000-000000000003',
    requestedAt: now.toISOString(),
    operation: 'promote',
    worker: 'steward-control',
    expectedDeploymentId: '40000000-0000-4000-8000-000000000004',
    stableVersionId,
    candidateVersionId,
    stewardCommit: 'a'.repeat(40),
    candidatePercentage: 25,
    ...overrides,
  };
}

describe('runtime promotion command contract', () => {
  it('is exact, fresh, and fixed to the runtime Worker allowlist', () => {
    const parsed = parseRuntimePromotionCommand(command());
    expect(parsed).toEqual(command());
    expect(() => assertFreshRuntimePromotionCommand(parsed, now)).not.toThrow();
    for (const worker of runtimePromotionWorkers) {
      expect(parseRuntimePromotionCommand({
        ...command(),
        worker,
      }).worker).toBe(worker);
    }

    for (const worker of ['steward-promotion', 'arbitrary-script']) {
      expect(() => parseRuntimePromotionCommand({
        ...command(),
        worker,
      })).toThrow(/worker must be one of/);
    }
    expect(() => parseRuntimePromotionCommand({
      ...command(),
      force: true,
    })).toThrow(/unsupported or missing fields/);
    expect(() => assertFreshRuntimePromotionCommand(
      parsed,
      new Date(now.getTime() + 300_001),
    )).toThrow(/freshness window/);
  });

  it('builds stage, gradual promotion, canary stop, and rollback traffic', () => {
    expect(desiredRuntimePromotionDeployment(parseRuntimePromotionCommand(
      command({ operation: 'stage', candidatePercentage: 0 }),
    )).versions).toEqual([
      { versionId: stableVersionId, percentage: 100 },
      { versionId: candidateVersionId, percentage: 0 },
    ].sort((left, right) => left.versionId.localeCompare(right.versionId)));

    expect(desiredRuntimePromotionDeployment(parseRuntimePromotionCommand(
      command(),
    )).versions).toEqual([
      { versionId: stableVersionId, percentage: 75 },
      { versionId: candidateVersionId, percentage: 25 },
    ].sort((left, right) => left.versionId.localeCompare(right.versionId)));

    expect(desiredRuntimePromotionDeployment(parseRuntimePromotionCommand(
      command({ operation: 'canary-stop', candidatePercentage: 0 }),
    )).versions).toEqual([
      { versionId: stableVersionId, percentage: 100 },
      { versionId: candidateVersionId, percentage: 0 },
    ].sort((left, right) => left.versionId.localeCompare(right.versionId)));

    expect(desiredRuntimePromotionDeployment(parseRuntimePromotionCommand(
      command({ operation: 'rollback', candidatePercentage: 0 }),
    )).versions).toEqual([
      { versionId: stableVersionId, percentage: 100 },
    ]);
  });

  it('defines same-version promotion as a single-version traffic no-op', () => {
    const parsed = parseRuntimePromotionCommand(command({
      candidateVersionId: stableVersionId,
    }));
    const desired = desiredRuntimePromotionDeployment(parsed);
    expect(desired.versions).toEqual([
      { versionId: stableVersionId, percentage: 100 },
    ]);
    expect(sameRuntimePromotionTraffic(
      {
        id: '50000000-0000-4000-8000-000000000005',
        versions: [{ versionId: stableVersionId, percentage: 100 }],
      },
      desired,
    )).toBe(true);
  });

  it('rejects non-canonical identifiers and unsafe percentages', () => {
    expect(() => parseRuntimePromotionCommand(command({
      candidateVersionId: 'latest',
    }))).toThrow(/lowercase UUID/);
    expect(() => parseRuntimePromotionCommand(command({
      stewardCommit: 'A'.repeat(40),
    }))).toThrow(/lowercase 40-character commit SHA/);
    expect(() => parseRuntimePromotionCommand(command({
      candidatePercentage: 0,
    }))).toThrow(/positive candidatePercentage/);
    expect(() => parseRuntimePromotionCommand(command({
      operation: 'rollback',
      candidatePercentage: 1,
    }))).toThrow(/rollback requires candidatePercentage 0/);
  });

  it('strictly binds fresh unknown resolution evidence to the original Worker and deployment', () => {
    const expectedBefore = {
      id: '40000000-0000-4000-8000-000000000004',
      versions: [
        { versionId: stableVersionId, percentage: 75 },
        { versionId: candidateVersionId, percentage: 25 },
      ],
    };
    const resolution = parseRuntimePromotionUnknownResolution({
      schemaVersion: 1,
      requestedAt: now.toISOString(),
      operation: 'abandon',
      commandId: '30000000-0000-4000-8000-000000000003',
      worker: 'steward-control',
      expectedBefore,
    });
    expect(() =>
      assertFreshRuntimePromotionResolution(resolution, now)
    ).not.toThrow();
    expect(resolution.expectedBefore.versions).toEqual(
      [...expectedBefore.versions].sort(
        (left, right) => left.versionId.localeCompare(right.versionId),
      ),
    );
    expect(() => parseRuntimePromotionUnknownResolution({
      ...resolution,
      expectedBefore: { ...expectedBefore, force: true },
    })).toThrow(/unsupported or missing fields/);
    expect(() => parseRuntimePromotionUnknownResolution({
      ...resolution,
      worker: 'steward-promotion',
    })).toThrow(/worker must be one of/);
  });

  it('preserves the stable Version at zero percent for full candidate promotion', () => {
    expect(desiredRuntimePromotionDeployment(parseRuntimePromotionCommand(
      command({ candidatePercentage: 100 }),
    )).versions).toEqual([
      { versionId: stableVersionId, percentage: 0 },
      { versionId: candidateVersionId, percentage: 100 },
    ].sort((left, right) => left.versionId.localeCompare(right.versionId)));
  });
});
