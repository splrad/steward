import { receiptDigest, canonicalReleaseJson, newReleaseReceipt, candidateProjection, candidatePaths, type FrozenRelease, type CandidateReviewFacts } from '../src/release-note-receipt.js';
import profile from '../../../config/profiles/release-notes/common-v3.json' with { type: 'json' };

export const sha = (letter: string) => letter.repeat(40);
export function frozenFixture(): FrozenRelease {
  return { repositoryId: 9001, fullName: 'sample/neutral-product', defaultBranch: 'trunk', productTargetSha: sha('a'), productTree: sha('b'), policySha: sha('c'),
    targetTag: 'v1.2.3', title: 'Neutral 1.2.3', sourceDigest: receiptDigest('source'), evidenceDigest: receiptDigest('evidence'), templateDigest: receiptDigest(canonicalReleaseJson(profile)),
    boundary: { kind: 'full-tree' }, assets: [], manifests: [], build: null, authorIds: [1], contributors: [], allowedLinks: [], compareUrl: null };
}
export const notesFixture = '# Neutral 1.2.3\n\n## 升级须知\n\n无需额外操作。\n\n## 更新内容\n\n### 修复\n\n修复导入失败。\n\n## 完整变更\n\n首次发布，范围为目标完整树。\n';
export function receiptFixture() { return newReleaseReceipt(frozenFixture(), notesFixture); }
export function factsFixture(): CandidateReviewFacts {
  const r = receiptFixture();
  return { headSha: sha('d'), notes: notesFixture, projection: canonicalReleaseJson(candidateProjection(r)), files: candidatePaths(r), closed: false, merged: false, checksPassed: true,
    reviews: [{ id: 10, actorId: 2, type: 'User', permission: 'write', headSha: sha('d'), state: 'APPROVED', submittedAt: '2026-10-18T00:00:00Z' }],
    merge: null, manualMerge: false, productTreeUnchanged: true };
}
