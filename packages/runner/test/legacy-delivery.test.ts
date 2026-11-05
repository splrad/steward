import { afterEach,expect,it,vi } from 'vitest';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { C,D,NOW,digest } from './native-evidence-fixture.js';
import { normalizeLegacyDelivery,normalizedDeliveryFile,verifyNormalizedDelivery,readCycleDelivery,prepareNormalizedDelivery,pipelineChannelIdentity,pipelinePreparePublication } from '../src/release-pipeline.js';
import { sealReleaseArtifacts,type ReleaseManifest } from '../src/release-artifacts.js';
import { channelTargetsDigest, readDirectChannelTargets, verifyDirectChannelRead } from '../src/release-run.js';
import { decodeStateFile } from '../../core/src/release-observation.js';
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const blob=(text:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
async function fixture() {
  const f=productPipelineFixture(),cycle=f.context.cycle,unit=cycle.units[0]!;f.context.repository='splrad/product';f.environment.GITHUB_REPOSITORY='splrad/product';
  const root=await mkdtemp(join(tmpdir(),'legacy-delivery-'));roots.push(root);
  const old={schemaVersion:1,units:[{id:'app',displayName:'App',path:'.',releasePleasePath:'.',ecosystem:'native',versionFile:'VERSION',changelogPath:'CHANGELOG.md',notesPath:'.release-notes/app.md',signingPolicy:'none',
    channels:[{id:'ghcr-assets',kind:'oci-artifact',artifacts:['app'],dependsOn:[]},{id:'winget',kind:'winget',artifacts:['app'],dependsOn:[]}],
    artifacts:[{id:'app',file:'app.exe',kind:'executable',mediaType:'application/octet-stream',platform:'windows',architecture:'x64',build:'windows',required:true}],
    builds:[{id:'windows',os:'windows',arch:'x64',entrypoint:'build.ps1',args:[],expectedArtifacts:['app']}]}]};
  const descriptor={content:JSON.stringify(old),blobSha:''};descriptor.blobSha=blob(descriptor.content);cycle.deliveryConfigSha=descriptor.blobSha;
  const config=JSON.parse(await readFile('packages/core/test/fixtures/legacy-repositories-v5.json','utf8')),repo=config.repositories['1187527897'];delete config.repositories['1187527897'];
  repo.repositoryId=1;repo.fullName='splrad/product';repo.release.enabled=true;const original=repo.release.units.layerscape;delete repo.release.units.layerscape;
  repo.release.units.app=original;original.enabled=true;original.adoptedAfterTag=null;original.adoptedFromSha=cycle.sourceSha;
  for(const channel of Object.values(original.channels) as any[])channel.enabled=true;
  original.channels.winget.forkRepository='example/winget-pkgs';config.repositories['1']=repo;
  const catalog={content:JSON.stringify(config),blobSha:''};catalog.blobSha=blob(catalog.content);
  const notes=`Original notes ${unit.version} ${cycle.sourceSha} ${C}`;
  for(const [name,text] of [['app.exe','app'],['sbom.spdx.json',JSON.stringify({spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',packages:[]})],['release-notes.md',notes]])await writeFile(join(root,name!),text!);
  const base:ReleaseManifest={schemaVersion:2,repositoryId:1,fullName:'splrad/product',unitId:'app',version:unit.version,packageVersion:unit.version,tag:unit.tag,
    sourceSha:cycle.sourceSha,policySha:C,descriptorSha256:digest(descriptor.content),templateSha256:'e'.repeat(64),runId:100,attempt:1,toolLocks:{mise:'f'.repeat(64)},
    producers:[{buildId:'windows',jobId:1000,attempt:1,artifactId:700}],artifacts:[{id:'app',path:'app.exe',size:3,sha256:digest('app'),kind:'executable',mediaType:'application/octet-stream',platform:'windows',architecture:'x64'}],evidence:[]};
  await sealReleaseArtifacts(root,base);const content=await readFile(join(root,'artifact-manifest.json'),'utf8'),manifest=JSON.parse(content);
  const names=['app.exe','sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'];
  const assets=await Promise.all(names.map(async(path,i)=>{const b=await readFile(join(root,path));return {id:i===0?'app':'metadata-'+i,path,size:b.length,sha256:digest(b.toString())};}));
  Object.assign(unit,{releaseId:20,manifestDigest:digest(content),notesDigest:digest(notes),assets});
  cycle.requiredChannels=old.units[0]!.channels.map(channel=>({unitId:'app',channelId:channel.id}));
  const value=normalizeLegacyDelivery(f.context,descriptor,catalog,[{unitId:'app',content}],NOW),file=normalizedDeliveryFile(value),record={...file,commit:D,value};
  const targets=cycle.requiredChannels.map(c=>({...c,version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}));
  const calls:string[]=[];
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.includes('delivery.json?'))return {status:404,headers:new Headers(),bytes:Buffer.from('{}')};
    if(path.includes('steward-release.json?')||path.includes('config/repositories.json?')){const source=path.includes('config/')?catalog:descriptor;
      expect(path).toContain(`ref=${path.includes('config/')?C:cycle.sourceSha}`);return f.response({type:'file',encoding:'base64',content:Buffer.from(source.content).toString('base64'),size:Buffer.byteLength(source.content),sha:source.blobSha});}
    if(path.endsWith('/product'))return f.response({id:1,full_name:'splrad/product',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/release-state'))return f.response({object:{sha:f.input.state.head}});
    if(path.endsWith('/releases/20'))return f.response({id:20,tag_name:unit.tag,author:{id:42},draft:false,immutable:true});
    if(path.includes('/releases/20/assets?'))return f.response(assets.map((a,i)=>({id:700+i,name:a.path,size:a.size,state:'uploaded'})));
    if(path.endsWith('/releases/assets/703'))return {status:200,headers:new Headers(),bytes:Buffer.from(content)};
    if(path.endsWith('/runs/100'))return f.response({...f.runs.get(1),head_sha:D,head_branch:'main',path:'.github/workflows/steward-release-channels.yml',display_title:digest(JSON.stringify(['observe',channelTargetsDigest(f.context,targets),D]))});
    throw Error('unexpected '+path);
  }};
  return {...f,root,descriptor,catalog,value,file,record,targets,io,calls,manifest,assets};
}
it('normalizes original S descriptor, frozen v2 bytes and original channels without current delivery or author invention',async()=>{
  const f=await fixture(),value=verifyNormalizedDelivery(f.context,f.record);
  expect(value.normalizedDelivery.units[0]!.channels.map(c=>c.required)).toEqual([true,true]);
  expect(value.normalizedDelivery).not.toHaveProperty('repositoryAuthors');expect(JSON.stringify(value.normalizedDelivery)).not.toContain('entrypoint');
  decodeStateFile('steward/release-state',f.file.path,Buffer.from(f.file.content),1);
  expect((await readCycleDelivery(f.context,[f.record],f.io)).legacy).toEqual(f.value);
});
it('retrieves exact S/C and original Release manifest before archiving a projection',async()=>{
  const f=await fixture();expect(await prepareNormalizedDelivery(f.context,f.io,f.io,NOW)).toEqual(f.file);
  expect(f.calls.some(p=>p.includes('ref='+D))).toBe(false);
});
it('reads an old-source registry directly from archived original obligations and revalidates the embedded proof',async()=>{
  const f=await fixture(),channel=f.value.normalizedDelivery.units[0]!.channels.find(c=>c.id==='ghcr-assets')!;
  const result=await readDirectChannelTargets(f.context,f.targets,f.io,NOW,async args=>JSON.stringify(args[0]==='repo'
    ?{name:channel.location.slice(8),tags:[f.context.cycle.units[0]!.version]}:{digest:'sha256:'+'a'.repeat(64),size:10}),[f.record]);
  expect(result.reads).toHaveLength(1);expect(result.reads[0]).toMatchObject({channelId:'ghcr-assets',readStatus:'OK'});
  const file=result.files[0]!;expect(verifyDirectChannelRead(f.context,{...file,commit:D,value:JSON.parse(file.content)},NOW).fresh).toBe(true);
});
it('permits current R observe with an archived original S that has no new delivery file',async()=>{
  const f=await fixture();f.input.state.domainRecords=[f.record];
  const key=channelTargetsDigest(f.context,f.targets),inputs={cycle_id:f.context.cycle.id,source_sha:f.context.cycle.sourceSha,execution_sha:D,controller_sha:C,targets_json:JSON.stringify(f.targets),mode:'observe' as const,operation_key:key,request_key:digest(JSON.stringify(['observe',key,D]))};
  expect(await pipelineChannelIdentity(inputs,f.input.state,{...f.environment,GITHUB_SHA:D,GITHUB_REF:'refs/heads/main'},f.gh,f.io)).toMatchObject({status:'OBSERVE',delivery:f.value.normalizedDelivery});
});
it('prepares the original sealed Release bytes without consulting a new build workflow or rebuilding',async()=>{
  const f=await fixture(),output=await mkdtemp(join(tmpdir(),'legacy-readback-'));roots.push(output);
  const records=await pipelinePreparePublication(f.context,output,'controller','token',async args=>args.at(-1)===`repos/${f.context.repository}`
    ?JSON.stringify({id:f.context.repositoryId,full_name:f.context.repository,archived:false,disabled:false,private:false}):f.gh(args),f.io,f.io,async(_repo,id,path,anonymous)=>{
    expect(anonymous).toBe(true);
    await writeFile(path,await readFile(join(f.root,f.assets[id-700]!.path)));
  },[f.record]);
  if(!Array.isArray(records))throw Error('legacy publication expected');
  expect(records[0]).toMatchObject({build:null,manifest:f.manifest});expect(f.calls.some(p=>p.includes('/actions/')||p.includes('/workflows/'))).toBe(false);
});
it.each(['required','manifest','descriptor','projection','path'])('rejects lost or substituted legacy obligations: %s',async kind=>{
  const f=await fixture(),value=structuredClone(f.value);
  if(kind==='required')value.originalChannels[0]!.required=false;
  if(kind==='manifest')value.manifests[0]!.content=value.manifests[0]!.content.replace('app.exe','other.exe');
  if(kind==='descriptor')value.descriptor.content=value.descriptor.content.replace('app.exe','other.exe');
  if(kind==='projection')value.normalizedDelivery.units[0]!.channels=[];
  const file=normalizedDeliveryFile(value);if(kind==='path')file.path=file.path.replace(/[a-f0-9]{64}/,'f'.repeat(64));
  expect(()=>verifyNormalizedDelivery(f.context,{...file,commit:D,value})).toThrow();
});
it('keeps missing original evidence and access denied unknown rather than borrowing current R',async()=>{
  const f=await fixture();await expect(readCycleDelivery(f.context,[],f.io)).rejects.toThrow('NORMALIZED_DELIVERY_EVIDENCE_REQUIRED');
  const denied={request:async()=>({status:403,headers:new Headers(),bytes:Buffer.from('{}')})};
  await expect(readCycleDelivery(f.context,[f.record],denied)).rejects.toThrow('NATIVE_HTTP_403');
});
