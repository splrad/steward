import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipelineIdentity, pipelinePreparePublication } from '../src/release-pipeline.js';
import { sealProductArtifacts, fileDigest, type ProductReleaseManifest } from '../src/release-artifacts.js';
import * as downloads from '../src/native-artifact-download.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { S, C, START, END, digest } from './native-evidence-fixture.js';
import { permitOfflineScript } from './offline-fixtures.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['freeze','python-freeze','incomplete-run','failed-run','unbound-run','undispatched','foreign-run','foreign-source','formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset'])('prepares publication from exact native objects: %s',async kind=>{
  const f=productPipelineFixture();
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
  const original=join(root,'original');await mkdir(original);
  await writeFile(join(original,'app-1.0.0.exe'),'frozen binary');
  await writeFile(join(original,'sbom.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',packages:[]}));
  await writeFile(join(original,'release-notes.md'),`1.0.0\n${S}\n${C}\n`);
  const manifest:ProductReleaseManifest={schemaVersion:3,repositoryId:1,fullName:'example/product',cycleId:record.cycleId,requestKey:record.requestKey,
    unitId:'app',version:'1.0.0',packageVersion:'1.0.0',tag:'v1.0.0',sourceSha:S,controllerSha:C,buildRef:record.buildRef,
    deliverySha256:record.deliverySha256,templateSha256:record.templateSha256,runId:100,attempt:1,toolLocks:record.toolLocks,
    producers:[{buildId:'windows-x64',jobId:1000,attempt:1,artifactId:701}],artifacts:[{id:'app',mediaType:'application/octet-stream',...await fileDigest(original,'app-1.0.0.exe')}],evidence:[]};
  await sealProductArtifacts(original,manifest);
  const names=await readdir(original),unit=f.context.cycle.units[0]!,bound=['formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset'].includes(kind);
  if(bound){unit.releaseId=20;unit.manifestDigest=(await fileDigest(original,'artifact-manifest.json')).sha256;}
  if(kind==='foreign-source')unit.manifestDigest='f'.repeat(64);
  Object.assign(f.runs.get(1),{status:kind==='incomplete-run'?'in_progress':'completed',conclusion:kind==='incomplete-run'?null:kind==='failed-run'?'failure':'success'});
  if(kind==='foreign-run')f.runs.get(1).head_sha='e'.repeat(40);
  const artifact={id:702,name:`final-1-app-${S}-100-1`,expired:false,digest:'sha256:'+digest('archive'),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'};
  const sourceBlob=(value:string)=>{const bytes=Buffer.from(value);return {type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64'),sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
  const calls:string[]=[],io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.startsWith('/repos/splrad/steward/')){expect(path).toBe(`/repos/splrad/steward/contents/mise.lock?ref=${C}`);return f.response(sourceBlob('locked tools'));}
    if(path.includes('/contents/')){const file=path.split('/contents/')[1]!.split('?')[0]!;expect(path.endsWith(`?ref=${S}`)).toBe(true);return f.response(sourceBlob(f.source[file]!));}
    if(path.endsWith('/releases/20'))return f.response({id:20,tag_name:'v1.0.0',author:{id:42},draft:kind==='partial-draft'});
    if(path.includes('/releases/20/assets'))return f.response((kind==='partial-draft'||kind==='missing-public-asset'?names.slice(0,1):names).map((name,i)=>({id:300+i,name,state:'uploaded'})));
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
  const result=pipelinePreparePublication(f.context,output,f.input.controllerDirectory,'fixture-product-token',async args=>JSON.stringify(args.at(-1)==='repos/example/product'
    ?{id:1,full_name:'example/product',archived:false,disabled:false,private:kind==='private-formal'}:artifact),io,io,async(_repo,id,destination,anonymous)=>{
    expect(anonymous).toBe(kind!=='private-formal');
    await copyFile(join(original,names[id-300]!),destination);if(kind==='corrupt-formal'&&destination.endsWith('.exe'))await writeFile(destination,'other bytes');
  });
  if(['incomplete-run','failed-run','unbound-run','undispatched'].includes(kind)) { await expect(result).resolves.toMatchObject({status:'WAIT',reason:['unbound-run','undispatched'].includes(kind)?'BUILD_BINDING_REQUIRED':'BUILD_RUN_NOT_READY',publishInvoked:false});expect(download).not.toHaveBeenCalled(); }
  else if(['foreign-run','foreign-source','corrupt-formal','missing-public-asset'].includes(kind))await expect(result).rejects.toThrow(kind==='foreign-run'?'execution source':kind==='foreign-source'?'frozen manifest changed':kind==='missing-public-asset'?'formal frozen bytes missing':/manifest|artifact|sealed|hash|size/i);
  else {const prepared=await result;if(!Array.isArray(prepared))throw Error('publication expected');expect(prepared).toHaveLength(1);expect(prepared[0]!.manifest.runId).toBe(100);for(const name of names)expect(await readFile(join(output,'app',name))).toEqual(await readFile(join(original,name)));}
  if(kind==='formal-after-expiry')expect(download).not.toHaveBeenCalled();
  if(kind==='freeze'||kind==='python-freeze'||kind==='partial-draft')expect(download).toHaveBeenCalledOnce();
  if(kind==='python-freeze')expect(manifest.toolLocks).toHaveProperty('source/requirements-build.txt',digest(f.source['requirements-build.txt']!));
});
