import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {dependencyMode,loadPolicy,assertGovernanceOnlyScope} from '../private-dependency-policy.mjs';
import {assertLifecycleScope,assertLifecycleSnapshot,lifecycleSupport,lifecycleWorkflows,lifecycleMiseVersions,lifecycleReusable,assertLifecycleMissingActionLock} from '../private-lifecycle-policy.mjs';
import {buildMode} from '../validation-input.mjs';
const SHA='a'.repeat(40),OLD='b'.repeat(40),policy=await loadPolicy();
const event={repository:{id:1448797077,full_name:'splrad/steward-e10-lifecycle-20261107',private:true,owner:{id:302208797}}};
async function sample(){
 const files=new Map();
 for(const path of lifecycleSupport)files.set(path,await readFile(new URL('../../templates/lifecycle-sample/'+path,import.meta.url)));
 for(const path of lifecycleWorkflows){
  const doc=YAML.parse(await readFile(new URL('../../templates/release/'+path.split('/').at(-1),import.meta.url),'utf8'));
  for(const job of Object.values(doc.jobs)){if(job.uses)job.uses='splrad/steward/.github/workflows/product-release.yml@'+SHA;for(const step of job.steps??[])if(step.with?.repository==='splrad/steward')step.with.ref=SHA;}
  files.set(path,Buffer.from(YAML.stringify(doc)));
 }
 for(const [path,text] of Object.entries({
  'acceptance-app.js':'/** @param {string} value */\nexport function sampleLabel(value) { return value === "ready" ? "就绪" : "等待"; }\n',
  'acceptance-app.test.js':'import {test} from "node:test"; import assert from "node:assert/strict"; import {sampleLabel} from "./dist/acceptance-app.js"; test("labels",()=>{assert.equal(sampleLabel("ready"),"就绪");assert.equal(sampleLabel("other"),"等待");});\n',
  VERSION:'0.0.0\n','release-please-config.json':JSON.stringify({'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}}),
  '.release-please-manifest.json':'{".":"0.0.0"}',
  '.github/delivery.json':JSON.stringify({schemaVersion:1,units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[{id:'app',name:'app-${version}.zip',mediaType:'application/zip'}],channels:[]}],repositoryAuthors:[{id:44151430,evidence:'fixture author'}]})
 }))files.set(path,Buffer.from(text));
 return files;
}
test('lifecycle mode requires exact registered private identity without changing other governance admission',()=>{
 assert.equal(dependencyMode(event,policy,'1448797077'),'private-lifecycle');
 for(const registration of [undefined,'','1448797078'])assert.throws(()=>dependencyMode(event,policy,registration),/LIFECYCLE_IDENTITY/);
 for(const repository of [{...event.repository,private:false},{...event.repository,full_name:'splrad/other'},{...event.repository,owner:{id:1}}])assert.throws(()=>dependencyMode({repository},policy,'1448797077'),/LIFECYCLE_IDENTITY/);
 assert.equal(dependencyMode({repository:{...event.repository,id:42,full_name:'splrad/other'}},policy,'42'),'private-governance');
 assert.throws(()=>assertGovernanceOnlyScope(['acceptance-app.js']),/GOVERNANCE_INPUT_UNCOVERED/);
 for(const path of ['src/other.js','package-lock.yaml','mise.toml','.npmrc','.github/workflows/other.yml','dist/acceptance-app.js'])assert.throws(()=>assertLifecycleScope([path]),/GOVERNANCE_INPUT_UNCOVERED/);
});
test('empty governance base and complete dependency-free application are distinguished',async()=>{
 assert.equal((await assertLifecycleSnapshot(new Map([['README.md',Buffer.from('seed')]]),{side:'base'})).application,false);
 await assert.rejects(assertLifecycleSnapshot(new Map(),{side:'head'}),/HEAD_INCOMPLETE/);
 const files=await sample();assert.equal(buildMode([...files.keys()]),'node');
 assert.equal((await assertLifecycleSnapshot(files,{side:'head',controllerSha:SHA})).npmPackages,0);
 files.delete('acceptance-app.test.js');await assert.rejects(assertLifecycleSnapshot(files,{side:'head',controllerSha:SHA}),/APPLICATION_INCOMPLETE/);
});
test('dependency additions, lock divergence, lifecycle script changes and missing tests fail closed',async()=>{
 for(const path of lifecycleSupport){
  const files=await sample();files.set(path,Buffer.concat([files.get(path),Buffer.from(' ')]));
  await assert.rejects(assertLifecycleSnapshot(files,{side:'head',controllerSha:SHA}),/SUPPORT_BYTES/);
 }
 const files=await sample();const pkg=JSON.parse(files.get('package.json'));pkg.dependencies={demo:'1.0.0'};files.set('package.json',Buffer.from(JSON.stringify(pkg)));
 await assert.rejects(assertLifecycleSnapshot(files,{side:'head',controllerSha:SHA}),/SUPPORT_BYTES/);
});
test('release workflows must match trusted templates and controller ancestry',async()=>{
 const files=await sample();
 await assert.rejects(assertLifecycleSnapshot(files,{side:'head',controllerSha:OLD}),/CONTROLLER_UNTRUSTED/);
 const seen=[];await assertLifecycleSnapshot(files,{side:'head',controllerSha:OLD,verifyController:ref=>{seen.push(ref);return ref===SHA;}});assert.equal(seen.length,2);
 const doc=YAML.parse(files.get(lifecycleWorkflows[0]).toString());doc.on.push={};files.set(lifecycleWorkflows[0],Buffer.from(YAML.stringify(doc)));
 await assert.rejects(assertLifecycleSnapshot(files,{side:'head',controllerSha:SHA}),/WORKFLOW_TEMPLATE/);
});
test('all admitted mise versions are collected; malformed versions fail',async()=>{
 const files=await sample();const docs=new Map(lifecycleWorkflows.map(p=>[p,YAML.parse(files.get(p).toString())]));
 assert(lifecycleMiseVersions(docs).includes('2026.10.18'));
 docs.set('bad',{jobs:{a:{steps:[{uses:'jdx/mise-action@'+SHA,with:{version:'latest'}}]}}});assert.throws(()=>lifecycleMiseVersions(docs),/MISE_VERSION/);
});
test('actual sample compiles, tests emitted application, checks types and verifies repeatable output',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lifecycle-contract-'));
 try{
  const files=await sample();for(const [path,bytes] of files){await mkdir(join(directory,path,'..'),{recursive:true});await writeFile(join(directory,path),bytes);}
  const env={...process.env};
  env.STEWARD_TEST_TOOLCHAIN_ROOT=await import('node:url').then(m=>m.fileURLToPath(new URL('../..',import.meta.url)));
  const run=(args,ok=true)=>{const result=spawnSync(process.execPath,args,{cwd:directory,env,encoding:'utf8',windowsHide:true});assert.equal(result.status===0,ok,result.stdout+result.stderr);};
  run(['scripts/verify.mjs','build']);run(['--test','acceptance-app.test.js']);run(['scripts/verify.mjs','types']);run(['scripts/verify.mjs','config']);run(['scripts/verify.mjs','dist']);
  await writeFile(join(directory,'dist/acceptance-app.js'),'corrupt');run(['scripts/verify.mjs','dist'],false);
  await writeFile(join(directory,'acceptance-app.js'),'/** @type {string} */ export const broken = 42;');run(['scripts/verify.mjs','types'],false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('only the trusted release reusable workflow is expanded; nested and unknown workflows fail',async()=>{
 const bytes=await readFile(new URL('../../.github/workflows/product-release.yml',import.meta.url));
 const value=await lifecycleReusable('splrad/steward/.github/workflows/product-release.yml@'+SHA,(sha,path)=>{assert.equal(sha,SHA);assert.equal(path,'.github/workflows/product-release.yml');return bytes;});
 assert.equal(value.sha,SHA);assert(value.bytes.equals(bytes));
 await assert.rejects(lifecycleReusable('other/repo/.github/workflows/product-release.yml@'+SHA,()=>bytes),/REUSABLE_IDENTITY/);
 const doc=YAML.parse(bytes.toString());doc.jobs.inspect.uses='other/repo/.github/workflows/other.yml@'+SHA;
 await assert.rejects(lifecycleReusable('splrad/steward/.github/workflows/product-release.yml@'+SHA,()=>Buffer.from(YAML.stringify(doc))),/REUSABLE_NESTING/);
});

test('snapshot side is mandatory and generated notes alone do not imply an application',async()=>{
 const base=new Map([['README.md',Buffer.from('base')],['CHANGELOG.md',Buffer.from('history')],['.release-notes/app.md',Buffer.from('notes')]]);
 await assert.rejects(assertLifecycleSnapshot(base),/LIFECYCLE_SIDE/);
 assert.equal((await assertLifecycleSnapshot(base,{side:'base'})).application,false);
 await assert.rejects(assertLifecycleSnapshot(base,{side:'head'}),/HEAD_INCOMPLETE/);
 base.set('acceptance-app.js',Buffer.from('export const x=1;'));
 await assert.rejects(assertLifecycleSnapshot(base,{side:'base'}),/APPLICATION_INCOMPLETE/);
});
test('workflow registration reaches every identity revalidation and malformed mise refs fail closed',async()=>{
 const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/pr-validation-native.yml',import.meta.url),'utf8'));
 assert.equal(workflow.env.PRIVATE_GOVERNANCE_REPOSITORY_ID,'${{ vars.STEWARD_PRIVATE_GOVERNANCE_REPOSITORY_ID }}');
 for(const job of Object.values(workflow.jobs))for(const step of job.steps??[]){
  if(/validation-(?:input|governance|docs|private-dependencies)\.mjs/.test(step.run??'')){
   const env={...workflow.env,...job.env,...step.env};
   assert.equal(env.PRIVATE_GOVERNANCE_REPOSITORY_ID,workflow.env.PRIVATE_GOVERNANCE_REPOSITORY_ID);
  }
 }
 for(const uses of ['jdx/mise-action@latest','jdx/mise-action@abcd','jdx/mise-action/sub@'+SHA]){
  assert.throws(()=>lifecycleMiseVersions(new Map([['bad',{jobs:{a:{steps:[{uses,with:{version:'2026.10.18'}}]}}}]])),/MISE_REFERENCE/);
 }
});

test('action lock remains admitted; only a non-executable pre-application base may omit it',async()=>{
 assertLifecycleScope(['.github/workflows/actions.lock']);
 const paths=['README.md','CHANGELOG.md','.release-notes/app.md'];
 const files=new Map(paths.map(path=>[path,Buffer.from('history')]));
 const snapshot=await assertLifecycleSnapshot(files,{side:'base'});
 assertLifecycleMissingActionLock(paths,{side:'base',application:snapshot.application});
 for(const input of [{side:'head',application:false},{side:'base',application:true}])assert.throws(()=>assertLifecycleMissingActionLock(paths,input),/ACTION_LOCK_REQUIRED/);
 assert.throws(()=>assertLifecycleMissingActionLock([...paths,'.github/workflows/pr-title.yml'],{side:'base',application:false}),/ACTION_LOCK_REQUIRED/);
});
