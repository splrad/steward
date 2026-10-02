import { evaluateRequirement, fragmentIdFromPath, parseFragment, validateFragmentRequirement,
  type FragmentClassification, type FragmentPathChange, type FragmentProfile } from './release-note-fragment.js';

export interface FragmentValidationIdentity { repositoryId: number; pullRequestNumber: number; baseSha: string; headSha: string; policySha: string }
export class FragmentValidationError extends Error {
  constructor(public readonly code: 'RN_SOURCE_INCOMPLETE' | 'RN_SOURCE_STALE' | 'RN_FRAGMENT_LIFECYCLE', detail: string) {
    super(`${code}: ${detail}`);
  }
}
export function assertFragmentIdentity(expected: FragmentValidationIdentity, actual: FragmentValidationIdentity): void {
  if (![expected.repositoryId, expected.pullRequestNumber].every(value => Number.isSafeInteger(value) && value > 0)
    || ![expected.baseSha, expected.headSha, expected.policySha].every(value => /^[a-f0-9]{40}$/.test(value))) {
    throw new FragmentValidationError('RN_SOURCE_INCOMPLETE', 'validation identity');
  }
  for (const key of ['repositoryId', 'pullRequestNumber', 'baseSha', 'headSha', 'policySha'] as const) {
    if (expected[key] !== actual[key]) throw new FragmentValidationError('RN_SOURCE_STALE', key);
  }
}
export function validatePullRequestFragments(input: {
  identity: FragmentValidationIdentity; changes: readonly FragmentPathChange[]; expectedFileCount: number;
  profile: FragmentProfile; classification: FragmentClassification | null;
  fragments: readonly { path: string; bytes: Uint8Array; existsInBase: boolean }[];
}) {
  assertFragmentIdentity(input.identity, input.identity);
  if (!Number.isSafeInteger(input.expectedFileCount) || input.expectedFileCount < 0 || input.expectedFileCount > 3000
    || input.changes.length !== input.expectedFileCount || new Set(input.changes.map(change => change.path)).size !== input.changes.length) {
    throw new FragmentValidationError('RN_SOURCE_INCOMPLETE', 'PR files');
  }
  const decision = evaluateRequirement(input.changes, input.classification, input.profile);
  const inside = (path: string) => path === input.profile.fragmentDirectory || path.startsWith(`${input.profile.fragmentDirectory}/`);
  const touched = input.changes.filter(change => inside(change.path) || (change.status === 'renamed' && inside(change.previousPath)));
  if (touched.some(change => change.status !== 'added') || touched.length > 1) {
    throw new FragmentValidationError('RN_FRAGMENT_LIFECYCLE', 'only one new fragment is allowed; historical fragments are immutable');
  }
  if (input.fragments.length !== touched.length || input.fragments.some((fragment, index) => fragment.path !== touched[index]?.path)) {
    throw new FragmentValidationError('RN_SOURCE_INCOMPLETE', 'fragment bytes');
  }
  const source = input.fragments[0];
  if (source?.existsInBase) throw new FragmentValidationError('RN_FRAGMENT_LIFECYCLE', 'fragment exists in base');
  if (source) fragmentIdFromPath(source.path, input.profile.fragmentDirectory);
  const fragment = source ? parseFragment(source.bytes) : null;
  validateFragmentRequirement(fragment, decision, input.classification);
  return { identity: { ...input.identity }, decision, fragment };
}
