import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import schema from '../../../schema/repositories.schema.json' with { type: 'json' };
const ajv = new Ajv2020({ allErrors: true, strict: false }); (addFormats as unknown as FormatsPlugin)(ajv);
const validate = ajv.compile(schema);
export interface ChannelPolicy {
  enabled: boolean; kind: string; destination: string; packageName: string; visibility: 'public' | 'private'; environment: string; authMode: string;
  distTagStable?: string; distTagPrerelease?: string; nugetUser?: string; artifactType?: string; platforms?: string[]; packageIdentifier?: string; forkRepository?: string | null;
}
export interface UnitPolicy { enabled: boolean; adoptedAfterTag: string | null; adoptedFromSha: string | null; channels: Record<string, ChannelPolicy> }
export interface RepositoryPolicy {
  repositoryId: number; fullName: string; defaultBranch: string; managed: boolean;
  automation: { managedSync: { enabled: boolean; policySha: string | null }; dependencyUpdates: { enabled: boolean } };
  release: { enabled: boolean; units: Record<string, UnitPolicy> }; pages: { enabled: boolean }; revokedPolicyShas: string[];
  [key: string]: unknown;
}
export interface RepositoryCatalog { schemaVersion: 5; repositories: Record<string, RepositoryPolicy>; defaults: { public: RepositoryPolicy; private: RepositoryPolicy }; organization: { id: number; login: string } }
function fail(reason: string): never { throw new Error(`REPOSITORY_POLICY: ${reason}`); }
export function parseRepositoryCatalog(input: unknown): RepositoryCatalog {
  if (!validate(input)) fail(`schema: ${ajv.errorsText(validate.errors)}`);
  const catalog = structuredClone(input) as unknown as RepositoryCatalog;
  const names = new Set<string>();
  for (const [id, repository] of Object.entries(catalog.repositories)) {
    if (String(repository.repositoryId) !== id || names.has(repository.fullName.toLowerCase())) fail('repository ID/name mapping');
    names.add(repository.fullName.toLowerCase());
  }
  for (const repository of [...Object.values(catalog.repositories), ...Object.values(catalog.defaults)]) {
    const sync = repository.automation.managedSync;
    if (sync.enabled && (!repository.managed || !sync.policySha || repository.revokedPolicyShas.includes(sync.policySha))) fail('sync policy');
    if (!repository.managed && (repository.release.enabled || repository.pages.enabled || repository.automation.dependencyUpdates.enabled)) fail('unmanaged capability');
    if (repository.release.enabled && !Object.values(repository.release.units).some(unit => unit.enabled)) fail('no enabled release unit');
    for (const unit of Object.values(repository.release.units)) {
      if (unit.adoptedAfterTag && unit.adoptedFromSha || unit.enabled && Boolean(unit.adoptedAfterTag) === Boolean(unit.adoptedFromSha)) fail('adoption boundary');
      if (unit.enabled && !repository.release.enabled) fail('unit without repository capability');
      if (unit.adoptedAfterTag && (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(unit.adoptedAfterTag) || unit.adoptedAfterTag.includes('..'))) fail('unsafe adopted tag');
      for (const channel of Object.values(unit.channels)) {
        if (channel.enabled && !unit.enabled) fail('channel without unit capability');
        const extra: Record<string, string[]> = { npm: ['distTagStable', 'distTagPrerelease'], nuget: ['nugetUser'], pypi: [],
          'oci-image': ['platforms'], 'oci-artifact': ['artifactType'], helm: [], winget: ['packageIdentifier', 'forkRepository'] };
        const common = ['enabled', 'kind', 'destination', 'packageName', 'visibility', 'environment', 'authMode'];
        const fields = extra[channel.kind];
        if (!fields || Object.keys(channel).sort().join(',') !== [...common, ...fields].sort().join(',')) fail('channel fields');
        if (['oci-image', 'oci-artifact', 'helm'].includes(channel.kind)) {
          if (!/^ghcr\.io\/splrad\/[a-z0-9][a-z0-9._/-]*$/.test(channel.destination) || channel.destination.includes('..') || channel.authMode !== 'github-token') fail('GHCR destination');
        } else if (channel.kind === 'winget') {
          if (channel.destination !== 'microsoft/winget-pkgs' || channel.authMode !== 'owner-fork' || channel.enabled && !channel.forkRepository) fail('WinGet destination');
        } else {
          const destinations: Record<string, string> = { npm: 'https://registry.npmjs.org', nuget: 'https://api.nuget.org/v3/index.json', pypi: 'https://upload.pypi.org/legacy/' };
          if (channel.destination !== destinations[channel.kind] || channel.authMode !== 'oidc') fail('registry destination');
        }
      }
    }
  }
  return catalog;
}
export function releaseWriteAuthority(catalog: RepositoryCatalog, repositoryId: number, fullName: string, unitId: string, policySha: string) {
  const repository = catalog.repositories[String(repositoryId)];
  if (!repository || repository.fullName !== fullName) fail('repository identity');
  if (!/^[a-f0-9]{40}$/.test(policySha) || repository.revokedPolicyShas.includes(policySha)) fail('revoked or invalid policy');
  const unit = repository.release.units[unitId];
  if (!repository.managed || !repository.release.enabled || !unit?.enabled) fail('release not enabled');
  return { repository, unit };
}
