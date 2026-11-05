import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Version} from 'release-please/build/src/version.js';
import {TagName} from 'release-please/build/src/util/tag-name.js';
import {NativeEvidenceReader,nativeEvidenceTransport,nativeGhCommand,nativeReleaseDownload,NativeGitHubRelease,
  parseDeliveryConfig,deliveryAssetNames,validateProductManifest} from '../packages/runner/dist/index.js';

const check=(ok,code)=>{if(!ok)throw Error('PAGES_'+code);};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const json=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const utc=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/(?:Z|[+-]\d\d:\d\d)$/.test(value);
const repositoryName=value=>typeof value==='string'&&/^[\w.-]+\/[\w.-]+$/.test(value)&&!value.split('/').some(p=>p==='.'||p==='..');
export const pagesWorkflow='.github/workflows/pages.yml';

/** Input identity includes the source tree and the reviewed selector/tool source. It contains no command. */
export function pagesInputDigest(source) {
  check(positive(source.repositoryId)&&repositoryName(source.repository)&&sha(source.sourceSha)&&sha(source.controllerSha),'IDENTITY');
  check(['default-branch','release'].includes(source.mode)&&typeof source.ref==='string'&&source.ref.startsWith('refs/'),'MODE');
  check(source.mode==='default-branch'?source.releaseId===null&&source.unitId===null&&source.manifestDigest===null
    :positive(source.releaseId)&&/^[a-z][a-z0-9-]*$/.test(source.unitId)&&/^[a-f0-9]{64}$/.test(source.manifestDigest),'RELEASE_IDENTITY');
  return hash(JSON.stringify([1,source.repositoryId,source.repository,source.mode,source.sourceSha,source.controllerSha,
    source.ref,source.releaseId,source.unitId,source.manifestDigest]));
}
export function pagesDispatchInputs(source) {
  check(source.inputDigest===pagesInputDigest(source),'DIGEST');
  return {source_mode:source.mode,source_sha:source.sourceSha,release_id:source.releaseId===null?'':String(source.releaseId),input_digest:source.inputDigest};
}
export function pagesRunName(source) {const i=pagesDispatchInputs(source);return `Pages ${i.source_mode} ${i.source_sha} ${i.input_digest}`;}

export async function pagesContent(reader,path,ref) {
  const value=await reader.json(`contents/${path}?ref=${encodeURIComponent(ref)}`);
  check(value.type==='file'&&value.path===path&&value.encoding==='base64'&&typeof value.content==='string','CONTENT');
  const bytes=Buffer.from(value.content,'base64');
  check(value.size===bytes.length&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===value.sha,'CONTENT_DIGEST');
  return bytes;
}
async function manifestForRelease(reader,release) {
  const assets=await reader.pages(`releases/${release.id}/assets`,'');
  const matches=assets.filter(a=>a.name==='artifact-manifest.json');
  if(!matches.length)return null;
  check(matches.length===1&&matches[0].state==='uploaded'&&matches[0].size>0&&matches[0].size<=16*1024*1024,'MANIFEST_ASSET');
  const bytes=(await reader.response(`releases/assets/${matches[0].id}`,16*1024*1024)).bytes;
  check(bytes.length===matches[0].size&&(!matches[0].digest||matches[0].digest===`sha256:${hash(bytes)}`),'MANIFEST_BYTES');
  const manifest=json(bytes);validateProductManifest(manifest);
  return {manifest,bytes,assets};
}
/** Reuses the publication verifier: immutable native release, sealed set, final bytes and attestations. */
export async function verifyPagesRelease({reader,release,bundle,appBotId,unitId},
  {gh=nativeGhCommand,download=nativeReleaseDownload(process.env.GH_TOKEN)}={}) {
  const m=bundle.manifest;validateProductManifest(m);
  check(m.fullName===reader.repository&&m.unitId===unitId&&m.tag===release.tag_name,'RELEASE_SOURCE');
  const directory=await mkdtemp(join(tmpdir(),'steward-pages-release-'));
  try {
    const expected=[...m.artifacts.map(a=>a.path),'sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'].sort();
    check(same(bundle.assets.map(a=>a.name).sort(),expected)&&new Set(expected.map(p=>p.toLowerCase())).size===expected.length,'ASSET_SET');
    await writeFile(join(directory,'artifact-manifest.json'),bundle.bytes,{flag:'wx'});
    for(const asset of bundle.assets) {
      check(asset.state==='uploaded'&&Number.isSafeInteger(asset.size)&&asset.size>=0&&asset.size<2**31,'ASSET');
      // Manifest schema restricts every name to a single portable filename.
      if(asset.name!=='artifact-manifest.json')await download(reader.repository,asset.id,join(directory,asset.name),false);
    }
    await new NativeGitHubRelease(gh,download).verify({manifest:m,directory,releaseId:release.id,appBotId});
  }finally {await rm(directory,{recursive:true,force:true});}
}
function releaseFacts(r){return [r.id,r.author?.id,r.tag_name,r.draft,r.prerelease,r.immutable,r.published_at,r.target_commitish];}

/** Complete desired-source read. Default mode never asks for VERSION, delivery, tags or releases. */
export async function desiredPagesSource({reader,repositoryId,mode,unitId='',controllerSha,appBotId},
  {readContent=pagesContent,readManifest=manifestForRelease,verifyRelease=verifyPagesRelease}={}) {
  check(positive(repositoryId)&&repositoryName(reader.repository)&&sha(controllerSha),'CONTEXT');
  if(mode==='')return {status:'DISABLED'};
  check(['default-branch','release'].includes(mode),'MODE');
  const response=await reader.io.request('GET',`/repos/${reader.repository}`);check(response.status===200,'REPOSITORY_READ');
  const repo=json(response.bytes);
  check(repo.id===repositoryId&&repo.full_name===reader.repository&&repo.archived===false&&repo.disabled===false
    &&typeof repo.default_branch==='string'&&repo.default_branch.length>0,'REPOSITORY');
  const branch=await reader.json(`git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  check(branch.ref===`refs/heads/${repo.default_branch}`&&branch.object?.type==='commit'&&sha(branch.object.sha),'DEFAULT_HEAD');
  const base={schemaVersion:1,repositoryId,repository:reader.repository,mode,controllerSha,defaultBranch:repo.default_branch};
  let source;
  if(mode==='default-branch')source={...base,sourceSha:branch.object.sha,ref:branch.ref,releaseId:null,unitId:null,manifestDigest:null};
  else {
    check(/^[a-z][a-z0-9-]*$/.test(unitId)&&positive(appBotId),'UNIT');
    const activeDelivery=parseDeliveryConfig(json(await readContent(reader,'.github/delivery.json',branch.object.sha)));
    check(activeDelivery.units.some(u=>u.id===unitId),'UNIT');
    await readContent(reader,pagesWorkflow,branch.object.sha);
    const candidates=[];
    for(const listed of await reader.pages('releases','')) {
      if(listed.draft!==false||listed.prerelease!==false||listed.immutable!==true)continue;
      check(positive(listed.id)&&utc(listed.published_at),'RELEASE');
      if(listed.author?.id!==appBotId)continue;
      const bundle=await readManifest(reader,listed);
      if(!bundle)continue;
      const m=bundle.manifest;validateProductManifest(m);
      check(m.repositoryId===repositoryId&&m.fullName===reader.repository,'MANIFEST_REPOSITORY');
      if(m.unitId!==unitId)continue;
      check(m.tag===listed.tag_name,'MANIFEST_TAG');
      candidates.push({release:listed,bundle});
    }
    if(!candidates.length)return {status:'WAIT',reason:'NO_FORMAL_RELEASE'};
    candidates.sort((a,b)=>Date.parse(b.release.published_at)-Date.parse(a.release.published_at)||b.release.id-a.release.id);
    const {release,bundle}=candidates[0],m=bundle.manifest;
    const actual=await reader.json(`releases/${release.id}`);check(same(releaseFacts(actual),releaseFacts(release)),'RELEASE_CHANGED');
    const deliveryBytes=await readContent(reader,'.github/delivery.json',m.sourceSha);
    const delivery=parseDeliveryConfig(json(deliveryBytes)),unit=delivery.units.find(u=>u.id===unitId);
    check(unit&&hash(deliveryBytes)===m.deliverySha256,'SOURCE_DELIVERY');
    const names=deliveryAssetNames(unit,m.version,m.packageVersion);
    check(same([...names].sort(),m.artifacts.map(a=>[a.id,a.path]).sort()),'SOURCE_ASSETS');
    const settings=json(await readContent(reader,'release-please-config.json',m.sourceSha));
    check(settings.packages&&Object.hasOwn(settings.packages,unit.path),'TAG_CONFIG');
    const options={...settings,...settings.packages[unit.path]},component=options['include-component-in-tag']===false?undefined:options.component;
    check(options['include-component-in-tag']===false||typeof component==='string'&&component.length>0,'TAG_CONFIG');
    check(new TagName(Version.parse(m.version),component,options['tag-separator'],options['include-v-in-tag']).toString()===m.tag,'TAG_CONFIG');
    await readContent(reader,pagesWorkflow,m.sourceSha);
    await verifyRelease({reader,release:actual,bundle,appBotId,unitId});
    check(same(releaseFacts(await reader.json(`releases/${release.id}`)),releaseFacts(actual)),'RELEASE_CHANGED');
    source={...base,sourceSha:m.sourceSha,ref:`refs/tags/${m.tag}`,releaseId:release.id,unitId,manifestDigest:hash(bundle.bytes)};
  }
  return {status:'READY',source:{...source,inputDigest:pagesInputDigest(source)}};
}

/** The actual event and ref must agree with the current desired source. Stale events cannot deploy. */
export function admitPagesEvent(source,event) {
  check(event.repositoryId===source.repositoryId&&event.repository===source.repository,'EVENT_REPOSITORY');
  if(event.name==='push') {
    if(source.mode!=='default-branch'||event.ref!==source.ref||event.sha!==source.sourceSha||event.payload?.deleted)return {status:'STALE'};
    check(event.payload?.after===event.sha,'PUSH_SOURCE');
  }else if(event.name==='release') {
    if(source.mode!=='release'||event.payload?.action!=='published'||event.payload?.release?.id!==source.releaseId)return {status:'STALE'};
    check(event.ref===source.ref&&event.sha===source.sourceSha,'RELEASE_EVENT_SOURCE');
  }else if(event.name==='workflow_dispatch') {
    const inputs=event.payload?.inputs;
    check(inputs&&same(Object.keys(inputs).sort(),['input_digest','release_id','source_mode','source_sha']),'DISPATCH_FIELDS');
    if(!same(inputs,pagesDispatchInputs(source))) {
      // Key order is not a platform promise.
      if(Object.keys(inputs).some(k=>inputs[k]!==pagesDispatchInputs(source)[k]))return {status:'STALE'};
    }
    if(event.ref!==source.ref||event.sha!==source.sourceSha)return {status:'STALE'};
  }else return {status:'IGNORED'};
  return {status:'READY',source};
}

export async function selectPagesSource(options,event,ports) {
  const desired=await desiredPagesSource(options,ports);
  return desired.status==='READY'?admitPagesEvent(desired.source,event):desired;
}
async function main() {
  check(process.argv.length===2,'ARGUMENTS');
  const reader=new NativeEvidenceReader(nativeEvidenceTransport(process.env.GH_TOKEN),process.env.GITHUB_REPOSITORY);
  const payload=json(await readFile(process.env.GITHUB_EVENT_PATH));
  const options={reader,repositoryId:Number(process.env.GITHUB_REPOSITORY_ID),mode:process.env.STEWARD_DOCS_SOURCE??'',
    unitId:process.env.STEWARD_DOCS_UNIT??'',controllerSha:process.env.STEWARD_CONTROLLER_SHA};
  if(options.mode==='release') {
    // Same confirmed App bot identity as nativeReleaseApp; the repository transport is deliberately repo-scoped.
    options.appBotId=301115370;
  }
  const event={name:process.env.GITHUB_EVENT_NAME,repositoryId:options.repositoryId,repository:reader.repository,
    sha:process.env.GITHUB_SHA,ref:process.env.GITHUB_REF,payload};
  const {currentPagesSource}=await import('./pages-runtime.mjs');
  const desired=await currentPagesSource(options);
  check(desired.status!=='READY'||desired.source.controllerSha===options.controllerSha,'CONTROLLER_PIN');
  const result=desired.status==='READY'?admitPagesEvent(desired.source,event):desired;
  await writeFile('pages-source.json',JSON.stringify(result,null,2)+'\n');
  if(process.env.GITHUB_OUTPUT) {
    const values={ready:String(result.status==='READY'),source:result.source?JSON.stringify(result.source):'',
      source_sha:result.source?.sourceSha??'',input_digest:result.source?.inputDigest??''};
    await appendFile(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
  }
  console.log(JSON.stringify({status:result.status}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error(/^PAGES_[A-Z_]+$/.test(error.message)?error.message:'PAGES_SOURCE_UNAVAILABLE');process.exitCode=1;
});
