import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, copyFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import registrations from '../../../config/release/event-repositories.json' with { type: 'json' };
import { nativeGhCommand, NativeGitHubRelease, nativeReleaseDownload, releaseReadIsAnonymous, type GhCommand, type ReleaseDownload } from './gh-release.js';
import { localGitSnapshot, safeGitPath } from './git-snapshot.js';
import { selectReleaseProducers, producerArtifactName } from './release-run.js';
import { jobFact } from './native-release-evidence.js';
import { originalJobExecutions, type NativeJobAttempt } from '../../core/src/native-job-origins.js';
import { verifySealedArtifacts, validateReleaseManifest, fileDigest, type ReleaseManifest } from './release-artifacts.js';
import { inspectDeclaredAsset, readNativeUnitVersion } from './release-native.js';
import { committedVersionNotes } from '../../core/src/release-template.js';
import { downloadNativeArtifact, downloadWorkflowArtifact } from './native-artifact-download.js';
import { Octokit } from '@octokit/rest';
import { assertPipelineSource, type PipelineSource, type PublishPipelineRecord } from './release-pipeline-record.js';
import { parsePipelineRecord, pipelineSource, type BuildPipelineRecord } from './release-pipeline-record.js';
import { channelFiles, parseDeliveryConfig, deliveryAssetNames, assertDeliveryPath, type DeliveryUnit, type DeliveryConfig } from '../../core/src/delivery-config.js';
import { defaultBuildWorkflow, dispatchWorkflow, encodeRepositoryPath, githubDeliveryJobStep, githubDeliveryStep } from '../../core/src/release-workflow.js';
import { parseReleaseDescriptor,artifactNames } from '../../core/src/release-descriptor.js';
import { parseLegacyRepositoryCatalog } from '../../core/src/legacy-repository-policy.js';
import { decodeNormalizedDelivery,type NormalizedDeliveryEvidence } from '../../core/src/native-evidence.js';
import { githubUnits, parseReleaseRecord, sameWorkflowDelivery, type CycleRecord, type RepositoryRecord, type WorkflowDeliveryReceipt } from '../../core/src/release-observation.js';
import { decodeCandidateDocument, type CandidateArchiveChunk } from '../../core/src/release-candidate-record.js';
import { selectReleaseContributors } from '../../core/src/release-candidate.js';
import { nativeRunFact, NativeEvidenceReader, EvidenceReadError, type EvidenceContext, type EvidenceTransport, nativeEvidenceTransport } from './native-release-evidence.js';
import { verifyExecutionSource, verifyDispatchWorkflow, channelTargets, channelTargetsDigest, verifyContinuationReleases, type ChannelTarget } from './release-run.js';
import { parseDocument } from 'yaml';
import { Version } from 'release-please/build/src/version.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { productReleaseTemplatePath, sharedReleaseTemplatePath, projectFrozenReleaseDownloads, renderFrozenReleaseNotes } from '../../core/src/release-template.js';
import { inspectProductArtifacts, validateProductManifest, validateWorkflowManifest, type ProductReleaseManifest, type WorkflowReleaseManifest } from './release-artifacts.js';

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
async function readNativeSourceFile(reader:NativeEvidenceReader,sha:string,path:string) {
  const value=await reader.json(`contents/${encodeRepositoryPath(path)}?ref=${sha}`);
  if(value.type!=='file'||value.encoding!=='base64'||typeof value.content!=='string')fail('source file identity');
  const bytes=Buffer.from(value.content,'base64');
  if(bytes.length!==value.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==value.sha)fail('source blob digest');
  return {bytes,sha:value.sha};
}

export async function readCycleDelivery(context:EvidenceContext,records:{path:string;commit:string;value:unknown}[],io:EvidenceTransport) {
  const reader=new NativeEvidenceReader(io,context.repository),sourceSha=context.cycle.sourceSha;
  let source;
  try {
    source=await readNativeSourceFile(reader,sourceSha,'.github/delivery.json');
  }catch(error) {
    if (!((error instanceof EvidenceReadError) && error.status === 404)) throw error;
    const proofs=records.filter(r=>r.path.startsWith('evidence/normalized-delivery/')&&(r.value as {cycleId?:string})?.cycleId===context.cycle.id).map(r=>verifyNormalizedDelivery(context,r));
    if(!proofs.length)fail('NORMALIZED_DELIVERY_EVIDENCE_REQUIRED');
    if(proofs.some(proof=>JSON.stringify({...proof,observedAt:''})!==JSON.stringify({...proofs[0],observedAt:''})))fail('conflicting normalized delivery evidence');
    proofs.sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
    return {delivery:proofs[0]!.normalizedDelivery,legacy:proofs[0]!};
  }
  if(source.sha!==context.cycle.deliveryConfigSha)fail('original delivery evidence required');
  const raw=JSON.parse(source.bytes.toString('utf8'));
  const settings=raw.schemaVersion===3?JSON.parse((await readNativeSourceFile(reader,sourceSha,'release-please-config.json')).bytes.toString('utf8')):undefined;
  return {delivery:parseDeliveryConfig(raw,settings),legacy:null};
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
  download:ReleaseDownload=nativeReleaseDownload(process.env.GH_TOKEN),
  source?:{unit:DeliveryUnit;controllerDirectory:string;history:{path:string;commit:string;value:unknown}[]}) {
  channelTargets(context,[target]);
  const unit=context.cycle.units.find(unit=>unit.id===target.unitId)!;
  let publicSelection:string[]|undefined;
  const github=source?.unit.channels.find(channel=>channel.id==='github-release');
  if (source && github && (github.artifactIds?.length !== undefined && github.artifactIds.length !== source.unit.assets.length
    || github.metadata?.length !== undefined && github.metadata.length !== 4)) {
    const token=process.env.GH_TOKEN;
    if (!token) return fail('channel source authentication');
    await verifyContinuationReleases(context,nativeEvidenceTransport(token));
    const inventory=source.unit.assets.map(asset=>({id:asset.id,path:unit.assets.find(item=>item.id===asset.id)?.path ?? asset.name}));
    publicSelection=channelFiles(source.unit,target.channelId,inventory);
    if (!publicSelection.every(path=>unit.assets.some(asset=>asset.path===path))) {
      const root=await mkdtemp(join(tmpdir(),'steward-channel-freeze-'));
      try {
        const records=await pipelinePreparePublication(context,root,source.controllerDirectory,token,gh,undefined,undefined,download,source.history,new Set([target.unitId]));
        if (!Array.isArray(records)) return fail('channel freeze unavailable');
        const record=records.find(record=>record.unitId===target.unitId);
        if (!record || record.manifest.schemaVersion===4
          || (await fileDigest(record.directory,'artifact-manifest.json')).sha256!==target.manifestDigest) return fail('channel freeze identity');
        await new NativeGitHubRelease(gh,download).verify({manifest:record.manifest,
          delivery:'delivery' in record?record.delivery:source.unit,
          ...(('publicBody' in record) && (record.publicBody !== undefined) ? {publicBody:record.publicBody} : {}),
          directory:record.directory,releaseId:target.releaseId,appBotId:context.appBotId});
        await mkdir(directory);
        for (const name of channelFiles(source.unit,target.channelId,record.manifest.artifacts))
          await copyFile(join(record.directory,name),join(directory,name));
        return record.manifest;
      } finally {await rm(root,{recursive:true,force:true});}
    }
  }
  const anonymous=await releaseReadIsAnonymous(gh,context.repository,context.repositoryId);
  const pages=JSON.parse(await gh(['api','--paginate','--slurp',`repos/${context.repository}/releases/${target.releaseId}/assets?per_page=100`]));
  if(!Array.isArray(pages)||!pages.length||pages.some(page=>!Array.isArray(page)))fail('formal asset pages');
  const assets=pages.flat();
  if(assets.length!==unit.assets.length||new Set(assets.map(asset=>asset.id)).size!==assets.length
    ||new Set(assets.map(asset=>asset.name)).size!==assets.length||assets.some(asset=>!unit.assets.some(expected=>expected.path===asset.name&&expected.size===asset.size)||asset.state!=='uploaded'))fail('formal asset mapping');
  await mkdir(directory);
  for(const asset of assets.filter(asset=>!publicSelection || publicSelection.includes(asset.name))) {
    await download(context.repository,asset.id,join(directory,asset.name),anonymous);
    const actual=await fileDigest(directory,asset.name),expected=unit.assets.find(value=>value.path===asset.name)!;
    if(actual.sha256!==expected.sha256||actual.size!==expected.size)fail('formal bytes conflict');
  }
  if (publicSelection && source) {
    const artifacts=unit.assets.filter(asset=>source.unit.assets.some(declared=>declared.id===asset.id));
    await gh(['release','verify',unit.tag,'--repo',context.repository,'--format','json']);
    for(const name of publicSelection) {
      const file=join(directory,name);
      await gh(['release','verify-asset',unit.tag,file,'--repo',context.repository,'--format','json']);
      const proofs=JSON.parse(await gh(['attestation','verify',file,'--repo',context.repository,
        '--signer-workflow',context.repository+'/'+(context.cycle.buildWorkflow??defaultBuildWorkflow),
        '--signer-digest',context.cycle.sourceSha,'--source-digest',context.cycle.sourceSha,
        '--source-ref','refs/heads/steward/build/'+context.cycle.id,'--deny-self-hosted-runners','--format','json']));
      if (!Array.isArray(proofs) || !proofs.some(proof=>{
        const cert=proof?.verificationResult?.signature?.certificate;
        return cert?.sourceRepositoryIdentifier===String(context.repositoryId) && cert.buildTrigger==='workflow_dispatch'
          && context.cycle.dispatches.some(dispatch=>dispatch.purpose==='build' && dispatch.canonicalRunId!==null &&
            typeof cert.runInvocationURI==='string' && cert.runInvocationURI.startsWith(`https://github.com/${context.repository}/actions/runs/${dispatch.canonicalRunId}/attempts/`) &&
            /^[1-9][0-9]*$/.test(cert.runInvocationURI.split('/').at(-1)));
      })) fail('formal channel attestation');
    }
    return {version:unit.version,tag:unit.tag,artifacts,channelFiles:publicSelection};
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
/** Only registered product workflows may consume the corresponding channel credential. */
export function assertRegisteredAdapters(repositoryId: number, repository: string, delivery: Pick<DeliveryConfig,'units'>) {
  const registration = registrations.find(item => item.id === repositoryId && item.name === repository);
  for (const unit of delivery.units) for (const channel of unit.channels) {
    if (channel.id === 'github-release' || !channel.required) continue;
    if (!registration?.externalAdapters.some(adapter => adapter.unitId === unit.id
      && adapter.channelId === channel.id && adapter.location === channel.location))
      fail('external adapter is not registered for this repository, unit and destination');
    if (unit.channels.some(item=>item.id==='github-release' && !item.required)) fail('registered external adapter requires a published Release ID');
    if (channel.id === 'winget') {
      const inventory = [...deliveryAssetNames(unit,'1.0.0','1.0.0')].map(([id,path])=>({id,path}));
      const publicFiles = channelFiles(unit,'github-release',inventory);
      const [installer] = channelFiles(unit,'winget',inventory);
      if (!installer || !publicFiles.includes(installer)) fail('WinGet requires a published installer URL');
    }
  }
}
/** These are the external channels implemented by the fixed product workflow and native CLI. */
export function assertProductDelivery(delivery:Pick<DeliveryConfig,'units'>) {
  for(const unit of delivery.units)for(const channel of unit.channels)
    if(channel.id!=='github-release'&&channel.id!=='ghcr-assets'&&channel.id!=='winget')fail('channel has no fixed product implementation');
}
/** The merged source is eligible only when its full Git tree matches the reviewed candidate. */
export function mergedBuildCycle(input: { prNumber: number; sourceSha: string; controllerSha: string; sourceTree: string; reviewedTree: string;
  deliveryBlobSha: string; delivery: unknown; releasePlease?:Parameters<typeof parseDeliveryConfig>[1];
  units: { id: string; path: string; version: string; tag: string }[]; repository?:string; repositoryId?:number }): CycleRecord {
  if (![input.sourceSha, input.controllerSha, input.sourceTree, input.reviewedTree, input.deliveryBlobSha].every(sha => /^[a-f0-9]{40}$/.test(sha))
    || input.sourceTree !== input.reviewedTree || !input.units.length) fail('merged product tree differs from reviewed source');
  const delivery = parseDeliveryConfig(input.delivery,input.releasePlease);
  assertProductDelivery(delivery);
  if(input.repository && input.repositoryId) assertRegisteredAdapters(input.repositoryId,input.repository,delivery);
  if(new Set(input.units.map(unit=>unit.id)).size!==input.units.length||new Set(input.units.map(unit=>unit.path)).size!==input.units.length)fail('merged duplicate unit mapping');
  for (const unit of input.units) if (!delivery.units.some(value => value.id === unit.id && value.path === unit.path)) fail('merged unit source');
  return parseReleaseRecord('cycle', { id: `pr-${input.prNumber}-${input.sourceSha}`, prNumber: input.prNumber, sourceSha: input.sourceSha,
    controllerSha: input.controllerSha, deliveryConfigSha: input.deliveryBlobSha,
    ...(delivery.buildWorkflow === undefined ? {} : {buildWorkflow:delivery.buildWorkflow}),
    units: input.units.map(unit => ({ id: unit.id, version: unit.version, tag: unit.tag, releaseId: null, assets: [], notesDigest: null, manifestDigest: null })),
    requiredChannels: delivery.units.filter(unit => input.units.some(value => value.id === unit.id)).flatMap(unit => unit.channels.filter(channel => channel.required && channel.id !== 'github-release').map(channel => ({ unitId: unit.id, channelId: channel.id }))),
    dispatches: [], publications: [], channelFacts: [], executionEvidence: [], completionObservations: [], completedEvidencePath: null, repairOf: null, approvedRepairDecision: null });
}
/** The build admission and central freeze recovery derive the same native versions and source locks from S. */
async function nativeDeliveryProjection(delivery:DeliveryConfig,targets:CycleRecord['units'],source:(path:string)=>Promise<Buffer>,controllerDirectory:string,historical=false) {
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
    if (!historical && (!unit.buildLocks || unit.assets.some(asset => !asset.inspection))) fail('missing product inspection or build locks');
    const packageVersion = await readNativeUnitVersion(unit.path, options, target.version, source, controllerDirectory);
    // Undeclared historical units used the original controller's fixed projection.
    const locks = unit.buildLocks ?? [options['release-type'] === 'simple' ? 'global.json'
      : path(options['release-type'] === 'node' ? 'package-lock.json' : 'requirements-build.txt')];
    for (const lock of locks) {
      safeGitPath(lock);
      const bytes = await source(lock);
      if (!bytes.length) fail('empty source lock');
      toolLocks[`source/${lock}`] = hash(bytes);
    }
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
  const deliveryBytes=await source('.github/delivery.json'),rawDelivery=JSON.parse(deliveryBytes.toString('utf8'));
  const delivery=parseDeliveryConfig(rawDelivery,rawDelivery.schemaVersion===3?JSON.parse((await source('release-please-config.json')).toString('utf8')):undefined);
  assertProductDelivery(delivery);
  if (createHash('sha1').update(`blob ${deliveryBytes.length}\0`).update(deliveryBytes).digest('hex') !== cycle.deliveryConfigSha) fail('delivery source blob');
  if (delivery.buildWorkflow !== request.buildWorkflow) fail('delivery workflow identity');
  const workflowBytes = await source(dispatchWorkflow(request)); verifyDispatchWorkflow(workflowBytes, request);
  const document = parseDocument(workflowBytes.toString('utf8'), { uniqueKeys: true });
  if (document.errors.length) fail('product YAML');
  const workflow=document.toJS({maxAliasCount:0});
  const matrix:{unit:string;target:string;assets:string[]}[]=workflow?.jobs?.build?.strategy?.matrix?.include;
  const workflowOwned=delivery.schemaVersion===3;
  if(workflowOwned) {
    const handoff=workflowGitHubDelivery(workflow);
    if(!handoff||handoff.sealed)fail('workflow-owned product must deliver its files');
  } else if (!Array.isArray(matrix) || !matrix.length || matrix.some(row => !row || Object.keys(row).sort().join(',') !== 'assets,target,unit'
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
  if(workflowOwned) {
    for(const target of cycle.units) {
      if(!session.generated.units.some((unit:typeof target)=>unit.id===target.id&&unit.version===target.version&&unit.tag===target.tag))
        fail('candidate release unit version');
    }
    if(!await stateRef())return {status:'UNKNOWN' as const,reason:'STATE_SOURCE_MOVED'};
    return {status:'SOURCE_VERIFIED' as const,units:cycle.units.map(unit=>({
      unit:unit.id,version:unit.version,tag:unit.tag,packageVersion:projection.versions.get(unit.id)!,
    }))};
  }
  const sharedTemplate=await file(input.controllerDirectory,cycle.controllerSha,sharedReleaseTemplatePath);
  const productTemplate=await localGitSnapshot.file(input.sourceDirectory,cycle.sourceSha,productReleaseTemplatePath);
  const template=productTemplate??sharedTemplate;
  if(!template.equals(sharedTemplate))fail('adopted notes template');
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

export async function pipelineNotes(record: BuildPipelineRecord, unitId: string, sourceDirectory: string, controllerDirectory?:string) {
  const unit = record.units.find(unit => unit.id === unitId), delivery = record.delivery.units.find(unit => unit.id === unitId);
  if (!unit || !delivery) fail('notes unit');
  const read = async (path: string) => { const bytes = await localGitSnapshot.file(sourceDirectory, record.sourceSha, path); if (!bytes) fail('missing notes source'); return bytes.toString('utf8'); };
  const settings = JSON.parse(await read('release-please-config.json')), options = { ...settings, ...settings.packages[delivery.path] };
  const changelogPath = options['changelog-path'] ?? 'CHANGELOG.md'; assertDeliveryPath(changelogPath);
  const changelogFile = delivery.path === '.' ? changelogPath : `${delivery.path}/${changelogPath}`;
  const changelog = await read(changelogFile);
  let templateBytes=await localGitSnapshot.file(sourceDirectory,record.sourceSha,productReleaseTemplatePath);
  if(!templateBytes&&controllerDirectory)
    templateBytes=await localGitSnapshot.file(controllerDirectory,record.controllerSha,sharedReleaseTemplatePath);
  if(!templateBytes||hash(templateBytes)!==record.templateSha256)fail('notes template source');
  const template=templateBytes.toString('utf8');
  const publicNames=new Set(channelFiles(delivery,'github-release',unit.assets.map(asset=>({id:asset.id,path:asset.name}))));
  const { sourceLinkLabel, sourceUrl, commitUrl } = committedVersionNotes(changelog, unit.version, record.fullName, record.sourceSha, unit.tag,
    template.includes('{{controllerSha}}') ? undefined : changelogFile);
  return renderFrozenReleaseNotes(template, { repository: record.fullName, unitId, version: unit.version, tag: unit.tag, sourceSha: record.sourceSha,
    githubDisabled:delivery.channels.some(channel=>channel.id==='github-release' && !channel.required),
    displayName: delivery.displayName, controllerSha: record.controllerSha, notes: await read(delivery.notesPath), sourceLinkLabel, sourceUrl, commitUrl, contributors: unit.contributors,
    repositoryAuthors: record.delivery.repositoryAuthors, assets: unit.assets.filter(asset=>publicNames.has(asset.name)).map(asset => ({ ...asset, description: delivery.assets.find(item => item.id === asset.id)?.description })), channels: delivery.channels.filter(channel=>channel.required && channel.id!=='github-release') });
}
export async function pipelineInspect(record: BuildPipelineRecord, unitId: string, selection: Awaited<ReturnType<typeof pipelineProducers>>,
  directory: string, controllerDirectory: string, home: string) {
  const source = pipelineSource(record, unitId), unit = record.delivery.units.find(unit => unit.id === unitId)!;
  if (selection.producers.length !== source.unit.builds.length || new Set(selection.producers.map(producer => producer.buildId)).size !== source.unit.builds.length
    || selection.producers.some(producer => !source.unit.builds.some(build => build.id === producer.buildId) || (producer.runId??record.runId)===record.runId && producer.attempt > record.runAttempt)) fail('producer set');
  await mkdir(home, { recursive: false });
  return inspectProductArtifacts(unit, directory, { repositoryId: record.repositoryId, fullName: record.fullName, unitId, cycleId: record.cycleId,
    ...(record.delivery.buildWorkflow === undefined ? {} : {buildWorkflow:record.delivery.buildWorkflow}),
    requestKey: record.requestKey, version: source.unit.version, packageVersion: source.unit.packageVersion, tag: source.unit.tag,
    sourceSha: record.sourceSha, controllerSha: record.controllerSha, buildRef: record.buildRef, deliverySha256: record.deliverySha256,
    templateSha256: record.templateSha256, runId: record.runId, attempt: record.runAttempt, toolLocks: record.toolLocks, producers: selection.producers },
  (path, asset) => inspectDeclaredAsset(path, asset, source.unit.packageVersion, controllerDirectory, home));
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
  let total: number | undefined, canonicalRepositoryId: number | undefined;
  const repository = path.split('/').slice(1, 3).join('/'), repositoryPath = `/repos/${repository}`;
  const request = client.request;
  const expectedUrl = new URL(request.endpoint(`GET /${path}`).url);
  const checkedRequest = Object.assign(async (options: Parameters<typeof request>[0]) => {
    const resolved = request.endpoint(options), url = new URL(resolved.url);
    if (url.origin !== expectedUrl.origin || url.username || url.password || url.hash) fail('pagination link left collection');
    if (url.pathname !== expectedUrl.pathname) {
      const alias = /^\/repositories\/([1-9][0-9]*)(\/.*)?$/.exec(url.pathname);
      if (!alias || (alias[2] ?? '') !== expectedUrl.pathname.slice(repositoryPath.length)) fail('pagination link left collection');
      if (canonicalRepositoryId === undefined) {
        const metadata = (await request(`GET ${repositoryPath}`)).data;
        if (!Number.isSafeInteger(metadata?.id) || metadata.id < 1 || metadata.full_name !== repository) fail('pagination repository identity');
        canonicalRepositoryId = metadata.id;
      }
      if (alias[1] !== String(canonicalRepositoryId)) fail('pagination repository identity');
    }
    for (const key of expectedUrl.searchParams.keys()) {
      if (JSON.stringify(url.searchParams.getAll(key)) !== JSON.stringify(expectedUrl.searchParams.getAll(key))) fail('pagination query');
    }
    if ([...url.searchParams.keys()].some(key => !expectedUrl.searchParams.has(key) && key !== 'page')) fail('pagination query');
    // Follow only the verified collection, retaining the original named request path.
    const normalized = new URL(expectedUrl); normalized.search = url.search;
    const response = await request({ ...resolved, url: normalized.href });
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
export async function pipelineDownloadProducers(record: PipelineSource, selection: Awaited<ReturnType<typeof pipelineProducers>>, rawDirectory: string, policyDirectory: string, home: string, gh: GhCommand = nativeGhCommand) {
  assertPipelineSource(record);
  await mkdir(home, { recursive: true });
  await mkdir(rawDirectory, { recursive: false });
  try {
    for (const producer of selection.producers) {
      const build = record.unit.builds.find(item => item.id === producer.buildId); if (!build) fail('unknown producer');
      await downloadNativeArtifact({ fullName: record.fullName, artifactId: producer.artifactId, digest: selection.digests[String(producer.artifactId)]!,
        names: build.expectedArtifacts.map(id => record.unit.assets.find(asset => asset.id === id)!.name),
        directory: join(rawDirectory, producerArtifactName({ ...record, runId:producer.runId??record.runId, unitId: record.unit.id }, build.id, producer.attempt)),
        policyDirectory, home: join(home, String(producer.artifactId)) });
    }
    const current = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/runs/${record.runId}`]));
    if (current.id !== record.runId || current.repository?.id !== record.repositoryId || current.head_repository?.id !== record.repositoryId
      || current.head_sha !== record.sourceSha || current.event !== record.event || current.run_attempt !== record.attempt) fail('run changed during producer download');
  } catch (error) {
    await rm(rawDirectory, {recursive:true, force:true});
    throw error;
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
    || manifest.buildWorkflow !== record.delivery.buildWorkflow
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
  return { manifest, directory, releaseId: release.releaseId, appBotId, delivery:record.build.delivery.units.find(unit=>unit.id===unitId)! };
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
  const delivery=record.build.delivery.units.find(candidate=>candidate.id===unitId)!;
  const assets=pages.flat(), names=channelFiles(delivery,'github-release',unit.assets.map(asset=>({id:asset.id,path:asset.name})));
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names) || new Set(assets.map(asset => asset.id)).size !== assets.length
    || assets.some(asset => !Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== 'uploaded')) fail('release asset set');
  if (names.length !== unit.assets.length + 4) {
    const home=await mkdtemp(join(tmpdir(),'steward-verify-freeze-'));
    try {
      const freeze=await pipelineRecoverFinal(pipelineSource(record.build,unitId),directory,process.cwd(),home,gh);
      if(!freeze.found) return fail('original full freeze unavailable for partial publication');
      return await new NativeGitHubRelease(gh,download).verify(await publicationTarget(record,unitId,directory,appBotId));
    } finally {await rm(home,{recursive:true,force:true});}
  }
  const anonymous=await releaseReadIsAnonymous(gh,fullName,record.build.repositoryId);
  await mkdir(directory, { recursive: false });
  for (const asset of assets) await download(fullName, asset.id, join(directory, asset.name), anonymous);
  return new NativeGitHubRelease(gh, download).verify(await publicationTarget(record, unitId, directory, appBotId));
}

function workflowGitHubDelivery(workflow:any) {
  const jobs=Object.values(workflow?.jobs??{}) as {steps?:any[]}[];
  const deliver=jobs.filter(job=>Array.isArray(job.steps)&&job.steps.some(step=>step?.id===githubDeliveryStep));
  if(!deliver.length)return null;
  const steps=deliver[0]!.steps!,uploads=steps.filter(step=>step?.id===githubDeliveryStep);
  const selected=uploads[0],prefix='delivery-github-release-';
  const isUpload=(step:any)=>typeof step?.uses==='string'&&step.uses.startsWith('actions/upload-artifact@');
  if(deliver.length!==1||uploads.length!==1||selected.name!==githubDeliveryJobStep||!/^actions\/upload-artifact@[a-f0-9]{40}$/.test(selected.uses??'')
    ||typeof selected.with?.name!=='string'||!selected.with.name.startsWith(prefix)
    ||![undefined,false,'false'].includes(selected.with.overwrite))
    fail('GitHub delivery workflow step');
  for(const step of steps.filter(step=>step!==selected&&isUpload(step))) {
    const other=String(step.with?.name??'artifact').match(/^[A-Za-z0-9_.-]+/)?.[0]??'';
    if(prefix.startsWith(other)||other.startsWith(prefix))fail('ambiguous GitHub delivery upload name');
  }
  const freezeJob=jobs.find(job=>job.steps?.some(step=>step?.name==='business-freeze'&&isUpload(step)));
  return {sealed:Boolean(freezeJob),sameJob:freezeJob===deliver[0],
    attested:jobs.some(job=>job.steps?.some(step=>/^actions\/attest(?:-build-provenance)?@[a-f0-9]{40}$/.test(step?.uses??'')))};
}

type DeliveryRun=Pick<PipelineSource,'fullName'|'sourceSha'|'repositoryId'|'runId'|'attempt'>;
export async function githubDeliveryArtifact(record:DeliveryRun,unitId:string,jobName:string,pages:NativePages,retainedAttempt?:number):Promise<WorkflowDeliveryReceipt> {
  const {repositoryId,fullName,runId,sourceSha}=record,prefix='repos/'+fullName+'/actions/runs/'+runId;
  const name=['delivery','github-release',repositoryId,unitId,sourceSha,runId,''].join('-');
  const artifacts=await pages(prefix+'/artifacts?per_page=100','artifacts');
  const entries=artifacts.filter(item=>typeof item.name==='string'&&(retainedAttempt===undefined
    ?item.name.startsWith(name):item.name===name+retainedAttempt));
  const seen=new Set<number>(),ordered=entries.map(artifact=>{
    const attemptText=artifact.name.slice(name.length),attempt=Number(attemptText);
    if(!Number.isSafeInteger(attempt)||attempt<1||attempt>record.attempt||String(attempt)!==attemptText||seen.has(attempt)
      ||!Number.isSafeInteger(artifact.id)||artifact.id<1||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      ||artifact.workflow_run?.id!==runId||artifact.workflow_run?.head_sha!==sourceSha)fail('GitHub delivery artifact identity: '+unitId);
    seen.add(attempt);return {artifact,attempt};
  }).sort((a,b)=>a.attempt-b.attempt);
  for(const {artifact,attempt} of ordered) {
    const jobs=await pages(prefix+'/attempts/'+attempt+'/jobs?per_page=100','jobs'),matches=jobs.filter(job=>job.name===jobName);
    const job=matches[0];
    if(matches.length!==1||job.run_id!==runId||job.run_attempt!==attempt||job.head_sha!==sourceSha||job.status!=='completed')
      fail('GitHub delivery artifact provenance: '+unitId);
    if(job.conclusion!=='success')continue;
    const steps=job.steps?.filter((step:any)=>step.name===githubDeliveryJobStep),step=steps?.[0];
    if(artifact.expired!==false||steps?.length!==1||step?.status!=='completed'||step.conclusion!=='success')
      fail('GitHub delivery artifact provenance: '+unitId);
    const created=Date.parse(artifact.created_at),started=Date.parse(step.started_at),completed=Date.parse(step.completed_at);
    if(![created,started,completed].every(Number.isFinite)||created<started||created>completed)fail('GitHub delivery artifact chronology');
    return {runId,attempt,artifactId:artifact.id,digest:artifact.digest};
  }
  return fail('successful GitHub delivery artifact missing: '+unitId);
}

export async function verifyWorkflowDelivery(selection:string[],staged:string,sealed:string,unit:DeliveryUnit,manifest:ProductReleaseManifest) {
  const artifacts=manifest.artifacts.filter(asset=>selection.includes(asset.path));
  if(!artifacts.length||new Set(selection).size!==selection.length)fail('GitHub delivery requires a business file');
  for(const name of selection) {
    const actual=await fileDigest(staged,name),original=await fileDigest(sealed,name);
    if(actual.size!==original.size||actual.sha256!==original.sha256)fail('GitHub delivery bytes: '+name);
  }
  const github=unit.channels.find(channel=>channel.id==='github-release')??{id:'github-release',required:true,location:'github'};
  const selected={...github,artifactIds:artifacts.map(asset=>asset.id),metadata:selection.filter(name=>!artifacts.some(asset=>asset.path===name))};
  return {...unit,channels:[...unit.channels.filter(channel=>channel.id!=='github-release'),selected]};
}

type PublicationUnit={unitId:string;directory:string;manifest:ProductReleaseManifest|WorkflowReleaseManifest;delivery:DeliveryUnit;
  build:BuildPipelineRecord|null;githubDelivery?:WorkflowDeliveryReceipt;publicBody?:string;
  archive:{artifactId:number;digest:string;runId:number;attempt:number;producerAttempt:number}|null};

async function prepareWorkflowPublication(options:{
  context:EvidenceContext;delivery:DeliveryConfig;units:CycleRecord['units'];versions:Map<string,string>;
  reader:NativeEvidenceReader;pages:NativePages;source:(path:string)=>Promise<string>;template:string;
  root:string;controllerDirectory:string;token:string;history:{path:string;commit:string;value:unknown}[];
  attested:boolean;
},download:typeof downloadWorkflowArtifact) {
  const {context,delivery,units,versions,reader,pages,source,template,root,controllerDirectory,token,history,attested}=options;
  const {cycle}=context,requests=cycle.dispatches.filter(dispatch=>dispatch.purpose==='build');
  if(requests.length!==1||requests[0]!.canonicalRunId===null)
    return {status:'WAIT' as const,reason:'BUILD_BINDING_REQUIRED',publishInvoked:false as const};
  const request=requests[0]!,run=verifyExecutionSource(nativeRunFact(await reader.json('actions/runs/'+request.canonicalRunId)),{...context,request});
  if(run.status!=='completed'||run.conclusion!=='success')
    return {status:'WAIT' as const,reason:'BUILD_RUN_NOT_READY',publishInvoked:false as const};
  const chunks=history.filter(entry=>(entry.value as CandidateArchiveChunk)?.documentKind==='merged-candidate'
    && new RegExp(`/cycles/${cycle.id}(?:-[1-9][0-9]*)?\\.json$`).test(entry.path)).map(entry=>entry.value as CandidateArchiveChunk);
  const merged=await decodeCandidateDocument(chunks);
  if(merged.cycleId!==cycle.id||merged.sourceSha!==cycle.sourceSha||merged.pull.number!==cycle.prNumber
    ||merged.session.identity?.authorsDigest!==hash(Buffer.from(JSON.stringify(delivery.repositoryAuthors))))fail('workflow delivery reviewed source');
  const settings=JSON.parse(await source('release-please-config.json'));
  const records:PublicationUnit[]=[];
  for(const target of units) {
    const unit=delivery.units.find(unit=>unit.id===target.id);
    if(!unit||unit.channels.some(channel=>channel.required&&channel.id!=='github-release')
      ||unit.channels.some(channel=>channel.id==='github-release'&&!channel.required))fail('workflow GitHub delivery channel');
    const packageVersion=versions.get(unit.id);
    const identity=merged.session.identity.units.find((item:any)=>item.id===unit.id);
    if(!packageVersion||!identity)fail('workflow delivery unit data');
    const contributors=selectReleaseContributors(identity.actors,delivery.repositoryAuthors);
    if(JSON.stringify(contributors)!==JSON.stringify(identity.contributors))fail('workflow delivery contributor identity');
    const nativeReceipt=await githubDeliveryArtifact({fullName:context.repository,repositoryId:context.repositoryId,sourceSha:cycle.sourceSha,
      runId:run.id,attempt:run.runAttempt},unit.id,'delivery/'+unit.id,pages,target.githubDelivery?.attempt);
    if(target.githubDelivery&&!sameWorkflowDelivery(nativeReceipt,target.githubDelivery))fail('workflow delivery receipt changed');
    const directory=join(root,unit.id);
    await download({fullName:context.repository,artifactId:nativeReceipt.artifactId,digest:nativeReceipt.digest,directory,
      policyDirectory:controllerDirectory,home:join(root,'download-'+unit.id)},token);
    const names=(await readdir(directory)).sort(),artifacts=[];
    for(const name of names) {
      const file=await fileDigest(directory,name),id='file-'+hash(Buffer.from(name)).slice(0,40);
      artifacts.push({...file,id});
    }
    const manifest:WorkflowReleaseManifest={schemaVersion:4,repositoryId:context.repositoryId,fullName:context.repository,cycleId:cycle.id,
      unitId:unit.id,version:target.version,packageVersion,tag:target.tag,sourceSha:cycle.sourceSha,buildWorkflow:dispatchWorkflow(request),
      buildRef:'refs/heads/'+request.ref,workflowId:run.workflowId,runId:run.id,attempt:nativeReceipt.attempt,delivery:nativeReceipt,attested,artifacts};
    validateWorkflowManifest(manifest);
    const config={...settings,...settings.packages[unit.path]},changelog=config['changelog-path']??'CHANGELOG.md';
    assertDeliveryPath(changelog);
    const changelogFile=unit.path==='.'?changelog:unit.path+'/'+changelog;
    const links=committedVersionNotes(await source(changelogFile),target.version,context.repository,cycle.sourceSha,target.tag,
      template.includes('{{controllerSha}}')?undefined:changelogFile);
    const publicBody=renderFrozenReleaseNotes(template,{repository:context.repository,unitId:unit.id,version:target.version,tag:target.tag,
      sourceSha:cycle.sourceSha,controllerSha:cycle.controllerSha,displayName:unit.displayName,notes:await source(unit.notesPath),...links,
      contributors:contributors.contributors,repositoryAuthors:delivery.repositoryAuthors,channels:[],
      assets:artifacts.map(file=>({id:file.id,name:file.path,build:'delivery'}))});
    records.push({unitId:unit.id,directory,manifest,delivery:unit,build:null,archive:null,githubDelivery:nativeReceipt,publicBody});
  }
  return records;
}

/** Central preparation only reads S, exact native freeze objects and formal Release bytes. */
export async function pipelinePreparePublication(context: EvidenceContext, root: string, controllerDirectory: string, token: string,
  gh: GhCommand = args => nativeGhCommand(args, token), io: EvidenceTransport = nativeEvidenceTransport(token),
  controllerIo:EvidenceTransport=nativeEvidenceTransport(undefined),download:ReleaseDownload=nativeReleaseDownload(token),
  history:{path:string;commit:string;value:unknown}[]=[],unitIds?:ReadonlySet<string>,
  workflowDownload=downloadWorkflowArtifact) {
  const { cycle } = context, reader = new NativeEvidenceReader(io, context.repository);
  const units=githubUnits(cycle).filter(unit=>!unitIds||unitIds.has(unit.id));
  if(unitIds&&units.length!==unitIds.size)fail('unknown publication unit');
  const original=await readCycleDelivery(context,history,io);
  if(original.legacy) {
    const records:{build:null;unitId:string;directory:string;manifest:ReleaseManifest}[]=[];
    for(const unit of units) {
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
  const source=(repository:string,sha:string,path:string)=>readNativeSourceFile(
    repository===context.repository?reader:new NativeEvidenceReader(controllerIo,repository),sha,path);
  const deliverySource = await source(context.repository, cycle.sourceSha, '.github/delivery.json');
  if (deliverySource.sha !== cycle.deliveryConfigSha) fail('frozen delivery source');
  const delivery=original.delivery;
  assertProductDelivery(delivery);
  const template=await source(context.repository,cycle.sourceSha,productReleaseTemplatePath).catch(error=>{
    if(!(error instanceof EvidenceReadError)||error.status!==404)throw error;
    return source('splrad/steward',cycle.controllerSha,sharedReleaseTemplatePath);
  });
  if (delivery.buildWorkflow !== cycle.buildWorkflow) fail('frozen delivery workflow');
  const workflow = await source(context.repository, cycle.sourceSha, delivery.buildWorkflow ?? defaultBuildWorkflow);
  const document = parseDocument(workflow.bytes.toString('utf8'), { uniqueKeys: true }); if (document.errors.length) fail('source workflow');
  const definition=document.toJS({maxAliasCount:0}),workflowDelivery=workflowGitHubDelivery(definition);
  if(delivery.schemaVersion===3&&(!workflowDelivery||workflowDelivery.sealed))fail('workflow-owned product must deliver its files');
  const matrix = definition?.jobs?.build?.strategy?.matrix?.include;
  const projection=await nativeDeliveryProjection(delivery,cycle.units,async path=>(await source(context.repository,cycle.sourceSha,path)).bytes,controllerDirectory,true);
  const pages: NativePages = async (path, field) => {
    const prefix = `repos/${context.repository}/`; if (!path.startsWith(prefix)) fail('native page target');
    return reader.pages(path.slice(prefix.length).replace('?per_page=100', ''), field);
  };
  if(workflowDelivery&&!workflowDelivery.sealed)
    return prepareWorkflowPublication({context,delivery,units,versions:projection.versions,reader,pages,template:template.bytes.toString('utf8'),
      source:async path=>(await source(context.repository,cycle.sourceSha,path)).bytes.toString('utf8'),
      root,controllerDirectory,token,history,attested:workflowDelivery.attested},workflowDownload);
  if (!Array.isArray(matrix) || !matrix.length) fail('native producer matrix');
  const toolLocks = { 'controller/mise.lock': hash((await source('splrad/steward', cycle.controllerSha, 'mise.lock')).bytes),...projection.toolLocks };
  const records:PublicationUnit[]=[];
  for (const unit of units) {
    const declared = delivery.units.find(value => value.id === unit.id); if (!declared) return fail('publication unit');
    const packageVersion=projection.versions.get(unit.id)!;
    const builds = matrix.filter(row => row.unit === unit.id).map(row => ({ id: row.target, jobName: `build/${row.target}/${unit.id}`, expectedArtifacts: row.assets }));
    const assets = [...deliveryAssetNames(declared, unit.version, packageVersion)].map(([id, name]) => {
      const producer = builds.filter(build => build.expectedArtifacts?.includes(id)); if (producer.length !== 1) fail('asset producer');
      return { id, name, build: producer[0]!.id };
    });
    const names = [...assets.map(asset => asset.name), 'sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'];
    const directory = join(root, unit.id), candidates: { source: PipelineSource; artifactId: number; digest: string }[] = [];
    const useWorkflowDelivery=workflowDelivery&&!declared.channels.some(channel=>channel.id==='github-release'&&!channel.required);
    let archive: {artifactId:number;digest:string;runId:number;attempt:number;producerAttempt:number} | null=null;
    let chosen:PipelineSource|undefined;
    let formal: any[] | null = null, anonymous=false;
    if (unit.releaseId !== null&&!useWorkflowDelivery) {
      const release = await reader.json(`releases/${unit.releaseId}`), remote = await reader.pages(`releases/${unit.releaseId}/assets`, '');
      if (release.id !== unit.releaseId || release.tag_name !== unit.tag || release.author?.id !== context.appBotId) fail('bound release identity');
      const selected = channelFiles(declared, 'github-release', assets.map(asset => ({id:asset.id, path:asset.name})));
      if (JSON.stringify(remote.map(asset => asset.name).sort()) === JSON.stringify(selected) && remote.every(asset => asset.state === 'uploaded')) {
        if (selected.length === names.length) formal = remote;
      }
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
      chosen=frozen.source;
      const verified = await pipelineDownloadPhase(frozen.source, frozen.artifactId, frozen.digest, 'final', directory, controllerDirectory, join(root, `download-${unit.id}`), gh, token);
      archive={artifactId:frozen.artifactId,digest:frozen.digest,runId:frozen.source.runId,attempt:frozen.source.attempt,producerAttempt:verified.producerAttempt};
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
    let selected=declared,publicBody:string|undefined,githubDelivery:WorkflowDeliveryReceipt|undefined;
    if(useWorkflowDelivery) {
      if(!chosen||!archive)fail('GitHub delivery requires the exact freeze Run');
      const jobName=workflowDelivery!.sameJob?chosen.inspectJob:'delivery/'+unit.id;
      githubDelivery=await githubDeliveryArtifact(chosen,unit.id,jobName,pages,unit.githubDelivery?.attempt);
      if(unit.githubDelivery&&!sameWorkflowDelivery(unit.githubDelivery,githubDelivery))fail('frozen GitHub delivery changed');
      const staging=join(root,'github-release-'+unit.id);
      await downloadNativeArtifact({fullName:context.repository,artifactId:githubDelivery.artifactId,digest:githubDelivery.digest,
        names,directory:staging,policyDirectory:controllerDirectory,home:join(root,'download-github-'+unit.id),allowSubset:true},token);
      const selection=(await readdir(staging)).sort();
      selected=await verifyWorkflowDelivery(selection,staging,directory,declared,m);
      const original=new Set(channelFiles(declared,'github-release',m.artifacts));
      const priorDownloads=assets.filter(asset=>original.has(asset.name)).map(asset=>({
        ...asset,description:declared.assets.find(item=>item.id===asset.id)?.description,
      }));
      if(priorDownloads.length!==assets.length&&selection.some(name=>m.artifacts.some(asset=>asset.path===name)&&!original.has(name)))
        fail('legacy download block requires all workflow assets');
      publicBody=projectFrozenReleaseDownloads(template.bytes.toString('utf8'),await readFile(join(directory,'release-notes.md'),'utf8'),
        {assets:priorDownloads,repository:context.repository,tag:unit.tag},new Set(selection));
    }
    records.push({build,unitId:unit.id,directory,manifest:m,delivery:selected,archive,
      ...(publicBody===undefined?{}:{publicBody}),...(githubDelivery===undefined?{}:{githubDelivery})});
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
