import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeReleaseCli } from '../src/native-release-cli.js';
import * as pipeline from '../src/release-pipeline.js';
import { parseHistoricalPipelineRecord, bindPipelineRun, historicalPipelineSource, assertPipelineSource, type HistoricalPipelineRecord, type PipelineSource } from '../src/release-pipeline-record.js';
const record: HistoricalPipelineRecord = { repositoryId: 1, fullName: 'fixture/product', releaseId: 3, releasePr: 4, sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), observationSha: 'c'.repeat(40), runId: 42, attempt: 2, mode: 'build', toolLocks: { mise: 'd'.repeat(64) },
  admitted: { version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', descriptorSha256: 'e'.repeat(64), templateSha256: 'f'.repeat(64), assets: [{ id: 'app', name: 'app.exe' }],
    unit: { id: 'app', displayName: 'App', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/app.md', signingPolicy: 'none', channels: [], artifacts: [{ id: 'app', file: 'app.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'windows', required: true }], builds: [{ id: 'windows', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['app'] }] } } };
const current = { repositoryId: '1', fullName: record.fullName, sourceSha: record.sourceSha, runId: '42',
  ref: 'refs/tags/v1.2.3', event: 'workflow_dispatch', attempt: '3' };
it('accepts same-run failed-job retry without mutating the frozen identity input', () => {
  expect(bindPipelineRun(historicalPipelineSource(parseHistoricalPipelineRecord(record)), current).attempt).toBe(3); expect(record.attempt).toBe(2);
});
it.each(Object.keys(current))('rejects missing or mismatched current %s before phase execution', name => {
  expect(() => bindPipelineRun(historicalPipelineSource(record), { ...current, [name]: undefined })).toThrow('RELEASE_RECORD');
  expect(() => bindPipelineRun(historicalPipelineSource(record), { ...current, [name]: 'unexpected' })).toThrow('RELEASE_RECORD');
});
it.each(['1','0','01','9007199254740992'])('rejects invalid/regressing attempt %s', attempt => {
  expect(() => bindPipelineRun(historicalPipelineSource(record), { ...current, attempt })).toThrow('current attempt');
});
it.each(['extra','unsafe-entrypoint','asset-mapping','bad-lock','fractional-id','unknown-mode'])('rejects malformed record %s', kind => {
  const value: any = structuredClone(record);
  if (kind === 'extra') value.extra = true;
  if (kind === 'unsafe-entrypoint') value.admitted.unit.builds[0].entrypoint = '../evil.ps1';
  if (kind === 'asset-mapping') value.admitted.assets[0].name = 'other.exe';
  if (kind === 'bad-lock') value.toolLocks.mise = 'invalid';
  if (kind === 'fractional-id') value.releaseId = 1.5;
  if (kind === 'unknown-mode') value.mode = 'publish';
  expect(() => parseHistoricalPipelineRecord(value)).toThrow();
});

it('reads historical build and verify receipts independently of the current run, without changing their bytes', () => {
  const bytes = JSON.stringify(record);
  expect(parseHistoricalPipelineRecord(JSON.parse(bytes))).toEqual(record);
  expect(parseHistoricalPipelineRecord({ ...record, mode: 'verify' }).mode).toBe('verify');
  expect(JSON.stringify(record)).toBe(bytes);
  const source = historicalPipelineSource(parseHistoricalPipelineRecord(JSON.parse(bytes)));
  expect(source.controllerSha).toBe(record.policySha);
  expect(source.unit.deliverySha256).toBe(record.admitted.descriptorSha256);
  expect(() => assertPipelineSource(source)).not.toThrow();
  expect(() => historicalPipelineSource({ ...record, mode: 'verify' })).toThrow('verify-only');
  for (const field of ['releaseId', 'releasePr', 'policySha', 'observationSha', 'admitted', 'mode', 'entrypoint', 'args'])
    expect(JSON.stringify(source)).not.toContain('"' + field + '"');
  source.unit.builds[0]!.expectedArtifacts.push('other');
  expect(record.admitted.unit.builds[0]!.expectedArtifacts).toEqual(['app']);
});

it.each(['refs/heads/steward/build/cycle-1', 'refs/tags/product/v1.2.3-rc.1'])('binds a native source at %s without requiring a Release', ref => {
  const source = historicalPipelineSource(record);
  source.ref = ref; source.event = 'push'; source.unit.tag = 'product/v1.2.3-rc.1';
  source.unit.version = '1.2.3-rc.1'; source.unit.packageVersion = '1.2.3rc1';
  expect(() => assertPipelineSource(source)).not.toThrow();
  expect(bindPipelineRun(source, { ...current, ref, event: 'push', attempt: '101' }).attempt).toBe(101);
  expect(source.attempt).toBe(2);
});

it.each(['unknown-format', 'unsafe-name', 'reserved-name', 'duplicate-name', 'duplicate-id', 'extra-asset', 'missing-asset',
  'unknown-producer', 'duplicate-producer', 'duplicate-job-name', 'inspector-as-build', 'command', 'invalid-controller', 'invalid-lock'])('rejects %s in finite source data', kind => {
  const source: any = historicalPipelineSource(record);
  if (kind === 'unknown-format') source.schemaVersion = 99;
  if (kind === 'unsafe-name') source.unit.assets[0].name = '../app.exe';
  if (kind === 'reserved-name') source.unit.assets[0].name = 'SHA256SUMS';
  if (kind === 'duplicate-name') { source.unit.assets.push({ id: 'other', name: 'APP.exe', build: 'windows' }); source.unit.builds[0].expectedArtifacts.push('other'); }
  if (kind === 'duplicate-id') source.unit.assets.push({ ...source.unit.assets[0], name: 'other.exe' });
  if (kind === 'extra-asset') source.unit.assets.push({ id: 'other', name: 'other.exe', build: 'windows' });
  if (kind === 'missing-asset') source.unit.assets = [];
  if (kind === 'unknown-producer') source.unit.assets[0].build = 'unknown';
  if (kind === 'duplicate-producer') source.unit.builds.push(source.unit.builds[0]);
  if (kind === 'duplicate-job-name') { source.unit.builds.push({ id: 'linux', jobName: source.unit.builds[0].jobName, expectedArtifacts: ['linux'] }); source.unit.assets.push({ id: 'linux', name: 'linux.zip', build: 'linux' }); }
  if (kind === 'inspector-as-build') source.inspectJob = source.unit.builds[0].jobName;
  if (kind === 'command') source.unit.builds[0].entrypoint = 'build.ps1';
  if (kind === 'invalid-controller') source.controllerSha = 'bad';
  if (kind === 'invalid-lock') source.toolLocks.mise = 'bad';
  expect(() => assertPipelineSource(source)).toThrow();
});

it('does not admit historical authorization receipts as new build inputs', async () => {
  const { parsePipelineRecord } = await import('../src/release-pipeline-record.js');
  expect(() => parsePipelineRecord(record)).toThrow('data variant');
});
