import { expect, it } from 'vitest';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { Version } from 'release-please/build/src/version.js';
import { NativeReleasePlanner } from '../src/release-plan.js';
import catalog from '../../../config/repositories.json' with { type: 'json' };
const S = 'a'.repeat(40), P = 'b'.repeat(40), Q = 'c'.repeat(40), before = 'd'.repeat(40);
function fixture(enabled = true) {
  const config: any = structuredClone(catalog), policy = config.repositories['1187527897'];
  policy.release.enabled = enabled; policy.release.units.layerscape.enabled = enabled;
  const descriptor = { schemaVersion: 1, units: [{ id: 'layerscape', displayName: 'LayerScape', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/layerscape.md', signingPolicy: 'none', builds: [{ id: 'win', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['app'] }], artifacts: [{ id: 'app', file: 'app-${version}.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'win', required: true }], channels: [] }] };
  const pull = { number: 42, user: { id: 301115370 }, head: { ref: 'release-please--branches--main', sha: 'e'.repeat(40), repo: { id: 1187527897 } }, base: { ref: 'main', repo: { id: 1187527897 } }, merged_at: '2026-10-24T00:00:00Z' as string | null, merge_commit_sha: S, state: 'closed', labels: [{ name: 'autorelease: pending' }], body: new PullRequestBody([{ version: Version.parse('9.2.3'), notes: '## [9.2.3]\n\nfixture' }]).toString() };
  const releases: any[] = [], runs: any[] = [], calls: string[][] = [];
  const blob = (data: unknown) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') });
  const routes: Record<string, any> = {
    'repos/splrad/steward': { id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' }, 'repos/splrad/steward/commits/main': { sha: Q },
    [`repos/splrad/steward/contents/config/repositories.json?ref=${Q}`]: () => blob(config), [`repos/splrad/steward/compare/${P}...${Q}`]: { status: 'ahead', merge_base_commit: { sha: P } },
    'repos/splrad/LayerScape': { id: 1187527897, full_name: 'splrad/LayerScape', default_branch: 'main' },
    'repos/splrad/LayerScape/pulls?state=all&base=main&per_page=100': [[pull]], 'repos/splrad/LayerScape/releases?per_page=100': [releases],
    'repos/splrad/LayerScape/commits/main': { sha: S },
    [`repos/splrad/steward/contents/config/release/defaults.json?ref=${P}`]: blob({ draft: true, 'force-tag-creation': true, 'include-component-in-tag': false }),
    [`repos/splrad/steward/contents/config/release/bootstrap.json?ref=${P}`]: blob({ '1187527897': before }),
    'repos/splrad/LayerScape/commits/v9.2.2': { sha: before }, [`repos/splrad/LayerScape/compare/${before}...${S}`]: { status: 'ahead', merge_base_commit: { sha: before } },
    [`repos/splrad/LayerScape/commits/${S}`]: { sha: S, parents: [{ sha: before }] }, 'repos/splrad/LayerScape/commits/v9.2.3': { sha: S },
    [`repos/splrad/LayerScape/contents/.release-please-manifest.json?ref=${S}`]: blob({ '.': '9.2.3' }),
    [`repos/splrad/LayerScape/contents/.release-please-manifest.json?ref=${before}`]: blob({ '.': '9.2.2' }),
    [`repos/splrad/LayerScape/contents/release-please-config.json?ref=${S}`]: blob({ draft: true, 'force-tag-creation': true, 'include-component-in-tag': false, 'bootstrap-sha': before, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION', 'changelog-path': 'CHANGELOG.md' } } }),
    [`repos/splrad/LayerScape/contents/.github/steward-release.json?ref=${S}`]: blob(descriptor),
    'repos/splrad/LayerScape/actions/workflows/steward-release-publish.yml': { id: 10, path: '.github/workflows/steward-release-publish.yml' },
    [`repos/splrad/LayerScape/actions/workflows/10/runs?event=workflow_dispatch&head_sha=${S}&per_page=100`]: () => [{ total_count: runs.length, workflow_runs: runs }],
  };
  const planner = new NativeReleasePlanner(async args => {
    calls.push([...args]);
    if (args[0] !== 'api') throw new Error('fixture write not registered');
    const value = routes[args.at(-1)!]; if (!value) throw new Error('unregistered read: ' + args.at(-1));
    return JSON.stringify(typeof value === 'function' ? value() : value);
  });
  const draft = () => releases.push({ id: 50, author: { id: 301115370 }, tag_name: 'v9.2.3', draft: true, immutable: false });
  const run = (status: string, conclusion: string | null = null) => runs.push({ id: 70, run_attempt: 1, workflow_id: 10, event: 'workflow_dispatch', head_sha: S, repository: { id: 1187527897 }, head_repository: { id: 1187527897 }, display_title: 'Publish layerscape / v9.2.3 / 50', status, conclusion });
  return { planner, config, calls, routes, pull, releases, runs, draft, run };
}
it('does not call target APIs when release capability is disabled', async () => {
  const f = fixture(false); expect((await f.planner.inspect(1187527897, P, 'before')).mode).toBe('not-enabled');
  expect(f.calls.every(args => args.at(-1)!.startsWith('repos/splrad/steward'))).toBe(true);
});
it('allows release-only for an exact merged native candidate, but no next PR', async () => {
  const f = fixture(); const plan = await f.planner.inspect(1187527897, P, 'before');
  expect(plan.should_run_release).toBe(true); expect(plan.should_run_pr).toBe(false);
  expect(plan.units[0]).toMatchObject({ unitId: 'layerscape', version: '9.2.3', tag: 'v9.2.3', releasePr: 42, releaseId: null, S });
  expect((await f.planner.inspect(1187527897, P, 'after')).should_run_pr).toBe(false);
});
it('recovers a draft even when the Action output was lost, and waits for an active run', async () => {
  const f = fixture(); f.draft(); f.run('queued');
  const plan = await f.planner.inspect(1187527897, P, 'after');
  expect(plan.mode).toBe('recover'); expect(plan.units[0]!.releaseId).toBe(50);
  expect(await f.planner.dispatch(1187527897, 'layerscape', 50, 42, P)).toEqual({ status: 'waiting', runId: 70 });
  expect(f.calls.every(args => args[0] === 'api')).toBe(true);
});
it('does not create another PR for an open or closed editing candidate', async () => {
  const f = fixture(); f.pull.merged_at = null; f.pull.labels = [{ name: 'release:editing' }];
  for (const state of ['open', 'closed']) { f.pull.state = state; expect((await f.planner.inspect(1187527897, P, 'after')).should_run_pr).toBe(false); }
});
it.each(['unknown-draft', 'wrong-tag', 'partial-tagged', 'policy', 'untrusted-pr', 'partial-pagination'])('rejects %s platform state', async kind => {
  const f = fixture();
  if (kind === 'unknown-draft') f.releases.push({ id: 99, tag_name: 'v8.0.0', draft: true });
  if (kind === 'wrong-tag') { f.draft(); f.routes['repos/splrad/LayerScape/commits/v9.2.3'] = { sha: before }; }
  if (kind === 'partial-tagged') f.pull.labels = [{ name: 'autorelease: tagged' }];
  if (kind === 'policy') f.routes[`repos/splrad/steward/compare/${P}...${Q}`].merge_base_commit.sha = before;
  if (kind === 'untrusted-pr') f.pull.user.id = 123;
  if (kind === 'partial-pagination') f.routes['repos/splrad/LayerScape/releases?per_page=100'] = {};
  await expect(f.planner.inspect(1187527897, P, 'before')).rejects.toThrow('RELEASE_PLAN');
});
it('requires successful exact verify job before advancing beyond a published release', async () => {
  const f = fixture(); f.draft(); f.releases[0].draft = false; f.releases[0].immutable = true; f.run('completed', 'success');
  const path = 'repos/splrad/LayerScape/actions/runs/70/attempts/1/jobs?per_page=100';
  f.routes[path] = [{ total_count: 1, jobs: [{ id: 1, name: 'publish / build', status: 'completed', conclusion: 'success', head_sha: S }] }];
  expect((await f.planner.inspect(1187527897, P, 'after')).should_run_pr).toBe(false);
  f.routes[path][0].jobs[0].name = 'publish / verify';
  expect((await f.planner.inspect(1187527897, P, 'after')).should_run_pr).toBe(true);
});

it.each([undefined, { id: 42 }, { id: '301115370' }])('rejects a matching draft with an untrusted creator %j before recovery', async author => {
  const f = fixture(); f.draft(); f.releases[0].author = author;
  await expect(f.planner.dispatch(1187527897, 'layerscape', 50, 42, P)).rejects.toThrow('untrusted release creator');
  expect(f.calls.every(args => args[0] === 'api')).toBe(true);
});

it.each(['missing-draft', 'published', 'package-override', 'plugin', 'extra-file'])('blocks unsafe native configuration before writer planning: %s', async kind => {
  const f = fixture();
  const path = `repos/splrad/LayerScape/contents/release-please-config.json?ref=${S}`;
  const config = JSON.parse(Buffer.from(f.routes[path].content, 'base64').toString());
  if (kind === 'missing-draft') delete config.draft;
  if (kind === 'published') config.draft = false;
  if (kind === 'package-override') config.packages['.'].draft = false;
  if (kind === 'plugin') config.plugins = ['node-workspace'];
  if (kind === 'extra-file') config.packages['.']['extra-files'] = ['unowned.json'];
  f.routes[path].content = Buffer.from(JSON.stringify(config)).toString('base64');
  await expect(f.planner.inspect(1187527897, P, 'before')).rejects.toThrow('untrusted Release Please configuration');
  expect(f.calls.some(args => args.at(-1)!.includes('/releases?'))).toBe(false);
});
