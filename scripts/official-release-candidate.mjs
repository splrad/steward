import { createHash } from 'node:crypto';
import { GitHub, Manifest } from 'release-please';
import { PullRequestBody } from 'release-please-official/build/src/util/pull-request-body.js';
import { PullRequestTitle } from 'release-please-official/build/src/util/pull-request-title.js';
import { TagName } from 'release-please-official/build/src/util/tag-name.js';
import { Version } from 'release-please-official/build/src/version.js';
import { assertDeliveryPath, assertVersionAcquisitionLinks, EvidenceReadError, generateOfficialCandidateNotes,
  parseDeliveryConfig, renderConditionalNotes, selectReleaseContributors } from '../packages/runner/dist/index.js';

export const officialPending = 'autorelease: pending';
export const officialTagged = 'autorelease: tagged';
export const officialBodyLimit = 65_536;
export const fitsOfficialEvent = body => body.length <= officialBodyLimit && Buffer.byteLength(JSON.stringify({body})) <= 63_000;

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const normalized = body => body.replace(/\r\n/g, '\n');
export const bodyDigest = text => createHash('sha256').update(text).digest('hex');
export function requireCandidate(value, code) {
  if (!value) throw Error('OFFICIAL_CANDIDATE_' + code);
}
export const hasLabel = (pull, name) => Array.isArray(pull.labels) && pull.labels.some(label => label.name === name);
export const officialRef = (ref, base) => ref === 'release-please--branches--' + base;

export function officialNotes(body) {
  requireCandidate(typeof body === 'string', 'BODY');
  const lines = normalized(body).trim().split('\n');
  const first = lines.indexOf('---'), last = lines.lastIndexOf('---');
  requireCandidate(first >= 0 && last > first, 'BOUNDARIES');
  const content = lines.slice(first + 1, last).join('\n').trim();
  let parsed;
  try {
    parsed = PullRequestBody.parse(body, logger);
  } catch {
    throw Error('OFFICIAL_CANDIDATE_BODY_PARSE');
  }
  const data = parsed?.releaseData;
  requireCandidate(parsed?.useComponents === false && data?.length === 1 &&
    data[0].version && data[0].notes === content && content.includes('\n'), 'BODY_PARSE');
  return { version: data[0].version.toString(), body: content, bodyDigest: bodyDigest(content) };
}

export const officialRoundMarker = roundId => '<!-- steward-candidate-round:' + roundId + ' -->';

export function renderOfficialHomepage({ upstreamBody, template, notes, sourceLink, contributors, roundId }) {
  const upstream = officialNotes(upstreamBody);
  const lines = normalized(upstreamBody).trim().split('\n');
  const first = lines.indexOf('---'), last = lines.lastIndexOf('---');
  const header = lines.slice(0, first + 1).join('\n');
  const footer = lines.slice(last + 1).join('\n').trim();
  const versionHeading = upstream.body.split('\n', 1)[0];
  const notesBody = renderConditionalNotes(template, notes, sourceLink, contributors).trimEnd();
  const expected = versionHeading + '\n\n' + notesBody;
  const result = [header + '\n\n' + expected + '\n\n---', footer, officialRoundMarker(roundId)]
    .filter(Boolean).join('\n\n');
  requireCandidate(fitsOfficialEvent(result), 'BODY_LIMIT');
  const readback = officialNotes(result);
  requireCandidate(readback.body === expected && readback.version === upstream.version, 'RENDER_PARSE');
  return result;
}

export function officialCandidateRoundId(product, { baseline, candidate }) {
  return bodyDigest(JSON.stringify([product.id, candidate.base, baseline.tag, baseline.sha, candidate.title,
    candidate.head, candidate.version, candidate.body, candidate.labels, candidate.files.map(file => [file.path, file.mode, file.content])]));
}

export async function candidateBaseline(get, product, sourceSha, configuration, manifest) {
  const prior = manifest['.'];
  const tag = prior ? officialUnit(configuration, 'release-please--branches--' + product.defaultBranch,
    product.defaultBranch, prior).tag : null;
  let taggedSha = null;
  if (tag) {
    try {
      taggedSha = (await get('commits/' + encodeURIComponent('tags/' + tag))).sha;
      requireCandidate(sha(taggedSha), 'BASELINE');
    } catch (error) {
      if (!(error instanceof EvidenceReadError && error.status === 404)) throw error;
    }
  }
  const boundary = configuration['last-release-sha'] ?? taggedSha ?? configuration['bootstrap-sha'] ?? null;
  requireCandidate(!boundary || sha(boundary), 'BASELINE');
  if (boundary && boundary !== sourceSha) {
    const comparison = await get('compare/' + boundary + '...' + sourceSha + '?per_page=1');
    requireCandidate(comparison.merge_base_commit?.sha === boundary && comparison.status === 'ahead', 'BASELINE');
  }
  return { tag: taggedSha ? tag : null, sha: boundary };
}

export async function computeOfficialCandidate({ product, sourceSha, configuration, get, token, openManifest }) {
  const [owner, repo] = product.name.split('/');
  const defaultOpen = async () => {
    const github = await GitHub.create({ owner, repo, token, defaultBranch: product.defaultBranch, logger });
    const manifest = await Manifest.fromManifest(github, product.defaultBranch, configPath, manifestPath, { logger });
    return { github, manifest };
  };
  const { github, manifest } = await (openManifest ?? defaultOpen)();
  const strategies = await manifest.getStrategiesByPath();
  requireCandidate(Object.keys(strategies).length === 1 && strategies['.'] &&
    !(await strategies['.'].getBranchComponent()), 'ROOT_BRANCH');
  const candidates = await manifest.buildPullRequests();
  if (!candidates.length) {
    requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'SOURCE_CHANGED');
    return null;
  }
  requireCandidate(candidates.length === 1, 'ROOT_CANDIDATE');
  const [raw] = candidates;
  const title = raw.title.toString();
  const body = raw.body.toString();
  const version = raw.version?.toString();
  const head = raw.headRefName;
  const labels = [...raw.labels].sort();
  const { unit } = officialUnit(configuration, head, product.defaultBranch, version);
  const parsed = PullRequestTitle.parse(title, unit['pull-request-title-pattern'], unit['component-no-space'], logger);
  requireCandidate(!raw.draft && labels.length === 1 && labels[0] === officialPending &&
    officialNotes(body).version === version && parsed?.getVersion()?.toString() === version &&
    (!parsed.getTargetBranch() || parsed.getTargetBranch() === product.defaultBranch), 'RAW_CANDIDATE_VERSION');
  const changes = await github.buildChangeSet(raw.updates, sourceSha);
  const files = [...changes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, change]) => {
    assertDeliveryPath(path);
    requireCandidate(!path.split('/').some(part => part.toLowerCase() === '.git') &&
      ['100644', '100755'].includes(change.mode) && typeof change.content === 'string' &&
      Buffer.from(change.content).toString('utf8') === change.content, 'UPDATE_FILE');
    return { path, mode: change.mode, content: change.content };
  });
  const versions = files.find(file => file.path === manifestPath);
  requireCandidate(versions && JSON.parse(versions.content)['.'] === version && files.length > 1, 'UPDATE_MANIFEST');
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'SOURCE_CHANGED');
  return { title, head, base: product.defaultBranch, body, version, files, labels };
}

export function officialConfig(settings) {
  return settings?.['separate-pull-requests'] === true;
}

export function officialRootSettings(settings) {
  const packages = settings?.packages;
  const root = packages?.['.'];
  if (!officialConfig(settings) || !root || typeof root !== 'object' || Array.isArray(root) ||
      Object.keys(packages).length !== 1 || ['group-pull-request-title-pattern', 'label', 'release-label']
        .some(key => settings[key] !== undefined || root[key] !== undefined)) return null;
  if ((root.draft ?? settings.draft) !== true ||
      (root['force-tag-creation'] ?? settings['force-tag-creation']) !== true ||
      (root['skip-github-release'] ?? settings['skip-github-release']) ||
      (root['draft-pull-request'] ?? settings['draft-pull-request'])) return null;
  return { ...settings, ...root, path: '.' };
}

function officialUnit(settings, ref, base, version) {
  const unit = officialRootSettings(settings);
  requireCandidate(unit, 'ROOT_CONFIG');
  requireCandidate(officialRef(ref, base), 'BRANCH');
  const tag = value => new TagName(Version.parse(value), undefined, unit['tag-separator'],
    unit['include-v-in-tag'] ?? true).toString();
  return { unit, tag: tag(version) };
}

export function pullBinding(pull, product, number, botId) {
  requireCandidate(pull.number === number && pull.user?.id === botId &&
    pull.head?.repo?.id === product.id && pull.base?.repo?.id === product.id &&
    pull.base.ref === product.defaultBranch && officialRef(pull.head.ref, product.defaultBranch) &&
    sha(pull.head.sha) && typeof pull.title === 'string', 'PR_IDENTITY');
}

export function verifyOfficialPull(pull, product, number, botId, settings, manifest, body = pull.body) {
  pullBinding(pull, product, number, botId);
  const notes = officialNotes(body);
  const { unit, tag } = officialUnit(settings, pull.head.ref, product.defaultBranch, notes.version);
  const title = PullRequestTitle.parse(pull.title, unit['pull-request-title-pattern'], unit['component-no-space'], logger);
  requireCandidate(title?.getVersion()?.toString() === notes.version && manifest[unit.path] === notes.version &&
    (!title.getTargetBranch() || title.getTargetBranch() === product.defaultBranch), 'VERSION');
  return { ...notes, path: unit.path, tag };
}

export async function readSourceFile(get, path, ref) {
  const file = await get('contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + ref);
  requireCandidate(file?.path === path && file.type === 'file' && file.encoding === 'base64' &&
    typeof file.content === 'string' && sha(file.sha), 'FILE');
  const bytes = Buffer.from(file.content, 'base64');
  requireCandidate(bytes.length === file.size && createHash('sha1').update('blob ' + bytes.length + '\0')
    .update(bytes).digest('hex') === file.sha, 'BLOB');
  return bytes;
}
export const configPath = 'release-please-config.json';
export const manifestPath = '.release-please-manifest.json';
export const deliveryPath = '.github/delivery.json';
const readJson = async (get, path, ref) => JSON.parse(await readSourceFile(get, path, ref));
export const readOfficialConfig = (get, ref) => readJson(get, configPath, ref);
export const readOfficialManifest = (get, ref) => readJson(get, manifestPath, ref);
export const readOfficialDelivery = (get, ref) => readJson(get, deliveryPath, ref);
export const defaultHead = async (get, branch) => {
  const ref = await get('git/ref/heads/' + encodeURIComponent(branch));
  requireCandidate(ref.ref === 'refs/heads/' + branch && ref.object?.type === 'commit' && sha(ref.object.sha), 'DEFAULT_REF');
  return ref.object.sha;
};

export function officialMergeKey(event) {
  return bodyDigest(JSON.stringify([event.repositoryId, event.kind, event.prNumber, event.sourceSha, event.head]));
}

export function validateOfficialMergeEvent(event, product, key) {
  requireCandidate(Object.keys(event).sort().join(',') === 'body,head,kind,mergedAt,prNumber,repositoryId,sourceSha,title'
    && event.kind === 'official-merge' && event.repositoryId === product.id && positive(event.prNumber)
    && sha(event.sourceSha) && sha(event.head) && typeof event.title === 'string' && typeof event.body === 'string'
    && Number.isFinite(Date.parse(event.mergedAt)) && officialMergeKey(event) === key, 'MERGE_EVENT');
}

export async function verifyOfficialMerge(event, product, get, botId) {
  const [pull, configuration, manifest, head] = await Promise.all([
    get('pulls/' + event.prNumber), readSourceFile(get, configPath, event.sourceSha),
    readOfficialManifest(get, event.sourceSha), defaultHead(get, product.defaultBranch),
  ]);
  requireCandidate(pull.state === 'closed' && pull.merged === true && pull.merged_at === event.mergedAt &&
    pull.merge_commit_sha === event.sourceSha && pull.head?.sha === event.head &&
    (hasLabel(pull, officialPending) || hasLabel(pull, officialTagged)), 'MERGE_IDENTITY');
  if (head !== event.sourceSha) {
    const comparison = await get('compare/' + event.sourceSha + '...' + head + '?per_page=1');
    requireCandidate(comparison.merge_base_commit?.sha === event.sourceSha && comparison.status === 'ahead', 'MERGE_SOURCE');
  }
  const settings = JSON.parse(configuration);
  const frozen = verifyOfficialPull({...pull, title: event.title}, product, event.prNumber, botId, settings, manifest, event.body);
  const current = verifyOfficialPull(pull, product, event.prNumber, botId, settings, manifest);
  requireCandidate(current.bodyDigest === frozen.bodyDigest, 'MERGE_BODY_DRIFT');
  const { path, version, tag, body, bodyDigest: digest } = frozen;
  return { repositoryId: product.id, repository: product.name, defaultBranch: product.defaultBranch,
    prNumber: pull.number, candidateHead: event.head, sourceSha: event.sourceSha, mergedAt: event.mergedAt,
    authorId: botId, configDigest: bodyDigest(configuration), path, version, tag, body,
    pullBodyDigest: bodyDigest(event.body), bodyDigest: digest };
}

async function rangeCommits(get, sourceSha, priorSha) {
  if (!priorSha) {
    const result = await pages(get, 'commits?sha=' + sourceSha);
    requireCandidate(result[0]?.sha === sourceSha && result.every(c => sha(c.sha)) &&
      new Set(result.map(c => c.sha)).size === result.length, 'RANGE');
    return result;
  }
  const comparison = 'compare/' + priorSha + '...' + sourceSha;
  const result = [];
  let total;
  for (let page = 1; page <= 100; page++) {
    const value = await get(comparison + '?per_page=100&page=' + page);
    requireCandidate(value.base_commit?.sha === priorSha && value.merge_base_commit?.sha === priorSha
      && ['ahead', 'identical'].includes(value.status) && Number.isSafeInteger(value.total_commits)
      && Array.isArray(value.commits), 'RANGE');
    total ??= value.total_commits;
    requireCandidate(value.total_commits === total, 'RANGE');
    result.push(...value.commits);
    if (value.commits.length < 100 || result.length === total) break;
  }
  requireCandidate(result.length === total && result.every(c => sha(c.sha)) &&
    new Set(result.map(c => c.sha)).size === result.length, 'RANGE');
  return result;
}
export async function pages(get, path, field) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const value = await get(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    const rows = field ? value?.[field] : value;
    requireCandidate(Array.isArray(rows) && rows.length <= 100, 'PAGES');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw Error('OFFICIAL_CANDIDATE_PAGES');
}

async function optionalEvidence(read) {
  try { return await read(); }
  catch (error) {
    if (!(error instanceof EvidenceReadError && error.status === 404)) throw error;
    return null;
  }
}

const filterPatch = file => ({
  path: file.filename, previousPath: file.previous_filename ?? null, status: file.status,
  patch: typeof file.patch === 'string' ? file.patch : null,
});

export async function officialCandidateEvidence({ product, sourceSha, baseline, candidate, get }) {
  const configuration = await readOfficialConfig(get, sourceSha);
  const { unit: release, tag } = officialUnit(configuration, candidate.head, candidate.base, candidate.version);
  const path = release.path;
  const repository = 'https://github.com/' + product.name;
  const [commits, delivery, tree, previous] = await Promise.all([
    rangeCommits(get, sourceSha, baseline.sha),
    readOfficialDelivery(get, sourceSha),
    get('git/trees/' + sourceSha + '?recursive=1'),
    baseline.tag ? optionalEvidence(() => get('releases/tags/' + encodeURIComponent(baseline.tag))) : null,
  ]);
  const { units, buildWorkflow } = parseDeliveryConfig(delivery, configuration);
  const unit = units.find(unit => unit.path === path);
  requireCandidate(unit && tree.truncated === false && Array.isArray(tree.tree), 'CONTENT_SOURCE');
  const files = tree.tree.filter(file => file.type === 'blob' && ['100644', '100755'].includes(file.mode));
  const docPaths = files.map(file => file.path).filter(path =>
    /^README\.(?:md|rst|adoc)$/i.test(path) ||
    /^docs\/(?:product\/|.*(?:install|setup|download|upgrade|migrat|usage|getting-started)).*\.(?:md|mdx|rst|adoc)$/i.test(path));
  const deliveryPaths = files.map(file => file.path).filter(path =>
    path === buildWorkflow || /^(?:scripts|tools)\/(?:.*\/)?(?:Publish|Select)-ReleaseAssets\.[A-Za-z0-9]+$/i.test(path));
  const paths = [...new Set([...docPaths, ...deliveryPaths, unit.notesPath])].filter(path => files.some(file => file.path === path));
  const associated = new Map();
  const diffs = [];
  for (const commit of commits) {
    const refs = await pages(get, 'commits/' + commit.sha + '/pulls');
    for (const pull of refs) {
      if (positive(pull.number) && pull.merged_at && pull.base?.repo?.id === product.id && pull.base.ref === candidate.base) {
        associated.set(pull.number, pull);
      }
    }
    if (!refs.some(pull => associated.has(pull.number))) {
      const changed = await pages(get, 'commits/' + commit.sha, 'files');
      diffs.push({ kind: 'commit-diff', details: { sha: commit.sha, files: changed.map(filterPatch) } });
    }
  }
  const pulls = [];
  for (const [number, pull] of associated) {
    const changes = await pages(get, 'pulls/' + number + '/files');
    pulls.push({ kind: 'merged-pull-request', details: {
      number, url: pull.html_url, title: pull.title, body: pull.body, files: changes.map(filterPatch),
    } });
  }
  const actors = commits.map(commit => commit.author ? { id: commit.author.id, login: commit.author.login,
    type: commit.author.type, profileUrl: commit.author.html_url, avatarUrl: commit.author.avatar_url } : null);
  const { contributors } = selectReleaseContributors(actors, [], 'github-authors');
  const sourceLink = baseline.sha ? { label: '查看本版变更', url: repository + '/compare/' + baseline.sha + '...' + sourceSha }
    : { label: '查看本版源码', url: repository + '/tree/' + sourceSha };
  const docs = await Promise.all(paths.map(async path => ({
    kind: deliveryPaths.includes(path) ? 'product-delivery-source' : 'product-documentation',
    details: { path, text: (await readSourceFile(get, path, sourceSha)).toString('utf8') },
  })));
  return {
    tag, sourceLink, contributors, unit: { id: unit.id, path, version: candidate.version, tag },
    evidence: [
      { kind: 'official-candidate', details: {
        sourceSha, baseline, body: candidate.body, version: candidate.version, title: candidate.title,
        files: candidate.files.map(file => ({ path: file.path, digest: bodyDigest(file.content) })),
        commits: commits.map(commit => ({ sha: commit.sha, message: commit.commit?.message })),
      } },
      ...pulls, ...diffs, ...docs,
      ...(previous ? [{ kind: 'previous-release', details: { tag: previous.tag_name, draft: previous.draft, body: previous.body } }] : []),
      { kind: 'delivery', details: { expectedReleasePage: repository + '/releases/tag/' + tag, declaration: delivery } },
    ],
  };
}

export async function draftOfficialCandidate({ roundId, candidate, context, product, sourceSha, template, call }) {
  const notes = await generateOfficialCandidateNotes({ unit: context.unit, evidence: context.evidence, call });
  assertVersionAcquisitionLinks(notes, product.name, context.tag, sourceSha);
  const body = renderOfficialHomepage({ upstreamBody: candidate.body, template, notes, sourceLink: context.sourceLink,
    contributors: context.contributors, roundId });
  requireCandidate(officialNotes(body).version === candidate.version, 'C1_VERSION');
  return { body, templateDigest: bodyDigest(template) };
}
