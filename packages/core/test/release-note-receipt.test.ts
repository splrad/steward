import { describe, expect, it } from 'vitest';
import { assertReleasePermit, candidateProjection, canonicalReleaseJson, contributorMarkdown, newReleaseReceipt, reviewReleaseReceipt, validateCandidateNotes } from '../src/release-note-receipt.js';
import { factsFixture, frozenFixture, notesFixture, receiptFixture, sha } from './release-receipt-fixture.js';

describe('release receipt authority', () => {
  it('approval seals exact bytes but cannot publish before a human merge', () => {
    const r = reviewReleaseReceipt(receiptFixture(), factsFixture());
    expect(r.phase).toBe('approved'); expect(r.approvedNotes).toBe(notesFixture);
    expect(() => assertReleasePermit(r)).toThrow('NOT_APPROVED_AND_MERGED');
    const merged = reviewReleaseReceipt(r, { ...factsFixture(), merged: true, closed: true, manualMerge: true, merge: { actorId: 3, commitSha: sha('e'), mergedAt: '2026-10-18T00:01:00Z' } });
    expect(merged.phase).toBe('merged'); expect(() => assertReleasePermit(merged)).not.toThrow();
    expect(() => assertReleasePermit({ ...merged, approvedNotes: notesFixture + '\n' })).toThrow('SEALED_IDENTITY');
    expect(() => assertReleasePermit({ ...merged, paused: true })).toThrow();
  });
  it.each(['Bot', 'Organization', 'Mannequin'])('rejects %s approval', type => {
    const f = factsFixture(); f.reviews[0]!.type = type;
    expect(reviewReleaseReceipt(receiptFixture(), f).approval).toBeNull();
  });
  it.each(['read', 'triage', 'none'])('rejects %s permission', permission => {
    const f = factsFixture(); f.reviews[0]!.permission = permission;
    expect(reviewReleaseReceipt(receiptFixture(), f).phase).toBe('awaiting-review');
  });
  it('new head and dismissed/changes-requested approvals invalidate sealed notes', () => {
    const approved = reviewReleaseReceipt(receiptFixture(), factsFixture());
    expect(reviewReleaseReceipt(approved, { ...factsFixture(), headSha: sha('e') }).approvedNotes).toBeNull();
    for (const state of ['DISMISSED', 'CHANGES_REQUESTED']) {
      const f = factsFixture(); f.reviews.push({ ...f.reviews[0]!, id: 11, state });
      expect(reviewReleaseReceipt(approved, f).approval).toBeNull();
    }
  });
  it('comments do not replace a decisive review and another change request blocks', () => {
    const f = factsFixture(); f.reviews.push({ ...f.reviews[0]!, id: 11, state: 'COMMENTED' });
    expect(reviewReleaseReceipt(receiptFixture(), f).phase).toBe('approved');
    f.reviews.push({ ...f.reviews[0]!, id: 12, actorId: 9, state: 'CHANGES_REQUESTED' });
    expect(reviewReleaseReceipt(receiptFixture(), f).phase).toBe('awaiting-review');
  });
  it.each(['checksPassed', 'productTreeUnchanged'] as const)('%s failure blocks even approved content', key => {
    expect(reviewReleaseReceipt(receiptFixture(), { ...factsFixture(), [key]: false }).approval).toBeNull();
  });
  it('close pauses; reopen requires fresh evaluation', () => {
    const closed = reviewReleaseReceipt(receiptFixture(), { ...factsFixture(), closed: true });
    expect(closed.paused).toBe(true); expect(closed.approval).toBeNull();
    expect(reviewReleaseReceipt(closed, factsFixture()).phase).toBe('approved');
  });
  it('rejects automated merges and merge dates before approval', () => {
    const f = { ...factsFixture(), merged: true, merge: { actorId: 4, commitSha: sha('e'), mergedAt: '2026-10-18T00:01:00Z' } };
    expect(() => reviewReleaseReceipt(receiptFixture(), f)).toThrow('MANUAL_MERGE');
    expect(() => reviewReleaseReceipt(receiptFixture(), { ...f, manualMerge: true, merge: { ...f.merge, mergedAt: '2026-10-17T00:00:00Z' } })).toThrow('MANUAL_MERGE');
  });
  it('rejects projection and third-file tampering', () => {
    const r = receiptFixture(), f = factsFixture();
    expect(() => reviewReleaseReceipt(r, { ...f, projection: canonicalReleaseJson({ ...candidateProjection(r), productTargetSha: sha('e') }) })).toThrow('PROJECTION');
    expect(() => reviewReleaseReceipt(r, { ...f, files: [...f.files, 'VERSION'] })).toThrow('FILE_SCOPE');
  });
  it('revision changes projection and branch while preserving version-slot identity', () => {
    const one = receiptFixture(), two = newReleaseReceipt(frozenFixture(), notesFixture, 2);
    expect(two.candidateId).toBe(one.candidateId); expect(two.branch).not.toBe(one.branch);
    expect(candidateProjection(two)).not.toEqual(candidateProjection(one));
  });
});

describe('candidate Markdown boundary', () => {
  it.each([
    notesFixture.replace(/\n/g, '\r\n'), notesFixture.replace('Neutral', 'Other'), notesFixture + '<script>x</script>\n',
    notesFixture.replace('修复导入失败。', '[恶意](javascript:alert(1))'), notesFixture.replace('修复导入失败。', '[未知](https://evil.test/)'),
    notesFixture.replace('修复导入失败。', '![图片](https://evil.test/a.png)'), notesFixture.replace('无需额外操作。', ''),
  ])('rejects malformed, foreign or empty content %#', notes => expect(() => validateCandidateNotes(notes, frozenFixture())).toThrow());
  it('preserves direct human edits and Unicode', () => expect(() => validateCandidateNotes(notesFixture.replace('修复导入失败。', '修复导入失败；请先备份。✨'), frozenFixture())).not.toThrow());
  it('contributors are numeric-ID sorted, authors excluded, exact accessible avatars only', () => {
    const f = { ...frozenFixture(), contributors: [{ id: 3, login: 'third' }, { id: 1, login: 'author' }, { id: 2, login: 'second' }] };
    const avatars = contributorMarkdown(f);
    expect(avatars).not.toContain('author'); expect(avatars.indexOf('/u/2')).toBeLessThan(avatars.indexOf('/u/3'));
    const notes = notesFixture.replace('## 完整变更', avatars + '## 完整变更');
    expect(() => validateCandidateNotes(notes, f)).not.toThrow();
    expect(() => validateCandidateNotes(notes.replace('width="40"', 'width="80"'), f)).toThrow('CONTRIBUTOR_BYTES');
  });
});
