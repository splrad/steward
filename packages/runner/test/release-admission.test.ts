import {evidenceFixture} from './native-evidence-fixture.js';
import {reconcileCycleHistory} from '../../core/src/release-history.js';
import {createHash} from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { pipelineIdentity, pipelineNotes, mergedBuildCycle, assertProductDelivery, assertRegisteredAdapters } from '../src/release-pipeline.js';
import { parsePipelineRecord, pipelineSource } from '../src/release-pipeline-record.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { nativeRequestIdentity } from '../src/native-release-evidence.js';
import { defaultBuildWorkflow } from '../../core/src/release-workflow.js';
import { projectFrozenReleaseDownloads } from '../../core/src/release-template.js';
import YAML from 'yaml';
afterEach(() => vi.restoreAllMocks());
it.each(['ghcr','unknown'])('rejects an external channel with no fixed implementation: %s',id=>{
  expect(()=>assertProductDelivery({units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[],channels:[{id,required:true,location:'fixture'}]}]})).toThrow('fixed product implementation');
});
it('admits a GitHub-only unit with its own artifact IDs', () => {
  expect(()=>assertProductDelivery({units:[{id:'cli',path:'.',notesPath:'notes.md',
    assets:[{id:'archive',name:'cli.tar.gz',mediaType:'application/gzip'}],
    channels:[{id:'github-release',required:true,location:'github',artifactIds:['archive']}]}]})).not.toThrow();
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
it('admits a Node workflow with a localized path, optional input and shared release template', async () => {
  const f = productPipelineFixture(1, false, 'package-lock.json'), path = '.github/workflows/发布 构建.yml';
  const delivery = { ...f.delivery, buildWorkflow:path };
  delivery.units[0]!.assets = [{id:'bundle',name:'package.json',inspection:'node-package',mediaType:'application/json'}];
  const workflow=YAML.parse(f.source[defaultBuildWorkflow]!.replace('windows-x64','linux-x64').replace('- app','- bundle'));
  workflow['run-name']='发行业务 ${{ inputs.operation_key }}';
  workflow.on.workflow_dispatch.inputs.flavor={type:'choice',default:'ordinary',options:['ordinary','large']};
  f.source[path]=YAML.stringify(workflow);
  delete f.source[defaultBuildWorkflow];
  delete f.source['.github/release-template.md.mustache'];
  f.source['package.json'] = '{"name":"fixture-cli","version":"1.0.0"}';
  f.source['package-lock.json'] = '{}';
  f.source['release-please-config.json'] = '{"include-component-in-tag":false,"packages":{".":{"release-type":"node"}}}';
  f.source['.github/delivery.json'] = JSON.stringify(delivery);
  const bytes=Buffer.from(f.source['.github/delivery.json']);
  const cycle=f.context.cycle;
  cycle.deliveryConfigSha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  cycle.buildWorkflow=f.request.buildWorkflow=path;
  Object.assign(f.request,nativeRequestIdentity(f.context.repositoryId,cycle,f.request));
  f.input.operationKey=f.request.inputs.operation_key=f.request.operationKey;
  f.runs.get(1).display_title='发行业务 '+f.request.operationKey;
  f.runs.get(1).path=path;
  const admitted=await pipelineIdentity(f.input,f.environment,f.gh,f.io);
  expect(admitted).toMatchObject({status:'ADMITTED',record:{delivery:{buildWorkflow:path},
    units:[{packageVersion:'1.0.0',assets:[{id:'bundle',name:'package.json',build:'linux-x64'}]}]}});
  workflow.on.workflow_dispatch.inputs.flavor.required=true;
  f.source[path]=YAML.stringify(workflow);
  await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).rejects.toThrow('dispatch workflow interface');
  delete workflow.on.workflow_dispatch.inputs.flavor.required;
  f.source[path]=YAML.stringify(workflow);
  f.runs.get(1).path=defaultBuildWorkflow;
  await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).rejects.toThrow('execution source');
});
it('treats concurrent protected state advancement as UNKNOWN without product admission', async () => {
  const f = productPipelineFixture();
  const gh = async (args: readonly string[]) => args.at(-1)!.endsWith('/heads/steward/release-state')
    ? JSON.stringify({ ref: 'refs/heads/steward/release-state', object: { type: 'commit', sha: 'e'.repeat(40) } }) : f.gh(args);
  expect(await pipelineIdentity(f.input, f.environment, gh, f.io)).toMatchObject({ status: 'UNKNOWN', reason: 'STATE_SOURCE_MOVED' });
});
it('requires the product template for a legacy cycle without an explicit native entry', async () => {
  const f=productPipelineFixture();
  delete f.source['.github/release-template.md.mustache'];
  await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).rejects.toThrow('missing source input: .github/release-template.md.mustache');
});
it('rejects a static artifact identity before admitting a sealed legacy GitHub handoff', async () => {
  const f=productPipelineFixture(), workflow=YAML.parse(f.source[defaultBuildWorkflow]!);
  const upload='actions/upload-artifact@'+'a'.repeat(40);
  workflow.jobs.freeze={name:'freeze/app',steps:[
    {name:'business-freeze',uses:upload,with:{name:'final-fixture'}},
    {id:'upload-github-release',name:'Upload GitHub release delivery',uses:upload,with:{name:'delivery-github-release-static'}},
  ]};
  f.source[defaultBuildWorkflow]=YAML.stringify(workflow);
  await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).rejects.toThrow('GitHub delivery workflow step');
  workflow.jobs.freeze.steps[1].with.name='delivery-github-release-${{ github.repository_id }}-app-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}';
  f.source[defaultBuildWorkflow]=YAML.stringify(workflow);
  await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).resolves.toMatchObject({status:'ADMITTED'});
});
it.each(['valid', 'unit', 'template', 'version', 'compare', 'historical-subset'])('renders reviewed notes at S without a catalog reader: %s', async kind => {
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
  } else if(kind==='historical-subset') {
    const delivery=result.record.delivery.units[0]!,unit=result.record.units[0]!;
    delivery.assets.push({id:'fonts',name:'Fonts.zip',mediaType:'application/zip'},{id:'internal',name:'Internal.zip',mediaType:'application/zip'});
    unit.assets.push({id:'fonts',name:'Fonts.zip',build:'windows-x64'},{id:'internal',name:'Internal.zip',build:'windows-x64'});
    delivery.channels[0]!.artifactIds=['app','fonts'];
    const body=await pipelineNotes(result.record,'app','source');
    expect(body).toContain('app-1.0.0.exe');
    expect(body).toContain('Fonts.zip');
    expect(body).not.toContain('Internal.zip');
    const projected=projectFrozenReleaseDownloads(f.source['.github/release-template.md.mustache']!,body,
      {assets:unit.assets.slice(0,2),repository:result.record.fullName,tag:unit.tag},new Set(['Fonts.zip']));
    expect(projected).toContain('已审事实。');
    expect(projected).toContain('Fonts.zip');
    expect(projected).not.toMatch(/Internal\.zip|app-1\.0\.0\.exe/);
  } else await expect(pipelineNotes(result.record, kind === 'unit' ? 'missing' : 'app', 'source')).rejects.toThrow();
  expect(JSON.stringify(f.source)).toBe(before);
});
it('checks conditional text against the workflow subset and preserves approved body bytes', async () => {
  const template=await (await import('node:fs/promises')).readFile('templates/repository/.github/release-template.md.mustache','utf8');
  const repository='example/product',tag='v1.0.0',asset='Fonts.zip';
  const body=`## 获取与使用\n\n[字体](<https://github.com/${repository}/releases/download/${tag}/${asset}>)。\n`;
  const native={repository,tag,assets:[{id:'app',name:'Internal.zip',build:'windows-x64'},{id:'fonts',name:asset,build:'windows-x64'}]};
  expect(projectFrozenReleaseDownloads(template,body,native,new Set([asset]))).toBe(body);
  expect(()=>projectFrozenReleaseDownloads(template,body,native,new Set(['Internal.zip']))).toThrow('outside GitHub delivery');
});
it('keeps two unit asset sets separate and requires every frozen Release ID in publish input', async () => {
  const f = productPipelineFixture(1,true), result = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  if (result.status !== 'ADMITTED') throw new Error('fixture admission');
  const build = result.record;
  expect(parsePipelineRecord(build)).toEqual(build);
  const missingAuthors={...build,delivery:{...build.delivery,repositoryAuthors:[]}};
  expect(()=>parsePipelineRecord(missingAuthors)).toThrow('AUTHOR_IDENTITY_UNVERIFIED');
  const conditional={...missingAuthors,noteFormat:'conditional'} as const;
  expect(parsePipelineRecord(conditional)).toMatchObject({noteFormat:'conditional'});
  await expect(pipelineNotes(conditional,'app','source')).rejects.toThrow('notes template format');
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
it.each(['source', 'controller', 'ref', 'repository', 'run-attempt', 'delivery', 'native-version', 'template-drift', 'rp-path', 'fork'])('rejects %s drift using the current source', async kind => {
  const f = productPipelineFixture();
  if (kind === 'source') f.environment.GITHUB_SHA = 'd'.repeat(40);
  if (kind === 'controller') f.input.controllerSha = 'd'.repeat(40);
  if (kind === 'ref') f.environment.GITHUB_REF = 'refs/tags/v1.0.0';
  if (kind === 'repository') f.environment.GITHUB_REPOSITORY_ID = '2';
  if (kind === 'run-attempt') f.environment.GITHUB_RUN_ATTEMPT = '2';
  if (kind === 'delivery') f.source['.github/delivery.json'] += ' ';
  if (kind === 'native-version') f.source.VERSION = '2.0.0';
  if (kind === 'template-drift') f.source['.github/release-template.md.mustache'] += ' invalid';
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

it('prevents unregistered repositories or destinations from using an enrolled external adapter',()=>{
  const unit={id:'layerscape',path:'.',notesPath:'notes.md',
    assets:[{id:'installer',name:'app.exe',mediaType:'application/octet-stream'}],
    channels:[{id:'winget',required:true,location:'SPLRAD.LayerScape.Deployer',artifactIds:['installer']}]};
  expect(()=>assertRegisteredAdapters(41,'test/other',{units:[unit]})).toThrow('not registered');
  expect(()=>assertRegisteredAdapters(1187527897,'splrad/LayerScape',{units:[unit]})).not.toThrow();
  unit.assets.push({id:'plugins',name:'AFR-DLL.zip',mediaType:'application/zip'});
  unit.channels[0]!.artifactIds=['plugins'];
  expect(()=>assertRegisteredAdapters(1187527897,'splrad/LayerScape',{units:[unit]})).toThrow('DELIVERY_WINGET_INSTALLER');
  unit.channels[0]!.location='Other.Product';
  expect(()=>assertRegisteredAdapters(1187527897,'splrad/LayerScape',{units:[unit]})).toThrow('not registered');
});

it('closes a frozen-only cycle from its native build receipt without inventing a Release',()=>{
  const {context}=evidenceFixture(), cycle=context.cycle, unit=cycle.units[0]!;
  const digest='d'.repeat(64);
  Object.assign(unit,{notesDigest:digest,manifestDigest:digest,assets:[{id:'archive',path:'cli.tar.gz',size:10,sha256:digest}]});
  cycle.freezeOnly=[{unitId:unit.id,runId:100,attempt:2,producerAttempt:1,artifactId:45,archiveDigest:'sha256:'+digest}];
  const input={repositoryId:context.repositoryId,inventoryComplete:true,cycles:[cycle],
    discovered:[{id:cycle.id,prNumber:cycle.prNumber,sourceSha:cycle.sourceSha,mergedAt:'2026-11-19T00:00:00Z'}],
    completions:[],decisions:[],repairActorId:1,now:'2026-11-19T01:00:00Z'};
  expect(reconcileCycleHistory(input).result).toBe('UNKNOWN');
  expect(reconcileCycleHistory({...input,verifiedFreezes:[cycle.id]})).toMatchObject({result:'PASS',lastCompletedCycleId:cycle.id});
  expect(unit.releaseId).toBeNull();
  const published={...unit,id:'public',tag:'public-v1.0.0',releaseId:20};
  cycle.units.push(published);
  expect(reconcileCycleHistory({...input,verifiedFreezes:[cycle.id]}).result).toBe('UNKNOWN');
  const assets=published.assets.map(({path,size,sha256})=>({path,size,sha256}));
  const source={repositoryId:context.repositoryId,cycleId:cycle.id,sourceSha:cycle.sourceSha,
    deliveryConfigSha:cycle.deliveryConfigSha,units:[{...published,releaseId:20,manifestDigest:digest,notesDigest:digest,assets,authorId:42}],requiredChannels:[]};
  const {id:unitId,...release}=source.units[0]!;
  const observation={source,sourceComplete:true,observedAt:input.now,releasesComplete:true,channelsComplete:true,
    releases:[{...release,unitId,sourceSha:cycle.sourceSha,draft:false,immutable:true,evidenceDigest:digest}],
    channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]};
  const fact={cycleId:cycle.id,source,observation,kind:'live' as const,provenanceComplete:true};
  expect(reconcileCycleHistory({...input,verifiedFreezes:[cycle.id],completions:[fact]}).result).toBe('PASS');
});
