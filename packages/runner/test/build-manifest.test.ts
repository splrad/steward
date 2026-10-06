import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, win32 } from 'node:path';
import { BuildContractError, buildLimits, planBuild, type BuildIdentity, type BuildUnit } from '../../core/src/build-manifest.js';
import { githubBuildExecutionPolicy, assertBuildDirectoriesSeparate, assertBuildSourcePath, collectFileBuildManifest, collectOciBuildManifest, validateBuildExecutionContext, validateBuildInputs, verifyDownloadedFileBuild, verifyDownloadedOciBuild } from '../src/build-manifest.js';

const identity: BuildIdentity = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', profile: 'custom-adapter-v1', targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
const unit: BuildUnit = { profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.mjs', runtime: 'node', runnerFamily: 'linux' }, outputs: [{ id: 'archive', kind: 'file', match: '*.json', count: 1, mediaType: 'application/json' }] };
const inspect = async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)).version ?? null;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), realpath: vi.fn(actual.realpath) };
});
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, relative: vi.fn(actual.relative) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualPath = await vi.importActual<typeof import('node:path')>('node:path');
const originalTotalLimit = buildLimits.maxTotalBytes;
let root: string; let output: string; let source: string;
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open);
  vi.mocked(realpath).mockReset().mockImplementation(actualFs.realpath);
  vi.mocked(opendir).mockReset().mockImplementation(actualFs.opendir);
  vi.mocked(relative).mockReset().mockImplementation(actualPath.relative);
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
  it.each(['ENOENT', 'ENOTDIR', 'ELOOP', 'EIO'])('读取失败分类路径错误并保留其他异常 %s', async code => {
    await file(); const plan = await planBuild(identity, unit); const error = Object.assign(new Error(code), { code });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args); vi.spyOn(handle, 'read').mockRejectedValueOnce(error); return handle;
    });
    const operation = collectFileBuildManifest(plan, output, inspect);
    if (code === 'EIO') await expect(operation).rejects.toBe(error);
    else { await expect(operation).rejects.toBeInstanceOf(BuildContractError); await expect(operation).rejects.toMatchObject({ code: 'RN_BUILD_PATH' }); }
  });
  it('native inspector 的同名错误保持原异常', async () => {
    await file(); const plan = await planBuild(identity, unit); const error = Object.assign(new Error('inspector'), { code: 'ENOENT' });
    await expect(collectFileBuildManifest(plan, output, async () => { throw error; })).rejects.toBe(error);
  });
  it('多平台 index 不能声明单一架构', async () => {
    const { image, store, plan } = await oci(['linux/amd64', 'linux/arm64']);
    const outer = { ...await store({ schemaVersion: 2, manifests: [image] }, 'application/vnd.oci.image.index.v1+json'), platform: { os: 'linux', architecture: 'amd64' }, annotations: { 'org.opencontainers.image.ref.name': 'image' } };
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [outer] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(verifyDownloadedOciBuild(plan, {} as never, output)).rejects.toThrow('RN_BUILD_INVALID');
  });

  it.each([
    ['dotnet-assets-v1', { project: 'src/Widget.csproj', configuration: 'Release', framework: 'net8.0-windows', runtime: 'win-x64' }, 'windows-latest'],
    ['node-package-v1', { directory: '.', lockfile: 'package-lock.json', buildTask: 'build', packageManager: 'npm' }, 'ubuntu-latest'],
    ['oci-image-v1', { context: '.', dockerfile: 'Dockerfile', platforms: ['linux/amd64'] }, 'ubuntu-latest'],
    ['custom-adapter-v1', unit.inputs, 'ubuntu-latest'],
    ['custom-adapter-v1', { ...unit.inputs, runnerFamily: 'windows' }, 'windows-latest'],
  ] as const)('GitHub adapter 为 %s 映射执行策略 %j', async (profile, inputs, runner) => {
    const outputs = profile === 'oci-image-v1' ? [{ id: 'image', kind: 'oci-image' as const, count: 1 }] : unit.outputs;
    const plan = await planBuild({ ...identity, profile }, { profile, inputs, outputs });
    expect(githubBuildExecutionPolicy(plan)).toEqual({ runner, timeoutMinutes: 45, permissions: { contents: 'read' }, environment: null, persistCredentials: false });
  });
  it('GitHub adapter 拒绝未知 runner family', async () => {
    const plan = await planBuild(identity, unit);
    expect(() => githubBuildExecutionPolicy({ ...plan, runnerFamily: 'unknown' } as unknown as typeof plan)).toThrow('RN_BUILD_INVALID');
  });
  it('OCI 收集和下载接受 IPv6 registry 映射', async () => {
    const { plan } = await oci(); const repository = '[::1]:5000/example/widget';
    const manifest = await collectOciBuildManifest(plan, output, repository);
    expect(manifest.artifacts[0]).toMatchObject({ reference: expect.stringContaining(`${repository}@sha256:`) });
    await expect(verifyDownloadedOciBuild(plan, manifest, output, repository)).resolves.toBeUndefined();
  });
  it.each(['root', 'nested'].flatMap(location => ['matching', 'missing', 'mismatch', 'invalid-type', 'null'].map(mode => [location, mode])))('嵌套 index 平台声明在 %s 处理 %s', async (location, mode) => {
    const { image, store, plan } = await oci(['linux/arm64']);
    const platform = mode === 'missing' ? undefined : mode === 'matching' ? { os: 'linux', architecture: 'arm64' } : mode === 'mismatch' ? { os: 'linux', architecture: 'amd64' } : mode === 'null' ? null : { os: ['linux'], architecture: 'arm64' };
    const child = { ...await store({ schemaVersion: 2, manifests: [image] }, 'application/vnd.oci.image.index.v1+json'), ...(location === 'nested' ? { platform } : {}) };
    const outer = { ...await store({ schemaVersion: 2, manifests: [child] }, 'application/vnd.oci.image.index.v1+json'), ...(location === 'root' ? { platform } : {}), annotations: { 'org.opencontainers.image.ref.name': 'image' } };
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [outer] }));
    if (mode === 'matching' || mode === 'missing') {
      const manifest = await collectOciBuildManifest(plan, output);
      expect(manifest.artifacts[0]).toMatchObject({ digest: outer.digest });
      await expect(verifyDownloadedOciBuild(plan, manifest, output)).resolves.toBeUndefined();
    } else {
      await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
      await expect(verifyDownloadedOciBuild(plan, {} as never, output)).rejects.toThrow('RN_BUILD_INVALID');
    }
  });
  it('未声明平台的嵌套多平台 index 保留所有平台和外层摘要', async () => {
    const { image, store, plan } = await oci(['linux/amd64', 'linux/arm64']);
    const outer = { ...await store({ schemaVersion: 2, manifests: [image] }, 'application/vnd.oci.image.index.v1+json'), annotations: { 'org.opencontainers.image.ref.name': 'image' } };
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [outer] }));
    const manifest = await collectOciBuildManifest(plan, output);
    expect(manifest.artifacts[0]).toMatchObject({ digest: outer.digest });
    await expect(verifyDownloadedOciBuild(plan, manifest, output)).resolves.toBeUndefined();
  });

  it.each(['file', 'oci'])('非目录输出根在 %s 收集和下载中返回路径合同错误', async kind => {
    let plan; let expected;
    if (kind === 'file') { await file(); plan = await planBuild(identity, unit); expected = await collectFileBuildManifest(plan, output, inspect); }
    else { ({ plan } = await oci()); expected = await collectOciBuildManifest(plan, output); }
    const badRoot = join(root, 'not-directory'); await writeFile(badRoot, 'file');
    for (const mode of ['collect', 'download']) {
      const operation = kind === 'file'
        ? mode === 'collect' ? collectFileBuildManifest(plan, badRoot, inspect) : verifyDownloadedFileBuild(plan, expected, badRoot, inspect)
        : mode === 'collect' ? collectOciBuildManifest(plan, badRoot) : verifyDownloadedOciBuild(plan, expected, badRoot);
      await expect(operation).rejects.toBeInstanceOf(BuildContractError);
      await expect(operation).rejects.toMatchObject({ code: 'RN_BUILD_PATH' });
    }
  });
  it.each(['file', 'oci'])('打开前删除 %s 文件时收集和下载返回路径合同错误', async kind => {
    let plan; let expected;
    if (kind === 'file') { await file(); plan = await planBuild(identity, unit); expected = await collectFileBuildManifest(plan, output, inspect); }
    else { ({ plan } = await oci()); expected = await collectOciBuildManifest(plan, output); }
    const target = join(output, kind === 'file' ? 'widget.json' : 'index.json'); const bytes = await readFile(target);
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === target) await actualFs.unlink(target);
      return actualFs.open(...args);
    });
    for (const mode of ['collect', 'download']) {
      await writeFile(target, bytes);
      const operation = kind === 'file'
        ? mode === 'collect' ? collectFileBuildManifest(plan, output, inspect) : verifyDownloadedFileBuild(plan, expected, output, inspect)
        : mode === 'collect' ? collectOciBuildManifest(plan, output) : verifyDownloadedOciBuild(plan, expected, output);
      await expect(operation).rejects.toBeInstanceOf(BuildContractError);
      await expect(operation).rejects.toMatchObject({ code: 'RN_BUILD_PATH' });
    }
  });
  it.each(['ENOENT', 'ENOTDIR', 'ELOOP', 'EIO'])('枚举中途失败分类路径错误并保留其他异常 %s', async code => {
    await file(); const plan = await planBuild(identity, unit);
    const error = Object.assign(new Error(code), { code }); let closed = false;
    const directory = await actualFs.opendir(output);
    directory[Symbol.asyncIterator] = async function* () { try { throw error; } finally { await directory.close(); closed = true; } };
    vi.mocked(opendir).mockResolvedValueOnce(directory);
    const operation = collectFileBuildManifest(plan, output, inspect);
    if (code === 'EIO') await expect(operation).rejects.toBe(error);
    else { await expect(operation).rejects.toBeInstanceOf(BuildContractError); await expect(operation).rejects.toMatchObject({ code: 'RN_BUILD_PATH' }); }
    expect(closed).toBe(true);
  });
  it.each(['ENOENT', 'ENOTDIR', 'ELOOP', 'EIO'])('打开失败分类路径错误并保留其他异常 %s', async code => {
    await file(); const plan = await planBuild(identity, unit);
    const error = Object.assign(new Error(code), { code }); vi.mocked(open).mockRejectedValueOnce(error);
    const operation = collectFileBuildManifest(plan, output, inspect);
    if (code === 'EIO') await expect(operation).rejects.toBe(error);
    else { await expect(operation).rejects.toBeInstanceOf(BuildContractError); await expect(operation).rejects.toMatchObject({ code: 'RN_BUILD_PATH' }); }
  });
  it('OCI 收集和下载保持仓库映射语法并拒绝旧的非法名称', async () => {
    const { plan } = await oci();
    const mapped = { ...plan, fullName: 'Example/Widget__Part' };
    const expected = await collectOciBuildManifest(mapped, output);
    expect(expected.artifacts[0]).toMatchObject({ reference: expect.stringMatching(/^example\/widget__part@sha256:/u) });
    await expect(verifyDownloadedOciBuild(mapped, expected, output)).resolves.toBeUndefined();
    const invalid = { ...plan, fullName: 'example/.github' };
    await expect(collectOciBuildManifest(invalid, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(verifyDownloadedOciBuild(invalid, expected, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it('源仓库 .github 可以通过显式 registry namespace 收集和下载', async () => {
    const { plan } = await oci();
    const identityPlan = { ...plan, fullName: 'example/.github' };
    const repository = 'ghcr.io/example/organization-config';
    const expected = await collectOciBuildManifest(identityPlan, output, repository);
    expect(expected.fullName).toBe('example/.github');
    expect(expected.artifacts[0]).toMatchObject({ reference: expect.stringMatching(/^ghcr\.io\/example\/organization-config@sha256:/u) });
    await expect(verifyDownloadedOciBuild(identityPlan, expected, output, repository)).resolves.toBeUndefined();
    await expect(verifyDownloadedOciBuild(identityPlan, expected, output, 'ghcr.io/other/config')).rejects.toThrow('RN_BUILD_DIGEST');
  });
  it.each([{ repository: 'example/.github' }, { repository: 'example//widget' }, { repository: 'Example/Widget' }, { repository: null }, { repository: 1 }, { repository: ['example/widget'] }, { repository: new String('example/widget') }])('runner 拒绝非法显式 OCI 名称 %j', async ({ repository }) => {
    const { plan } = await oci();
    await expect(collectOciBuildManifest(plan, output, repository as string)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([{ fullName: null }, { fullName: undefined }, { fullName: ['example/widget'] }])('runner 默认映射保留非字符串源身份的合同错误 %j', async ({ fullName }) => {
    const { plan } = await oci();
    await expect(collectOciBuildManifest({ ...plan, fullName } as unknown as typeof plan, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it('拒绝解析后越出根目录的绝对相对路径', async () => {
    expect(win32.isAbsolute(win32.relative('D:\\source', 'C:\\outside\\build.mjs'))).toBe(true);
    await writeFile(join(source, 'build.mjs'), 'build');
    const outside = join(output, 'build.mjs'); await writeFile(outside, 'outside');
    vi.mocked(realpath).mockResolvedValueOnce(resolve(source)).mockResolvedValueOnce(outside);
    vi.mocked(relative).mockReturnValueOnce(outside);
    await expect(assertBuildSourcePath(source, 'build.mjs')).rejects.toThrow('RN_BUILD_PATH');
  });
  it.each([{ kind: 'file', entries: 'directory' }, { kind: 'oci', entries: 'directory' }, { kind: 'file', entries: 'file' }, { kind: 'oci', entries: 'file' }])('目录规模超限时收集和下载提前关闭枚举句柄 %j', async ({ kind, entries }) => {
    await mkdir(join(output, 'empty'));
    let plan; let expected;
    if (kind === 'file') { await file(); plan = await planBuild(identity, unit); expected = await collectFileBuildManifest(plan, output, inspect); }
    else { ({ plan } = await oci()); expected = await collectOciBuildManifest(plan, output); }
    for (const mode of ['collect', 'download']) {
      let readEntries = 0; let closed = false;
      const directory = await actualFs.opendir(output);
      directory[Symbol.asyncIterator] = async function* () {
        try {
          for (;;) { readEntries++; yield { name: entries === 'directory' ? 'empty' : kind === 'file' ? 'widget.json' : 'index.json' } as import('node:fs').Dirent; }
        } finally { closed = true; await directory.close(); }
      };
      vi.mocked(opendir).mockResolvedValueOnce(directory);
      const operation = kind === 'file'
        ? mode === 'collect' ? collectFileBuildManifest(plan, output, inspect) : verifyDownloadedFileBuild(plan, expected, output, inspect)
        : mode === 'collect' ? collectOciBuildManifest(plan, output) : verifyDownloadedOciBuild(plan, expected, output);
      await expect(operation).rejects.toThrow('RN_BUILD_LIMIT');
      expect(readEntries).toBe(entries === 'directory' ? buildLimits.maxFiles * 4 : buildLimits.maxFiles + 1); expect(closed).toBe(true);
    }
  });
  it.each(['ENOENT', 'ENOTDIR', 'ELOOP', 'EIO'])('路径解析分类预期错误并保留其他异常 %s', async code => {
    const error = Object.assign(new Error(code), { code });
    vi.mocked(realpath).mockRejectedValueOnce(error);
    const operation = assertBuildSourcePath(source, '.', { root: true });
    if (code === 'EIO') await expect(operation).rejects.toBe(error);
    else await expect(operation).rejects.toThrow('RN_BUILD_PATH');
  });
  it('缺失入口和非目录路径返回构建路径错误', async () => {
    const plan = await planBuild(identity, unit);
    await expect(validateBuildInputs(plan, { buildRunId: 'run-1', sourceDirectory: source, outputDirectory: output })).rejects.toThrow('RN_BUILD_PATH');
    await writeFile(join(source, 'tools'), 'not a directory');
    await expect(validateBuildInputs(plan, { buildRunId: 'run-1', sourceDirectory: source, outputDirectory: output })).rejects.toThrow('RN_BUILD_PATH');
  });
  it.each(['collect', 'download'])('缺失 OCI blob 在 %s 时返回构建路径错误', async mode => {
    const { plan, image } = await oci();
    const expected = await collectOciBuildManifest(plan, output);
    await actualFs.unlink(join(output, 'blobs', 'sha256', image.digest.slice(7)));
    await expect(mode === 'collect' ? collectOciBuildManifest(plan, output) : verifyDownloadedOciBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_PATH');
  });
  it.each(['collect', 'download'])('无公共版本时 %s 忽略检查器并保持分块摘要和状态复核', async mode => {
    await writeFile(join(output, 'widget.json'), Buffer.alloc(128 * 1024 + 1, 120));
    const plan = await planBuild({ ...identity, version: null }, unit);
    const expected = await collectFileBuildManifest(plan, output);
    const inspector = vi.fn(async () => { throw new Error('unexpected native inspection'); });
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      if (mode === 'collect') expect(await collectFileBuildManifest(plan, output, inspector)).toEqual(expected);
      else await expect(verifyDownloadedFileBuild(plan, expected, output, inspector)).resolves.toBeUndefined();
      expect(inspector).not.toHaveBeenCalled(); expect(concat).not.toHaveBeenCalled();
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args); const read = handle.read.bind(handle); let changed = false;
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (!changed) { changed = true; await truncate(join(output, 'widget.json'), 2 * 1024 * 1024); }
          return read(...readArgs);
        }) as typeof handle.read;
        return handle;
      });
      await expect(mode === 'collect' ? collectFileBuildManifest(plan, output, inspector) : verifyDownloadedFileBuild(plan, expected, output, inspector)).rejects.toThrow('RN_BUILD_DIGEST');
    } finally { concat.mockRestore(); }
  });
  it.skipIf(process.platform === 'win32').each(['file', 'oci'])('常规 %s 文件被替换为 FIFO 时收集和下载受控失败', async kind => {
    let plan; let expected;
    if (kind === 'file') { await file(); plan = await planBuild(identity, unit); expected = await collectFileBuildManifest(plan, output, inspect); }
    else { ({ plan } = await oci()); expected = await collectOciBuildManifest(plan, output); }
    const target = join(output, kind === 'file' ? 'widget.json' : 'index.json');
    const original = await readFile(target);
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === target) {
        expect((args[1] as number) & constants.O_NONBLOCK).not.toBe(0);
        await actualFs.unlink(target);
        await promisify(execFile)('mkfifo', [target]);
      }
      return actualFs.open(...args);
    });
    for (const mode of ['collect', 'download']) {
      await actualFs.unlink(target); await writeFile(target, original);
      const operation = kind === 'file'
        ? mode === 'collect' ? collectFileBuildManifest(plan, output, inspect) : verifyDownloadedFileBuild(plan, expected, output, inspect)
        : mode === 'collect' ? collectOciBuildManifest(plan, output) : verifyDownloadedOciBuild(plan, expected, output);
      await expect(operation).rejects.toThrow('RN_BUILD_PATH');
    }
  });
  it.each(['collect', 'download'])('无版本检查器时 %s 以分块摘要验证文件', async mode => {
    const payload = Buffer.alloc(128 * 1024 + 1, 120);
    await writeFile(join(output, 'widget.json'), payload);
    const plan = await planBuild({ ...identity, version: null }, unit);
    const expected = await collectFileBuildManifest(plan, output);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      if (mode === 'collect') expect((await collectFileBuildManifest(plan, output)).artifacts[0]).toMatchObject({ size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
      else {
        await expect(verifyDownloadedFileBuild(plan, expected, output)).resolves.toBeUndefined();
        payload[0] = 121;
        await writeFile(join(output, 'widget.json'), payload);
        await expect(verifyDownloadedFileBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_DIGEST');
      }
      expect(concat).not.toHaveBeenCalled();
    } finally { concat.mockRestore(); }
  });
  it.each(['collect', 'download'])('文件增长时 %s 的读取量受初始大小约束', async mode => {
    await file(); const plan = await planBuild(identity, unit);
    const expected = await collectFileBuildManifest(plan, output, inspect);
    const path = join(output, 'widget.json'); const initialSize = (await actualFs.stat(path)).size;
    let readBytes = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      expect(args[1]).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const handle = await actualFs.open(...args);
      const read = handle.read.bind(handle); let grown = false;
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        if (!grown) { await truncate(path, 2 * 1024 * 1024); grown = true; }
        const result = await read(...readArgs); readBytes += result.bytesRead; return result;
      }) as typeof handle.read;
      handle.readFile = vi.fn(() => { throw new Error('file artifacts must use bounded reads'); });
      return handle;
    });
    const operation = mode === 'collect' ? collectFileBuildManifest(plan, output, inspect) : verifyDownloadedFileBuild(plan, expected, output, inspect);
    await expect(operation).rejects.toThrow('RN_BUILD_DIGEST');
    expect(readBytes).toBeLessThanOrEqual(initialSize + 1);
  });
  it('按实际字节生成清单并在下载后重新验证', async () => {
    await file(); const plan = await planBuild(identity, unit);
    const manifest = await collectFileBuildManifest(plan, output, inspect);
    const bytes = await readFile(join(output, 'widget.json'));
    expect(manifest.artifacts).toEqual([{ id: 'archive', kind: 'file', file: 'widget.json', mediaType: 'application/json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]);
    await expect(verifyDownloadedFileBuild(plan, manifest, output, inspect)).resolves.toBeUndefined();
    await file('1.2.4'); await expect(verifyDownloadedFileBuild(plan, manifest, output, inspect)).rejects.toThrow('RN_BUILD_VERSION');
  });
  it('检查器修改缓冲区不改变磁盘字节的摘要', async () => {
    await file(); const plan = await planBuild(identity, unit);
    const diskBytes = await readFile(join(output, 'widget.json'));
    const mutatingInspector = async (bytes: Uint8Array) => { bytes.fill(0); return '1.2.3'; };
    const manifest = await collectFileBuildManifest(plan, output, mutatingInspector);
    expect(manifest.artifacts[0]).toMatchObject({ size: diskBytes.length, sha256: createHash('sha256').update(diskBytes).digest('hex') });
    await verifyDownloadedFileBuild(plan, manifest, output, mutatingInspector);
    await writeFile(join(output, 'widget.json'), '{"version":"9.9.9"}');
    await expect(verifyDownloadedFileBuild(plan, manifest, output, mutatingInspector)).rejects.toThrow('RN_BUILD_DIGEST');
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
  it('运行编号拒绝可转换为字符串的数组', async () => {
    await expect(validateBuildExecutionContext({ buildRunId: ['run-123'] as unknown as string, sourceDirectory: source, outputDirectory: output })).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([['D:\\source', 'C:\\output'], ['C:\\source', 'C:\\output'], ['\\\\server\\first\\source', '\\\\server\\second\\output']])('Windows 独立目录 %j %j 可用', (sourcePath, outputPath) => {
    expect(() => assertBuildDirectoriesSeparate(sourcePath, outputPath, win32)).not.toThrow();
  });
  it.each([['D:\\source', 'd:\\SOURCE'], ['D:\\source', 'D:\\source\\output'], ['D:\\source\\nested', 'D:\\source']])('Windows 相同或嵌套目录 %j %j 失败', (sourcePath, outputPath) => {
    expect(() => assertBuildDirectoriesSeparate(sourcePath, outputPath, win32)).toThrow('RN_BUILD_PATH');
  });
  it('固定入口必须是目标源码树中的常规文件', async () => {
    const plan = await planBuild(identity, unit);
    const context = { buildRunId: 'run-123', sourceDirectory: source, outputDirectory: output };
    await mkdir(join(source, 'tools')); await writeFile(join(source, 'tools', 'build.mjs'), 'export {};');
    await expect(validateBuildInputs(plan, context)).resolves.toBeUndefined();
    await expect(validateBuildInputs({ ...plan, inputs: { ...plan.inputs, entrypoint: 'tools' } }, context)).rejects.toThrow('RN_BUILD_PATH');
  });
});
describe('OCI 摘要链验证 T09', () => {
  it.each(['oci-layout', 'index.json', 'config', 'manifest', 'image-index'].flatMap(location => ['null', '[]', '1', 'true', '"metadata"'].map(json => [location, json])))('收集和下载拒绝 %s 的非法 JSON 根值 %s', async (location, json) => {
    const { image, store, plan } = await oci();
    const expected = await collectOciBuildManifest(plan, output);
    if (location === 'oci-layout' || location === 'index.json') await writeFile(join(output, location), json);
    else {
      let changed;
      if (location === 'config') {
        const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
        imageManifest.config = await store(json, imageManifest.config.mediaType);
        changed = await store(imageManifest, image.mediaType);
      } else changed = await store(json, location === 'manifest' ? image.mediaType : 'application/vnd.oci.image.index.v1+json');
      await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...changed, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    }
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(verifyDownloadedOciBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each(['descriptor', 'layer'])('收集和下载拒绝 null %s 元素', async location => {
    const { image, store, plan } = await oci();
    const expected = await collectOciBuildManifest(plan, output);
    let descriptor: unknown = null;
    if (location === 'layer') {
      const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
      imageManifest.layers = [null];
      descriptor = { ...await store(imageManifest, image.mediaType), annotations: { 'org.opencontainers.image.ref.name': 'image' } };
    }
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(verifyDownloadedOciBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each([[['linux'], 'amd64'], ['linux', ['amd64']], [['linux'], ['amd64']]])('无描述符 platform 时拒绝无效 config 类型 %j %j', async (os, architecture) => {
    const { image, store, plan } = await oci();
    const expected = await collectOciBuildManifest(plan, output);
    const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    const oldConfig = join(output, 'blobs', 'sha256', imageManifest.config.digest.slice(7));
    const config = JSON.parse(await readFile(oldConfig, 'utf8')); config.os = os; config.architecture = architecture;
    imageManifest.config = await store(config, imageManifest.config.mediaType);
    const changed = await store(imageManifest, image.mediaType);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...changed, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await actualFs.unlink(oldConfig); await actualFs.unlink(join(output, 'blobs', 'sha256', image.digest.slice(7)));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_INVALID');
    await expect(verifyDownloadedOciBuild(plan, expected, output)).rejects.toThrow('RN_BUILD_INVALID');
  });
  it.each(['oci-layout', 'index.json'])('在打开 %s 前拒绝超大 JSON', async path => {
    const { plan } = await oci();
    const oversized = join(output, path);
    await truncate(oversized, 512 * 1024 + 1);
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_LIMIT');
    expect(vi.mocked(open).mock.calls.filter(([file]) => file === oversized)).toHaveLength(0);
  });
  it.each(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json'])('读取 %s 前检查描述符 JSON 上限', async mediaType => {
    const { image, plan } = await oci();
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...image, mediaType, size: 512 * 1024 + 1, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_LIMIT');
    expect(vi.mocked(open).mock.calls.filter(([file]) => file === join(output, 'blobs', 'sha256', image.digest.slice(7)))).toHaveLength(0);
  });
  it('config 的实际字节数和描述符分别受 JSON 上限约束', async () => {
    const { image, store, plan } = await oci();
    const imagePath = join(output, 'blobs', 'sha256', image.digest.slice(7));
    const imageManifest = JSON.parse(await readFile(imagePath, 'utf8'));
    const configPath = join(output, 'blobs', 'sha256', imageManifest.config.digest.slice(7));
    await truncate(configPath, 512 * 1024 + 1);
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_LIMIT');
    expect(vi.mocked(open).mock.calls.filter(([file]) => file === configPath)).toHaveLength(0);
    imageManifest.config.size = 512 * 1024 + 1;
    const changed = await store(imageManifest, image.mediaType);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...changed, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_LIMIT');
  });
  it('JSON 打开后增长时读取量仍受初始大小约束', async () => {
    const { plan } = await oci(); const indexPath = join(output, 'index.json');
    let readBytes = 0;
    const initialSize = (await actualFs.stat(indexPath)).size;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (args[0] === indexPath) {
        const read = handle.read.bind(handle);
        let grown = false;
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (!grown) { await truncate(indexPath, 2 * 1024 * 1024); grown = true; }
          const result = await read(...readArgs); readBytes += result.bytesRead; return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(collectOciBuildManifest(plan, output)).rejects.toThrow('RN_BUILD_DIGEST');
    expect(readBytes).toBeLessThanOrEqual(initialSize + 1);
  });
  it('合法的多行命令和 history 可收集并下载复核', async () => {
    const { image, store, plan } = await oci();
    const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    const oldConfig = join(output, 'blobs', 'sha256', imageManifest.config.digest.slice(7));
    const config = JSON.parse(await readFile(oldConfig, 'utf8'));
    config.config.Cmd = ['sh', '-c', 'printf "hello"\nprintf "world"\t'];
    config.config.Env = ['TEXT=line1\nline2']; config.config.Labels.description = 'multi\nline';
    config.history = [{ created_by: 'RUN first\n\tsecond' }];
    imageManifest.config = await store(config, imageManifest.config.mediaType);
    const changed = await store(imageManifest, image.mediaType);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...changed, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await actualFs.unlink(oldConfig); await actualFs.unlink(join(output, 'blobs', 'sha256', image.digest.slice(7)));
    const manifest = await collectOciBuildManifest(plan, output);
    await expect(verifyDownloadedOciBuild(plan, manifest, output)).resolves.toBeUndefined();
  });
  it('layer 使用独立上限并通过分块读取验证', async () => {
    const { image, store, plan } = await oci();
    const imageManifest = JSON.parse(await readFile(join(output, 'blobs', 'sha256', image.digest.slice(7)), 'utf8'));
    const oldLayer = join(output, 'blobs', 'sha256', imageManifest.layers[0].digest.slice(7));
    imageManifest.layers[0] = await store('x'.repeat(512 * 1024 + 1), imageManifest.layers[0].mediaType);
    const changed = await store(imageManifest, image.mediaType);
    await writeFile(join(output, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...changed, annotations: { 'org.opencontainers.image.ref.name': 'image' } }] }));
    await actualFs.unlink(oldLayer); await actualFs.unlink(join(output, 'blobs', 'sha256', image.digest.slice(7)));
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      handle.readFile = vi.fn(() => { throw new Error('OCI must use bounded reads'); });
      return handle;
    });
    await expect(collectOciBuildManifest(plan, output)).resolves.toMatchObject({ profile: 'oci-image-v1' });
  });
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
