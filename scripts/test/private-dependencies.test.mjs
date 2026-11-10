import {parseAcceptanceTarget} from '../bootstrap-acceptance.mjs';
import {replaceScanOutput} from '../private-scan-output.mjs';
import {assertActionInputs,reusableActions,verifyReusableLock} from '../private-reusable-actions.mjs';
import {effectiveLock} from '../private-lock-exception.mjs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencyMode,loadPolicy,inventory,checkInventory,highFindings,requireOnline,actionFindings,newActions,newPackageFindings,newTools,assertInputScope,assertGovernanceOnlyScope,assertCopierInputs,licenseFacts} from '../private-dependency-policy.mjs';
import {upstreamReference,run,assertVerifiedActionTag,main,docker} from '../validation-private-dependencies.mjs';
import {nodeFindings,miseFindings,miseVersions,archiveInventory} from '../private-tool-security.mjs';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import YAML from 'yaml';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const SHA='a'.repeat(40),OTHER='b'.repeat(40),policy=await loadPolicy();
const lock={lockfileVersion:3,packages:{'':{name:'fixture'},'node_modules/demo':{version:'1.0.0',resolved:'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',dev:true}}};
const packageResult={package:{name:'demo',version:'1.0.0',ecosystem:'npm'}};

const reusableUse='splrad/steward/.github/workflows/product-release.yml@'+SHA;
const reusablePath='.github/workflows/product-release.yml',actionLockPath='.github/workflows/actions.lock';
function reusableFiles(){return new Map([
 [reusablePath,Buffer.from(YAML.stringify({on:{workflow_call:{}},jobs:{release:{steps:[{uses:'jdx/mise-action@'+SHA}]}}}))],
 ['.github/workflows/other.yml',Buffer.from('on: push\njobs: {}\n')],
 [actionLockPath,Buffer.from('complete original native lock bytes')],
]);}
function reusableIO(files=reusableFiles()){return {
 loadSource:async sha=>{assert.equal(sha,SHA);return files;},
 verifyLock:async actual=>{assert.equal(actual,files);assert.equal(actual.size,3);return {stdout:'verified',stderr:'retained warning'};},
 inventory:async text=>{assert.equal(text,'complete original native lock bytes');return [{repo:'jdx/mise-action',sha:SHA},{repo:'transitive/action',sha:OTHER}];},
};}
test('reusable uses its exact source inventory; all locked transitive actions and native diagnostics survive',async()=>{
 const nested=await reusableActions(reusableUse,reusableIO());
 assert.equal(nested.sha,SHA);assert.equal(nested.actions.length,2);assert.equal(nested.native.stderr,'retained warning');
 assert.match(nested.lockSha256,/^[a-f0-9]{64}$/);
 const caller={jobs:{run:{steps:[{uses:'jdx/mise-action@'+OTHER}]}}};
 assertActionInputs(caller,[{repo:'jdx/mise-action',sha:OTHER}]);
 assert.throws(()=>assertActionInputs(caller,nested.actions),/ACTION_INPUT_UNCOVERED/);
 assert.throws(()=>assertActionInputs(YAML.parse(nested.bytes.toString()),[{repo:'jdx/mise-action',sha:OTHER}]),/ACTION_INPUT_UNCOVERED/);
});
test('reusable cannot borrow missing coverage from the consumer or another source',async()=>{
 await assert.rejects(reusableActions(reusableUse,{...reusableIO(),inventory:async()=>[{repo:'jdx/mise-action',sha:OTHER}]}),/ACTION_INPUT_UNCOVERED/);
});
test('reusable rejects a missing source lock before any inventory can be substituted',async()=>{
 const files=reusableFiles();files.delete(actionLockPath);
 await assert.rejects(reusableActions(reusableUse,{...reusableIO(files),inventory:async()=>{assert.fail('must not run');}}),/REUSABLE_ACTION_LOCK_REQUIRED/);
});
test('native lock failure and online identity/unknown failures propagate without a partial success',async()=>{
 for(const stage of ['verifyLock','inventory'])for(const code of ['NATIVE_LOCK_INVALID','ACTION_IDENTITY','ACTION_VERSION_UNRESOLVED']){
  await assert.rejects(reusableActions(reusableUse,{...reusableIO(),[stage]:async()=>{throw Error(code);}}),new RegExp(code));
 }
 await assert.rejects(reusableActions(reusableUse,{...reusableIO(),verifyLock:async()=>{throw Error('NATIVE_FAILED');}}),error=>{
  assert.equal(error.reusableSource.sha,SHA);assert.equal(error.reusableSource.stage,'native-lock');
  assert.match(error.reusableSource.lockSha256,/^[a-f0-9]{64}$/);return error.message==='NATIVE_FAILED';
 });
});
test('reusable wrong owner, non-SHA, untrusted source and nested workflow remain rejected',async()=>{
 for(const use of [reusableUse.replace('splrad/steward','other/steward'),reusableUse.replace(SHA,'main')]){
  await assert.rejects(reusableActions(use,{...reusableIO(),loadSource:async()=>assert.fail('must not load')}),/LIFECYCLE_REUSABLE_IDENTITY/);
 }
 await assert.rejects(reusableActions(reusableUse,{...reusableIO(),loadSource:async()=>{throw Error('ANCESTRY_REJECTED');}}),/ANCESTRY_REJECTED/);
 const files=reusableFiles();files.set(reusablePath,Buffer.from(YAML.stringify({on:{workflow_call:{}},jobs:{nested:{uses:reusableUse}}})));
 await assert.rejects(reusableActions(reusableUse,reusableIO(files)),/LIFECYCLE_REUSABLE_NESTING/);
});
test('native source verification uses full unedited inputs and an isolated exact source root',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reusable-lock-test-')),files=reusableFiles();
 try{
  const result=await verifyReusableLock(files,directory,{GH_REPO:'wrong/repo',GH_ACTIONS_LOCK_REPO_ROOT:'wrong',GH_CONFIG_DIR:'trusted-tool'},(command,args,cwd,env)=>{
   assert.equal(command,'gh');assert.deepEqual(args,['actions-lock','--verify','--no-interactive']);assert.equal(cwd,directory);
   assert.equal(env.GH_REPO,'splrad/steward');assert.equal(env.GH_ACTIONS_LOCK_REPO_ROOT,directory);assert.equal(env.GH_CONFIG_DIR,'trusted-tool');
   return {stdout:'all workflows verified',stderr:'warning'};
  });
  assert.equal(result.stderr,'warning');for(const [path,bytes] of files)assert.deepEqual(await readFile(join(directory,path)),bytes);
  await assert.rejects(verifyReusableLock(new Map([['../escape.yml',Buffer.from('x')],[actionLockPath,Buffer.from('x')]]),directory,{},()=>assert.fail()),/REUSABLE_LOCK_INPUT_PATH/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('read-only native verification cannot silently rewrite source bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reusable-lock-test-')),files=reusableFiles();
 try{
  await assert.rejects(verifyReusableLock(files,directory,{},()=>{
   run(process.execPath,['-e','require("node:fs").writeFileSync(".github/workflows/actions.lock","changed")'],directory,process.env);
   return {stdout:'',stderr:''};
  }),/REUSABLE_LOCK_INPUT_CHANGED/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('only configured private administrator identity selects replacement; other private products remain native',()=>{
 assert.equal(dependencyMode({repository:{id:12,full_name:'org/product',private:true}},policy),'native');
 assert.equal(dependencyMode({repository:{id:1447987054,full_name:'splrad/steward-settings',private:true}},policy),'private-administrator');
 for(const repository of [{id:1447987054,full_name:'fork/settings',private:true},{id:1447987054,full_name:'splrad/steward-settings',private:false}])assert.throws(()=>dependencyMode({repository},policy),/TARGET_IDENTITY/);
});
test('complete inventory reconciles unique package versions while retaining dev; zero, missing and unresolved packages fail',()=>{
 assert.equal([...inventory(lock).values()][0].scope,'development');
 const nested=structuredClone(lock);nested.packages['node_modules/parent/node_modules/demo']=structuredClone(lock.packages['node_modules/demo']);
 assert.deepEqual(checkInventory(nested,{results:[{packages:[packageResult]}]}),{lockEntries:2,uniquePackages:1,complete:true});
 assert.throws(()=>checkInventory(lock,{results:[]}),/INCOMPLETE/);
 assert.throws(()=>inventory({lockfileVersion:3,packages:{}}),/NO_PACKAGES/);
 const local=structuredClone(lock);delete local.packages['node_modules/demo'].resolved;assert.throws(()=>inventory(local),/NPM_SOURCE/);
});
test('new high/critical are blocked, license unknown and lower severity are not silently promoted',()=>{
 for(const severity of ['HIGH','CRITICAL'])assert.equal(highFindings({results:[{packages:[{...packageResult,licenses:[],vulnerabilities:[{id:'GHSA-test',database_specific:{severity}}]}]}]}).length,1);
 assert.deepEqual(highFindings({results:[{packages:[{...packageResult,licenses:[],vulnerabilities:[{id:'GHSA-test',database_specific:{severity:'LOW'}}]}]}]}),[]);
 assert.throws(()=>highFindings({results:[{packages:[{...packageResult,vulnerabilities:[{id:'unknown'}]}]}]}),/UNKNOWN_SEVERITY/);
});
test('online scan requires token and cannot inherit an offline downgrade',()=>{
 for(const env of [{},{GH_TOKEN:''},{GH_TOKEN:'test',ZIZMOR_OFFLINE:'1'},{GH_TOKEN:'test',ZIZMOR_NO_ONLINE_AUDITS:'1'}])assert.throws(()=>requireOnline(env));
 requireOnline({GH_TOKEN:'test'});
});
function finding(severity='High'){return {ident:'known-vulnerable-actions',determinations:{severity},locations:[{symbolic:{annotation:'GHSA-cxww-7g56-2vh6',key:{Local:{verbatim_path:'scan.yml'}},route:{route:[{Key:'jobs'},{Key:'test'},{Key:'steps'},{Index:0},{Key:'uses'}]}}}]};}
test('Actions findings bind to source repository, exact SHA and GHSA; changed SHA is not swallowed by same advisory',()=>{
 const docs=new Map([['scan.yml',{jobs:{test:{steps:[{uses:'actions/download-artifact@'+SHA}]}}}]]);
 const base=actionFindings([finding()],docs),head=[{...base[0],sha:OTHER}];assert.equal(newActions(base,head).length,1);assert.equal(newActions(base,base).length,0);assert.equal(newActions(base,[]).length,0);
 assert.equal(newActions(base,[{...base[0],repository:'different/action'}]).length,1);
 assert.throws(()=>actionFindings([finding('Unknown')],docs),/ACTION_SEVERITY/);
 assert.throws(()=>actionFindings([finding()],new Map()),/ACTION_LOCATION/);
});
test('upstream source is immutable and unique; path collisions and unrecognized input fail',()=>{
 const item=policy.administrators[0];const document={jobs:{sync:{steps:[{uses:'actions/checkout@'+SHA,with:{repository:item.upstream,ref:OTHER,path:'.safe-settings-code'}}]}}};
 assert.equal(upstreamReference(YAML.stringify(document),item),OTHER);
 document.jobs.sync.steps[0].with.ref='main';assert.throws(()=>upstreamReference(YAML.stringify(document),item),/UPSTREAM_SHA/);
 document.jobs.sync.steps[0].with.ref=OTHER;document.jobs.sync.steps.push(structuredClone(document.jobs.sync.steps[0]));assert.throws(()=>upstreamReference(YAML.stringify(document),item),/UPSTREAM_REFERENCE/);
 assertInputScope(['mise.lock','safe-settings/settings.yml','.mise/locks/npm/12.2.1/aube-lock.yaml']);
 for(const file of ['package.json','requirements.txt','.npmrc','safe-settings/validator.js','.github/workflows/extra.yml'])assert.throws(()=>assertInputScope([file]),/INPUT_UNCOVERED/);
});
test('official supplier ranges use semver, preserve severity, and reject unknown data',()=>{
 const feed={one:{vulnerable:'<26.12.1',patched:'>=26.12.1',severity:'high',cve:'CVE-fixture'}};
 assert.equal(nodeFindings('26.12.0',feed).length,1);assert.equal(nodeFindings('26.12.1',feed).length,0);
 const advisory={ghsa_id:'GHSA-fixture',severity:'critical',vulnerabilities:[{package:{name:'mise',ecosystem:'rust'},vulnerable_version_range:'>=2025.9.13',patched_versions:'2026.10.0'}]};
 assert.equal(miseFindings('2026.9.18',[advisory]).length,1);assert.equal(miseFindings('2026.10.18',[advisory]).length,0);
 advisory.severity='unknown';assert.throws(()=>miseFindings('2026.9.18',[advisory]),/MISE_SEVERITY/);
});
test('tool execution errors are not clean scan results',()=>{
 assert.throws(()=>run(process.execPath,['-e','process.exit(2)'],process.cwd(),process.env,[0,1]),/TOOL_FAILED/);
 assert.throws(()=>run('nonexistent-private-scan-executable',[],process.cwd(),process.env),/TOOL_FAILED/);
});
test('workflow keeps private execution under dependency job, fixed policy source and native review elsewhere',async()=>{
 const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/pr-validation-native.yml',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(workflow.jobs),['scope','source-linux','source-windows','governance','dependency','docs','summary']);
 assert.equal(workflow.jobs.scope.outputs.source,"${{ steps.identity.outputs.dependencyMode == 'private-governance' && 'false' || steps.scope.outputs.source }}");
 for(const name of ['source-linux','source-windows'])assert.equal(workflow.jobs[name].if,"needs.scope.outputs.source == 'true'");
 const steps=workflow.jobs.dependency.steps;
 assert.equal(steps.find(s=>s.uses?.startsWith('actions/dependency-review-action@')).if,"needs.scope.outputs.dependency-mode == 'native'");
 const scan=steps.find(s=>s.name==='Scan private administrator dependencies');assert.equal(scan.if,"startsWith(needs.scope.outputs.dependency-mode, 'private-')");assert.equal(scan['working-directory'],'policy');
 const verifier=steps.find(s=>s.name==='Install trusted reusable workflow lock verifier');
 assert.equal(verifier.if,"needs.scope.outputs.dependency-mode == 'private-lifecycle'");
 assert.match(verifier.run,/cat policy\/config\/actions-lock-version\.txt/);assert.match(verifier.run,/--pin "\$ACTIONS_LOCK_VERSION"/);
 assert.equal(verifier.env.GH_CONFIG_DIR,scan.env.GH_CONFIG_DIR);assert.ok(steps.indexOf(verifier)<steps.indexOf(scan));
 assert.equal(workflow.permissions['security-events'],undefined);
 assert.equal(steps.find(s=>s.with?.path==='policy').with.ref,'${{ job.workflow_sha }}');
 assert.equal(steps.find(s=>s.with?.path==='policy').with['fetch-depth'],0);
});

test('licenses are factual changes and unknowns, never a new allowlist gate',()=>{
 const base={results:[{source:{path:'lock'},packages:[{...packageResult,licenses:['MIT']}]}]};
 const head={results:[{source:{path:'lock'},packages:[{...packageResult,licenses:[]}]}]};
 const report=licenseFacts(base,head);assert.equal(report.changes.length,1);assert.equal(report.unknown.length,1);assert.equal(report.blocking,false);
});

test('administrator scans cannot be skipped by paths-filter; native filters include tool lock-only changes',async()=>{
 const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/pr-validation-native.yml',import.meta.url),'utf8'));
 assert.equal(workflow.jobs.scope.outputs.dependency,"${{ startsWith(steps.identity.outputs.dependencyMode, 'private-') && 'true' || steps.scope.outputs.dependency }}");
 const filter=YAML.parse(workflow.jobs.scope.steps.find(s=>s.id==='scope').with.filters);assert(filter.dependency.includes('.mise/**'));
 // Every administrator PR is scanned, even an unknown manifest or a documentation-only change.
 assert.equal(workflow.jobs.dependency.if,"needs.scope.outputs.dependency == 'true'");
});

test('existing Renovate regex manager extracts the scanner stable version and digest',async()=>{
 const config=JSON.parse(await readFile(new URL('../../.github/renovate.json',import.meta.url),'utf8'));
 const manager=config.customManagers.find(m=>m.depNameTemplate==='ghcr.io/google/osv-scanner-action');assert.equal(manager.datasourceTemplate,'docker');
 const text=await readFile(new URL('../../config/private-dependency-security.json',import.meta.url),'utf8');
 const match=new RegExp(manager.matchStrings[0]).exec(text);assert.equal(match.groups.currentValue,'v2.7.0');assert.match(match.groups.currentDigest,/^sha256:[a-f0-9]{64}$/);
 assert.equal(new RegExp(manager.matchStrings[0]).exec(text.replace('v2.7.0','latest')),null);
});

test('official reporter null-results means no new findings only after complete scans and reporter mode',()=>{
 const empty={results:null,experimental_config:{licenses:{summary:false,allowlist:null}}};
 assert.deepEqual(highFindings(empty,{emptyReporter:true}),[]);assert.throws(()=>highFindings(empty),/REPORTER_JSON/);assert.throws(()=>highFindings({}, {emptyReporter:true}),/REPORTER_JSON/);
});

test('all accepted workflows contribute mise versions and the runtime entry cannot omit mise',()=>{
 const doc=version=>({jobs:{run:{steps:[{uses:'jdx/mise-action@'+SHA,with:{version}}]}}});
 const documents=new Map([['runtime.yml',doc('2026.10.18')],['title.yml',doc('2026.9.18')]]);
 assert.deepEqual(miseVersions(documents,'runtime.yml'),['2026.10.18','2026.9.18']);
 const advisory={ghsa_id:'GHSA-fixture',severity:'high',vulnerabilities:[{package:{name:'mise',ecosystem:'rust'},vulnerable_version_range:'<2026.10.0',patched_versions:'2026.10.0'}]};
 assert.equal(miseVersions(documents,'runtime.yml').flatMap(v=>miseFindings(v,[advisory])).length,1);
 documents.set('runtime.yml',{jobs:{run:{steps:[]}}});assert.throws(()=>miseVersions(documents,'runtime.yml'),/MISE_RUNTIME_REQUIRED/);
 documents.set('runtime.yml',doc('2026.10.18'));documents.set('title.yml',doc('${{ inputs.version }}'));assert.throws(()=>miseVersions(documents,'runtime.yml'),/MISE_RUNTIME_VERSION/);
});
test('verified ref must be the unique longest matching tag, including equal length alternatives',()=>{
 assertVerifiedActionTag('v2.7.0',['v2','2.7.0','v2.7.0']);
 for(const tags of [['v2.7.0','x2.7.0'],['v2.7.0','v2.7.0-extra'],['v2','2.7.0']])assert.throws(()=>assertVerifiedActionTag('v2.7.0',tags),/ZIZMOR_TAG_AMBIGUOUS/);
});
test('real tar manifest inventory includes vendor paths and refuses unresolved manifests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'private-archive-test-')),archive=join(directory,'npm.tgz'),python=process.env.PRIVATE_PYTHON??'python';
 try{
  const create=`import io,json,tarfile,sys
with tarfile.open(sys.argv[1],'w:gz') as archive:
 for path,data in [('package/package.json',{'name':'npm','version':'1.0.0'}),('package/dist/esm/package.json',{'type':'module'}),('package/vendor/extra/package.json',{'name':'extra','version':'2.0.0'} if sys.argv[2]=='valid' else {})]:
  body=json.dumps(data).encode();item=tarfile.TarInfo(path);item.size=len(body);archive.addfile(item,io.BytesIO(body))`;
  run(python,['-I','-c',create,archive,'valid'],directory,process.env);
  assert.deepEqual(archiveInventory(python,archive,run,process.env),{packages:[['extra','2.0.0'],['npm','1.0.0']],moduleScopes:['package/dist/esm/package.json']});
  run(python,['-I','-c',create,archive,'invalid'],directory,process.env);
  assert.throws(()=>archiveInventory(python,archive,run,process.env),/TOOL_FAILED/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('preflight token failure still writes a failed evidence summary',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'private-preflight-test-'));
 try{
  await assert.rejects(main({PRIVATE_DEPENDENCY_EVIDENCE:directory}),/TOKEN_REQUIRED/);
  const report=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
  assert.equal(report.complete,false);assert.equal(report.identity,null);assert.equal(report.error,'PRIVATE_DEPENDENCY_TOKEN_REQUIRED');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('package identity and severity cannot be consumed by equal native advisory counts',()=>{
 const result=(version,name='demo',severity='HIGH',path='/input/package-lock.json')=>({results:[{source:{type:'lockfile',path},packages:[{package:{name,version,ecosystem:'npm'},vulnerabilities:[{id:'GHSA-fixture',database_specific:{severity}}]}]}]});
 const empty={results:null,experimental_config:{licenses:{}}};
 assert.equal(newPackageFindings(result('1.0.0'),result('1.0.0'),empty).length,0);
 for(const head of [result('1.1.0'),result('1.0.0','other'),result('1.0.0','demo','CRITICAL'),result('1.0.0','demo','HIGH','/input/npm-tool/bom.cdx.json')])assert.equal(newPackageFindings(result('1.0.0'),head,empty).length,1);
 assert.equal(newPackageFindings(result('1.0.0','demo','LOW'),result('1.0.0'),empty).length,1);
 assert.equal(newPackageFindings({results:[]},result('1.0.0'),result('1.0.0')).length,1);
});
test('severity upgrades remain new action and tool findings',()=>{
 const action={repository:'jdx/mise-action',sha:SHA,id:'GHSA-fixture',severity:'Low'};
 assert.equal(newActions([action],[{...action,severity:'High'}]).length,1);assert.equal(newActions([action],[action]).length,0);
 const tool={source:'jdx/mise',version:'2026.10.18',id:'GHSA-fixture',severity:'LOW'};
 assert.equal(newTools([tool],[{...tool,severity:'HIGH'}]).length,1);assert.equal(newTools([tool],[tool]).length,0);
});
test('mise runtime requires the exact action identity and complete SHA',()=>{
 for(const uses of ['jdx/mise-action-evil@'+SHA,'jdx/mise-action@v3','jdx/mise-action@'+SHA+'extra']){
  const docs=new Map([['runtime.yml',{jobs:{run:{steps:[{uses,with:{version:'2026.10.18'}}]}}}]]);
  assert.throws(()=>miseVersions(docs,'runtime.yml'),/MISE_RUNTIME_REQUIRED/);
 }
});


test('fixed lock exception reconstructs bytes and rejects missing, mismatched or extra inputs',async()=>{
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const original=Buffer.from('{"version":1}\n'),expected=Buffer.from('{"version":2}\n');
 const patch=Buffer.from('diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{"version":1}\n+{"version":2}\n');
 const value={schemaVersion:1,upstream:'org/source',sourceSha:SHA,originalLockSha256:digest(original),patchSha256:digest(patch),effectiveLockSha256:digest(expected)};
 const directory=await mkdtemp(join(tmpdir(),'lock-exception-test-'));
 const attempt=async({change={},patchBytes=patch,manifestMissing=false,patchMissing=false,sourceSha=SHA,manifestHash,originalBytes=original}={})=>{
   await writeFile(join(directory,'package-lock.json'),originalBytes);
   await writeFile(join(directory,'package.json'),'unchanged');
   const manifest=Buffer.from(JSON.stringify({...value,...change}));
   const item={upstream:value.upstream,lockException:{manifestPath:'safe-settings/upstream-lock-exception.json',patchPath:'safe-settings/upstream-package-lock.patch',manifestSha256:manifestHash??digest(manifest)}};
   return effectiveLock({directory,item,sourceSha,manifest:manifestMissing?null:manifest,patch:patchMissing?null:patchBytes});
 };
 try{
   assert.equal(await effectiveLock({manifest:null,patch:null}),null);
   assert.equal((await attempt()).effectiveLockSha256,digest(expected));
   assert.deepEqual(await readFile(join(directory,'package-lock.json')),expected);
   assert.equal(await readFile(join(directory,'package.json'),'utf8'),'unchanged');
   for(const option of [{manifestMissing:true},{patchMissing:true}])await assert.rejects(attempt(option),/FILES/);
   await assert.rejects(attempt({manifestHash:'0'.repeat(64)}),/MANIFEST_HASH/);
   await assert.rejects(attempt({sourceSha:OTHER}),/SOURCE/);
   await assert.rejects(attempt({change:{upstream:'org/other'}}),/SOURCE/);
   await assert.rejects(attempt({originalBytes:expected}),/ORIGINAL_HASH/);
   await assert.rejects(attempt({patchBytes:Buffer.from('bad')}),/PATCH_HASH/);
   await assert.rejects(attempt({change:{effectiveLockSha256:'0'.repeat(64)}}),/RESULT_HASH/);
   await assert.rejects(attempt({change:{extra:true}}),/SCHEMA/);
   const extra=Buffer.concat([patch,Buffer.from('diff --git a/extra b/extra\nnew file mode 100644\n--- /dev/null\n+++ b/extra\n@@ -0,0 +1 @@\n+unexpected\n')]);
   await assert.rejects(attempt({patchBytes:extra,change:{patchSha256:digest(extra)}}),/TARGET/);
 }finally{await rm(directory,{recursive:true,force:true});}
});


test('failed trusted tools retain exit diagnostics without credential values',()=>{
 const secret='fixture-token-do-not-record';
 assert.throws(()=>run(process.execPath,['-e','console.error("scanner denied "+process.env.GH_TOKEN);process.exit(127)'],process.cwd(),{...process.env,GH_TOKEN:secret}),error=>{
   assert.equal(error.toolFailure.exitStatus,127);
   assert.match(error.toolFailure.stderr,/scanner denied \[REDACTED\]/);
   assert.ok(!error.toolFailure.stderr.includes(secret));
   return /TOOL_FAILED/.test(error.message);
 });
});

test('scan normalization replaces existing output and leaves only the final file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'private-output-test-'));
 try{
  const path=join(directory,'osv.json');await writeFile(path,'original');
  await replaceScanOutput(path,{results:[]});
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{results:[]});
  const {readdir}=await import('node:fs/promises');
  assert.deepEqual(await readdir(directory),['osv.json']);
 }finally{await rm(directory,{recursive:true,force:true});}
});


test('Docker output permissions and sandbox arguments cover POSIX and Windows branches',async()=>{
 const fs=await import('node:fs'),child=await import('node:child_process');
 const {syncBuiltinESMExports}=await import('node:module');
 const originalSpawn=child.default.spawnSync,originalChmod=fs.default.chmodSync;
 const getgidDescriptor=Object.getOwnPropertyDescriptor(process,'getgid');
 const directory=await mkdtemp(join(tmpdir(),'private-docker-test-'));
 const calls=[],modes=[];
 try{
  child.default.spawnSync=(command,args)=>{calls.push({command,args});return {status:0,stdout:'',stderr:''};};
  fs.default.chmodSync=(path,mode)=>{modes.push({path,mode});return originalChmod(path,mode);};
  syncBuiltinESMExports();
  for(const posix of [true,false]){
   Object.defineProperty(process,'getgid',{configurable:true,value:posix?()=>123:undefined});
   docker('pinned-image','/root/osv-reporter',directory,directory,['--old=/input/osv.json'],false);
   const {command,args}=calls.at(-1);assert.equal(command,'docker');
   for(const flag of ['--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--network=none'])assert.ok(args.includes(flag));
   assert.equal(args[args.indexOf('--tmpfs')+1],'/tmp:rw,noexec,nosuid,size=128m');
   assert.ok(args.includes(directory+':/input:ro'));
   assert.ok(args.includes(directory+':/out'));
   if(posix){
    assert.equal(args[args.indexOf('--group-add')+1],String(fs.statSync(directory).gid));
    assert.deepEqual(modes,[{path:directory,mode:0o770}]);
    if(getgidDescriptor)assert.equal(fs.statSync(directory).mode&0o777,0o770);
   }else assert.ok(!args.includes('--group-add'));
  }
  assert.equal(modes.length,1);
 }finally{
  child.default.spawnSync=originalSpawn;fs.default.chmodSync=originalChmod;
  if(getgidDescriptor)Object.defineProperty(process,'getgid',getgidDescriptor);else delete process.getgid;
  syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});
 }
});

test('bootstrap control is exact nondependency data, with no executable or dependency extensions',()=>{
 assertInputScope(['acceptance/bootstrap-target.json']);
 for(const path of ['acceptance/other.json','acceptance/bootstrap-target.js','acceptance/package.json'])assert.throws(()=>assertInputScope([path]),/INPUT_UNCOVERED/);
 const target={schemaVersion:1,repositoryId:12,purpose:'bootstrap-only'};
 assert.equal(parseAcceptanceTarget(JSON.stringify(target)),12);
 for(const bad of [{...target,run:'execute'},{...target,dependencies:{}},{...target,repositoryId:0},null])assert.throws(()=>parseAcceptanceTarget(JSON.stringify(bad)),/^Error: BOOTSTRAP_ACCEPTANCE_TARGET_INVALID$/);
});

test('Copier admission requires trusted template bytes and original versioned answers',async()=>{
 const paths=['.github/labeler.yml','.github/workflows/pr-labeler.yml'];
 const templates=new Map(await Promise.all(paths.map(async path=>[path,await readFile(new URL('../../templates/repository/'+path,import.meta.url))])));
 const files=new Map(templates);files.set('.copier-answers.yml',Buffer.from('_src_path: https://github.com/splrad/steward.git\n_commit: v0.2.0\n'));
 assertInputScope([...files.keys()]);assertCopierInputs(files,ref=>ref==='v0.2.0'?templates:null);
 for(const tag of ['v1!2.3.5','v1.2.3.4','v1.2.3.post1','V1.2.3+local.1']){
  const versioned=new Map(files);versioned.set('.copier-answers.yml',Buffer.from('_src_path: https://github.com/splrad/steward.git\n_commit: '+tag+'\n'));
  assertCopierInputs(versioned,ref=>ref===tag?templates:null);
  assert.throws(()=>assertCopierInputs(versioned,()=>null),/COPIER_TEMPLATE_SOURCE/);
 }
 for(const tag of ['v1.2.3^{commit}','v1.2.3:path','v1.2.3/other','--help']){
  const invalid=new Map(files);invalid.set('.copier-answers.yml',Buffer.from('_src_path: https://github.com/splrad/steward.git\n_commit: '+tag+'\n'));
  assert.throws(()=>assertCopierInputs(invalid,()=>templates),/COPIER_ANSWERS/);
 }
 assert.throws(()=>assertCopierInputs(files,()=>null),/COPIER_TEMPLATE_SOURCE/);
 for(const path of paths){const changed=new Map(files);changed.set(path,Buffer.from('unreviewed'));assert.throws(()=>assertCopierInputs(changed,()=>templates),/COPIER_TEMPLATE_BYTES/);}
 for(const text of ['_src_path: https://example.invalid/template\n_commit: v0.2.0\n','_src_path: https://github.com/splrad/steward.git\n_commit: main\n','_src_path: https://github.com/splrad/steward.git\n_commit: v0.2.0\n_tasks: bad\n']){
  const changed=new Map(files);changed.set('.copier-answers.yml',Buffer.from(text));assert.throws(()=>assertCopierInputs(changed,()=>templates),/COPIER_ANSWERS/);
 }
 for(const path of ['.github/workflows/custom-labeler.yml','.copier-answers.yaml','.github/labeler.js'])assert.throws(()=>assertInputScope([path]),/INPUT_UNCOVERED/);
});

test('private governance registration binds native identity and rejects product inputs',()=>{
 const event={repository:{id:42,full_name:'splrad/fixture',private:true,owner:{id:302208797}}};
 assert.equal(dependencyMode(event,policy,'42'),'private-governance');
 assert.equal(dependencyMode(event,policy),'native');
 for(const id of ['43','true','042'])assert.throws(()=>dependencyMode(event,policy,id),/GOVERNANCE_REGISTRATION/);
 for(const repository of [{...event.repository,private:false},{...event.repository,owner:{id:1}},{...event.repository,full_name:'fork/fixture'}])assert.throws(()=>dependencyMode({repository},policy,'42'),/GOVERNANCE_REGISTRATION/);
 assertGovernanceOnlyScope(['README.md','.copier-answers.yml','.github/workflows/pr-labeler.yml']);
 for(const path of ['safe-settings/settings.yml','mise.lock','package-lock.json','package.json','src/index.js','.github/workflows/build.yml'])assert.throws(()=>assertGovernanceOnlyScope([path]),/GOVERNANCE_INPUT_UNCOVERED/);
});
