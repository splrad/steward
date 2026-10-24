import { expect, it } from 'vitest';
import 'release-please';
import { Simple } from 'release-please/build/src/strategies/simple.js';
import { Node } from 'release-please/build/src/strategies/node.js';
import { Python } from 'release-please/build/src/strategies/python.js';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';
import { Version } from 'release-please/build/src/version.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
const scm = (files: Record<string, string> = {}) => ({
  repository: { owner: 'fixture', repo: 'product' },
  async getFileContentsOnBranch(path: string) {
    if (!(path in files)) throw new Error('unregistered fixture file: ' + path);
    return { content: Buffer.from(files[path]!).toString('base64'), parsedContent: files[path], sha: 'a'.repeat(40) };
  },
  async findFilesByFilenameAndRef() { return []; },
});
const latest = (version: string, component?: string) => ({ tag: new TagName(Version.parse(version), component), sha: 'b'.repeat(40), notes: 'previous' });
const commits = (message: string) => parseConventionalCommits([{ sha: 'c'.repeat(40), message, files: ['source'] }]);
it.each([['fix: 修复路径', '9.2.3'], ['feat: 新增功能', '9.3.0'], ['feat!: 调整接口', '10.0.0']])('uses bundled upstream simple strategy for %s', async (message, version) => {
  const strategy = new Simple({ github: scm() as any, targetBranch: 'main', versionFile: 'VERSION', includeComponentInTag: false });
  const pr = await strategy.buildReleasePullRequest(commits(message!), latest('9.2.2'));
  expect(pr!.version!.toString()).toBe(version);
  const update = pr!.updates.find(update => update.path === 'VERSION')!;
  expect(update.updater.updateContent('9.2.2\n')).toBe(version + '\n');
  expect(pr!.updates.map(update => update.path)).toContain('CHANGELOG.md');
  expect(PullRequestBody.parse(pr!.body.toString())).toBeDefined();
});
it('does not create a release PR for no changes or an ordinary direct commit', async () => {
  const strategy = new Simple({ github: scm() as any, targetBranch: 'main', versionFile: 'VERSION' });
  expect(await strategy.buildReleasePullRequest([], latest('9.2.2'))).toBeUndefined();
  expect(await strategy.buildReleasePullRequest(commits('ordinary direct commit'), latest('9.2.2'))).toBeUndefined();
});
it('uses native Node and Python updates in separate unit paths', async () => {
  const files = { 'packages/web/package.json': '{"name":"@fixture/web","version":"1.2.3"}\n',
    'packages/python/pyproject.toml': '[project]\nname = "fixture-python"\nversion = "2.3.4"\n' };
  const github = scm(files) as any;
  const node = new Node({ github, targetBranch: 'main', path: 'packages/web', component: 'web' });
  const python = new Python({ github, targetBranch: 'main', path: 'packages/python', component: 'python' });
  const nodePr = await node.buildReleasePullRequest(commits('feat: 添加接口'), latest('1.2.3', 'web'));
  const pythonPr = await python.buildReleasePullRequest(commits('fix: 修复解析'), latest('2.3.4', 'python'));
  expect(JSON.parse(nodePr!.updates.find(update => update.path === 'packages/web/package.json')!.updater.updateContent(files['packages/web/package.json'])).version).toBe('1.3.0');
  expect(pythonPr!.updates.find(update => update.path === 'packages/python/pyproject.toml')!.updater.updateContent(files['packages/python/pyproject.toml'])).toContain('version = "2.3.5"');
  expect(nodePr!.updates.some(update => update.path === 'packages/web/package-lock.json')).toBe(true);
  for (const pr of [nodePr!, pythonPr!]) expect(PullRequestBody.parse(pr.body.toString())).toBeDefined();
});
