import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../schema/repository-registration.schema.json' with { type: 'json' };
import {decodeBuildJson,parseDeliveryConfig} from '../packages/runner/dist/index.js';
import {channelWorkflowPath,effectiveChannels,inspectRepository,publishPath} from './configuration-view.mjs';

export const registrationPath = /^repositories\/([1-9][0-9]*)\.json$/;
export const registrationWorkflow = '.github/workflows/repository-registration.yml';
export const centralRegistrationWorkflow = '.github/workflows/sync-managed.yml';
export const registrationRunName = 'SPLRAD Steward / Repository Registration';
const validate = new Ajv2020().compile(schema);
const uniqueIds = values => new Set(values.map(({ id }) => id)).size === values.length;
const metadataFiles = ['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'];

export function checkedRegistration(value, id) {
  if (!Number.isSafeInteger(id) || id < 1 || !validate(value) || value.repositoryId !== id ||
    value.release && (!uniqueIds(value.release.units) || value.release.units.some(unit => !uniqueIds(unit.channels))) ||
    value.site?.source === 'release' && !value.release?.units.some(unit => unit.id === value.site.unit))
    throw Error('Invalid central repository registration');
  return value;
}

export function parseRegistration(bytes,id) {
  return checkedRegistration(decodeBuildJson(typeof bytes==='string'?Buffer.from(bytes):bytes),id);
}

// An empty result is the native selection. Null means the approval is incompatible.
export function releaseAssetSelections(selected, observed) {
  if (!selected || !observed) return selected === observed ? [] : null;
  if (selected.buildWorkflow !== observed.buildWorkflow || selected.units.length !== observed.units.length) return null;
  const selections = [];
  for (const unit of selected.units) {
    const nativeUnit = observed.units.find(value => value.id === unit.id);
    if (!nativeUnit || unit.channels.length !== nativeUnit.channels.length) return null;
    for (const channel of unit.channels) {
      const native = nativeUnit.channels.find(value => value.id === channel.id);
      if (!native || channel.required !== native.required || channel.location !== native.location ||
        channel.artifactIds.some(id => !native.artifactIds.includes(id)) ||
        channel.metadata.some(name => !native.metadata.includes(name))) return null;
      if (channel.artifactIds.length === native.artifactIds.length && channel.metadata.length === native.metadata.length) continue;
      if (channel.id !== 'github-release' || !channel.required || !channel.artifactIds.length) return null;
      selections.push({unitId:unit.id, artifactIds:[...channel.artifactIds].sort(), metadata:[...channel.metadata].sort()});
    }
  }
  return selections.sort((a,b) => a.unitId.localeCompare(b.unitId));
}

async function readChannelController(ref) {
  const response=await fetch(`https://raw.githubusercontent.com/splrad/steward/${ref}/packages/runner/src/release-pipeline.ts`,
    {redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(response.status===404)return '';
  if(!response.ok)throw Error('RELEASE_CHANNEL_CONTROLLER_UNAVAILABLE');
  return response.text();
}

export async function releaseAssetConsumerConflicts(selections, native, site, {read,assetCount,controller=readChannelController}) {
  const conflicts=[];
  if(selections.some(unit=>site?.source==='release' && site.unit===unit.unitId))
    conflicts.push('PAGES_RELEASE_SOURCE');
  let consumer;
  for(const selection of selections) {
    const channels=native.units.find(unit=>unit.id===selection.unitId).channels;
    const downstream=channels.filter(channel=>channel.id!=='github-release'&&channel.required);
    if(!downstream.length)continue;
    if(!consumer) {
      const source=await read?.(channelWorkflowPath);
      const workflow=source&&inspectRepository(new Map([[channelWorkflowPath,source]])).workflows[0]?.document;
      const refs=[...new Set(Object.values(workflow?.jobs??{}).flatMap(job=>(job?.steps??[]))
        .filter(step=>step?.with?.repository==='splrad/steward'&&step.with.path==='controller')
        .map(step=>step.with.ref))];
      consumer=refs.length&&refs.every(ref=>typeof ref==='string'&&/^[a-f0-9]{40}$/.test(ref))
        ?await Promise.all(refs.map(controller)):[];
    }
    if(consumer.length&&consumer.every(source=>source.includes('applyFrozenReleaseAssets(delivery,context.repositoryId')))continue;
    const github=channels.find(channel=>channel.id==='github-release');
    const nativePartial=github.metadata.length!==metadataFiles.length || github.artifactIds.length<assetCount(selection.unitId);
    const directFiles=downstream.every(channel=>channel.artifactIds.every(id=>selection.artifactIds.includes(id)) &&
      channel.metadata.every(name=>selection.metadata.includes(name)));
    // The older partial-Release reader can still use the channel's own files
    // directly, provided the original source already activated that path.
    if(!nativePartial || !directFiles || !consumer.length ||
      !consumer.every(source=>source.includes('publicSelection=channelFiles(source.unit,target.channelId,inventory)')))
      return [...conflicts,'RELEASE_CHANNEL_SOURCE'];
  }
  return conflicts;
}

export async function configurationConflicts(selected,{policy:observed,productCiApplicable,releaseIncomplete,releaseDetails,readProductFile}) {
  const conflicts=[];
  const requiresCi=productCiApplicable||observed.productCi.length>0;
  if((requiresCi&&!selected.productCi.length)||selected.productCi.some(path=>!observed.productCi.includes(path)))
    conflicts.push('PRODUCT_CI');
  if(selected.release) {
    const selections=releaseAssetSelections(selected.release,observed.release);
    if(releaseIncomplete||selections===null)conflicts.push('RELEASE');
    else conflicts.push(...await releaseAssetConsumerConflicts(selections,observed.release,selected.site,
      {read:readProductFile,assetCount:unit=>releaseDetails?.get(unit)?.assets.size??Infinity}));
  }
  return conflicts;
}

export function releaseRegistration(model, pending) {
  let release = null;
  if (model.delivery) {
    const delivery = parseDeliveryConfig(model.delivery);
    const matrix = model.publish?.jobs?.build?.strategy?.matrix?.include;
    const units = [];
    for (const unit of delivery.units) {
      if (!model.versions?.packages?.[unit.path] || !Array.isArray(matrix) ||
        !matrix.some(row => row?.unit === unit.id && typeof row.target === 'string' && row.target)) {
        pending.push('确认发行单元和构建入口 ' + unit.id);
        continue;
      }
      const channels = [];
      for (const channel of effectiveChannels(delivery, unit)) {
        let artifactIds = channel.artifactIds;
        if (!artifactIds && channel.id === 'winget') {
          const installers = unit.assets.filter(asset => /\.(?:exe|msi|msix|appx|msixbundle|appxbundle)$/i.test(asset.name));
          if (installers.length !== 1) {
            pending.push('确认 WinGet 安装文件 ' + unit.id);
            continue;
          }
          artifactIds = [installers[0].id];
        }
        channels.push({ ...channel, artifactIds: artifactIds ?? unit.assets.map(asset => asset.id),
          metadata: channel.metadata ?? (channel.id === 'winget' ? [] : metadataFiles) });
      }
      units.push({ id: unit.id, channels });
    }
    if (units.length) release = { buildWorkflow: publishPath, units };
  }
  return release;
}
