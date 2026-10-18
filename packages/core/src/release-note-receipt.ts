import { validatePersonalization, personalizedSections, type FrozenPersonalization } from './release-personalization.js';
import { canonicalBuildManifest, type BuildManifest } from './build-manifest.js';
import { createHash } from 'node:crypto';

export const receiptDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonicalReleaseJson(value: unknown): string {
  const visit = (v: any): any => Array.isArray(v) ? v.map(visit) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, visit(v[k])])) : v;
  return JSON.stringify(visit(value)) + '\n';
}
export const releaseAssert: (condition: unknown, reason: string) => asserts condition = (condition, reason) => {
  if (!condition) throw new Error(`RN_RECEIPT_${reason}`);
};
export const releaseSha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
export const releaseDigest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const positiveId = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export interface ReleaseAssetIdentity { name: string; size: number; sha256: string }
export interface FrozenRelease {
  repositoryId: number; fullName: string; defaultBranch: string; productTargetSha: string; productTree: string;
  policySha: string; targetTag: string; title: string; sourceDigest: string; evidenceDigest: string; templateDigest: string;
  boundary: { kind: 'full-tree' } | { kind: 'tag' | 'baseline'; sha: string; reference: string };
  assets: ReleaseAssetIdentity[];
  build: { runId: number; artifactId: number; artifactName: string; headSha: string } | null;
  toolchainDigest?: string;
  personalization?: FrozenPersonalization;
  manifests: BuildManifest[];
  authorIds: number[]; contributors: { id: number; login: string }[];
  allowedLinks: string[]; compareUrl: string | null;
}
export interface CandidateProjection { schemaVersion: 1; candidateId: string; revision: number; frozenDigest: string; repositoryId: number; targetTag: string; productTargetSha: string; policySha: string }
export interface ReleaseApproval { reviewId: number; actorId: number; headSha: string; notesDigest: string; submittedAt: string }
export interface ReleaseMerge { actorId: number; commitSha: string; mergedAt: string }
export interface ReleaseReceipt {
  schemaVersion: 1; candidateId: string; revision: number; version: number; frozen: FrozenRelease; frozenDigest: string;
  phase: 'prepared' | 'awaiting-review' | 'approved' | 'merged' | 'publishing' | 'verified';
  paused: boolean; error: string | null; branch: string; initialCommitSha: string | null; pullNumber: number | null;
  headSha: string | null; draftNotes: string; approvedNotes: string | null; approval: ReleaseApproval | null; merge: ReleaseMerge | null;
  releaseId: number | null; releaseUrl: string | null; draftTitle: string | null; assetIds: Record<string, number>; downloadedDigests: string[];
  attempts: number; operation: { kind: string; key: string; startedAt: string } | null;
  rebuiltAssets?: { build: NonNullable<FrozenRelease['build']>; toolchainDigest: string; recordedAt: string }[];
  assetRecoveryPending?: boolean;
  rebuildRequestKey?: string;
  candidateBase?: { sha: string; tree: string };
}
export function validateFrozenRelease(f: FrozenRelease): void {
  releaseAssert(f && positiveId(f.repositoryId) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(f.fullName), 'REPOSITORY');
  if (f.personalization) validatePersonalization(f.personalization, f.repositoryId, f.fullName);
  releaseAssert(f.defaultBranch && !/[\x00-\x20]/.test(f.defaultBranch), 'BRANCH');
  releaseAssert([f.productTargetSha, f.productTree, f.policySha, ...(f.build ? [f.build.headSha] : [])].every(releaseSha), 'SHA');
  releaseAssert(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(f.targetTag), 'TAG');
  releaseAssert(typeof f.title === 'string' && f.title.length > 0 && f.title.length <= 200 && !/[\r\n<>]/.test(f.title), 'TITLE');
  releaseAssert([f.sourceDigest, f.evidenceDigest, f.templateDigest].every(releaseDigest), 'DIGEST');
  releaseAssert(Array.isArray(f.assets) && f.assets.length <= 128 && new Set(f.assets.map(a => a.name.toLowerCase())).size === f.assets.length, 'ASSETS');
  for (const asset of f.assets) releaseAssert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(asset.name) && positiveId(asset.size) && asset.size <= 1024 ** 3 && releaseDigest(asset.sha256), 'ASSET');
  releaseAssert(f.build === null ? f.assets.length === 0 : positiveId(f.build.runId) && positiveId(f.build.artifactId) && /^[A-Za-z0-9._-]{1,200}$/.test(f.build.artifactName) && f.build.headSha === f.policySha, 'BUILD');
  releaseAssert(f.toolchainDigest === undefined || releaseDigest(f.toolchainDigest), 'TOOLCHAIN');
  releaseAssert(Array.isArray(f.manifests) && new Set(f.manifests.map(m => m.buildId)).size === f.manifests.length, 'MANIFESTS');
  const assets: ReleaseAssetIdentity[] = [];
  for (const manifest of f.manifests) {
    canonicalBuildManifest(manifest);
    releaseAssert(manifest.repositoryId === f.repositoryId && manifest.fullName === f.fullName && manifest.targetSha === f.productTargetSha && manifest.policySha === f.policySha && manifest.version === f.targetTag.slice(1), 'MANIFEST_IDENTITY');
    for (const asset of manifest.artifacts) { releaseAssert(asset.kind === 'file', 'MANIFEST_FILE'); assets.push({ name: asset.file, size: asset.size, sha256: asset.sha256 }); }
  }
  const byName = (a: ReleaseAssetIdentity, b: ReleaseAssetIdentity) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  releaseAssert(canonicalReleaseJson(assets.sort(byName)) === canonicalReleaseJson([...f.assets].sort(byName)), 'MANIFEST_ASSETS');
  releaseAssert(Array.isArray(f.authorIds) && f.authorIds.length > 0 && f.authorIds.every(positiveId) && new Set(f.authorIds).size === f.authorIds.length, 'AUTHORS');
  releaseAssert(Array.isArray(f.contributors) && f.contributors.length <= 200 && f.contributors.every(c => positiveId(c.id) && /^[A-Za-z0-9-]{1,39}$/.test(c.login)) && new Set(f.contributors.map(c => c.id)).size === f.contributors.length, 'CONTRIBUTORS');
  releaseAssert(Array.isArray(f.allowedLinks) && f.allowedLinks.length <= 256 && f.allowedLinks.every(link => {
    try { const u = new URL(link); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !/[\s<>"\\]/.test(link); } catch { return false; }
  }), 'LINKS');
  releaseAssert(f.boundary && (f.boundary.kind === 'full-tree' || (['tag', 'baseline'].includes(f.boundary.kind) && releaseSha(f.boundary.sha) && typeof f.boundary.reference === 'string' && f.boundary.reference.length > 0)), 'BOUNDARY');
  releaseAssert(f.compareUrl === null || (f.allowedLinks.includes(f.compareUrl) && f.compareUrl.startsWith(`https://github.com/${f.fullName}/compare/`)), 'COMPARE');
}
export function candidateProjection(r: ReleaseReceipt): CandidateProjection {
  return { schemaVersion: 1, candidateId: r.candidateId, revision: r.revision, frozenDigest: r.frozenDigest,
    repositoryId: r.frozen.repositoryId, targetTag: r.frozen.targetTag, productTargetSha: r.frozen.productTargetSha, policySha: r.frozen.policySha };
}
export function candidatePaths(r: ReleaseReceipt): [string, string] {
  const dir = `.release-notes/candidates/${r.frozen.targetTag}/`;
  return [dir + 'candidate.json', dir + 'release-notes.zh-CN.md'];
}
export function contributorMarkdown(f: FrozenRelease): string {
  const people = f.contributors.filter(c => !f.authorIds.includes(c.id)).sort((a, b) => a.id - b.id);
  return people.length ? '## 贡献者\n\n' + people.map(c => `<a href="https://github.com/${c.login}"><img src="https://avatars.githubusercontent.com/u/${c.id}?s=40" alt="${c.login} 的 GitHub 头像" width="40" height="40"></a>`).join(' ') + '\n\n' : '';
}
/** Direct Markdown editing is supported; the protected projection and trusted links remain fixed. */
export function validateCandidateNotes(notes: string, f: FrozenRelease): void {
  validateFrozenRelease(f);
  releaseAssert(typeof notes === 'string' && Buffer.byteLength(notes) <= 128 * 1024 && !notes.includes('\r') && notes.endsWith('\n') && !/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]/u.test(notes), 'NOTES_BYTES');
  releaseAssert(notes.startsWith(`# ${f.title}\n\n`), 'NOTES_TITLE');
  releaseAssert(notes.split(/^## [^\n]+\n/gm).slice(1).every(section => section.trim().length > 0), 'NOTES_EMPTY_SECTION');
  const headings = [...notes.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  const contributor = contributorMarkdown(f);
  releaseAssert(JSON.stringify(headings) === JSON.stringify(['升级须知', '更新内容', ...(contributor ? ['贡献者'] : []), '完整变更']), 'NOTES_HEADINGS');
  let stripped = contributor ? notes.replace(contributor, '') : notes;
  const personal = personalizedSections(f);
  for (const section of personal) {
    releaseAssert(stripped.split(section.markdown).length === 2, 'PERSONALIZATION_BYTES');
    const start = notes.indexOf(section.markdown), boundary = notes.indexOf('## 更新内容\n');
    releaseAssert(section.slot === 'beforeActions' ? start > notes.indexOf('## 升级须知\n') && start < boundary : start > boundary && start < notes.indexOf('## 完整变更\n'), 'PERSONALIZATION_SLOT');
    stripped = stripped.replace(section.markdown, '');
  }
  releaseAssert(!contributor || notes.includes(contributor), 'CONTRIBUTOR_BYTES');
  releaseAssert(!/<[A-Za-z/!]|!\[|\]\s*\[|^\s*\[[^\]]+\]:/m.test(stripped), 'NOTES_EMBED');
  const links = [...stripped.matchAll(/https?:\/\/[^\s)<>"']+/g)].map(m => m[0]);
  releaseAssert(links.every(link => f.allowedLinks.includes(link)) && !/\]\((?!https:\/\/)/.test(stripped), 'NOTES_LINK');
  const categories = [...stripped.matchAll(/^### (.+)$/gm)].map(m => m[1]!);
  const order = ['安全', '移除', '即将停用', '新增', '变更', '修复'];
  releaseAssert(categories.every((c, i) => order.includes(c) && (i === 0 || order.indexOf(c) > order.indexOf(categories[i - 1]!))), 'NOTES_CATEGORIES');
  releaseAssert(f.compareUrl ? notes.includes(`](${f.compareUrl})`) : notes.includes('首次发布'), 'NOTES_RANGE');
}
export function newReleaseReceipt(frozen: FrozenRelease, draftNotes: string, revision = 1): ReleaseReceipt {
  validateFrozenRelease(frozen); validateCandidateNotes(draftNotes, frozen);
  releaseAssert(positiveId(revision), 'REVISION');
  const candidateId = receiptDigest(`${frozen.repositoryId}:${frozen.targetTag}`);
  return { schemaVersion: 1, candidateId, revision, version: 0, frozen: structuredClone(frozen), frozenDigest: receiptDigest(canonicalReleaseJson(frozen)),
    phase: 'prepared', paused: false, error: null, branch: `steward/release-notes/${frozen.targetTag}-r${revision}`, initialCommitSha: null,
    pullNumber: null, headSha: null, draftNotes, approvedNotes: null, approval: null, merge: null, releaseId: null, releaseUrl: null, draftTitle: null, assetIds: {}, downloadedDigests: [], attempts: 0, operation: null };
}
export interface CandidateReviewFacts {
  headSha: string; notes: string; projection: string; files: string[]; closed: boolean; merged: boolean;
  checksPassed: boolean; reviews: { id: number; actorId: number; type: string; permission: string; headSha: string; state: string; submittedAt: string }[];
  merge: ReleaseMerge | null; manualMerge: boolean; productTreeUnchanged: boolean;
}
export function reviewReleaseReceipt(receipt: ReleaseReceipt, facts: CandidateReviewFacts): ReleaseReceipt {
  const r = structuredClone(receipt);
  releaseAssert(!['publishing', 'verified'].includes(r.phase), 'SEALED');
  releaseAssert(releaseSha(facts.headSha) && facts.projection === canonicalReleaseJson(candidateProjection(r)), 'PROJECTION');
  releaseAssert(JSON.stringify([...facts.files].sort()) === JSON.stringify(candidatePaths(r).sort()), 'FILE_SCOPE');
  validateCandidateNotes(facts.notes, r.frozen);
  r.headSha = facts.headSha; r.approval = null; r.approvedNotes = null; r.merge = null;
  r.phase = 'awaiting-review'; r.paused = facts.closed && !facts.merged;
  r.error = r.paused ? 'candidate-closed' : null;
  if (r.paused || !facts.checksPassed || !facts.productTreeUnchanged) { r.error ??= 'checks-or-product-drift'; return r; }
  const latest = new Map<number, CandidateReviewFacts['reviews'][number]>();
  for (const review of [...facts.reviews].sort((a, b) => a.id - b.id)) {
    releaseAssert(positiveId(review.id) && positiveId(review.actorId) && Number.isFinite(Date.parse(review.submittedAt)), 'REVIEW_IDENTITY');
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.actorId, review);
  }
  if ([...latest.values()].some(v => v.state === 'CHANGES_REQUESTED')) { r.error = 'changes-requested'; return r; }
  const approval = [...latest.values()].find(v => v.state === 'APPROVED' && v.type === 'User' && ['write', 'maintain', 'admin'].includes(v.permission) && v.headSha === facts.headSha);
  if (!approval) { r.error = 'current-human-approval-required'; return r; }
  r.approvedNotes = facts.notes;
  r.approval = { reviewId: approval.id, actorId: approval.actorId, headSha: facts.headSha, notesDigest: receiptDigest(facts.notes), submittedAt: approval.submittedAt };
  r.phase = 'approved'; r.error = null;
  if (facts.merged) {
    releaseAssert(facts.manualMerge && facts.merge && positiveId(facts.merge.actorId) && releaseSha(facts.merge.commitSha)
      && Number.isFinite(Date.parse(facts.merge.mergedAt)) && Date.parse(facts.merge.mergedAt) >= Date.parse(approval.submittedAt), 'MANUAL_MERGE');
    r.merge = facts.merge; r.phase = 'merged';
  }
  return r;
}
export function assertReleasePermit(r: ReleaseReceipt): void {
  releaseAssert(!r.paused && ['merged', 'publishing'].includes(r.phase) && r.approval && r.merge && r.approvedNotes !== null, 'NOT_APPROVED_AND_MERGED');
  releaseAssert(r.approval.headSha === r.headSha && r.approval.notesDigest === receiptDigest(r.approvedNotes!) && r.frozenDigest === receiptDigest(canonicalReleaseJson(r.frozen)), 'SEALED_IDENTITY');
}
