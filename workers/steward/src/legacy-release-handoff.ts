export interface LegacyReleaseHandoffEnv {
  LEGACY_RELEASE_HANDOFF_IDS?: string;
}
export const legacyReleaseHandoffReason = 'LEGACY_RELEASE_HANDOFF';

/** Temporary release-writer fence. Remove after the legacy handlers are retired. */
export function legacyReleaseHandoff(env: LegacyReleaseHandoffEnv, repositoryId: number): boolean {
  const policy = env.LEGACY_RELEASE_HANDOFF_IDS;
  if (policy === undefined || policy === '[]') return false;
  let ids: unknown;
  try { ids = JSON.parse(policy); }
  catch { throw Error('LEGACY_RELEASE_HANDOFF_IDS'); }
  if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0) ||
      new Set(ids).size !== ids.length) throw Error('LEGACY_RELEASE_HANDOFF_IDS');
  return ids.includes(repositoryId);
}
