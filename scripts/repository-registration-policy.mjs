import { Ajv2020 } from 'ajv/dist/2020.js';
import { isDeepStrictEqual } from 'node:util';
import schema from '../schema/repository-registration.schema.json' with { type: 'json' };
import {decodeBuildJson} from '../packages/runner/dist/index.js';

export const registrationPath = /^repositories\/([1-9][0-9]*)\.json$/;
export const registrationWorkflow = '.github/workflows/repository-registration.yml';
export const centralRegistrationWorkflow = '.github/workflows/sync-managed.yml';
export const registrationRunName = 'SPLRAD Steward / Repository Registration';
const validate = new Ajv2020().compile(schema);
const uniqueIds = values => new Set(values.map(({ id }) => id)).size === values.length;

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

export function configurationConflicts(selected,{policy:observed,productCiDeclared,releaseIncomplete}) {
  const conflicts=[];
  const requiresCi=productCiDeclared||observed.productCi.length>0;
  if((requiresCi&&!selected.productCi.length)||selected.productCi.some(path=>!observed.productCi.includes(path)))
    conflicts.push('PRODUCT_CI');
  if(selected.release&&(releaseIncomplete||!isDeepStrictEqual(selected.release,observed.release)))
    conflicts.push('RELEASE');
  return conflicts;
}
