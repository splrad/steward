import { describe, expect, it } from 'vitest';
import { activeDelivery, assertDeliveryPath, requiresPublicVersion, validateDeliveryConfiguration, type DeliveryConfiguration, type DeliveryRegistry } from '../src/delivery-config.js';

const identity = { id: 42, fullName: 'example/neutral', managed: true };
function fixture(mask = 0): DeliveryConfiguration {
  return {
    builds: { files: { profile: 'node-package-v1', inputs: { directory: '.', lockfile: 'package-lock.json' }, outputs: [{ id: 'package', kind: 'file', match: 'package-{version}.tgz' }] },
      image: { profile: 'oci-image-v1', inputs: { context: '.', dockerfile: 'Dockerfile' }, outputs: [{ id: 'image', kind: 'oci-image' }] } },
    delivery: { githubRelease: mask & 1 ? { enabled: true, state: 'pending', profile: 'neutral', builds: [] } : { enabled: false, state: 'disabled', profile: null, builds: [] },
      deployments: mask & 2 ? [{ id: 'production', state: 'pending', profile: 'cloud-service-v1', builds: ['image'], source: 'commit', trigger: 'default-branch' }] : [],
      packages: mask & 4 ? [{ id: 'container', state: 'pending', profile: 'ghcr-oci-v1', builds: ['image'], publication: 'versioned', trigger: 'version-change' }] : [] },
  };
}
function registry(adapters = false): DeliveryRegistry {
  return { builds: { 'node-package-v1': { kind: 'file' }, 'oci-image-v1': { kind: 'oci-image' } },
    releases: { neutral: { repository: identity, releaseNotes: { profile: 'common-v3' } } }, notes: { 'common-v3': {} },
    deployments: { 'cloud-service-v1': { artifactKind: 'oci-image' } }, packages: { 'ghcr-oci-v1': { artifactKind: 'oci-image' } },
    adapters: adapters ? { builds: ['node-package-v1', 'oci-image-v1'], releases: ['neutral'], deployments: ['cloud-service-v1'], packages: ['ghcr-oci-v1'] } : { builds: [], releases: [], deployments: [], packages: [] },
  };
}
const check = (config: DeliveryConfiguration, available = registry()) => validateDeliveryConfiguration(config, available, identity);

describe('delivery configuration T07', () => {
  it.each(Array.from({ length: 8 }, (_, i) => i))('accepts capability combination %i as pending', mask => {
    const config = fixture(mask);
    expect(() => check(config)).not.toThrow();
    expect(activeDelivery(config)).toEqual({ githubRelease: false, deployments: [], packages: [], requiresVersion: false });
    expect(requiresPublicVersion(config)).toBe(Boolean(mask & 5));
  });
  it.each(Array.from({ length: 8 }, (_, i) => i))('requires an adapter for active combination %i', mask => {
    const config = fixture(mask);
    if (config.delivery.githubRelease.enabled) config.delivery.githubRelease.state = 'active';
    for (const entry of [...config.delivery.packages, ...config.delivery.deployments]) entry.state = 'active';
    if (mask) expect(() => check(config)).toThrow('RN_CONFIG_ADAPTER_UNAVAILABLE');
    expect(() => check(config, registry(true))).not.toThrow();
    expect(activeDelivery(config).requiresVersion).toBe(Boolean(mask & 5));
  });
  it.each(['pending', 'suspended', 'active'] as const)('rejects disabled release with %s state', state => {
    const config = fixture(); config.delivery.githubRelease.state = state;
    expect(() => check(config)).toThrow('RN_CONFIG_DISABLED');
  });
  it('rejects an enabled release with disabled state', () => {
    const config = fixture(1); config.delivery.githubRelease.state = 'disabled';
    expect(() => check(config)).toThrow('RN_CONFIG_STATE');
  });
  it('rejects defaults with delivery or build configuration', () => {
    expect(() => validateDeliveryConfiguration(fixture(), registry())).toThrow('RN_CONFIG_DEFAULTS');
    const config = fixture(); config.builds = {};
    expect(() => validateDeliveryConfiguration(config, registry())).not.toThrow();
  });
  it('rejects delivery on an unmanaged repository', () => {
    expect(() => validateDeliveryConfiguration(fixture(1), registry(), { ...identity, managed: false })).toThrow('RN_CONFIG_UNMANAGED');
  });
  it.each(['build', 'release', 'notes', 'deployment', 'package'])('rejects unknown %s profile', type => {
    const config = fixture(7); const available = registry();
    if (type === 'build') available.builds = {};
    if (type === 'release') available.releases = {};
    if (type === 'notes') available.notes = {};
    if (type === 'deployment') available.deployments = {};
    if (type === 'package') available.packages = {};
    expect(() => check(config, available)).toThrow('RN_CONFIG_PROFILE');
  });
  it('rejects a release profile for another repository', () => {
    const available = registry(); available.releases.neutral!.repository = { ...identity, id: 43 };
    expect(() => check(fixture(1), available)).toThrow('RN_CONFIG_REPOSITORY');
  });
  it('rejects dangling references even while pending', () => {
    const config = fixture(1); config.delivery.githubRelease.builds = ['missing'];
    expect(() => check(config)).toThrow('RN_CONFIG_BUILD_REFERENCE');
  });
  it('rejects inherited object keys as build references', () => {
    const config = fixture(1); config.delivery.githubRelease.builds = ['constructor'];
    expect(() => check(config)).toThrow('RN_CONFIG_BUILD_REFERENCE');
  });
  it('rejects duplicate references', () => {
    const config = fixture(1); config.delivery.githubRelease.builds = ['files', 'files'];
    expect(() => check(config)).toThrow('RN_CONFIG_DUPLICATE_REFERENCE');
  });
  it('rejects duplicate delivery ids across capability types', () => {
    const config = fixture(6); config.delivery.packages[0]!.id = 'production';
    expect(() => check(config)).toThrow('RN_CONFIG_DUPLICATE_ID');
  });
  it('rejects duplicate output ids', () => {
    const config = fixture(); config.builds.files!.outputs.push(config.builds.files!.outputs[0]!);
    expect(() => check(config)).toThrow('RN_CONFIG_DUPLICATE_ID');
  });
  it('rejects OCI artifacts attached to a file release', () => {
    const config = fixture(1); config.delivery.githubRelease.builds = ['image'];
    expect(() => check(config)).toThrow('RN_CONFIG_ARTIFACT_KIND');
  });
  it('rejects file artifacts attached to an OCI package', () => {
    const config = fixture(4); config.delivery.packages[0]!.builds = ['files'];
    expect(() => check(config)).toThrow('RN_CONFIG_ARTIFACT_KIND');
  });
  it('requires a release for a release-sourced deployment', () => {
    const config = fixture(2); Object.assign(config.delivery.deployments[0]!, { source: 'github-release', trigger: 'github-release-published' });
    expect(() => check(config)).toThrow('RN_CONFIG_RELEASE_DEPENDENCY');
    config.delivery.githubRelease = fixture(1).delivery.githubRelease;
    expect(() => check(config)).not.toThrow();
    expect(requiresPublicVersion(config)).toBe(true);
    config.delivery.deployments[0]!.state = 'active';
    expect(() => check(config, registry(true))).toThrow('RN_CONFIG_RELEASE_DEPENDENCY');
  });
  it('uses a commit identity for snapshot packages', () => {
    const config = fixture(4); Object.assign(config.delivery.packages[0]!, { publication: 'snapshot', trigger: 'default-branch' });
    expect(() => check(config)).not.toThrow(); expect(requiresPublicVersion(config)).toBe(false);
  });
  it.each(['deployment', 'package'])('rejects incompatible %s trigger', type => {
    const config = fixture(6);
    if (type === 'deployment') config.delivery.deployments[0]!.trigger = 'version-change';
    else config.delivery.packages[0]!.trigger = 'default-branch';
    expect(() => check(config)).toThrow('RN_CONFIG_TRIGGER');
  });
  it('keeps suspended capabilities out of the active plan', () => {
    const config = fixture(7); config.delivery.githubRelease.state = 'suspended';
    for (const entry of [...config.delivery.packages, ...config.delivery.deployments]) entry.state = 'suspended';
    expect(() => check(config)).not.toThrow(); expect(activeDelivery(config).requiresVersion).toBe(false);
  });
});

describe('delivery paths', () => {
  it.each(['../build', '/build', 'C:/build', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\u202eb', 'a\ud800b', 'a\u0000b', 'a/', '', 'a/{other}.zip', '!a.zip'])('rejects %j', value => {
    expect(() => assertDeliveryPath(value, { glob: true, version: true })).toThrow('RN_CONFIG_PATH');
  });
  it('accepts supported globs and the version placeholder', () => {
    expect(() => assertDeliveryPath('assets/**/package-{version}.zip', { glob: true, version: true })).not.toThrow();
    expect(() => assertDeliveryPath('.', { root: true })).not.toThrow();
  });
  it('limits custom entrypoints to the central tools directory', () => {
    const config = fixture(); config.builds.files!.profile = 'custom-adapter-v1';
    config.builds.files!.inputs = { entrypoint: 'scripts/build.sh' };
    const available = registry(); available.builds['custom-adapter-v1'] = { kind: 'file' };
    expect(() => check(config, available)).toThrow('RN_CONFIG_ENTRYPOINT');
  });
});
