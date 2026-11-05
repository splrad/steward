import { receiptDigest, type FrozenRelease } from '../src/release-note-receipt.js';

export const sha = (letter: string) => letter.repeat(40);
export function frozenFixture(): FrozenRelease {
  return { repositoryId: 9001, fullName: 'sample/neutral-product', defaultBranch: 'trunk', productTargetSha: sha('a'), productTree: sha('b'), policySha: sha('c'),
    targetTag: 'v1.2.3', title: 'Neutral 1.2.3', sourceDigest: receiptDigest('source'), evidenceDigest: receiptDigest('evidence'), templateDigest: receiptDigest('historical-template-fixture'),
    boundary: { kind: 'full-tree' }, assets: [], manifests: [], build: null, authorIds: [1], contributors: [], allowedLinks: [], compareUrl: null };
}
