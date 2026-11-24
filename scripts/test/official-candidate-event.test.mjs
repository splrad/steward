import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';
import YAML from 'yaml';
import { EvidenceReadError } from '../../packages/runner/dist/index.js';
import { Manifest } from 'release-please';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { bodyDigest, computeOfficialCandidate, draftOfficialCandidate, officialCandidateRoundId, officialMergeKey,
  officialNotes, renderOfficialHomepage, validateOfficialMergeEvent, verifyOfficialMerge } from '../official-release-candidate.mjs';
import { candidateEvent, officialCandidateRoute, prepareOfficialCandidate } from '../official-candidate-event.mjs';
import { compatibleExistingCandidate, writeOfficialCandidate } from '../official-candidate-write.mjs';

const sourceSha = 'a'.repeat(40), head = 'b'.repeat(40), controllerSha = 'c'.repeat(40), previousSha = 'd'.repeat(40);
const product = { id: 17, name: 'splrad/fixture', defaultBranch: 'main' }, authorId = 301115370;
const versionHeader = '## [1.1.0](https://github.com/splrad/fixture/compare/v1.0.0...v1.1.0)';
const upstreamBody = '请审阅本版。\n---\n\n' + versionHeader + '\n\n### 新增功能\n\n* 支持新版\n\n---\n产品文件差异。';
const template = await readFile(new URL('../../templates/repository/.github/release-template.md.mustache', import.meta.url), 'utf8');
const settings = { 'separate-pull-requests': true, 'include-component-in-tag': false, 'tag-separator': '/',
  packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION', draft: true, 'force-tag-creation': true } } };
const pr = { number: 29, user: { id: authorId }, head: { repo: { id: product.id }, sha: head,
  ref: 'release-please--branches--main' }, base: { repo: { id: product.id }, ref: product.defaultBranch },
  title: 'chore(main): release 1.1.0', body: upstreamBody, state: 'open', merged: false,
  labels: [{ name: 'autorelease: pending' }] };
const blob = (path, value) => {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  return { path, type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, sha };
};
const orgNotes = {
  changes: { added: { items: [{ title: '新版本支持', description: '使用 ' + String.fromCharCode(96) + 'steward doctor' +
    String.fromCharCode(96) + ' 检查安装。' }] } },
  compatibility: { items: [{ title: '支持范围', description: '适用于本版本的支持范围。' }] },
};
const person = { id: 42, login: 'contributor', profileUrl: 'https://github.com/contributor',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4', alt: 'contributor' };

test('requires the official switch and the native product declaration to select a candidate writer', async () => {
  const label = { repositoryId: product.id, prNumber: 29, eventId: 12 };
  const old = { 'separate-pull-requests': false };
  assert.deepEqual(officialCandidateRoute(old, 'true'), { result: 'official_candidate_not_adopted' });
  assert.throws(() => candidateEvent(label, 'a'.repeat(64)), /OFFICIAL_CANDIDATE_EVENT/);
  assert.deepEqual(officialCandidateRoute(settings), { result: 'official_candidate_disabled' });
  assert.deepEqual(officialCandidateRoute(settings, 'false'), { result: 'official_candidate_disabled' });
  assert.deepEqual(officialCandidateRoute(settings, 'true'), { route: 'official' });
  const multi = { ...settings, packages: { ...settings.packages, tools: { 'release-type': 'simple' } } };
  assert.throws(() => officialCandidateRoute(multi, 'true'), /ROOT_CONFIG/);
  assert.deepEqual(officialCandidateRoute(multi, 'false'), { result: 'official_candidate_disabled' });
  assert.throws(() => officialCandidateRoute({}, 'false'), /ROUTE/);

  const workflow = YAML.parse(await readFile('.github/workflows/release-candidate-event.yml', 'utf8'));
  const steps = workflow.jobs.event.steps;
  assert.equal(steps.find(step => step.id === 'candidate-token').if, "steps.check.outputs.mode == 'write'");
  assert.equal(workflow.jobs.event.permissions['copilot-requests'], 'write');
  const secretSteps = steps.filter(step => /secrets\./.test(JSON.stringify(step)));
  assert.deepEqual(secretSteps.map(step => step.id), ['product', 'compute', 'check', 'candidate-token', undefined]);
  for (const step of secretSteps) assert.deepEqual(JSON.stringify(step).match(/secrets\.[A-Z_0-9]+/g), ['secrets.STEWARD_APP_PRIVATE_KEY']);
  assert.ok(!steps.some(step => /release-please-action/.test(step.uses ?? '')));
  const model = steps.filter(step => step.env?.STEWARD_COPILOT_TOKEN);
  assert.equal(model.length, 1);
  assert.deepEqual(model[0].env, { STEWARD_COPILOT_TOKEN: '${{ github.token }}' });
  assert.equal(model[0].if, "steps.compute.outputs.mode == 'draft'");
});

function render(upstream = upstreamBody, notes = orgNotes, contributors = [person], roundId = 'a'.repeat(64)) {
  return renderOfficialHomepage({ upstreamBody: upstream, template, notes, contributors,
    sourceLink: { label: '查看本版变更', url: 'https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha },
    roundId });
}

test('native single-root extraction preserves every byte of rich notes and excludes the footer', async () => {
  for (const expected of [render(), render(upstreamBody, { summary: '本版修复安装。' }, []), render().replace('支持范围', '兼容系统')]) {
    const section = officialNotes(expected);
    assert.equal(section.version, '1.1.0');
    assert.match(section.body, /版本记录/);
    assert.match(section.body, /^## 1\.1\.0\n/);
    assert.equal(section.body.match(/\/compare\//g)?.length, 1);
    assert.doesNotMatch(section.body, /候选文件差异|技术变更记录|产品文件差异/);
    assert.equal(PullRequestBody.parse(expected.replace(/\n/g, '\r\n'), {error() {}, warn() {}}).releaseData[0].notes, section.body);
  }
  const section = officialNotes(render()).body;
  const avatar = parseFragment(section).childNodes.find(node => node.nodeName === 'a');
  assert.equal(avatar?.attrs.find(attr => attr.name === 'href')?.value, person.profileUrl);
  assert.equal(avatar?.childNodes[0]?.attrs.find(attr => attr.name === 'src')?.value, person.avatarUrl);
  assert.match(section, /<summary>贡献者 GitHub ID<\/summary>/);
  const disclosure = parseFragment(section).childNodes.find(node => node.nodeName === 'details');
  const login = disclosure?.childNodes.find(node => node.nodeName === 'a');
  assert.equal(login?.attrs.find(attr => attr.name === 'href')?.value, person.profileUrl);
  assert.equal(login?.childNodes[0]?.value, person.login);
  assert.match(section, /兼容性与迁移/);
  assert.match(section, /steward doctor/);
  assert.doesNotMatch(officialNotes(render(upstreamBody, { summary: '本版修复安装。' }, [])).body, /贡献者|本次更新/);
  const large = render(upstreamBody.replace('* 支持新版', '技术细节'.repeat(9000)));
  assert.doesNotMatch(large, /技术变更记录/);
  assert.match(large, /产品文件差异/);
  assert.throws(() => officialNotes(upstreamBody.replace('\n\n---\n', '\n\n')), /BOUNDARIES/);
});

test('the official package generates the three native files and chooses the frozen draft notes', async () => {
  const fileMap = { 'release-please-config.json': settings, '.release-please-manifest.json': { '.': '1.0.0' } };
  const commits = [{ sha: sourceSha, message: 'feat: 支持新版', files: ['README.md'] },
    { sha: previousSha, message: 'chore: release 1.0.0', files: ['VERSION'] }];
  let pending = [];
  const github = { repository: { owner: 'splrad', repo: 'fixture' },
    getFileJson: async path => fileMap[path],
    releaseIterator: async function* () { yield {tagName:'v1.0.0',sha:previousSha,notes:'',name:'v1.0.0'}; },
    mergeCommitIterator: async function* () { yield* commits; },
    pullRequestIterator: async function* (_branch, state) { if (state === 'MERGED') yield* pending; } };
  const manifest = await Manifest.fromManifest(github, 'main');
  const [candidate, extra] = await manifest.buildPullRequests();
  assert.equal(extra, undefined);
  assert.equal(candidate.version.toString(), '1.1.0');
  assert.equal(candidate.headRefName, pr.head.ref);
  assert.equal(candidate.title.toString(), pr.title);
  assert.deepEqual(candidate.updates.map(update => update.path).sort(), ['.release-please-manifest.json', 'CHANGELOG.md', 'VERSION']);
  assert.equal(await (await manifest.getStrategiesByPath())['.'].getBranchComponent(), '');
  const rendered = render(candidate.body.toString());
  pending = [{number:pr.number, sha:sourceSha, title:pr.title, headBranchName:pr.head.ref,
    baseBranchName:'main', labels:candidate.labels, body:rendered}];
  const [release] = await manifest.buildReleases();
  assert.equal(release.notes, officialNotes(rendered).body);
  assert.equal(release.sha, sourceSha);
  assert.equal(release.tag.toString(), 'v1.1.0');
  assert.equal(release.draft, true);
  assert.equal(release.forceTag, true);

  const files = { 'CHANGELOG.md': '# Changelog\n', 'VERSION': '1.0.0\n', '.release-please-manifest.json': '{".":"1.0.0"}\n' };
  const project = raw => ({
    title: raw.title.toString(), head: raw.headRefName, base: 'main', body: raw.body.toString(), version: raw.version.toString(),
    changelogPath: 'CHANGELOG.md', labels: raw.labels,
    files: raw.updates.map(({ path, updater }) => ({ path, mode: '100644', content: updater.updateContent(files[path]) })),
  });
  const id = raw => officialCandidateRoundId(product, { baseline: { tag: 'v1.0.0', sha: previousSha }, candidate: project(raw) });
  commits[0] = { ...commits[0], sha: controllerSha, message: 'feat: 新增另一项功能' };
  const [changedContent] = await manifest.buildPullRequests();
  assert.equal(changedContent.version.toString(), candidate.version.toString());
  assert.notEqual(id(changedContent), id(candidate));
  commits[0] = { ...commits[0], sha: head, message: 'fix: 修复启动' };
  const [changedVersion] = await manifest.buildPullRequests();
  assert.equal(changedVersion.version.toString(), '1.0.1');
  assert.notEqual(id(changedVersion), id(candidate));
});

test('verified merge archives the merge-time edit after default head movement and subsequent PR edits', async () => {
  const edited = render().replace('适用于本版本的支持范围。', '仅支持已审定的安装范围。');
  const merged = { ...pr, body: edited, state: 'closed', merged: true, merged_at: '2026-11-23T00:00:00Z', merge_commit_sha: sourceSha };
  const event = { repositoryId: product.id, kind: 'official-merge', prNumber: pr.number, head, sourceSha,
    mergedAt: merged.merged_at, title: pr.title, body: edited };
  validateOfficialMergeEvent(event, product, officialMergeKey(event));
  assert.equal(officialMergeKey({ ...event, body: upstreamBody }), officialMergeKey(event));
  const get = async path => {
    if (path === 'pulls/29') return merged;
    if (path === 'contents/release-please-config.json?ref=' + sourceSha) return blob('release-please-config.json', settings);
    if (path === 'contents/.release-please-manifest.json?ref=' + sourceSha) return blob('.release-please-manifest.json', { '.': '1.1.0' });
    if (path.startsWith('git/ref/heads/')) return { ref: 'refs/heads/main', object: { type: 'commit', sha: controllerSha } };
    if (path === 'compare/' + sourceSha + '...' + controllerSha + '?per_page=1') return { status: 'ahead', merge_base_commit: { sha: sourceSha } };
    assert.fail(path);
  };
  const result = await verifyOfficialMerge(event, product, get, authorId);
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(result.candidateHead, head);
  assert.equal(result.tag, 'v1.1.0');
  assert.equal(result.body, officialNotes(edited).body);
  assert.equal(result.pullBodyDigest, bodyDigest(edited));
  merged.body = edited + '\n\n合并后追加页脚。';
  assert.deepEqual(await verifyOfficialMerge(event, product, get, authorId), result);
  merged.body = edited.replace('仅支持已审定', '合并后改为');
  assert.deepEqual(await verifyOfficialMerge(event, product, get, authorId), result);
  merged.body = '合并后清空发行说明区段。';
  merged.title = '合并后的标题';
  assert.deepEqual(await verifyOfficialMerge(event, product, get, authorId), result);
  merged.head = { ...merged.head, sha: previousSha };
  await assert.rejects(verifyOfficialMerge(event, product, get, authorId), /MERGE_IDENTITY/);
});

const updateFiles = [
  { path: '.release-please-manifest.json', mode: '100644', content: '{"." : "1.1.0"}\n' },
  { path: 'CHANGELOG.md', mode: '100644', content: 'Support new behavior\n' },
  { path: 'VERSION', mode: '100644', content: '1.1.0\n' },
];
const computed = {
  title: pr.title, head: pr.head.ref, base: product.defaultBranch, body: upstreamBody, version: '1.1.0',
  changelogPath: 'CHANGELOG.md', files: updateFiles, labels: ['autorelease: pending'],
};
const source = { sourceSha, baseline: { tag: 'v1.0.0', sha: previousSha }, candidate: computed, prior: null };
const roundId = officialCandidateRoundId(product, source);
const expectedBody = render(upstreamBody, orgNotes, [person], roundId);
function candidateDated(date) {
  const heading = versionHeader + ' (' + date + ')';
  return { ...computed, body: upstreamBody.replace(versionHeader, heading),
    files: updateFiles.map(file => file.path === computed.changelogPath ? {
      ...file, content: '# Changelog\n\n' + heading + '\n\nSupport new behavior\n\n## 1.0.0 (2026-11-01)\n',
    } : file) };
}

test('only the upstream date in the current release heading is excluded from round identity', () => {
  const previous = candidateDated('2026-11-23'), nextDay = candidateDated('2026-11-24');
  const id = candidate => officialCandidateRoundId(product, { ...source, candidate });
  assert.notEqual(previous.body, nextDay.body);
  assert.notEqual(previous.files[1].content, nextDay.files[1].content);
  assert.equal(id(previous), id(nextDay));
  for (const change of [
    { body: nextDay.body.replace('支持新版', '维护窗口为 2026-11-24') },
    { body: nextDay.body.replace('v1.0.0...v1.1.0)', 'v1.0.0...v1.1.0?date=2026-11-24)') },
    { files: nextDay.files.map(file => ({ ...file, content: file.content.replace('2026-11-01', '2026-11-02') })) },
    { files: nextDay.files.map(file => ({ ...file, content: file.content.replace('Support new behavior', 'Fix a second issue') })) },
    { version: '1.2.0', title: 'chore(main): release 1.2.0' },
  ]) assert.notEqual(id({ ...nextDay, ...change }), id(previous));
});

test('carries an existing signed PR when only its generated changelog date differs', async () => {
  const previous = candidateDated('2026-11-23');
  const today = candidateDated('2026-11-24');
  const pull = { ...pr, body: expectedBody };
  const get = async path => {
    if (path === 'git/commits/' + head)
      return { sha: head, message: pr.title, verification: { verified: true }, parents: [{ sha: sourceSha }] };
    if (path === 'contents/release-please-config.json?ref=' + sourceSha) return blob('release-please-config.json', settings);
    if (path === 'compare/' + sourceSha + '...' + head + '?per_page=1')
      return { merge_base_commit: { sha: sourceSha }, total_commits: 1, files: updateFiles.map(file => ({ filename: file.path })) };
    const file = previous.files.find(file => path === 'contents/' + file.path + '?ref=' + head);
    if (file) return blob(file.path, file.content);
    assert.fail(path);
  };
  const adopt = candidate => compatibleExistingCandidate({ get, pull, product, botId: authorId, candidate, configuration: settings });
  assert.deepEqual(await adopt(today), {
    draft: { body: expectedBody, templateDigest: null },
    branch: { head, sourceSha },
    pull: { number: 29, head, bodyDigest: officialNotes(expectedBody).bodyDigest },
  });
  const changed = { ...today, files: today.files.map(file => ({ ...file, content: file.content.replace('Support new behavior', 'Fix another issue') })) };
  assert.equal(await adopt(changed), null);
});

test('materializes the official candidate once against the immutable source and derives identity from its raw content', async () => {
  let buildCount = 0, readCount = 0;
  const get = async path => {
    assert.equal(path, 'git/ref/heads/main');
    return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
  };
  const raw = { title: pr.title, headRefName: computed.head, body: upstreamBody, version: computed.version,
    labels: computed.labels, draft: false, updates: [{ path: 'VERSION' }] };
  const openManifest = async () => ({
    github: { buildChangeSet: async (updates, source) => {
      ++readCount;
      assert.deepEqual(updates, raw.updates);
      assert.equal(source, sourceSha);
      return new Map(updateFiles.map(({path, mode, content}) => [path, {mode, content}]));
    } },
    manifest: {
      getStrategiesByPath: async () => ({ '.': { getBranchComponent: async () => '' } }),
      buildPullRequests: async () => { ++buildCount; return [raw]; },
    },
  });
  assert.deepEqual(await computeOfficialCandidate({ product, sourceSha, configuration: settings, get, openManifest }), computed);
  assert.deepEqual([buildCount, readCount], [1, 1]);
  assert.equal(officialCandidateRoundId(product, { ...source, sourceSha: controllerSha }), roundId);
  assert.notEqual(officialCandidateRoundId(product, { ...source, baseline: { tag: null, sha: null } }), roundId);
  assert.notEqual(officialCandidateRoundId(product, { ...source, candidate: { ...computed, body: upstreamBody + '\nChanged' } }), roundId);
});

test('restores a saved calculation and draft before contacting Release Please or Copilot again', async () => {
  let hasDraft = true, hasPull = false, collectCount = 0;
  const identity = { product, event: { kind: 'push' }, sourceSha };
  const get = async path => {
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
    if (path.startsWith('issues?')) return [];
    if (path === 'contents/release-please-config.json?ref=' + sourceSha) return blob('release-please-config.json', settings);
    if (path === 'contents/.release-please-manifest.json?ref=' + sourceSha) return blob('.release-please-manifest.json', { '.': '1.0.0' });
    if (path === 'commits/tags%2Fv1.0.0') return { sha: previousSha };
    if (path === 'compare/' + previousSha + '...' + sourceSha + '?per_page=1')
      return { status: 'ahead', merge_base_commit: { sha: previousSha } };
    assert.fail(path);
  };
  const store = {
    find: async (sha, baseline) => {
      assert.deepEqual([sha, baseline], [sourceSha, source.baseline]);
      return { roundId, source, draft: hasDraft ? { body: expectedBody, templateDigest: bodyDigest(template) } : null,
        pull: hasPull ? { number: 29, head, bodyDigest: bodyDigest(expectedBody) } : null };
    },
  };
  const prepare = () => prepareOfficialCandidate({ identity, get, store,
    prepareParticipation: async () => ({ status: 'APPLICABLE', sourceSha }),
    buildCandidate: () => assert.fail('recomputed the saved candidate'),
    collectEvidence: () => { collectCount++; return { fixture: true }; },
  });
  assert.equal((await prepare()).mode, 'write');
  assert.equal(collectCount, 0);
  hasDraft = false;
  assert.deepEqual((await prepare()).evidence, { fixture: true });
  assert.equal(collectCount, 1);
  hasDraft = hasPull = true;
  assert.equal((await prepare()).result, 'candidate_unchanged');
  assert.equal(collectCount, 1);
});

test('records each new source only after an exact round match and skips repeated computation for that source', async () => {
  const identity = { product, event: { kind: 'push' }, sourceSha: controllerSha };
  const archived = { ...source, candidate: candidateDated('2026-11-23') };
  const recalculated = candidateDated('2026-11-24');
  const datedRound = officialCandidateRoundId(product, archived);
  const saved = {
    roundId: datedRound, source: archived, draft: null,
    branch: null, pull: null,
  };
  let boundSource, builds = 0;
  const get = async path => {
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: controllerSha } };
    if (path.startsWith('issues?')) return [];
    if (path === 'contents/release-please-config.json?ref=' + controllerSha) return blob('release-please-config.json', settings);
    if (path === 'contents/.release-please-manifest.json?ref=' + controllerSha) return blob('.release-please-manifest.json', { '.': '1.0.0' });
    if (path === 'commits/tags%2Fv1.0.0') return { sha: previousSha };
    if (path.startsWith('compare/')) return { status: 'ahead', merge_base_commit: { sha: previousSha } };
    assert.fail(path);
  };
  const store = {
    find: async sha => sha === boundSource ? saved : null,
    read: async id => { assert.equal(id, datedRound); return saved; },
    bind: async (id, sha) => {
      assert.equal(id, datedRound);
      assert.equal(sha, controllerSha);
      boundSource = sha;
    },
  };
  const prepare = () => prepareOfficialCandidate({ identity, get, store,
    prepareParticipation: async () => ({ status: 'APPLICABLE', sourceSha: controllerSha }),
    buildCandidate: async () => { builds++; return recalculated; },
    collectEvidence: ({ candidate }) => { assert.deepEqual(candidate, archived.candidate); return {}; },
  });
  const restoredSource = await prepare();
  assert.equal(restoredSource.mode, 'draft');
  assert.deepEqual(restoredSource.candidate, archived.candidate);
  assert.equal(boundSource, controllerSha);
  saved.draft = { body: expectedBody, templateDigest: bodyDigest(template) };
  const restoredDraft = await prepare();
  assert.equal(restoredDraft.mode, 'write');
  assert.deepEqual(restoredDraft.candidate.files, archived.candidate.files);
  saved.branch = { head, sourceSha };
  saved.pull = { number: pr.number, head, bodyDigest: officialNotes(expectedBody).bodyDigest };
  assert.equal((await prepare()).result, 'candidate_unchanged');
  assert.equal(builds, 1);
});

test('renders only evidence-bound Copilot sections and validates the official section', async () => {
  const context = {
    unit: { id: 'root', path: '.', version: computed.version, tag: 'v1.1.0' }, tag: 'v1.1.0', contributors: [person],
    sourceLink: { label: '查看本版变更', url: 'https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha },
    evidence: [{ kind: 'fixture', details: { instruction: '升级前备份设置。' } }],
  };
  const draft = await draftOfficialCandidate({ roundId, candidate: computed, context, product, sourceSha, template,
    call: async input => {
      const value = JSON.parse(input);
      assert.equal(value.sources[0].details.instruction, '升级前备份设置。');
      return { text: JSON.stringify({ paragraphs: [{
        section: 'requiredActions', sourceIds: [value.sources[0].id], qualification: 'SOURCE_CONFIRMED',
        textZh: '**升级用户**。升级前备份设置。',
      }] }) };
    },
  });
  const section = officialNotes(draft.body);
  assert.match(section.body, /> \[!IMPORTANT\][\s\S]+升级前备份设置/);
  assert.match(section.body, /版本记录/);
  assert.doesNotMatch(section.body, /获取与使用|本次更新|候选文件差异/);
  assert.equal(PullRequestBody.parse(draft.body).releaseData[0].notes, section.body);
});

test('reads back unknown candidate writes across Runs and preserves manual edits after the first PR write', async () => {
  const phases = [];
  const round = { source, draft: { body: expectedBody, templateDigest: bodyDigest(template) }, branch: null, pull: null };
  let branchHead = null, actualPull = null, failCheckpoint = true, defaultSource = sourceSha;
  const created = { sha: head, tree: { sha: '1'.repeat(40) }, parents: [{ sha: sourceSha }],
    message: computed.title + '\n\nSteward-Candidate-Round: ' + roundId, verification: { verified: true } };
  const get = async path => {
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: defaultSource } };
    if (path === 'git/ref/heads/' + computed.head) {
      if (!branchHead) throw new EvidenceReadError(404, null);
      return { ref: 'refs/heads/' + computed.head, object: { type: 'commit', sha: branchHead } };
    }
    if (path.startsWith('pulls?')) return actualPull ? [actualPull] : [];
    if (path === 'pulls/29') return actualPull;
    if (path === 'git/commits/' + sourceSha) return { sha: sourceSha, tree: { sha: '2'.repeat(40) } };
    if (path === 'git/commits/' + head) return created;
    if (path === 'compare/' + sourceSha + '...' + head + '?per_page=1') {
      return { merge_base_commit: { sha: sourceSha }, total_commits: 1, files: updateFiles.map(file => ({filename: file.path})) };
    }
    if (path.startsWith('contents/') && path.endsWith('?ref=' + head)) {
      const file = updateFiles.find(file => path === 'contents/' + file.path + '?ref=' + head);
      return blob(file.path, file.content);
    }
    assert.fail(path);
  };
  const request = async (method, path, body) => {
    assert.equal(method, 'POST');
    if (path === 'git/trees') return created.tree;
    if (path === 'git/commits') return created;
    phases.push(path);
    if (path === 'git/refs') branchHead = body.sha;
    if (path === 'pulls') {
      assert.equal(body.body, expectedBody);
      actualPull = { ...pr, body: body.body, labels: [] };
    }
    if (path === 'issues/29/labels') actualPull.labels = body.labels.map(name => ({ name }));
    throw Error('response lost');
  };
  const save = async (phase, data) => {
    if (failCheckpoint) throw Error('checkpoint unavailable');
    round[phase] = data;
  };
  const write = () => writeOfficialCandidate({ roundId, round, product, botId: authorId, sourceSha, configuration: settings,
    get, request, save, admit: async () => {} });
  defaultSource = controllerSha;
  await assert.rejects(write, /C2_SOURCE_CHANGED/);
  assert.deepEqual(phases, []);
  defaultSource = sourceSha;
  await assert.rejects(write, /checkpoint unavailable/);
  failCheckpoint = false;
  const recorded = await write();
  assert.deepEqual(phases, ['git/refs', 'pulls', 'issues/29/labels']);
  actualPull.body = actualPull.body.replace('支持范围', '人工修订');
  assert.deepEqual(await write(), recorded);
  assert.match(actualPull.body, /人工修订/);
  assert.deepEqual(phases, ['git/refs', 'pulls', 'issues/29/labels']);
});
