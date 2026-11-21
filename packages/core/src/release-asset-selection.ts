import { Ajv2020 } from 'ajv/dist/2020.js';
import { decodeBuildJson } from './build-manifest.js';
import { type DeliveryConfig, releaseMetadataFiles } from './delivery-config.js';

export interface ReleaseAssetSelection {
  unitId: string;
  artifactIds: string[];
  metadata: (typeof releaseMetadataFiles)[number][];
}

interface FrozenReleaseAssets {
  schemaVersion: 1;
  repositoryId: number;
  cycleId: string;
  deliveryConfigSha: string;
  units: ReleaseAssetSelection[];
}

interface ReleaseAssetSource {
  id: string;
  deliveryConfigSha: string;
  units: readonly {id: string}[];
}

const id = {type:'string', pattern:'^[a-z0-9][a-z0-9-]*$'};
const cyclePattern = 'pr-[1-9][0-9]*-[a-f0-9]{40}';
export const releaseAssetSelectionPath = new RegExp('^evidence/release-assets/(' + cyclePattern + ')\\.json$');
const pathFor = (cycleId: string) => `evidence/release-assets/${cycleId}.json`;
const validate = new Ajv2020().compile({
  type:'object', additionalProperties:false, required:['schemaVersion','repositoryId','cycleId','deliveryConfigSha','units'],
  properties:{
    schemaVersion:{const:1},
    repositoryId:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
    cycleId:{type:'string',pattern:'^'+cyclePattern+'$'},
    deliveryConfigSha:{type:'string',pattern:'^[a-f0-9]{40}$'},
    units:{type:'array',minItems:1,items:{
      type:'object',additionalProperties:false,required:['unitId','artifactIds','metadata'],
      properties:{
        unitId:id,
        artifactIds:{type:'array',minItems:1,uniqueItems:true,items:id},
        metadata:{type:'array',uniqueItems:true,items:{enum:releaseMetadataFiles}},
      },
    }},
  },
});

export function decodeFrozenReleaseAssets(bytes: Uint8Array, repositoryId: number, path: string): FrozenReleaseAssets {
  const value = decodeBuildJson(bytes) as FrozenReleaseAssets;
  if (!validate(value) || value.repositoryId !== repositoryId || path !== pathFor(value.cycleId) ||
    new Set(value.units.map(unit => unit.unitId)).size !== value.units.length)
    throw new Error('RELEASE_ASSET_SELECTION: invalid frozen record');
  return value;
}

export function freezeReleaseAssets(repositoryId: number, cycle: ReleaseAssetSource, approved: ReleaseAssetSelection[]) {
  const units = approved.filter(selection => cycle.units.some(unit => unit.id === selection.unitId));
  if (!units.length) return [];
  const path = pathFor(cycle.id);
  const content = JSON.stringify({schemaVersion:1,repositoryId,cycleId:cycle.id,deliveryConfigSha:cycle.deliveryConfigSha,units}) + '\n';
  decodeFrozenReleaseAssets(new TextEncoder().encode(content),repositoryId,path);
  return [{path,content}];
}

export function applyFrozenReleaseAssets(delivery: DeliveryConfig, repositoryId: number, cycle: ReleaseAssetSource,
  records: readonly {path: string; value: unknown}[]) {
  const path = pathFor(cycle.id), record = records.find(value => value.path === path);
  if (!record) return delivery;
  const frozen = decodeFrozenReleaseAssets(new TextEncoder().encode(JSON.stringify(record.value)),repositoryId,path);
  if (frozen.deliveryConfigSha !== cycle.deliveryConfigSha) throw new Error('RELEASE_ASSET_SELECTION: frozen delivery mismatch');
  const effective = structuredClone(delivery);
  for (const selection of frozen.units) {
    const unit = effective.units.find(unit => unit.id === selection.unitId);
    if (!unit || !cycle.units.some(value => value.id === selection.unitId))
      throw new Error('RELEASE_ASSET_SELECTION: unknown cycle unit');
    // Delivery V1 implicitly enabled GitHub when the channel was omitted.
    if (effective.schemaVersion === 1 && !unit.channels.some(channel => channel.id === 'github-release'))
      unit.channels.push({id:'github-release',required:true,location:'github'});
    const channel = unit.channels.find(channel => channel.id === 'github-release');
    if (!channel?.required ||
      selection.artifactIds.some(id => !(channel.artifactIds ?? unit.assets.map(asset => asset.id)).includes(id)) ||
      selection.metadata.some(name => !(channel.metadata ?? releaseMetadataFiles).includes(name)))
      throw new Error('RELEASE_ASSET_SELECTION: outside frozen delivery');
    Object.assign(channel,{artifactIds:selection.artifactIds,metadata:selection.metadata});
  }
  return effective;
}
