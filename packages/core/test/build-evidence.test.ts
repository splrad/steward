import { describe, expect, it } from 'vitest';
import { BuildContractError, canonicalBuildEvidence, checkBuildNativeVersion, matchBuildFiles, parseBuildArtifactInput,
  type BuildArtifactEvidence, type BuildArtifactInput } from '../src/build-manifest.js';

const input: BuildArtifactInput = { repositoryId: 1400000001, fullName: 'example/widget', buildId: 'asset', kind: 'file',
  sourceSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40), version: '1.2.3', packageVersion: '1.2.3', inputsSha256: 'c'.repeat(64),
  platforms: [], outputs: [{ id: 'archive', kind: 'file', match: 'widget-{version}.zip', count: 1, mediaType: 'application/zip' }] };
const image: BuildArtifactInput = { ...input, kind: 'oci-image', platforms: ['linux/amd64'], outputs: [{ id: 'image', kind: 'oci-image', count: 1 }] };
describe('finite artifact source and byte evidence', () => {
  it('exports finite evidence while historical readers remain available only from their module', async () => {
    const api = await import('../src/index.js');
    expect(api.parseBuildArtifactInput).toBe(parseBuildArtifactInput);
    for (const name of ['planBuild', 'buildProfiles', 'assertBuildIdentity', 'canonicalBuildManifest', 'parseBuildManifest']) expect(api).not.toHaveProperty(name);
  });
  it('copies finite data before asynchronous consumers can observe caller changes', () => {
    const original = structuredClone(input), parsed = parseBuildArtifactInput(original);
    original.outputs[0]!.id = 'changed'; original.outputs.length = 0; original.sourceSha = 'd'.repeat(40);
    expect(parsed).toEqual(input);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(input).sort());
  });
  it.each([null, [], true, 1, 'input'])('rejects invalid root %j', value => {
    expect(() => parseBuildArtifactInput(value)).toThrow('RN_BUILD_INVALID');
  });
  it.each(['profile', 'inputs', 'runnerFamily', 'timeoutMinutes', 'command', 'permissions', 'targetSha', 'policySha'])('rejects non-data field %s', field => {
    expect(() => parseBuildArtifactInput({ ...input, [field]: 'legacy' })).toThrow('RN_BUILD_INVALID');
  });
  it.each(['sourceSha', 'controllerSha', 'inputsSha256'].flatMap(field =>
    [undefined, null, 1, new String('a'.repeat(40)), {}, 'short', 'A'.repeat(40), 'a'.repeat(field === 'inputsSha256' ? 64 : 40) + '\n'].map(value => ({ field, value }))))('rejects invalid source digest %j', ({ field, value }) => {
    expect(() => parseBuildArtifactInput({ ...input, [field]: value })).toThrow('RN_BUILD_INVALID');
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects repository id %j', repositoryId => {
    expect(() => parseBuildArtifactInput({ ...input, repositoryId })).toThrow('RN_BUILD_INVALID');
  });
  it.each([['example/widget'], null, true, 1, 'example/widget\n', './widget', 'example/..', 'example//widget'])('rejects repository name %j', fullName => {
    expect(() => parseBuildArtifactInput({ ...input, fullName })).toThrow('RN_BUILD_INVALID');
  });
  it.each(['example/.github', 'example/-widget', 'example/widget.', 'example/widget___part'])('keeps source identity independent of OCI repository mapping %s', fullName => {
    expect(parseBuildArtifactInput({ ...image, fullName }).fullName).toBe(fullName);
    expect(parseBuildArtifactInput({ ...input, fullName }).fullName).toBe(fullName);
  });
  it.each(['version', 'packageVersion'].flatMap(field => [undefined, 1, true, new String('1.2.3'), {}, '', '1.2.3\n', '../x'].map(value => ({ field, value }))))('rejects invalid native version field %j', ({ field, value }) => {
    expect(() => parseBuildArtifactInput({ ...input, [field]: value })).toThrow('RN_BUILD_INVALID');
  });
  it('uses the materialized native package version without a semantic-version projection', () => {
    const source = parseBuildArtifactInput({ ...input, version: '2.0.0-beta.1', packageVersion: '2.0.0.7' });
    expect(() => checkBuildNativeVersion(source, '2.0.0.7')).not.toThrow();
    for (const native of [null, '2.0.0-beta.1', '2.0.0.8']) expect(() => checkBuildNativeVersion(source, native)).toThrow('RN_BUILD_VERSION');
  });
  it('requires paired optional version fields and literal outputs for unversioned evidence', () => {
    for (const field of ['version', 'packageVersion']) expect(() => parseBuildArtifactInput({ ...input, [field]: null })).toThrow('RN_BUILD_INVALID');
    const unversioned = { ...input, version: null, packageVersion: null };
    expect(() => parseBuildArtifactInput(unversioned)).toThrow('RN_BUILD_VERSION');
    const parsed = parseBuildArtifactInput({ ...unversioned, outputs: [{ ...input.outputs[0], match: '*.zip' }] });
    expect(() => checkBuildNativeVersion(parsed, null)).not.toThrow();
  });
  it.each([null, {}, 'outputs', 1, true, [], [null], [[]], [false], ['file'], new Array(1), [input.outputs[0], ,]])('rejects invalid output structure %j', outputs => {
    expect(() => parseBuildArtifactInput({ ...input, outputs })).toThrow('RN_BUILD_OUTPUT');
  });
  it.each([true, null, ['archive'], 'archive\n'])('rejects invalid output id %j', id => {
    expect(() => parseBuildArtifactInput({ ...input, outputs: [{ ...input.outputs[0], id }] })).toThrow('RN_BUILD_OUTPUT');
  });
  it.each([0, 129, 1.1, '1'])('rejects invalid count %j', count => {
    expect(() => parseBuildArtifactInput({ ...input, outputs: [{ ...input.outputs[0], count }] })).toThrow('RN_BUILD_OUTPUT');
  });
  it.each([['application/zip'], null, true, 'application/zip\n'])('rejects media type %j', mediaType => {
    expect(() => parseBuildArtifactInput({ ...input, outputs: [{ ...input.outputs[0], mediaType }] })).toThrow('RN_BUILD_OUTPUT');
  });
  it.each([[], new Array(1), ['linux/amd64', ,], ['linux/amd64', 'linux/amd64'], ['linux/x64'], ['linux/amd64\n']])('rejects invalid OCI platforms %j', platforms => {
    expect(() => parseBuildArtifactInput({ ...image, platforms })).toThrow('RN_BUILD_INVALID');
  });
  it('rejects file platform declarations, mismatched output kind, duplicate ids and expanded count overflow', () => {
    expect(() => parseBuildArtifactInput({ ...input, platforms: ['linux/amd64'] })).toThrow('RN_BUILD_INVALID');
    for (const outputs of [[input.outputs[0], input.outputs[0]], [{ ...input.outputs[0], id: 'asset', count: 2 }, { ...input.outputs[0], id: 'asset-1' }],
      [{ ...input.outputs[0], count: 65 }, { ...input.outputs[0], id: 'second', count: 65 }], image.outputs]) {
      expect(() => parseBuildArtifactInput({ ...input, outputs })).toThrow('RN_BUILD');
    }
    expect(() => parseBuildArtifactInput({ ...image, outputs: [{ ...image.outputs[0], count: 2 }] })).toThrow('RN_BUILD_OUTPUT');
  });
  it.each(['COM{version}.zip', 'LPT{version}.zip', 'nested/COM{version}*.zip'])('rejects device names after version expansion %s', match => {
    expect(() => parseBuildArtifactInput({ ...input, outputs: [{ ...input.outputs[0], match }] })).toThrow('RN_BUILD_PATH');
  });
  it('restricts font archives to a single literal ZIP and validates declared archive type', () => {
    const font = { ...input.outputs[0], match: 'Fonts.zip', archiveType: 'font-archive' };
    expect(parseBuildArtifactInput({ ...input, outputs: [font] }).outputs).toEqual([font]);
    for (const patch of [{ match: '*.zip' }, { count: 2 }, { match: 'Fonts.dll' }, { mediaType: 'application/json' }, { archiveType: 'unknown' }]) {
      expect(() => parseBuildArtifactInput({ ...input, outputs: [{ ...font, ...patch }] })).toThrow('RN_BUILD_OUTPUT');
    }
  });
  it('matches exactly one file and rejects malformed, missing, additional and case-colliding files', () => {
    for (const files of [null, undefined, 1, 'widget-1.2.3.zip', {}, [null], [1], [new String('widget-1.2.3.zip')], new Array(1), ['widget-1.2.3.zip', ,],
      [], ['missing.zip'], ['widget-1.2.3.zip', 'extra.txt'], ['widget-1.2.3.zip', 'WIDGET-1.2.3.zip']]) {
      expect(() => matchBuildFiles(input, files as never)).toThrow(BuildContractError);
    }
    expect(matchBuildFiles(input, ['widget-1.2.3.zip'])).toEqual([{ id: 'archive', file: 'widget-1.2.3.zip', mediaType: 'application/zip' }]);
    expect(matchBuildFiles({ ...input, outputs: [{ ...input.outputs[0]!, match: 'widget-{version}*.zip' }] }, ['widget-1.2.3-linux.zip'])).toHaveLength(1);
  });
  it('sorts expanded ids by filename and rejects overlapping rules', () => {
    expect(matchBuildFiles({ ...input, outputs: [{ ...input.outputs[0]!, match: '*.zip', count: 2 }] }, ['z.zip', 'a.zip'])
      .map(asset => [asset.id, asset.file])).toEqual([['archive-1', 'a.zip'], ['archive-2', 'z.zip']]);
    const outputs = [{ ...input.outputs[0]!, match: '*.zip' }, { ...input.outputs[0]!, id: 'other', match: '*.zip' }];
    expect(() => matchBuildFiles({ ...input, outputs }, ['a.zip'])).toThrow('RN_BUILD_OUTPUT');
  });
  it('canonicalizes only source and byte evidence and rejects foreign or inconsistent fields', () => {
    const { outputs: _outputs, platforms: _platforms, ...source } = input;
    const evidence: BuildArtifactEvidence = { ...source, artifacts: [{ id: 'archive', kind: 'file', file: 'widget.zip', mediaType: 'application/zip', size: 1, sha256: 'd'.repeat(64) }] };
    expect(canonicalBuildEvidence(evidence)).toBe(JSON.stringify(evidence) + '\n');
    expect(() => canonicalBuildEvidence({ ...evidence, profile: 'custom-adapter-v1' } as never)).toThrow('RN_BUILD_INVALID');
    expect(() => canonicalBuildEvidence({ ...evidence, kind: 'oci-image' })).toThrow('RN_BUILD_OUTPUT');
    expect(() => canonicalBuildEvidence({ ...evidence, artifacts: new Array(1) })).toThrow('RN_BUILD_INVALID');
  });
});
