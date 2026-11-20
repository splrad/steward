import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../schema/repository-registration.schema.json' with { type: 'json' };

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
