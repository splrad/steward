import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { pipelineChannelDownload, pipelineIdentity, pipelinePreparePublication, readCycleDelivery } from '../src/release-pipeline.js';
import { sealProductArtifacts, fileDigest, type ProductReleaseManifest } from '../src/release-artifacts.js';
import * as downloads from '../src/native-artifact-download.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { S, C, START, END, digest } from './native-evidence-fixture.js';
import { permitOfflineScript } from './offline-fixtures.js';
import { freezeReleaseAssets } from '../../core/src/release-asset-selection.js';
import { channelFiles } from '../../core/src/delivery-config.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['freeze','central-selection','external-from-freeze','wrong-selection-source','historical-formal','python-freeze','incomplete-run','failed-run','unbound-run','undispatched','foreign-run','foreign-source','formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset'])('prepares publication from exact native objects: %s',async kind=>{
  const f=productPipelineFixture(1,false,kind==='python-freeze'?'requirements-build.txt':'global.json');
  const external=kind==='external-from-freeze', unpublished='support-1.0.0.exe', published='app-1.0.0.exe';
  const downloadLine=(name:string)=>`- [${name}](https://github.com/example/product/releases/download/v1.0.0/${name})\n`;
  if(external) {
    const delivery=JSON.parse(f.source['.github/delivery.json']!);
    delivery.units[0].assets.push({...delivery.units[0].assets[0],id:'support',name:'support-${version}.exe'});
    delivery.units[0].channels.push({id:'ghcr-assets',required:true,location:'ghcr.io/example/product',artifactIds:['support'],metadata:['SHA256SUMS']});
    const bytes=Buffer.from(JSON.stringify(delivery));
    f.source['.github/delivery.json']=bytes.toString();
    const workflowPath='.github/workflows/steward-release-publish.yml';
    const workflow=parse(f.source[workflowPath]!);
    workflow.jobs.build.strategy.matrix.include[0].assets.push('support');
    f.source[workflowPath]=stringify(workflow);
    f.context.cycle.deliveryConfigSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    f.context.cycle.requiredChannels=[{unitId:'app',channelId:'ghcr-assets'}];
  }
  if(kind==='python-freeze') {
    permitOfflineScript(resolve('scripts/inspect-python-release.py'));
    f.input.controllerDirectory=process.cwd();delete f.source.VERSION;delete f.source['global.json'];
    f.source['release-please-config.json']=JSON.stringify({'include-component-in-tag':false,'include-v-in-tag':true,packages:{'.':{'release-type':'python'}}});
    f.source['pyproject.toml']='[project]\nname="fixture"\nversion="1.0.0"\n';
    f.source['requirements-build.txt']='build==1.2.3 --hash=sha256:'+'f'.repeat(64)+'\n';
  }
  const admitted=await pipelineIdentity(f.input,f.environment,f.gh,f.io);
  if(admitted.status!=='ADMITTED')throw Error('fixture admission');
  const record=admitted.record,root=await mkdtemp(join(tmpdir(),'publish-connection-'));roots.push(root);
  if (kind === 'historical-formal') {
    const legacy = JSON.parse(f.source['.github/delivery.json']!);
    legacy.schemaVersion = 1;
    delete legacy.units[0].buildLocks;
    delete legacy.units[0].assets[0].inspection;
    legacy.units[0].channels = [];
    const bytes = Buffer.from(JSON.stringify(legacy));
    f.source['.github/delivery.json'] = bytes.toString();
    f.context.cycle.deliveryConfigSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    record.deliverySha256 = digest(bytes);
    await expect(pipelineIdentity(f.input, f.environment, f.gh, f.io)).rejects.toThrow('missing product inspection or build locks');
  }
  const original=join(root,'original');await mkdir(original);
  await writeFile(join(original,published),'frozen binary');
  await writeFile(join(original,'sbom.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',packages:[]}));
  const noteIdentity=`1.0.0\n${S}\n${C}\n`, publicBody=noteIdentity+'\n'+downloadLine(published);
  await writeFile(join(original,'release-notes.md'),external?publicBody+downloadLine(unpublished):noteIdentity);
  const manifest:ProductReleaseManifest={schemaVersion:3,repositoryId:1,fullName:'example/product',cycleId:record.cycleId,requestKey:record.requestKey,
    unitId:'app',version:'1.0.0',packageVersion:'1.0.0',tag:'v1.0.0',sourceSha:S,controllerSha:C,buildRef:record.buildRef,
    deliverySha256:record.deliverySha256,templateSha256:record.templateSha256,runId:100,attempt:1,toolLocks:record.toolLocks,
    producers:[{buildId:'windows-x64',jobId:1000,attempt:1,artifactId:701}],artifacts:[{id:'app',mediaType:'application/octet-stream',...await fileDigest(original,'app-1.0.0.exe')}],evidence:[]};
  if(external) {
    await writeFile(join(original,unpublished),'frozen channel binary');
    manifest.artifacts.push({id:'support',mediaType:'application/octet-stream',...await fileDigest(original,unpublished)});
  }
  await sealProductArtifacts(original,manifest);
  const names=await readdir(original),unit=f.context.cycle.units[0]!,bound=['external-from-freeze','historical-formal','formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset'].includes(kind);
  if(bound){unit.releaseId=20;unit.manifestDigest=(await fileDigest(original,'artifact-manifest.json')).sha256;}
  const body=external?publicBody:noteIdentity,installer=manifest.artifacts[0]!;
  if(kind==='external-from-freeze'){unit.notesDigest=digest(body);unit.assets=[installer];}
  if(kind==='foreign-source')unit.manifestDigest='f'.repeat(64);
  Object.assign(f.runs.get(1),{status:kind==='incomplete-run'?'in_progress':'completed',conclusion:kind==='incomplete-run'?null:kind==='failed-run'?'failure':'success'});
  if(kind==='foreign-run')f.runs.get(1).head_sha='e'.repeat(40);
  const artifact={id:702,name:`final-1-app-${S}-100-1`,expired:false,digest:'sha256:'+digest('archive'),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'};
  const sourceBlob=(value:string)=>{const bytes=Buffer.from(value);return {type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64'),sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
  const calls:string[]=[],io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.startsWith('/repos/splrad/steward/')){expect(path).toBe(`/repos/splrad/steward/contents/mise.lock?ref=${C}`);return f.response(sourceBlob('locked tools'));}
    if(path.includes('/contents/')){const file=path.split('/contents/')[1]!.split('?')[0]!;expect(path.endsWith(`?ref=${S}`)).toBe(true);return f.response(sourceBlob(f.source[file]!));}
    if(path.endsWith('/releases/20'))return f.response({id:20,tag_name:'v1.0.0',author:{id:42},draft:kind==='partial-draft',immutable:true,body});
    if(path.includes('/releases/20/assets'))return f.response(kind==='external-from-freeze'?[{id:300,name:installer.path,state:'uploaded',size:installer.size}]:
      (kind==='partial-draft'||kind==='missing-public-asset'?names.slice(0,1):names).map((name,i)=>({id:300+i,name,state:'uploaded'})));
    if(path.endsWith('/commits/v1.0.0'))return f.response({sha:S});
    if(path.endsWith('/releases/assets/300'))return {status:200,headers:new Headers(),bytes:await readFile(join(original,installer.path))};
    if(path.endsWith('/repos/example/product'))return f.response({id:1,full_name:'example/product',archived:false,disabled:false,private:false});
    if(path.includes('/artifacts?'))return f.response({total_count:1,artifacts:[artifact]});
    if(path.includes('/jobs?'))return f.response({total_count:1,jobs:[{id:1100,name:'freeze/app',run_id:100,head_sha:S,status:'completed',started_at:START,completed_at:END}]});
    if(path.endsWith('/runs/100')){expect(kind).not.toBe('formal-after-expiry');return f.response(f.runs.get(1));}
    throw Error('Unexpected publication source '+path);
  }};
  const download=vi.spyOn(downloads,'downloadNativeArtifact').mockImplementation(async(input,token)=>{
    expect(input.artifactId).toBe(702);expect(token).toBe('fixture-product-token');await mkdir(input.directory);for(const name of names)await copyFile(join(original,name),join(input.directory,name));
  });
  const output=join(root,'prepared');await mkdir(output);
  if(kind==='unbound-run')f.request.canonicalRunId=null;
  if(kind==='undispatched')f.context.cycle.dispatches=[];
  const history=['central-selection','external-from-freeze','wrong-selection-source'].includes(kind)
    ?freezeReleaseAssets(1,{...f.context.cycle,deliveryConfigSha:kind==='wrong-selection-source'?'a'.repeat(40):f.context.cycle.deliveryConfigSha},
      [{unitId:'app',artifactIds:['app'],metadata:[]}]).map(({path,content})=>({path,commit:C,value:JSON.parse(content)}))
    :[];
  if(kind==='external-from-freeze') {
    vi.stubEnv('GH_TOKEN','fixture-product-token');
    vi.stubGlobal('fetch',async(input:unknown)=>{
      const url=new URL(String(input)),value=await io.request('GET',url.pathname+url.search);
      return new Response(new Uint8Array(value.bytes),{status:value.status,headers:value.headers});
    });
    const {delivery}=await readCycleDelivery(f.context,history,io);
    const gh=async(args:readonly string[])=>{
      if(args[0]==='release')return '{}';
      if(args[0]==='attestation')return JSON.stringify([{verificationResult:{signature:{certificate:{
        runInvocationURI:'https://github.com/example/product/actions/runs/100/attempts/1',sourceRepositoryIdentifier:'1',buildTrigger:'workflow_dispatch'
      }}}}]);
      const endpoint=args.at(-1)!;
      if(endpoint.endsWith('git/ref/tags/v1.0.0'))return JSON.stringify({ref:'refs/tags/v1.0.0',object:{type:'commit',sha:S}});
      if(endpoint.endsWith('actions/artifacts/702'))return JSON.stringify(artifact);
      const result=await io.request('GET','/'+endpoint);
      const payload=JSON.parse(Buffer.from(result.bytes).toString());
      return JSON.stringify(args.includes('--slurp')?[payload]:payload);
    };
    const target={unitId:'app',channelId:'ghcr-assets',version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!};
    const output=join(root,'channel');
    await expect(pipelineChannelDownload(f.context,target,output,gh,async(_repo,id,destination)=>{
      expect(id).toBe(300);await copyFile(join(original,installer.path),destination);
    },{unit:delivery.units[0]!,controllerDirectory:f.input.controllerDirectory,history})).resolves.toEqual(
      JSON.parse(await readFile(join(original,'artifact-manifest.json'),'utf8')));
    expect((await readdir(output)).sort()).toEqual(['SHA256SUMS',unpublished].sort());
    expect(await readFile(join(output,unpublished))).toEqual(await readFile(join(original,unpublished)));
    expect(download).toHaveBeenCalledOnce();
    return;
  }
  const result=pipelinePreparePublication(f.context,output,f.input.controllerDirectory,'fixture-product-token',async args=>JSON.stringify(args.at(-1)==='repos/example/product'
    ?{id:1,full_name:'example/product',archived:false,disabled:false,private:kind==='private-formal'}:artifact),io,io,async(_repo,id,destination,anonymous)=>{
    expect(anonymous).toBe(kind!=='private-formal');
    await copyFile(join(original,names[id-300]!),destination);if(kind==='corrupt-formal'&&destination.endsWith('.exe'))await writeFile(destination,'other bytes');
  },history);
  if(['incomplete-run','failed-run','unbound-run','undispatched'].includes(kind)) { await expect(result).resolves.toMatchObject({status:'WAIT',reason:['unbound-run','undispatched'].includes(kind)?'BUILD_BINDING_REQUIRED':'BUILD_RUN_NOT_READY',publishInvoked:false});expect(download).not.toHaveBeenCalled(); }
  else if(['foreign-run','foreign-source','corrupt-formal','missing-public-asset'].includes(kind))await expect(result).rejects.toThrow(kind==='foreign-run'?'execution source':kind==='foreign-source'?'frozen manifest changed':kind==='missing-public-asset'?'formal frozen bytes missing':/manifest|artifact|sealed|hash|size/i);
  else if(kind==='wrong-selection-source') {
    await expect(result).rejects.toThrow('frozen delivery mismatch');
    expect(download).not.toHaveBeenCalled();
  } else {
    const prepared=await result;
    if(!Array.isArray(prepared)||!prepared[0]?.build)throw Error('publication expected');
    expect(prepared).toHaveLength(1);
    const item=prepared[0];
    expect(item.manifest.runId).toBe(100);
    for(const name of names)expect(await readFile(join(output,'app',name))).toEqual(await readFile(join(original,name)));
    const inventory=item.manifest.artifacts;
    expect(channelFiles(item.build.delivery.units[0]!,'github-release',inventory)).toEqual([...names].sort());
    expect(channelFiles(item.delivery!,'github-release',inventory)).toEqual(kind==='central-selection'?['app-1.0.0.exe']:[...names].sort());
  }
  if(kind==='formal-after-expiry')expect(download).not.toHaveBeenCalled();
  if(kind==='freeze'||kind==='python-freeze'||kind==='partial-draft')expect(download).toHaveBeenCalledOnce();
  if(kind==='python-freeze')expect(manifest.toolLocks).toHaveProperty('source/requirements-build.txt',digest(f.source['requirements-build.txt']!));
});
