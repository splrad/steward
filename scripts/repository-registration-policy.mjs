import { Ajv2020 } from 'ajv/dist/2020.js';
import { isDeepStrictEqual } from 'node:util';
import schema from '../schema/repository-registration.schema.json' with { type: 'json' };
import {decodeBuildJson,parseDeliveryConfig} from '../packages/runner/dist/index.js';
import {effectiveChannels,publishPath} from './configuration-view.mjs';

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

export function configurationConflicts(selected,{policy:observed,productCiApplicable,releaseIncomplete}) {
  const conflicts=[];
  const requiresCi=productCiApplicable||observed.productCi.length>0;
  if((requiresCi&&!selected.productCi.length)||selected.productCi.some(path=>!observed.productCi.includes(path)))
    conflicts.push('PRODUCT_CI');
  if(selected.release&&(releaseIncomplete||!isDeepStrictEqual(selected.release,observed.release)))
    conflicts.push('RELEASE');
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
