import { expect, it } from 'vitest';
import { allowPullRequestPreparation, planNativeRelease, type NativeReleaseState } from '../src/release-plan.js';
const unit = { id: 'product', enabled: true, adoptedAfterTag: 'v1.0.0', adoptedFromSha: null };
const release: NativeReleaseState = { id: 12, unitId: 'product', tag: 'v1.0.1', sourceSha: 'a'.repeat(40), draft: true, owned: true, verified: false, abandoned: false };
const input = () => ({ enabled: true, units: [unit], releases: [] as NativeReleaseState[], candidates: [] as any[], complete: true });
it('does not prepare a new version while a draft or unverified release exists', () => {
  expect(planNativeRelease({ ...input(), releases: [release] }).mode).toBe('recover');
  expect(planNativeRelease({ ...input(), releases: [{ ...release, draft: false }] }).mode).toBe('verify-only');
  expect(planNativeRelease({ ...input(), enabled: false }).mode).toBe('not-enabled');
});
it('holds open and closed editing candidates', () => {
  for (const closed of [true, false]) expect(planNativeRelease({ ...input(), candidates: [{ number: 1, merged: false, closed, editing: true, mergeSha: null, expectedUnits: ['product'] }] }).mode).toBe('editing');
});
it('repairs missing units after partial release-only output', () => {
  const candidate = { number: 1, merged: true, closed: true, editing: false, mergeSha: release.sourceSha, expectedUnits: ['product', 'other'] };
  expect(planNativeRelease({ ...input(), units: [unit, { ...unit, id: 'other' }], releases: [release], candidates: [candidate] }).mode).toBe('release-only');
});
it.each(['partial', 'unknown', 'unknown-unit', 'duplicate', 'adoption'])('rejects %s observations', change => {
  const value = input();
  if (change === 'partial') value.complete = false;
  if (change === 'unknown') value.releases = [{ ...release, owned: false }];
  if (change === 'unknown-unit') value.releases = [{ ...release, unitId: 'unregistered' }];
  if (change === 'duplicate') value.releases = [release, release];
  if (change === 'adoption') value.units = [{ ...unit, adoptedAfterTag: null as any }];
  expect(() => planNativeRelease(value)).toThrow('RELEASE_PLAN');
});
it('allows PR-only only after a complete empty release-only readback', () => {
  const plan = planNativeRelease(input());
  const result = { complete: true, createdReleaseIds: [], unpublishedDraftIds: [], editing: false, mergedPending: false };
  expect(allowPullRequestPreparation(plan, result)).toBe(true);
  for (const changed of [{ complete: false }, { createdReleaseIds: [1] }, { unpublishedDraftIds: [1] }, { editing: true }, { mergedPending: true }]) {
    expect(allowPullRequestPreparation(plan, { ...result, ...changed })).toBe(false);
  }
});
