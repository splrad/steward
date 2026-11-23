import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { EvidenceReadError, NativeEvidenceReader, nativeEvidenceTransport, nativeGhCommand } from '../packages/runner/dist/index.js';

const candidatePrefix = 'release-please--branches--';
const pending = 'autorelease: pending';
const tagged = 'autorelease: tagged';
const configPath = 'release-please-config.json';
const manifestPath = '.release-please-manifest.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{40}$/;
const id = value => Number.isSafeInteger(value) && value > 0;
const requireFact = (value, code) => { if (!value) throw new Error('OFFICIAL_RELEASE_' + code); };
const logger = Object.fromEntries(['trace','debug','info','warn','error'].map(level => [level, () => {}]));
const releaseIsPrerelease = (config, version) =>
  (config.packages?.['.']?.prerelease ?? config.prerelease) === true && (version.includes('-') || version.startsWith('0.'));

async function officialCore() {
  const core = await import('release-please-official');
  requireFact(core.VERSION === '17.6.0', 'CORE_VERSION');
  return core;
}

/** Use the same body parser as the single-root official release strategy. */
export async function approvedOfficialBody(pullBody) {
  await officialCore();
  const { PullRequestBody } = await import('release-please-official/build/src/util/pull-request-body.js');
  const parsed = PullRequestBody.parse(pullBody, logger);
  const [section] = parsed?.releaseData ?? [];
  requireFact(parsed?.useComponents === false && parsed.releaseData.length === 1 && !section.component && section.version
    && section.notes.trim(), 'BODY_FORMAT');
  return section.notes;
}

async function buildReleases(approval, token) {
  const { GitHub, Manifest } = await officialCore();
  const [owner, repo] = approval.repository.split('/');
  const github = await GitHub.create({ owner, repo, token, defaultBranch: approval.defaultBranch, logger });
  const manifest = await Manifest.fromManifest(github, approval.defaultBranch, configPath, manifestPath, { logger });
  return manifest.buildReleases();
}

export function approvedCycleTarget({ repository, repositoryId, appBotId, cycle }, defaultBranch) {
  requireFact(cycle.officialRelease && cycle.workflowDelivery && cycle.units.length === 1
    && !cycle.units[0].githubDisabled && !cycle.freezeOnly
    && /^splrad\/[A-Za-z0-9_.-]+$/.test(repository) && !repository.endsWith('/.') && !repository.endsWith('/..')
    && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(defaultBranch) && !defaultBranch.includes('..')
    && id(repositoryId) && id(appBotId), 'APPROVAL');
  const unit = cycle.units[0];
  return {
    repository, repositoryId, appBotId, defaultBranch, prNumber: cycle.prNumber, sourceSha: cycle.sourceSha,
    unitId: unit.id, tag: unit.tag, version: unit.version, releaseId: unit.releaseId, ...cycle.officialRelease,
  };
}

async function scopedReader(approval, token) {
  requireFact(token, 'TOKEN');
  const repositories = JSON.parse(await nativeGhCommand(['api','installation/repositories?per_page=100'], token));
  requireFact(repositories.total_count === 1 && repositories.repositories?.length === 1
    && repositories.repositories[0].id === approval.repositoryId && repositories.repositories[0].full_name === approval.repository, 'TOKEN_SCOPE');
  return new NativeEvidenceReader(nativeEvidenceTransport(token), approval.repository);
}

async function nativeFile(reader, path, ref) {
  const result = await reader.json(`contents/${path}?ref=${encodeURIComponent(ref)}`);
  const bytes = Buffer.from(result.content ?? '', 'base64');
  requireFact(result.type === 'file' && result.path === path && result.encoding === 'base64' && result.size === bytes.length
    && sha.test(result.sha) && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === result.sha, 'CONFIG_SOURCE');
  return { digest: hash(bytes), value: JSON.parse(bytes.toString('utf8')) };
}
export async function sourceUsesOfficialRelease(reader, ref) {
  requireFact(sha.test(ref), 'CONFIG_SOURCE');
  const {value} = await nativeFile(reader, configPath, ref);
  requireFact(typeof value?.['separate-pull-requests'] === 'boolean', 'CONFIG_SOURCE');
  return value['separate-pull-requests'];
}

async function approvalFacts(approval, reader, parseBody, compare) {
  const { repository, repositoryId, defaultBranch, prNumber, sourceSha, headSha, appBotId } = approval;
  const [repo, pull, branch, comparison] = await Promise.all([
    reader.json(''), reader.json(`pulls/${prNumber}`),
    reader.json(`git/ref/heads/${encodeURIComponent(defaultBranch)}`),
    compare(),
  ]);
  requireFact(repo.id === repositoryId && repo.full_name === repository && repo.default_branch === defaultBranch
    && repo.archived === false && repo.disabled === false, 'REPOSITORY');
  requireFact(pull.number === prNumber && pull.state === 'closed' && pull.merged === true && typeof pull.merged_at === 'string'
    && pull.base?.ref === defaultBranch && pull.base?.repo?.id === repositoryId && pull.head?.repo?.id === repositoryId
    && pull.head?.ref === candidatePrefix + defaultBranch && pull.head?.sha === headSha
    && pull.user?.id === appBotId && pull.user?.type === 'Bot' && pull.merge_commit_sha === sourceSha, 'MERGED_PULL');
  requireFact(typeof pull.body === 'string' && hash(pull.body) === approval.pullBodyDigest, 'PULL_BODY_DRIFT');
  const body = await parseBody(pull.body);
  requireFact(hash(body) === approval.bodyDigest, 'BODY_DIGEST');
  requireFact(branch.ref === `refs/heads/${defaultBranch}` && branch.object?.type === 'commit' && sha.test(branch.object.sha)
    && ['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === sourceSha, 'SOURCE_ANCESTRY');
  const [merged, live, mergedManifest, liveManifest] = await Promise.all([
    nativeFile(reader, configPath, sourceSha), nativeFile(reader, configPath, branch.object.sha),
    nativeFile(reader, manifestPath, sourceSha), nativeFile(reader, manifestPath, branch.object.sha),
  ]);
  requireFact(merged.digest === live.digest && mergedManifest.digest === liveManifest.digest, 'CONFIG_DRIFT');
  const config = live.value, root = config.packages?.['.'];
  requireFact(root && Object.keys(config.packages).length === 1 && config['separate-pull-requests'] === true
    && ['label', 'release-label'].every(key => config[key] === undefined) && root['skip-github-release'] !== true
    && (root.draft ?? config.draft) === true && root['force-tag-creation'] === true
    && liveManifest.value?.['.'] === approval.version && Object.keys(liveManifest.value).length === 1, 'ROOT_CONFIG');
  const prerelease = releaseIsPrerelease(config, approval.version);
  requireFact(Array.isArray(pull.labels) && pull.labels.every(label => typeof label.name === 'string'), 'LABELS');
  const labels = pull.labels.map(label => label.name);
  return { body, prerelease, configDigest: live.digest, manifestDigest: liveManifest.digest,
    pending: labels.includes(pending), tagged: labels.includes(tagged) };
}

async function tagCommit(approval, reader) {
  const tag = encodeURIComponent(approval.tag);
  let ref;
  try { ref = await reader.json(`git/ref/tags/${tag}`); }
  catch (error) {
    if (!(error instanceof EvidenceReadError) || error.status !== 404) throw error;
    const refs = await reader.json(`git/matching-refs/tags/${tag}`);
    requireFact(Array.isArray(refs) && !refs.some(item => item.ref === `refs/tags/${approval.tag}`), 'TAG_ABSENCE');
    return null;
  }
  requireFact(ref.ref === `refs/tags/${approval.tag}`, 'TAG_IDENTITY');
  let object = ref.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    requireFact(sha.test(object.sha) && !visited.has(object.sha) && visited.size < 8, 'TAG_CHAIN');
    visited.add(object.sha);
    const next = await reader.json(`git/tags/${object.sha}`);
    requireFact(next.sha === object.sha, 'TAG_IDENTITY');
    object = next.object;
  }
  requireFact(object?.type === 'commit' && object.sha === approval.sourceSha, 'TAG_SOURCE');
  return object.sha;
}

async function releaseInventory(approval, facts, reader) {
  const [releases, refs] = await Promise.all([
    reader.pages('releases', ''), reader.json('git/matching-refs/tags'),
  ]);
  requireFact(releases.every(release => id(release.id) && typeof release.tag_name === 'string')
    && new Set(releases.map(release => release.id)).size === releases.length, 'INVENTORY');
  const matches = releases.filter(release => release.tag_name === approval.tag);
  requireFact(matches.length <= 1 && (approval.releaseId === null || matches[0]?.id === approval.releaseId), 'DUPLICATE_OR_REPLACED');
  const unrelated = releases.filter(release => release.tag_name !== approval.tag)
    .map(release => [release.id, release.tag_name, release.draft]).sort((a, b) => a[0] - b[0]);
  requireFact(Array.isArray(refs) && refs.every(ref=>ref.ref?.startsWith('refs/tags/') && sha.test(ref.object?.sha)
    && ['tag','commit','blob','tree'].includes(ref.object?.type)) && new Set(refs.map(ref=>ref.ref)).size===refs.length, 'TAG_INVENTORY');
  const tagRef = `refs/tags/${approval.tag}`;
  const otherTags = refs.filter(ref=>ref.ref!==tagRef).map(ref=>[ref.ref,ref.object.type,ref.object.sha]).sort();
  const tag = await tagCommit(approval, reader);
  requireFact(Boolean(tag) === refs.some(ref=>ref.ref===tagRef), 'TAG_INVENTORY');
  let release = null;
  if (matches.length) {
    release = await reader.json(`releases/${matches[0].id}`);
    requireFact(tag && release.id === matches[0].id && release.tag_name === approval.tag && release.author?.id === approval.appBotId
      && release.target_commitish === approval.sourceSha && release.body === facts.body && release.prerelease === facts.prerelease
      && release.draft === true && release.immutable === false, 'DRAFT_IDENTITY');
  }
  return { releaseId: release?.id ?? null, existingTag: tag, othersDigest: hash(JSON.stringify([unrelated, otherTags])) };
}

function enumerate(approval, facts, releases, existing) {
  requireFact(Array.isArray(releases) && releases.length <= 1, 'BRANCH_SCOPE');
  if (!releases.length) {
    requireFact(existing, 'APPROVED_PULL_MISSING');
    return;
  }
  const [found] = releases;
  requireFact(found.path === '.' && found.pullRequest?.number === approval.prNumber && found.sha === approval.sourceSha
    && found.tag?.toString() === approval.tag && found.tag?.version?.toString() === approval.version && found.notes === facts.body
    && found.draft === true && found.forceTag === true && (found.prerelease ?? false) === facts.prerelease, 'BRANCH_SCOPE');
}

export function officialActionOutput(output, approval, releaseId) {
  if (!output || ![output.id, output.tag, output.sha].some(Boolean)) return;
  requireFact(output.id === String(releaseId) && output.tag === approval.tag && output.sha === approval.sourceSha, 'ACTION_OUTPUT');
}

/** Compare native facts on both sides of the same-version branch scan. */
export async function inspectOfficialRelease(approval, { reader, scan, compare, parseBody = approvedOfficialBody, previous, output, scopeDigest }) {
  const snapshot = async () => {
    const facts = await approvalFacts(approval, reader, parseBody, compare);
    return { ...facts, ...await releaseInventory(approval, facts, reader) };
  };
  const before = await snapshot();
  if (scopeDigest !== undefined) requireFact(before.othersDigest === scopeDigest, 'RECORDED_SCOPE_DRIFT');
  if (previous) {
    requireFact(before.releaseId !== null && before.othersDigest === previous.othersDigest
      && before.configDigest === previous.configDigest && before.manifestDigest === previous.manifestDigest
      && (previous.releaseId === null || previous.releaseId === before.releaseId), 'AFTER_ACTION_DRIFT');
    officialActionOutput(output, approval, before.releaseId);
  } else if (!before.releaseId) requireFact(before.pending && !before.tagged, 'PENDING_LIFECYCLE');
  enumerate(approval, before, await scan(), before.releaseId !== null);
  requireFact(JSON.stringify(before) === JSON.stringify(await snapshot()), 'SCAN_DRIFT');
  return before;
}

function compareSource(approval, token) {
  const path = `repos/${approval.repository}/compare/${approval.sourceSha}...${encodeURIComponent(approval.defaultBranch)}?per_page=1`;
  return async () => JSON.parse(await nativeGhCommand(['api', path], token));
}

export async function readOfficialBody(approval, token) {
  const reader = await scopedReader(approval, token);
  return (await approvalFacts(approval, reader, approvedOfficialBody, compareSource(approval, token))).body;
}

export async function readOfficialScope(approval, token, body) {
  const reader = await scopedReader(approval, token);
  const config = await nativeFile(reader, configPath, approval.sourceSha);
  const snapshot = await releaseInventory(approval, {body, prerelease:releaseIsPrerelease(config.value, approval.version)}, reader);
  requireFact(snapshot.releaseId===null && snapshot.existingTag===null, 'OBJECT_WITHOUT_SCOPE_RECEIPT');
  return snapshot.othersDigest;
}

/** The durable ID already passed the branch-wide Action check in its original attempt. */
export async function readBoundOfficialDraft(approval, reader) {
  requireFact(id(approval.releaseId), 'BOUND_DRAFT_REQUIRED');
  const [config, release] = await Promise.all([
    nativeFile(reader, configPath, approval.sourceSha), reader.json(`releases/${approval.releaseId}`),
  ]);
  requireFact(typeof release.body==='string' && hash(release.body)===approval.bodyDigest, 'DRAFT_IDENTITY');
  const prerelease=releaseIsPrerelease(config.value,approval.version);
  const current=await releaseInventory(approval,{body:release.body,prerelease},reader);
  requireFact(current.releaseId===approval.releaseId, 'DRAFT_IDENTITY');
  return {body:release.body,prerelease,releaseId:approval.releaseId};
}

export async function prepareOfficialAction(approval, token, stateHead, scopeDigest) {
  const reader = await scopedReader(approval, token);
  requireFact(/^[a-f0-9]{64}$/.test(scopeDigest), 'SCOPE_RECEIPT_REQUIRED');
  const verifyState = async () => {
    const state = await reader.json('git/ref/heads/steward/release-state');
    requireFact(sha.test(stateHead) && state.ref === 'refs/heads/steward/release-state'
      && state.object?.type === 'commit' && state.object.sha === stateHead, 'STATE_DRIFT');
  };
  await verifyState();
  const facts = await inspectOfficialRelease(approval, { reader, compare: compareSource(approval, token), scan: () => buildReleases(approval, token),
    ...(approval.releaseId===null?{scopeDigest}:{}) });
  await verifyState();
  return { ...facts, body: undefined };
}

export async function reconcileOfficialLifecycle(read, removePending, addTagged) {
  let facts = await read();
  if (facts.pending) {
    try { await removePending(); } catch { /* Confirm the original PR before continuing. */ }
    facts = await read();
    requireFact(!facts.pending, 'LIFECYCLE_RECOVERY');
  }
  if (!facts.tagged) {
    try { await addTagged(); } catch { /* Confirm the original PR before continuing. */ }
    facts = await read();
    requireFact(facts.tagged && !facts.pending, 'LIFECYCLE_RECOVERY');
  }
  return facts;
}

export async function finishOfficialAction(approval, token, previous, output) {
  requireFact(previous, 'PREFLIGHT_REQUIRED');
  const reader = await scopedReader(approval, token);
  const read = () => inspectOfficialRelease(approval, { reader, compare: compareSource(approval, token), scan: () => buildReleases(approval, token), previous, output });
  const path = `repos/${approval.repository}/issues/${approval.prNumber}/labels`;
  const facts=await reconcileOfficialLifecycle(read,
    ()=>nativeGhCommand(['api','--method','DELETE',`${path}/${encodeURIComponent(pending)}`], token),
    ()=>nativeGhCommand(['api','--method','POST',path,'-f',`labels[]=${tagged}`], token));
  return { body: facts.body, prerelease: facts.prerelease, releaseId: facts.releaseId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { approval, stateHead, scopeDigest } = JSON.parse(await readFile('official-release-plan.json', 'utf8'));
    const facts = await prepareOfficialAction(approval, process.env.OFFICIAL_RELEASE_TOKEN, stateHead, scopeDigest);
    await writeFile('official-release-preflight.json', JSON.stringify({ approval, facts }) + '\n', { flag: 'wx' });
    await appendFile(process.env.GITHUB_OUTPUT, `create=${facts.releaseId === null}\n`);
  } catch (error) {
    console.error(/^OFFICIAL_RELEASE_[A-Z_]+$/.test(error?.message) ? error.message : 'OFFICIAL_RELEASE_PREFLIGHT_UNAVAILABLE');
    process.exitCode = 1;
  }
}
