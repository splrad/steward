import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AjvModule from 'ajv/dist/2020.js';
import { assertBuildPath, BuildContractError, canonicalBuildManifest, checkBuildNativeVersion, decodeBuildJson, deliveryBuildReadiness, matchBuildFiles, parseBuildManifest, planBuild, selectDeliveryBuilds, type BuildIdentity, type BuildManifest, type BuildUnit } from '../src/build-manifest.js';
import type { DeliveryConfiguration } from '../src/delivery-config.js';

const identity: BuildIdentity = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', profile: 'custom-adapter-v1', targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
const unit: BuildUnit = { profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.mjs', runtime: 'node', runnerFamily: 'linux' }, outputs: [{ id: 'archive', kind: 'file', match: 'widget-{version}.zip', count: 1, mediaType: 'application/zip' }] };
describe('构建合同 T09/T10', () => {
  it.each([{ platforms: new Array<string>(1) }, { platforms: ['linux/amd64', ,] }])('规划拒绝稀疏平台数组 %j', async ({ platforms }) => {
    await expect(planBuild({ ...identity, profile: 'oci-image-v1' }, { profile: 'oci-image-v1', inputs: { context: '.', dockerfile: 'Dockerfile', platforms }, outputs: [{ id: 'image', kind: 'oci-image', count: 1 }] })).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each(['COM{version}.zip', 'LPT{version}.zip', 'nested/COM{version}*.zip'])('规划拒绝展开后保留设备路径 %s', async match => {
    await expect(planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, match }] })).rejects.toThrow('RN_BUILD_PATH');
  });
  it('展开版本后仍保留通配匹配语义', async () => {
    const plan = await planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, match: 'widget-{version}*.zip' }] });
    expect(matchBuildFiles(plan, ['widget-1.2.3-linux.zip'])).toHaveLength(1);
  });
  it.each([{ artifacts: new Array<BuildManifest['artifacts'][number]>(1) }, { artifacts: [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }, ,] }])('生成拒绝稀疏产物数组 %j', ({ artifacts }) => {
    const manifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts } as BuildManifest;
    expect(() => canonicalBuildManifest(manifest)).toThrow('RN_BUILD_INVALID');
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_INVALID');
  });
  it.each(['01.2.3', '1.2', '1.2.3.0', '1.2.3-beta', '1.2.3\n'])('规划、生成和解析统一拒绝格式错误版本 %j', async version => {
    const manifest: BuildManifest = { ...identity, version, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    await expect(planBuild({ ...identity, version }, unit)).rejects.toBeInstanceOf(BuildContractError);
    await expect(planBuild({ ...identity, version }, unit)).rejects.toHaveProperty('code', 'RN_BUILD_INVALID');
    for (const operation of [() => canonicalBuildManifest(manifest), () => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))]) {
      expect(operation).toThrow(BuildContractError);
      try { operation(); } catch (error) { expect(error).toHaveProperty('code', 'RN_BUILD_INVALID'); }
    }
  });
  it.each(['targetSha', 'policySha'].flatMap(field => [undefined, null, 1, new String('a'.repeat(40)), {}].map(value => ({ field, value }))))('规划阶段拒绝非字符串 SHA %j', async ({ field, value }) => {
    await expect(planBuild({ ...identity, [field]: value } as unknown as BuildIdentity, unit)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([undefined, 1, true, new String('1.2.3'), {}].map(version => ({ version })))('规划阶段拒绝非法版本类型 %j', async ({ version }) => {
    await expect(planBuild({ ...identity, version } as unknown as BuildIdentity, unit)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([null, new String('asset.zip')].map(path => ({ path })))('拒绝非字符串路径 %j', ({ path }) => {
    expect(() => assertBuildPath(path as unknown as string)).toThrow('RN_BUILD_PATH');
  });
  it.each(['sha256', 'file', 'digest', 'reference'])('清单拒绝包装字符串字段 %s', field => {
    const image = field === 'digest' || field === 'reference';
    const manifest: BuildManifest = { ...identity, profile: image ? 'oci-image-v1' : identity.profile, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: image
      ? [{ id: 'image', kind: 'oci-image', digest: `sha256:${'d'.repeat(64)}`, reference: `example/widget@sha256:${'d'.repeat(64)}` }]
      : [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    const asset = manifest.artifacts[0] as unknown as Record<string, unknown>;
    asset[field] = new String(asset[field]);
    expect(() => canonicalBuildManifest(manifest)).toThrow(field === 'file' ? 'RN_BUILD_PATH' : 'RN_BUILD_OUTPUT');
  });
  it.each([null, []].map(value => ({ value })))('规划阶段拒绝非法身份或构建单元根值 %j', async ({ value }) => {
    await expect(planBuild(value as unknown as BuildIdentity, unit)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(planBuild(identity, value as unknown as BuildUnit)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([null, {}, 'outputs', 1, true, [null], [[]], [false], ['file']].map(outputs => ({ outputs })))('规划阶段拒绝非法输出结构 %j', async ({ outputs }) => {
    await expect(planBuild(identity, { ...unit, outputs } as unknown as BuildUnit)).rejects.toThrow('RN_BUILD_OUTPUT');
  });
  it.each(['COM¹', 'com².zip', 'folder/COM³.tar.gz', 'LPT¹', 'lpt².json', 'folder/LPT³.zip'])('拒绝 Windows 保留设备路径 %j', path => {
    expect(() => assertBuildPath(path)).toThrow('RN_BUILD_PATH');
    expect(() => assertBuildPath(path, { glob: true })).toThrow('RN_BUILD_PATH');
    expect(() => assertBuildPath(path.replace(/com|lpt/iu, 'asset'))).not.toThrow();
  });
  it.each(['x', 'é'])('序列化清单限制包含 UTF-8 字节和末尾 LF：%s', character => {
    const manifest: BuildManifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    const asset = manifest.artifacts[0]!;
    if (asset.kind !== 'file') throw new Error('file fixture required');
    const padding = 512 * 1024 - new TextEncoder().encode(canonicalBuildManifest(manifest)).byteLength;
    const width = new TextEncoder().encode(character).byteLength;
    asset.file = character.repeat(Math.floor(padding / width)) + 'x'.repeat(padding % width) + 'asset.zip';
    const bytes = new TextEncoder().encode(canonicalBuildManifest(manifest));
    expect(bytes.byteLength).toBe(512 * 1024);
    expect(bytes.at(-1)).toBe(10);
    expect(parseBuildManifest(bytes)).toEqual(manifest);
    asset.file = `x${asset.file}`;
    expect(() => canonicalBuildManifest(manifest)).toThrow('RN_BUILD_LIMIT');
    asset.file = asset.file.slice(1, -1);
    expect(new TextEncoder().encode(canonicalBuildManifest(manifest)).byteLength).toBe(512 * 1024 - 1);
  });
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
  it('异步摘要期间原对象变更不改变已验证计划', async () => {
    const original = structuredClone(unit);
    const pending = planBuild(identity, original);
    original.outputs[0]!.count = 0; original.outputs[0]!.id = 'changed'; original.outputs.length = 0;
    const plan = await pending;
    expect(plan.outputs).toEqual(unit.outputs);
  });
  it('OCI 字符策略接受转义换行，合同字符策略仍拒绝', () => {
    const bytes = new TextEncoder().encode('{"Cmd":["line one\\nline two\\tend"]}');
    expect(decodeBuildJson(bytes, 'oci')).toEqual({ Cmd: ['line one\nline two\tend'] });
    expect(() => decodeBuildJson(bytes)).toThrow('RN_BUILD_INVALID');
    for (const source of ['{"a":1,"a":2}', '{"a":"\\ud800"}', '\ufeff{}', '{"a":1e400}']) {
      expect(() => decodeBuildJson(new TextEncoder().encode(source), 'oci')).toThrow('RN_BUILD_INVALID');
    }
  });
  it.each([['example/widget'], null, true, 1])('拒绝非字符串仓库名 %j', async fullName => {
    await expect(planBuild({ ...identity, fullName } as unknown as BuildIdentity, unit)).rejects.toThrow('RN_BUILD_INVALID');
    const manifest = { ...identity, fullName, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_INVALID');
  });
  it.each([true, null, ['archive']])('规划时拒绝非字符串输出编号 %j', async id => {
    await expect(planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, id }] } as unknown as BuildUnit)).rejects.toThrow('RN_BUILD_OUTPUT');
  });
  it.each([['application/zip'], null, true])('清单拒绝非字符串媒体类型 %j', mediaType => {
    const manifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType, size: 1, sha256: 'd'.repeat(64) }] };
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_OUTPUT');
  });
  it('规划时拒绝展开后的编号冲突和总数量越界', async () => {
    for (const outputs of [
      [{ ...unit.outputs[0]!, id: 'asset', count: 2 }, { ...unit.outputs[0]!, id: 'asset-1' }],
      [{ ...unit.outputs[0]!, id: 'first', count: 65 }, { ...unit.outputs[0]!, id: 'second', count: 65 }],
    ]) await expect(planBuild(identity, { ...unit, outputs })).rejects.toThrow('RN_BUILD_OUTPUT');
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
