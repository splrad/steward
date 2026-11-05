import { assertDeliveryArtifactMapping, assertDeliveryPath } from '../../core/src/delivery-config.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { artifactNames, parseReleaseDescriptor, type ReleaseUnit } from '../../core/src/release-descriptor.js';
import { parseDeliveryConfig, deliveryAssetNames, type DeliveryConfig } from '../../core/src/delivery-config.js';
import deliverySchema from '../../../schema/delivery.schema.json' with { type: 'json' };
import { selectReleaseContributors, type ReleaseContributor } from '../../core/src/release-candidate.js';

/** Historical job output for the E06 publication handoff and read-only decoding. */
export interface HistoricalPipelineRecord {
  repositoryId: number; fullName: string; releaseId: number; releasePr: number; sourceSha: string; policySha: string;
  observationSha: string; runId: number; attempt: number; mode: 'build' | 'verify'; admitted: { unit: ReleaseUnit; version: string; packageVersion: string; tag: string; assets: { id: string; name: string }[]; descriptorSha256: string; templateSha256: string }; toolLocks: Record<string, string>;
}
export interface PipelineRun {
  repositoryId: number; fullName: string; sourceSha: string; runId: number; attempt: number; ref: string; event: string;
}
/** In-memory source facts. No commands, permissions, release existence or admission state. */
export interface PipelineSource extends PipelineRun {
  controllerSha: string; toolLocks: Record<string, string>; inspectJob: string;
  unit: {
    id: string; version: string; packageVersion: string; tag: string; deliverySha256: string; templateSha256: string;
    builds: { id: string; jobName: string; expectedArtifacts: string[] }[];
    assets: { id: string; name: string; build: string }[];
  };
}
export type CurrentPipelineRun = { [K in keyof PipelineRun]: string | undefined };
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
    properties: { unit: { type: 'object' }, version, packageVersion: version,
      tag: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]*$' }, descriptorSha256: digest, templateSha256: digest,
      assets: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
};
const validate = new Ajv2020({ allErrors: true, strict: false }).compile({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
/** Decode historical receipts without consulting the executing machine or current authority. */
export function parseHistoricalPipelineRecord(input: unknown): HistoricalPipelineRecord {
  if (!validate(input)) throw new Error('RELEASE_RECORD: invalid structure');
  const record = structuredClone(input) as unknown as HistoricalPipelineRecord;
  parseReleaseDescriptor({ schemaVersion: 1, units: [record.admitted.unit] });
  const unit = record.admitted.unit;
  assertDeliveryPath(unit.path, { root: true }); assertDeliveryPath(unit.releasePleasePath, { root: true });
  for (const path of [unit.versionFile, unit.changelogPath, unit.notesPath, ...unit.builds.map(build => build.entrypoint)]) assertDeliveryPath(path);
  try { assertDeliveryArtifactMapping(unit); } catch (error) { throw new Error('RELEASE_RECORD: ' + (error as Error).message); }
  const expected = [...artifactNames(record.admitted.unit, record.admitted.version, record.admitted.packageVersion)].map(([id, name]) => ({ id, name }));
  if (JSON.stringify(expected) !== JSON.stringify(record.admitted.assets)) throw new Error('RELEASE_RECORD: artifact mapping');
  return record;
}

/** Reconcile an actual retry; its native attempt is a fact, not a failure budget. */
export function bindPipelineRun<T extends PipelineRun>(source: T, current: CurrentPipelineRun): T {
  for (const key of ['repositoryId', 'fullName', 'sourceSha', 'runId', 'ref', 'event'] as const) {
    if (current[key] !== String(source[key])) throw new Error('RELEASE_RECORD: current run mismatch: ' + key);
  }
  const attempt = current.attempt;
  if (!Number.isSafeInteger(source.attempt) || source.attempt < 1 || !attempt || !/^[1-9][0-9]*$/.test(attempt)
    || !Number.isSafeInteger(Number(attempt)) || Number(attempt) < source.attempt) throw new Error('RELEASE_RECORD: current attempt');
  return { ...structuredClone(source), attempt: Number(attempt) };
}

/** Project the old receipt once at its CLI boundary; consumers receive source data only. */
export function historicalPipelineSource(record: HistoricalPipelineRecord): PipelineSource {
  if (record.mode !== 'build') throw new Error('RELEASE_RECORD: verify-only cannot consume build artifacts');
  const unit = record.admitted.unit;
  return {
    repositoryId: record.repositoryId, fullName: record.fullName, sourceSha: record.sourceSha, controllerSha: record.policySha,
    runId: record.runId, attempt: record.attempt, ref: 'refs/tags/' + record.admitted.tag, event: 'workflow_dispatch',
    toolLocks: { ...record.toolLocks }, inspectJob: 'publish / inspect',
    unit: { id: unit.id, version: record.admitted.version, packageVersion: record.admitted.packageVersion, tag: record.admitted.tag,
      deliverySha256: record.admitted.descriptorSha256, templateSha256: record.admitted.templateSha256,
      builds: unit.builds.map(build => ({ id: build.id, jobName: `publish / build-${build.id}`, expectedArtifacts: [...build.expectedArtifacts] })),
      assets: record.admitted.assets.map(asset => ({ ...asset, build: unit.artifacts.find(item => item.id === asset.id)!.build })) },
  };
}

const key = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const text = { type: 'string', minLength: 1, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
const exactObject = (fields: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields });
const validateSource = new Ajv2020({ allErrors: true, strict: false }).compile(exactObject({
  repositoryId: id, fullName: properties.fullName, sourceSha: sha, controllerSha: sha, runId: id, attempt: id,
  ref: text, event: key, toolLocks: properties.toolLocks, inspectJob: text,
  unit: exactObject({ id: key, version: text, packageVersion: text, tag: text, deliverySha256: digest, templateSha256: digest,
    builds: { type: 'array', minItems: 1, items: exactObject({ id: key, jobName: text, expectedArtifacts: { type: 'array', minItems: 1, uniqueItems: true, items: key } }) },
    assets: { type: 'array', minItems: 1, items: exactObject({ id: key, name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$' }, build: key }) } }),
}));

export function assertPipelineSource(input: unknown): asserts input is PipelineSource {
  if (!validateSource(input)) throw new Error('RELEASE_RECORD: invalid source structure');
  const source = input as unknown as PipelineSource;
  if (source.fullName.split('/').some(part => part === '.' || part === '..')) throw new Error('RELEASE_RECORD: repository path');
  assertDeliveryArtifactMapping({ builds: source.unit.builds, artifacts: source.unit.assets });
  if (new Set([...source.unit.builds.map(build => build.jobName), source.inspectJob]).size !== source.unit.builds.length + 1)
    throw new Error('RELEASE_RECORD: ambiguous job mapping');
  // Reuse the actual flat asset/path checks without importing build recipes into this input.
  const names = artifactNames({ id: source.unit.id, artifacts: source.unit.assets.map(asset => ({
    id: asset.id, file: asset.name, platform: '', architecture: '',
  })) }, source.unit.version, source.unit.packageVersion);
  if (names.size !== source.unit.assets.length) throw new Error('RELEASE_RECORD: artifact mapping');
}

export interface BuildPipelineRecord {
  schemaVersion: 1; kind: 'build'; repositoryId: number; fullName: string;
  cycleId: string; requestKey: string; sourceSha: string; controllerSha: string; buildRef: string;
  runId: number; runAttempt: number; toolLocks: Record<string, string>;
  delivery: DeliveryConfig; deliverySha256: string; templateSha256: string;
  units: (Omit<PipelineSource['unit'], 'deliverySha256' | 'templateSha256'> & {
    contributors: ReleaseContributor[];
  })[];
}
export interface PublishPipelineRecord {
  schemaVersion: 1; kind: 'publish'; build: BuildPipelineRecord;
  releases: { unitId: string; releaseId: number; manifestDigest: string }[];
}
export interface ChannelPipelineRecord {
  schemaVersion: 1; kind: 'channel'; repositoryId: number; fullName: string; cycleId: string;
  sourceSha: string; controllerSha: string; requestKey: string; runId: number; runAttempt: number;
  releases: { unitId: string; releaseId: number; manifestDigest: string }[];
}
export type PipelineRecord = BuildPipelineRecord | PublishPipelineRecord | ChannelPipelineRecord;
const sourceUnitSchema = (validateSource.schema as any).properties.unit.properties;
const contributorSchema = exactObject({ id, login: text, profileUrl: text, avatarUrl: text, alt: text });
const buildFields = {
  schemaVersion: { const: 1 }, kind: { const: 'build' }, repositoryId: id, fullName: properties.fullName,
  cycleId: { type: 'string', pattern: '^pr-[1-9][0-9]*-[a-f0-9]{40}$' }, requestKey: digest,
  sourceSha: sha, controllerSha: sha, buildRef: text, runId: id, runAttempt: id, toolLocks: properties.toolLocks,
  delivery: { $ref: deliverySchema.$id }, deliverySha256: digest, templateSha256: digest,
  units: { type: 'array', minItems: 1, items: exactObject({ id: key, version: text, packageVersion: text, tag: text,
    builds: sourceUnitSchema.builds, assets: sourceUnitSchema.assets, contributors: { type: 'array', items: contributorSchema } }) },
};
const releases = { type: 'array', minItems: 1, items: exactObject({ unitId: key, releaseId: id, manifestDigest: digest }) };
const recordAjv = new Ajv2020({ strict: false }).addSchema(deliverySchema);
const validateRecord = recordAjv.compile({ oneOf: [exactObject(buildFields),
  exactObject({ schemaVersion: { const: 1 }, kind: { const: 'publish' }, build: exactObject(buildFields), releases }),
  exactObject({ schemaVersion: { const: 1 }, kind: { const: 'channel' }, repositoryId: id, fullName: properties.fullName,
    cycleId: buildFields.cycleId, sourceSha: sha, controllerSha: sha, requestKey: digest, runId: id, runAttempt: id, releases }),
] });
/** New executable inputs are closed data variants; old authorization receipts use the historical reader. */
export function parsePipelineRecord(input: unknown): PipelineRecord {
  if (!validateRecord(input)) throw new Error('RELEASE_RECORD: invalid data variant');
  const record = structuredClone(input) as unknown as PipelineRecord;
  const build = record.kind === 'build' ? record : record.kind === 'publish' ? record.build : null;
  const identity = build ?? record as ChannelPipelineRecord;
  if (!identity.cycleId.endsWith('-' + identity.sourceSha) || identity.fullName.split('/').some(part => part === '.' || part === '..'))
    throw new Error('RELEASE_RECORD: source identity');
  if (build) {
    parseDeliveryConfig(build.delivery);
    if (build.buildRef !== `refs/heads/steward/build/${build.cycleId}`
      || new Set(build.units.map(unit => unit.id)).size !== build.units.length) throw new Error('RELEASE_RECORD: build identity');
    const jobs = new Set<string>(), assetNames=new Set<string>();
    for (const unit of build.units) {
      const delivery = build.delivery.units.find(item => item.id === unit.id);
      if (!delivery) throw new Error('RELEASE_RECORD: undeclared unit');
      const expected = deliveryAssetNames(delivery, unit.version, unit.packageVersion);
      if (expected.size !== unit.assets.length || unit.assets.some(asset => expected.get(asset.id) !== asset.name))
        throw new Error('RELEASE_RECORD: delivery asset mapping');
      for(const asset of unit.assets) {
        const name=asset.name.toLowerCase();if(assetNames.has(name))throw new Error('RELEASE_RECORD: duplicate product asset');assetNames.add(name);
      }
      assertPipelineSource(pipelineSource(build, unit.id));
      for (const producer of unit.builds) {
        if (jobs.has(producer.jobName)) throw new Error('RELEASE_RECORD: duplicate product job'); jobs.add(producer.jobName);
      }
      const selected = selectReleaseContributors(unit.contributors.map(person => ({ ...person, type: 'User' })), build.delivery.repositoryAuthors);
      if (JSON.stringify(selected.contributors) !== JSON.stringify(unit.contributors)) throw new Error('RELEASE_RECORD: frozen contributor identity');
    }
  }
  if (record.kind !== 'build') {
    if (new Set(record.releases.map(release => release.unitId)).size !== record.releases.length
      || new Set(record.releases.map(release => release.releaseId)).size !== record.releases.length
      || record.kind === 'publish' && (record.releases.length !== record.build.units.length
        || record.releases.some(release => !record.build.units.some(unit => unit.id === release.unitId))))
      throw new Error('RELEASE_RECORD: frozen release set');
  }
  return record;
}
/** Select one product unit without changing the frozen build or producer identities. */
export function pipelineSource(record: BuildPipelineRecord, unitId: string): PipelineSource {
  const unit = record.units.find(item => item.id === unitId);
  if (!unit) throw new Error('RELEASE_RECORD: unit missing');
  return { repositoryId: record.repositoryId, fullName: record.fullName, sourceSha: record.sourceSha, controllerSha: record.controllerSha,
    runId: record.runId, attempt: record.runAttempt, ref: record.buildRef, event: 'workflow_dispatch', toolLocks: { ...record.toolLocks },
    inspectJob: `freeze/${unitId}`, unit: { id: unit.id, version: unit.version, packageVersion: unit.packageVersion, tag: unit.tag,
      builds: structuredClone(unit.builds), assets: structuredClone(unit.assets), deliverySha256: record.deliverySha256, templateSha256: record.templateSha256 } };
}
