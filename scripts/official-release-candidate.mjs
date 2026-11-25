import { createHash } from 'node:crypto';
import { GitHub, Manifest } from 'release-please';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { PullRequestTitle } from 'release-please/build/src/util/pull-request-title.js';
import { parse as parseVersion } from 'semver';
import { assertDeliveryPath, assertSelectedReleaseDownloads, assertVersionAcquisitionLinks, EvidenceReadError, generateOfficialCandidateNotes, officialCandidateDiff, splitContentText,
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

// Release Please requires a numeric first heading inside its native separators.
const nativeComment = '<!-- release-please';
export const nativeDraftBody = (version, body) => '## ' + version + '\n-->\n\n' + body;
export const legacyVersionHeading = /^#{2,} \[?\d+\.\d+\.\d+/;
export const officialReleaseTitle = (repository, tag) => repository.split('/')[1] + ' ' + tag;

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
  const version = data[0].version.toString();
  let notes = content;
  let releaseTitle;
  if (lines[first - 1] === nativeComment) {
    const prefix = nativeDraftBody(version, '');
    requireCandidate(content.startsWith(prefix) && /^## [A-Za-z0-9_.-]+ \S+$/.test(lines[first - 3] ?? ''), 'BODY_PARSE');
    releaseTitle = lines[first - 3].slice(3);
    notes = content.slice(prefix.length);
    requireCandidate(notes.trim() && !legacyVersionHeading.test(notes), 'BODY_PARSE');
  } else {
    requireCandidate(!content.startsWith(nativeDraftBody(version, '')), 'BODY_PARSE');
  }
  return { version, body: notes, bodyDigest: bodyDigest(notes), ...(releaseTitle && { releaseTitle }) };
}

export const officialRoundMarker = roundId => '<!-- steward-candidate-round:' + roundId + ' -->';

export function renderOfficialHomepage({ upstreamBody, repository, tag, template, notes, sourceLink, contributors, roundId, filesUrl, creationLink }) {
  const upstream = officialNotes(upstreamBody);
  const lines = normalized(upstreamBody).trim().split('\n');
  const first = lines.indexOf('---'), last = lines.lastIndexOf('---');
  const header = lines.slice(0, first).join('\n').trim();
  const footer = lines.slice(last + 1).join('\n').trim();
  const releaseTitle = officialReleaseTitle(repository, tag);
  const notesBody = renderConditionalNotes(template, notes, sourceLink, contributors).trimEnd();
  const nativeBody = nativeDraftBody(upstream.version, notesBody);
  const buildNotice = '请审阅下方版本说明。确认后合并，本次合并将启动该版本的正式构建。';
  const review = ['> **审阅提示**', '> ' + buildNotice,
    '> 如需修改，请编辑下方版本标题后的发行说明。'].join('\n>\n');
  const record = creationLink ?? sourceLink;
  const recordContext = creationLink ? '创建 PR 时的变更记录' : '本轮候选变更记录';
  const recordLink = recordContext + ' · [' + record.label + '](<' + record.url + '>)';
  const files = filesUrl ? '[查看候选文件差异](<' + filesUrl + '>)' : '在本 PR 的 **Files changed** 页查看候选文件差异。';
  const info = ['<details>\n<summary><strong>PR 信息（仅供审阅）</strong></summary>',
    header !== buildNotice ? header : '', footer, files, recordLink, '</details>']
    .filter(Boolean).join('\n\n').split('\n').map(line => line ? '> ' + line : '>').join('\n');
  // The HTML comment hides only the native version header in the PR preview.
  const result = [review, '## ' + releaseTitle, nativeComment + '\n---\n' + nativeBody, '---', info, officialRoundMarker(roundId)].join('\n\n');
  requireCandidate(fitsOfficialEvent(result), 'BODY_LIMIT');
  const readback = officialNotes(result);
  requireCandidate(readback.body === notesBody && readback.releaseTitle === releaseTitle && readback.version === upstream.version, 'RENDER_PARSE');
  return result;
}

const generatedDateSuffix = / \(\d{4}-\d{2}-\d{2}\)$/;

function comparableCandidateBody(candidate) {
  const section = /^---\r?\n(?:\r?\n)*(?<heading>[^\r\n]+)/m.exec(candidate.body);
  const heading = section?.groups?.heading;
  const header = heading?.match(/^## (?:\[([^\]\r\n]+)\]\([^\r\n]+\)|([^ ()\r\n]+)) \(\d{4}-\d{2}-\d{2}\)$/);
  if (!header || (header[1] ?? header[2]) !== candidate.version) return { body: candidate.body };
  const stableHeading = heading.replace(generatedDateSuffix, '');
  const start = section.index + section[0].length - heading.length;
  return { heading: stableHeading, body: candidate.body.slice(0, start) + stableHeading + candidate.body.slice(start + heading.length) };
}

export function comparableCandidateFile(candidate, path, content, heading = comparableCandidateBody(candidate).heading) {
  if (!heading || path !== candidate.changelogPath) return content;
  let matched = false;
  return content.replace(/^## [^\r\n]+/gm, line => {
    if (matched || !generatedDateSuffix.test(line) || line.replace(generatedDateSuffix, '') !== heading) return line;
    matched = true;
    return heading;
  });
}

export function officialCandidateRoundId(product, { baseline, candidate }) {
  // Release Please stamps its current-version heading at calculation time.
  const { body, heading } = comparableCandidateBody(candidate);
  return bodyDigest(JSON.stringify([product.id, candidate.base, baseline.tag, baseline.sha, candidate.title,
    candidate.head, candidate.version, body, candidate.labels,
    candidate.files.map(file => [file.path, file.mode, comparableCandidateFile(candidate, file.path, file.content, heading)])]));
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
  const changelogPath = unit['changelog-path'] ?? 'CHANGELOG.md';
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
  return { title, head, base: product.defaultBranch, body, version, changelogPath, files, labels };
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

export function officialCandidateSettings(settings) {
  const unit = officialRootSettings(settings);
  requireCandidate(unit, 'ROOT_CONFIG');
  requireCandidate(!unit['include-component-in-tag'], 'ROOT_TAG_CONFIG');
  return unit;
}

function officialUnit(settings, ref, base, version) {
  const unit = officialCandidateSettings(settings);
  requireCandidate(officialRef(ref, base), 'BRANCH');
  const parsed = parseVersion(version);
  const suffix = parsed?.build.length ? '+' + parsed.build.join('.') : '';
  requireCandidate(parsed && parsed.version + suffix === version, 'VERSION');
  // Release Please uses the tag separator between a component name and its version.
  return { unit, tag: (unit['include-v-in-tag'] === false ? '' : 'v') + version };
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
  if (notes.releaseTitle !== undefined) requireCandidate(notes.releaseTitle === officialReleaseTitle(product.name, tag), 'VERSION');
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
  for (let page = 1; total === undefined || result.length < total; page++) {
    const value = await get(comparison + '?per_page=100&page=' + page);
    requireCandidate(value.base_commit?.sha === priorSha && value.merge_base_commit?.sha === priorSha
      && ['ahead', 'identical'].includes(value.status) && Number.isSafeInteger(value.total_commits)
      && value.total_commits >= 0 && Array.isArray(value.commits) && value.commits.length <= 100, 'RANGE');
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

async function sourceTree(get, sourceSha) {
  const commit = await get('git/commits/' + sourceSha);
  requireCandidate(commit.sha === sourceSha && sha(commit.tree?.sha), 'CONTENT_SOURCE');
  const tree = await get('git/trees/' + commit.tree.sha + '?recursive=1');
  requireCandidate(tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree), 'CONTENT_SOURCE');
  return tree.tree;
}

// Side-branch commits first introduced by this merge, limited to the release range.
function mergedHistory(commit, bySha) {
  function ancestors(parents, stop) {
    const found = new Set(), pending = parents.map(parent => parent.sha);
    while (pending.length) {
      const id = pending.pop();
      if (found.has(id) || stop.has(id) || !bySha.has(id)) continue;
      found.add(id);
      for (const parent of bySha.get(id).parents) pending.push(parent.sha);
    }
    return found;
  }
  const baseHistory = ancestors(commit.parents.slice(0, 1), new Set());
  return ancestors(commit.parents.slice(1), baseHistory);
}

export async function officialCandidateEvidence({ product, sourceSha, baseline, candidate, get, getPages, directory }) {
  const configuration = await readOfficialConfig(get, sourceSha);
  const { unit: release, tag } = officialUnit(configuration, candidate.head, candidate.base, candidate.version);
  const path = release.path;
  const [commits, delivery] = await Promise.all([
    rangeCommits(get, sourceSha, baseline.sha),
    readOfficialDelivery(get, sourceSha),
  ]);
  const { units, buildWorkflow } = parseDeliveryConfig(delivery, configuration);
  const unit = units.find(unit => unit.path === path);
  requireCandidate(unit, 'CONTENT_SOURCE');
  const associated = new Map();
  for (const commit of commits) {
    const refs = await getPages('commits/' + commit.sha + '/pulls');
    for (const pull of refs) {
      if (positive(pull.number) && pull.merged_at && pull.base?.repo?.id === product.id && pull.base.ref === candidate.base) {
        if (!associated.has(pull.number)) associated.set(pull.number, { pull, commits: [] });
        associated.get(pull.number).commits.push(commit.sha);
      }
    }
  }
  const isInternal = ({ pull }) => pull.labels?.some(label => label.name?.toLowerCase() === 'internal');
  const eligible = [...associated.values()].filter(item => !isInternal(item));
  const pulls = eligible.map(({ pull, commits }) => ({
    kind: 'merged-pull-request', details: { number: pull.number, url: pull.html_url, title: pull.title, body: pull.body, commits },
  }));
  const actors = commits.map(commit => commit.author ? { id: commit.author.id, login: commit.author.login,
    type: commit.author.type, profileUrl: commit.author.html_url, avatarUrl: commit.author.avatar_url } : null);
  const { contributors } = selectReleaseContributors(actors, [], 'github-authors');
  const sourceLink = candidateSourceLink(product, baseline.sha, sourceSha);
  const context = { tag, sourceLink, contributors, unit: { id: unit.id, path, version: candidate.version, tag } };
  if (eligible.length < associated.size) {
    // Range-wide notes, generated files and snapshots can repeat excluded PRs.
    // Only the selection for writing changes. The original candidate and version history stay intact.
    const bySha = new Map(commits.map(commit => [commit.sha, commit]));
    const merges = new Map();
    for (const commit of commits) {
      requireCandidate(Array.isArray(commit.parents) && commit.parents.every(p => sha(p.sha)), 'RANGE');
    }
    for (const commit of commits.filter(item => item.parents.length > 1)) {
      merges.set(commit.sha, mergedHistory(commit, bySha));
    }
    const excluded = new Set([...associated.values()].filter(isInternal).flatMap(item => item.commits));
    for (const item of eligible) for (const sha of item.commits) excluded.delete(sha);
    for (const id of [...excluded]) {
      for (const side of merges.get(id) ?? []) excluded.add(side);
    }
    const mixedMerges = new Set(), coveredByMerge = new Set();
    for (const [merge, side] of merges) {
      if (excluded.has(merge)) continue;
      if ([...side].some(id => excluded.has(id))) mixedMerges.add(merge);
      else for (const id of side) coveredByMerge.add(id);
    }
    const selected = commits.filter(commit => !excluded.has(commit.sha) && !coveredByMerge.has(commit.sha));
    const evidence = [...pulls];
    if (selected.length) {
      const workspace = await directory();
      const exclude = [candidate.changelogPath ?? 'CHANGELOG.md', manifestPath];
      for (const commit of selected) {
        // A clean merge has no combined patch. Use its first-parent diff unless
        // that would reintroduce an Internal side commit. In a mixed merge the
        // selected side commits supply their own patches plus merge resolutions.
        evidence.push({ kind: 'selected-commit', details: { sha: commit.sha, message: commit.commit.message } });
        evidence.push(...await officialCandidateDiff(workspace, commit.sha, commit.parents[0]?.sha ?? null,
          { exclude, mixedMerge: mixedMerges.has(commit.sha), excludedCommits: excluded }));
      }
    } else {
      evidence.push({ kind: 'maintenance-only', details: { summary: '本版仅包含项目内部维护。' } });
    }
    return { ...context, evidence };
  }
  const [tree, previous, diffs] = await Promise.all([
    sourceTree(get, sourceSha),
    baseline.tag ? optionalEvidence(() => get('releases/tags/' + encodeURIComponent(baseline.tag))) : null,
    directory().then(workspace => officialCandidateDiff(workspace, sourceSha, baseline.sha)),
  ]);
  const files = tree.filter(file => file.type === 'blob' && ['100644', '100755'].includes(file.mode));
  const docPaths = files.map(file => file.path).filter(path =>
    /^README\.(?:md|rst|adoc)$/i.test(path) ||
    /^docs\/(?:product\/|.*(?:install|setup|download|upgrade|migrat|usage|getting-started)).*\.(?:md|mdx|rst|adoc)$/i.test(path));
  const deliveryPaths = files.map(file => file.path).filter(path =>
    path === buildWorkflow || /^(?:scripts|tools)\/(?:.*\/)?(?:Publish|Select)-ReleaseAssets\.[A-Za-z0-9]+$/i.test(path));
  const paths = [...new Set([...docPaths, ...deliveryPaths, unit.notesPath])].filter(path => files.some(file => file.path === path));
  const docs = await Promise.all(paths.map(async path => {
    const bytes = await readSourceFile(get, path, sourceSha);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw Error('CONTENT_SOURCE_ENCODING'); }
    const kind = deliveryPaths.includes(path) ? 'product-delivery-source' : 'product-documentation';
    return splitContentText(text).map(chunk => ({ kind, details: { path, ...chunk } }));
  }));
  return {
    ...context,
    evidence: [
      { kind: 'official-candidate', details: {
        sourceSha, baseline, body: candidate.body, version: candidate.version, title: candidate.title,
        commits: commits.map(commit => ({ sha: commit.sha, message: commit.commit?.message })),
      } },
      ...candidate.files.flatMap(file => {
        const digest = bodyDigest(file.content);
        return splitContentText(file.content).map(chunk => ({
          kind: 'official-candidate-file', details: { path: file.path, digest, ...chunk },
        }));
      }),
      ...pulls, ...diffs, ...docs.flat(),
      ...(previous ? [{ kind: 'previous-release', details: { tag: previous.tag_name, draft: previous.draft, body: previous.body } }] : []),
      { kind: 'delivery', details: { declaration: delivery } },
    ],
  };
}

function candidateSourceLink(product, base, head) {
  requireCandidate(sha(head) && (base === null || sha(base)), 'CONTENT_SOURCE');
  const repository = 'https://github.com/' + product.name;
  return base ? { label: '查看本版变更', url: repository + '/compare/' + base + '...' + head }
    : { label: '查看本版源码', url: repository + '/tree/' + head };
}

export async function draftOfficialCandidate({ roundId, candidate, context, product, sourceSha, template, call, creationRange, pullNumber }) {
  const maintenance = context.evidence.length === 1 && context.evidence[0].kind === 'maintenance-only';
  const notes = maintenance ? { summary: context.evidence[0].details.summary }
    : await generateOfficialCandidateNotes({ unit: context.unit, evidence: context.evidence, template, call });
  const body = renderOfficialHomepage({ upstreamBody: candidate.body, repository: product.name, tag: context.tag, template, notes, sourceLink: context.sourceLink,
    contributors: context.contributors, roundId,
    filesUrl: positive(pullNumber) ? 'https://github.com/' + product.name + '/pull/' + pullNumber + '/files' : null,
    creationLink: creationRange && candidateSourceLink(product, creationRange.base, creationRange.head) });
  try {
    // The product build hasn't selected or verified the downloadable files yet.
    assertVersionAcquisitionLinks(notes, product.name, context.tag, sourceSha, []);
    assertSelectedReleaseDownloads(body, product.name, context.tag, new Set());
  } catch {
    throw Error('OFFICIAL_CANDIDATE_C1_ACQUISITION_LINKS');
  }
  requireCandidate(officialNotes(body).version === candidate.version, 'C1_VERSION');
  return { body, templateDigest: bodyDigest(template) };
}
