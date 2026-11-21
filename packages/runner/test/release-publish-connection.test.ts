import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyWorkflowDelivery, githubDeliveryArtifact, mergedBuildCycle, pipelineChannelDownload, pipelineIdentity, pipelinePreparePublication, prepareWorkflowChannelReceipts, readCycleDelivery } from '../src/release-pipeline.js';
import { githubUnits, parseReleaseRecord } from '../../core/src/release-observation.js';
import { parseDeliveryConfig } from '../../core/src/delivery-config.js';
import { sealProductArtifacts, fileDigest, type ProductReleaseManifest } from '../src/release-artifacts.js';
import * as downloads from '../src/native-artifact-download.js';
import { mergedCandidateFixture, productPipelineFixture } from './product-pipeline-fixture.js';
import { S, C, START, END, digest, npmPackageFixture } from './native-evidence-fixture.js';
import { nativeRequestIdentity } from '../src/native-release-evidence.js';
import { permitOfflineScript, registerOfflineFixtureRoot } from './offline-fixtures.js';
import type { WorkflowDeliveryReceipt } from '../../core/src/release-observation.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const deliveryName=(channel:string,unit:string)=>'delivery-'+channel+'-${{ github.repository_id }}-'+unit+'-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}';
it('adopts channels for the declared unit rows of a delivery matrix',()=>{
  const compact={schemaVersion:3,repositoryAuthors:[{id:1,evidence:'approved author record'}]};
  const settings={packages:{'.':{component:'cli'},'docs':{component:'internal-docs'},'sdk':{component:'sdk'}}};
  const units=[{id:'cli',path:'.',version:'1.0.0',tag:'cli-v1.0.0'},
    {id:'internal-docs',path:'docs',version:'1.0.0',tag:'internal-docs-v1.0.0'},
    {id:'sdk',path:'sdk',version:'1.0.0',tag:'sdk-v1.0.0'}];
  const bytes=(matrix:unknown)=>Buffer.from(JSON.stringify({jobs:{deliver:{name:'delivery/${{ matrix.unit }}',
    strategy:{matrix},steps:[{id:'upload-github-release',name:'Upload GitHub release delivery',
      uses:'actions/upload-artifact@'+'a'.repeat(40),
      with:{name:deliveryName('github-release','${{ matrix.unit }}'),path:'dist/${{ matrix.unit }}/*.tgz'}}]}}}));
  const select=(matrix:unknown)=>{
    const workflow=bytes(matrix);
    const handoff=applyWorkflowDelivery(parseDeliveryConfig(compact,settings),workflow);
    const cycle=mergedBuildCycle({prNumber:12,sourceSha:S,sourceTree:S,reviewedTree:S,controllerSha:C,
      deliveryBlobSha:S,delivery:compact,releasePlease:settings,workflow,units});
    return {handoff,cycle};
  };
  const {handoff,cycle}=select({unit:['cli']});
  expect(githubUnits(cycle).map(unit=>unit.id)).toEqual(['cli']);
  expect(cycle.units.find(unit=>unit.id==='internal-docs')).toMatchObject({githubDisabled:true,assets:[],releaseId:null});
  expect(handoff.paths.get('cli')?.get('github-release')).toEqual(['dist/cli/*.tgz']);
  expect(handoff.paths.get('internal-docs')?.size).toBe(0);
  expect(githubUnits(select({unit:['cli'],os:['ubuntu-24.04'],include:[{label:'release archive'}]}).cycle).map(u=>u.id))
    .toEqual(['cli']);
  expect(githubUnits(select({include:[{unit:'sdk',files:'dist/sdk/*.tgz'}]}).cycle).map(unit=>unit.id)).toEqual(['sdk']);
  expect(githubUnits(select({unit:['cli','internal-docs','sdk'],exclude:[{unit:'sdk'},{unit:'internal-docs'}],
    include:[{unit:'sdk',files:'dist/sdk/*.tgz'}]}).cycle).map(unit=>unit.id)).toEqual(['cli','sdk']);
  expect(()=>select({unit:['cli'],os:['ubuntu-24.04','windows-2025']})).toThrow('workflow delivery unit matrix');
  expect(()=>select({include:[{unit:'cli',os:'ubuntu-24.04'},{unit:'cli',os:'windows-2025'}]}))
    .toThrow('workflow delivery unit matrix');
});
it('binds required provenance to each unit and channel selection',()=>{
  const delivery=parseDeliveryConfig({schemaVersion:3,repositoryAuthors:[{id:1,evidence:'approved author record'}]},
    {packages:{'packages/signed':{component:'signed'},'packages/plain':{component:'plain'}}});
  const standard=(unit:string,path:string)=>({id:'upload-github-release',name:'Upload GitHub release delivery',
    uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:deliveryName('github-release',unit),path}});
  const attest=(path:string)=>({uses:'actions/attest-build-provenance@'+'b'.repeat(40),with:{'subject-path':path}});
  const workflow={jobs:{
    signed:{name:'delivery/signed',steps:[attest('dist/signed.tgz'),standard('signed','dist/signed.tgz'),
      {id:'upload-ghcr-assets',name:'Upload GHCR assets delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
        env:{STEWARD_CHANNEL_LOCATION:'ghcr.io/example/product'},with:{name:deliveryName('ghcr-assets','signed'),path:'dist/registry.tgz'}}]},
    plain:{name:'delivery/plain',steps:[attest('dist/internal.tgz'),standard('plain','dist/plain.tgz')]},
  }};
  const {attestations}=applyWorkflowDelivery(delivery,Buffer.from(JSON.stringify(workflow)));
  expect([...attestations.get('signed')!]).toEqual(['github-release']);
  expect(attestations.has('plain')).toBe(false);
});
it.each(['freeze','historical-formal','python-freeze','incomplete-run','failed-run','unbound-run','undispatched','foreign-run','foreign-source','formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset',
  'wrong-contents-path','wrong-contents-blob','missing-v1-template','missing-v2-template'])('prepares publication from exact native objects: %s',async kind=>{
  const f=productPipelineFixture(1,false,kind==='python-freeze'?'requirements-build.txt':'global.json');
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
  if (kind === 'historical-formal'||kind==='missing-v1-template') {
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
  await writeFile(join(original,'app-1.0.0.exe'),'frozen binary');
  await writeFile(join(original,'sbom.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',packages:[]}));
  await writeFile(join(original,'release-notes.md'),`1.0.0\n${S}\n${C}\n`);
  const manifest:ProductReleaseManifest={schemaVersion:3,repositoryId:1,fullName:'example/product',cycleId:record.cycleId,requestKey:record.requestKey,
    unitId:'app',version:'1.0.0',packageVersion:'1.0.0',tag:'v1.0.0',sourceSha:S,controllerSha:C,buildRef:record.buildRef,
    deliverySha256:record.deliverySha256,templateSha256:record.templateSha256,runId:100,attempt:1,toolLocks:record.toolLocks,
    producers:[{buildId:'windows-x64',jobId:1000,attempt:1,artifactId:701}],artifacts:[{id:'app',mediaType:'application/octet-stream',...await fileDigest(original,'app-1.0.0.exe')}],evidence:[]};
  await sealProductArtifacts(original,manifest);
  const names=await readdir(original),unit=f.context.cycle.units[0]!,bound=['historical-formal','formal-after-expiry','private-formal','partial-draft','corrupt-formal','missing-public-asset'].includes(kind);
  if(bound){unit.releaseId=20;unit.manifestDigest=(await fileDigest(original,'artifact-manifest.json')).sha256;}
  if(kind==='foreign-source')unit.manifestDigest='f'.repeat(64);
  Object.assign(f.runs.get(1),{status:kind==='incomplete-run'?'in_progress':'completed',conclusion:kind==='incomplete-run'?null:kind==='failed-run'?'failure':'success'});
  if(kind==='foreign-run')f.runs.get(1).head_sha='e'.repeat(40);
  const artifact={id:702,name:`final-1-app-${S}-100-1`,expired:false,digest:'sha256:'+digest('archive'),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'};
  const sourceBlob=(path:string,value:string)=>{const bytes=Buffer.from(value);return {path,type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64'),sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
  const calls:string[]=[],io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.startsWith('/repos/splrad/steward/')){expect(path).toBe(`/repos/splrad/steward/contents/mise.lock?ref=${C}`);return f.response(sourceBlob('mise.lock','locked tools'));}
    if(path.includes('/contents/')){
      const file=path.split('/contents/')[1]!.split('?')[0]!;expect(path.endsWith(`?ref=${S}`)).toBe(true);
      const isTemplate=file==='.github/release-template.md.mustache';
      if(isTemplate&&(kind==='missing-v1-template'||kind==='missing-v2-template'))return {...f.response({}),status:404};
      const blob=sourceBlob(file,f.source[file]!);
      if(isTemplate&&kind==='wrong-contents-path')blob.path='.github/other.md';
      if(file==='.github/delivery.json'&&kind==='wrong-contents-blob')blob.sha='a'.repeat(40);
      return f.response(blob);
    }
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
  else if(kind==='wrong-contents-path'||kind==='wrong-contents-blob'||kind==='missing-v1-template'||kind==='missing-v2-template') {
    const errors={'wrong-contents-path':'source file identity','wrong-contents-blob':'source blob digest',
      'missing-v1-template':'NATIVE_HTTP_404','missing-v2-template':'NATIVE_HTTP_404'};
    await expect(result).rejects.toThrow(errors[kind]);
    expect(download).not.toHaveBeenCalled();
  }
  else if(['foreign-run','foreign-source','corrupt-formal','missing-public-asset'].includes(kind))await expect(result).rejects.toThrow(kind==='foreign-run'?'execution source':kind==='foreign-source'?'frozen manifest changed':kind==='missing-public-asset'?'formal frozen bytes missing':/manifest|artifact|sealed|hash|size/i);
  else {const prepared=await result;if(!Array.isArray(prepared))throw Error('publication expected');expect(prepared).toHaveLength(1);expect(prepared[0]!.manifest.runId).toBe(100);for(const name of names)expect(await readFile(join(output,'app',name))).toEqual(await readFile(join(original,name)));}
  if(kind==='formal-after-expiry')expect(download).not.toHaveBeenCalled();
  if(kind==='freeze'||kind==='python-freeze'||kind==='partial-draft')expect(download).toHaveBeenCalledOnce();
  if(kind==='python-freeze')expect(manifest.toolLocks).toHaveProperty('source/requirements-build.txt',digest(f.source['requirements-build.txt']!));
});

it.each(['legacy','conditional'])('prepares a native Node delivery with the %s notes template and reuses the original attempt',async layout=>{
  const f=productPipelineFixture(2,false,[]),{context,source}=f;
  const conditional=layout==='conditional';
  permitOfflineScript(resolve('scripts/inspect-python-release.py'));
  f.input.controllerDirectory=process.cwd();
  const workflow='.github/workflows/steward-release-publish.yml';
  const settings={'include-component-in-tag':false,packages:{'.':{'release-type':'node',component:'app'}}};
  source['release-please-config.json']=JSON.stringify(settings);
  source['package.json']='{"name":"fixture-cli","version":"1.0.0"}';
  source['CHANGELOG.md']='## [1.0.0](https://github.com/example/product/compare/v0.9.0...v1.0.0)\n\n### Features\n\nCLI.\n';
  source['.release-notes/app.md']=['概述','更新内容','兼容性','升级与迁移','安装说明','已知问题','恢复'].map(label=>'## '+label+'\n\n已审文稿。').join('\n\n');
  if(conditional) {
    source['.release-notes/app.md']='## 获取与使用\n\n**安装命令**。从[本版附件](<https://github.com/example/product/releases/download/v1.0.0/fixture-cli.tgz>)获取 CLI。\n\n```sh\nnpm install -g ./fixture-cli.tgz\n```\n';
    source['.github/release-contributors.json']=JSON.stringify([{id:902,evidence:'Offline confirmation'}]);
  }
  function adoptedWorkflow(files:string[]) {
    return JSON.stringify({'run-name':'为 GitHub 打包 ${{ inputs.operation_key }}',on:{workflow_dispatch:{
      inputs:Object.fromEntries(['cycle_id','operation_key','source_sha','controller_sha'].map(key=>[key,{type:'string',required:true}]))
    }},jobs:{internal:{steps:[{uses:'actions/attest@'+'b'.repeat(40),with:{'subject-path':'internal.zip'}}]},
      package:{name:'delivery/app',steps:[
      {run:'node build.mjs'},{id:'upload-github-release',name:'Upload GitHub release delivery',
        uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:deliveryName('github-release','app'),path:files.join('\n')}},
    ]}}});
  }
  const initial=['dist/fixture-cli.tgz','dist/fixture-cli-*.sha256'];
  const sharedTemplate=conditional ? await readFile('templates/repository/.github/release-template.md.mustache','utf8') : source['.github/release-template.md.mustache']!;
  source['.github/release-template.md.mustache']='disallowed product override';
  source[workflow]=adoptedWorkflow(initial);
  source['.github/delivery.json']=JSON.stringify(conditional?{schemaVersion:3}:{schemaVersion:3,repositoryAuthors:f.delivery.repositoryAuthors});
  const sourceConfig=source['.github/delivery.json'];
  if(conditional) {
    const chunk=f.input.state.domainRecords.find(record=>(record.value as {documentKind?:string}).documentKind==='session')!.value as
      {content:string;documentDigest:string};
    const session=JSON.parse(chunk.content);
    session.identity.authorsDigest=digest('[]');
    session.identity.noteTemplate=sharedTemplate;
    chunk.content=JSON.stringify(session);
    chunk.documentDigest=digest(chunk.content);
  }
  const bytes=Buffer.from(sourceConfig);
  context.cycle.deliveryConfigSha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  context.cycle.buildWorkflow=f.request.buildWorkflow=workflow;
  context.cycle.workflowDelivery=true;
  Object.assign(f.request,nativeRequestIdentity(context.repositoryId,context.cycle,f.request));
  f.input.operationKey=f.request.inputs.operation_key=f.request.operationKey;
  f.runs.get(2).display_title='为 GitHub 打包 '+f.request.operationKey;
  expect(await pipelineIdentity(f.input,f.environment,f.gh,f.io)).toMatchObject({status:'SOURCE_VERIFIED',
    units:[{unit:'app',tag:'v1.0.0',version:'1.0.0',packageVersion:'1.0.0'}]});
  const originalBuild = {...f.runs.get(2),status:'completed',conclusion:'success',run_attempt:1};
  Object.assign(f.runs.get(2),{status:'completed',conclusion:'success'});
  const history=[mergedCandidateFixture(f.input)];
  if(conditional) {
    const chunk=history[0]!.value;
    const document=JSON.parse(chunk.content);
    const actor={id:902,login:'verified-contributor',type:'User',profileUrl:'https://github.com/verified-contributor',avatarUrl:'https://avatars.githubusercontent.com/u/902'};
    const projection={actors:[actor],contributors:{contributors:[{id:actor.id,login:actor.login,profileUrl:actor.profileUrl,avatarUrl:actor.avatarUrl,alt:actor.login}],unresolved:0}};
    Object.assign(document.session.identity,projection,{authorsDigest:digest('[]'),noteTemplate:sharedTemplate,units:[{id:'app',...projection}]});
    chunk.content=JSON.stringify(document);
    chunk.documentDigest=digest(chunk.content);
  }
  const artifact={id:810,name:['delivery','github-release',context.repositoryId,'app',S,100,1].join('-'),expired:false,
    digest:'sha256:'+digest('node archive'),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'};
  let deliveryConclusion='success',wrongSourcePath=false,notesStatus=200;
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path.includes('/contents/')) {
      const file=path.split('/contents/')[1]!.split('?')[0]!;
      if(file==='.release-notes/app.md'&&notesStatus!==200)return f.response({},notesStatus);
      if(file.endsWith('/release-template.md.mustache'))
        expect(path).toBe('/repos/splrad/steward/contents/templates/repository/.github/release-template.md.mustache?ref='+C);
      const value=path.startsWith('/repos/splrad/steward/')?sharedTemplate:source[file];
      if(value===undefined)return f.response({},404);
      const bytes=Buffer.from(value);
      return f.response({type:'file',path:wrongSourcePath&&file===workflow?'.github/workflows/other.yml':file,encoding:'base64',size:bytes.length,content:bytes.toString('base64'),
        sha:createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')});
    }
    if(path.endsWith('/runs/100'))return f.response(f.runs.get(2));
    if(path.endsWith('/runs/100/attempts/1'))return f.response(originalBuild);
    if(path.includes('/artifacts?'))return f.response({total_count:1,artifacts:[artifact]});
    if(path.includes('/attempts/1/jobs?'))return f.response({total_count:1,jobs:[{id:1100,name:'delivery/app',run_id:100,run_attempt:1,
      head_sha:S,status:'completed',conclusion:deliveryConclusion,steps:[{name:'Upload GitHub release delivery',status:'completed',conclusion:'success',started_at:START,completed_at:END}]}]});
    throw Error('Unexpected workflow publication source '+path);
  }};
  const output=await mkdtemp(join(tmpdir(),'direct-github-delivery-'));roots.push(output);registerOfflineFixtureRoot(output);
  const packageBytes=npmPackageFixture('1.0.0');
  let delivered:Uint8Array|string=packageBytes;
  const prepare=async (child:string,selected:string[],unavailable?:(id:string)=>void)=>{
    const directory=join(output,child);await mkdir(directory);
    return pipelinePreparePublication(context,directory,f.input.controllerDirectory,'fixture-token',async()=>{throw Error('unexpected gh command');},
      io,io,undefined,history,undefined,async input=>{
        expect(input).toMatchObject({artifactId:artifact.id,digest:artifact.digest});
        await mkdir(input.directory);for(const name of selected)await writeFile(join(input.directory,name),name.endsWith('.tgz')?delivered:'checksums\n');
      },unavailable);
  };
  const originalManifest=source['.release-please-manifest.json']!;
  source['.release-please-manifest.json']='{}';
  await expect(prepare('missing-version-in-merged-source',initial)).rejects.toThrow('native version source');
  source['.release-please-manifest.json']=JSON.stringify({...JSON.parse(originalManifest),unknown:'0.1.0'});
  await expect(prepare('unknown-version-in-merged-source',initial)).rejects.toThrow('Release Please delivery paths');
  source['.release-please-manifest.json']=originalManifest;
  const originalSettings=source['release-please-config.json']!;
  const partial=JSON.parse(originalSettings);
  partial.packages['packages/docs']={component:'docs','release-type':'simple'};
  source['release-please-config.json']=JSON.stringify(partial);
  await expect(prepare('unreleased-package-outside-merged-cycle',initial)).resolves.toMatchObject([{manifest:{unitId:'app',version:'1.0.0'}}]);
  source['release-please-config.json']=originalSettings;
  delivered='incorrect archive bytes';
  await expect(prepare('invalid-format',initial)).rejects.toThrow('RN_DELIVERY_FORMAT: fixture-cli.tgz');
  delivered=npmPackageFixture('2.0.0');
  await expect(prepare('wrong-embedded-version',initial)).rejects.toThrow('RN_DELIVERY_VERSION: fixture-cli.tgz');
  delivered=packageBytes;
  await expect(prepare('unselected-file',[...initial,'unexpected.txt'])).rejects.toThrow('RN_DELIVERY_SELECTION');
  wrongSourcePath=true;
  await expect(prepare('wrong-source-path',initial)).rejects.toThrow('source file identity');
  wrongSourcePath=false;
  notesStatus=503;
  const unavailableSource=vi.fn();
  await expect(prepare('unavailable-notes',initial,unavailableSource)).rejects.toMatchObject({status:503});
  expect(unavailableSource).not.toHaveBeenCalled();
  notesStatus=200;
  const prepared=await prepare('first',initial);if(!Array.isArray(prepared))throw Error('workflow publication expected');
  const target=prepared[0];
  if(!target||!('publicBody' in target)||typeof target.publicBody!=='string')throw Error('workflow public body expected');
  expect(prepared[0]).toMatchObject({githubDelivery:{artifactId:810,runId:100,attempt:1},manifest:{
    schemaVersion:4,packageVersion:'1.0.0',attested:false,artifacts:[{path:'fixture-cli.tgz'}]}});
  expect(await readdir(prepared[0]!.directory)).toEqual(initial);
  expect(prepared[0]).toHaveProperty('publicBody',expect.stringContaining('fixture-cli.tgz'));
  if(conditional) {
    const body=target.publicBody;
    expect(body).toContain('~~~sh\nnpm install -g ./fixture-cli.tgz\n~~~');
    expect(body).toContain('alt="verified-contributor" width="48"');
    expect(body).toContain('## 版本记录');
    const before=source['.release-notes/app.md']!;
    source['.release-notes/app.md']=before.replace('/fixture-cli.tgz>)','/internal.tgz>)');
    await expect(prepare('unselected-notes-link',initial)).rejects.toThrow('acquisition link is outside the release version');
    source['.release-notes/app.md']=before;
  }
  const notes=source['.release-notes/app.md']!;
  delete source['.release-notes/app.md'];
  const skipped=vi.fn();
  await expect(prepare('missing-reviewed-notes',initial,skipped)).rejects.toThrow('frozen product file missing');
  expect(skipped).not.toHaveBeenCalled();
  source['.release-notes/app.md']=notes;
  const retained:WorkflowDeliveryReceipt={artifactId:artifact.id,runId:100,attempt:1,digest:artifact.digest};
  Object.assign(context.cycle.units[0]!,{githubDelivery:retained});
  for(const [status,conclusion] of [['in_progress',null],['completed','failure'],['completed','success']]) {
    Object.assign(f.runs.get(2),{status,conclusion});
    expect(await prepare('retry-'+(conclusion??status),initial)).toMatchObject([
      {githubDelivery:retained,publicBody:target.publicBody,manifest:{artifacts:[{path:'fixture-cli.tgz',sha256:digest(packageBytes)}]}},
    ]);
  }
  originalBuild.run_attempt=2;
  await expect(prepare('wrong-original-run-attempt',initial)).rejects.toThrow('original workflow build attempt identity');
  originalBuild.run_attempt=1;originalBuild.conclusion='failure';
  await expect(prepare('failed-original-run-attempt',initial)).rejects.toThrow('original GitHub delivery build not ready');
  originalBuild.conclusion='success';
  deliveryConclusion='failure';
  await expect(prepare('failed-delivery-job',initial)).rejects.toThrow('successful GitHub delivery artifact missing');
  deliveryConclusion='success';
  artifact.id=811;
  await expect(prepare('changed-id',initial)).rejects.toThrow('receipt changed');
  delete context.cycle.units[0]!.githubDelivery;

  const scope=['${{ runner.temp }}/dist/*.tgz','!${{ runner.temp }}/dist/internal.tgz'];
  source[workflow]=adoptedWorkflow(scope);
  await expect(prepare('allow-matching-glob',initial)).resolves.toMatchObject([{manifest:{artifacts:[{path:'fixture-cli.tgz'}]}}]);
  await expect(prepare('reject-explicitly-excluded',[...initial,'internal.tgz'])).rejects.toThrow('RN_DELIVERY_SELECTION');
  await expect(prepare('reject-outside-glob',[...initial,'checksums.txt'])).rejects.toThrow('RN_DELIVERY_SELECTION');
  source[workflow]=adoptedWorkflow([...scope,'${{ runner.temp }}/dist/internal.tgz']);
  await expect(prepare('allow-reincluded',[...initial,'internal.tgz'])).resolves.toMatchObject([
    {manifest:{artifacts:[{path:'fixture-cli.tgz'},{path:'internal.tgz'}]}},
  ]);
  source[workflow]=adoptedWorkflow(['dist/*']);
  await expect(prepare('allow-reviewed-directory-glob',[...initial,'checksums.txt'])).resolves.toMatchObject([
    {manifest:{artifacts:[{path:'checksums.txt'},{path:'fixture-cli.tgz'}]}},
  ]);

  for(const leaf of ['app','v1.2.3','net8.0','README']) {
    source[workflow]=adoptedWorkflow(['dist/'+leaf]);
    await expect(prepare('native-directory-root-'+leaf,initial)).resolves.toMatchObject([{manifest:{artifacts:[{path:'fixture-cli.tgz'}]}}]);
  }
  source[workflow]=adoptedWorkflow(['dist/README']);
  await expect(prepare('native-single-extensionless-file',['README'])).resolves.toMatchObject([{manifest:{artifacts:[{path:'README'}]}}]);
  source[workflow]=adoptedWorkflow(['dist/README','dist/fixture-cli.tgz']);
  await expect(prepare('literal-siblings-at-proven-root',['README',...initial])).resolves.toMatchObject([
    {manifest:{artifacts:[{path:'README'},{path:'fixture-cli.tgz'}]}},
  ]);
  await expect(prepare('missing-literal-at-proven-root',initial)).rejects.toThrow('RN_DELIVERY_SELECTION');
  source[workflow]=adoptedWorkflow(['dist/app','dist/fixture-cli.tgz']);
  await expect(prepare('missing-extensionless-sibling',initial)).rejects.toThrow('RN_DELIVERY_SELECTION');
  await expect(prepare('extensionless-sibling-has-no-format-inspector',[...initial,'app'])).rejects.toThrow('RN_DELIVERY_UNSUPPORTED: app');
  source[workflow]=adoptedWorkflow(['dist/*','!dist/app']);
  await expect(prepare('allow-extensionless-exclusion',initial)).resolves.toMatchObject([{manifest:{artifacts:[{path:'fixture-cli.tgz'}]}}]);
  await expect(prepare('reject-extensionless-exclusion',[...initial,'app'])).rejects.toThrow('RN_DELIVERY_SELECTION');

  const aggregate=(targets:{name:string;runner:string}[],usesMatrixFiles=false)=>{
    const built=JSON.parse(adoptedWorkflow([]));
    const upload='actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
    const selected=['dist/${{ matrix.unit }}/fixture-cli-*.tgz','!dist/${{ matrix.unit }}/fixture-cli-debug.tgz'].join('\n');
    built.jobs.build={name:'build/${{ matrix.name }}','runs-on':'${{ matrix.runner }}',strategy:{matrix:{include:targets}},steps:[
      {run:'npm run package -- --target "${{ matrix.name }}"'},
      {uses:upload,with:{name:'cli-target-${{ matrix.name }}',path:'out/fixture-cli-${{ matrix.name }}.tgz'}},
    ]};
    const delivery=built.jobs.package;
    delivery.name='delivery/${{ matrix.unit }}';
    delivery.needs='build';
    delivery['runs-on']='ubuntu-24.04';
    delivery.strategy={matrix:usesMatrixFiles?{include:[{unit:'app',files:'dist/app/fixture-cli-*.tgz'}]}:{unit:['app']}};
    delivery.steps=[{uses:'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
      with:{pattern:'cli-target-*',path:'dist/app','merge-multiple':true}},
      {...delivery.steps[1],uses:upload,with:{name:deliveryName('github-release','${{ matrix.unit }}'),
        path:usesMatrixFiles?'${{ matrix.files }}':selected}}];
    return JSON.stringify(built);
  };
  const targets=[{name:'linux-x64',runner:'ubuntu-24.04'},{name:'win-x64',runner:'windows-2025'}];
  if(conditional) source['.release-notes/app.md']='## 获取与使用\n\n**按平台安装**。从[本版附件](<https://github.com/example/product/releases/tag/v1.0.0>)选取对应平台的软件包。\n';
  source[workflow]=aggregate(targets);
  const platformFiles=targets.map(({name})=>'fixture-cli-'+name+'.tgz');
  const two=await prepare('aggregate-two',platformFiles);
  expect(two).toMatchObject([{githubDelivery:{runId:100,artifactId:811,attempt:1},
    manifest:{artifacts:platformFiles.map(path=>({path,sha256:digest(packageBytes)}))}}]);
  if(conditional) expect(two).toMatchObject([{publicBody:expect.stringContaining('/releases/tag/v1.0.0')}]);
  await expect(prepare('reject-matrix-exclusion',[...platformFiles,'fixture-cli-debug.tgz'])).rejects.toThrow('RN_DELIVERY_SELECTION');
  await expect(prepare('reject-non-package',[...platformFiles,'checksums.txt'])).rejects.toThrow('RN_DELIVERY_SELECTION');
  const third={name:'macos-arm64',runner:'macos-15'};
  source[workflow]=aggregate([...targets,third]);
  expect(JSON.parse(source[workflow]!).jobs.package).toEqual(JSON.parse(aggregate(targets)).jobs.package);
  await expect(prepare('aggregate-three',[...platformFiles,'fixture-cli-'+third.name+'.tgz'])).resolves.toMatchObject([
    {manifest:{artifacts:[...platformFiles,'fixture-cli-'+third.name+'.tgz'].sort().map(path=>({path}))}},
  ]);
  source[workflow]=aggregate(targets,true);
  await expect(prepare('matrix-row-selects-path',platformFiles)).resolves.toMatchObject([
    {manifest:{artifacts:platformFiles.map(path=>({path}))}},
  ]);
  await expect(prepare('matrix-row-rejects-unmatched',[...platformFiles,'checksums.txt'])).rejects.toThrow('RN_DELIVERY_SELECTION');

  const next=['fixture-cli.tgz','checksums.txt'];
  source[workflow]=adoptedWorkflow(next);
  expect(source['.github/delivery.json']).toBe(sourceConfig);
  expect(await prepare('new-selection',next)).toMatchObject([{manifest:{artifacts:[{path:'checksums.txt'},{path:'fixture-cli.tgz'}]}}]);
  const amended=JSON.parse(source[workflow]!);
  amended.jobs.package.steps[1].with.name='delivery-github-release-fixture';
  source[workflow]=JSON.stringify(amended);
  await expect(prepare('incomplete-identity',next)).rejects.toThrow('workflow channel delivery step');
  amended.jobs.package.steps[1].with.name=deliveryName('github-release','app');
  amended.jobs.package.steps.push({uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:'delivery-github-release-duplicate'}});
  source[workflow]=JSON.stringify(amended);
  await expect(prepare('ambiguous-upload',next)).rejects.toThrow('ambiguous workflow delivery upload name');
  amended.jobs.other={steps:[amended.jobs.package.steps.pop()]};
  source[workflow]=JSON.stringify(amended);
  await expect(prepare('other-job-upload',next)).rejects.toThrow('ambiguous workflow delivery upload name');
  delete amended.jobs.other;
  amended.jobs.archive={steps:[{name:'business-freeze',uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:'final-fixture'}}]};
  source[workflow]=JSON.stringify(amended);
  await expect(prepare('separate-legacy-freeze',next)).rejects.toThrow('workflow-owned product must deliver its files');

  const internal={id:'internal-docs',path:'docs',version:'2.0.0',tag:'internal-docs-v2.0.0'};
  const scopedSettings={...settings,packages:{...settings.packages,docs:{'release-type':'simple','version-file':'VERSION',
    component:internal.id,'include-component-in-tag':true}}};
  source['release-please-config.json']=JSON.stringify(scopedSettings);
  source['.release-please-manifest.json']=JSON.stringify({'.':'1.0.0',docs:internal.version});
  source['docs/VERSION']='2.0.0\n';
  source[workflow]=aggregate(targets);
  const scoped=mergedBuildCycle({prNumber:context.cycle.prNumber,sourceSha:S,sourceTree:S,reviewedTree:S,controllerSha:C,
    deliveryBlobSha:context.cycle.deliveryConfigSha,delivery:JSON.parse(sourceConfig),releasePlease:scopedSettings,
    workflow:Buffer.from(source[workflow]!),units:[{id:'app',path:'.',version:'1.0.0',tag:'v1.0.0'},internal]});
  expect(scoped.units[1]).toMatchObject({id:internal.id,githubDisabled:true});
  const request={...f.request,inputs:{...f.request.inputs}};
  Object.assign(request,nativeRequestIdentity(context.repositoryId,scoped,request));
  request.inputs.operation_key=request.operationKey;
  scoped.dispatches.push(request);
  context.cycle=scoped;
  f.runs.get(2).display_title=originalBuild.display_title='为 GitHub 打包 '+request.operationKey;
  await expect(prepare('only-matrix-unit-delivers',platformFiles)).resolves.toMatchObject([
    {unitId:'app',githubDelivery:{artifactId:811,attempt:1}},
  ]);
},30_000);

it('selects separate GitHub and authorized channel assemblies and restores only the original external bytes',async()=>{
  permitOfflineScript(resolve('scripts/inspect-python-release.py'));
  const f=productPipelineFixture(1),repository='splrad/LayerScape',repositoryId=1187527897,appBotId=42;
  const workflow='.github/workflows/steward-release-publish.yml',compact=JSON.stringify({schemaVersion:3,repositoryAuthors:f.delivery.repositoryAuthors});
  const settings={'release-type':'simple',packages:{'packages/desktop':{component:'layerscape'},'packages/tools':{component:'tools'}}};
  const step=(id:string,name:string,channel:string,location?:string)=>({id,name,uses:'actions/upload-artifact@'+'a'.repeat(40),
    with:{name:deliveryName(channel,'layerscape'),path:channel+'/*'},...(location?{env:{STEWARD_CHANNEL_LOCATION:location}}:{})});
  const definition={jobs:{deliver:{name:'delivery/layerscape',steps:[
    step('upload-github-release','Upload GitHub release delivery','github-release'),
    step('upload-ghcr-assets','Upload GHCR assets delivery','ghcr-assets','ghcr.io/splrad/layerscape-assets'),
    step('upload-winget','Upload WinGet delivery','winget','SPLRAD.LayerScape.Deployer'),
  ]},internal:{name:'package internal tools',steps:[{run:'build internal tools'}]}}};
  const gitBlob=(value:string)=>{const bytes=Buffer.from(value);return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');};
  const handoff={prNumber:12,sourceSha:S,controllerSha:C,sourceTree:S,reviewedTree:S,deliveryBlobSha:gitBlob(compact),delivery:JSON.parse(compact),
    releasePlease:settings,workflow:Buffer.from(JSON.stringify(definition)),repository,repositoryId,units:[
      {id:'layerscape',path:'packages/desktop',version:'1.0.0',tag:'v1.0.0'},
      {id:'tools',path:'packages/tools',version:'1.0.0',tag:'tools-v1.0.0'},
    ]};
  const cycle=mergedBuildCycle(handoff),context={repository,repositoryId,appBotId,cycle};
  expect(githubUnits(cycle).map(unit=>unit.id)).toEqual(['layerscape']);
  expect(cycle.units[1]).toMatchObject({id:'tools',githubDisabled:true,releaseId:null,assets:[]});
  expect(cycle.requiredChannels.map(({unitId,channelId})=>[unitId,channelId])).toEqual([['layerscape','ghcr-assets'],['layerscape','winget']]);
  expect(()=>mergedBuildCycle({...handoff,repository:'example/product',repositoryId:1})).toThrow('external adapter is not registered');
  const disabled=structuredClone(definition);disabled.jobs.deliver.steps.shift();
  expect(()=>mergedBuildCycle({...handoff,workflow:Buffer.from(JSON.stringify(disabled))})).toThrow('requires a published Release ID');
  const request={...f.request,buildWorkflow:workflow,inputs:{...f.request.inputs}};
  Object.assign(request,nativeRequestIdentity(repositoryId,cycle,request));request.inputs.operation_key=request.operationKey;
  cycle.dispatches.push(request);
  const unit=cycle.units[0]!;
  Object.assign(unit,{releaseId:50,manifestDigest:digest('public receipt'),notesDigest:digest('approved notes'),
    githubDelivery:{runId:100,attempt:1,artifactId:800,digest:'sha256:'+digest('public archive')},
    assets:[{id:'desktop',path:'desktop.exe',size:8,sha256:digest('public!!')}]});
  const run={...f.runs.get(1),repository:{id:repositoryId},head_repository:{id:repositoryId},path:workflow,
    status:'completed',conclusion:'success',run_attempt:1,display_title:'Build '+request.operationKey};
  const makeArtifact=(id:number,attempt:number,channel='ghcr-assets')=>({id,name:['delivery',channel,repositoryId,unit.id,S,100,attempt].join('-'),
    expired:false,digest:'sha256:'+digest(String(id)),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'});
  const artifacts=[makeArtifact(810,1)],reads:string[]=[];
  let publicBytes='public!!',publicStatus=200;
  const io={anonymous:()=>io,request:async(method:string,path:string)=>{
    expect(method).toBe('GET');reads.push(path);
    if(path.includes('/contents/')) {
      const name=path.split('/contents/')[1]!.split('?')[0];
      const value=name==='.github/delivery.json'?compact:name==='release-please-config.json'?JSON.stringify(settings):JSON.stringify(definition);
      const bytes=Buffer.from(value);return f.response({type:'file',path:name,encoding:'base64',size:bytes.length,content:bytes.toString('base64'),sha:gitBlob(value)});
    }
    if(path.endsWith('/runs/100'))return f.response(run);
    if(path.endsWith('/runs/100/attempts/1'))return f.response({...run,status:'completed',conclusion:'success',run_attempt:1});
    if(path.includes('/artifacts?'))return f.response({total_count:artifacts.length,artifacts});
    if(path.includes('/attempts/1/jobs?'))return f.response({total_count:1,jobs:[{name:'delivery/layerscape',id:1001,
      run_id:100,run_attempt:1,head_sha:S,status:'completed',conclusion:'success',
      steps:['Upload GHCR assets delivery','Upload WinGet delivery'].map(name=>({name,status:'completed',conclusion:'success',started_at:START,completed_at:END}))}]});
    if(path.endsWith('/assets/51'))return f.response(publicBytes,publicStatus);
    if(path.includes('/releases/50/assets?'))return f.response([{id:51,name:'desktop.exe',size:8,state:'uploaded'}]);
    if(path.endsWith('/releases/50'))return f.response({id:50,tag_name:unit.tag,author:{id:appBotId},body:'approved notes',draft:false,immutable:true});
    if(path.endsWith('/commits/'+unit.tag))return f.response({sha:S});
    if(path==='/repos/'+repository)return f.response({id:repositoryId,full_name:repository,private:false,archived:false,disabled:false});
    throw Error('unexpected request '+path);
  }};
  const root=await mkdtemp(join(tmpdir(),'channel-workflow-delivery-'));roots.push(root);registerOfflineFixtureRoot(root);
  let bytes:Uint8Array|string=npmPackageFixture('2.0.0');
  const download=async(input:Parameters<typeof downloads.downloadWorkflowArtifact>[0])=>{
    if(input.artifactId===820) {
      await mkdir(input.directory);await writeFile(join(input.directory,'desktop.exe'),'wrong installer format');return;
    }
    expect(input).toMatchObject({artifactId:810,digest:artifacts[0]!.digest});
    await mkdir(input.directory);await writeFile(join(input.directory,'registry.tgz'),bytes);
  };
  const invalid=join(root,'wrong-version');await mkdir(invalid);
  const controller=process.cwd();
  await expect(prepareWorkflowChannelReceipts(context,invalid,controller,'fixture-token',[],io,download)).resolves.toMatchObject({
    receipts:[],rejected:[{unitId:'layerscape',channelId:'ghcr-assets',reason:'RN_DELIVERY_VERSION: registry.tgz'}],
  });
  bytes=npmPackageFixture('1.0.0');
  const ghcr=definition.jobs.deliver.steps[1]!.with;
  ghcr.path='ghcr-assets/*\n!ghcr-assets/registry.tgz';
  const excluded=join(root,'excluded-channel-file');await mkdir(excluded);
  await expect(prepareWorkflowChannelReceipts(context,excluded,controller,'fixture-token',[],io,download)).resolves.toMatchObject({
    receipts:[],rejected:[{unitId:'layerscape',channelId:'ghcr-assets',reason:expect.stringContaining('RN_DELIVERY_SELECTION')}],
  });
  ghcr.path='ghcr-assets/*';
  const mixed=join(root,'mixed');await mkdir(mixed);
  artifacts.push(makeArtifact(820,1,'winget'));
  await expect(prepareWorkflowChannelReceipts(context,mixed,controller,'fixture-token',[],io,download)).resolves.toMatchObject({
    receipts:[{unitId:'layerscape',frozen:{channelId:'ghcr-assets'}}],
    missing:[],rejected:[{unitId:'layerscape',channelId:'winget',reason:'RN_DELIVERY_FORMAT: desktop.exe'}],
  });
  artifacts.pop();
  const prepared=await prepareWorkflowChannelReceipts(context,root,controller,'fixture-token',[],io,download);
  expect(prepared.missing).toEqual([{unitId:'layerscape',channelId:'winget'}]);
  expect(prepared.receipts).toMatchObject([{unitId:'layerscape',frozen:{channelId:'ghcr-assets',delivery:{artifactId:810,attempt:1,runId:100},
    assets:[{path:'registry.tgz',sha256:digest(bytes)}]}}]);
  publicBytes='conflict';
  await expect(prepareWorkflowChannelReceipts(context,root,controller,'fixture-token',[],io,download)).rejects.toThrow('formal release bytes');
  publicBytes='public!!';
  publicStatus=404;
  await expect(prepareWorkflowChannelReceipts(context,root,controller,'fixture-token',[],io,download)).rejects.toMatchObject({status:404});
  publicStatus=200;
  unit.channelDeliveries=prepared.receipts.map(receipt=>receipt.frozen);
  expect(parseReleaseRecord('cycle',cycle).units[0]?.channelDeliveries).toEqual(unit.channelDeliveries);
  const {delivery}=await readCycleDelivery(context,[],io);
  const source={unit:delivery.units.find(unit=>unit.id==='layerscape')!,controllerDirectory:root,history:[]};
  const target={unitId:'layerscape',channelId:'ghcr-assets',releaseId:50,manifestDigest:unit.manifestDigest!,version:unit.version};
  Object.assign(run,{run_attempt:2,status:'in_progress',conclusion:null});artifacts.push(makeArtifact(811,2));
  vi.stubEnv('GH_TOKEN','fixture-token');
  const beforeRetry=reads.length;
  await expect(pipelineChannelDownload(context,target,join(root,'retry'),undefined,undefined,source,io,download))
    .resolves.toMatchObject({channelFiles:['registry.tgz'],delivery:{artifactId:810,attempt:1,runId:100}});
  expect(await readdir(join(root,'retry'))).toEqual(['registry.tgz']);
  expect(reads.slice(beforeRetry).filter(path=>/\/runs\/100(?:\/attempts\/\d+)?$/.test(path))).toEqual([
    '/repos/'+repository+'/actions/runs/100/attempts/1',
  ]);
  expect(reads.some(path=>path.includes('/attempts/2/jobs?')||path.includes('tools'))).toBe(false);
  bytes='drifted registry archive';
  await expect(pipelineChannelDownload(context,target,join(root,'drift'),undefined,undefined,source,io,download)).rejects.toThrow('frozen channel bytes changed');
});

it('uses the first successful original upload when a failed attempt also left an artifact',async()=>{
  const input={fullName:'example/product',sourceSha:S,repositoryId:1,runId:100,attempt:2};
  const make=(attempt:number)=>({id:800+attempt,name:`delivery-github-release-1-app-${S}-100-${attempt}`,expired:false,
    digest:'sha256:'+digest(String(attempt)),workflow_run:{id:100,head_sha:S},created_at:'2026-10-26T00:00:30.000Z'});
  const pages=async(path:string,field:'jobs'|'artifacts')=>{
    if(field==='artifacts')return [make(1),make(2)];
    const attempt=path.includes('/attempts/1/')?1:2;
    return [{name:'delivery/app',run_id:100,run_attempt:attempt,head_sha:S,status:'completed',conclusion:attempt===1?'failure':'success',
      steps:[{name:'Upload GitHub release delivery',status:'completed',conclusion:'success',started_at:START,completed_at:END}]}];
  };
  await expect(githubDeliveryArtifact(input,'app','delivery/app',pages)).resolves.toMatchObject({artifactId:802,attempt:2});
  await expect(githubDeliveryArtifact(input,'app','delivery/app',pages,1)).rejects.toThrow('successful GitHub delivery artifact missing');
});

it('uses actual public attachments for an external channel on a legacy complete seal',async()=>{
  const f=productPipelineFixture(),{context}=f;
  const unit=context.cycle.units[0]!,name='app-1.0.0.exe',bytes='verified installer data';
  Object.assign(unit,{releaseId:50,manifestDigest:digest('complete seal'),notesDigest:digest('notes'),
    assets:[{id:'app',path:name,size:bytes.length,sha256:digest(bytes)}],
    githubDelivery:{artifactId:500,runId:100,attempt:1,digest:'sha256:'+digest('selected ZIP')}});
  context.cycle.requiredChannels=[{unitId:unit.id,channelId:'ghcr-assets'}];
  const {unitId,channelId}=context.cycle.requiredChannels[0]!;
  const target={unitId,channelId,releaseId:50,version:unit.version,manifestDigest:unit.manifestDigest!};
  const original=f.delivery.units[0]!;
  const source={unit:{...original,assets:original.assets.map(({id,name,mediaType})=>({id,name,mediaType})),
    channels:[...original.channels,{id:channelId,required:true,location:'ghcr.io/example/product',metadata:[]}]},
    controllerDirectory:process.cwd(),history:[]};
  const assets=[{id:51,name,size:bytes.length,state:'uploaded'}],release={id:50,tag_name:unit.tag,
    author:{id:context.appBotId},body:'notes',draft:false,immutable:true};
  const repo={id:context.repositoryId,full_name:context.repository,private:false,visibility:'public',archived:false,disabled:false};
  const io={anonymous:()=>io,request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    if(path.includes('/commits/'))return f.response({sha:S});
    if(path.endsWith('/assets/51'))return f.response(bytes);
    if(path.includes('/releases/50/assets?'))return f.response(assets);
    if(path.endsWith('/releases/50'))return f.response(release);
    if(path.endsWith(context.repository))return f.response(repo);
    throw Error('Unexpected native object '+path);
  }};
  const gh=async (args:readonly string[])=>{
    if(args[0]==='api')return JSON.stringify(args.includes('--slurp')?[assets]:repo);
    if(args[0]==='release')return '{}';
    if(args[0]==='attestation')return JSON.stringify([{verificationResult:{signature:{certificate:{
      sourceRepositoryIdentifier:String(context.repositoryId),buildTrigger:'workflow_dispatch',
      runInvocationURI:`https://github.com/${context.repository}/actions/runs/100/attempts/1`,
    }}}}]);
    throw Error('Unexpected GitHub command');
  };
  const root=await mkdtemp(join(tmpdir(),'legacy-channel-workflow-delivery-'));roots.push(root);
  const destination=join(root,'download');
  vi.stubEnv('GH_TOKEN','fixture-token');
  await expect(pipelineChannelDownload(context,target,destination,gh,async(_repo,id,path)=>{
    expect(id).toBe(51);await writeFile(path,bytes);
  },source,io)).resolves.toMatchObject({channelFiles:[name]});
  expect(await readdir(destination)).toEqual([name]);
});
