import { vi } from 'vitest';
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evidenceFixture, S, C, D, digest } from './native-evidence-fixture.js';
import { localGitSnapshot } from '../src/git-snapshot.js';
import { nativeRequestIdentity } from '../src/native-release-evidence.js';
import type { ProductBuildInput } from '../src/release-pipeline.js';
export function productPipelineFixture(attempts = 1, twoUnits = false) {
  const f = evidenceFixture(attempts), candidateId = 'd'.repeat(64);
  const delivery = { schemaVersion: 1, repositoryAuthors: [{ id: 44151430, evidence: 'User confirmed axiomoth; native ID verified.' }],
    units: [{ id: 'app', path: '.', notesPath: '.release-notes/app.md', assets: [{ id: 'app', name: 'app-${version}.exe', mediaType: 'application/octet-stream' }], channels: [] }] };
  const workflow = { 'run-name': 'Build ${{ inputs.operation_key }}', on: { workflow_dispatch: { inputs: Object.fromEntries(['cycle_id', 'operation_key', 'source_sha', 'controller_sha'].map(key => [key, { type: 'string', required: true }])) } },
    jobs: { build: { strategy: { matrix: { include: [{ unit: 'app', target: 'windows-x64', assets: ['app'] }] } } } } };
  const source: Record<string, string> = { '.github/delivery.json': JSON.stringify(delivery), '.github/workflows/steward-release-publish.yml': YAML.stringify(workflow),
    'release-please-config.json': JSON.stringify({ 'include-component-in-tag': false, 'include-v-in-tag': true, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } }),
    '.release-please-manifest.json': '{".":"1.0.0"}', VERSION: '1.0.0\n', 'global.json': '{}',
    '.github/release-template.md.mustache': readFileSync('templates/repository/.github/release-template.md.mustache', 'utf8') };
  if (twoUnits) {
    delivery.units[0]!.path='packages/app';
    delivery.units.push({ ...structuredClone(delivery.units[0]!), id: 'other', path: 'packages/other', notesPath: '.release-notes/other.md' });
    delivery.units[1]!.assets[0]!.name='other-${version}.exe';
    workflow.jobs.build.strategy.matrix.include.push({ unit: 'other', target: 'windows-x64', assets: ['app'] });
    f.context.cycle.units[0]!.tag = 'app-v1.0.0';
    f.context.cycle.units.push({ ...structuredClone(f.context.cycle.units[0]!), id: 'other', tag: 'other-v1.0.0' });
    source['.github/delivery.json'] = JSON.stringify(delivery);
    source['.github/workflows/steward-release-publish.yml'] = YAML.stringify(workflow);
    source['release-please-config.json'] = JSON.stringify({ 'include-component-in-tag': true, 'include-v-in-tag': true,
      packages: Object.fromEntries(delivery.units.map(unit => [unit.path, { 'release-type': 'simple', 'version-file': 'VERSION', component: unit.id }])) });
    source['.release-please-manifest.json'] = '{"packages/app":"1.0.0","packages/other":"1.0.0"}';
    source['packages/app/VERSION'] = source['packages/other/VERSION'] = '1.0.0\n';
  }
  const bytes = Buffer.from(source['.github/delivery.json']!);
  f.context.cycle.deliveryConfigSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  Object.assign(f.request, nativeRequestIdentity(1, f.context.cycle, f.request)); f.request.inputs.operation_key = f.request.operationKey;
  for (const [attempt, run] of f.runs) {
    run.display_title = `Build ${f.request.operationKey}`;
    const result = f.results.get(attempt)!; result.execution.inputDigest = f.request.inputDigest;
    result.execution.invocationKey = digest(JSON.stringify([1, f.context.cycle.id, 10, 100, attempt, 'build', attempt * 1000, 2, 'app', null, f.request.inputDigest]));
  }
  f.runs.get(attempts).status = 'in_progress'; f.runs.get(attempts).conclusion = null;
  f.jobs.get(attempts)![0].status = 'in_progress'; f.jobs.get(attempts)![0].steps = [];
  const frozen = { authorsDigest: digest(JSON.stringify(delivery.repositoryAuthors)), sourceDigest: 'f'.repeat(64), actors: [],
    contributors: { contributors: [], unresolved: 0 }, units: delivery.units.map(unit => ({ id: unit.id, actors: [], contributors: { contributors: [], unresolved: 0 } })) };
  const session = { generated: { schemaVersion: 1, baseSha: D, files: [], units: delivery.units.map(unit => ({ id: unit.id, path: unit.path, version: '1.0.0', tag: twoUnits ? `${unit.id}-v1.0.0` : 'v1.0.0' })), configDigest: 'e'.repeat(64), sourceDigest: 'f'.repeat(64) },
    identity: frozen, pending: null, conflict: null, preview: null, adoption: null };
  const content = JSON.stringify(session);
  const input: ProductBuildInput = { cycleId: f.context.cycle.id, operationKey: f.request.operationKey, sourceSha: S, controllerSha: C, sourceDirectory: 'source', controllerDirectory: 'controller',
    state: { head: D, repository: { schemaVersion: 2, repositoryId: 1, defaultBranch: 'main', revision: 1, lastObservedDefaultSha: S,
      lastCompletedCycleId: null, activeCycleId: f.context.cycle.id, nextCheckAt: null, lastProgressAt: null, lastErrorCode: null,
      candidate: { id: candidateId, prNumber: 12, branch: 'steward/release-candidate', baseSha: D, generatedSnapshotPath: null, publishedHead: S,
        editingAckHead: null, statusCommentId: null, contentGenerationDigest: 'e'.repeat(64), adoptionOverride: null, observedLabelEventIds: [], pendingWrite: null } },
      cycles: [{ value: f.context.cycle }], domainRecords: [{ path: `generated/${candidateId}/session.json`, commit: D,
        value: { schemaVersion: 1, repositoryId: 1, candidateId, documentKind: 'session', documentDigest: digest(content), index: 0, count: 1, content } }] } };
  const environment = { GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY: 'example/product', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: String(attempts),
    GITHUB_SHA: S, GITHUB_REF: `refs/heads/${f.request.ref}`, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const calls: string[] = [];
  const gh = async (args: readonly string[]) => {
    const path = args.at(-1)!; calls.push(path);
    if (path === `repos/${f.context.repository}`) return JSON.stringify({id:f.context.repositoryId,full_name:f.context.repository,private:false,visibility:'public',default_branch:'main',archived:false,disabled:false});
    if (path === 'users/splrad-steward%5Bbot%5D') return JSON.stringify({ id: 42, type: 'Bot', login: 'splrad-steward[bot]' });
    if (path.endsWith('/heads/steward/release-state')) return JSON.stringify({ ref: 'refs/heads/steward/release-state', object: { type: 'commit', sha: D } });
    if (path.endsWith('/heads/' + f.request.ref)) return JSON.stringify({ ref: `refs/heads/${f.request.ref}`, object: { type: 'commit', sha: S } });
    if (path.endsWith('/actions/runs/100')) return JSON.stringify(f.runs.get(attempts));
    throw new Error('unexpected native API: ' + path);
  };
  vi.spyOn(localGitSnapshot, 'head').mockImplementation(async directory => directory === 'source' ? S : C);
  vi.spyOn(localGitSnapshot, 'file').mockImplementation(async (directory, sha, path) => {
    if (sha !== (directory === 'source' ? S : C)) throw new Error('wrong source SHA');
    const value = directory === 'source' ? source[path] : path === 'mise.lock' ? 'locked tools' : path === 'templates/repository/.github/release-template.md.mustache' ? source['.github/release-template.md.mustache'] : undefined;
    return value === undefined ? null : Buffer.from(value);
  });
  return { ...f, input, environment, gh, source, delivery, nativeCalls: calls };
}
