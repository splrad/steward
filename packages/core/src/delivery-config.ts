export type CapabilityState = 'disabled' | 'pending' | 'active' | 'suspended';
export interface DeliveryEntry { id: string; profile: string; state: CapabilityState; builds: string[] }
export interface DeliveryConfiguration {
  builds: Record<string, { profile: string; inputs: Record<string, unknown>; outputs: { id: string; kind: string; match?: string }[] }>;
  delivery: {
    githubRelease: { enabled: boolean; state: CapabilityState; profile: string | null; builds: string[] };
    deployments: (DeliveryEntry & { source: 'commit' | 'github-release'; trigger: string })[];
    packages: (DeliveryEntry & { publication: 'versioned' | 'snapshot'; trigger: string })[];
  };
}
export interface DeliveryRegistry {
  builds: Record<string, { kind: string }>;
  releases: Record<string, { repository: { id: number; fullName: string }; releaseNotes: { profile: string } }>;
  notes: Record<string, unknown>;
  deployments: Record<string, { artifactKind: string }>;
  packages: Record<string, { artifactKind: string }>;
  adapters: { builds: readonly string[]; releases: readonly string[]; deployments: readonly string[]; packages: readonly string[] };
}

export function assertDeliveryPath(value: string, options: { glob?: boolean; root?: boolean; version?: boolean } = {}): void {
  if (options.root && value === '.') return;
  const normalized = options.version ? value.replaceAll('{version}', '1.0.0') : value;
  if (!normalized || normalized.startsWith('/') || /[\\:\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/u.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')
    || (options.glob ? /[!{}()[\]]/u.test(normalized) || normalized.split('/').some(part => part.includes('**') && part !== '**') : /[*!?{}()[\]]/u.test(normalized))) {
    throw new Error('RN_CONFIG_PATH');
  }
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function validateDeliveryConfiguration(
  configuration: DeliveryConfiguration,
  registry: DeliveryRegistry,
  repository?: { id: number; fullName: string; managed: boolean },
): void {
  const { builds, delivery } = configuration;
  const release = delivery.githubRelease;
  if (!release.enabled && (release.state !== 'disabled' || release.profile !== null || release.builds.length)) throw new Error('RN_CONFIG_DISABLED');
  if (release.enabled && (release.state === 'disabled' || !release.profile)) throw new Error('RN_CONFIG_STATE');
  const entries = [...delivery.deployments, ...delivery.packages];
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('RN_CONFIG_DUPLICATE_ID');
  if (!repository && (Object.keys(builds).length || release.enabled || entries.length)) throw new Error('RN_CONFIG_DEFAULTS');
  if (repository && !repository.managed && (release.enabled || entries.some(entry => entry.state !== 'disabled'))) throw new Error('RN_CONFIG_UNMANAGED');
  for (const unit of Object.values(builds)) {
    const profile = own(registry.builds, unit.profile);
    if (!profile) throw new Error('RN_CONFIG_PROFILE');
    const outputIds = unit.outputs.map(output => output.id);
    if (new Set(outputIds).size !== outputIds.length) throw new Error('RN_CONFIG_DUPLICATE_ID');
    for (const output of unit.outputs) {
      if (output.kind !== profile.kind) throw new Error('RN_CONFIG_ARTIFACT_KIND');
      if (output.match !== undefined) assertDeliveryPath(output.match, { glob: true, version: true });
    }
    for (const field of ['project', 'directory', 'lockfile', 'context', 'dockerfile', 'entrypoint']) {
      const value = unit.inputs[field];
      if (typeof value === 'string') assertDeliveryPath(value, { root: ['context', 'directory'].includes(field) });
    }
    if (unit.profile === 'custom-adapter-v1' && !String(unit.inputs.entrypoint).startsWith('tools/')) throw new Error('RN_CONFIG_ENTRYPOINT');
  }
  function checkBuilds(ids: string[], active: boolean, kind?: string): void {
    if (new Set(ids).size !== ids.length) throw new Error('RN_CONFIG_DUPLICATE_REFERENCE');
    for (const id of ids) {
      const build = own(builds, id);
      if (!build) throw new Error('RN_CONFIG_BUILD_REFERENCE');
      if (kind !== undefined && own(registry.builds, build.profile)?.kind !== kind) throw new Error('RN_CONFIG_ARTIFACT_KIND');
      if (active && !registry.adapters.builds.includes(build.profile)) throw new Error('RN_CONFIG_ADAPTER_UNAVAILABLE');
    }
  }
  if (release.enabled) {
    const profile = own(registry.releases, release.profile!);
    if (!profile || !own(registry.notes, profile.releaseNotes.profile)) throw new Error('RN_CONFIG_PROFILE');
    if (!repository || profile.repository.id !== repository.id || profile.repository.fullName !== repository.fullName) throw new Error('RN_CONFIG_REPOSITORY');
    if (release.state === 'active' && !registry.adapters.releases.includes(release.profile!)) throw new Error('RN_CONFIG_ADAPTER_UNAVAILABLE');
    checkBuilds(release.builds, release.state === 'active', 'file');
  }
  for (const entry of delivery.deployments) {
    const profile = own(registry.deployments, entry.profile);
    if (!profile) throw new Error('RN_CONFIG_PROFILE');
    if (entry.source === 'github-release' && (!release.enabled || (entry.state === 'active' && release.state !== 'active'))) throw new Error('RN_CONFIG_RELEASE_DEPENDENCY');
    if ((entry.source === 'commit' ? 'default-branch' : 'github-release-published') !== entry.trigger) throw new Error('RN_CONFIG_TRIGGER');
    if (entry.state === 'active' && !registry.adapters.deployments.includes(entry.profile)) throw new Error('RN_CONFIG_ADAPTER_UNAVAILABLE');
    checkBuilds(entry.builds, entry.state === 'active', profile.artifactKind);
  }
  for (const entry of delivery.packages) {
    const profile = own(registry.packages, entry.profile);
    if (!profile) throw new Error('RN_CONFIG_PROFILE');
    if ((entry.publication === 'versioned' ? 'version-change' : 'default-branch') !== entry.trigger) throw new Error('RN_CONFIG_TRIGGER');
    if (entry.state === 'active' && !registry.adapters.packages.includes(entry.profile)) throw new Error('RN_CONFIG_ADAPTER_UNAVAILABLE');
    checkBuilds(entry.builds, entry.state === 'active', profile.artifactKind);
  }
}

export function requiresPublicVersion(configuration: DeliveryConfiguration): boolean {
  return configuration.delivery.githubRelease.enabled
    || configuration.delivery.packages.some(entry => entry.state !== 'disabled' && entry.publication === 'versioned')
    || configuration.delivery.deployments.some(entry => entry.state !== 'disabled' && entry.source === 'github-release');
}

export function activeDelivery(configuration: DeliveryConfiguration): {
  githubRelease: boolean; deployments: string[]; packages: string[]; requiresVersion: boolean;
} {
  const githubRelease = configuration.delivery.githubRelease.enabled && configuration.delivery.githubRelease.state === 'active';
  const deployments = configuration.delivery.deployments.filter(entry => entry.state === 'active');
  const packages = configuration.delivery.packages.filter(entry => entry.state === 'active');
  return { githubRelease, deployments: deployments.map(entry => entry.id), packages: packages.map(entry => entry.id),
    requiresVersion: githubRelease || deployments.some(entry => entry.source === 'github-release') || packages.some(entry => entry.publication === 'versioned') };
}
