import { EvidenceReadError } from '../packages/runner/dist/index.js';
import { bodyDigest, defaultHead, fitsOfficialEvent, hasLabel, officialNotes, officialPending,
  officialRef, officialRoundMarker, pages, pullBinding, readOfficialManifest, readSourceFile,
  requireCandidate, verifyOfficialPull } from './official-release-candidate.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
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

async function verifyCandidateFiles(get, parent, head, candidate) {
  const result = await get('compare/' + parent + '...' + head + '?per_page=1');
  const paths = candidate.files.map(file => file.path).sort();
  if (result.merge_base_commit?.sha !== parent || result.total_commits !== 1 ||
    JSON.stringify(result.files?.map(file => file.filename).sort()) !== JSON.stringify(paths)) return false;
  const match = await Promise.all(candidate.files.map(async file =>
    (await readSourceFile(get, file.path, head)).equals(Buffer.from(file.content))));
  return match.every(Boolean);
}

export async function compatibleExistingCandidate({ get, pull, product, botId, candidate, configuration }) {
  if (!pull || !hasLabel(pull, officialPending) || !fitsOfficialEvent(pull.body ?? '')) return null;
  const commit = await get('git/commits/' + pull.head.sha);
  const parent = commit.parents?.[0]?.sha;
  if (commit.sha !== pull.head.sha || commit.parents?.length !== 1 || !sha(parent) ||
    commit.message.includes('Steward-Candidate-Round:') ||
    !await verifyCandidateFiles(get, parent, pull.head.sha, candidate)) return null;
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

export function verifyCandidateDraft(candidate, draft, roundId) {
  requireCandidate(typeof draft?.body === 'string' && fitsOfficialEvent(draft.body), 'C1_BODY_LIMIT');
  const parsed = officialNotes(draft.body);
  requireCandidate(parsed.version === candidate.version, 'C1_VERSION');
  requireCandidate(draft.body.endsWith(officialRoundMarker(roundId)), 'C1_ROUND');
  return parsed;
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
    const parent = current.parents?.[0]?.sha;
    if (current.message === candidate.title + '\n\n' + commitMarker(roundId)) {
      requireCandidate(current.sha === currentHead && current.parents?.length === 1 && sha(parent) &&
        current.verification?.verified === true && await verifyCandidateFiles(get, parent, currentHead, candidate), 'BRANCH_READBACK');
      return { head: currentHead, sourceSha: parent };
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

async function settlePull({ get, request, admit, sourceSha, product, botId, roundId, round, branch, configuration }) {
  const { candidate, prior } = round.source;
  const appliedRound = pull => typeof pull?.body === 'string' && pull.body.includes(officialRoundMarker(roundId));
  let pull = await openOfficialPull(get, product, botId);
  requireCandidate(pull ? pull.head.sha === branch.head && (prior ? pull.number === prior.number : appliedRound(pull)) : !prior,
    'PRIOR_PULL_DRIFT');
  if (!appliedRound(pull)) {
    await admit();
    requireCandidate(await readBranch(get, candidate.head) === branch.head &&
      await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
    let mutationError;
    const fields = { title: candidate.title, body: round.draft.body };
    try {
      if (prior) await request('PATCH', 'pulls/' + prior.number, fields);
      else await request('POST', 'pulls', { ...fields, head: candidate.head, base: candidate.base, draft: false });
    } catch (error) { mutationError = error; }
    pull = await openOfficialPull(get, product, botId);
    if (!appliedRound(pull) && mutationError?.status && mutationError.status < 500) throw mutationError;
    requireCandidate(appliedRound(pull) && pull.head.sha === branch.head && (!prior || prior.number === pull.number), 'PULL_WRITE_UNKNOWN');
  }
  if (!hasLabel(pull, officialPending)) {
    await admit();
    let mutationError;
    try { await request('POST', 'issues/' + pull.number + '/labels', { labels: candidate.labels }); }
    catch (error) { mutationError = error; }
    pull = await get('pulls/' + pull.number);
    if (!hasLabel(pull, officialPending) && mutationError?.status && mutationError.status < 500) throw mutationError;
    requireCandidate(hasLabel(pull, officialPending), 'LABEL_WRITE_UNKNOWN');
  }
  const actual = verifyOfficialPull(pull, product, pull.number, botId, configuration, await readOfficialManifest(get, branch.head));
  return { number: pull.number, head: branch.head, bodyDigest: actual.bodyDigest };
}

export async function writeOfficialCandidate(options) {
  const { round, roundId, sourceSha, product, get, save, admit } = options;
  if (round.pull) return round.pull;
  verifyCandidateDraft(round.source.candidate, round.draft, roundId);
  await admit();
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
  const branch = await settleBranch(options);
  if (!round.branch) await save('branch', branch);
  const pull = await settlePull({ ...options, branch });
  await save('pull', pull);
  return pull;
}
