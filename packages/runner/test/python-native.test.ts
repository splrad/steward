import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {nativeReleaseInspector} from '../src/release-native.js';
import {collectFileBuildManifest} from '../src/build-manifest.js';
import {inspectProductArtifacts,type ProductReleaseManifest} from '../src/release-artifacts.js';
import {BuildContractError,type BuildArtifactInput} from '../../core/src/build-manifest.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {permitOfflineScript,registerOfflineFixtureRoot} from './offline-fixtures.js';

const fixtures=resolve('packages/runner/test/fixtures/python-release');
const artifacts=JSON.parse(await readFile(join(fixtures,'artifacts.json'),'utf8')) as {file:string;version:string;publicVersion:string;sha256:string;bytes:number}[];
const helper=resolve('scripts/inspect-python-release.py');
const mutation=resolve('packages/runner/test/fixtures/python-native-fixture.py');
const python=resolve('tools/template/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const roots:string[]=[];
beforeEach(()=>{permitOfflineScript(helper);permitOfflineScript(mutation);});
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(version='1.2.3') {
  const root=await mkdtemp(join(tmpdir(),'python-native-'));roots.push(root);registerOfflineFixtureRoot(root);
  const out=join(root,'out');await mkdir(out);
  const selected=artifacts.filter(a=>a.version===version);
  for(const asset of selected){const bytes=await readFile(join(fixtures,asset.file));expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);await copyFile(join(fixtures,asset.file),join(out,asset.file));}
  const inspector=nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'),root);
  const plan:BuildArtifactInput={repositoryId:1,fullName:'sample/python',buildId:'python',kind:'file',sourceSha:'a'.repeat(40),controllerSha:'b'.repeat(40),
    version:selected[0]!.publicVersion,packageVersion:version,inputsSha256:'c'.repeat(64),platforms:[],
    outputs:selected.map((a,i)=>({id:i===0?'wheel':'sdist',kind:'file',match:a.file,count:1,mediaType:a.file.endsWith('.whl')?'application/zip':'application/gzip'}))};
  return {root,out,selected,inspector,plan};
}
it.each(['1.2.3','1.2.4rc1'])('consumes actual %s wheel/sdist bytes through the hashed build collector and product inspector',async version=>{
  const f=await fixture(version),manifest=await collectFileBuildManifest(f.plan,f.out,f.inspector);
  expect(manifest.version).toBe(f.plan.version);expect(manifest.packageVersion).toBe(version);
  expect(manifest.artifacts.map(a=>'sha256'in a?a.sha256:'').sort()).toEqual(f.selected.map(a=>a.sha256).sort());
  const unit={id:'python',path:'.',notesPath:'notes.md',channels:[],assets:f.selected.map((a,i)=>({id:i===0?'wheel':'sdist',name:a.file,mediaType:a.file.endsWith('.whl')?'application/zip':'application/gzip'}))};
  const source='a'.repeat(40),cycle='pr-1-'+source;
  const identity:Omit<ProductReleaseManifest,'schemaVersion'|'artifacts'|'evidence'>={repositoryId:1,fullName:'sample/python',cycleId:cycle,requestKey:'d'.repeat(64),unitId:'python',
    sourceSha:source,controllerSha:'b'.repeat(40),buildRef:'refs/heads/steward/build/'+cycle,version:f.plan.version!,packageVersion:version,tag:'v'+f.plan.version,
    deliverySha256:'e'.repeat(64),templateSha256:'f'.repeat(64),runId:100,attempt:1,toolLocks:{'controller/mise.lock':'1'.repeat(64)},
    producers:[{buildId:'python',jobId:101,attempt:1,artifactId:201}]};
  const product=await inspectProductArtifacts(unit,f.out,identity,async path=>await f.inspector.inspectPath!(path) as string);
  expect(product.artifacts.map(a=>a.sha256).sort()).toEqual(f.selected.map(a=>a.sha256).sort());
  await expect(collectFileBuildManifest({...f.plan,packageVersion:'9.9.9'},f.out,f.inspector)).rejects.toThrow('RN_BUILD_VERSION');
},30000);
it('keeps public RC and native package version separate',async()=>{
  const f=await fixture('1.2.4rc1');
  await expect(collectFileBuildManifest({...f.plan,packageVersion:'1.2.4-rc.1'},f.out,f.inspector)).rejects.toThrow('RN_BUILD_VERSION');
});
const modes=['name','version','duplicate-version','missing-metadata','duplicate-path','traversal','absolute','symlink','metadata-limit'];
for(const kind of ['whl','tar.gz'])it.each(modes)(`${kind} rejects %s`,async mode=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith('.'+kind))!,source=join(fixtures,asset.file),output=join(f.out,asset.file),config=join(f.root,'mutation.json');
  await writeFile(config,JSON.stringify({source,output,mode}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  await expect(f.inspector.inspectPath!(output)).rejects.toBeInstanceOf(BuildContractError);
  const staged=join(f.root,'sbom-staging');
  await expect(promisify(execFile)(python,['-I',helper,'--stage',output,staged],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true})).rejects.toMatchObject({code:2});
  await expect(access(staged)).rejects.toMatchObject({code:'ENOENT'});
},30000);
it.each(['1.2.3','1.2.4rc1'])('stages actual %s wheel/sdist bytes without executing package code',async version=>{
  const f=await fixture(version);
  for(const asset of f.selected){
    const staged=join(f.root,asset.file),config=join(f.root,'mutation.json'),output=join(f.out,asset.file);
    await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode:'no-execution'}));
    await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
    const {stdout}=await promisify(execFile)(python,['-I',helper,'--stage',output,staged],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
    expect(JSON.parse(stdout).version).toBe(version);
    const prefix=asset.file.endsWith('.whl')?'':asset.file.slice(0,-7)+'/';
    expect(await readFile(join(staged,prefix+'untrusted.py'),'utf8')).toContain('must not run');
    await expect(promisify(execFile)(python,['-I',helper,'--stage',output,staged],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true})).rejects.toMatchObject({code:2});
  }
},30000);
it.each(['whl','tar.gz'])('rejects Windows-normalized %s collisions before creating staging',async kind=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith('.'+kind))!,output=join(f.out,asset.file),config=join(f.root,'mutation.json'),staged=join(f.root,'sbom-staging');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode:'windows-normalization'}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  expect(await f.inspector.inspectPath!(output)).toBe('1.2.3');
  await expect(promisify(execFile)(python,['-I',helper,'--stage',output,staged],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true})).rejects.toMatchObject({code:2});
  await expect(access(staged)).rejects.toMatchObject({code:'ENOENT'});
},30000);
it.each(['whl','tar.gz'])('normalizes official name/version metadata in %s without importing its code',async kind=>{
  const f=await fixture('1.2.4rc1'),asset=f.selected.find(a=>a.file.endsWith('.'+kind))!,output=join(f.out,asset.file),config=join(f.root,'mutation.json');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode:'normalized'}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  await writeFile(join(f.root,'packaging.py'),"raise RuntimeError('untrusted cwd module')");
  expect(await f.inspector.inspectPath!(output)).toBe('1.2.4rc1');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode:'no-execution'}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  expect(await f.inspector.inspectPath!(output)).toBe('1.2.4rc1');
});
it.each(['entry-limit','expanded-limit','unsupported-compression'])('rejects wheel %s before accepting metadata',async mode=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith('.whl'))!,output=join(f.out,asset.file),config=join(f.root,'mutation.json');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  await expect(f.inspector.inspectPath!(output)).rejects.toBeInstanceOf(BuildContractError);
},30000);
it.each(['whl','tar.gz'])('rejects a %s name that disagrees with its embedded package',async kind=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith('.'+kind))!,renamed=join(f.root,asset.file.replace('splrad_uv_fixture','another_package'));
  await copyFile(join(fixtures,asset.file),renamed);
  await expect(f.inspector.inspectPath!(renamed)).rejects.toBeInstanceOf(BuildContractError);
});
it('preserves infrastructure errors separately from malformed distributions',async()=>{
  const f=await fixture(),path=join(f.root,'broken-1.0.0.tar.gz');await writeFile(path,'not gzip');
  await expect(f.inspector.inspectPath!(path)).rejects.toBeInstanceOf(BuildContractError);
  const error=await f.inspector.inspectPath!(join(f.root,'missing-1.0.0.tar.gz')).catch(e=>e);
  expect(error).not.toBeInstanceOf(BuildContractError);expect(error.code).toBe(1);
  const missing=join(f.root,'missing');await mkdir(missing);
  const copiedHelper=join(missing,'inspect-python-release.py');await copyFile(helper,copiedHelper);permitOfflineScript(copiedHelper);
  await expect(nativeReleaseInspector(join(f.root,'missing','inspect.ps1'),f.root).inspectPath!(path)).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['pax-budget','zip-directory-budget'])('bounds %s inside the standard library reader with a small fixture',async mode=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith(mode==='pax-budget'?'.tar.gz':'.whl'))!,config=join(f.root,'mutation.json');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output:join(f.out,asset.file),mode,helper}));
  const {stdout}=await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  expect(stdout.trim()).toBe('bounded');
});
it('checks gzip CRC after tar end blocks and padding',async()=>{
  const f=await fixture(),asset=f.selected.find(a=>a.file.endsWith('.tar.gz'))!,output=join(f.out,asset.file),config=join(f.root,'mutation.json');
  await writeFile(config,JSON.stringify({source:join(fixtures,asset.file),output,mode:'gzip-crc'}));
  await promisify(execFile)(python,['-I',mutation,config],{env:isolatedBuildEnvironment(process.env,f.root),cwd:f.root,timeout:30000,windowsHide:true});
  await expect(f.inspector.inspectPath!(output)).rejects.toBeInstanceOf(BuildContractError);
});
it('installs the exact shared inspection group before the real product evidence consumer',async()=>{
  const workflow=YAML.parse(await readFile('.github/workflows/product-release.yml','utf8')),steps=workflow.jobs.inspect.steps;
  const installed=steps.findIndex((s:any)=>s.name==='Install locked native metadata reader'),inspected=steps.findIndex((s:any)=>s.name==='business-evidence');
  expect(installed).toBeGreaterThan(0);expect(inspected).toBeGreaterThan(installed);
  expect(steps[installed].run).toContain('uv sync --project controller/tools/template --frozen --only-group release-inspection --no-build');
  expect(steps[installed].env).toBeUndefined();expect(steps[installed].run).not.toContain('secrets');
  await access(python);
});
