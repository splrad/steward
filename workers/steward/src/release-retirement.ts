const retiredWorkflows = new Set(['release.yml', 'release-build.yml', 'release-build-complete.yml']);

export function assertLegacyReleaseDispatchActive(workflow: string): void {
  if (retiredWorkflows.has(workflow)) throw new Error('LEGACY_RELEASE_RETIRED');
}
