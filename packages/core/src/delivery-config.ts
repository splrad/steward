export function assertDeliveryPath(value: string, options: { glob?: boolean; root?: boolean; version?: boolean } = {}): void {
  if (options.root && value === '.') return;
  const normalized = options.version ? value.replaceAll('{version}', '1.0.0') : value;
  if (!normalized || normalized.startsWith('/') || /[\\:\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/u.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')
    || (options.glob ? /[!{}()[\]]/u.test(normalized) || normalized.split('/').some(part => part.includes('**') && part !== '**') : /[*!?{}()[\]]/u.test(normalized))) {
    throw new Error('RN_CONFIG_PATH');
  }
}

/** A materialized artifact filename, suitable for both Windows and Linux. */
export function assertDeliveryAssetName(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(value) || /[. ]$/.test(value)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error('DELIVERY_ASSET_NAME');
}


/** Finite producer/asset references shared by delivery data and historical readers. */
export function assertDeliveryArtifactMapping(unit: {
  builds: readonly { id: string; expectedArtifacts: readonly string[] }[];
  artifacts: readonly { id: string; build: string }[];
}): void {
  if (!unit.builds.length || !unit.artifacts.length
    || new Set(unit.builds.map(build => build.id)).size !== unit.builds.length
    || new Set(unit.artifacts.map(asset => asset.id)).size !== unit.artifacts.length) throw new Error('DELIVERY_ARTIFACTS: duplicate or empty producer/asset set');
  for (const build of unit.builds) {
    const expected = unit.artifacts.filter(asset => asset.build === build.id).map(asset => asset.id).sort();
    if (!expected.length || JSON.stringify(expected) !== JSON.stringify([...build.expectedArtifacts].sort())) throw new Error('DELIVERY_ARTIFACTS: producer mapping');
  }
  if (unit.artifacts.some(asset => !unit.builds.some(build => build.id === asset.build))) throw new Error('DELIVERY_ARTIFACTS: missing producer');
}
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../schema/delivery.schema.json' with { type: 'json' };

export interface DeliveryConfig {
  schemaVersion: 1;
  repositoryAuthors: { id: number; evidence: string }[];
  units: DeliveryUnit[];
}
export interface DeliveryUnit {
  id: string; path: string; notesPath: string;
  assets: { id: string; name: string; mediaType: string }[];
  channels: { id: string; required: boolean; location: string }[];
}
const validateDelivery = new Ajv2020({ strict: true }).compile(schema);
const reservedAssets = new Set(['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'sha256sums']);
export function deliveryAssetNames(unit: DeliveryUnit, version: string, packageVersion: string): Map<string, string> {
  const names = new Map<string, string>(), seen = new Set<string>();
  for (const asset of unit.assets) {
    const name = asset.name.replaceAll('${version}', version).replaceAll('${packageVersion}', packageVersion);
    assertDeliveryAssetName(name);
    if (names.has(asset.id) || seen.has(name.toLowerCase()) || reservedAssets.has(name.toLowerCase())) throw new Error('DELIVERY_ASSET_SET');
    names.set(asset.id, name); seen.add(name.toLowerCase());
  }
  return names;
}
/** Finite delivery facts at S. Commands, build recipes and publication policy are not data fields. */
export function parseDeliveryConfig(input: unknown): DeliveryConfig {
  if (input && typeof input === 'object' && !Array.isArray(input) && (input as { schemaVersion?: unknown }).schemaVersion === 1) {
    const authors = (input as { repositoryAuthors?: unknown }).repositoryAuthors;
    if (!Array.isArray(authors) || !authors.length || authors.some(author => author && typeof author === 'object'
      && (typeof author.evidence !== 'string' || !author.evidence.trim()))) throw new Error('AUTHOR_IDENTITY_UNVERIFIED');
  }
  if (!validateDelivery(input)) throw new Error('DELIVERY_CONFIG_STRUCTURE');
  const value = structuredClone(input) as unknown as DeliveryConfig;
  const unique = (values: unknown[]) => new Set(values).size === values.length;
  if (!unique(value.units.map(unit => unit.id)) || !unique(value.units.map(unit => unit.path.toLowerCase()))
    || !unique(value.repositoryAuthors.map(author => author.id)) || value.repositoryAuthors.some(author => !author.evidence.trim()))
    throw new Error('DELIVERY_DUPLICATE_IDENTITY');
  const paths=value.units.map(unit=>unit.path.toLowerCase());
  if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&(path==='.'||other.startsWith(path+'/')))))throw new Error('DELIVERY_NESTED_UNIT_PATH');
  for (const unit of value.units) {
    assertDeliveryPath(unit.path, { root: true }); assertDeliveryPath(unit.notesPath);
    if ([unit.path, unit.notesPath].some(path => path.split('/').some(part => part.toLowerCase() === '.git')))
      throw new Error('DELIVERY_GIT_PATH');
    if (!unique(unit.channels.map(channel => channel.id)) || !unique(unit.assets.map(asset => asset.id))) throw new Error('DELIVERY_DUPLICATE_IDENTITY');
    for (const asset of unit.assets) {
      const literal = asset.name.replaceAll('${version}', '1.2.3').replaceAll('${packageVersion}', '1.2.3rc1');
      assertDeliveryAssetName(literal);
    }
    deliveryAssetNames(unit, '1.2.3', '1.2.3rc1');
  }
  return value;
}
