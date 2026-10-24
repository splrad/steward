import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../schema/steward-release.schema.json' with { type: 'json' };
import { assertDeliveryPath } from './delivery-config.js';

export interface ReleaseBuild {
  id: string; os: 'ubuntu' | 'windows' | 'macos'; arch: 'x64' | 'arm64';
  entrypoint: string; args: string[]; expectedArtifacts: string[];
}
export interface ReleaseArtifact {
  id: string; file: string; kind: string; mediaType: string;
  platform: string; architecture: string; build: string; required: true;
}
export interface ReleaseChannel { id: string; kind: string; artifacts: string[]; dependsOn: string[] }
export interface ReleaseUnit {
  id: string; displayName: string; path: string; releasePleasePath: string; ecosystem: string;
  versionFile: string; changelogPath: string; notesPath: string;
  builds: ReleaseBuild[]; artifacts: ReleaseArtifact[]; channels: ReleaseChannel[];
  signingPolicy?: 'none' | 'authenticode' | 'apple-notarized';
}
export interface ReleaseDescriptor { schemaVersion: 1; units: ReleaseUnit[] }
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const fail = (reason: string): never => { throw new Error(`RELEASE_DESCRIPTOR: ${reason}`); };
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`duplicate ${label}`);
}
function repositoryPath(value: string, root = false) {
  try { assertDeliveryPath(value, { root }); } catch { fail(`unsafe path: ${value}`); }
}
const reservedNames = new Set(['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'sha256sums']);

export function artifactNames(unit: ReleaseUnit, version: string, packageVersion = version): Map<string, string> {
  if (![version, packageVersion].every(value => /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value))) fail('unsafe version');
  const names = new Map<string, string>();
  for (const artifact of unit.artifacts) {
    const values: Record<string, string> = { version, packageVersion, unitId: unit.id, os: artifact.platform, arch: artifact.architecture };
    const name = artifact.file.replace(/\$\{([^}]+)\}/g, (_, key: string) => values[key] ?? fail('unknown artifact placeholder'));
    repositoryPath(name);
    if (name.includes('/') || /[ .]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
      || reservedNames.has(name.toLowerCase())) fail('unsafe or reserved artifact name');
    names.set(artifact.id, name);
  }
  unique([...names.values()].map(name => name.toLowerCase()), 'artifact filename');
  return names;
}

/** Validate data and cross references. Filesystem identities are checked by the admission adapter. */
export function parseReleaseDescriptor(input: unknown): ReleaseDescriptor {
  if (!validate(input)) fail(`schema: ${JSON.stringify(validate.errors)}`);
  const descriptor = input as ReleaseDescriptor;
  unique(descriptor.units.map(unit => unit.id), 'unit id');
  unique(descriptor.units.map(unit => unit.releasePleasePath), 'Release Please path');
  unique(descriptor.units.flatMap(unit => [unit.versionFile, unit.changelogPath, unit.notesPath]), 'owned file');
  const graph = new Map<string, string[]>();
  for (const unit of descriptor.units) {
    repositoryPath(unit.path, true); repositoryPath(unit.releasePleasePath, true);
    if (unit.path !== unit.releasePleasePath) fail('unit and Release Please paths differ');
    for (const other of descriptor.units) {
      if (other !== unit && (unit.path === '.' || other.path === unit.path || other.path.startsWith(unit.path + '/'))) fail('overlapping unit paths');
    }
    for (const path of [unit.versionFile, unit.changelogPath, unit.notesPath]) repositoryPath(path);
    if (unit.path !== '.' && [unit.versionFile, unit.changelogPath].some(path => !path.startsWith(unit.path + '/'))) fail('version or changelog outside unit');
    unique(unit.builds.map(build => build.id), 'build id');
    unique(unit.artifacts.map(artifact => artifact.id), 'artifact id');
    unique(unit.channels.map(channel => channel.id), 'channel id');
    for (const build of unit.builds) {
      repositoryPath(build.entrypoint);
      if (!/\.(?:mjs|ps1|sh)$/.test(build.entrypoint) || build.args.some(arg => /[\u0000\r\n]/.test(arg))) fail('unsafe build entrypoint or arguments');
      const expected = unit.artifacts.filter(artifact => artifact.build === build.id).map(artifact => artifact.id).sort();
      if (JSON.stringify(expected) !== JSON.stringify([...build.expectedArtifacts].sort())) fail('build artifact set mismatch');
    }
    for (const artifact of unit.artifacts) {
      if (!unit.builds.some(build => build.id === artifact.build)) fail('unknown artifact producer');
    }
    artifactNames(unit, '1.2.3');
    for (const channel of unit.channels) {
      if (channel.artifacts.some(id => !unit.artifacts.some(artifact => artifact.id === id))) fail('unknown channel artifact');
      graph.set(`${unit.id}/${channel.id}`, channel.dependsOn);
    }
  }
  const active = new Set<string>(), done = new Set<string>();
  function visit(key: string) {
    if (done.has(key)) return;
    if (active.has(key)) fail('channel dependency cycle');
    const edges = graph.get(key) ?? fail('unknown channel dependency');
    active.add(key); for (const edge of edges) visit(edge); active.delete(key); done.add(key);
  }
  for (const key of graph.keys()) visit(key);
  return structuredClone(descriptor);
}

export function assertAdmittedAdapter(unit: ReleaseUnit, validatedAdapters: readonly string[]): void {
  if (!validatedAdapters.includes(unit.ecosystem)) fail(`adapter has not passed admission: ${unit.ecosystem}`);
}
