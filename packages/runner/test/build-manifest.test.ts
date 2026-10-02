import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLimits, planBuild, type BuildIdentity, type BuildUnit } from '../../core/src/build-manifest.js';
import { assertBuildSourcePath, collectFileBuildManifest, collectOciBuildManifest, validateBuildExecutionContext, validateBuildInputs, verifyDownloadedFileBuild, verifyDownloadedOciBuild } from '../src/build-manifest.js';

const identity: BuildIdentity = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', profile: 'custom-adapter-v1', targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
const unit: BuildUnit = { profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.mjs', runtime: 'node', runnerFamily: 'linux' }, outputs: [{ id: 'archive', kind: 'file', match: '*.json', count: 1, mediaType: 'application/json' }] };
const inspect = async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)).version ?? null;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const originalTotalLimit = buildLimits.maxTotalBytes;
let root: string; let output: string; let source: string;
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open);
  root = await mkdtemp(join(tmpdir(), 'steward-build-contract-'));
  output = join(root, 'output'); source = join(root, 'source');
  await mkdir(output); await mkdir(source);
});
afterEach(async () => {
  Object.defineProperty(buildLimits, 'maxTotalBytes', { value: originalTotalLimit });
  if (resolve(root).startsWith(join(resolve(tmpdir()), 'steward-build-contract-'))) await rm(root, { recursive: true, force: true });
});
async function file(version = '1.2.3') { await writeFile(join(output, 'widget.json'), JSON.stringify({ version })); }
async function oci(platforms = ['linux/amd64'], version = '1.2.3') {
  await mkdir(join(output, 'blobs', 'sha256'), { recursive: true });
  const store = async (value: object | string, mediaType: string) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(output, 'blobs', 'sha256', hash), bytes);
    return { mediaType, digest: `sha256:${hash}`, size: bytes.length };
  };
  const manifests = [];
  for (const platform of platforms) {
    const [os, architecture] = platform.split('/');
    const config = await store({ os, architecture, config: { Labels: { 'org.opencontainers.image.version': version } } }, 'application/vnd.oci.image.config.v1+json');
    const layer = await store(`layer-${platform}`, 'application/vnd.oci.image.layer.v1.tar');
    manifests.push({ ...await store({ schemaVersion: 2, config, layers: [layer] }, 'application/vnd.oci.image.manifest.v1+json'), platform: { os, architecture } });
  }
  const image = manifests.length === 1 ? manifests[0]! : await store({ schemaVersion: 2, manifests }, 'application/vnd.oci.image.index.v1+json');
  await writeFile(join(output, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...image, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
  return { image, store, plan: await planBuild({ ...identity, profile: 'oci-image-v1' }, { profile: 'oci-image-v1', inputs: { context: '.', dockerfile: 'Dockerfile', platforms }, outputs: [{ id: 'image', kind: 'oci-image', count: 1 }] }) };
}
describe('中央文件产物验证 T09', () => {
  it('按实际字节生成清单并在下载后重新验证', async () => {
    await file(); const plan = await planBuild(identity, unit);
    const manifest = await collectFileBuildManifest(plan, output, inspect);
    const bytes = await readFile(join(output, 'widget.json'));
    expect(manifest.artifacts).toEqual([{ id: 'archive', kind: 'file', file: 'widget.json', mediaType: 'application/json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]);
    await expect(verifyDownloadedFileBuild(plan, manifest, output, inspect)).resolves.toBeUndefined();
    await file('1.2.4'); await expect(verifyDownloadedFileBuild(plan, manifest, output, inspect)).rejects.toThrow('RN_BUILD_VERSION');
  });
  it('摘要和仓库、提交、参数绑定分别复核', async () => {
    await file(); const plan = await planBuild(identity, unit); const manifest = await collectFileBuildManifest(plan, output, inspect);
    for (const changed of [{ targetSha: 'c'.repeat(40) }, { policySha: 'c'.repeat(40) }, { inputsSha256: 'c'.repeat(64) }, { repositoryId: 2 }]) {
      await expect(verifyDownloadedFileBuild(plan, { ...manifest, ...changed }, output, inspect)).rejects.toThrow('RN_BUILD_DIGEST');
    }
    await writeFile(join(output, 'widget.json'), '{"version":"1.2.3","extra":true}');
    await expect(verifyDownloadedFileBuild(plan, manifest, output, inspect)).rejects.toThrow('RN_BUILD_DIGEST');
  });
  it('拒绝空文件、额外文件和缺失原生版本', async () => {
    const plan = await planBuild(identity, unit);
    await writeFile(join(output, 'widget.json'), ''); await expect(collectFileBuildManifest(plan, output, inspect)).rejects.toThrow('RN_BUILD_LIMIT');
    await file(); await expect(collectFileBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_VERSION');
    await writeFile(join(output, 'extra.txt'), 'extra'); await expect(collectFileBuildManifest(plan, output, inspect)).rejects.toThrow('RN_BUILD_OUTPUT');
  });
  it('拒绝单文件和文件数量越过固定上限', async () => {
    await file(); const plan = await planBuild(identity, unit);
    await truncate(join(output, 'widget.json'), buildLimits.maxFileBytes + 1);
    await expect(collectFileBuildManifest(plan, output, inspect)).rejects.toThrow('RN_BUILD_LIMIT');
    await file();
    await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(join(output, `${index}.json`), '{}')));
    await expect(collectFileBuildManifest(plan, output, inspect)).rejects.toThrow('RN_BUILD_LIMIT');
  });
  it('拒绝外部目录链接及硬链接', async () => {
    await file(); const plan = await planBuild(identity, unit);
    await link(join(output, 'widget.json'), join(source, 'alias.json'));
    await expect(collectFileBuildManifest(plan, output, inspect)).rejects.toThrow('RN_BUILD_PATH');
    await symlink(source, join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertBuildSourcePath(output, 'linked')).rejects.toThrow('RN_BUILD_PATH');
  });
  it('拒绝检查过程中替换文件或增加输出', async () => {
    await file(); const plan = await planBuild(identity, unit);
    await expect(collectFileBuildManifest(plan, output, async bytes => { await writeFile(join(output, 'widget.json'), '{"version":"1.2.3","changed":true}'); return inspect(bytes); })).rejects.toThrow('RN_BUILD_PATH');
    await file();
    await expect(collectFileBuildManifest(plan, output, async bytes => { await writeFile(join(output, 'extra.json'), '{}'); return inspect(bytes); })).rejects.toThrow('RN_BUILD_OUTPUT');
  });
  it('收集和下载复核都拒绝后续检查改写先前文件', async () => {
    await file(); await writeFile(join(output, 'z.json'), '{"version":"1.2.3"}');
    const plan = await planBuild(identity, { ...unit, outputs: [{ ...unit.outputs[0]!, count: 2 }] });
    const expected = await collectFileBuildManifest(plan, output, inspect);
    const changingInspector = async (bytes: Uint8Array, path: string) => {
      if (path === 'z.json') await writeFile(join(output, 'widget.json'), '{"version":"1.2.3","changed":true}');
      return inspect(bytes);
    };
    await expect(collectFileBuildManifest(plan, output, changingInspector)).rejects.toThrow('RN_BUILD_PATH');
    await file();
    await expect(verifyDownloadedFileBuild(plan, expected, output, changingInspector)).rejects.toThrow('RN_BUILD_PATH');
  });
  it('源码和中央输出目录必须分离，源码路径逐段检查', async () => {
    await validateBuildExecutionContext({ buildRunId: 'run-123', sourceDirectory: source, outputDirectory: output });
    await expect(validateBuildExecutionContext({ buildRunId: 'run-123', sourceDirectory: source, outputDirectory: source })).rejects.toThrow('RN_BUILD_PATH');
    await mkdir(join(source, 'nested'));
    await expect(validateBuildExecutionContext({ buildRunId: 'run-123', sourceDirectory: source, outputDirectory: join(source, 'nested') })).rejects.toThrow('RN_BUILD_PATH');
    await expect(assertBuildSourcePath(source, '../output')).rejects.toThrow('RN_BUILD_PATH');
    await expect(validateBuildExecutionContext({ buildRunId: 'bad\n', sourceDirectory: source, outputDirectory: output })).rejects.toThrow('RN_BUILD_INVALID');
  });
});
describe('构建入口验证', () => {
  it('固定入口必须是目标源码树中的常规文件', async () => {
    const plan = await planBuild(identity, unit);
    const context = { buildRunId: 'run-123', sourceDirectory: source, outputDirectory: output };
    await mkdir(join(source, 'tools')); await writeFile(join(source, 'tools', 'build.mjs'), 'export {};');
    await expect(validateBuildInputs(plan, context)).resolves.toBeUndefined();
    await expect(validateBuildInputs({ ...plan, inputs: { ...plan.inputs, entrypoint: 'tools' } }, context)).rejects.toThrow('RN_BUILD_PATH');
  });
});
describe('OCI 摘要链验证 T09', () => {
  it('元数据字节与 blob 共同计入总量', async () => {
    const { plan } = await oci();
    const allFiles = await actualFs.readdir(join(output, 'blobs', 'sha256'));
    const blobBytes = (await Promise.all(allFiles.map(async name => (await actualFs.stat(join(output, 'blobs', 'sha256', name))).size))).reduce((a, b) => a + b, 0);
    Object.defineProperty(buildLimits, 'maxTotalBytes', { value: blobBytes });
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_LIMIT');
  });
  it('共享层只读取一次，重复描述符的大小仍需一致', async () => {
    const { image, plan } = await oci();
    const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    const layerPath = join(output, 'blobs', 'sha256', imageManifest.layers[0].digest.slice(7));
    const outputs = ['first', 'second'].map(id => ({ id, kind: 'oci-image' as const, count: 1 }));
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: outputs.map(rule => ({ ...image, annotations: { 'org.opencontainers.image.ref.name': rule.id } })) }));
    await collectOciBuildManifest({ ...plan, outputs }, output);
    expect(vi.mocked(open).mock.calls.filter(([path]) => path === layerPath)).toHaveLength(1);
    imageManifest.layers.push({ ...imageManifest.layers[0], size: imageManifest.layers[0].size + 1 });
    const bytes = Buffer.from(JSON.stringify(imageManifest)); const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(output, 'blobs', 'sha256', hash), bytes);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...image, digest: `sha256:${hash}`, size: bytes.length, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_DIGEST');
  });
  it.each(['oci-layout', 'index.json', 'blob'])('整轮结束时复核已读取的 %s', async changed => {
    const { image, plan } = await oci();
    const expected = await collectOciBuildManifest(plan, output);
    const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    const layerPath = join(output, 'blobs', 'sha256', imageManifest.layers[0].digest.slice(7));
    const changedPath = changed === 'blob' ? join(output, 'blobs', 'sha256', imageManifest.config.digest.slice(7)) : join(output, changed);
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === layerPath) await writeFile(changedPath, 'changed during later read');
      return actualFs.open(...args);
    });
    await expect(verifyDownloadedOciBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_PATH');
  });
  it('索引子描述符必须与镜像 config 的平台一致', async () => {
    const { image, store, plan } = await oci(['linux/amd64', 'linux/arm64']);
    const imageIndex = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    [imageIndex.manifests[0].platform, imageIndex.manifests[1].platform] = [imageIndex.manifests[1].platform, imageIndex.manifests[0].platform];
    const swapped = await store(imageIndex, image.mediaType);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...swapped, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([['linux/amd64'], ['linux/amd64', 'linux/arm64']])('验证声明平台和 immutable digest %j', async (...platforms) => {
    const { image, plan } = await oci(platforms);
    const manifest = await collectOciBuildManifest(plan, output);
    expect(manifest.artifacts).toEqual([{ id: 'image', kind: 'oci-image', reference: `example/widget@${image.digest}`, digest: image.digest }]);
    await expect(verifyDownloadedOciBuild(plan, manifest, output)).resolves.toBeUndefined();
    await expect(verifyDownloadedOciBuild(plan, { ...manifest, targetSha: 'c'.repeat(40) }, output)).rejects.toThrow('RN_BUILD_DIGEST');
  });
  it('版本投影、未声明的平台和额外 blob 都失败', async () => {
    const { plan } = await oci(['linux/amd64'], '1.2.4');
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_VERSION');
    const { plan: valid } = await oci();
    await expect(collectOciBuildManifest({ ...valid, inputs: { ...valid.inputs, platforms: ['linux/arm64'] } }, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(collectOciBuildManifest(valid, output)).rejects.toThrow('RN_BUILD_OUTPUT');
  });
  it('下载后 blob 篡改和描述符字节数不一致均失败', async () => {
    const { image, plan } = await oci(); const manifest = await collectOciBuildManifest(plan, output);
    const index = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'));
    index.manifests[0].size++;
    await writeFile(join(output, 'index.json'), JSON.stringify(index));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_DIGEST');
    index.manifests[0].size--; await writeFile(join(output, 'index.json'), JSON.stringify(index));
    await writeFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'tampered');
    await expect(verifyDownloadedOciBuild(plan, manifest, output)).rejects.toThrow('RN_BUILD_DIGEST');
  });
  it('缺失输出标签、重复键和重复输出标签均失败', async () => {
    const { plan } = await oci();
    const index = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'));
    delete index.manifests[0].annotations;
    await writeFile(join(output, 'index.json'), JSON.stringify(index));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_OUTPUT');
    await writeFile(join(output, 'index.json'), '{"schemaVersion":2,"schemaVersion":2,"manifests":[]}');
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
    index.manifests[0].annotations = { 'org.opencontainers.image.ref.name': 'image' }; index.manifests.push(index.manifests[0]);
    await writeFile(join(output, 'index.json'), JSON.stringify(index));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_OUTPUT');
  });
});
