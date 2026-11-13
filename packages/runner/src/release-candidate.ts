import { createHash } from 'node:crypto';
import { candidateId, candidateCreationBody, selectReleaseContributors, renderReleaseContributors, type CandidateSnapshot, type ReleaseActor, type RepositoryAuthor } from '../../core/src/release-candidate.js';
import { assertRepositoryWrite, type RepositoryRecord } from '../../core/src/release-observation.js';
import { mergeCandidate, prepareCandidateWrite, resumeCandidateWrite, candidateTreeMatches, type PreparedCandidateWrite } from './release-candidate-update.js';

export interface CandidatePullRequest { number: number; head: string; branch: string; base: string; state: 'open' | 'closed'; merged: boolean; editing: boolean; body: string }
export interface CandidateComment { id: number; authorId: number; body: string }
export interface CandidateSession {
  repository: RepositoryRecord; generated: CandidateSnapshot | null; pending: { write: PreparedCandidateWrite; generated: CandidateSnapshot } | null;
  identity: null | { authorsDigest: string; sourceDigest: string; actors: (ReleaseActor | null)[]; contributors: ReturnType<typeof selectReleaseContributors>;
    units: { id: string; actors: (ReleaseActor | null)[]; contributors: ReturnType<typeof selectReleaseContributors> }[] };
  conflict: null | { head: string; generated: CandidateSnapshot; paths: string[] };
  preview: string | null;
  adoption: null | { humanHead: string; generatedBase: string; differences: CandidateSnapshot['files'] };
}
export interface CandidateRuntime {
  workspace: string; temporaryRoot: string; repository: string; defaultBranch: string; appBotId: number; identity: { name: string; email: string };
  now(): string;
  source(): Promise<{ baseSha: string; authors: RepositoryAuthor[]; authorsDigest: string }>;
  pullRequests(branch: string): Promise<CandidatePullRequest[]>;
  legacyCandidate(): Promise<CandidatePullRequest | null>;
  generation(baseSha: string): Promise<{ status: 'READY'; snapshot: CandidateSnapshot; title: string; body: string } | { status: 'UNCHANGED' | 'DRIFT' }>;
  content(candidate: NonNullable<RepositoryRecord['candidate']>, snapshot: CandidateSnapshot): Promise<{ status: 'READY'; files: CandidateSnapshot['files']; actors: (ReleaseActor | null)[]; unitActors: Record<string, (ReleaseActor | null)[]> } | { status: 'WAIT' | 'EDITING' | 'FAILED' }>;
  /** Atomic protected state transaction. Returns the exact archive commit for preview links. */
  save(session: CandidateSession): Promise<string>;
  branchHead(branch: string): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  push(branch: string, prepared: PreparedCandidateWrite): Promise<void>;
  createPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<void>;
  comments(pr: number): Promise<CandidateComment[]>;
  createComment(pr: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The same PR owns every generation; metadata updates are deliberately absent from this port. */
export async function advanceReleaseCandidate(session: CandidateSession, io: CandidateRuntime) {
  const repository = session.repository;
  assertRepositoryWrite(repository);
  if (repository.defaultBranch !== io.defaultBranch) throw new Error('CANDIDATE_DEFAULT_BRANCH_DRIFT');
  const save = async () => { repository.revision++; repository.lastProgressAt = io.now(); return io.save(session); };
  const source = await io.source();
  let candidate = repository.candidate;
  if (!candidate) {
    const old = await io.legacyCandidate(), branch = old?.branch ?? 'steward/release-candidate';
    candidate = { id: await candidateId(repository.repositoryId, branch, source.baseSha, repository.lastCompletedCycleId),
      prNumber: old?.number ?? null, branch, baseSha: source.baseSha, generatedSnapshotPath: null, publishedHead: null,
      statusCommentId: null, contentGenerationDigest: digest([source.baseSha, source.authorsDigest]),
      adoptionOverride: null, observedLabelEventIds: [], pendingWrite: null };
    repository.candidate = candidate; await save();
  }
  const current = async () => {
    const prs = await io.pullRequests(candidate.branch);
    const selected = candidate.prNumber === null ? prs.filter(p => p.base === io.defaultBranch && p.body.includes(`<!-- steward:candidate:${candidate.id} -->`))
      : prs.filter(p => p.number === candidate.prNumber && p.base === io.defaultBranch);
    if (selected.length > 1) throw new Error('CANDIDATE_MULTIPLE_PRS');
    if (prs.some(p => p.state === 'open' && p.base === io.defaultBranch && !selected.includes(p))) throw new Error('CANDIDATE_UNRELATED_OPEN_PR');
    if (candidate.prNumber !== null && !selected.length) throw new Error('CANDIDATE_PR_UNAVAILABLE');
    const pr = selected[0] ?? null;
    if (pr && candidate.prNumber === null) { candidate.prNumber = pr.number; await save(); }
    const head = pr?.head ?? await io.branchHead(candidate.branch);
    // The old reviewed branch survives a completed cycle. Its exact merged head
    // is only the next push's parent; new content starts from the new default B.
    const retiredHead = !pr && candidate.prNumber === null && !session.generated && head !== null
      && prs.some(p => p.state === 'closed' && p.merged && p.base === io.defaultBranch && p.head === head);
    return { pr, head, retiredHead };
  };
  const finishPending = async () => {
    if (!session.pending) return null;
    const pending = session.pending;
    const finish = async (prepared: PreparedCandidateWrite) => {
      session.generated = pending.generated; candidate.baseSha = pending.generated.baseSha;
      candidate.generatedSnapshotPath = `generated/${candidate.id}/${prepared.generatedDigest}.json`;
      candidate.publishedHead = prepared.proposedCommit; candidate.pendingWrite = null; session.pending = null; session.conflict = null; await save();
    };
    const result = await resumeCandidateWrite(pending.write, {
      read: async () => { const value = await current(); return { head: value.head, editing: value.pr?.editing ?? false,
        closed: value.pr?.state === 'closed', baseSha: (await io.source()).baseSha }; },
      isAncestor: (a, b) => io.isAncestor(a, b), push: prepared => io.push(candidate.branch, prepared),
      persistPending: async () => { await save(); },
      finish,
    });
    if (result.status === 'EDITING' || result.status === 'CHANGED_BEFORE_PUSH' || result.status === 'CONFLICT') {
      const value = await current();
      // Recheck adoption before retiring a stale proposal. An unavailable
      // ancestry read throws and leaves the durable intent intact.
      if (value.head && (value.head === pending.write.proposedCommit || await io.isAncestor(pending.write.proposedCommit, value.head))) {
        await finish(pending.write); return { status: 'APPLIED' as const, head: value.head };
      }
      if (value.pr?.editing || value.head !== pending.write.expectedHead || (await io.source()).baseSha !== pending.write.baseSha) {
        // The original proposal remains in protected state history. Keep the previous generated snapshot
        // so the next wake can detect and preserve human differences.
        candidate.pendingWrite = null; session.pending = null; await save();
        return { status: value.pr?.editing ? 'CANCELLED_FOR_EDITING' as const : 'REPLAN' as const };
      }
    }
    return result;
  };
  // Recovery precedes the editing pause, including accepted pushes followed by human commits.
  const recovered = await finishPending();
  if (recovered && !['APPLIED', 'CANCELLED_FOR_EDITING'].includes(recovered.status)) return { status: 'WAIT', reason: recovered.status };
  let observed = await current();
  if (observed.pr?.state === 'closed') return { status: 'WAIT', reason: observed.pr.merged ? 'MERGED_SOURCE_HANDOFF' : 'CLOSED_PR' };
  // Refresh derived identity even on protected early returns, without changing its native evidence.
  const frozen = session.identity, generated = session.generated;
  if (frozen && generated && generated.baseSha === source.baseSha
    && frozen.sourceDigest === generated.sourceDigest && frozen.authorsDigest === source.authorsDigest
    && JSON.stringify(frozen.units.map(u => u.id).sort()) === JSON.stringify(generated.units.map(u => u.id).sort())) {
    const projected = { ...frozen, contributors: selectReleaseContributors(frozen.actors, source.authors),
      units: frozen.units.map(unit => ({ ...unit, contributors: selectReleaseContributors(unit.actors, source.authors) })) };
    if (JSON.stringify(projected) !== JSON.stringify(frozen)) { session.identity = projected; await save(); }
  }
  const statusComment = async (body: string, previewHead: string, currentHead: string) => {
    if (!candidate.prNumber) return;
    const marker = `<!-- steward:candidate-status:${candidate.id} -->`;
    const units = session.generated?.units.map(u => `${u.id}: ${u.version}`).join('\n') ?? '';
    const link = `https://github.com/${io.repository}/blob/${previewHead}/generated/${candidate.id}/preview.md`;
    const header = `${marker}\n候选 head: ${currentHead}\n${units}\n\n`;
    const full = `${header}${body}`;
    const text = Buffer.byteLength(full) <= 48 * 1024 ? full : `${header}[完整预览](${link})\n`;
    const own = (await io.comments(candidate.prNumber)).filter(c => c.authorId === io.appBotId && c.body.includes(marker));
    const existing = candidate.statusCommentId === null ? own : own.filter(c => c.id === candidate.statusCommentId);
    if (existing.length > 1 || candidate.statusCommentId !== null && existing.length !== 1) throw new Error('CANDIDATE_STATUS_COMMENT_IDENTITY');
    if (existing[0]) {
      if (existing[0].body !== text) await io.updateComment(existing[0].id, text);
    } else {
      try { await io.createComment(candidate.prNumber, text); } catch { /* Reconcile by native author and owner marker. */ }
    }
    const readback = (await io.comments(candidate.prNumber)).filter(c => c.authorId === io.appBotId && c.body.includes(marker));
    if (readback.length !== 1 || readback[0]!.body !== text) throw new Error('CANDIDATE_STATUS_COMMENT_UNKNOWN');
    if (candidate.statusCommentId !== readback[0]!.id) { candidate.statusCommentId = readback[0]!.id; await save(); }
  };
  if (observed.pr?.editing) {
    session.preview = `已暂停候选写入；请在原PR处理人工修改。当前 head：${observed.pr.head}。\n`;
    const archive = await save(); await statusComment(session.preview, archive, observed.pr.head);
    return { status: 'WAIT', reason: 'EDITING', head: observed.pr.head };
  }
  if (session.generated && observed.head) {
    const difference = await mergeCandidate(io.workspace, session.generated, observed.head, session.generated, io.temporaryRoot);
    if (difference.status === 'CONFLICT') {
      session.conflict = { head: observed.head, generated: session.generated, paths: difference.conflictPaths };
      session.preview = `检测到候选人工修改，已保留当前文件；请在原PR处理冲突。当前 head：${observed.head}。\n`;
      const archive = await save(); await statusComment(session.preview, archive, observed.head);
      return { status: 'CONFLICT', reason: difference.conflictPaths.some(path => !path.startsWith('.release-notes/')) ? 'SOURCE_CHANGED' : 'HUMAN_EDIT_CONFLICT', paths: difference.conflictPaths };
    }
  }
  // Missing author facts block only this repository's new takeover, not implementation or other repositories.
  selectReleaseContributors([], source.authors);
  const generation = await io.generation(source.baseSha);
  if (generation.status !== 'READY') return { status: 'WAIT', reason: generation.status };
  candidate.contentGenerationDigest = digest([generation.snapshot.sourceDigest, generation.snapshot.configDigest, source.authorsDigest]); await save();
  const content = await io.content(candidate, generation.snapshot);
  if (content.status !== 'READY') return { status: 'WAIT', reason: `CONTENT_${content.status}` };
  const N: CandidateSnapshot = { ...generation.snapshot, files: [...generation.snapshot.files, ...content.files] };
  if (JSON.stringify(Object.keys(content.unitActors).sort()) !== JSON.stringify(N.units.map(unit => unit.id).sort())) throw new Error('CANDIDATE_CONTRIBUTOR_UNIT_COVERAGE');
  session.identity = { authorsDigest: source.authorsDigest, sourceDigest: N.sourceDigest, actors: content.actors, contributors: selectReleaseContributors(content.actors, source.authors),
    units: N.units.map(unit => ({ id: unit.id, actors: content.unitActors[unit.id]!, contributors: selectReleaseContributors(content.unitActors[unit.id]!, source.authors) })) };
  const latestSource = await io.source();
  if (latestSource.baseSha !== source.baseSha || latestSource.authorsDigest !== source.authorsDigest) return { status: 'WAIT', reason: 'SOURCE_DRIFT' };
  observed = await current();
  if (observed.pr?.editing || observed.pr?.state === 'closed') return { status: 'WAIT', reason: 'PR_CHANGED_DURING_GENERATION' };
  const H = observed.head;
  const merged = await mergeCandidate(io.workspace, session.generated, observed.retiredHead ? source.baseSha : H ?? source.baseSha, N, io.temporaryRoot);
  if (merged.status === 'CONFLICT') {
    session.conflict = { head: H ?? source.baseSha, generated: N, paths: merged.conflictPaths }; await save();
    return { status: 'CONFLICT', reason: merged.conflictPaths.some(path => !path.startsWith('.release-notes/')) ? 'SOURCE_CHANGED' : 'HUMAN_EDIT_CONFLICT', paths: merged.conflictPaths };
  }
  const unchanged = H !== null && await candidateTreeMatches(io.workspace, H, N.baseSha, merged.files, io.temporaryRoot);
  if (!unchanged) {
  const prepared = await prepareCandidateWrite(io.workspace, H, N, merged, io.identity, io.temporaryRoot);
  session.pending = { write: prepared, generated: N };
  candidate.pendingWrite = { expectedHead: H, proposedCommit: prepared.proposedCommit,
    newGeneratedSnapshotPath: `generated/${candidate.id}/${prepared.generatedDigest}.json`, newGeneratedDigest: prepared.generatedDigest,
    operationKey: digest([candidate.id, prepared.proposedCommit]), observedAt: io.now() };
  // The adoption evidence is archived with the original H/N difference; no fabricated authorization event.
  if (merged.adoption && merged.adoption.differences.length) {
    session.adoption = merged.adoption;
    candidate.adoptionOverride = { kind: 'legacy-candidate', humanHead: merged.adoption.humanHead,
      generatedBase: merged.adoption.generatedBase, evidencePath: `generated/${candidate.id}/adoption.json` };
  }
  await save();
  const written = await finishPending();
  if (written?.status !== 'APPLIED') return { status: 'WAIT', reason: written?.status ?? 'WRITE_UNKNOWN' };
  } else {
    session.generated = N; candidate.baseSha = N.baseSha; candidate.generatedSnapshotPath = `generated/${candidate.id}/${digest(N)}.json`;
    // The current head already equals the generated result. Record that
    // exact head and retire the resolved conflict without rewriting its tree.
    candidate.publishedHead = H; session.conflict = null; await save();
  }
  observed = await current();
  if (!observed.pr) {
    try { await io.createPullRequest({ branch: candidate.branch, base: io.defaultBranch, title: generation.title, body: candidateCreationBody(candidate.id, generation.body) }); }
    catch { /* Creation response is never the identity; all-state native readback is. */ }
    observed = await current();
    if (!observed.pr) return { status: 'WAIT', reason: 'PR_CREATE_UNKNOWN' };
  }
  if (observed.pr.state === 'closed') return { status: 'WAIT', reason: 'CLOSED_PR' };
  session.preview = merged.files.filter(f => f.path.startsWith('.release-notes/') && f.content !== null)
    .map(f => `# ${f.path}\n\n${f.content}` + renderReleaseContributors(session.identity!.units.find(u => `.release-notes/${u.id}.md` === f.path)!.contributors.contributors)).join('\n').replace(/\r\n?/g, '\n');
  const archive = await save(); await statusComment(session.preview, archive, observed.pr.head);
  return { status: 'READY', prNumber: candidate.prNumber, head: candidate.publishedHead };
}
