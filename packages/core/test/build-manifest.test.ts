import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AjvModule from 'ajv/dist/2020.js';
import { assertBuildPath, canonicalBuildManifest, checkBuildNativeVersion, decodeBuildJson, deliveryBuildReadiness, matchBuildFiles, parseBuildManifest, planBuild, selectDeliveryBuilds, type BuildIdentity, type BuildManifest, type BuildUnit } from '../src/build-manifest.js';
import type { DeliveryConfiguration } from '../src/delivery-config.js';

const identity: BuildIdentity = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', profile: 'custom-adapter-v1', targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
const unit: BuildUnit = { profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.mjs', runtime: 'node', runnerFamily: 'linux' }, outputs: [{ id: 'archive', kind: 'file', match: 'widget-{version}.zip', count: 1, mediaType: 'application/zip' }] };
describe('构建合同 T09/T10', () => {
  it.each([
    ['dotnet-assets-v1', { project: 'src/Widget.csproj', configuration: 'Release', framework: 'net8.0-windows', runtime: 'win-x64' }, 'windows-latest'],
    ['node-package-v1', { directory: '.', lockfile: 'package-lock.json', buildTask: 'build', packageManager: 'npm' }, 'ubuntu-latest'],
    ['oci-image-v1', { context: '.', dockerfile: 'Dockerfile', platforms: ['linux/amd64'] }, 'ubuntu-latest'],
    ['custom-adapter-v1', unit.inputs, 'ubuntu-latest'],
  ] as const)('固定 %s 的受控计划', async (profile, inputs, runner) => {
    const outputs = profile === 'oci-image-v1' ? [{ id: 'image', kind: 'oci-image' as const, count: 1 }] : unit.outputs;
    const plan = await planBuild({ ...identity, profile }, { profile, inputs, outputs });
    expect(plan.runner).toBe(runner); expect(plan.environment).toBeNull(); expect(plan.permissions).toEqual({ contents: 'read' }); expect(plan.persistCredentials).toBe(false);
    expect(plan.inputsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.timeoutMinutes).toBe(45);
  });
  it('规范化参数、复制输入并固定摘要', async () => {
    const original = structuredClone(unit);
    const plan = await planBuild(identity, original);
    expect(plan.inputsSha256).toBe(createHash('sha256').update('{"entrypoint":"tools/build.mjs","runtime":"node","runnerFamily":"linux"}\n').digest('hex'));
    original.outputs[0]!.id = 'changed'; original.inputs.runtime = 'bash';
    expect(plan.outputs[0]!.id).toBe('archive'); expect(plan.inputs.runtime).toBe('node');
  });
  it.each(['/root', '../asset', 'a/../b', 'a\\b', 'a//b', 'C:/asset', 'CON.zip', 'foo:bar', 'asset.', 'asset ', 'a\n', 'x/[ab].zip'])('拒绝非法路径 %j', path => {
    expect(() => assertBuildPath(path, { glob: true })).toThrow('RN_BUILD_PATH');
  });
  it.each([
    { ...unit, inputs: { ...unit.inputs, command: 'run anything' } },
    { ...unit, inputs: { ...unit.inputs, entrypoint: 'scripts/build.mjs' } },
    { ...unit, inputs: { ...unit.inputs, runtime: 'sh' } },
    { ...unit, outputs: [] },
    { ...unit, outputs: [unit.outputs[0]!, unit.outputs[0]!] },
    { ...unit, outputs: [{ ...unit.outputs[0]!, count: 0 }] },
    { ...unit, outputs: [{ ...unit.outputs[0]!, count: 129 }] },
  ])('拒绝未登记的参数与输出', async invalid => { await expect(planBuild(identity, invalid)).rejects.toThrow('RN_BUILD'); });
  it.each(['a'.repeat(40) + '\n', 'A'.repeat(40), 'short'])('拒绝未冻结的提交 %j', async targetSha => {
    await expect(planBuild({ ...identity, targetSha }, unit)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it('中央匹配覆盖恰好一个文件，拒绝额外、空、重复与大小写冲突', async () => {
    const plan = await planBuild(identity, unit);
    expect(matchBuildFiles(plan, ['widget-1.2.3.zip'])).toEqual([{ id: 'archive', file: 'widget-1.2.3.zip', mediaType: 'application/zip' }]);
    for (const files of [[], ['missing.zip'], ['widget-1.2.3.zip', 'extra.txt'], ['widget-1.2.3.zip', 'WIDGET-1.2.3.zip']]) expect(() => matchBuildFiles(plan, files)).toThrow('RN_BUILD_OUTPUT');
  });
  it('多文件规则按文件名固定子编号，重叠规则失败', async () => {
    const plan = await planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, count: 2, match: '*.zip' }] });
    expect(matchBuildFiles(plan, ['z.zip', 'a.zip']).map(asset => [asset.id, asset.file])).toEqual([['archive-1', 'a.zip'], ['archive-2', 'z.zip']]);
    const overlapping = await planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, match: '*.zip' }, { ...unit.outputs[0]!, id: 'other', match: '*.zip' }] });
    expect(() => matchBuildFiles(overlapping, ['a.zip'])).toThrow('RN_BUILD_OUTPUT');
  });
  it('公共版本要求产物投影一致，按提交交付可以无版本', async () => {
    const plan = await planBuild(identity, unit);
    for (const native of [null, '1.2.4', '01.2.3', '1.2.3.0']) expect(() => checkBuildNativeVersion(plan, native)).toThrow('RN_BUILD_VERSION');
    expect(() => checkBuildNativeVersion(plan, '1.2.3')).not.toThrow();
    const snapshot = await planBuild({ ...identity, version: null }, { ...unit, outputs: [{ ...unit.outputs[0]!, match: '*.zip' }] });
    expect(() => checkBuildNativeVersion(snapshot, null)).not.toThrow();
    await expect(planBuild({ ...identity, version: null }, unit)).rejects.toThrow('RN_BUILD_VERSION');
  });
  it('标准清单固定字段顺序与字节，Schema验证同一合同', async () => {
    const manifest: BuildManifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    const bytes = canonicalBuildManifest(manifest);
    expect(parseBuildManifest(new TextEncoder().encode(bytes))).toEqual(manifest);
    expect(bytes).toBe(`{"schemaVersion":1,"repositoryId":1400000001,"fullName":"example/widget","buildId":"asset","profile":"custom-adapter-v1","targetSha":"${'a'.repeat(40)}","policySha":"${'b'.repeat(40)}","version":"1.2.3","inputsSha256":"${'c'.repeat(64)}","artifacts":[{"id":"archive","kind":"file","file":"widget.zip","mediaType":"application/zip","size":1,"sha256":"${'d'.repeat(64)}"}]}\n`);
    const Ajv = AjvModule as unknown as typeof import('ajv').default;
    const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile('schema/build-manifest.schema.json', 'utf8')));
    expect(validate(manifest)).toBe(true);
    expect(validate({ ...manifest, unwanted: true })).toBe(false);
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify({ ...manifest, buildId: true })))).toThrow('RN_BUILD_INVALID');
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify({ ...manifest, artifacts: [{ ...manifest.artifacts[0]!, id: true }] })))).toThrow('RN_BUILD_OUTPUT');
    expect(() => canonicalBuildManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0]!, size: 0 }] } as BuildManifest)).toThrow('RN_BUILD_OUTPUT');
    expect(() => canonicalBuildManifest({ ...manifest, inputsSha256: 'bad' })).toThrow('RN_BUILD_INVALID');
  });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1e400}', '{"a":"\\ud800"}', '\ufeff{}', '{"a":"\\n"}'])('严格解析清单 JSON %j', source => {
    expect(() => decodeBuildJson(new TextEncoder().encode(source))).toThrow('RN_BUILD_INVALID');
  });
  it.each(['null', '[]', '{"schemaVersion":1}', '{"artifacts":[null]}'])('类型错误返回构建合同错误 %j', source => {
    expect(() => parseBuildManifest(new TextEncoder().encode(source))).toThrow('RN_BUILD_INVALID');
  });
  it('无资产发布、构建复用与局部失败独立判定', () => {
    const configuration: DeliveryConfiguration = { builds: { failed: { profile: unit.profile, inputs: unit.inputs, outputs: unit.outputs }, ok: { profile: unit.profile, inputs: unit.inputs, outputs: unit.outputs } }, delivery: {
      githubRelease: { enabled: true, state: 'active', profile: 'neutral', builds: [] },
      deployments: [{ id: 'service', profile: 'cloud', state: 'active', builds: ['ok'], source: 'commit', trigger: 'default-branch' }],
      packages: [{ id: 'package', profile: 'pkg', state: 'active', builds: ['failed', 'ok'], publication: 'snapshot', trigger: 'default-branch' }],
    } };
    expect(selectDeliveryBuilds(configuration)).toEqual(['ok', 'failed']);
    expect(deliveryBuildReadiness(configuration, ['ok'])).toEqual({ githubRelease: 'ready', deployments: { service: 'ready' }, packages: { package: 'blocked' } });
    configuration.delivery.githubRelease.builds = ['failed'];
    expect(deliveryBuildReadiness(configuration, ['ok']).githubRelease).toBe('blocked');
    expect(deliveryBuildReadiness(configuration, ['ok']).deployments.service).toBe('ready');
    configuration.delivery.deployments[0]!.source = 'github-release';
    expect(deliveryBuildReadiness(configuration, ['ok']).deployments.service).toBe('blocked');
  });
});
