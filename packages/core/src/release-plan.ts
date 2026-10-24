export interface PlannedUnit { id: string; enabled: boolean; adoptedAfterTag: string | null; adoptedFromSha: string | null }
export interface NativeReleaseState {
  id: number; unitId: string; tag: string; sourceSha: string; draft: boolean;
  owned: boolean; verified: boolean; abandoned: boolean;
}
export interface NativeCandidateState {
  number: number; merged: boolean; closed: boolean; editing: boolean;
  mergeSha: string | null; expectedUnits: string[];
}
export type ReleasePlan = { mode: 'not-enabled' | 'editing' | 'release-only' | 'pull-request-only' | 'recover' | 'verify-only'; releases: NativeReleaseState[] };
/** Decide only from complete native-object observations; no separate task ledger. */
export function planNativeRelease(input: {
  enabled: boolean; units: PlannedUnit[]; releases: NativeReleaseState[]; candidates: NativeCandidateState[]; complete: boolean;
}): ReleasePlan {
  if (!input.complete) throw new Error('RELEASE_PLAN_INCOMPLETE');
  const enabled = input.units.filter(unit => unit.enabled);
  if (!input.enabled || !enabled.length) return { mode: 'not-enabled', releases: [] };
  if (new Set(enabled.map(unit => unit.id)).size !== enabled.length
    || enabled.some(unit => Boolean(unit.adoptedAfterTag) === Boolean(unit.adoptedFromSha))) throw new Error('RELEASE_PLAN_ADOPTION');
  if (input.releases.some(release => release.draft && (!release.owned || !input.units.some(unit => unit.id === release.unitId)))) throw new Error('RELEASE_PLAN_UNKNOWN_ORIGIN');
  const releases = input.releases.filter(release => enabled.some(unit => unit.id === release.unitId));
  if (releases.some(release => !release.owned || !Number.isSafeInteger(release.id) || release.id <= 0 || !/^[a-f0-9]{40}$/.test(release.sourceSha))) throw new Error('RELEASE_PLAN_UNKNOWN_ORIGIN');
  if (new Set(releases.map(release => release.id)).size !== releases.length
    || new Set(releases.map(release => release.tag)).size !== releases.length) throw new Error('RELEASE_PLAN_DUPLICATE');
  const published = releases.filter(release => !release.draft && !release.verified);
  if (published.length) return { mode: 'verify-only', releases: published };
  const drafts = releases.filter(release => release.draft && !release.abandoned);
  // Repair the other units of the same merged candidate before dispatching builds.
  const incomplete = input.candidates.filter(candidate => candidate.merged && candidate.mergeSha
    && candidate.expectedUnits.some(id => enabled.some(unit => unit.id === id)
      && !releases.some(release => release.unitId === id && release.sourceSha === candidate.mergeSha)));
  if (incomplete.length > 1) throw new Error('RELEASE_PLAN_AMBIGUOUS_MERGED_CANDIDATES');
  if (incomplete.length) return { mode: 'release-only', releases: drafts };
  if (drafts.length) return { mode: 'recover', releases: drafts };
  if (input.candidates.some(candidate => !candidate.merged && candidate.editing)) return { mode: 'editing', releases: [] };
  // The workflow runs release-only before PR-only even if the previous call lost output.
  return { mode: 'release-only', releases: [] };
}

export function allowPullRequestPreparation(plan: ReleasePlan, releaseOnlyResult: {
  complete: boolean; createdReleaseIds: number[]; unpublishedDraftIds: number[]; editing: boolean; mergedPending: boolean;
}): boolean {
  return plan.mode === 'release-only' && releaseOnlyResult.complete && !releaseOnlyResult.editing && !releaseOnlyResult.mergedPending
    && releaseOnlyResult.createdReleaseIds.length === 0 && releaseOnlyResult.unpublishedDraftIds.length === 0;
}
