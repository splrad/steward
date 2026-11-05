import { describe, expect, it } from 'vitest';
import { assertDeliveryPath, assertDeliveryArtifactMapping, assertDeliveryAssetName } from '../src/delivery-config.js';

it.each(['dist/widget.zip', '部件.zip', 'widget file.zip', '.hidden', 'con.zip', 'widget.', 'widget-*.zip', '*.tgz', 'a'.repeat(201)])('rejects materialized asset name %s', name => {
  expect(() => assertDeliveryAssetName(name)).toThrow('DELIVERY_ASSET_NAME');
});
it.each(['widget-1.2.3.zip', 'widget-1.2.3-rc.1+build.tgz', 'SHA256SUMS'])('accepts portable asset name %s', name => {
  expect(() => assertDeliveryAssetName(name)).not.toThrow();
});
const mapping = () => ({ builds: [{ id: 'windows', expectedArtifacts: ['app', 'fonts'] }, { id: 'linux', expectedArtifacts: ['linux'] }],
  artifacts: [{ id: 'app', build: 'windows' }, { id: 'fonts', build: 'windows' }, { id: 'linux', build: 'linux' }] });
it('validates multiple producers and their complete asset sets without mutation', () => {
  const input = mapping(), before = structuredClone(input);
  input.builds[0]!.expectedArtifacts.reverse(); before.builds[0]!.expectedArtifacts.reverse();
  expect(() => assertDeliveryArtifactMapping(input)).not.toThrow();
  expect(input).toEqual(before);
});
it.each(['duplicate-producer', 'duplicate-asset', 'unknown-producer', 'inherited-key', 'missing-asset', 'missing-reference', 'duplicate-reference', 'empty-producers', 'empty-assets'])('rejects %s in finite producer data', kind => {
  const input = mapping();
  if (kind === 'duplicate-producer') input.builds.push(input.builds[0]!);
  if (kind === 'duplicate-asset') input.artifacts.push(input.artifacts[0]!);
  if (kind === 'unknown-producer') input.artifacts[0]!.build = 'missing';
  if (kind === 'inherited-key') input.artifacts[0]!.build = 'constructor';
  if (kind === 'missing-asset') input.artifacts.pop();
  if (kind === 'missing-reference') input.builds[0]!.expectedArtifacts.pop();
  if (kind === 'duplicate-reference') input.builds[0]!.expectedArtifacts.push('app');
  if (kind === 'empty-producers') input.builds = [];
  if (kind === 'empty-assets') input.artifacts = [];
  expect(() => assertDeliveryArtifactMapping(input)).toThrow('DELIVERY_ARTIFACTS');
});

describe('delivery paths', () => {
  it.each(['../build', '/build', 'C:/build', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\u202eb', 'a\ud800b', 'a\u0000b', 'a/', '', 'a/{other}.zip', '!a.zip'])('rejects %j', value => {
    expect(() => assertDeliveryPath(value, { glob: true, version: true })).toThrow('RN_CONFIG_PATH');
  });
  it('accepts supported globs and the version placeholder', () => {
    expect(() => assertDeliveryPath('assets/**/package-{version}.zip', { glob: true, version: true })).not.toThrow();
    expect(() => assertDeliveryPath('.', { root: true })).not.toThrow();
  });
});
