import { EvidenceReadError } from '../packages/runner/dist/index.js';
import { comparableCandidateFile, defaultHead, fitsOfficialEvent, hasLabel, officialNotes, officialPending,
  officialRef, officialRoundMarker, pages, pullBinding, readOfficialConfig, readOfficialManifest, readSourceFile,
  requireCandidate, verifyNotesUnit, verifyOfficialPull } from './official-release-candidate.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hasRoundMarker = (pull, roundId) => typeof pull?.body === 'string' && pull.body.includes(officialRoundMarker(roundId));
const branchPath = head => 'git/ref/heads/' + encodeURIComponent(head);
const commitMarker = roundId => 'Steward-Candidate-Round: ' + roundId;

export async function openOfficialPull(get, product, botId) {
  const pulls = await pages(get, 'pulls?state=open&base=' + encodeURIComponent(product.defaultBranch));
  const official = pulls.filter(pull => pull.head?.repo?.id === product.id &&
    officialRef(pull.head.ref, product.defaultBranch));
  requireCandidate(official.length <= 1, 'AMBIGUOUS_BRANCH');
  const [pull] = official;
  if (pull) pullBinding(pull, product, pull.number, botId);
  return pull ?? null;
}

async function readOpenCandidatePull(get, product, botId, number, expectedHead) {
  const pull = await get('pulls/' + number);
  pullBinding(pull, product, number, botId);
  requireCandidate(pull.state === 'open' && pull.merged === false && pull.head.sha === expectedHead, 'PRIOR_PULL_DRIFT');
  return pull;
}

async function readBranch(get, head) {
  let ref;
  try { ref = await get(branchPath(head)); }
  catch (error) {
    if (error instanceof EvidenceReadError && error.status === 404) return null;
    throw error;
  }
  requireCandidate(ref.ref === 'refs/heads/' + head && ref.object?.type === 'commit' && sha(ref.object.sha), 'CANDIDATE_REF');
  return ref.object.sha;
}

async function verifyCandidateFiles(get, parent, head, candidate, allowGeneratedDate = false) {
  const result = await get('compare/' + parent + '...' + head + '?per_page=1');
  const paths = candidate.files.map(file => file.path).sort();
  if (result.merge_base_commit?.sha !== parent || result.total_commits !== 1 ||
    JSON.stringify(result.files?.map(file => file.filename).sort()) !== JSON.stringify(paths)) return false;
  const match = await Promise.all(candidate.files.map(async file => {
    const actual = await readSourceFile(get, file.path, head);
    if (actual.equals(Buffer.from(file.content))) return true;
    if (!allowGeneratedDate) return false;
    const text = actual.toString('utf8');
    return actual.equals(Buffer.from(text)) &&
      comparableCandidateFile(candidate, file.path, text) === comparableCandidateFile(candidate, file.path, file.content);
  }));
  return match.every(Boolean);
}

export async function compatibleExistingCandidate({ get, pull, product, botId, candidate, configuration }) {
  if (!pull || !hasLabel(pull, officialPending) || !fitsOfficialEvent(pull.body ?? '')) return null;
  const commit = await get('git/commits/' + pull.head.sha);
  const parent = commit.parents?.[0]?.sha;
  if (commit.sha !== pull.head.sha || commit.verification?.verified !== true || commit.parents?.length !== 1 || !sha(parent) ||
    commit.message.includes('Steward-Candidate-Round:') ||
    !await verifyCandidateFiles(get, parent, pull.head.sha, candidate, true)) return null;
  const previousConfig = await readOfficialConfig(get, parent);
  if (JSON.stringify(previousConfig) !== JSON.stringify(configuration)) return null;
  let notes;
  try {
    notes = verifyOfficialPull(pull, product, pull.number, botId, configuration, await readOfficialManifest(get, pull.head.sha));
  } catch (error) {
    if (/^OFFICIAL_CANDIDATE_(?:VERSION|BOUNDARIES|BODY_PARSE)$/.test(error?.message)) return null;
    throw error;
  }
  if (notes.version !== candidate.version || !notes.body.includes('\n## 版本记录\n')) return null;
  return { draft: { body: pull.body, templateDigest: null },
    branch: { head: pull.head.sha, sourceSha: parent },
    pull: { number: pull.number, head: pull.head.sha, bodyDigest: notes.bodyDigest } };
}

export function verifyCandidateDraft(candidate, draft, roundId, product, configuration) {
  requireCandidate(typeof draft?.body === 'string' && fitsOfficialEvent(draft.body), 'C1_BODY_LIMIT');
  const parsed = officialNotes(draft.body);
  verifyNotesUnit(parsed, product, configuration, candidate.head);
  requireCandidate(parsed.version === candidate.version, 'C1_VERSION');
  requireCandidate(draft.body.endsWith(officialRoundMarker(roundId)), 'C1_ROUND');
  return parsed;
}

async function verifiedCandidateParent(get, candidate, head, roundId, commit) {
  const parent = commit.parents?.[0]?.sha;
  requireCandidate(commit.sha === head && commit.message === candidate.title + '\n\n' + commitMarker(roundId) &&
    commit.parents?.length === 1 && sha(parent) && commit.verification?.verified === true &&
    await verifyCandidateFiles(get, parent, head, candidate), 'BRANCH_READBACK');
  return parent;
}

async function settleBranch({ get, request, admit, sourceSha, product, botId, roundId, round }) {
  const { candidate, prior } = round.source;
  const currentHead = await readBranch(get, candidate.head);
  if (round.branch) {
    requireCandidate(round.branch.head === currentHead, 'BRANCH_DRIFT');
    return round.branch;
  }
  if (currentHead) {
    const current = await get('git/commits/' + currentHead);
    if (current.message === candidate.title + '\n\n' + commitMarker(roundId)) {
      const sourceSha = await verifiedCandidateParent(get, candidate, currentHead, roundId, current);
      return { head: currentHead, sourceSha };
    }
    if (prior) {
      requireCandidate(currentHead === prior.head, 'PRIOR_BRANCH_DRIFT');
    } else {
      const closed = await pages(get, 'pulls?state=closed&head=' + encodeURIComponent(product.name.split('/')[0] + ':' + candidate.head));
      const priorPull = closed.find(pull => pull.head?.sha === currentHead && pull.base?.ref === candidate.base);
      requireCandidate(priorPull, 'UNBOUND_CANDIDATE_BRANCH');
      pullBinding(priorPull, product, priorPull.number, botId);
    }
  } else {
    requireCandidate(!prior, 'PRIOR_BRANCH_DRIFT');
  }
  const open = await openOfficialPull(get, product, botId);
  requireCandidate(prior ? open?.number === prior.number && open.head.sha === prior.head : !open, 'PRIOR_PULL_DRIFT');
  // A delivered PR must already point to this round's signed commit, recovered above.
  requireCandidate(!hasRoundMarker(open, roundId), 'PRIOR_PULL_DRIFT');
  const base = await get('git/commits/' + sourceSha);
  requireCandidate(base.sha === sourceSha && sha(base.tree?.sha), 'C2_SOURCE_TREE');
  const tree = await request('POST', 'git/trees', { base_tree: base.tree.sha,
    tree: candidate.files.map(file => ({ ...file, type: 'blob' })) });
  requireCandidate(sha(tree.sha) && tree.sha !== base.tree.sha, 'CANDIDATE_TREE');
  const commit = await request('POST', 'git/commits', {
    message: candidate.title + '\n\n' + commitMarker(roundId), parents: [sourceSha], tree: tree.sha,
  });
  requireCandidate(sha(commit.sha) && commit.verification?.verified === true && commit.tree?.sha === tree.sha &&
    commit.parents?.length === 1 && commit.parents[0].sha === sourceSha, 'CANDIDATE_SIGNED_COMMIT');
  await admit();
  requireCandidate(await readBranch(get, candidate.head) === currentHead, 'PRIOR_BRANCH_DRIFT');
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
  if (prior) {
    const beforeWrite = await readOpenCandidatePull(get, product, botId, prior.number, prior.head);
    requireCandidate(!hasRoundMarker(beforeWrite, roundId), 'PRIOR_PULL_DRIFT');
  }
  let mutationError;
  try {
    if (currentHead) await request('PATCH', 'git/refs/heads/' + encodeURIComponent(candidate.head), { sha: commit.sha, force: true });
    else await request('POST', 'git/refs', { ref: 'refs/heads/' + candidate.head, sha: commit.sha });
  } catch (error) { mutationError = error; }
  const actual = await readBranch(get, candidate.head);
  if (actual === currentHead && mutationError?.status && mutationError.status < 500) throw mutationError;
  requireCandidate(actual === commit.sha, 'BRANCH_WRITE_UNKNOWN');
  return { head: actual, sourceSha };
}

async function settlePull({ get, request, admit, sourceSha, product, botId, roundId, round, branch, configuration, sameCandidateBase }) {
  const { candidate, prior } = round.source;
  let pull = await openOfficialPull(get, product, botId);
  if (pull) pull = await readOpenCandidatePull(get, product, botId, pull.number, branch.head);
  requireCandidate(pull ? pull.head.sha === branch.head && (prior ? pull.number === prior.number : hasRoundMarker(pull, roundId)) : !prior,
    'PRIOR_PULL_DRIFT');
  if (branch.sourceSha !== sourceSha && (!hasRoundMarker(pull, roundId) || !hasLabel(pull, officialPending))) {
    const commit = await get('git/commits/' + branch.head);
    const parent = await verifiedCandidateParent(get, candidate, branch.head, roundId, commit);
    requireCandidate(parent === branch.sourceSha &&
      await sameCandidateBase(parent, sourceSha, candidate.files.map(file => file.path)), 'C2_STALE_BRANCH_BASE');
  }
  const confirmSource = async () => {
    await admit();
    requireCandidate(await readBranch(get, candidate.head) === branch.head &&
      await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
  };
  if (!hasRoundMarker(pull, roundId)) {
    await confirmSource();
    if (prior) pull = await readOpenCandidatePull(get, product, botId, prior.number, branch.head);
  }
  if (!hasRoundMarker(pull, roundId)) {
    let mutationError;
    const fields = { title: candidate.title, body: round.draft.body };
    try {
      if (prior) await request('PATCH', 'pulls/' + prior.number, fields);
      else await request('POST', 'pulls', { ...fields, head: candidate.head, base: candidate.base, draft: false });
    } catch (error) { mutationError = error; }
    pull = await openOfficialPull(get, product, botId);
    if (!hasRoundMarker(pull, roundId) && mutationError?.status && mutationError.status < 500) throw mutationError;
    requireCandidate(hasRoundMarker(pull, roundId) && pull.head.sha === branch.head && (!prior || prior.number === pull.number), 'PULL_WRITE_UNKNOWN');
  }
  const manifest = await readOfficialManifest(get, branch.head);
  if (!hasLabel(pull, officialPending)) {
    await confirmSource();
    pull = await readOpenCandidatePull(get, product, botId, pull.number, branch.head);
    requireCandidate(hasRoundMarker(pull, roundId), 'PRIOR_PULL_DRIFT');
    verifyOfficialPull(pull, product, pull.number, botId, configuration, manifest);
    let mutationError;
    try { await request('POST', 'issues/' + pull.number + '/labels', { labels: candidate.labels }); }
    catch (error) { mutationError = error; }
    pull = await get('pulls/' + pull.number);
    if (!hasLabel(pull, officialPending) && mutationError?.status && mutationError.status < 500) throw mutationError;
    requireCandidate(hasLabel(pull, officialPending), 'LABEL_WRITE_UNKNOWN');
  }
  const actual = verifyOfficialPull(pull, product, pull.number, botId, configuration, manifest);
  return { number: pull.number, head: branch.head, bodyDigest: actual.bodyDigest };
}

export async function observeOfficialCandidatePull({ get, product, botId, record }) {
  const pull = await get('pulls/' + record.number);
  pullBinding(pull, product, record.number, botId);
  requireCandidate(typeof pull.merged === 'boolean' && ['open', 'closed'].includes(pull.state), 'COMPLETED_PULL_STATE');
  if (pull.state === 'closed') {
    if (!pull.merged) return 'candidate_closed';
    requireCandidate(pull.head.sha === record.head, 'COMPLETED_PULL_DRIFT');
    return 'candidate_merged';
  }
  requireCandidate(!pull.merged && pull.head.sha === record.head && hasLabel(pull, officialPending) &&
    await readBranch(get, pull.head.ref) === record.head, 'COMPLETED_PULL_DRIFT');
  return 'candidate_unchanged';
}

export async function writeOfficialCandidate(options) {
  const { round, roundId, sourceSha, product, get, save, admit } = options;
  if (round.pull) {
    await observeOfficialCandidatePull({ get, product, botId: options.botId, record: round.pull });
    return round.pull;
  }
  verifyCandidateDraft(round.source.candidate, round.draft, roundId, product, options.configuration);
  await admit();
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
  const branch = await settleBranch(options);
  if (!round.branch) await save('branch', branch);
  const pull = await settlePull({ ...options, branch });
  await save('pull', pull);
  return pull;
}
