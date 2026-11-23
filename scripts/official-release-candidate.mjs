import { createHash } from 'node:crypto';
import { BranchName } from 'release-please-official/build/src/util/branch-name.js';
import { PullRequestBody } from 'release-please-official/build/src/util/pull-request-body.js';
import { PullRequestTitle } from 'release-please-official/build/src/util/pull-request-title.js';
import { TagName } from 'release-please-official/build/src/util/tag-name.js';
import { Version } from 'release-please-official/build/src/version.js';
import { assertVersionAcquisitionLinks, parseConditionalNotes, renderConditionalNotes, selectReleaseContributors } from '../packages/runner/dist/index.js';

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
export const officialRef = (ref, base) => typeof ref === 'string' && ref.startsWith('release-please--branches--')
  && BranchName.parse(ref, logger)?.getTargetBranch() === base;

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

export function renderOfficialHomepage({ upstreamBody, template, notes, sourceLink, contributors, candidateUrl, prUrl }) {
  const upstream = officialNotes(upstreamBody);
  const lines = normalized(upstreamBody).trim().split('\n');
  const first = lines.indexOf('---'), last = lines.lastIndexOf('---');
  const header = lines.slice(0, first + 1).join('\n');
  const footer = lines.slice(last + 1).join('\n').trim();
  const versionHeading = upstream.body.split('\n', 1)[0];
  const notesBody = renderConditionalNotes(template, notes, sourceLink, contributors).trimEnd();
  const expected = versionHeading + '\n\n' + notesBody;
  const technical = upstream.body.replace(/^---$/gm, '- - -');
  const extras = [
    footer,
    '[候选文件差异](<' + candidateUrl + '>) · [查看 PR](<' + prUrl + '>)',
  ].filter(Boolean).join('\n\n');
  const skeleton = header + '\n\n' + expected + '\n\n---\n\n' + extras;
  let result = skeleton + '\n\n<details>\n<summary>技术变更记录</summary>\n\n' + technical + '\n\n</details>';
  if (!fitsOfficialEvent(result)) result = skeleton;
  requireCandidate(fitsOfficialEvent(result), 'BODY_LIMIT');
  const readback = officialNotes(result);
  requireCandidate(readback.body === expected && readback.version === upstream.version, 'RENDER_PARSE');
  return result;
}

export function officialConfig(settings) {
  return settings?.['separate-pull-requests'] === true;
}

function officialUnit(settings, ref, base, version) {
  requireCandidate(officialConfig(settings) && settings.packages && typeof settings.packages === 'object'
    && !Array.isArray(settings.packages) && !settings['group-pull-request-title-pattern']
    && !settings['release-label'] && !settings.label, 'CONFIG');
  const branch = BranchName.parse(ref, logger);
  requireCandidate(officialRef(ref, base), 'BRANCH');
  const options = Object.entries(settings.packages).map(([path, config]) => ({...settings, ...config, path}));
  const matches = options.filter(o => (o.component ?? (o.path === '.' ? undefined : o.path)) === branch.getComponent());
  requireCandidate(matches.length === 1, 'UNIT');
  const unit = matches[0];
  requireCandidate(unit.draft === true && unit['force-tag-creation'] === true && !unit['skip-github-release'] &&
    !unit['draft-pull-request'], 'CONFIG');
  const tag = value => new TagName(Version.parse(value), unit['include-component-in-tag'] === false ? undefined : branch.getComponent(), unit['tag-separator'],
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

const conventionalCategories = { feat: 'added', fix: 'fixed', revert: 'fixed', perf: 'improved' };
const headings = {added:'功能变更', fixed:'问题修复', improved:'性能改进'};
const escapeMarkdown = value => value.replace(/[\\*_{}[\]<>~\x60]/g, '\\$&');
function fallbackNotes(commits, repository) {
  const changes = {};
  let first = null;
  for (const commit of commits) {
    const subject = commit.commit?.message?.split(/\r?\n/, 1)[0] ?? '';
    const match = /^(?<type>[a-z]+)(?:\([^)]*\))?!?: (?<summary>.+)$/.exec(subject);
    const category = conventionalCategories[match?.groups?.type];
    if (!subject) continue;
    const url = 'https://github.com/' + repository + '/commit/' + commit.sha;
    const description = escapeMarkdown(match?.groups?.summary ?? subject) + ' [查看提交](<' + url + '>)';
    first ??= description;
    if (!category) continue;
    (changes[category] ??= { items: [] }).items.push({ title: match.groups.type === 'revert' ? '回退变更' : headings[category],
      description });
  }
  requireCandidate(first, 'RELEASE_CHANGE_REQUIRED');
  return Object.keys(changes).length ? { changes } : { summary: '本版变更包括 ' + first };
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

export async function renderOfficialPull(pull, product, get, botId, sourceSha, template) {
  const [configuration, before, manifest, delivery] = await Promise.all([
    readOfficialConfig(get, sourceSha), readOfficialManifest(get, sourceSha),
    readOfficialManifest(get, pull.head.sha), readOfficialDelivery(get, sourceSha),
  ]);
  const { path, tag } = verifyOfficialPull(pull, product, pull.number, botId, configuration, manifest);
  const heading = officialNotes(pull.body).body.split('\n', 1)[0];
  const comparePrefix = 'https://github.com/' + product.name + '/compare/';
  const linkedTag = heading.split('](' + comparePrefix)[1]?.split('...')[0];
  const priorTag = linkedTag && TagName.parse(linkedTag) ? linkedTag : null;
  const backstop = configuration['last-release-sha'] ?? (!before[path] ? configuration['bootstrap-sha'] : null);
  const priorSha = priorTag ? (await get('commits/' + encodeURIComponent('tags/' + priorTag))).sha : backstop;
  requireCandidate(!priorSha || sha(priorSha), 'RANGE');
  const commits = await rangeCommits(get, sourceSha, priorSha);
  const relevant = path === '.' ? commits : (await Promise.all(commits.map(async c => {
    const files = await pages(get, 'commits/' + c.sha, 'files');
    return files.some(f => f.filename?.startsWith(path + '/') || f.previous_filename?.startsWith(path + '/')) ? c : null;
  }))).filter(Boolean);
  const notesPath = delivery.units?.find(unit => unit.path === path)?.notesPath ?? (path === '.' ? delivery.notesPath : undefined);
  const notes = notesPath ? parseConditionalNotes((await readSourceFile(get, notesPath, sourceSha)).toString('utf8'))
    : fallbackNotes(relevant, product.name);
  assertVersionAcquisitionLinks(notes, product.name, tag, sourceSha);
  const actors = relevant.map(commit => commit.author ? { id: commit.author.id, login: commit.author.login,
    type: commit.author.type, profileUrl: commit.author.html_url, avatarUrl: commit.author.avatar_url } : null);
  const { contributors } = selectReleaseContributors(actors, [], 'github-authors');
  const base = 'https://github.com/' + product.name;
  const sourceLink = priorSha ? { label: '查看本版变更', url: base + '/compare/' + priorSha + '...' + sourceSha }
    : { label: '查看本版源码', url: base + '/tree/' + sourceSha };
  const body = renderOfficialHomepage({ upstreamBody: pull.body, template, notes, sourceLink, contributors,
    candidateUrl: base + '/pull/' + pull.number + '/files', prUrl: base + '/pull/' + pull.number });
  return { body, notes: officialNotes(body), templateDigest: bodyDigest(template) };
}
