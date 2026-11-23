import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';
import { Manifest as ActionManifest } from 'release-please-official/build/src/manifest.js';
import { Manifest } from 'release-please/build/src/manifest.js';
import { PullRequestBody as ActionPullRequestBody } from 'release-please-official/build/src/util/pull-request-body.js';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { bodyDigest, officialMergeKey, officialNotes, renderOfficialHomepage, validateOfficialMergeEvent,
  renderOfficialPull, verifyOfficialMerge } from '../official-release-candidate.mjs';
import { captureOfficialAction, finishOfficialPull, officialActionResult, prepareOfficialPush } from '../official-candidate-event.mjs';

const sourceSha = 'a'.repeat(40), head = 'b'.repeat(40), controllerSha = 'c'.repeat(40), previousSha = 'd'.repeat(40);
const product = { id: 17, name: 'splrad/fixture', defaultBranch: 'main' }, authorId = 301115370;
const versionHeader = '## [1.1.0](https://github.com/splrad/fixture/compare/v1.0.0...v1.1.0)';
const upstreamBody = '请审阅本版。\n---\n\n' + versionHeader + '\n\n### 新增功能\n\n* 支持新版\n\n---\n产品文件差异。';
const template = await readFile(new URL('../../templates/repository/.github/release-template.md.mustache', import.meta.url), 'utf8');
const settings = { 'separate-pull-requests': true, 'include-component-in-tag': false,
  packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION', draft: true, 'force-tag-creation': true } } };
const pr = { number: 29, user: { id: authorId }, head: { repo: { id: product.id }, sha: head,
  ref: 'release-please--branches--main' }, base: { repo: { id: product.id }, ref: product.defaultBranch },
  title: 'chore(main): release 1.1.0', body: upstreamBody, state: 'open', merged: false,
  labels: [{ name: 'autorelease: pending' }] };
const blob = (path, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
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
function render(upstream = upstreamBody, notes = orgNotes, contributors = [person]) {
  return renderOfficialHomepage({ upstreamBody: upstream, template, notes, contributors,
    sourceLink: { label: '查看本版变更', url: 'https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha },
    candidateUrl: 'https://github.com/splrad/fixture/pull/29/files', prUrl: 'https://github.com/splrad/fixture/pull/29' });
}

test('native single-root extraction preserves every byte of rich notes and excludes the footer in both cores', async () => {
  const versions = [ActionPullRequestBody, PullRequestBody];
  for (const expected of [render(), render(upstreamBody, { summary: '本版修复安装。' }, []), render().replace('支持范围', '兼容系统')]) {
    const section = officialNotes(expected);
    assert.equal(section.version, '1.1.0');
    assert.match(section.body, /版本记录/);
    assert.doesNotMatch(section.body, /候选文件差异|技术变更记录|产品文件差异/);
    for (const core of versions) {
      assert.equal(core.parse(expected.replace(/\n/g, '\r\n'), {error() {}, warn() {}}).releaseData[0].notes, section.body);
    }
  }
  const section = officialNotes(render()).body;
  const avatar = parseFragment(section).childNodes.find(node => node.nodeName === 'a');
  assert.equal(avatar?.attrs.find(attr => attr.name === 'href')?.value, person.profileUrl);
  assert.equal(avatar?.childNodes[0]?.attrs.find(attr => attr.name === 'src')?.value, person.avatarUrl);
  assert.match(section, /<summary>贡献者 GitHub ID<\/summary>/);
  assert.match(section, /兼容性与迁移/);
  assert.match(section, /steward doctor/);
  assert.doesNotMatch(officialNotes(render(upstreamBody, { summary: '本版修复安装。' }, [])).body, /贡献者|本次更新/);
  const large = render(upstreamBody.replace('* 支持新版', '技术细节'.repeat(9000)));
  assert.doesNotMatch(large, /技术变更记录/);
  assert.match(large, /候选文件差异/);
  assert.throws(() => officialNotes(upstreamBody.replace('\n\n---\n', '\n\n')), /BOUNDARIES/);
});

test('both cores generate the three native files and choose the same official draft notes', async () => {
  for (const Core of [ActionManifest, Manifest]) {
    const fileMap = { 'release-please-config.json': settings, '.release-please-manifest.json': { '.': '1.0.0' } };
    const commits = [{ sha: sourceSha, message: 'feat: 支持新版', files: ['README.md'] },
      { sha: previousSha, message: 'chore: release 1.0.0', files: ['VERSION'] }];
    let pending = [];
    const github = { repository: { owner: 'splrad', repo: 'fixture' },
      getFileJson: async path => fileMap[path],
      releaseIterator: async function* () { yield {tagName:'v1.0.0',sha:previousSha,notes:'',name:'v1.0.0'}; },
      mergeCommitIterator: async function* () { yield* commits; },
      pullRequestIterator: async function* (_branch, state) { if (state === 'MERGED') yield* pending; } };
    const manifest = await Core.fromManifest(github, 'main');
    const [candidate, extra] = await manifest.buildPullRequests();
    assert.equal(extra, undefined);
    assert.equal(candidate.version.toString(), '1.1.0');
    assert.equal(candidate.headRefName, pr.head.ref);
    assert.equal(candidate.title.toString(), pr.title);
    assert.deepEqual(candidate.updates.map(update => update.path).sort(), ['.release-please-manifest.json', 'CHANGELOG.md', 'VERSION']);
    const rendered = render(candidate.body.toString());
    pending = [{number:pr.number, sha:sourceSha, title:pr.title, headBranchName:pr.head.ref,
      baseBranchName:'main', labels:candidate.labels, body:rendered}];
    const [release] = await manifest.buildReleases();
    assert.equal(release.notes, officialNotes(rendered).body);
    assert.equal(release.sha, sourceSha);
    assert.equal(release.tag.toString(), 'v1.1.0');
    assert.equal(release.draft, true);
    assert.equal(release.forceTag, true);
  }
});

test('pinned central rendering needs no product Mustache and excludes committers and identified services', async () => {
  const author = { id: person.id, login: person.login, html_url: person.profileUrl, avatar_url: person.avatarUrl, type: 'User' };
  const commits = [{ sha: sourceSha, commit: { message: 'fix: 修复安装' }, author, committer: { ...author, id: 555 } },
    { sha: controllerSha, commit: { message: 'docs: 更新开发说明' },
      author: { ...author, id: 19864447, login: 'web-flow' } }];
  const get = async path => {
    if (path.startsWith('contents/release-please-config.json?ref=')) return blob('release-please-config.json', settings);
    if (path === 'contents/.release-please-manifest.json?ref=' + sourceSha) return blob('.release-please-manifest.json', { '.': '1.0.0' });
    if (path === 'contents/.release-please-manifest.json?ref=' + head) return blob('.release-please-manifest.json', { '.': '1.1.0' });
    if (path === 'contents/.github/delivery.json?ref=' + sourceSha) return blob('.github/delivery.json', { schemaVersion: 3 });
    if (path === 'commits/tags%2Fv1.0.0') return { sha: previousSha };
    if (path === 'compare/' + previousSha + '...' + sourceSha + '?per_page=100&page=1')
      return { status: 'ahead', base_commit: { sha: previousSha }, merge_base_commit: { sha: previousSha }, total_commits: 2, commits };
    assert.fail(path);
  };
  const homepage = await renderOfficialPull(pr, product, get, authorId, sourceSha, template);
  assert.equal(homepage.templateDigest, bodyDigest(template));
  assert.match(homepage.notes.body, /修复安装/);
  assert.match(homepage.notes.body, /contributor/);
  assert.doesNotMatch(homepage.notes.body, /555|web-flow|更新开发说明/);
  assert.match(homepage.notes.body, new RegExp(previousSha + '\\.\\.\\.' + sourceSha));
});

test('verified merge uses the original event and exact source after the default branch has advanced', async () => {
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
  merged.body = merged.body.replace('仅支持已审定', '合并后改为');
  await assert.rejects(verifyOfficialMerge(event, product, get, authorId), /MERGE_BODY_DRIFT/);
});

test('old open candidate can coexist while the official writer uses its own branch and duplicate head is retained', async () => {
  const identity = { product, sourceSha, event: { kind: 'push', repositoryId: product.id, sourceSha }, runId: 1, requestKey: 'k', controllerSha };
  const old = { ...pr, head: { ...pr.head, ref: 'steward/release-candidate' } };
  const fork = { ...pr, number: 50, head: { ...pr.head, repo: { id: 999 } } };
  const open = [old, fork];
  const get = async path => {
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
    if (path === 'git/commits/' + head) return { sha: head, parents: [{ sha: sourceSha }] };
    if (path.startsWith('contents/release-please-config.json?')) return blob('release-please-config.json', settings);
    if (path.startsWith('contents/.release-please-manifest.json?')) return blob('.release-please-manifest.json', { '.': '1.0.0' });
    if (path.startsWith('pulls?')) return open;
    if (path.startsWith('issues?')) return [];
    assert.fail(path);
  };
  const options = { identity, get, prepareParticipation: async () => ({ status: 'APPLICABLE', sourceSha }), restore: async () => false };
  const fresh = await prepareOfficialPush(options);
  assert.equal(fresh.mode, 'action');
  assert.deepEqual(fresh.checkpoint.initial, []);
  open.push(pr);
  assert.deepEqual(await prepareOfficialPush(options), { result: 'candidate_unchanged' });
  assert.deepEqual(await prepareOfficialPush({ ...options, restore: async () => true }), { mode: 'resume' });
  await assert.rejects(prepareOfficialPush({ ...options, restore: async name => name === 'before' }), /ACTION_RESULT_UNKNOWN/);
});

test('only the action-produced head is rendered and retries protect human edits and stale heads', async () => {
  const output = JSON.stringify([{ number: pr.number, headBranchName: pr.head.ref, baseBranchName: 'main', body: upstreamBody }]);
  const before = { sourceSha, initial: [] };
  let live = { ...pr }, writes = 0;
  const get = async path => {
    if (path === 'pulls/29') return live;
    if (path === 'git/commits/' + head) return { sha: head, parents: [{ sha: sourceSha }] };
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
    if (path.startsWith('contents/release-please-config.json?')) return blob('release-please-config.json', settings);
    if (path.startsWith('contents/.release-please-manifest.json?')) return blob('.release-please-manifest.json', { '.': '1.1.0' });
    assert.fail(path);
  };
  const observed = await captureOfficialAction({ checkpoint: officialActionResult(output, before), product, get });
  const checkpoint = observed.pulls[0];
  assert.equal(checkpoint.upstreamDigest, bodyDigest(upstreamBody));
  const proposal = render();
  const options = { product, get, patch: async (_number, body) => { writes++; live = { ...live, body }; throw Error('response lost'); },
    sourceSha, checkpoint, template, render: () => ({ body: proposal, templateDigest: bodyDigest(template), notes: officialNotes(proposal) }) };
  assert.equal((await finishOfficialPull(options)).status, 'rendered');
  assert.equal((await finishOfficialPull(options)).status, 'body_retained');
  live.body = live.body.replace('检查安装', '核查正式版安装');
  const human = live.body;
  assert.equal((await finishOfficialPull(options)).status, 'body_retained');
  assert.equal(live.body, human);
  live.head = { ...live.head, sha: controllerSha };
  assert.equal((await finishOfficialPull(options)).status, 'superseded');
  assert.equal(writes, 1);
});
