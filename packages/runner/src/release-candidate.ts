import { renderCandidateNote, renderCandidateProjection } from '../../core/src/candidate-note.js';
import { reviewedConditionalReleaseTemplate } from '../../core/src/conditional-release-notes.js';
export { renderCandidateNote };
import { manualCandidateFacts, type ManualCandidate } from '../../core/src/manual-candidate.js';
import { createHash } from 'node:crypto';
import { candidateId, candidateCreationBody, replayReleaseContributors, selectReleaseContributors, type CandidateSnapshot, type ReleaseActor, type RepositoryAuthor } from '../../core/src/release-candidate.js';
import { assertRepositoryWrite, type CycleRecord, type RepositoryRecord } from '../../core/src/release-observation.js';
import { productReleaseTemplatePath } from '../../core/src/release-template.js';
import { mergeCandidate, prepareCandidateWrite, resumeCandidateWrite, candidateTreeMatches, candidateTemplateAdoption, type PreparedCandidateWrite } from './release-candidate-update.js';

export interface CandidatePullRequest { number: number; head: string; branch: string; base: string; state: 'open' | 'closed'; merged: boolean; editing: boolean; body: string }
export interface CandidateComment { id: number; authorId: number; body: string }
export interface CandidateSession {
  manualValidation?: ManualCandidate | null;
  repository: RepositoryRecord; generated: CandidateSnapshot | null; pending: { write: PreparedCandidateWrite; generated: CandidateSnapshot; previousIdentity?: CandidateSession['identity'] } | null;
  identity: null | { authorsDigest: string; sourceDigest: string; noteTemplate?: string; contributorMode?: 'github-authors'; actors: (ReleaseActor | null)[]; contributors: ReturnType<typeof selectReleaseContributors>;
    units: { id: string; notesPath?: string; actors: (ReleaseActor | null)[]; contributors: ReturnType<typeof selectReleaseContributors> }[] };
  conflict: null | { head: string; generated: CandidateSnapshot; paths: string[] };
  preview: string | null;
  adoption: null | { humanHead: string; generatedBase: string; differences: CandidateSnapshot['files'] };
}
export interface CandidateRuntime {
  activeCycle?: CycleRecord;
  workspace: string; temporaryRoot: string; repository: string; defaultBranch: string; appBotId: number; identity: { name: string; email: string };
  now(): string;
  source(): Promise<{ baseSha: string; authors: RepositoryAuthor[]; authorsDigest: string; noteTemplate?: string;
    notesPaths?: Record<string,string>; contributorMode?: 'github-authors'; noteTemplateController?: {workflow: string; pin: string} }>;
  readControllerTemplate?(pin: string): Promise<string>;
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
  readPreview?(commit: string, path: string): Promise<string>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The same PR owns every generation; metadata updates are deliberately absent from this port. */
export interface CandidateObservation {
  repositoryId: number; cycleId: string; channel: 'candidate'; version: string;
  artifactDigest: string; sourceSha: string; stage: 'candidate'; epoch: string; upstreamPR: null;
}
function candidateVersion(units:{id:string;path:string;version:string;tag:string}[]) {
  if(!units.length || new Set(units.map(unit=>unit.id)).size!==units.length ||
      new Set(units.map(unit=>unit.path)).size!==units.length)throw Error('CANDIDATE_UNIT_COVERAGE');
  if(units.length===1)return units[0]!.version;
  const ordered=[...units].sort((a,b)=>a.id<b.id?-1:1);
  const identities=ordered.map(({id,path,version,tag})=>[id,path,version,tag]);
  return 'units-'+digest(identities);
}
// The caller resolves this record from the same protected tree as the repository.
export function candidateCycleIsSeparate(repository: RepositoryRecord, cycle?: CycleRecord) {
  if (repository.activeCycleId === null) return true;
  const number = repository.candidate?.prNumber;
  return !!cycle && !!number && Number.isSafeInteger(number) && number > 0
    && Number.isSafeInteger(cycle.prNumber) && cycle.prNumber > 0 && cycle.prNumber !== number
    && /^[a-f0-9]{40}$/.test(cycle.sourceSha) && cycle.id === repository.activeCycleId
    && cycle.id === `pr-${cycle.prNumber}-${cycle.sourceSha}`;
}
/** Stable generation identity; human edits and derived contributor projection do not restart a window. */
export function candidateObservationIdentity(session: CandidateSession, activeCycle?: CycleRecord): CandidateObservation {
  const { repository, generated } = session, candidate = repository.candidate;
  if (!candidateCycleIsSeparate(repository,activeCycle)) throw Error('CANDIDATE_CYCLE_OWNER');
  if(session.manualValidation) {
    const m=session.manualValidation;
    if(repository.repositoryId!==m.repositoryId||candidate?.id!==m.candidateId||candidate.prNumber!==m.prNumber||candidate.branch!==m.branch
      ||session.pending||candidate.pendingWrite)throw Error('MANUAL_OWNER');
    const factDigest=digest(manualCandidateFacts(m));
    return {repositoryId:m.repositoryId,cycleId:m.candidateId,channel:'candidate',version:candidateVersion(m.units),
      artifactDigest:'sha256:'+factDigest,sourceSha:m.sourceSha,stage:'candidate',
      epoch:digest([m.kind,m.candidateId,m.headSha,m.sourceSha,factDigest]),upstreamPR:null};
  }
  if (!Number.isSafeInteger(repository.repositoryId) || repository.repositoryId<1 || !candidate?.prNumber || !candidate.publishedHead
    || !candidate.generatedSnapshotPath || !generated || !session.identity || session.pending || candidate.pendingWrite
    || generated.baseSha !== candidate.baseSha)
    throw new Error('CANDIDATE_OBSERVATION_NOT_READY');
  return { repositoryId: repository.repositoryId, cycleId: candidate.id, channel: 'candidate',
    version: candidateVersion(generated.units), artifactDigest: 'sha256:' + digest(generated), sourceSha: candidate.baseSha,
    stage: 'candidate', epoch: digest([repository.repositoryId, candidate.id, candidate.baseSha, candidate.generatedSnapshotPath, candidate.publishedHead]), upstreamPR: null };
}

/** Exact existing generated-note projection, with frozen native contributor identities. */
export function candidateProjectionPreview(session:CandidateSession, repository:string):string {
  if(!session.generated||!session.identity)throw Error('CANDIDATE_PROJECTION_CACHE');
  return renderCandidateProjection(session.generated, session.identity, repository);
}
export function candidateCommentFits(body:string):boolean { return Buffer.byteLength(body)<=48*1024; }
export function candidateStatusBody(repository:string,candidateId:string,units:{id:string;version:string}[],head:string,preview:string,previewCommit:string):string {
  const header=`<!-- steward:candidate-status:${candidateId} -->\n候选 head: ${head}\n${units.map(u=>`${u.id}: ${u.version}`).join('\n')}\n\n`;
  const body=header+preview;
  if(candidateCommentFits(body))return body;
  const linked=`${header}[完整预览](https://github.com/${repository}/blob/${previewCommit}/generated/${candidateId}/preview.md)\n`;
  if(!candidateCommentFits(linked))throw Error('CANDIDATE_STATUS_HEADER_TOO_LARGE');
  return linked;
}
export async function advanceReleaseCandidate(session: CandidateSession, io: CandidateRuntime, observation?: CandidateObservation) {
  const repository = session.repository;
  assertRepositoryWrite(repository);
  if (repository.defaultBranch !== io.defaultBranch) throw new Error('CANDIDATE_DEFAULT_BRANCH_DRIFT');
  const save = async () => { repository.revision++; repository.lastProgressAt = io.now(); return io.save(session); };
  if (observation) {
    const actual = candidateObservationIdentity(session, io.activeCycle);
    if (JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify(Object.keys(actual).sort())
      || Object.entries(actual).some(([key, value]) => observation[key as keyof CandidateObservation] !== value))
      throw new Error('CANDIDATE_OBSERVATION_IDENTITY');
  }
  const source = await io.source();
  const notePaths = source.notesPaths ? new Set(Object.values(source.notesPaths)) : null;
  const isNotesPath = (path:string) => notePaths ? notePaths.has(path) : path.startsWith('.release-notes/');
  if (observation && source.baseSha !== observation.sourceSha) return { status: 'WAIT', reason: 'SOURCE_CHANGED' };
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
  const openCandidatePullRequest = async (metadata: { title: string; body: string }) => {
    try {
      await io.createPullRequest({ branch: candidate.branch, base: io.defaultBranch,
        title: metadata.title, body: candidateCreationBody(candidate.id, metadata.body) });
    } catch { /* Creation response is never the identity; all-state native readback is. */ }
    return current();
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
        session.identity = pending.previousIdentity ?? null;
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
  let retainReviewedGeneration = false;
  let templateOnlyAdvance: { generated: CandidateSnapshot; identity: NonNullable<CandidateSession['identity']> } | undefined;
  if (observation && (!frozen || !generated || frozen.sourceDigest !== generated.sourceDigest
    || frozen.authorsDigest !== source.authorsDigest
    || JSON.stringify(frozen.units.map(u => u.id).sort()) !== JSON.stringify(generated.units.map(u => u.id).sort())))
    throw new Error('CANDIDATE_OBSERVATION_CACHE_MISMATCH');
  if (frozen && generated && frozen.sourceDigest === generated.sourceDigest && frozen.authorsDigest === source.authorsDigest
    && JSON.stringify(frozen.units.map(u => u.id).sort()) === JSON.stringify(generated.units.map(u => u.id).sort())) {
    const sameBase = generated.baseSha === source.baseSha, currentTemplate = source.noteTemplate;
    const reviewedTemplate = currentTemplate === undefined ? undefined
      : await reviewedConditionalReleaseTemplate(currentTemplate, frozen.noteTemplate);
    const approvedUpgrade = reviewedTemplate !== currentTemplate;
    const policyUpgrade = reviewedTemplate !== undefined && !frozen.contributorMode && source.contributorMode === 'github-authors';
    const controller = source.noteTemplateController, readTemplate = io.readControllerTemplate;
    if (!sameBase && reviewedTemplate !== undefined && currentTemplate !== undefined
      && (approvedUpgrade || (controller && policyUpgrade)) && observed.pr && candidate.publishedHead
      && (!controller || readTemplate)
      && !generated.files.some(file => file.path === (controller?.workflow ?? productReleaseTemplatePath))
      && await io.isAncestor(generated.baseSha, source.baseSha)
      && await candidateTemplateAdoption(io.workspace, source.baseSha, generated.baseSha, {
        template: currentTemplate, ...(controller && readTemplate ? {controller: {...controller, reviewedTemplate, readTemplate}} : {}),
      }, io.temporaryRoot)) {
      templateOnlyAdvance = { generated, identity: frozen };
    }
    if (sameBase || templateOnlyAdvance) {
      if (frozen.noteTemplate !== reviewedTemplate || frozen.units.some(unit => {
        const declared = source.notesPaths?.[unit.id];
        return declared ? (unit.notesPath ?? `.release-notes/${unit.id}.md`) !== declared : unit.notesPath !== undefined;
      }))
        throw Error('CANDIDATE_NOTE_TEMPLATE_DRIFT');
      retainReviewedGeneration = approvedUpgrade || policyUpgrade;
      const mode = frozen.contributorMode ?? (frozen.noteTemplate ? 'recorded' : undefined);
      const projected = { ...frozen, contributors: replayReleaseContributors(frozen, source.authors, mode),
        units: frozen.units.map(unit => ({ ...unit, contributors: replayReleaseContributors(unit, source.authors, mode) })) };
      if (JSON.stringify(projected) !== JSON.stringify(frozen)) {
        if (retainReviewedGeneration) throw Error('CANDIDATE_OBSERVATION_CACHE_MISMATCH');
        session.identity = projected; await save();
      }
    }
  }
  const statusComment = async (body: string, previewHead: string, currentHead: string) => {
    if (!candidate.prNumber) return;
    const marker = `<!-- steward:candidate-status:${candidate.id} -->`;
    let text=candidateStatusBody(io.repository,candidate.id,session.generated?.units??[],currentHead,body,previewHead);
    const own = (await io.comments(candidate.prNumber)).filter(c => c.authorId === io.appBotId && c.body.includes(marker));
    const existing = candidate.statusCommentId === null ? own : own.filter(c => c.id === candidate.statusCommentId);
    if (own.length>1 || existing.length > 1 || candidate.statusCommentId !== null && existing.length !== 1) throw new Error('CANDIDATE_STATUS_COMMENT_IDENTITY');
    // Reuse a verified immutable large-preview link; recording statusCommentId can advance the state ref.
    if(existing[0]&&io.readPreview) {
      const match=/\[完整预览\]\(https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([a-f0-9]{40})\/(generated\/[a-f0-9]{64}\/preview\.md)\)\n$/.exec(existing[0].body);
      if(match&&match[1]===io.repository&&match[3]===`generated/${candidate.id}/preview.md`
        &&candidateStatusBody(io.repository,candidate.id,session.generated?.units??[],currentHead,body,match[2]!)===existing[0].body
        &&await io.readPreview(match[2]!,match[3]!)===body)text=existing[0].body;
    }
    if (existing[0]) {
      if (existing[0].body !== text) await io.updateComment(existing[0].id, text);
    } else {
      try { await io.createComment(candidate.prNumber, text); } catch { /* Reconcile by native author and owner marker. */ }
    }
    const readback = (await io.comments(candidate.prNumber)).filter(c => c.authorId === io.appBotId && c.body.includes(marker));
    if (readback.length !== 1 || readback[0]!.body !== text) throw new Error('CANDIDATE_STATUS_COMMENT_UNKNOWN');
    if (candidate.statusCommentId !== readback[0]!.id) { candidate.statusCommentId = readback[0]!.id; await save(); }
    const rawDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
    return {commentId:readback[0]!.id,bodyDigest:rawDigest(text),previewDigest:rawDigest(body)};
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
      return { status: 'CONFLICT', reason: difference.conflictPaths.every(isNotesPath) ? 'HUMAN_EDIT_CONFLICT' : 'SOURCE_CHANGED', paths: difference.conflictPaths };
    }
  }
  // Reuse the frozen generation when the template or contributor policy is being adopted.
  if (observation || (retainReviewedGeneration && !templateOnlyAdvance)) {
    // A mergeable tree can still require a write (for example a human revert to B).
    // Observation never performs that write, so only the actual frozen tree can complete.
    const reviewedHead = observed.head, reviewed = session.generated;
    if (!reviewedHead || !reviewed || !await candidateTreeMatches(io.workspace, reviewedHead,
      reviewed.baseSha, reviewed.files, io.temporaryRoot))
      return { status: 'WAIT', reason: 'GENERATED_FILES_MISMATCH', head: reviewedHead };
    const stable=async(allowMissingPull = false)=>{
      const now=await current(),latest=await io.source();
      if((!now.pr&&!allowMissingPull)||now.pr?.state==='closed'||now.pr?.editing||now.head!==reviewedHead||latest.baseSha!==source.baseSha
        ||latest.authorsDigest!==source.authorsDigest||latest.noteTemplate!==source.noteTemplate)
        throw Error('CANDIDATE_OBSERVATION_MOVED');
      return now;
    };
    if (!observed.pr && !observation) {
      if (candidate.publishedHead !== reviewedHead) return { status: 'WAIT', reason: 'GENERATED_FILES_MISMATCH', head: reviewedHead };
      const metadata = await io.generation(source.baseSha);
      if (metadata.status !== 'READY') return { status: 'WAIT', reason: metadata.status };
      if (metadata.snapshot.baseSha !== reviewed.baseSha || metadata.snapshot.configDigest !== reviewed.configDigest
        || metadata.snapshot.sourceDigest !== reviewed.sourceDigest) return { status: 'WAIT', reason: 'SOURCE_DRIFT' };
      observed = await stable(true);
      if (!observed.pr) observed = await openCandidatePullRequest(metadata);
      if (!observed.pr) return { status: 'WAIT', reason: 'PR_CREATE_UNKNOWN' };
    }
    await stable();const preview=candidateProjectionPreview(session,io.repository);
    const changed=session.preview!==preview;session.preview=preview;
    const archive=changed?await save():await io.save(session);
    await stable();const projectionEvidence=await statusComment(preview,archive,observed.head!);
    await stable();if(!projectionEvidence)throw Error('CANDIDATE_PROJECTION_UNKNOWN');
    return observation
      ? { status: 'READY', reason: 'CACHED_OBSERVATION', head: observed.head, projectionEvidence }
      : { status: 'READY', prNumber: candidate.prNumber, head: observed.head };
  }
  // Check the identity inputs before running upstream generation.
  selectReleaseContributors([], source.authors, source.contributorMode);
  const generation = await io.generation(source.baseSha);
  if (generation.status !== 'READY') return { status: 'WAIT', reason: generation.status };
  const previousIdentity = session.identity;
  let N: CandidateSnapshot;
  if (templateOnlyAdvance) {
    const prior = templateOnlyAdvance.generated;
    if (generation.snapshot.baseSha !== source.baseSha || generation.snapshot.configDigest !== prior.configDigest
      || digest(generation.snapshot.units) !== digest(prior.units)) return { status: 'WAIT', reason: 'SOURCE_DRIFT' };
    N = { ...generation.snapshot, files: prior.files };
  } else {
    candidate.contentGenerationDigest = digest([generation.snapshot.sourceDigest, generation.snapshot.configDigest, source.authorsDigest]); await save();
    const content = await io.content(candidate, generation.snapshot);
    if (content.status !== 'READY') return { status: 'WAIT', reason: `CONTENT_${content.status}` };
    N = { ...generation.snapshot, files: [...generation.snapshot.files, ...content.files] };
    if (JSON.stringify(Object.keys(content.unitActors).sort()) !== JSON.stringify(N.units.map(unit => unit.id).sort())) throw new Error('CANDIDATE_CONTRIBUTOR_UNIT_COVERAGE');
    session.identity = { authorsDigest: source.authorsDigest, sourceDigest: N.sourceDigest,
      ...(source.noteTemplate ? { noteTemplate: source.noteTemplate } : {}),
      ...(source.contributorMode ? { contributorMode: source.contributorMode } : {}),
      actors: content.actors, contributors: selectReleaseContributors(content.actors, source.authors, source.contributorMode),
      units: N.units.map(unit => ({ id: unit.id, ...(source.notesPaths ? {notesPath:source.notesPaths[unit.id]!} : {}),
        actors: content.unitActors[unit.id]!, contributors: selectReleaseContributors(content.unitActors[unit.id]!, source.authors, source.contributorMode) })) };
  }
  const latestSource = await io.source();
  if (latestSource.baseSha !== source.baseSha || latestSource.authorsDigest !== source.authorsDigest
    || (templateOnlyAdvance && latestSource.noteTemplate !== source.noteTemplate)) return { status: 'WAIT', reason: 'SOURCE_DRIFT' };
  observed = await current();
  if (observed.pr?.editing || observed.pr?.state === 'closed') return { status: 'WAIT', reason: 'PR_CHANGED_DURING_GENERATION' };
  const H = observed.head;
  const merged = await mergeCandidate(io.workspace, session.generated, observed.retiredHead ? source.baseSha : H ?? source.baseSha, N, io.temporaryRoot);
  if (merged.status === 'CONFLICT') {
    session.conflict = { head: H ?? source.baseSha, generated: N, paths: merged.conflictPaths }; await save();
    return { status: 'CONFLICT', reason: merged.conflictPaths.every(isNotesPath) ? 'HUMAN_EDIT_CONFLICT' : 'SOURCE_CHANGED', paths: merged.conflictPaths };
  }
  if (templateOnlyAdvance) session.identity = { ...templateOnlyAdvance.identity, sourceDigest: N.sourceDigest };
  const unchanged = H !== null && await candidateTreeMatches(io.workspace, H, N.baseSha, merged.files, io.temporaryRoot);
  if (!unchanged) {
  const prepared = await prepareCandidateWrite(io.workspace, H, N, merged, io.identity, io.temporaryRoot);
  session.pending = { write: prepared, generated: N, previousIdentity };
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
    observed = await openCandidatePullRequest(generation);
    if (!observed.pr) return { status: 'WAIT', reason: 'PR_CREATE_UNKNOWN' };
  }
  if (observed.pr.state === 'closed') return { status: 'WAIT', reason: 'CLOSED_PR' };
  if (!session.identity) throw Error('CANDIDATE_PROJECTION_CACHE');
  session.preview = renderCandidateProjection({ ...N, files: merged.files }, session.identity, io.repository);
  const archive = await save(); await statusComment(session.preview, archive, observed.pr.head);
  return { status: 'READY', prNumber: candidate.prNumber, head: candidate.publishedHead };
}
