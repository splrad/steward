import { afterEach, expect, it, vi } from 'vitest';
import { pipelineIdentity, pipelineNotes } from '../src/release-pipeline.js';
import { NativeControlPlane } from '../src/native-control-plane.js';
import { localGitSnapshot } from '../src/managed-sync-preview.js';
import { parseRepositoryCatalog } from '../../core/src/repository-policy.js';
import { readFile } from 'node:fs/promises';
import catalog from '../../../config/repositories.json' with { type: 'json' };
import descriptorSchema from '../../../schema/steward-release.schema.json' with { type: 'json' };
import { validateReleaseSource, admitReleaseIdentity, type AdmissionInput, type ReleaseIdentityObservation } from '../src/release-admission.js';
import type { GitSnapshot } from '../src/managed-sync-preview.js';
import type { ReleaseDescriptor } from '../../core/src/release-descriptor.js';
const S = 'a'.repeat(40), P = 'b'.repeat(40);
afterEach(() => vi.restoreAllMocks());
const descriptor: ReleaseDescriptor = { schemaVersion: 1, units: [{ id: 'layerscape', displayName: 'LayerScape', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/layerscape.md', signingPolicy: 'none', builds: [{ id: 'windows', os: 'windows', arch: 'x64', entrypoint: 'tools/build.ps1', args: [], expectedArtifacts: ['app'] }], artifacts: [{ id: 'app', file: 'app-${version}.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'windows', required: true }], channels: [{ id: 'ghcr-assets', kind: 'oci-artifact', artifacts: ['app'], dependsOn: [] }, { id: 'winget', kind: 'winget', artifacts: ['app'], dependsOn: [] }] }] };
async function fixture() {
  const template = await readFile(new URL('../../../config/templates/release.md.mustache', import.meta.url), 'utf8');
  const source: Record<string, string> = { '.github/steward-release.json': JSON.stringify(descriptor), '.github/release-template.md.mustache': template,
    'schema/steward-release.schema.json': JSON.stringify(descriptorSchema), VERSION: '9.2.3\n', '.release-please-manifest.json': '{".":"9.2.3"}',
    'release-please-config.json': JSON.stringify({ draft: true, 'force-tag-creation': true, 'include-component-in-tag': false, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } }),
    'CHANGELOG.md': '# 更新记录\n\n## [9.2.3](https://github.com/splrad/LayerScape/compare/v9.2.2...v9.2.3)\n\n修复路径。\n',
    '.release-notes/layerscape.md': ['概述', '兼容性', '升级与迁移', '安装说明', '已知问题', '恢复'].map(h => `## ${h}\n\n本节是仅用于离线验证的完整夹具内容。\n`).join('\n'), 'tools/build.ps1': 'Write-Output fixture\n' };
  const policy: Record<string, string> = { 'config/templates/release.md.mustache': template, 'schema/steward-release.schema.json': JSON.stringify(descriptorSchema) };
  const input: AdmissionInput = { repository: 'splrad/LayerScape', repositoryId: 1187527897, sourceSha: S, policySha: P, sourceDirectory: 'source', policyDirectory: 'policy', centralConfig: structuredClone(catalog) };
  const snapshot: GitSnapshot = { head: async () => S, blob: async () => { throw new Error('not used'); }, file: async (directory, sha, path) => {
    if (sha !== (directory === 'source' ? S : P)) throw new Error('unexpected commit');
    const value = (directory === 'source' ? source : policy)[path]; return value === undefined ? null : Buffer.from(value);
  } };
  const evidence: ReleaseIdentityObservation = { complete: true, repository: { id: 1187527897, fullName: 'splrad/LayerScape', defaultBranch: 'main' }, githubSha: S, githubRef: 'refs/tags/v9.2.3', resolvedTagSha: S, policyOnProtectedMain: true, adoptionAncestor: true,
    release: { id: 1, tag: 'v9.2.3', draft: true, authorId: 301115370 }, pull: { number: 3, merged: true, mergeSha: S, baseRef: 'main', baseRepositoryId: 1187527897 },
    caller: (await readFile('templates/release/steward-release-publish.yml', 'utf8')).replace(/product-release\.yml@[a-f0-9]{40}/, `product-release.yml@${P}`) };
  return { input, source, policy, snapshot, evidence };
}
it.each(['drift', 'disabled', 'revoked', 'missing', 'history'])('binds pipeline admission and notes to P while enforcing current authority: %s', async kind => {
  const f = await fixture(), live = parseRepositoryCatalog(structuredClone(catalog)), Q = 'c'.repeat(40), boundary = 'd'.repeat(40);
  const policy = live.repositories['1187527897']!;
  policy.release.enabled = kind !== 'disabled'; policy.release.units.layerscape!.enabled = true;
  policy.release.units.layerscape!.channels['ghcr-assets']!.destination = 'ghcr.io/splrad/new-location';
  policy.release.units.layerscape!.adoptedAfterTag = 'v8.0.0';
  if (kind === 'revoked') policy.revokedPolicyShas.push(P);
  f.policy['config/repositories.json'] = JSON.stringify(catalog);
  if (kind === 'missing') delete f.policy['config/repositories.json'];
  f.policy['mise.lock'] = 'policy-lock'; f.source['global.json'] = '{}';
  f.source['.github/workflows/steward-release-publish.yml'] = f.evidence.caller;
  vi.spyOn(localGitSnapshot, 'file').mockImplementation(f.snapshot.file);
  vi.spyOn(NativeControlPlane.prototype, 'catalog').mockResolvedValue({ observationSha: Q, catalog: live });
  const routes: Record<string, unknown> = {
    'repos/splrad/LayerScape': { id: 1187527897, full_name: 'splrad/LayerScape', default_branch: 'main' },
    'repos/splrad/LayerScape/releases/1': { id: 1, tag_name: 'v9.2.3', draft: true, author: { id: 301115370 } },
    'repos/splrad/LayerScape/pulls/3': { number: 3, merged: true, merge_commit_sha: S, base: { ref: 'main', repo: { id: 1187527897 } } },
    'repos/splrad/LayerScape/commits/v9.2.3': { sha: S },
    'repos/splrad/LayerScape/commits/v9.2.2': { sha: boundary },
    [`repos/splrad/steward/compare/${P}...${Q}`]: { status: kind === 'history' ? 'diverged' : 'ahead', merge_base_commit: { sha: P } },
    [`repos/splrad/LayerScape/compare/${boundary}...${S}`]: { status: 'ahead', merge_base_commit: { sha: boundary } },
  };
  const pending = pipelineIdentity({ unit: 'layerscape', tag: 'v9.2.3', releaseId: 1, releasePr: 3, policySha: P, sourceDirectory: 'source', policyDirectory: 'policy' },
    { GITHUB_REPOSITORY_ID: '1187527897', GITHUB_REPOSITORY: 'splrad/LayerScape', GITHUB_SHA: S, GITHUB_REF: 'refs/tags/v9.2.3', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' },
    async args => { const result = routes[args.at(-1)!]; if (!result) throw new Error('unexpected API: ' + args.at(-1)); return JSON.stringify(result); });
  if (kind !== 'drift') { await expect(pending).rejects.toThrow(); return; }
  const record = await pending;
  expect(record.policySha).toBe(P); expect(record.observationSha).toBe(Q);
  const notes = await pipelineNotes(record, 'source', 'policy');
  expect(notes).toContain(catalog.repositories['1187527897'].release.units.layerscape.channels['ghcr-assets'].destination);
  expect(notes).not.toContain('new-location');
});
it('validates committed native version, manifest, template and exact asset mapping', async () => {
  const f = await fixture(); const units = await validateReleaseSource(f.input, f.snapshot);
  expect(units.map(unit => [unit.unit.id, unit.version, unit.tag, unit.assets[0]!.name])).toEqual([['layerscape', '9.2.3', 'v9.2.3', 'app-9.2.3.exe']]);
  expect(() => admitReleaseIdentity(f.input, units[0]!, { releaseId: 1, releasePr: 3 }, f.evidence)).toThrow('not enabled');
  const central: any = f.input.centralConfig; central.repositories['1187527897'].release.enabled = true; central.repositories['1187527897'].release.units.layerscape.enabled = true;
  expect(admitReleaseIdentity(f.input, units[0]!, { releaseId: 1, releasePr: 3 }, f.evidence)).toBe('build');
  central.repositories['1187527897'].release.enabled = false; central.repositories['1187527897'].release.units.layerscape.enabled = false;
  expect(admitReleaseIdentity(f.input, units[0]!, { releaseId: 1, releasePr: 3 }, { ...f.evidence, release: { ...f.evidence.release, draft: false } })).toBe('verify');
});
it.each(['version', 'manifest', 'template', 'schema', 'changelog', 'notes', 'entrypoint', 'rp', 'adapter', 'channel'])('rejects changed %s input', async kind => {
  const f = await fixture();
  if (kind === 'version') f.source.VERSION = '9.2.4\n';
  if (kind === 'manifest') f.source['.release-please-manifest.json'] = '{".":"9.2.4"}';
  if (kind === 'template') f.source['.github/release-template.md.mustache'] += 'drift';
  if (kind === 'schema') f.source['schema/steward-release.schema.json'] = '{}';
  if (kind === 'changelog') f.source['CHANGELOG.md'] = '# no version section';
  if (kind === 'notes') f.source['.release-notes/layerscape.md'] = 'TODO';
  if (kind === 'entrypoint') delete f.source['tools/build.ps1'];
  if (kind === 'rp') f.source['release-please-config.json'] = '{"packages":{}}';
  if (kind === 'adapter') { const d = structuredClone(descriptor); d.units[0]!.ecosystem = 'node'; f.source['.github/steward-release.json'] = JSON.stringify(d); }
  if (kind === 'channel') { const d = structuredClone(descriptor); d.units[0]!.channels.pop(); f.source['.github/steward-release.json'] = JSON.stringify(d); }
  await expect(validateReleaseSource(f.input, f.snapshot)).rejects.toThrow();
});
it.each(['creator', 'head', 'tag', 'release-id', 'pr-source', 'base', 'repo', 'incomplete', 'untrusted-policy', 'adoption', 'caller', 'permission', 'secret'])('rejects %s evidence before production', async kind => {
  const f = await fixture(), units = await validateReleaseSource(f.input, f.snapshot), e = f.evidence;
  if (kind === 'creator') e.release.authorId = 42;
  if (kind === 'head') e.githubSha = 'c'.repeat(40);
  if (kind === 'tag') e.resolvedTagSha = 'c'.repeat(40);
  if (kind === 'release-id') e.release.id = 2;
  if (kind === 'pr-source') e.pull.mergeSha = 'c'.repeat(40);
  if (kind === 'base') e.pull.baseRef = 'other';
  if (kind === 'repo') e.repository.id++;
  if (kind === 'incomplete') e.complete = false;
  if (kind === 'untrusted-policy') e.policyOnProtectedMain = false;
  if (kind === 'adoption') e.adoptionAncestor = false;
  if (kind === 'caller') e.caller = e.caller.replace(P, 'main');
  if (kind === 'permission') e.caller = e.caller.replace('actions: read', 'actions: write');
  if (kind === 'secret') e.caller += '    secrets: inherit\n';
  expect(() => admitReleaseIdentity(f.input, units[0]!, { releaseId: 1, releasePr: 3 }, e)).toThrow('RELEASE_ADMISSION');
});

it.each(['bare', 'empty', 'duplicate', 'fenced', 'wrong-depth'])('uses the same version section contract as note generation: %s', async kind => {
  const f = await fixture();
  const section = '## 9.2.3\n\nActual changes.\n';
  f.source['CHANGELOG.md'] = '# Changelog\n\n' + section;
  if (kind === 'empty') f.source['CHANGELOG.md'] = '## 9.2.3\n';
  if (kind === 'duplicate') f.source['CHANGELOG.md'] += section;
  if (kind === 'fenced') f.source['CHANGELOG.md'] = '```markdown\n' + section + '```\n';
  if (kind === 'wrong-depth') f.source['CHANGELOG.md'] = section.replace('## ', '# ');
  if (kind === 'bare') expect(await validateReleaseSource(f.input, f.snapshot)).toHaveLength(1);
  else await expect(validateReleaseSource(f.input, f.snapshot)).rejects.toThrow();
});
