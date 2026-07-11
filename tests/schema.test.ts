import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(await readFile(new URL('../schema/steward.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('Steward manifest schema bootstrap', () => {
  it('accepts the supported schema version', () => {
    expect(validate({ schemaVersion: 1 })).toBe(true);
  });

  it('rejects missing and unknown schema versions', () => {
    expect(validate({})).toBe(false);
    expect(validate({ schemaVersion: 2 })).toBe(false);
  });
});
