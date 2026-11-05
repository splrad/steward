import {afterEach,expect,it,vi} from 'vitest';
import {releaseProtectionFixture} from './fixtures/release-protection.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerOfflineFixtureRoot,permitOfflineScript} from './offline-fixtures.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {createHash} from 'node:crypto';
import {inspectNativeCycle} from '../src/native-release-evidence.js';
import {prepareBuildDispatch} from '../src/release-run.js';
const {initializeReleaseAdoption,withReleaseAdoption,recoverReleaseCaches}=await import(pathToFileURL(resolve('scripts/release-adoption.mjs')).href);
const {readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
vi.setConfig({testTimeout:60_000});
const roots:string[]=[];
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'adoption-test-'));roots.push(root);registerOfflineFixtureRoot(root);
  const directory=join(root,'source'),remote=join(root,'remote.git');await mkdir(directory);
  const env=isolatedBuildEnvironment(process.env,root),identity={name:'Adoption Fixture',email:'adoption@example.invalid'};
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:directory,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=main');await git('config','user.name',identity.name);await git('config','user.email',identity.email);
  const config={'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION','initial-version':'1.0.0'}}};
  const delivery={schemaVersion:1,repositoryAuthors:[{id:7,evidence:'Explicit offline author record'}],units:[{id:'layerscape',path:'.',notesPath:'.release-notes/layerscape.md',assets:[{id:'app',name:'app-${version}.zip',mediaType:'application/zip'}],channels:[]}]};
  const files:Record<string,string>={'release-please-config.json':JSON.stringify(config),'.release-please-manifest.json':'{}',VERSION:'9.2.2',
    '.github/delivery.json':JSON.stringify(delivery),'.github/release-template.md.mustache':'Offline template',
    '.github/workflows/steward-release-publish.yml':'name: Fixture publish\n','.github/workflows/steward-release-channels.yml':'name: Fixture channels\n'};
  for(const [path,value] of Object.entries(files)){await mkdir(join(directory,path,'..'),{recursive:true});await writeFile(join(directory,path),value);}
  await git('add','.');await git('commit','--signoff','-m','Adopt first-release fixture');const A=await git('rev-parse','HEAD');
  await git('init','--bare',remote);await git('push','--porcelain',remote,'HEAD:refs/heads/main');
  const request={directory,remote,writeDirectory:join(root,'writes'),repository:'splrad/LayerScape',repositoryId:1187527897,defaultBranch:'main',appBotId:301115370,identity,releaseAdoption:{sourceSha:A,prNumber:7}};
  const pull:any={number:7,merged:true,merge_commit_sha:A,base:{ref:'main',repo:{id:request.repositoryId}},head:{ref:'onboarding',repo:{id:request.repositoryId}}};
  let denied=false;const closed:any[]=[];
  const stateHead=async()=>(await git('ls-remote','--heads','--refs',remote,'refs/heads/steward/release-state')).split('\t')[0]||null;
  const io={async request(method:string,path:string) {
    expect(method).toBe('GET');let value:any,status=200;const url=new URL(path,'https://api.github.com'),p=url.pathname;
    if(p==='/repos/splrad/LayerScape')value={id:request.repositoryId,full_name:request.repository,default_branch:'main',archived:false,disabled:false};
    else if(p.endsWith('/pulls/7'))value=pull;
    else if(/\/pulls\/[0-9]+$/.test(p)&&closed.some(pr=>p.endsWith('/pulls/'+pr.number)))value=closed.find(pr=>p.endsWith('/pulls/'+pr.number));
    else if(p.endsWith('/commits/main'))value={sha:await git('rev-parse','main')};
    else if(p.endsWith('/git/ref/heads/steward/release-state')){const head=await stateHead();status=denied?403:head?200:404;value=head?{object:{sha:head}}:{};}
    else if(p.endsWith('/pulls'))value=closed;
    else if(p.endsWith('/releases')||p.endsWith('/tags'))value=[];
    else if(releaseProtectionFixture(p))value=releaseProtectionFixture(p);
    else if(p.includes('/git/blobs/'))value={encoding:'base64',content:(await promisify(execFile)('git',['cat-file','blob',p.split('/').at(-1)!],{cwd:directory,env,encoding:'buffer',windowsHide:true})).stdout.toString('base64')};
    else throw Error('Unknown fixture endpoint '+path);
    return {status,bytes:new Uint8Array(Buffer.from(JSON.stringify(value))),headers:new Headers()};
  }};
  const fetchState=async()=>{await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state');await git('update-ref','refs/heads/steward/release-state',await git('rev-parse','FETCH_HEAD'));};
  return {root,git,A,request,pull,io,stateHead,fetchState,closed,deny:()=>{denied=true;}};
}
it('initializes revision zero from a real merged A/P, reads back and retries without a new commit',async()=>{
  const f=await fixture(),first=await initializeReleaseAdoption(f.request,{io:f.io});
  expect(first.status).toBe('APPLIED');await f.fetchState();
  const state=await readReleaseRecords({directory:f.request.directory,targetRef:'steward/release-state',repositoryId:f.request.repositoryId});
  expect(state.repository).toMatchObject({schemaVersion:3,revision:0,lastObservedDefaultSha:f.A,releaseAdoption:f.request.releaseAdoption,candidate:null,activeCycleId:null,lastCompletedCycleId:null});
  expect(state.cycles).toEqual([]);
  const second=await initializeReleaseAdoption(f.request,{io:f.io});expect(second.status).toBe('UNCHANGED');expect(second.head).toBe(first.head);
});
it.each(['unmerged','base','repository','A','unreadable'])('rejects adoption %s before any state write',async kind=>{
  const f=await fixture();if(kind==='unmerged')f.pull.merged=false;if(kind==='base')f.pull.base.ref='other';if(kind==='repository')f.pull.head.repo.id=2;
  if(kind==='A')f.pull.merge_commit_sha='a'.repeat(40);if(kind==='unreadable')f.deny();
  await expect(initializeReleaseAdoption(f.request,{io:f.io})).rejects.toThrow('RELEASE_ADOPTION:');expect(await f.stateHead()).toBeNull();
});
it('does not require empty-repository bootstrap evidence to verify A',async()=>{
  const f=await fixture(),result=await withReleaseAdoption(f.request,f.request.releaseAdoption,f.io,async(proof:any)=>({head:proof.defaultHead,reachable:proof.reachable}));
  expect(result).toEqual({head:f.A,reachable:[]});expect(await f.stateHead()).toBeNull();
});
it.each(['match','mismatch','dynamic','oversized'])('verifies Python source metadata from the actual adopted Git history: %s',async kind=>{
  const f=await fixture();permitOfflineScript(resolve('scripts/inspect-python-release.py'));
  const config={'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'python','initial-version':'1.0.0'}}};
  await writeFile(join(f.request.directory,'release-please-config.json'),JSON.stringify(config));
  await writeFile(join(f.request.directory,'pyproject.toml'),kind==='dynamic'
    ? '[project]\nname = "adoption-fixture"\ndynamic = ["version"]\n'
    : '[project]\nname = "adoption-fixture"\nversion = "1.0.0"\n'+(kind==='oversized'?' '.repeat(512*1024):''));
  await f.git('add','release-please-config.json','pyproject.toml');await f.git('commit','--signoff','-m','Adopt Python fixture');
  const A=await f.git('rev-parse','HEAD');f.request.releaseAdoption.sourceSha=A;f.pull.merge_commit_sha=A;
  const version=kind==='mismatch'?'1.0.1':'1.0.0';
  await writeFile(join(f.request.directory,'.release-please-manifest.json'),JSON.stringify({'.':version})+'\n');
  await f.git('add','.release-please-manifest.json');await f.git('commit','--signoff','-m','chore: release Python fixture');
  const S=await f.git('rev-parse','HEAD'),cycle={sourceSha:S,prNumber:8,units:[{id:'layerscape',version,tag:'v'+version}]};
  const run=()=>withReleaseAdoption(f.request,f.request.releaseAdoption,f.io,(proof:any)=>proof.verifySource({number:8,merge_commit_sha:S},cycle));
  if(kind==='match')expect(await run()).toBe(true);else await expect(run()).rejects.toThrow();
  expect(await f.stateHead()).toBeNull();
});
it('refuses initialization when the native state ref disappeared but local protected history remains',async()=>{
  const f=await fixture();await f.git('update-ref','refs/heads/steward/release-state',f.A);
  await expect(initializeReleaseAdoption(f.request,{io:f.io})).rejects.toThrow('missing adopted state requires recovery');expect(await f.stateHead()).toBeNull();
});
it('migrates a v2 record after proving A and preserves its original history and revision',async()=>{
  const f=await fixture();await f.git('switch','--orphan','steward/release-state');
  const original={schemaVersion:2,repositoryId:f.request.repositoryId,defaultBranch:'main',revision:17,lastObservedDefaultSha:f.A,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
  await writeFile(join(f.request.directory,'state.json'),JSON.stringify(original)+'\n');await f.git('add','state.json');await f.git('commit','--signoff','-m','Historical repository record');
  const old=await f.git('rev-parse','HEAD');await f.git('push','--porcelain',f.request.remote,'HEAD:refs/heads/steward/release-state');
  const result=await initializeReleaseAdoption(f.request,{io:f.io});expect(result.migrated).toBe(true);await f.fetchState();
  const back=await readReleaseRecords({directory:f.request.directory,targetRef:'steward/release-state',repositoryId:f.request.repositoryId});
  expect(back.repository.revision).toBe(18);expect(back.repository.releaseAdoption).toEqual(f.request.releaseAdoption);
  expect(back.repositoryHistory.some((record:any)=>record.commit===old&&record.value.schemaVersion===2&&record.value.revision===17)).toBe(true);
});
it.each(['missing','malformed'])('restores %s state from exact protected bytes without resetting revision or creating a cycle',async kind=>{
  const f=await fixture(),first=await initializeReleaseAdoption(f.request,{io:f.io});await f.fetchState();
  const original=await f.git('show',`${first.head}:state.json`);await f.git('switch','--detach','refs/heads/steward/release-state');
  if(kind==='missing')await f.git('rm','state.json');else {await writeFile(join(f.request.directory,'state.json'),'{broken');await f.git('add','state.json');}
  await f.git('commit','--signoff','-m','Simulate damaged cache');await f.git('push','--porcelain',f.request.remote,'HEAD:refs/heads/steward/release-state');await f.fetchState();
  const snapshot=await readReleaseRecords({directory:f.request.directory,targetRef:'steward/release-state',repositoryId:f.request.repositoryId});
  const repaired=await recoverReleaseCaches(f.request,snapshot,{io:f.io});
  expect(repaired.snapshot.repository).toEqual(snapshot.repository);expect(repaired.snapshot.cycles).toEqual([]);
  expect(await f.git('show',`${repaired.snapshot.head}:state.json`)).toBe(original);
  expect(await f.git('rev-parse','main')).toBe(f.A);
});
it('rejects a later onboarding PR without moving the adopted A/P',async()=>{
  const f=await fixture(),first=await initializeReleaseAdoption(f.request,{io:f.io});await f.fetchState();
  await f.git('commit','--allow-empty','--signoff','-m','Later onboarding configuration');const later=await f.git('rev-parse','main');
  f.closed.push({...f.pull,number:8,merge_commit_sha:later});
  const result=await initializeReleaseAdoption({...f.request,releaseAdoption:{sourceSha:later,prNumber:8}},{io:f.io});
  expect(result).toMatchObject({status:'CONFLICT',reason:'RELEASE_ADOPTION_CHANGED'});expect(await f.stateHead()).toBe(first.head);
});
it.each(['terminal','missing','in-progress'])('restores original cycle cache only with known terminal evidence: %s',async kind=>{
  const f=await fixture();await initializeReleaseAdoption(f.request,{io:f.io});await f.fetchState();
  await writeFile(join(f.request.directory,'VERSION'),'1.0.0\n');await writeFile(join(f.request.directory,'.release-please-manifest.json'),'{".":"1.0.0"}\n');
  await f.git('add','VERSION','.release-please-manifest.json');await f.git('commit','--signoff','-m','chore: release 1.0.0');const S=await f.git('rev-parse','main');
  const cycle:any={id:`pr-8-${S}`,prNumber:8,sourceSha:S,controllerSha:'b'.repeat(40),deliveryConfigSha:'c'.repeat(40),
    units:[{id:'layerscape',version:'1.0.0',tag:'v1.0.0',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
  if(kind!=='terminal')cycle.dispatches=[prepareBuildDispatch({repository:f.request.repository,repositoryId:f.request.repositoryId,appBotId:f.request.appBotId,cycle},10,'2026-10-31T00:00:00.000Z')];
  const observedAt='2026-10-31T00:01:00.000Z';
  if(kind==='in-progress') {
    const request=cycle.dispatches[0];request.canonicalRunId=100;request.nativeResponseEvidencePath='evidence/dispatch.json';
    const original=f.io.request,run={id:100,repository:{id:f.request.repositoryId},head_repository:{id:f.request.repositoryId},workflow_id:10,
      path:'.github/workflows/steward-release-publish.yml',event:'workflow_dispatch',head_sha:S,head_branch:request.ref,
      actor:{id:f.request.appBotId},triggering_actor:{id:f.request.appBotId},run_attempt:1,status:'in_progress',conclusion:null,
      created_at:request.sentAt,updated_at:observedAt,display_title:request.operationKey};
    const workflow=Buffer.from(`on: workflow_dispatch\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@${'d'.repeat(40)}\n        with:\n          repository: splrad/steward\n          ref: ${cycle.controllerSha}\n`);
    f.io.request=async(method,path)=>{
      let value:any;
      if(path.includes('/actions/runs/100')&&path.includes('/jobs'))value={total_count:0,jobs:[]};
      else if(path.includes('/actions/runs/100')&&path.includes('/artifacts'))value={total_count:0,artifacts:[]};
      else if(path.includes('/actions/runs/100'))value=run;
      else if(path.includes('/actions/workflows/10'))value={id:10,path:run.path};
      else if(path.includes('/contents/.github/workflows/'))value={type:'file',encoding:'base64',content:workflow.toString('base64'),size:workflow.length,sha:createHash('sha1').update(`blob ${workflow.length}\0`).update(workflow).digest('hex')};
      else return original(method,path);
      expect(method).toBe('GET');return {status:200,bytes:new Uint8Array(Buffer.from(JSON.stringify(value))),headers:new Headers()};
    };
    const evidence=await inspectNativeCycle({repository:f.request.repository,repositoryId:f.request.repositoryId,appBotId:f.request.appBotId,cycle},[],f.io,observedAt,{complete:true,observations:[]});
    expect(evidence.currentFacts.unknownEvidence).toEqual([]);expect(evidence.currentFacts.conflictEvidence).toEqual([]);
    expect(evidence.readObservation.disposition).toBe('COMPLETE');expect(evidence.currentFacts.inFlightWaveKeys).not.toHaveLength(0);
  }
  f.closed.push({number:8,merged:true,merge_commit_sha:S,user:{id:f.request.appBotId},base:{ref:'main',repo:{id:f.request.repositoryId}},head:{ref:'steward/release-candidate',repo:{id:f.request.repositoryId}}});
  await f.git('switch','--detach','refs/heads/steward/release-state');await mkdir(join(f.request.directory,'cycles'));
  const path=`cycles/${cycle.id}.json`,bytes=JSON.stringify(cycle)+'\n';await writeFile(join(f.request.directory,path),bytes);
  await f.git('add',path);await f.git('commit','--signoff','-m','Original release cycle');
  await writeFile(join(f.request.directory,path),'{broken');await f.git('add',path);await f.git('commit','--signoff','-m','Damaged cycle cache');
  await f.git('push','--porcelain',f.request.remote,'HEAD:refs/heads/steward/release-state');await f.fetchState();
  const snapshot=await readReleaseRecords({directory:f.request.directory,targetRef:'steward/release-state',repositoryId:f.request.repositoryId});
  if(kind!=='terminal'){await expect(recoverReleaseCaches(f.request,snapshot,{io:f.io,now:()=>observedAt})).rejects.toThrow('original native evidence unknown');expect(await f.stateHead()).toBe(snapshot.head);}
  else {const repaired=await recoverReleaseCaches(f.request,snapshot,{io:f.io});expect(repaired.snapshot.cycles[0].value).toEqual(cycle);expect(repaired.snapshot.repository).toEqual(snapshot.repository);expect(await f.git('show',`${repaired.snapshot.head}:${path}`)).toBe(bytes.trim());}
});
