// Native protection was reconciled for these exact default-branch consumers.
// Unknown installations, renamed repositories and changed defaults retain the
// historical writer until their own handoff; this is not organization-wide.
const retiredDefaults: Readonly<Record<number, readonly [string, string]>> = {
  1187527897: ['splrad/LayerScape', 'main'],
  1296724484: ['splrad/steward', 'main'],
  1296725317: ['splrad/.github', 'main'],
  1440689456: ['splrad/steward-e08-controller', 'e08-channel-trunk'],
  1440689534: ['splrad/steward-e08-product', 'main'],
  1440689606: ['splrad/steward-e08-bootstrap', 'main'],
  1447987054: ['splrad/steward-settings', 'main'],
  1448797077: ['splrad/steward-e10-lifecycle-20261107', 'main'],
};

export function legacyValidationRetired(
  env: { LEGACY_VALIDATION_RETIRED?: string },
  repository: { id?: unknown; full_name?: unknown; default_branch?: unknown },
  targetBranch: unknown,
): boolean {
  if (env.LEGACY_VALIDATION_RETIRED !== 'true' || !Number.isSafeInteger(repository.id)) return false;
  const target = retiredDefaults[repository.id as number];
  return target !== undefined && repository.full_name === target[0]
    && repository.default_branch === target[1] && targetBranch === target[1];
}
