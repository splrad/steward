import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import AjvModule from 'ajv/dist/2020.js';
import { assertBuildOciRepository, assertBuildPath, BuildContractError, canonicalBuildManifest, decodeBuildJson, parseBuildManifest, type BuildIdentity, type BuildManifest } from '../src/build-manifest.js';

const identity: BuildIdentity = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', profile: 'custom-adapter-v1', targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
describe('构建合同 T09/T10', () => {
  it.each(['[::1]:5000/example/widget', '[2001:DB8::1]/example/widget', 'ghcr.io/example/widget:Release-1'])('Core 和 Schema 接受 IPv6 registry 与大小写敏感标签 %s', async repository => {
    const manifest: BuildManifest = { ...identity, profile: 'oci-image-v1', schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'image', kind: 'oci-image', reference: `${repository}@sha256:${'d'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` }] };
    const Ajv = AjvModule as unknown as typeof import('ajv').default;
    const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile('schema/build-manifest.schema.json', 'utf8')));
    expect(validate(manifest)).toBe(true);
    expect(parseBuildManifest(new TextEncoder().encode(canonicalBuildManifest(manifest)))).toEqual(manifest);
    if (!repository.includes('Release-1')) expect(() => assertBuildOciRepository(repository)).not.toThrow();
  });
  it.each(['[fe80::1%eth0]/example/widget', '[::ffff:192.0.2.1]/example/widget', '[::1]/Example/Widget', 'example/widget:-Release', `example/widget:${'R'.repeat(129)}`])('Core 和 Schema 拒绝非法 IPv6 路径或标签 %s', async repository => {
    const manifest: BuildManifest = { ...identity, profile: 'oci-image-v1', schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'image', kind: 'oci-image', reference: `${repository}@sha256:${'d'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` }] };
    const Ajv = AjvModule as unknown as typeof import('ajv').default;
    const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile('schema/build-manifest.schema.json', 'utf8')));
    expect(validate(manifest)).toBe(false);
    expect(() => canonicalBuildManifest(manifest)).toThrow('RN_BUILD_OUTPUT');
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_OUTPUT');
  });

  it.each(['example//widget', 'example/.github', 'example/widget.', 'example/_widget', 'example/widget___part', 'example/widget:tag:extra'])('生成和解析拒绝非法 OCI 仓库引用 %s', repository => {
    const manifest: BuildManifest = { ...identity, profile: 'oci-image-v1', schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'image', kind: 'oci-image', reference: `${repository}@sha256:${'d'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` }] };
    expect(() => canonicalBuildManifest(manifest)).toThrow('RN_BUILD_OUTPUT');
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_OUTPUT');
  });
  it.each(['example/widget', 'ghcr.io/example/widget', 'localhost:5000/example/widget:v1.2.3', 'example/widget__part', 'example/widget---part'])('保留合法 OCI 路径、registry 端口和标签 %s', repository => {
    const manifest: BuildManifest = { ...identity, profile: 'oci-image-v1', schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'image', kind: 'oci-image', reference: `${repository}@sha256:${'d'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` }] };
    expect(parseBuildManifest(new TextEncoder().encode(canonicalBuildManifest(manifest)))).toEqual(manifest);
  });
  it('OCI Schema 与核心对路径语法一致，摘要绑定和长度限制由核心复核', async () => {
    const Ajv = AjvModule as unknown as typeof import('ajv').default;
    const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile('schema/build-manifest.schema.json', 'utf8')));
    const make = (repository: string): BuildManifest => ({ ...identity, profile: 'oci-image-v1', schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'image', kind: 'oci-image', reference: `${repository}@sha256:${'d'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` }] });
    for (const repository of ['example/widget', 'ghcr.io/example/widget', 'localhost:5000/example/widget:v1.2.3']) expect(validate(make(repository))).toBe(true);
    for (const repository of ['example//widget', 'example/.github', 'example/widget___part', 'example/widget:tag:extra']) expect(validate(make(repository))).toBe(false);
    const manifest = make(`ghcr.io/${'x'.repeat(255)}`);
    expect(() => canonicalBuildManifest(manifest)).not.toThrow();
    expect(() => canonicalBuildManifest(make(`ghcr.io/${'x'.repeat(256)}`))).toThrow('RN_BUILD_OUTPUT');
    expect(() => canonicalBuildManifest(make(`example/widget:${'x'.repeat(129)}`))).toThrow('RN_BUILD_OUTPUT');
    const mismatch = make('example/widget'); (mismatch.artifacts[0] as import('../src/build-manifest.js').ImageArtifact).digest = `sha256:${'e'.repeat(64)}`;
    expect(() => canonicalBuildManifest(mismatch)).toThrow('RN_BUILD_OUTPUT');
  });
  it.each([{ artifacts: new Array<BuildManifest['artifacts'][number]>(1) }, { artifacts: [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }, ,] }])('生成拒绝稀疏产物数组 %j', ({ artifacts }) => {
    const manifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts } as BuildManifest;
    expect(() => canonicalBuildManifest(manifest)).toThrow('RN_BUILD_INVALID');
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_INVALID');
  });
  it.each(['01.2.3', '1.2', '1.2.3.0', '1.2.3-beta', '1.2.3\n'])('历史清单生成和解析拒绝格式错误版本 %j', async version => {
    const manifest: BuildManifest = { ...identity, version, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'asset.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    for (const operation of [() => canonicalBuildManifest(manifest), () => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))]) {
      expect(operation).toThrow(BuildContractError);
      try { operation(); } catch (error) { expect(error).toHaveProperty('code', 'RN_BUILD_INVALID'); }
    }
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
  it('OCI 字符策略接受转义换行，合同字符策略仍拒绝', () => {
    const bytes = new TextEncoder().encode('{"Cmd":["line one\\nline two\\tend"]}');
    expect(decodeBuildJson(bytes, 'oci')).toEqual({ Cmd: ['line one\nline two\tend'] });
    expect(() => decodeBuildJson(bytes)).toThrow('RN_BUILD_INVALID');
    for (const source of ['{"a":1,"a":2}', '{"a":"\\ud800"}', '\ufeff{}', '{"a":1e400}']) {
      expect(() => decodeBuildJson(new TextEncoder().encode(source), 'oci')).toThrow('RN_BUILD_INVALID');
    }
  });
  it.each([['example/widget'], null, true, 1])('拒绝非字符串仓库名 %j', async fullName => {
    const manifest = { ...identity, fullName, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_INVALID');
  });
  it.each([['application/zip'], null, true])('清单拒绝非字符串媒体类型 %j', mediaType => {
    const manifest = { ...identity, schemaVersion: 1, inputsSha256: 'c'.repeat(64), artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType, size: 1, sha256: 'd'.repeat(64) }] };
    expect(() => parseBuildManifest(new TextEncoder().encode(JSON.stringify(manifest)))).toThrow('RN_BUILD_OUTPUT');
  });
  it.each(['/root', '../asset', 'a/../b', 'a\\b', 'a//b', 'C:/asset', 'CON.zip', 'foo:bar', 'asset.', 'asset ', 'a\n', 'x/[ab].zip'])('拒绝非法路径 %j', path => {
    expect(() => assertBuildPath(path, { glob: true })).toThrow('RN_BUILD_PATH');
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
});
