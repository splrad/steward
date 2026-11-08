/** Scoped retirement switch; absent preserves the historical runtime contract. */
export interface LegacyReleaseControl { LEGACY_RELEASE_RETIRED?: string }
export function legacyReleaseRetired(env: LegacyReleaseControl): boolean {
  return env.LEGACY_RELEASE_RETIRED === 'true';
}
export function assertLegacyReleaseActive(env: LegacyReleaseControl): void {
  if (legacyReleaseRetired(env)) throw new Error('LEGACY_RELEASE_RETIRED');
}
