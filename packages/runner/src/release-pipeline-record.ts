import { assertDeliveryPath } from '../../core/src/delivery-config.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import descriptorSchema from '../../../schema/steward-release.schema.json' with { type: 'json' };
import { artifactNames } from '../../core/src/release-descriptor.js';
import type { PipelineRecord } from './release-pipeline.js';
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const version = { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$' };
const properties = {
  repositoryId: id, fullName: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }, releaseId: id, releasePr: id,
  sourceSha: sha, policySha: sha, observationSha: sha, runId: id, attempt: { ...id, maximum: 100 }, mode: { enum: ['build', 'verify'] },
  toolLocks: { type: 'object', minProperties: 1, propertyNames: { pattern: '^[A-Za-z0-9_./-]+$' }, additionalProperties: digest },
  admitted: { type: 'object', additionalProperties: false,
    required: ['unit', 'version', 'packageVersion', 'tag', 'assets', 'descriptorSha256', 'templateSha256'],
    properties: { unit: descriptorSchema.properties.units.items, version, packageVersion: version,
      tag: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]*$' }, descriptorSha256: digest, templateSha256: digest,
      assets: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
};
const validate = new Ajv2020({ allErrors: true, strict: false }).compile({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
/** Job outputs remain bound to the current native run when a failed job is retried. */
export function parsePipelineRecord(input: unknown, environment: NodeJS.ProcessEnv): PipelineRecord {
  if (!validate(input)) throw new Error('RELEASE_RECORD: invalid structure');
  const record = structuredClone(input) as unknown as PipelineRecord;
  const unit = record.admitted.unit;
  assertDeliveryPath(unit.path, { root: true }); assertDeliveryPath(unit.releasePleasePath, { root: true });
  for (const path of [unit.versionFile, unit.changelogPath, unit.notesPath, ...unit.builds.map(build => build.entrypoint)]) assertDeliveryPath(path);
  if (new Set(unit.builds.map(build => build.id)).size !== unit.builds.length || new Set(unit.artifacts.map(asset => asset.id)).size !== unit.artifacts.length) throw new Error('RELEASE_RECORD: duplicate producer or asset');
  for (const build of unit.builds) {
    const expected = unit.artifacts.filter(asset => asset.build === build.id).map(asset => asset.id).sort();
    if (JSON.stringify(expected) !== JSON.stringify([...build.expectedArtifacts].sort())) throw new Error('RELEASE_RECORD: producer mapping');
  }
  if (unit.artifacts.some(asset => !unit.builds.some(build => build.id === asset.build))) throw new Error('RELEASE_RECORD: missing producer');
  const expected = [...artifactNames(record.admitted.unit, record.admitted.version, record.admitted.packageVersion)].map(([id, name]) => ({ id, name }));
  if (JSON.stringify(expected) !== JSON.stringify(record.admitted.assets)) throw new Error('RELEASE_RECORD: artifact mapping');
  for (const [name, value] of Object.entries({ GITHUB_REPOSITORY_ID: String(record.repositoryId), GITHUB_REPOSITORY: record.fullName,
    GITHUB_SHA: record.sourceSha, GITHUB_RUN_ID: String(record.runId), GITHUB_REF: 'refs/tags/' + record.admitted.tag, GITHUB_EVENT_NAME: 'workflow_dispatch' })) {
    if (environment[name] !== value) throw new Error('RELEASE_RECORD: current run mismatch: ' + name);
  }
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  if (!attempt || !/^[1-9][0-9]*$/.test(attempt) || Number(attempt) < record.attempt || Number(attempt) > 100) throw new Error('RELEASE_RECORD: current attempt');
  record.attempt = Number(attempt);
  return record;
}
