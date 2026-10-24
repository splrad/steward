import { expect, it } from 'vitest';
import { parsePipelineRecord } from '../src/release-pipeline-record.js';
import type { PipelineRecord } from '../src/release-pipeline.js';
const record: PipelineRecord = { repositoryId: 1, fullName: 'fixture/product', releaseId: 3, releasePr: 4, sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), observationSha: 'c'.repeat(40), runId: 42, attempt: 2, mode: 'build', toolLocks: { mise: 'd'.repeat(64) },
  admitted: { version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', descriptorSha256: 'e'.repeat(64), templateSha256: 'f'.repeat(64), assets: [{ id: 'app', name: 'app.exe' }],
    unit: { id: 'app', displayName: 'App', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/app.md', signingPolicy: 'none', channels: [], artifacts: [{ id: 'app', file: 'app.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'windows', required: true }], builds: [{ id: 'windows', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['app'] }] } } };
const environment = { GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY: record.fullName, GITHUB_SHA: record.sourceSha, GITHUB_RUN_ID: '42',
  GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '3' };
it('accepts same-run failed-job retry without mutating the frozen identity input', () => {
  expect(parsePipelineRecord(record, environment).attempt).toBe(3); expect(record.attempt).toBe(2);
});
it.each(Object.keys(environment))('rejects missing or mismatched current %s before phase execution', name => {
  expect(() => parsePipelineRecord(record, { ...environment, [name]: undefined })).toThrow('RELEASE_RECORD');
  expect(() => parsePipelineRecord(record, { ...environment, [name]: 'unexpected' })).toThrow('RELEASE_RECORD');
});
it.each(['1','0','01','101','9007199254740992'])('rejects invalid/regressing attempt %s', attempt => {
  expect(() => parsePipelineRecord(record, { ...environment, GITHUB_RUN_ATTEMPT: attempt })).toThrow('current attempt');
});
it.each(['extra','unsafe-entrypoint','asset-mapping','bad-lock','fractional-id','unknown-mode'])('rejects malformed record %s', kind => {
  const value: any = structuredClone(record);
  if (kind === 'extra') value.extra = true;
  if (kind === 'unsafe-entrypoint') value.admitted.unit.builds[0].entrypoint = '../evil.ps1';
  if (kind === 'asset-mapping') value.admitted.assets[0].name = 'other.exe';
  if (kind === 'bad-lock') value.toolLocks.mise = 'invalid';
  if (kind === 'fractional-id') value.releaseId = 1.5;
  if (kind === 'unknown-mode') value.mode = 'publish';
  expect(() => parsePipelineRecord(value, environment)).toThrow();
});
