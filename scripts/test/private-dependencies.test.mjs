import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencyMode,loadPolicy,inventory,checkInventory,highFindings,requireOnline,actionFindings,newActions,assertInputScope,licenseFacts} from '../private-dependency-policy.mjs';
import {upstreamReference,run} from '../validation-private-dependencies.mjs';
import {nodeFindings,miseFindings} from '../private-tool-security.mjs';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
const SHA='a'.repeat(40),OTHER='b'.repeat(40),policy=await loadPolicy();
const lock={lockfileVersion:3,packages:{'':{name:'fixture'},'node_modules/demo':{version:'1.0.0',resolved:'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',dev:true}}};
const packageResult={package:{name:'demo',version:'1.0.0',ecosystem:'npm'}};
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
 const steps=workflow.jobs.dependency.steps;
 assert.equal(steps.find(s=>s.uses?.startsWith('actions/dependency-review-action@')).if,"needs.scope.outputs.dependency-mode == 'native'");
 const scan=steps.find(s=>s.name==='Scan private administrator dependencies');assert.equal(scan.if,"needs.scope.outputs.dependency-mode == 'private-administrator'");assert.equal(scan['working-directory'],'policy');
 assert.equal(workflow.permissions['security-events'],undefined);
 assert.equal(steps.find(s=>s.with?.path==='policy').with.ref,'${{ job.workflow_sha }}');
});

test('licenses are factual changes and unknowns, never a new allowlist gate',()=>{
 const base={results:[{source:{path:'lock'},packages:[{...packageResult,licenses:['MIT']}]}]};
 const head={results:[{source:{path:'lock'},packages:[{...packageResult,licenses:[]}]}]};
 const report=licenseFacts(base,head);assert.equal(report.changes.length,1);assert.equal(report.unknown.length,1);assert.equal(report.blocking,false);
});

test('administrator scans cannot be skipped by paths-filter; native filters include tool lock-only changes',async()=>{
 const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/pr-validation-native.yml',import.meta.url),'utf8'));
 assert.equal(workflow.jobs.scope.outputs.dependency,"${{ steps.identity.outputs.dependencyMode == 'private-administrator' && 'true' || steps.scope.outputs.dependency }}");
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
