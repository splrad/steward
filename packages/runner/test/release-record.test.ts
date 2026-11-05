import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';

const {readReleaseRecords,main}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const S='a'.repeat(40),C='b'.repeat(40),D='c'.repeat(40),cycleId=`pr-12-${S}`;
const repository={schemaVersion:2,repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
const cycle={id:cycleId,prNumber:12,sourceSha:S,controllerSha:C,deliveryConfigSha:D,units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
const roots:string[]=[];
// Hosted Windows may serialize native Git process startup under the full suite.
const nativeGitTestTimeout = 30_000;
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'release-record-'));roots.push(root);registerOfflineFixtureRoot(root);
  const home=join(root,'profile');await mkdir(home);const env=isolatedBuildEnvironment(process.env,home);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:root,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=steward/release-state');await git('config','user.name','Offline Fixture');await git('config','user.email','fixture@example.invalid');
  const save=async()=>{await git('add','--','state.json','cycles');await git('commit','--signoff','-m','Offline state fixture');return git('rev-parse','HEAD');};
  await writeFile(join(root,'state.json'),JSON.stringify(repository));await mkdir(join(root,'cycles'));await writeFile(join(root,'cycles',cycleId+'.json'),JSON.stringify(cycle));
  const head=await save();return {root,git,save,head,input:{directory:root,targetRef:'steward/release-state',repositoryId:1,includeHistory:true}};
}
it('reads exact Git blobs and leaves the working tree, branch and source bytes unchanged',async()=>{
  const f=await fixture(),before=await f.git('status','--porcelain');const result=await readReleaseRecords(f.input);
  expect(result.head).toBe(f.head);expect(result.repository).toEqual(repository);expect(result.cycles[0].value).toEqual(cycle);expect(result.completion.result).toBe('UNKNOWN');
  expect(await f.git('rev-parse','HEAD')).toBe(f.head);expect(await f.git('status','--porcelain')).toBe(before);
},nativeGitTestTimeout);
it('recovers missing state/cycle caches from Git ancestors without resetting them or declaring completion',async()=>{
  const f=await fixture();await rm(join(f.root,'state.json'));await rm(join(f.root,'cycles',cycleId+'.json'));await f.git('add','-u');await f.git('commit','--signoff','-m','Offline cache loss');
  const result=await readReleaseRecords(f.input);expect(result.repositoryCommit).toBe(f.head);expect(result.cycles[0].commit).toBe(f.head);expect(result.completion.result).toBe('UNKNOWN');
  expect(await f.git('status','--porcelain')).toBe('');
},nativeGitTestTimeout);
it('retains malformed current bytes and finds an earlier parseable record',async()=>{
  const f=await fixture();await writeFile(join(f.root,'state.json'),'{malformed');await f.save();
  const result=await readReleaseRecords(f.input);expect(result.repositoryCommit).toBe(f.head);expect(result.history.some((entry:{status:string})=>entry.status==='MALFORMED_JSON')).toBe(true);
},nativeGitTestTimeout);
it('reads v2 ancestors while recovering the same v3 A/P after current cache damage',async()=>{
  const f=await fixture(),value={...repository,schemaVersion:3,releaseAdoption:{sourceSha:S,prNumber:4}};
  await writeFile(join(f.root,'state.json'),JSON.stringify(value));const adopted=await f.save();
  await writeFile(join(f.root,'state.json'),'{broken');await f.save();
  const result=await readReleaseRecords(f.input);expect(result.repository).toEqual(value);expect(result.repositoryCommit).toBe(adopted);
  expect(result.repositoryHistory.some((record:any)=>record.value.schemaVersion===2)).toBe(true);
},nativeGitTestTimeout);
it.each(['source','pr','downgrade'])('rejects conflicting adoption history: %s',async kind=>{
  const f=await fixture(),value={...repository,schemaVersion:3,releaseAdoption:{sourceSha:S,prNumber:4}};
  await writeFile(join(f.root,'state.json'),JSON.stringify(value));await f.save();
  await writeFile(join(f.root,'state.json'),JSON.stringify(kind==='downgrade'?repository:{...value,releaseAdoption:{sourceSha:kind==='source'?C:S,prNumber:kind==='pr'?5:4}}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow(kind==='downgrade'?'schema downgrade':'adoption conflict');
},nativeGitTestTimeout);
it.each([1,4])('does not bypass unsupported schema %s by selecting an older record',async schemaVersion=>{
  const f=await fixture();await writeFile(join(f.root,'state.json'),JSON.stringify({...repository,schemaVersion}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('unsupported schema');
},nativeGitTestTimeout);
it('rejects changed A/P even when an unrelated field in that record is invalid',async()=>{
  const f=await fixture(),value={...repository,schemaVersion:3,releaseAdoption:{sourceSha:S,prNumber:4}};
  await writeFile(join(f.root,'state.json'),JSON.stringify(value));await f.save();
  await writeFile(join(f.root,'state.json'),JSON.stringify({...value,revision:-1,releaseAdoption:{sourceSha:C,prNumber:4}}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('release adoption conflict');
},nativeGitTestTimeout);
it('rejects a repository identity mismatch and immutable cycle source conflicts',async()=>{
  const f=await fixture();await expect(readReleaseRecords({...f.input,repositoryId:2})).rejects.toThrow('repository identity');
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify({...cycle,controllerSha:D}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('immutable cycle conflict');
},nativeGitTestTimeout);
it('rejects record symlinks in the Git tree without following or executing them',async()=>{
  const f=await fixture(),blob=await f.git('rev-parse','HEAD:state.json');
  await f.git('update-index','--cacheinfo',`120000,${blob},state.json`);await f.git('commit','--signoff','-m','Offline link fixture');
  await expect(readReleaseRecords(f.input)).rejects.toThrow('unsafe path');
},nativeGitTestTimeout);
it.each(['version','tag','required-channel'])('rejects historical frozen %s changes',async field=>{
  const f=await fixture(),value=structuredClone(cycle);
  if(field==='version')value.units[0]!.version='2.0.0';
  if(field==='tag')value.units[0]!.tag='v2.0.0';
  if(field==='required-channel')(value.requiredChannels as {unitId:string;channelId:string}[]).push({unitId:'app',channelId:'winget'});
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify(value));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('immutable cycle conflict');
},nativeGitTestTimeout);
it('rejects a cache that clears an already frozen Release ID',async()=>{
  const f=await fixture();
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify({...cycle,units:[{...cycle.units[0],releaseId:7}]}));await f.save();
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify(cycle));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('frozen cycle fact removed');
},nativeGitTestTimeout);
it('rejects arbitrary refs and unfixed write command arguments',async()=>{
  await expect(readReleaseRecords({directory:'.',targetRef:'main',repositoryId:1})).rejects.toThrow('target');
  await expect(main(['write','--directory','.','--target-ref','main','--repository-id','1','--output','ignored'])).rejects.toThrow('write arguments');
});
it('keeps an original repair decision immutable after adopting it',async()=>{
  const f=await fixture(),decision={eventId:1,actorId:99,createdAt:'2026-10-27T00:00:00Z',cycleId,sourceSha:S,
    unitIds:['app'],releaseIds:[],tags:['v1.2.3'],evidencePath:'generated/repair.json'};
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify({...cycle,approvedRepairDecision:decision}));const adopted=await f.save();
  const accepted=await readReleaseRecords(f.input);
  expect(accepted.cycleHistory.find((record:any)=>record.commit===adopted).value.approvedRepairDecision).toEqual(decision);
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify({...cycle,approvedRepairDecision:{...decision,eventId:2}}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('repair decision changed');
},nativeGitTestTimeout);
it('rejects a later cache that attaches a new parent to an existing ordinary cycle',async()=>{
  const f=await fixture(),parent=`pr-1-${C}`,decision={eventId:1,actorId:99,createdAt:'2026-10-27T00:00:00Z',cycleId:parent,sourceSha:C,
    unitIds:['app'],releaseIds:[],tags:['v1.0.0'],evidencePath:'generated/repair.json'};
  await writeFile(join(f.root,'cycles',cycleId+'.json'),JSON.stringify({...cycle,repairOf:parent,approvedRepairDecision:decision}));await f.save();
  await expect(readReleaseRecords(f.input)).rejects.toThrow('immutable cycle conflict');
},nativeGitTestTimeout);

it('normal reads use only registered current records; explicit recovery reads ancestors',async()=>{
  const f=await fixture();await writeFile(join(f.root,'state.json'),JSON.stringify({...repository,revision:1}));const head=await f.save();
  const current=await readReleaseRecords({...f.input,includeHistory:false});
  expect(current.repository.revision).toBe(1);expect(current.repositoryHistory).toHaveLength(1);
  expect(current.history.every((entry:any)=>entry.commit===head)).toBe(true);
  const recovered=await readReleaseRecords(f.input);expect(recovered.repositoryHistory).toHaveLength(2);
},nativeGitTestTimeout);
