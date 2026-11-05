import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, copyFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeGhCommand, NativeGitHubRelease, nativeReleaseDownload, releaseReadIsAnonymous, type GhCommand, type ReleaseDownload } from './gh-release.js';
import { localGitSnapshot } from './git-snapshot.js';
import { selectReleaseProducers, producerArtifactName } from './release-run.js';
import { jobFact } from './native-release-evidence.js';
import { originalJobExecutions, type NativeJobAttempt } from '../../core/src/native-job-origins.js';
import { verifySealedArtifacts, validateReleaseManifest, fileDigest, type ReleaseManifest } from './release-artifacts.js';
import { nativeReleaseInspector, nativePythonSourceVersion } from './release-native.js';
import { committedVersionNotes } from '../../core/src/release-template.js';
import { downloadNativeArtifact } from './native-artifact-download.js';
import { Octokit } from '@octokit/rest';
import { assertPipelineSource, type PipelineSource, type PublishPipelineRecord } from './release-pipeline-record.js';
import { parsePipelineRecord, pipelineSource, type BuildPipelineRecord } from './release-pipeline-record.js';
import { parseDeliveryConfig, deliveryAssetNames, assertDeliveryPath, type DeliveryUnit, type DeliveryConfig } from '../../core/src/delivery-config.js';
import { parseReleaseDescriptor,artifactNames } from '../../core/src/release-descriptor.js';
import { parseLegacyRepositoryCatalog } from '../../core/src/legacy-repository-policy.js';
import { decodeNormalizedDelivery,type NormalizedDeliveryEvidence } from '../../core/src/native-evidence.js';
import { parseReleaseRecord, type CycleRecord, type RepositoryRecord } from '../../core/src/release-observation.js';
import { decodeCandidateDocument, type CandidateArchiveChunk } from '../../core/src/release-candidate-record.js';
import { selectReleaseContributors } from '../../core/src/release-candidate.js';
import { inspectNativeCycle, nativeRunFact, NativeEvidenceReader, EvidenceReadError, type EvidenceContext, type EvidenceTransport, nativeEvidenceTransport } from './native-release-evidence.js';
import { verifyExecutionSource, verifyDispatchWorkflow, channelTargets, channelTargetsDigest, type ChannelTarget } from './release-run.js';
import { inspectPublications } from './release-publication.js';
import { parseDocument } from 'yaml';
import { Version } from 'release-please/build/src/version.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { renderFrozenReleaseNotes } from '../../core/src/release-template.js';
import { inspectProductArtifacts, validateProductManifest, type ProductReleaseManifest } from './release-artifacts.js';

export interface ProductBuildInput {
  cycleId: string; operationKey: string; sourceSha: string; controllerSha: string;
  sourceDirectory: string; controllerDirectory: string;
  state: { head: string; repository: RepositoryRecord; cycles: { value: CycleRecord }[];
    domainRecords: { path: string; commit: string; value: any }[] };
}

export interface ProductChannelInputs {
  cycle_id:string;source_sha:string;execution_sha:string;controller_sha:string;targets_json:string;mode:'submit'|'verify'|'observe';operation_key:string;request_key:string;
}
export function normalizedDeliveryFile(value:NormalizedDeliveryEvidence) {
  const content=JSON.stringify(value)+'\n';decodeNormalizedDelivery(Buffer.from(content));const sha256=hash(Buffer.from(content));
  return {path:`evidence/normalized-delivery/${sha256}.json`,content,sha256};
}
/** Historical data projection only. Original commands, policy enablement and authors never become current authority. */
function legacyDeliveryFacts(context:EvidenceContext,value:Omit<NormalizedDeliveryEvidence,'normalizedDelivery'>) {
  const {cycle}=context,bytes=Buffer.from(value.descriptor.content);
  if(value.repositoryId!==context.repositoryId||value.cycleId!==cycle.id||value.sourceSha!==cycle.sourceSha||value.controllerSha!==cycle.controllerSha
    ||value.descriptor.blobSha!==cycle.deliveryConfigSha||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==cycle.deliveryConfigSha)fail('legacy original source');
  const descriptor=parseReleaseDescriptor(JSON.parse(value.descriptor.content));
  if(value.manifests.length!==cycle.units.length||new Set(value.manifests.map(m=>m.unitId)).size!==cycle.units.length
    ||new Set(value.originalChannels.map(c=>JSON.stringify([c.unitId,c.channelId]))).size!==value.originalChannels.length)fail('legacy coverage');
  const required=value.originalChannels.filter(channel=>channel.required).map(channel=>[channel.unitId,channel.channelId]).sort();
  if(JSON.stringify(required)!==JSON.stringify(cycle.requiredChannels.map(c=>[c.unitId,c.channelId]).sort()))fail('legacy required obligations');
  const units:DeliveryUnit[]=cycle.units.map(unit=>{
    const old=descriptor.units.find(old=>old.id===unit.id),frozen=value.manifests.find(m=>m.unitId===unit.id);
    if(!old||!frozen||unit.manifestDigest!==hash(Buffer.from(frozen.content)))return fail('legacy frozen manifest required');
    const manifest:unknown=JSON.parse(frozen.content);validateReleaseManifest(manifest);
    if(manifest.repositoryId!==context.repositoryId||manifest.fullName!==context.repository||manifest.sourceSha!==cycle.sourceSha
      ||manifest.policySha!==cycle.controllerSha||manifest.unitId!==unit.id||manifest.version!==unit.version||manifest.tag!==unit.tag
      ||manifest.descriptorSha256!==hash(bytes))fail('legacy manifest source');
    const names=artifactNames(old,manifest.version,manifest.packageVersion);
    if(manifest.artifacts.length!==names.size||manifest.artifacts.some(a=>names.get(a.id)!==a.path||!unit.assets.some(f=>f.id===a.id&&f.path===a.path&&f.sha256===a.sha256&&f.size===a.size)))fail('legacy frozen assets');
    const channels=value.originalChannels.filter(c=>c.unitId===unit.id);
    if(channels.some(c=>!old.channels.some(o=>o.id===c.channelId&&o.kind===c.kind)||!c.location||/\s/.test(c.location)))fail('legacy channel source');
    return {id:old.id,path:old.path,notesPath:old.notesPath,assets:old.artifacts.map(a=>({id:a.id,name:names.get(a.id)!,mediaType:a.mediaType})),
      channels:channels.map(c=>({id:c.channelId,required:c.required,location:c.location}))};
  });
  return {schemaVersion:1 as const,units};
}
export function normalizeLegacyDelivery(context:EvidenceContext,descriptor:{blobSha:string;content:string},catalog:{blobSha:string;content:string},
  manifests:{unitId:string;content:string}[],observedAt:string) {
  const bytes=Buffer.from(catalog.content);
  if(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==catalog.blobSha)fail('legacy catalog blob');
  const original=parseLegacyRepositoryCatalog(JSON.parse(catalog.content)).repositories[String(context.repositoryId)];
  if(!original||original.fullName!==context.repository||!original.release.enabled)fail('legacy channel obligations unknown');
  const originalChannels:NormalizedDeliveryEvidence['originalChannels']=[];
  for(const unit of context.cycle.units) {
    const old=original.release.units[unit.id];if(!old?.enabled)fail('legacy unit obligations unknown');
    for(const [channelId,channel] of Object.entries(old.channels))originalChannels.push({catalogBlobSha:catalog.blobSha,unitId:unit.id,channelId,kind:channel.kind,
      location:channel.kind==='winget'?channel.packageIdentifier!:channel.destination,required:channel.enabled});
  }
  const raw={schemaVersion:1 as const,repositoryId:context.repositoryId,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,controllerSha:context.cycle.controllerSha,
    observedAt,descriptor:{blobSha:descriptor.blobSha,content:descriptor.content},originalChannels,manifests};
  const value={...raw,normalizedDelivery:legacyDeliveryFacts(context,raw)};normalizedDeliveryFile(value);return value;
}
export function verifyNormalizedDelivery(context:EvidenceContext,record:{path:string;commit:string;value:unknown}) {
  const value=decodeNormalizedDelivery(Buffer.from(JSON.stringify(record.value)));
  if(!/^[a-f0-9]{40}$/.test(record.commit)||record.path!==normalizedDeliveryFile(value).path
    ||JSON.stringify(value.normalizedDelivery)!==JSON.stringify(legacyDeliveryFacts(context,value)))fail('normalized delivery provenance');
  return value;
}
export async function readCycleDelivery(context:EvidenceContext,records:{path:string;commit:string;value:unknown}[],io:EvidenceTransport) {
  try {
    const source=await new NativeEvidenceReader(io,context.repository).json(`contents/.github/delivery.json?ref=${context.cycle.sourceSha}`),bytes=Buffer.from(source.content??'','base64');
    if(source.type!=='file'||source.encoding!=='base64'||source.size!==bytes.length||source.sha!==context.cycle.deliveryConfigSha
      ||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==source.sha)fail('original delivery evidence required');
    return {delivery:parseDeliveryConfig(JSON.parse(bytes.toString('utf8'))),legacy:null};
  }catch(error) {
    if (!((error instanceof EvidenceReadError) && error.status === 404)) throw error;
    const proofs=records.filter(r=>r.path.startsWith('evidence/normalized-delivery/')&&(r.value as {cycleId?:string})?.cycleId===context.cycle.id).map(r=>verifyNormalizedDelivery(context,r));
    if(!proofs.length)fail('NORMALIZED_DELIVERY_EVIDENCE_REQUIRED');
    if(proofs.some(proof=>JSON.stringify({...proof,observedAt:''})!==JSON.stringify({...proofs[0],observedAt:''})))fail('conflicting normalized delivery evidence');
    proofs.sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
    return {delivery:proofs[0]!.normalizedDelivery,legacy:proofs[0]!};
  }
}
/** Read the exact original S/C sources before producing a historical projection for protected Git adoption. */
export async function prepareNormalizedDelivery(context:EvidenceContext,io:EvidenceTransport,controllerIo:EvidenceTransport,observedAt:string) {
  const source=async(repository:string,ref:string,path:string,transport:EvidenceTransport)=>{
    const raw=await new NativeEvidenceReader(transport,repository).json(`contents/${path}?ref=${ref}`),bytes=Buffer.from(raw.content??'','base64');
    if(raw.type!=='file'||raw.encoding!=='base64'||raw.size!==bytes.length||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==raw.sha)fail('legacy native source');
    return {blobSha:raw.sha as string,content:bytes.toString('utf8')};
  };
  const descriptor=await source(context.repository,context.cycle.sourceSha,'.github/steward-release.json',io),
    catalog=await source('splrad/steward',context.cycle.controllerSha,'config/repositories.json',controllerIo),reader=new NativeEvidenceReader(io,context.repository);
  const manifests:{unitId:string;content:string}[]=[];
  for(const unit of context.cycle.units) {
    if(unit.releaseId===null||unit.manifestDigest===null)fail('legacy frozen release required');
    const release=await reader.json(`releases/${unit.releaseId}`),assets=await reader.pages(`releases/${unit.releaseId}/assets`,'');
    if(release.id!==unit.releaseId||release.tag_name!==unit.tag||release.author?.id!==context.appBotId)fail('legacy native release');
    const found=assets.filter(a=>a.name==='artifact-manifest.json');if(found.length!==1||found[0].state!=='uploaded')fail('legacy native manifest');
    const response=await reader.response(`releases/assets/${found[0].id}`,2*1024*1024);
    if(response.status!==200||hash(Buffer.from(response.bytes))!==unit.manifestDigest||response.bytes.length!==found[0].size)fail('legacy manifest bytes');
    manifests.push({unitId:unit.id,content:Buffer.from(response.bytes).toString('utf8')});
  }
  return normalizedDeliveryFile(normalizeLegacyDelivery(context,descriptor,catalog,manifests,observedAt));
}
export async function pipelineChannelIdentity(inputs:ProductChannelInputs,state:ProductBuildInput['state'],environment:NodeJS.ProcessEnv,
  gh:GhCommand=nativeGhCommand,io:EvidenceTransport=nativeEvidenceTransport(process.env.GH_TOKEN),stage:'source'|'admit'='admit') {
  if(Object.keys(inputs).sort().join(',')!=='controller_sha,cycle_id,execution_sha,mode,operation_key,request_key,source_sha,targets_json'
    ||!['submit','verify','observe'].includes(inputs.mode))fail('closed channel inputs');
  const repositoryId=Number(environment.GITHUB_REPOSITORY_ID),runId=Number(environment.GITHUB_RUN_ID),attempt=Number(environment.GITHUB_RUN_ATTEMPT),fullName=environment.GITHUB_REPOSITORY!;
  const cycle=parseReleaseRecord('cycle',state.cycles.find(value=>value.value.id===inputs.cycle_id)?.value), repository=parseReleaseRecord('repository',state.repository);
  const reader=new NativeEvidenceReader(io,fullName),actual=await reader.json(''),bot=JSON.parse(await gh(['api','users/splrad-steward%5Bbot%5D']));
  const stateRef=async()=> (await reader.json('git/ref/heads/steward/release-state')).object?.sha===state.head;
  if(repository.repositoryId!==repositoryId||actual.id!==repositoryId||actual.full_name!==fullName||actual.archived!==false||actual.disabled!==false
    ||actual.default_branch!==repository.defaultBranch||inputs.source_sha!==cycle.sourceSha||inputs.controller_sha!==cycle.controllerSha
    ||environment.GITHUB_EVENT_NAME!=='workflow_dispatch'||environment.GITHUB_REF!==`refs/heads/${actual.default_branch}`
    ||bot.type!=='Bot'||bot.login!=='splrad-steward[bot]'||!Number.isSafeInteger(bot.id))fail('channel source identity');
  const context={repository:fullName,repositoryId,appBotId:bot.id,cycle}, targets=channelTargets(context,JSON.parse(inputs.targets_json));
  const run=nativeRunFact(await reader.json(`actions/runs/${runId}`));
  if(run.repositoryId!==repositoryId||run.headRepositoryId!==repositoryId||run.path!=='.github/workflows/steward-release-channels.yml'
    ||run.headBranch!==actual.default_branch||run.event!=='workflow_dispatch'||run.runAttempt!==attempt||run.actorId!==bot.id)fail('channel native execution');
  if(run.headSha!==inputs.execution_sha||environment.GITHUB_SHA!==inputs.execution_sha)return {status:'REJECTED' as const,reason:'SOURCE_REF_MOVED'};
  if(!await stateRef())return {status:'UNKNOWN' as const,reason:'STATE_SOURCE_MOVED'};
  const {delivery}=await readCycleDelivery(context,state.domainRecords,io);
  assertProductDelivery(delivery);
  for(const target of targets)if(!delivery.units.some(unit=>unit.id===target.unitId&&unit.channels.some(channel=>channel.id===target.channelId)))fail('undeclared channel');
  const digest=channelTargetsDigest(context,targets);
  if(inputs.mode==='observe') {
    if(inputs.operation_key!==digest||inputs.request_key!==hash(Buffer.from(JSON.stringify(['observe',digest,inputs.execution_sha])))
      ||!run.displayTitle.includes(inputs.request_key))fail('probe request identity');
    if(!await stateRef())return {status:'UNKNOWN' as const,reason:'STATE_SOURCE_MOVED'};
    return {status:'OBSERVE' as const,context,targets,delivery,run,request:null,targetsDigest:digest};
  }
  if(stage==='source')return {status:'SOURCE' as const,context,targets,delivery,run,request:null,targetsDigest:digest};
  const request=cycle.dispatches.find(value=>value.requestKey===inputs.request_key);
  if(!request||request.purpose!==`channel-${inputs.mode}`||request.operationKey!==inputs.operation_key
    ||Object.keys(inputs).some(key=>request.inputs[key]!==inputs[key as keyof ProductChannelInputs]))fail('channel request identity');
  if(request.canonicalRunId===null)return {status:'NOT_BOUND' as const,reason:'NATIVE_BINDING_PENDING'};
  if(request.canonicalRunId!==run.id)return {status:'REJECTED' as const,reason:'NON_CANONICAL_RUN'};
  verifyExecutionSource(run,{...context,request});
  if(!await stateRef())return {status:'UNKNOWN' as const,reason:'STATE_SOURCE_MOVED'};
  return {status:'ADMITTED' as const,context,targets,delivery,run,request,targetsDigest:digest};
}

export async function pipelineChannelDownload(context:EvidenceContext,target:ChannelTarget,directory:string,gh:GhCommand=nativeGhCommand,
  download:ReleaseDownload=nativeReleaseDownload(process.env.GH_TOKEN)) {
  channelTargets(context,[target]);const unit=context.cycle.units.find(unit=>unit.id===target.unitId)!;
  const anonymous=await releaseReadIsAnonymous(gh,context.repository,context.repositoryId);
  const pages=JSON.parse(await gh(['api','--paginate','--slurp',`repos/${context.repository}/releases/${target.releaseId}/assets?per_page=100`]));
  if(!Array.isArray(pages)||!pages.length||pages.some(page=>!Array.isArray(page)))fail('formal asset pages');
  const assets=pages.flat();
  if(assets.length!==unit.assets.length||new Set(assets.map(asset=>asset.id)).size!==assets.length
    ||new Set(assets.map(asset=>asset.name)).size!==assets.length||assets.some(asset=>!unit.assets.some(expected=>expected.path===asset.name&&expected.size===asset.size)||asset.state!=='uploaded'))fail('formal asset mapping');
  await mkdir(directory);
  for(const asset of assets) {
    await download(context.repository,asset.id,join(directory,asset.name),anonymous);
    const actual=await fileDigest(directory,asset.name),expected=unit.assets.find(value=>value.path===asset.name)!;
    if(actual.sha256!==expected.sha256||actual.size!==expected.size)fail('formal bytes conflict');
  }
  const manifest:unknown=JSON.parse(await readFile(join(directory,'artifact-manifest.json'),'utf8'));
  if((manifest as {schemaVersion:number}).schemaVersion===3)validateProductManifest(manifest);else validateReleaseManifest(manifest);
  const m=manifest as ProductReleaseManifest|ReleaseManifest;
  if(m.repositoryId!==context.repositoryId||m.fullName!==context.repository||m.sourceSha!==context.cycle.sourceSha||m.unitId!==target.unitId
    ||m.tag!==unit.tag||m.version!==unit.version||(m.schemaVersion===3?m.controllerSha:m.policySha)!==context.cycle.controllerSha
    ||(await fileDigest(directory,'artifact-manifest.json')).sha256!==target.manifestDigest)fail('formal manifest source');
  await new NativeGitHubRelease(gh,download).verify({manifest:m,directory,releaseId:target.releaseId,appBotId:context.appBotId});
  return m;
}
/** These are the external channels implemented by the fixed product workflow and native CLI. */
export function assertProductDelivery(delivery:Pick<DeliveryConfig,'units'>,repository?:string) {
  for(const unit of delivery.units)for(const channel of unit.channels)
    if(channel.id!=='ghcr-assets'&&channel.id!=='winget')fail('channel has no fixed product implementation');
  if(repository==='splrad/LayerScape'&&(delivery.units.length!==1||delivery.units[0]!.id!=='layerscape'
    ||delivery.units[0]!.channels.length!==2||!['ghcr-assets','winget'].every(id=>delivery.units[0]!.channels.some(channel=>channel.id===id&&channel.required))))
    fail('LayerScape required delivery obligations');
}
/** The merged source is eligible only when its full Git tree matches the reviewed candidate. */
export function mergedBuildCycle(input: { prNumber: number; sourceSha: string; controllerSha: string; sourceTree: string; reviewedTree: string;
  deliveryBlobSha: string; delivery: unknown; units: { id: string; path: string; version: string; tag: string }[]; repository?:string }): CycleRecord {
  if (![input.sourceSha, input.controllerSha, input.sourceTree, input.reviewedTree, input.deliveryBlobSha].every(sha => /^[a-f0-9]{40}$/.test(sha))
    || input.sourceTree !== input.reviewedTree || !input.units.length) fail('merged product tree differs from reviewed source');
  const delivery = parseDeliveryConfig(input.delivery);
  assertProductDelivery(delivery,input.repository);
  if(new Set(input.units.map(unit=>unit.id)).size!==input.units.length||new Set(input.units.map(unit=>unit.path)).size!==input.units.length)fail('merged duplicate unit mapping');
  for (const unit of input.units) if (!delivery.units.some(value => value.id === unit.id && value.path === unit.path)) fail('merged unit source');
  return parseReleaseRecord('cycle', { id: `pr-${input.prNumber}-${input.sourceSha}`, prNumber: input.prNumber, sourceSha: input.sourceSha,
    controllerSha: input.controllerSha, deliveryConfigSha: input.deliveryBlobSha,
    units: input.units.map(unit => ({ id: unit.id, version: unit.version, tag: unit.tag, releaseId: null, assets: [], notesDigest: null, manifestDigest: null })),
    requiredChannels: delivery.units.filter(unit => input.units.some(value => value.id === unit.id)).flatMap(unit => unit.channels.filter(channel => channel.required).map(channel => ({ unitId: unit.id, channelId: channel.id }))),
    dispatches: [], publications: [], channelFacts: [], executionEvidence: [], completionObservations: [], completedEvidencePath: null, repairOf: null, approvedRepairDecision: null });
}
/** The build admission and central freeze recovery derive the same native versions and source locks from S. */
async function nativeDeliveryProjection(delivery:DeliveryConfig,targets:CycleRecord['units'],source:(path:string)=>Promise<Buffer>,controllerDirectory:string) {
  const settings=JSON.parse((await source('release-please-config.json')).toString('utf8'));
  const manifest=JSON.parse((await source('.release-please-manifest.json')).toString('utf8'));
  if(JSON.stringify(Object.keys(settings.packages??{}).sort())!==JSON.stringify(delivery.units.map(unit=>unit.path).sort())
    ||JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify(delivery.units.map(unit=>unit.path).sort()))fail('Release Please delivery paths');
  const versions=new Map<string,string>(),toolLocks:Record<string,string>={};
  for(const target of targets) {
    const unit=delivery.units.find(unit=>unit.id===target.id);
    if(!unit||versions.has(unit.id)||manifest[unit.path]!==target.version)fail('native version source');
    const options={...settings,...settings.packages[unit.path]},component=options['include-component-in-tag']===false?undefined:options.component;
    if(options['include-component-in-tag']!==false&&!component)fail('native tag component');
    if(new TagName(Version.parse(target.version),component,options['tag-separator'],options['include-v-in-tag']).toString()!==target.tag)fail('native tag source');
    const path=(name:string)=>{assertDeliveryPath(name);return unit.path==='.'?name:`${unit.path}/${name}`;};
    let packageVersion=target.version,lock:string;
    if(options['release-type']==='simple') {
      if((await source(path(options['version-file']))).toString('utf8').trim()!==target.version)fail('native version projection');
      lock='global.json';
    } else if(options['release-type']==='node') {
      packageVersion=JSON.parse((await source(path('package.json'))).toString('utf8')).version;
      if(packageVersion!==target.version)fail('native version projection');
      lock=path('package-lock.json');
    } else if(options['release-type']==='python') {
      packageVersion=await nativePythonSourceVersion(controllerDirectory,await source(path('pyproject.toml')),target.version);
      lock=path('requirements-build.txt');
    } else fail('native package version evidence required');
    const bytes=await source(lock);if(!bytes.length)fail('empty source lock');toolLocks[`source/${lock}`]=hash(bytes);
    versions.set(unit.id,packageVersion);
  }
  return {versions,toolLocks};
}
/** Read-only admission: no release/tag lookup, controller catalog, state write or future attempt allocation. */
export async function pipelineIdentity(input: ProductBuildInput, environment: NodeJS.ProcessEnv = process.env,
  gh: GhCommand = nativeGhCommand, io: EvidenceTransport = nativeEvidenceTransport(process.env.GH_TOKEN)) {
  const repositoryId = positive(environment.GITHUB_REPOSITORY_ID), runId = positive(environment.GITHUB_RUN_ID), runAttempt = positive(environment.GITHUB_RUN_ATTEMPT);
  const fullName = environment.GITHUB_REPOSITORY;
  if (!fullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || fullName.split('/').some(part => part === '.' || part === '..')
    || ![input.sourceSha, input.controllerSha, input.state.head].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('source identity');
  const read = async (path: string) => JSON.parse(await gh(['api', '--method', 'GET', path]));
  const stateRef = async () => {
    const ref = await read(`repos/${fullName}/git/ref/heads/steward/release-state`);
    if (ref.ref !== 'refs/heads/steward/release-state' || ref.object?.type !== 'commit' || ref.object.sha !== input.state.head) return false;
    return true;
  };
  if (!await stateRef()) return { status: 'UNKNOWN' as const, reason: 'STATE_SOURCE_MOVED' };
  const repository = parseReleaseRecord('repository', input.state.repository);
  const cycle = parseReleaseRecord('cycle', input.state.cycles.find(item => item.value.id === input.cycleId)?.value);
  if (repository.repositoryId !== repositoryId || cycle.sourceSha !== input.sourceSha
    || cycle.controllerSha !== input.controllerSha || environment.GITHUB_SHA !== cycle.sourceSha || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_REF !== `refs/heads/steward/build/${cycle.id}`) fail('current build source');
  const matches = cycle.dispatches.filter(item => item.purpose === 'build' && item.operationKey === input.operationKey);
  if (matches.length !== 1) fail('build request identity');
  const request = matches[0]!;
  if (request.canonicalRunId === null) return { status: 'NOT_BOUND' as const, reason: 'NATIVE_BINDING_PENDING' };
  if (request.canonicalRunId !== runId) return { status: 'REJECTED' as const, reason: 'NON_CANONICAL_RUN' };
  const bot = await read('users/splrad-steward%5Bbot%5D');
  if (bot.type !== 'Bot' || bot.login !== 'splrad-steward[bot]' || !Number.isSafeInteger(bot.id) || bot.id < 1) fail('App bot native user');
  const context = { repository: fullName, repositoryId, appBotId: bot.id, cycle };
  const run = verifyExecutionSource(nativeRunFact(await read(`repos/${fullName}/actions/runs/${runId}`)), { ...context, request });
  if (run.runAttempt !== runAttempt) return { status: 'REJECTED' as const, reason: 'ACTOR_REJECTED' };
  const ref = await read(`repos/${fullName}/git/ref/heads/${request.ref}`);
  if (ref.ref !== `refs/heads/${request.ref}` || ref.object?.type !== 'commit' || ref.object.sha !== cycle.sourceSha) fail('SOURCE_REF_MOVED');
  if (await localGitSnapshot.head(input.sourceDirectory) !== cycle.sourceSha || await localGitSnapshot.head(input.controllerDirectory) !== cycle.controllerSha)
    fail('checkout source identity');
  const file = async (directory: string, sha: string, path: string) => {
    const bytes = await localGitSnapshot.file(directory, sha, path); if (!bytes) fail('missing source input: ' + path); return bytes;
  };
  const source = (path: string) => file(input.sourceDirectory, cycle.sourceSha, path);
  const deliveryBytes = await source('.github/delivery.json'), delivery = parseDeliveryConfig(JSON.parse(deliveryBytes.toString('utf8')));
  assertProductDelivery(delivery,fullName);
  if (createHash('sha1').update(`blob ${deliveryBytes.length}\0`).update(deliveryBytes).digest('hex') !== cycle.deliveryConfigSha) fail('delivery source blob');
  const workflowBytes = await source('.github/workflows/steward-release-publish.yml'); verifyDispatchWorkflow(workflowBytes, request);
  const document = parseDocument(workflowBytes.toString('utf8'), { uniqueKeys: true });
  if (document.errors.length) fail('product YAML');
  const workflow = document.toJS({ maxAliasCount: 0 }), matrix = workflow?.jobs?.build?.strategy?.matrix?.include;
  if (!Array.isArray(matrix) || !matrix.length || matrix.some(row => !row || Object.keys(row).sort().join(',') !== 'assets,target,unit'
    || !/^[a-z][a-z0-9-]*$/.test(row.target) || !Array.isArray(row.assets) || !row.assets.length)) fail('native producer matrix');
  const projection=await nativeDeliveryProjection(delivery,cycle.units,source,input.controllerDirectory);
  const mergedChunks=input.state.domainRecords.filter(item=>item.value?.documentKind==='merged-candidate'
    && new RegExp(`/cycles/${cycle.id}(?:-[1-9][0-9]*)?\\.json$`).test(item.path)).map(item=>item.value as CandidateArchiveChunk);
  let session;
  if(mergedChunks.length) {
    const merged=await decodeCandidateDocument(mergedChunks);
    if(merged.cycleId!==cycle.id || merged.sourceSha!==cycle.sourceSha || merged.pull.number!==cycle.prNumber)fail('candidate identity archive');
    session=merged.session;
  } else {
    const candidate=repository.candidate;
    if(!candidate || candidate.prNumber!==cycle.prNumber)fail('candidate identity archive');
    session=await decodeCandidateDocument(input.state.domainRecords.filter(item=>new RegExp(`^generated/${candidate.id}/session(?:-[1-9][0-9]*)?\\.json$`).test(item.path))
      .map(item=>item.value as CandidateArchiveChunk));
  }
  if(!session.identity || !session.generated || session.pending || session.identity.authorsDigest!==hash(Buffer.from(JSON.stringify(delivery.repositoryAuthors))))
    fail('frozen candidate identities');
  if (JSON.stringify(cycle.units.map(unit => unit.id).sort()) !== JSON.stringify(session.generated.units.map((unit: { id: string }) => unit.id).sort())) fail('candidate release unit set');
  const template = await source('.github/release-template.md.mustache');
  if (!template.equals(await file(input.controllerDirectory, cycle.controllerSha, 'templates/repository/.github/release-template.md.mustache'))) fail('adopted notes template');
  const units: BuildPipelineRecord['units'] = [];
  for (const target of cycle.units) {
    const unit = delivery.units.find(unit => unit.id === target.id), frozen = session.generated.units.find((unit: any) => unit.id === target.id);
    if (!unit || !frozen || frozen.version !== target.version || frozen.tag !== target.tag) fail('native version source');
    const packageVersion=projection.versions.get(unit.id)!;
    const rows = matrix.filter(row => row.unit === unit.id);
    const builds = rows.map(row => ({ id: row.target as string, jobName: `build/${row.target}/${unit.id}`, expectedArtifacts: row.assets as string[] }));
    const assets = [...deliveryAssetNames(unit, target.version, packageVersion)].map(([id, name]) => {
      const producers = builds.filter(build => build.expectedArtifacts.includes(id)); if (producers.length !== 1) fail('native asset producer');
      return { id, name, build: producers[0]!.id };
    });
    const identity = session.identity.units.find((item: any) => item.id === unit.id); if (!identity) fail('unit identity snapshot');
    const selected = selectReleaseContributors(identity.actors, delivery.repositoryAuthors);
    if (JSON.stringify(selected) !== JSON.stringify(identity.contributors)) fail('frozen identity mismatch');
    units.push({ id: unit.id, version: target.version, packageVersion, tag: target.tag, builds, assets, contributors: selected.contributors });
  }
  if (matrix.some(row => !delivery.units.some(unit => unit.id === row.unit))) fail('unknown matrix unit');
  const toolLocks:Record<string,string>={'controller/mise.lock':hash(await file(input.controllerDirectory,cycle.controllerSha,'mise.lock')),...projection.toolLocks};
  if (!await stateRef()) return { status: 'UNKNOWN' as const, reason: 'STATE_SOURCE_MOVED' };
  const record = parsePipelineRecord({ schemaVersion: 1, kind: 'build', repositoryId, fullName, cycleId: cycle.id, requestKey: request.requestKey,
    sourceSha: cycle.sourceSha, controllerSha: cycle.controllerSha, buildRef: environment.GITHUB_REF, runId, runAttempt, toolLocks, delivery,
    deliverySha256: hash(deliveryBytes), templateSha256: hash(template), units }) as BuildPipelineRecord;
  return { status: 'ADMITTED' as const, record };
}

export async function pipelineNotes(record: BuildPipelineRecord, unitId: string, sourceDirectory: string) {
  const unit = record.units.find(unit => unit.id === unitId), delivery = record.delivery.units.find(unit => unit.id === unitId);
  if (!unit || !delivery) fail('notes unit');
  const read = async (path: string) => { const bytes = await localGitSnapshot.file(sourceDirectory, record.sourceSha, path); if (!bytes) fail('missing notes source'); return bytes.toString('utf8'); };
  const settings = JSON.parse(await read('release-please-config.json')), options = { ...settings, ...settings.packages[delivery.path] };
  const changelogPath = options['changelog-path'] ?? 'CHANGELOG.md'; assertDeliveryPath(changelogPath);
  const changelog = await read(delivery.path === '.' ? changelogPath : `${delivery.path}/${changelogPath}`);
  const { sourceLinkLabel, sourceUrl, commitUrl } = committedVersionNotes(changelog, unit.version, record.fullName, record.sourceSha, unit.tag);
  const template = await read('.github/release-template.md.mustache'); if (hash(Buffer.from(template)) !== record.templateSha256) fail('notes template source');
  return renderFrozenReleaseNotes(template, { repository: record.fullName, unitId, version: unit.version, tag: unit.tag, sourceSha: record.sourceSha,
    controllerSha: record.controllerSha, notes: await read(delivery.notesPath), sourceLinkLabel, sourceUrl, commitUrl, contributors: unit.contributors,
    repositoryAuthors: record.delivery.repositoryAuthors, assets: unit.assets, channels: delivery.channels });
}
export async function pipelineInspect(record: BuildPipelineRecord, unitId: string, selection: Awaited<ReturnType<typeof pipelineProducers>>,
  directory: string, controllerDirectory: string, home: string) {
  const source = pipelineSource(record, unitId), unit = record.delivery.units.find(unit => unit.id === unitId)!;
  if (selection.producers.length !== source.unit.builds.length || new Set(selection.producers.map(producer => producer.buildId)).size !== source.unit.builds.length
    || selection.producers.some(producer => !source.unit.builds.some(build => build.id === producer.buildId) || (producer.runId??record.runId)===record.runId && producer.attempt > record.runAttempt)) fail('producer set');
  await mkdir(home, { recursive: false });
  const inspector = nativeReleaseInspector(join(controllerDirectory, 'scripts/inspect-native-release.ps1'), home);
  return inspectProductArtifacts(unit, directory, { repositoryId: record.repositoryId, fullName: record.fullName, unitId, cycleId: record.cycleId,
    requestKey: record.requestKey, version: source.unit.version, packageVersion: source.unit.packageVersion, tag: source.unit.tag,
    sourceSha: record.sourceSha, controllerSha: record.controllerSha, buildRef: record.buildRef, deliverySha256: record.deliverySha256,
    templateSha256: record.templateSha256, runId: record.runId, attempt: record.runAttempt, toolLocks: record.toolLocks, producers: selection.producers },
  path => inspector.inspectPath!(path) as Promise<string | { resourceOnly: 'font-archive' }>);
}

function fail(reason: string): never { throw new Error(`RELEASE_PIPELINE: ${reason}`); }
const positive = (value: string | undefined) => { if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('positive native ID'); return Number(value); };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type NativePages = (path: string, collection: 'jobs' | 'artifacts') => Promise<any[]>;
/** Official pagination reads one response at a time, outside gh's aggregate stdout limit. */
export async function nativePages(path: string, collection: 'jobs' | 'artifacts', client?: Octokit): Promise<any[]> {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/(?:artifacts|attempts\/[1-9][0-9]*\/jobs)\?per_page=100$/.test(path)
    || path.split('/').some(part => part === '.' || part === '..') || !path.endsWith(`/${collection}?per_page=100`)) fail('pagination endpoint');
  if (!client) {
    const token = process.env.GH_TOKEN;
    if (!token?.trim() || /[\r\n\0]/.test(token)) fail('pagination credential');
    client = new Octokit({ auth: token, request: { timeout: 120_000 },
      log: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  const result: any[] = [], ids = new Set<number>();
  let total: number | undefined;
  const request = client.request;
  const expectedUrl = new URL(request.endpoint(`GET /${path}`).url);
  const checkedRequest = Object.assign(async (options: Parameters<typeof request>[0]) => {
    const url = new URL(request.endpoint(options).url);
    if (url.origin !== expectedUrl.origin || url.pathname !== expectedUrl.pathname) fail('pagination link left collection');
    const response = await request(options);
    if (!response.data || !Array.isArray(response.data[collection])) fail('pagination collection');
    return response;
  }, request);
  for await (const response of client.paginate.iterator(checkedRequest, `GET /${path}`)) {
    const rows = response.data as unknown as any[] & { total_count?: number; incomplete_results?: boolean };
    if (!Array.isArray(rows) || !Number.isSafeInteger(rows.total_count) || rows.total_count! < 0
      || rows.incomplete_results === true || total !== undefined && rows.total_count !== total) fail('pagination');
    total = rows.total_count;
    for (const row of rows) {
      if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)) fail('duplicate or invalid pagination ID');
      ids.add(row.id); result.push(row);
    }
    if (result.length > total!) fail('pagination count');
  }
  if (total === undefined || result.length !== total) fail('incomplete pagination');
  return result;
}
export async function pipelineProducers(record: PipelineSource, gh: GhCommand = nativeGhCommand, pages: NativePages = nativePages) {
  assertPipelineSource(record);
  const run = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/runs/${record.runId}`]));
  if (run.id !== record.runId || run.repository?.id !== record.repositoryId || run.head_repository?.id !== record.repositoryId
    || run.head_sha !== record.sourceSha || run.event !== record.event || run.run_attempt !== record.attempt) fail('run identity');
  const jobs: Parameters<typeof selectReleaseProducers>[2]['jobs'] = [];
  const attempts: NativeJobAttempt[] = [];
  for (let attempt = 1; attempt <= record.attempt; attempt++) {
    const native = await pages(`repos/${record.fullName}/actions/runs/${record.runId}/attempts/${attempt}/jobs?per_page=100`, 'jobs');
    if (native.some(job => job.run_id !== record.runId || job.head_sha !== record.sourceSha || job.run_attempt !== attempt)) fail('producer job source');
    attempts.push({ attempt, jobs: native.map(jobFact) });
  }
    for (const job of originalJobExecutions(attempts)) {
      const build = record.unit.builds.find(build => job.name === build.jobName); if (!build) continue;
      jobs.push({ id: job.id, runId: job.runId, attempt: job.runAttempt, buildId: build.id, sourceSha: job.headSha, controllerSha: record.controllerSha, status: job.status, conclusion: job.conclusion });
    }
  const artifacts = await pages(`repos/${record.fullName}/actions/runs/${record.runId}/artifacts?per_page=100`, 'artifacts');
  const after = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/runs/${record.runId}`]));
  for (const key of ['id', 'head_sha', 'event', 'run_attempt', 'status', 'updated_at']) {
    if (after[key] !== run[key]) fail('run changed during pagination; reread current run');
  }
  if (after.repository?.id !== record.repositoryId || after.head_repository?.id !== record.repositoryId) fail('run changed during pagination');
  return selectReleaseProducers(record.unit, { ...record, unitId: record.unit.id }, { complete: true, jobs,
    artifacts: artifacts.map(artifact => ({ id: artifact.id, name: artifact.name, runId: artifact.workflow_run?.id, expired: artifact.expired, digest: artifact.digest })) });
}
export async function pipelineCollect(record: PipelineSource, selection: Awaited<ReturnType<typeof pipelineProducers>>, rawDirectory: string, outputDirectory: string) {
  assertPipelineSource(record);
  await mkdir(outputDirectory, { recursive: false });
  const names = record.unit.assets;
  for (const producer of selection.producers) {
    const build = record.unit.builds.find(build => build.id === producer.buildId); if (!build) fail('unknown producer');
    const directory = join(rawDirectory, producerArtifactName({ ...record, runId:producer.runId??record.runId, unitId: record.unit.id }, build.id, producer.attempt));
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) fail('producer directory');
    const expected = build.expectedArtifacts.map(id => names.find(asset => asset.id === id)!.name).sort();
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('producer file set');
    for (const name of expected) { await fileDigest(directory, name); await copyFile(join(directory, name), join(outputDirectory, name), 1); }
  }
  if (JSON.stringify((await readdir(outputDirectory)).sort()) !== JSON.stringify(names.map(asset => asset.name).sort())) fail('collected file set');
}
export async function pipelineDownloadProducers(record: PipelineSource, selection: Awaited<ReturnType<typeof pipelineProducers>>, rawDirectory: string, policyDirectory: string, home: string) {
  assertPipelineSource(record);
  await mkdir(rawDirectory, { recursive: false }); await mkdir(home, { recursive: false });
  for (const producer of selection.producers) {
    const build = record.unit.builds.find(item => item.id === producer.buildId); if (!build) fail('unknown producer');
    await downloadNativeArtifact({ fullName: record.fullName, artifactId: producer.artifactId, digest: selection.digests[String(producer.artifactId)]!,
      names: build.expectedArtifacts.map(id => record.unit.assets.find(asset => asset.id === id)!.name),
      directory: join(rawDirectory, producerArtifactName({ ...record, runId:producer.runId??record.runId, unitId: record.unit.id }, build.id, producer.attempt)),
      policyDirectory, home: join(home, String(producer.artifactId)) });
  }
}
/** Validate frozen producer A/S against the retained build record; execution B/R cannot replace it. */
export async function pipelineFrozenManifest(record: BuildPipelineRecord, unitId: string, directory: string) {
  if (parsePipelineRecord(record).kind !== 'build') fail('build record required');
  const unit = record.units.find(value => value.id === unitId); if (!unit) return fail('unit identity');
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8')); validateProductManifest(manifest);
  if (manifest.repositoryId !== record.repositoryId || manifest.fullName !== record.fullName || manifest.unitId !== unitId
    || manifest.cycleId !== record.cycleId || manifest.requestKey !== record.requestKey || manifest.sourceSha !== record.sourceSha
    || manifest.controllerSha !== record.controllerSha || manifest.buildRef !== record.buildRef || manifest.runId !== record.runId
    || manifest.attempt > record.runAttempt || manifest.tag !== unit.tag || manifest.version !== unit.version || manifest.packageVersion !== unit.packageVersion
    || manifest.deliverySha256 !== record.deliverySha256 || manifest.templateSha256 !== record.templateSha256
    || JSON.stringify(manifest.toolLocks) !== JSON.stringify(record.toolLocks)) fail('final manifest identity');
  const mapping = (items: { id: string; name: string }[]) => JSON.stringify(items.map(item => [item.id, item.name]).sort());
  if (mapping(unit.assets) !== mapping(manifest.artifacts.map(asset => ({ id: asset.id, name: asset.path })))
    || manifest.producers.length !== unit.builds.length || new Set(manifest.producers.map(item => item.buildId)).size !== unit.builds.length
    || manifest.producers.some(item => !unit.builds.some(build => build.id === item.buildId) || (item.runId??manifest.runId)===manifest.runId && item.attempt > manifest.attempt)) fail('frozen producer mapping');
  await verifySealedArtifacts(directory, manifest); return manifest;
}
async function publicationTarget(record: PublishPipelineRecord, unitId: string, directory: string, appBotId: number) {
  if (parsePipelineRecord(record).kind !== 'publish') fail('publish record required');
  const release = record.releases.find(item => item.unitId === unitId); if (!release) return fail('release identity');
  const manifest = await pipelineFrozenManifest(record.build, unitId, directory);
  if ((await fileDigest(directory, 'artifact-manifest.json')).sha256 !== release.manifestDigest) fail('frozen manifest digest');
  return { manifest, directory, releaseId: release.releaseId, appBotId };
}
export async function pipelinePublish(record: PublishPipelineRecord, unitId: string, directory: string, appBotId: number,
  gh: GhCommand = nativeGhCommand, download: ReleaseDownload = nativeReleaseDownload(process.env.GH_TOKEN)) {
  return new NativeGitHubRelease(gh, download).publish(await publicationTarget(record, unitId, directory, appBotId));
}
/** This is also the exact-Release fallback when the original Actions artifact has expired. */
export async function pipelineVerifyPublished(record: PublishPipelineRecord, unitId: string, directory: string, appBotId: number,
  gh: GhCommand = nativeGhCommand, download: ReleaseDownload = nativeReleaseDownload(process.env.GH_TOKEN)) {
  if (parsePipelineRecord(record).kind !== 'publish') fail('publish record required');
  const binding = record.releases.find(value => value.unitId === unitId), unit = record.build.units.find(value => value.id === unitId);
  if (!binding || !unit) return fail('published unit identity');
  const fullName = record.build.fullName, release = JSON.parse(await gh(['api', `repos/${fullName}/releases/${binding.releaseId}`]));
  if (release.id !== binding.releaseId || release.tag_name !== unit.tag || release.author?.id !== appBotId
    || release.draft !== false || release.immutable !== true) fail('published release identity');
  const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${fullName}/releases/${binding.releaseId}/assets?per_page=100`]));
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) fail('release asset inventory');
  const assets = pages.flat(), names = [...unit.assets.map(asset => asset.name), 'sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'].sort();
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names) || new Set(assets.map(asset => asset.id)).size !== assets.length
    || assets.some(asset => !Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== 'uploaded')) fail('release asset set');
  const anonymous=await releaseReadIsAnonymous(gh,fullName,record.build.repositoryId);
  await mkdir(directory, { recursive: false });
  for (const asset of assets) await download(fullName, asset.id, join(directory, asset.name), anonymous);
  return new NativeGitHubRelease(gh, download).verify(await publicationTarget(record, unitId, directory, appBotId));
}

/** Central preparation only reads S, exact native freeze objects and formal Release bytes. */
export async function pipelinePreparePublication(context: EvidenceContext, root: string, controllerDirectory: string, token: string,
  gh: GhCommand = args => nativeGhCommand(args, token), io: EvidenceTransport = nativeEvidenceTransport(token),
  controllerIo:EvidenceTransport=nativeEvidenceTransport(undefined),download:ReleaseDownload=nativeReleaseDownload(token),
  history:{path:string;commit:string;value:unknown}[]=[]) {
  const { cycle } = context, reader = new NativeEvidenceReader(io, context.repository);
  const original=await readCycleDelivery(context,history,io);
  if(original.legacy) {
    const records:{build:null;unitId:string;directory:string;manifest:ReleaseManifest}[]=[];
    for(const unit of cycle.units) {
      if(unit.releaseId===null)fail('legacy existing release required');
      const manifest:unknown=JSON.parse(original.legacy.manifests.find(m=>m.unitId===unit.id)!.content);validateReleaseManifest(manifest);
      const release=await reader.json(`releases/${unit.releaseId}`),assets=await reader.pages(`releases/${unit.releaseId}/assets`,'');
      if(release.id!==unit.releaseId||release.tag_name!==unit.tag||release.author?.id!==context.appBotId
        ||JSON.stringify(assets.map(a=>a.name).sort())!==JSON.stringify(unit.assets.map(a=>a.path).sort())||assets.some(a=>a.state!=='uploaded'))fail('legacy release asset identity');
      const directory=join(root,unit.id);await mkdir(directory);
      const anonymous=release.draft===false&&await releaseReadIsAnonymous(gh,context.repository,context.repositoryId);
      for(const asset of assets)await download(context.repository,asset.id,join(directory,asset.name),anonymous);
      await verifySealedArtifacts(directory,manifest);
      if((await fileDigest(directory,'artifact-manifest.json')).sha256!==unit.manifestDigest)fail('legacy manifest changed');
      records.push({build:null,unitId:unit.id,directory,manifest});
    }
    return records;
  }
  const source = async (repository: string, sha: string, path: string) => {
    const value = await new NativeEvidenceReader(repository === context.repository ? io : controllerIo, repository).json(`contents/${path}?ref=${sha}`);
    if (value.type !== 'file' || value.encoding !== 'base64') fail('source file identity');
    const bytes = Buffer.from(value.content, 'base64');
    if (bytes.length !== value.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== value.sha) fail('source blob digest');
    return { bytes, sha: value.sha };
  };
  const deliverySource = await source(context.repository, cycle.sourceSha, '.github/delivery.json');
  if (deliverySource.sha !== cycle.deliveryConfigSha) fail('frozen delivery source');
  const delivery = parseDeliveryConfig(JSON.parse(deliverySource.bytes.toString('utf8')));
  assertProductDelivery(delivery,context.repository);
  const template = await source(context.repository, cycle.sourceSha, '.github/release-template.md.mustache');
  const workflow = await source(context.repository, cycle.sourceSha, '.github/workflows/steward-release-publish.yml');
  const document = parseDocument(workflow.bytes.toString('utf8'), { uniqueKeys: true }); if (document.errors.length) fail('source workflow');
  const matrix = document.toJS({ maxAliasCount: 0 })?.jobs?.build?.strategy?.matrix?.include;
  if (!Array.isArray(matrix) || !matrix.length) fail('native producer matrix');
  const projection=await nativeDeliveryProjection(delivery,cycle.units,async path=>(await source(context.repository,cycle.sourceSha,path)).bytes,controllerDirectory);
  const toolLocks = { 'controller/mise.lock': hash((await source('splrad/steward', cycle.controllerSha, 'mise.lock')).bytes),...projection.toolLocks };
  const records: { build: BuildPipelineRecord; unitId: string; directory: string; manifest: ProductReleaseManifest }[] = [];
  const pages: NativePages = async (path, field) => {
    const prefix = `repos/${context.repository}/`; if (!path.startsWith(prefix)) fail('native page target');
    return reader.pages(path.slice(prefix.length).replace('?per_page=100', ''), field);
  };
  for (const unit of cycle.units) {
    const declared = delivery.units.find(value => value.id === unit.id); if (!declared) return fail('publication unit');
    const packageVersion=projection.versions.get(unit.id)!;
    const builds = matrix.filter(row => row.unit === unit.id).map(row => ({ id: row.target, jobName: `build/${row.target}/${unit.id}`, expectedArtifacts: row.assets }));
    const assets = [...deliveryAssetNames(declared, unit.version, packageVersion)].map(([id, name]) => {
      const producer = builds.filter(build => build.expectedArtifacts?.includes(id)); if (producer.length !== 1) fail('asset producer');
      return { id, name, build: producer[0]!.id };
    });
    const names = [...assets.map(asset => asset.name), 'sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'];
    const directory = join(root, unit.id), candidates: { source: PipelineSource; artifactId: number; digest: string }[] = [];
    let formal: any[] | null = null, anonymous=false;
    if (unit.releaseId !== null) {
      const release = await reader.json(`releases/${unit.releaseId}`), remote = await reader.pages(`releases/${unit.releaseId}/assets`, '');
      if (release.id !== unit.releaseId || release.tag_name !== unit.tag || release.author?.id !== context.appBotId) fail('bound release identity');
      if (JSON.stringify(remote.map(asset => asset.name).sort()) === JSON.stringify([...names].sort()) && remote.every(asset => asset.state === 'uploaded')) formal = remote;
      else if (!release.draft) fail('formal frozen bytes missing');
      if(formal!==null&&release.draft===false)anonymous=await releaseReadIsAnonymous(gh,context.repository,context.repositoryId);
    }
    if (formal === null) {
      const requests = cycle.dispatches.filter(value => value.purpose === 'build');
      if (!requests.length || requests.some(request => request.canonicalRunId === null))
        return {status:'WAIT' as const, reason:'BUILD_BINDING_REQUIRED', publishInvoked:false as const};
      for (const request of requests) {
        const run = verifyExecutionSource(nativeRunFact(await reader.json(`actions/runs/${request.canonicalRunId}`)), { ...context, request });
        if (run.status !== 'completed' || run.conclusion !== 'success')
          return {status:'WAIT' as const, reason:'BUILD_RUN_NOT_READY', publishInvoked:false as const};
        const pipeline: PipelineSource = { repositoryId: context.repositoryId, fullName: context.repository, sourceSha: cycle.sourceSha,
          controllerSha: cycle.controllerSha, runId: run.id, attempt: run.runAttempt, ref: `refs/heads/${request.ref}`, event: run.event, toolLocks,
          inspectJob: `freeze/${unit.id}`, unit: { id: unit.id, version: unit.version, packageVersion, tag: unit.tag,
            deliverySha256: hash(deliverySource.bytes), templateSha256: hash(template.bytes), builds, assets } };
        const frozen = await findFrozenFinal(pipeline, pages); if (frozen) candidates.push({ source: pipeline, ...frozen });
      }
      if (candidates.length !== 1) fail('unique final freeze required');
      const frozen = candidates[0]!;
      await pipelineDownloadPhase(frozen.source, frozen.artifactId, frozen.digest, 'final', directory, controllerDirectory, join(root, `download-${unit.id}`), gh, token);
    } else {
      // Once bound, the exact Release is the byte source even after Actions retention expires.
      await mkdir(directory);
      for (const asset of formal) await download(context.repository, asset.id, join(directory, asset.name), anonymous);
    }
    const m: unknown = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8')); validateProductManifest(m);
    const request = cycle.dispatches.find(value => value.requestKey === m.requestKey && value.canonicalRunId === m.runId && value.purpose === 'build');
    if (!request || m.cycleId !== cycle.id || m.sourceSha !== cycle.sourceSha || m.controllerSha !== cycle.controllerSha) fail('frozen canonical producer');
    const build = parsePipelineRecord({ schemaVersion: 1, kind: 'build', repositoryId: context.repositoryId, fullName: context.repository,
      cycleId: cycle.id, requestKey: request.requestKey, sourceSha: cycle.sourceSha, controllerSha: cycle.controllerSha, buildRef: `refs/heads/${request.ref}`,
      runId: m.runId, runAttempt: m.attempt, toolLocks, delivery, deliverySha256: hash(deliverySource.bytes), templateSha256: hash(template.bytes),
      units: [{ id: unit.id, version: unit.version, packageVersion, tag: unit.tag, builds, assets, contributors: [] }] }) as BuildPipelineRecord;
    await pipelineFrozenManifest(build, unit.id, directory);
    if (unit.manifestDigest !== null && unit.manifestDigest !== (await fileDigest(directory, 'artifact-manifest.json')).sha256) fail('frozen manifest changed');
    records.push({ build, unitId: unit.id, directory, manifest: m });
  }
  return records;
}
export async function pipelineDownloadPhase(record: PipelineSource, artifactId: number, digest: string, phase: 'collected' | 'evidence' | 'final', directory: string, policyDirectory: string, home: string, gh: GhCommand = nativeGhCommand, token: string | undefined = process.env.GH_TOKEN) {
  assertPipelineSource(record);
  if (!['collected', 'evidence', 'final'].includes(phase) || !Number.isSafeInteger(artifactId) || artifactId < 1) fail('phase artifact identity');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail('phase artifact source');
  const artifact = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/artifacts/${artifactId}`]));
  const prefix = `${phase}-${record.repositoryId}-${record.unit.id}-${record.sourceSha}-${record.runId}-`;
  const attempt = typeof artifact.name === 'string' && artifact.name.startsWith(prefix) ? artifact.name.slice(prefix.length) : '';
  if (artifact.id !== artifactId || artifact.workflow_run?.id !== record.runId || artifact.workflow_run?.head_sha !== record.sourceSha || artifact.expired !== false
    || !/^[1-9][0-9]*$/.test(attempt) || Number(attempt) > record.attempt || artifact.digest !== digest) fail('phase artifact source');
  const names = record.unit.assets.map(asset => asset.name);
  if (phase !== 'collected') names.push('sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS');
  await downloadNativeArtifact({ fullName: record.fullName, artifactId, digest, names, directory, policyDirectory, home }, token);
  if (phase !== 'collected') {
    const input: unknown = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8'));
    if ((input as { schemaVersion: number }).schemaVersion === 3) validateProductManifest(input); else validateReleaseManifest(input);
    const manifest = input as ReleaseManifest | ProductReleaseManifest;
    if (manifest.runId !== record.runId || manifest.attempt !== Number(attempt) || manifest.sourceSha !== record.sourceSha
      || (manifest.schemaVersion === 3 ? manifest.controllerSha : manifest.policySha) !== record.controllerSha
      || manifest.repositoryId !== record.repositoryId || manifest.fullName !== record.fullName || manifest.unitId !== record.unit.id || manifest.tag !== record.unit.tag
      || manifest.version !== record.unit.version || manifest.packageVersion !== record.unit.packageVersion
      || (manifest.schemaVersion === 3 ? manifest.deliverySha256 : manifest.descriptorSha256) !== record.unit.deliverySha256 || manifest.templateSha256 !== record.unit.templateSha256
      || JSON.stringify(manifest.toolLocks) !== JSON.stringify(record.toolLocks)) fail('downloaded manifest identity');
    const assetMapping = (assets: { id: string; name: string }[]) => assets.map(asset => [asset.id, asset.name]).sort((a, b) => a[0]!.localeCompare(b[0]!));
    if (JSON.stringify(assetMapping(record.unit.assets)) !== JSON.stringify(assetMapping(manifest.artifacts.map(asset => ({ id: asset.id, name: asset.path })))))
      fail('downloaded manifest asset mapping');
    if (manifest.producers.length !== record.unit.builds.length
      || new Set(manifest.producers.map(producer => producer.buildId)).size !== record.unit.builds.length
      || new Set(manifest.producers.map(producer => producer.jobId)).size !== manifest.producers.length
      || new Set(manifest.producers.map(producer => producer.artifactId)).size !== manifest.producers.length
      || manifest.producers.some(producer => !record.unit.builds.some(build => build.id === producer.buildId) || (producer.runId??manifest.runId)===manifest.runId && producer.attempt > manifest.attempt))
      fail('downloaded manifest producer mapping');
    await verifySealedArtifacts(directory, manifest);
  }
  return { artifactId, digest, phase, producerAttempt: Number(attempt) };
}

/** A previously uploaded final set is immutable even when its job response was lost. */
export async function findFrozenFinal(record: PipelineSource, pages: NativePages = nativePages, phase: 'final' | 'evidence' = 'final') {
  assertPipelineSource(record);
  const artifacts = await pages(`repos/${record.fullName}/actions/runs/${record.runId}/artifacts?per_page=100`, 'artifacts');
  const prefix = `${phase}-${record.repositoryId}-${record.unit.id}-${record.sourceSha}-${record.runId}-`;
  const candidates = artifacts.filter(artifact => typeof artifact.name === 'string' && artifact.name.startsWith(prefix));
  if (!candidates.length) return null;
  if (candidates.length !== 1) fail('ambiguous frozen final set');
  const candidate = candidates[0], attempt = candidate.name.slice(prefix.length);
  if (!Number.isSafeInteger(candidate.id) || candidate.id < 1 || candidate.workflow_run?.id !== record.runId
    || candidate.workflow_run?.head_sha !== record.sourceSha || candidate.expired !== false
    || !/^[1-9][0-9]*$/.test(attempt) || Number(attempt) > record.attempt || !/^sha256:[a-f0-9]{64}$/.test(candidate.digest)) fail('frozen final identity');
  // Build jobs can upload artifacts too: bind recovery to the completed trusted
  // inspect job's server timestamps, after every product build has terminated.
  const jobs = await pages(`repos/${record.fullName}/actions/runs/${record.runId}/attempts/${attempt}/jobs?per_page=100`, 'jobs');
  const inspections = jobs.filter(job => job.name === (phase === 'final' ? record.inspectJob : `evidence/${record.unit.id} / inspect`));
  if (inspections.length !== 1) fail('frozen inspect job identity');
  const inspection = inspections[0], created = Date.parse(candidate.created_at), started = Date.parse(inspection.started_at), completed = Date.parse(inspection.completed_at);
  if (!Number.isSafeInteger(inspection.id) || inspection.id < 1 || inspection.run_id !== record.runId || inspection.head_sha !== record.sourceSha || inspection.status !== 'completed'
    || ![created, started, completed].every(Number.isFinite) || started >= created || created > completed || Number(attempt) > record.attempt) fail('frozen inspect job provenance');
  return { artifactId: candidate.id as number, digest: candidate.digest as string };
}
export async function pipelineRecoverFinal(record: PipelineSource, directory: string, policyDirectory: string, home: string, gh: GhCommand = nativeGhCommand, pages: NativePages = nativePages) {
  const frozen = await findFrozenFinal(record, pages);
  if (!frozen) return { found: false as const };
  await pipelineDownloadPhase(record, frozen.artifactId, frozen.digest, 'final', directory, policyDirectory, home, gh);
  return { found: true as const, ...frozen };
}
/** A continuation consumes an earlier canonical freeze without changing its manifest or producer run. */
export async function pipelineRecoverCycleFinal(record: BuildPipelineRecord, unitId: string, cycle: CycleRecord,
  directory: string, controllerDirectory: string, home: string, gh: GhCommand = nativeGhCommand, pages: NativePages = nativePages) {
  if (cycle.id !== record.cycleId || cycle.sourceSha !== record.sourceSha || cycle.controllerSha !== record.controllerSha) fail('recovery cycle identity');
  const bot = JSON.parse(await gh(['api', '--method', 'GET', 'users/splrad-steward%5Bbot%5D']));
  if (bot.type !== 'Bot' || bot.login !== 'splrad-steward[bot]') fail('recovery native bot');
  const sources: PipelineSource[] = [], seen = new Set<number>();
  let runId: number | null = record.runId;
  while (runId !== null) {
    if (seen.has(runId)) fail('recovery continuation loop'); seen.add(runId);
    const requests = cycle.dispatches.filter(request => request.purpose === 'build' && request.canonicalRunId === runId);
    if (requests.length !== 1) fail('recovery canonical request');
    const request = requests[0]!;
    if (runId === record.runId && request.requestKey !== record.requestKey || request.inputs.controller_sha !== record.controllerSha) fail('recovery frozen request');
    const run = verifyExecutionSource(nativeRunFact(JSON.parse(await gh(['api', '--method', 'GET', `repos/${record.fullName}/actions/runs/${runId}`]))),
      { repository: record.fullName, repositoryId: record.repositoryId, appBotId: bot.id, cycle, request });
    if (run.id === record.runId && run.runAttempt !== record.runAttempt || run.id !== record.runId && run.status !== 'completed') fail('recovery native run state');
    const source = pipelineSource(record, unitId); source.runId = run.id; source.attempt = run.runAttempt;
    sources.push(source); runId = request.continuationOfRunId;
  }
  const candidates: { source: PipelineSource; artifactId: number; digest: string }[] = [];
  for (const source of sources) { const frozen = await findFrozenFinal(source, pages); if (frozen) candidates.push({ source, ...frozen }); }
  if (candidates.length > 1) fail('multiple frozen sets across continuation');
  if (!candidates.length) return { found: false as const };
  const frozen = candidates[0]!;
  await pipelineDownloadPhase(frozen.source, frozen.artifactId, frozen.digest, 'final', directory, controllerDirectory, home, gh);
  return { found: true as const, artifactId: frozen.artifactId, digest: frozen.digest, producerRunId: frozen.source.runId };
}
