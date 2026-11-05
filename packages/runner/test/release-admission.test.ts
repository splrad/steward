import {createHash} from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { pipelineIdentity, pipelineNotes, mergedBuildCycle, assertProductDelivery } from '../src/release-pipeline.js';
import { parsePipelineRecord, pipelineSource } from '../src/release-pipeline-record.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
afterEach(() => vi.restoreAllMocks());
it.each(['github-release','ghcr','unknown'])('rejects an external channel with no fixed implementation: %s',id=>{
  expect(()=>assertProductDelivery({units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[],channels:[{id,required:true,location:'fixture'}]}]})).toThrow('fixed product implementation');
});
it.each(['complete','deleted','optional','wrong-unit'])('LayerScape preserves its two explicit required channels: %s',kind=>{
  const delivery={units:[{id:kind==='wrong-unit'?'other':'layerscape',path:'.',notesPath:'.release-notes/layerscape.md',assets:[],
    channels:[{id:'ghcr-assets',required:true,location:'fixture'},{id:'winget',required:kind!=='optional',location:'fixture'}]}]};
  if(kind==='deleted')delivery.units[0]!.channels.pop();
  if(kind==='complete')expect(()=>assertProductDelivery(delivery,'splrad/LayerScape')).not.toThrow();
  else expect(()=>assertProductDelivery(delivery,'splrad/LayerScape')).toThrow('required delivery obligations');
});
it.each(['complete', 'missing-unit', 'missing-producer', 'extra-asset'])('admits native two-unit source only with its complete frozen set: %s', async kind => {
  const f = productPipelineFixture(1, true);
  if (kind === 'missing-unit') f.context.cycle.units.pop();
  if (kind === 'missing-producer') f.source['.github/workflows/steward-release-publish.yml'] = f.source['.github/workflows/steward-release-publish.yml']!.replace('unit: other', 'unit: absent');
  if (kind === 'extra-asset') f.source['.github/workflows/steward-release-publish.yml'] = f.source['.github/workflows/steward-release-publish.yml']!.replace('- app', '- app\n              - foreign');
  if (kind === 'complete') {
    const result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
    expect(result.status).toBe('ADMITTED');
    if (result.status === 'ADMITTED') expect(result.record.units.map(unit => ({ id: unit.id, tag: unit.tag, job: unit.builds[0]!.jobName })))
      .toEqual([{ id: 'app', tag: 'app-v1.0.0', job: 'build/windows-x64/app' }, { id: 'other', tag: 'other-v1.0.0', job: 'build/windows-x64/other' }]);
  } else await expect(pipelineIdentity(f.input, f.environment, f.gh, f.io)).rejects.toThrow();
});
it('admits current canonical source without a Release, catalog or tag read; native attempt 2 consumes only the earlier actual failure', async () => {
  const f = productPipelineFixture(2), before = JSON.stringify(f.input.state);
  const result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  expect(result.status).toBe('ADMITTED'); if (result.status !== 'ADMITTED') throw new Error('fixture admission');
   expect(result.record.runAttempt).toBe(2);
  expect(parsePipelineRecord(result.record)).toEqual(result.record);
  expect(pipelineSource(result.record, 'app').ref).toBe(f.environment.GITHUB_REF);
  expect(f.nativeCalls.some(path => /releases|catalog|tags|compare|pulls/.test(path))).toBe(false);
  expect(JSON.stringify(f.input.state)).toBe(before);
  expect(JSON.stringify(result.record)).not.toMatch(/"(?:releaseId|policySha|observationSha|admitted|entrypoint)"/);
});
it('treats concurrent protected state advancement as UNKNOWN without product admission', async () => {
  const f = productPipelineFixture();
  const gh = async (args: readonly string[]) => args.at(-1)!.endsWith('/heads/steward/release-state')
    ? JSON.stringify({ ref: 'refs/heads/steward/release-state', object: { type: 'commit', sha: 'e'.repeat(40) } }) : f.gh(args);
  expect(await pipelineIdentity(f.input, f.environment, gh, f.io)).toMatchObject({ status: 'UNKNOWN', reason: 'STATE_SOURCE_MOVED' });
});
it.each(['valid', 'unit', 'template', 'version', 'compare'])('renders reviewed notes at S without a catalog reader: %s', async kind => {
  const f = productPipelineFixture(), result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  if (result.status !== 'ADMITTED') throw new Error('fixture admission');
  f.source['.release-notes/app.md'] = ['概述', '更新内容', '兼容性', '升级与迁移', '安装说明', '已知问题', '恢复'].map(label => `## ${label}\n\n已审事实。`).join('\n\n');
  f.source['CHANGELOG.md'] = '## [1.0.0](https://github.com/example/product/compare/v0.9.0...v1.0.0)\n\n### Features\n\nOriginal English evidence retained.\n';
  if (kind === 'template') result.record.templateSha256 = '0'.repeat(64);
  if (kind === 'version') f.source['CHANGELOG.md'] = f.source['CHANGELOG.md'].replace('[1.0.0]', '[2.0.0]');
  if (kind === 'compare') f.source['CHANGELOG.md'] = f.source['CHANGELOG.md'].replace('example/product/compare', 'other/product/compare');
  const before = JSON.stringify(f.source);
  if (kind === 'valid') {
    const body = await pipelineNotes(result.record, 'app', 'source');
    expect(body).toContain('已审事实。'); expect(body).toContain('v0.9.0...'+result.record.sourceSha);
    expect(body).not.toContain('Original English evidence retained');
  } else await expect(pipelineNotes(result.record, kind === 'unit' ? 'missing' : 'app', 'source')).rejects.toThrow();
  expect(JSON.stringify(f.source)).toBe(before);
});
it('keeps two unit asset sets separate and requires every frozen Release ID in publish input', async () => {
  const f = productPipelineFixture(1,true), result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  if (result.status !== 'ADMITTED') throw new Error('fixture admission');
  const build = result.record;
  expect(parsePipelineRecord(build)).toEqual(build);
  const duplicate=structuredClone(build);duplicate.delivery.units[1]!.assets[0]!.name=duplicate.delivery.units[0]!.assets[0]!.name;
  duplicate.units[1]!.assets[0]!.name=duplicate.units[0]!.assets[0]!.name;
  expect(()=>parsePipelineRecord(duplicate)).toThrow('duplicate product asset');
  const releases = build.units.map((unit, index) => ({ unitId: unit.id, releaseId: 200 + index, manifestDigest: String(index).repeat(64) }));
  expect(parsePipelineRecord({ schemaVersion: 1, kind: 'publish', build, releases }).kind).toBe('publish');
  expect(() => parsePipelineRecord({ schemaVersion: 1, kind: 'publish', build, releases: releases.slice(0, 1) })).toThrow('release set');
  expect(() => parsePipelineRecord({ schemaVersion: 1, kind: 'publish', build, releases: [releases[0], { ...releases[1], releaseId: 200 }] })).toThrow('release set');
  const channel = { schemaVersion: 1, kind: 'channel', repositoryId: build.repositoryId, fullName: build.fullName, cycleId: build.cycleId,
    sourceSha: build.sourceSha, controllerSha: build.controllerSha, requestKey: build.requestKey, runId: 400, runAttempt: 1, releases };
  expect(parsePipelineRecord(channel).kind).toBe('channel');
  expect(() => parsePipelineRecord({ ...channel, releases: [{ ...releases[0], releaseId: null }] })).toThrow();
  build.units[1]!.assets.push({ id: 'foreign', name: 'other.exe', build: 'windows-x64' });
  expect(() => parsePipelineRecord(build)).toThrow('asset mapping');
});
it('merged handoff compares the complete product tree and creates no tag or Release identity', () => {
  const f = productPipelineFixture(), input = { prNumber: 12, sourceSha: f.input.sourceSha, controllerSha: f.input.controllerSha,
    sourceTree: 'a'.repeat(40), reviewedTree: 'a'.repeat(40), deliveryBlobSha: f.context.cycle.deliveryConfigSha,
    delivery: f.delivery, units: [{ id: 'app', path: '.', version: '1.0.0', tag: 'v1.0.0' }] };
  const cycle = mergedBuildCycle(input);
  expect(cycle.units[0]).toMatchObject({ releaseId: null, manifestDigest: null }); expect(cycle.requiredChannels).toEqual([]);
  expect(() => mergedBuildCycle({ ...input, reviewedTree: 'b'.repeat(40) })).toThrow('product tree');
  expect(() => mergedBuildCycle({ ...input, units: [{ ...input.units[0]!, path: 'wrong' }] })).toThrow('unit source');
});
it.each(['unbound','duplicate'])('stops %s before product work',async kind=>{
  const f=productPipelineFixture();
  if(kind==='unbound'){f.request.canonicalRunId=null;f.request.nativeResponseEvidencePath=null;}
  else f.environment.GITHUB_RUN_ID='101';
  const result=await pipelineIdentity(f.input,f.environment,f.gh,f.io);
  expect(result.status).toBe(kind==='unbound'?'NOT_BOUND':'REJECTED');expect(result.record).toBeUndefined();
});
it('admits an original Run rerun by a maintainer without replaying failure history',async()=>{
  const f=productPipelineFixture(4);f.runs.get(4).triggering_actor.id=44151430;
  const io={request:async()=>{throw Error('past-attempt inventory must not be fetched for admission');}};
  expect((await pipelineIdentity(f.input,f.environment,f.gh,io)).status).toBe('ADMITTED');
});
it.each(['source', 'controller', 'ref', 'repository', 'run-attempt', 'delivery', 'native-version', 'missing-template', 'rp-path', 'fork'])('rejects %s drift using the current source', async kind => {
  const f = productPipelineFixture();
  if (kind === 'source') f.environment.GITHUB_SHA = 'd'.repeat(40);
  if (kind === 'controller') f.input.controllerSha = 'd'.repeat(40);
  if (kind === 'ref') f.environment.GITHUB_REF = 'refs/tags/v1.0.0';
  if (kind === 'repository') f.environment.GITHUB_REPOSITORY_ID = '2';
  if (kind === 'run-attempt') f.environment.GITHUB_RUN_ATTEMPT = '2';
  if (kind === 'delivery') f.source['.github/delivery.json'] += ' ';
  if (kind === 'native-version') f.source.VERSION = '2.0.0';
  if (kind === 'missing-template') delete f.source['.github/release-template.md.mustache'];
  if (kind === 'rp-path') f.source['.release-please-manifest.json'] = '{"other":"1.0.0"}';
  if (kind === 'fork') f.runs.get(1).head_repository.id = 99;
  if (kind === 'run-attempt') expect((await pipelineIdentity(f.input, f.environment, f.gh, f.io)).status).toBe('REJECTED');
  else await expect(pipelineIdentity(f.input, f.environment, f.gh, f.io)).rejects.toThrow();
});
it.each(['releaseId', 'policySha', 'admitted', 'command', 'wrong-ref', 'missing-asset', 'duplicate-unit', 'author-as-contributor'])('closed build data rejects %s', async kind => {
  const f = productPipelineFixture(), result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  if (result.status !== 'ADMITTED') throw new Error('fixture admission');
  const record: any = structuredClone(result.record);
  if (['releaseId', 'policySha', 'admitted', 'command'].includes(kind)) record[kind] = 'unexpected';
  if (kind === 'wrong-ref') record.buildRef = 'refs/heads/main';
  if (kind === 'missing-asset') record.units[0].assets = [];
  if (kind === 'duplicate-unit') record.units.push(record.units[0]);
  if (kind === 'author-as-contributor') record.units[0].contributors.push({ id: 44151430, login: 'axiomoth', profileUrl: 'https://github.com/axiomoth', avatarUrl: 'https://avatars.githubusercontent.com/u/44151430?v=4', alt: 'axiomoth' });
  expect(() => parsePipelineRecord(record)).toThrow();
});

it('builds a registered earlier cycle from its exact merged archive after candidate replacement',async()=>{
  const f=productPipelineFixture(),repository=f.input.state.repository as any,chunk=f.input.state.domainRecords[0]!.value as any;
  const candidate={...repository.candidate,generatedSnapshotPath:`generated/${chunk.candidateId}/generated.json`};
  const value={schemaVersion:1,cycleId:f.context.cycle.id,sourceSha:f.context.cycle.sourceSha,stateCommit:f.input.state.head,candidate,
    session:JSON.parse(chunk.content),pull:{number:12,head:candidate.publishedHead,branch:candidate.branch,base:'main',repositoryId:1,mergedAt:'2026-10-26T00:00:00Z',mergeCommitSha:f.context.cycle.sourceSha},
    documents:[{path:`generated/${chunk.candidateId}/session.json`,sha256:chunk.documentDigest},{path:candidate.generatedSnapshotPath,sha256:'a'.repeat(64)}]};
  const content=JSON.stringify(value);
  f.input.state.domainRecords=[{path:`generated/${chunk.candidateId}/cycles/${f.context.cycle.id}.json`,commit:f.input.state.head,
    value:{...chunk,documentKind:'merged-candidate',content,documentDigest:createHash('sha256').update(content).digest('hex')}}];
  repository.candidate=null;repository.activeCycleId=`pr-13-${'d'.repeat(40)}`;
  expect((await pipelineIdentity(f.input,f.environment,f.gh,f.io)).status).toBe('ADMITTED');
});
