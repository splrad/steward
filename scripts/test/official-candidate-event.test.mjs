import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFragment } from 'parse5';
import YAML from 'yaml';
import { candidateBaseUnchanged, copilotReleaseClient, EvidenceReadError, isolatedBuildEnvironment, officialCandidateDiff } from '../../packages/runner/dist/index.js';
import { Manifest } from 'release-please';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { bodyDigest, computeOfficialCandidate, draftOfficialCandidate, officialCandidateEvidence, officialCandidateRoundId, officialMergeKey,
  officialNotes, officialRoundMarker, renderOfficialHomepage, validateOfficialMergeEvent, verifyOfficialMerge } from '../official-release-candidate.mjs';
import { candidateDiagnostic, candidateEvent, officialCandidateRoute, prepareOfficialCandidate } from '../official-candidate-event.mjs';
import { compatibleExistingCandidate, writeOfficialCandidate } from '../official-candidate-write.mjs';
import { classifyPull, impactTarget } from '../pr-release-impact.mjs';

const sourceSha = 'a'.repeat(40), head = 'b'.repeat(40), controllerSha = 'c'.repeat(40), previousSha = 'd'.repeat(40);
const product = { id: 17, name: 'splrad/fixture', defaultBranch: 'main' }, authorId = 301115370;

test('the candidate log retains the isolated SDK failure and excludes untrusted provider fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-sdk-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'tools', 'quality-language');
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'release-notes.mjs');
  const client = copilotReleaseClient(root, 'fixture');
  const failure = { status: 'FAILED', errorCode: 'RESPONSE_UNKNOWN', diagnostic: {
    sdkStage: 'send', sdkErrorType: 'policy', status: 403, message: 'private provider text' } };
  await writeFile(script, 'console.log(' + JSON.stringify(JSON.stringify(failure)) + ')');
  await assert.rejects(client.call('{}'), error =>
    candidateDiagnostic(error, 'generate') === 'RESPONSE_UNKNOWN stage=generate sdk_stage=send sdk_error=policy status=403');
  assert.equal(candidateDiagnostic({ ...failure.diagnostic, message: 'RESPONSE_UNKNOWN',
    sdkStage: 'private input', sdkErrorType: 'private details' }, 'generate'), 'RESPONSE_UNKNOWN stage=generate status=403');
  for (const invalid of ['process.exit(1)', 'console.log("[]")', 'console.log(\'{"status":"RETURNED"}\')']) {
    await writeFile(script, invalid);
    await assert.rejects(client.call('{}'), error =>
      candidateDiagnostic(error, 'generate') === 'RESPONSE_UNKNOWN stage=generate sdk_stage=process');
  }
});
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

test('candidate diff reads the complete immutable range beyond GitHub file pagination', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-candidate-diff-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd: directory, env: isolatedBuildEnvironment(process.env, directory), encoding: 'utf8', input });
  git(['init', '--quiet']);
  const baselineSha = git(['commit-tree', git(['write-tree']).trim()], 'baseline\n').trim();
  const oid = git(['hash-object', '-w', '--stdin'], '真实变更\n').trim();
  const records = Array.from({ length: 3001 }, (_, index) => '100644 ' + oid + '\tfile-' + index + '.txt\n');
  git(['update-index', '--index-info'], records.join(''));
  const sourceSha = git(['commit-tree', git(['write-tree']).trim(), '-p', baselineSha], 'contents\n').trim();
  const evidence = await officialCandidateDiff(directory, sourceSha, baselineSha);
  const text = evidence.map((chunk, index) => {
    const { start, end, text } = chunk.details;
    assert.equal(chunk.kind, 'source-range-diff');
    assert.equal(chunk.details.sourceSha, sourceSha);
    assert.equal(chunk.details.baselineSha, baselineSha);
    assert.equal(start, evidence[index - 1]?.details.end ?? 0);
    assert.equal(end - start, Buffer.byteLength(text));
    return text;
  }).join('');
  assert.equal(text, git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=2', baselineSha, sourceSha, '--']));
  assert.equal((text.match(/^\+真实变更$/gm) ?? []).length, records.length);
  assert.deepEqual((await officialCandidateDiff(directory, sourceSha, null)).map(chunk => chunk.details.text).join(''), text);
});

test('Internal labels filter every writing source and preserve mixed PRs and direct commits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-release-labels-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd: directory, encoding: 'utf8', env: isolatedBuildEnvironment(process.env, directory) }).trim();
  git('init', '--quiet');
  const manual = '使用 手册.md';
  await writeFile(join(directory, manual), 'old-public-option\n');
  git('add', manual);
  git('commit', '-qm', 'baseline');
  const baseline = { tag: 'v1.0.0', sha: git('rev-parse', 'HEAD') };
  const commits = [];
  async function commit(path, contents, message) {
    const parent = git('rev-parse', 'HEAD');
    await writeFile(join(directory, path), contents);
    git('add', path);
    git('commit', '-qm', message);
    const sha = git('rev-parse', 'HEAD');
    commits.push({ sha, parents: [{ sha: parent }], commit: { message } });
    return sha;
  }
  const internal = await commit(manual, 'old-public-option\ninternal-only-sentinel\nprivate-deleted-sentinel\n', 'internal-only-sentinel');
  const visible = await commit(manual, 'internal-only-sentinel\nvisible-usage\n', 'mixed PR adds public usage');
  const direct = await commit('direct.txt', 'direct-feature\n', 'direct feature');
  const candidate = { base: 'main', head: pr.head.ref, version: '1.1.0', body: upstreamBody,
    files: [{ path: 'CHANGELOG.md', content: 'range-wide-sentinel' }] };
  const pull = (number, labels, title) => ({ number, labels: labels.map(name => ({ name })), title, body: title,
    base: pr.base, merged_at: '2026-01-01T00:00:00Z' });
  const labels = new Map([[internal, [pull(40, ['iNteRnal'], 'internal-only-sentinel')]],
    [visible, [pull(41, ['auto/docs'], 'mixed change')]], [direct, []]]);
  async function collect(sourceSha = direct) {
    return officialCandidateEvidence({ product, sourceSha, baseline, candidate, directory: async () => directory,
      getPages: async path => labels.get(path.split('/')[1]),
      get: async path => {
        if (path === 'contents/release-please-config.json?ref=' + sourceSha) return blob('release-please-config.json', settings);
        if (path === 'contents/.github/delivery.json?ref=' + sourceSha) return blob('.github/delivery.json', { schemaVersion: 3 });
        if (path.startsWith('compare/')) return { base_commit: baseline, merge_base_commit: baseline, status: 'ahead',
          total_commits: commits.length, commits };
        assert.fail('unexpected range-wide source: ' + path);
      } });
  }
  const result = await collect();
  const material = JSON.stringify(result.evidence);
  assert.match(material, /mixed change/);
  assert.match(material, /visible-usage/);
  assert.match(material, /-old-public-option/);
  assert.match(material, /direct-feature/);
  assert.doesNotMatch(material, /internal-only-sentinel|private-deleted-sentinel|range-wide-sentinel/);
  for (const sha of [visible, direct]) labels.set(sha, [pull(42, ['Internal'], 'internal-only-sentinel')]);
  const context = await collect();
  assert.deepEqual(context.evidence.map(item => item.kind), ['maintenance-only']);
  const draft = await draftOfficialCandidate({ roundId: 'e'.repeat(64), candidate, context, product, sourceSha: direct,
    template, call: () => assert.fail('purely internal release does not need model inference') });
  assert.match(officialNotes(draft.body).body, /本版仅包含项目内部维护/);

  const baseBranch = git('branch', '--show-current');
  git('switch', '-qc', 'feature');
  const side = await commit('feature.txt', 'feature-from-merge\n', 'changes on topic');
  labels.set(side, []);
  git('switch', '-q', baseBranch);
  git('merge', '--no-ff', '-qm', 'merge topic', 'feature');
  const merge = git('rev-parse', 'HEAD');
  commits.push({ sha: merge, parents: [{sha:direct},{sha:side}], commit: {message:'merge topic'} });
  labels.set(merge, [pull(43, [], 'visible PR')]);
  const mergePatch = async () => (await collect(merge)).evidence
    .filter(item => item.kind === 'source-range-diff' && item.details.sourceSha === merge)
    .map(item => item.details.text).join('');
  assert.match(await mergePatch(), /\+feature-from-merge/);
  const cleanMerge = (await collect(merge)).evidence.filter(item => item.kind === 'source-range-diff');
  assert.equal(cleanMerge.some(item => item.details.sourceSha === side), false);
  assert.equal(cleanMerge.flatMap(item => item.details.text.match(/\+feature-from-merge/g) ?? []).length, 1);
  labels.set(side, [pull(44, ['Internal'], 'embedded maintenance')]);
  assert.doesNotMatch(JSON.stringify((await collect(merge)).evidence), /feature-from-merge|embedded maintenance/);
  labels.set(side, []);
  labels.set(merge, [pull(43, ['Internal'], 'internal merge')]);
  assert.deepEqual((await collect(merge)).evidence.map(item => item.kind), ['maintenance-only']);

  git('switch', '-qc', 'conflict-side');
  const hiddenParent = await commit('feature.txt', 'hidden-parent-line\n', 'maintenance side');
  labels.set(hiddenParent, [pull(44, ['Internal'], 'maintenance side')]);
  git('switch', '-q', baseBranch);
  const publicParent = await commit('feature.txt', 'main-visible-line\n', 'visible change');
  labels.set(publicParent, []);
  const publicAddition = await commit('public.txt', 'public-command\n', 'public command');
  labels.set(publicAddition, []);
  assert.throws(() => git('merge', '--no-ff', '-m', 'merge conflict-side', 'conflict-side'));
  await writeFile(join(directory, 'feature.txt'), 'new-resolution-line\n');
  git('add', 'feature.txt');
  git('update-index', '--chmod=+x', 'feature.txt');
  git('rm', 'public.txt');
  git('commit', '-qm', 'resolve integration');
  const resolved = git('rev-parse', 'HEAD');
  commits.push({sha:resolved,parents:[{sha:publicAddition},{sha:hiddenParent}],commit:{message:'resolve integration'}});
  labels.set(resolved, [pull(45, [], 'visible integration')]);
  const conflict = await collect(resolved);
  const resolution = conflict.evidence.filter(item => item.details.sourceSha === resolved).map(item => item.details.text).join('');
  assert.match(resolution, /new-resolution-line/);
  assert.match(resolution, /^-main-visible-line$/m);
  assert.match(resolution, /new mode 100755/);
  assert.match(resolution, /^-public-command$/m);
  assert.doesNotMatch(JSON.stringify(conflict.evidence), /hidden-parent-line/);

  const secretText = 'carried-internal-sentinel\n'.repeat(5);
  const original = await commit('maintenance.txt', secretText, 'housekeeping');
  labels.set(original, [pull(46, ['Internal'], 'housekeeping')]);
  git('mv', 'maintenance.txt', 'renamed.txt');
  await writeFile(join(directory, 'copy.txt'), secretText + 'genuine-new-behavior\n');
  git('add', 'copy.txt');
  git('commit', '-qm', 'publish new behavior');
  const copied = git('rev-parse', 'HEAD');
  commits.push({sha:copied,parents:[{sha:original}],commit:{message:'publish new behavior'}});
  labels.set(copied, [pull(47, [], 'public contribution')]);
  const copyMaterial = JSON.stringify((await collect(copied)).evidence);
  assert.doesNotMatch(copyMaterial, /carried-internal-sentinel/);
  assert.match(copyMaterial, /genuine-new-behavior/);

  const internalConfig = await commit('ci-settings.txt', 'ci-only configuration\nmode=full\ninternal switch for CI\n', 'CI config');
  labels.set(internalConfig, [pull(48, ['Internal'], 'CI config')]);
  const example = await commit('user-guide.txt', 'Run the following example with the public CLI:\nmode=full\n', 'document a CLI option');
  labels.set(example, [pull(49, [], 'CLI example')]);
  const examplePatch = (await collect(example)).evidence
    .filter(item => item.kind === 'source-range-diff' && item.details.sourceSha === example)
    .map(item => item.details.text).join('');
  assert.match(examplePatch, /^\+mode=full$/m);
});

test('a native manual correction wins even when it lands inside the App label request', async () => {
  for (const desired of [true, false]) {
    const repo = {id:pr.base.repo.id,full_name:product.name,owner:{id:302208797},default_branch:'main'};
    const current = {...pr, head:{...pr.head,ref:'change'},base:{...pr.base,sha:sourceSha},changed_files:1,labels:[]};
    const hook = {action:'opened',repository:repo,pull_request:current};
    const events = [], writes = [];
    function record(labeled, actor) {
      events.push({id:events.length + 1,event:labeled?'labeled':'unlabeled',actor:{id:actor},label:{name:'Internal'}});
      current.labels = labeled ? [{name:'Internal'}] : [];
    }
    if (desired) record(true, authorId);
    function write(labeled) {
      if (!writes.length) record(desired, 42);
      writes.push(labeled);
      record(labeled, authorId);
    }
    const io = {pull:async()=>structuredClone(current),events:async()=>events,readme:async()=>'Product',
      files:async()=>[{filename:'ci',patch:'+test',additions:1,deletions:0}],
      ensureLabel:async()=>{},add:async()=>write(true),remove:async()=>write(false)};
    const model = async()=>({text:JSON.stringify({decision:desired?'eligible':'internal',reason:'fixture'})});
    await classifyPull(impactTarget(hook),io,model);
    assert.deepEqual(writes,[!desired,desired]);
    assert.equal(current.labels.length,Number(desired));
    const correction = impactTarget({...hook,action:desired?'labeled':'unlabeled',label:{name:'Internal'},sender:{id:42}});
    assert.equal(await classifyPull(correction,io,()=>assert.fail('no model on label events')),'preserved');
    assert.deepEqual(writes,[!desired,desired]);
  }
});

test('App classifies the current PR, preserves manual changes and releases stale automatic labels on failure', async () => {
  const repo = {id:17, full_name:product.name, owner:{id:302208797}, default_branch:'main'};
  const current = {...pr, head:{...pr.head,ref:'change'}, base:{...pr.base,sha:sourceSha}, changed_files:1,labels:[]};
  const target = impactTarget({action:'opened',repository:repo,pull_request:current});
  assert.ok(target);
  for (const swap of [{title:'a later title'}, {body:'a later description'}]) {
    const changed = {...current,...swap};
    assert.equal(await classifyPull(target,{pull:async()=>changed,events:async()=>[]},
      ()=>assert.fail('obsolete delivery must not use Copilot')),'superseded');
  }
  assert.equal(impactTarget({action:'opened',repository:repo,pull_request:pr}),null);
  let events = [], writes = [];
  const io = { pull:async()=>structuredClone(current), events:async()=>events, readme:async()=>'A deployment tool',
    files:async()=>[{filename:'ci.yml',patch:'@@ -0,0 +1 @@\n+verify',additions:1,deletions:0}],
    ensureLabel:async()=>writes.push('ensure'), add:async()=>writes.push('add'), remove:async()=>writes.push('remove') };
  const internal = async input => {
    assert.match(input,/A deployment tool/);
    return {text:JSON.stringify({decision:'internal',reason:'Only the project tests use this job.'})};
  };
  assert.equal(await classifyPull(target,io,internal),'internal');
  assert.deepEqual(writes,['ensure','add']);
  writes=[];
  assert.equal(await classifyPull(target,io,async input => {
    current.state = 'closed'; current.merged = true;
    return internal(input);
  }), 'internal');
  assert.deepEqual(writes,['ensure','add']);
  writes=[];
  assert.equal(await classifyPull(target,io,internal),'internal');
  assert.deepEqual(writes,['ensure','add']);
  writes=[];
  current.merged = false;
  assert.equal(await classifyPull(target,io,()=>assert.fail('closed without merge')),'preserved');
  current.state = 'open';
  const title = current.title;
  assert.equal(await classifyPull(target,{...io,readme:async()=>{current.title='changed during read';return 'Project';}},
    ()=>assert.fail('material changed before inference')),'superseded');
  current.title = title;
  assert.equal(await classifyPull(target,{...io,readme:async()=>'  '},()=>assert.fail('no project context')),'eligible');
  assert.deepEqual(writes,[]);
  events=[{id:1,event:'unlabeled',actor:{id:9},label:{name:'Internal'}}];
  assert.equal(await classifyPull(target,io,()=>assert.fail()),'preserved');
  events=[];
  assert.equal(await classifyPull(target,io,async input=>{
    const output=await internal(input);
    events.push({id:2,event:'labeled',actor:{id:9},label:{name:'Internal'}});
    current.labels.push({name:'Internal'});
    return output;
  }),'superseded');
  assert.deepEqual(writes,[]);
  events[0].actor.id=authorId;
  await assert.rejects(classifyPull(target,io,async()=>{throw Error('provider unavailable')}),/IMPACT_CLASSIFICATION_UNAVAILABLE/);
  assert.deepEqual(writes,['remove']);
  writes=[];
  assert.equal(await classifyPull(target,{...io,files:async()=>[]},()=>assert.fail()),'eligible');
  assert.deepEqual(writes,['remove']);
  writes=[];
  assert.equal(await classifyPull(target,io,async input=>{
    const output=await internal(input);current.head.sha=sourceSha;return output;
  }),'superseded');
  assert.deepEqual(writes,[]);
});

test('C2 compares the Git objects and modes for every candidate path across an ancestor range', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-candidate-basis-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd: directory, env: isolatedBuildEnvironment(process.env, directory), encoding: 'utf8', input }).trim();
  git(['init', '--quiet']);
  const baseOid = git(['hash-object', '-w', '--stdin'], '旧内容\n');
  const changedOid = git(['hash-object', '-w', '--stdin'], '新内容\n');
  const entry = (mode, oid, path) => mode + ' ' + oid + '\t' + path + '\n';
  const commit = (rows, parent) => {
    git(['read-tree', '--empty']);
    git(['update-index', '--index-info'], rows.join(''));
    return git(['commit-tree', git(['write-tree']), ...(parent ? ['-p', parent] : [])], 'fixture\n');
  };
  const paths = ['VERSION', 'nested/CHANGELOG.md'];
  const stable = entry('100644', baseOid, paths[0]);
  const before = commit([stable]);
  const unrelated = entry('100644', changedOid, 'README.md');
  const equivalent = commit([stable, unrelated], before);
  assert.equal(candidateBaseUnchanged(directory, before, equivalent, paths), true);
  for (const drift of [
    commit([entry('100755', baseOid, paths[0])], before),
    commit([entry('100644', changedOid, paths[0])], before),
    commit([stable, entry('100644', baseOid, paths[1])], before),
    commit([stable, entry('100644', baseOid, 'nested')], before),
    commit([unrelated], before),
    commit([stable, unrelated]),
  ]) assert.equal(candidateBaseUnchanged(directory, before, drift, paths), false);
});

test('requires the official switch and the native product declaration to select a candidate writer', async () => {
  const label = { repositoryId: product.id, prNumber: 29, eventId: 12 };
  const old = { 'separate-pull-requests': false };
  assert.deepEqual(officialCandidateRoute(old, 'true'), { result: 'official_candidate_not_adopted' });
  assert.throws(() => candidateEvent(label, 'a'.repeat(64)), /OFFICIAL_CANDIDATE_EVENT/);
  assert.deepEqual(officialCandidateRoute(settings), { result: 'official_candidate_disabled' });
  assert.deepEqual(officialCandidateRoute(settings, 'false'), { result: 'official_candidate_disabled' });
  assert.deepEqual(officialCandidateRoute(settings, 'true'), { route: 'official' });
  const component = { ...settings, 'include-component-in-tag': true };
  assert.throws(() => officialCandidateRoute(component, 'true'), /ROOT_TAG_CONFIG/);
  const rootComponent = { ...settings, packages: { '.': { ...settings.packages['.'], 'include-component-in-tag': true } } };
  assert.throws(() => officialCandidateRoute(rootComponent, 'true'), /ROOT_TAG_CONFIG/);
  assert.deepEqual(officialCandidateRoute({ ...component, packages: {
    '.': { ...settings.packages['.'], 'include-component-in-tag': false },
  } }, 'true'), { route: 'official' });
  const multi = { ...settings, packages: { ...settings.packages, tools: { 'release-type': 'simple' } } };
  assert.throws(() => officialCandidateRoute(multi, 'true'), /ROOT_CONFIG/);
  assert.deepEqual(officialCandidateRoute(multi, 'false'), { result: 'official_candidate_disabled' });
  assert.throws(() => officialCandidateRoute({}, 'false'), /ROUTE/);

  const workflow = YAML.parse(await readFile('.github/workflows/release-candidate-event.yml', 'utf8'));
  assert.deepEqual(workflow.jobs.event.env, { MISE_ENABLE_TOOLS: 'node,npm' });
  const steps = workflow.jobs.event.steps;
  assert.equal(steps.find(step => step.id === 'candidate-token').if, "steps.check.outputs.mode == 'write'");
  assert.equal(workflow.jobs.event.permissions['copilot-requests'], 'write');
  const secretSteps = steps.filter(step => /secrets\./.test(JSON.stringify(step)));
  assert.deepEqual(secretSteps.map(step => step.id), ['product', 'compute', 'check', 'candidate-token', undefined]);
  for (const step of secretSteps) assert.deepEqual(JSON.stringify(step).match(/secrets\.[A-Z_0-9]+/g), ['secrets.STEWARD_APP_PRIVATE_KEY']);
  const centralReads = steps.filter(step => step.env?.STEWARD_CENTRAL_TOKEN);
  assert.deepEqual(centralReads.map(step => step.run.split(' ').at(-1)), ['identify', 'prepare', 'check', 'write']);
  for (const step of centralReads) assert.equal(step.env.STEWARD_CENTRAL_TOKEN, '${{ github.token }}');
  assert.ok(!steps.some(step => /release-please-action/.test(step.uses ?? '')));
  const model = steps.filter(step => step.env?.STEWARD_COPILOT_TOKEN);
  assert.equal(model.length, 1);
  assert.deepEqual(model[0].env, { STEWARD_COPILOT_TOKEN: '${{ github.token }}' });
  assert.equal(model[0].if, "steps.compute.outputs.mode == 'draft'");
});

function render(upstream = upstreamBody, notes = orgNotes, contributors = [person], roundId = 'a'.repeat(64)) {
  return renderOfficialHomepage({ upstreamBody: upstream, template, notes, contributors,
    sourceLink: { label: '查看本版变更', url: 'https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha },
    filesUrl: 'https://github.com/splrad/fixture/pull/29/files', roundId });
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
  assert.match(section, /<summary>查看贡献者名单<\/summary>/);
  const disclosure = parseFragment(section).childNodes.find(node => node.nodeName === 'details');
  const login = disclosure?.childNodes.find(node => node.nodeName === 'a');
  assert.equal(login?.attrs.find(attr => attr.name === 'href')?.value, person.profileUrl);
  assert.equal(login?.childNodes[0]?.value, person.login);
  assert.doesNotMatch(section, / · .42./);
  const page = render();
  const notice = '请审阅下方版本说明。确认后合并，本次合并将启动该版本的正式构建。';
  assert.ok(page.startsWith('> **审阅提示**\n>\n> ' + notice + '\n>\n> 如需修改，请编辑本 PR 首页描述中的「发行说明」区段。\n\n发行说明'));
  assert.match(page, /发行说明\n---\n\n## 1\.1\.0/);
  const info = page.slice(page.lastIndexOf('\n---\n') + '\n---\n\n'.length);
  assert.deepEqual(info.split('\n'), [
    '> <details>', '> <summary><strong>PR 信息（仅供审阅）</strong></summary>', '>',
    '> 请审阅本版。', '>', '> 产品文件差异。', '>',
    '> [查看候选文件差异](<https://github.com/splrad/fixture/pull/29/files>)', '>',
    '> 本轮候选变更记录 · [查看本版变更](<https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha + '>)',
    '>', '> </details>', '', officialRoundMarker('a'.repeat(64)),
  ]);
  const standardPage = render(upstreamBody.replace('请审阅本版。', notice));
  assert.equal(standardPage.split(notice).length - 1, 1);
  assert.equal(officialNotes(standardPage).body, section);
  assert.equal(officialNotes(page.replace('## 贡献者', '---\n\n## 贡献者')).body, section.replace('## 贡献者', '---\n\n## 贡献者'));
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

test('keeps the creation source on refresh and identifies older PRs without a creation record', async () => {
  const firstSource = 'e'.repeat(40), firstRound = 'f'.repeat(64);
  const openPull = { ...pr, body: '维护者已编辑正文。' };
  let live = null, previous = null;
  const get = async path => {
    if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
    if (path.startsWith('issues?')) return [];
    if (path.startsWith('pulls?')) return live ? [live] : [];
    if (path === 'pulls/' + pr.number) return live;
    if (path === 'git/commits/' + head) return { sha: head, verification: { verified: true },
      parents: [{ sha: firstSource }], message: 'Release\n\nSteward-Candidate-Round: ' + firstRound };
    if (path === 'contents/release-please-config.json?ref=' + sourceSha) return blob('release-please-config.json', settings);
    if (path === 'contents/.release-please-manifest.json?ref=' + sourceSha) return blob('.release-please-manifest.json', { '.': '1.0.0' });
    if (path === 'commits/tags%2Fv1.0.0') return { sha: previousSha };
    if (path.startsWith('compare/')) return { status: 'ahead', merge_base_commit: { sha: previousSha } };
    assert.fail(path);
  };
  const store = { find: async () => null,
    read: async id => id === firstRound ? previous : { source: null },
    save: async (id, phase, data) => { assert.equal(phase, 'source'); return { source: data }; } };
  const prepare = () => prepareOfficialCandidate({ identity: { product, event: { kind: 'push' }, sourceSha }, get, store,
    buildCandidate: async () => computed, collectEvidence: async () => ({}),
    prepareParticipation: async () => ({ status: 'APPLICABLE', sourceSha }) });
  assert.deepEqual((await prepare()).creationRange, { base: previousSha, head: sourceSha });
  live = openPull;
  previous = { pull: { number: pr.number, head }, source: { prior: null, baseline: { sha: null }, sourceSha: firstSource } };
  assert.deepEqual((await prepare()).creationRange, { base: null, head: firstSource });
  previous.source = { prior: { number: pr.number, head }, creationRange: { base: previousSha, head: firstSource } };
  assert.deepEqual((await prepare()).creationRange, previous.source.creationRange);
  previous.pull.number++;
  assert.equal((await prepare()).creationRange, null);
  previous.pull.number = pr.number;
  delete previous.source.creationRange;
  assert.equal((await prepare()).creationRange, null);
});

test('restores a saved calculation and draft before contacting Release Please or Copilot again', async () => {
  let hasDraft = true, hasPull = false, collectCount = 0;
  let nativePull = { ...pr, body: '人工修订后的原始正文' };
  let candidateRef = head;
  const identity = { product, event: { kind: 'push' }, sourceSha };
  const get = async path => {
    if (path === 'pulls/29') return nativePull;
    if (path === 'git/ref/heads/' + computed.head) {
      if (!candidateRef) throw new EvidenceReadError(404, null);
      return { ref: 'refs/heads/' + computed.head, object: { type: 'commit', sha: candidateRef } };
    }
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
  assert.equal(nativePull.body, '人工修订后的原始正文');
  nativePull = { ...nativePull, state: 'closed' };
  assert.equal((await prepare()).result, 'candidate_closed');
  nativePull = { ...nativePull, merged: true };
  assert.equal((await prepare()).result, 'candidate_merged');
  nativePull = { ...pr, labels: [] };
  await assert.rejects(prepare, /COMPLETED_PULL_DRIFT/);
  nativePull = { ...pr, head: { ...pr.head, sha: controllerSha } };
  await assert.rejects(prepare, /COMPLETED_PULL_DRIFT/);
  nativePull = { ...pr };
  candidateRef = null;
  await assert.rejects(prepare, /COMPLETED_PULL_DRIFT/);
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
    if (path === 'pulls/29') return pr;
    if (path === 'git/ref/heads/' + computed.head)
      return { ref: 'refs/heads/' + computed.head, object: { type: 'commit', sha: head } };
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
    collectEvidence: ({ candidate, sourceSha, baseline }) => {
      assert.equal(sourceSha, archived.sourceSha);
      assert.deepEqual(baseline, archived.baseline);
      assert.deepEqual(candidate, archived.candidate);
      return {};
    },
  });
  const restoredSource = await prepare();
  assert.equal(restoredSource.mode, 'draft');
  assert.equal(restoredSource.evidenceSourceSha, archived.sourceSha);
  assert.deepEqual(restoredSource.candidate, archived.candidate);
  assert.equal(boundSource, controllerSha);
  await assert.rejects(draftOfficialCandidate({ roundId: datedRound, candidate: archived.candidate, product,
    sourceSha: archived.sourceSha, template, context: { evidence: [], unit: { id: 'root', path: '.' } },
    call: async () => { throw Error('CONTENT_CONTEXT_LIMIT'); },
  }), /CONTENT_CONTEXT_LIMIT/);
  assert.equal(saved.draft, null);
  assert.equal((await prepare()).mode, 'draft');
  assert.equal(builds, 1);
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
  const initialSha = 'f'.repeat(40);
  const templateNote = '此处可查看本版使用的源码。';
  const updatedTemplate = template + '\n' + templateNote + '\n';
  const draft = await draftOfficialCandidate({ roundId, candidate: computed, context, product, sourceSha, template: updatedTemplate,
    creationRange: { base: previousSha, head: initialSha },
    call: async input => {
      const value = JSON.parse(input);
      assert.equal(value.organizationTemplate, updatedTemplate);
      assert.ok(!value.prompt.includes(templateNote));
      assert.match(value.prompt, /以中文为主体语言/);
      assert.match(value.constraints, /按 organizationTemplate 的栏目及注释填写适用内容/);
      assert.equal(value.sources[0].details.instruction, '升级前备份设置。');
      return { text: JSON.stringify({ paragraphs: [{
        section: 'requiredActions', sourceIds: [value.sources[0].id], qualification: 'SOURCE_CONFIRMED',
        textZh: '**升级用户**。升级前备份设置。',
      }] }) };
    },
  });
  const section = officialNotes(draft.body);
  assert.ok(section.body.includes(templateNote));
  assert.equal(draft.templateDigest, bodyDigest(updatedTemplate));
  assert.ok(draft.body.includes('> 创建 PR 时的变更记录 · ['));
  assert.ok(draft.body.includes('/compare/' + previousSha + '...' + initialSha));
  assert.ok(!section.body.includes(initialSha));
  assert.ok(draft.body.includes('**Files changed**'));
  assert.match(section.body, /> \[!IMPORTANT\][\s\S]+升级前备份设置/);
  assert.match(section.body, /版本记录/);
  assert.doesNotMatch(section.body, /获取与使用|本次更新|候选文件差异/);
  assert.equal(PullRequestBody.parse(draft.body).releaseData[0].notes, section.body);
});

test('C1 permits the versioned Release page and stops unverified asset links anywhere in the draft', async () => {
  const context = {
    unit: { id: 'root', path: '.', version: computed.version, tag: 'v1.1.0' }, tag: 'v1.1.0', contributors: [],
    sourceLink: { label: '查看本版变更', url: 'https://github.com/splrad/fixture/compare/' + previousSha + '...' + sourceSha },
    evidence: [{ kind: 'delivery', details: { releasePage: 'https://github.com/splrad/fixture/releases/tag/v1.1.0' } }],
  };
  const draft = (section, url) => draftOfficialCandidate({ roundId, candidate: computed, context, product, sourceSha, template,
    call: async input => ({ text: JSON.stringify({ paragraphs: [{
      section, sourceIds: [JSON.parse(input).sources[0].id], qualification: 'SOURCE_CONFIRMED',
      textZh: '**获取本版**。前往[本版发布页面](' + url + ')。',
    }] }) }),
  });
  const releasePage = context.evidence[0].details.releasePage;
  assert.match((await draft('acquisition', releasePage)).body, /releases\/tag\/v1\.1\.0/);
  const asset = 'https://github.com/splrad/fixture/releases/download/v1.1.0/Unverified.exe';
  await assert.rejects(draft('acquisition', asset), /C1_ACQUISITION_LINKS/);
  await assert.rejects(draft('delivery', asset), /C1_ACQUISITION_LINKS/);
  await assert.rejects(draft('delivery', 'https://github.com/splrad/fixture/releases/latest/download/Unverified.exe'), /C1_ACQUISITION_LINKS/);
});

test('refresh replaces the older draft and preserves edits made after the current round was delivered', async () => {
  const previousPull = { ...pr, body: '旧轮有人工修改。' };
  const revisedBody = expectedBody.replace('支持范围', '本轮人工修订');
  for (const scenario of ['older-round', 'current-round', 'closed']) {
    const writes = [];
    const round = { source: { ...source, prior: { number: pr.number, head: previousSha } },
      draft: { body: expectedBody, templateDigest: bodyDigest(template) }, branch: { head, sourceSha }, pull: null };
    let detailReads = 0;
    let current = scenario === 'current-round' ? { ...previousPull, body: revisedBody }
      : scenario === 'closed' ? { ...previousPull, state: 'closed' } : previousPull;
    const get = async path => {
      if (path === 'git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: sourceSha } };
      if (path === 'git/ref/heads/' + computed.head)
        return { ref: 'refs/heads/' + computed.head, object: { type: 'commit', sha: head } };
      if (path.startsWith('pulls?')) return [writes.length ? current : previousPull];
      if (path === 'pulls/29') return scenario === 'current-round' && ++detailReads === 1 ? previousPull : current;
      if (path === 'contents/.release-please-manifest.json?ref=' + head)
        return blob('.release-please-manifest.json', { '.': computed.version });
      assert.fail(path);
    };
    const write = () => writeOfficialCandidate({ roundId, round, product, botId: authorId, sourceSha, configuration: settings,
      get, admit: async () => {}, save: async () => {}, request: async (method, path, fields) => {
        writes.push([method, path]);
        current = { ...current, ...fields };
      },
    });
    if (scenario === 'closed') await assert.rejects(write, /PRIOR_PULL_DRIFT/);
    else await write();
    assert.deepEqual(writes, scenario === 'older-round' ? [['PATCH', 'pulls/29']] : []);
    assert.equal(current.body, scenario === 'older-round' ? expectedBody
      : scenario === 'current-round' ? revisedBody : previousPull.body);
  }
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
  const write = (source = sourceSha, sameCandidateBase = () => assert.fail('did not recover the already written PR')) =>
    writeOfficialCandidate({ roundId, round, product, botId: authorId, sourceSha: source, configuration: settings,
      get, request, save, sameCandidateBase, admit: async () => {} });
  defaultSource = controllerSha;
  await assert.rejects(write, /C2_SOURCE_CHANGED/);
  assert.deepEqual(phases, []);
  defaultSource = sourceSha;
  await assert.rejects(write, /checkpoint unavailable/);
  failCheckpoint = false;
  defaultSource = controllerSha;
  await assert.rejects(() => write(controllerSha, (old, current, paths) => {
    assert.deepEqual([old, current, paths], [sourceSha, controllerSha, computed.files.map(file => file.path)]);
    return false;
  }), /C2_STALE_BRANCH_BASE/);
  assert.deepEqual(phases, ['git/refs']);
  assert.deepEqual(round.branch, { head, sourceSha });
  await assert.rejects(() => write(controllerSha, () => { defaultSource = previousSha; return true; }), /C2_SOURCE_CHANGED/);
  assert.deepEqual(phases, ['git/refs']);
  defaultSource = controllerSha;
  const recorded = await write(controllerSha, () => true);
  assert.deepEqual(phases, ['git/refs', 'pulls', 'issues/29/labels']);
  actualPull.body = actualPull.body.replace('支持范围', '人工修订');
  assert.deepEqual(await write(controllerSha), recorded);
  round.pull = null;
  assert.equal((await write(controllerSha)).head, recorded.head);
  assert.match(actualPull.body, /人工修订/);
  assert.deepEqual(phases, ['git/refs', 'pulls', 'issues/29/labels']);
});
