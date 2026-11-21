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
import { defaultBuildWorkflow, isBuildWorkflow, releasePleaseUnitId } from './release-workflow.js';

export interface DeliveryConfig {
  schemaVersion: 1 | 2 | 3;
  buildWorkflow?: string;
  repositoryAuthors: { id: number; evidence: string }[];
  units: DeliveryUnit[];
}
export interface DeliveryUnit {
  id: string; displayName?: string; path: string; notesPath: string;
  buildLocks?: string[];
  assets: { id: string; name: string; description?: string; mediaType: string;
    inspection?: 'pe' | 'dll-zip' | 'font-zip' | 'wheel' | 'sdist' | 'zip' | 'tar-gzip' | 'node-package';
    members?: { path: string; format: 'elf' | 'text' | 'version' }[]; rightsSource?: string }[];
  channels: { id: string; required: boolean; location: string; artifactIds?: string[]; metadata?: string[] }[];
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
export const releaseMetadataFiles = ['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'] as const;

/** Resolve the channel's source-controlled selection against the full frozen inventory. */
export function channelFiles(unit: DeliveryUnit, channelId: string, files: readonly {id: string; path: string}[]): string[] {
  const channel = unit.channels.find(item => item.id === channelId);
  if ((!channel && channelId !== 'github-release') || (channel && !channel.required)) return [];
  const installerName = /\.(?:exe|msi|msix|appx|msixbundle|appxbundle)$/i;
  let ids = channel?.artifactIds;
  if (!ids && channelId === 'winget') {
    const installers = files.filter(file => installerName.test(file.path));
    if (installers.length !== 1) throw new Error('DELIVERY_WINGET_INSTALLER');
    ids = [installers[0]!.id];
  }
  const artifacts = ids ? ids.map(id => {
    const file = files.find(item => item.id === id);
    if (!file) throw new Error('DELIVERY_UNKNOWN_CHANNEL_ARTIFACT');
    return file.path;
  }) : files.map(file => file.path);
  if (channelId === 'winget' && (artifacts.length !== 1 || !installerName.test(artifacts[0]!)))
    throw new Error('DELIVERY_WINGET_INSTALLER');
  return [...artifacts, ...(channel?.metadata ?? (channelId === 'winget' ? [] : releaseMetadataFiles))].sort();
}

/** Finite delivery facts at S. Commands, build recipes and publication policy are not data fields. */
export function parseDeliveryConfig(input: unknown, releasePlease?:{packages?:Record<string,{component?:unknown}>}): DeliveryConfig {
  if (input && typeof input === 'object' && !Array.isArray(input) && [1,2,3].includes((input as { schemaVersion?: number }).schemaVersion ?? 0)) {
    const authors = (input as { repositoryAuthors?: unknown }).repositoryAuthors;
    if (!Array.isArray(authors) || !authors.length || authors.some(author => author && typeof author === 'object'
      && (typeof author.evidence !== 'string' || !author.evidence.trim()))) throw new Error('AUTHOR_IDENTITY_UNVERIFIED');
  }
  if (!validateDelivery(input)) throw new Error('DELIVERY_CONFIG_STRUCTURE');
  const value = structuredClone(input) as unknown as DeliveryConfig & {notes?:Record<string,string>};
  if (value.buildWorkflow !== undefined && !isBuildWorkflow(value.buildWorkflow)) throw new Error('DELIVERY_BUILD_WORKFLOW');
  if(value.schemaVersion===3) {
    const packages=releasePlease?.packages;
    const paths=packages&&typeof packages==='object'&&!Array.isArray(packages)?Object.keys(packages):[];
    if(!paths.length||paths.length>128||Object.keys(value.notes??{}).some(path=>!Object.hasOwn(packages!,path)))
      throw new Error('DELIVERY_RELEASE_PLEASE_UNITS');
    if(value.repositoryAuthors.some(author=>/^(?:https:\/\/github\.com\/[^ /?#]+|https:\/\/api\.github\.com\/users\/[^ /?#]+)\/?$/i.test(author.evidence.trim())))
      throw new Error('AUTHOR_IDENTITY_UNVERIFIED');
    value.buildWorkflow??=defaultBuildWorkflow;
    value.units=paths.sort().map(path=>{
      const item=packages![path];
      if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('DELIVERY_RELEASE_PLEASE_UNITS');
      const id=releasePleaseUnitId(path,item.component);
      const notesPath=(value.notes&&Object.hasOwn(value.notes,path)?value.notes[path]:undefined)??'.release-notes/'+id+'.md';
      return {id,path,notesPath,assets:[],buildLocks:[],channels:[]};
    });
    delete value.notes;
  }
  const unique = (values: unknown[]) => new Set(values).size === values.length;
  if (!unique(value.units.map(unit => unit.id)) || !unique(value.units.map(unit => unit.path.toLowerCase()))
    || !unique(value.repositoryAuthors.map(author => author.id)) || value.repositoryAuthors.some(author => !author.evidence.trim()))
    throw new Error('DELIVERY_DUPLICATE_IDENTITY');
  const paths=value.units.map(unit=>unit.path.toLowerCase());
  if(value.schemaVersion===3) {
    if(!unique(value.units.map(unit=>unit.notesPath.toLowerCase())))throw new Error('DELIVERY_DUPLICATE_NOTES_PATH');
  } else if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&(path==='.'||other.startsWith(path+'/')))))throw new Error('DELIVERY_NESTED_UNIT_PATH');
  for (const unit of value.units) {
    // Version 1 implicitly published the entire seal to GitHub. In version 2 omission disables it.
    if (value.schemaVersion === 2 && !unit.channels.some(channel => channel.id === 'github-release'))
      unit.channels.push({id:'github-release',required:false,location:'github'});
    assertDeliveryPath(unit.path, { root: true }); assertDeliveryPath(unit.notesPath);
    if ([unit.path, unit.notesPath].some(path => path.split('/').some(part => part.toLowerCase() === '.git')))
      throw new Error('DELIVERY_GIT_PATH');
    if (!unique(unit.channels.map(channel => channel.id)) || !unique(unit.assets.map(asset => asset.id))) throw new Error('DELIVERY_DUPLICATE_IDENTITY');
    if (unit.buildLocks && !unique(unit.buildLocks.map(path => path.toLowerCase()))) throw new Error('DELIVERY_DUPLICATE_LOCK');
    for (const path of unit.buildLocks ?? []) assertDeliveryPath(path);
    for (const asset of unit.assets) {
      if (asset.rightsSource) assertDeliveryPath(asset.rightsSource);
      const generic = asset.inspection === 'zip' || asset.inspection === 'tar-gzip';
      if (!generic && asset.members) throw new Error('DELIVERY_ARCHIVE_MEMBERS');
      if (asset.members) {
        if (!unique(asset.members.map(member => member.path.toLowerCase()))) throw new Error('DELIVERY_ARCHIVE_MEMBERS');
        for (const member of asset.members) assertDeliveryPath(member.path);
      }
      if (generic && !asset.members?.some(member => member.format === 'version') && !/\$\{(?:packageVersion|version)\}/.test(asset.name))
        throw new Error('DELIVERY_ARCHIVE_VERSION');
      if (asset.inspection) {
        const formats = {
          pe: [/\.(?:dll|exe)$/i, ['application/octet-stream', 'application/vnd.microsoft.portable-executable']],
          'dll-zip': [/\.zip$/i, ['application/zip']], 'font-zip': [/\.zip$/i, ['application/zip']],
          zip: [/\.zip$/i, ['application/zip']], wheel: [/\.whl$/, ['application/zip']],
          sdist: [/\.tar\.gz$/, ['application/gzip']], 'tar-gzip': [/\.tar\.gz$/, ['application/gzip']],
          'node-package': [/^package\.json$/, ['application/json']],
        } as const;
        const [name, types] = formats[asset.inspection];
        if (!name.test(asset.name) || !(types as readonly string[]).includes(asset.mediaType)) throw new Error('DELIVERY_INSPECTION_FORMAT');
      }
      const literal = asset.name.replaceAll('${version}', '1.2.3').replaceAll('${packageVersion}', '1.2.3rc1');
      assertDeliveryAssetName(literal);
    }
    for (const channel of unit.channels) {
      if (value.schemaVersion === 2) channel.metadata ??= [];
      if (channel.artifactIds?.some(id => !unit.assets.some(asset => asset.id === id)))
        throw new Error('DELIVERY_UNKNOWN_CHANNEL_ARTIFACT');
      if (channel.id === 'winget' && (channel.artifactIds && channel.artifactIds.length !== 1 || channel.metadata?.length))
        throw new Error('DELIVERY_WINGET_INSTALLER');
    }
    deliveryAssetNames(unit, '1.2.3', '1.2.3rc1');
  }
  return value;
}
